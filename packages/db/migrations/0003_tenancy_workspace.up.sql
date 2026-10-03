-- migrate:phase expand
-- Minimal tenant root (0B tenancy.workspace) sufficient for RLS and execution foundations.
-- Phase 1C extends this table additively (brands, settings, ownership); nothing here is final copy.

CREATE TYPE tenancy.workspace_state AS ENUM ('active', 'read_only', 'deletion_pending', 'purging');

CREATE TABLE tenancy.workspace (
  id uuid PRIMARY KEY,
  public_id text NOT NULL,
  name text NOT NULL,
  timezone text NOT NULL,
  locale text NOT NULL,
  currency char(3) NOT NULL,
  week_start smallint NOT NULL,
  state tenancy.workspace_state NOT NULL DEFAULT 'active',
  deletion_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_actor_type exec.actor_type NOT NULL,
  created_by_actor_id uuid,
  updated_by_actor_type exec.actor_type NOT NULL,
  updated_by_actor_id uuid,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT workspace_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT workspace_public_id_key UNIQUE (public_id),
  CONSTRAINT workspace_public_id_format CHECK (public_id ~ '^ws_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT workspace_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT workspace_timezone_format CHECK (timezone ~ '^[A-Za-z]+(/[A-Za-z0-9_+\-]+)*$'),
  CONSTRAINT workspace_locale_format CHECK (locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  CONSTRAINT workspace_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT workspace_week_start_range CHECK (week_start BETWEEN 1 AND 7),
  CONSTRAINT workspace_deletion_consistency CHECK ((state IN ('deletion_pending', 'purging')) = (deletion_requested_at IS NOT NULL)),
  CONSTRAINT workspace_version_nonnegative CHECK (version >= 0)
);
COMMENT ON TABLE tenancy.workspace IS 'Tenant root. RLS: a transaction sees only the workspace in app.workspace_id.';

ALTER TABLE tenancy.workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.workspace FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenancy.workspace
  USING (id = exec.current_workspace_id())
  WITH CHECK (id = exec.current_workspace_id());

GRANT SELECT, INSERT, UPDATE ON tenancy.workspace TO app_rw;
GRANT SELECT ON tenancy.workspace TO app_worker;
