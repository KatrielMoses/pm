import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import type { WorkerRuntime } from '@pm/platform';
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
import { automationWorker, runsOf, settle, stepsOf, wakeDelays } from './automation-support.ts';

const v = (n: number) => mutation({ ifMatch: `"${n}"` });
const code = (c: string) => expect.objectContaining({ code: c });
const issueOf = (c: string) =>
  expect.objectContaining({
    issues: expect.arrayContaining([expect.objectContaining({ code: c })]),
  });

const ROLES = ['administrator', 'member', 'limited_member', 'read_only'] as const;
type Who = 'owner' | (typeof ROLES)[number] | 'manager' | 'limited_manager' | 'guest' | 'shared';

const created = (brand: string) => ({
  schema_version: 1,
  trigger: { kind: 'record.created', record: 'task' },
  conditions: null,
  steps: [
    { id: 'up', type: 'action', action: 'task.update', params: { fields: { priority: 'high' } } },
  ],
  scope: brand,
});

/**
 * Phase 8A authority (0C §9.4, AZ-51) across three workspaces, every role, a guest, a narrower
 * shared user, sensitive brands, and access changes at activation, during a delay, on retry, and
 * in history. The configurer and the trigger author never lend authority; the owner's current
 * authority, narrowed to the declared scope, decides every step.
 */
describe('automations (8A): authority, isolation, and revocation', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let worker: WorkerRuntime;
  const W: Array<{
    ws: string;
    id: string;
    people: Record<Who, Caller>;
    brands: Record<string, string>;
  }> = [];

  const define = (def: ReturnType<typeof created>) => {
    const { scope: _scope, ...definition } = def;
    return definition;
  };
  const create = (as: Caller, ws: string, brand: string, def = created(brand), name = 'Rule') =>
    env.svc.createAutomation(
      as,
      ws,
      { name, scope: { kind: 'brand', brand }, definition: define(def) },
      mutation(),
    );
  const activate = async (as: Caller, ws: string, id: string) => {
    const a = await env.svc.getAutomation(as, ws, id);
    return env.svc.activateAutomation(as, ws, id, {}, v(a.version));
  };
  const mem = async (i: number, who: Who) =>
    (await membershipOf(db, W[i]!.id, W[i]!.people[who].auth.account.id))!.public_id;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    for (const k of ['a', 'b', 'c']) {
      const { owner: o, ws, brands } = await workspaceWith(env, db, [`Main ${k}`]);
      const b: Record<string, string> = { main: brands[`Main ${k}`]! };
      b.secret = (await env.svc.createBrand(o, ws, { name: `Secret ${k}` }, mutation())).data.id;
      env.stepUp.allow = true;
      await env.svc.setSensitivity(
        o,
        ws,
        b.secret,
        { is_sensitive: true },
        mutation({ ifMatch: '"0"', stepUpToken: 't' }),
      );
      env.stepUp.allow = false;
      const people = { owner: o } as Record<Who, Caller>;
      for (const role of ROLES) people[role] = await join(env, db, o, ws, { kind: 'member', role });
      people.manager = await join(env, db, o, ws, { kind: 'member', role: 'member' });
      people.limited_manager = await join(env, db, o, ws, {
        kind: 'member',
        role: 'limited_member',
      });
      people.shared = await join(env, db, o, ws, { kind: 'member', role: 'member' });
      W.push({ ws, id: await workspaceIdOf(db, ws), people, brands: b });
      const i = W.length - 1;
      for (const who of ['manager', 'limited_manager'] as const)
        await apply(env, o, ws, {
          kind: 'brand_grant',
          brand: b.main,
          principal: await mem(i, who),
          level: 'manage',
        });
      const t = (
        await env.svc.createTask(o, ws, { brand: b.main, title: `Shared ${k}` }, mutation())
      ).data;
      await env.svc
        .createShare(
          o,
          ws,
          { record: t.id, principal: await mem(i, 'shared'), level: 'edit' },
          mutation(),
        )
        .catch(() => undefined);
      people.guest = await join(env, db, o, ws, {
        kind: 'guest',
        records: [{ record: t.id, level: 'edit' }],
      });
    }
    worker = await automationWorker(env);
  });
  afterAll(async () => {
    await worker.stop();
    await env.h.close();
    await db.drop();
  });

  it('AT-556 every role and guest: only configurers of a brand create, see, and activate its automations', async () => {
    const { ws, people, brands } = W[0]!;
    const can: Record<string, boolean> = {};
    for (const who of [
      'owner',
      'administrator',
      'member',
      'limited_member',
      'read_only',
      'manager',
      'limited_manager',
      'shared',
    ] as const) {
      try {
        const a = (await create(people[who], ws, brands.main!)).data;
        await activate(people[who], ws, a.id);
        can[who] = true;
      } catch (err) {
        can[who] = false;
        expect(err).toEqual(
          expect.objectContaining({
            code: expect.stringMatching(/^(validation_failed|forbidden|not_found)$/),
          }),
        );
      }
    }
    expect(can).toEqual({
      owner: true,
      administrator: true,
      member: false,
      limited_member: false,
      read_only: false,
      manager: true,
      limited_manager: true,
      // A record share is never configuration authority.
      shared: false,
    });
    // Guests have no automation surface at all; a listed automation is not_found to them.
    const any = (await env.svc.listAutomations(people.owner, ws)).data[0]!;
    await expect(env.svc.listAutomations(people.guest, ws)).rejects.toEqual(code('not_found'));
    await expect(env.svc.getAutomation(people.guest, ws, any.id)).rejects.toEqual(
      code('not_found'),
    );
    // Read-only and plain members neither see nor run them; the owner's list sees all.
    expect((await env.svc.listAutomations(people.read_only, ws)).data).toEqual([]);
    await expect(env.svc.getAutomation(people.member, ws, any.id)).rejects.toEqual(
      code('not_found'),
    );
    await expect(
      env.svc.runAutomationNow(people.member, ws, any.id, {}, mutation()),
    ).rejects.toEqual(code('not_found'));
    // Sensitive brands need an explicit grant: the administrator cannot configure there.
    await expect(create(people.administrator, ws, brands.secret!)).rejects.toEqual(
      issueOf('invalid_reference'),
    );
    const secret = (
      await create(people.owner, ws, brands.secret!, created(brands.secret!), 'Secret rule')
    ).data;
    await expect(env.svc.getAutomation(people.administrator, ws, secret.id)).rejects.toEqual(
      code('not_found'),
    );
  });

  it('AT-557 three workspaces are isolated: triggers, lists, runs, and identifiers never cross', async () => {
    const [a, b, c] = W as [(typeof W)[0], (typeof W)[0], (typeof W)[0]];
    const ra = (
      await create(a.people.owner, a.ws, a.brands.main!, created(a.brands.main!), 'A only')
    ).data;
    await activate(a.people.owner, a.ws, ra.id);
    const before = (await runsOf(db, ra.id)).length;
    await env.svc.createTask(
      b.people.owner,
      b.ws,
      { brand: b.brands.main, title: 'In b' },
      mutation(),
    );
    await env.svc.createTask(
      c.people.owner,
      c.ws,
      { brand: c.brands.main, title: 'In c' },
      mutation(),
    );
    await settle(db, worker);
    expect((await runsOf(db, ra.id)).length).toBe(before);
    // Another workspace's identifiers are unknown, even to its owner.
    await expect(env.svc.getAutomation(b.people.owner, b.ws, ra.id)).rejects.toEqual(
      code('not_found'),
    );
    expect(
      (await env.svc.listAutomations(c.people.owner, c.ws)).data.map((x) => x.id),
    ).not.toContain(ra.id);
    await env.svc.createTask(
      a.people.owner,
      a.ws,
      { brand: a.brands.main, title: 'In a' },
      mutation(),
    );
    await settle(db, worker);
    const runs = await runsOf(db, ra.id);
    expect(runs.length).toBe(before + 1);
    await expect(
      env.svc.getAutomationRun(b.people.owner, b.ws, runs.at(-1)!.op_public_id),
    ).rejects.toEqual(code('not_found'));
    await env.svc.disableAutomation(a.people.owner, a.ws, ra.id, mutation());
  });

  it('AT-558 revocation between preview and activation, before a delayed step, and on retry', async () => {
    const { ws, id, people, brands } = W[1]!;
    const owner = people.owner;
    const m = people.manager;
    for (const a of (await env.svc.listAutomations(owner, ws)).data)
      if (a.enabled) await env.svc.disableAutomation(owner, ws, a.id, mutation());
    const def = {
      schema_version: 1,
      trigger: { kind: 'record.created', record: 'task' },
      conditions: null,
      steps: [
        { id: 'wait', type: 'delay', minutes: 5 },
        {
          id: 'up',
          type: 'action',
          action: 'task.update',
          params: { fields: { priority: 'urgent' } },
        },
      ],
    };
    const a = (
      await env.svc.createAutomation(
        m,
        ws,
        { name: 'Delayed', scope: { kind: 'brand', brand: brands.main }, definition: def },
        mutation(),
      )
    ).data;
    const sample = (
      await env.svc.createTask(owner, ws, { brand: brands.main, title: 'Sample' }, mutation())
    ).data;
    const preview = await env.svc.previewAutomation(m, ws, a.id, { record: sample.id });
    expect(preview.steps.map((s) => [s.node, s.outcome])).toEqual([
      ['wait', 'would_wait'],
      ['up', 'would_run'],
    ]);
    // Revoked after the preview: activation re-checks and refuses; the preview is not authority.
    await apply(env, owner, ws, {
      kind: 'brand_revoke',
      brand: brands.main,
      principal: await mem(1, 'manager'),
    });
    await expect(activate(m, ws, a.id)).rejects.toEqual(code('not_found'));
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.main,
      principal: await mem(1, 'manager'),
      level: 'manage',
    });
    const activation = v((await env.svc.getAutomation(m, ws, a.id)).version);
    await env.svc.activateAutomation(m, ws, a.id, {}, activation);
    // While access holds, the same key is a replay of the completed activation (nothing new).
    expect((await env.svc.activateAutomation(m, ws, a.id, {}, activation)).replayed).toBe(true);
    const t = (
      await env.svc.createTask(owner, ws, { brand: brands.main, title: 'Trigger' }, mutation())
    ).data;
    await settle(db, worker);
    expect((await runsOf(db, a.id)).map((r) => [r.status, r.reason])).toEqual([
      ['waiting', 'delay'],
    ]);
    // Revoked while the run waits: the wake re-checks, refuses, and suspends without acting.
    await apply(env, owner, ws, {
      kind: 'brand_revoke',
      brand: brands.main,
      principal: await mem(1, 'manager'),
    });
    // A completed activation key replayed after the loss renders through current access: opaque.
    await expect(env.svc.activateAutomation(m, ws, a.id, {}, activation)).rejects.toEqual(
      code('not_found'),
    );
    await wakeDelays(db);
    await settle(db, worker);
    const [run] = await runsOf(db, a.id);
    expect({
      status: run!.status,
      reason: run!.reason,
      op: run!.execution_state,
      terminal: run!.terminal_reason,
    }).toEqual({
      status: 'policy_rejected',
      reason: 'owner_authority',
      op: 'failed',
      terminal: 'policy_rejected',
    });
    expect(((await env.svc.getTask(owner, ws, t.id)) as { priority: string }).priority).toBe(
      'none',
    );
    const view = await env.svc.getAutomation(owner, ws, a.id);
    expect(view).toMatchObject({
      state: 'suspended',
      suspended_reason: 'owner_authority',
      enabled: false,
    });
    // The former configurer no longer sees it (no disclosure); the workspace owner does.
    await expect(env.svc.getAutomation(m, ws, a.id)).rejects.toEqual(code('not_found'));
    // Retry re-authorizes: with authority still gone, a reactivation is refused; restored, the
    // run's retry passes the delay and acts, as the owner it was pinned to.
    await expect(
      env.svc.retryAutomationRun(owner, ws, run!.op_public_id, mutation()),
    ).rejects.toEqual(issueOf('automation_disabled'));
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.main,
      principal: await mem(1, 'manager'),
      level: 'manage',
    });
    await activate(m, ws, a.id);
    const retried = await env.svc.retryAutomationRun(owner, ws, run!.op_public_id, mutation());
    expect(retried.data).toMatchObject({ status: 'queued', retries: 1 });
    await settle(db, worker);
    await wakeDelays(db);
    await settle(db, worker);
    const [again] = await runsOf(db, a.id).then((r) => r.filter((x) => x.id === run!.id));
    expect({ status: again!.status, op: again!.execution_state }).toEqual({
      status: 'succeeded',
      op: 'succeeded',
    });
    // The link from before the retry still opens the run, now showing its current attempt.
    expect(await env.svc.getAutomationRun(owner, ws, run!.op_public_id)).toMatchObject({
      id: again!.op_public_id,
      status: 'succeeded',
      retries: 1,
    });
    // The delay that already completed in the first attempt was not waited twice.
    expect(
      (await stepsOf(db, run!.id as string))
        .filter((s) => s.node_id === 'wait')
        .map((s) => s.state),
    ).toEqual(['succeeded']);
    expect(((await env.svc.getTask(owner, ws, t.id)) as { priority: string }).priority).toBe(
      'urgent',
    );
    void id;
  });

  it('AT-559 history renders through current access; owner departure suspends without disclosure', async () => {
    const { ws, id, people, brands } = W[2]!;
    const owner = people.owner;
    const m = people.limited_manager;
    const a = (
      await env.svc.createAutomation(
        m,
        ws,
        {
          name: 'Leaver',
          scope: { kind: 'brand', brand: brands.main },
          definition: define(created(brands.main!)),
        },
        mutation(),
      )
    ).data;
    await activate(m, ws, a.id);
    const t = (
      await env.svc.createTask(
        owner,
        ws,
        { brand: brands.main, title: 'Visible then restricted' },
        mutation(),
      )
    ).data;
    await settle(db, worker);
    const [run] = await runsOf(db, a.id);
    const seen = await env.svc.getAutomationRun(owner, ws, run!.op_public_id);
    expect(seen.trigger.record).toEqual({ id: t.id, type: 'task' });
    expect(seen.steps.find((s) => s.node === 'up')).toMatchObject({
      state: 'succeeded',
      targets: [{ id: t.id, type: 'task' }],
    });
    // The record is trashed: history keeps the run but no longer names the record to anyone.
    await env.svc.taskLifecycle(owner, ws, t.id, 'trash', {}, mutation());
    const later = await env.svc.getAutomationRun(owner, ws, run!.op_public_id);
    expect(later.trigger.record).toBeNull();
    expect(later.steps.find((s) => s.node === 'up')!.targets).toEqual([]);
    // Decisions never carry values (bounded pointers and results only).
    expect(JSON.stringify(later)).not.toContain('Visible then restricted');
    // The 6D export (DATA-013, 8A portion) is the same current view, and empty for a member who
    // neither configures nor watches the brand.
    const exported = await env.svc.exportPortabilityHistory(owner, ws, 'automation_history', {});
    expect(exported.rows).toBe((await runsOf(db, a.id)).length);
    expect(exported.csv).toContain(run!.op_public_id);
    expect(exported.csv).not.toContain(t.id);
    expect(exported.csv).not.toContain('Visible then restricted');
    const none = await env.svc.exportPortabilityHistory(
      people.member,
      ws,
      'automation_history',
      {},
    );
    expect(none.rows).toBe(0);
    // The owner leaves: the automation is suspended (owner_departed) and stops listening.
    const leaving = (await membershipOf(db, id, m.auth.account.id))!;
    const ownerM = (await membershipOf(db, id, owner.auth.account.id))!;
    const pv = await env.svc.previewChange(owner, ws, {
      kind: 'remove',
      member: leaving.public_id,
    });
    env.stepUp.allow = true;
    await env.svc.removeMember(
      owner,
      ws,
      leaving.public_id,
      { preview_token: pv.preview_token, reassign_to: ownerM.public_id },
      mutation({ stepUpToken: 't' }),
    );
    env.stepUp.allow = false;
    expect(await env.svc.getAutomation(owner, ws, a.id)).toMatchObject({
      state: 'suspended',
      suspended_reason: 'owner_departed',
      enabled: false,
    });
    const n = (await runsOf(db, a.id)).length;
    await env.svc.createTask(
      owner,
      ws,
      { brand: brands.main, title: 'After departure' },
      mutation(),
    );
    await settle(db, worker);
    expect((await runsOf(db, a.id)).length).toBe(n);
    // Activating again needs an active owner; reassignment validates the new owner first.
    await expect(activate(owner, ws, a.id)).rejects.toEqual(issueOf('owner_unavailable'));
    const re = await env.svc.reassignAutomation(
      owner,
      ws,
      a.id,
      { owner: ownerM.public_id },
      mutation(),
    );
    expect(re.data).toMatchObject({
      owner: { id: ownerM.public_id },
      enabled: false,
      suspended_reason: null,
    });
    await expect(
      env.svc.reassignAutomation(owner, ws, a.id, { owner: await mem(2, 'read_only') }, mutation()),
    ).rejects.toEqual(issueOf('not_grantable'));
  });

  it('AT-560 an unreadable required input is an opaque refusal, never false', async () => {
    const { ws, people, brands } = W[0]!;
    const owner = people.owner;
    for (const a of (await env.svc.listAutomations(owner, ws)).data)
      if (a.enabled) await env.svc.disableAutomation(owner, ws, a.id, mutation());
    const p1 = (
      await env.svc.createProject(owner, ws, { brand: brands.main, name: 'P1' }, mutation())
    ).data;
    const p2 = (
      await env.svc.createProject(owner, ws, { brand: brands.main, name: 'P2' }, mutation())
    ).data;
    // A field of project P1 only: it does not exist for records of P2.
    const fld = (
      await env.svc.createFieldDefinition(
        owner,
        ws,
        { scope: `project:${p1.id}`, applies_to: ['task'], name: 'Risk', field_type: 'number' },
        mutation(),
      )
    ).data;
    const a = (
      await env.svc.createAutomation(
        owner,
        ws,
        {
          name: 'Risky',
          scope: { kind: 'brand', brand: brands.main },
          definition: {
            schema_version: 1,
            trigger: { kind: 'record.created', record: 'task' },
            conditions: {
              any: [
                { field: `custom:${fld.id}`, op: 'is_not_set' },
                { field: 'priority', op: 'eq', value: 'none' },
              ],
            },
            steps: [
              {
                id: 'up',
                type: 'action',
                action: 'task.update',
                params: { fields: { priority: 'low' } },
              },
            ],
          },
        },
        mutation(),
      )
    ).data;
    await activate(owner, ws, a.id);
    await env.svc.createTask(owner, ws, { project: p1.id, title: 'Readable input' }, mutation());
    await env.svc.createTask(owner, ws, { project: p2.id, title: 'Missing input' }, mutation());
    await settle(db, worker);
    const runs = await runsOf(db, a.id);
    expect(runs.map((r) => [r.status, r.reason]).sort()).toEqual([
      ['policy_rejected', 'input_unavailable'],
      ['succeeded', null],
    ]);
    const refused = runs.find((r) => r.status === 'policy_rejected')!;
    // The refusal records no comparison results (the other OR branch was not a hint either).
    expect(await stepsOf(db, refused.id as string)).toEqual([
      expect.objectContaining({
        node_id: '_conditions',
        state: 'refused',
        failure_class: 'policy_rejected',
        code: 'input_unavailable',
        decision: null,
      }),
    ]);
    await env.svc.disableAutomation(owner, ws, a.id, mutation());
  });
});
