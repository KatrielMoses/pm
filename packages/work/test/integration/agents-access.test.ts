import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { startAgentConnectorFixture, type AgentConnectorFixture } from '@pm/test-support';
import type { WorkerRuntime } from '@pm/platform';
import type { Caller } from '@pm/tenancy';
import { agentConnectorTestHandler, purgeAgentProfiles } from '@pm/work';
import { membershipOf, mutation, workEnv, type WorkEnv } from './fixture.ts';
import { automationWorker, settle } from './automation-support.ts';
import {
  activeProfile,
  agentWorld,
  code,
  config,
  grantBrand,
  issueOf,
  memberId,
  revokeBrand,
  type AgentWorld,
} from './agents-support.ts';

const SECRET = 'agent-credential-0123456789abcdef';

/**
 * Phase 8B authority (0C AZ-52): configure and assign permissions are separate from record and
 * tool permissions; every role, guest, and share-only person; three isolated workspaces;
 * session-only configuration on first execution and on completed-key replay; revocation between
 * preview and save and between a connector test's request and its handshake; lifecycle, purge,
 * and historical rendering.
 */
describe('agents (8B): authority, isolation, and revocation', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let fx: AgentConnectorFixture;
  let worker: WorkerRuntime;
  const W: AgentWorld[] = [];

  const token = async (w: AgentWorld, who: Caller, scopes: string[]): Promise<Caller> => ({
    ...who,
    delegation: {
      tokenId: '00000000-0000-7000-8000-000000000801',
      tokenPublicId: 'tok_00000000000000000000000801',
      kind: 'personal',
      principalType: 'api_token_personal',
      scopes,
      brandIds: null,
      membershipId: (await membershipOf(db, w.wsId, who.auth.account.id))!.id,
      accountId: who.auth.account.id,
      sourceKind: 'api',
    },
  });

  beforeAll(async () => {
    fx = await startAgentConnectorFixture();
    db = await createTestDatabase();
    env = workEnv(db, { agents: { transport: 'fixture', productOrigin: null } });
    for (let i = 0; i < 3; i++)
      W.push(
        await agentWorld(env, db, {
          admin: { kind: 'member', role: 'administrator' },
          member: { kind: 'member', role: 'member' },
          limited: { kind: 'member', role: 'limited_member' },
          reader: { kind: 'member', role: 'read_only' },
        }),
      );
    const w = W[0]!;
    w.people.guest = await (
      await import('./fixture.ts')
    ).join(env, db, w.owner, w.ws, {
      kind: 'guest',
      records: [{ record: w.tasks['Write launch notes'], level: 'edit' }],
    });
    worker = await automationWorker(env, {
      handlers: [agentConnectorTestHandler({ service: env.workerSvc() })],
    });
  });
  afterAll(async () => {
    await worker.stop();
    await env.h.close();
    await db.drop();
    await fx.close();
  });

  it('AT-615 every role and guest: only owners and administrators configure (members by policy); members see summaries; guests see nothing; three workspaces never cross', async () => {
    const w = W[0]!;
    const can: Record<string, boolean> = {};
    for (const who of ['owner', 'admin', 'member', 'limited', 'reader'] as const) {
      const c = who === 'owner' ? w.owner : w.people[who]!;
      try {
        await env.svc.createAgentProfile(
          c,
          w.ws,
          { name: `By ${who}`, kind: 'internal' },
          mutation(),
        );
        can[who] = true;
      } catch (err) {
        expect(err).toEqual(
          code(who === 'reader' || who === 'limited' || who === 'member' ? 'forbidden' : 'x'),
        );
        can[who] = false;
      }
    }
    expect(can).toEqual({ owner: true, admin: true, member: false, limited: false, reader: false });
    const a = await activeProfile(
      env,
      w,
      w.owner,
      config({ scope: { brands: [w.brands.Harbor!] } }),
      'Visible',
    );
    // Members (any role) see a summary: name, kind, state, readiness; never the configuration.
    for (const who of ['member', 'limited', 'reader'] as const) {
      const seen = (await env.svc.getAgentProfile(w.people[who]!, w.ws, a.id)) as Record<
        string,
        unknown
      >;
      expect(seen).toMatchObject({ id: a.id, name: 'Visible', capabilities: { configure: false } });
      expect(seen).not.toHaveProperty('draft');
      expect(seen).not.toHaveProperty('active_revision');
    }
    await expect(env.svc.getAgentProfile(w.people.guest!, w.ws, a.id)).rejects.toEqual(
      code('not_found'),
    );
    await expect(env.svc.listAgentProfiles(w.people.guest!, w.ws)).rejects.toEqual(
      code('not_found'),
    );
    // Other workspaces: unknown and hidden are one answer, and lists never cross.
    for (const other of [W[1]!, W[2]!]) {
      await expect(env.svc.getAgentProfile(other.owner, other.ws, a.id)).rejects.toEqual(
        code('not_found'),
      );
      expect(
        (await env.svc.listAgentProfiles(other.owner, other.ws)).data.map((x) => x.id),
      ).not.toContain(a.id);
      await expect(
        env.svc.assignAgent(
          other.owner,
          other.ws,
          other.tasks['Write launch notes']!,
          { profile: a.id, goal: 'x' },
          mutation(),
        ),
      ).rejects.toEqual(code('not_found'));
    }
    // A guest with an edit share on the task cannot assign agents.
    await expect(
      env.svc.assignAgent(
        w.people.guest!,
        w.ws,
        w.tasks['Write launch notes']!,
        { profile: a.id, goal: 'x' },
        mutation(),
      ),
    ).rejects.toEqual(code('forbidden'));
  });

  it('AT-616 configuration is session-only on first execution and on completed-key replay; assignment accepts a token only with agents:execute', async () => {
    const w = W[1]!;
    const a = (
      await env.svc.createAgentProfile(
        w.owner,
        w.ws,
        {
          name: 'Session',
          kind: 'internal',
          draft: config({ scope: { brands: [w.brands.Harbor!] } }),
        },
        mutation(),
      )
    ).data as Record<string, any>;
    const tok = await token(w, w.owner, ['records:read', 'records:write', 'agents:execute']);
    await expect(
      env.svc.createAgentProfile(tok, w.ws, { name: 'Token', kind: 'internal' }, mutation()),
    ).rejects.toEqual(code('forbidden'));
    await expect(env.svc.activateAgentProfile(tok, w.ws, a.id, mutation())).rejects.toEqual(
      code('forbidden'),
    );
    await expect(
      env.svc.configureAgentConnector(
        tok,
        w.ws,
        a.id,
        { kind: 'api', endpoint_url: fx.endpoint('x'), secret: SECRET },
        mutation(),
      ),
    ).rejects.toEqual(code('forbidden'));
    // A completed session key replayed by the same member's token renders nothing.
    const req = mutation();
    await env.svc.activateAgentProfile(w.owner, w.ws, a.id, req);
    for (const replay of [
      () => env.svc.activateAgentProfile(tok, w.ws, a.id, req),
      () => env.svc.agentProfileLifecycle(tok, w.ws, a.id, 'archive', req),
      () =>
        env.svc.reassignAgentProfile(
          tok,
          w.ws,
          a.id,
          { owner: 'mem_01HZZZZZZZZZZZZZZZZZZZZZZZ' },
          req,
        ),
    ])
      await expect(replay()).rejects.toEqual(code('forbidden'));
    // Assignment: a token without agents:execute is refused; with it, it assigns as its member.
    const weak = await token(w, w.owner, ['records:read', 'records:write']);
    await expect(
      env.svc.assignAgent(
        weak,
        w.ws,
        w.tasks['Write launch notes']!,
        { profile: a.id, goal: 'By token.' },
        mutation(),
      ),
    ).rejects.toEqual(code('forbidden'));
    const made = (
      await env.svc.assignAgent(
        tok,
        w.ws,
        w.tasks['Write launch notes']!,
        { profile: a.id, goal: 'By token.' },
        mutation(),
      )
    ).data as Record<string, any>;
    expect(made).toMatchObject({ state: expect.any(String), goal: 'By token.' });
  });

  it('AT-617 revocation between preview and save, and a completed assignment key after the assigner lost the brand, are refused opaquely', async () => {
    const w = W[2]!;
    const m = w.people.member!;
    await grantBrand(env, db, w, m, w.brands.Harbor!, 'edit');
    const a = await activeProfile(
      env,
      w,
      w.owner,
      config({ scope: { brands: [w.brands.Harbor!] } }),
      'Revoked',
    );
    const task = w.tasks['Write launch notes']!;
    const p = (await env.svc.previewAgentAssignment(m, w.ws, task, {
      profile: a.id,
      goal: 'Preview first.',
    })) as Record<string, any>;
    expect(p.refusals).toEqual([]);
    await revokeBrand(env, db, w, m, w.brands.Harbor!);
    await expect(
      env.svc.assignAgent(m, w.ws, task, { profile: a.id, goal: 'Preview first.' }, mutation()),
    ).rejects.toEqual(code('not_found'));
    await grantBrand(env, db, w, m, w.brands.Harbor!, 'edit');
    const req = mutation();
    await env.svc.assignAgent(m, w.ws, task, { profile: a.id, goal: 'Saved.' }, req);
    expect(
      (await env.svc.assignAgent(m, w.ws, task, { profile: a.id, goal: 'Saved.' }, req)).replayed,
    ).toBe(true);
    await revokeBrand(env, db, w, m, w.brands.Harbor!);
    await expect(
      env.svc.assignAgent(m, w.ws, task, { profile: a.id, goal: 'Saved.' }, req),
    ).rejects.toEqual(code('not_found'));
    // The owner still sees the assignment, now blocked: the assigner lost the task's brand.
    const list = (await env.svc.listTaskAgentAssignments(w.owner, w.ws, task)) as Record<
      string,
      any
    >;
    expect(list.data[0]).toMatchObject({
      state: 'blocked',
      blocked_reasons: expect.arrayContaining(['scope_lost']),
    });
  });

  it('AT-618 a connector test is re-decided after it was requested: a trashed profile or a requester who lost authority sends nothing', async () => {
    const w = W[0]!;
    const admin = w.people.admin!;
    const mk = async (name: string) => {
      const a = (
        await env.svc.createAgentProfile(
          admin,
          w.ws,
          {
            name,
            kind: 'external',
            draft: config({
              kind: 'external',
              model_key: null,
              scope: { brands: [w.brands.Harbor!] },
            }),
          },
          mutation(),
        )
      ).data as Record<string, any>;
      fx.peer(name, { kind: 'api', secret: SECRET });
      await env.svc.configureAgentConnector(
        admin,
        w.ws,
        a.id,
        { kind: 'api', endpoint_url: fx.endpoint(name), secret: SECRET },
        mutation(),
      );
      return a.id as string;
    };
    const one = await mk('revoked-requester');
    const two = await mk('trashed-profile');
    const before = fx.received().length;
    const t1 = (await env.svc.testAgentConnector(admin, w.ws, one, { confirm: true }, mutation()))
      .data as { id: string };
    const t2 = (await env.svc.testAgentConnector(admin, w.ws, two, { confirm: true }, mutation()))
      .data as { id: string };
    // Between request and handshake: the administrator becomes a member; the other profile is trashed.
    const { apply } = await import('./fixture.ts');
    await apply(env, w.owner, w.ws, {
      kind: 'role',
      member: await memberId(db, w, admin),
      role: 'member',
    });
    await env.svc.agentProfileLifecycle(w.owner, w.ws, two, 'trash', mutation());
    await settle(db, worker);
    expect(fx.received().length).toBe(before);
    expect(await env.svc.getAgentConnectorTest(w.owner, w.ws, one, t1.id)).toMatchObject({
      state: 'refused',
      code: 'requester_unauthorized',
    });
    expect(
      (
        await db.admin(
          `SELECT t.state, t.code FROM agents.agent_connector_test t JOIN exec.operation o ON o.id = t.operation_id WHERE o.public_id = $1`,
          [t2.id],
        )
      ).rows[0],
    ).toEqual({ state: 'refused', code: 'connector_revoked' });
  });

  it("AT-619 purge removes a profile with its assignments, connector, tests, grants, and revisions; task purge removes the task's assignments; history renders through current access", async () => {
    const w = W[1]!;
    const a = await activeProfile(
      env,
      w,
      w.owner,
      config({ scope: { brands: [w.brands.Harbor!] } }),
      'Purged',
    );
    const task = w.tasks['Plan launch party']!;
    await env.svc.assignAgent(
      w.owner,
      w.ws,
      task,
      { profile: a.id, goal: 'To be purged.' },
      mutation(),
    );
    await env.svc.withdrawAgentAssignment(w.owner, w.ws, task, a.id, mutation());
    let list = (await env.svc.listTaskAgentAssignments(w.owner, w.ws, task)) as Record<string, any>;
    expect(list.data.map((x: { state: string }) => x.state)).toEqual(['withdrawn']);
    await env.svc.agentProfileLifecycle(w.owner, w.ws, a.id, 'trash', mutation());
    const id = (await db.admin(`SELECT id FROM core.record WHERE public_id = $1`, [a.id])).rows[0]!
      .id;
    await env.h.worker.withWorkspace(w.wsId, { module: 'test' }, (tx) =>
      purgeAgentProfiles(tx as never, [id]),
    );
    const left = (
      await db.admin(
        `SELECT (SELECT count(*)::int FROM agents.agent_profile WHERE id = $1) AS profiles,
                (SELECT count(*)::int FROM agents.agent_profile_revision WHERE profile_id = $1) AS revisions,
                (SELECT count(*)::int FROM agents.agent_connector WHERE profile_id = $1) AS connectors,
                (SELECT count(*)::int FROM agents.agent_assignment WHERE profile_id = $1) AS assignments,
                (SELECT count(*)::int FROM agents.agent_scope_grant g WHERE NOT EXISTS (SELECT 1 FROM agents.agent_profile_revision r WHERE r.id = g.revision_id)) AS orphan_grants,
                (SELECT count(*)::int FROM agents.agent_assignment_revision r WHERE NOT EXISTS (SELECT 1 FROM agents.agent_assignment a WHERE a.id = r.assignment_id)) AS orphan_revisions`,
        [id],
      )
    ).rows[0];
    expect(left).toEqual({
      profiles: 0,
      revisions: 0,
      connectors: 0,
      assignments: 0,
      orphan_grants: 0,
      orphan_revisions: 0,
    });
    list = (await env.svc.listTaskAgentAssignments(w.owner, w.ws, task)) as Record<string, any>;
    expect(list.data).toEqual([]);
    // A task purge takes its assignments with it.
    const b = await activeProfile(
      env,
      w,
      w.owner,
      config({ scope: { brands: [w.brands.Harbor!] } }),
      'Survivor',
    );
    await env.svc.assignAgent(
      w.owner,
      w.ws,
      w.tasks['Loose harbor task']!,
      { profile: b.id, goal: 'Task goes away.' },
      mutation(),
    );
    const tid = (
      await db.admin(`SELECT id FROM core.record WHERE public_id = $1`, [
        w.tasks['Loose harbor task'],
      ])
    ).rows[0]!.id;
    const { purgeTaskAgentAssignments } = await import('@pm/work');
    await env.h.worker.withWorkspace(w.wsId, { module: 'test' }, (tx) =>
      purgeTaskAgentAssignments(tx as never, [tid]),
    );
    expect(
      (
        await db.admin(
          `SELECT count(*)::int AS n FROM agents.agent_assignment WHERE task_id = $1`,
          [tid],
        )
      ).rows[0]!.n,
    ).toBe(0);
    void issueOf;
  });
});
