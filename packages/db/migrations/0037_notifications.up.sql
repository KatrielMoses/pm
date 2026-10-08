-- migrate:phase expand
-- Phase 4B (0B ADR-32, 0C AZ-32, 0D PL-34; ADR-0024; UXD-10, UXD-18): durable in-app notifications,
-- preferences and mute scopes, quiet hours and digest scheduling, per-channel deliveries with
-- retry and dead-letter states, and digests. Rows hold identifiers and a few scalar facts, never a
-- title, body, snippet, or address: what a notification says is rendered from what the recipient may
-- read at the moment it is shown or sent. No documents, files, editing, agent delivery, or external
-- connector structures (4C, 4E, 4D, 8B, 6x).

CREATE SCHEMA notify;
REVOKE ALL ON SCHEMA notify FROM PUBLIC;
GRANT USAGE ON SCHEMA notify TO app_rw, app_worker;

-- ---------------------------------------------------------------------------------------------
-- Notifications (NTF-001, NTF-011, NTF-012, COL-016, COL-019, COL-020)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE notify.notification (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  recipient_membership_id uuid NOT NULL,
  type text NOT NULL,
  record_id uuid,
  actor_membership_id uuid,
  source_event_id uuid,
  dedupe_key text NOT NULL,
  group_key text,
  facts jsonb NOT NULL DEFAULT '{}',
  occurrences integer NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'unread',
  digest_pending boolean NOT NULL DEFAULT false,
  digest_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_occurred_at timestamptz NOT NULL DEFAULT now(),
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT notification_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT notification_dedupe_unique UNIQUE (workspace_id, recipient_membership_id, dedupe_key),
  CONSTRAINT notification_public_id_format CHECK (public_id ~ '^ntf_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT notification_recipient_fkey FOREIGN KEY (workspace_id, recipient_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT notification_actor_fkey FOREIGN KEY (workspace_id, actor_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT notification_record_fkey FOREIGN KEY (workspace_id, record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT notification_type_known CHECK (type IN
    ('assignment', 'mention', 'comment', 'review_requested', 'approval_decided', 'blocker', 'due_soon',
     'overdue', 'integration_failure', 'automation_failure', 'agent_failure', 'agent_output_ready',
     'spend_threshold', 'permission_changed', 'share_changed', 'briefing_ready', 'export_ready',
     'hidden_dependency_affects_assignee')),
  CONSTRAINT notification_state_known CHECK (state IN ('unread', 'read', 'saved', 'dismissed')),
  CONSTRAINT notification_facts_shape CHECK (jsonb_typeof(facts) = 'object' AND octet_length(facts::text) <= 4096),
  CONSTRAINT notification_dedupe_key_format CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  CONSTRAINT notification_group_key_format CHECK (group_key IS NULL OR char_length(group_key) BETWEEN 1 AND 200),
  CONSTRAINT notification_occurrences_positive CHECK (occurrences >= 1 AND version >= 0),
  CONSTRAINT notification_digest_exclusive CHECK (NOT (digest_pending AND digest_id IS NOT NULL))
);
CREATE INDEX notification_by_recipient ON notify.notification
  (workspace_id, recipient_membership_id, state, last_occurred_at DESC, id);
CREATE INDEX notification_by_record ON notify.notification (workspace_id, record_id);
CREATE INDEX notification_by_actor ON notify.notification (workspace_id, actor_membership_id);
CREATE INDEX notification_digest_pending ON notify.notification (workspace_id, recipient_membership_id, created_at)
  WHERE digest_pending;
CREATE INDEX notification_by_age ON notify.notification (workspace_id, last_occurred_at);

-- ---------------------------------------------------------------------------------------------
-- Digests (NTF-004, COL-018): one per person, period kind, and period start
-- ---------------------------------------------------------------------------------------------
CREATE TABLE notify.digest (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  recipient_membership_id uuid NOT NULL,
  period_kind text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  item_count integer NOT NULL,
  state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT digest_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT digest_unique UNIQUE (workspace_id, recipient_membership_id, period_kind, period_start),
  CONSTRAINT digest_recipient_fkey FOREIGN KEY (workspace_id, recipient_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT digest_kind_known CHECK (period_kind IN ('daily', 'weekly')),
  CONSTRAINT digest_state_known CHECK (state IN ('assembled', 'empty')),
  CONSTRAINT digest_period CHECK (period_end > period_start),
  CONSTRAINT digest_count CHECK (item_count >= 0 AND ((state = 'empty') = (item_count = 0)))
);
ALTER TABLE notify.notification ADD CONSTRAINT notification_digest_fkey
  FOREIGN KEY (workspace_id, digest_id) REFERENCES notify.digest (workspace_id, id) ON DELETE RESTRICT;
CREATE INDEX notification_by_digest ON notify.notification (workspace_id, digest_id);

-- ---------------------------------------------------------------------------------------------
-- Deliveries (NTF-002, NTF-003): one row per channel attempt series; delivered only after the
-- provider (email) or the person's own browser (client acknowledgement) confirms
-- ---------------------------------------------------------------------------------------------
CREATE TABLE notify.delivery (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  recipient_membership_id uuid NOT NULL,
  channel text NOT NULL,
  kind text NOT NULL,
  notification_id uuid,
  digest_id uuid,
  state text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  failure_class text,
  failure_code text,
  suppress_reason text,
  provider_message_id text,
  ack_source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT delivery_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT delivery_public_id_format CHECK (public_id ~ '^ndl_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT delivery_recipient_fkey FOREIGN KEY (workspace_id, recipient_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT delivery_notification_fkey FOREIGN KEY (workspace_id, notification_id)
    REFERENCES notify.notification (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT delivery_digest_fkey FOREIGN KEY (workspace_id, digest_id)
    REFERENCES notify.digest (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT delivery_channel_known CHECK (channel IN ('email', 'browser')),
  CONSTRAINT delivery_kind_known CHECK (kind IN ('notification', 'digest')),
  CONSTRAINT delivery_subject_shape CHECK (
    (kind = 'notification' AND notification_id IS NOT NULL AND digest_id IS NULL)
    OR (kind = 'digest' AND digest_id IS NOT NULL AND notification_id IS NULL AND channel = 'email')),
  CONSTRAINT delivery_state_known CHECK (state IN
    ('pending', 'sending', 'delivered', 'failed', 'dead', 'suppressed', 'deferred_quiet_hours', 'expired')),
  CONSTRAINT delivery_failure_class_known CHECK (failure_class IS NULL
    OR failure_class IN ('transient', 'permanent', 'unconfigured', 'rate_limited')),
  CONSTRAINT delivery_failure_code_format CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  CONSTRAINT delivery_suppress_reason_known CHECK (suppress_reason IS NULL OR suppress_reason IN
    ('access_lost', 'muted', 'email_disabled', 'browser_disabled', 'provider_unconfigured',
     'recipient_unavailable', 'no_content', 'superseded')),
  CONSTRAINT delivery_suppressed_shape CHECK ((state = 'suppressed') = (suppress_reason IS NOT NULL)),
  CONSTRAINT delivery_delivered_shape CHECK ((state = 'delivered') = (delivered_at IS NOT NULL)),
  CONSTRAINT delivery_ack_source_known CHECK (ack_source IS NULL OR ack_source IN ('provider', 'client')),
  CONSTRAINT delivery_ack_shape CHECK (state <> 'delivered' OR ack_source IS NOT NULL),
  CONSTRAINT delivery_sending_lease CHECK ((state = 'sending') = (lease_until IS NOT NULL)),
  CONSTRAINT delivery_counts CHECK (attempts >= 0 AND version >= 0)
);
CREATE INDEX delivery_due ON notify.delivery (workspace_id, next_attempt_at)
  WHERE state IN ('pending', 'deferred_quiet_hours', 'sending');
CREATE INDEX delivery_by_recipient ON notify.delivery (workspace_id, recipient_membership_id, created_at DESC, id);
CREATE INDEX delivery_by_notification ON notify.delivery (workspace_id, notification_id);
CREATE INDEX delivery_by_digest ON notify.delivery (workspace_id, digest_id);
CREATE INDEX delivery_needs_attention ON notify.delivery (workspace_id, state, updated_at DESC)
  WHERE state IN ('failed', 'dead');

-- ---------------------------------------------------------------------------------------------
-- Preferences, mute scopes, and the person's profile (COL-017, NTF-008 to NTF-010)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE notify.preference (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL,
  event_type text NOT NULL,
  scope_kind text NOT NULL,
  scope_record_id uuid,
  channel text NOT NULL,
  mode text NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT preference_member_fkey FOREIGN KEY (workspace_id, membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT preference_scope_fkey FOREIGN KEY (workspace_id, scope_record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT preference_type_known CHECK (event_type = '*' OR event_type IN
    ('assignment', 'mention', 'comment', 'review_requested', 'approval_decided', 'blocker', 'due_soon',
     'overdue', 'integration_failure', 'automation_failure', 'agent_failure', 'agent_output_ready',
     'spend_threshold', 'permission_changed', 'share_changed', 'briefing_ready', 'export_ready',
     'hidden_dependency_affects_assignee')),
  CONSTRAINT preference_scope_known CHECK (scope_kind IN ('workspace', 'brand', 'project', 'record')),
  CONSTRAINT preference_scope_shape CHECK ((scope_kind = 'workspace') = (scope_record_id IS NULL)),
  CONSTRAINT preference_channel_known CHECK (channel IN ('all', 'in_app', 'email', 'browser')),
  CONSTRAINT preference_mode_known CHECK (mode IN ('immediate', 'digest', 'muted')),
  -- Digests are an email idea, and `all` only ever mutes.
  CONSTRAINT preference_mode_channel CHECK (
    (channel = 'all' AND mode = 'muted') OR (channel = 'email') OR (channel <> 'all' AND mode <> 'digest')),
  CONSTRAINT preference_version_nonnegative CHECK (version >= 0)
);
CREATE UNIQUE INDEX preference_unique ON notify.preference
  (workspace_id, membership_id, event_type, channel, scope_kind, COALESCE(scope_record_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX preference_by_scope ON notify.preference (workspace_id, scope_record_id);

CREATE TABLE notify.profile (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL,
  timezone text,
  quiet_start_minute smallint,
  quiet_end_minute smallint,
  email_enabled boolean NOT NULL DEFAULT true,
  browser_enabled boolean NOT NULL DEFAULT false,
  browser_permission text NOT NULL DEFAULT 'unknown',
  digest_cadence text NOT NULL DEFAULT 'daily',
  daily_digest_minute smallint NOT NULL DEFAULT 480,
  weekly_digest_weekday smallint NOT NULL DEFAULT 1,
  weekly_digest_minute smallint NOT NULL DEFAULT 540,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, membership_id),
  CONSTRAINT profile_member_fkey FOREIGN KEY (workspace_id, membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT profile_tz CHECK (timezone IS NULL OR (timezone ~ '^[A-Za-z]+(/[A-Za-z0-9_+\-]+)*$' AND char_length(timezone) <= 64)),
  CONSTRAINT profile_quiet_pair CHECK ((quiet_start_minute IS NULL) = (quiet_end_minute IS NULL)),
  CONSTRAINT profile_quiet_range CHECK (quiet_start_minute IS NULL OR
    (quiet_start_minute BETWEEN 0 AND 1439 AND quiet_end_minute BETWEEN 0 AND 1439 AND quiet_start_minute <> quiet_end_minute)),
  CONSTRAINT profile_browser_permission CHECK (browser_permission IN ('unknown', 'granted', 'denied')),
  CONSTRAINT profile_digest_cadence CHECK (digest_cadence IN ('off', 'daily', 'weekly')),
  CONSTRAINT profile_digest_minutes CHECK (daily_digest_minute BETWEEN 0 AND 1439 AND weekly_digest_minute BETWEEN 0 AND 1439
    AND weekly_digest_weekday BETWEEN 1 AND 7),
  CONSTRAINT profile_version_nonnegative CHECK (version >= 0)
);

-- Brand and project defaults (WSB-014): what a scope's people start with until they choose.
CREATE TABLE notify.scope_default (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  scope_kind text NOT NULL,
  scope_record_id uuid NOT NULL,
  event_type text NOT NULL,
  channel text NOT NULL,
  mode text NOT NULL,
  set_by_membership_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT scope_default_unique UNIQUE (workspace_id, scope_record_id, event_type, channel),
  CONSTRAINT scope_default_scope_fkey FOREIGN KEY (workspace_id, scope_record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT scope_default_setter_fkey FOREIGN KEY (workspace_id, set_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT scope_default_scope_known CHECK (scope_kind IN ('brand', 'project')),
  CONSTRAINT scope_default_type_known CHECK (event_type = '*' OR event_type IN
    ('assignment', 'mention', 'comment', 'review_requested', 'approval_decided', 'blocker', 'due_soon',
     'overdue', 'integration_failure', 'automation_failure', 'agent_failure', 'agent_output_ready',
     'spend_threshold', 'permission_changed', 'share_changed', 'briefing_ready', 'export_ready',
     'hidden_dependency_affects_assignee')),
  CONSTRAINT scope_default_channel_known CHECK (channel IN ('in_app', 'email', 'browser')),
  CONSTRAINT scope_default_mode_known CHECK (mode IN ('immediate', 'digest', 'muted')),
  CONSTRAINT scope_default_mode_channel CHECK (channel = 'email' OR mode <> 'digest'),
  CONSTRAINT scope_default_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX scope_default_by_setter ON notify.scope_default (workspace_id, set_by_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Discovery for the delivery, digest, deadline, and retention sweeps (payload-free, bounded)
-- ---------------------------------------------------------------------------------------------
CREATE POLICY scheduler_discovery ON notify.delivery FOR SELECT TO pm_scheduler USING (true);
CREATE POLICY scheduler_discovery ON notify.notification FOR SELECT TO pm_scheduler USING (true);
GRANT SELECT (workspace_id, state, next_attempt_at, lease_until) ON notify.delivery TO pm_scheduler;
GRANT SELECT (workspace_id, digest_pending, last_occurred_at, state) ON notify.notification TO pm_scheduler;
CREATE POLICY scheduler_discovery ON work.task FOR SELECT TO pm_scheduler USING (true);
GRANT SELECT (workspace_id, due_date, status_category) ON work.task TO pm_scheduler;
GRANT USAGE ON SCHEMA notify TO pm_scheduler;
GRANT USAGE ON SCHEMA work TO pm_scheduler;

CREATE FUNCTION exec_dispatch.discover_notification_work(p_now timestamptz, p_retention_before timestamptz, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT w.workspace_id FROM (
    SELECT d.workspace_id, min(d.next_attempt_at) AS due FROM notify.delivery d
     WHERE (d.state IN ('pending', 'deferred_quiet_hours') AND d.next_attempt_at <= p_now)
        OR (d.state = 'sending' AND d.lease_until <= p_now)
     GROUP BY d.workspace_id
    UNION ALL
    SELECT n.workspace_id, min(n.created_at) FROM notify.notification n
     WHERE n.digest_pending GROUP BY n.workspace_id
    UNION ALL
    SELECT n.workspace_id, min(n.last_occurred_at) FROM notify.notification n
     WHERE n.state <> 'saved' AND n.last_occurred_at < p_retention_before GROUP BY n.workspace_id
    UNION ALL
    SELECT t.workspace_id, p_now FROM work.task t
     WHERE t.due_date IS NOT NULL AND t.status_category NOT IN ('done', 'cancelled')
       AND t.due_date <= (p_now AT TIME ZONE 'UTC')::date + 2
       AND t.due_date >= (p_now AT TIME ZONE 'UTC')::date - 2
     GROUP BY t.workspace_id
  ) w
  GROUP BY w.workspace_id
  ORDER BY min(w.due), w.workspace_id
  LIMIT least(greatest(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION exec_dispatch.discover_notification_work(timestamptz, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION exec_dispatch.discover_notification_work(timestamptz, timestamptz, integer) TO dispatcher;
ALTER FUNCTION exec_dispatch.discover_notification_work(timestamptz, timestamptz, integer) OWNER TO pm_scheduler;

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE notify.notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE notify.notification FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notify.notification
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE notify.digest ENABLE ROW LEVEL SECURITY;
ALTER TABLE notify.digest FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notify.digest
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE notify.delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE notify.delivery FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notify.delivery
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE notify.preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE notify.preference FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notify.preference
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE notify.profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE notify.profile FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notify.profile
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE notify.scope_default ENABLE ROW LEVEL SECURITY;
ALTER TABLE notify.scope_default FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notify.scope_default
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON notify.notification, notify.digest, notify.delivery, notify.preference, notify.profile,
  notify.scope_default FROM PUBLIC;
-- People change only the state of their own notifications; the worker creates and sweeps them.
GRANT SELECT ON notify.notification, notify.digest, notify.delivery, notify.preference, notify.profile,
  notify.scope_default TO app_rw;
GRANT UPDATE (state, state_changed_at, version) ON notify.notification TO app_rw;
-- The browser acknowledges its own deliveries; administrators send a failed one back to the queue.
GRANT UPDATE (state, attempts, next_attempt_at, lease_until, failure_class, failure_code, suppress_reason,
  ack_source, delivered_at, updated_at, version) ON notify.delivery TO app_rw;
GRANT INSERT, DELETE ON notify.preference TO app_rw;
GRANT UPDATE (mode, expires_at, updated_at, version) ON notify.preference TO app_rw;
GRANT INSERT ON notify.profile TO app_rw;
GRANT UPDATE (timezone, quiet_start_minute, quiet_end_minute, email_enabled, browser_enabled, browser_permission,
  digest_cadence, daily_digest_minute, weekly_digest_weekday, weekly_digest_minute, updated_at, version)
  ON notify.profile TO app_rw;
GRANT INSERT, DELETE ON notify.scope_default TO app_rw;
GRANT UPDATE (mode, set_by_membership_id, updated_at, version) ON notify.scope_default TO app_rw;
-- Departure and account deletion erase a person's rows (personal-data eraser).
GRANT DELETE ON notify.notification, notify.digest, notify.delivery, notify.profile TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON notify.notification, notify.digest, notify.delivery TO app_worker;
GRANT SELECT, DELETE ON notify.preference, notify.profile, notify.scope_default TO app_worker;
