-- migrate:phase contract
-- Restores the exact 0061 catalog. Rolling back would strand open runs (queued, running, or waiting
-- for a delay or a reconciliation) and the liability of what they may have sent, so the rollback
-- refuses, with counts, while any run is open or any automation notice notification exists (0061
-- cannot represent that type). Forced row-level security is lifted for that one check. AI actions
-- recorded by automations keep their rows but cannot keep the `automation` caller, so they also
-- refuse the rollback.
ALTER TABLE automation.automation_run NO FORCE ROW LEVEL SECURITY;
ALTER TABLE notify.notification NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ai.ai_action NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  n_open bigint;
  n_notices bigint;
  n_ai bigint;
BEGIN
  SELECT count(*) INTO n_open FROM automation.automation_run WHERE status IN ('queued', 'running', 'waiting');
  SELECT count(*) INTO n_notices FROM notify.notification WHERE type = 'automation_notice';
  SELECT count(*) INTO n_ai FROM ai.ai_action WHERE caller_kind = 'automation';
  IF n_open > 0 OR n_notices > 0 OR n_ai > 0 THEN
    RAISE EXCEPTION '0062 cannot be rolled back: % open automation run(s), % automation notice(s), % automation AI action(s)', n_open, n_notices, n_ai
      USING ERRCODE = '55000';
  END IF;
END $$;
ALTER TABLE ai.ai_action FORCE ROW LEVEL SECURITY;
ALTER TABLE notify.notification FORCE ROW LEVEL SECURITY;

REVOKE INSERT ON ai.ai_action, ai.ai_context_ref FROM app_worker;
REVOKE UPDATE (name, status_id, status_category, priority, start_date, target_date, updated_at,
  updated_by_membership_id, version) ON work.project FROM app_worker;
REVOKE INSERT ON relations.record_relationship FROM app_worker;
REVOKE UPDATE (is_primary, rank) ON work.task_assignee FROM app_worker;
REVOKE INSERT ON work.task_assignee FROM app_worker;
REVOKE UPDATE (project_id, parent_task_id, ancestor_ids, depth, title, status_id, status_category, prior_status_id,
  priority, start_date, due_date, rank, updated_at, updated_by_membership_id, version)
  ON work.task FROM app_worker;
ALTER TABLE ai.ai_action DROP CONSTRAINT ai_action_caller;
ALTER TABLE ai.ai_action ADD CONSTRAINT ai_action_caller CHECK (caller_kind IN ('ui', 'api', 'mcp'));

ALTER TABLE notify.scope_default DROP CONSTRAINT scope_default_type_known;
ALTER TABLE notify.scope_default ADD CONSTRAINT scope_default_type_known CHECK (event_type = '*' OR event_type IN
    ('assignment', 'mention', 'comment', 'review_requested', 'approval_decided', 'blocker', 'due_soon',
     'overdue', 'integration_failure', 'automation_failure', 'agent_failure', 'agent_output_ready',
     'spend_threshold', 'permission_changed', 'share_changed', 'briefing_ready', 'export_ready',
     'hidden_dependency_affects_assignee'));
ALTER TABLE notify.preference DROP CONSTRAINT preference_type_known;
ALTER TABLE notify.preference ADD CONSTRAINT preference_type_known CHECK (event_type = '*' OR event_type IN
    ('assignment', 'mention', 'comment', 'review_requested', 'approval_decided', 'blocker', 'due_soon',
     'overdue', 'integration_failure', 'automation_failure', 'agent_failure', 'agent_output_ready',
     'spend_threshold', 'permission_changed', 'share_changed', 'briefing_ready', 'export_ready',
     'hidden_dependency_affects_assignee'));
ALTER TABLE notify.notification DROP CONSTRAINT notification_type_known;
ALTER TABLE notify.notification ADD CONSTRAINT notification_type_known CHECK (type IN
    ('assignment', 'mention', 'comment', 'review_requested', 'approval_decided', 'blocker', 'due_soon',
     'overdue', 'integration_failure', 'automation_failure', 'agent_failure', 'agent_output_ready',
     'spend_threshold', 'permission_changed', 'share_changed', 'briefing_ready', 'export_ready',
     'hidden_dependency_affects_assignee'));

DROP FUNCTION exec_dispatch.discover_automation_due(timestamptz, integer);
DROP FUNCTION access.bump_permission_epoch(text, uuid);
DROP TABLE automation.usage_period;
DROP TABLE automation.trigger_schedule;
DROP TABLE automation.standing_approval;
DROP TABLE automation.automation_step_run;
DROP TABLE automation.automation_run;
ALTER TABLE automation.automation DROP CONSTRAINT automation_active_revision_fkey;
DROP TABLE automation.automation_revision;
DROP FUNCTION automation.revision_immutable();
DROP TABLE automation.automation;
DROP SCHEMA automation;
