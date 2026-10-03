-- migrate:phase expand
-- Identity and sessions (Phase 1B; 0B module `identity`, platform scope). Identity grants no
-- workspace authority. Platform-scoped rows carry no tenant RLS (0C §12.2: platform tables have no
-- tenant policy); access is limited by column-scoped grants and server-side ownership checks in the
-- identity repository. Secrets (session, verification, step-up tokens; TOTP seeds; recovery codes;
-- passwords) are stored only as hashes or as secret-store references (C4).

CREATE SCHEMA identity;
COMMENT ON SCHEMA identity IS 'Identity and accounts (0B module identity): accounts, credentials, MFA, sessions, OAuth identities, one-time tokens, step-up.';
GRANT USAGE ON SCHEMA identity TO app_rw, app_worker;

-- Accounts --------------------------------------------------------------------------------------
CREATE TABLE identity.account (
  id uuid PRIMARY KEY,
  public_id text NOT NULL,
  -- Delivery/display form (trimmed, NFC). Comparison uses email_key.
  primary_email text NOT NULL,
  -- Case-insensitive comparison key computed by the application (NFC, full Unicode lowercase,
  -- IDNA domain). No provider-specific alias rules (dots, plus tags) are applied.
  email_key text NOT NULL,
  display_name text NOT NULL,
  timezone text NOT NULL,
  locale text NOT NULL,
  day_start_offset interval NOT NULL DEFAULT '0 hours',
  email_verified_at timestamptz,
  terms_version text NOT NULL,
  privacy_version text NOT NULL,
  legal_acknowledged_at timestamptz NOT NULL,
  pseudonym text,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT account_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT account_public_id_key UNIQUE (public_id),
  CONSTRAINT account_public_id_format CHECK (public_id ~ '^acct_[0-9A-HJKMNP-TV-Z]{26}$'),
  -- Race-safe case-insensitive uniqueness (0B: unique lower(primary_email)).
  CONSTRAINT account_email_key_unique UNIQUE (email_key),
  CONSTRAINT account_email_length CHECK (char_length(primary_email) BETWEEN 3 AND 254 AND char_length(email_key) BETWEEN 3 AND 320),
  CONSTRAINT account_display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 120),
  CONSTRAINT account_timezone_format CHECK (timezone ~ '^[A-Za-z]+(/[A-Za-z0-9_+\-]+)*$'),
  CONSTRAINT account_locale_format CHECK (locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  CONSTRAINT account_day_start_range CHECK (day_start_offset >= '0 hours' AND day_start_offset < '24 hours'),
  CONSTRAINT account_legal_versions_format CHECK (terms_version ~ '^[A-Za-z0-9._-]{1,40}$' AND privacy_version ~ '^[A-Za-z0-9._-]{1,40}$'),
  CONSTRAINT account_deleted_pseudonymized CHECK (deleted_at IS NULL OR pseudonym IS NOT NULL),
  CONSTRAINT account_verified_after_creation CHECK (email_verified_at IS NULL OR email_verified_at >= created_at - interval '1 minute'),
  CONSTRAINT account_version_nonnegative CHECK (version >= 0)
);

-- Credentials: separate table so password material has its own column privileges (0B).
CREATE TABLE identity.credential (
  account_id uuid PRIMARY KEY REFERENCES identity.account (id) ON DELETE RESTRICT,
  password_hash bytea NOT NULL,
  password_salt bytea NOT NULL,
  algorithm text NOT NULL,
  -- {"v":19,"m":<KiB>,"t":<passes>,"p":<lanes>,"len":32}; raised on successful sign-in.
  params jsonb NOT NULL,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  failed_attempts integer NOT NULL DEFAULT 0,
  last_failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT credential_algorithm_known CHECK (algorithm = 'argon2id'),
  CONSTRAINT credential_hash_lengths CHECK (octet_length(password_hash) BETWEEN 16 AND 64 AND octet_length(password_salt) BETWEEN 16 AND 64),
  CONSTRAINT credential_params_shape CHECK (
    jsonb_typeof(params) = 'object' AND params ?& ARRAY['v', 'm', 't', 'p', 'len'] AND pg_column_size(params) <= 256),
  CONSTRAINT credential_failed_attempts_nonnegative CHECK (failed_attempts >= 0)
);

-- MFA factors ------------------------------------------------------------------------------------
CREATE TABLE identity.mfa_factor (
  id uuid PRIMARY KEY,
  public_id text NOT NULL,
  account_id uuid NOT NULL REFERENCES identity.account (id) ON DELETE RESTRICT,
  factor_type text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  label text,
  -- TOTP: reference into the secret store (never the seed).
  secret_ref text,
  -- WebAuthn boundary (no production UI in 1B): public credential data only.
  webauthn_credential_id bytea,
  webauthn_public_key bytea,
  webauthn_sign_count bigint,
  -- TOTP replay protection: highest accepted time step.
  last_used_step bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT mfa_factor_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT mfa_factor_public_id_key UNIQUE (public_id),
  CONSTRAINT mfa_factor_public_id_format CHECK (public_id ~ '^mfa_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT mfa_factor_type_known CHECK (factor_type IN ('totp', 'webauthn')),
  CONSTRAINT mfa_factor_state_known CHECK (state IN ('pending', 'active', 'revoked')),
  CONSTRAINT mfa_factor_label_length CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 60),
  CONSTRAINT mfa_factor_totp_secret CHECK (factor_type <> 'totp' OR state = 'revoked' OR secret_ref IS NOT NULL),
  CONSTRAINT mfa_factor_webauthn_key CHECK (factor_type <> 'webauthn' OR state = 'revoked' OR (webauthn_credential_id IS NOT NULL AND webauthn_public_key IS NOT NULL)),
  CONSTRAINT mfa_factor_state_times CHECK (
    (state = 'active') = (verified_at IS NOT NULL AND revoked_at IS NULL)
    AND (state = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT mfa_factor_version_nonnegative CHECK (version >= 0)
);
-- At most one enrolling-or-active TOTP factor per account.
CREATE UNIQUE INDEX mfa_factor_one_totp ON identity.mfa_factor (account_id)
  WHERE factor_type = 'totp' AND state IN ('pending', 'active');
CREATE INDEX mfa_factor_by_account ON identity.mfa_factor (account_id, state);

-- One-time recovery codes (hashes only). A regeneration revokes the previous set atomically.
CREATE TABLE identity.recovery_code (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES identity.account (id) ON DELETE RESTRICT,
  generation integer NOT NULL,
  code_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT recovery_code_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT recovery_code_hash_key UNIQUE (code_hash),
  CONSTRAINT recovery_code_hash_length CHECK (octet_length(code_hash) = 32),
  CONSTRAINT recovery_code_single_end CHECK (used_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX recovery_code_active ON identity.recovery_code (account_id, generation) WHERE used_at IS NULL AND revoked_at IS NULL;

-- Sessions ---------------------------------------------------------------------------------------
CREATE TABLE identity.session (
  id uuid PRIMARY KEY,
  public_id text NOT NULL,
  account_id uuid NOT NULL REFERENCES identity.account (id) ON DELETE RESTRICT,
  -- SHA-256 of a 256-bit random token; the raw token exists only in the cookie.
  token_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  auth_methods text[] NOT NULL,
  assurance text NOT NULL,
  mfa_verified_at timestamptz,
  rotated_from_session_id uuid REFERENCES identity.session (id) ON DELETE SET NULL,
  -- Privacy-minimized device context: browser/OS family label and a network prefix
  -- (IPv4 /24, IPv6 /48). Full addresses and user agents are never stored.
  device_label text,
  network_prefix text,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT session_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT session_public_id_key UNIQUE (public_id),
  CONSTRAINT session_public_id_format CHECK (public_id ~ '^ses_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT session_token_hash_key UNIQUE (token_hash),
  CONSTRAINT session_token_hash_length CHECK (octet_length(token_hash) = 32),
  CONSTRAINT session_expiry_order CHECK (absolute_expires_at > created_at AND idle_expires_at <= absolute_expires_at AND last_seen_at >= created_at),
  CONSTRAINT session_revocation_reason CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
  CONSTRAINT session_revoke_reason_known CHECK (revoke_reason IS NULL OR revoke_reason IN
    ('sign_out', 'sign_out_everywhere', 'revoked_by_owner', 'password_reset', 'password_changed', 'rotated', 'mfa_changed', 'administrative')),
  CONSTRAINT session_methods_known CHECK (auth_methods <@ ARRAY['password', 'totp', 'recovery_code', 'oauth', 'webauthn']::text[] AND cardinality(auth_methods) >= 1),
  CONSTRAINT session_assurance_known CHECK (assurance IN ('single_factor', 'multi_factor')),
  CONSTRAINT session_mfa_assurance CHECK ((assurance = 'multi_factor') = (mfa_verified_at IS NOT NULL)),
  CONSTRAINT session_device_label_length CHECK (device_label IS NULL OR char_length(device_label) <= 80),
  CONSTRAINT session_network_prefix_format CHECK (network_prefix IS NULL OR network_prefix ~ '^[0-9a-f.:]{2,45}/(24|48)$'),
  CONSTRAINT session_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX session_active_by_account ON identity.session (account_id, created_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX session_expiry ON identity.session (absolute_expires_at);
CREATE INDEX session_rotated_from ON identity.session (rotated_from_session_id);

-- OAuth identities -------------------------------------------------------------------------------
CREATE TABLE identity.oauth_identity (
  id uuid PRIMARY KEY,
  public_id text NOT NULL,
  account_id uuid NOT NULL REFERENCES identity.account (id) ON DELETE RESTRICT,
  provider text NOT NULL,
  subject text NOT NULL,
  -- Provider-asserted metadata kept only for display in the account UI.
  provider_email text,
  provider_display_name text,
  state text NOT NULL DEFAULT 'linked',
  linked_at timestamptz NOT NULL DEFAULT now(),
  unlinked_at timestamptz,
  last_sign_in_at timestamptz,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT oauth_identity_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT oauth_identity_public_id_key UNIQUE (public_id),
  CONSTRAINT oauth_identity_public_id_format CHECK (public_id ~ '^oid_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT oauth_identity_subject_key UNIQUE (provider, subject),
  CONSTRAINT oauth_identity_provider_format CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  CONSTRAINT oauth_identity_subject_length CHECK (char_length(subject) BETWEEN 1 AND 255),
  CONSTRAINT oauth_identity_state_known CHECK (state IN ('linked', 'unlinked')),
  CONSTRAINT oauth_identity_state_times CHECK ((state = 'unlinked') = (unlinked_at IS NOT NULL))
);
CREATE INDEX oauth_identity_by_account ON identity.oauth_identity (account_id, state);

-- One-time tokens --------------------------------------------------------------------------------
CREATE TABLE identity.verification_token (
  id uuid PRIMARY KEY,
  purpose text NOT NULL,
  account_id uuid REFERENCES identity.account (id) ON DELETE RESTRICT,
  token_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  -- Issuance lineage: the token this one superseded (resend, re-request).
  supersedes_token_id uuid REFERENCES identity.verification_token (id) ON DELETE SET NULL,
  -- Non-secret context (provider, intent, safe return path). Secrets live in the secret store.
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  sealed_ref text,
  CONSTRAINT verification_token_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT verification_token_hash_key UNIQUE (token_hash),
  CONSTRAINT verification_token_hash_length CHECK (octet_length(token_hash) = 32),
  CONSTRAINT verification_token_purpose_known CHECK (purpose IN ('email_verification', 'password_reset', 'sign_in_continuation', 'oauth_state')),
  CONSTRAINT verification_token_account_required CHECK (purpose = 'oauth_state' OR account_id IS NOT NULL),
  CONSTRAINT verification_token_expiry_order CHECK (expires_at > created_at),
  CONSTRAINT verification_token_single_end CHECK (consumed_at IS NULL OR revoked_at IS NULL),
  CONSTRAINT verification_token_attempts_nonnegative CHECK (attempts >= 0),
  CONSTRAINT verification_token_context_shape CHECK (jsonb_typeof(context) = 'object' AND pg_column_size(context) <= 2048)
);
CREATE INDEX verification_token_open ON identity.verification_token (account_id, purpose, created_at DESC) WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX verification_token_expiry ON identity.verification_token (expires_at);
CREATE INDEX verification_token_lineage ON identity.verification_token (supersedes_token_id);

-- Step-up challenges (0D §11.2; 0B identity.step_up_challenge) -----------------------------------
CREATE TABLE identity.step_up_challenge (
  id uuid PRIMARY KEY,
  public_id text NOT NULL,
  account_id uuid NOT NULL REFERENCES identity.account (id) ON DELETE RESTRICT,
  session_id uuid NOT NULL REFERENCES identity.session (id) ON DELETE RESTRICT,
  -- Tenant actions bind a concrete membership and workspace (plain references until 1C/1D).
  membership_id uuid,
  workspace_id uuid,
  action_key text NOT NULL,
  target_type text,
  target_hash bytea,
  methods text[] NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  challenge_nonce_hash bytea NOT NULL,
  token_hash bytea,
  -- The client must retry the original request with the same Idempotency-Key (0D §11.2 step 4).
  idempotency_key_hash bytea,
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  verified_method text,
  token_expires_at timestamptz,
  consumed_at timestamptz,
  cancelled_at timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT step_up_challenge_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT step_up_challenge_public_id_key UNIQUE (public_id),
  CONSTRAINT step_up_challenge_public_id_format CHECK (public_id ~ '^stp_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT step_up_challenge_token_hash_key UNIQUE (token_hash),
  CONSTRAINT step_up_challenge_state_known CHECK (state IN ('pending', 'verified', 'consumed', 'expired', 'cancelled')),
  CONSTRAINT step_up_challenge_methods_known CHECK (methods <@ ARRAY['password', 'totp', 'webauthn', 'recovery_code']::text[] AND cardinality(methods) >= 1),
  CONSTRAINT step_up_challenge_tenant_binding CHECK ((membership_id IS NULL) = (workspace_id IS NULL)),
  CONSTRAINT step_up_challenge_action_format CHECK (action_key ~ '^[a-z_]+(\.[a-z_]+)+$'),
  CONSTRAINT step_up_challenge_target_pair CHECK ((target_type IS NULL) = (target_hash IS NULL)),
  CONSTRAINT step_up_challenge_hash_lengths CHECK (
    octet_length(challenge_nonce_hash) = 32 AND (token_hash IS NULL OR octet_length(token_hash) = 32)
    AND (target_hash IS NULL OR octet_length(target_hash) = 32)
    AND (idempotency_key_hash IS NULL OR octet_length(idempotency_key_hash) = 32)),
  CONSTRAINT step_up_challenge_verified_state CHECK (
    (state IN ('verified', 'consumed')) = (verified_at IS NOT NULL AND token_hash IS NOT NULL AND token_expires_at IS NOT NULL)),
  CONSTRAINT step_up_challenge_consumed_state CHECK ((state = 'consumed') = (consumed_at IS NOT NULL)),
  CONSTRAINT step_up_challenge_cancelled_state CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT step_up_challenge_expiry_order CHECK (expires_at > created_at),
  CONSTRAINT step_up_challenge_attempts_nonnegative CHECK (failed_attempts >= 0)
);
CREATE INDEX step_up_challenge_by_session ON identity.step_up_challenge (session_id, action_key, state);
CREATE INDEX step_up_challenge_by_account ON identity.step_up_challenge (account_id);
CREATE INDEX step_up_challenge_expiry ON identity.step_up_challenge (expires_at);

-- Mail deliveries (outbox-delivered through the worker; no mail inside request transactions) ------
CREATE TABLE identity.mail_delivery (
  id uuid PRIMARY KEY,
  template text NOT NULL,
  -- C3: kept only until delivery completes and the retention sweep clears it.
  recipient text,
  locale text NOT NULL,
  account_id uuid REFERENCES identity.account (id) ON DELETE RESTRICT,
  -- Secret-store reference to the one-time token embedded in the link (if any).
  sealed_ref text,
  state text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  provider_message_id text,
  request_id text,
  correlation_id uuid NOT NULL,
  traceparent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CONSTRAINT mail_delivery_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT mail_delivery_template_known CHECK (template IN
    ('email_verification', 'account_exists', 'password_reset', 'password_changed', 'mfa_enabled', 'mfa_disabled',
     'recovery_codes_regenerated', 'sessions_revoked', 'oauth_linked', 'oauth_unlinked')),
  CONSTRAINT mail_delivery_state_known CHECK (state IN ('pending', 'sent', 'failed')),
  CONSTRAINT mail_delivery_sent_state CHECK ((state = 'sent') = (sent_at IS NOT NULL)),
  CONSTRAINT mail_delivery_locale_format CHECK (locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  CONSTRAINT mail_delivery_traceparent_format CHECK (traceparent IS NULL OR traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'),
  CONSTRAINT mail_delivery_request_id_format CHECK (request_id IS NULL OR request_id ~ '^req_[0-9A-HJKMNP-TV-Z]{26}$')
);
CREATE INDEX mail_delivery_by_account ON identity.mail_delivery (account_id);
CREATE INDEX mail_delivery_retention ON identity.mail_delivery (created_at);

-- Security events: durable fallback buffer behind the typed port until 1F's audit sink drains it.
-- Shape follows the 0D security-event contract; network context is minimized (C3).
CREATE TABLE identity.security_event_buffer (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  category text NOT NULL,
  action text NOT NULL,
  outcome text NOT NULL,
  actor_type exec.actor_type NOT NULL,
  actor_id uuid,
  subject_type text,
  subject_id uuid,
  workspace_id uuid,
  network_prefix text,
  user_agent_family text,
  correlation_id uuid NOT NULL,
  retention_class text NOT NULL DEFAULT 'R-AUDIT',
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
CREATE INDEX security_event_by_subject ON identity.security_event_buffer (subject_id, occurred_at DESC);

-- Platform operational state ----------------------------------------------------------------------
-- Rate-limit buckets keyed by HMAC of the dimension (never plaintext emails, IPs, or account IDs).
CREATE TABLE ops.rate_limit_bucket (
  policy text NOT NULL,
  key_hash bytea NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL,
  strikes integer NOT NULL DEFAULT 0,
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rate_limit_bucket_pkey PRIMARY KEY (policy, key_hash),
  CONSTRAINT rate_limit_bucket_policy_format CHECK (policy ~ '^[a-z_.]{1,64}$'),
  CONSTRAINT rate_limit_bucket_key_length CHECK (octet_length(key_hash) = 32),
  CONSTRAINT rate_limit_bucket_counts CHECK (hits >= 0 AND strikes >= 0)
);
CREATE INDEX rate_limit_bucket_stale ON ops.rate_limit_bucket (updated_at);

-- Development-only secret store (AES-256-GCM ciphertext). The adapter refuses to start outside
-- local and test; production uses the approved secret store/KMS once selected (DQ-28).
CREATE TABLE ops.dev_secret_vault (
  ref text PRIMARY KEY,
  purpose text NOT NULL,
  nonce bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  CONSTRAINT dev_secret_vault_ref_format CHECK (ref ~ '^dev:[a-z_]+:[0-9a-f]{32}$'),
  CONSTRAINT dev_secret_vault_sizes CHECK (octet_length(nonce) = 12 AND octet_length(auth_tag) = 16 AND octet_length(ciphertext) <= 4096)
);
CREATE INDEX dev_secret_vault_expiry ON ops.dev_secret_vault (expires_at);

-- Grants -------------------------------------------------------------------------------------------
-- Web/API (app_rw): the identity repository's commands. No DELETE except tokens it supersedes.
GRANT SELECT, INSERT, UPDATE ON identity.account TO app_rw;
GRANT SELECT, INSERT, UPDATE ON identity.credential TO app_rw;
GRANT SELECT, INSERT, UPDATE ON identity.mfa_factor TO app_rw;
GRANT SELECT, INSERT, UPDATE ON identity.recovery_code TO app_rw;
GRANT SELECT, INSERT, UPDATE ON identity.session TO app_rw;
GRANT SELECT, INSERT, UPDATE ON identity.oauth_identity TO app_rw;
GRANT SELECT, INSERT, UPDATE ON identity.verification_token TO app_rw;
GRANT SELECT, INSERT, UPDATE ON identity.step_up_challenge TO app_rw;
GRANT INSERT ON identity.mail_delivery TO app_rw;
GRANT INSERT ON identity.security_event_buffer TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.rate_limit_bucket TO app_rw;
GRANT SELECT, INSERT, DELETE ON ops.dev_secret_vault TO app_rw;

-- Worker (app_worker): mail delivery and retention sweeps only. It never reads password material,
-- session tokens, or MFA rows.
GRANT SELECT (id, primary_email, display_name, locale) ON identity.account TO app_worker;
GRANT SELECT, UPDATE ON identity.mail_delivery TO app_worker;
GRANT DELETE ON identity.mail_delivery TO app_worker;
GRANT SELECT (id, expires_at, consumed_at, revoked_at, sealed_ref), DELETE ON identity.verification_token TO app_worker;
GRANT SELECT (id, absolute_expires_at, idle_expires_at, revoked_at), DELETE ON identity.session TO app_worker;
GRANT SELECT (id, session_id, expires_at, state, token_expires_at), DELETE ON identity.step_up_challenge TO app_worker;
GRANT INSERT ON identity.security_event_buffer TO app_worker;
GRANT SELECT, DELETE ON ops.rate_limit_bucket TO app_worker;
GRANT SELECT, DELETE ON ops.dev_secret_vault TO app_worker;
