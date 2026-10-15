-- migrate:phase contract
REVOKE SELECT (claimed_until) ON integrations.webhook_delivery FROM pm_scheduler;
-- Restores the exact 0049 catalog: transfer is introduced only by migration 0050.
DROP TABLE transfer.import_row;
DROP TABLE transfer.import_job;
DROP TABLE transfer.import_preview;
DROP TABLE transfer.import_mapping;
DROP SCHEMA transfer;
