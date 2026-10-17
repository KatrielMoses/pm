-- migrate:phase contract
-- Restores the exact 0051 catalog. Paused subscriptions return as `disabled_endpoint` (they stay
-- stopped and need an explicit re-enable), and skipped deliveries return as `failed`; the replay
-- cycle, lifetime attempts, and resolved sources are dropped.
UPDATE integrations.webhook_subscription
   SET state = 'disabled_endpoint', paused_at = NULL, paused_by_membership_id = NULL
 WHERE state = 'paused';
UPDATE integrations.webhook_delivery SET state = 'failed' WHERE state = 'skipped';
DROP INDEX integrations.webhook_delivery_by_replayer;
ALTER TABLE integrations.webhook_delivery
  DROP CONSTRAINT webhook_delivery_replay_shape,
  DROP CONSTRAINT webhook_delivery_total_attempts,
  DROP CONSTRAINT webhook_delivery_cycle,
  DROP CONSTRAINT webhook_delivery_object_shape,
  DROP CONSTRAINT webhook_delivery_object_kind,
  DROP CONSTRAINT webhook_delivery_replayer_fkey,
  DROP CONSTRAINT webhook_delivery_state_known,
  DROP COLUMN replayed_by_membership_id,
  DROP COLUMN replayed_at,
  DROP COLUMN total_attempts,
  DROP COLUMN cycle,
  DROP COLUMN source_record_id,
  DROP COLUMN object_id,
  DROP COLUMN object_kind,
  DROP COLUMN event_created_at,
  ADD CONSTRAINT webhook_delivery_state_known CHECK (state IN
    ('pending', 'delivered', 'retry_scheduled', 'failed', 'unknown', 'disabled_endpoint'));
DROP INDEX integrations.webhook_subscription_by_pauser;
ALTER TABLE integrations.webhook_subscription
  DROP CONSTRAINT webhook_subscription_paused_shape,
  DROP CONSTRAINT webhook_subscription_pauser_fkey,
  DROP CONSTRAINT webhook_subscription_state_known,
  DROP COLUMN stopped_at,
  DROP COLUMN paused_by_membership_id,
  DROP COLUMN paused_at,
  ADD CONSTRAINT webhook_subscription_state_known CHECK (state IN ('active', 'disabled_endpoint', 'suspended'));
