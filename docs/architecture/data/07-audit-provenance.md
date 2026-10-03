# 7. Audit, activity, provenance, and immutable decisions

Operational state lives in typed domain tables. **Historical truth** lives in append-only tables that domain commands write in the same transaction ([ADR-07](12-decisions.md#adr-07)).

## 7.1 Audit events

`audit.audit_event`: insert-only and partition-ready ([10 §10.9](10-postgresql-guidance.md#109-append-heavy-tables-and-partitioning)).

| Column | Purpose |
|---|---|
| `id` (UUIDv7), `occurred_at` | Identity and time (statement time of the domain change) |
| `workspace_id`, `brand_id` | Scope **at event time**. A brand move does not rewrite history. |
| `action` | Dotted verb, e.g., `task.status_changed`, `record.trashed`, `grant.created`, `export.generated`, `agent.tool_called` |
| `actor_type`, `actor_id` | `human`, `ai`, `automation`, `integration`, `agent`, `system` (0A/0E) |
| `on_behalf_of_membership_id` | The person for AI actions, or the configuring owner for automations and agents |
| `target_record_id`, `target_type`, `target_public_id` | **No foreign key**, so events survive purge |
| `changes` | `jsonb`: `{field: {old, new, class}}` for material changes only (§7.3) |
| `operation_id`, `attempt_id` | Links to `execution.operation`/`attempt` |
| `correlation_id`, `causation_id` | Request or trace grouping; the event or operation that caused this one |
| `source_kind`, `source_ref` | Channel (UI, API token prefix, webhook endpoint, import batch, template installation) |
| `workflow_revision_id` | For status transitions |

**Append-only enforcement:**

- `REVOKE UPDATE, DELETE, TRUNCATE ON audit.audit_event FROM app_rw`.
- A `BEFORE UPDATE OR DELETE` trigger raises an error unless `current_setting('app.redaction_operation_id', true)` is set **and** the session role is `audit_maintainer`. Only the redaction and purge procedures run as that role.
- A periodic check verifies hash continuity per partition (§7.6).

**Material events** (AUD-001): create, change of any non-presentation field, move (container or brand), status/lifecycle transitions, approvals and decisions, shares and permission changes, exports, executions (AI, agent, automation, integration actions), deletions, restores, purges, sign-in and security events (`audit.security_event`). Presentation-only changes (view density, column order) are not audited.

## 7.2 Activity projection

`audit.activity_item` is a **rebuildable projection** of audit events for record feeds and the Activity view (VIEW-010). Each item has:

- `target_record_id`, `brand_id`, `project_id` (permission keys), plus `related_record_id` for relationship events. Items are filtered by **both** endpoints (UXD-28).
- `summary_key` (an i18n message key) and `display_values` with **only display-safe values**: no secret- or sensitive-class values, and field values the viewer may not read are dropped at read time by field-level policy (0C).
- `group_key` for collapsing bursts ("Ana changed 5 fields").

It is written by an outbox consumer (lag of seconds is acceptable), can be rebuilt from `audit_event`, and has its own shorter retention (R-DERIVED).

## 7.3 Capturing previous and new values safely

Each field in the domain model is tagged with a **value class** in the owning module's field catalog:

| Value class | Captured in `changes` |
|---|---|
| `plain` (titles, statuses, dates, assignees) | Old and new values |
| `content` (rich descriptions, comment bodies, document bodies) | A hash plus a version reference (`document_version_id`, `comment_revision_id`). The body itself stays in the versioned content table, so audit does not duplicate large text. |
| `personal` (email, phone, time-off kind) | Old and new values, marked `class: personal`, and redacted on account deletion per OD-39 |
| `secret` | **Never captured**: `{changed: true}` only |
| `credential-ref` | Reference ID changes only |

## 7.4 Immutable decisions and evidence

| Record | Table | Immutability |
|---|---|---|
| Review decisions (approvals, acceptances, rejections) | `collab.review_decision` | Insert-only. `UNIQUE (review_request_id)`. Human reviewer only. |
| Accepted deliverable version | `files.deliverable_version` (`evidence_locked`) + object | A trigger forbids updates to locked versions except clearing on purge. The object is never overwritten (objects are immutable). |
| Go/no-go and release decisions | `delivery.release_decision` | Insert-only, sequenced. `supersedes_id` for reversals. Evidence snapshot references copied (`readiness_snapshot`, scope item IDs, test-run IDs). |
| Blocker waivers | `delivery.blocker_waiver` | Insert-only |
| Verification evidence | `quality.verification_record`, `quality.test_result`, `files.evidence_item` | Insert-only. Evidence referenced by a release decision is **evidence-locked** (`locked_by_kind = 'release_decision'`), and purge skips locked evidence while the decision exists, except during workspace deletion. |
| Approved timesheets and period locks | `timetrack.timesheet_approval`, `timetrack.period_lock` | Insert-only. Unlock is a new row. |
| Daily records | `planning.daily_record` | Insert-only snapshot |
| Approved-source verifications | `knowledge.source_approval` | Insert-only per document version |
| Billing records | `billing.invoice`, `billing.payment_event`, `metering.usage_event` | Insert-only, R-BILLING |

**Corrections** are new rows that reference the original (`supersedes_id`, or a new decision on a new review request). The UI shows both.

## 7.5 Provenance

| Origin | Recorded as |
|---|---|
| Typed in UI | `source_kind = 'ui'` |
| Capture channels | `source_kind` ∈ `paste`, `voice`, `email`, `form`, `api`, `webhook`. The original text is kept in `capture.inbox_item.raw_text` (CAP-016). |
| Import | `source_kind = 'import'`, `source_ref` = import job ID, and `transfer.import_row` links row to record |
| Integration | `source_kind = 'integration'`, plus `integrations.external_identity` |
| AI proposal applied | `source_kind = 'ai_proposal'`, `operation_id` of the application, `ai.proposed_change` link. The actor of the change is the **approving person**, with `causation_id` set to the AI action. |
| Automation | Actor type `automation`, `on_behalf_of` = automation owner, `operation_id` = automation run |
| Agent | Actor type `agent`, `operation_id` = agent run, tool call ID in `source_ref` |
| Template or sample | `template_installation_id` on the envelope |

## 7.6 Identifiers for causality and reliability

| ID | Scope | Use |
|---|---|---|
| `correlation_id` | One user request or trace (from the request context, propagated into jobs) | Group everything a single request caused |
| `causation_id` | The event or operation that directly caused this one | Automation loop detection (AUTO-011: depth and cycle checks walk causation), explanations |
| `operation_id` | One logical operation | Single logical outcome. Bulk undo groups by operation. |
| `attempt_id` | One try | Per-attempt metering and errors |
| Idempotency key | Client or API request | Maps to `operation_id` ([09 §9.6](09-concurrency-consistency.md#96-idempotency-logical-operations-and-attempts)) |
| `prev_hash` (optional, per partition) | Tamper evidence | `sha256(prev_hash || canonical(event))`, verified by a periodic job. Detects edits made outside the application role. |

## 7.7 Redaction and purge of evidence (explicit, never silent)

When privacy or purge requires removing content from immutable rows, a **redaction procedure**:

1. runs as `audit_maintainer` inside a `governance` or `core` purge operation;
2. replaces the affected `changes` values (or evidence content) with `{redacted: true, reason}`;
3. inserts an `audit.audit_redaction` row (event ID, fields, reason, authorizing request, operation);
4. leaves the structural facts in place: who, what action, which target ID, and when.

Exports of audit history (AUD-009, eligible plans) include redaction markers.

## 7.8 Retention and exportability

| Data | Retention class | Export |
|---|---|---|
| `audit_event`, `security_event`, `audit_redaction` | R-AUDIT (period OD-36) | Admin export on eligible plans (OD-45) |
| `activity_item` | R-DERIVED | Not exported separately (derived from audit) |
| Decisions and evidence | R-EVIDENCE | Full export, as part of their parent records |
| Execution history | R-EXEC | Filtered export (DATA-013) |
