-- Reverts 0040 (local/test only). Restores the exact 0039 catalog.
DROP TABLE knowledge.edit_op;
DROP TABLE knowledge.edit_session;
DROP TABLE knowledge.edit_draft;
ALTER TABLE files.upload_session DROP CONSTRAINT upload_session_host_kind_known;
ALTER TABLE files.upload_session ADD CONSTRAINT upload_session_host_kind_known
  CHECK (host_kind IN ('workspace', 'brand', 'project', 'task', 'comment'));
ALTER TABLE files.file DROP CONSTRAINT file_host_shape;
ALTER TABLE files.file ADD CONSTRAINT file_host_shape CHECK (
  (host_kind = 'workspace' AND host_record_id IS NULL AND brand_id IS NULL AND comment_id IS NULL)
  OR (host_kind = 'comment' AND host_record_id IS NOT NULL AND comment_id IS NOT NULL AND brand_id IS NOT NULL)
  OR (host_kind IN ('brand', 'project', 'task') AND host_record_id IS NOT NULL AND comment_id IS NULL
      AND brand_id IS NOT NULL));
ALTER TABLE files.file DROP CONSTRAINT file_host_kind_known;
ALTER TABLE files.file ADD CONSTRAINT file_host_kind_known
  CHECK (host_kind IN ('workspace', 'brand', 'project', 'task', 'comment'));
