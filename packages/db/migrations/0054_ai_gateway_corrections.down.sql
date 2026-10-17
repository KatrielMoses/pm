-- migrate:phase contract
-- Restores the exact 0053 catalog. Checkpoint content removed by 0054 is not restored: user
-- content never belongs in generic execution storage. Attempt snapshots, breach and clipping
-- facts, and a workspace suspension are dropped with their columns.
DROP FUNCTION ai.scrub_dispatch_checkpoints(uuid[]);
REVOKE UPDATE (dispatch_suspended_reason, dispatch_suspended_at, updated_at, version)
  ON ai.ai_provider_config FROM app_worker;
ALTER TABLE ai.ai_provider_config
  DROP CONSTRAINT ai_provider_config_suspension,
  DROP COLUMN dispatch_suspended_at,
  DROP COLUMN dispatch_suspended_reason;
ALTER TABLE ai.ai_dispatch
  DROP CONSTRAINT ai_dispatch_breach_shape,
  DROP CONSTRAINT ai_dispatch_failure_detail,
  DROP CONSTRAINT ai_dispatch_snapshots,
  DROP COLUMN failure_detail,
  DROP COLUMN clipped_locally,
  DROP COLUMN bound_breach,
  DROP COLUMN capability_snapshot,
  DROP COLUMN price_snapshot;
