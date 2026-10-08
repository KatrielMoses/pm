import { connect, type Socket } from 'node:net';
import type { FilesScannerConfig } from '@pm/config';

export type { FilesScannerConfig } from '@pm/config';

export type ScanResult =
  | { verdict: 'clean' }
  | { verdict: 'infected'; signature: string }
  | { verdict: 'error'; reason: string };

export interface MalwareScanner {
  readonly provider: 'clamav' | 'test-signature';
  scan(bytes: Uint8Array): Promise<ScanResult>;
  check(): Promise<'ok' | 'unavailable'>;
}

export interface ClamAvScannerOptions {
  host: string;
  port: number;
  timeoutMs: number;
  /** INSTREAM chunk size (default 64 KiB). */
  chunkBytes?: number;
}

/** Longest clamd reply we accept; anything longer is a protocol error. */
const MAX_REPLY_BYTES = 4096;

/** clamd over TCP using the null-terminated (`z`) INSTREAM and PING commands. */
export class ClamAvScanner implements MalwareScanner {
  readonly provider = 'clamav' as const;
  readonly #o: Required<ClamAvScannerOptions>;

  constructor(o: ClamAvScannerOptions) {
    this.#o = { chunkBytes: 64 * 1024, ...o };
  }

  async scan(bytes: Uint8Array): Promise<ScanResult> {
    let reply: string;
    try {
      reply = await this.#exchange((socket) => {
        socket.write('zINSTREAM\0');
        for (let off = 0; off < bytes.byteLength; off += this.#o.chunkBytes) {
          const chunk = bytes.subarray(off, off + this.#o.chunkBytes);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(chunk.byteLength);
          socket.write(len);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4));
      });
    } catch (e) {
      return { verdict: 'error', reason: (e as Error).message };
    }
    return parseClamdReply(reply);
  }

  async check(): Promise<'ok' | 'unavailable'> {
    try {
      const reply = await this.#exchange((socket) => socket.write('zPING\0'));
      return reply === 'PONG' ? 'ok' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  /** Sends a command and resolves with the first null-terminated reply (trimmed). */
  #exchange(send: (socket: Socket) => void): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const socket = connect({ host: this.#o.host, port: this.#o.port });
      const finish = (err: Error | null, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolvePromise(value ?? '');
      };
      const timer = setTimeout(
        () => finish(new Error(`clamd timed out after ${this.#o.timeoutMs} ms`)),
        this.#o.timeoutMs,
      );
      socket.on('connect', () => {
        try {
          send(socket);
        } catch (e) {
          finish(e as Error);
        }
      });
      socket.on('data', (d: Buffer) => {
        chunks.push(d);
        size += d.length;
        const all = Buffer.concat(chunks);
        const nul = all.indexOf(0);
        if (nul >= 0) finish(null, all.subarray(0, nul).toString('utf8').trim());
        else if (size > MAX_REPLY_BYTES) finish(new Error('clamd reply too long'));
      });
      socket.on('end', () => {
        const all = Buffer.concat(chunks).toString('utf8').trim();
        if (all) finish(null, all);
        else finish(new Error('clamd closed the connection without a reply'));
      });
      socket.on('error', (e) => finish(new Error(`clamd connection failed: ${e.message}`)));
    });
  }
}

/** Maps a clamd INSTREAM reply to a verdict. */
export function parseClamdReply(reply: string): ScanResult {
  if (reply === 'stream: OK') return { verdict: 'clean' };
  const found = /^stream: (.+) FOUND$/.exec(reply);
  if (found) return { verdict: 'infected', signature: found[1]!.trim().slice(0, 200) };
  return { verdict: 'error', reason: `clamd: ${reply.slice(0, 200) || 'empty reply'}` };
}

/** The EICAR anti-malware test string, assembled so this source is not itself flagged. */
export const EICAR_TEST_STRING = [
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$',
  'EICAR-STANDARD-ANTIVIRUS-TEST-FILE',
  '!$H+H*',
].join('');

/** Dev/test only: infected iff the bytes contain the EICAR test string; clean otherwise. */
export class SignatureTestScanner implements MalwareScanner {
  readonly provider = 'test-signature' as const;
  static readonly SIGNATURE = 'Eicar-Test-Signature';
  readonly #needle = Buffer.from(EICAR_TEST_STRING, 'latin1');

  scan(bytes: Uint8Array): Promise<ScanResult> {
    const hit = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(
      this.#needle,
    );
    return Promise.resolve(
      hit
        ? { verdict: 'infected', signature: SignatureTestScanner.SIGNATURE }
        : { verdict: 'clean' },
    );
  }

  check(): Promise<'ok' | 'unavailable'> {
    return Promise.resolve('ok');
  }
}

export function createMalwareScanner(cfg: FilesScannerConfig): MalwareScanner | null {
  switch (cfg.provider) {
    case 'clamav':
      return new ClamAvScanner({ host: cfg.host, port: cfg.port, timeoutMs: cfg.timeoutMs });
    case 'test-signature':
      return new SignatureTestScanner();
    default:
      return null;
  }
}
