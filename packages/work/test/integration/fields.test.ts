import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import { canonical, productLifecycleRegistry } from '@pm/work';
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

/**
 * Phase 2C custom fields on real PostgreSQL (ADR-0015 W10–W23): every type with validation,
 * currency and percentage precision, person and label eligibility, select options with
 * replacement, formulas (chains, cycles, depth, typed errors, read-only), field policy (hidden
 * fields and formulas over hidden inputs are absent everywhere), field sets with explicit
 * upgrades, the database value guard, conflicts, and the lossless canonical document.
 */
describe('custom fields (2C)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let limited: Caller;
  let ws: string;
  let wsId: string;
  let brands: Record<string, string>;
  const scope = () => `brand:${brands.Harbor}`;
  const field = (body: Record<string, unknown>) =>
    env.svc
      .createFieldDefinition(
        owner,
        ws,
        { scope: scope(), applies_to: ['task'], ...body },
        mutation(),
      )
      .then((r) => r.data);
  const task = (title: string) =>
    env.svc.createTask(owner, ws, { brand: brands.Harbor, title }, mutation()).then((r) => r.data);
  const fieldsOf = (id: string, as: Caller = owner) => env.svc.recordFields(as, ws, id);
  const set = async (id: string, changes: Record<string, unknown>, as: Caller = owner) => {
    const cur = await fieldsOf(id, as);
    return env.svc.updateRecordFields(
      as,
      ws,
      id,
      {
        version: cur.version,
        changes: Object.fromEntries(Object.entries(changes).map(([k, value]) => [k, { value }])),
      },
      mutation(),
    );
  };
  const valueOf = async (id: string, fld: string, as: Caller = owner) =>
    (await fieldsOf(id, as)).fields.find((f) => f.id === fld);

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
    wsId = await workspaceIdOf(db, ws);
    limited = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    const m = (await membershipOf(db, wsId, limited.auth.account.id))!;
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: m.public_id,
      level: 'edit',
    });
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('every type validates and normalizes; currency is minor units; references grant no access', async () => {
    const f = {
      text: await field({
        name: 'Code',
        field_type: 'text',
        config: { pattern: '[A-Z]{3}-\\d{2}' },
      }),
      number: await field({
        name: 'Points',
        field_type: 'number',
        config: { scale: 0, min: '0', max: '100' },
      }),
      money: await field({ name: 'Cost', field_type: 'currency', config: { currency: 'EUR' } }),
      pct: await field({ name: 'Done %', field_type: 'percentage', config: { scale: 1 } }),
      date: await field({ name: 'Launch', field_type: 'date' }),
      person: await field({ name: 'Reviewer', field_type: 'person' }),
      label: await field({ name: 'Theme', field_type: 'label' }),
      box: await field({ name: 'Signed off', field_type: 'checkbox' }),
      url: await field({ name: 'Spec', field_type: 'url' }),
      email: await field({ name: 'Contact', field_type: 'email' }),
    };
    const t = await task('Typed');
    const mem = (await membershipOf(db, wsId, limited.auth.account.id))!;
    const lbl = (
      await env.svc.createLabel(owner, ws, brands.Harbor, { name: 'Growth' }, mutation())
    ).data;
    const otherLbl = (
      await env.svc.createLabel(owner, ws, brands.Summit, { name: 'Elsewhere' }, mutation())
    ).data;
    await set(t.id, {
      [f.text.id]: 'ABC-12',
      [f.number.id]: '42',
      [f.money.id]: { amount: '12.50' },
      [f.pct.id]: '12.5',
      [f.date.id]: '2026-11-30',
      [f.person.id]: mem.public_id,
      [f.label.id]: lbl.id,
      [f.box.id]: true,
      [f.url.id]: 'https://Example.com/spec',
      [f.email.id]: 'Ada@Example.COM',
    });
    const got = await fieldsOf(t.id);
    const val = (id: string) => got.fields.find((x) => x.id === id)!.value;
    expect(val(f.money.id)).toEqual({ minor: '1250', currency: 'EUR', amount: '12.50' });
    expect(val(f.person.id)).toMatchObject({ id: mem.public_id });
    expect(val(f.label.id)).toMatchObject({ id: lbl.id, name: 'Growth' });
    expect(val(f.url.id)).toBe('https://example.com/spec');
    expect(val(f.email.id)).toBe('Ada@example.com');
    // Validation failures are pointer-addressed and nothing is written.
    const before = (await fieldsOf(t.id)).version;
    await expect(set(t.id, { [f.text.id]: 'abc', [f.number.id]: '101' })).rejects.toEqual(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'pattern_mismatch' }),
          expect.objectContaining({ code: 'too_large' }),
        ]),
      }),
    );
    await expect(set(t.id, { [f.money.id]: { amount: '1.005' } })).rejects.toEqual(
      issueOf('scale'),
    );
    await expect(set(t.id, { [f.money.id]: { minor: '1', currency: 'USD' } })).rejects.toEqual(
      issueOf('currency_mismatch'),
    );
    await expect(set(t.id, { [f.label.id]: otherLbl.id })).rejects.toEqual(issueOf('not_eligible'));
    await expect(set(t.id, { [f.url.id]: 'javascript:alert(1)' })).rejects.toEqual(
      issueOf('invalid'),
    );
    expect((await fieldsOf(t.id)).version).toBe(before);
    // The database refuses shapes the service would never write.
    await expect(
      db.admin(
        `UPDATE workflow.field_value SET value = '1.5'::jsonb WHERE definition_id = (SELECT id FROM workflow.field_definition WHERE public_id = '${f.money.id}')`,
      ),
    ).rejects.toThrow(/invalid currency/);
    // Naming someone in a person field gives them nothing.
    const outsider = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    const om = (await membershipOf(db, wsId, outsider.auth.account.id))!;
    await set(t.id, { [f.person.id]: om.public_id });
    await expect(env.svc.getTask(outsider, ws, t.id)).rejects.toEqual(reason('not_found'));
    // Stale base is a conflict, not a silent overwrite.
    const cur = await fieldsOf(t.id);
    await expect(
      env.svc.updateRecordFields(
        owner,
        ws,
        t.id,
        { version: cur.version, changes: { [f.number.id]: { base: '7', value: '8' } } },
        mutation(),
      ),
    ).rejects.toEqual(reason('conflict'));
  });

  it('select options keep identity; in-use removal needs a replacement', async () => {
    const sel = await field({ name: 'Tier', field_type: 'select' });
    let def = (
      await env.svc.addOption(
        owner,
        ws,
        sel.id,
        { label: 'Gold' },
        mutation({ ifMatch: `"${sel.version}"` }),
      )
    ).data;
    def = (
      await env.svc.addOption(
        owner,
        ws,
        sel.id,
        { label: 'Silver' },
        mutation({ ifMatch: `"${def.version}"` }),
      )
    ).data;
    const [gold, silver] = def.options.map((o) => o.id);
    const t = await task('Tiered');
    await set(t.id, { [sel.id]: gold });
    def = (
      await env.svc.updateOption(
        owner,
        ws,
        sel.id,
        gold,
        { label: 'Platinum' },
        mutation({ ifMatch: `"${def.version}"` }),
      )
    ).data;
    expect((await valueOf(t.id, sel.id))!.value).toMatchObject({ id: gold, label: 'Platinum' });
    await expect(
      env.svc.removeOption(owner, ws, sel.id, gold, {}, mutation({ ifMatch: `"${def.version}"` })),
    ).rejects.toEqual(issueOf('in_use'));
    const r = await env.svc.removeOption(
      owner,
      ws,
      sel.id,
      gold,
      { replace_with: silver },
      mutation({ ifMatch: `"${def.version}"` }),
    );
    expect(r.data).toMatchObject({ remaining: 0 });
    expect((await valueOf(t.id, sel.id))!.value).toMatchObject({ id: silver });
  });

  it('formulas: typed AST, chains recompute in the same transaction, cycles and depth refused, typed errors, read-only', async () => {
    const a = await field({ name: 'Hours', field_type: 'number', config: { scale: 1 } });
    const rate = await field({ name: 'Rate', field_type: 'currency', config: { currency: 'USD' } });
    const cost = await field({
      name: 'Cost estimate',
      field_type: 'formula',
      config: { source: `{${a.id}} * {${rate.id}}` },
    });
    expect(cost.formula).toMatchObject({
      result_type: 'number',
      depends_on: expect.arrayContaining([a.id, rate.id]),
    });
    const flag = await field({
      name: 'Expensive',
      field_type: 'formula',
      config: { source: `if({${cost.id}} > 1000, "yes", "no")` },
    });
    const ratio = await field({
      name: 'Per hour',
      field_type: 'formula',
      config: { source: `{${cost.id}} / {${a.id}}` },
    });
    const t = await task('Costed');
    expect((await valueOf(t.id, cost.id))!.error).toBe('missing');
    await set(t.id, { [a.id]: '10', [rate.id]: { amount: '150.00' } });
    expect((await valueOf(t.id, cost.id))!.value).toBe('1500');
    expect((await valueOf(t.id, flag.id))!.value).toBe('yes');
    await set(t.id, { [a.id]: '0' });
    expect((await valueOf(t.id, ratio.id))!.error).toBe('divide_by_zero');
    // Materialized in the same transaction (not only computed on read).
    const stored = await db.admin(
      `SELECT value, error_code FROM workflow.field_value v JOIN workflow.field_definition d ON d.id = v.definition_id WHERE d.public_id = '${ratio.id}'`,
    );
    expect(stored.rows[0]).toMatchObject({ error_code: 'divide_by_zero' });
    // Read-only, never code, no cycles.
    await expect(set(t.id, { [cost.id]: '1' })).rejects.toEqual(reason('forbidden'));
    await expect(
      field({ name: 'Bad', field_type: 'formula', config: { source: 'process.exit()' } }),
    ).rejects.toEqual(issueOf('formula_invalid'));
    await expect(
      env.svc.updateFieldDefinition(
        owner,
        ws,
        cost.id,
        { config: { source: `{${flag.id}} & "x"` } },
        mutation({ ifMatch: `"${cost.version}"` }),
      ),
    ).rejects.toEqual(issueOf('cycle'));
    // An edit bumps the formula version; reads compute the current result until the next write.
    const c2 = (
      await env.svc.updateFieldDefinition(
        owner,
        ws,
        cost.id,
        { config: { source: `{${a.id}} + {${rate.id}}` } },
        mutation({ ifMatch: `"${cost.version}"` }),
      )
    ).data;
    expect(c2.formula!.version).toBe(2);
    expect((await valueOf(t.id, cost.id))!.value).toBe('150');
    // Depth is bounded (FORMULA_DEPTH_MAX).
    const shallow = workEnv(db, { work: { formulaDepthMax: 1 } });
    await expect(
      shallow.svc.createFieldDefinition(
        owner,
        ws,
        {
          scope: scope(),
          applies_to: ['task'],
          name: 'Deep',
          field_type: 'formula',
          config: { source: `{${flag.id}} & "!"` },
        },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('depth_exceeded'));
    await shallow.h.close();
    // Explain lists inputs without values.
    const ex = await env.svc.explainFormula(owner, ws, t.id, cost.id);
    expect(ex).toMatchObject({
      result_type: 'number',
      inputs: expect.arrayContaining([expect.objectContaining({ id: a.id, has_value: true })]),
    });
  });

  it('field policy: hidden fields and formulas over hidden inputs are absent from payloads, errors, explanations, and exports', async () => {
    const secret = await field({
      name: 'Margin',
      field_type: 'number',
      visibility: { read: 'min_level', read_min_level: 'manage' },
    });
    const derived = await field({
      name: 'Margin x2',
      field_type: 'formula',
      config: { source: `{${secret.id}} * 2` },
    });
    const open = await field({ name: 'Notes', field_type: 'text' });
    const t = await task('Policy');
    await set(t.id, { [secret.id]: '30', [open.id]: 'hello' });
    const mine = (await fieldsOf(t.id, limited)).fields.map((f) => f.id);
    expect(mine).toContain(open.id);
    expect(mine).not.toContain(secret.id);
    expect(mine).not.toContain(derived.id);
    expect((await fieldsOf(t.id)).fields.map((f) => f.id)).toEqual(
      expect.arrayContaining([secret.id, derived.id]),
    );
    await expect(set(t.id, { [secret.id]: '1' }, limited)).rejects.toEqual(reason('not_found'));
    await expect(env.svc.explainFormula(limited, ws, t.id, derived.id)).rejects.toEqual(
      reason('not_found'),
    );
    const doc = await env.svc.exportFields(owner, ws, { scope: scope(), record: t.id });
    expect((doc.values as Array<{ field: string }>).map((x) => x.field)).toContain(secret.id);
    // Configuration needs fields.configure at the scope; an edit-level member has neither.
    await expect(env.svc.exportFields(limited, ws, { scope: scope() })).rejects.toEqual(
      reason('forbidden'),
    );
  });

  it('field sets attach a version; later versions never change records until an explicit upgrade', async () => {
    const extra = await field({ name: 'Severity', field_type: 'text', applicability: 'via_set' });
    const extra2 = await field({ name: 'Component', field_type: 'text', applicability: 'via_set' });
    const s = (
      await env.svc.createFieldSet(
        owner,
        ws,
        { scope: scope(), name: 'Bug', applies_to: ['task'], items: [{ field: extra.id }] },
        mutation(),
      )
    ).data;
    const t = await task('Bug 1');
    expect((await fieldsOf(t.id)).fields.map((f) => f.id)).not.toContain(extra.id);
    const v0 = (await fieldsOf(t.id)).version;
    await env.svc.applyFieldSet(owner, ws, t.id, { set: s.id, version: v0 }, mutation());
    expect((await fieldsOf(t.id)).fields.map((f) => f.id)).toContain(extra.id);
    await env.svc.updateFieldSet(
      owner,
      ws,
      s.id,
      { version: s.version, items: [{ field: extra2.id, presentation: 'advanced' }] },
      mutation(),
    );
    const after = await fieldsOf(t.id);
    expect(after.fields.map((f) => f.id)).toEqual(expect.arrayContaining([extra.id]));
    expect(after.fields.map((f) => f.id)).not.toContain(extra2.id);
    expect(after.field_sets[0]).toMatchObject({
      version: 1,
      current_version: 2,
      upgrade_available: true,
    });
    await set(t.id, { [extra.id]: 'High' });
    const pv = await env.svc.previewFieldSet(owner, ws, t.id, { set: s.id });
    expect(pv).toMatchObject({
      from_version: 1,
      to_version: 2,
      fields_added: [extra2.id],
      fields_removed: [extra.id],
      values_hidden: 1,
      values_deleted: 0,
    });
    await env.svc.applyFieldSet(
      owner,
      ws,
      t.id,
      { set: s.id, version: (await fieldsOf(t.id)).version },
      mutation(),
    );
    const up = await fieldsOf(t.id);
    expect(up.fields.find((f) => f.id === extra2.id)).toMatchObject({ presentation: 'advanced' });
    expect(up.fields.map((f) => f.id)).not.toContain(extra.id);
    // The hidden value still exists (never deleted).
    expect(
      (
        await db.admin(
          `SELECT count(*)::int AS n FROM workflow.field_value v JOIN workflow.field_definition d ON d.id = v.definition_id WHERE d.public_id = '${extra.id}'`,
        )
      ).rows[0],
    ).toMatchObject({ n: 1 });
  });

  it('values follow a cross-brand move (old-brand labels cannot) and are removed with a purge', async () => {
    const note = await env.svc
      .createFieldDefinition(
        owner,
        ws,
        { scope: 'workspace', applies_to: ['task'], name: 'Anywhere', field_type: 'text' },
        mutation(),
      )
      .then((r) => r.data);
    const theme = await env.svc
      .createFieldDefinition(
        owner,
        ws,
        { scope: 'workspace', applies_to: ['task'], name: 'Any theme', field_type: 'label' },
        mutation(),
      )
      .then((r) => r.data);
    const lbl = (
      await env.svc.createLabel(owner, ws, brands.Harbor, { name: 'Moving' }, mutation())
    ).data;
    const t = await task('Mover');
    await set(t.id, { [note.id]: 'kept', [theme.id]: lbl.id });
    const pv = await env.svc.previewTaskBrandMove(owner, ws, t.id, { brand: brands.Summit });
    await env.svc.moveTaskBrand(
      owner,
      ws,
      t.id,
      { brand: brands.Summit, preview_token: pv.preview_token },
      mutation(),
    );
    expect((await valueOf(t.id, note.id))!.value).toBe('kept');
    expect((await valueOf(t.id, theme.id))!.value).toBeNull();
    const roots = await db.admin(
      `SELECT DISTINCT v.brand_id = r.brand_id AS same FROM workflow.field_value v JOIN core.record r ON r.id = v.record_id WHERE r.public_id = $1`,
      [t.id],
    );
    expect(roots.rows).toEqual([{ same: true }]);
    await env.svc.taskLifecycle(owner, ws, t.id, 'trash', {}, mutation());
    // The purge command is authorized (record.purge at the brand) and queues the durable purge;
    // its content step runs the task adapter's hook as the worker, as below.
    await env.svc.taskLifecycle(owner, ws, t.id, 'purge', {}, mutation());
    const { id } = (await db.admin(`SELECT id FROM core.record WHERE public_id = $1`, [t.id]))
      .rows[0] as { id: string };
    await env.h.worker.withWorkspace(wsId, { module: 'test' }, async (tx) => {
      const hooks = productLifecycleRegistry().get('task')!.purge!;
      await hooks.deleteContent(tx, [id]);
    });
    const left = await db.admin(
      `SELECT count(*)::int AS n FROM workflow.field_value v JOIN core.record r ON r.id = v.record_id WHERE r.public_id = $1`,
      [t.id],
    );
    expect(left.rows[0]).toMatchObject({ n: 0 });
  });

  it('the canonical document round-trips losslessly and keeps unknown parts opaque', async () => {
    const doc = await env.svc.exportFields(owner, ws, { scope: scope() });
    const withFuture = {
      ...doc,
      definitions: [...(doc.definitions as unknown[]), { opaque: { type: 'hologram', depth: 3 } }],
      extensions: { from: 'future' },
    };
    const check = await env.svc.validateFieldDocument(owner, ws, withFuture);
    expect(check).toMatchObject({ valid: true, lossless: true, opaque_definitions: 1 });
    expect(canonical(check.document)).toBe(canonical(withFuture));
    await expect(env.svc.validateFieldDocument(owner, ws, { schema: 'nope' })).rejects.toEqual(
      reason('validation_failed'),
    );
  });
});
