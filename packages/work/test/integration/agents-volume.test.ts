import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { workEnv, type WorkEnv } from './fixture.ts';
import { agentWorld, type AgentWorld } from './agents-support.ts';

/**
 * Phase 8B bounded query behaviour: the reads the agent service makes on every task panel,
 * readiness check, grantability check, and connector view use their indexes at volume (2,000
 * profiles, 5,000 assignments, 20,000 scope grants, 5,000 connector tests), never a scan.
 */
describe('agents (8B): query plans at volume', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let w: AgentWorld;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    w = await agentWorld(env, db);
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('EXPLAIN at 2,000 profiles and 5,000 assignments: task panels, active assignments, grant lookups, and the latest connector test use their indexes', async () => {
    // Synthetic rows for the plan only (inserted past RLS with foreign keys and triggers off).
    await db.admin(`SET session_replication_role = replica;
      INSERT INTO agents.agent_profile (id, workspace_id, scope_key, kind, name, owner_membership_id, state, draft, created_by_membership_id)
      SELECT uuidv7(), '${w.wsId}', '${w.wsId}', CASE WHEN n % 2 = 0 THEN 'internal' ELSE 'external' END, 'Agent ' || n,
             uuidv7(), 'draft', '{}'::jsonb, uuidv7()
        FROM generate_series(1, 2000) n;
      INSERT INTO agents.agent_assignment (id, workspace_id, brand_id, task_id, profile_id, state, current_revision_id, assigned_by_membership_id, withdrawn_at, created_at)
      SELECT uuidv7(), '${w.wsId}', uuidv7(), uuidv7(), uuidv7(), CASE WHEN n % 4 = 0 THEN 'withdrawn' ELSE 'assigned' END,
             uuidv7(), uuidv7(), CASE WHEN n % 4 = 0 THEN now() END, now() - n * interval '1 minute'
        FROM generate_series(1, 5000) n;
      INSERT INTO agents.agent_scope_grant (id, workspace_id, revision_id, kind, target_id)
      SELECT uuidv7(), '${w.wsId}', uuidv7(), (ARRAY['brand','project','record','integration'])[1 + n % 4], uuidv7()
        FROM generate_series(1, 20000) n;
      INSERT INTO agents.agent_connector_test (id, workspace_id, connector_id, operation_id, config_version, requested_by_membership_id, state, created_at)
      SELECT uuidv7(), '${w.wsId}', uuidv7(), uuidv7(), 1, uuidv7(), 'queued', now() - n * interval '1 minute'
        FROM generate_series(1, 5000) n;
      SET session_replication_role = origin;
      ANALYZE agents.agent_profile, agents.agent_assignment, agents.agent_scope_grant, agents.agent_connector_test;`);
    const any = async (sql: string) => (await db.admin(sql)).rows[0] as Record<string, string>;
    const a = await any(
      `SELECT task_id, profile_id FROM agents.agent_assignment WHERE workspace_id = '${w.wsId}' AND state = 'assigned' LIMIT 1`,
    );
    const g = await any(
      `SELECT kind, target_id FROM agents.agent_scope_grant WHERE workspace_id = '${w.wsId}' LIMIT 1`,
    );
    const t = await any(
      `SELECT connector_id FROM agents.agent_connector_test WHERE workspace_id = '${w.wsId}' LIMIT 1`,
    );
    const plan = async (query: string, params: unknown[]) =>
      env.h.app.withWorkspace(w.wsId, { module: 'test' }, async (tx) => {
        const r = await tx.db.executeQuery({
          sql: `EXPLAIN (FORMAT JSON) ${query}`,
          parameters: params,
          query: { kind: 'RawNode' },
        } as never);
        return JSON.stringify((r as { rows: unknown[] }).rows);
      });
    const cases: Array<[string, string, unknown[], RegExp]> = [
      [
        'the task Agent section',
        `SELECT * FROM agents.agent_assignment WHERE task_id = $1 ORDER BY created_at`,
        [a.task_id],
        /agent_assignment_by_task|agent_assignment_active/,
      ],
      [
        'one active assignment per task and profile',
        `SELECT id FROM agents.agent_assignment WHERE task_id = $1 AND profile_id = $2 AND state = 'assigned'`,
        [a.task_id, a.profile_id],
        /agent_assignment_active|agent_assignment_by_task|agent_assignment_by_profile/,
      ],
      [
        "a profile's active assignments",
        `SELECT id FROM agents.agent_assignment WHERE profile_id = $1 AND state = 'assigned'`,
        [a.profile_id],
        /agent_assignment_by_profile/,
      ],
      [
        'grants naming one target',
        `SELECT revision_id FROM agents.agent_scope_grant WHERE kind = $1 AND target_id = $2`,
        [g.kind, g.target_id],
        /agent_scope_grant_by_target/,
      ],
      [
        "a connector's latest test",
        `SELECT id FROM agents.agent_connector_test WHERE connector_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [t.connector_id],
        /agent_connector_test_by_connector/,
      ],
    ];
    for (const [label, query, params, index] of cases) {
      const p = await plan(query, params);
      expect(p, label).toMatch(index);
      expect(p, label).not.toMatch(/"Node Type":"Seq Scan"/);
    }
  });
});
