import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAiProviderFixture, type AiProviderFixture } from '@pm/test-support';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { enableAi, fixtureAi, stepped, stepUp } from './ai-support.ts';
import { mutation, workEnv, type WorkEnv } from './fixture.ts';
import {
  activeProfile,
  agentWorld,
  code,
  config,
  grantBrand,
  issueOf,
  memberId,
  v,
  type AgentWorld,
} from './agents-support.ts';

/**
 * Phase 8B agent profiles (AGT-001/002/005/006/008, PERM-008): canonical addressable records with
 * an accountable human owner, typed versioned configuration, relational grants on immutable
 * revisions, grantability for the configurer and the owner at activation and reassignment, real
 * starter templates, duplication without credentials or grants, and lifecycle. Nothing here runs
 * an agent: execution belongs to 8C.
 */
describe('agents (8B): profiles, revisions, grants, templates', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let w: AgentWorld;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    w = await agentWorld(env, db, {
      admin: { kind: 'member', role: 'administrator' },
      member: { kind: 'member', role: 'member' },
    });
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('AT-595 every starter template instantiates a disabled draft with conservative tools and missing configuration named', async () => {
    const templates = env.svc.listAgentTemplates().data;
    expect(templates.map((t) => t.key).sort()).toEqual([
      'development',
      'documentation',
      'growth',
      'research',
      'testing',
    ]);
    for (const t of templates) {
      const a = (await env.svc.createAgentProfile(w.owner, w.ws, { template: t.key }, mutation()))
        .data as Record<string, any>;
      expect(a).toMatchObject({
        type: 'agent_profile',
        state: 'draft',
        kind: t.kind,
        template: t.key,
        active_revision: null,
      });
      expect(a.readiness.state).toBe('not_ready');
      expect(a.draft_status).toMatchObject({ valid: true, unavailable: [] });
      expect(a.draft_status.missing).toEqual(
        expect.arrayContaining(['scope', t.kind === 'internal' ? 'model' : 'connector']),
      );
      // Conservative: no R2+ tool, no update or code tools, approvals stricter than the floor.
      for (const tool of a.draft.tools)
        expect([
          'pm.tasks.get',
          'pm.documents.get',
          'pm.documents.draft',
          'pm.deliverables.draft_version',
          'pm.tasks.create_subtask',
        ]).toContain(tool.name);
      expect(a.execution).toMatchObject({ available: true, owner: '8C' });
      // A template cannot be turned on until a person names its scope.
      await expect(env.svc.activateAgentProfile(w.owner, w.ws, a.id, mutation())).rejects.toEqual(
        issueOf('configuration_incomplete'),
      );
    }
  });

  it('AT-596 configuration is typed and bounded: unregistered tools, weaker approval, unknown fields, out-of-range limits, and unavailable tools are refused', async () => {
    const a = (
      await env.svc.createAgentProfile(
        w.owner,
        w.ws,
        { name: 'Typed', kind: 'internal' },
        mutation(),
      )
    ).data as Record<string, any>;
    const save = async (draft: Record<string, unknown>) =>
      (
        await env.svc.updateAgentProfile(
          w.owner,
          w.ws,
          a.id,
          { draft },
          v((await env.svc.getAgentProfile(w.owner, w.ws, a.id)).version),
        )
      ).data as Record<string, any>;
    let d = await save(
      config({
        tools: [{ name: 'http.request', version: '1' }],
        scope: { brands: [w.brands.Harbor!] },
      }),
    );
    expect(d.draft_status.issues).toEqual([
      expect.objectContaining({ pointer: '/tools/0', code: 'unregistered_tool' }),
    ]);
    d = await save(
      config({
        tools: [{ name: 'pm.tasks.update', version: '9' }],
        scope: { brands: [w.brands.Harbor!] },
      }),
    );
    expect(d.draft_status.issues[0].code).toBe('unregistered_tool');
    d = await save(
      config({
        tools: [{ name: 'pm.tasks.update', version: '1' }],
        approval_policy: { update_records: 'low_impact_policy' },
        scope: { brands: [w.brands.Harbor!] },
      }),
    );
    expect(d.draft_status.issues).toEqual([
      expect.objectContaining({ code: 'weaker_than_policy' }),
    ]);
    d = await save(
      config({
        limits: { max_tool_calls: 100000 },
        scope: { brands: [w.brands.Harbor!] },
        script: 'x',
      }),
    );
    expect(d.draft_status.issues.map((i: { code: string }) => i.code).sort()).toEqual([
      'out_of_range',
      'unknown_field',
    ]);
    d = await save(
      config({
        tools: [{ name: 'pm.tests.run', version: '1' }],
        scope: { brands: [w.brands.Harbor!] },
      }),
    );
    expect(d.draft_status).toMatchObject({
      valid: true,
      unavailable: [expect.objectContaining({ tool: 'pm.tests.run', owner: '9B' })],
    });
    await expect(env.svc.activateAgentProfile(w.owner, w.ws, a.id, mutation())).rejects.toEqual(
      issueOf('tool_unavailable'),
    );
    // Stricter is allowed and recorded per tool grant.
    d = await save(
      config({
        tools: [
          { name: 'pm.tasks.get', version: '1' },
          { name: 'pm.tasks.update', version: '1' },
        ],
        approval_policy: { read_records: 'human_approval' },
        scope: { brands: [w.brands.Harbor!] },
      }),
    );
    expect(d.draft_status).toMatchObject({ valid: true, missing: [] });
    const on = (await env.svc.activateAgentProfile(w.owner, w.ws, a.id, mutation())).data as Record<
      string,
      any
    >;
    expect(on.active_revision.tools).toEqual([
      {
        tool: 'pm.tasks.get',
        version: '1',
        tool_class: 'read_records',
        approval_class: 'human_approval',
      },
      {
        tool: 'pm.tasks.update',
        version: '1',
        tool_class: 'update_records',
        approval_class: 'review_required',
      },
    ]);
    // Grants are relational rows on the immutable revision.
    const rows = (
      await db.admin(
        `SELECT g.tool, g.approval_class FROM agents.agent_tool_grant g JOIN agents.agent_profile_revision r ON r.id = g.revision_id JOIN core.record c ON c.id = r.profile_id WHERE c.public_id = $1 ORDER BY g.tool`,
        [a.id],
      )
    ).rows;
    expect(rows).toEqual([
      { tool: 'pm.tasks.get', approval_class: 'human_approval' },
      { tool: 'pm.tasks.update', approval_class: 'review_required' },
    ]);
    await expect(
      db.admin(`UPDATE agents.agent_tool_grant SET approval_class = 'none'`),
    ).rejects.toThrow(/immutable/);
  });

  it('AT-597 editing a profile changes only the draft; activation selects a new immutable revision; identical configuration reuses it', async () => {
    const a = await activeProfile(
      env,
      w,
      w.owner,
      config({ scope: { brands: [w.brands.Harbor!] } }),
      'Revisions',
    );
    let view = (await env.svc.getAgentProfile(w.owner, w.ws, a.id)) as Record<string, any>;
    expect(view.active_revision).toMatchObject({ revision: 1 });
    await env.svc.updateAgentProfile(
      w.owner,
      w.ws,
      a.id,
      { draft: config({ scope: { brands: [w.brands.Harbor!, w.brands.Vault!] } }) },
      v(view.version),
    );
    view = (await env.svc.getAgentProfile(w.owner, w.ws, a.id)) as Record<string, any>;
    expect(view.active_revision.revision).toBe(1);
    expect(view.active_revision.scope.items.map((i: { id: string }) => i.id)).toEqual([
      w.brands.Harbor!,
    ]);
    expect(view.draft_status.matches_active).toBe(false);
    // A stale version never overwrites a newer draft.
    await expect(
      env.svc.updateAgentProfile(w.owner, w.ws, a.id, { name: 'x' }, v(0)),
    ).rejects.toEqual(code('conflict'));
    view = (await env.svc.activateAgentProfile(w.owner, w.ws, a.id, mutation())).data as Record<
      string,
      any
    >;
    expect(view.active_revision.revision).toBe(2);
    await env.svc.updateAgentProfile(
      w.owner,
      w.ws,
      a.id,
      { draft: config({ scope: { brands: [w.brands.Harbor!] } }) },
      v(view.version),
    );
    view = (await env.svc.activateAgentProfile(w.owner, w.ws, a.id, mutation())).data as Record<
      string,
      any
    >;
    expect(view.active_revision.revision).toBe(1);
    const revs = (await env.svc.listAgentProfileRevisions(w.owner, w.ws, a.id)).data;
    expect(revs.map((r) => [r.revision, r.active])).toEqual([
      [2, false],
      [1, true],
    ]);
  });

  it('AT-598 activation needs grantability for the configurer and the owner on every scope item at the level its tools need', async () => {
    const admin = w.people.admin!;
    // Administrators have no implicit access to a sensitive brand: they cannot grant it.
    const a = (
      await env.svc.createAgentProfile(
        admin,
        w.ws,
        {
          name: 'Sensitive',
          kind: 'internal',
          draft: config({ scope: { brands: [w.brands.Vault!] } }),
        },
        mutation(),
      )
    ).data as Record<string, any>;
    await expect(env.svc.activateAgentProfile(admin, w.ws, a.id, mutation())).rejects.toEqual(
      issueOf('invalid_reference'),
    );
    // A member with view on Harbor (policy allows members to configure agents) can grant read
    // tools there but not write tools.
    const member = w.people.member!;
    await grantBrand(env, db, w, member, w.brands.Harbor!, 'view');
    // Members configure agents only when the workspace policy allows it.
    await expect(
      env.svc.createAgentProfile(
        member,
        w.ws,
        { name: 'Member agent', kind: 'internal' },
        mutation(),
      ),
    ).rejects.toEqual(code('forbidden'));
    await env.svc.updatePolicy(
      w.owner,
      w.ws,
      { changes: { members_configure_agents: true }, confirm_exposure: true },
      mutation(),
    );
    const m = (
      await env.svc.createAgentProfile(
        member,
        w.ws,
        {
          name: 'Member agent',
          kind: 'internal',
          draft: config({
            tools: [
              { name: 'pm.tasks.get', version: '1' },
              { name: 'pm.tasks.update', version: '1' },
            ],
            scope: { brands: [w.brands.Harbor!] },
          }),
        },
        mutation(),
      )
    ).data as Record<string, any>;
    // View on Harbor grants read tools only: an update tool there needs edit.
    await expect(env.svc.activateAgentProfile(member, w.ws, m.id, mutation())).rejects.toEqual(
      issueOf('not_grantable'),
    );
    await env.svc.updateAgentProfile(
      member,
      w.ws,
      m.id,
      { draft: config({ scope: { brands: [w.brands.Harbor!] } }) },
      v(m.version),
    );
    expect(
      (
        (await env.svc.activateAgentProfile(member, w.ws, m.id, mutation())).data as Record<
          string,
          any
        >
      ).state,
    ).toBe('active');
    await env.svc.updatePolicy(
      w.owner,
      w.ws,
      { changes: { members_configure_agents: false } },
      mutation(),
    );
    // The owner configures for a profile owned by the administrator: the owner must also hold it.
    const b = (
      await env.svc.createAgentProfile(
        admin,
        w.ws,
        {
          name: 'Writer',
          kind: 'internal',
          draft: config({
            tools: [{ name: 'pm.tasks.update', version: '1' }],
            scope: { brands: [w.brands.Harbor!] },
          }),
        },
        mutation(),
      )
    ).data as Record<string, any>;
    const on = (await env.svc.activateAgentProfile(admin, w.ws, b.id, mutation())).data as Record<
      string,
      any
    >;
    expect(on.state).toBe('active');
    // Reassigning to a member without configure authority is refused; nothing changes.
    await expect(
      env.svc.reassignAgentProfile(
        admin,
        w.ws,
        b.id,
        { owner: await memberId(db, w, member) },
        mutation(),
      ),
    ).rejects.toEqual(issueOf('not_grantable'));
    expect(((await env.svc.getAgentProfile(admin, w.ws, b.id)) as Record<string, any>).state).toBe(
      'active',
    );
    // Reassigning to the workspace owner validates afresh and leaves the profile off.
    const moved = (
      await env.svc.reassignAgentProfile(
        admin,
        w.ws,
        b.id,
        { owner: await memberId(db, w, w.owner) },
        mutation(),
      )
    ).data as Record<string, any>;
    expect(moved).toMatchObject({ state: 'disabled', owner: { name: expect.any(String) } });
  });

  it('AT-599 duplicate copies the draft only: no connector, credential, revision, or grant', async () => {
    const a = await activeProfile(
      env,
      w,
      w.owner,
      config({ scope: { brands: [w.brands.Harbor!] } }),
      'Original',
    );
    const dup = (await env.svc.duplicateAgentProfile(w.owner, w.ws, a.id, mutation()))
      .data as Record<string, any>;
    expect(dup).toMatchObject({
      name: 'Copy of Original',
      state: 'draft',
      active_revision: null,
      connector: null,
    });
    const counts = (
      await db.admin(
        `SELECT (SELECT count(*)::int FROM agents.agent_profile_revision r JOIN core.record c ON c.id = r.profile_id WHERE c.public_id = $1) AS revisions`,
        [dup.id],
      )
    ).rows[0];
    expect(counts).toEqual({ revisions: 0 });
  });

  it('AT-600 archive and trash stop use; restore comes back disabled; members see summaries only', async () => {
    const a = await activeProfile(
      env,
      w,
      w.owner,
      config({ scope: { brands: [w.brands.Harbor!] } }),
      'Lifecycle',
    );
    const member = w.people.member!;
    const seen = (await env.svc.getAgentProfile(member, w.ws, a.id)) as Record<string, any>;
    expect(seen).not.toHaveProperty('draft');
    expect(seen).not.toHaveProperty('connector');
    expect(JSON.stringify(seen)).not.toContain('Summarize the assigned task');
    await env.svc.agentProfileLifecycle(w.owner, w.ws, a.id, 'archive', mutation());
    let view = (await env.svc.getAgentProfile(w.owner, w.ws, a.id)) as Record<string, any>;
    expect(view.readiness.reasons).toContain('archived');
    await env.svc.agentProfileLifecycle(w.owner, w.ws, a.id, 'unarchive', mutation());
    view = (await env.svc.getAgentProfile(w.owner, w.ws, a.id)) as Record<string, any>;
    expect(view.state).toBe('disabled');
    await env.svc.agentProfileLifecycle(w.owner, w.ws, a.id, 'trash', mutation());
    await expect(env.svc.getAgentProfile(w.owner, w.ws, a.id)).rejects.toEqual(code('not_found'));
    const back = (await env.svc.agentProfileLifecycle(w.owner, w.ws, a.id, 'restore', mutation()))
      .data as Record<string, any>;
    expect(back).toMatchObject({ lifecycle_state: 'active', state: 'disabled' });
  });
});

describe('agents (8B): the workspace limit under concurrency, and internal readiness with AI on and off', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let fx: AiProviderFixture;
  let w: AgentWorld;

  beforeAll(async () => {
    db = await createTestDatabase();
    fx = await startAiProviderFixture();
    env = workEnv(db, { ai: fixtureAi(fx), work: { agentProfilesPerWorkspaceMax: 3 } });
    w = await agentWorld(env, db, { admin: { kind: 'member', role: 'administrator' } });
  });
  afterAll(async () => {
    await env.h.close();
    await fx.close();
    await db.drop();
  });

  it('AT-630 internal readiness follows the workspace AI policy now: off names the reason, on is ready and labelled synthetic', async () => {
    const a = await activeProfile(
      env,
      w,
      w.owner,
      config({ scope: { brands: [w.brands.Harbor!] } }),
      'Reader',
    );
    const before = (await env.svc.getAgentProfile(w.owner, w.ws, a.id)) as Record<string, any>;
    expect(before.readiness.state).toBe('not_ready');
    expect(before.readiness.reasons.some((r: string) => r.startsWith('model_'))).toBe(true);
    await enableAi(env, w.owner, w.ws);
    const after = (await env.svc.getAgentProfile(w.owner, w.ws, a.id)) as Record<string, any>;
    expect(after.readiness).toEqual({ state: 'ready', reasons: [], synthetic: true });
    // Turning AI off again is reflected at once (readiness is derived, never stored).
    const current = await env.svc.getAiSettings(w.owner, w.ws);
    await stepped(env, () =>
      env.svc.updateAiSettings(w.owner, w.ws, { enabled: false }, stepUp(current.version)),
    );
    const off = (await env.svc.getAgentProfile(w.owner, w.ws, a.id)) as Record<string, any>;
    expect(off.readiness.state).toBe('not_ready');
    expect(off.readiness.reasons).toContain('model_disabled');
  });

  it('AT-631 concurrent creations never exceed the workspace profile limit', async () => {
    const existing = ((await env.svc.listAgentProfiles(w.owner, w.ws, {})).data as unknown[])
      .length;
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        env.svc.createAgentProfile(
          w.owner,
          w.ws,
          { kind: 'internal', name: `Racer ${i}` },
          mutation(),
        ),
      ),
    );
    const made = results.filter((r) => r.status === 'fulfilled').length;
    expect(made).toBe(3 - existing);
    for (const r of results)
      if (r.status === 'rejected') expect(r.reason).toEqual(issueOf('limit_reached'));
    const n = await db.admin(
      `SELECT count(*)::int AS n FROM agents.agent_profile p JOIN tenancy.workspace w ON w.id = p.workspace_id WHERE w.public_id = $1`,
      [w.ws],
    );
    expect(n.rows[0].n).toBe(3);
  });
});
