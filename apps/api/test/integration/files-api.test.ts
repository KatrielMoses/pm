import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { createMalwareScanner, createObjectStorage, fileScanHandler } from '@pm/work';
import {
  Browser,
  idemKey,
  identityEnv,
  registerAndVerify,
  signIn,
  type IdentityEnv,
} from './identity-helpers.ts';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * 4E HTTP surface (ADR-0025; 0D PL-35): storage status, an upload session whose signed PUT goes
 * to the (dev/test) object store, completion, the scan, a 303 to a signed GET that serves the
 * bytes as an attachment with nosniff, previews, versions, links, deliverables reviewed through
 * 4A, tampered and expired signed URLs refused, the same not_found for strangers, no UUIDs.
 */
describe('files API (4E)', () => {
  let env: IdentityEnv;
  let owner: Browser;
  let stranger: Browser;
  let ws: string;
  let task: string;
  const bodies: string[] = [];
  const keep = (r: LightMyRequestResponse) => {
    bodies.push(r.body);
    return r;
  };
  const key = (extra: Record<string, string> = {}) => ({ 'idempotency-key': idemKey(), ...extra });
  const base = () => `/v1/workspaces/${ws}`;
  const path = (url: string) => {
    const u = new URL(url);
    return u.pathname + u.search;
  };

  async function person(email: string, ip: string): Promise<Browser> {
    const b = new Browser(env.app);
    b.ip = ip;
    await registerAndVerify(env, b, email);
    await signIn(b, email);
    return b;
  }
  const scan = async () => {
    const pending = await env.db.admin(
      `SELECT id, workspace_id FROM files.file_object WHERE scan_state = 'pending'`,
    );
    for (const r of pending.rows)
      await fileScanHandler({
        tenant: env.h.worker,
        discovery: env.h.discovery,
        storage: createObjectStorage(env.h.config.files.storage),
        scanner: createMalwareScanner(env.h.config.files.scanner),
        metrics: env.h.telemetry.metrics,
        logger: env.h.logger,
      }).handle({
        job: { workspaceId: r.workspace_id, payloadRef: r.id, attemptNumber: 1 },
        logger: env.h.logger,
      } as never);
  };

  beforeAll(async () => {
    env = await identityEnv({
      OBJECT_STORAGE: 'local',
      OBJECT_STORAGE_LOCAL_DIR: mkdtempSync(join(tmpdir(), 'pm-api-files-')),
      OBJECT_STORAGE_LOCAL_SECRET: randomBytes(32).toString('base64url'),
      OBJECT_STORAGE_PUBLIC_BASE_URL: 'http://127.0.0.1:4999',
      MALWARE_SCANNER: 'test-signature',
    });
    owner = await person('files-owner@example.test', '203.0.113.150');
    stranger = await person('files-stranger@example.test', '203.0.113.151');
    const created = await owner.post(
      '/v1/workspaces',
      {
        name: 'Files',
        timezone: 'UTC',
        locale: 'en',
        currency: 'USD',
        week_start: 1,
        first_brand: { name: 'Main' },
      },
      { headers: key() },
    );
    ws = created.json().data.id;
    const brand = created.json().data.first_brand.id;
    task = (
      await owner.post(`${base()}/tasks`, { brand, title: 'Ship it' }, { headers: key() })
    ).json().data.id;
  });
  afterAll(async () => {
    await env.close();
  });

  it('reports storage truthfully, uploads through a signed PUT, and downloads through a 303', async () => {
    const st = keep(await owner.get(`${base()}/storage`));
    expect(st.json().data).toMatchObject({
      type: 'storage_status',
      object_storage: 'ok',
      malware_scanner: 'ok',
      accepting_uploads: true,
    });
    const bytes = Buffer.from('release notes\n');
    const init = keep(
      await owner.post(
        `${base()}/uploads`,
        {
          host: task,
          name: 'notes.txt',
          content_type: 'text/plain',
          byte_size: bytes.length,
          sha256: sha(bytes),
        },
        { headers: key() },
      ),
    );
    expect(init.statusCode, init.body).toBe(201);
    const s = init.json().data;
    expect(s).toMatchObject({
      type: 'upload_session',
      state: 'initiated',
      upload: { method: 'PUT' },
    });
    expect(s.id).toMatch(/^upl_/);
    // A tampered URL is refused; the real one stores the bytes (exact length and checksum).
    const bad = await env.app.inject({
      method: 'PUT',
      url: path(s.upload.url).replace(/sig=[0-9a-f]+/, `sig=${'0'.repeat(64)}`),
      payload: bytes,
      headers: { 'content-type': 'text/plain' },
    });
    expect(bad.statusCode).toBe(403);
    const put = await env.app.inject({
      method: 'PUT',
      url: path(s.upload.url),
      payload: bytes,
      headers: { 'content-type': 'text/plain', ...s.upload.headers },
    });
    expect(put.statusCode, put.body).toBe(200);
    const done = keep(
      await owner.post(`${base()}/uploads/${s.id}:complete`, {}, { headers: key() }),
    );
    expect(done.statusCode, done.body).toBe(200);
    const file = done.json().data.file as string;
    expect(file).toMatch(/^file_/);
    const early = keep(await owner.get(`${base()}/files/${file}:download`));
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('file_not_ready');
    await scan();
    const dl = await owner.get(`${base()}/files/${file}:download`);
    expect(dl.statusCode).toBe(303);
    expect(dl.headers['cache-control']).toBe('no-store');
    const got = await env.app.inject({ method: 'GET', url: path(dl.headers.location as string) });
    expect(got.statusCode).toBe(200);
    expect(got.body).toBe('release notes\n');
    expect(got.headers['content-disposition']).toMatch(/^attachment;/);
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    const pv = keep(await owner.get(`${base()}/files/${file}:preview`));
    expect(pv.json().data).toMatchObject({ type: 'file_url', disposition: 'inline' });
    const listed = keep(await owner.get(`${base()}/files?host=${task}`));
    expect(listed.json()).toMatchObject({
      can_upload: true,
      data: [expect.objectContaining({ id: file })],
    });
    const renamed = keep(
      await owner.patch(
        `${base()}/files/${file}`,
        { name: 'release.txt' },
        { headers: key({ 'if-match': '"0"' }) },
      ),
    );
    expect(renamed.json().data.name).toBe('release.txt');
  });

  it('accepts the signed PUT from a signed-in browser (ambient cookie, no CSRF token; JSON body)', async () => {
    // A same-origin XHR carries the session cookie and Origin but no CSRF token; the signature is
    // the authorization. A JSON or text body must arrive as raw bytes, not a parsed value.
    const bytes = Buffer.from('{"a": 1}\n');
    const init = keep(
      await owner.post(
        `${base()}/uploads`,
        {
          host: task,
          name: 'data.json',
          content_type: 'application/json',
          byte_size: bytes.length,
          sha256: sha(bytes),
        },
        { headers: key() },
      ),
    );
    expect(init.statusCode, init.body).toBe(201);
    const s = init.json().data;
    const put = await env.app.inject({
      method: 'PUT',
      url: path(s.upload.url),
      payload: bytes,
      headers: {
        ...s.upload.headers,
        origin: owner.origin,
        cookie: [...owner.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
    });
    expect(put.statusCode, put.body).toBe(200);
    const done = keep(
      await owner.post(`${base()}/uploads/${s.id}:complete`, {}, { headers: key() }),
    );
    expect(done.json().data.state).toBe('completed');
  });

  it('links external files and runs a deliverable through review to acceptance', async () => {
    const link = keep(
      await owner.post(
        `${base()}/file-links`,
        { host: task, url: 'https://example.com/deck.pdf' },
        { headers: key() },
      ),
    );
    expect(link.statusCode, link.body).toBe(201);
    expect(link.json().data).toMatchObject({ type: 'file', source: 'external', name: 'deck.pdf' });
    const go = await owner.get(`${base()}/files/${link.json().data.id}:download`);
    expect(go.statusCode).toBe(303);
    expect(go.headers.location).toBe('https://example.com/deck.pdf');
    const d = keep(
      await owner.post(
        `${base()}/tasks/${task}/deliverables`,
        { title: 'Deck', expected_type: 'url' },
        { headers: key() },
      ),
    );
    expect(d.statusCode, d.body).toBe(201);
    expect(d.json().data.id).toMatch(/^dlv_/);
    const list = keep(await owner.get(`${base()}/tasks/${task}/deliverables`));
    expect(list.json().data).toMatchObject({ type: 'deliverable_list', counts: { draft: 1 } });
    const none = keep(
      await owner.post(
        `${base()}/deliverables/${d.json().data.id}:submit`,
        { url: 'https://example.com/v1' },
        { headers: key() },
      ),
    );
    expect(none.statusCode).toBe(422);
  });

  it('gives strangers the same not_found everywhere and never returns internal UUIDs', async () => {
    const f = (await owner.get(`${base()}/files?host=${task}`)).json().data[0].id as string;
    for (const [method, url] of [
      ['get', `${base()}/storage`],
      ['get', `${base()}/files?host=${task}`],
      ['get', `${base()}/files/${f}`],
      ['get', `${base()}/files/${f}:download`],
      ['get', `${base()}/files/${f}:preview`],
      ['get', `${base()}/tasks/${task}/deliverables`],
      ['post', `${base()}/uploads`],
      ['post', `${base()}/file-links`],
    ] as const) {
      // Well-formed bodies: the refusal is about the workspace, not the request shape.
      const body = url.endsWith('/uploads')
        ? {
            host: task,
            name: 'a.txt',
            content_type: 'text/plain',
            byte_size: 1,
            sha256: 'a'.repeat(64),
          }
        : { host: task, url: 'https://example.com/x' };
      const r =
        method === 'get'
          ? await stranger.get(url)
          : await stranger.post(url, body, { headers: key() });
      expect(r.statusCode, `${method} ${url}`).toBe(404);
    }
    for (const b of bodies) expect(b).not.toMatch(UUID);
  });
});
