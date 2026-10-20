-- migrate:phase contract
-- Restores the exact 0063 catalog. Rolling back would delete configured agents, their revisions,
-- grants, connectors (with secret-store references the rollback cannot destroy), tests, and task
-- assignments, so the rollback refuses, with counts, while any profile or assignment exists.
-- Forced row-level security is lifted for that one check.
ALTER TABLE agents.agent_profile NO FORCE ROW LEVEL SECURITY;
ALTER TABLE agents.agent_assignment NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  n_profiles bigint;
  n_assignments bigint;
BEGIN
  SELECT count(*) INTO n_profiles FROM agents.agent_profile;
  SELECT count(*) INTO n_assignments FROM agents.agent_assignment;
  IF n_profiles > 0 OR n_assignments > 0 THEN
    RAISE EXCEPTION '0064 cannot be rolled back: % agent profile(s), % agent assignment(s)', n_profiles, n_assignments
      USING ERRCODE = '55000';
  END IF;
END $$;

DROP TABLE agents.agent_assignment_revision CASCADE;
DROP TABLE agents.agent_assignment CASCADE;
DROP TABLE agents.agent_connector_test;
DROP TABLE agents.agent_connector;
DROP TABLE agents.agent_tool_grant;
DROP TABLE agents.agent_scope_grant;
DROP TABLE agents.agent_profile_revision CASCADE;
DROP TABLE agents.agent_profile;
DROP FUNCTION agents.revision_immutable();
DROP SCHEMA agents;
