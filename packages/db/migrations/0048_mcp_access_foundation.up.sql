-- migrate:phase expand
-- Phase 6E (INT-022): OAuth/MCP client registration, member consent grants, bounded invocation audit,
-- and platform-scoped access-token lookup. Builds on migration 0047_google_calendar.

-- Repeat the full 0B addressable set so migration history remains self-describing.
INSERT INTO core.record_type (record_type, public_id_prefix, owner_module) VALUES
  ('brand', 'br', 'tenancy'),
  ('team', 'team', 'tenancy'),
  ('workflow', 'wf', 'workflow'),
  ('file', 'file', 'files'),
  ('deliverable', 'dlv', 'files'),
  ('project', 'prj', 'work'),
  ('phase', 'phs', 'work'),
  ('milestone', 'ms', 'work'),
  ('task', 'tsk', 'work'),
  ('decision_record', 'dec', 'work'),
  ('inbox_item', 'inb', 'capture'),
  ('note', 'note', 'capture'),
  ('intake_form', 'form', 'capture'),
  ('work_block', 'blk', 'planning'),
  ('document', 'doc', 'knowledge'),
  ('goal', 'goal', 'goals'),
  ('key_result', 'kr', 'goals'),
  ('portfolio', 'pf', 'goals'),
  ('saved_view', 'view', 'views'),
  ('dashboard', 'dash', 'insights'),
  ('report_definition', 'rpt', 'insights'),
  ('connection', 'conn', 'integrations'),
  ('webhook_subscription', 'whk', 'integrations'),
  ('test_case', 'tc', 'quality'),
  ('test_suite', 'ts', 'quality'),
  ('test_run', 'tr', 'quality'),
  ('environment', 'env', 'delivery'),
  ('release', 'rel', 'delivery'),
  ('template', 'tpl', 'templates'),
  ('automation', 'auto', 'automation'),
  ('agent_profile', 'agt', 'agents'),
  ('mcp_invocation', 'mci', 'integrations'),
  ('oauth_access_token', 'oat', 'integrations'),
  ('oauth_client', 'oac', 'integrations'),
  ('oauth_consent', 'ocs', 'integrations')
ON CONFLICT (record_type) DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- OAuth / MCP client registration (workspace-scoped, hash-only secret).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE integrations.oauth_client (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  public_id text NOT NULL,
  name text NOT NULL,
  client_prefix text NOT NULL,
  client_hash bytea NOT NULL,
  redirect_uris text[] NOT NULL,
  allowed_scopes text[] NOT NULL,
  state text NOT NULL,
  revoked_at timestamptz,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT oauth_client_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT oauth_client_public_unique UNIQUE (workspace_id, public_id),
  CONSTRAINT oauth_client_prefix_unique UNIQUE (client_prefix),
  CONSTRAINT oauth_client_public_format CHECK (public_id ~ '^oac_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT oauth_client_prefix_format CHECK (client_prefix ~ '^oac_[A-Za-z0-9_-]{8}$'),
  CONSTRAINT oauth_client_hash_len CHECK (octet_length(client_hash) = 32),
  CONSTRAINT oauth_client_name CHECK (char_length(btrim(name)) BETWEEN 1 AND 80 AND name = btrim(name)
    AND tenancy.valid_plain_text(name, 80)),
  CONSTRAINT oauth_client_redirects_bounded CHECK (cardinality(redirect_uris) BETWEEN 1 AND 8),
  CONSTRAINT oauth_client_scopes_bounded CHECK (cardinality(allowed_scopes) BETWEEN 1 AND 19),
  CONSTRAINT oauth_client_state_known CHECK (state IN ('active', 'revoked')),
  CONSTRAINT oauth_client_revoked_shape CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT oauth_client_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT oauth_client_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX oauth_client_by_workspace ON integrations.oauth_client (workspace_id, state);

-- ---------------------------------------------------------------------------------------------
-- Member consent: effective scopes are a subset of the client registration and the member access.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE integrations.oauth_consent (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  public_id text NOT NULL,
  client_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  scopes text[] NOT NULL,
  brand_ids uuid[],
  state text NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT oauth_consent_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT oauth_consent_public_unique UNIQUE (workspace_id, public_id),
  CONSTRAINT oauth_consent_public_format CHECK (public_id ~ '^ocs_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT oauth_consent_member_client UNIQUE (workspace_id, client_id, membership_id),
  CONSTRAINT oauth_consent_client_fkey FOREIGN KEY (workspace_id, client_id)
    REFERENCES integrations.oauth_client (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT oauth_consent_member_fkey FOREIGN KEY (workspace_id, membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT oauth_consent_scopes_bounded CHECK (cardinality(scopes) BETWEEN 1 AND 19),
  CONSTRAINT oauth_consent_brands_bounded CHECK (brand_ids IS NULL OR cardinality(brand_ids) BETWEEN 1 AND 100),
  CONSTRAINT oauth_consent_state_known CHECK (state IN ('active', 'revoked')),
  CONSTRAINT oauth_consent_revoked_shape CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT oauth_consent_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX oauth_consent_by_client ON integrations.oauth_consent (workspace_id, client_id, state);

-- ---------------------------------------------------------------------------------------------
-- Short-lived OAuth access tokens (pma_ prefix). Refresh is out of scope for 6E foundation.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE integrations.oauth_access_token (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  public_id text NOT NULL,
  consent_id uuid NOT NULL,
  client_id uuid NOT NULL,
  token_prefix text NOT NULL,
  token_hash bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  state text NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oauth_access_token_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT oauth_access_token_public_unique UNIQUE (workspace_id, public_id),
  CONSTRAINT oauth_access_token_public_format CHECK (public_id ~ '^oat_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT oauth_access_token_prefix_unique UNIQUE (token_prefix),
  CONSTRAINT oauth_access_token_consent_fkey FOREIGN KEY (workspace_id, consent_id)
    REFERENCES integrations.oauth_consent (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT oauth_access_token_client_fkey FOREIGN KEY (workspace_id, client_id)
    REFERENCES integrations.oauth_client (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT oauth_access_token_prefix_format CHECK (token_prefix ~ '^pma_[A-Za-z0-9_-]{8}$'),
  CONSTRAINT oauth_access_token_hash_len CHECK (octet_length(token_hash) = 32),
  CONSTRAINT oauth_access_token_state_known CHECK (state IN ('active', 'revoked')),
  CONSTRAINT oauth_access_token_revoked_shape CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX oauth_access_token_by_consent ON integrations.oauth_access_token (workspace_id, consent_id, state);

-- ---------------------------------------------------------------------------------------------
-- Invocation audit (no secrets, bounded metadata).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE integrations.mcp_invocation (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  public_id text NOT NULL,
  consent_id uuid,
  token_id uuid,
  actor_membership_id uuid NOT NULL,
  actor_principal text NOT NULL,
  actor_public_id text NOT NULL,
  tool_name text NOT NULL,
  tool_version text NOT NULL,
  outcome text NOT NULL,
  duration_ms integer,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mcp_invocation_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT mcp_invocation_public_unique UNIQUE (workspace_id, public_id),
  CONSTRAINT mcp_invocation_public_format CHECK (public_id ~ '^mci_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT mcp_invocation_tool CHECK (char_length(tool_name) BETWEEN 1 AND 80),
  CONSTRAINT mcp_invocation_version CHECK (char_length(tool_version) BETWEEN 1 AND 16),
  CONSTRAINT mcp_invocation_outcome_known CHECK (outcome IN ('ok', 'error', 'timeout', 'denied')),
  CONSTRAINT mcp_invocation_duration CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CONSTRAINT mcp_invocation_detail CHECK (detail IS NULL OR char_length(detail) <= 80),
  CONSTRAINT mcp_invocation_principal CHECK (actor_principal IN ('member', 'api_token_personal', 'service_principal', 'oauth_client')),
  CONSTRAINT mcp_invocation_actor_public_id CHECK (actor_public_id ~ '^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT mcp_invocation_actor_fkey FOREIGN KEY (workspace_id, actor_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX mcp_invocation_by_workspace ON integrations.mcp_invocation (workspace_id, created_at DESC);

GRANT CREATE ON SCHEMA integrations TO pm_directory;

CREATE FUNCTION integrations.resolve_oauth_access_token(p_prefix text, p_hash bytea)
  RETURNS TABLE (
    workspace_id uuid,
    workspace_public_id text,
    token_id uuid,
    client_id uuid,
    client_public_id text,
    consent_id uuid,
    scopes text[],
    brand_ids uuid[],
    expires_at timestamptz,
    membership_id uuid,
    account_id uuid,
    state text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT t.workspace_id, w.public_id AS workspace_public_id, t.id AS token_id, t.client_id, c.public_id AS client_public_id, t.consent_id,
         g.scopes, g.brand_ids, t.expires_at, g.membership_id, m.account_id, t.state
    FROM integrations.oauth_access_token t
    JOIN integrations.oauth_consent g ON g.workspace_id = t.workspace_id AND g.id = t.consent_id
    JOIN integrations.oauth_client c ON c.workspace_id = t.workspace_id AND c.id = t.client_id
    JOIN tenancy.membership m ON m.workspace_id = g.workspace_id AND m.id = g.membership_id
    JOIN tenancy.workspace w ON w.id = t.workspace_id
   WHERE exec.in_platform_scope()
     AND t.token_prefix = p_prefix
     AND t.token_hash = p_hash
     AND t.state = 'active'
     AND g.state = 'active'
     AND c.state = 'active'
     AND t.expires_at > now()
     AND m.state = 'active'
$$;

REVOKE ALL ON FUNCTION integrations.resolve_oauth_access_token(text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integrations.resolve_oauth_access_token(text, bytea) TO app_rw, app_worker;
ALTER FUNCTION integrations.resolve_oauth_access_token(text, bytea) OWNER TO pm_directory;
REVOKE CREATE ON SCHEMA integrations FROM pm_directory;
GRANT USAGE ON SCHEMA integrations TO pm_directory;

CREATE POLICY oauth_token_lookup ON integrations.oauth_access_token FOR SELECT TO pm_directory USING (true);
CREATE POLICY oauth_consent_lookup ON integrations.oauth_consent FOR SELECT TO pm_directory USING (true);
CREATE POLICY oauth_client_lookup ON integrations.oauth_client FOR SELECT TO pm_directory USING (true);
GRANT SELECT ON integrations.oauth_access_token, integrations.oauth_consent, integrations.oauth_client TO pm_directory;

ALTER TABLE integrations.oauth_client ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations.oauth_client FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integrations.oauth_client
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE integrations.oauth_consent ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations.oauth_consent FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integrations.oauth_consent
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE integrations.oauth_access_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations.oauth_access_token FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integrations.oauth_access_token
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE integrations.mcp_invocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations.mcp_invocation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integrations.mcp_invocation
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON integrations.oauth_client, integrations.oauth_consent, integrations.oauth_access_token,
  integrations.mcp_invocation FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON integrations.oauth_client, integrations.oauth_consent,
  integrations.oauth_access_token TO app_rw;
GRANT SELECT, INSERT ON integrations.mcp_invocation TO app_rw;
GRANT SELECT, UPDATE, DELETE ON integrations.oauth_client, integrations.oauth_consent,
  integrations.oauth_access_token, integrations.mcp_invocation TO app_worker;
GRANT SELECT, INSERT ON integrations.mcp_invocation TO app_worker;
