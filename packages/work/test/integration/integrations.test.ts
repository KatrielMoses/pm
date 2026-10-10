import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVault } from '@pm/identity';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import { openCredential } from '@pm/work';
import {
  join,
  membershipOf,
  mutation,
  workEnv,
  workspaceIdOf,
  workspaceWith,
  type WorkEnv,
} from './fixture.ts';

const rejects = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; issues?: Array<{ code: string }> };
  }
  throw new Error('expected a rejection');
};

const TOKEN = 'loopback-token';
const connectBody = (extra: Record<string, unknown> = {}) => ({
  provider: 'loopback',
  auth_kind: 'api_key',
  display_name: 'Loopback',
  scopes: ['read', 'write'],
  api_key: TOKEN,
  ...extra,
});

describe('Integration connections (6A)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let member: Caller;
  let guest: Caller;
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db, { work: { syncMaxAttempts: 1 } });
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
    wsId = await workspaceIdOf(db, ws);
    member = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    const project = (
      await env.svc.createProject(owner, ws, { brand: brands.Harbor, name: 'Open' }, mutation())
    ).data.id;
    const task = (
      await env.svc.createTask(owner, ws, { project, title: 'Shared once' }, mutation())
    ).data.id;
    guest = await join(env, db, owner, ws, {
      kind: 'guest',
      records: [{ record: task, level: 'comment' }],
    });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  const secretRef = async (publicId: string) => {
    const r = await db.admin(
      `SELECT c.credential_secret_ref AS ref, c.credential_key_version AS v, c.health
         FROM integrations.connection c JOIN core.record r ON r.id = c.id WHERE r.public_id = $1`,
      [publicId],
    );
    return r.rows[0] as { ref: string | null; v: number; health: string };
  };

  it('refuses a guest and a member without authority, and hides another brand', async () => {
    const made = await env.svc.createConnection(
      owner,
      ws,
      { ...connectBody(), brand: brands.Harbor, display_name: 'Harbor link' },
      mutation(),
    );
    expect(await rejects(env.svc.listConnections(guest, ws))).toMatchObject({ code: 'forbidden' });
    expect(await rejects(env.svc.getConnection(member, ws, made.data.id))).toMatchObject({
      code: 'not_found',
    });
    const listed = await env.svc.listConnections(member, ws);
    expect(JSON.stringify(listed)).not.toContain('Harbor link');
    const unknown = await rejects(
      env.svc.getConnection(owner, ws, 'conn_00000000000000000000000000'),
    );
    expect(unknown.code).toBe('not_found');
    expect((await rejects(env.svc.getConnection(member, ws, made.data.id))).code).toBe(
      unknown.code,
    );
  });

  it('answers unknown and hidden connections the same way', async () => {
    const made = await env.svc.createConnection(
      owner,
      ws,
      { ...connectBody(), brand: brands.Summit, display_name: 'Summit link' },
      mutation(),
    );
    const hidden = await rejects(env.svc.getConnection(member, ws, made.data.id));
    const unknown = await rejects(
      env.svc.getConnection(member, ws, 'conn_00000000000000000000000000'),
    );
    expect(hidden.code).toBe('not_found');
    expect(unknown.code).toBe(hidden.code);
  });

  it('stores credentials only as a vault reference and never returns them', async () => {
    const made = await env.svc.createConnection(owner, ws, connectBody(), mutation());
    const body = JSON.stringify(made);
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain('credential_secret_ref');
    expect(made.data.credential_configured).toBe(true);
    const row = await secretRef(made.data.id);
    expect(row.ref).toMatch(/^dev:integration_credential:[0-9a-f]{32}$/);
    expect(row.ref).not.toContain(TOKEN);
    const vault = createVault(env.h.config.identity);
    const plain = await env.h.app.withWorkspace(wsId, { module: 'integrations' }, (tx) =>
      vault.get(row.ref!, { scope: tx }),
    );
    expect(openCredential(plain)?.token).toBe(TOKEN);
  });

  it('rotates a credential onto a new vault reference and destroys the old one', async () => {
    const made = await env.svc.createConnection(
      owner,
      ws,
      connectBody({ display_name: 'Rotate me' }),
      mutation(),
    );
    const before = await secretRef(made.data.id);
    const rotated = await env.svc.rotateCredentials(owner, ws, mutation());
    expect(rotated.data.rotated).toBeGreaterThan(0);
    const after = await secretRef(made.data.id);
    expect(after.ref).not.toBe(before.ref);
    expect(after.v).toBe(before.v + 1);
    const gone = await db.admin(
      `SELECT count(*)::int AS n FROM ops.dev_secret_vault WHERE ref = $1`,
      [before.ref],
    );
    expect(gone.rows[0].n).toBe(0);
    const vault = createVault(env.h.config.identity);
    const plain = await env.h.app.withWorkspace(wsId, { module: 'integrations' }, (tx) =>
      vault.get(after.ref!, { scope: tx }),
    );
    expect(openCredential(plain)?.token).toBe(TOKEN);
    expect(JSON.stringify(rotated)).not.toContain(TOKEN);
  });

  it('tests, reauthorizes, and disconnects with a retention choice', async () => {
    const made = await env.svc.createConnection(
      owner,
      ws,
      connectBody({ display_name: 'Detach me' }),
      mutation(),
    );
    await env.svc.syncNow(owner, ws, made.data.id, mutation());
    const tested = await env.svc.testConnection(owner, ws, made.data.id, mutation());
    expect(tested.data.health).toBe('connected');
    expect(tested.data.last_success_at).toBeTruthy();
    const again = await env.svc.reauthorize(
      owner,
      ws,
      made.data.id,
      connectBody({ display_name: 'Detach me', api_key: 'loopback-next' }),
      mutation(),
    );
    expect(JSON.stringify(again)).not.toContain('loopback-next');
    expect(again.data.credential_configured).toBe(true);
    const kept = await env.svc.disconnect(
      owner,
      ws,
      made.data.id,
      { retention: 'retain' },
      mutation(),
    );
    expect(kept.data.health).toBe('disconnected');
    expect(kept.data.retention_choice).toBe('retain');
    expect(kept.data.credential_configured).toBe(false);
    const identities = await db.admin(
      `SELECT count(*)::int AS n FROM integrations.external_identity e
         JOIN core.record r ON r.id = e.connection_id WHERE r.public_id = $1`,
      [made.data.id],
    );
    expect(identities.rows[0].n).toBeGreaterThan(0);
    const removed = await env.svc.createConnection(
      owner,
      ws,
      connectBody({ display_name: 'Drop me' }),
      mutation(),
    );
    await env.svc.syncNow(owner, ws, removed.data.id, mutation());
    await env.svc.disconnect(owner, ws, removed.data.id, { retention: 'remove' }, mutation());
    const left = await db.admin(
      `SELECT count(*)::int AS n FROM integrations.external_identity e
         JOIN core.record r ON r.id = e.connection_id WHERE r.public_id = $1`,
      [removed.data.id],
    );
    expect(left.rows[0].n).toBe(0);
    const history = await db.admin(
      `SELECT count(*)::int AS n FROM integrations.sync_run s
         JOIN core.record r ON r.id = s.connection_id WHERE r.public_id = $1`,
      [removed.data.id],
    );
    expect(history.rows[0].n).toBeGreaterThan(0);
  });

  it('advances a checkpoint once under a repeated sync and dead-letters a failing provider', async () => {
    const made = await env.svc.createConnection(
      owner,
      ws,
      connectBody({ display_name: 'Once' }),
      mutation(),
    );
    const key = mutation();
    const first = await env.svc.syncNow(owner, ws, made.data.id, key);
    const again = await env.svc.syncNow(owner, ws, made.data.id, key);
    expect(again.replayed).toBe(true);
    const versions = await db.admin(
      `SELECT k.version FROM integrations.sync_checkpoint k
         JOIN core.record r ON r.id = k.connection_id WHERE r.public_id = $1`,
      [made.data.id],
    );
    expect(versions.rows).toHaveLength(1);
    expect(first.data.read_count).toBeGreaterThan(0);
    const bad = await env.svc.createConnection(
      owner,
      ws,
      connectBody({ display_name: 'Broken', mode: 'error' }),
      mutation(),
    );
    const run = await env.svc.syncNow(owner, ws, bad.data.id, mutation());
    expect(run.data.state).toBe('dead');
    const delivery = await db.admin(
      `SELECT d.state FROM integrations.sync_delivery d
         JOIN core.record r ON r.id = d.connection_id WHERE r.public_id = $1`,
      [bad.data.id],
    );
    expect(delivery.rows[0].state).toBe('dead');
  });

  it('opens a conflict when both sides changed and resolves it once', async () => {
    const made = await env.svc.createConnection(
      owner,
      ws,
      connectBody({ display_name: 'Conflict' }),
      mutation(),
    );
    await env.svc.syncNow(owner, ws, made.data.id, mutation());
    const ident = await db.admin(
      `SELECT e.public_id FROM integrations.external_identity e
         JOIN core.record r ON r.id = e.connection_id WHERE r.public_id = $1`,
      [made.data.id],
    );
    await env.svc.editLocal(
      owner,
      ws,
      made.data.id,
      ident.rows[0].public_id,
      { version: 'local-2' },
      mutation(),
    );
    await env.svc.reauthorize(
      owner,
      ws,
      made.data.id,
      connectBody({ display_name: 'Conflict', remote_version: '2' }),
      mutation(),
    );
    const run = await env.svc.syncNow(owner, ws, made.data.id, mutation());
    expect(run.data.conflict_count).toBe(1);
    const open = await env.svc.listConflicts(owner, ws, made.data.id);
    expect(open.conflicts).toHaveLength(1);
    const resolved = await env.svc.resolveConflict(
      owner,
      ws,
      made.data.id,
      open.conflicts[0]!.id,
      { resolution: 'kept_local' },
      mutation(),
    );
    expect(resolved.data.state).toBe('kept_local');
    expect((await env.svc.listConflicts(owner, ws, made.data.id)).conflicts).toHaveLength(0);
  });

  it('reports an unconfigured provider and a degraded provider honestly', async () => {
    const missing = await rejects(
      env.svc.createConnection(
        owner,
        ws,
        { ...connectBody(), provider: 'google_calendar', scopes: ['calendar.read'] },
        mutation(),
      ),
    );
    expect(missing.issues?.[0]?.code).toBe('provider_unconfigured');
    const catalog = await env.svc.listProviders(owner, ws);
    expect(catalog.providers.find((p) => p.id === 'google_calendar')).toMatchObject({
      configured: false,
    });
    expect(catalog.providers.find((p) => p.id === 'email_inbound')?.unavailable).toMatch(/OD-29/);
    const slow = await env.svc.createConnection(
      owner,
      ws,
      connectBody({ display_name: 'Degraded', mode: 'degraded' }),
      mutation(),
    );
    const run = await env.svc.syncNow(owner, ws, slow.data.id, mutation());
    expect(run.data.error_code).toBe('provider_degraded');
    expect(run.data.write_count).toBe(0);
    expect((await env.svc.getConnection(owner, ws, slow.data.id)).health).toBe('degraded');
  });

  it('suspends and revokes the secret when the owner leaves', async () => {
    const leaver = await join(env, db, owner, ws, { kind: 'member', role: 'administrator' });
    const leaverId = (await membershipOf(db, wsId, leaver.auth.account.id))!.public_id;
    const ownerId = (await membershipOf(db, wsId, owner.auth.account.id))!.public_id;
    const made = await env.svc.createConnection(
      leaver,
      ws,
      connectBody({ display_name: 'Leaver' }),
      mutation(),
    );
    const before = await secretRef(made.data.id);
    expect(before.ref).toBeTruthy();
    const preview = await env.svc.previewChange(owner, ws, { kind: 'remove', member: leaverId });
    env.stepUp.allow = true;
    try {
      await env.svc.removeMember(
        owner,
        ws,
        leaverId,
        { preview_token: preview.preview_token, reassign_to: ownerId },
        mutation({ stepUpToken: 't' }),
      );
    } finally {
      env.stepUp.allow = false;
    }
    const after = await secretRef(made.data.id);
    expect(after.ref).toBeNull();
    expect(after.health).toBe('needs_reauthorization');
    const view = await env.svc.getConnection(owner, ws, made.data.id);
    expect(view.suspended_reason).toBe('owner_departed');
    expect(view.credential_configured).toBe(false);
    const gone = await db.admin(
      `SELECT count(*)::int AS n FROM ops.dev_secret_vault WHERE ref = $1`,
      [before.ref],
    );
    expect(gone.rows[0].n).toBe(0);
  });
});
