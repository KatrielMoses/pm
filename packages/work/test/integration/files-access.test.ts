import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OBJECT_DELETE_DESTINATION } from '@pm/lifecycle';
import { createOperation, recordEffect } from '@pm/platform';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import {
  fileScanHandler,
  fileSweepHandler,
  LocalObjectStorage,
  productLifecycleRegistry,
  StorageUnavailableError,
  type FileJobDeps,
  type ObjectStorage,
} from '@pm/work';
import { systemExec } from '../../src/notify/system.ts';
import {
  apply,
  join,
  membershipOf,
  mutation,
  seedAccount,
  workEnv,
  workspaceIdOf,
  workspaceWith,
  WORKSPACE_INPUT,
  type WorkEnv,
} from './fixture.ts';

const reason = (code: string) => expect.objectContaining({ code });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * Phase 4E authorization, isolation, concurrency, idempotency, provider failure and recovery, and
 * deletion on real PostgreSQL (ADR-0026; 0C AZ-34). Every role and share kind sees exactly the
 * files its host allows; hidden and cross-workspace files are `not_found`; races settle once;
 * replays never double-count; an unavailable store is a retryable refusal that recovers; a purge
 * removes rows and its object deletions are performed once by the sweep.
 */
describe('Files access, concurrency, recovery, and deletion (4E)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let admin: Caller;
  let editor: Caller;
  let viewer: Caller;
  let readOnly: Caller;
  let shareOnly: Caller;
  let guest: Caller;
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  let open: string;
  let shared: string;
  let secret: string;
  let storage: LocalObjectStorage;
  let jobs: FileJobDeps;
  const mem = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
  const keyOf = async (upl: string) =>
    (
      await db.admin(
        `SELECT quarantine_object_key AS k FROM files.upload_session WHERE public_id = $1`,
        [upl],
      )
    ).rows[0].k as string;
  const start = (as: Caller, host: string, name = 'a.txt', bytes = Buffer.from('abc'), e = env) =>
    e.svc.initiateUpload(
      as,
      ws,
      { host, name, content_type: 'text/plain', byte_size: bytes.length, sha256: sha(bytes) },
      mutation(),
    );
  const upload = async (as: Caller, host: string, name = 'a.txt', bytes = Buffer.from('abc')) => {
    const s = (await start(as, host, name, bytes)).data;
    await storage.writeObject(await keyOf(s.id), bytes, { contentType: 'text/plain' });
    const done = (await env.svc.completeUpload(as, ws, s.id, mutation())).data;
    await scan();
    return done.file!;
  };
  const scan = async () => {
    for (const r of (
      await db.admin(`SELECT id FROM files.file_object WHERE scan_state = 'pending'`)
    ).rows)
      await fileScanHandler(jobs).handle({
        job: { workspaceId: wsId, payloadRef: r.id, attemptNumber: 1 },
        logger: env.h.logger,
      } as never);
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    storage = env.files.storage as LocalObjectStorage;
    jobs = {
      tenant: env.h.worker,
      discovery: env.h.discovery,
      storage: env.files.storage,
      scanner: env.files.scanner,
      metrics: env.h.telemetry.metrics,
      logger: env.h.logger,
    };
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Main', 'Secret']));
    wsId = await workspaceIdOf(db, ws);
    env.stepUp.allow = true;
    await env.svc.setSensitivity(
      owner,
      ws,
      brands.Secret,
      { is_sensitive: true },
      mutation({ ifMatch: '"0"', stepUpToken: 't' }),
    );
    env.stepUp.allow = false;
    admin = await join(env, db, owner, ws, { kind: 'member', role: 'administrator' });
    editor = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    viewer = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    readOnly = await join(env, db, owner, ws, { kind: 'member', role: 'read_only' });
    shareOnly = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    for (const [who, level] of [
      [editor, 'edit'],
      [viewer, 'view'],
      [readOnly, 'view'],
    ] as const)
      await apply(env, owner, ws, {
        kind: 'brand_grant',
        brand: brands.Main,
        principal: await mem(who),
        level,
      });
    open = (await env.svc.createTask(owner, ws, { brand: brands.Main, title: 'Open' }, mutation()))
      .data.id;
    shared = (
      await env.svc.createTask(owner, ws, { brand: brands.Main, title: 'Shared' }, mutation())
    ).data.id;
    secret = (
      await env.svc.createTask(owner, ws, { brand: brands.Secret, title: 'Secret' }, mutation())
    ).data.id;
    await apply(env, owner, ws, {
      kind: 'record_share',
      record: shared,
      grantee: await mem(shareOnly),
      level: 'view',
    });
    guest = await join(env, db, owner, ws, {
      kind: 'guest',
      records: [{ record: shared, level: 'comment' }],
    });
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('decides upload, read, and download by role, share, and host', async () => {
    const onOpen = await upload(owner, open, 'open.txt');
    const onShared = await upload(owner, shared, 'shared.txt');
    const onSecret = await upload(owner, secret, 'secret.txt');
    const onWorkspace = await upload(owner, 'workspace', 'handbook.txt');
    // Editors upload; viewers and read-only members read and download but cannot upload.
    await upload(editor, open, 'editor.txt');
    for (const who of [viewer, readOnly]) {
      await expect(start(who, open)).rejects.toEqual(reason('forbidden'));
      expect((await env.svc.fileUrl(who, ws, onOpen, {})).kind).toBe('object');
    }
    await upload(admin, open, 'admin.txt');
    // A share reaches exactly the shared task's files; everything else is not_found.
    expect((await env.svc.fileUrl(shareOnly, ws, onShared, {})).kind).toBe('object');
    for (const who of [shareOnly, guest])
      for (const id of [onOpen, onSecret])
        await expect(env.svc.getFile(who, ws, id)).rejects.toEqual(reason('not_found'));
    // Workspace files are for internal members (OD-06), never guests.
    expect((await env.svc.getFile(shareOnly, ws, onWorkspace)).name).toBe('handbook.txt');
    await expect(env.svc.getFile(guest, ws, onWorkspace)).rejects.toEqual(reason('not_found'));
    // Guests never see workspace files or storage; the sensitive brand is the owner's alone.
    await expect(env.svc.listFiles(guest, ws, 'workspace')).rejects.toEqual(reason('not_found'));
    await expect(env.svc.storageStatus(guest, ws)).rejects.toEqual(reason('not_found'));
    for (const who of [admin, editor, viewer])
      await expect(env.svc.fileUrl(who, ws, onSecret, {})).rejects.toEqual(reason('not_found'));
    expect((await env.svc.listFiles(viewer, ws, 'workspace')).data.map((f) => f.id)).toEqual([
      onWorkspace,
    ]);
  });

  it('lets only the comment author attach to a comment, under the comment host’s authority', async () => {
    const c = (await env.svc.createComment(editor, ws, open, { text: 'See attached' }, mutation()))
      .data;
    await upload(editor, c.id, 'att.txt');
    await expect(start(owner, c.id)).rejects.toEqual(reason('forbidden'));
    expect((await env.svc.listFiles(viewer, ws, c.id)).data).toHaveLength(1);
    await expect(env.svc.listFiles(shareOnly, ws, c.id)).rejects.toEqual(reason('not_found'));
  });

  it('keeps workspaces apart: another workspace’s identifiers are not_found', async () => {
    const other = await seedAccount(db);
    const made = await env.svc.createWorkspace(
      other,
      { ...WORKSPACE_INPUT, name: 'Other', first_brand: { name: 'O' } },
      mutation(),
    );
    const oTask = (
      await env.svc.createTask(
        other,
        made.data.workspace.id,
        { brand: made.data.first_brand!.id, title: 'T' },
        mutation(),
      )
    ).data.id;
    const mine = (await env.svc.listFiles(owner, ws, open)).data[0]!.id;
    await expect(env.svc.getFile(other, made.data.workspace.id, mine)).rejects.toEqual(
      reason('not_found'),
    );
    await expect(env.svc.listFiles(owner, ws, oTask)).rejects.toEqual(reason('not_found'));
  });

  it('settles concurrent completions once and replays an idempotency key without double counting', async () => {
    const bytes = Buffer.from('race');
    const s = (await start(owner, open, 'race.txt', bytes)).data;
    await storage.writeObject(await keyOf(s.id), bytes, { contentType: 'text/plain' });
    const before = (await env.svc.storageStatus(owner, ws)).used_bytes;
    const both = await Promise.allSettled([
      env.svc.completeUpload(owner, ws, s.id, mutation()),
      env.svc.completeUpload(owner, ws, s.id, mutation()),
    ]);
    expect(both.every((r) => r.status === 'fulfilled')).toBe(true);
    const files = new Set(
      both.map(
        (r) => (r as PromiseFulfilledResult<{ data: { file: string | null } }>).value.data.file,
      ),
    );
    expect(files.size).toBe(1);
    expect((await env.svc.storageStatus(owner, ws)).used_bytes).toBe(before + bytes.length);
    const versions = await db.admin(
      `SELECT count(*)::int AS n FROM files.file_version v JOIN core.record r ON r.id = v.file_id WHERE r.public_id = $1`,
      [[...files][0]],
    );
    expect(versions.rows[0].n).toBe(1);
    // The same Idempotency-Key replays the same session (with a freshly signed URL).
    const req = mutation();
    const a = (
      await env.svc.initiateUpload(
        owner,
        ws,
        {
          host: open,
          name: 'k.txt',
          content_type: 'text/plain',
          byte_size: 1,
          sha256: sha(Buffer.from('k')),
        },
        req,
      )
    ).data;
    const b = (
      await env.svc.initiateUpload(
        owner,
        ws,
        {
          host: open,
          name: 'k.txt',
          content_type: 'text/plain',
          byte_size: 1,
          sha256: sha(Buffer.from('k')),
        },
        req,
      )
    ).data;
    expect(b.id).toBe(a.id);
    const audits = await db.admin(
      `SELECT count(*)::int AS n FROM audit.audit_event WHERE action = 'file.upload_started' AND changes::text LIKE $1`,
      [`%${a.id}%`],
    );
    expect(audits.rows[0].n).toBe(1);
  });

  it('reserves quota atomically: concurrent uploads past the quota let one through', async () => {
    const tight = workEnv(db, {
      work: { workspaceStorageQuotaBytes: 1_048_576 + 10_000, fileUploadMaxBytes: 1_048_576 },
      files: env.files,
    });
    const used = await tight.svc.storageStatus(owner, ws);
    const room = 1_048_576 + 10_000 - used.used_bytes - used.reserved_bytes;
    const size = Math.floor(room * 0.6);
    const body = Buffer.alloc(size, 7);
    const r = await Promise.allSettled([
      start(owner, open, 'x.txt', body, tight),
      start(owner, open, 'y.txt', body, tight),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(r.find((x) => x.status === 'rejected')).toMatchObject({
      reason: reason('usage_limit_reached'),
    });
    await tight.h.close();
  });

  it('turns an unavailable store into a retryable refusal and recovers', async () => {
    let down = true;
    const inner = env.files.storage!;
    const flaky: ObjectStorage = {
      provider: inner.provider,
      presignPut: (k, o) => inner.presignPut(k, o),
      presignGet: (k, o) =>
        down ? Promise.reject(new StorageUnavailableError('down')) : inner.presignGet(k, o),
      head: (k) => (down ? Promise.reject(new StorageUnavailableError('down')) : inner.head(k)),
      read: (k, o) => inner.read(k, o),
      copy: (a, b) => inner.copy(a, b),
      delete: (k) => inner.delete(k),
      check: () => Promise.resolve(down ? 'unavailable' : 'ok'),
    };
    const shaky = workEnv(db, { files: { storage: flaky, scanner: env.files.scanner } });
    const bytes = Buffer.from('flaky');
    const s = (await start(owner, open, 'f.txt', bytes, shaky)).data;
    await storage.writeObject(await keyOf(s.id), bytes, { contentType: 'text/plain' });
    await expect(shaky.svc.completeUpload(owner, ws, s.id, mutation())).rejects.toEqual(
      reason('dependency_unavailable'),
    );
    expect((await shaky.svc.storageStatus(owner, ws)).object_storage).toBe('unavailable');
    expect((await env.svc.getUpload(owner, ws, s.id)).state).toBe('initiated');
    down = false;
    const done = (await shaky.svc.completeUpload(owner, ws, s.id, mutation())).data;
    expect(done.state).toBe('completed');
    await scan();
    down = true;
    await expect(shaky.svc.fileUrl(owner, ws, done.file, {})).rejects.toEqual(
      reason('dependency_unavailable'),
    );
    await shaky.h.close();
  });

  it('purges files with their task and deletes the orphaned bytes once through the sweep', async () => {
    const t = (
      await env.svc.createTask(owner, ws, { brand: brands.Main, title: 'Doomed' }, mutation())
    ).data.id;
    const f = await upload(owner, t, 'doomed.txt', Buffer.from('bye'));
    const key = (
      await db.admin(
        `SELECT o.storage_key AS k FROM files.file_object o JOIN files.file_version v ON v.file_object_id = o.id
          JOIN core.record r ON r.id = v.file_id WHERE r.public_id = $1`,
        [f],
      )
    ).rows[0].k as string;
    expect(await storage.readObject(key)).not.toBeNull();
    const before = (await env.svc.storageStatus(owner, ws)).used_bytes;
    await env.svc.taskLifecycle(owner, ws, t, 'trash', {}, mutation());
    await expect(env.svc.getFile(owner, ws, f)).rejects.toEqual(reason('not_found'));
    await env.svc.taskLifecycle(owner, ws, t, 'restore', {}, mutation());
    expect((await env.svc.getFile(owner, ws, f)).name).toBe('doomed.txt');
    await env.svc.taskLifecycle(owner, ws, t, 'trash', {}, mutation());
    const ids = (
      await db.admin(`SELECT id FROM core.record WHERE public_id = ANY($1)`, [[t, f]])
    ).rows.map((r) => r.id);
    const registry = productLifecycleRegistry();
    const keys = await env.h.worker.withWorkspace(wsId, { module: 'test' }, async (tx) => {
      await registry.get('task')!.purge!.deleteContent(tx, [ids[0]]);
      await registry.get('file')!.purge!.deleteContent(tx, ids);
      const k = await registry.get('file')!.purge!.objectKeys!(tx, ids);
      const op = await createOperation(tx, {
        kind: 'purge',
        context: systemExec(wsId, null),
        initiatedBy: { type: 'system', id: wsId },
      });
      for (const x of k)
        await recordEffect(tx, {
          operationId: op.id,
          effectKey: `object:${x}`,
          destination: OBJECT_DELETE_DESTINATION,
        });
      return k;
    });
    expect(keys).toContain(key);
    expect((await env.svc.storageStatus(owner, ws)).used_bytes).toBe(before - 3);
    await fileSweepHandler(jobs).handle({} as never);
    await fileSweepHandler(jobs).handle({} as never);
    expect(await storage.readObject(key)).toBeNull();
    const eff = await db.admin(`SELECT state FROM exec.external_effect WHERE effect_key = $1`, [
      `object:${key}`,
    ]);
    expect(eff.rows.map((r) => r.state)).toEqual(['confirmed']);
    const rows = await db.admin(
      `SELECT count(*)::int AS n FROM files.file_object WHERE storage_key = $1`,
      [key],
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it('stops reaching a file the moment access is revoked', async () => {
    const f = await upload(owner, open, 'revoke.txt');
    expect((await env.svc.fileUrl(viewer, ws, f, {})).kind).toBe('object');
    await apply(env, owner, ws, {
      kind: 'brand_revoke',
      brand: brands.Main,
      principal: await mem(viewer),
    });
    await expect(env.svc.fileUrl(viewer, ws, f, {})).rejects.toEqual(reason('not_found'));
    await expect(env.svc.listFiles(viewer, ws, open)).rejects.toEqual(reason('not_found'));
  });
});
