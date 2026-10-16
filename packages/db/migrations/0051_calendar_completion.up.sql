-- migrate:phase expand
-- Phase 6 integration review (ADR-0037; 0B ADR-42, 0C AZ-42, 0D PL-44): completes Google Calendar on
-- top of 0047 without editing it. Adds the connected-calendar list with selection, direction and
-- brand mapping (CAL-006, WSB-010), provider recurring series and their occurrence exceptions
-- (CAL-005), and the event-to-work-block link with its agreed base versions (CAL-012/013). It also
-- moves the 0047 and 0050 tenant policies onto the canonical fail-closed workspace context with an
-- explicit WITH CHECK, matching every other tenant table.

-- ---------------------------------------------------------------------------------------------
-- Connected calendars (CAL-006). One row per calendar the provider lists for a connection. Only
-- selected calendars are synchronized. Two-way requires a writable calendar and the write scope.
-- Brand mapping places the owner's events in that brand for their own conflict and capacity reads.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE integrations.calendar_source (
  id uuid PRIMARY KEY,
  public_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  connection_id uuid NOT NULL,
  owner_membership_id uuid NOT NULL,
  external_calendar_id text NOT NULL,
  label text NOT NULL,
  calendar_tz text NOT NULL,
  access_role text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  selected boolean NOT NULL DEFAULT false,
  direction text NOT NULL DEFAULT 'read',
  brand_id uuid,
  state text NOT NULL DEFAULT 'active',
  last_synced_at timestamptz,
  version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendar_source_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT calendar_source_public_key UNIQUE (public_id),
  CONSTRAINT calendar_source_public_format CHECK (public_id ~ '^cal_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT calendar_source_connection_fkey FOREIGN KEY (workspace_id, connection_id)
    REFERENCES integrations.connection (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT calendar_source_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT calendar_source_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT calendar_source_pair UNIQUE (workspace_id, connection_id, external_calendar_id),
  CONSTRAINT calendar_source_external CHECK (char_length(external_calendar_id) BETWEEN 1 AND 200),
  CONSTRAINT calendar_source_label CHECK (char_length(btrim(label)) BETWEEN 1 AND 200
    AND tenancy.valid_plain_text(label, 200)),
  CONSTRAINT calendar_source_tz CHECK (calendar_tz ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$'),
  CONSTRAINT calendar_source_role CHECK (access_role IN ('owner', 'writer', 'reader', 'free_busy')),
  CONSTRAINT calendar_source_direction CHECK (direction IN ('read', 'two_way')),
  CONSTRAINT calendar_source_writable CHECK (direction = 'read' OR access_role IN ('owner', 'writer')),
  CONSTRAINT calendar_source_state CHECK (state IN ('active', 'removed')),
  CONSTRAINT calendar_source_removed_unselected CHECK (state = 'active' OR NOT selected),
  CONSTRAINT calendar_source_version CHECK (version >= 0)
);
CREATE INDEX calendar_source_by_connection ON integrations.calendar_source (workspace_id, connection_id);
CREATE INDEX calendar_source_by_owner ON integrations.calendar_source (workspace_id, owner_membership_id);
CREATE INDEX calendar_source_by_brand ON integrations.calendar_source (workspace_id, brand_id);

-- ---------------------------------------------------------------------------------------------
-- Provider recurring series (CAL-005). The rule is evaluated in its anchor zone with the shared
-- recurrence engine; `rrule` holds the engine subset when `supported`, otherwise occurrences come
-- from the provider's own instance expansion. Exceptions name an original occurrence key.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE integrations.calendar_series (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  connection_id uuid NOT NULL,
  source_id uuid NOT NULL,
  owner_membership_id uuid NOT NULL,
  external_series_id text NOT NULL,
  title text NOT NULL,
  rrule text,
  supported boolean NOT NULL,
  until_at timestamptz,
  anchor_tz text NOT NULL,
  dtstart_local timestamp NOT NULL,
  all_day boolean NOT NULL DEFAULT false,
  duration_minutes integer NOT NULL,
  busy boolean NOT NULL DEFAULT true,
  remote_version text NOT NULL,
  expanded_from timestamptz,
  expanded_through timestamptz,
  version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendar_series_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT calendar_series_connection_fkey FOREIGN KEY (workspace_id, connection_id)
    REFERENCES integrations.connection (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT calendar_series_source_fkey FOREIGN KEY (workspace_id, source_id)
    REFERENCES integrations.calendar_source (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT calendar_series_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT calendar_series_pair UNIQUE (workspace_id, source_id, external_series_id),
  CONSTRAINT calendar_series_external CHECK (char_length(external_series_id) BETWEEN 1 AND 200),
  CONSTRAINT calendar_series_title CHECK (char_length(btrim(title)) BETWEEN 1 AND 500
    AND tenancy.valid_plain_text(title, 500)),
  CONSTRAINT calendar_series_rule CHECK ((rrule IS NOT NULL) = supported
    AND (rrule IS NULL OR char_length(rrule) BETWEEN 7 AND 300)),
  CONSTRAINT calendar_series_tz CHECK (anchor_tz ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$'),
  CONSTRAINT calendar_series_duration CHECK (duration_minutes BETWEEN 0 AND 525600),
  CONSTRAINT calendar_series_remote CHECK (char_length(remote_version) BETWEEN 1 AND 80),
  CONSTRAINT calendar_series_window CHECK (expanded_from IS NULL OR expanded_through IS NULL
    OR expanded_through >= expanded_from),
  CONSTRAINT calendar_series_version CHECK (version >= 0)
);
CREATE INDEX calendar_series_by_connection ON integrations.calendar_series (workspace_id, connection_id);
CREATE INDEX calendar_series_by_owner ON integrations.calendar_series (workspace_id, owner_membership_id);

CREATE TABLE integrations.calendar_exception (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  series_id uuid NOT NULL,
  occurrence_key text NOT NULL,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendar_exception_pkey PRIMARY KEY (workspace_id, series_id, occurrence_key),
  CONSTRAINT calendar_exception_series_fkey FOREIGN KEY (workspace_id, series_id)
    REFERENCES integrations.calendar_series (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT calendar_exception_key CHECK (occurrence_key ~ '^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$'),
  CONSTRAINT calendar_exception_kind CHECK (kind IN ('cancelled', 'moved'))
);

-- ---------------------------------------------------------------------------------------------
-- Mirrored events gain their calendar, series occurrence, status, and the agreed state of a
-- linked work block (CAL-012). `link_block_version` and `link_remote_version` are the last
-- versions both sides agreed on: a change on one side moves the other; a change on both is a
-- conflict. `push_pending` marks a local block move not yet written to the provider (meaningful
-- only while linked).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE integrations.calendar_event
  ADD COLUMN source_id uuid,
  ADD COLUMN series_id uuid,
  ADD COLUMN occurrence_key text,
  ADD COLUMN detached boolean NOT NULL DEFAULT false,
  ADD COLUMN status text NOT NULL DEFAULT 'confirmed',
  ADD COLUMN link_block_version bigint,
  ADD COLUMN link_remote_version text,
  ADD COLUMN push_pending boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT calendar_event_source_fkey FOREIGN KEY (workspace_id, source_id)
    REFERENCES integrations.calendar_source (workspace_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT calendar_event_series_fkey FOREIGN KEY (workspace_id, series_id)
    REFERENCES integrations.calendar_series (workspace_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT calendar_event_occurrence_shape CHECK ((series_id IS NULL) = (occurrence_key IS NULL)
    AND (occurrence_key IS NULL OR occurrence_key ~ '^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$')),
  ADD CONSTRAINT calendar_event_status CHECK (status IN ('confirmed', 'tentative')),
  -- One direction only: the 0047 block reference is ON DELETE SET NULL, so a deleted block leaves
  -- stale agreement columns that the service treats as unlinked and clears on the next write.
  ADD CONSTRAINT calendar_event_link_shape CHECK (linked_work_block_id IS NULL
    OR (link_block_version IS NOT NULL AND link_remote_version IS NOT NULL)),
  ADD CONSTRAINT calendar_event_link_remote CHECK (link_remote_version IS NULL
    OR char_length(link_remote_version) BETWEEN 1 AND 80);
CREATE UNIQUE INDEX calendar_event_occurrence ON integrations.calendar_event (workspace_id, series_id, occurrence_key)
  WHERE series_id IS NOT NULL;
CREATE UNIQUE INDEX calendar_event_one_link ON integrations.calendar_event (workspace_id, linked_work_block_id)
  WHERE linked_work_block_id IS NOT NULL;
CREATE INDEX calendar_event_by_source ON integrations.calendar_event (workspace_id, source_id);
CREATE INDEX calendar_event_by_series ON integrations.calendar_event (workspace_id, series_id);
CREATE INDEX calendar_event_push_pending ON integrations.calendar_event (workspace_id, connection_id)
  WHERE push_pending;

-- ---------------------------------------------------------------------------------------------
-- Canonical tenant policies (fail closed on an unset context, explicit WITH CHECK).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE integrations.calendar_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations.calendar_source FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integrations.calendar_source
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE integrations.calendar_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations.calendar_series FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integrations.calendar_series
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE integrations.calendar_exception ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations.calendar_exception FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integrations.calendar_exception
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

DROP POLICY tenant_isolation ON integrations.connection_mapping;
CREATE POLICY tenant_isolation ON integrations.connection_mapping
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
DROP POLICY tenant_isolation ON integrations.calendar_event;
CREATE POLICY tenant_isolation ON integrations.calendar_event
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
DROP POLICY tenant_isolation ON transfer.import_job;
CREATE POLICY tenant_isolation ON transfer.import_job
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
DROP POLICY tenant_isolation ON transfer.import_row;
CREATE POLICY tenant_isolation ON transfer.import_row
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
DROP POLICY tenant_isolation ON transfer.import_mapping;
CREATE POLICY tenant_isolation ON transfer.import_mapping
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
DROP POLICY tenant_isolation ON transfer.import_preview;
CREATE POLICY tenant_isolation ON transfer.import_preview
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

-- ---------------------------------------------------------------------------------------------
-- MCP provenance on records (corrects 0049, which widened audit and capture facts but not
-- core.record): a record created through MCP keeps `mcp` as its source kind instead of failing.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE core.record DROP CONSTRAINT record_source_kind_known;
ALTER TABLE core.record ADD CONSTRAINT record_source_kind_known CHECK (source_kind IN
  ('ui', 'api', 'paste', 'voice', 'email', 'form', 'webhook', 'mcp', 'import', 'integration', 'ai_proposal',
   'automation', 'agent', 'template', 'system'));

REVOKE ALL ON integrations.calendar_source, integrations.calendar_series, integrations.calendar_exception FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON integrations.calendar_source, integrations.calendar_series,
  integrations.calendar_exception TO app_rw, app_worker;
