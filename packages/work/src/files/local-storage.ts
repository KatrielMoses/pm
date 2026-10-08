import { createHmac, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import {
  assertObjectKey,
  contentDisposition,
  ObjectNotFoundError,
  sanitizeFilename,
  sha256Hex,
  StorageUnavailableError,
  type ObjectHead,
  type ObjectStorage,
  type PresignedRequest,
  type StorageStatus,
} from './storage.ts';

/**
 * Development/test adapter: objects live in a directory and "presigned" URLs point at the API's
 * `/v1/storage/local/:key` route, authorised by an HMAC over every bound parameter.
 */
export interface LocalObjectStorageOptions {
  dir: string;
  /** HMAC key for signed URLs. */
  secret: string;
  /** Base the signed URLs point at (no trailing slash). */
  publicBaseUrl: string;
  now?: () => Date;
}

export const LOCAL_STORAGE_ROUTE_PREFIX = '/v1/storage/local/';
const MAX_EXPIRES_SECONDS = 604_800;

/** The verified grant carried by a signed local storage URL. */
export type LocalStorageGrant =
  | { op: 'put'; contentType: string; byteSize: number; sha256Hex: string | null; expiresAt: Date }
  | {
      op: 'get';
      contentType: string;
      disposition: 'inline' | 'attachment';
      filename: string;
      expiresAt: Date;
    };

export type LocalSignatureResult =
  { ok: true; grant: LocalStorageGrant } | { ok: false; reason: 'invalid' | 'expired' };

type QueryLike = URLSearchParams | Readonly<Record<string, string | string[] | undefined>>;

function param(q: QueryLike, name: string): string | undefined {
  if (q instanceof URLSearchParams) {
    const all = q.getAll(name);
    return all.length === 1 ? all[0] : undefined;
  }
  const v = q[name];
  return typeof v === 'string' ? v : undefined;
}

/** Canonical string covered by the signature (op-specific fields are empty for the other op). */
function stringToSign(key: string, p: Record<string, string>): string {
  return [
    'pm-local-storage-v1',
    p.op,
    key,
    p.exp,
    p.ct,
    p.len ?? '',
    p.sha ?? '',
    p.disp ?? '',
    p.fn ?? '',
  ]
    .map((v) => `${Buffer.byteLength(v ?? '')}:${v ?? ''}`)
    .join('\n');
}

function sign(secret: string, key: string, p: Record<string, string>): string {
  return createHmac('sha256', secret).update(stringToSign(key, p), 'utf8').digest('hex');
}

/**
 * Verifies a signed local storage URL for `key` (the decoded route parameter) at `now`.
 * Every bound parameter is covered, so tampering with op, type, size, disposition or filename
 * invalidates the signature.
 */
export function verifyLocalSignature(
  secret: string | { reveal(): string },
  query: QueryLike,
  key: string,
  now: Date,
): LocalSignatureResult {
  const s = typeof secret === 'string' ? secret : secret.reveal();
  const invalid = { ok: false, reason: 'invalid' } as const;
  const op = param(query, 'op');
  const exp = param(query, 'exp');
  const ct = param(query, 'ct');
  const sig = param(query, 'sig');
  if ((op !== 'put' && op !== 'get') || !exp || !/^\d{1,12}$/.test(exp) || !ct || !sig)
    return invalid;
  if (!/^[0-9a-f]{64}$/.test(sig)) return invalid;
  try {
    assertObjectKey(key);
  } catch {
    return invalid;
  }
  const p: Record<string, string> = { op, exp, ct };
  if (op === 'put') {
    const len = param(query, 'len');
    if (!len || !/^\d{1,16}$/.test(len)) return invalid;
    p.len = len;
    const sha = param(query, 'sha');
    if (sha !== undefined) {
      if (!/^[0-9a-f]{64}$/.test(sha)) return invalid;
      p.sha = sha;
    }
  } else {
    const disp = param(query, 'disp');
    const fn = param(query, 'fn');
    if ((disp !== 'inline' && disp !== 'attachment') || fn === undefined) return invalid;
    p.disp = disp;
    p.fn = fn;
  }
  const expected = Buffer.from(sign(s, key, p), 'hex');
  if (!timingSafeEqual(expected, Buffer.from(sig, 'hex'))) return invalid;
  const expiresAt = new Date(Number(exp) * 1000);
  if (now.getTime() >= expiresAt.getTime()) return { ok: false, reason: 'expired' };
  return {
    ok: true,
    grant:
      op === 'put'
        ? {
            op,
            contentType: ct,
            byteSize: Number(p.len),
            sha256Hex: p.sha ?? null,
            expiresAt,
          }
        : {
            op,
            contentType: ct,
            disposition: p.disp as 'inline' | 'attachment',
            filename: p.fn!,
            expiresAt,
          },
  };
}

interface Meta {
  contentType: string | null;
  sha256Hex: string;
}

function isNotFound(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export class LocalObjectStorage implements ObjectStorage {
  readonly provider = 'local' as const;
  readonly #root: string;
  readonly #secret: string;
  readonly #base: string;
  readonly #now: () => Date;

  constructor(o: LocalObjectStorageOptions) {
    if (!o.dir || !o.secret) throw new TypeError('local storage requires dir and secret');
    this.#root = resolve(o.dir);
    this.#secret = o.secret;
    this.#base = o.publicBaseUrl.replace(/\/+$/, '');
    this.#now = o.now ?? (() => new Date());
  }

  #paths(key: string): { data: string; meta: string } {
    assertObjectKey(key);
    const data = resolve(join(this.#root, 'objects', key));
    const meta = resolve(join(this.#root, 'meta', `${key}.json`));
    for (const p of [data, meta])
      if (!p.startsWith(this.#root + sep)) throw new TypeError('invalid object key');
    return { data, meta };
  }

  #url(key: string, op: 'put' | 'get', p: Record<string, string>, expiresIn: number) {
    assertObjectKey(key);
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_EXPIRES_SECONDS)
      throw new RangeError(`expiresInSeconds must be 1..${MAX_EXPIRES_SECONDS}`);
    const expSeconds = Math.floor(this.#now().getTime() / 1000) + expiresIn;
    const params: Record<string, string> = { op, exp: String(expSeconds), ...p };
    const qs = new URLSearchParams(params);
    qs.set('sig', sign(this.#secret, key, params));
    return {
      url: `${this.#base}${LOCAL_STORAGE_ROUTE_PREFIX}${encodeURIComponent(key)}?${qs.toString()}`,
      expiresAt: new Date(expSeconds * 1000),
    };
  }

  presignPut(
    key: string,
    o: { contentType: string; byteSize: number; sha256Hex: string; expiresInSeconds: number },
  ): Promise<PresignedRequest> {
    if (!Number.isSafeInteger(o.byteSize) || o.byteSize < 0)
      return Promise.reject(new RangeError('byteSize must be a non-negative integer'));
    if (!/^[0-9a-f]{64}$/.test(o.sha256Hex))
      return Promise.reject(new TypeError('sha256Hex must be 64 lowercase hex chars'));
    const { url, expiresAt } = this.#url(
      key,
      'put',
      { ct: o.contentType, len: String(o.byteSize), sha: o.sha256Hex },
      o.expiresInSeconds,
    );
    return Promise.resolve({
      url,
      method: 'PUT',
      headers: { 'Content-Type': o.contentType },
      expiresAt,
    });
  }

  presignGet(
    key: string,
    o: {
      filename: string;
      contentType: string;
      disposition: 'inline' | 'attachment';
      expiresInSeconds: number;
    },
  ): Promise<PresignedRequest> {
    const { url, expiresAt } = this.#url(
      key,
      'get',
      { ct: o.contentType, disp: o.disposition, fn: sanitizeFilename(o.filename) },
      o.expiresInSeconds,
    );
    return Promise.resolve({ url, method: 'GET', headers: {}, expiresAt });
  }

  /** Response headers the API route sends for a verified GET grant. */
  static responseHeaders(grant: Extract<LocalStorageGrant, { op: 'get' }>): Record<string, string> {
    return {
      'content-type': grant.contentType,
      'content-disposition': contentDisposition(grant.disposition, grant.filename),
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
      'content-security-policy': "default-src 'none'; sandbox",
    };
  }

  /**
   * Stores bytes for a verified PUT grant (used by the API route). Refuses a size or checksum
   * that differs from what the URL was signed for.
   */
  async writeSignedPut(
    key: string,
    grant: Extract<LocalStorageGrant, { op: 'put' }>,
    bytes: Uint8Array,
  ): Promise<void> {
    if (bytes.byteLength !== grant.byteSize) throw new RangeError('content length mismatch');
    if (grant.sha256Hex !== null && sha256Hex(bytes) !== grant.sha256Hex)
      throw new RangeError('checksum mismatch');
    await this.writeObject(key, bytes, { contentType: grant.contentType });
  }

  /** Writes object bytes directly (route and test helper). */
  async writeObject(
    key: string,
    bytes: Uint8Array,
    o: { contentType: string | null },
  ): Promise<void> {
    const p = this.#paths(key);
    const meta: Meta = { contentType: o.contentType, sha256Hex: sha256Hex(bytes) };
    try {
      await mkdir(dirname(p.data), { recursive: true });
      await mkdir(dirname(p.meta), { recursive: true });
      await writeFile(p.data, bytes);
      await writeFile(p.meta, JSON.stringify(meta));
    } catch (cause) {
      throw new StorageUnavailableError('local storage write failed', { cause });
    }
  }

  /** Reads object bytes and metadata for the API route; null when missing. */
  async readObject(key: string): Promise<{ bytes: Uint8Array; contentType: string | null } | null> {
    const head = await this.head(key);
    if (!head) return null;
    const bytes = await this.read(key);
    return { bytes, contentType: head.contentType };
  }

  async head(key: string): Promise<ObjectHead | null> {
    const p = this.#paths(key);
    try {
      const st = await stat(p.data);
      let meta: Meta | null = null;
      try {
        meta = JSON.parse(await readFile(p.meta, 'utf8')) as Meta;
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
      return {
        byteSize: st.size,
        contentType: meta?.contentType ?? null,
        sha256Hex: meta?.sha256Hex ?? null,
      };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw new StorageUnavailableError('local storage head failed', { cause: e });
    }
  }

  async read(key: string, o: { maxBytes?: number } = {}): Promise<Uint8Array> {
    const p = this.#paths(key);
    const max = o.maxBytes;
    if (max !== undefined && (!Number.isSafeInteger(max) || max < 0))
      throw new RangeError('maxBytes must be a non-negative integer');
    try {
      if (max === undefined) return new Uint8Array(await readFile(p.data));
      const fh = await open(p.data, 'r');
      try {
        const buf = Buffer.alloc(Math.min(max, (await fh.stat()).size));
        let off = 0;
        while (off < buf.length) {
          const { bytesRead } = await fh.read(buf, off, buf.length - off, off);
          if (bytesRead === 0) break;
          off += bytesRead;
        }
        return new Uint8Array(buf.subarray(0, off));
      } finally {
        await fh.close();
      }
    } catch (e) {
      if (isNotFound(e)) throw new ObjectNotFoundError();
      throw new StorageUnavailableError('local storage read failed', { cause: e });
    }
  }

  async copy(fromKey: string, toKey: string): Promise<void> {
    const from = this.#paths(fromKey);
    const to = this.#paths(toKey);
    try {
      await mkdir(dirname(to.data), { recursive: true });
      await mkdir(dirname(to.meta), { recursive: true });
      await copyFile(from.data, to.data);
      try {
        await copyFile(from.meta, to.meta);
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    } catch (e) {
      if (isNotFound(e)) throw new ObjectNotFoundError();
      throw new StorageUnavailableError('local storage copy failed', { cause: e });
    }
  }

  async delete(key: string): Promise<void> {
    const p = this.#paths(key);
    try {
      await rm(p.data, { force: true });
      await rm(p.meta, { force: true });
    } catch (cause) {
      throw new StorageUnavailableError('local storage delete failed', { cause });
    }
  }

  async check(): Promise<StorageStatus> {
    try {
      await mkdir(this.#root, { recursive: true });
      await access(this.#root, constants.R_OK | constants.W_OK);
      return 'ok';
    } catch {
      return 'unavailable';
    }
  }
}
