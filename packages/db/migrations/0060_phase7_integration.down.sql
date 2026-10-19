-- migrate:phase contract
-- Restores the exact 0059 catalog. A saved recording whose Inbox item was purged cannot be
-- represented in 0059 (saved requires the link), so it returns as `expired`: its audio and its
-- item are gone and nothing can be saved from it again. Forced row-level security is lifted for
-- that one relabel and restored.
ALTER TABLE capture.voice_capture NO FORCE ROW LEVEL SECURITY;
UPDATE capture.voice_capture
   SET state = 'expired', updated_at = now(), version = version + 1
 WHERE state = 'saved' AND inbox_item_id IS NULL;
ALTER TABLE capture.voice_capture FORCE ROW LEVEL SECURITY;
ALTER TABLE capture.voice_capture
  DROP CONSTRAINT voice_capture_saved,
  ADD CONSTRAINT voice_capture_saved CHECK ((state = 'saved') = (inbox_item_id IS NOT NULL));
