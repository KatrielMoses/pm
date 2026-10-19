-- migrate:phase expand
-- Safe recovery of external effects (P8-W0, ADR-0045; closes REL-FU-7A-01). The effect ledger
-- gains an owned in-flight state (`dispatching`) with a durable claim taken before any I/O, typed
-- proof for `failed` (not sent), a reason for every `unknown`, fenced late-result evidence, and a
-- destination fingerprint. An effect that may have left is never resent automatically to an
-- unsafe destination: it waits for an authorized reconciliation.
--
-- Existing rows: a `pending` row with attempts, and every `failed` row (the old worker recorded any
-- error as failed), may have been dispatched; the old schema has no dispatch marker, so they are
-- reclassified as `unknown` (`legacy_attempted`). Unsafe ones wait for reconciliation; safe-class
-- ones are retried with their stable key. Never-attempted pending rows are unchanged. No attempt
-- count, key, or decision is reset.

ALTER TYPE exec.effect_state ADD VALUE IF NOT EXISTS 'dispatching' AFTER 'pending';

ALTER TABLE exec.external_effect
  ADD COLUMN destination_fingerprint text,
  ADD COLUMN claim_token uuid,
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN claim_until timestamptz,
  ADD COLUMN not_sent_code text,
  ADD COLUMN uncertainty_reason text,
  ADD COLUMN late_outcome text,
  ADD COLUMN late_outcome_at timestamptz,
  ADD CONSTRAINT external_effect_destination_fingerprint CHECK (
    destination_fingerprint IS NULL OR destination_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT external_effect_not_sent_code CHECK (
    not_sent_code IS NULL OR not_sent_code IN ('refused_before_send', 'rejected_by_receiver', 'precondition_failed')),
  ADD CONSTRAINT external_effect_uncertainty_reason CHECK (
    uncertainty_reason IS NULL OR uncertainty_reason IN
      ('outcome_unknown', 'unproven_failure', 'abandoned_claim', 'legacy_attempted')),
  ADD CONSTRAINT external_effect_late_outcome CHECK (
    (late_outcome IS NULL) = (late_outcome_at IS NULL)
    AND (late_outcome IS NULL OR late_outcome IN ('sent', 'unknown', 'failed'))),
  ADD CONSTRAINT external_effect_claim_pair CHECK ((claim_token IS NULL) = (claim_until IS NULL));
COMMENT ON TABLE exec.external_effect IS 'Effect ledger: stable key recorded before any attempt; a durable claim (dispatching) before any I/O; unknown after possible dispatch; failed only with proof of not sent; unsafe unknown outcomes wait for authorized reconciliation (never exactly once).';

-- Allowed transitions (0D §5.4, ADR-0045). Terminal: confirmed, cancelled.
--   pending     -> dispatching | cancelled
--   dispatching -> sent | unknown | failed (proof)            (fenced to the claim)
--   sent        -> confirmed | unknown
--   unknown     -> dispatching (safe classes) | pending (retry decision, or a safe class)
--                  | confirmed | sent | failed (proof) | cancelled (abandon decision)
--   failed      -> dispatching | pending | cancelled
-- `dispatching` always holds a claim; `failed` always carries its proof; `unknown` its reason.
CREATE OR REPLACE FUNCTION exec.external_effect_transition_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.operation_id <> OLD.operation_id
     OR NEW.effect_key <> OLD.effect_key OR NEW.destination_class <> OLD.destination_class
     OR (OLD.destination_fingerprint IS NOT NULL
         AND NEW.destination_fingerprint IS DISTINCT FROM OLD.destination_fingerprint)
     OR NEW.attempt_count < OLD.attempt_count
     OR NEW.provider_idempotency_key IS DISTINCT FROM OLD.provider_idempotency_key THEN
    RAISE EXCEPTION 'external effect identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.state::text = 'dispatching' AND (NEW.claim_token IS NULL OR NEW.claimed_at IS NULL) THEN
    RAISE EXCEPTION 'a dispatching effect needs its claim' USING ERRCODE = '55000';
  END IF;
  IF NEW.state::text <> 'dispatching' AND NEW.claim_token IS NOT NULL THEN
    RAISE EXCEPTION 'only a dispatching effect holds a claim' USING ERRCODE = '55000';
  END IF;
  IF NEW.state = OLD.state THEN
    IF OLD.state::text = 'dispatching' AND NEW.claim_token IS DISTINCT FROM OLD.claim_token THEN
      RAISE EXCEPTION 'a claim is replaced only through recovery' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT (
       (OLD.state::text = 'pending' AND NEW.state::text IN ('dispatching', 'cancelled'))
    OR (OLD.state::text = 'dispatching' AND NEW.state::text IN ('sent', 'unknown', 'failed'))
    OR (OLD.state::text = 'sent' AND NEW.state::text IN ('confirmed', 'unknown'))
    OR (OLD.state::text = 'unknown' AND NEW.state::text IN
         ('dispatching', 'pending', 'confirmed', 'sent', 'failed', 'cancelled'))
    OR (OLD.state::text = 'failed' AND NEW.state::text IN ('dispatching', 'pending', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'illegal external effect transition' USING ERRCODE = '55000';
  END IF;
  IF NEW.state::text = 'dispatching' AND NEW.attempt_count <> OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'every claim is one counted attempt' USING ERRCODE = '55000';
  END IF;
  IF NEW.state::text = 'failed' AND NEW.not_sent_code IS NULL THEN
    RAISE EXCEPTION 'failed means proven not sent' USING ERRCODE = '55000';
  END IF;
  IF NEW.state::text = 'unknown' AND NEW.uncertainty_reason IS NULL THEN
    RAISE EXCEPTION 'an unknown outcome needs its reason' USING ERRCODE = '55000';
  END IF;
  -- An unknown outcome on an unsafe destination is never retried automatically: moving it back to
  -- pending needs a recorded retry decision, and it is never claimed directly.
  IF OLD.state::text = 'unknown' AND OLD.destination_class = 'unsafe' AND (
       NEW.state::text = 'dispatching'
    OR (NEW.state::text = 'pending' AND NEW.reconciliation_decision IS DISTINCT FROM 'retry')) THEN
    RAISE EXCEPTION 'unsafe effect with unknown outcome needs reconciliation' USING ERRCODE = '55000';
  END IF;
  -- A possibly-sent effect is never relabelled cancelled without an abandon decision.
  IF OLD.state::text = 'unknown' AND NEW.state::text = 'cancelled'
     AND NEW.reconciliation_decision IS DISTINCT FROM 'abandon' THEN
    RAISE EXCEPTION 'an unknown effect is abandoned only by decision' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

-- Legacy rows (see header): reclassified without resetting anything. This one migration-time
-- relabel is the only pending/failed -> unknown change the guard does not allow at run time, so
-- the guard and forced row-level security are lifted for this statement and restored.
ALTER TABLE exec.external_effect NO FORCE ROW LEVEL SECURITY;
ALTER TABLE exec.external_effect DISABLE TRIGGER external_effect_transition_guard;
UPDATE exec.external_effect
   SET state = 'unknown', uncertainty_reason = 'legacy_attempted', updated_at = now(),
       version = version + 1
 WHERE (state = 'pending' AND attempt_count > 0) OR state = 'failed';
ALTER TABLE exec.external_effect ENABLE TRIGGER external_effect_transition_guard;
ALTER TABLE exec.external_effect FORCE ROW LEVEL SECURITY;

-- File work discovery also finds object deletions whose outcome is unknown or whose claim is held
-- (naturally idempotent: the sweep recovers and retries them with the same key).
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
     WHERE e.effect_key LIKE 'object:%' AND e.state::text IN ('pending', 'failed', 'unknown', 'dispatching')
     GROUP BY e.workspace_id
  ) w
  GROUP BY w.workspace_id
  ORDER BY min(w.due), w.workspace_id
  LIMIT least(greatest(p_limit, 1), 1000)
$$;
SET LOCAL ROLE pm_owner;
