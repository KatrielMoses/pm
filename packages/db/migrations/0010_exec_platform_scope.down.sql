-- The definer functions are owned by pm_scheduler; act as it (SET-only membership) to replace them.
SET LOCAL ROLE pm_scheduler;
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
  LIMIT least(greatest(p_limit, 1), 1000)
$$;
SET LOCAL ROLE pm_owner;

-- claim_jobs keeps the NULL-safe join: identical results when no platform rows exist.
DROP POLICY platform_scope ON exec.idempotency_key;
DELETE FROM exec.idempotency_key WHERE workspace_id IS NULL;
ALTER TABLE exec.idempotency_key ADD CONSTRAINT idempotency_key_scope_key UNIQUE (workspace_id, principal_id, key);
ALTER TABLE exec.idempotency_key DROP CONSTRAINT idempotency_key_scope_unique;
ALTER TABLE exec.idempotency_key DROP CONSTRAINT idempotency_key_platform_without_operation;
ALTER TABLE exec.idempotency_key ALTER COLUMN workspace_id SET NOT NULL;
DROP POLICY platform_scope ON exec.job;
DELETE FROM exec.job WHERE workspace_id IS NULL;
DROP INDEX exec.job_active_dedupe_scoped;
CREATE UNIQUE INDEX job_active_dedupe ON exec.job (workspace_id, queue, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('queued', 'leased', 'retry_scheduled');
ALTER TABLE exec.job DROP CONSTRAINT job_platform_without_operation;
ALTER TABLE exec.job ALTER COLUMN workspace_id SET NOT NULL;
DROP FUNCTION exec.in_platform_scope();
