-- Reverts 0019 (local/test only).
REVOKE UPDATE (role_id, expires_at, version) ON access.role_assignment FROM app_rw;
REVOKE DELETE ON access.role_assignment FROM app_rw;
REVOKE UPDATE (kind, state, display_name_override, joined_at, suspended_at, removed_at, departure_reason,
  state_changed_by_membership_id, updated_at, version) ON tenancy.membership FROM app_rw;
DROP TABLE tenancy.ownership_transfer;
DROP FUNCTION tenancy.ownership_transfer_guard();
DROP TABLE access.record_grant;
DROP TABLE access.share_group;
DROP FUNCTION access.share_guard();
DELETE FROM identity.mail_delivery WHERE template = 'workspace_invitation';
ALTER TABLE identity.mail_delivery DROP CONSTRAINT mail_delivery_template_known;
ALTER TABLE identity.mail_delivery ADD CONSTRAINT mail_delivery_template_known CHECK (template IN
  ('email_verification', 'account_exists', 'password_reset', 'password_changed', 'mfa_enabled', 'mfa_disabled',
   'recovery_codes_regenerated', 'sessions_revoked', 'oauth_linked', 'oauth_unlinked'));
DELETE FROM identity.verification_token WHERE purpose = 'invitation_acceptance';
ALTER TABLE identity.verification_token DROP CONSTRAINT verification_token_account_required;
ALTER TABLE identity.verification_token ADD CONSTRAINT verification_token_account_required
  CHECK (purpose = 'oauth_state' OR account_id IS NOT NULL);
ALTER TABLE identity.verification_token DROP CONSTRAINT verification_token_purpose_known;
ALTER TABLE identity.verification_token ADD CONSTRAINT verification_token_purpose_known
  CHECK (purpose IN ('email_verification', 'password_reset', 'sign_in_continuation', 'oauth_state'));
DROP TABLE tenancy.invitation;
DROP FUNCTION tenancy.invitation_guard();
DROP TABLE access.workspace_policy;
DROP TRIGGER team_member_role_shape ON tenancy.team_member;
DROP TRIGGER role_assignment_role_shape ON access.role_assignment;
DROP TRIGGER membership_role_shape ON tenancy.membership;
DROP FUNCTION access.assert_membership_role_shape();
ALTER TABLE access.role_assignment DROP CONSTRAINT role_assignment_team_scope;
DROP INDEX access.role_assignment_by_team;
ALTER TABLE access.role_assignment DROP CONSTRAINT role_assignment_team_fkey;
ALTER TABLE access.role_assignment DROP COLUMN team_principal_id;
DROP TABLE tenancy.team_member;
DROP TABLE tenancy.team;
DROP INDEX core.record_by_owner_membership;
ALTER TABLE core.record DROP CONSTRAINT record_owner_membership_fkey;
DROP TRIGGER membership_guard ON tenancy.membership;
DROP FUNCTION tenancy.membership_guard();
DROP INDEX tenancy.membership_by_state_changer;
ALTER TABLE tenancy.membership DROP CONSTRAINT membership_state_changed_by_fkey;
ALTER TABLE tenancy.membership DROP CONSTRAINT membership_departure_reason;
ALTER TABLE tenancy.membership DROP COLUMN state_changed_by_membership_id;
ALTER TABLE tenancy.membership DROP COLUMN departure_reason;
