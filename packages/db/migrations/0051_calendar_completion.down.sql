-- migrate:phase contract
-- Restores the exact 0050 catalog: the 0047 and 0050 tenant policies return to their original
-- form, and the calendar list, series, exceptions and link columns are removed. Records created
-- through MCP keep their provenance as `api` (MCP is delivered over the public API), because the
-- 0050 record constraint does not know `mcp`.
UPDATE core.record SET source_kind = 'api' WHERE source_kind = 'mcp';
ALTER TABLE core.record DROP CONSTRAINT record_source_kind_known;
ALTER TABLE core.record ADD CONSTRAINT record_source_kind_known CHECK (source_kind IN
  ('ui', 'api', 'paste', 'voice', 'email', 'form', 'webhook', 'import', 'integration', 'ai_proposal',
   'automation', 'agent', 'template', 'system'));
DROP POLICY tenant_isolation ON transfer.import_preview;
CREATE POLICY tenant_isolation ON transfer.import_preview
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
DROP POLICY tenant_isolation ON transfer.import_mapping;
CREATE POLICY tenant_isolation ON transfer.import_mapping
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
DROP POLICY tenant_isolation ON transfer.import_row;
CREATE POLICY tenant_isolation ON transfer.import_row
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
DROP POLICY tenant_isolation ON transfer.import_job;
CREATE POLICY tenant_isolation ON transfer.import_job
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
DROP POLICY tenant_isolation ON integrations.calendar_event;
CREATE POLICY tenant_isolation ON integrations.calendar_event
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
DROP POLICY tenant_isolation ON integrations.connection_mapping;
CREATE POLICY tenant_isolation ON integrations.connection_mapping
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

DROP INDEX integrations.calendar_event_push_pending;
DROP INDEX integrations.calendar_event_by_series;
DROP INDEX integrations.calendar_event_by_source;
DROP INDEX integrations.calendar_event_one_link;
DROP INDEX integrations.calendar_event_occurrence;
ALTER TABLE integrations.calendar_event
  DROP CONSTRAINT calendar_event_link_remote,
  DROP CONSTRAINT calendar_event_link_shape,
  DROP CONSTRAINT calendar_event_status,
  DROP CONSTRAINT calendar_event_occurrence_shape,
  DROP CONSTRAINT calendar_event_series_fkey,
  DROP CONSTRAINT calendar_event_source_fkey,
  DROP COLUMN push_pending,
  DROP COLUMN link_remote_version,
  DROP COLUMN link_block_version,
  DROP COLUMN status,
  DROP COLUMN detached,
  DROP COLUMN occurrence_key,
  DROP COLUMN series_id,
  DROP COLUMN source_id;

DROP TABLE integrations.calendar_exception;
DROP TABLE integrations.calendar_series;
DROP TABLE integrations.calendar_source;
