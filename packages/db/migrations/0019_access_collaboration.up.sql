-- migrate:phase expand
-- Phase 1D collaboration: membership transitions, invitations, workspace policy, teams, explicit
-- record shares, and ownership transfer. Extends the canonical 1C tables (never replaces them).
--
-- Authority stays membership + access.role_assignment (+ access.record_grant for exact records).
-- Guests never hold role assignments; internal active members hold exactly one workspace role.

-- ---------------------------------------------------------------------------------------------
-- Memberships: departure metadata and guarded transitions
-- ---------------------------------------------------------------------------------------------
ALTER TABLE tenancy.membership ADD COLUMN departure_reason text;
ALTER TABLE tenancy.membership ADD COLUMN state_changed_by_membership_id uuid;
ALTER TABLE tenancy.membership ADD CONSTRAINT membership_departure_reason
  CHECK ((state = 'removed') = (departure_reason IS NOT NULL)
    AND (departure_reason IS NULL OR departure_reason IN ('removed', 'left', 'account_deleted')));
ALTER TABLE tenancy.membership ADD CONSTRAINT membership_state_changed_by_fkey
  FOREIGN KEY (workspace_id, state_changed_by_membership_id) REFERENCES tenancy.membership (workspace_id, id)
  ON DELETE RESTRICT;
CREATE INDEX membership_by_state_changer ON tenancy.membership (workspace_id, state_changed_by_membership_id);

-- invited → active; active ↔ suspended; active|suspended → removed; removed → active only as a
-- fresh acceptance (the service clears every assignment, team membership, and grant at removal).
CREATE FUNCTION tenancy.membership_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.account_id <> OLD.account_id
     OR NEW.public_id <> OLD.public_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'membership identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'invited' AND NEW.state IN ('active', 'removed'))
    OR (OLD.state = 'active' AND NEW.state IN ('suspended', 'removed'))
    OR (OLD.state = 'suspended' AND NEW.state IN ('active', 'removed'))
    OR (OLD.state = 'removed' AND NEW.state = 'active')) THEN
    RAISE EXCEPTION 'membership transition % → % is not allowed', OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind <> OLD.kind AND NOT (OLD.state = 'removed' AND NEW.state = 'active') THEN
    RAISE EXCEPTION 'membership kind changes only on re-acceptance' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'membership version must advance by one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER membership_guard BEFORE UPDATE ON tenancy.membership
  FOR EACH ROW EXECUTE FUNCTION tenancy.membership_guard();

-- Deferred from 1F: an envelope's accountable owner is a membership of the same workspace. Owners
-- are reassigned (never nulled while required) by the departure hooks.
ALTER TABLE core.record ADD CONSTRAINT record_owner_membership_fkey FOREIGN KEY (workspace_id, owner_membership_id)
  REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE core.record VALIDATE CONSTRAINT record_owner_membership_fkey;
CREATE INDEX record_by_owner_membership ON core.record (workspace_id, owner_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Teams: addressable core.record extensions (workspace scope; never a scope themselves)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE tenancy.team (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  scope_key uuid NOT NULL,
  lifecycle_state core.lifecycle_state NOT NULL DEFAULT 'active',
  name text NOT NULL,
  description text,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_membership_id uuid,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT team_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT team_scope_is_workspace CHECK (scope_key = workspace_id),
  CONSTRAINT team_envelope_fkey FOREIGN KEY (id, workspace_id, scope_key, lifecycle_state)
    REFERENCES core.record (id, workspace_id, scope_key, lifecycle_state)
    ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT team_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT team_updater_fkey FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT team_name_text CHECK (char_length(btrim(name)) BETWEEN 1 AND 80 AND name = btrim(name)
    AND tenancy.valid_plain_text(name, 80)),
  CONSTRAINT team_description_text CHECK (tenancy.valid_plain_text(description, 2000)),
  CONSTRAINT team_version_nonnegative CHECK (version >= 0)
);
CREATE UNIQUE INDEX team_name_unique ON tenancy.team (workspace_id, lower(name)) WHERE lifecycle_state <> 'purged';
CREATE INDEX team_by_envelope ON tenancy.team (id, workspace_id, scope_key, lifecycle_state);
CREATE INDEX team_by_creator ON tenancy.team (workspace_id, created_by_membership_id);
CREATE INDEX team_by_updater ON tenancy.team (workspace_id, updated_by_membership_id);

CREATE TABLE tenancy.team_member (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  team_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  added_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, team_id, membership_id),
  CONSTRAINT team_member_team_fkey FOREIGN KEY (workspace_id, team_id)
    REFERENCES tenancy.team (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT team_member_membership_fkey FOREIGN KEY (workspace_id, membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT team_member_added_by_fkey FOREIGN KEY (workspace_id, added_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX team_member_by_membership ON tenancy.team_member (workspace_id, membership_id);
CREATE INDEX team_member_by_adder ON tenancy.team_member (workspace_id, added_by_membership_id);

-- Team principals on role assignments (0B principal_type includes team).
ALTER TABLE access.role_assignment ADD COLUMN team_principal_id uuid
  GENERATED ALWAYS AS (CASE WHEN principal_type = 'team' THEN principal_id END) STORED;
ALTER TABLE access.role_assignment ADD CONSTRAINT role_assignment_team_fkey
  FOREIGN KEY (workspace_id, team_principal_id) REFERENCES tenancy.team (workspace_id, id) ON DELETE RESTRICT;
CREATE INDEX role_assignment_by_team ON access.role_assignment (workspace_id, team_principal_id);
-- Teams hold scope grants only, never a workspace role.
ALTER TABLE access.role_assignment ADD CONSTRAINT role_assignment_team_scope
  CHECK (principal_type <> 'team' OR scope_type <> 'workspace');

-- ---------------------------------------------------------------------------------------------
-- Role shape (0C AZ-06, §3.1): guests never hold role assignments and never join teams; every
-- active or suspended internal membership holds exactly one workspace role (checked at commit).
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION access.assert_membership_role_shape() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  ws uuid := coalesce(NEW.workspace_id, OLD.workspace_id);
  mid uuid;
BEGIN
  IF TG_TABLE_NAME = 'membership' THEN
    mid := NEW.id;
  ELSIF TG_TABLE_NAME = 'team_member' THEN
    mid := coalesce(NEW.membership_id, OLD.membership_id);
  ELSE
    mid := coalesce(NEW.membership_principal_id, OLD.membership_principal_id);
  END IF;
  IF mid IS NULL THEN
    RETURN NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM tenancy.membership m
    WHERE m.workspace_id = ws AND m.id = mid AND (
      (m.kind = 'guest' AND (
         EXISTS (SELECT 1 FROM access.role_assignment a WHERE a.workspace_id = ws AND a.membership_principal_id = mid)
         OR EXISTS (SELECT 1 FROM tenancy.team_member t WHERE t.workspace_id = ws AND t.membership_id = mid)))
      OR (m.kind = 'member' AND m.state IN ('active', 'suspended') AND (
         SELECT count(*) FROM access.role_assignment a
         WHERE a.workspace_id = ws AND a.membership_principal_id = mid AND a.scope_type = 'workspace') <> 1)
      OR (m.state = 'removed' AND (
         EXISTS (SELECT 1 FROM access.role_assignment a WHERE a.workspace_id = ws AND a.membership_principal_id = mid)
         OR EXISTS (SELECT 1 FROM tenancy.team_member t WHERE t.workspace_id = ws AND t.membership_id = mid))))) THEN
    RAISE EXCEPTION 'membership role shape violated (guest assignments, internal role count, or removed authority)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER membership_role_shape AFTER INSERT OR UPDATE ON tenancy.membership
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access.assert_membership_role_shape();
CREATE CONSTRAINT TRIGGER role_assignment_role_shape AFTER INSERT OR UPDATE OR DELETE ON access.role_assignment
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access.assert_membership_role_shape();
CREATE CONSTRAINT TRIGGER team_member_role_shape AFTER INSERT OR UPDATE ON tenancy.team_member
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access.assert_membership_role_shape();

-- ---------------------------------------------------------------------------------------------
-- Workspace policy (0B access.workspace_policy, 0C AZ-19 safe defaults). A missing row means the
-- defaults; the row is written on the first change.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE access.workspace_policy (
  workspace_id uuid PRIMARY KEY REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  self_approval_mode text NOT NULL DEFAULT 'auto',
  require_independent_for text[] NOT NULL DEFAULT '{}',
  members_invite_guests boolean NOT NULL DEFAULT false,
  limited_members_can_export boolean NOT NULL DEFAULT false,
  limited_members_tokens boolean NOT NULL DEFAULT false,
  limited_members_ai boolean NOT NULL DEFAULT false,
  limited_members_agents boolean NOT NULL DEFAULT false,
  read_only_ai boolean NOT NULL DEFAULT false,
  members_configure_agents boolean NOT NULL DEFAULT false,
  admins_manage_billing boolean NOT NULL DEFAULT false,
  comment_on_archived boolean NOT NULL DEFAULT false,
  workspace_records_default_level text NOT NULL DEFAULT 'view',
  cross_brand_sharing_enabled boolean NOT NULL DEFAULT false,
  guest_invitations_enabled boolean NOT NULL DEFAULT true,
  public_links_enabled boolean NOT NULL DEFAULT false,
  share_max_expiry interval,
  token_max_lifetime interval,
  low_impact_agent_actions text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_membership_id uuid,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT workspace_policy_self_approval_known CHECK (self_approval_mode IN ('auto', 'allowed', 'forbidden')),
  CONSTRAINT workspace_policy_default_level_known CHECK (workspace_records_default_level IN ('none', 'view', 'comment', 'edit')),
  CONSTRAINT workspace_policy_no_public_links CHECK (public_links_enabled = false),
  CONSTRAINT workspace_policy_share_expiry CHECK (share_max_expiry IS NULL OR share_max_expiry > interval '0'),
  CONSTRAINT workspace_policy_token_lifetime CHECK (token_max_lifetime IS NULL OR token_max_lifetime > interval '0'),
  CONSTRAINT workspace_policy_bounded_arrays CHECK (cardinality(require_independent_for) <= 64 AND cardinality(low_impact_agent_actions) <= 64),
  CONSTRAINT workspace_policy_updater_fkey FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX workspace_policy_by_updater ON access.workspace_policy (workspace_id, updated_by_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Invitations (state machine; token hash lives in identity.verification_token)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE tenancy.invitation (
  id uuid PRIMARY KEY,
  public_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  email_key text NOT NULL,
  kind text NOT NULL,
  role_key text,
  scope_proposal jsonb NOT NULL,
  invited_by_membership_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  send_count integer NOT NULL DEFAULT 1,
  last_sent_at timestamptz NOT NULL DEFAULT now(),
  token_id uuid NOT NULL,
  accepted_account_id uuid REFERENCES identity.account (id) ON DELETE RESTRICT,
  accepted_membership_id uuid,
  revoked_by_membership_id uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT invitation_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT invitation_public_id_key UNIQUE (public_id),
  CONSTRAINT invitation_public_id_format CHECK (public_id ~ '^inv_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT invitation_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT invitation_email_key_format CHECK (char_length(email_key) BETWEEN 3 AND 254 AND email_key = lower(email_key)
    AND email_key ~ '^[^@\s]+@[^@\s]+$'),
  CONSTRAINT invitation_kind_known CHECK (kind IN ('member', 'guest')),
  CONSTRAINT invitation_role_matches_kind CHECK (
    (kind = 'guest' AND role_key IS NULL)
    OR (kind = 'member' AND role_key IN ('owner', 'administrator', 'member', 'limited_member', 'read_only'))),
  CONSTRAINT invitation_scope_proposal_shape CHECK (jsonb_typeof(scope_proposal) = 'object'
    AND octet_length(scope_proposal::text) <= 16384),
  CONSTRAINT invitation_guest_records CHECK (kind <> 'guest'
    OR (jsonb_typeof(scope_proposal->'records') = 'array' AND jsonb_array_length(scope_proposal->'records') BETWEEN 1 AND 50)),
  CONSTRAINT invitation_state_known CHECK (state IN ('pending', 'accepted', 'revoked', 'expired')),
  CONSTRAINT invitation_accepted_fields CHECK ((state = 'accepted') = (accepted_account_id IS NOT NULL AND accepted_membership_id IS NOT NULL)),
  CONSTRAINT invitation_decided_fields CHECK ((state = 'pending') = (decided_at IS NULL)),
  CONSTRAINT invitation_revoked_fields CHECK ((state = 'revoked') = (revoked_by_membership_id IS NOT NULL)),
  CONSTRAINT invitation_send_count CHECK (send_count BETWEEN 1 AND 50),
  CONSTRAINT invitation_inviter_fkey FOREIGN KEY (workspace_id, invited_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT invitation_membership_fkey FOREIGN KEY (workspace_id, accepted_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT invitation_revoker_fkey FOREIGN KEY (workspace_id, revoked_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX invitation_one_pending ON tenancy.invitation (workspace_id, email_key) WHERE state = 'pending';
CREATE INDEX invitation_by_state ON tenancy.invitation (workspace_id, state, created_at DESC, id);
CREATE INDEX invitation_by_inviter ON tenancy.invitation (workspace_id, invited_by_membership_id);
CREATE INDEX invitation_by_membership ON tenancy.invitation (workspace_id, accepted_membership_id);
CREATE INDEX invitation_by_revoker ON tenancy.invitation (workspace_id, revoked_by_membership_id);
CREATE INDEX invitation_by_account ON tenancy.invitation (accepted_account_id);

CREATE FUNCTION tenancy.invitation_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.public_id <> OLD.public_id
     OR NEW.email_key <> OLD.email_key OR NEW.kind <> OLD.kind OR NEW.role_key IS DISTINCT FROM OLD.role_key
     OR NEW.scope_proposal <> OLD.scope_proposal OR NEW.invited_by_membership_id <> OLD.invited_by_membership_id THEN
    RAISE EXCEPTION 'invitation terms are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state <> 'pending' THEN
    RAISE EXCEPTION 'a decided invitation is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invitation version must advance by one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER invitation_guard BEFORE UPDATE ON tenancy.invitation
  FOR EACH ROW EXECUTE FUNCTION tenancy.invitation_guard();

-- Invitation tokens use the 1B single-use token boundary (hash only; raw token sealed for mail).
ALTER TABLE identity.verification_token DROP CONSTRAINT verification_token_purpose_known;
ALTER TABLE identity.verification_token ADD CONSTRAINT verification_token_purpose_known
  CHECK (purpose IN ('email_verification', 'password_reset', 'sign_in_continuation', 'oauth_state', 'invitation_acceptance'));
ALTER TABLE identity.verification_token DROP CONSTRAINT verification_token_account_required;
ALTER TABLE identity.verification_token ADD CONSTRAINT verification_token_account_required
  CHECK (purpose IN ('oauth_state', 'invitation_acceptance') OR account_id IS NOT NULL);

-- Invitation mail uses the durable 1B mail outbox (recipient email, no account yet).
ALTER TABLE identity.mail_delivery DROP CONSTRAINT mail_delivery_template_known;
ALTER TABLE identity.mail_delivery ADD CONSTRAINT mail_delivery_template_known CHECK (template IN
  ('email_verification', 'account_exists', 'password_reset', 'password_changed', 'mfa_enabled', 'mfa_disabled',
   'recovery_codes_regenerated', 'sessions_revoked', 'oauth_linked', 'oauth_unlinked', 'workspace_invitation'));

-- ---------------------------------------------------------------------------------------------
-- Explicit record shares (0B access.share_group / access.record_grant; 0C §6)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE access.share_group (
  id uuid PRIMARY KEY,
  public_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  source_record_id uuid NOT NULL,
  source_brand_id uuid,
  grantee_type text NOT NULL,
  grantee_id uuid NOT NULL,
  grantee_membership_id uuid GENERATED ALWAYS AS (CASE WHEN grantee_type = 'membership' THEN grantee_id END) STORED,
  grantee_team_id uuid GENERATED ALWAYS AS (CASE WHEN grantee_type = 'team' THEN grantee_id END) STORED,
  grantee_brand_id uuid GENERATED ALWAYS AS (CASE WHEN grantee_type = 'brand' THEN grantee_id END) STORED,
  level text NOT NULL,
  expires_at timestamptz,
  state text NOT NULL DEFAULT 'active',
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by_membership_id uuid,
  record_count integer NOT NULL,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT share_group_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT share_group_public_id_key UNIQUE (public_id),
  CONSTRAINT share_group_public_id_format CHECK (public_id ~ '^shr_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT share_group_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT share_group_grantee_known CHECK (grantee_type IN ('brand', 'membership', 'team')),
  CONSTRAINT share_group_level_known CHECK (level IN ('read', 'comment', 'edit')),
  CONSTRAINT share_group_state_known CHECK (state IN ('active', 'revoked', 'expired')),
  CONSTRAINT share_group_revoked_fields CHECK ((state = 'revoked') = (revoked_at IS NOT NULL AND revoked_by_membership_id IS NOT NULL)),
  CONSTRAINT share_group_record_count CHECK (record_count BETWEEN 1 AND 500),
  CONSTRAINT share_group_source_fkey FOREIGN KEY (workspace_id, source_record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT share_group_source_brand_fkey FOREIGN KEY (workspace_id, source_brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT share_group_grantee_membership_fkey FOREIGN KEY (workspace_id, grantee_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT share_group_grantee_team_fkey FOREIGN KEY (workspace_id, grantee_team_id)
    REFERENCES tenancy.team (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT share_group_grantee_brand_fkey FOREIGN KEY (workspace_id, grantee_brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT share_group_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT share_group_revoker_fkey FOREIGN KEY (workspace_id, revoked_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX share_group_by_source ON access.share_group (workspace_id, source_record_id);
CREATE INDEX share_group_by_source_brand ON access.share_group (workspace_id, source_brand_id);
CREATE INDEX share_group_by_membership ON access.share_group (workspace_id, grantee_membership_id);
CREATE INDEX share_group_by_team ON access.share_group (workspace_id, grantee_team_id);
CREATE INDEX share_group_by_brand ON access.share_group (workspace_id, grantee_brand_id);
CREATE INDEX share_group_by_creator ON access.share_group (workspace_id, created_by_membership_id);
CREATE INDEX share_group_by_revoker ON access.share_group (workspace_id, revoked_by_membership_id);

CREATE TABLE access.record_grant (
  id uuid PRIMARY KEY,
  public_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  share_group_id uuid NOT NULL,
  record_id uuid NOT NULL,
  source_brand_id uuid,
  grantee_type text NOT NULL,
  grantee_id uuid NOT NULL,
  grantee_key uuid GENERATED ALWAYS AS (grantee_id) STORED,
  grantee_membership_id uuid GENERATED ALWAYS AS (CASE WHEN grantee_type = 'membership' THEN grantee_id END) STORED,
  grantee_team_id uuid GENERATED ALWAYS AS (CASE WHEN grantee_type = 'team' THEN grantee_id END) STORED,
  grantee_brand_id uuid GENERATED ALWAYS AS (CASE WHEN grantee_type = 'brand' THEN grantee_id END) STORED,
  level text NOT NULL,
  state text NOT NULL DEFAULT 'active',
  expires_at timestamptz,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by_membership_id uuid,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT record_grant_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT record_grant_public_id_key UNIQUE (public_id),
  CONSTRAINT record_grant_public_id_format CHECK (public_id ~ '^grt_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT record_grant_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT record_grant_group_record UNIQUE (share_group_id, record_id),
  CONSTRAINT record_grant_grantee_known CHECK (grantee_type IN ('brand', 'membership', 'team')),
  CONSTRAINT record_grant_level_known CHECK (level IN ('read', 'comment', 'edit')),
  CONSTRAINT record_grant_state_known CHECK (state IN ('active', 'revoked', 'expired')),
  CONSTRAINT record_grant_revoked_fields CHECK ((state = 'revoked') = (revoked_at IS NOT NULL AND revoked_by_membership_id IS NOT NULL)),
  CONSTRAINT record_grant_group_fkey FOREIGN KEY (workspace_id, share_group_id)
    REFERENCES access.share_group (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT record_grant_record_fkey FOREIGN KEY (workspace_id, record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT record_grant_source_brand_fkey FOREIGN KEY (workspace_id, source_brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT record_grant_grantee_membership_fkey FOREIGN KEY (workspace_id, grantee_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT record_grant_grantee_team_fkey FOREIGN KEY (workspace_id, grantee_team_id)
    REFERENCES tenancy.team (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT record_grant_grantee_brand_fkey FOREIGN KEY (workspace_id, grantee_brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT record_grant_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT record_grant_revoker_fkey FOREIGN KEY (workspace_id, revoked_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX record_grant_one_active ON access.record_grant (record_id, grantee_type, grantee_id) WHERE state = 'active';
-- 0B indexes for the visibility semi-join and "shared with me".
CREATE INDEX record_grant_by_record_active ON access.record_grant (workspace_id, record_id, grantee_key) WHERE state = 'active';
CREATE INDEX record_grant_by_grantee_active ON access.record_grant (workspace_id, grantee_key, record_id) WHERE state = 'active';
-- Full indexes covering each foreign key.
CREATE INDEX record_grant_by_group ON access.record_grant (workspace_id, share_group_id);
CREATE INDEX record_grant_by_record ON access.record_grant (workspace_id, record_id);
CREATE INDEX record_grant_by_source_brand ON access.record_grant (workspace_id, source_brand_id);
CREATE INDEX record_grant_by_membership ON access.record_grant (workspace_id, grantee_membership_id);
CREATE INDEX record_grant_by_team ON access.record_grant (workspace_id, grantee_team_id);
CREATE INDEX record_grant_by_brand ON access.record_grant (workspace_id, grantee_brand_id);
CREATE INDEX record_grant_by_creator ON access.record_grant (workspace_id, created_by_membership_id);
CREATE INDEX record_grant_by_revoker ON access.record_grant (workspace_id, revoked_by_membership_id);

-- Shares: terms immutable; active → revoked | expired, terminal after that.
CREATE FUNCTION access.share_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.public_id <> OLD.public_id
     OR NEW.grantee_type <> OLD.grantee_type OR NEW.grantee_id <> OLD.grantee_id OR NEW.level <> OLD.level
     OR NEW.created_by_membership_id <> OLD.created_by_membership_id THEN
    RAISE EXCEPTION 'share terms are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state <> 'active' THEN
    RAISE EXCEPTION 'a revoked or expired share is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER share_group_guard BEFORE UPDATE ON access.share_group
  FOR EACH ROW EXECUTE FUNCTION access.share_guard();
CREATE TRIGGER record_grant_guard BEFORE UPDATE ON access.record_grant
  FOR EACH ROW EXECUTE FUNCTION access.share_guard();

-- Guests: membership grantees only, never brand or team contexts (0C §6.1). A guest share is a
-- membership grant whose membership kind is guest; brand-context grants never reach guests because
-- guests have no brand level (enforced by the compiler) — nothing further to check here.

-- ---------------------------------------------------------------------------------------------
-- Ownership transfer (0C §11.4; ADM-013)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE tenancy.ownership_transfer (
  id uuid PRIMARY KEY,
  public_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  from_membership_id uuid NOT NULL,
  to_membership_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  demote_previous boolean NOT NULL,
  expires_at timestamptz NOT NULL,
  requested_step_up_id uuid NOT NULL,
  accepted_step_up_id uuid,
  decided_at timestamptz,
  decided_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT ownership_transfer_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT ownership_transfer_public_id_key UNIQUE (public_id),
  CONSTRAINT ownership_transfer_public_id_format CHECK (public_id ~ '^otr_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT ownership_transfer_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT ownership_transfer_distinct CHECK (from_membership_id <> to_membership_id),
  CONSTRAINT ownership_transfer_state_known CHECK (state IN ('pending', 'accepted', 'cancelled', 'expired')),
  CONSTRAINT ownership_transfer_decided CHECK ((state = 'pending') = (decided_at IS NULL)),
  CONSTRAINT ownership_transfer_accepted CHECK ((state = 'accepted') = (accepted_step_up_id IS NOT NULL)),
  CONSTRAINT ownership_transfer_from_fkey FOREIGN KEY (workspace_id, from_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT ownership_transfer_to_fkey FOREIGN KEY (workspace_id, to_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT ownership_transfer_decider_fkey FOREIGN KEY (workspace_id, decided_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX ownership_transfer_one_pending ON tenancy.ownership_transfer (workspace_id) WHERE state = 'pending';
CREATE INDEX ownership_transfer_by_from ON tenancy.ownership_transfer (workspace_id, from_membership_id);
CREATE INDEX ownership_transfer_by_to ON tenancy.ownership_transfer (workspace_id, to_membership_id);
CREATE INDEX ownership_transfer_by_decider ON tenancy.ownership_transfer (workspace_id, decided_by_membership_id);

CREATE FUNCTION tenancy.ownership_transfer_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.public_id <> OLD.public_id
     OR NEW.from_membership_id <> OLD.from_membership_id OR NEW.to_membership_id <> OLD.to_membership_id
     OR NEW.demote_previous <> OLD.demote_previous OR NEW.requested_step_up_id <> OLD.requested_step_up_id
     OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'ownership transfer terms are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state <> 'pending' THEN
    RAISE EXCEPTION 'a decided ownership transfer is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'ownership transfer version must advance by one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER ownership_transfer_guard BEFORE UPDATE ON tenancy.ownership_transfer
  FOR EACH ROW EXECUTE FUNCTION tenancy.ownership_transfer_guard();

-- ---------------------------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE tenancy.team ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.team FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenancy.team
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE tenancy.team_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.team_member FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenancy.team_member
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE access.workspace_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE access.workspace_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON access.workspace_policy
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE tenancy.invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.invitation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenancy.invitation
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE access.share_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE access.share_group FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON access.share_group
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE access.record_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE access.record_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON access.record_grant
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE tenancy.ownership_transfer ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.ownership_transfer FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenancy.ownership_transfer
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON tenancy.team, tenancy.team_member, access.workspace_policy, tenancy.invitation,
  access.share_group, access.record_grant, tenancy.ownership_transfer FROM PUBLIC;
-- Memberships and role assignments: managed transitions only (1C granted SELECT/INSERT).
GRANT UPDATE (kind, state, display_name_override, joined_at, suspended_at, removed_at, departure_reason,
  state_changed_by_membership_id, updated_at, version) ON tenancy.membership TO app_rw;
GRANT UPDATE (role_id, expires_at, version) ON access.role_assignment TO app_rw;
GRANT DELETE ON access.role_assignment TO app_rw;
GRANT SELECT, INSERT ON tenancy.team TO app_rw;
GRANT UPDATE (name, description, updated_at, updated_by_membership_id, version) ON tenancy.team TO app_rw;
GRANT SELECT, INSERT, DELETE ON tenancy.team_member TO app_rw;
GRANT SELECT, INSERT ON access.workspace_policy TO app_rw;
GRANT UPDATE (self_approval_mode, require_independent_for, members_invite_guests, limited_members_can_export,
  limited_members_tokens, limited_members_ai, limited_members_agents, read_only_ai, members_configure_agents,
  admins_manage_billing, comment_on_archived, workspace_records_default_level, cross_brand_sharing_enabled,
  guest_invitations_enabled, share_max_expiry, token_max_lifetime, low_impact_agent_actions, updated_at,
  updated_by_membership_id, version) ON access.workspace_policy TO app_rw;
GRANT SELECT, INSERT ON tenancy.invitation TO app_rw;
GRANT UPDATE (state, expires_at, send_count, last_sent_at, token_id, accepted_account_id, accepted_membership_id,
  revoked_by_membership_id, decided_at, updated_at, version) ON tenancy.invitation TO app_rw;
GRANT SELECT, INSERT ON access.share_group, access.record_grant TO app_rw;
GRANT UPDATE (state, revoked_at, revoked_by_membership_id, version) ON access.share_group, access.record_grant TO app_rw;
GRANT UPDATE (record_count) ON access.share_group TO app_rw;
GRANT SELECT, INSERT ON tenancy.ownership_transfer TO app_rw;
GRANT UPDATE (state, accepted_step_up_id, decided_at, decided_by_membership_id, version) ON tenancy.ownership_transfer TO app_rw;
GRANT SELECT ON tenancy.team, tenancy.team_member, access.workspace_policy, tenancy.invitation,
  access.share_group, access.record_grant, tenancy.ownership_transfer TO app_worker;
-- The worker expires invitations, shares, and ownership transfers on schedule.
GRANT UPDATE (state, decided_at, updated_at, version) ON tenancy.invitation TO app_worker;
GRANT UPDATE (state, version) ON access.share_group, access.record_grant TO app_worker;
GRANT UPDATE (state, decided_at, version) ON tenancy.ownership_transfer TO app_worker;
REVOKE ALL ON FUNCTION tenancy.membership_guard(), access.assert_membership_role_shape(),
  tenancy.invitation_guard(), access.share_guard(), tenancy.ownership_transfer_guard() FROM PUBLIC;
