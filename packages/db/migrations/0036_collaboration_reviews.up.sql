-- migrate:phase expand
-- Phase 4A (0B ADR-31, 0C AZ-31, 0D PL-33; ADR-0023; OD-10, OD-38): comments with threaded replies,
-- revisions and tombstones, reactions, mentions, per-record followers, review requests with
-- immutable per-reviewer decisions, and the append-only assignment history behind delegation and
-- reassignment. Every row hangs on a host record (core.record) and is authorized through that host
-- on every read; nothing here is a copy of anyone's access. No notification delivery, preferences,
-- documents, files, or agent tables (4B, 4C, 4E, 8D).

CREATE SCHEMA collab;
REVOKE ALL ON SCHEMA collab FROM PUBLIC;
GRANT USAGE ON SCHEMA collab TO app_rw, app_worker;

-- ---------------------------------------------------------------------------------------------
-- Comments (COL-005, COL-006): flat threads. A reply names the thread's root and, optionally, the
-- comment it answers; replies never nest deeper. Deleting is a tombstone: the body leaves the row
-- (the prior body stays in comment_revision, OD-38) so the thread keeps its shape.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE collab.comment (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  host_record_id uuid NOT NULL,
  root_comment_id uuid,
  in_reply_to_comment_id uuid,
  body_rich jsonb,
  body_text text,
  author_membership_id uuid NOT NULL,
  author_actor_type text NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  edit_count integer NOT NULL DEFAULT 0,
  deleted_at timestamptz,
  deleted_by_membership_id uuid,
  deleted_by_kind text,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT comment_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT comment_public_id_format CHECK (public_id ~ '^cmt_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT comment_host_fkey FOREIGN KEY (workspace_id, host_record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  -- Replies go with their thread when a purged host's comments are removed (no other delete path).
  CONSTRAINT comment_root_fkey FOREIGN KEY (workspace_id, root_comment_id)
    REFERENCES collab.comment (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT comment_reply_to_fkey FOREIGN KEY (workspace_id, in_reply_to_comment_id)
    REFERENCES collab.comment (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT comment_author_fkey FOREIGN KEY (workspace_id, author_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT comment_deleter_fkey FOREIGN KEY (workspace_id, deleted_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT comment_author_actor_known CHECK (author_actor_type IN ('member')),
  CONSTRAINT comment_reply_shape CHECK ((root_comment_id IS NULL) = (in_reply_to_comment_id IS NULL)),
  CONSTRAINT comment_body_rich CHECK (body_rich IS NULL OR tenancy.valid_rich_text(body_rich, 50000)),
  CONSTRAINT comment_body_text CHECK (body_text IS NULL OR (char_length(body_text) <= 50000 AND body_text ~ '[^[:space:]]')),
  -- A live comment has a body; a tombstone has none and says who removed it.
  CONSTRAINT comment_body_shape CHECK (
    (deleted_at IS NULL AND body_rich IS NOT NULL AND body_text IS NOT NULL
      AND deleted_by_membership_id IS NULL AND deleted_by_kind IS NULL)
    OR (deleted_at IS NOT NULL AND body_rich IS NULL AND body_text IS NULL
      AND deleted_by_membership_id IS NOT NULL AND deleted_by_kind IN ('author', 'moderator'))),
  CONSTRAINT comment_edit_shape CHECK ((edited_at IS NULL) = (edit_count = 0) OR deleted_at IS NOT NULL),
  CONSTRAINT comment_counts_nonnegative CHECK (edit_count >= 0 AND version >= 0)
);
CREATE INDEX comment_by_host ON collab.comment (workspace_id, host_record_id, created_at, id);
CREATE INDEX comment_by_root ON collab.comment (workspace_id, root_comment_id, created_at, id);
CREATE INDEX comment_by_reply_to ON collab.comment (workspace_id, in_reply_to_comment_id);
CREATE INDEX comment_by_author ON collab.comment (workspace_id, author_membership_id, created_at DESC);
CREATE INDEX comment_by_deleter ON collab.comment (workspace_id, deleted_by_membership_id);

-- A reply belongs to a root comment of the same host record, and answers a comment of that thread;
-- the identity columns never change (the grants also leave them out).
CREATE FUNCTION collab.comment_thread_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  root_row collab.comment%ROWTYPE;
  target_row collab.comment%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.host_record_id IS DISTINCT FROM OLD.host_record_id
       OR NEW.root_comment_id IS DISTINCT FROM OLD.root_comment_id
       OR NEW.in_reply_to_comment_id IS DISTINCT FROM OLD.in_reply_to_comment_id
       OR NEW.author_membership_id IS DISTINCT FROM OLD.author_membership_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'a comment keeps its host, thread, author, and time' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL
       AND (NEW.body_rich IS NOT NULL OR NEW.body_text IS NOT NULL) THEN
      RAISE EXCEPTION 'a deleted comment stays deleted' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
      RAISE EXCEPTION 'a deleted comment stays deleted' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.root_comment_id IS NOT NULL THEN
    SELECT * INTO root_row FROM collab.comment
      WHERE workspace_id = NEW.workspace_id AND id = NEW.root_comment_id;
    IF NOT FOUND OR root_row.root_comment_id IS NOT NULL
       OR root_row.host_record_id <> NEW.host_record_id THEN
      RAISE EXCEPTION 'a reply belongs to a root comment of the same record' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO target_row FROM collab.comment
      WHERE workspace_id = NEW.workspace_id AND id = NEW.in_reply_to_comment_id;
    IF NOT FOUND OR target_row.host_record_id <> NEW.host_record_id
       OR (target_row.id <> NEW.root_comment_id AND target_row.root_comment_id IS DISTINCT FROM NEW.root_comment_id) THEN
      RAISE EXCEPTION 'a reply answers a comment of its own thread' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER comment_thread_guard BEFORE INSERT OR UPDATE ON collab.comment
  FOR EACH ROW EXECUTE FUNCTION collab.comment_thread_guard();

-- ---------------------------------------------------------------------------------------------
-- Comment revisions (COL-009, OD-38): the prior body of every edit and of a deletion, append-only.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE collab.comment_revision (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  comment_id uuid NOT NULL,
  revision_no integer NOT NULL,
  kind text NOT NULL,
  body_rich jsonb NOT NULL,
  body_text text NOT NULL,
  actor_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT comment_revision_unique UNIQUE (workspace_id, comment_id, revision_no),
  CONSTRAINT comment_revision_comment_fkey FOREIGN KEY (workspace_id, comment_id)
    REFERENCES collab.comment (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT comment_revision_actor_fkey FOREIGN KEY (workspace_id, actor_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT comment_revision_kind_known CHECK (kind IN ('edited', 'deleted')),
  CONSTRAINT comment_revision_no_positive CHECK (revision_no >= 1),
  CONSTRAINT comment_revision_body CHECK (tenancy.valid_rich_text(body_rich, 50000))
);
CREATE INDEX comment_revision_by_actor ON collab.comment_revision (workspace_id, actor_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Reactions (COL-008): a fixed vocabulary, one row per person, comment, and reaction.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE collab.reaction (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  comment_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  reaction text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, comment_id, membership_id, reaction),
  CONSTRAINT reaction_comment_fkey FOREIGN KEY (workspace_id, comment_id)
    REFERENCES collab.comment (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT reaction_member_fkey FOREIGN KEY (workspace_id, membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT reaction_known CHECK (reaction IN
    ('thumbs_up', 'heart', 'celebrate', 'eyes', 'check', 'question', 'thanks', 'laugh'))
);
CREATE INDEX reaction_by_member ON collab.reaction (workspace_id, membership_id);

-- ---------------------------------------------------------------------------------------------
-- Mentions (TSK-019, COL-007): references from a comment to a person, a team, or a record. A
-- mention never grants access and is re-authorized when shown; `notified` is 4B's flag.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE relations.mention (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  source_kind text NOT NULL DEFAULT 'comment',
  source_id uuid NOT NULL,
  target_kind text NOT NULL,
  target_membership_id uuid,
  target_team_id uuid,
  target_record_id uuid,
  position smallint NOT NULL DEFAULT 0,
  notified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mention_source_fkey FOREIGN KEY (workspace_id, source_id)
    REFERENCES collab.comment (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT mention_member_fkey FOREIGN KEY (workspace_id, target_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT mention_team_fkey FOREIGN KEY (workspace_id, target_team_id)
    REFERENCES tenancy.team (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT mention_record_fkey FOREIGN KEY (workspace_id, target_record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT mention_source_known CHECK (source_kind IN ('comment')),
  CONSTRAINT mention_position_nonnegative CHECK (position >= 0),
  CONSTRAINT mention_target_shape CHECK (
    (target_kind = 'member' AND target_membership_id IS NOT NULL AND target_team_id IS NULL AND target_record_id IS NULL)
    OR (target_kind = 'team' AND target_team_id IS NOT NULL AND target_membership_id IS NULL AND target_record_id IS NULL)
    OR (target_kind = 'record' AND target_record_id IS NOT NULL AND target_membership_id IS NULL AND target_team_id IS NULL))
);
CREATE UNIQUE INDEX mention_unique_member ON relations.mention (workspace_id, source_id, target_membership_id)
  WHERE target_kind = 'member';
CREATE UNIQUE INDEX mention_unique_team ON relations.mention (workspace_id, source_id, target_team_id)
  WHERE target_kind = 'team';
CREATE UNIQUE INDEX mention_unique_record ON relations.mention (workspace_id, source_id, target_record_id)
  WHERE target_kind = 'record';
CREATE INDEX mention_by_source ON relations.mention (workspace_id, source_id);
CREATE INDEX mention_by_member ON relations.mention (workspace_id, target_membership_id);
CREATE INDEX mention_by_team ON relations.mention (workspace_id, target_team_id);
CREATE INDEX mention_by_record ON relations.mention (workspace_id, target_record_id);

-- ---------------------------------------------------------------------------------------------
-- Followers (OD-10, COL-010, TSK-009): an explicit subscription of one person to one record.
-- Never derived from membership, project role, assignment, or a share.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE relations.follower (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  record_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'explicit',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, record_id, membership_id),
  CONSTRAINT follower_record_fkey FOREIGN KEY (workspace_id, record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT follower_member_fkey FOREIGN KEY (workspace_id, membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT follower_source_known CHECK (source IN ('explicit'))
);
CREATE INDEX follower_by_member ON relations.follower (workspace_id, membership_id, created_at DESC, record_id);

-- ---------------------------------------------------------------------------------------------
-- Review requests (COL-013, TSK-029, TSK-030): a request to review one version of one record.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE collab.review_request (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  subject_record_id uuid NOT NULL,
  subject_kind text NOT NULL,
  subject_version bigint NOT NULL,
  kind text NOT NULL,
  rule text NOT NULL,
  state text NOT NULL DEFAULT 'requested',
  requested_by_membership_id uuid NOT NULL,
  message_text text,
  previous_request_id uuid,
  closed_reason text,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT review_request_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT review_request_public_id_format CHECK (public_id ~ '^rvw_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT review_request_subject_fkey FOREIGN KEY (workspace_id, subject_record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT review_request_requester_fkey FOREIGN KEY (workspace_id, requested_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT review_request_previous_fkey FOREIGN KEY (workspace_id, previous_request_id)
    REFERENCES collab.review_request (workspace_id, id) ON DELETE SET NULL (previous_request_id),
  CONSTRAINT review_request_subject_known CHECK (subject_kind IN ('task', 'project')),
  CONSTRAINT review_request_kind_known CHECK (kind IN ('review', 'approval')),
  CONSTRAINT review_request_rule_known CHECK (rule IN ('any', 'all')),
  CONSTRAINT review_request_state_known CHECK (state IN
    ('requested', 'changes_requested', 'approved', 'rejected', 'withdrawn', 'superseded')),
  CONSTRAINT review_request_settled_shape CHECK ((state = 'requested') = (settled_at IS NULL)),
  CONSTRAINT review_request_closed_reason_known CHECK (closed_reason IS NULL
    OR closed_reason IN ('requester', 'requester_departed', 'reviewer_departed', 'refreshed')),
  CONSTRAINT review_request_message CHECK (message_text IS NULL
    OR (char_length(btrim(message_text)) BETWEEN 1 AND 2000 AND message_text = btrim(message_text))),
  CONSTRAINT review_request_version_nonnegative CHECK (subject_version >= 0 AND version >= 0)
);
-- One open request per record; a settled one makes room for the next.
CREATE UNIQUE INDEX review_request_one_open ON collab.review_request (workspace_id, subject_record_id)
  WHERE state = 'requested';
CREATE INDEX review_request_by_subject ON collab.review_request (workspace_id, subject_record_id, created_at DESC, id);
CREATE INDEX review_request_by_requester ON collab.review_request (workspace_id, requested_by_membership_id, created_at DESC);
CREATE INDEX review_request_by_previous ON collab.review_request (workspace_id, previous_request_id);

CREATE TABLE collab.review_reviewer (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  review_request_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  rank smallint NOT NULL,
  PRIMARY KEY (workspace_id, review_request_id, membership_id),
  CONSTRAINT review_reviewer_request_fkey FOREIGN KEY (workspace_id, review_request_id)
    REFERENCES collab.review_request (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT review_reviewer_member_fkey FOREIGN KEY (workspace_id, membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT review_reviewer_rank_positive CHECK (rank >= 1)
);
CREATE INDEX review_reviewer_by_member ON collab.review_reviewer (workspace_id, membership_id, review_request_id);

-- Only active internal members review (people, never agents or guests).
CREATE FUNCTION collab.assert_reviewer_eligible() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenancy.membership m
      WHERE m.workspace_id = NEW.workspace_id AND m.id = NEW.membership_id
        AND m.kind = 'member' AND m.state = 'active') THEN
    RAISE EXCEPTION 'only active internal members can review' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER review_reviewer_eligible BEFORE INSERT ON collab.review_reviewer
  FOR EACH ROW EXECUTE FUNCTION collab.assert_reviewer_eligible();

-- One decision per named reviewer, immutable (the grants give no UPDATE or DELETE).
CREATE TABLE collab.review_decision (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  review_request_id uuid NOT NULL,
  reviewer_membership_id uuid NOT NULL,
  outcome text NOT NULL,
  subject_version bigint NOT NULL,
  note_text text,
  self_approval boolean NOT NULL DEFAULT false,
  decided_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_decision_once UNIQUE (workspace_id, review_request_id, reviewer_membership_id),
  CONSTRAINT review_decision_reviewer_fkey FOREIGN KEY (workspace_id, review_request_id, reviewer_membership_id)
    REFERENCES collab.review_reviewer (workspace_id, review_request_id, membership_id) ON DELETE RESTRICT,
  CONSTRAINT review_decision_outcome_known CHECK (outcome IN ('approved', 'changes_requested', 'rejected')),
  CONSTRAINT review_decision_note CHECK (note_text IS NULL
    OR (char_length(btrim(note_text)) BETWEEN 1 AND 2000 AND note_text = btrim(note_text))),
  CONSTRAINT review_decision_version_nonnegative CHECK (subject_version >= 0)
);

-- ---------------------------------------------------------------------------------------------
-- Assignment history (COL-014, COL-015): append-only; who handed work to whom, and how.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE collab.assignment_event (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  task_id uuid NOT NULL,
  kind text NOT NULL,
  via text NOT NULL,
  from_membership_id uuid,
  to_membership_id uuid,
  actor_membership_id uuid NOT NULL,
  note_text text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assignment_event_task_fkey FOREIGN KEY (workspace_id, task_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT assignment_event_from_fkey FOREIGN KEY (workspace_id, from_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT assignment_event_to_fkey FOREIGN KEY (workspace_id, to_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT assignment_event_actor_fkey FOREIGN KEY (workspace_id, actor_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT assignment_event_kind_known CHECK (kind IN ('assigned', 'unassigned', 'reassigned', 'delegated')),
  CONSTRAINT assignment_event_via_known CHECK (via IN ('assign', 'delegate', 'departure')),
  CONSTRAINT assignment_event_shape CHECK (
    (kind = 'assigned' AND from_membership_id IS NULL AND to_membership_id IS NOT NULL)
    OR (kind = 'unassigned' AND from_membership_id IS NOT NULL AND to_membership_id IS NULL)
    OR (kind IN ('reassigned', 'delegated') AND from_membership_id IS NOT NULL
        AND to_membership_id IS NOT NULL AND from_membership_id <> to_membership_id)),
  CONSTRAINT assignment_event_delegate_via CHECK ((kind = 'delegated') = (via = 'delegate')),
  CONSTRAINT assignment_event_note CHECK (note_text IS NULL
    OR (char_length(btrim(note_text)) BETWEEN 1 AND 500 AND note_text = btrim(note_text)))
);
CREATE INDEX assignment_event_by_task ON collab.assignment_event (workspace_id, task_id, occurred_at DESC, id);
CREATE INDEX assignment_event_by_from ON collab.assignment_event (workspace_id, from_membership_id);
CREATE INDEX assignment_event_by_to ON collab.assignment_event (workspace_id, to_membership_id);
CREATE INDEX assignment_event_by_actor ON collab.assignment_event (workspace_id, actor_membership_id);

-- A delegated assignment remembers who handed it over.
ALTER TABLE work.task_assignee
  ADD COLUMN delegated_from_membership_id uuid,
  ADD COLUMN delegated_at timestamptz,
  ADD CONSTRAINT task_assignee_delegator_fkey FOREIGN KEY (workspace_id, delegated_from_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT task_assignee_delegation_shape CHECK ((delegated_from_membership_id IS NULL) = (delegated_at IS NULL));
CREATE INDEX task_assignee_by_delegator ON work.task_assignee (workspace_id, delegated_from_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE collab.comment ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.comment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON collab.comment
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE collab.comment_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.comment_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON collab.comment_revision
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE collab.reaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.reaction FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON collab.reaction
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE relations.mention ENABLE ROW LEVEL SECURITY;
ALTER TABLE relations.mention FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON relations.mention
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE relations.follower ENABLE ROW LEVEL SECURITY;
ALTER TABLE relations.follower FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON relations.follower
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE collab.review_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.review_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON collab.review_request
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE collab.review_reviewer ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.review_reviewer FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON collab.review_reviewer
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE collab.review_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.review_decision FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON collab.review_decision
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE collab.assignment_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.assignment_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON collab.assignment_event
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON collab.comment, collab.comment_revision, collab.reaction, relations.mention, relations.follower,
  collab.review_request, collab.review_reviewer, collab.review_decision, collab.assignment_event FROM PUBLIC;
-- Comments are never hard-deleted by the application: deletion is a tombstone update.
GRANT SELECT, INSERT ON collab.comment TO app_rw;
GRANT UPDATE (body_rich, body_text, edited_at, edit_count, deleted_at, deleted_by_membership_id,
  deleted_by_kind, version) ON collab.comment TO app_rw;
GRANT SELECT, INSERT ON collab.comment_revision TO app_rw;
GRANT SELECT, INSERT, DELETE ON collab.reaction, relations.mention, relations.follower TO app_rw;
GRANT UPDATE (position) ON relations.mention TO app_rw;
GRANT SELECT, INSERT ON collab.review_request TO app_rw;
GRANT UPDATE (state, closed_reason, settled_at, updated_at, version) ON collab.review_request TO app_rw;
GRANT SELECT, INSERT ON collab.review_reviewer, collab.review_decision, collab.assignment_event TO app_rw;
-- A departing reviewer who has not decided is removed from open requests.
GRANT DELETE ON collab.review_reviewer TO app_rw;
GRANT UPDATE (delegated_from_membership_id, delegated_at) ON work.task_assignee TO app_rw;
-- The worker purges the content of a purged host record, and nothing else.
GRANT SELECT, DELETE ON collab.comment, collab.comment_revision, collab.reaction, relations.mention,
  relations.follower, collab.review_request, collab.review_reviewer, collab.review_decision,
  collab.assignment_event TO app_worker;
REVOKE ALL ON FUNCTION collab.comment_thread_guard(), collab.assert_reviewer_eligible() FROM PUBLIC;
