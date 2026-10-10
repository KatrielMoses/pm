-- migrate:phase expand
-- Phase 6C (0B ADR-42, 0C AZ-42, 0D PL-43): personal calendar_event mirror and brand
-- connection_mapping for external calendars. Builds on 0046_public_api_webhooks.

CREATE TABLE integrations.connection_mapping (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  connection_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  project_id uuid,
  external_resource_id text NOT NULL,
  resource_kind text NOT NULL DEFAULT 'calendar',
  version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connection_mapping_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT connection_mapping_connection_fkey FOREIGN KEY (workspace_id, connection_id)
    REFERENCES integrations.connection (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT connection_mapping_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT connection_mapping_project_fkey FOREIGN KEY (workspace_id, project_id)
    REFERENCES work.project (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT connection_mapping_pair UNIQUE (workspace_id, connection_id, external_resource_id),
  CONSTRAINT connection_mapping_kind CHECK (resource_kind IN ('calendar')),
  CONSTRAINT connection_mapping_external CHECK (char_length(external_resource_id) BETWEEN 1 AND 200),
  CONSTRAINT connection_mapping_version CHECK (version >= 0)
);
CREATE INDEX connection_mapping_by_connection ON integrations.connection_mapping (workspace_id, connection_id);
CREATE INDEX connection_mapping_by_brand ON integrations.connection_mapping (workspace_id, brand_id);

CREATE TABLE integrations.calendar_event (
  id uuid PRIMARY KEY,
  public_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  connection_id uuid NOT NULL,
  owner_membership_id uuid NOT NULL,
  calendar_id text NOT NULL,
  external_event_id text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  event_tz text NOT NULL,
  all_day boolean NOT NULL DEFAULT false,
  title text NOT NULL,
  busy boolean NOT NULL DEFAULT true,
  linked_work_block_id uuid,
  remote_version text NOT NULL,
  version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendar_event_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT calendar_event_public_key UNIQUE (public_id),
  CONSTRAINT calendar_event_public_format CHECK (public_id ~ '^cev_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT calendar_event_connection_fkey FOREIGN KEY (workspace_id, connection_id)
    REFERENCES integrations.connection (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT calendar_event_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT calendar_event_block_fkey FOREIGN KEY (workspace_id, linked_work_block_id)
    REFERENCES planning.work_block (workspace_id, id) ON DELETE SET NULL,
  CONSTRAINT calendar_event_triple UNIQUE (workspace_id, connection_id, calendar_id, external_event_id),
  CONSTRAINT calendar_event_calendar CHECK (char_length(calendar_id) BETWEEN 1 AND 200),
  CONSTRAINT calendar_event_external CHECK (char_length(external_event_id) BETWEEN 1 AND 200),
  CONSTRAINT calendar_event_tz CHECK (char_length(event_tz) BETWEEN 1 AND 64),
  CONSTRAINT calendar_event_title CHECK (char_length(btrim(title)) BETWEEN 1 AND 500
    AND tenancy.valid_plain_text(title, 500)),
  CONSTRAINT calendar_event_order CHECK (ends_at > starts_at OR all_day = true),
  CONSTRAINT calendar_event_remote CHECK (char_length(remote_version) BETWEEN 1 AND 80),
  CONSTRAINT calendar_event_version CHECK (version >= 0)
);
CREATE INDEX calendar_event_by_owner_time ON integrations.calendar_event (workspace_id, owner_membership_id, starts_at);
CREATE INDEX calendar_event_by_connection ON integrations.calendar_event (workspace_id, connection_id);

ALTER TABLE integrations.connection_mapping ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations.connection_mapping FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integrations.connection_mapping
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

ALTER TABLE integrations.calendar_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations.calendar_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integrations.calendar_event
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

REVOKE ALL ON integrations.connection_mapping, integrations.calendar_event FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON integrations.connection_mapping, integrations.calendar_event TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON integrations.connection_mapping, integrations.calendar_event TO app_worker;
