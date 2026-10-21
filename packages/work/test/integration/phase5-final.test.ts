import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import {
  DEFAULT_WORK_SETTINGS,
  goalRecalcHandler,
  indexWorkspace,
  reconcileWorkspace,
  type EmailProvider,
  type ExternalMessage,
  type SearchJobDeps,
  emailProviderFrom,
} from '@pm/work';
import type { Caller } from '@pm/tenancy';
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

const Q4 = { kind: 'quarter', year: 2026, index: 4 };
const widget = (id: string, metric: string, params: Record<string, unknown> = {}) => ({
  id,
  metric,
  params,
});
const reason = (code: string) => expect.objectContaining({ code });

class Outbox implements EmailProvider {
  readonly name = 'test';
  state: 'configured' | 'capture' | 'unconfigured' = 'configured';
  sent: ExternalMessage[] = [];
  async send(m: ExternalMessage) {
    this.sent.push(m);
    return { providerMessageId: `pm_${this.sent.length}` };
  }
}

/**
 * Phase 5 final integration (5A search, 5B goals and portfolios, 5C metrics, 5D dashboards and
 * reports): one workspace, every role, and the same hidden work reached through every surface.
 * Hidden and unknown must be indistinguishable everywhere at once, every change of access,
 * lifecycle, or membership must show on the next request everywhere, and derived work (indexing,
 * recalculation, reconciliation, delivery) must converge and repeat harmlessly.
 */
describe('Search, goals, metrics, dashboards, and reports as one permission-safe system (Phase 5 exit)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let editor: Caller;
  let reader: Caller;
  let outsider: Caller;
  let guest: Caller;
  let leaver: Caller;
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  const proj: Record<string, string> = {};
  const tsk: Record<string, string> = {};
  const outbox = new Outbox();
  const sql = async (text: string, params: unknown[] = []) =>
    (await db.admin(text, params)).rows as Array<Record<string, any>>;
  const mem = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
  const emailOf = async (c: Caller) =>
    (
      await sql(`SELECT primary_email AS e FROM identity.account WHERE id = $1`, [
        c.auth.account.id,
      ])
    )[0]!.e as string;
  const deps = (): SearchJobDeps => ({
    tenant: env.h.worker,
    discovery: undefined as never,
    metrics: env.h.telemetry.metrics,
    logger: env.h.logger,
  });
  const drain = () => indexWorkspace(deps(), wsId);
  const sweepGoals = () =>
    goalRecalcHandler({
      tenant: env.h.worker,
      discovery: env.h.discovery,
      metrics: env.h.telemetry.metrics,
      logger: env.h.logger,
      settings: DEFAULT_WORK_SETTINGS,
    }).handle({} as never);
  const reconcile = async () => {
    await sql(
      `UPDATE metrics.reconcile_state SET next_run_at = now() - interval '1 minute', lease_until = NULL WHERE workspace_id = $1`,
      [wsId],
    );
    return reconcileWorkspace(
      {
        tenant: env.h.worker,
        discovery: env.h.discovery,
        metrics: env.h.telemetry.metrics,
        logger: env.h.logger,
        settings: DEFAULT_WORK_SETTINGS,
      },
      wsId,
    );
  };
  const deliver = (now = new Date(), email: EmailProvider = outbox) =>
    env.svc.runReportSweep(env.h.worker, wsId, now, { email, origin: 'https://pm.test' });
  const metric = (as: Caller, id: string, q: Record<string, unknown> = {}) =>
    env.svc.getMetric(as, ws, id, q) as Promise<any>;
  const records = (as: Caller, id: string, member: string, q: Record<string, unknown> = {}) =>
    env.svc.getMetricRecords(as, ws, id, { member, limit: 100, ...q }) as Promise<any>;
  const widgetValue = async (as: Caller, dash: string, w: string) =>
    (
      (await env.svc.dashboardWidget(as, ws, dash, w, {})) as {
        outcome: { state: string; value: number | null } & Record<string, any>;
      }
    ).outcome;
  const find = (as: Caller, q: string) => env.svc.search(as, ws, { q });
  const ids = (r: { results: Array<{ id: string }> }) => r.results.map((x) => x.id);
  const mk = async (key: string, body: Record<string, unknown>) =>
    (tsk[key] = (await env.svc.createTask(owner, ws, { title: key, ...body }, mutation())).data.id);

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
    wsId = await workspaceIdOf(db, ws);
    editor = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    reader = await join(env, db, owner, ws, { kind: 'member', role: 'read_only' });
    outsider = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    leaver = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    for (const [who, level] of [
      [editor, 'edit'],
      [reader, 'view'],
      [leaver, 'edit'],
    ] as const)
      await apply(env, owner, ws, {
        kind: 'brand_grant',
        brand: brands.Harbor,
        principal: await mem(who),
        level,
      });
    const project = async (key: string, brand: string, name: string) =>
      (proj[key] = (await env.svc.createProject(owner, ws, { brand, name }, mutation())).data.id);
    await project('launch', brands.Harbor!, 'Heron launch');
    await project('vault', brands.Harbor!, 'Heron vault');
    await project('site', brands.Summit!, 'Heron site');
    await env.svc.setAccess(
      owner,
      ws,
      proj.vault!,
      { access_mode: 'restricted', allow_record_shares: false },
      mutation(),
    );
    await mk('l1', { project: proj.launch, title: 'Heron launch plan', estimate_minutes: 60 });
    await mk('l2', { project: proj.launch, title: 'Heron launch copy', estimate_minutes: 120 });
    await mk('l3', { project: proj.launch, title: 'Heron launch review' });
    await mk('v1', { project: proj.vault, title: 'Heron vault secret', estimate_minutes: 500 });
    await mk('v2', { project: proj.vault, title: 'Heron vault budget', estimate_minutes: 500 });
    await mk('s1', { project: proj.site, title: 'Heron site page' });
    await env.svc.addRelationship(
      owner,
      ws,
      tsk.l1!,
      { kind: 'blocks', target: tsk.l3! },
      mutation(),
    );
    await env.svc.addRelationship(
      owner,
      ws,
      tsk.v1!,
      { kind: 'blocks', target: tsk.l2! },
      mutation(),
    );
    const v = (await env.svc.getTask(owner, ws, tsk.v2!)).version;
    await env.svc.completeTask(owner, ws, tsk.v2!, {}, mutation({ ifMatch: `"${v}"` }));
    guest = await join(env, db, owner, ws, {
      kind: 'guest',
      records: [{ record: tsk.l2, level: 'comment' }],
    });
    await drain();
  }, 360_000);
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('serves the 5C metrics to dashboards through the metric port, for each viewer, with figure and records from one authority', async () => {
    const dash = (
      await env.svc.createDashboard(
        owner,
        ws,
        {
          title: 'Everything',
          kind: 'owner',
          layout: {
            widgets: [
              widget('age', 'work.aging'),
              widget('blocked', 'work.blocked'),
              widget('stale', 'work.stale'),
              widget('cycle', 'work.cycle_time'),
              widget('flow', 'work.created_vs_completed'),
              widget('tis', 'work.time_in_status'),
            ],
          },
        },
        mutation(),
      )
    ).data;
    // The catalog offers them, and the sources that do not exist yet stay unavailable.
    const cat = env.svc.metricCatalog(false);
    expect(cat.metrics.map((m: { key: string }) => m.key)).toEqual(
      expect.arrayContaining([
        'work.aging',
        'work.blocked',
        'work.stale',
        'work.cycle_time',
        'work.created_vs_completed',
        'work.time_in_status',
      ]),
    );
    // 7A (AI usage), 8A (automation outcomes), and 8C (agent outcomes) have since registered
    // through the same port; the later sources remain listed.
    expect(cat.not_available.map((m: { key: string }) => m.key).sort()).toEqual(['quality.release']);
    expect(env.svc.metricCatalog(true).metrics.map((m: { key: string }) => m.key)).not.toContain(
      'work.aging',
    );
    const open = async (as: Caller) => (await metric(as, 'work.age')).value.open as number;
    const blocked = async (as: Caller) =>
      (await metric(as, 'work.attention')).value.blocked as number;
    for (const [as, name] of [
      [owner, 'owner'],
      [editor, 'editor'],
      [reader, 'reader'],
      [outsider, 'outsider'],
    ] as const) {
      const w = await widgetValue(as, dash.id, 'age');
      expect(w.value, `${name}: aging widget equals the metric`).toBe(await open(as));
      expect((await widgetValue(as, dash.id, 'blocked')).value, `${name}: blocked`).toBe(
        await blocked(as),
      );
      // The records behind the widget are exactly its count.
      const drill = (await env.svc.dashboardDrill(as, ws, dash.id, 'age', {})) as {
        rows: Array<{ link: { id: string } }>;
      };
      const behind = await records(as, 'work.age', 'open');
      expect(drill.rows.map((r) => r.link.id).sort(), `${name}: drill`).toEqual(
        behind.items.map((i: { record: { id: string } }) => i.record.id).sort(),
      );
    }
    // Hidden work: the owner reads the vault, the editor and reader do not, the outsider reads nothing.
    expect(await open(owner)).toBe(5);
    expect(await open(editor)).toBe(3);
    expect(await open(outsider)).toBe(0);
    expect(await blocked(owner)).toBe(2);
    expect(await blocked(editor)).toBe(1); // the vault blocker is hidden, the open one is not
    // A figure with no history to measure says so, on the dashboard as in the metric.
    const cycle = await widgetValue(owner, dash.id, 'cycle');
    expect(cycle.state).not.toBe('error');
    const flow = (await env.svc.dashboardWidget(editor, ws, dash.id, 'flow', {})) as {
      outcome: Record<string, any>;
    };
    expect(flow.outcome.freshness).toBeDefined();
    // Neither role can place what the catalog does not offer: a guest has no dashboards, and the
    // sources that do not exist yet are refused with their reason.
    await expect(
      env.svc.createDashboard(
        owner,
        ws,
        { title: 'No', kind: 'owner', layout: { widgets: [widget('a', 'quality.release')] } },
        mutation(),
      ),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'not_available' })]),
    });
    await expect(env.svc.dashboardWidget(guest, ws, dash.id, 'age', {})).rejects.toEqual(
      expect.objectContaining({ code: expect.stringMatching(/not_found|forbidden/) }),
    );
  });

  it('keeps search, goals, portfolios, metrics, dashboards, and exports in step as access, lifecycle, and membership change', async () => {
    const dash = (
      await env.svc.createDashboard(
        editor,
        ws,
        {
          title: 'Harbor',
          kind: 'brand',
          brand: brands.Harbor,
          layout: { widgets: [widget('open', 'tasks.open'), widget('age', 'work.aging')] },
        },
        mutation(),
      )
    ).data;
    const g = (
      await env.svc.createGoal(
        owner,
        ws,
        { title: 'Ship Heron', period: Q4, basis: 'linked_work', brand: brands.Harbor },
        mutation(),
      )
    ).data;
    await env.svc.addGoalLink(owner, ws, g.id, { target: proj.launch! }, mutation());
    await drain();
    await sweepGoals();
    const snapshot = async (as: Caller) => {
      const s = await find(as, 'heron').then(
        (r) => ids(r).length,
        () => -1,
      );
      const goal = await env.svc.getGoal(as, ws, g.id).then(
        (x) => x.progress.work,
        (e) => ({ error: e.code }),
      );
      const comp = (await metric(as, 'project.completion')).parts;
      const age = await widgetValue(as, dash.id, 'age').then(
        (w) => w.value,
        (e) => (e as { code: string }).code,
      );
      const open = await widgetValue(as, dash.id, 'open').then(
        (w) => w.value,
        (e) => (e as { code: string }).code,
      );
      return { search: s, goal, completion: comp, age, open };
    };
    const before = await snapshot(editor);
    expect(before).toMatchObject({
      search: 4, // the project and its three tasks (the vault and the other brand are hidden)
      goal: { done: 0, total: 3 },
    });
    expect(before.completion).toEqual({ numerator: 0, denominator: 3 });
    expect(before.age).toBe(3);
    // Trash and restore a linked task: every surface moves with it, at once, and back.
    await env.svc.taskLifecycle(owner, ws, tsk.l3!, 'trash', {}, mutation());
    const trashed = await snapshot(editor);
    expect(trashed.goal).toEqual({ done: 0, total: 2 });
    expect(trashed.completion).toEqual({ numerator: 0, denominator: 2 });
    expect(trashed.age).toBe(2);
    expect(trashed.search).toBe(before.search - 1);
    await env.svc.taskLifecycle(owner, ws, tsk.l3!, 'restore', {}, mutation());
    expect(await snapshot(editor)).toEqual(before);
    // Revoking the brand removes the work from every surface for the editor on the next request.
    await apply(env, owner, ws, {
      kind: 'brand_revoke',
      brand: brands.Harbor,
      principal: await mem(editor),
    });
    const revoked = await snapshot(editor);
    expect(revoked.search).toBe(0);
    expect(revoked.goal).toEqual({ error: 'not_found' });
    expect(revoked.completion).toEqual({ numerator: 0, denominator: 0 });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: await mem(editor),
      level: 'edit',
    });
    expect(await snapshot(editor)).toEqual(before);
    // A departed member loses everything, and what they owned moves with the departure plan.
    const lm = await mem(leaver);
    const preview = await env.svc.previewChange(owner, ws, { kind: 'remove', member: lm });
    env.stepUp.allow = true;
    try {
      await env.svc.removeMember(
        owner,
        ws,
        lm,
        { preview_token: preview.preview_token, reassign_to: await mem(owner) },
        mutation({ stepUpToken: 't' }),
      );
    } finally {
      env.stepUp.allow = false;
    }
    await expect(metric(leaver, 'project.completion')).rejects.toEqual(reason('not_found'));
    await expect(find(leaver, 'heron')).rejects.toEqual(reason('not_found'));
    await expect(env.svc.dashboardWidget(leaver, ws, dash.id, 'age', {})).rejects.toEqual(
      reason('not_found'),
    );
    // A purge removes the task's history, its search row, and its goal link together.
    const t = (
      await env.svc.createTask(
        owner,
        ws,
        { title: 'Heron doomed', project: proj.launch },
        mutation(),
      )
    ).data;
    await env.svc.addGoalLink(owner, ws, g.id, { target: t.id }, mutation());
    await drain();
    expect(ids(await find(editor, 'doomed'))).toEqual([t.id]);
    await env.svc.taskLifecycle(owner, ws, t.id, 'trash', {}, mutation());
    await env.svc.taskLifecycle(owner, ws, t.id, 'purge', {}, mutation());
    const rid = (await sql(`SELECT id FROM core.record WHERE public_id = $1`, [t.id]))[0]!
      .id as string;
    await env.h.worker.withWorkspace(wsId, { module: 'test' }, async (tx) => {
      const { sql: ksql } = await import('@pm/db');
      await ksql`UPDATE core.record SET lifecycle_state = 'purged', purged_at = now(), prior_lifecycle_state = NULL,
          owner_membership_id = NULL, source_ref = NULL, template_installation_id = NULL, archive_cause = NULL,
          archive_batch_id = NULL, archived_at = NULL, archived_by_type = NULL, archived_by_id = NULL, version = version + 1
        WHERE id = ${rid}`.execute(tx.db);
    });
    expect(
      (
        await sql(`SELECT count(*)::int AS n FROM metrics.task_status_span WHERE task_id = $1`, [
          rid,
        ])
      )[0]!.n,
    ).toBe(0);
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM search.search_document WHERE source_id = $1 OR auth_record_id = $1`,
          [rid],
        )
      )[0]!.n,
    ).toBe(0);
    expect((await find(editor, 'doomed')).results).toEqual([]);
  });

  it('delivers scheduled reports as each recipient, never beyond what they may read, and recovers from an unconfigured provider', async () => {
    const r = (
      await env.svc.createReport(
        owner,
        ws,
        {
          title: 'Weekly health',
          layout: { widgets: [widget('age', 'work.aging'), widget('open', 'tasks.open')] },
        },
        mutation(),
      )
    ).data;
    await env.svc.shareReport(owner, ws, r.id, { grantee: await mem(editor) }, mutation());
    const withRecipients = await env.svc.setReportRecipients(
      owner,
      ws,
      r.id,
      {
        members: [await mem(owner), await mem(editor)],
        version: (await env.svc.getReport(owner, ws, r.id)).version,
      },
      mutation(),
    );
    await env.svc.setReportSchedule(
      owner,
      ws,
      r.id,
      {
        version: withRecipients.data.version,
        schedule: { frequency: 'daily', time: '00:00', timezone: 'UTC' },
      },
      mutation(),
    );
    await sql(
      `UPDATE insights.report_definition SET next_run_at = now() - interval '1 minute' WHERE title = 'Weekly health'`,
    );
    // A provider that is not configured is recorded honestly: nothing is claimed as sent, and each
    // recipient's occurrence is recorded as skipped for that reason.
    const none = await deliver(new Date(), emailProviderFrom(null, 'pm@test'));
    expect(outbox.sent).toHaveLength(0);
    expect(none.delivered).toBe(0);
    const skipped = await sql(`SELECT state, detail FROM insights.report_run ORDER BY created_at`);
    expect(skipped.length).toBeGreaterThanOrEqual(2);
    expect(
      skipped.every((r) => r.state === 'skipped' && r.detail === 'provider_unconfigured'),
    ).toBe(true);
    // When the provider exists, the next occurrence goes out.
    await sql(
      `UPDATE insights.report_definition SET next_run_at = now() - interval '1 minute', last_run_at = NULL, claimed_until = NULL WHERE title = 'Weekly health'`,
    );
    const first = await deliver(new Date(Date.now() + 86_400_000));
    expect(first.delivered).toBeGreaterThanOrEqual(2);
    const mail = (c: string) => outbox.sent.find((m) => m.to === c)!.text;
    const ownerOpen = (await metric(owner, 'work.age')).value.open as number;
    const editorOpen = (await metric(editor, 'work.age')).value.open as number;
    expect(ownerOpen).toBeGreaterThan(editorOpen);
    expect(mail(await emailOf(editor))).toContain(`${editorOpen}`);
    expect(mail(await emailOf(editor))).not.toMatch(/vault/i);
    expect(mail(await emailOf(owner))).toContain(`${ownerOpen}`);
    // The same occurrence again (a crashed or overlapping sweep) sends nothing more.
    const sent = outbox.sent.length;
    await sql(
      `UPDATE insights.report_definition SET next_run_at = last_run_at, claimed_until = NULL WHERE title = 'Weekly health'`,
    );
    await deliver(new Date(Date.now() + 2000));
    expect(outbox.sent).toHaveLength(sent);
    // A recipient who loses access is removed and never emailed again.
    await apply(env, owner, ws, {
      kind: 'brand_revoke',
      brand: brands.Harbor,
      principal: await mem(editor),
    });
    for (const s of (
      (await env.svc.listReportShares(owner, ws, r.id)) as { data: Array<{ id: string }> }
    ).data)
      await env.svc.revokeReportShare(owner, ws, r.id, s.id, mutation());
    outbox.sent.length = 0;
    await sql(
      `UPDATE insights.report_definition SET next_run_at = now() - interval '1 minute', last_run_at = NULL, claimed_until = NULL WHERE title = 'Weekly health'`,
    );
    await deliver(new Date(Date.now() + 86_400_000));
    expect(outbox.sent.filter((m) => /Editor weekly/.test(m.subject))).toEqual([]);
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: await mem(editor),
      level: 'edit',
    });
  });

  it('converges when indexing, recalculation, reconciliation, delivery, and edits overlap, and repeats change nothing', async () => {
    const t = (
      await env.svc.createTask(
        owner,
        ws,
        { title: 'Heron overlap alpha', project: proj.launch },
        mutation(),
      )
    ).data;
    const rename = async (title: string) => {
      const cur = await env.svc.getTask(owner, ws, t.id);
      await env.svc.updateTask(
        owner,
        ws,
        t.id,
        { version: cur.version, changes: { title: { base: cur.title, value: title } } },
        mutation({ ifMatch: `"${cur.version}"` }),
      );
    };
    // Two writers race on one task; the loser re-reads and tries again (optimistic concurrency).
    const finish = async () => {
      for (let i = 0; i < 6; i++) {
        const cur = await env.svc.getTask(owner, ws, t.id);
        try {
          await env.svc.completeTask(
            owner,
            ws,
            t.id,
            {},
            mutation({ ifMatch: `"${cur.version}"` }),
          );
          return;
        } catch (e) {
          if ((e as { code?: string }).code !== 'conflict') throw e;
        }
      }
      throw new Error('could not finish');
    };
    await Promise.all([
      drain(),
      sweepGoals(),
      reconcile(),
      deliver(),
      rename('Heron overlap beta'),
      drain(),
      reconcile(),
      sweepGoals(),
      finish(),
    ]);
    await drain();
    await sweepGoals();
    await reconcile();
    // One open span per task, matching its status, and the search row says the latest title.
    expect(
      await sql(`SELECT t.id FROM work.task t JOIN core.record cr ON cr.id = t.id AND cr.lifecycle_state <> 'purged'
         WHERE (SELECT count(*) FROM metrics.task_status_span s WHERE s.task_id = t.id AND s.left_at IS NULL) <> 1`),
    ).toEqual([]);
    expect(ids(await find(owner, 'beta'))).toEqual([t.id]);
    expect(ids(await find(owner, 'alpha'))).toEqual([]);
    // Figures equal the records behind them once everything has settled, and a repeat changes nothing.
    const a = await metric(owner, 'work.created_vs_completed', { project: proj.launch });
    for (const m of a.drill.members)
      expect(
        (await records(owner, 'work.created_vs_completed', m.role, { project: proj.launch })).total,
      ).toBe(m.count);
    const again = await metric(owner, 'work.created_vs_completed', { project: proj.launch });
    expect(again.reproducibility.result_digest).toBe(a.reproducibility.result_digest);
    const sent = outbox.sent.length;
    await deliver();
    expect(outbox.sent).toHaveLength(sent);
    // The reconciliation request is for administrators, and a lapsed lease is taken over.
    await expect(env.svc.requestReconcile(editor, ws)).rejects.toEqual(reason('forbidden'));
    expect(await env.svc.requestReconcile(owner, ws)).toEqual({ requested: true });
    const freshness = await metric(owner, 'data.freshness');
    expect(freshness.value.sources.map((s: { source: string }) => s.source).sort()).toEqual([
      'goal_recalculation',
      'search_index',
      'status_history',
    ]);
  });

  it('shows a stale permission nowhere: a cursor, a share, and a schedule outlive nothing', async () => {
    const first = await env.svc.getMetricRecords(editor, ws, 'work.age', {
      member: 'open',
      limit: 1,
    });
    expect(first.page.next_cursor).toEqual(expect.any(String));
    await apply(env, owner, ws, {
      kind: 'brand_revoke',
      brand: brands.Harbor,
      principal: await mem(editor),
    });
    // The cursor of a person whose access changed pages through what they may read now, never what they could.
    const after = (await records(editor, 'work.age', 'open')) as { total: number };
    expect(after.total).toBe(0);
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: await mem(editor),
      level: 'edit',
    });
    // Another person can never use it.
    await expect(
      env.svc.getMetricRecords(owner, ws, 'work.age', {
        member: 'open',
        limit: 1,
        cursor: first.page.next_cursor,
      }),
    ).rejects.toEqual(reason('cursor_invalid'));
    // A report owned by a member who loses the authority to schedule is suspended and sends nothing.
    const mine = (
      await env.svc.createReport(
        editor,
        ws,
        {
          title: 'Editor weekly',
          brand: brands.Harbor,
          layout: { widgets: [widget('open', 'tasks.open')] },
        },
        mutation(),
      )
    ).data;
    const withRecipients = await env.svc.setReportRecipients(
      editor,
      ws,
      mine.id,
      { members: [await mem(editor)], version: mine.version },
      mutation(),
    );
    await env.svc.setReportSchedule(
      editor,
      ws,
      mine.id,
      {
        version: withRecipients.data.version,
        schedule: { frequency: 'daily', time: '00:00', timezone: 'UTC' },
      },
      mutation(),
    );
    await apply(env, owner, ws, {
      kind: 'brand_revoke',
      brand: brands.Harbor,
      principal: await mem(editor),
    });
    await sql(
      `UPDATE insights.report_definition SET next_run_at = now() - interval '1 minute' WHERE title = 'Editor weekly'`,
    );
    outbox.sent.length = 0;
    await deliver(new Date(Date.now() + 3 * 86_400_000));
    expect(outbox.sent.filter((m) => /Editor weekly/.test(m.subject))).toEqual([]);
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: await mem(editor),
      level: 'edit',
    });
  });
});
