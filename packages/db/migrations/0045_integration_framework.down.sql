-- Restores the exact 0044 catalog.
DROP FUNCTION exec_dispatch.discover_integration_work(timestamptz, timestamptz, integer);
DROP TABLE integrations.sync_conflict;
DROP TABLE integrations.sync_delivery;
DROP TABLE integrations.sync_run;
DROP TABLE integrations.external_identity;
DROP TABLE integrations.sync_checkpoint;
DROP TABLE integrations.connection;
DROP FUNCTION search.connection_changed();
DROP SCHEMA integrations;
ALTER TABLE ops.dev_secret_vault DROP CONSTRAINT dev_secret_vault_key_id;
ALTER TABLE ops.dev_secret_vault DROP COLUMN key_id;
