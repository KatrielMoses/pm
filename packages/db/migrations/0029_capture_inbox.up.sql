-- migrate:phase expand
-- Phase 2E (0B ADR-25, 0C AZ-25, 0D PL-27): the personal Inbox, notes, and conversion lineage.
-- Inbox items and notes are personal records (OD-03): one owner, an optional brand, visible only to
-- the owner. The original captured text, source, and correlation never change. No voice, email,
-- API, webhook, or file-storage tables (7F, 6A, 6B, 4E).

CREATE SCHEMA capture;
REVOKE ALL ON SCHEMA capture FROM PUBLIC;
GRANT USAGE ON SCHEMA capture TO app_rw, app_worker;

-- ---------------------------------------------------------------------------------------------
-- Inbox items
-- ---------------------------------------------------------------------------------------------
CREATE TABLE capture.inbox_item (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid,
  scope_key uuid NOT NULL,
  lifecycle_state core.lifecycle_state NOT NULL DEFAULT 'active',
  owner_membership_id uuid NOT NULL,
  intent text NOT NULL DEFAULT 'task',
  raw_text text NOT NULL,
  source_kind text NOT NULL,
  source_ref text,
  correlation_id uuid NOT NULL,
  parse_version integer NOT NULL,
  parsed jsonb NOT NULL DEFAULT '{}',
  capture_batch_id uuid,
  triage_state text NOT NULL DEFAULT 'untriaged',
  converted_kind text,
  converted_record_id uuid,
  merged_into_id uuid,
  triaged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT inbox_item_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT inbox_item_scope_key CHECK (scope_key = coalesce(brand_id, workspace_id)),
  CONSTRAINT inbox_item_envelope_fkey FOREIGN KEY (id, workspace_id, scope_key, lifecycle_state)
    REFERENCES core.record (id, workspace_id, scope_key, lifecycle_state)
    ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT inbox_item_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT inbox_item_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT inbox_item_merged_fkey FOREIGN KEY (workspace_id, merged_into_id)
    REFERENCES capture.inbox_item (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT inbox_item_intent_known CHECK (intent IN ('task', 'note')),
  -- The database bound is the widest configurable CAPTURE_TEXT_MAX.
  CONSTRAINT inbox_item_raw_text CHECK (char_length(raw_text) BETWEEN 1 AND 50000),
  CONSTRAINT inbox_item_source_known CHECK (source_kind IN
    ('typed', 'paste', 'form', 'voice', 'email', 'api', 'webhook')),
  CONSTRAINT inbox_item_source_ref CHECK (source_ref IS NULL OR source_ref ~ '^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{26}$'
    OR source_ref ~ '^batch:[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT inbox_item_parse_version CHECK (parse_version >= 1),
  CONSTRAINT inbox_item_parsed CHECK (jsonb_typeof(parsed) = 'object' AND pg_column_size(parsed) <= 65536),
  CONSTRAINT inbox_item_triage_known CHECK (triage_state IN ('untriaged', 'converted', 'merged', 'discarded')),
  CONSTRAINT inbox_item_conversion CHECK ((triage_state = 'converted') = (converted_kind IS NOT NULL)
    AND (converted_kind IS NULL OR converted_kind IN ('task', 'note', 'project'))
    AND (converted_kind IS NULL) = (converted_record_id IS NULL)),
  CONSTRAINT inbox_item_merge CHECK ((triage_state = 'merged') = (merged_into_id IS NOT NULL) AND merged_into_id IS DISTINCT FROM id),
  CONSTRAINT inbox_item_triaged_at CHECK ((triaged_at IS NULL) = (triage_state = 'untriaged')),
  CONSTRAINT inbox_item_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX inbox_item_by_envelope ON capture.inbox_item (id, workspace_id, scope_key, lifecycle_state);
-- The daily Inbox: one owner's untriaged items, newest first.
CREATE INDEX inbox_item_by_owner ON capture.inbox_item (workspace_id, owner_membership_id, triage_state, created_at DESC, id);
CREATE INDEX inbox_item_by_brand ON capture.inbox_item (workspace_id, brand_id);
CREATE INDEX inbox_item_by_merge ON capture.inbox_item (workspace_id, merged_into_id);
CREATE INDEX inbox_item_by_batch ON capture.inbox_item (workspace_id, capture_batch_id);

-- The original capture never changes; triage moves only forward (untriaged → one outcome), except
-- that a merged or discarded item may be restored to untriaged by its owner.
CREATE FUNCTION capture.inbox_item_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.raw_text IS DISTINCT FROM OLD.raw_text OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
     OR NEW.source_ref IS DISTINCT FROM OLD.source_ref OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.owner_membership_id IS DISTINCT FROM OLD.owner_membership_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.brand_id IS DISTINCT FROM OLD.brand_id OR NEW.capture_batch_id IS DISTINCT FROM OLD.capture_batch_id THEN
    RAISE EXCEPTION 'the original capture is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.triage_state = 'converted' AND NEW.triage_state <> 'converted' THEN
    RAISE EXCEPTION 'a converted item stays converted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.triage_state IN ('merged', 'discarded') AND NEW.triage_state NOT IN (OLD.triage_state, 'untriaged') THEN
    RAISE EXCEPTION 'restore the item before triaging it again' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER inbox_item_guard BEFORE UPDATE ON capture.inbox_item
  FOR EACH ROW EXECUTE FUNCTION capture.inbox_item_guard();

-- ---------------------------------------------------------------------------------------------
-- Notes
-- ---------------------------------------------------------------------------------------------
CREATE TABLE capture.note (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid,
  scope_key uuid NOT NULL,
  lifecycle_state core.lifecycle_state NOT NULL DEFAULT 'active',
  owner_membership_id uuid NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  source_inbox_item_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT note_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT note_scope_key CHECK (scope_key = coalesce(brand_id, workspace_id)),
  CONSTRAINT note_envelope_fkey FOREIGN KEY (id, workspace_id, scope_key, lifecycle_state)
    REFERENCES core.record (id, workspace_id, scope_key, lifecycle_state)
    ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT note_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT note_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT note_source_fkey FOREIGN KEY (workspace_id, source_inbox_item_id)
    REFERENCES capture.inbox_item (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT note_title_text CHECK (char_length(btrim(title)) BETWEEN 1 AND 300 AND title = btrim(title)
    AND tenancy.valid_plain_text(title, 300)),
  CONSTRAINT note_body_size CHECK (char_length(body) <= 50000),
  CONSTRAINT note_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX note_by_envelope ON capture.note (id, workspace_id, scope_key, lifecycle_state);
CREATE INDEX note_by_owner ON capture.note (workspace_id, owner_membership_id, updated_at DESC, id);
CREATE INDEX note_by_brand ON capture.note (workspace_id, brand_id);
CREATE INDEX note_by_source ON capture.note (workspace_id, source_inbox_item_id);

-- ---------------------------------------------------------------------------------------------
-- Conversion lineage (append-only): what an item or note became.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE capture.capture_conversion (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  source_record_id uuid NOT NULL,
  source_kind text NOT NULL,
  target_record_id uuid NOT NULL,
  target_kind text NOT NULL,
  by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT capture_conversion_unique UNIQUE (workspace_id, source_record_id, target_record_id),
  CONSTRAINT capture_conversion_source_fkey FOREIGN KEY (workspace_id, source_record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT capture_conversion_by_fkey FOREIGN KEY (workspace_id, by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT capture_conversion_source_known CHECK (source_kind IN ('inbox_item', 'note')),
  CONSTRAINT capture_conversion_target_known CHECK (target_kind IN ('task', 'note', 'project'))
);
CREATE INDEX capture_conversion_by_target ON capture.capture_conversion (workspace_id, target_record_id);
CREATE INDEX capture_conversion_by_actor ON capture.capture_conversion (workspace_id, by_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE capture.inbox_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture.inbox_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON capture.inbox_item
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE capture.note ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture.note FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON capture.note
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE capture.capture_conversion ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture.capture_conversion FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON capture.capture_conversion
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON capture.inbox_item, capture.note, capture.capture_conversion FROM PUBLIC;
GRANT SELECT, INSERT ON capture.inbox_item TO app_rw;
GRANT UPDATE (intent, parse_version, parsed, triage_state, converted_kind, converted_record_id, merged_into_id,
  triaged_at, updated_at, version) ON capture.inbox_item TO app_rw;
GRANT SELECT, INSERT ON capture.note TO app_rw;
GRANT UPDATE (title, body, updated_at, version) ON capture.note TO app_rw;
GRANT SELECT, INSERT ON capture.capture_conversion TO app_rw;
-- The worker purges personal records (lifecycle and departure) and detaches project intake sources.
GRANT SELECT, DELETE ON capture.inbox_item, capture.note, capture.capture_conversion TO app_worker;
GRANT UPDATE (intake_source_id) ON work.project TO app_worker;
GRANT UPDATE (source_inbox_item_id) ON capture.note TO app_worker;
REVOKE ALL ON FUNCTION capture.inbox_item_guard() FROM PUBLIC;
