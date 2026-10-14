-- migrate:phase contract
-- Restores the exact 0047 catalog: transfer is introduced only by migration 0048.
DROP TABLE transfer.import_row;
DROP TABLE transfer.import_mapping;
DROP TABLE transfer.import_job;
DROP SCHEMA transfer;
