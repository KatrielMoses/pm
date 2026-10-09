import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import { productLifecycleRegistry, type EmailProvider, type ExternalMessage } from '@pm/work';
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

const widget = (id: string, metric: string, params: Record<string, unknown> = {}) => ({
  id,
  metric,
  params,
});

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
 * 5D scheduled delivery and its recovery (ADR-0030 D12 to D14): overlapping and crashed sweeps,
 * leases, outages, trash, retention, departure, workspace isolation, purge, and a widget that
 * fails while the rest of a document is still produced.
 */
describe('Dashboard and report jobs, recovery, and lifecycle (5D)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let editor: Caller;
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  let ownerId: string;
  let editorId: string;
  const proj: Record<string, string> = {};
  const outbox = new Outbox();

  const mem = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
  const sql = async (text: string) => (await db.admin(text)).rows as Array<Record<string, any>>;
  const sweep = (now = new Date(), e = env, id = wsId) =>
    e.svc.runReportSweep(e.h.worker, id, now, { email: outbox, origin: 'https://pm.test' });
  const daily = { frequency: 'daily', time: '06:00', timezone: 'UTC' };

  /** A scheduled Harbor report owned by `as`, sent to `to`, made due now. */
  async function scheduled(
    title: string,
    as: Caller,
    to: string[],
    e = env,
    w = ws,
    b = brands.Harbor!,
  ) {
    const r = (
      await e.svc.createReport(
        as,
        w,
        { title, brand: b, layout: { widgets: [widget('open', 'tasks.open')] } },
        mutation(),
      )
    ).data;
    const withRecipients = await e.svc.setReportRecipients(
      as,
      w,
      r.id,
      { members: to, version: r.version },
      mutation(),
    );
    await e.svc.setReportSchedule(
      as,
      w,
      r.id,
      { version: withRecipients.data.version, schedule: daily },
      mutation(),
    );
    await sql(
      `UPDATE insights.report_definition SET next_run_at = now() - interval '1 minute' WHERE title = '${title}'`,
    );
    return r.id;
  }
  const runs = (title: string) =>
    sql(
      `SELECT x.state, x.detail FROM insights.report_run x JOIN insights.report_definition d ON d.id = x.report_id WHERE d.title = '${title}' ORDER BY x.created_at`,
    );

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor']));
    wsId = await workspaceIdOf(db, ws);
    editor = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    ownerId = await mem(owner);
    editorId = await mem(editor);
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: editorId,
      level: 'edit',
    });
    proj.launch = (
      await env.svc.createProject(owner, ws, { brand: brands.Harbor, name: 'Launch' }, mutation())
    ).data.id;
    await env.svc.createTask(owner, ws, { title: 'One', project: proj.launch }, mutation());
    await env.svc.createTask(owner, ws, { title: 'Two', project: proj.launch }, mutation());
  }, 120_000);
  afterAll(async () => {
    await db.drop();
  });

  it('sends once when two sweeps overlap', async () => {
    await scheduled('Overlap', owner, [ownerId, editorId]);
    outbox.sent.length = 0;
    await Promise.all([sweep(), sweep(), sweep()]);
    expect(outbox.sent).toHaveLength(2);
    expect(await runs('Overlap')).toHaveLength(2);
  });

  it('leaves a leased report alone and reclaims it once the lease lapses (a crashed worker)', async () => {
    await scheduled('Leased', owner, [ownerId]);
    await sql(
      `UPDATE insights.report_definition SET claimed_until = now() + interval '10 minutes' WHERE title = 'Leased'`,
    );
    outbox.sent.length = 0;
    expect(await sweep()).toMatchObject({ reports: 0 });
    expect(outbox.sent).toHaveLength(0);
    await sql(
      `UPDATE insights.report_definition SET claimed_until = now() - interval '1 second' WHERE title = 'Leased'`,
    );
    expect(await sweep()).toMatchObject({ reports: 1, delivered: 1 });
  });

  it('finishes a delivery a crashed worker left half done without sending it twice', async () => {
    const id = await scheduled('Crashed', owner, [ownerId, editorId]);
    const due = (
      await sql(`SELECT next_run_at FROM insights.report_definition WHERE title = 'Crashed'`)
    )[0]!.next_run_at as Date;
    outbox.sent.length = 0;
    // First sweep creates the runs; make one look unfinished, as if the send never happened.
    await sweep();
    await sql(
      `UPDATE insights.report_run SET state = 'pending', finished_at = NULL, detail = NULL WHERE recipient_membership_id IN (SELECT id FROM tenancy.membership WHERE public_id = '${ownerId}') AND report_id IN (SELECT id FROM insights.report_definition WHERE title = 'Crashed')`,
    );
    await sql(
      `UPDATE insights.report_definition SET next_run_at = '${new Date(due).toISOString()}', claimed_until = NULL, last_run_at = NULL WHERE title = 'Crashed'`,
    );
    const before = outbox.sent.length;
    await sweep();
    // Only the unfinished recipient is sent to again; the finished one is left alone.
    expect(outbox.sent.length - before).toBe(1);
    expect((await runs('Crashed')).filter((r) => r.state === 'delivered')).toHaveLength(2);
    expect(await runs('Crashed')).toHaveLength(2);
    void id;
  });

  it('owes one delivery after a long outage and moves on', async () => {
    await scheduled('Outage', owner, [ownerId]);
    await sql(
      `UPDATE insights.report_definition SET next_run_at = now() - interval '10 days' WHERE title = 'Outage'`,
    );
    outbox.sent.length = 0;
    await sweep();
    expect(outbox.sent).toHaveLength(1);
    expect(await runs('Outage')).toHaveLength(1);
    const row = (
      await sql(
        `SELECT next_run_at > now() AS future FROM insights.report_definition WHERE title = 'Outage'`,
      )
    )[0]!;
    expect(row.future).toBe(true);
  });

  it('sends nothing for a trashed report, and carries on after it is restored', async () => {
    const id = await scheduled('Trashy', owner, [ownerId]);
    await env.svc.reportLifecycle(owner, ws, id, 'trash', mutation());
    outbox.sent.length = 0;
    expect(await sweep()).toMatchObject({ reports: 0 });
    expect(outbox.sent).toHaveLength(0);
    await env.svc.reportLifecycle(owner, ws, id, 'restore', mutation());
    expect(await sweep()).toMatchObject({ reports: 1, delivered: 1 });
  });

  it('ages out finished runs past retention and keeps what is pending', async () => {
    await sql(`INSERT INTO insights.report_run (id, workspace_id, report_id, recipient_membership_id, occurrence_at, state, finished_at, created_at)
      SELECT gen_random_uuid(), d.workspace_id, d.id, d.owner_membership_id, now() - interval '200 days', 'delivered', now() - interval '200 days', now() - interval '200 days'
        FROM insights.report_definition d WHERE d.title = 'Overlap'`);
    await sql(`INSERT INTO insights.report_run (id, workspace_id, report_id, recipient_membership_id, occurrence_at, state, created_at)
      SELECT gen_random_uuid(), d.workspace_id, d.id, d.owner_membership_id, now() - interval '201 days', 'pending', now() - interval '201 days'
        FROM insights.report_definition d WHERE d.title = 'Overlap'`);
    const out = await sweep();
    expect(out.purged).toBeGreaterThanOrEqual(1);
    const left = await sql(
      `SELECT state FROM insights.report_run WHERE created_at < now() - interval '100 days'`,
    );
    expect(left.map((r) => r.state)).toEqual(['pending']);
  });

  it('hands a departed member’s reports on, pauses their schedule, and drops their recipient row', async () => {
    const leaver = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    const leaverId = await mem(leaver);
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: leaverId,
      level: 'edit',
    });
    const id = await scheduled('Leavers', leaver, [leaverId, ownerId]);
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
    const view = await env.svc.getReport(owner, ws, id);
    expect(view.owner).toMatchObject({ id: ownerId });
    expect(view.schedule?.suspended).toMatchObject({ reason: 'owner_departed' });
    expect(
      (await env.svc.listReportRecipients(owner, ws, id)) as { data: Array<{ id: string }> },
    ).toEqual({ data: [expect.objectContaining({ id: ownerId })] });
    outbox.sent.length = 0;
    await sweep();
    expect(outbox.sent).toHaveLength(0);
    // The person who takes it over resumes it and answers for it from then on.
    const resumed = await env.svc.resumeReport(owner, ws, id, mutation());
    expect(resumed.data.schedule?.suspended).toBeNull();
  });

  it('never reads or sends another workspace’s reports', async () => {
    const other = workEnv(db);
    const o = await workspaceWith(other, db, ['Elsewhere']);
    const otherWs = await workspaceIdOf(db, o.ws);
    const otherOwner = (await membershipOf(db, otherWs, o.owner.auth.account.id))!.public_id;
    await scheduled('Elsewhere report', o.owner, [otherOwner], other, o.ws, o.brands.Elsewhere!);
    outbox.sent.length = 0;
    const mine = await sweep();
    expect(outbox.sent.some((m) => m.subject.includes('Elsewhere'))).toBe(false);
    expect(mine.reports).toBe(0);
    const theirs = await sweep(new Date(), other, otherWs);
    expect(theirs).toMatchObject({ reports: 1, delivered: 1 });
    expect(outbox.sent.at(-1)!.subject).toContain('Elsewhere report');
    await other.h.close();
  });

  it('removes a report’s runs, shares, and recipients with it, and a project carries its own', async () => {
    const id = await scheduled('Doomed report', owner, [ownerId]);
    await env.svc.shareReport(owner, ws, id, { grantee: editorId }, mutation());
    await sweep();
    const internal = async (publicId: string) =>
      (await sql(`SELECT id FROM core.record WHERE public_id = '${publicId}'`))[0]!.id as string;
    const reportInternal = await internal(id);
    const pd = (
      await env.svc.createDashboard(
        owner,
        ws,
        { title: 'Project board', kind: 'project', project: proj.launch },
        mutation(),
      )
    ).data;
    const pr = (
      await env.svc.createReport(
        owner,
        ws,
        { title: 'Project report', project: proj.launch },
        mutation(),
      )
    ).data;
    const projectInternal = await internal(proj.launch!);
    const registry = productLifecycleRegistry();
    await env.h.worker.withWorkspace(wsId, { module: 'test' }, async (tx) => {
      const carried = await registry.get('project')!.children!(tx, [projectInternal]);
      expect(
        carried
          .map((c) => c.recordType)
          .filter((t) => t === 'dashboard' || t === 'report_definition')
          .sort(),
      ).toEqual(['dashboard', 'report_definition']);
      await registry.get('report_definition')!.purge!.deleteContent(tx, [reportInternal]);
    });
    for (const table of ['report_run', 'report_share', 'report_recipient'])
      expect(
        await sql(`SELECT 1 FROM insights.${table} WHERE report_id = '${reportInternal}'`),
      ).toHaveLength(0);
    expect(
      await sql(`SELECT 1 FROM insights.report_definition WHERE id = '${reportInternal}'`),
    ).toHaveLength(0);
    void pd;
    void pr;
  });

  it('still produces an export when one widget cannot be loaded, and says so', async () => {
    const d = (
      await env.svc.createDashboard(
        owner,
        ws,
        {
          title: 'Brittle',
          kind: 'owner',
          layout: { widgets: [widget('time', 'time.by_brand'), widget('open', 'tasks.open')] },
        },
        mutation(),
      )
    ).data;
    const spy = vi
      .spyOn(env.svc as unknown as Record<string, (...a: never[]) => unknown>, 'timeReportIn')
      .mockRejectedValue(new Error('boom'));
    try {
      const w = (await env.svc.dashboardWidget(owner, ws, d.id, 'time', {})) as {
        outcome: { state: string };
      };
      expect(w.outcome.state).toBe('error');
      const csv = await env.svc.exportDashboard(owner, ws, d.id, { format: 'csv' });
      expect(String(csv.body)).toContain('could not be loaded');
      expect(String(csv.body)).toMatch(/Open tasks/);
      expect(
        (
          (await env.svc.dashboardWidget(owner, ws, d.id, 'open', {})) as {
            outcome: { state: string };
          }
        ).outcome.state,
      ).toBe('ok');
    } finally {
      spy.mockRestore();
    }
  });
});
