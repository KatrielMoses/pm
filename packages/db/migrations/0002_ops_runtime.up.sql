-- migrate:phase expand
-- Operational (platform, non-tenant) tables. The migration history table ops.schema_migration is
-- created by the migrator itself before the first migration runs.

GRANT USAGE ON SCHEMA ops TO app_rw, app_worker, dispatcher;
-- Readiness compares the applied version with the version bundled in the artifact.
GRANT SELECT (version, checksum) ON ops.schema_migration TO app_rw, app_worker, dispatcher;

-- Binds a database to exactly one deployment environment. Written by the migrator on first run;
-- application processes refuse to start when it differs from their APP_ENV.
CREATE TABLE ops.environment_binding (
  singleton boolean PRIMARY KEY DEFAULT true,
  environment text NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT environment_binding_singleton CHECK (singleton),
  CONSTRAINT environment_binding_known CHECK (environment IN ('local', 'test', 'preview', 'staging', 'production'))
);
GRANT SELECT ON ops.environment_binding TO app_rw, app_worker, dispatcher;

-- Worker liveness for readiness ("outbox dispatcher alive", 0D §17.4). No tenant data.
CREATE TABLE ops.worker_heartbeat (
  worker_id text PRIMARY KEY,
  role text NOT NULL,
  build_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  stopping boolean NOT NULL DEFAULT false,
  CONSTRAINT worker_heartbeat_id_format CHECK (worker_id ~ '^wrk_[0-9a-f]{16}$'),
  CONSTRAINT worker_heartbeat_role_known CHECK (role IN ('worker')),
  CONSTRAINT worker_heartbeat_build_format CHECK (build_id ~ '^[0-9A-Za-z.-]{1,40}$')
);
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.worker_heartbeat TO dispatcher;
GRANT SELECT (role, last_seen_at, stopping) ON ops.worker_heartbeat TO app_rw;
