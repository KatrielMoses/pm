-- migrate:phase expand
-- Phase 7 integration review (ADR-0044 I2): a saved recording may outlive the Inbox item it was
-- saved to. Purging that item (the 1F purge executor, through the 2E Inbox adapter) erases the AI
-- copies made from the capture and unlinks the recording, which stays `saved` as a reference-only
-- fact (its audio is already gone). Before this, `ON DELETE RESTRICT` and the saved-iff-linked check
-- made every purge of a voice-saved item fail. A recording that was never saved still never names
-- an item.

ALTER TABLE capture.voice_capture
  DROP CONSTRAINT voice_capture_saved,
  ADD CONSTRAINT voice_capture_saved CHECK (inbox_item_id IS NULL OR state = 'saved');
