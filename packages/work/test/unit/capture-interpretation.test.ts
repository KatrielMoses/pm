import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syntheticOgg, syntheticWav, syntheticWebm } from '@pm/test-support';
import { ACTION_BY_ID } from '../../src/ai/actions/catalog.ts';
import {
  captureTextOf,
  interpretationSystemTemplate,
  validateInterpretation,
} from '../../src/ai/actions/interpretation.ts';
import { deriveSpan, nameOf } from '../../src/capture/interpret.ts';
import {
  billedSeconds,
  checkAudio,
  HttpTranscriptionProvider,
  TranscriptionError,
} from '../../src/ai/transcription.ts';

const def = ACTION_BY_ID.get('interpret_capture.v1')!;
const validate = (text: string, capture: string, completeness: 'complete' | 'truncated' = 'complete') =>
  validateInterpretation({ def, text, completeness, capture });

describe('Phase 7F interpretation contract (interpretation.v1)', () => {
  it('accepts only exact spans of the capture text; anything else is dropped, never guessed', () => {
    const capture = 'Call Sam tomorrow about the Falcon launch';
    const r = validate(
      JSON.stringify({
        fields: [
          { field: 'due_date', span: 'tomorrow' },
          { field: 'owner', span: 'sam' },
          { field: 'project', span: 'Atlas' },
        ],
      }),
      capture,
    );
    expect(r.status).toBe('downgraded');
    expect(r.dropped).toBe(1);
    // Offsets point into the person's own words (case kept from the text, not the model).
    expect(r.fields).toEqual([
      { field: 'owner', span: 'Sam', start: 5, end: 8 },
      { field: 'due_date', span: 'tomorrow', start: 9, end: 17 },
    ]);
  });

  it('refuses incomplete transport, malformed output, unknown fields, and extra keys whole', () => {
    expect(validate('{"fields":[]}', 'x', 'truncated')).toMatchObject({
      status: 'rejected',
      reason: 'truncated_response',
    });
    expect(validate('not json', 'x').reason).toBe('malformed_response');
    expect(validate('{"fields":[{"field":"cost","span":"x"}]}', 'x').reason).toBe(
      'unsupported_output',
    );
    expect(validate('{"fields":[{"field":"title","span":"x","value":"y"}]}', 'x').reason).toBe(
      'unsupported_output',
    );
    expect(validate('{"fields":[],"apply":true}', 'x').reason).toBe('unsupported_output');
    expect(
      validate(
        JSON.stringify({ fields: Array.from({ length: 21 }, () => ({ field: 'title', span: 'x' })) }),
        'x',
      ).reason,
    ).toBe('unsupported_output');
    expect(validate('{"fields":[{"field":"title","span":"elsewhere"}]}', 'x')).toMatchObject({
      status: 'rejected',
      reason: 'no_valid_fields',
      dropped: 1,
    });
    expect(validate('{"fields":[],"questions":[{"text":"Which project?"}]}', 'x')).toMatchObject({
      status: 'needs_input',
    });
  });

  it('a repeated word maps to distinct occurrences; overlapping spans are never claimed twice', () => {
    const r = validate(
      JSON.stringify({
        fields: [
          { field: 'title', span: 'review' },
          { field: 'label', span: 'review' },
        ],
      }),
      'review the review',
    );
    expect(r.fields.map((f) => f.start)).toEqual([0, 11]);
  });

  it('reads the capture text from the composed request and keeps the contract in the template', () => {
    expect(captureTextOf('Action: Interpret a capture\nRequest: Buy milk\nAnswers to earlier questions:\n- a: b')).toBe(
      'Buy milk',
    );
    const t = interpretationSystemTemplate(def);
    expect(t).toContain('interpretation.v1');
    expect(t).toMatch(/copied exactly/);
    expect(t).toMatch(/cannot call tools/);
  });
});

describe('Phase 7F span derivation (server rules, person’s today)', () => {
  const today = '2026-10-21'; // a Wednesday
  it('derives dates, priority, duration, and recurrence deterministically; unknown stays unknown', () => {
    expect(deriveSpan('due_date', 'tomorrow', today, 30)).toMatchObject({
      status: 'resolved',
      value: '2026-10-22',
    });
    expect(deriveSpan('due_date', 'next friday', today, 30)).toMatchObject({
      status: 'ambiguous',
    });
    expect(deriveSpan('deadline', '3/4', today, 30)).toMatchObject({ status: 'ambiguous' });
    expect(deriveSpan('due_date', 'whenever', today, 30)).toMatchObject({ status: 'unknown' });
    expect(deriveSpan('priority', 'high priority', today, 30)).toMatchObject({ value: 'high' });
    expect(deriveSpan('priority', '!urgent', today, 30)).toMatchObject({ value: 'urgent' });
    expect(deriveSpan('priority', 'soonish', today, 30)).toMatchObject({ status: 'unknown' });
    expect(deriveSpan('estimate_minutes', 'about an hour', today, 30)).toMatchObject({ value: 60 });
    expect(deriveSpan('estimate_minutes', 'half an hour', today, 30)).toMatchObject({ value: 30 });
    expect(deriveSpan('estimate_minutes', '90m', today, 30)).toMatchObject({ value: 90 });
    // A missing duration is never zero.
    expect(deriveSpan('estimate_minutes', 'a while', today, 30)).toMatchObject({ status: 'unknown' });
    expect(deriveSpan('recurrence', 'every monday', today, 30)).toMatchObject({
      value: { frequency: 'weekly', weekdays: ['MO'] },
    });
    expect(nameOf('+"Falcon launch"')).toBe('Falcon launch');
    expect(nameOf('@sam')).toBe('sam');
  });
});

describe('Phase 7F audio checks (from bytes, never a name)', () => {
  it('measures WAV, Ogg, and WebM durations and bounds them', () => {
    expect(checkAudio(syntheticWav(3, null), 'audio/wav', 120)).toEqual({ ok: true, durationMs: 3000 });
    expect(checkAudio(syntheticWav(121, null), 'audio/wav', 120)).toEqual({ ok: false, code: 'too_long' });
    expect(checkAudio(syntheticWav(0, null), 'audio/wav', 120)).toEqual({ ok: false, code: 'empty_audio' });
    expect(checkAudio(syntheticOgg(2.5, null), 'audio/ogg', 120)).toEqual({ ok: true, durationMs: 2500 });
    expect(checkAudio(syntheticWebm(1500, null), 'audio/webm', 120)).toEqual({ ok: true, durationMs: 1500 });
    expect(checkAudio(syntheticWebm(null, null), 'audio/webm', 120)).toEqual({ ok: true, durationMs: null });
  });

  it('refuses a container that does not match its declared format, or is malformed', () => {
    expect(checkAudio(syntheticOgg(1, null), 'audio/wav', 120)).toEqual({
      ok: false,
      code: 'unsupported_format',
    });
    expect(checkAudio(syntheticWav(1, null), 'audio/webm', 120)).toEqual({
      ok: false,
      code: 'unsupported_format',
    });
    const truncated = syntheticWav(1, null).slice(0, 30);
    expect(checkAudio(truncated, 'audio/wav', 120).ok).toBe(false);
    expect(billedSeconds(1)).toBe(1);
    expect(billedSeconds(4001)).toBe(5);
  });
});

describe('Phase 7F transcription transport (provider contract)', () => {
  let server: Server;
  let base: string;
  let reply: { status: number; body: string } = { status: 200, body: '{}' };
  let seen: { headers: Record<string, unknown>; bytes: number } | null = null;
  beforeAll(async () => {
    server = createServer((req, res) => {
      let n = 0;
      req.on('data', (c: Buffer) => (n += c.length));
      req.on('end', () => {
        seen = { headers: req.headers, bytes: n };
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(reply.body);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const call = (maxChars = 100) =>
    new HttpTranscriptionProvider({ baseUrl: base, timeoutMs: 2000 }).transcribe({
      model: 'synthetic-transcription',
      audio: syntheticWav(1, null),
      format: 'audio/wav',
      apiKey: 'k',
      maxChars,
      signal: new AbortController().signal,
    });

  it('sends the bytes with the model and key and returns a bounded, typed result', async () => {
    reply = {
      status: 200,
      body: JSON.stringify({ id: 'tr_1', text: 'hello world', duration_ms: 1000, confidence: 0.8 }),
    };
    expect(await call()).toEqual({ text: 'hello world', durationMs: 1000, confidence: 0.8, requestId: 'tr_1' });
    expect(seen!.headers).toMatchObject({ 'content-type': 'audio/wav', 'x-api-key': 'k', 'x-model': 'synthetic-transcription' });
    expect(seen!.bytes).toBe(syntheticWav(1, null).byteLength);
    expect((await call(5)).text).toBe('hello');
  });

  it('classifies failures by whether they can have been charged', async () => {
    for (const [status, kind, charged] of [
      [401, 'auth', 'no'],
      [429, 'rate', 'no'],
      [415, 'invalid', 'no'],
      [503, 'transient', 'unknown'],
    ] as const) {
      reply = { status, body: '{}' };
      await expect(call()).rejects.toMatchObject({ kind, charged });
    }
    reply = { status: 200, body: '{"text": 3}' };
    await expect(call()).rejects.toBeInstanceOf(TranscriptionError);
    // A port nothing listens on: the connection is refused before anything is sent.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const closed = new HttpTranscriptionProvider({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 500 });
    await expect(
      closed.transcribe({
        model: 'm',
        audio: new Uint8Array(4),
        format: 'audio/wav',
        apiKey: 'k',
        maxChars: 10,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ kind: 'not_sent', charged: 'no' });
  });
});
