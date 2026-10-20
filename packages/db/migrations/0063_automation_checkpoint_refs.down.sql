-- migrate:phase contract
-- Restores the exact 0062 catalog: 0063 changes data only (no table, column, function, policy,
-- or grant). The payload copies it removed from automation checkpoints are not put back: they were
-- content that must not be kept. Only the corrected worker (which rebuilds a webhook payload under
-- fresh authorization before sending) may run against cleaned checkpoints; the pre-correction
-- worker must not be redeployed over them.
SELECT 1;
