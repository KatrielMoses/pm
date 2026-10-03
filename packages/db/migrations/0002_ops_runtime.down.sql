DROP TABLE ops.worker_heartbeat;
DROP TABLE ops.environment_binding;
REVOKE SELECT (version, checksum) ON ops.schema_migration FROM app_rw, app_worker, dispatcher;
REVOKE USAGE ON SCHEMA ops FROM app_rw, app_worker, dispatcher;
