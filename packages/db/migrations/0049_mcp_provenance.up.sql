-- migrate:phase expand
-- Phase 6E: preserve MCP as an explicit actor provenance label in the existing audit and capture facts.
ALTER TABLE audit.audit_event DROP CONSTRAINT audit_event_source_kind_known;
ALTER TABLE audit.audit_event ADD CONSTRAINT audit_event_source_kind_known CHECK (source_kind IN
  ('ui', 'api', 'paste', 'voice', 'email', 'form', 'webhook', 'mcp', 'import', 'integration', 'ai_proposal',
   'automation', 'agent', 'template', 'system'));
ALTER TABLE capture.inbox_item DROP CONSTRAINT inbox_item_source_known;
ALTER TABLE capture.inbox_item ADD CONSTRAINT inbox_item_source_known CHECK (source_kind IN
  ('typed', 'paste', 'form', 'voice', 'email', 'api', 'webhook', 'mcp'));
-- migrate:phase contract
