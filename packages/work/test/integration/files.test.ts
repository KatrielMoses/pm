import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import {
  EICAR_TEST_STRING,
  fileScanHandler,
  fileSweepHandler,
  LocalObjectStorage,
  type FileJobDeps,
} from '@pm/work';
import {
  apply,
  join,
  membershipOf,
  mutation,
  workEnv,
  workspaceIdOf,
  workspaceWith,
  type WorkEnv,
} from './fixture.ts';

const reason = (code: string) => expect.objectContaining({ code });
const issueOf = (code: string) =>
  expect.objectContaining({ issues: expect.arrayContaining([expect.objectContaining({ code })]) });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * Phase 4E files and deliverables on real PostgreSQL (ADR-0026): upload sessions with quota
 * reservation, verification, quarantine, and the scan job (clean promotes, infected blocks, failures
 * fail closed); downloads only of clean bytes through short-lived signed URLs; versions, external
 * links, bounded comparison; deliverables reviewed through 4A with acceptance evidence and the
 * evidence lock; storage not configured; hidden files indistinguishable from unknown ones.
 */
describe('Files and deliverables (4E)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let reviewer: Caller;
  let outsider: Caller;
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  let task: string;
  let storage: LocalObjectStorage;
  let jobs: FileJobDeps;

  /** Starts an upload, writes the bytes (as the browser's signed PUT would), and completes it. */
  const upload = async (
    host: Record<string, unknown>,
    name: string,
    contentType: string,
    bytes: Buffer,
    as: Caller = owner,
  ) => {
    const s = (
      await env.svc.initiateUpload(
        as,
        ws,
        { ...host, name, content_type: contentType, byte_size: bytes.length, sha256: sha(bytes) },
        mutation(),
      )
    ).data;
    expect(s.upload).toMatchObject({ method: 'PUT' });
    const key = (
      await db.admin(
        `SELECT quarantine_object_key AS k FROM files.upload_session WHERE public_id = $1`,
        [s.id],
      )
    ).rows[0].k as string;
    await storage.writeObject(key, bytes, { contentType });
    return (await env.svc.completeUpload(as, ws, s.id, mutation())).data;
  };
  const scanAll = async (attempt = 1) => {
    const pending = await db.admin(
      `SELECT id FROM files.file_object WHERE workspace_id = $1 AND scan_state = 'pending'`,
      [wsId],
    );
    for (const r of pending.rows)
      await fileScanHandler(jobs).handle({
        job: { workspaceId: wsId, payloadRef: r.id, attemptNumber: attempt },
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
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Secret']));
    wsId = await workspaceIdOf(db, ws);
    reviewer = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    outsider = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: (await membershipOf(db, wsId, reviewer.auth.account.id))!.public_id,
      level: 'edit',
    });
    task = (
      await env.svc.createTask(owner, ws, { brand: brands.Harbor, title: 'Ship brief' }, mutation())
    ).data.id;
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('uploads into quarantine, scans clean, then signs a short-lived download', async () => {
    const bytes = Buffer.from('hello world\n');
    const done = await upload({ host: task }, 'notes.txt', 'text/plain', bytes);
    expect(done).toMatchObject({ state: 'completed', upload: null });
    const file = await env.svc.getFile(owner, ws, done.file);
    expect(file.current).toMatchObject({
      state: 'scanning',
      byte_size: bytes.length,
      sha256: sha(bytes),
    });
    // Fail closed: nothing is downloadable before the scan says clean.
    await expect(env.svc.fileUrl(owner, ws, done.file, {})).rejects.toEqual(
      reason('file_not_ready'),
    );
    await scanAll();
    const after = await env.svc.getFile(owner, ws, done.file);
    expect(after.current).toMatchObject({ state: 'ready', preview: 'text' });
    const dl = await env.svc.fileUrl(owner, ws, done.file, {});
    expect(dl).toMatchObject({ kind: 'object', disposition: 'attachment' });
    expect(new Date(dl.expires_at!).getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    const inline = await env.svc.fileUrl(owner, ws, done.file, { disposition: 'inline' });
    expect(inline.disposition).toBe('inline');
    const usage = await env.svc.storageStatus(owner, ws);
    expect(usage).toMatchObject({
      object_storage: 'ok',
      malware_scanner: 'ok',
      used_bytes: bytes.length,
      reserved_bytes: 0,
    });
  });

  it('refuses type mismatches, checksum mismatches, and HTML/SVG inline previews', async () => {
    await expect(
      env.svc.initiateUpload(
        owner,
        ws,
        {
          host: task,
          name: 'run.exe',
          content_type: 'application/x-msdownload',
          byte_size: 3,
          sha256: sha(Buffer.from('abc')),
        },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('unsupported_type'));
    await expect(
      env.svc.initiateUpload(
        owner,
        ws,
        {
          host: task,
          name: 'photo.png',
          content_type: 'application/pdf',
          byte_size: 3,
          sha256: sha(Buffer.from('abc')),
        },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('type_mismatch'));
    const s = (
      await env.svc.initiateUpload(
        owner,
        ws,
        {
          host: task,
          name: 'a.txt',
          content_type: 'text/plain',
          byte_size: 3,
          sha256: sha(Buffer.from('abc')),
        },
        mutation(),
      )
    ).data;
    const key = (
      await db.admin(
        `SELECT quarantine_object_key AS k FROM files.upload_session WHERE public_id = $1`,
        [s.id],
      )
    ).rows[0].k;
    await storage.writeObject(key, Buffer.from('xyz'), { contentType: 'text/plain' });
    await expect(env.svc.completeUpload(owner, ws, s.id, mutation())).rejects.toEqual(
      reason('checksum_mismatch'),
    );
    const svg = await upload({ host: task }, 'logo.svg', 'image/svg+xml', Buffer.from('<svg/>'));
    await scanAll();
    const pre = await env.svc.fileUrl(owner, ws, svg.file, { disposition: 'inline' });
    expect(pre.disposition).toBe('attachment');
  });

  it('blocks infected uploads, releases their bytes, and fails closed after the last scan attempt', async () => {
    const before = (await env.svc.storageStatus(owner, ws)).used_bytes;
    const bad = await upload(
      { host: task },
      'bad.txt',
      'text/plain',
      Buffer.from(EICAR_TEST_STRING, 'latin1'),
    );
    await scanAll();
    const f = await env.svc.getFile(owner, ws, bad.file);
    expect(f.current).toMatchObject({ state: 'blocked', blocked_reason: 'malware' });
    expect(JSON.stringify(f)).not.toMatch(/Eicar/i);
    await expect(env.svc.fileUrl(owner, ws, bad.file, {})).rejects.toEqual(reason('file_blocked'));
    expect((await env.svc.storageStatus(owner, ws)).used_bytes).toBe(before);
    // A scanner that keeps failing: retries, then the last attempt marks scan_failed.
    const broken = {
      ...jobs,
      scanner: {
        provider: 'clamav' as const,
        scan: () => Promise.resolve({ verdict: 'error' as const, reason: 'down' }),
        check: () => Promise.resolve('unavailable' as const),
      },
    };
    const odd = await upload({ host: task }, 'odd.txt', 'text/plain', Buffer.from('fine'));
    const obj = (await db.admin(`SELECT id FROM files.file_object WHERE scan_state = 'pending'`))
      .rows[0].id;
    const run = (n: number) =>
      fileScanHandler(broken).handle({
        job: { workspaceId: wsId, payloadRef: obj, attemptNumber: n },
        logger: env.h.logger,
      } as never);
    await expect(run(1)).rejects.toThrow();
    expect((await env.svc.getFile(owner, ws, odd.file)).current!.state).toBe('scanning');
    await run(5);
    const failed = await env.svc.getFile(owner, ws, odd.file);
    expect(failed.current).toMatchObject({ state: 'blocked', blocked_reason: 'scan_failed' });
  });

  it('keeps immutable versions, links external files without copying, and compares text', async () => {
    const v1 = await upload({ host: task }, 'plan.md', 'text/markdown', Buffer.from('a\nb\nc\n'));
    await scanAll();
    const s2 = (
      await env.svc.initiateUpload(
        owner,
        ws,
        {
          file: v1.file,
          name: 'plan.md',
          content_type: 'text/markdown',
          byte_size: 6,
          sha256: sha(Buffer.from('a\nB\nc\n')),
        },
        mutation(),
      )
    ).data;
    const key = (
      await db.admin(
        `SELECT quarantine_object_key AS k FROM files.upload_session WHERE public_id = $1`,
        [s2.id],
      )
    ).rows[0].k;
    await storage.writeObject(key, Buffer.from('a\nB\nc\n'), { contentType: 'text/markdown' });
    await env.svc.completeUpload(owner, ws, s2.id, mutation());
    await scanAll();
    const file = await env.svc.getFile(owner, ws, v1.file);
    expect(file.versions.map((v) => v.number)).toEqual([2, 1]);
    const diff = await env.svc.compareVersions(owner, ws, v1.file, { from: 1, to: 2 });
    expect(diff.mode).toBe('lines');
    expect(diff.lines).toEqual([
      { op: 'same', text: 'a' },
      { op: 'remove', text: 'b' },
      { op: 'add', text: 'B' },
      { op: 'same', text: 'c' },
      { op: 'same', text: '' },
    ]);
    await expect(
      db.admin(
        `UPDATE files.file_version SET name = 'x' WHERE file_id = (SELECT id FROM core.record WHERE public_id = $1)`,
        [v1.file],
      ),
    ).rejects.toThrow(/immutable/);
    const link = (
      await env.svc.addFileLink(
        owner,
        ws,
        { host: task, url: 'https://example.com/specs/final.pdf' },
        mutation(),
      )
    ).data;
    expect(link).toMatchObject({
      source: 'external',
      name: 'final.pdf',
      current: { kind: 'link', state: 'link' },
    });
    await expect(
      env.svc.addFileLink(owner, ws, { host: task, url: 'javascript:alert(1)' }, mutation()),
    ).rejects.toEqual(issueOf('invalid'));
    expect(await env.svc.fileUrl(owner, ws, link.id, {})).toMatchObject({
      kind: 'link',
      url: 'https://example.com/specs/final.pdf',
    });
  });

  it('enforces the workspace quota with reservations', async () => {
    const tight = workEnv(db, {
      work: { workspaceStorageQuotaBytes: 1_048_576, fileUploadMaxBytes: 1_048_576 },
    });
    const big = Buffer.alloc(700_000, 1);
    await tight.svc
      .initiateUpload(
        owner,
        ws,
        {
          host: task,
          name: 'a.txt',
          content_type: 'text/plain',
          byte_size: big.length,
          sha256: sha(big),
        },
        mutation(),
      )
      .catch(() => undefined);
    await expect(
      tight.svc.initiateUpload(
        owner,
        ws,
        {
          host: task,
          name: 'b.txt',
          content_type: 'text/plain',
          byte_size: big.length,
          sha256: sha(big),
        },
        mutation(),
      ),
    ).rejects.toEqual(reason('usage_limit_reached'));
    await tight.h.close();
  });

  it('expires unfinished uploads and releases their reservation', async () => {
    const s = (
      await env.svc.initiateUpload(
        owner,
        ws,
        {
          host: task,
          name: 'late.txt',
          content_type: 'text/plain',
          byte_size: 4,
          sha256: sha(Buffer.from('late')),
        },
        mutation(),
      )
    ).data;
    const reserved = (await env.svc.storageStatus(owner, ws)).reserved_bytes;
    await db.admin(
      `UPDATE files.upload_session SET expires_at = now() - interval '1 minute' WHERE public_id = $1`,
      [s.id],
    );
    await fileSweepHandler(jobs).handle({} as never);
    expect((await env.svc.storageStatus(owner, ws)).reserved_bytes).toBe(reserved - 4);
    await expect(env.svc.completeUpload(owner, ws, s.id, mutation())).rejects.toEqual(
      issueOf('upload_expired'),
    );
  });

  it('reviews deliverables through 4A and evidence-locks the accepted version', async () => {
    const out = await upload(
      { host: task },
      'brief.pdf',
      'application/pdf',
      Buffer.from('%PDF-1.4 brief'),
    );
    await scanAll();
    const d = (
      await env.svc.createDeliverable(
        owner,
        ws,
        task,
        { title: 'Campaign brief', expected_type: 'file' },
        mutation(),
      )
    ).data;
    expect(d.state).toBe('draft');
    const reviewerId = (await membershipOf(db, wsId, reviewer.auth.account.id))!.public_id;
    const sub = (
      await env.svc.submitDeliverable(
        owner,
        ws,
        d.id,
        { file: out.file, reviewers: [reviewerId] },
        mutation(),
      )
    ).data;
    expect(sub).toMatchObject({
      state: 'ready_for_review',
      versions: [expect.objectContaining({ number: 1, state: 'ready_for_review' })],
    });
    const queue = await env.svc.myReviews(reviewer, ws, { role: 'reviewer' });
    expect(queue.data[0]).toMatchObject({
      subject: { id: d.id, type: 'deliverable', title: 'Campaign brief' },
    });
    const rvw = sub.versions[0]!.review!;
    await env.svc.decideReview(
      reviewer,
      ws,
      rvw,
      { outcome: 'approved', subject_version: sub.version },
      mutation(),
    );
    const accepted = await env.svc.getDeliverable(owner, ws, d.id);
    expect(accepted.state).toBe('accepted');
    expect(accepted.versions[0]).toMatchObject({
      state: 'accepted',
      evidence_locked: true,
      accepted_by: { id: reviewerId },
      accepted_at: expect.any(String),
    });
    // Accepted is final: no more versions, the evidence cannot change, and its file stays.
    await expect(
      env.svc.submitDeliverable(
        owner,
        ws,
        d.id,
        { url: 'https://example.com/v2', reviewers: [reviewerId] },
        mutation(),
      ),
    ).rejects.toEqual(reason('evidence_locked'));
    await expect(
      db.admin(`UPDATE files.deliverable_version SET note_text = 'x' WHERE evidence_locked`),
    ).rejects.toThrow(/evidence-locked/);
    const f = await env.svc.getFile(owner, ws, out.file);
    await expect(env.svc.trashFile(owner, ws, out.file, mutation())).rejects.toEqual(
      reason('evidence_locked'),
    );
    expect(f.current!.evidence_locked).toBe(true);
    const list = await env.svc.listDeliverables(owner, ws, task);
    expect(list.counts.accepted).toBe(1);
  });

  it('asks for changes, then accepts a resubmitted link; stale decisions are refused', async () => {
    const reviewerId = (await membershipOf(db, wsId, reviewer.auth.account.id))!.public_id;
    const d = (
      await env.svc.createDeliverable(owner, ws, task, { title: 'Landing page' }, mutation())
    ).data;
    const s1 = (
      await env.svc.submitDeliverable(
        owner,
        ws,
        d.id,
        { url: 'https://example.com/v1', reviewers: [reviewerId] },
        mutation(),
      )
    ).data;
    await env.svc.decideReview(
      reviewer,
      ws,
      s1.versions[0]!.review!,
      { outcome: 'changes_requested', subject_version: s1.version },
      mutation(),
    );
    expect((await env.svc.getDeliverable(owner, ws, d.id)).state).toBe('changes_requested');
    const s2 = (
      await env.svc.submitDeliverable(
        owner,
        ws,
        d.id,
        { url: 'https://example.com/v2', reviewers: [reviewerId] },
        mutation(),
      )
    ).data;
    await expect(
      env.svc.decideReview(
        reviewer,
        ws,
        s1.versions[0]!.review!,
        { outcome: 'approved', subject_version: s1.version },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('review_closed'));
    await env.svc.decideReview(
      reviewer,
      ws,
      s2.versions[0]!.review!,
      { outcome: 'approved', subject_version: s2.version },
      mutation(),
    );
    const done = await env.svc.getDeliverable(owner, ws, d.id);
    expect(done.versions.map((v) => [v.number, v.state])).toEqual([
      [2, 'accepted'],
      [1, 'changes_requested'],
    ]);
  });

  it('makes hidden files the same not_found as unknown ones, and revokes access immediately', async () => {
    const secretTask = (
      await env.svc.createTask(owner, ws, { brand: brands.Secret, title: 'Secret' }, mutation())
    ).data.id;
    const hidden = await upload({ host: secretTask }, 'secret.txt', 'text/plain', Buffer.from('s'));
    await scanAll();
    for (const id of [hidden.file, `file_${'0'.repeat(26)}`, 'nonsense']) {
      await expect(env.svc.getFile(outsider, ws, id)).rejects.toEqual(reason('not_found'));
      await expect(env.svc.fileUrl(outsider, ws, id, {})).rejects.toEqual(reason('not_found'));
    }
    await expect(env.svc.listFiles(outsider, ws, secretTask)).rejects.toEqual(reason('not_found'));
    const harborFile = (await env.svc.listFiles(reviewer, ws, task)).data[0]!.id;
    await env.svc.fileUrl(reviewer, ws, harborFile, {}).catch(() => undefined);
    await apply(env, owner, ws, {
      kind: 'brand_revoke',
      brand: brands.Harbor,
      principal: (await membershipOf(db, wsId, reviewer.auth.account.id))!.public_id,
    });
    await expect(env.svc.fileUrl(reviewer, ws, harborFile, {})).rejects.toEqual(
      reason('not_found'),
    );
    // The upload session belongs to its creator only.
    const s = (
      await env.svc.initiateUpload(
        owner,
        ws,
        {
          host: task,
          name: 'x.txt',
          content_type: 'text/plain',
          byte_size: 1,
          sha256: sha(Buffer.from('x')),
        },
        mutation(),
      )
    ).data;
    await expect(env.svc.completeUpload(outsider, ws, s.id, mutation())).rejects.toEqual(
      reason('not_found'),
    );
  });

  it('is honest when storage or scanning is not configured', async () => {
    const off = workEnv(db, { files: { storage: null, scanner: null } });
    expect(await off.svc.storageStatus(owner, ws)).toMatchObject({
      object_storage: 'not_configured',
      malware_scanner: 'not_configured',
      accepting_uploads: false,
    });
    await expect(
      off.svc.initiateUpload(
        owner,
        ws,
        {
          host: task,
          name: 'x.txt',
          content_type: 'text/plain',
          byte_size: 1,
          sha256: sha(Buffer.from('x')),
        },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('storage_not_configured'));
    // External links need no storage.
    await off.svc.addFileLink(owner, ws, { host: task, url: 'https://example.com/x' }, mutation());
    await off.h.close();
  });
});
