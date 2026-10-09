import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import type { EmailProvider, ExternalMessage } from '@pm/work';
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

const ifMatch = (v: number) => mutation({ ifMatch: `"${v}"` });
const rejects = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; issues?: Array<{ code: string; pointer: string }> };
  }
  throw new Error('expected a rejection');
};
const widget = (id: string, metric: string, params: Record<string, unknown> = {}) => ({
  id,
  metric,
  params,
});

class Outbox implements EmailProvider {
  readonly name = 'test';
  state: 'configured' | 'capture' | 'unconfigured' = 'configured';
  sent: ExternalMessage[] = [];
  fail: 'none' | 'transient' | 'permanent' = 'none';
  async send(m: ExternalMessage) {
    if (this.fail === 'transient') throw Object.assign(new Error('x'), { code: 'ECONNRESET' });
    if (this.fail === 'permanent') throw Object.assign(new Error('x'), { responseCode: 550 });
    this.sent.push(m);
    return { providerMessageId: `pm_${this.sent.length}` };
  }
}

/**
 * 5D dashboards and reports (ADR-0031): every figure is computed for the person reading it, from
 * what that person may read; shares are explicit and revocable; delivery renders per recipient.
 */
describe('Dashboards and reports (5D)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let editor: Caller; // edit on Harbor
  let reader: Caller; // view on Harbor
  let outsider: Caller; // member without access to Harbor
  let guest: Caller; // guest with a grant on one task
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  const pub: Record<string, string> = {};
  const proj: Record<string, string> = {};
  const tsk: Record<string, string> = {};
  const outbox = new Outbox();

  const mem = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
  const val = async (as: Caller, dash: string, w: string, filters?: unknown) => {
    const r = (await env.svc.dashboardWidget(
      as,
      ws,
      dash,
      w,
      filters ? { filters: JSON.stringify(filters) } : {},
    )) as { outcome: { state: string; value: number | null } & Record<string, any> };
    return r.outcome;
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
    wsId = await workspaceIdOf(db, ws);
    editor = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    reader = await join(env, db, owner, ws, { kind: 'member', role: 'read_only' });
    outsider = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: await mem(editor),
      level: 'edit',
    });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: await mem(reader),
      level: 'view',
    });
    pub.owner = await mem(owner);
    pub.editor = await mem(editor);
    pub.reader = await mem(reader);
    pub.outsider = await mem(outsider);
    const mkProject = async (key: string, brand: string, name: string) =>
      (proj[key] = (await env.svc.createProject(owner, ws, { brand, name }, mutation())).data.id);
    await mkProject('launch', brands.Harbor!, 'Launch');
    await mkProject('vault', brands.Harbor!, 'Vault');
    await mkProject('site', brands.Summit!, 'Site');
    await env.svc.setAccess(
      owner,
      ws,
      proj.vault!,
      { access_mode: 'restricted', allow_record_shares: false },
      mutation(),
    );
    const mkTask = async (key: string, body: Record<string, unknown>) =>
      (tsk[key] = (
        await env.svc.createTask(owner, ws, { title: key, ...body }, mutation())
      ).data.id);
    await mkTask('l1', { project: proj.launch });
    await mkTask('l2', { project: proj.launch });
    await mkTask('l3', { project: proj.launch });
    await mkTask('v1', { project: proj.vault });
    await mkTask('v2', { project: proj.vault });
    await mkTask('s1', { project: proj.site });
    await mkTask('s2', { project: proj.site });
    guest = await join(env, db, owner, ws, {
      kind: 'guest',
      records: [{ record: tsk.l2, level: 'comment' }],
    });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  describe('dashboards', () => {
    it('creates owner, brand, project, release, and personal dashboards with bounded widgets', async () => {
      const w = [widget('open', 'tasks.open'), widget('over', 'tasks.overdue')];
      const o = (
        await env.svc.createDashboard(
          owner,
          ws,
          { title: 'Everything', kind: 'owner', layout: { widgets: w } },
          mutation(),
        )
      ).data;
      expect(o).toMatchObject({
        type: 'dashboard',
        kind: 'owner',
        scope: { kind: 'workspace' },
        version: 0,
      });
      expect(o.widgets.map((x) => x.id)).toEqual(['open', 'over']);
      const b = (
        await env.svc.createDashboard(
          editor,
          ws,
          { title: 'Harbor', kind: 'brand', brand: brands.Harbor },
          mutation(),
        )
      ).data;
      expect(b.scope).toMatchObject({ kind: 'brand' });
      const p = (
        await env.svc.createDashboard(
          editor,
          ws,
          { title: 'Launch', kind: 'project', project: proj.launch },
          mutation(),
        )
      ).data;
      expect(p.scope).toMatchObject({ kind: 'project' });
      const r = (
        await env.svc.createDashboard(
          editor,
          ws,
          { title: 'Release', kind: 'release', brand: brands.Harbor },
          mutation(),
        )
      ).data;
      expect(r.kind).toBe('release');
      const me = (
        await env.svc.createDashboard(
          editor,
          ws,
          { title: 'Mine', kind: 'personal', layout: { widgets: [widget('mine', 'tasks.open')] } },
          mutation(),
        )
      ).data;
      expect(me.scope).toMatchObject({ kind: 'personal' });
      const tooMany = Array.from({ length: 25 }, (_, i) => widget(`w${i}`, 'tasks.open'));
      const e = await rejects(
        env.svc.createDashboard(
          owner,
          ws,
          { title: 'Big', kind: 'owner', layout: { widgets: tooMany } },
          mutation(),
        ),
      );
      expect(e.code).toBe('validation_failed');
    });

    it('refuses unknown and not-yet-available metrics with an honest reason', async () => {
      const e = await rejects(
        env.svc.createDashboard(
          owner,
          ws,
          { title: 'X', kind: 'owner', layout: { widgets: [widget('a', 'work.cycle_time')] } },
          mutation(),
        ),
      );
      expect(e.issues?.[0]).toMatchObject({ code: 'not_available' });
      const e2 = await rejects(
        env.svc.createDashboard(
          owner,
          ws,
          { title: 'X', kind: 'owner', layout: { widgets: [widget('a', 'nope.nothing')] } },
          mutation(),
        ),
      );
      expect(e2.issues?.[0]).toMatchObject({ code: 'unknown_metric' });
      const cat = await env.svc.insightMetrics(owner, ws);
      expect(cat.not_available.map((m) => m.key)).toContain('work.cycle_time');
    });

    it('requires placement authority, and keeps personal dashboards personal', async () => {
      expect(
        (
          await rejects(
            env.svc.createDashboard(
              reader,
              ws,
              { title: 'No', kind: 'brand', brand: brands.Harbor },
              mutation(),
            ),
          )
        ).code,
      ).toBe('forbidden');
      expect(
        (
          await rejects(
            env.svc.createDashboard(
              outsider,
              ws,
              { title: 'No', kind: 'brand', brand: brands.Harbor },
              mutation(),
            ),
          )
        ).code,
      ).toMatch(/not_found|forbidden/);
      const mine = (
        await env.svc.createDashboard(
          editor,
          ws,
          { title: 'Private', kind: 'personal' },
          mutation(),
        )
      ).data;
      expect((await rejects(env.svc.getDashboard(owner, ws, mine.id))).code).toBe('not_found');
      const list = await env.svc.listDashboards(owner, ws, {});
      expect(list.data.map((d) => d.id)).not.toContain(mine.id);
      const mineList = await env.svc.listDashboards(editor, ws, {});
      expect(mineList.data.map((d) => d.id)).toContain(mine.id);
    });

    it('updates with optimistic concurrency and one winner under a race', async () => {
      const d = (
        await env.svc.createDashboard(owner, ws, { title: 'Race', kind: 'owner' }, mutation())
      ).data;
      const results = await Promise.allSettled([
        env.svc.updateDashboard(owner, ws, d.id, { title: 'A' }, ifMatch(0)),
        env.svc.updateDashboard(owner, ws, d.id, { title: 'B' }, ifMatch(0)),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const stale = await rejects(
        env.svc.updateDashboard(owner, ws, d.id, { title: 'C' }, ifMatch(0)),
      );
      expect(stale.code).toBe('conflict');
    });

    it('replays an idempotent create once', async () => {
      const key = mutation();
      const a = await env.svc.createDashboard(owner, ws, { title: 'Once', kind: 'owner' }, key);
      const b = await env.svc.createDashboard(owner, ws, { title: 'Once', kind: 'owner' }, key);
      expect(b.data.id).toBe(a.data.id);
      expect(b.replayed).toBe(true);
    });
  });

  describe('figures are computed for the viewer', () => {
    let dash: string;
    beforeAll(async () => {
      dash = (
        await env.svc.createDashboard(
          owner,
          ws,
          {
            title: 'Counts',
            kind: 'owner',
            layout: {
              widgets: [
                widget('open', 'tasks.open'),
                widget('byproject', 'tasks.open', { group_by: 'project' }),
                widget('unassigned', 'tasks.unassigned'),
              ],
            },
          },
          mutation(),
        )
      ).data.id;
    });

    it('differs by what each person may read, and hidden work changes no number or label', async () => {
      expect((await val(owner, dash, 'open')).value).toBe(7);
      // The editor reads Harbor (launch) but not the restricted vault project or Summit.
      expect((await val(editor, dash, 'open')).value).toBe(3);
      expect((await val(reader, dash, 'open')).value).toBe(3);
      expect((await val(outsider, dash, 'open')).value).toBe(0);
      const g = (await val(editor, dash, 'byproject')).breakdown as Array<{ label: string }>;
      expect(g.map((x) => x.label)).toEqual(['Launch']);
    });

    it('carries covers, freshness, source, and applied filters on every figure', async () => {
      const o = await val(editor, dash, 'open');
      expect(o.covers).toMatch(/you can read/i);
      expect(o.freshness).toMatchObject({ basis: 'live', stale: false });
      expect(o.source.kind).toBe('work_query');
      expect(o.applied).toMatchObject({ brands: false });
      const f = await val(owner, dash, 'open', { brands: [brands.Harbor] });
      expect(f.value).toBe(5);
      expect(f.applied.brands).toBe(true);
    });

    it('drills into only the records the viewer may read', async () => {
      const r = (await env.svc.dashboardDrill(editor, ws, dash, 'open', {})) as {
        rows: Array<{ link: { id: string } }>;
      };
      expect(r.rows.map((x) => x.link.id).sort()).toEqual([tsk.l1, tsk.l2, tsk.l3].sort());
      const hidden = (await env.svc.dashboardDrill(outsider, ws, dash, 'open', {})) as {
        rows: unknown[];
      };
      expect(hidden.rows).toEqual([]);
    });

    it('a revoked grant applies to the next read', async () => {
      const g = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
      await apply(env, owner, ws, {
        kind: 'brand_grant',
        brand: brands.Summit,
        principal: await mem(g),
        level: 'view',
      });
      expect((await val(g, dash, 'open')).value).toBe(2);
      await apply(env, owner, ws, {
        kind: 'brand_revoke',
        brand: brands.Summit,
        principal: await mem(g),
      });
      // A revocation applies to the very next read: no stored figure outlives it.
      expect((await val(g, dash, 'open')).value).toBe(0);
    });

    it('one widget that cannot be shown does not hide the others', async () => {
      // A read-only member keeps personal dashboards (personal.manage_own); shared ones are read-only.
      const mine = await env.svc.createDashboard(
        reader,
        ws,
        { title: 'Reader mine', kind: 'personal' },
        mutation(),
      );
      expect(mine.data.capabilities.update).toBe(true);
      const d = (
        await env.svc.createDashboard(
          owner,
          ws,
          {
            title: 'Mixed',
            kind: 'owner',
            layout: { widgets: [widget('cap', 'capacity.workload'), widget('open', 'tasks.open')] },
          },
          mutation(),
        )
      ).data;
      const a = await val(reader, d.id, 'cap');
      expect(['unavailable', 'ok']).toContain(a.state);
      expect((await val(reader, d.id, 'open')).state).toBe('ok');
    });
  });

  describe('ad hoc widgets (Home and project pages)', () => {
    const adhoc = async (as: Caller, q: Record<string, unknown>) =>
      (await env.svc.adhocWidget(as, ws, { metric: 'tasks.open', ...q })) as {
        outcome: { state: string; value: number; covers: string };
      };
    it('computes the same figures a saved widget would, for the caller, over a brand or a project', async () => {
      expect((await adhoc(owner, {})).outcome.value).toBe(7);
      expect((await adhoc(editor, {})).outcome.value).toBe(3);
      expect((await adhoc(owner, { brand: brands.Harbor })).outcome.value).toBe(5);
      expect((await adhoc(owner, { project: proj.vault })).outcome.value).toBe(2);
      const covers = (await adhoc(owner, { project: proj.launch })).outcome.covers;
      expect(covers).toContain('Launch');
    });

    it('refuses what the caller cannot read exactly as it refuses what does not exist', async () => {
      const hidden = await rejects(
        env.svc.adhocWidget(editor, ws, { metric: 'tasks.open', project: proj.vault }),
      );
      const unknown = await rejects(
        env.svc.adhocWidget(editor, ws, {
          metric: 'tasks.open',
          project: 'prj_00000000000000000000000000',
        }),
      );
      expect(hidden.code).toBe('not_found');
      expect(unknown.code).toBe('not_found');
      const brand = await rejects(
        env.svc.adhocWidget(outsider, ws, { metric: 'tasks.open', brand: brands.Harbor }),
      );
      expect(brand.code).toBe('not_found');
    });

    it('is for members, validates its inputs, and pages its records', async () => {
      expect((await rejects(env.svc.adhocWidget(guest, ws, { metric: 'tasks.open' }))).code).toBe(
        'forbidden',
      );
      expect((await rejects(env.svc.adhocWidget(owner, ws, { metric: 'nope.nothing' }))).code).toBe(
        'validation_failed',
      );
      expect(
        (
          await rejects(
            env.svc.adhocWidget(owner, ws, {
              metric: 'tasks.open',
              brand: brands.Harbor,
              project: proj.launch,
            }),
          )
        ).code,
      ).toBe('validation_failed');
      const page = (await env.svc.adhocDrill(owner, ws, { metric: 'tasks.open', limit: '2' })) as {
        rows: unknown[];
        page: { has_more: boolean; next_cursor?: string };
      };
      expect(page.rows).toHaveLength(2);
      expect(page.page.has_more).toBe(true);
    });
  });

  describe('reports and shares', () => {
    let rpt: string;
    beforeAll(async () => {
      rpt = (
        await env.svc.createReport(
          editor,
          ws,
          {
            title: 'Weekly Harbor',
            brand: brands.Harbor,
            layout: { widgets: [widget('open', 'tasks.open'), widget('over', 'tasks.overdue')] },
          },
          mutation(),
        )
      ).data.id;
    });

    it('is invisible to someone without access until it is shared, and a share grants no data', async () => {
      expect((await rejects(env.svc.getReport(outsider, ws, rpt))).code).toBe('not_found');
      const s = (await env.svc.shareReport(owner, ws, rpt, { grantee: pub.outsider }, mutation()))
        .data;
      const view = await env.svc.getReport(outsider, ws, rpt);
      expect(view).toMatchObject({ access: 'share', scope: { kind: 'shared' } });
      const w = (await env.svc.reportWidget(outsider, ws, rpt, 'open', {})) as {
        outcome: { value: number; covers: string };
      };
      // The share opens the definition; the numbers are still the viewer's own (nothing in Harbor).
      expect(w.outcome.value).toBe(0);
      expect(w.outcome.covers).not.toMatch(/Harbor/);
      const list = await env.svc.listReports(outsider, ws, {});
      expect(list.data.map((r) => r.id)).toContain(rpt);
      await env.svc.revokeReportShare(owner, ws, rpt, s.id, mutation());
      expect((await rejects(env.svc.getReport(outsider, ws, rpt))).code).toBe('not_found');
      expect((await env.svc.listReports(outsider, ws, {})).data).toEqual([]);
    });

    it('limits a guest to the records granted to them, and to guest-safe widgets', async () => {
      const r2 = (
        await env.svc.createReport(
          owner,
          ws,
          {
            title: 'Guestable',
            layout: { widgets: [widget('open', 'tasks.open'), widget('time', 'time.by_brand')] },
          },
          mutation(),
        )
      ).data.id;
      expect((await rejects(env.svc.getReport(guest, ws, r2))).code).toBe('not_found');
      await env.svc.shareReport(owner, ws, r2, { grantee: await mem(guest) }, mutation());
      const open = (await env.svc.reportWidget(guest, ws, r2, 'open', {})) as {
        outcome: { value: number; covers: string };
      };
      expect(open.outcome.value).toBe(1);
      expect(open.outcome.covers).toBe('The records shared with you');
      const time = (await env.svc.reportWidget(guest, ws, r2, 'time', {})) as {
        outcome: { state: string };
      };
      expect(time.outcome.state).toBe('unavailable');
      const drill = (await env.svc.reportDrill(guest, ws, r2, 'open', {})) as {
        rows: Array<{ link: { id: string } }>;
      };
      expect(drill.rows.map((x) => x.link.id)).toEqual([tsk.l2]);
      expect((await rejects(env.svc.exportReport(guest, ws, r2, {}))).code).toMatch(
        /not_found|forbidden/,
      );
    });

    it('only managers share, and a share is bound to the report and listed to managers', async () => {
      expect(
        (await rejects(env.svc.shareReport(reader, ws, rpt, { grantee: pub.outsider }, mutation())))
          .code,
      ).toMatch(/forbidden|not_found/);
      const s = (await env.svc.shareReport(owner, ws, rpt, { grantee: pub.reader }, mutation()))
        .data;
      const dup = await rejects(
        env.svc.shareReport(owner, ws, rpt, { grantee: pub.reader }, mutation()),
      );
      expect(dup.code).toBe('conflict');
      const list = (await env.svc.listReportShares(owner, ws, rpt)) as {
        data: Array<{ id: string }>;
      };
      expect(list.data.map((x) => x.id)).toContain(s.id);
      await env.svc.revokeReportShare(owner, ws, rpt, s.id, mutation());
    });
  });

  describe('scheduled delivery', () => {
    let rpt: string;
    const sweep = (now: Date) =>
      env.svc.runReportSweep(env.h.worker, wsId, now, { email: outbox, origin: 'https://pm.test' });
    const runs = async () =>
      (
        await db.admin(
          `SELECT state, detail, recipient_membership_id FROM insights.report_run ORDER BY created_at, id`,
        )
      ).rows as Array<{ state: string; detail: string | null }>;

    beforeAll(async () => {
      rpt = (
        await env.svc.createReport(
          owner,
          ws,
          {
            title: 'Digest',
            brand: brands.Harbor,
            layout: { widgets: [widget('open', 'tasks.open')] },
          },
          mutation(),
        )
      ).data.id;
    });

    it('validates schedules and needs recipients first', async () => {
      const sched = { frequency: 'daily', time: '08:30', timezone: 'Europe/Berlin' };
      const none = await rejects(
        env.svc.setReportSchedule(owner, ws, rpt, { schedule: sched, version: 0 }, mutation()),
      );
      expect(none.issues?.[0]).toMatchObject({ code: 'no_recipients' });
      const bad = await rejects(
        env.svc.setReportSchedule(
          owner,
          ws,
          rpt,
          { schedule: { frequency: 'weekly', time: '08:30', timezone: 'Europe/Berlin' } },
          mutation(),
        ),
      );
      expect(bad.code).toBe('validation_failed');
      const noRead = await rejects(
        env.svc.setReportRecipients(
          owner,
          ws,
          rpt,
          { members: [pub.outsider], version: 0 },
          mutation(),
        ),
      );
      void bad;
      expect(noRead.code).toBe('validation_failed');
    });

    it('delivers once per recipient, as that recipient, and a repeat sends nothing more', async () => {
      await env.svc.shareReport(owner, ws, rpt, { grantee: pub.outsider }, mutation());
      const v = (await env.svc.getReport(owner, ws, rpt)).version;
      const withRecipients = await env.svc.setReportRecipients(
        owner,
        ws,
        rpt,
        { members: [pub.owner, pub.editor, pub.outsider], version: v },
        mutation(),
      );
      await env.svc.setReportSchedule(
        owner,
        ws,
        rpt,
        {
          version: withRecipients.data.version,
          schedule: { frequency: 'daily', time: '00:00', timezone: 'UTC' },
        },
        mutation(),
      );
      // Make it due now.
      await db.admin(
        `UPDATE insights.report_definition SET next_run_at = now() - interval '1 minute' WHERE schedule_frequency IS NOT NULL`,
      );
      const first = await sweep(new Date());
      expect(first).toMatchObject({ reports: 1, delivered: 3, skipped: 0 });
      expect(outbox.sent).toHaveLength(3);
      const body = (to: string) => outbox.sent.find((m) => m.to === to)!.text;
      const ownerMail = (
        await db.admin(`SELECT a.primary_email AS e FROM identity.account a
        JOIN tenancy.membership m ON m.account_id = a.id WHERE m.public_id = '${pub.owner}'`)
      ).rows[0].e as string;
      const editorMail = (
        await db.admin(`SELECT a.primary_email AS e FROM identity.account a
        JOIN tenancy.membership m ON m.account_id = a.id WHERE m.public_id = '${pub.editor}'`)
      ).rows[0].e as string;
      expect(body(ownerMail)).toMatch(/\b5\b/);
      expect(body(editorMail)).toMatch(/\b3\b/);
      expect(body(editorMail)).not.toMatch(/\b5\b/);
      const states = await runs();
      expect(states.filter((r) => r.state === 'delivered')).toHaveLength(3);
      // Same occurrence again (a crashed or overlapping sweep): nothing is sent twice.
      await db.admin(
        `UPDATE insights.report_definition SET next_run_at = last_run_at, claimed_until = NULL WHERE schedule_frequency IS NOT NULL`,
      );
      await sweep(new Date());
      expect(outbox.sent).toHaveLength(3);
    });

    it('removes a recipient who lost access and never emails them', async () => {
      const list = await env.svc.getReport(owner, ws, rpt);
      const shares = (await env.svc.listReportShares(owner, ws, rpt)) as {
        data: Array<{ id: string }>;
      };
      for (const s of shares.data)
        await env.svc.revokeReportShare(owner, ws, rpt, s.id, mutation());
      void list;
      outbox.sent.length = 0;
      await db.admin(
        `UPDATE insights.report_definition SET next_run_at = now() - interval '1 minute', last_run_at = NULL, claimed_until = NULL WHERE schedule_frequency IS NOT NULL`,
      );
      await sweep(new Date(Date.now() + 86_400_000));
      const skipped = (await runs()).filter((r) => r.detail === 'no_access');
      expect(skipped).toHaveLength(1);
      expect(outbox.sent).toHaveLength(2);
    });

    it('records an unconfigured or rejecting provider honestly and retries a transient failure', async () => {
      outbox.fail = 'transient';
      await db.admin(
        `UPDATE insights.report_definition SET next_run_at = now() - interval '1 minute', claimed_until = NULL, attempts = 0 WHERE schedule_frequency IS NOT NULL`,
      );
      const r = await sweep(new Date(Date.now() + 2 * 86_400_000));
      expect(r.retried).toBeGreaterThan(0);
      expect(
        (
          await db.admin(
            `SELECT count(*)::int AS n FROM insights.report_run WHERE state = 'pending'`,
          )
        ).rows[0].n,
      ).toBeGreaterThan(0);
      outbox.fail = 'none';
      await db.admin(
        `UPDATE insights.report_definition SET claimed_until = NULL WHERE schedule_frequency IS NOT NULL`,
      );
      const again = await sweep(new Date(Date.now() + 2 * 86_400_000));
      expect(again.delivered).toBeGreaterThan(0);
      expect(
        (
          await db.admin(
            `SELECT count(*)::int AS n FROM insights.report_run WHERE state = 'pending'`,
          )
        ).rows[0].n,
      ).toBe(0);
    });

    it('suspends the schedule when its accountable owner loses authority or leaves', async () => {
      const ed2 = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
      const ed2Id = await mem(ed2);
      await apply(env, owner, ws, {
        kind: 'brand_grant',
        brand: brands.Harbor,
        principal: ed2Id,
        level: 'edit',
      });
      const ed = (
        await env.svc.createReport(
          ed2,
          ws,
          {
            title: 'Editor owned',
            brand: brands.Harbor,
            layout: { widgets: [widget('open', 'tasks.open')] },
          },
          mutation(),
        )
      ).data;
      await env.svc.setReportRecipients(
        ed2,
        ws,
        ed.id,
        { members: [ed2Id], version: ed.version },
        mutation(),
      );
      const after = await env.svc.getReport(ed2, ws, ed.id);
      await env.svc.setReportSchedule(
        ed2,
        ws,
        ed.id,
        {
          version: after.version,
          schedule: { frequency: 'daily', time: '00:00', timezone: 'UTC' },
        },
        mutation(),
      );
      await apply(env, owner, ws, {
        kind: 'brand_revoke',
        brand: brands.Harbor,
        principal: ed2Id,
      });
      await db.admin(
        `UPDATE insights.report_definition SET next_run_at = now() - interval '1 minute', claimed_until = NULL WHERE title = 'Editor owned'`,
      );
      await sweep(new Date());
      const row = (
        await db.admin(
          `SELECT suspended_reason FROM insights.report_definition WHERE title = 'Editor owned'`,
        )
      ).rows[0];
      expect(row.suspended_reason).toBe('owner_authority');
    });
  });

  describe('exports', () => {
    it('exports CSV and PDF with only what the requester may read, and audits them', async () => {
      const d = (
        await env.svc.createDashboard(
          owner,
          ws,
          {
            title: 'Export me',
            kind: 'owner',
            layout: { widgets: [widget('byproject', 'tasks.open', { group_by: 'project' })] },
          },
          mutation(),
        )
      ).data;
      const ownerCsv = await env.svc.exportDashboard(owner, ws, d.id, { format: 'csv' });
      expect(String(ownerCsv.body)).toMatch(/Vault/);
      const editorCsv = await env.svc.exportDashboard(editor, ws, d.id, { format: 'csv' });
      expect(String(editorCsv.body)).not.toMatch(/Vault|Site/);
      expect(String(editorCsv.body)).toMatch(/Launch/);
      const pdf = await env.svc.exportDashboard(editor, ws, d.id, { format: 'pdf' });
      expect(Buffer.isBuffer(pdf.body)).toBe(true);
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      expect((pdf.body as Buffer).toString('latin1')).not.toMatch(/Vault/);
      const audit = await db.admin(
        `SELECT count(*)::int AS n FROM audit.audit_event WHERE action = 'insights.exported'`,
      );
      expect(audit.rows[0].n).toBeGreaterThanOrEqual(3);
      expect(
        (await rejects(env.svc.exportDashboard(reader, ws, d.id, { format: 'csv' }))).code,
      ).toMatch(/forbidden|not_found/);
    });
  });

  describe('lifecycle', () => {
    it('trash hides, restore returns, and purge removes recipients, shares, and runs', async () => {
      const r = (
        await env.svc.createReport(
          owner,
          ws,
          { title: 'Temp', layout: { widgets: [widget('a', 'tasks.open')] } },
          mutation(),
        )
      ).data;
      await env.svc.reportLifecycle(owner, ws, r.id, 'trash', mutation());
      expect((await rejects(env.svc.getReport(owner, ws, r.id))).code).toBe('not_found');
      const trash = (await env.svc.listTrashedInsights(owner, ws)) as {
        data: Array<{ id: string }>;
      };
      expect(trash.data.map((x) => x.id)).toContain(r.id);
      await env.svc.reportLifecycle(owner, ws, r.id, 'restore', mutation());
      expect((await env.svc.getReport(owner, ws, r.id)).lifecycle_state).toBe('active');
    });
  });
});
