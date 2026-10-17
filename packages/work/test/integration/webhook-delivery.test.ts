import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { InternalEvent } from '@pm/platform';
import type { Caller } from '@pm/tenancy';
import { signPayload, signatureHeader } from '../../src/integrations/semantics.ts';
import type { WebhookTransport } from '../../src/integrations/public-api-service.ts';
import {
  apply,
  internalIdOf,
  join,
  membershipOf,
  mutation,
  outboxEvents,
  workEnv,
  workspaceIdOf,
  workspaceWith,
  type WorkEnv,
} from './fixture.ts';

const code = (c: string) => expect.objectContaining({ code: c });
const issueOf = (c: string) =>
  expect.objectContaining({
    issues: expect.arrayContaining([expect.objectContaining({ code: c })]),
  });
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The outbound webhook delivery boundary (corrective review 01, ADR-0037 W1–W6) on real records:
 * authorization and payload built at send as the accountable owner through the canonical record
 * predicate, exact brand scope, the tombstone contract, the public envelope and signature, replay
 * as a guarded state transition, and a deliberate pause with an honest in-flight boundary.
 */
describe('Webhook delivery boundary (corrective review 01)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let manager: Caller;
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  let managerId: string;
  let openProject: string;
  let closedProject: string;
  const sent: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  let status = 200;
  /** A fixed answer per endpoint path (overrides `status`), so states do not depend on order. */
  const statusBy = new Map<string, number>();
  let hold: { path: string; entered: () => void; release: Promise<number> } | null = null;
  let entered: Promise<void> = Promise.resolve();
  let release: (status: number) => void = () => undefined;

  const transport: WebhookTransport = async (req) => {
    sent.push({ url: req.url, body: req.body, headers: req.headers });
    if (hold && req.url.endsWith(`/hooks/${hold.path}`)) {
      const h = hold;
      hold = null;
      h.entered();
      return { kind: 'status', status: await h.release };
    }
    const answer = statusBy.get(req.url.slice(req.url.lastIndexOf('/') + 1)) ?? status;
    return answer >= 0 ? { kind: 'status', status: answer } : { kind: 'network' };
  };
  const to = (path: string) => sent.filter((x) => x.url.endsWith(`/hooks/${path}`));
  /** The next send to one endpoint blocks until released, like a slow endpoint. */
  const holdNext = (path: string) => {
    let e!: () => void;
    entered = new Promise<void>((r) => (e = r));
    let r!: (s: number) => void;
    const p = new Promise<number>((res) => (r = res));
    release = r;
    hold = { path, entered: e, release: p };
  };
  const lockWaiters = async () =>
    Number(
      (
        await db.admin(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'`,
        )
      ).rows[0].n,
    );

  const subscribe = async (as: Caller, path: string, events: string[], brand?: string) =>
    (
      await env.svc.createSubscription(
        as,
        ws,
        { destination_url: `https://127.0.0.1/hooks/${path}`, event_types: events, brand },
        mutation(),
      )
    ).data;
  const deliveries = async (subPublic: string) =>
    (
      await db.admin(
        `SELECT d.public_id, d.event_type, d.state, d.detail, d.attempt, d.cycle, d.total_attempts,
                d.event_public_id, d.replayed_by_membership_id
           FROM integrations.webhook_delivery d JOIN core.record r ON r.id = d.subscription_id
          WHERE r.public_id = $1 ORDER BY d.created_at, d.id`,
        [subPublic],
      )
    ).rows as Array<{
      public_id: string;
      event_type: string;
      state: string;
      detail: string | null;
      attempt: number;
      cycle: number;
      total_attempts: number;
      event_public_id: string;
      replayed_by_membership_id: string | null;
    }>;
  const subState = async (subPublic: string) =>
    (
      await db.admin(
        `SELECT s.state, s.suspended_reason, s.version FROM integrations.webhook_subscription s
           JOIN core.record r ON r.id = s.id WHERE r.public_id = $1`,
        [subPublic],
      )
    ).rows[0] as { state: string; suspended_reason: string | null; version: string };
  const sweep = (at = new Date()) => env.svc.sweepWorkspace(wsId, at);
  const project = (e: InternalEvent) => env.svc.projectForWorkspace(wsId, e);
  /** A real task and the event its creation wrote to the outbox. */
  const created = async (body: Record<string, unknown>) => {
    const t = (await env.svc.createTask(owner, ws, body, mutation())).data;
    const [e] = await outboxEvents(db, wsId, 'work.task.created', await internalIdOf(db, t.id));
    return { task: t, event: e! };
  };
  const ifMatch = async (subPublic: string) =>
    mutation({ ifMatch: `"${Number((await subState(subPublic)).version)}"` });

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db, {
      deliver: transport,
      work: { webhookMaxAttempts: 2, webhookDisableThreshold: 50 },
    });
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
    wsId = await workspaceIdOf(db, ws);
    manager = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    managerId = (await membershipOf(db, wsId, manager.auth.account.id))!.public_id;
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: managerId,
      level: 'manage',
    });
    openProject = (
      await env.svc.createProject(owner, ws, { brand: brands.Harbor, name: 'Open' }, mutation())
    ).data.id;
    closedProject = (
      await env.svc.createProject(owner, ws, { brand: brands.Harbor, name: 'Closed' }, mutation())
    ).data.id;
    await env.svc.setAccess(
      owner,
      ws,
      closedProject,
      { access_mode: 'restricted', allow_record_shares: false },
      mutation(),
    );
    await apply(env, owner, ws, {
      kind: 'project_grant',
      project: closedProject,
      principal: managerId,
      level: 'view',
    });
  }, 120_000);

  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('AT-345 re-authorizes at send through the canonical record: a restricted record revoked before send is skipped while brand access remains', async () => {
    const sub = await subscribe(manager, 'restricted', ['task.created'], brands.Harbor);
    const open = await created({ project: openProject, title: 'Open plan' });
    const closed = await created({ project: closedProject, title: 'Closed plan' });
    expect(await project(open.event)).toBe(1);
    expect(await project(closed.event)).toBe(1);
    // The manager loses the restricted project, and keeps managing Harbor.
    await apply(env, owner, ws, {
      kind: 'project_revoke',
      project: closedProject,
      principal: managerId,
    });
    sent.length = 0;
    status = 200;
    await sweep();
    const rows = await deliveries(sub.id);
    expect(rows.map((r) => [r.state, r.detail])).toEqual([
      ['delivered', null],
      ['skipped', 'not_readable'],
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain(open.task.id);
    expect(sent.map((s) => s.body).join()).not.toMatch(/Closed plan|Open plan/);
    expect(sent.map((s) => s.body).join()).not.toContain(closed.task.id);
    // The subscription is untouched: losing one record is not losing the brand.
    expect(await subState(sub.id)).toMatchObject({ state: 'active' });
    // Losing the brand's manage grant suspends the subscription at the next send.
    const later = await created({ project: openProject, title: 'After the grant' });
    await project(later.event);
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: managerId,
      level: 'view',
    });
    await sweep();
    expect((await deliveries(sub.id)).at(-1)).toMatchObject({
      state: 'skipped',
      detail: 'owner_authority',
    });
    expect(await subState(sub.id)).toMatchObject({
      state: 'suspended',
      suspended_reason: 'owner_authority',
    });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: managerId,
      level: 'manage',
    });
    await apply(env, owner, ws, {
      kind: 'project_grant',
      project: closedProject,
      principal: managerId,
      level: 'view',
    });
  });

  it('AT-346 matches brand subscriptions exactly and authorizes every workspace-subscription event at send', async () => {
    const harbor = await subscribe(
      owner,
      'harbor-only',
      ['task.created', 'record.archived'],
      brands.Harbor,
    );
    const everything = await subscribe(owner, 'workspace', ['task.created', 'record.archived']);
    const h = await created({ brand: brands.Harbor, title: 'Harbor item' });
    const sm = await created({ brand: brands.Summit, title: 'Summit item' });
    await project(h.event);
    await project(sm.event);
    // A workspace-level event (no brand): a workspace-scoped record archived.
    const conn = (
      await env.svc.createConnection(
        owner,
        ws,
        {
          provider: 'loopback',
          auth_kind: 'api_key',
          display_name: 'Workspace link',
          scopes: ['read'],
          api_key: 'loopback-scope-test',
        }, // gitleaks:allow (synthetic loopback credential)
        mutation(),
      )
    ).data;
    const connId = await internalIdOf(db, conn.id);
    const workspaceEvent: InternalEvent = {
      ...h.event,
      event_id: '0190f0c0-0000-7000-8000-00000000a346',
      type: 'core.record.archived',
      aggregate: { type: 'core.record', id: connId, sequence: 1 },
      data: { record_type: 'connection' },
    };
    delete workspaceEvent.brand_id;
    expect(await project(workspaceEvent)).toBe(1);
    sent.length = 0;
    await sweep();
    expect((await deliveries(harbor.id)).map((r) => r.event_type)).toEqual(['task.created']);
    const all = await deliveries(everything.id);
    expect(all.map((r) => [r.event_type, r.state])).toEqual([
      ['task.created', 'delivered'],
      ['task.created', 'delivered'],
      ['record.archived', 'delivered'],
    ]);
    const archived = JSON.parse(
      sent.find((s) => JSON.parse(s.body).type === 'record.archived')!.body,
    );
    expect(archived).toMatchObject({
      workspace: ws,
      data: { object: { id: conn.id, type: 'connection' } },
    });
    expect(archived.brand).toBeUndefined();
  });

  it('AT-347 follows record, brand, and subscription lifecycle, with an explicit tombstone contract', async () => {
    const sub = await subscribe(
      owner,
      'lifecycle',
      ['task.created', 'record.trashed'],
      brands.Harbor,
    );
    const gone = await created({ project: openProject, title: 'Trash me' });
    await project(gone.event);
    await env.svc.taskLifecycle(owner, ws, gone.task.id, 'trash', {}, mutation());
    const [trashed] = await outboxEvents(
      db,
      wsId,
      'core.record.trashed',
      await internalIdOf(db, gone.task.id),
    );
    await project(trashed!);
    sent.length = 0;
    await sweep();
    // The ordinary event about a now-trashed task is withheld; the trash tombstone is delivered.
    expect((await deliveries(sub.id)).map((r) => [r.event_type, r.state, r.detail])).toEqual([
      ['task.created', 'skipped', 'not_readable'],
      ['record.trashed', 'delivered', null],
    ]);
    expect(JSON.parse(sent[0]!.body)).toMatchObject({
      type: 'record.trashed',
      data: { object: { id: gone.task.id, type: 'task' }, fields: { record_type: 'task' } },
    });
    // A brand that leaves active use takes its subscriptions (ADR-0033 D11) and their queued
    // deliveries with it.
    const summit = await subscribe(owner, 'summit', ['task.created'], brands.Summit);
    const s = await created({ brand: brands.Summit, title: 'Summit queued' });
    await project(s.event);
    await env.svc.archiveBrand(owner, ws, brands.Summit, mutation({ ifMatch: '"0"' }));
    await sweep();
    expect((await deliveries(summit.id)).map((r) => [r.state, r.detail])).toEqual([
      ['skipped', 'subscription_inactive'],
    ]);
  });

  it('AT-348 sends the public envelope built at send, with a verifiable signature and no internal identifiers', async () => {
    const sub = await subscribe(owner, 'envelope', ['comment.created'], brands.Harbor);
    const host = await created({ project: openProject, title: 'Commented task' });
    const comment = (
      await env.svc.createComment(
        owner,
        ws,
        host.task.id,
        { text: 'A private thought' },
        mutation(),
      )
    ).data;
    const [event] = await outboxEvents(db, wsId, 'collab.comment.created');
    await project(event!);
    status = 500;
    sent.length = 0;
    await sweep();
    status = 200;
    await sweep(new Date(Date.now() + 120_000));
    expect(sent).toHaveLength(2);
    const [first, second] = sent;
    for (const s of sent) {
      expect(
        signatureHeader([
          signPayload(
            sub.secret!,
            s.headers['webhook-id']!,
            s.headers['webhook-timestamp']!,
            s.body,
          ),
        ]),
      ).toBe(s.headers['webhook-signature']);
      expect(s.body).not.toMatch(UUID);
      expect(s.body).not.toContain('A private thought');
    }
    const body = JSON.parse(second!.body);
    expect(Object.keys(body).sort()).toEqual([
      'api_version',
      'brand',
      'created_at',
      'data',
      'id',
      'type',
      'workspace',
    ]);
    expect(body).toEqual({
      id: first!.headers['webhook-id'],
      type: 'comment.created',
      api_version: 'v1',
      created_at: new Date(event!.occurred_at).toISOString(),
      workspace: ws,
      brand: brands.Harbor,
      data: { object: { id: comment.id, type: 'comment' }, fields: {}, changes: [] },
    });
    // The same event id and original time on every attempt; the signature timestamp is the send.
    expect(second!.headers['webhook-id']).toBe(first!.headers['webhook-id']);
    expect(JSON.parse(first!.body).created_at).toBe(body.created_at);
    // A synthetic test carries no tenant record or fields.
    await env.svc.testSubscription(owner, ws, sub.id, mutation());
    sent.length = 0;
    await sweep();
    expect(JSON.parse(sent[0]!.body)).toMatchObject({
      type: 'webhook.test',
      data: { object: { type: 'webhook_test' }, fields: {} },
    });
  });

  it('AT-349 replays only dead-lettered deliveries, once, serialized with the worker, and audited', async () => {
    // One endpoint per state, each answering the same way every time, settled by one sweep:
    // delivered, retry_scheduled (503), unknown (network), failed (404), and still pending.
    const paths = { delivered: 200, retrying: 503, unknown: -1, failed: 404, pending: 200 };
    const subs: Record<string, { id: string }> = {};
    for (const [path, answer] of Object.entries(paths)) {
      statusBy.set(`r-${path}`, answer);
      subs[path] = await subscribe(owner, `r-${path}`, ['task.created'], brands.Harbor);
    }
    const one = async (path: string) => (await deliveries(subs[path]!.id))[0]!;
    const c = await created({ project: openProject, title: 'Replay subject' });
    // Each subscription gets its own delivery of the same event, settled by exactly one sweep.
    // Nothing sweeps again before the refusals below: a retry with full jitter may already be
    // due, and a second sweep would move it on.
    await project(c.event);
    await sweep();
    await project((await created({ project: openProject, title: 'Replay pending' })).event);
    expect((await one('delivered')).state).toBe('delivered');
    expect((await one('retrying')).state).toBe('retry_scheduled');
    expect((await one('unknown')).state).toBe('unknown');
    expect((await one('failed')).state).toBe('failed');
    const pending = (await deliveries(subs.pending!.id)).find(
      (r) => r.event_type === 'task.created' && r.state === 'pending',
    )!;
    for (const r of [await one('delivered'), await one('retrying'), await one('unknown'), pending])
      await expect(env.svc.replayDelivery(owner, ws, r.public_id, mutation())).rejects.toEqual(
        issueOf('not_replayable'),
      );
    const failed = await one('failed');
    const sub = subs.failed!;
    expect(failed).toMatchObject({ cycle: 1, attempt: 1, total_attempts: 1 });
    // Two replays at once: one transition, one typed refusal.
    const both = await Promise.allSettled([
      env.svc.replayDelivery(owner, ws, failed.public_id, mutation()),
      env.svc.replayDelivery(owner, ws, failed.public_id, mutation()),
    ]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(both.find((r) => r.status === 'rejected')).toMatchObject({
      reason: issueOf('not_replayable'),
    });
    let row = (await deliveries(sub.id)).find((r) => r.public_id === failed.public_id)!;
    expect(row).toMatchObject({ state: 'pending', cycle: 2, attempt: 0, total_attempts: 1 });
    expect(row.replayed_by_membership_id).not.toBeNull();
    // The same mutation key replays the stored answer and never resets the delivery again.
    const key = mutation();
    await sweep();
    await env.svc.replayDelivery(owner, ws, failed.public_id, key);
    await env.svc.replayDelivery(owner, ws, failed.public_id, key);
    row = (await deliveries(sub.id)).find((r) => r.public_id === failed.public_id)!;
    expect(row).toMatchObject({ state: 'pending', cycle: 3, total_attempts: 2 });
    // A replay racing a send in progress waits for it, then re-checks what it finds.
    const race = await subscribe(owner, 'race', ['task.created'], brands.Harbor);
    const raced = await created({ project: openProject, title: 'Raced' });
    await project(raced.event);
    status = 404;
    await sweep();
    const [target] = await deliveries(race.id);
    expect(target).toMatchObject({ state: 'failed', cycle: 1 });
    await env.svc.replayDelivery(owner, ws, target!.public_id, mutation());
    holdNext('race');
    const sending = sweep();
    await entered;
    const replay = env.svc.replayDelivery(owner, ws, target!.public_id, mutation());
    await expect.poll(lockWaiters).toBeGreaterThan(0);
    release(400);
    await sending;
    expect((await replay).data).toMatchObject({ state: 'pending', cycle: 3 });
    expect((await deliveries(race.id))[0]).toMatchObject({ cycle: 3, total_attempts: 2 });
    // A synthetic test is never replayed, even when it failed.
    await env.svc.testSubscription(owner, ws, subs.failed!.id, mutation());
    await sweep();
    const test = (await deliveries(subs.failed!.id)).find(
      (r) => r.event_type === 'webhook.test' && r.state === 'failed',
    )!;
    await expect(env.svc.replayDelivery(owner, ws, test.public_id, mutation())).rejects.toEqual(
      issueOf('not_replayable'),
    );
    // A member who cannot read Harbor gets the opaque refusal; one who reads it without managing
    // webhooks there is forbidden.
    const reader = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    await expect(env.svc.replayDelivery(reader, ws, failed.public_id, mutation())).rejects.toEqual(
      code('not_found'),
    );
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: (await membershipOf(db, wsId, reader.auth.account.id))!.public_id,
      level: 'edit',
    });
    await expect(env.svc.replayDelivery(reader, ws, failed.public_id, mutation())).rejects.toEqual(
      code('forbidden'),
    );
    const audit = await db.admin(
      `SELECT count(*)::int AS n FROM audit.audit_event WHERE action = 'webhook_delivery.replayed'`,
    );
    expect(Number(audit.rows[0].n)).toBe(4);
    statusBy.clear();
    const changes = await db.admin(
      `SELECT changes::text AS c FROM audit.audit_event WHERE action = 'webhook_delivery.replayed'`,
    );
    for (const c of changes.rows) expect(c.c).not.toMatch(/Replay failed|secret|hk_|pm_/);
  });

  it('AT-350 pauses at once without recalling a send in flight, keeps history, and resumes only after a delivered test', async () => {
    const sub = await subscribe(manager, 'pause', ['task.created'], brands.Harbor);
    status = 503;
    await project((await created({ project: openProject, title: 'Pause retrying' })).event);
    await sweep();
    await project((await created({ project: openProject, title: 'Pause in flight' })).event);
    await project((await created({ project: openProject, title: 'Pause queued' })).event);
    // A send is in flight when the pause arrives: the pause waits for it, and nothing after it starts.
    status = 200;
    holdNext('pause');
    sent.length = 0;
    const sending = sweep(new Date(Date.now() + 120_000));
    await entered;
    const pausing = env.svc.pauseSubscription(manager, ws, sub.id, await ifMatch(sub.id));
    await expect.poll(lockWaiters).toBeGreaterThan(0);
    release(200);
    await sending;
    const paused = await pausing;
    expect(paused.data).toMatchObject({ state: 'paused' });
    expect(to('pause')).toHaveLength(1);
    const rows = await deliveries(sub.id);
    expect(rows.map((r) => r.state).sort()).toEqual(['delivered', 'skipped', 'skipped']);
    expect(rows.filter((r) => r.state === 'skipped').every((r) => r.detail === 'paused')).toBe(
      true,
    );
    // A delivery withheld by the pause was never attempted: it is not a dead letter to replay.
    const withheld = rows.find((r) => r.state === 'skipped')!;
    await expect(
      env.svc.replayDelivery(manager, ws, withheld.public_id, mutation()),
    ).rejects.toEqual(issueOf('not_replayable'));
    // While paused: nothing new is queued, and repeated pauses change nothing.
    const before = (await deliveries(sub.id)).length;
    await project((await created({ project: openProject, title: 'While paused' })).event);
    expect(await deliveries(sub.id)).toHaveLength(before);
    const again = await env.svc.pauseSubscription(manager, ws, sub.id, await ifMatch(sub.id));
    expect(again.data).toMatchObject({ state: 'paused', version: paused.data.version });
    await expect(
      env.svc.pauseSubscription(manager, ws, sub.id, mutation({ ifMatch: '"0"' })),
    ).rejects.toEqual(issueOf('version_conflict'));
    // Resume needs a test delivered after the pause: none, then a failing one, then a success.
    await expect(
      env.svc.resumeSubscription(manager, ws, sub.id, await ifMatch(sub.id)),
    ).rejects.toEqual(issueOf('test_required'));
    status = 400;
    await env.svc.testSubscription(manager, ws, sub.id, mutation());
    await sweep();
    await expect(
      env.svc.resumeSubscription(manager, ws, sub.id, await ifMatch(sub.id)),
    ).rejects.toEqual(issueOf('test_required'));
    status = 200;
    await env.svc.testSubscription(manager, ws, sub.id, mutation());
    await sweep();
    const resumed = await env.svc.resumeSubscription(manager, ws, sub.id, await ifMatch(sub.id));
    expect(resumed.data).toMatchObject({ state: 'active', paused_at: null });
    // The paused backlog stays recorded and is not replayed; new events flow again.
    sent.length = 0;
    await sweep();
    expect(to('pause')).toHaveLength(0);
    await project((await created({ project: openProject, title: 'After resume' })).event);
    await sweep();
    expect(to('pause').map((x) => JSON.parse(x.body).type)).toEqual(['task.created']);
    // Someone without the brand cannot pause or resume it; the API offers no backdoor.
    const stranger = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    await expect(
      env.svc.pauseSubscription(stranger, ws, sub.id, await ifMatch(sub.id)),
    ).rejects.toEqual(code('not_found'));
  });
});
