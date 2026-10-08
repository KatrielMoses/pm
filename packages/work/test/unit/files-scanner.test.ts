import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ClamAvScanner,
  createMalwareScanner,
  EICAR_TEST_STRING,
  parseClamdReply,
  SignatureTestScanner,
} from '@pm/work';

/** Minimal clamd: parses zINSTREAM chunks and answers via `reply(received)`. */
function fakeClamd(
  reply: (received: Buffer, socket: Socket) => string | null,
): Promise<{ server: Server; port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  const server = createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.subarray(0, 6).toString() === 'zPING\0') {
        socket.end('PONG\0');
        return;
      }
      const head = 'zINSTREAM\0';
      if (buf.length < head.length) return;
      if (buf.subarray(0, head.length).toString() !== head) {
        socket.end('UNKNOWN COMMAND\0');
        return;
      }
      let off = head.length;
      const parts: Buffer[] = [];
      for (;;) {
        if (buf.length < off + 4) return;
        const len = buf.readUInt32BE(off);
        if (len === 0) break;
        if (buf.length < off + 4 + len) return;
        parts.push(buf.subarray(off + 4, off + 4 + len));
        off += 4 + len;
      }
      const all = Buffer.concat(parts);
      received.push(all);
      const r = reply(all, socket);
      if (r !== null) socket.end(`${r}\0`);
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0, received });
    }),
  );
}

describe('ClamAvScanner', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });
  const scanner = async (reply: Parameters<typeof fakeClamd>[0], timeoutMs = 2000) => {
    const f = await fakeClamd(reply);
    servers.push(f.server);
    return {
      s: new ClamAvScanner({ host: '127.0.0.1', port: f.port, timeoutMs, chunkBytes: 7 }),
      received: f.received,
    };
  };

  it('streams chunked bytes and maps OK to clean', async () => {
    const { s, received } = await scanner(() => 'stream: OK');
    const bytes = new TextEncoder().encode('a reasonably long file body over many chunks');
    expect(await s.scan(bytes)).toEqual({ verdict: 'clean' });
    expect(received[0]!.equals(Buffer.from(bytes))).toBe(true);
    expect(await s.scan(new Uint8Array(0))).toEqual({ verdict: 'clean' });
    expect(await s.check()).toBe('ok');
  });

  it('maps FOUND to infected with the signature', async () => {
    const { s } = await scanner(() => 'stream: Win.Test.EICAR_HDB-1 FOUND');
    expect(await s.scan(new Uint8Array([1]))).toEqual({
      verdict: 'infected',
      signature: 'Win.Test.EICAR_HDB-1',
    });
  });

  it('maps other replies to error', async () => {
    const { s } = await scanner(() => 'INSTREAM size limit exceeded. ERROR');
    expect(await s.scan(new Uint8Array([1]))).toEqual({
      verdict: 'error',
      reason: 'clamd: INSTREAM size limit exceeded. ERROR',
    });
  });

  it('times out when clamd does not answer', async () => {
    const { s } = await scanner(() => null, 150);
    expect(await s.scan(new Uint8Array([1]))).toEqual({
      verdict: 'error',
      reason: 'clamd timed out after 150 ms',
    });
  });

  it('reports a refused connection as error / unavailable', async () => {
    const f = await fakeClamd(() => 'stream: OK');
    const port = f.port;
    await new Promise((r) => f.server.close(r));
    const s = new ClamAvScanner({ host: '127.0.0.1', port, timeoutMs: 1000 });
    const r = await s.scan(new Uint8Array([1]));
    expect(r.verdict).toBe('error');
    expect(await s.check()).toBe('unavailable');
  });

  it('parses replies', () => {
    expect(parseClamdReply('stream: OK')).toEqual({ verdict: 'clean' });
    expect(parseClamdReply('')).toEqual({ verdict: 'error', reason: 'clamd: empty reply' });
  });
});

describe('SignatureTestScanner', () => {
  it('flags bytes containing the EICAR test string and passes everything else', async () => {
    const s = new SignatureTestScanner();
    const infected = Buffer.concat([
      Buffer.from('prefix '),
      Buffer.from(EICAR_TEST_STRING, 'latin1'),
      Buffer.from(' suffix'),
    ]);
    expect(await s.scan(new Uint8Array(infected))).toEqual({
      verdict: 'infected',
      signature: SignatureTestScanner.SIGNATURE,
    });
    expect(await s.scan(new TextEncoder().encode('EICAR-STANDARD-ANTIVIRUS'))).toEqual({
      verdict: 'clean',
    });
    expect(await s.scan(new Uint8Array(0))).toEqual({ verdict: 'clean' });
    expect(await s.check()).toBe('ok');
  });

  it('is built from config; none yields null', () => {
    expect(createMalwareScanner({ provider: 'none' })).toBeNull();
    expect(createMalwareScanner({ provider: 'test-signature' })?.provider).toBe('test-signature');
    expect(
      createMalwareScanner({ provider: 'clamav', host: 'h', port: 3310, timeoutMs: 1000 })
        ?.provider,
    ).toBe('clamav');
  });
});
