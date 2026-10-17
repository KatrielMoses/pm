-- migrate:phase expand
-- Phase 6 integration review, corrective review 01 (ADR-0037 W1–W6; 0B ADR-43, 0C AZ-43, 0D PL-45):
-- the outbound webhook delivery boundary. A subscription can be deliberately paused (distinct from
-- automatic endpoint disablement and suspended authority) and resumes only after a test delivered
-- after the stop. A delivery keeps its event's original time and the canonical record that governs
-- it, so the payload is authorized and built at send; a replay starts a new cycle without erasing
-- the lifetime attempt count; and a delivery withheld at send is recorded as `skipped`.

ALTER TABLE integrations.webhook_subscription
  DROP CONSTRAINT webhook_subscription_state_known,
  ADD CONSTRAINT webhook_subscription_state_known CHECK (state IN
    ('active', 'paused', 'disabled_endpoint', 'suspended')),
  ADD COLUMN paused_at timestamptz,
  ADD COLUMN paused_by_membership_id uuid,
  ADD COLUMN stopped_at timestamptz,
  ADD CONSTRAINT webhook_subscription_pauser_fkey FOREIGN KEY (workspace_id, paused_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT;
-- A subscription disabled before this migration stopped when it was last updated.
UPDATE integrations.webhook_subscription SET stopped_at = updated_at WHERE state = 'disabled_endpoint';
ALTER TABLE integrations.webhook_subscription
  ADD CONSTRAINT webhook_subscription_paused_shape CHECK (
    (state = 'paused') = (paused_at IS NOT NULL)
    AND (paused_at IS NULL) = (paused_by_membership_id IS NULL)
    AND (state IN ('paused', 'disabled_endpoint')) = (stopped_at IS NOT NULL));
CREATE INDEX webhook_subscription_by_pauser ON integrations.webhook_subscription (workspace_id, paused_by_membership_id);

ALTER TABLE integrations.webhook_delivery
  DROP CONSTRAINT webhook_delivery_state_known,
  ADD CONSTRAINT webhook_delivery_state_known CHECK (state IN
    ('pending', 'delivered', 'retry_scheduled', 'failed', 'unknown', 'disabled_endpoint', 'skipped')),
  -- Fail-closed defaults: an unresolved delivery is `unsupported` (skipped at send), and its event
  -- time is when it was queued. Every new delivery sets both explicitly.
  ADD COLUMN event_created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN object_kind text NOT NULL DEFAULT 'unsupported',
  ADD COLUMN object_id uuid,
  ADD COLUMN source_record_id uuid,
  ADD COLUMN cycle integer NOT NULL DEFAULT 1,
  ADD COLUMN total_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN replayed_at timestamptz,
  ADD COLUMN replayed_by_membership_id uuid,
  ADD CONSTRAINT webhook_delivery_replayer_fkey FOREIGN KEY (workspace_id, replayed_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT;
-- Deliveries queued before this migration: their time is when they were queued, and their
-- aggregate is the record they describe (authorized and resolved again at send, failing closed).
UPDATE integrations.webhook_delivery
   SET event_created_at = created_at,
       total_attempts = attempt,
       object_kind = CASE WHEN event_type = 'webhook.test' THEN 'synthetic'
                          WHEN aggregate_id IS NULL THEN 'unsupported' ELSE 'record' END,
       object_id = CASE WHEN event_type = 'webhook.test' THEN NULL ELSE aggregate_id END,
       source_record_id = CASE WHEN event_type = 'webhook.test' THEN NULL ELSE aggregate_id END;
ALTER TABLE integrations.webhook_delivery
  ADD CONSTRAINT webhook_delivery_object_kind CHECK (object_kind IN
    ('record', 'comment', 'review_request', 'synthetic', 'unsupported')),
  ADD CONSTRAINT webhook_delivery_object_shape CHECK (
    (object_kind IN ('synthetic', 'unsupported')) = (object_id IS NULL)
    AND (object_kind IN ('synthetic', 'unsupported')) = (source_record_id IS NULL)),
  ADD CONSTRAINT webhook_delivery_cycle CHECK (cycle BETWEEN 1 AND 100),
  ADD CONSTRAINT webhook_delivery_total_attempts CHECK (total_attempts >= attempt
    AND total_attempts <= 10000),
  ADD CONSTRAINT webhook_delivery_replay_shape CHECK (
    (replayed_at IS NULL) = (replayed_by_membership_id IS NULL)
    AND (replayed_at IS NULL) = (cycle = 1));
CREATE INDEX webhook_delivery_by_replayer ON integrations.webhook_delivery (workspace_id, replayed_by_membership_id);
