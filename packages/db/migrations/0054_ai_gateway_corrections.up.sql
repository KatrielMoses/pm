-- migrate:phase expand
-- Phase 7A corrective review 01 (0B ADR-45, 0D PL-47): attempt-level price and capability
-- snapshots, bound-breach and local-clipping facts, a workspace suspension after a breach, and the
-- removal of AI user content from generic execution checkpoints. Builds on 0053_ai_gateway; no
-- earlier file changes.

-- ---------------------------------------------------------------------------------------------
-- Attempt snapshots and settlement facts. Every attempt is settled and reconciled against the
-- price and capabilities it was dispatched under, never against the registry as it is later.
-- Rows written before this migration carry no attempt snapshot and settle against their
-- action's immutable snapshot.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE ai.ai_dispatch
  ADD COLUMN price_snapshot jsonb,
  ADD COLUMN capability_snapshot jsonb,
  ADD COLUMN bound_breach boolean NOT NULL DEFAULT false,
  ADD COLUMN clipped_locally boolean NOT NULL DEFAULT false,
  ADD COLUMN failure_detail text,
  ADD CONSTRAINT ai_dispatch_snapshots CHECK (
    (price_snapshot IS NULL OR (jsonb_typeof(price_snapshot) = 'object' AND pg_column_size(price_snapshot) <= 2048))
    AND (capability_snapshot IS NULL OR (jsonb_typeof(capability_snapshot) = 'object' AND pg_column_size(capability_snapshot) <= 1024))
    AND ((price_snapshot IS NULL) = (capability_snapshot IS NULL))),
  ADD CONSTRAINT ai_dispatch_failure_detail CHECK (failure_detail IS NULL OR failure_detail IN
    ('protocol_invalid', 'stream_overflow', 'unsupported_stop', 'usage_invalid', 'configuration_changed',
     'bound_unverified', 'bound_breach', 'content_unavailable')),
  ADD CONSTRAINT ai_dispatch_breach_shape CHECK (NOT bound_breach OR failure_detail = 'bound_breach');

-- A provider that reports usage beyond a reserved bound pauses AI for the workspace until an
-- owner or administrator reviews it.
ALTER TABLE ai.ai_provider_config
  ADD COLUMN dispatch_suspended_reason text,
  ADD COLUMN dispatch_suspended_at timestamptz,
  ADD CONSTRAINT ai_provider_config_suspension CHECK (
    (dispatch_suspended_reason IS NULL) = (dispatch_suspended_at IS NULL)
    AND (dispatch_suspended_reason IS NULL OR dispatch_suspended_reason IN ('bound_breach')));
GRANT UPDATE (dispatch_suspended_reason, dispatch_suspended_at, updated_at, version)
  ON ai.ai_provider_config TO app_worker;

-- ---------------------------------------------------------------------------------------------
-- Generic execution checkpoints hold references only. An AI dispatch job's checkpoint once kept
-- the rendered prompt and source content (`system`, `user`) and the key reference (`keyRef`) of
-- each `ai.prepare.<n>` step. This function removes exactly those fields from the AI dispatch
-- jobs of the given operations in the current workspace, leaving every other step and fact. The
-- API role (departure) cannot update jobs itself, so it calls this definer function.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION ai.scrub_dispatch_checkpoints(p_operation_ids uuid[]) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  n integer;
BEGIN
  UPDATE exec.job j
     SET checkpoint = (
           SELECT jsonb_object_agg(e.k, CASE
                    WHEN e.k LIKE 'ai.prepare.%' AND jsonb_typeof(e.v) = 'object'
                      THEN e.v - 'system' - 'user' - 'keyRef'
                    ELSE e.v END)
             FROM jsonb_each(j.checkpoint) AS e(k, v)),
         updated_at = now()
   WHERE j.workspace_id = exec.current_workspace_id()
     AND j.kind = 'ai.action.dispatch'
     AND j.operation_id = ANY (p_operation_ids)
     AND j.checkpoint IS NOT NULL
     AND EXISTS (
           SELECT 1 FROM jsonb_each(j.checkpoint) AS e(k, v)
            WHERE e.k LIKE 'ai.prepare.%' AND jsonb_typeof(e.v) = 'object'
              AND (e.v ? 'system' OR e.v ? 'user' OR e.v ? 'keyRef'));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION ai.scrub_dispatch_checkpoints(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.scrub_dispatch_checkpoints(uuid[]) TO app_rw, app_worker;

-- One-time cleanup of copies written before this migration, in every workspace, including
-- actions the old eraser already marked erased. exec.job forces tenant row-level security even on
-- its owner, and the migration role (pm_owner) is subject to it: without a workspace context it
-- reaches no rows. As in 0041, the force is lifted for this one statement inside the migration
-- transaction and set again straight after (the catalog comparison in the migration test proves it
-- is restored). Nothing outside this transaction sees the lifted state; no policy or grant changes.
ALTER TABLE exec.job NO FORCE ROW LEVEL SECURITY;
UPDATE exec.job j
   SET checkpoint = (
         SELECT jsonb_object_agg(e.k, CASE
                  WHEN e.k LIKE 'ai.prepare.%' AND jsonb_typeof(e.v) = 'object'
                    THEN e.v - 'system' - 'user' - 'keyRef'
                  ELSE e.v END)
           FROM jsonb_each(j.checkpoint) AS e(k, v)),
       updated_at = now()
 WHERE j.kind = 'ai.action.dispatch'
   AND j.checkpoint IS NOT NULL
   AND EXISTS (
         SELECT 1 FROM jsonb_each(j.checkpoint) AS e(k, v)
          WHERE e.k LIKE 'ai.prepare.%' AND jsonb_typeof(e.v) = 'object'
            AND (e.v ? 'system' OR e.v ? 'user' OR e.v ? 'keyRef'));
ALTER TABLE exec.job FORCE ROW LEVEL SECURITY;
