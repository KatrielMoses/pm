-- Reverts 0018 (local/test only).
DROP FUNCTION tenancy.account_selected_workspace(uuid);
DROP POLICY directory_lookup ON tenancy.scope_preference;
REVOKE SELECT (workspace_id, owner_membership_id, updated_at) ON tenancy.scope_preference FROM pm_directory;
DROP TABLE tenancy.scope_preference;
DROP TABLE tenancy.brand_setting;
DROP FUNCTION tenancy.valid_priorities(jsonb);
DROP FUNCTION tenancy.valid_calendar(jsonb);
DROP FUNCTION tenancy.valid_working_hours(jsonb);
ALTER TABLE access.role_assignment DROP CONSTRAINT role_assignment_brand_fkey;
DROP INDEX core.record_by_brand;
ALTER TABLE core.deletion_batch DROP CONSTRAINT deletion_batch_brand_fkey;
ALTER TABLE core.archive_batch DROP CONSTRAINT archive_batch_brand_fkey;
ALTER TABLE core.record DROP CONSTRAINT record_brand_fkey;
DROP TABLE tenancy.brand;
DROP FUNCTION tenancy.valid_plain_text(text, integer);
ALTER TABLE core.record DROP CONSTRAINT record_brand_self;
