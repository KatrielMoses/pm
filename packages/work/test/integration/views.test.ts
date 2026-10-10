import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measureClasses, statementShape } from '@pm/test-support';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
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

type Row = Record<string, unknown> & { id: string };

/**
 * Phase 3A query and saved-view engine (ADR-0018): filter semantics against an oracle over the
 * seeded facts, keyset pagination over every sort shape, grouping, authorization before rows,
 * counts, groups, and metadata, constant shape for hidden values, cursor binding, saved-view
 * sharing and permissions, defaults, pins, version conflicts, and bounded exports.
 */
describe('Phase 3A query engine and saved views', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let ws: string;
  let wsId: string;
  let owner: Caller;
  let member: Caller;
  let limited: Caller;
  let guest: Caller;
  let other: Caller;
  const brands = {} as Record<'Alpha' | 'Beta' | 'Secret', string>;
  let restrictedPrj: string;
  let launchPrj: string;
  let milestone: string;
  const facts: Array<{
    id: string;
    brand: 'Alpha' | 'Beta' | 'Secret';
    priority: string;
    due: string | null;
    title: string;
    label: boolean;
    assignee: 'member' | 'owner' | null;
    project: 'launch' | 'restricted' | null;
  }> = [];
  let sharedTask: string;
  let memberId: string;
  let label: string;
  let numberField: string;
  let hiddenField: string;

  const all = async (who: Caller, query: Record<string, unknown>, limit = 200) => {
    const out: Row[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 100; i++) {
      const r = await env.svc.query(who, ws, 'task', {
        query: { entity: 'task', ...query },
        limit,
        ...(cursor ? { cursor } : {}),
      });
      out.push(...(r.data as Row[]));
      if (!r.page.has_more) break;
      cursor = r.page.next_cursor;
    }
    return out;
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db, { work: { exportRowsMax: 25 } });
    const w = await workspaceWith(env, db, ['Alpha', 'Beta', 'Secret']);
    ({ ws, owner } = w);
    Object.assign(brands, w.brands);
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
    member = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    limited = await join(env, db, owner, ws, { kind: 'member', role: 'limited_member' });
    other = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    memberId = (await membershipOf(db, wsId, member.auth.account.id))!.public_id;
    const mem = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Alpha,
      principal: memberId,
      level: 'edit',
    });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Alpha,
      principal: await mem(limited),
      level: 'view',
    });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Beta,
      principal: await mem(other),
      level: 'edit',
    });
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Secret,
      principal: await mem(owner),
      level: 'manage',
    });
    launchPrj = (
      await env.svc.createProject(owner, ws, { brand: brands.Alpha, name: 'Launch' }, mutation())
    ).data.id;
    restrictedPrj = (
      await env.svc.createProject(owner, ws, { brand: brands.Alpha, name: 'Vault' }, mutation())
    ).data.id;
    await env.svc.setAccess(
      owner,
      ws,
      restrictedPrj,
      { access_mode: 'restricted', allow_record_shares: false },
      mutation(),
    );
    await env.svc.createMilestone(
      owner,
      ws,
      launchPrj,
      { name: 'Beta release', due_date: '2026-12-01' },
      mutation(),
    );
    milestone = (
      await db.admin(
        `SELECT r.public_id FROM core.record r JOIN work.milestone m ON m.id = r.id WHERE m.name = 'Beta release'`,
      )
    ).rows[0].public_id;
    label = (
      await env.svc.createLabel(owner, ws, brands.Alpha, { name: 'Urgent copy' }, mutation())
    ).data.id;
    numberField = (
      await env.svc.createFieldDefinition(
        owner,
        ws,
        {
          scope: `brand:${brands.Alpha}`,
          applies_to: ['task'],
          name: 'Points',
          field_type: 'number',
        },
        mutation(),
      )
    ).data.id;
    hiddenField = (
      await env.svc.createFieldDefinition(
        owner,
        ws,
        {
          scope: `brand:${brands.Alpha}`,
          applies_to: ['task'],
          name: 'Margin',
          field_type: 'number',
          visibility: { read: 'min_level', read_min_level: 'manage' },
        },
        mutation(),
      )
    ).data.id;
    const prios = ['urgent', 'high', 'medium', 'low', 'none'];
    for (let i = 0; i < 24; i++) {
      const brand = i % 3 === 2 ? 'Beta' : 'Alpha';
      const project = brand === 'Alpha' && i % 4 === 0 ? 'launch' : null;
      const due = i % 5 === 4 ? null : `2026-11-${String(1 + (i % 7)).padStart(2, '0')}`;
      const title = `${['Draft', 'review', 'Ship', 'plan'][i % 4]} item ${String(i).padStart(2, '0')}`;
      const t = (
        await env.svc.createTask(
          owner,
          ws,
          {
            title,
            ...(project ? { project: launchPrj } : { brand: brands[brand] }),
            priority: prios[i % 5],
            ...(due ? { due_date: due } : {}),
          },
          mutation(),
        )
      ).data;
      const f = {
        id: t.id,
        brand: brand as 'Alpha' | 'Beta',
        priority: prios[i % 5]!,
        due,
        title,
        label: false,
        assignee: null as 'member' | 'owner' | null,
        project: project as 'launch' | null,
      };
      if (brand === 'Alpha' && i % 2 === 1) {
        await env.svc.addTaskLabel(owner, ws, t.id, { label }, mutation());
        f.label = true;
      }
      if (brand === 'Alpha' && i % 3 === 0) {
        const v = (await env.svc.getTask(owner, ws, t.id)).version;
        await env.svc.setAssignees(
          owner,
          ws,
          t.id,
          { assignees: [memberId], primary: memberId, version: v },
          mutation(),
        );
        f.assignee = 'member';
      }
      if (brand === 'Alpha' && i < 6) {
        const rf = await env.svc.recordFields(owner, ws, t.id);
        await env.svc.updateRecordFields(
          owner,
          ws,
          t.id,
          {
            version: rf.version,
            changes: { [numberField]: { value: String(i * 10) }, [hiddenField]: { value: '9' } },
          },
          mutation(),
        );
      }
      facts.push(f);
    }
    const secret = (
      await env.svc.createTask(
        owner,
        ws,
        { title: 'Secret plan', brand: brands.Secret, priority: 'urgent' },
        mutation(),
      )
    ).data.id;
    facts.push({
      id: secret,
      brand: 'Secret',
      priority: 'urgent',
      due: null,
      title: 'Secret plan',
      label: false,
      assignee: null,
      project: null,
    });
    const vault = (
      await env.svc.createTask(
        owner,
        ws,
        { title: 'Vault plan', project: restrictedPrj, priority: 'urgent' },
        mutation(),
      )
    ).data.id;
    facts.push({
      id: vault,
      brand: 'Alpha',
      priority: 'urgent',
      due: null,
      title: 'Vault plan',
      label: false,
      assignee: null,
      project: 'restricted',
    });
    sharedTask = (
      await env.svc.createTask(
        owner,
        ws,
        { title: 'Shared brief', brand: brands.Beta, priority: 'high' },
        mutation(),
      )
    ).data.id;
    facts.push({
      id: sharedTask,
      brand: 'Beta',
      priority: 'high',
      due: null,
      title: 'Shared brief',
      label: false,
      assignee: null,
      project: null,
    });
    guest = await join(env, db, owner, ws, {
      kind: 'guest',
      records: [{ record: sharedTask, level: 'comment' }],
    });
  }, 240_000);
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  /** What each person may read (the oracle mirrors the 0C decisions the matrix proves). */
  const readable = (who: 'owner' | 'member' | 'other' | 'guest') =>
    facts.filter((f) =>
      who === 'owner'
        ? true
        : who === 'member'
          ? f.brand === 'Alpha' && f.project !== 'restricted'
          : who === 'other'
            ? f.brand === 'Beta'
            : f.id === sharedTask,
    );
  const ids = (rows: Row[]) => rows.map((r) => r.id).sort();

  it('filters match the oracle: AND/OR groups, refs, enums, dates, multi-values, custom fields', async () => {
    const cases: Array<[Record<string, unknown>, (f: (typeof facts)[number]) => boolean]> = [
      [
        { op: 'and', items: [{ field: 'brand', op: 'in', value: [brands.Beta] }] },
        (f) => f.brand === 'Beta',
      ],
      [
        {
          op: 'or',
          items: [
            { field: 'priority', op: 'in', value: ['urgent'] },
            {
              op: 'and',
              items: [
                { field: 'brand', op: 'in', value: [brands.Beta] },
                { field: 'due_date', op: 'on_or_before', value: '2026-11-03' },
              ],
            },
          ],
        },
        (f) => f.priority === 'urgent' || (f.brand === 'Beta' && !!f.due && f.due <= '2026-11-03'),
      ],
      [{ op: 'and', items: [{ field: 'due_date', op: 'is_empty' }] }, (f) => f.due === null],
      [
        {
          op: 'and',
          items: [{ field: 'due_date', op: 'between', value: ['2026-11-02', '2026-11-04'] }],
        },
        (f) => !!f.due && f.due >= '2026-11-02' && f.due <= '2026-11-04',
      ],
      [{ op: 'and', items: [{ field: 'label', op: 'any_of', value: [label] }] }, (f) => f.label],
      [{ op: 'and', items: [{ field: 'label', op: 'none_of', value: [label] }] }, (f) => !f.label],
      [{ op: 'and', items: [{ field: 'assignee', op: 'any_of', value: ['me'] }] }, () => false],
      [
        { op: 'and', items: [{ field: 'owner', op: 'in', value: [memberId] }] },
        (f) => f.assignee === 'member',
      ],
      [{ op: 'and', items: [{ field: 'owner', op: 'is_empty' }] }, (f) => f.assignee === null],
      [
        { op: 'and', items: [{ field: 'project', op: 'in', value: [launchPrj] }] },
        (f) => f.project === 'launch',
      ],
      [
        { op: 'and', items: [{ field: 'milestone', op: 'any_of', value: [milestone] }] },
        (f) => f.project === 'launch',
      ],
      [
        { op: 'and', items: [{ field: 'title', op: 'contains', value: 'REVIEW' }] },
        (f) => /review/i.test(f.title),
      ],
      [{ op: 'and', items: [{ field: 'agent', op: 'is_empty' }] }, () => true],
      [{ op: 'and', items: [{ field: 'agent', op: 'is_not_empty' }] }, () => false],
      [
        { op: 'and', items: [{ field: `field:${numberField}`, op: 'gte', value: '20' }] },
        (f) => {
          const i = facts.indexOf(f);
          return f.brand === 'Alpha' && i < 6 && i * 10 >= 20;
        },
      ],
    ];
    for (const [filter, oracle] of cases) {
      const got = ids(await all(owner, { filter }));
      expect(got, JSON.stringify(filter)).toEqual(
        readable('owner')
          .filter(oracle)
          .map((f) => f.id)
          .sort(),
      );
    }
    // `me` is the caller.
    expect(
      ids(
        await all(member, {
          filter: { op: 'and', items: [{ field: 'assignee', op: 'any_of', value: ['me'] }] },
        }),
      ),
    ).toEqual(
      readable('member')
        .filter((f) => f.assignee === 'member')
        .map((f) => f.id)
        .sort(),
    );
  });

  it('keyset pages cover every row exactly once in the full order, for every sort shape', async () => {
    const sorts: Array<Array<{ field: string; dir: 'asc' | 'desc' }>> = [
      [],
      [{ field: 'due_date', dir: 'asc' }],
      [{ field: 'due_date', dir: 'desc' }],
      [
        { field: 'priority', dir: 'asc' },
        { field: 'title', dir: 'desc' },
      ],
      [
        { field: 'brand', dir: 'desc' },
        { field: 'due_date', dir: 'asc' },
        { field: 'owner', dir: 'asc' },
      ],
      [{ field: `field:${numberField}`, dir: 'desc' }],
      [{ field: 'status', dir: 'asc' }],
    ];
    for (const sort of sorts) {
      for (const group of [
        null,
        { field: 'priority' },
        { field: 'due_date', granularity: 'week' },
      ]) {
        const q = { sort, ...(group ? { group } : {}) };
        const full = (await all(owner, q, 200)).map((r) => r.id);
        const paged = (await all(owner, q, 4)).map((r) => r.id);
        expect(paged, JSON.stringify(q)).toEqual(full);
        expect(new Set(full).size).toBe(full.length);
        expect(full.length).toBe(facts.length);
      }
    }
    // Sorting is real: due dates ascend with empty dates last.
    const byDue = await all(owner, { sort: [{ field: 'due_date', dir: 'asc' }] });
    const dues = byDue.map((r) => facts.find((f) => f.id === r.id)!.due);
    const firstNull = dues.indexOf(null);
    expect(dues.slice(firstNull).every((d) => d === null)).toBe(true);
    expect([...dues.slice(0, firstNull)]).toEqual([...dues.slice(0, firstNull)].sort());
  });

  it('groups are counted with the same authorized predicate as the rows', async () => {
    for (const who of [owner, member] as const) {
      const r = await env.svc.query(who, ws, 'task', {
        query: { entity: 'task', group: { field: 'brand' } },
        include_total: true,
        limit: 200,
      });
      const sum = r.groups!.reduce((n, g) => n + g.count, 0);
      expect(sum).toBe(r.page.total!.value);
      expect(sum).toBe(r.data.length);
      for (const row of r.data) expect(r.groups!.map((g) => g.key)).toContain(row.group);
    }
    const m = await env.svc.query(member, ws, 'task', {
      query: { entity: 'task', group: { field: 'brand' } },
      include_total: true,
    });
    // The member reads only Alpha (and not the restricted project): no Beta or Secret group.
    expect(m.groups!.map((g) => g.label)).toEqual(['Alpha']);
    expect(m.page.total!.value).toBe(readable('member').length);
    const p = await env.svc.query(member, ws, 'task', {
      query: { entity: 'task', group: { field: 'project' } },
    });
    expect(p.groups!.map((g) => g.label).sort()).toEqual(['Launch', 'No project']);
  });

  it('rows, totals, groups, and exports never include what the viewer cannot read', async () => {
    for (const [who, c] of [
      ['member', member],
      ['other', other],
      ['guest', guest],
    ] as const) {
      const rows = await all(c, {});
      expect(ids(rows), who).toEqual(
        readable(who)
          .map((f) => f.id)
          .sort(),
      );
    }
    // Guests have no people fields (unsupported, like an unknown field).
    await expect(
      env.svc.query(guest, ws, 'task', {
        query: {
          entity: 'task',
          filter: { op: 'and', items: [{ field: 'owner', op: 'is_empty' }] },
        },
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'validation_failed' }));
    // A hidden field and an unknown field fail identically.
    const hidden = await env.svc
      .query(owner, ws, 'task', {
        query: { entity: 'task', sort: [{ field: `field:${hiddenField}` }] },
      })
      .catch((e: { issues: unknown }) => e.issues);
    const unknown = await env.svc
      .query(owner, ws, 'task', {
        query: { entity: 'task', sort: [{ field: 'field:fld_00000000000000000000000000' }] },
      })
      .catch((e: { issues: unknown }) => e.issues);
    expect(hidden).toEqual(unknown);
    // Export: the member's CSV holds the member's rows only (bounded by EXPORT_ROWS_MAX = 25).
    const csv = await env.svc.exportView(member, ws, 'task', {
      query: { entity: 'task' },
      presentation: { columns: ['title', 'brand', 'priority'] },
    });
    const lines = csv.body.trim().split('\r\n');
    expect(lines[0]).toBe('ID,Title,Brand,Priority');
    expect(lines.length - 1).toBe(readable('member').length);
    expect(csv.body).not.toContain('Secret plan');
    expect(csv.body).not.toContain('Vault plan');
    await expect(
      env.svc.exportView(owner, ws, 'task', { query: { entity: 'task' } }),
    ).rejects.toEqual(expect.objectContaining({ code: 'validation_failed' }));
    const audit = await db.admin(
      `SELECT count(*)::int AS n FROM audit.audit_event WHERE workspace_id = $1 AND action = 'views.exported'`,
      [wsId],
    );
    expect(audit.rows[0].n).toBe(1);
    const security = await db.admin(
      `SELECT count(*)::int AS n FROM audit.security_event WHERE workspace_id = $1 AND category = 'export'`,
      [wsId],
    );
    expect(security.rows[0].n).toBe(1);
  });

  it('hidden and unknown filter values run the same statements, take the same time, and match nothing', async () => {
    const spans = () => env.h.telemetry.spans!;
    const q = (brand: string) => () =>
      env.svc.query(member, ws, 'task', {
        query: {
          entity: 'task',
          filter: { op: 'and', items: [{ field: 'brand', op: 'in', value: [brand] }] },
        },
        include_total: true,
      });
    const hidden = await q(brands.Secret)();
    const unknown = await q('br_00000000000000000000000000')();
    expect(hidden.data).toEqual([]);
    expect(hidden).toEqual(unknown);
    const classes = {
      hidden: q(brands.Secret),
      unknown: q('br_00000000000000000000000000'),
      restricted: () =>
        env.svc.query(member, ws, 'task', {
          query: {
            entity: 'task',
            filter: { op: 'and', items: [{ field: 'project', op: 'in', value: [restrictedPrj] }] },
          },
          include_total: true,
        }),
    };
    const shapes: string[][] = [];
    for (const fn of Object.values(classes)) shapes.push(await statementShape(spans(), fn));
    for (const s of shapes.slice(1)) expect(s).toEqual(shapes[0]);
    const t = await measureClasses(classes);
    expect(t.maxDelta, JSON.stringify(t.medians)).toBeLessThanOrEqual(t.threshold);
  });

  it('cursors are bound to the workspace, the person, and the query; tampering is refused', async () => {
    const r = await env.svc.query(owner, ws, 'task', { query: { entity: 'task' }, limit: 2 });
    const cursor = r.page.next_cursor!;
    await expect(
      env.svc.query(member, ws, 'task', { query: { entity: 'task' }, limit: 2, cursor }),
    ).rejects.toEqual(expect.objectContaining({ code: 'cursor_invalid' }));
    await expect(
      env.svc.query(owner, ws, 'task', {
        query: { entity: 'task', sort: [{ field: 'title' }] },
        limit: 2,
        cursor,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'cursor_invalid' }));
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { p: string; m: string };
    const forged = Buffer.from(
      JSON.stringify({
        ...raw,
        p: raw.p.replace(/"i":"[^"]+"/, '"i":"00000000-0000-7000-8000-000000000000"'),
      }),
    ).toString('base64url');
    await expect(
      env.svc.query(owner, ws, 'task', { query: { entity: 'task' }, limit: 2, cursor: forged }),
    ).rejects.toEqual(expect.objectContaining({ code: 'cursor_invalid' }));
  });

  it('validates the AST: bounds, unknown keys, operators, values, and depth', async () => {
    const bad = async (query: Record<string, unknown>) =>
      env.svc.query(owner, ws, 'task', { query: { entity: 'task', ...query } }).then(
        () => null,
        (e: { code: string; issues: Array<{ code: string }> }) => e.issues.map((i) => i.code),
      );
    expect(await bad({ nope: 1 })).toContain('unknown_key');
    expect(await bad({ filter: { op: 'xor', items: [] } })).toContain('invalid');
    expect(
      await bad({
        filter: { op: 'and', items: [{ field: 'priority', op: 'contains', value: 'x' }] },
      }),
    ).toContain('invalid');
    expect(
      await bad({
        filter: {
          op: 'and',
          items: [{ field: 'brand', op: 'in', value: ['prj_00000000000000000000000000'] }],
        },
      }),
    ).toContain('invalid');
    expect(await bad({ sort: [{ field: 'label' }] })).toContain('unsupported_field');
    let nested: Record<string, unknown> = { field: 'priority', op: 'is_empty' };
    for (let i = 0; i < 5; i++) nested = { op: 'and', items: [nested] };
    expect(await bad({ filter: nested })).toContain('too_deep');
    expect(
      await bad({
        filter: {
          op: 'or',
          items: Array.from({ length: 41 }, () => ({ field: 'priority', op: 'is_empty' })),
        },
      }),
    ).toContain('too_many');
  });

  it('projects: owner, health, milestone, parent, and target date', async () => {
    const r = await env.svc.query(owner, ws, 'project', {
      query: {
        entity: 'project',
        filter: { op: 'and', items: [{ field: 'milestone', op: 'is_not_empty' }] },
      },
      presentation: { columns: ['name', 'owner', 'milestone', 'health'] },
    });
    expect(r.data.map((x) => x.id)).toEqual([launchPrj]);
    expect(r.data[0]!.milestone).toEqual(
      expect.objectContaining({ id: milestone, name: 'Beta release' }),
    );
    // The member cannot read the restricted project: it is absent from every project query.
    const m = await env.svc.query(member, ws, 'project', { query: { entity: 'project' } });
    expect(m.data.map((x) => x.id)).not.toContain(restrictedPrj);
  });

  it('saved views: personal, shared exactly, never widened, revocable, versioned', async () => {
    const created = await env.svc.createView(
      member,
      ws,
      {
        name: 'Urgent Alpha',
        query: {
          entity: 'task',
          filter: {
            op: 'and',
            items: [{ field: 'priority', op: 'in', value: ['urgent', 'high'] }],
          },
          sort: [{ field: 'due_date', dir: 'asc' }],
        },
        presentation: { columns: ['title', 'priority', 'due_date'], density: 'compact' },
      },
      mutation(),
    );
    const v = created.data.id;
    expect(created.data.visibility).toBe('personal');
    // Personal: invisible (not_found) to everyone else, owner and administrator included.
    for (const c of [owner, other, limited, guest])
      await expect(env.svc.getView(c, ws, v)).rejects.toEqual(
        expect.objectContaining({ code: 'not_found' }),
      );
    // A limited member cannot share (view.share needs edit at the scope).
    const lim = await env.svc.createView(
      limited,
      ws,
      { name: 'Mine', query: { entity: 'task' } },
      mutation(),
    );
    await expect(
      env.svc.shareView(
        limited,
        ws,
        lim.data.id,
        { scope: 'brand', brand: brands.Alpha, version: 0 },
        mutation(),
      ),
    ).rejects.toEqual(expect.objectContaining({ code: 'forbidden' }));
    // Share with Alpha: readers of Alpha see it; Beta-only people do not.
    await env.svc.shareView(
      member,
      ws,
      v,
      { scope: 'brand', brand: brands.Alpha, version: 0 },
      mutation(),
    );
    expect((await env.svc.getView(limited, ws, v)).name).toBe('Urgent Alpha');
    await expect(env.svc.getView(other, ws, v)).rejects.toEqual(
      expect.objectContaining({ code: 'not_found' }),
    );
    // Running the shared definition gives each viewer only their own readable rows.
    const def = (await env.svc.getView(owner, ws, v)).query;
    const asOwner = await env.svc.query(owner, ws, 'task', { query: def, limit: 200 });
    const asMember = await env.svc.query(member, ws, 'task', { query: def, limit: 200 });
    expect(asOwner.data.map((x) => x.id)).toContain(
      facts.find((f) => f.title === 'Secret plan')!.id,
    );
    for (const row of asMember.data) expect(readable('member').map((f) => f.id)).toContain(row.id);
    // Concurrent edits: the second writer with a stale version gets a conflict.
    const [a, b] = await Promise.allSettled([
      env.svc.updateView(member, ws, v, { name: 'A', version: 1 }, mutation()),
      env.svc.updateView(owner, ws, v, { name: 'B', version: 1 }, mutation()),
    ]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    const rej = [a, b].find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(rej.reason.code).toBe('conflict');
    await expect(env.svc.updateView(member, ws, v, { name: 'C' }, mutation())).rejects.toEqual(
      expect.objectContaining({ code: 'precondition_required' }),
    );
    // Unshare: back to personal; readers lose it at once.
    const cur = (await env.svc.getView(member, ws, v)).version;
    await env.svc.unshareView(member, ws, v, { version: cur }, mutation());
    await expect(env.svc.getView(limited, ws, v)).rejects.toEqual(
      expect.objectContaining({ code: 'not_found' }),
    );
    // Delete through the lifecycle: gone for the owner too.
    await env.svc.deleteView(member, ws, v, mutation());
    await expect(env.svc.getView(member, ws, v)).rejects.toEqual(
      expect.objectContaining({ code: 'not_found' }),
    );
    const state = await db.admin(`SELECT lifecycle_state FROM core.record WHERE public_id = $1`, [
      v,
    ]);
    expect(state.rows[0].lifecycle_state).toBe('trashed');
  });

  it('defaults resolve the person, then the project, then the brand; pins need a shared view', async () => {
    const mk = async (c: Caller, name: string) =>
      (await env.svc.createView(c, ws, { name, query: { entity: 'task' } }, mutation())).data.id;
    const brandView = await mk(owner, 'Alpha board');
    await expect(
      env.svc.setDefault(
        owner,
        ws,
        { target: 'brand', brand: brands.Alpha, entity: 'task', view: brandView },
        mutation(),
      ),
    ).rejects.toEqual(expect.objectContaining({ code: 'validation_failed' }));
    await env.svc.shareView(
      owner,
      ws,
      brandView,
      { scope: 'brand', brand: brands.Alpha, version: 0 },
      mutation(),
    );
    await env.svc.setDefault(
      owner,
      ws,
      { target: 'brand', brand: brands.Alpha, entity: 'task', view: brandView },
      mutation(),
    );
    // A member without views.configure (grant:manage) cannot set a brand default.
    await expect(
      env.svc.setDefault(
        member,
        ws,
        { target: 'brand', brand: brands.Alpha, entity: 'task', view: brandView },
        mutation(),
      ),
    ).rejects.toEqual(expect.objectContaining({ code: 'forbidden' }));
    let d = await env.svc.defaultView(member, ws, { entity: 'task', brand: brands.Alpha });
    expect(d.effective).toEqual(expect.objectContaining({ id: brandView, source: 'brand' }));
    const mine = await mk(member, 'My list');
    await env.svc.setDefault(member, ws, { target: 'me', entity: 'task', view: mine }, mutation());
    d = await env.svc.defaultView(member, ws, { entity: 'task', brand: brands.Alpha });
    expect(d.effective).toEqual(expect.objectContaining({ id: mine, source: 'member' }));
    // Someone who cannot read Alpha never sees the brand default.
    const o = await env.svc.defaultView(other, ws, { entity: 'task' });
    expect(o.effective).toBeNull();
    // Pins: shared at the pin scope, views.configure there; readers see it, others do not.
    await expect(
      env.svc.pinView(owner, ws, mine, { scope: 'brand', brand: brands.Alpha }, mutation()),
    ).rejects.toEqual(expect.objectContaining({ code: 'not_found' }));
    await env.svc.pinView(
      owner,
      ws,
      brandView,
      { scope: 'brand', brand: brands.Alpha },
      mutation(),
    );
    expect((await env.svc.listPins(member, ws)).map((t) => t.id)).toContain(brandView);
    expect((await env.svc.listPins(other, ws)).map((t) => t.id)).not.toContain(brandView);
    await expect(
      env.svc.pinView(member, ws, brandView, { scope: 'workspace' }, mutation()),
    ).rejects.toEqual(expect.objectContaining({ code: 'forbidden' }));
    // Unsharing removes the pin and the brand default with it.
    const v = (await env.svc.getView(owner, ws, brandView)).version;
    await env.svc.unshareView(owner, ws, brandView, { version: v }, mutation());
    expect((await env.svc.listPins(owner, ws)).map((t) => t.id)).not.toContain(brandView);
    d = await env.svc.defaultView(limited, ws, { entity: 'task', brand: brands.Alpha });
    expect(d.effective).toBeNull();
  });

  it('every catalog field compiles with every operator, and the rows plan is bounded and indexed', async () => {
    const { CATALOG, OPERATORS } = await import('@pm/work');
    type Explain = (c: Caller, w: string, e: string, b: unknown) => Promise<unknown>;
    const explain = (env.svc as unknown as { explainQuery: Explain }).explainQuery.bind(env.svc);
    const sample: Record<string, unknown> = {
      ref: undefined,
      multi: undefined,
      enum: undefined,
      date: '2026-11-03',
      number: '5',
      text: 'plan',
      bool: undefined,
    };
    const refValue: Record<string, string> = {
      brand: brands.Alpha,
      project: launchPrj,
      member: 'me',
      label,
      milestone,
      status: 'todo',
      agent: 'agt_00000000000000000000000000',
    };
    let compiled = 0;
    for (const entity of ['task', 'project'] as const) {
      for (const [field, spec] of Object.entries(CATALOG[entity])) {
        if (!spec.filterable) continue;
        for (const op of OPERATORS[spec.kind]) {
          const empty = ['is_empty', 'is_not_empty', 'is_true', 'is_false'].includes(op);
          const value = empty
            ? undefined
            : spec.kind === 'enum'
              ? [spec.values![0]]
              : spec.kind === 'ref' || spec.kind === 'multi'
                ? [refValue[spec.ref ?? 'project']]
                : op === 'between'
                  ? [sample[spec.kind], sample[spec.kind]]
                  : sample[spec.kind];
          if (spec.kind === 'multi' && (op === 'in' || op === 'not_in')) continue;
          const query = {
            entity,
            filter: {
              op: 'and',
              items: [{ field, op, ...(value !== undefined ? { value } : {}) }],
            },
            ...(spec.sortable ? { sort: [{ field, dir: 'desc' }] } : {}),
            ...(spec.groupable ? { group: { field } } : {}),
          };
          const plan = await explain(owner, ws, entity, { query });
          expect(JSON.stringify(plan), `${entity}.${field} ${op}`).toContain('"Node Type":"Limit"');
          compiled++;
        }
      }
    }
    expect(compiled).toBeGreaterThan(150);
    // With sequential scans disabled the rows statement reaches tasks through their indexes:
    // nothing in the compiled SQL defeats the workspace and record-type indexes.
    const plan = JSON.stringify(
      await explain(owner, ws, 'task', {
        query: {
          entity: 'task',
          filter: { op: 'and', items: [{ field: 'brand', op: 'in', value: [brands.Alpha] }] },
          sort: [{ field: 'due_date', dir: 'asc' }],
        },
        no_seqscan: true,
      }),
    );
    expect(plan).toMatch(/Index (Only )?Scan|Bitmap Index Scan/);
    expect(plan).not.toMatch(
      /"Node Type":"Seq Scan","Parent Relationship":"[A-Za-z]+","Parallel Aware":false,"Async Capable":false,"Relation Name":"task"/,
    );
  });
});
