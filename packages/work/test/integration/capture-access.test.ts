import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@pm/db';
import { measureClasses, statementShape } from '@pm/test-support';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
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

const reason = (code: string) => expect.objectContaining({ code });
const ROLES = ['administrator', 'member', 'limited_member', 'read_only'] as const;
type Who = 'owner' | (typeof ROLES)[number] | 'guest';

/**
 * Phase 2E authority, privacy, concurrency, and plans (0C AZ-25, T-43, AT-138–AT-145): three
 * workspaces, every role and a guest, a sensitive brand and a restricted project. Inbox items and
 * notes are visible to their owner only; parsing never reveals hidden names; triage decides
 * record.create at the destination; intake forms are members-only; idempotent capture and
 * contended triage and merge keep one outcome; the daily Inbox stays indexed.
 */
describe('capture authority, privacy, concurrency, and plans (2E)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  const W: Array<{
    ws: string;
    id: string;
    people: Record<Who, Caller>;
    brands: Record<string, string>;
    restricted: string;
  }> = [];
  const mem = async (i: number, who: Caller) =>
    (await membershipOf(db, W[i]!.id, who.auth.account.id))!.public_id;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    for (const k of ['a', 'b', 'c']) {
      const o = await seedAccount(db);
      const created = await env.svc.createWorkspace(
        o,
        { ...WORKSPACE_INPUT, name: `C ${k}`, first_brand: { name: `Main ${k}` } },
        mutation(),
      );
      const ws = created.data.workspace.id;
      const brands: Record<string, string> = { main: created.data.first_brand!.id };
      brands.secret = (
        await env.svc.createBrand(o, ws, { name: `Secret ${k}` }, mutation())
      ).data.id;
      env.stepUp.allow = true;
      await env.svc.setSensitivity(
        o,
        ws,
        brands.secret,
        { is_sensitive: true },
        mutation({ ifMatch: '"0"', stepUpToken: 't' }),
      );
      env.stepUp.allow = false;
      const people = { owner: o } as Record<Who, Caller>;
      for (const role of ROLES) people[role] = await join(env, db, o, ws, { kind: 'member', role });
      const id = await workspaceIdOf(db, ws);
      for (const role of ['member', 'limited_member', 'read_only'] as const)
        await apply(env, o, ws, {
          kind: 'brand_grant',
          brand: brands.main,
          principal: (await membershipOf(db, id, people[role].auth.account.id))!.public_id,
          level: role === 'read_only' ? 'view' : role === 'limited_member' ? 'view' : 'edit',
        });
      const prj = (
        await env.svc.createProject(
          o,
          ws,
          { brand: brands.main, name: `Hidden project ${k}` },
          mutation(),
        )
      ).data;
      await env.svc.setAccess(
        o,
        ws,
        prj.id,
        { access_mode: 'restricted', allow_record_shares: false },
        mutation(),
      );
      const shared = (
        await env.svc.createTask(o, ws, { brand: brands.main, title: `Shared ${k}` }, mutation())
      ).data.id;
      people.guest = await join(env, db, o, ws, {
        kind: 'guest',
        records: [{ record: shared, level: 'comment' }],
      });
      W.push({ ws, id, people, brands, restricted: prj.id });
    }
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  const spans = () => env.h.telemetry.spans!;
  async function sameShapeAndTime(classes: Record<string, () => Promise<unknown>>) {
    const shapes = new Map<string, string[]>();
    for (const [name, fn] of Object.entries(classes))
      shapes.set(name, await statementShape(spans(), fn));
    const [first, ...rest] = [...shapes.entries()];
    for (const [name, shape] of rest) expect(shape, `${name} vs ${first![0]}`).toEqual(first![1]);
    expect(first![1].length).toBeGreaterThan(2);
    const t = await measureClasses(classes);
    expect(t.maxDelta, JSON.stringify(t.medians)).toBeLessThanOrEqual(t.threshold);
  }

  it('every role and the guest capture into their own Inbox; nobody else sees it, not even owners (AT-138)', async () => {
    const w = W[0]!;
    const ids: Record<string, string> = {};
    for (const who of [
      'owner',
      'administrator',
      'member',
      'limited_member',
      'read_only',
      'guest',
    ] as const)
      ids[who] = (
        await env.svc.capture(w.people[who], w.ws, { text: `mine ${who}` }, mutation())
      ).data.id;
    for (const who of Object.keys(ids) as Who[]) {
      const list = (await env.svc.listInbox(w.people[who], w.ws, {})).data.map((x) => x.id);
      expect(list, who).toEqual([ids[who]]);
      for (const other of Object.keys(ids) as Who[])
        if (other !== who) {
          await expect(
            env.svc.getInboxItem(w.people[who], w.ws, ids[other]!),
            `${who} → ${other}`,
          ).rejects.toEqual(reason('not_found'));
          await expect(
            env.svc
              .triage(w.people[who], w.ws, { items: [ids[other]!], to: 'discard' }, mutation())
              .then((r) => r.data.items[0]),
          ).resolves.toMatchObject({ outcome: 'not_found' });
        }
    }
    // Merging someone else's item is refused (AT-142).
    await expect(
      env.svc.merge(
        w.people.administrator,
        w.ws,
        { items: [ids.administrator!, ids.member!] },
        mutation(),
      ),
    ).rejects.toEqual(reason('not_found'));
    // Another workspace sees nothing either.
    await expect(env.svc.getInboxItem(W[1]!.people.owner, W[1]!.ws, ids.owner!)).rejects.toEqual(
      reason('not_found'),
    );
    // Someone else's item and an unknown one cost the same statements and time.
    const unknown = 'inb_00000000000000000000000000';
    await sameShapeAndTime({
      others: () => env.svc.getInboxItem(w.people.member, w.ws, ids.owner!),
      unknown: () => env.svc.getInboxItem(w.people.member, w.ws, unknown),
    });
  });

  it('parsing resolves only readable brands and projects; hidden and unknown names are identical (AT-139)', async () => {
    const w = W[1]!;
    const m = w.people.member;
    const hidden = await env.svc.previewCapture(m, w.ws, {
      text: `Plan +"Hidden project b" brand:"Secret b"`,
    });
    const unknown = await env.svc.previewCapture(m, w.ws, {
      text: `Plan +"Nothing here" brand:"No such"`,
    });
    const strip = (r: typeof hidden) =>
      r.candidates[0]!.detected.map((d) => ({ field: d.field, status: d.status, value: d.value }));
    expect(strip(hidden)).toEqual(strip(unknown));
    expect(strip(hidden).every((d) => d.status === 'unresolved')).toBe(true);
    const owner = await env.svc.previewCapture(w.people.owner, w.ws, {
      text: `Plan +"Hidden project b"`,
    });
    expect(owner.candidates[0]!.detected[0]!.status).toBe('resolved');
    await sameShapeAndTime({
      hidden: () =>
        env.svc.previewCapture(m, w.ws, { text: `Plan +"Hidden project b" brand:"Secret b"` }),
      unknown: () =>
        env.svc.previewCapture(m, w.ws, { text: `Plan +"Nothing here" brand:"No such"` }),
    });
  });

  it('triage decides record.create at the destination at preview and apply (AT-140, AT-141)', async () => {
    const w = W[2]!;
    for (const [who, expected] of [
      ['owner', 'ready'],
      ['administrator', 'ready'],
      ['member', 'ready'],
      ['limited_member', 'forbidden'],
      ['read_only', 'forbidden'],
    ] as const) {
      const c = w.people[who];
      const it = (await env.svc.capture(c, w.ws, { text: `work for ${who}` }, mutation())).data.id;
      const pv = await env.svc.previewTriage(c, w.ws, {
        items: [it],
        to: 'task',
        brand: w.brands.main,
      });
      expect(pv.items[0]!.outcome, who).toBe(expected);
      const ap = (
        await env.svc.triage(c, w.ws, { items: [it], to: 'task', brand: w.brands.main }, mutation())
      ).data.items[0]!;
      expect(ap.outcome, who).toBe(expected === 'ready' ? 'applied' : 'forbidden');
      // Notes and discards stay personal and always work.
      if (expected !== 'ready')
        expect(
          (await env.svc.triage(c, w.ws, { items: [it], to: 'note' }, mutation())).data.items[0]!
            .outcome,
        ).toBe('applied');
    }
    // A restricted project or sensitive brand without access is not_found, like an unknown one.
    const m = w.people.member;
    const it = (await env.svc.capture(m, w.ws, { text: 'sneaky' }, mutation())).data.id;
    for (const target of [
      { brand: w.brands.main, project: w.restricted },
      { brand: w.brands.secret },
      { brand: 'br_00000000000000000000000000' },
    ])
      expect(
        (await env.svc.previewTriage(m, w.ws, { items: [it], to: 'task', ...target })).items[0]!
          .outcome,
      ).toBe('not_found');
    // Permission lost between preview and apply: refused at apply.
    const it2 = (await env.svc.capture(m, w.ws, { text: 'later' }, mutation())).data.id;
    expect(
      (await env.svc.previewTriage(m, w.ws, { items: [it2], to: 'task', brand: w.brands.main }))
        .items[0]!.outcome,
    ).toBe('ready');
    await apply(env, w.people.owner, w.ws, {
      kind: 'brand_revoke',
      brand: w.brands.main,
      principal: await mem(2, m),
    });
    const late = (
      await env.svc.triage(m, w.ws, { items: [it2], to: 'task', brand: w.brands.main }, mutation())
    ).data.items[0]!;
    expect(late.outcome).toBe('not_found');
    expect((await env.svc.getInboxItem(m, w.ws, it2)).triage_state).toBe('untriaged');
  });

  it('intake forms: guests and non-readers cannot submit; members without manage cannot configure (AT-143–AT-145)', async () => {
    const w = W[0]!;
    const f = (
      await env.svc.createForm(
        w.people.owner,
        w.ws,
        { brand: w.brands.main, name: 'Requests' },
        mutation(),
      )
    ).data;
    const s = (
      await env.svc.createForm(
        w.people.owner,
        w.ws,
        { brand: w.brands.secret, name: 'Secret requests' },
        mutation(),
      )
    ).data;
    await expect(
      env.svc.submitForm(w.people.guest, w.ws, f.id, { title: 'x' }, mutation()),
    ).rejects.toEqual(reason('not_found'));
    await expect(
      env.svc.submitForm(w.people.member, w.ws, s.id, { title: 'x' }, mutation()),
    ).rejects.toEqual(reason('not_found'));
    await expect(
      env.svc.submitForm(
        w.people.member,
        w.ws,
        'form_00000000000000000000000000',
        { title: 'x' },
        mutation(),
      ),
    ).rejects.toEqual(reason('not_found'));
    for (const who of ['member', 'limited_member', 'read_only'] as const)
      await expect(
        env.svc.createForm(w.people[who], w.ws, { brand: w.brands.main, name: 'No' }, mutation()),
        who,
      ).rejects.toEqual(
        expect.objectContaining({ code: expect.stringMatching(/forbidden|not_found/) }),
      );
    for (const who of ['member', 'limited_member', 'read_only'] as const)
      expect(
        (await env.svc.submitForm(w.people[who], w.ws, f.id, { title: `from ${who}` }, mutation()))
          .data.received,
      ).toBe(true);
    await sameShapeAndTime({
      hidden: () => env.svc.getForm(w.people.member, w.ws, s.id).catch(() => undefined),
      unknown: () =>
        env.svc
          .getForm(w.people.member, w.ws, 'form_00000000000000000000000000')
          .catch(() => undefined),
    });
  });

  it('idempotency and concurrency: a replayed capture saves once; contended triage and merge keep one outcome', async () => {
    const w = W[1]!;
    const o = w.people.owner;
    const req = mutation();
    const a = await env.svc.capture(o, w.ws, { text: 'once only' }, req);
    const b = await env.svc.capture(o, w.ws, { text: 'once only' }, req);
    expect(b.replayed).toBe(true);
    expect(b.data.id).toBe(a.data.id);
    expect(
      (await env.svc.listInbox(o, w.ws, {})).data.filter((x) => x.raw_text === 'once only'),
    ).toHaveLength(1);
    const it = (await env.svc.capture(o, w.ws, { text: 'race me' }, mutation())).data.id;
    const results = await Promise.allSettled([
      env.svc.triage(o, w.ws, { items: [it], to: 'task', brand: w.brands.main }, mutation()),
      env.svc.triage(o, w.ws, { items: [it], to: 'note' }, mutation()),
    ]);
    const outcomes = results.map((r) =>
      r.status === 'fulfilled' ? r.value.data.items[0]!.outcome : 'rejected',
    );
    expect(outcomes.filter((x) => x === 'applied')).toHaveLength(1);
    const conv = await db.admin(
      `SELECT count(*)::int AS n FROM capture.capture_conversion c JOIN core.record r ON r.id = c.source_record_id WHERE r.public_id = $1`,
      [it],
    );
    expect(conv.rows[0].n).toBe(1);
    const x = (await env.svc.capture(o, w.ws, { text: 'm1' }, mutation())).data.id;
    const y = (await env.svc.capture(o, w.ws, { text: 'm2' }, mutation())).data.id;
    const z = (await env.svc.capture(o, w.ws, { text: 'm3' }, mutation())).data.id;
    const both = await Promise.allSettled([
      env.svc.merge(o, w.ws, { items: [x, y], keep: x }, mutation()),
      env.svc.merge(o, w.ws, { items: [y, z], keep: z }, mutation()),
    ]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const states = await Promise.all([x, y, z].map((id) => env.svc.getInboxItem(o, w.ws, id)));
    expect(states.filter((s) => s.triage_state === 'merged')).toHaveLength(1);
  });

  it('direct app_rw isolation for capture tables and the daily Inbox plan at 20,000 items', async () => {
    const pool = new pg.Pool({ connectionString: db.app, max: 1 });
    try {
      for (const t of [
        'capture.inbox_item',
        'capture.note',
        'capture.capture_conversion',
        'capture.intake_form',
        'capture.intake_submission',
      ]) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
          await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [W[0]!.id]);
          const ws = (await c.query(`SELECT DISTINCT workspace_id FROM ${t}`)).rows.map(
            (r) => r.workspace_id,
          );
          expect(
            ws.every((x) => x === W[0]!.id),
            t,
          ).toBe(true);
          await c.query('COMMIT');
        } finally {
          c.release();
        }
      }
    } finally {
      await pool.end();
    }
    const w = W[2]!;
    const ownerMem = (await membershipOf(db, w.id, w.people.owner.auth.account.id))!;
    await db.admin(
      `BEGIN; SET LOCAL session_replication_role = replica;
       CREATE TEMP TABLE vol ON COMMIT DROP AS SELECT uuidv7() AS id, i FROM generate_series(1, 20000) AS i;
       INSERT INTO core.record (id, public_id, record_type, workspace_id, source_kind, created_by_actor_type)
         SELECT id, 'inb_4' || lpad(i::text, 25, '0'), 'inbox_item', '${w.id}', 'ui', 'system' FROM vol;
       INSERT INTO capture.inbox_item (id, workspace_id, scope_key, owner_membership_id, raw_text, source_kind, correlation_id, parse_version, triage_state, triaged_at)
         SELECT id, '${w.id}', '${w.id}', '${ownerMem.id}', 'item ' || i, 'typed', uuidv7(), 1,
                CASE WHEN i % 4 = 0 THEN 'untriaged' ELSE 'discarded' END, CASE WHEN i % 4 = 0 THEN NULL ELSE now() END FROM vol;
       COMMIT;`,
    );
    await db.admin(`ANALYZE capture.inbox_item, core.record`);
    const plan = await env.h.app.withWorkspace(w.id, { module: 'test' }, async (tx) => {
      await sql`SET LOCAL enable_seqscan = off`.execute(tx.db);
      const r = await tx.db.executeQuery({
        sql: `EXPLAIN (FORMAT JSON) SELECT id FROM capture.inbox_item WHERE workspace_id = $1 AND owner_membership_id = $2 AND triage_state = 'untriaged' ORDER BY created_at DESC, id DESC LIMIT 50`,
        parameters: [w.id, ownerMem.id],
        query: { kind: 'RawNode' },
      } as never);
      return JSON.stringify((r as { rows: unknown[] }).rows);
    });
    expect(plan).toMatch(/inbox_item_by_owner/);
    const started = performance.now();
    const page = await env.svc.listInbox(w.people.owner, w.ws, {});
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(page.data).toHaveLength(50);
    expect(page.page.has_more).toBe(true);
  });
});
