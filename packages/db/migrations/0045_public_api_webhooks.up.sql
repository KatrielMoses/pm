-- migrate:phase expand
-- Phase 6B (0B ADR-40, 0C AZ-40, 0D PL-42): personal and service API tokens, outbound webhook
-- subscriptions and deliveries, and inbound webhook endpoints. Tokens are stored as a prefix plus
-- a SHA-256 hash. Signing secrets are vault references, never ciphertext in these tables.
-- Provider connections, sync, and calendar mirrors stay with later phases.

CREATE SCHEMA integrations;
REVOKE ALL ON SCHEMA integrations FROM PUBLIC;
GRANT USAGE ON SCHEMA integrations TO app_rw, app_worker, pm_directory;

-- ---------------------------------------------------------------------------------------------
-- API tokens (INT-017, INT-018). The secret is shown once and stored only as a hash. A brand
-- list, when present, narrows the owner's current authority; it never widens it.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE integrations.api_token (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  public_id text NOT NULL,
  kind text NOT NULL,
  principal_type text NOT NULL,
  principal_id uuid NOT NULL,
  accountable_owner_membership_id uuid NOT NULL,
  name text NOT NULL,
  token_prefix text NOT NULL,
  token_hash bytea NOT NULL,
  scopes text[] NOT NULL,
  brand_ids uuid[],
  expires_at timestamptz,
  last_used_at timestamptz,
  state text NOT NULL,
  revoked_at timestamptz,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT api_token_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT api_token_public_id_unique UNIQUE (workspace_id, public_id),
  CONSTRAINT api_token_prefix_unique UNIQUE (token_prefix),
  CONSTRAINT api_token_public_id_format CHECK (public_id ~ '^tok_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT api_token_kind_known CHECK (kind IN ('personal', 'service')),
  CONSTRAINT api_token_principal_known CHECK (
    (kind = 'personal' AND principal_type = 'membership' AND principal_id = accountable_owner_membership_id)
    OR (kind = 'service' AND principal_type = 'service_principal')),
  CONSTRAINT api_token_owner_fkey FOREIGN KEY (workspace_id, accountable_owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT api_token_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT api_token_name_text CHECK (char_length(btrim(name)) BETWEEN 1 AND 80 AND name = btrim(name)
    AND tenancy.valid_plain_text(name, 80)),
  CONSTRAINT api_token_prefix_format CHECK (token_prefix ~ '^pm_[A-Za-z0-9_-]{8}$'),
  CONSTRAINT api_token_hash_len CHECK (octet_length(token_hash) = 32),
  CONSTRAINT api_token_scopes_bounded CHECK (cardinality(scopes) BETWEEN 1 AND 32),
  CONSTRAINT api_token_brands_bounded CHECK (brand_ids IS NULL OR cardinality(brand_ids) BETWEEN 1 AND 100),
  CONSTRAINT api_token_state_known CHECK (state IN ('active', 'revoked', 'suspended')),
  CONSTRAINT api_token_revoked_shape CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT api_token_service_expiry CHECK (kind <> 'service' OR expires_at IS NOT NULL),
  CONSTRAINT api_token_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX api_token_by_owner ON integrations.api_token (workspace_id, accountable_owner_membership_id, state);
CREATE INDEX api_token_by_prefix ON integrations.api_token (token_prefix);

-- ---------------------------------------------------------------------------------------------
-- Outbound subscriptions (INT-011, INT-012). Addressable records. The signing secret lives in
-- the vault; a previous reference is accepted until previous_secret_until.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE integrations.webhook_subscription (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid,
  scope_key uuid NOT NULL,
  lifecycle_state core.lifecycle_state NOT NULL DEFAULT 'active',
  api_version text NOT NULL,
  event_types text[] NOT NULL,
  field_allowlist_version integer NOT NULL,
  destination_url text NOT NULL,
  state text NOT NULL,
  signing_secret_ref text NOT NULL,
  previous_secret_ref text,
  previous_secret_until timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  accountable_owner_membership_id uuid NOT NULL,
  suspended_reason text,
  suspended_at timestamptz,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_membership_id uuid,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT webhook_subscription_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT webhook_subscription_scope_key UNIQUE (workspace_id, scope_key, id),
  CONSTRAINT webhook_subscription_scope_shape CHECK (scope_key = coalesce(brand_id, workspace_id)),
  CONSTRAINT webhook_subscription_envelope_fkey FOREIGN KEY (id, workspace_id, scope_key, lifecycle_state)
    REFERENCES core.record (id, workspace_id, scope_key, lifecycle_state)
    ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT webhook_subscription_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT webhook_subscription_owner_fkey FOREIGN KEY (workspace_id, accountable_owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT webhook_subscription_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT webhook_subscription_updater_fkey FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT webhook_subscription_api_version CHECK (api_version = 'v1'),
  CONSTRAINT webhook_subscription_events_bounded CHECK (cardinality(event_types) BETWEEN 1 AND 20),
  CONSTRAINT webhook_subscription_allowlist CHECK (field_allowlist_version >= 1),
  CONSTRAINT webhook_subscription_url CHECK (destination_url LIKE 'https://%'
    AND char_length(destination_url) BETWEEN 12 AND 2000
    AND destination_url !~ '[[:space:]]'),
  CONSTRAINT webhook_subscription_state_known CHECK (state IN ('active', 'disabled_endpoint', 'suspended')),
  CONSTRAINT webhook_subscription_secret_ref CHECK (char_length(signing_secret_ref) BETWEEN 8 AND 240
    AND signing_secret_ref !~ '[[:space:]]'),
  CONSTRAINT webhook_subscription_previous_shape CHECK (
    (previous_secret_ref IS NULL) = (previous_secret_until IS NULL)),
  CONSTRAINT webhook_subscription_failures CHECK (consecutive_failures >= 0 AND consecutive_failures <= 1000),
  CONSTRAINT webhook_subscription_suspended_shape CHECK (
    (suspended_reason IS NULL) = (suspended_at IS NULL)
    AND (suspended_reason IS NULL OR suspended_reason IN ('owner_authority', 'owner_departed', 'admin'))),
  CONSTRAINT webhook_subscription_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX webhook_subscription_by_envelope ON integrations.webhook_subscription (id, workspace_id, scope_key, lifecycle_state);
CREATE INDEX webhook_subscription_by_owner ON integrations.webhook_subscription (workspace_id, accountable_owner_membership_id);
CREATE INDEX webhook_subscription_by_brand ON integrations.webhook_subscription (workspace_id, brand_id);
CREATE INDEX webhook_subscription_active ON integrations.webhook_subscription (workspace_id, state) WHERE state = 'active';

-- ---------------------------------------------------------------------------------------------
-- Delivery attempts (INT-014, INT-015). Response bodies are not stored. The same event public
-- id is reused across retries so receivers can deduplicate.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE integrations.webhook_delivery (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  subscription_id uuid NOT NULL,
  public_id text NOT NULL,
  event_public_id text NOT NULL,
  event_type text NOT NULL,
  aggregate_id uuid,
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL,
  attempt integer NOT NULL DEFAULT 0,
  response_status integer,
  duration_ms integer,
  detail text,
  next_attempt_at timestamptz,
  claimed_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_delivery_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT webhook_delivery_public_unique UNIQUE (workspace_id, public_id),
  CONSTRAINT webhook_delivery_event_once UNIQUE (workspace_id, subscription_id, event_public_id),
  CONSTRAINT webhook_delivery_subscription_fkey FOREIGN KEY (workspace_id, subscription_id)
    REFERENCES integrations.webhook_subscription (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT webhook_delivery_public_format CHECK (public_id ~ '^whd_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT webhook_delivery_event_format CHECK (event_public_id ~ '^evt_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT webhook_delivery_facts CHECK (jsonb_typeof(facts) = 'object' AND pg_column_size(facts) <= 4096),
  CONSTRAINT webhook_delivery_state_known CHECK (state IN
    ('pending', 'delivered', 'retry_scheduled', 'failed', 'unknown', 'disabled_endpoint')),
  CONSTRAINT webhook_delivery_attempt CHECK (attempt >= 0 AND attempt <= 100),
  CONSTRAINT webhook_delivery_status CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599),
  CONSTRAINT webhook_delivery_duration CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CONSTRAINT webhook_delivery_detail CHECK (detail IS NULL OR char_length(detail) <= 80)
);
CREATE INDEX webhook_delivery_due ON integrations.webhook_delivery (workspace_id, next_attempt_at, id)
  WHERE state IN ('pending', 'retry_scheduled', 'unknown');
CREATE INDEX webhook_delivery_by_subscription ON integrations.webhook_delivery (workspace_id, subscription_id, created_at DESC);

-- ---------------------------------------------------------------------------------------------
-- Inbound endpoints (INT-010, INT-013). The path token is unguessable and is not a workspace id.
-- Only its hash is stored. One endpoint performs one intake action in one scope.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE integrations.inbound_endpoint (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid,
  public_id text NOT NULL,
  path_prefix text NOT NULL,
  path_hash bytea NOT NULL,
  action text NOT NULL,
  signing_secret_ref text NOT NULL,
  previous_secret_ref text,
  previous_secret_until timestamptz,
  state text NOT NULL,
  accountable_owner_membership_id uuid NOT NULL,
  suspended_reason text,
  suspended_at timestamptz,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT inbound_endpoint_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT inbound_endpoint_public_unique UNIQUE (workspace_id, public_id),
  CONSTRAINT inbound_endpoint_prefix_unique UNIQUE (path_prefix),
  CONSTRAINT inbound_endpoint_public_format CHECK (public_id ~ '^whk_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT inbound_endpoint_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT inbound_endpoint_owner_fkey FOREIGN KEY (workspace_id, accountable_owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT inbound_endpoint_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT inbound_endpoint_prefix_format CHECK (path_prefix ~ '^hk_[A-Za-z0-9_-]{8}$'),
  CONSTRAINT inbound_endpoint_hash_len CHECK (octet_length(path_hash) = 32),
  CONSTRAINT inbound_endpoint_action_known CHECK (action IN ('capture.task')),
  CONSTRAINT inbound_endpoint_secret_ref CHECK (char_length(signing_secret_ref) BETWEEN 8 AND 240
    AND signing_secret_ref !~ '[[:space:]]'),
  CONSTRAINT inbound_endpoint_previous_shape CHECK (
    (previous_secret_ref IS NULL) = (previous_secret_until IS NULL)),
  CONSTRAINT inbound_endpoint_state_known CHECK (state IN ('active', 'suspended')),
  CONSTRAINT inbound_endpoint_suspended_shape CHECK (
    (suspended_reason IS NULL) = (suspended_at IS NULL)
    AND (suspended_reason IS NULL OR suspended_reason IN ('owner_authority', 'owner_departed', 'admin'))),
  CONSTRAINT inbound_endpoint_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX inbound_endpoint_by_prefix ON integrations.inbound_endpoint (path_prefix);
CREATE INDEX inbound_endpoint_by_owner ON integrations.inbound_endpoint (workspace_id, accountable_owner_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Inbound messages (INT-010, CAP-008). Deduped by provider event id. The body is not returned
-- on the public API; a quarantine keeps the reason, not an echo of the payload.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE integrations.inbound_message (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  endpoint_id uuid NOT NULL,
  provider_event_id text NOT NULL,
  state text NOT NULL,
  detail text,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbound_message_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT inbound_message_dedupe UNIQUE (endpoint_id, provider_event_id),
  CONSTRAINT inbound_message_endpoint_fkey FOREIGN KEY (workspace_id, endpoint_id)
    REFERENCES integrations.inbound_endpoint (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT inbound_message_event_id CHECK (char_length(provider_event_id) BETWEEN 1 AND 200),
  CONSTRAINT inbound_message_state_known CHECK (state IN ('accepted', 'processed', 'quarantined', 'rejected')),
  CONSTRAINT inbound_message_detail CHECK (detail IS NULL OR char_length(detail) <= 80)
);
CREATE INDEX inbound_message_by_endpoint ON integrations.inbound_message (workspace_id, endpoint_id, received_at DESC);

-- ---------------------------------------------------------------------------------------------
-- Credential lookup before any tenant data is exposed (0D §9.2). The functions return a row
-- only when the hash matches, and only inside a platform-scoped transaction.
-- ---------------------------------------------------------------------------------------------
GRANT CREATE ON SCHEMA integrations TO pm_directory;

CREATE FUNCTION integrations.resolve_api_token(p_prefix text, p_hash bytea)
  RETURNS TABLE (
    workspace_id uuid,
    token_id uuid,
    public_id text,
    kind text,
    principal_type text,
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
  SELECT t.workspace_id, t.id, t.public_id, t.kind, t.principal_type, t.scopes, t.brand_ids, t.expires_at,
         t.accountable_owner_membership_id, m.account_id, t.state
    FROM integrations.api_token t
    JOIN tenancy.membership m ON m.workspace_id = t.workspace_id AND m.id = t.accountable_owner_membership_id
   WHERE exec.in_platform_scope()
     AND t.token_prefix = p_prefix
     AND t.token_hash = p_hash
     AND t.state = 'active'
     AND (t.expires_at IS NULL OR t.expires_at > now())
     AND m.state = 'active'
$$;

CREATE FUNCTION integrations.resolve_inbound_endpoint(p_prefix text, p_hash bytea)
  RETURNS TABLE (
    workspace_id uuid,
    endpoint_id uuid,
    brand_id uuid,
    action text,
    signing_secret_ref text,
    previous_secret_ref text,
    previous_secret_until timestamptz,
    membership_id uuid,
    account_id uuid,
    state text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT e.workspace_id, e.id, e.brand_id, e.action, e.signing_secret_ref, e.previous_secret_ref,
         e.previous_secret_until, e.accountable_owner_membership_id, m.account_id, e.state
    FROM integrations.inbound_endpoint e
    JOIN tenancy.membership m ON m.workspace_id = e.workspace_id AND m.id = e.accountable_owner_membership_id
   WHERE exec.in_platform_scope()
     AND e.path_prefix = p_prefix
     AND e.path_hash = p_hash
$$;

REVOKE ALL ON FUNCTION integrations.resolve_api_token(text, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION integrations.resolve_inbound_endpoint(text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integrations.resolve_api_token(text, bytea) TO app_rw, app_worker;
GRANT EXECUTE ON FUNCTION integrations.resolve_inbound_endpoint(text, bytea) TO app_rw, app_worker;
ALTER FUNCTION integrations.resolve_api_token(text, bytea) OWNER TO pm_directory;
ALTER FUNCTION integrations.resolve_inbound_endpoint(text, bytea) OWNER TO pm_directory;
REVOKE CREATE ON SCHEMA integrations FROM pm_directory;

CREATE POLICY token_lookup ON integrations.api_token FOR SELECT TO pm_directory USING (true);
CREATE POLICY endpoint_lookup ON integrations.inbound_endpoint FOR SELECT TO pm_directory USING (true);
GRANT SELECT ON integrations.api_token, integrations.inbound_endpoint TO pm_directory;

-- ---------------------------------------------------------------------------------------------
-- Due deliveries and aged rows (payload-free discovery).
-- ---------------------------------------------------------------------------------------------
CREATE POLICY scheduler_discovery ON integrations.webhook_delivery FOR SELECT TO pm_scheduler USING (true);
GRANT SELECT (workspace_id, state, next_attempt_at, created_at) ON integrations.webhook_delivery TO pm_scheduler;
GRANT USAGE ON SCHEMA integrations TO pm_scheduler;

CREATE FUNCTION exec_dispatch.discover_webhook_work(p_now timestamptz, p_retention_before timestamptz, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT w.workspace_id FROM (
    SELECT d.workspace_id, d.next_attempt_at AS due FROM integrations.webhook_delivery d
     WHERE d.state IN ('pending', 'retry_scheduled', 'unknown')
       AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= p_now)
       AND (d.claimed_until IS NULL OR d.claimed_until <= p_now)
    UNION ALL
    SELECT x.workspace_id, min(x.created_at) FROM integrations.webhook_delivery x
     WHERE x.created_at < p_retention_before GROUP BY x.workspace_id
  ) w
   GROUP BY w.workspace_id
   ORDER BY min(w.due), w.workspace_id
   LIMIT least(greatest(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION exec_dispatch.discover_webhook_work(timestamptz, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION exec_dispatch.discover_webhook_work(timestamptz, timestamptz, integer) TO dispatcher;
ALTER FUNCTION exec_dispatch.discover_webhook_work(timestamptz, timestamptz, integer) OWNER TO pm_scheduler;

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE integrations.api_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations.api_token FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integrations.api_token
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE integrations.webhook_subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations.webhook_subscription FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integrations.webhook_subscription
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE integrations.webhook_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations.webhook_delivery FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integrations.webhook_delivery
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE integrations.inbound_endpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations.inbound_endpoint FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integrations.inbound_endpoint
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE integrations.inbound_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations.inbound_message FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integrations.inbound_message
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON integrations.api_token, integrations.webhook_subscription, integrations.webhook_delivery,
  integrations.inbound_endpoint, integrations.inbound_message FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON integrations.api_token, integrations.webhook_subscription,
  integrations.inbound_endpoint TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON integrations.webhook_delivery, integrations.inbound_message TO app_rw;
GRANT SELECT, UPDATE, DELETE ON integrations.api_token, integrations.webhook_subscription,
  integrations.webhook_delivery, integrations.inbound_endpoint, integrations.inbound_message TO app_worker;
GRANT SELECT, INSERT, UPDATE ON integrations.webhook_delivery, integrations.inbound_message TO app_worker;
