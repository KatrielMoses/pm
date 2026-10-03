-- migrate:phase expand
-- Historical truth (0B §7, 0D §12; Phase 1F). Append-only audit and security events, explicit
-- redaction records, chain checkpoints, and the rebuildable activity projection.
--
-- Enforcement model:
--   * Application roles get SELECT/INSERT only: no UPDATE, DELETE, or TRUNCATE on any audit table.
--   * BEFORE UPDATE/DELETE/TRUNCATE triggers reject every mutation regardless of role (owner and
--     misconfigured-grant mistakes included). The one exception is a value-field redaction of
--     `audit.audit_event.changes`, allowed only when current_user = audit_maintainer AND the
--     transaction-local app.redaction_operation_id is set; structural facts never change.
--   * Partition-ready (0B §10.9): primary keys include the time column; no foreign keys point INTO
--     these tables (redactions and checkpoints reference events by plain keys).
--   * Tamper evidence: per-workspace hash chain (chain_seq, prev_hash, hash) computed by the
--     application writer over RFC 8785 canonical JSON and continuity-checked here on insert.

CREATE SCHEMA audit;
COMMENT ON SCHEMA audit IS 'Append-only historical truth (0B module audit, layer 0): audit events, security events, redactions, activity projection.';
GRANT USAGE ON SCHEMA audit TO app_rw, app_worker, audit_maintainer;

-- ---------------------------------------------------------------------------------------------
-- Classified changes (0B §7.3, 0D §12.1). Every entry carries a per-entry digest (sha256 of the
-- canonical entry without its digest) so a redacted value still has a verifiable fingerprint.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION audit.valid_change_value(v jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT CASE jsonb_typeof(v)
      WHEN 'null' THEN true
      WHEN 'boolean' THEN true
      WHEN 'number' THEN true
      WHEN 'string' THEN char_length(v #>> '{}') <= 2000
      WHEN 'array' THEN jsonb_array_length(v) <= 100 AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v) e
        WHERE jsonb_typeof(e) NOT IN ('string', 'number', 'boolean', 'null')
           OR (jsonb_typeof(e) = 'string' AND char_length(e #>> '{}') > 200))
      ELSE false
    END
  $$;

CREATE FUNCTION audit.valid_changes(changes jsonb) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
  AS $$
DECLARE
  e jsonb;
  keys text[];
  cls text;
  fields text[] := '{}';
BEGIN
  IF jsonb_typeof(changes) <> 'array' OR jsonb_array_length(changes) > 200
     OR octet_length(changes::text) > 65536 THEN
    RETURN false;
  END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(changes) LOOP
    IF jsonb_typeof(e) <> 'object' THEN RETURN false; END IF;
    keys := ARRAY(SELECT jsonb_object_keys(e) ORDER BY 1);
    cls := e->>'class';
    IF jsonb_typeof(e->'field') <> 'string'
       OR (e->>'field') !~ '^[a-z][a-z0-9_]{0,62}(\.[a-z][a-z0-9_]{0,62}){0,3}$'
       OR (e->>'field') = ANY (fields)
       OR cls IS NULL OR cls NOT IN ('plain', 'content', 'personal', 'secret', 'credential_ref')
       OR coalesce(e->>'digest', '') !~ '^sha256:[0-9a-f]{64}$' THEN
      RETURN false;
    END IF;
    fields := fields || (e->>'field');
    -- Secret-looking field names may never carry values (defense in depth for the field catalog).
    IF cls IN ('plain', 'personal', 'content')
       AND (e->>'field') ~ '(password|passphrase|secret|token|api_key|apikey|private_key|credential|otp_seed|mfa_seed)' THEN
      RETURN false;
    END IF;
    IF e ? 'redacted' THEN
      IF keys <> ARRAY['class', 'digest', 'field', 'reason', 'redacted'] OR e->'redacted' <> 'true'::jsonb
         OR cls = 'secret'
         OR (e->>'reason') NOT IN ('purge', 'account_deletion', 'privacy_request', 'legal_request') THEN
        RETURN false;
      END IF;
      CONTINUE;
    END IF;
    CASE cls
      WHEN 'secret' THEN
        IF keys <> ARRAY['changed', 'class', 'digest', 'field'] OR e->'changed' <> 'true'::jsonb THEN
          RETURN false;
        END IF;
      WHEN 'content' THEN
        IF NOT (keys <@ ARRAY['class', 'digest', 'field', 'hash', 'version_ref'])
           OR coalesce(e->>'hash', '') !~ '^sha256:[0-9a-f]{64}$'
           OR (e ? 'version_ref' AND (jsonb_typeof(e->'version_ref') <> 'string'
               OR (e->>'version_ref') !~ '^[A-Za-z0-9_.:-]{1,128}$')) THEN
          RETURN false;
        END IF;
      WHEN 'credential_ref' THEN
        IF keys <> ARRAY['class', 'digest', 'field', 'new', 'old']
           OR NOT (jsonb_typeof(e->'old') = 'null' OR (jsonb_typeof(e->'old') = 'string' AND (e->>'old') ~ '^[A-Za-z0-9_.:-]{1,128}$'))
           OR NOT (jsonb_typeof(e->'new') = 'null' OR (jsonb_typeof(e->'new') = 'string' AND (e->>'new') ~ '^[A-Za-z0-9_.:-]{1,128}$')) THEN
          RETURN false;
        END IF;
      ELSE -- plain, personal
        IF keys <> ARRAY['class', 'digest', 'field', 'new', 'old']
           OR NOT audit.valid_change_value(e->'old') OR NOT audit.valid_change_value(e->'new') THEN
          RETURN false;
        END IF;
    END CASE;
  END LOOP;
  RETURN true;
END
$$;

CREATE FUNCTION audit.valid_delegation_chain(chain jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT jsonb_typeof(chain) = 'array' AND jsonb_array_length(chain) <= 16 AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(chain) e
      WHERE jsonb_typeof(e) <> 'object'
         OR ARRAY(SELECT jsonb_object_keys(e) ORDER BY 1) <> ARRAY['id', 'type']
         OR (e->>'type') !~ '^[a-z_]{1,40}$'
         OR (e->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  $$;

-- ---------------------------------------------------------------------------------------------
-- audit.audit_event
-- ---------------------------------------------------------------------------------------------
CREATE TABLE audit.audit_event (
  id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  -- Scope at event time. Plain reference by design: history survives brand moves and purges.
  brand_id uuid,
  action text NOT NULL,
  actor_type exec.actor_type NOT NULL,
  actor_id uuid,
  on_behalf_of_membership_id uuid,
  delegation_chain jsonb NOT NULL DEFAULT '[]',
  -- No foreign key to the target: events survive purge as tombstone references (0B §7.1).
  target_record_id uuid,
  target_type text NOT NULL,
  target_public_id text,
  changes jsonb NOT NULL DEFAULT '[]',
  operation_id uuid,
  attempt_id uuid,
  correlation_id uuid NOT NULL,
  causation_id uuid,
  source_kind text NOT NULL,
  source_ref text,
  workflow_revision_id uuid,
  retention_class text NOT NULL DEFAULT 'R-AUDIT',
  chain_seq bigint NOT NULL,
  prev_hash bytea NOT NULL,
  hash bytea NOT NULL,
  PRIMARY KEY (occurred_at, id),
  CONSTRAINT audit_event_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT audit_event_action_format CHECK (action ~ '^[a-z_]+\.[a-z_]+$' AND char_length(action) <= 80),
  CONSTRAINT audit_event_target_type_format CHECK (target_type ~ '^[a-z_]{1,64}$'),
  CONSTRAINT audit_event_target_public_id_format CHECK (target_public_id IS NULL OR target_public_id ~ '^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT audit_event_delegation_chain_valid CHECK (audit.valid_delegation_chain(delegation_chain)),
  CONSTRAINT audit_event_changes_valid CHECK (audit.valid_changes(changes)),
  CONSTRAINT audit_event_source_kind_known CHECK (source_kind IN
    ('ui', 'api', 'paste', 'voice', 'email', 'form', 'webhook', 'import', 'integration', 'ai_proposal',
     'automation', 'agent', 'template', 'system')),
  CONSTRAINT audit_event_source_ref_length CHECK (source_ref IS NULL OR char_length(source_ref) <= 200),
  CONSTRAINT audit_event_retention CHECK (retention_class = 'R-AUDIT'),
  CONSTRAINT audit_event_chain_seq_positive CHECK (chain_seq >= 1),
  CONSTRAINT audit_event_hash_lengths CHECK (octet_length(prev_hash) = 32 AND octet_length(hash) = 32),
  CONSTRAINT audit_event_actor_present CHECK (actor_type = 'system' OR actor_id IS NOT NULL)
);
COMMENT ON TABLE audit.audit_event IS 'Append-only material events (0B §7.1). Values follow field classes; secrets are never captured.';
-- Chain continuity: one link per sequence number per workspace (no forks).
CREATE UNIQUE INDEX audit_event_chain ON audit.audit_event (workspace_id, chain_seq);
CREATE UNIQUE INDEX audit_event_id_key ON audit.audit_event (id);
CREATE INDEX audit_event_by_target ON audit.audit_event (workspace_id, target_record_id, occurred_at DESC)
  WHERE target_record_id IS NOT NULL;
CREATE INDEX audit_event_by_time ON audit.audit_event (workspace_id, occurred_at DESC);

-- Insert guard: genesis prev_hash is 32 zero bytes; every insert must extend the workspace chain.
CREATE FUNCTION audit.audit_event_chain_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  last_seq bigint;
  last_hash bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('audit.chain:' || NEW.workspace_id::text, 0));
  SELECT e.chain_seq, e.hash INTO last_seq, last_hash
    FROM audit.audit_event e WHERE e.workspace_id = NEW.workspace_id
    ORDER BY e.chain_seq DESC LIMIT 1;
  IF NEW.chain_seq <> coalesce(last_seq, 0) + 1
     OR NEW.prev_hash <> coalesce(last_hash, '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea) THEN
    RAISE EXCEPTION 'audit chain continuity violated for workspace %', NEW.workspace_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER audit_event_chain BEFORE INSERT ON audit.audit_event
  FOR EACH ROW EXECUTE FUNCTION audit.audit_event_chain_guard();

-- Update guard: only a value-field redaction by audit_maintainer under a redaction operation.
CREATE FUNCTION audit.audit_event_mutation_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  i int;
  o jsonb;
  n jsonb;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'audit.audit_event is append-only (%)', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF current_user <> 'audit_maintainer'
     OR coalesce(current_setting('app.redaction_operation_id', true), '') = '' THEN
    RAISE EXCEPTION 'audit.audit_event is append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Structural facts are immutable.
  IF (to_jsonb(NEW) - 'changes') IS DISTINCT FROM (to_jsonb(OLD) - 'changes') THEN
    RAISE EXCEPTION 'audit redaction may change value fields only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF jsonb_array_length(NEW.changes) <> jsonb_array_length(OLD.changes) THEN
    RAISE EXCEPTION 'audit redaction may not add or remove entries' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR i IN 0 .. jsonb_array_length(OLD.changes) - 1 LOOP
    o := OLD.changes -> i;
    n := NEW.changes -> i;
    IF n = o THEN CONTINUE; END IF;
    IF n->>'field' IS DISTINCT FROM o->>'field' OR n->>'class' IS DISTINCT FROM o->>'class'
       OR n->>'digest' IS DISTINCT FROM o->>'digest' OR o ? 'redacted' OR NOT (n ? 'redacted') THEN
      RAISE EXCEPTION 'audit redaction may only replace values with a redaction marker'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE ON audit.audit_event
  FOR EACH ROW EXECUTE FUNCTION audit.audit_event_mutation_guard();

-- Generic append-only guard for the other audit tables (no exceptions, any role).
CREATE FUNCTION audit.reject_mutation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  RAISE EXCEPTION '%.% is append-only (%)', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON audit.audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_mutation();

-- ---------------------------------------------------------------------------------------------
-- audit.audit_redaction: explicit, append-only record of every redaction (0B §7.7).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE audit.audit_redaction (
  id uuid NOT NULL,
  redacted_at timestamptz NOT NULL DEFAULT now(),
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  audit_event_id uuid NOT NULL,
  audit_event_occurred_at timestamptz NOT NULL,
  fields text[] NOT NULL,
  reason text NOT NULL,
  authorized_by_type exec.actor_type NOT NULL,
  authorized_by_id uuid,
  operation_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  PRIMARY KEY (redacted_at, id),
  CONSTRAINT audit_redaction_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT audit_redaction_fields CHECK (cardinality(fields) BETWEEN 1 AND 200),
  CONSTRAINT audit_redaction_reason_known CHECK (reason IN ('purge', 'account_deletion', 'privacy_request', 'legal_request'))
);
COMMENT ON TABLE audit.audit_redaction IS 'Append-only record of redacted audit value fields: which event, which fields, why, under which operation (0B §7.7).';
CREATE INDEX audit_redaction_by_event ON audit.audit_redaction (workspace_id, audit_event_id);
CREATE TRIGGER audit_redaction_append_only BEFORE UPDATE OR DELETE ON audit.audit_redaction
  FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER audit_redaction_no_truncate BEFORE TRUNCATE ON audit.audit_redaction
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_mutation();

-- ---------------------------------------------------------------------------------------------
-- audit.security_event: account (workspace NULL, platform scope) and tenant events.
-- Columns mirror identity.security_event_buffer so the 1B drain copies rows field for field.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE audit.security_event (
  id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  category text NOT NULL,
  action text NOT NULL,
  outcome text NOT NULL,
  actor_type exec.actor_type NOT NULL,
  actor_id uuid,
  subject_type text,
  subject_id uuid,
  workspace_id uuid REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  network_prefix text,
  user_agent_family text,
  correlation_id uuid NOT NULL,
  retention_class text NOT NULL DEFAULT 'R-AUDIT',
  PRIMARY KEY (occurred_at, id),
  CONSTRAINT security_event_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT security_event_category_known CHECK (category IN
    ('authentication', 'session', 'step_up', 'token', 'permission', 'sharing', 'export', 'support_access', 'elevation', 'denial', 'secret', 'rls_assertion')),
  CONSTRAINT security_event_action_format CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  CONSTRAINT security_event_outcome_known CHECK (outcome IN ('success', 'failure', 'denied')),
  CONSTRAINT security_event_subject_pair CHECK ((subject_type IS NULL) = (subject_id IS NULL)),
  CONSTRAINT security_event_retention CHECK (retention_class = 'R-AUDIT'),
  CONSTRAINT security_event_network_prefix_format CHECK (network_prefix IS NULL OR network_prefix ~ '^[0-9a-f.:]{2,45}/(24|48)$'),
  CONSTRAINT security_event_ua_family_length CHECK (user_agent_family IS NULL OR char_length(user_agent_family) <= 80)
);
COMMENT ON TABLE audit.security_event IS 'Append-only security events (0D §12.3). workspace_id is NULL for account events (platform scope).';
CREATE UNIQUE INDEX security_event_id_key ON audit.security_event (id);
CREATE INDEX security_event_by_actor ON audit.security_event (actor_id, occurred_at DESC) WHERE workspace_id IS NULL;
CREATE INDEX security_event_by_subject ON audit.security_event (subject_id, occurred_at DESC) WHERE workspace_id IS NULL;
CREATE INDEX security_event_by_workspace ON audit.security_event (workspace_id, occurred_at DESC) WHERE workspace_id IS NOT NULL;
CREATE TRIGGER security_event_append_only BEFORE UPDATE OR DELETE ON audit.security_event
  FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER security_event_no_truncate BEFORE TRUNCATE ON audit.security_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_mutation();

-- ---------------------------------------------------------------------------------------------
-- audit.chain_checkpoint: append-only verified chain heads (detects later tail truncation).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE audit.chain_checkpoint (
  id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  chain_seq bigint NOT NULL,
  hash bytea NOT NULL,
  PRIMARY KEY (recorded_at, id),
  CONSTRAINT chain_checkpoint_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT chain_checkpoint_seq_positive CHECK (chain_seq >= 1),
  CONSTRAINT chain_checkpoint_hash_length CHECK (octet_length(hash) = 32)
);
CREATE INDEX chain_checkpoint_latest ON audit.chain_checkpoint (workspace_id, chain_seq DESC);
CREATE TRIGGER chain_checkpoint_append_only BEFORE UPDATE OR DELETE ON audit.chain_checkpoint
  FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER chain_checkpoint_no_truncate BEFORE TRUNCATE ON audit.chain_checkpoint
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_mutation();

-- ---------------------------------------------------------------------------------------------
-- audit.activity_item: rebuildable projection (R-DERIVED). Display-safe values only.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION audit.valid_display_values(v jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT jsonb_typeof(v) = 'object' AND octet_length(v::text) <= 8192 AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(v) kv
      WHERE kv.key !~ '^[a-z][a-z0-9_]{0,62}$'
         OR jsonb_typeof(kv.value) NOT IN ('string', 'number', 'boolean', 'null')
         OR (jsonb_typeof(kv.value) = 'string' AND char_length(kv.value #>> '{}') > 500))
  $$;

CREATE TABLE audit.activity_item (
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid,
  project_id uuid,
  target_record_id uuid NOT NULL,
  related_record_id uuid,
  audit_event_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  summary_key text NOT NULL,
  display_values jsonb NOT NULL DEFAULT '{}',
  group_key text,
  PRIMARY KEY (created_at, id),
  CONSTRAINT activity_item_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT activity_item_summary_key_format CHECK (summary_key ~ '^[a-z_]+(\.[a-z_]+){1,3}$'),
  CONSTRAINT activity_item_display_values_safe CHECK (audit.valid_display_values(display_values)),
  CONSTRAINT activity_item_group_key_length CHECK (group_key IS NULL OR char_length(group_key) <= 200)
);
COMMENT ON TABLE audit.activity_item IS 'Rebuildable projection of audit events (0B §7.2). Never authoritative; read-time authorization still applies.';
CREATE UNIQUE INDEX activity_item_event ON audit.activity_item (audit_event_id);
CREATE INDEX activity_item_by_target ON audit.activity_item (workspace_id, target_record_id, occurred_at DESC);

-- ---------------------------------------------------------------------------------------------
-- RLS: tenant isolation everywhere; account security events additionally visible in platform scope.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE audit.audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.audit_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit.audit_event
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());

ALTER TABLE audit.audit_redaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.audit_redaction FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit.audit_redaction
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());

ALTER TABLE audit.security_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.security_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit.security_event
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());
CREATE POLICY platform_scope ON audit.security_event
  USING (workspace_id IS NULL AND exec.in_platform_scope())
  WITH CHECK (workspace_id IS NULL AND exec.in_platform_scope());

ALTER TABLE audit.chain_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.chain_checkpoint FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit.chain_checkpoint
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());

ALTER TABLE audit.activity_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.activity_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit.activity_item
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());

-- ---------------------------------------------------------------------------------------------
-- Grants: append-only for every application identity. audit_maintainer may update only the
-- value column (and the trigger restricts what it may write there).
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA audit FROM PUBLIC;
GRANT SELECT, INSERT ON audit.audit_event, audit.security_event TO app_rw, app_worker;
GRANT SELECT ON audit.audit_redaction TO app_rw, app_worker;
GRANT SELECT, INSERT ON audit.chain_checkpoint TO app_worker;
GRANT SELECT ON audit.activity_item TO app_rw;
GRANT SELECT, INSERT, DELETE ON audit.activity_item TO app_worker;
GRANT SELECT, UPDATE (changes) ON audit.audit_event TO audit_maintainer;
GRANT SELECT, INSERT ON audit.audit_redaction TO audit_maintainer;
GRANT USAGE ON SCHEMA exec, tenancy TO audit_maintainer;
REVOKE ALL ON FUNCTION audit.valid_change_value(jsonb), audit.valid_changes(jsonb),
  audit.valid_delegation_chain(jsonb), audit.valid_display_values(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.valid_change_value(jsonb), audit.valid_changes(jsonb),
  audit.valid_delegation_chain(jsonb), audit.valid_display_values(jsonb) TO app_rw, app_worker, audit_maintainer;
REVOKE ALL ON FUNCTION audit.audit_event_chain_guard(), audit.audit_event_mutation_guard(),
  audit.reject_mutation() FROM PUBLIC;

-- The Phase 1B buffer is drained by the worker (ADR-0008 handoff): read access only.
GRANT SELECT ON identity.security_event_buffer TO app_worker;
