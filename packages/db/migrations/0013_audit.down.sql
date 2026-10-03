-- Reverts 0013 (local/test only; the migrator refuses down migrations elsewhere).
REVOKE SELECT ON identity.security_event_buffer FROM app_worker;
REVOKE USAGE ON SCHEMA exec, tenancy FROM audit_maintainer;
DROP TABLE audit.activity_item;
DROP TABLE audit.chain_checkpoint;
DROP TABLE audit.security_event;
DROP TABLE audit.audit_redaction;
DROP TABLE audit.audit_event;
DROP FUNCTION audit.valid_display_values(jsonb);
DROP FUNCTION audit.reject_mutation();
DROP FUNCTION audit.audit_event_mutation_guard();
DROP FUNCTION audit.audit_event_chain_guard();
DROP FUNCTION audit.valid_delegation_chain(jsonb);
DROP FUNCTION audit.valid_changes(jsonb);
DROP FUNCTION audit.valid_change_value(jsonb);
DROP SCHEMA audit;
