-- migrate:phase expand
-- Transactional outbox and consumer inbox (0B §9.7, ADR-08; 0D §8). Delivery is at least once;
-- consumers deduplicate by writing an inbox receipt in the same transaction as their effects.

CREATE TABLE exec.outbox_event (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  brand_id uuid,
  event_type text NOT NULL,
  schema_version integer NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_sequence bigint NOT NULL,
  payload jsonb NOT NULL,
  max_class exec.data_class NOT NULL,
  operation_id uuid,
  attempt_id uuid,
  actor_type exec.actor_type NOT NULL,
  actor_id uuid,
  on_behalf_of_membership_id uuid,
  workspace_epoch bigint NOT NULL,
  delegation_depth integer,
  public_event_id text,
  correlation_id uuid NOT NULL,
  causation_id uuid,
  traceparent text,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  dispatch_lease_until timestamptz,
  dispatch_attempts integer NOT NULL DEFAULT 0,
  CONSTRAINT outbox_event_id_uuidv7 CHECK (exec.is_uuidv7(id)),
  CONSTRAINT outbox_event_type_format CHECK (event_type ~ '^[a-z]+\.[a-z_]+\.[a-z_]+$'),
  CONSTRAINT outbox_event_schema_version_positive CHECK (schema_version >= 1),
  CONSTRAINT outbox_event_sequence_nonnegative CHECK (aggregate_sequence >= 0),
  -- 0D §8.2: data carries classified values <= C2 only.
  CONSTRAINT outbox_event_max_class_capped CHECK (max_class IN ('C0', 'C1', 'C2')),
  CONSTRAINT outbox_event_payload_shape CHECK (
    jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 8192),
  CONSTRAINT outbox_event_public_id_format CHECK (
    public_event_id IS NULL OR public_event_id ~ '^evt_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT outbox_event_traceparent_format CHECK (
    traceparent IS NULL OR traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'),
  CONSTRAINT outbox_event_operation_same_workspace FOREIGN KEY (workspace_id, operation_id)
    REFERENCES exec.operation (workspace_id, id)
);
COMMENT ON TABLE exec.outbox_event IS 'Domain facts written with the state change; deleted after OUTBOX_REPLAY_WINDOW.';
CREATE INDEX outbox_event_undispatched ON exec.outbox_event (id) WHERE dispatched_at IS NULL;
CREATE INDEX outbox_event_dispatched ON exec.outbox_event (workspace_id, dispatched_at) WHERE dispatched_at IS NOT NULL;

CREATE TABLE exec.inbox_receipt (
  consumer_name text NOT NULL,
  event_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbox_receipt_pkey PRIMARY KEY (consumer_name, event_id),
  CONSTRAINT inbox_receipt_consumer_format CHECK (consumer_name ~ '^[a-z][a-z0-9_.]{0,63}$')
);
COMMENT ON TABLE exec.inbox_receipt IS 'Consumer-side dedupe: one row per (consumer, event).';
CREATE INDEX inbox_receipt_expiry ON exec.inbox_receipt (workspace_id, processed_at);

ALTER TABLE exec.outbox_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE exec.outbox_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON exec.outbox_event
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());
CREATE POLICY scheduler_discovery ON exec.outbox_event FOR SELECT TO pm_scheduler USING (true);
CREATE POLICY scheduler_lease ON exec.outbox_event FOR UPDATE TO pm_scheduler USING (true) WITH CHECK (true);

ALTER TABLE exec.inbox_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE exec.inbox_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON exec.inbox_receipt
  USING (workspace_id = exec.current_workspace_id())
  WITH CHECK (workspace_id = exec.current_workspace_id());
CREATE POLICY scheduler_discovery ON exec.inbox_receipt FOR SELECT TO pm_scheduler USING (true);

-- Producers (web/API and workers) insert; only the worker-side dispatcher reads and marks rows.
GRANT INSERT ON exec.outbox_event TO app_rw;
GRANT SELECT, INSERT, DELETE ON exec.outbox_event TO app_worker;
GRANT UPDATE (dispatched_at, dispatch_lease_until) ON exec.outbox_event TO app_worker;
GRANT SELECT (id, workspace_id, recorded_at, dispatched_at, dispatch_lease_until, dispatch_attempts)
  ON exec.outbox_event TO pm_scheduler;
GRANT UPDATE (dispatch_lease_until, dispatch_attempts) ON exec.outbox_event TO pm_scheduler;

GRANT SELECT, INSERT, DELETE ON exec.inbox_receipt TO app_worker;
GRANT SELECT (workspace_id, processed_at) ON exec.inbox_receipt TO pm_scheduler;
