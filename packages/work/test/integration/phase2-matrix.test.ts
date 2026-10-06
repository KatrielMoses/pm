import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measureClasses, statementShape } from '@pm/test-support';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import { recurrenceHandler, remindersHandler } from '@pm/work';
import {
  apply,
  join,
  membershipOf,
  mutation,
  seedAccount,
  workEnv,
  workspaceIdOf,
  WORKSPACE_INPUT,
  type WorkEnv,
} from './fixture.ts';

const ROLES = ['administrator', 'member', 'limited_member', 'read_only'] as const;
type Who = 'owner' | (typeof ROLES)[number] | 'share_only' | 'guest';
const PEOPLE: Who[] = [
  'owner',
  'administrator',
  'member',
  'limited_member',
  'read_only',
  'share_only',
  'guest',
];
type TaskKey = 'open' | 'restricted' | 'secret' | 'shared';
const UNKNOWN = 'tsk_00000000000000000000000000';
const soon = (h = 1) => new Date(Date.now() + h * 3_600_000).toISOString();

/**
 * Phase 2 integration matrix (exit gate): three workspaces, every role, a share-only member, a
 * guest, a sensitive brand, a restricted project, a hidden custom field, and a custom workflow.
 * Every Phase 2 surface that names a task — reads, lists, signals, duplicates, bulk previews,
 * reminders, history, fields, capture parsing, and triage destinations — agrees with the one
 * read decision, across workspaces too. Suspension and removal stop the person and their
 * background work; permission lost between preview and apply is refused at apply; hidden and
 * unknown data cost the same statements and time.
 */
describe('Phase 2 cross-surface authorization matrix', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  const W: Array<{
    ws: string;
    id: string;
    people: Record<Who, Caller>;
    brands: Record<'main' | 'secret', string>;
    restrictedProject: string;
    tasks: Record<TaskKey, string>;
    hiddenField: string;
    status: string;
  }> = [];
  const mem = async (w: (typeof W)[number], who: Caller) =>
    (await membershipOf(db, w.id, who.auth.account.id))!.public_id;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    for (const k of ['a', 'b', 'c']) {
      const o = await seedAccount(db);
      const created = await env.svc.createWorkspace(
        o,
        { ...WORKSPACE_INPUT, name: `Matrix ${k}`, first_brand: { name: `Main ${k}` } },
        mutation(),
      );
      const ws = created.data.workspace.id;
      const id = await workspaceIdOf(db, ws);
      const main = created.data.first_brand!.id;
      const secret = (await env.svc.createBrand(o, ws, { name: `Secret ${k}` }, mutation())).data
        .id;
      env.stepUp.allow = true;
      await env.svc.setSensitivity(
        o,
        ws,
        secret,
        { is_sensitive: true },
        mutation({ ifMatch: '"0"', stepUpToken: 't' }),
      );
      env.stepUp.allow = false;
      const people = { owner: o } as Record<Who, Caller>;
      for (const role of ROLES) people[role] = await join(env, db, o, ws, { kind: 'member', role });
      people.share_only = await join(env, db, o, ws, { kind: 'member', role: 'member' });
      const w = { ws, id, people, brands: { main, secret } } as (typeof W)[number];
      const grant = async (who: Who, level: string) =>
        apply(env, o, ws, {
          kind: 'brand_grant',
          brand: main,
          principal: await mem(w, people[who]),
          level,
        });
      await grant('member', 'edit');
      await grant('limited_member', 'view');
      await grant('read_only', 'view');
      await apply(env, o, ws, {
        kind: 'brand_grant',
        brand: secret,
        principal: await mem(w, o),
        level: 'manage',
      });
      // A custom workflow and a hidden field on the main brand (2C).
      const wf = (
        await env.svc.createWorkflow(
          o,
          ws,
          {
            scope: `brand:${main}`,
            record_kind: 'task',
            name: 'Studio',
            statuses: [
              { name: 'Queued', category: 'planned' },
              { name: 'Making', category: 'active' },
              { name: 'Shipped', category: 'done' },
            ],
          },
          mutation(),
        )
      ).data;
      const hidden = (
        await env.svc.createFieldDefinition(
          o,
          ws,
          {
            scope: `brand:${main}`,
            applies_to: ['task'],
            name: 'Margin',
            field_type: 'number',
            visibility: { read: 'min_level', read_min_level: 'manage' },
          },
          mutation(),
        )
      ).data;
      const prj = (
        await env.svc.createProject(o, ws, { brand: main, name: `Restricted ${k}` }, mutation())
      ).data;
      await env.svc.setAccess(
        o,
        ws,
        prj.id,
        { access_mode: 'restricted', allow_record_shares: false },
        mutation(),
      );
      const task = async (body: Record<string, unknown>) =>
        (await env.svc.createTask(o, ws, { title: `Quarterly report ${k}`, ...body }, mutation()))
          .data.id;
      const tasks: Record<TaskKey, string> = {
        open: await task({ brand: main }),
        restricted: await task({ project: prj.id }),
        secret: await task({ brand: secret }),
        shared: await task({ brand: main, title: `Shared brief ${k}` }),
      };
      const f = await env.svc.recordFields(o, ws, tasks.open);
      await env.svc.updateRecordFields(
        o,
        ws,
        tasks.open,
        { version: f.version, changes: { [hidden.id]: { value: '42.5' } } },
        mutation(),
      );
      await apply(env, o, ws, {
        kind: 'record_share',
        record: tasks.shared,
        grantee: await mem(w, people.share_only),
        level: 'edit',
      });
      people.guest = await join(env, db, o, ws, {
        kind: 'guest',
        records: [{ record: tasks.shared, level: 'comment' }],
      });
      Object.assign(w, {
        restrictedProject: prj.id,
        tasks,
        hiddenField: hidden.id,
        status: wf.statuses[1]!.id,
      });
      W.push(w);
    }
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  const ok = (p: Promise<unknown>) =>
    p.then(
      () => true,
      (e: { code?: string }) => {
        expect(['not_found', 'forbidden']).toContain(e.code);
        return false;
      },
    );

  it('every task surface agrees with the one read decision, per role and workspace', async () => {
    for (const w of W) {
      const readable = {} as Record<Who, Record<TaskKey, boolean>>;
      for (const who of PEOPLE) {
        const c = w.people[who];
        readable[who] = {} as Record<TaskKey, boolean>;
        for (const k of Object.keys(w.tasks) as TaskKey[])
          readable[who][k] = await ok(env.svc.getTask(c, w.ws, w.tasks[k]));
      }
      // The decisions themselves (AZ-21–AZ-25): no owner or administrator bypass on sensitive brands
      // or restricted projects; shares reach exactly one record.
      expect(readable.owner).toEqual({ open: true, restricted: true, secret: true, shared: true });
      expect(readable.administrator).toEqual({
        open: true,
        restricted: false,
        secret: false,
        shared: true,
      });
      for (const who of ['member', 'limited_member', 'read_only'] as const)
        expect(readable[who], who).toEqual({
          open: true,
          restricted: false,
          secret: false,
          shared: true,
        });
      for (const who of ['share_only', 'guest'] as const)
        expect(readable[who], who).toEqual({
          open: false,
          restricted: false,
          secret: false,
          shared: true,
        });

      for (const who of PEOPLE) {
        const c = w.people[who];
        const allowed = (Object.keys(w.tasks) as TaskKey[])
          .filter((k) => readable[who][k])
          .map((k) => w.tasks[k]);
        const all = Object.values(w.tasks);
        // Signals: exactly the readable tasks.
        const sig = await env.svc.listTaskSignals(c, w.ws, { tasks: [...all, UNKNOWN].join(',') });
        expect(sig.items.map((i) => i.task).sort(), `${who} signals`).toEqual([...allowed].sort());
        // Lists never include an unreadable task.
        if (who !== 'guest') {
          const listed = (await env.svc.listTasks(c, w.ws, { limit: '200' })).data.map((t) => t.id);
          for (const id of listed) expect(allowed, `${who} list`).toContain(id);
        }
        // Duplicate candidates are readable tasks only.
        const dup = await env.svc
          .duplicateCandidates(c, w.ws, {
            brand: w.brands.main,
            title: `quarterly report ${w.ws.slice(-1).toLowerCase()}`,
          })
          .catch(() => ({ candidates: [] as Array<{ id: string }> }));
        for (const d of dup.candidates) expect(allowed, `${who} duplicates`).toContain(d.id);
        // Bulk preview: unreadable and unknown are both not_found.
        const pv = await env.svc
          .previewBulk(
            c,
            w.ws,
            { operation: 'set_priority', params: { value: 'low' }, tasks: [...all, UNKNOWN] },
            mutation(),
          )
          .then((r) => r.data.items)
          .catch((e: { code?: string; issues?: Array<{ code: string }> }) => {
            expect(e.issues?.[0]?.code, who).toBe('nothing_to_apply');
            return all.concat(UNKNOWN).map((task) => ({ task, outcome: 'not_found' }));
          });
        for (const item of pv)
          expect(item.outcome === 'not_found', `${who} bulk ${item.task}`).toBe(
            !allowed.includes(item.task),
          );
        // Reminders and history follow the same decision.
        for (const k of Object.keys(w.tasks) as TaskKey[]) {
          const r = await ok(
            env.svc.createReminder(c, w.ws, w.tasks[k], { remind_at: soon(2) }, mutation()),
          );
          expect(r, `${who} reminder ${k}`).toBe(readable[who][k]);
          if (!readable[who][k])
            await expect(
              env.svc.taskHistory(c, w.ws, w.tasks[k], {}),
              `${who} history ${k}`,
            ).rejects.toEqual(expect.objectContaining({ code: 'not_found' }));
        }
        // The hidden field is absent for everyone below manage.
        if (readable[who].open) {
          const f = await env.svc
            .recordFields(c, w.ws, w.tasks.open)
            .catch(() => ({ fields: [] as Array<{ id: string }> }));
          const sees = f.fields.some((x) => x.id === w.hiddenField);
          expect(sees, `${who} hidden field`).toBe(who === 'owner' || who === 'administrator');
        }
        // Capture parsing resolves the restricted project only for those who can read it.
        const parsed = await env.svc.previewCapture(c, w.ws, {
          text: `Plan +"Restricted ${w.ws.slice(-1)}"`,
        });
        void parsed;
        // Triage into the restricted project: ready only where record.create is allowed there.
        const item = (await env.svc.capture(c, w.ws, { text: `triage probe ${who}` }, mutation()))
          .data.id;
        const tp = await env.svc.previewTriage(c, w.ws, {
          items: [item],
          to: 'task',
          brand: w.brands.main,
          project: w.restrictedProject,
        });
        expect(tp.items[0]!.outcome === 'ready', `${who} triage restricted`).toBe(who === 'owner');
      }
    }
  });

  it('capture parsing resolves a restricted project only for those who can read it', async () => {
    const w = W[0]!;
    const projectName = (await env.svc.getProject(w.people.owner, w.ws, w.restrictedProject)).name;
    for (const who of PEOPLE) {
      const r = await env.svc.previewCapture(w.people[who], w.ws, {
        text: `Plan +"${projectName}"`,
      });
      expect(r.candidates[0]!.detected[0]!.status, who).toBe(
        who === 'owner' ? 'resolved' : 'unresolved',
      );
    }
  });

  it('workspaces never cross: every surface returns not_found for another workspace’s records', async () => {
    const [a, b] = [W[0]!, W[1]!];
    const bo = b.people.owner;
    const it = (await env.svc.capture(a.people.owner, a.ws, { text: 'only in a' }, mutation())).data
      .id;
    for (const call of [
      () => env.svc.getTask(bo, b.ws, a.tasks.open),
      () => env.svc.taskSignals(bo, b.ws, a.tasks.open),
      () => env.svc.taskHistory(bo, b.ws, a.tasks.open, {}),
      () => env.svc.recordFields(bo, b.ws, a.tasks.open),
      () => env.svc.createReminder(bo, b.ws, a.tasks.open, { remind_at: soon() }, mutation()),
      () => env.svc.getInboxItem(bo, b.ws, it),
      () => env.svc.getProject(bo, b.ws, a.restrictedProject),
      () => env.svc.previewTransition(bo, b.ws, a.tasks.open, { to: a.status }),
    ])
      await expect(call()).rejects.toEqual(expect.objectContaining({ code: 'not_found' }));
    const sig = await env.svc.listTaskSignals(bo, b.ws, {
      tasks: Object.values(a.tasks).join(','),
    });
    expect(sig.items).toEqual([]);
  });

  it('suspension and removal stop the person and their background work (reminders cancel, series pause)', async () => {
    const w = W[2]!;
    const o = w.people.owner;
    const m = w.people.member;
    const admin = w.people.administrator;
    // The member's reminder is due; the administrator owns a daily task series.
    const r = (
      await env.svc.createReminder(m, w.ws, w.tasks.open, { remind_at: soon() }, mutation())
    ).data;
    await db.admin(
      `UPDATE planning.task_reminder SET remind_at = now() - interval '1 minute' WHERE public_id = $1`,
      [r.id],
    );
    const s = (
      await env.svc.defineTaskRecurrence(
        admin,
        w.ws,
        w.tasks.open,
        { frequency: 'daily', anchor_tz: 'UTC', start: '2026-01-01T09:00' },
        mutation(),
      )
    ).data;
    const mine = (await env.svc.capture(m, w.ws, { text: 'member private thought' }, mutation()))
      .data.id;
    // The series owner is suspended (removal would need the series reassigned first, PERM-014);
    // the reminder owner is removed.
    await apply(env, o, w.ws, { kind: 'suspend', member: await mem(w, admin) });
    await apply(env, o, w.ws, { kind: 'remove', member: await mem(w, m) });
    for (const who of [admin, m]) {
      await expect(env.svc.getTask(who, w.ws, w.tasks.open)).rejects.toBeDefined();
      await expect(env.svc.capture(who, w.ws, { text: 'x' }, mutation())).rejects.toBeDefined();
    }
    // Their personal records stay personal: nobody else, not even the owner, sees them.
    await expect(env.svc.getInboxItem(o, w.ws, mine)).rejects.toEqual(
      expect.objectContaining({ code: 'not_found' }),
    );
    // Background work rechecks freshness: the reminder is cancelled, the series pauses.
    const deps = {
      tenant: env.h.worker,
      discovery: env.h.discovery,
      metrics: env.h.telemetry.metrics,
      logger: env.h.logger,
    };
    await remindersHandler(deps).handle({} as never);
    await recurrenceHandler(deps).handle({} as never);
    const rs = await db.admin(`SELECT state FROM planning.task_reminder WHERE public_id = $1`, [
      r.id,
    ]);
    expect(rs.rows[0].state).toBe('cancelled');
    const ss = await db.admin(`SELECT state FROM planning.recurrence_series WHERE public_id = $1`, [
      s.id,
    ]);
    expect(ss.rows[0].state).toBe('paused');
    const made = await db.admin(
      `SELECT count(*)::int AS n FROM work.task t JOIN planning.recurrence_series s ON s.id = t.recurrence_series_id WHERE s.public_id = $1`,
      [s.id],
    );
    expect(made.rows[0].n).toBe(0);
  });

  it('permission lost between preview and apply is refused at apply on every two-step surface', async () => {
    const w = W[1]!;
    const o = w.people.owner;
    const lim = w.people.read_only;
    const m = w.people.member;
    const mm = await mem(w, m);
    // Bulk, triage, and template application all re-decide at apply.
    const pv = (
      await env.svc.previewBulk(
        m,
        w.ws,
        { operation: 'set_priority', params: { value: 'high' }, tasks: [w.tasks.open] },
        mutation(),
      )
    ).data;
    const item = (await env.svc.capture(m, w.ws, { text: 'file me later' }, mutation())).data.id;
    expect(
      (await env.svc.previewTriage(m, w.ws, { items: [item], to: 'task', brand: w.brands.main }))
        .items[0]!.outcome,
    ).toBe('ready');
    const tpl = (
      await env.svc.createTaskTemplate(
        o,
        w.ws,
        w.tasks.open,
        { name: 'Report', scope: 'workspace' },
        mutation(),
      )
    ).data;
    const tr = await env.svc.previewTransition(m, w.ws, w.tasks.open, { to: w.status });
    expect(tr.allowed).toBe(true);
    await apply(env, o, w.ws, { kind: 'brand_revoke', brand: w.brands.main, principal: mm });
    expect((await env.svc.executeBulk(m, w.ws, pv.id, mutation())).data.items[0]!.outcome).toBe(
      'not_found',
    );
    expect(
      (
        await env.svc.triage(
          m,
          w.ws,
          { items: [item], to: 'task', brand: w.brands.main },
          mutation(),
        )
      ).data.items[0]!.outcome,
    ).toBe('not_found');
    await expect(
      env.svc.applyTaskTemplate(m, w.ws, tpl.id, { brand: w.brands.main }, mutation()),
    ).rejects.toEqual(expect.objectContaining({ code: 'not_found' }));
    await expect(
      env.svc.applyTransition(
        m,
        w.ws,
        w.tasks.open,
        {
          to: w.status,
          version: (await env.svc.getTask(o, w.ws, w.tasks.open)).version,
          preview_token: tr.preview_token,
        },
        mutation(),
      ),
    ).rejects.toEqual(expect.objectContaining({ code: 'not_found' }));
    expect((await env.svc.getTask(o, w.ws, w.tasks.open)).priority).toBe('none');
    // A read-only person never had create rights: triage is forbidden at preview and apply.
    const ri = (await env.svc.capture(lim, w.ws, { text: 'read only idea' }, mutation())).data.id;
    expect(
      (await env.svc.previewTriage(lim, w.ws, { items: [ri], to: 'task', brand: w.brands.main }))
        .items[0]!.outcome,
    ).toBe('forbidden');
  });

  it('hidden and unknown records cost the same statements and time on the shared read surfaces', async () => {
    const w = W[0]!;
    const m = w.people.member;
    const spans = () => env.h.telemetry.spans!;
    const same = async (classes: Record<string, () => Promise<unknown>>) => {
      // One at a time: every probe resets the shared span exporter.
      const shapes: string[][] = [];
      for (const fn of Object.values(classes)) shapes.push(await statementShape(spans(), fn));
      for (const s of shapes.slice(1)) expect(s).toEqual(shapes[0]);
      const t = await measureClasses(classes);
      expect(t.maxDelta, JSON.stringify(t.medians)).toBeLessThanOrEqual(t.threshold);
    };
    await same({
      secret: () => env.svc.getTask(m, w.ws, w.tasks.secret),
      unknown: () => env.svc.getTask(m, w.ws, UNKNOWN),
    });
    await same({
      restricted: () => env.svc.taskSignals(m, w.ws, w.tasks.restricted),
      unknown: () => env.svc.taskSignals(m, w.ws, UNKNOWN),
    });
    await same({
      secretBrand: () =>
        env.svc.previewTriage(m, w.ws, {
          items: ['inb_00000000000000000000000000'],
          to: 'task',
          brand: w.brands.secret,
        }),
      unknownBrand: () =>
        env.svc.previewTriage(m, w.ws, {
          items: ['inb_00000000000000000000000000'],
          to: 'task',
          brand: 'br_00000000000000000000000000',
        }),
    });
  });
});
