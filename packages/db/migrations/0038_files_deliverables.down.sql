-- Reverts 0038 (local/test only). Restores the exact 0037 catalog.
DROP FUNCTION exec_dispatch.discover_file_work(timestamptz, integer);
REVOKE USAGE ON SCHEMA files FROM pm_scheduler;
REVOKE SELECT (workspace_id, effect_key, state, created_at) ON exec.external_effect FROM pm_scheduler;
DROP POLICY scheduler_object_effects ON exec.external_effect;
ALTER TABLE collab.review_request DROP CONSTRAINT review_request_subject_known;
ALTER TABLE collab.review_request ADD CONSTRAINT review_request_subject_known
  CHECK (subject_kind IN ('task', 'project'));
ALTER TABLE files.deliverable DROP CONSTRAINT deliverable_current_version_fkey;
ALTER TABLE files.deliverable DROP CONSTRAINT deliverable_accepted_version_fkey;
DROP TABLE files.deliverable_version;
ALTER TABLE collab.review_decision DROP CONSTRAINT review_decision_workspace_key;
DROP FUNCTION files.deliverable_version_guard();
DROP TABLE files.deliverable;
DROP TABLE files.upload_session;
ALTER TABLE files.file DROP CONSTRAINT file_current_version_fkey;
DROP TABLE files.file_version;
DROP FUNCTION files.file_version_guard();
DROP TABLE files.file;
DROP TABLE files.file_object;
DROP TABLE files.storage_usage;
DROP SCHEMA files;
