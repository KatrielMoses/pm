-- migrate:phase contract
-- Restores the exact 0049 catalog: transfer is introduced only by migration 0050.
DROP TABLE transfer.import_row;
DROP TABLE transfer.import_mapping;
DROP TABLE transfer.import_job;
DROP SCHEMA transfer;
