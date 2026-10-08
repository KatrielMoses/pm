import { createHash, createHmac } from 'node:crypto';
import {
  assertObjectKey,
  contentDisposition,
  ObjectNotFoundError,
  sha256Base64ToHex,
  sha256HexToBase64,
  StorageUnavailableError,
  type ObjectHead,
  type ObjectStorage,
  type PresignedRequest,
  type StorageStatus,
} from './storage.ts';

/** AWS SigV4 query-string auth limit (7 days). */
export const S3_PRESIGN_MAX_SECONDS = 604_800;
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface S3ObjectStorageOptions {
  bucket: string;
  region: string;
  /** S3-compatible endpoint; defaults to `https://s3.<region>.amazonaws.com`. */
  endpoint?: string | undefined;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  /** Per-request timeout for header-auth requests (default 30 s). */
  requestTimeoutMs?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
}

/** RFC 3986 unreserved-only encoding (SigV4 `UriEncode`). */
export function sigV4Encode(value: string, keepSlash = false): string {
  const enc = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return keepSlash ? enc.replace(/%2F/g, '/') : enc;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function hashHex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** `YYYYMMDDTHHMMSSZ` */
export function amzDate(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function signingKey(c: SigV4Credentials, date: string): Buffer {
  const kDate = hmac(`AWS4${c.secretAccessKey}`, date);
  const kRegion = hmac(kDate, c.region);
  const kService = hmac(kRegion, c.service ?? 's3');
  return hmac(kService, 'aws4_request');
}

function canonicalQuery(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([k, v]) => [sigV4Encode(k), sigV4Encode(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function canonicalHeaders(headers: Record<string, string>): {
  canonical: string;
  signed: string;
} {
  const entries = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    canonical: entries.map(([k, v]) => `${k}:${v}\n`).join(''),
    signed: entries.map(([k]) => k).join(';'),
  };
}

export interface SigV4Request {
  method: string;
  /** Already URI-encoded absolute path (e.g. `/bucket/key%20name`). */
  path: string;
  /** Unencoded query parameters (encoded during canonicalization). */
  query: Record<string, string>;
  /** Headers to sign; must include `host`. */
  headers: Record<string, string>;
}

/** Builds the SigV4 canonical request (exported for tests). */
export function sigV4CanonicalRequest(req: SigV4Request, payloadHash: string): string {
  const { canonical, signed } = canonicalHeaders(req.headers);
  return [req.method, req.path, canonicalQuery(req.query), canonical, signed, payloadHash].join(
    '\n',
  );
}

function signature(
  creds: SigV4Credentials,
  now: Date,
  canonicalRequest: string,
): { signature: string; scope: string; date: string } {
  const date = amzDate(now);
  const day = date.slice(0, 8);
  const scope = `${day}/${creds.region}/${creds.service ?? 's3'}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, hashHex(canonicalRequest)].join('\n');
  return {
    signature: createHmac('sha256', signingKey(creds, day))
      .update(stringToSign, 'utf8')
      .digest('hex'),
    scope,
    date,
  };
}

/**
 * SigV4 query-string (presigned URL) signing. Returns the full query string, including
 * `X-Amz-Signature`, to append to `https://<host><path>?`.
 */
export function sigV4PresignQuery(
  creds: SigV4Credentials,
  req: SigV4Request,
  o: { now: Date; expiresInSeconds: number },
): string {
  if (
    !Number.isInteger(o.expiresInSeconds) ||
    o.expiresInSeconds < 1 ||
    o.expiresInSeconds > S3_PRESIGN_MAX_SECONDS
  )
    throw new RangeError(`expiresInSeconds must be 1..${S3_PRESIGN_MAX_SECONDS}`);
  const date = amzDate(o.now);
  const scope = `${date.slice(0, 8)}/${creds.region}/${creds.service ?? 's3'}/aws4_request`;
  const { signed } = canonicalHeaders(req.headers);
  const query: Record<string, string> = {
    ...req.query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${creds.accessKeyId}/${scope}`,
    'X-Amz-Date': date,
    'X-Amz-Expires': String(o.expiresInSeconds),
    'X-Amz-SignedHeaders': signed,
  };
  const canonical = sigV4CanonicalRequest({ ...req, query }, 'UNSIGNED-PAYLOAD');
  const sig = signature(creds, o.now, canonical).signature;
  return `${canonicalQuery(query)}&X-Amz-Signature=${sig}`;
}

/** SigV4 header auth: returns the headers to send (adds x-amz-date, x-amz-content-sha256, authorization). */
export function sigV4SignHeaders(
  creds: SigV4Credentials,
  req: SigV4Request,
  o: { now: Date; payloadHash?: string },
): Record<string, string> {
  const payloadHash = o.payloadHash ?? EMPTY_SHA256;
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v])),
    'x-amz-date': amzDate(o.now),
    'x-amz-content-sha256': payloadHash,
  };
  const canonical = sigV4CanonicalRequest({ ...req, headers }, payloadHash);
  const { signature: sig, scope } = signature(creds, o.now, canonical);
  const { signed } = canonicalHeaders(headers);
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${sig}`;
  return headers;
}

/** S3-compatible adapter: presigned URLs for the browser, header-auth fetch for the server. */
export class S3ObjectStorage implements ObjectStorage {
  readonly provider = 's3' as const;
  readonly #creds: SigV4Credentials;
  readonly #bucket: string;
  readonly #origin: URL;
  readonly #pathStyle: boolean;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #timeoutMs: number;

  constructor(o: S3ObjectStorageOptions) {
    if (!o.bucket || !o.region || !o.accessKeyId || !o.secretAccessKey)
      throw new TypeError('s3 storage requires bucket, region and credentials');
    this.#creds = {
      accessKeyId: o.accessKeyId,
      secretAccessKey: o.secretAccessKey,
      region: o.region,
    };
    this.#bucket = o.bucket;
    this.#origin = new URL(o.endpoint ?? `https://s3.${o.region}.amazonaws.com`);
    this.#pathStyle = o.forcePathStyle;
    this.#fetch = o.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = o.now ?? (() => new Date());
    this.#timeoutMs = o.requestTimeoutMs ?? 30_000;
  }

  /** Host and encoded path addressing `key` (or the bucket when key is undefined). */
  #target(key?: string): { host: string; path: string; base: string } {
    const encodedKey = key === undefined ? '' : sigV4Encode(key, true);
    const prefix = this.#origin.pathname.replace(/\/+$/, '');
    if (this.#pathStyle) {
      const path = `${prefix}/${sigV4Encode(this.#bucket)}${key === undefined ? '' : `/${encodedKey}`}`;
      return {
        host: this.#origin.host,
        path,
        base: `${this.#origin.protocol}//${this.#origin.host}`,
      };
    }
    const host = `${this.#bucket}.${this.#origin.host}`;
    return { host, path: `${prefix}/${encodedKey}`, base: `${this.#origin.protocol}//${host}` };
  }

  #presign(
    method: 'PUT' | 'GET',
    key: string,
    query: Record<string, string>,
    headers: Record<string, string>,
    expiresInSeconds: number,
  ): PresignedRequest {
    assertObjectKey(key);
    const now = this.#now();
    const t = this.#target(key);
    const qs = sigV4PresignQuery(
      this.#creds,
      { method, path: t.path, query, headers: { host: t.host, ...headers } },
      { now, expiresInSeconds },
    );
    return {
      url: `${t.base}${t.path}?${qs}`,
      method,
      headers: {},
      expiresAt: new Date(now.getTime() + expiresInSeconds * 1000),
    };
  }

  presignPut(
    key: string,
    o: { contentType: string; byteSize: number; sha256Hex: string; expiresInSeconds: number },
  ): Promise<PresignedRequest> {
    if (!Number.isSafeInteger(o.byteSize) || o.byteSize < 0)
      return Promise.reject(new RangeError('byteSize must be a non-negative integer'));
    const checksum = sha256HexToBase64(o.sha256Hex);
    const req = this.#presign(
      'PUT',
      key,
      {},
      {
        'content-type': o.contentType,
        'content-length': String(o.byteSize),
        'x-amz-checksum-sha256': checksum,
      },
      o.expiresInSeconds,
    );
    // Content-Length is set by the HTTP client from the body; it is signed, so it must match.
    req.headers = { 'Content-Type': o.contentType, 'x-amz-checksum-sha256': checksum };
    return Promise.resolve(req);
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
    // S3 offers no nosniff override; the API sets it on its own responses and the bucket policy
    // must serve objects from a separate origin.
    return Promise.resolve(
      this.#presign(
        'GET',
        key,
        {
          'response-content-disposition': contentDisposition(o.disposition, o.filename),
          'response-content-type': o.contentType,
          'response-cache-control': 'private, no-store',
        },
        {},
        o.expiresInSeconds,
      ),
    );
  }

  async #send(
    method: 'HEAD' | 'GET' | 'PUT' | 'DELETE',
    key: string | undefined,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    if (key !== undefined) assertObjectKey(key);
    const t = this.#target(key);
    const headers = sigV4SignHeaders(
      this.#creds,
      { method, path: t.path, query: {}, headers: { host: t.host, ...extraHeaders } },
      { now: this.#now() },
    );
    delete headers.host;
    let res: Response;
    try {
      res = await this.#fetch(`${t.base}${t.path}`, {
        method,
        headers,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      throw new StorageUnavailableError(`object storage ${method} failed`, { cause });
    }
    if (res.status >= 500) {
      await res.body?.cancel();
      throw new StorageUnavailableError(`object storage ${method} returned ${res.status}`);
    }
    return res;
  }

  async head(key: string): Promise<ObjectHead | null> {
    const res = await this.#send('HEAD', key, { 'x-amz-checksum-mode': 'ENABLED' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`object storage HEAD returned ${res.status}`);
    const checksum = res.headers.get('x-amz-checksum-sha256');
    return {
      byteSize: Number(res.headers.get('content-length') ?? 0),
      contentType: res.headers.get('content-type'),
      // Multipart composite checksums ("...-N") are not whole-object digests.
      sha256Hex: checksum && !checksum.includes('-') ? sha256Base64ToHex(checksum) : null,
    };
  }

  async read(key: string, o: { maxBytes?: number } = {}): Promise<Uint8Array> {
    const max = o.maxBytes;
    if (max !== undefined && (!Number.isSafeInteger(max) || max < 0))
      throw new RangeError('maxBytes must be a non-negative integer');
    if (max === 0) return new Uint8Array(0);
    const res = await this.#send(
      'GET',
      key,
      max === undefined ? {} : { range: `bytes=0-${max - 1}` },
    );
    if (res.status === 404) {
      await res.body?.cancel();
      throw new ObjectNotFoundError();
    }
    // Ranged read of an empty object.
    if (res.status === 416) {
      await res.body?.cancel();
      return new Uint8Array(0);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`object storage GET returned ${res.status}`);
    }
    return readBounded(res, max);
  }

  async copy(fromKey: string, toKey: string): Promise<void> {
    assertObjectKey(fromKey);
    const source = `/${sigV4Encode(this.#bucket)}/${sigV4Encode(fromKey, true)}`;
    const res = await this.#send('PUT', toKey, { 'x-amz-copy-source': source });
    const body = await res.text().catch(() => '');
    if (res.status === 404) throw new ObjectNotFoundError();
    if (!res.ok) throw new Error(`object storage copy returned ${res.status}`);
    // S3 may answer 200 with an error document when the copy fails mid-flight.
    if (/<Error>/.test(body)) throw new StorageUnavailableError('object storage copy failed');
  }

  async delete(key: string): Promise<void> {
    const res = await this.#send('DELETE', key);
    await res.body?.cancel();
    if (res.ok || res.status === 404) return;
    throw new Error(`object storage DELETE returned ${res.status}`);
  }

  async check(): Promise<StorageStatus> {
    try {
      const res = await this.#send('HEAD', undefined);
      return res.ok ? 'ok' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }
}

async function readBounded(res: Response, max: number | undefined): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = max === undefined ? value.byteLength : max - total;
      chunks.push(value.byteLength > room ? value.subarray(0, room) : value);
      total += Math.min(value.byteLength, room);
      if (max !== undefined && total >= max) {
        await reader.cancel();
        break;
      }
    }
  } catch (cause) {
    throw new StorageUnavailableError('object storage read failed', { cause });
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
