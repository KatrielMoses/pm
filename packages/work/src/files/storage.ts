import { createHash } from 'node:crypto';
import type { FilesStorageConfig } from '@pm/config';
import { LocalObjectStorage } from './local-storage.ts';
import { S3ObjectStorage } from './s3-storage.ts';

export type { FilesStorageConfig } from '@pm/config';

/**
 * Provider-neutral object storage port (4E). Adapters: S3-compatible (SigV4) and a local
 * filesystem adapter for development and tests.
 */
export type StorageStatus = 'ok' | 'not_configured' | 'unavailable';

export interface PresignedRequest {
  url: string;
  method: 'PUT' | 'GET';
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface ObjectHead {
  byteSize: number;
  contentType: string | null;
  sha256Hex: string | null;
}

export interface ObjectStorage {
  readonly provider: 's3' | 'local';
  /** Upload URL bound to key, exact content length and content type (and sha256 when the provider supports checksum headers). */
  presignPut(
    key: string,
    o: { contentType: string; byteSize: number; sha256Hex: string; expiresInSeconds: number },
  ): Promise<PresignedRequest>;
  /** Download URL; disposition 'attachment' always sets Content-Disposition attachment with an RFC 6266 filename*; 'inline' only when the caller allows it. Responses must carry X-Content-Type-Options: nosniff where the provider allows response-header overrides. */
  presignGet(
    key: string,
    o: {
      filename: string;
      contentType: string;
      disposition: 'inline' | 'attachment';
      expiresInSeconds: number;
    },
  ): Promise<PresignedRequest>;
  head(key: string): Promise<ObjectHead | null>;
  /** Streams the object (for scanning, checksum verification, and bounded text comparison); maxBytes bounds what is read. */
  read(key: string, o?: { maxBytes?: number }): Promise<Uint8Array>;
  copy(fromKey: string, toKey: string): Promise<void>;
  /** Idempotent: deleting a missing key succeeds. */
  delete(key: string): Promise<void>;
  /** Cheap readiness probe. */
  check(): Promise<StorageStatus>;
}

/** Thrown by adapters on network failures, timeouts and provider 5xx responses. */
export class StorageUnavailableError extends Error {
  constructor(message = 'object storage is unavailable', options?: ErrorOptions) {
    super(message, options);
    this.name = 'StorageUnavailableError';
  }
}

/** Thrown by `read` and `copy` when the (source) object does not exist. */
export class ObjectNotFoundError extends Error {
  constructor(message = 'object not found') {
    super(message);
    this.name = 'ObjectNotFoundError';
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Hex SHA-256 → base64 (the `x-amz-checksum-sha256` encoding). */
export function sha256HexToBase64(hex: string): string {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new TypeError('sha256Hex must be 64 lowercase hex chars');
  return Buffer.from(hex, 'hex').toString('base64');
}

/** Base64 SHA-256 → hex; null when the value is not a 32-byte digest. */
export function sha256Base64ToHex(b64: string): string | null {
  const buf = Buffer.from(b64, 'base64');
  return buf.length === 32 ? buf.toString('hex') : null;
}

const MAX_FILENAME_CHARS = 200;

/** Removes control characters, quotes and path separators; never returns an empty name. */
export function sanitizeFilename(filename: string): string {
  let name = filename
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '')
    .replace(/["\\/]/g, '_')
    .trim();
  if (name === '.' || name === '..') name = '';
  const chars = [...name];
  if (chars.length > MAX_FILENAME_CHARS) name = chars.slice(0, MAX_FILENAME_CHARS).join('');
  return name || 'download';
}

/** RFC 5987 attr-char encoding (UTF-8 percent-encoding). */
function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * RFC 6266 Content-Disposition with an ASCII `filename` fallback and an RFC 5987 `filename*`.
 * Control characters (so no CR/LF header injection), quotes and path separators are stripped.
 */
export function contentDisposition(disposition: 'inline' | 'attachment', filename: string): string {
  const type = disposition === 'inline' ? 'inline' : 'attachment';
  const name = sanitizeFilename(filename);
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/[%;]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${rfc5987(name)}`;
}

/** Validates an object key: relative, no traversal segments, no control characters. */
export function assertObjectKey(key: string): void {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    Buffer.byteLength(key) > 1024 ||
    key.startsWith('/') ||
    key.includes('\\') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(key) ||
    key.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
  ) {
    throw new TypeError('invalid object key');
  }
}

export function createObjectStorage(cfg: FilesStorageConfig): ObjectStorage | null {
  switch (cfg.provider) {
    case 's3':
      return new S3ObjectStorage({
        bucket: cfg.bucket,
        region: cfg.region,
        endpoint: cfg.endpoint,
        forcePathStyle: cfg.forcePathStyle,
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey.reveal(),
      });
    case 'local':
      return new LocalObjectStorage({
        dir: cfg.dir,
        secret: cfg.secret.reveal(),
        publicBaseUrl: cfg.publicBaseUrl,
      });
    default:
      return null;
  }
}
