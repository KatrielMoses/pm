-- migrate:phase expand
-- Phase 2E (0B ADR-25, 0C AZ-25): brand intake forms. OD-28 is open, so forms accept submissions
-- only from signed-in members who can read the brand; each submission becomes an Inbox item owned
-- by the form's queue owner and is receipted here (append-only).

CREATE TABLE capture.intake_form (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  scope_key uuid NOT NULL,
  lifecycle_state core.lifecycle_state NOT NULL DEFAULT 'active',
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  target_kind text NOT NULL DEFAULT 'task',
  queue_owner_membership_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'active',
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT intake_form_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT intake_form_scope_is_brand CHECK (scope_key = brand_id),
  CONSTRAINT intake_form_envelope_fkey FOREIGN KEY (id, workspace_id, scope_key, lifecycle_state)
    REFERENCES core.record (id, workspace_id, scope_key, lifecycle_state)
    ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT intake_form_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT intake_form_owner_fkey FOREIGN KEY (workspace_id, queue_owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT intake_form_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT intake_form_name_text CHECK (char_length(btrim(name)) BETWEEN 1 AND 200 AND name = btrim(name)
    AND tenancy.valid_plain_text(name, 200)),
  CONSTRAINT intake_form_description CHECK (char_length(description) <= 2000),
  CONSTRAINT intake_form_target_known CHECK (target_kind IN ('task', 'project')),
  CONSTRAINT intake_form_state_known CHECK (state IN ('active', 'archived')),
  CONSTRAINT intake_form_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX intake_form_by_envelope ON capture.intake_form (id, workspace_id, scope_key, lifecycle_state);
CREATE INDEX intake_form_by_brand ON capture.intake_form (workspace_id, brand_id, state, name);
CREATE INDEX intake_form_by_owner ON capture.intake_form (workspace_id, queue_owner_membership_id);
CREATE INDEX intake_form_by_creator ON capture.intake_form (workspace_id, created_by_membership_id);

CREATE TABLE capture.intake_submission (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  form_id uuid NOT NULL,
  submitter_membership_id uuid NOT NULL,
  inbox_item_id uuid NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intake_submission_form_fkey FOREIGN KEY (workspace_id, form_id)
    REFERENCES capture.intake_form (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT intake_submission_submitter_fkey FOREIGN KEY (workspace_id, submitter_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT intake_submission_item_fkey FOREIGN KEY (workspace_id, inbox_item_id)
    REFERENCES capture.inbox_item (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT intake_submission_item_unique UNIQUE (inbox_item_id)
);
CREATE INDEX intake_submission_by_form ON capture.intake_submission (workspace_id, form_id, submitted_at DESC);
CREATE INDEX intake_submission_by_submitter ON capture.intake_submission (workspace_id, submitter_membership_id);
CREATE INDEX intake_submission_by_item ON capture.intake_submission (workspace_id, inbox_item_id);

ALTER TABLE capture.intake_form ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture.intake_form FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON capture.intake_form
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE capture.intake_submission ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture.intake_submission FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON capture.intake_submission
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON capture.intake_form, capture.intake_submission FROM PUBLIC;
GRANT SELECT, INSERT ON capture.intake_form TO app_rw;
GRANT UPDATE (name, description, target_kind, queue_owner_membership_id, state, updated_at, version)
  ON capture.intake_form TO app_rw;
GRANT SELECT, INSERT ON capture.intake_submission TO app_rw;
GRANT SELECT, DELETE ON capture.intake_form, capture.intake_submission TO app_worker;
