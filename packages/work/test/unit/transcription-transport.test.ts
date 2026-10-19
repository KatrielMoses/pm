import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HttpTranscriptionProvider,
  responseBudget,
  TranscriptionError,
  TranscriptTooLongError,
} from '../../src/ai/transcription.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Phase 7F review 01 R2 (provider contract): the transcription response is read under a strict
 * byte budget, decoded as strict UTF-8 only when complete, validated before any arithmetic, and a
 * transcript over the character bound is refused (with its measured duration), never clipped.
 */
describe('Phase 7F review 01: bounded transcription responses', () => {
  let server: Server;
  let base: string;
  let handler: Handler = (_q, s) => s.end();
  const audio = new Uint8Array(64);
  const call = (maxChars = 100, signal = new AbortController().signal, url = base) =>
    new HttpTranscriptionProvider({ baseUrl: url, timeoutMs: 5000 }).transcribe({
      model: 'synthetic-transcription',
      audio,
      format: 'audio/wav',
      apiKey: 'k',
      maxChars,
      signal,
    });
  const failure = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => e as TranscriptionError,
    );

  beforeAll(async () => {
    server = createServer((req, res) => {
      // The client may hang up mid-answer (that is the point of several cases).
      req.socket.on('error', () => undefined);
      res.on('error', () => undefined);
      req.resume();
      req.on('end', () => handler(req, res));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('stops reading a chunked stream as soon as it exceeds the byte budget (no length declared)', async () => {
    let written = 0;
    let closed = false;
    const planned = 2 * 1024 * 1024;
    handler = (_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.on('close', () => (closed = true));
      const chunk = Buffer.alloc(4096, 'a');
      res.write('{"text":"');
      const pump = (): void => {
        if (closed || written >= planned) {
          res.end('"}');
          return;
        }
        written += chunk.length;
        if (res.write(chunk)) setImmediate(pump);
        else res.once('drain', pump);
      };
      pump();
    };
    const e = await failure(call(100));
    expect(e).toBeInstanceOf(TranscriptionError);
    expect(e).toMatchObject({ kind: 'invalid', charged: 'unknown', message: 'response_too_large' });
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(true);
    // Far less than the whole response was produced before the client hung up.
    expect(written).toBeLessThan(planned / 4);
  });

  it('refuses a declared length over the budget before reading, and an understated length cannot smuggle more', async () => {
    handler = (_q, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(responseBudget(100) + 1),
      });
      res.end('{');
    };
    expect(await failure(call(100))).toMatchObject({ message: 'response_too_large' });
    // A raw server that declares 12 bytes and sends far more: only the declared bytes are read.
    const raw: NetServer = createNetServer((sock) => {
      sock.on('error', () => undefined);
      sock.on('data', () => {
        sock.write(
          'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 12\r\nconnection: close\r\n\r\n' +
            '{"text":"x",' +
            'A'.repeat(100_000),
        );
        sock.end();
      });
    });
    await new Promise<void>((r) => raw.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(raw.address() as AddressInfo).port}`;
      expect(await failure(call(100, new AbortController().signal, url))).toMatchObject({
        message: 'malformed_response',
      });
    } finally {
      await new Promise<void>((r) => raw.close(() => r()));
    }
  });

  it('decodes multibyte text split across chunks and counts characters, not bytes', async () => {
    const text = 'Café ☕ résumé 🎉'.repeat(3);
    const body = Buffer.from(JSON.stringify({ text, duration_ms: 2000, confidence: 0.9 }));
    handler = (_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // One byte per write: every multibyte character is split across chunks.
      let i = 0;
      const pump = (): void => {
        if (i >= body.length) {
          res.end();
          return;
        }
        res.write(body.subarray(i, i + 1));
        i++;
        setImmediate(pump);
      };
      pump();
    };
    const exact = [...text].length;
    expect(await call(exact)).toMatchObject({ text, durationMs: 2000, confidence: 0.9 });
    const e = await failure(call(exact - 1));
    expect(e).toBeInstanceOf(TranscriptTooLongError);
    expect(e).toMatchObject({ message: 'transcript_too_long', durationMs: 2000 });
  });

  it('refuses a transcript over the character bound inside otherwise valid JSON, never clipping it', async () => {
    handler = (_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'tr_9', text: 'eightwords', duration_ms: 1000 }));
    };
    const e = await failure(call(4));
    expect(e).toBeInstanceOf(TranscriptTooLongError);
    expect(e).toMatchObject({ durationMs: 1000, requestId: 'tr_9', charged: 'unknown' });
    expect(await call(10)).toMatchObject({ text: 'eightwords' });
  });

  it('refuses malformed, unsafe, or implausible durations and shapes before any arithmetic', async () => {
    for (const body of [
      '{"text":"x","duration_ms":1.5}',
      '{"text":"x","duration_ms":-1}',
      '{"text":"x","duration_ms":1e20}',
      '{"text":"x","duration_ms":"100"}',
      '{"text":"x","duration_ms":90000000}',
      '{"text":3,"duration_ms":10}',
      '[1,2]',
      'not json',
      '{"text":"\\ud83d',
    ]) {
      handler = (_q, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
      };
      expect(await failure(call(100)), body).toMatchObject({
        kind: 'invalid',
        charged: 'unknown',
        message: 'malformed_response',
      });
    }
    // Invalid UTF-8 bytes are malformed, never replaced.
    handler = (_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(Buffer.from([0x7b, 0x22, 0x74, 0xff, 0x22, 0x7d]));
    };
    expect(await failure(call(100))).toMatchObject({ message: 'malformed_response' });
  });

  it('a cancellation while the answer streams stops reading and is reported as cancelled', async () => {
    let closed = false;
    handler = (_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.on('close', () => (closed = true));
      res.write('{"text":"');
      const t = setInterval(() => (closed ? clearInterval(t) : res.write('a')), 20);
    };
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    expect(await failure(call(10_000, ac.signal))).toMatchObject({
      kind: 'cancelled',
      charged: 'unknown',
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(true);
  });

  it('returns an ordinary valid answer unchanged', async () => {
    handler = (_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ id: 'tr_1', text: 'Call the venue', duration_ms: 3500, confidence: 0.8 }),
      );
    };
    expect(await call(100)).toEqual({
      text: 'Call the venue',
      durationMs: 3500,
      confidence: 0.8,
      requestId: 'tr_1',
    });
  });
});
