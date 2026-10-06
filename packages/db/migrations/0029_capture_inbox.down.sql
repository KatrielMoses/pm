-- Reverts 0029 (local/test only). Restores the exact 0028 catalog.
REVOKE UPDATE (intake_source_id) ON work.project FROM app_worker;
DROP TABLE capture.capture_conversion;
DROP TABLE capture.note;
DROP TABLE capture.inbox_item;
DROP FUNCTION capture.inbox_item_guard();
DROP SCHEMA capture;
