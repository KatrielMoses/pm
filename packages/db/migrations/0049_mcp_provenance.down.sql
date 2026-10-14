-- migrate:phase expand
-- Restores the exact source-kind constraints from migration 0048.
ALTER TABLE capture.inbox_item DROP CONSTRAINT inbox_item_source_known;
ALTER TABLE capture.inbox_item ADD CONSTRAINT inbox_item_source_known CHECK (source_kind IN
  ('typed', 'paste', 'form', 'voice', 'email', 'api', 'webhook'));
ALTER TABLE audit.audit_event DROP CONSTRAINT audit_event_source_kind_known;
ALTER TABLE audit.audit_event ADD CONSTRAINT audit_event_source_kind_known CHECK (source_kind IN
  ('ui', 'api', 'paste', 'voice', 'email', 'form', 'webhook', 'import', 'integration', 'ai_proposal',
   'automation', 'agent', 'template', 'system'));
-- migrate:phase contract
