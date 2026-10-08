-- Reverts 0038 (local/test only). Restores the exact 0037 catalog.
ALTER TABLE collab.review_request DROP CONSTRAINT review_request_subject_known;
ALTER TABLE collab.review_request ADD CONSTRAINT review_request_subject_known
  CHECK (subject_kind IN ('task', 'project'));
DROP TABLE knowledge.source_approval;
DROP TABLE knowledge.document_suggestion;
DROP TABLE knowledge.document_reference;
ALTER TABLE knowledge.document DROP CONSTRAINT document_current_version_fkey;
DROP TABLE knowledge.document_version;
DROP FUNCTION knowledge.document_version_immutable();
DROP TABLE knowledge.document;
DROP FUNCTION knowledge.assert_document_placement();
DROP FUNCTION knowledge.valid_content(jsonb);
DROP SCHEMA knowledge;
