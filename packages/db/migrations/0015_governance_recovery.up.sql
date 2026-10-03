-- migrate:phase expand
-- Retention policy values, the post-restore recovery gate, the 1B buffer verification log, and
-- payload-free discovery for purge scheduling and audit chain verification (Phase 1F).
--
-- No duration is chosen here: every period is a nullable value. NULL means "not decided" and the
-- dependent job does nothing (0B ADR-11).

CREATE SCHEMA governance;
COMMENT ON SCHEMA governance IS 'Retention policy, holds, and deletion workflows (0B module governance). 1F creates retention_policy only.';
GRANT USAGE ON SCHEMA governance TO app_rw, app_worker, pm_scheduler;

-- ---------------------------------------------------------------------------------------------
-- governance.retention_policy: per-workspace values by retention class. The most specific row in
-- force wins over the platform default (configuration); a NULL period disables the purge.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE governance.retention_policy (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  retention_class text NOT NULL,
  period interval,
  source text NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT retention_policy_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT retention_policy_class_known CHECK (retention_class IN
    ('R-LIVE', 'R-EVIDENCE', 'R-AUDIT', 'R-EXEC', 'R-PERSONAL', 'R-BILLING', 'R-DERIVED', 'R-EPHEMERAL', 'R-PLATFORM')),
  CONSTRAINT retention_policy_period_positive CHECK (period IS NULL OR period > interval '0'),
  CONSTRAINT retention_policy_source_known CHECK (source IN ('plan', 'workspace')),
  CONSTRAINT retention_policy_unique UNIQUE (workspace_id, retention_class, effective_from)
);
COMMENT ON TABLE governance.retention_policy IS 'Named nullable retention values per class (0B governance.retention_policy). NULL = undecided: purge disabled.';

ALTER TABLE governance.retention_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance.retention_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON governance.retention_policy
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());
CREATE POLICY scheduler_discovery ON governance.retention_policy FOR SELECT TO pm_scheduler USING (true);

REVOKE ALL ON governance.retention_policy FROM PUBLIC;
-- Configuring values is `retention.configure` (owner, step-up; 1D/10C): no write grant yet.
GRANT SELECT ON governance.retention_policy TO app_rw, app_worker;
GRANT SELECT (workspace_id, retention_class, period, effective_from) ON governance.retention_policy TO pm_scheduler;

-- ---------------------------------------------------------------------------------------------
-- ops.recovery_gate: a restored environment stays closed until purge-ledger entries newer than the
-- backup point are re-applied (0B §8.11). Readiness fails while replay is required.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE ops.recovery_gate (
  id smallint PRIMARY KEY DEFAULT 1,
  state text NOT NULL DEFAULT 'open',
  backup_point timestamptz,
  replayed_through timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recovery_gate_singleton CHECK (id = 1),
  CONSTRAINT recovery_gate_state_known CHECK (state IN ('open', 'replay_required')),
  CONSTRAINT recovery_gate_backup_point CHECK (state = 'open' OR backup_point IS NOT NULL)
);
INSERT INTO ops.recovery_gate (id, state) VALUES (1, 'open');
REVOKE ALL ON ops.recovery_gate FROM PUBLIC;
GRANT SELECT ON ops.recovery_gate TO app_rw, app_worker;
-- State changes run as restore_operator (SET ROLE pm_owner) in the restore runbook only.

-- ---------------------------------------------------------------------------------------------
-- audit.buffer_verification: append-only results of verifying the 1B buffer against the sink.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE audit.buffer_verification (
  id uuid NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL,
  buffer_count bigint NOT NULL,
  sink_count bigint NOT NULL,
  buffer_digest text NOT NULL,
  sink_digest text NOT NULL,
  per_day jsonb NOT NULL,
  PRIMARY KEY (verified_at, id),
  CONSTRAINT buffer_verification_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT buffer_verification_outcome_known CHECK (outcome IN ('verified', 'mismatch')),
  CONSTRAINT buffer_verification_digests CHECK (buffer_digest ~ '^sha256:[0-9a-f]{64}$' AND sink_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT buffer_verification_per_day CHECK (jsonb_typeof(per_day) = 'array'),
  CONSTRAINT buffer_verification_consistent CHECK (outcome = 'mismatch' OR (buffer_count = sink_count AND buffer_digest = sink_digest))
);
COMMENT ON TABLE audit.buffer_verification IS 'ADR-0008 handoff: count and checksum verification of identity.security_event_buffer against audit.security_event. Retirement requires a verified row.';
CREATE TRIGGER buffer_verification_append_only BEFORE UPDATE OR DELETE ON audit.buffer_verification
  FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER buffer_verification_no_truncate BEFORE TRUNCATE ON audit.buffer_verification
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_mutation();
REVOKE ALL ON audit.buffer_verification FROM PUBLIC;
GRANT SELECT, INSERT ON audit.buffer_verification TO app_worker;
GRANT SELECT ON audit.buffer_verification TO app_rw;

-- ---------------------------------------------------------------------------------------------
-- Payload-free discovery (dispatcher only; identifiers and counts, never content).
-- ---------------------------------------------------------------------------------------------
CREATE POLICY scheduler_discovery ON audit.audit_event FOR SELECT TO pm_scheduler USING (true);
GRANT USAGE ON SCHEMA audit TO pm_scheduler;
GRANT SELECT (workspace_id) ON audit.audit_event TO pm_scheduler;

-- Trashed batches whose recovery period (R-LIVE) has passed. The workspace's most specific policy
-- row in force wins; otherwise the platform default argument. A NULL effective period selects
-- nothing, so an undecided policy never purges. Held batches are never selected.
CREATE FUNCTION exec_dispatch.discover_purge_due(p_platform_period interval, p_limit integer)
  RETURNS TABLE (workspace_id uuid, batch_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT b.workspace_id, b.id
  FROM core.deletion_batch b
  LEFT JOIN LATERAL (
    SELECT true AS found, p.period FROM governance.retention_policy p
    WHERE p.workspace_id = b.workspace_id AND p.retention_class = 'R-LIVE' AND p.effective_from <= now()
    ORDER BY p.effective_from DESC LIMIT 1
  ) wp ON true
  WHERE b.state = 'trashed' AND NOT b.hold
    AND CASE WHEN wp.found THEN wp.period ELSE p_platform_period END IS NOT NULL
    AND b.trashed_at + CASE WHEN wp.found THEN wp.period ELSE p_platform_period END <= now()
  ORDER BY b.trashed_at, b.id
  LIMIT least(greatest(p_limit, 1), 1000)
$$;

CREATE FUNCTION exec_dispatch.purge_backlog()
  RETURNS TABLE (state text, batches bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT b.state::text, count(*) FROM core.deletion_batch b
  WHERE b.state IN ('trashed', 'purging') GROUP BY b.state
$$;

-- Workspaces with audit history, in id order (keyset), for per-workspace chain verification.
CREATE FUNCTION exec_dispatch.discover_audit_workspaces(p_after uuid, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT DISTINCT a.workspace_id FROM audit.audit_event a
  WHERE p_after IS NULL OR a.workspace_id > p_after
  ORDER BY a.workspace_id
  LIMIT least(greatest(p_limit, 1), 1000)
$$;

REVOKE ALL ON FUNCTION exec_dispatch.discover_purge_due(interval, integer),
  exec_dispatch.purge_backlog(), exec_dispatch.discover_audit_workspaces(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION exec_dispatch.discover_purge_due(interval, integer),
  exec_dispatch.purge_backlog(), exec_dispatch.discover_audit_workspaces(uuid, integer) TO dispatcher;
ALTER FUNCTION exec_dispatch.discover_purge_due(interval, integer) OWNER TO pm_scheduler;
ALTER FUNCTION exec_dispatch.purge_backlog() OWNER TO pm_scheduler;
ALTER FUNCTION exec_dispatch.discover_audit_workspaces(uuid, integer) OWNER TO pm_scheduler;
