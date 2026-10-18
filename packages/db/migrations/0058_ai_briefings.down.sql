-- migrate:phase contract
-- Restores the exact 0057 catalog. Briefings, schedules, and corrections cannot be represented in
-- 0057, so the rollback refuses while any exists. Business records are not affected.
ALTER TABLE ai.briefing_schedule NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ai.briefing NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ai.briefing_schedule) OR EXISTS (SELECT 1 FROM ai.briefing) THEN
    RAISE EXCEPTION 'briefings exist; 0058 cannot be rolled back' USING ERRCODE = 'P0001';
  END IF;
END $$;
ALTER TABLE ai.briefing FORCE ROW LEVEL SECURITY;
ALTER TABLE ai.briefing_schedule FORCE ROW LEVEL SECURITY;

REVOKE SELECT ON timetrack.timesheet_line FROM app_worker;
DROP FUNCTION exec_dispatch.discover_briefing_retention_work(timestamptz, integer);
DROP FUNCTION exec_dispatch.discover_briefing_work(timestamptz, integer);
DROP TABLE ai.briefing_evidence;
DROP TABLE ai.briefing_correction_event;
DROP TABLE ai.briefing_correction;
DROP TABLE ai.briefing_statement;
DROP TABLE ai.briefing;
DROP TABLE ai.briefing_schedule;
