-- Reverts 0028 (local/test only). Restores the exact 0027 catalog.
DROP INDEX work.task_rank_by_brand;
DROP TABLE work.undo_entry;
DROP TABLE work.bulk_operation;
DROP FUNCTION work.bulk_undo_guard();
