import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Secret } from '@pm/config';
import {
  contentDisposition,
  createObjectStorage,
  LocalObjectStorage,
  ObjectNotFoundError,
  S3ObjectStorage,
  sha256Hex,
  sigV4PresignQuery,
  sigV4SignHeaders,
  StorageUnavailableError,
  verifyLocalSignature,
} from '@pm/work';

const AWS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', // gitleaks:allow (AWS docs example)
  region: 'us-east-1',
};
const AWS_NOW = new Date('2013-05-24T00:00:00Z');

describe('contentDisposition', () => {
  it('emits an ASCII fallback and an RFC 5987 filename* for unicode names', () => {
    expect(contentDisposition('attachment', 'résumé 2026.pdf')).toBe(
      `attachment; filename="r_sum_ 2026.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%202026.pdf`,
    );
    expect(contentDisposition('inline', '报告.png')).toBe(
      `inline; filename="__.png"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.png`,
    );
  });

  it('strips quotes, CR/LF and path separators so no header can be injected', () => {
    const v = contentDisposition('attachment', '../../etc/"pass"\r\nSet-Cookie: x=1\\wd.txt');
    expect(v).not.toMatch(/[\r\n]/);
    expect(v).toBe(
      `attachment; filename=".._.._etc__pass_Set-Cookie: x=1_wd.txt"; filename*=UTF-8''.._.._etc__pass_Set-Cookie%3A%20x%3D1_wd.txt`,
    );
  });

  it('encodes RFC 5987 specials and falls back to a default name', () => {
    expect(contentDisposition('attachment', "it's (1)*%;.txt")).toBe(
      `attachment; filename="it's (1)*__.txt"; filename*=UTF-8''it%27s%20%281%29%2A%25%3B.txt`,
    );
    expect(contentDisposition('attachment', '\u0000\u0007')).toBe(
      `attachment; filename="download"; filename*=UTF-8''download`,
    );
  });
});

describe('S3 SigV4', () => {
  it('matches the AWS documented presigned-URL example', () => {
    const qs = sigV4PresignQuery(
      AWS,
      {
        method: 'GET',
        path: '/test.txt',
        query: {},
        headers: { host: 'examplebucket.s3.amazonaws.com' },
      },
      { now: AWS_NOW, expiresInSeconds: 86400 },
    );
    expect(qs).toBe(
      'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  it('matches the AWS documented header-auth GET example', () => {
    const h = sigV4SignHeaders(
      AWS,
      {
        method: 'GET',
        path: '/test.txt',
        query: {},
        headers: { Host: 'examplebucket.s3.amazonaws.com', Range: 'bytes=0-9' },
      },
      { now: AWS_NOW },
    );
    expect(h.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('refuses expiries beyond seven days', () => {
    expect(() =>
      sigV4PresignQuery(
        AWS,
        { method: 'GET', path: '/k', query: {}, headers: { host: 'h' } },
        { now: AWS_NOW, expiresInSeconds: 604_801 },
      ),
    ).toThrow(RangeError);
  });

  it('presigns uploads bound to type, length and checksum, and downloads with overrides', async () => {
    const s3 = new S3ObjectStorage({
      ...AWS,
      bucket: 'examplebucket',
      endpoint: 'http://minio.local:9000',
      forcePathStyle: true,
      now: () => AWS_NOW,
    });
    const sha = sha256Hex(new TextEncoder().encode('hello'));
    const put = await s3.presignPut('ws/1/a b.txt', {
      contentType: 'text/plain',
      byteSize: 5,
      sha256Hex: sha,
      expiresInSeconds: 900,
    });
    const u = new URL(put.url);
    expect(u.origin + u.pathname).toBe('http://minio.local:9000/examplebucket/ws/1/a%20b.txt');
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host;x-amz-checksum-sha256',
    );
    expect(put.headers).toEqual({
      'Content-Type': 'text/plain',
      'x-amz-checksum-sha256': Buffer.from(sha, 'hex').toString('base64'),
    });
    expect(put.expiresAt.toISOString()).toBe('2013-05-24T00:15:00.000Z');

    const get = await s3.presignGet('ws/1/a b.txt', {
      filename: 'a b.txt',
      contentType: 'text/plain',
      disposition: 'attachment',
      expiresInSeconds: 60,
    });
    const g = new URL(get.url);
    expect(g.searchParams.get('response-content-disposition')).toBe(
      `attachment; filename="a b.txt"; filename*=UTF-8''a%20b.txt`,
    );
    expect(g.searchParams.get('response-content-type')).toBe('text/plain');

    const vhost = new S3ObjectStorage({
      ...AWS,
      bucket: 'examplebucket',
      forcePathStyle: false,
      now: () => AWS_NOW,
    });
    const v = await vhost.presignGet('k', {
      filename: 'k',
      contentType: 'application/pdf',
      disposition: 'inline',
      expiresInSeconds: 60,
    });
    expect(new URL(v.url).host).toBe('examplebucket.s3.us-east-1.amazonaws.com');
  });
});

describe('S3 adapter requests', () => {
  type Call = { url: string; init: RequestInit };
  const make = (respond: (c: Call) => Response | Promise<Response>) => {
    const calls: Call[] = [];
    const fetchMock = ((url: string, init: RequestInit) => {
      const c = { url, init };
      calls.push(c);
      return Promise.resolve(respond(c));
    }) as unknown as typeof fetch;
    const s3 = new S3ObjectStorage({
      ...AWS,
      bucket: 'b',
      endpoint: 'https://s3.example.test',
      forcePathStyle: true,
      fetch: fetchMock,
      now: () => AWS_NOW,
    });
    return { s3, calls };
  };
  const hdr = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];

  it('HEAD maps metadata and the checksum; 404 is null', async () => {
    const sha = sha256Hex(new Uint8Array([1, 2, 3]));
    const { s3, calls } = make(
      () =>
        new Response(null, {
          status: 200,
          headers: {
            'content-length': '3',
            'content-type': 'image/png',
            'x-amz-checksum-sha256': Buffer.from(sha, 'hex').toString('base64'),
          },
        }),
    );
    expect(await s3.head('k/1')).toEqual({ byteSize: 3, contentType: 'image/png', sha256Hex: sha });
    expect(calls[0]!.init.method).toBe('HEAD');
    expect(calls[0]!.url).toBe('https://s3.example.test/b/k/1');
    expect(hdr(calls[0]!, 'x-amz-checksum-mode')).toBe('ENABLED');
    expect(hdr(calls[0]!, 'authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-checksum-mode;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    const missing = make(() => new Response(null, { status: 404 }));
    expect(await missing.s3.head('k/1')).toBeNull();
  });

  it('DELETE is idempotent on 404 and copy sends the encoded copy source', async () => {
    const { s3 } = make(() => new Response(null, { status: 404 }));
    await expect(s3.delete('gone')).resolves.toBeUndefined();
    await expect(s3.copy('a', 'b')).rejects.toBeInstanceOf(ObjectNotFoundError);

    const ok = make(() => new Response('<CopyObjectResult/>', { status: 200 }));
    await ok.s3.copy('src/a b.txt', 'dst/c.txt');
    expect(ok.calls[0]!.init.method).toBe('PUT');
    expect(ok.calls[0]!.url).toBe('https://s3.example.test/b/dst/c.txt');
    expect(hdr(ok.calls[0]!, 'x-amz-copy-source')).toBe('/b/src/a%20b.txt');

    const late = make(() => new Response('<Error><Code>InternalError</Code></Error>'));
    await expect(late.s3.copy('a', 'b')).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it('maps 5xx and network failures to StorageUnavailableError', async () => {
    const down = make(() => new Response('oops', { status: 503 }));
    await expect(down.s3.head('k')).rejects.toBeInstanceOf(StorageUnavailableError);
    await expect(down.s3.delete('k')).rejects.toBeInstanceOf(StorageUnavailableError);
    await expect(down.s3.read('k')).rejects.toBeInstanceOf(StorageUnavailableError);
    expect(await down.s3.check()).toBe('unavailable');
    const broken = make(() => Promise.reject(new TypeError('fetch failed')));
    await expect(broken.s3.copy('a', 'b')).rejects.toBeInstanceOf(StorageUnavailableError);
    const up = make(() => new Response(null, { status: 200 }));
    expect(await up.s3.check()).toBe('ok');
    expect(up.calls[0]!.url).toBe('https://s3.example.test/b');
  });

  it('read bounds bytes with a Range request', async () => {
    const { s3, calls } = make(
      () => new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 206 }),
    );
    expect([...(await s3.read('k', { maxBytes: 3 }))]).toEqual([1, 2, 3]);
    expect(hdr(calls[0]!, 'range')).toBe('bytes=0-2');
    const missing = make(() => new Response(null, { status: 404 }));
    await expect(missing.s3.read('k')).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it('refuses traversal keys', async () => {
    const { s3 } = make(() => new Response(null));
    await expect(s3.head('../x')).rejects.toThrow('invalid object key');
  });
});

describe('local storage', () => {
  const secret = 'k'.repeat(43);
  let dir: string;
  let store: LocalObjectStorage;
  const now = new Date('2026-10-08T12:00:00Z');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pm-files-'));
    store = new LocalObjectStorage({
      dir,
      secret,
      publicBaseUrl: 'http://127.0.0.1:3000/',
      now: () => now,
    });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const parse = (url: string) => {
    const u = new URL(url);
    const key = decodeURIComponent(u.pathname.replace('/v1/storage/local/', ''));
    return { key, q: u.searchParams };
  };

  it('signs PUT and GET URLs that verify, and stores bytes through the route helpers', async () => {
    const bytes = new TextEncoder().encode('hello');
    const sha = sha256Hex(bytes);
    const put = await store.presignPut('ws/1/f', {
      contentType: 'text/plain',
      byteSize: 5,
      sha256Hex: sha,
      expiresInSeconds: 60,
    });
    expect(put.url.startsWith('http://127.0.0.1:3000/v1/storage/local/ws%2F1%2Ff?op=put&')).toBe(
      true,
    );
    const { key, q } = parse(put.url);
    const res = verifyLocalSignature(new Secret(secret), q, key, now);
    expect(res).toEqual({
      ok: true,
      grant: {
        op: 'put',
        contentType: 'text/plain',
        byteSize: 5,
        sha256Hex: sha,
        expiresAt: put.expiresAt,
      },
    });
    if (!res.ok || res.grant.op !== 'put') throw new Error('unreachable');
    await expect(store.writeSignedPut(key, res.grant, new Uint8Array(4))).rejects.toThrow(
      'content length mismatch',
    );
    await expect(store.writeSignedPut(key, res.grant, new Uint8Array(5))).rejects.toThrow(
      'checksum mismatch',
    );
    await store.writeSignedPut(key, res.grant, bytes);
    expect(await store.head(key)).toEqual({
      byteSize: 5,
      contentType: 'text/plain',
      sha256Hex: sha,
    });
    expect(new TextDecoder().decode(await store.read(key, { maxBytes: 2 }))).toBe('he');

    const get = await store.presignGet(key, {
      filename: 'a/"b".txt',
      contentType: 'text/plain',
      disposition: 'attachment',
      expiresInSeconds: 60,
    });
    const g = parse(get.url);
    const gr = verifyLocalSignature(secret, g.q, g.key, now);
    if (!gr.ok || gr.grant.op !== 'get') throw new Error('expected a get grant');
    expect(LocalObjectStorage.responseHeaders(gr.grant)).toMatchObject({
      'content-disposition': `attachment; filename="a__b_.txt"; filename*=UTF-8''a__b_.txt`,
      'x-content-type-options': 'nosniff',
    });
    expect((await store.readObject(key))?.contentType).toBe('text/plain');
  });

  it('rejects tampering, op mismatch, wrong key, wrong secret and expiry', async () => {
    const put = await store.presignPut('k', {
      contentType: 'text/plain',
      byteSize: 5,
      sha256Hex: '0'.repeat(64),
      expiresInSeconds: 60,
    });
    const { key, q } = parse(put.url);
    const tamper = (name: string, value: string) => {
      const c = new URLSearchParams(q);
      c.set(name, value);
      return verifyLocalSignature(secret, c, key, now);
    };
    expect(tamper('len', '6')).toEqual({ ok: false, reason: 'invalid' });
    expect(tamper('ct', 'text/html')).toEqual({ ok: false, reason: 'invalid' });
    expect(tamper('exp', String(Number(q.get('exp')) + 1000))).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(tamper('op', 'get')).toEqual({ ok: false, reason: 'invalid' });
    expect(tamper('sig', 'zz')).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyLocalSignature(secret, q, 'other', now)).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyLocalSignature('x'.repeat(43), q, key, now)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(verifyLocalSignature(secret, q, key, new Date(now.getTime() + 60_000))).toEqual({
      ok: false,
      reason: 'expired',
    });
    const dup = new URLSearchParams(q);
    dup.append('op', 'put');
    expect(verifyLocalSignature(secret, dup, key, now)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('copies, deletes idempotently, reports missing objects and refuses traversal', async () => {
    await store.writeObject('a/1', new Uint8Array([9]), { contentType: 'image/png' });
    await store.copy('a/1', 'b/2');
    expect(await store.head('b/2')).toMatchObject({ byteSize: 1, contentType: 'image/png' });
    await store.delete('a/1');
    await store.delete('a/1');
    expect(await store.head('a/1')).toBeNull();
    await expect(store.read('a/1')).rejects.toBeInstanceOf(ObjectNotFoundError);
    await expect(store.copy('a/1', 'c')).rejects.toBeInstanceOf(ObjectNotFoundError);
    await expect(store.head('../escape')).rejects.toThrow('invalid object key');
    await expect(store.head('/abs')).rejects.toThrow('invalid object key');
    expect(await store.check()).toBe('ok');
  });
});

describe('createObjectStorage', () => {
  it('builds adapters from config and returns null when not configured', () => {
    expect(createObjectStorage({ provider: 'none' })).toBeNull();
    expect(
      createObjectStorage({
        provider: 'local',
        dir: '/tmp/x',
        secret: new Secret('s'.repeat(43)),
        publicBaseUrl: 'http://127.0.0.1:3000',
      })?.provider,
    ).toBe('local');
    expect(
      createObjectStorage({
        provider: 's3',
        bucket: 'b',
        region: 'us-east-1',
        endpoint: undefined,
        forcePathStyle: false,
        accessKeyId: 'a',
        secretAccessKey: new Secret('s'),
      })?.provider,
    ).toBe('s3');
  });
});
