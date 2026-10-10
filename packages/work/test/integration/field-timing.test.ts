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

/**
 * Hidden-field timing (2C corrective review 01, ADR-0015 W20). For each surface, requests that
 * differ only in what the viewer may not see must (1) run the same ordered database statements and
 * (2) stay in one timing class under the shared harness's documented threshold. Covered: a readable
 * record whose fields include hidden values vs one without; an unreadable record vs an unknown
 * identifier; a hidden formula vs a visible one vs an unknown field in explanations; hidden vs
 * visible required fields in transition previews; record serialization; the audit projection
 * (history); and the field-set upgrade preview's counts. Filters and sorts by custom field do not
 * exist before 3A (documented limitation).
 */
describe('hidden-field timing and statement shape (2C review 01)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let viewer: Caller;
  let admin: Caller;
  let ws: string;
  let brands: Record<string, string>;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
    const wsId = await workspaceIdOf(db, ws);
    viewer = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    const vm = (await membershipOf(db, wsId, viewer.auth.account.id))!;
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: vm.public_id,
      level: 'edit',
    });
    // An administrator who cannot read a sensitive brand's records (no explicit grant).
    admin = await join(env, db, owner, ws, { kind: 'member', role: 'administrator' });
    env.stepUp.allow = true;
    await env.svc.setSensitivity(
      owner,
      ws,
      brands.Summit,
      { is_sensitive: true },
      mutation({ ifMatch: '"0"', stepUpToken: 't' }),
    );
    env.stepUp.allow = false;
    const scope = `brand:${brands.Harbor}`;
    const def = (body: Record<string, unknown>) =>
      env.svc
        .createFieldDefinition(owner, ws, { scope, applies_to: ['task'], ...body }, mutation())
        .then((r) => r.data);
    const hidden = { read: 'min_level', read_min_level: 'manage' };
    const notes = await def({ name: 'Notes', field_type: 'text' });
    const margin = await def({ name: 'Margin', field_type: 'number', visibility: hidden });
    const lead = await def({ name: 'Lead', field_type: 'person', visibility: hidden });
    const tier = await def({ name: 'Tier', field_type: 'select', visibility: hidden });
    const tierDef = (
      await env.svc.addOption(
        owner,
        ws,
        tier.id,
        { label: 'Gold' },
        mutation({ ifMatch: `"${tier.version}"` }),
      )
    ).data;
    const secretF = await def({
      name: 'Margin x2',
      field_type: 'formula',
      config: { source: `{${margin.id}} * 2` },
    });
    const openF = await def({
      name: 'Notes length',
      field_type: 'formula',
      config: { source: `len({${notes.id}})` },
    });
    Object.assign(ids, {
      notes: notes.id,
      margin: margin.id,
      secretF: secretF.id,
      openF: openF.id,
    });
    const task = async (title: string, values: Record<string, unknown>) => {
      const t = (await env.svc.createTask(owner, ws, { brand: brands.Harbor, title }, mutation()))
        .data;
      const f = await env.svc.recordFields(owner, ws, t.id);
      await env.svc
        .updateRecordFields(
          owner,
          ws,
          t.id,
          {
            version: f.version,
            changes: Object.fromEntries(Object.entries(values).map(([k, value]) => [k, { value }])),
          },
          mutation(),
        )
        .catch((e) => {
          throw new Error(JSON.stringify(e.issues));
        });
      return t.id;
    };
    const om = (await membershipOf(db, wsId, owner.auth.account.id))!;
    ids.withHidden = await task('With hidden values', {
      [notes.id]: 'hello',
      [margin.id]: '30',
      [lead.id]: om.public_id,
      [tier.id]: tierDef.options[0]!.id,
    });
    ids.withoutHidden = await task('Without hidden values', { [notes.id]: 'hello' });
    ids.unreadable = (
      await env.svc.createTask(owner, ws, { brand: brands.Summit, title: 'Elsewhere' }, mutation())
    ).data.id;
    ids.unknown = 'tsk_00000000000000000000000000';
    // Workflow with a hidden and a visible required field (for preview/required-field errors).
    const wf = (
      await env.svc.createWorkflow(
        owner,
        ws,
        {
          scope,
          record_kind: 'task',
          name: 'Gated',
          statuses: [
            { name: 'Open', category: 'planned' },
            { name: 'A', category: 'active' },
            { name: 'B', category: 'paused' },
            { name: 'Done', category: 'done' },
          ],
        },
        mutation(),
      )
    ).data;
    const [open, a, b] = wf.statuses.map((s) => s.id) as [string, string, string, string];
    const w2 = (
      await env.svc.addTransition(
        owner,
        ws,
        wf.id,
        { transition: { from: open, to: a, requirements: [{ field: margin.id }] } },
        mutation({ ifMatch: `"${wf.version}"` }),
      )
    ).data;
    await env.svc.addTransition(
      owner,
      ws,
      wf.id,
      { transition: { from: open, to: b, requirements: [{ field: notes.id }] } },
      mutation({ ifMatch: `"${w2.version}"` }),
    );
    ids.gated = (
      await env.svc.createTask(owner, ws, { brand: brands.Harbor, title: 'Gated' }, mutation())
    ).data.id;
    Object.assign(ids, { toHidden: a, toVisible: b });
    // Field sets: one removing a hidden field with a value, one removing a visible field.
    const sh = (
      await env.svc.createFieldSet(
        owner,
        ws,
        { scope, name: 'S hidden', applies_to: ['task'], items: [{ field: margin.id }] },
        mutation(),
      )
    ).data;
    ids.setHidden = sh.id;
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
    expect(first![1].length, 'the requests reach the database').toBeGreaterThan(2);
    const t = await measureClasses(classes);
    expect(t.maxDelta, JSON.stringify(t.medians)).toBeLessThanOrEqual(t.threshold);
  }

  it('record fields: hidden values present vs absent, and unreadable vs unknown records, are one class each', async () => {
    const hiddenFields = (await env.svc.recordFields(viewer, ws, ids.withHidden!)).fields.map(
      (f) => f.id,
    );
    expect(hiddenFields).toContain(ids.notes);
    expect(hiddenFields).not.toContain(ids.margin);
    expect(hiddenFields).not.toContain(ids.secretF);
    await sameShapeAndTime({
      hiddenValues: () => env.svc.recordFields(viewer, ws, ids.withHidden!),
      noHiddenValues: () => env.svc.recordFields(viewer, ws, ids.withoutHidden!),
    });
    await expect(env.svc.recordFields(viewer, ws, ids.unreadable!)).rejects.toEqual(
      expect.objectContaining({ code: 'not_found' }),
    );
    await sameShapeAndTime({
      unreadable: () => env.svc.recordFields(viewer, ws, ids.unreadable!),
      unknown: () => env.svc.recordFields(viewer, ws, ids.unknown!),
    });
  });

  it('formula explanations: hidden formula, visible formula, and unknown field run the same work', async () => {
    await expect(env.svc.explainFormula(viewer, ws, ids.withHidden!, ids.secretF!)).rejects.toEqual(
      expect.objectContaining({ code: 'not_found' }),
    );
    expect((await env.svc.explainFormula(viewer, ws, ids.withHidden!, ids.openF!)).result).toBe(
      '5',
    );
    await sameShapeAndTime({
      hiddenFormula: () => env.svc.explainFormula(viewer, ws, ids.withHidden!, ids.secretF!),
      visibleFormula: () => env.svc.explainFormula(viewer, ws, ids.withHidden!, ids.openF!),
      unknownField: () =>
        env.svc.explainFormula(viewer, ws, ids.withHidden!, 'fld_00000000000000000000000000'),
    });
  });

  it('required-field errors: a hidden requirement is never named and costs the same as a visible one', async () => {
    const hiddenReq = await env.svc.previewTransition(viewer, ws, ids.gated!, { to: ids.toHidden });
    expect(hiddenReq.required_fields).toEqual([]);
    expect(hiddenReq.issues.map((i) => i.code)).toEqual(['requirements_unmet']);
    expect(JSON.stringify(hiddenReq)).not.toContain('Margin');
    const visibleReq = await env.svc.previewTransition(viewer, ws, ids.gated!, {
      to: ids.toVisible,
    });
    expect(visibleReq.required_fields).toEqual([
      expect.objectContaining({ label: 'Notes', satisfied: false }),
    ]);
    await sameShapeAndTime({
      hiddenRequirement: () =>
        env.svc.previewTransition(viewer, ws, ids.gated!, { to: ids.toHidden }),
      visibleRequirement: () =>
        env.svc.previewTransition(viewer, ws, ids.gated!, { to: ids.toVisible }),
    });
  });

  it('audit projection: history with hidden field changes vs without is one class and names no hidden field', async () => {
    const h = await env.svc.taskHistory(viewer, ws, ids.withHidden!);
    const all = JSON.stringify(h);
    expect(all).not.toContain(ids.margin!.toLowerCase());
    expect(all).toContain(ids.notes!.toLowerCase());
    await sameShapeAndTime({
      hiddenChanges: () => env.svc.taskHistory(viewer, ws, ids.withHidden!),
      visibleChanges: () => env.svc.taskHistory(viewer, ws, ids.withoutHidden!),
    });
  });

  it('serialization and counts: record export by a manager and the field-set preview count only readable fields', async () => {
    // An administrator exporting at workspace scope: a record in a sensitive brand they cannot
    // read costs the same as an unknown identifier (both not_found).
    await expect(
      env.svc.exportFields(admin, ws, { scope: 'workspace', record: ids.unreadable }),
    ).rejects.toEqual(expect.objectContaining({ code: 'not_found' }));
    await sameShapeAndTime({
      unreadable: () =>
        env.svc.exportFields(admin, ws, { scope: 'workspace', record: ids.unreadable }),
      unknown: () => env.svc.exportFields(admin, ws, { scope: 'workspace', record: ids.unknown }),
    });
    // The viewer previewing a set that would hide a hidden field's value sees no count or name.
    const pv = await env.svc.previewFieldSet(viewer, ws, ids.withHidden!, { set: ids.setHidden });
    expect(pv).toMatchObject({ fields_added: [], values_hidden: 0 });
    await sameShapeAndTime({
      hiddenValue: () =>
        env.svc.previewFieldSet(viewer, ws, ids.withHidden!, { set: ids.setHidden }),
      noValue: () =>
        env.svc.previewFieldSet(viewer, ws, ids.withoutHidden!, { set: ids.setHidden }),
    });
  });
});
