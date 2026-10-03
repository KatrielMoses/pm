DROP DOMAIN exec.principal_type;
DROP TYPE exec.data_class, exec.risk_class, exec.idempotency_state, exec.effect_destination_class,
  exec.effect_state, exec.job_error_class, exec.job_state, exec.waiting_reason, exec.terminal_reason,
  exec.exec_state, exec.actor_type;
DROP FUNCTION exec.is_uuidv7(uuid);
DROP FUNCTION exec.current_workspace_id();
DROP SCHEMA exec_dispatch;
DROP SCHEMA access;
DROP SCHEMA tenancy;
DROP SCHEMA exec;
