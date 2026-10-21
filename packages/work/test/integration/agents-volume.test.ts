import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { workEnv, type WorkEnv } from './fixture.ts';
import { agentWorld, type AgentWorld } from './agents-support.ts';

/**
 * Phase 8B bounded query behaviour: the reads the agent service makes on every task panel,
 * readiness check, grantability check, and connector view use their indexes at volume (2,000
 * profiles, 5,000 assignments, 20,000 scope grants, 5,000 connector tests), never a scan; 8C adds
 * the run history, open-run, active-run, event long-poll, model-turn, and credential reads.
 */
describe('agents (8B–8C): query plans at volume', () => {
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

  it('EXPLAIN at 10,000 runs and 50,000 events (8C): task run history, the open run, active runs, event long polls, the model turn link, and credential lookup use their indexes', async () => {
    const hash = 'a'.repeat(64);
    await db.admin(`SET session_replication_role = replica;
      INSERT INTO agents.agent_run (id, workspace_id, brand_id, task_id, profile_id, assignment_id, assignment_revision_id,
          profile_revision_id, kind, instructions_hash, initiator_kind, initiator_membership_id, assigner_membership_id,
          owner_membership_id, model_key, tools, limits, operation_id, current_operation_id, request_key, model_operation_id,
          ended_at, created_at)
      SELECT uuidv7(), '${w.wsId}', uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7(), 'internal', '${hash}', 'human',
             uuidv7(), uuidv7(), uuidv7(), 'agent_task_draft', '[]'::jsonb, '{}'::jsonb, uuidv7(), uuidv7(), 'volume-' || n, uuidv7(),
             CASE WHEN n % 10 = 0 THEN NULL ELSE now() END, now() - n * interval '1 minute'
        FROM generate_series(1, 10000) n;
      INSERT INTO agents.agent_run_event (id, workspace_id, run_id, operation_id, seq, kind, source, text)
      SELECT uuidv7(), '${w.wsId}', r.id, r.operation_id, s, 'progress', 'agent', 'Working.'
        FROM (SELECT id, operation_id FROM agents.agent_run WHERE workspace_id = '${w.wsId}' LIMIT 1000) r,
             generate_series(1, 50) s;
      INSERT INTO agents.agent_run_credential (id, workspace_id, run_id, operation_id, token_prefix, token_hash, expires_at, stop_epoch)
      SELECT uuidv7(), '${w.wsId}', uuidv7(), uuidv7(), 'par_' || lpad(n::text, 8, '0'), sha256(n::text::bytea), now() + interval '15 minutes', 0
        FROM generate_series(1, 10000) n;
      SET session_replication_role = origin;
      ANALYZE agents.agent_run, agents.agent_run_event, agents.agent_run_credential;`);
    const r = (
      await db.admin(
        `SELECT r.id, r.task_id, r.profile_id, r.model_operation_id FROM agents.agent_run r
          WHERE r.workspace_id = $1 AND EXISTS (SELECT 1 FROM agents.agent_run_event e WHERE e.run_id = r.id) LIMIT 1`,
        [w.wsId],
      )
    ).rows[0] as Record<string, string>;
    const plan = async (query: string, params: unknown[]) =>
      env.h.app.withWorkspace(w.wsId, { module: 'test' }, async (tx) => {
        const x = await tx.db.executeQuery({
          sql: `EXPLAIN (FORMAT JSON) ${query}`,
          parameters: params,
          query: { kind: 'RawNode' },
        } as never);
        return JSON.stringify((x as { rows: unknown[] }).rows);
      });
    const cases: Array<[string, string, unknown[], RegExp]> = [
      [
        "a task's run history",
        `SELECT id FROM agents.agent_run WHERE task_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [r.task_id],
        /agent_run_by_task/,
      ],
      [
        'the open run for a task and agent',
        `SELECT id FROM agents.agent_run WHERE task_id = $1 AND profile_id = $2 AND ended_at IS NULL`,
        [r.task_id, r.profile_id],
        /agent_run_open|agent_run_by_task/,
      ],
      [
        'active runs in the workspace',
        `SELECT count(*) FROM agents.agent_run WHERE ended_at IS NULL`,
        [],
        /agent_run_active|agent_run_open/,
      ],
      [
        'progress events after a cursor',
        `SELECT seq, kind, text FROM agents.agent_run_event WHERE run_id = $1 AND seq > $2 ORDER BY seq LIMIT 100`,
        [r.id, 10],
        /agent_run_event_seq_unique/,
      ],
      [
        'the run behind a model turn',
        `SELECT id FROM agents.agent_run WHERE model_operation_id = $1`,
        [r.model_operation_id],
        /agent_run_by_model_operation/,
      ],
      [
        'a run credential by prefix',
        `SELECT id FROM agents.agent_run_credential WHERE token_prefix = $1`,
        ['par_00000042'],
        /agent_run_credential_prefix_unique/,
      ],
    ];
    for (const [label, query, params, index] of cases) {
      const p = await plan(query, params);
      expect(p, label).toMatch(index);
      expect(p, label).not.toMatch(/"Node Type":"Seq Scan"/);
    }
  });
});
