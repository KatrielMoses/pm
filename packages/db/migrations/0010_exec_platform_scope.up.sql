-- migrate:phase expand
-- Platform-scoped (workspace-free) jobs and account-level idempotency keys (1B). 1A ADR-0007 D5
-- deferred platform jobs; relaxing NOT NULL is the additive change it anticipated.
--
-- Safety model: a platform row has workspace_id IS NULL and is visible only inside an explicit
-- platform transaction (app.platform_scope = 'platform' AND no workspace context). A platform
-- transaction can never see tenant rows (their predicate needs a workspace context), and a tenant
-- transaction can never see platform rows. There is still no wildcard or unset-context mode.

CREATE FUNCTION exec.in_platform_scope() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT current_setting('app.platform_scope', true) = 'platform'
               AND NULLIF(current_setting('app.workspace_id', true), '') IS NULL $$;
COMMENT ON FUNCTION exec.in_platform_scope() IS 'True only inside an explicit platform transaction without workspace context.';

-- Jobs ---------------------------------------------------------------------------------------
ALTER TABLE exec.job ALTER COLUMN workspace_id DROP NOT NULL;
-- Platform jobs never belong to a (tenant) logical operation.
ALTER TABLE exec.job ADD CONSTRAINT job_platform_without_operation
  CHECK (workspace_id IS NOT NULL OR operation_id IS NULL);
CREATE POLICY platform_scope ON exec.job
  USING (workspace_id IS NULL AND exec.in_platform_scope())
  WITH CHECK (workspace_id IS NULL AND exec.in_platform_scope());
-- One active platform job per (queue, dedupe key): NULL workspaces must not be distinct.
CREATE UNIQUE INDEX job_active_dedupe_scoped ON exec.job (workspace_id, queue, dedupe_key) NULLS NOT DISTINCT
  WHERE dedupe_key IS NOT NULL AND state IN ('queued', 'leased', 'retry_scheduled');
DROP INDEX exec.job_active_dedupe;

-- Idempotency keys: account-level routes use (account, key) (0D §5.2) ----------------------------
ALTER TABLE exec.idempotency_key ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE exec.idempotency_key ADD CONSTRAINT idempotency_key_platform_without_operation
  CHECK (workspace_id IS NOT NULL OR operation_id IS NULL);
ALTER TABLE exec.idempotency_key ADD CONSTRAINT idempotency_key_scope_unique
  UNIQUE NULLS NOT DISTINCT (workspace_id, principal_id, key);
ALTER TABLE exec.idempotency_key DROP CONSTRAINT idempotency_key_scope_key;
CREATE POLICY platform_scope ON exec.idempotency_key
  USING (workspace_id IS NULL AND exec.in_platform_scope())
  WITH CHECK (workspace_id IS NULL AND exec.in_platform_scope());

-- Scheduling functions: fairness caps must count the platform (NULL) group too; maintenance
-- discovery returns tenant workspaces only (platform maintenance runs in a platform transaction).
-- The definer functions are owned by pm_scheduler; act as it (SET-only membership) to replace them.
SET LOCAL ROLE pm_scheduler;
CREATE OR REPLACE FUNCTION exec_dispatch.claim_jobs(
  p_queue text, p_worker_id text, p_limit integer, p_workspace_cap integer, p_lease_ms integer)
  RETURNS TABLE (job_id uuid, workspace_id uuid, lease_token uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
#variable_conflict use_column
BEGIN
  IF p_queue !~ '^[a-z_]{1,64}$' OR p_worker_id !~ '^wrk_[0-9a-f]{16}$'
     OR p_limit NOT BETWEEN 1 AND 500 OR p_workspace_cap NOT BETWEEN 1 AND 1000
     OR p_lease_ms NOT BETWEEN 1000 AND 3600000 THEN
    RAISE EXCEPTION 'invalid claim parameters' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pm.exec.claim:' || p_queue, 0));
  RETURN QUERY
  WITH inflight AS (
    SELECT j.workspace_id, count(*)::integer AS n
    FROM exec.job j
    WHERE j.queue = p_queue AND j.state = 'leased'
    GROUP BY j.workspace_id
  ), ranked AS (
    SELECT j.id, j.workspace_id, j.run_at,
           row_number() OVER (PARTITION BY j.workspace_id ORDER BY j.run_at, j.id) AS rnk
    FROM exec.job j
    WHERE j.queue = p_queue AND j.state IN ('queued', 'retry_scheduled')
      AND j.run_at <= now() AND j.attempts < j.max_attempts
  ), candidates AS (
    SELECT r.id
    FROM ranked r LEFT JOIN inflight i ON i.workspace_id IS NOT DISTINCT FROM r.workspace_id
    WHERE r.rnk + coalesce(i.n, 0) <= p_workspace_cap
    ORDER BY r.rnk, r.run_at, r.id
    LIMIT p_limit
  ), locked AS (
    SELECT j.id
    FROM exec.job j JOIN candidates c ON c.id = j.id
    WHERE j.state IN ('queued', 'retry_scheduled')
    FOR UPDATE OF j SKIP LOCKED
  )
  UPDATE exec.job j
     SET state = 'leased',
         lease_token = gen_random_uuid(),
         lease_owner = p_worker_id,
         lease_until = now() + make_interval(secs => p_lease_ms / 1000.0),
         heartbeat_at = now(),
         attempts = j.attempts + 1,
         updated_at = now()
    FROM locked l
   WHERE j.id = l.id
  RETURNING j.id, j.workspace_id, j.lease_token;
END $$;

CREATE OR REPLACE FUNCTION exec_dispatch.discover_maintenance_workspaces(p_cutoff timestamptz, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT w.workspace_id FROM (
    SELECT o.workspace_id FROM exec.outbox_event o WHERE o.dispatched_at < p_cutoff
    UNION
    SELECT k.workspace_id FROM exec.idempotency_key k WHERE k.expires_at < now()
    UNION
    SELECT r.workspace_id FROM exec.inbox_receipt r WHERE r.processed_at < p_cutoff
    UNION
    SELECT j.workspace_id FROM exec.job j WHERE j.finished_at < p_cutoff
  ) w
  WHERE w.workspace_id IS NOT NULL
  LIMIT least(greatest(p_limit, 1), 1000)
$$;
SET LOCAL ROLE pm_owner;

