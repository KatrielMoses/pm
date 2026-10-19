-- migrate:phase contract
-- Restores the exact 0060 catalog. The 0060 ledger cannot represent an owned in-flight claim
-- (`dispatching`) or a stale claimant's late evidence; rolling back would turn a possibly-sent
-- effect into retryable work or drop evidence. So the rollback refuses, with counts, while any
-- dispatching row or late evidence exists (settle or reconcile them first). Forced row-level
-- security is lifted for that one check. Unknown and failed rows are representable in 0060 (an
-- unknown unsafe effect still waits there) and keep their states; their reasons and proof codes
-- are dropped with the columns.
ALTER TABLE exec.external_effect NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  n_claims bigint;
  n_late bigint;
BEGIN
  SELECT count(*) FILTER (WHERE state::text = 'dispatching'), count(*) FILTER (WHERE late_outcome IS NOT NULL)
    INTO n_claims, n_late FROM exec.external_effect;
  IF n_claims > 0 OR n_late > 0 THEN
    RAISE EXCEPTION '0061 cannot be rolled back: % effect(s) are dispatching and % carry late evidence; settle or reconcile them first', n_claims, n_late
      USING ERRCODE = '55000';
  END IF;
END $$;
ALTER TABLE exec.external_effect FORCE ROW LEVEL SECURITY;

-- The definer function is owned by pm_scheduler; act as it (SET-only membership) to replace it.
SET LOCAL ROLE pm_scheduler;
CREATE OR REPLACE FUNCTION exec_dispatch.discover_file_work(p_now timestamptz, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT w.workspace_id FROM (
    SELECT s.workspace_id, min(s.expires_at) AS due FROM files.upload_session s
     WHERE s.state IN ('initiated', 'uploaded') AND s.expires_at <= p_now
     GROUP BY s.workspace_id
    UNION ALL
    SELECT e.workspace_id, min(e.created_at) FROM exec.external_effect e
     WHERE e.effect_key LIKE 'object:%' AND e.state IN ('pending', 'failed')
     GROUP BY e.workspace_id
  ) w
  GROUP BY w.workspace_id
  ORDER BY min(w.due), w.workspace_id
  LIMIT least(greatest(p_limit, 1), 1000)
$$;
SET LOCAL ROLE pm_owner;

-- The 0060 (0007) transition guard, restored exactly.
--   pending -> sent | unknown | failed | cancelled
--   sent    -> confirmed | unknown
--   unknown -> sent | confirmed | failed | cancelled | pending (retry: safe classes, or human decision)
--   failed  -> pending (retry) | cancelled
CREATE OR REPLACE FUNCTION exec.external_effect_transition_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.operation_id <> OLD.operation_id
     OR NEW.effect_key <> OLD.effect_key OR NEW.destination_class <> OLD.destination_class THEN
    RAISE EXCEPTION 'external effect identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;
  IF NOT (
       (OLD.state = 'pending' AND NEW.state IN ('sent', 'unknown', 'failed', 'cancelled'))
    OR (OLD.state = 'sent' AND NEW.state IN ('confirmed', 'unknown'))
    OR (OLD.state = 'unknown' AND NEW.state IN ('sent', 'confirmed', 'failed', 'cancelled', 'pending'))
    OR (OLD.state = 'failed' AND NEW.state IN ('pending', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'illegal external effect transition' USING ERRCODE = '55000';
  END IF;
  -- An unknown outcome on an unsafe destination is never retried automatically: moving it back to
  -- pending requires a recorded human reconciliation decision.
  IF OLD.state = 'unknown' AND NEW.state = 'pending' AND OLD.destination_class = 'unsafe'
     AND NEW.reconciliation_decision IS DISTINCT FROM 'retry' THEN
    RAISE EXCEPTION 'unsafe effect with unknown outcome needs reconciliation' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON TABLE exec.external_effect IS 'Effect ledger: stable key recorded before any attempt; unknown outcomes on unsafe destinations wait for reconciliation (never exactly once).';
ALTER TABLE exec.external_effect
  DROP CONSTRAINT external_effect_claim_pair,
  DROP CONSTRAINT external_effect_late_outcome,
  DROP CONSTRAINT external_effect_uncertainty_reason,
  DROP CONSTRAINT external_effect_not_sent_code,
  DROP CONSTRAINT external_effect_destination_fingerprint,
  DROP COLUMN late_outcome_at,
  DROP COLUMN late_outcome,
  DROP COLUMN uncertainty_reason,
  DROP COLUMN not_sent_code,
  DROP COLUMN claim_until,
  DROP COLUMN claimed_at,
  DROP COLUMN claim_token,
  DROP COLUMN destination_fingerprint;

-- The enum loses `dispatching` (no row uses it, checked above): rebuilt with the 0060 values.
ALTER TABLE exec.external_effect ALTER COLUMN state DROP DEFAULT;
CREATE TYPE exec.effect_state_0060 AS ENUM ('pending', 'sent', 'unknown', 'confirmed', 'failed', 'cancelled');
ALTER TABLE exec.external_effect
  ALTER COLUMN state TYPE exec.effect_state_0060 USING state::text::exec.effect_state_0060;
DROP TYPE exec.effect_state;
ALTER TYPE exec.effect_state_0060 RENAME TO effect_state;
ALTER TABLE exec.external_effect ALTER COLUMN state SET DEFAULT 'pending';
