-- migrate:phase contract
-- Restores the exact 0064 catalog. Rolling back would delete agent runs (with their events, tool
-- calls, draft artifacts, and credentials), emergency stop history, and model turns requested by
-- agents, so the rollback refuses, with counts, while any of them exists. Forced row-level
-- security is lifted for that one check.
ALTER TABLE agents.agent_run NO FORCE ROW LEVEL SECURITY;
ALTER TABLE agents.emergency_stop NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ai.ai_action NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  n_runs bigint;
  n_stops bigint;
  n_ai bigint;
BEGIN
  SELECT count(*) INTO n_runs FROM agents.agent_run;
  SELECT count(*) INTO n_stops FROM agents.emergency_stop;
  SELECT count(*) INTO n_ai FROM ai.ai_action WHERE caller_kind = 'agent';
  IF n_runs > 0 OR n_stops > 0 OR n_ai > 0 THEN
    RAISE EXCEPTION '0065 cannot be rolled back: % agent run(s), % emergency stop record(s), % agent model turn(s)',
      n_runs, n_stops, n_ai USING ERRCODE = '55000';
  END IF;
END $$;
ALTER TABLE ai.ai_action FORCE ROW LEVEL SECURITY;

ALTER TABLE ai.ai_action DROP CONSTRAINT ai_action_caller;
ALTER TABLE ai.ai_action ADD CONSTRAINT ai_action_caller CHECK (caller_kind IN ('ui', 'api', 'mcp', 'automation'));

DROP FUNCTION agents.resolve_run_credential(text, bytea);
REVOKE USAGE ON SCHEMA agents FROM pm_directory;
DROP TABLE agents.emergency_stop;
DROP TABLE agents.agent_run_credential;
DROP TABLE agents.agent_artifact;
DROP TABLE agents.agent_tool_call;
DROP TABLE agents.agent_run_event;
DROP TABLE agents.agent_run;
