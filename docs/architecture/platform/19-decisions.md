# 19. Platform decisions (ADRs) and resolutions

All decisions are **proposed (Phase 0D)**, pending solutions-architect acceptance.

## 19.1 Resolutions

<a id="resolve-dq-10"></a>
**DQ-10 — public IDs. Resolved.**
- Format: `<prefix>_<26 Crockford base32>` encoding 128 random bits.
- Prefixes are 2–5 lowercase letters, with 61 registered and matched to 0B.
- Bodies are case-insensitive on input; prefixes are exact.
- UUIDv7 is confined to internal schemas, and the validator enforces this ([01 §1.1](01-principles-and-versioning.md#11-public-identifiers-resolves-dq-10)).

<a id="resolve-dq-11"></a>
**DQ-11 — field-merge and conflict payload. Resolved.**
- `PATCH` with `changes: {field: {base | base_hash, value}}`. Atomic per request.
- The conflict payload holds `theirs` only when the field is readable, plus `changed_by`/`changed_at` and `would_merge`.
- Documents use `base_version_id`, and the caller's content is saved as a new version.
- Whole-record operations require `If-Match` ([04](04-concurrency.md)).

<a id="resolve-dq-12"></a>
**DQ-12 — idempotency key scope and lifetime. Resolved.**
- Scope is (workspace, authenticated principal, key). The fingerprint is RFC 8785 over method, route, parameters, and body.
- In-progress requests return 409 (retryable). A mismatched fingerprint returns 409 reuse.
- Replay **re-renders through current authorization**.
- Transient failures are not stored.
- Retention is `IDEMPOTENCY_RETENTION`, which must cover the offline replay window ([05](05-idempotency-and-effects.md)).

<a id="resolve-dq-13"></a>
**DQ-13 — event schema and webhook exposure. Resolved.**
- Names are `<module>.<entity>.<past_verb>`, with integer `schema_version`.
- The envelope carries scope, aggregate sequence, actor, auth epoch, and causality. Payloads are minimal and ≤ C2.
- Delivery is at least once, with inbox receipts and per-aggregate ordering.
- Projections rebuild from source tables.
- 20 events have public webhook names, with allow-listed payloads built at delivery ([08](08-internal-events.md), [09](09-webhooks.md)).

<a id="resolve-dq-14"></a>
**DQ-14 — job policies. Resolved.**
- Job states map to exec states.
- Leases and heartbeats; recovery after worker loss as a new attempt.
- Full-jitter exponential backoff, caps per kind, error classes deciding retry, dead letter with alerting.
- Per-workspace fairness caps. All values are named parameters ([07](07-jobs-and-execution-context.md)).

<a id="resolve-dq-15"></a>
**DQ-15 — change-notice channel. Resolved.**
- SSE with topic subscriptions.
- `record.changed` notices carry `{id, version}` only, sent to readable subscribers.
- `Last-Event-ID` resume from a bounded buffer, with re-authorization.
- `stream.reset` on epoch change, revocation, or overflow. Polling fallback ([10](10-live-updates.md)).

<a id="resolve-dq-16"></a>
**DQ-16 — meters and money precision. Resolved.**
- 14 meters, decimal-string quantities, integer micros as strings, ISO currency.
- `measured`/`estimated`/`reported` bases are never summed silently.
- Reservation → settle/release; hard caps are enforced before and during execution.
- Corrections are appended ([14](14-usage-and-entitlements.md)).

<a id="resolve-dq-17"></a>
**DQ-17 — pagination and counts. Resolved.**
- Opaque MAC-bound keyset cursors, no offsets.
- Totals use the identical authorized predicate and are exact up to `TOTAL_COUNT_CAP`. Beyond it they are labelled capped or estimated ([02 §2.5](02-http-api.md#25-keyset-pagination-resolves-dq-17)).

<a id="resolve-aq-01"></a>
**AQ-01 — error envelope and uniform not-found. Resolved.**
- One envelope and 32 registered codes.
- Uniform `not_found` across status, body, headers, timing, and caller-visible logs.
- Readable-only signals, and a check-ordering rule.
- Every 0C response shape is mapped ([03](03-errors-and-non-disclosure.md)).

<a id="resolve-aq-02"></a>
**AQ-02 — token and OAuth scope vocabulary. Resolved.**
- 19 `<family>:<access>` scopes mapped to 0C actions, with brand lists.
- Run-bound agent credentials that expire at the run's terminal state.
- Scopes never grant data access ([11 §11.1](11-scopes-and-step-up.md#111-scope-vocabulary-aq-02)).

<a id="resolve-aq-03"></a>
**AQ-03 — execution-context fields. Resolved.**
- The `execution-context` schema carries workspace, authenticated and effective principal, initiating membership, delegation chain, selected scope, epochs at enqueue, risk/approval/step-up, data-class limit, correlation, and operation/attempt.
- It is persisted with jobs and operations and rechecked live ([07 §7.1](07-jobs-and-execution-context.md#71-execution-context-aq-03)).
- The 0B columns were added in Phase 0 integration (PC-01 resolved).

<a id="resolve-aq-04"></a>
**AQ-04 — SSE subscription contract. Resolved** as in DQ-15, with topic validation that is silent for unreadable topics, and per-principal stream limits ([10](10-live-updates.md)).

<a id="resolve-aq-05"></a>
**AQ-05 — step-up protocol. Resolved.**
- Challenge resource (`stp_`), method proof, and a single-use token bound to session, membership, action, and target, valid for `STEP_UP_WINDOW`.
- The original request is retried with the same idempotency key.
- Human-only (`step_up_unavailable` error for others), with security events ([11 §11.2](11-scopes-and-step-up.md#112-step-up-challenges-aq-05)).

## 19.2 Architecture decision records

<a id="pl-01"></a>
### PL-01: JSON over HTTPS with resource routes and colon actions; no GraphQL
- **Alternatives:** GraphQL (a second contract surface, harder per-field authorization and cost control). RPC-only (weaker resource semantics).
- **Consequences:** One surface for UI, API, and MCP tools. OpenAPI can be generated from these schemas later (PQ-11).

<a id="pl-02"></a>
### PL-02: Random prefixed public IDs; UUIDv7 internal only (DQ-10)
- **Alternatives:** Exposing UUIDv7 (leaks creation time). Sequential IDs (leak counts). Hashids (reversible).
- **Consequences:** A lookup index on public IDs. Typed IDs make route mismatches harmless (`not_found`).

<a id="pl-03"></a>
### PL-03: Own error envelope with registered codes, not RFC 9457
- **Alternatives:** RFC 9457 problem+json, whose `type` URIs and `instance` add little and tempt detail leakage.
- **Consequences:** A simple, stable shape that can be mapped to problem+json later if partners require it.

<a id="pl-04"></a>
### PL-04: MAC-bound opaque keyset cursors and authorized, labelled totals (DQ-17)
- **Alternatives:** Offset pagination (unstable under mutation, expensive). Unbound cursors (replayable across principals).
- **Consequences:** No random page access. Totals may be capped.

<a id="pl-05"></a>
### PL-05: Field-level base-value merge (DQ-11)
- **Alternatives:** Row version only (conflicts on unrelated fields, against ST-06). JSON Patch `test` operations (verbose, path-based, poor for rich text). Per-field version columns (schema bloat).
- **Consequences:** Clients keep base values. Rich text uses hashes.

<a id="pl-06"></a>
### PL-06: Principal-scoped idempotency with re-authorized replay (DQ-12)
- **Alternatives:** Workspace-scoped keys (collisions between principals). Replaying stored bodies (could bypass revocation).
- **Consequences:** Replays may return `not_found` if access was revoked. This is correct.

<a id="pl-07"></a>
### PL-07: Destination classes for external effects; never exactly once
- **Alternatives:** Blind retries (duplicate emails and charges). No retries (lost effects).
- **Consequences:** Unsafe destinations sometimes need human reconciliation, which is visible and audited.

<a id="pl-08"></a>
### PL-08: One operation resource with schema-enforced reasons and results
- **Alternatives:** Per-feature job resources (divergent states).
- **Consequences:** Uniform UI (0E ST-60) and success metrics. Partial and failed states cannot be serialized as success.

<a id="pl-09"></a>
### PL-09: Database job queue with leases, heartbeats, full-jitter backoff, fairness caps (DQ-14)
- **Alternatives:** Redis or a broker (prohibited at outset). Fixed-interval retries (thundering herds).
- **Consequences:** The PostgreSQL load from polling is bounded by `SKIP LOCKED` claims. A broker can replace dispatch later.

<a id="pl-10"></a>
### PL-10: Fact events, per-aggregate ordering, rebuild from source (DQ-13)
- **Alternatives:** Event sourcing (unneeded complexity). A global order (serializes throughput).
- **Consequences:** Consumers must handle gaps by re-reading state.

<a id="pl-11"></a>
### PL-11: Standard-Webhooks-style signing; payloads built at delivery
- **Alternatives:** Payloads frozen at event time (may disclose after revocation). Unsigned webhooks.
- **Consequences:** Payloads reflect current authorization and state at delivery time. Receivers deduplicate by `Webhook-Id`.

<a id="pl-12"></a>
### PL-12: SSE notices only, with topic subscriptions and epoch resets (DQ-15)
- **Alternatives:** WebSockets with payloads (a second data path). Polling only (stale UX).
- **Consequences:** Re-fetch traffic after notices, which is acceptable and cacheable per principal.

<a id="pl-13"></a>
### PL-13: Scopes limit action families and brands; run-bound agent credentials (AQ-02)
- **Alternatives:** Scopes as grants (confused deputy). Long-lived agent tokens (outlive runs).
- **Consequences:** Every token check is an intersection with live authorization.

<a id="pl-14"></a>
### PL-14: Step-up tokens bound and single-use (AQ-05)
- **Alternatives:** Session-wide "recently authenticated" flags (broad and replayable across actions).
- **Consequences:** A user may re-authenticate twice for two sensitive actions. That is intended.

<a id="pl-15"></a>
### PL-15: Usage as immutable events with micros strings, cost bases, reservations (DQ-16)
- **Alternatives:** Mutable counters (no audit trail). Float money (rounding errors).
- **Consequences:** Balances are derived. Corrections are explicit.

<a id="pl-16"></a>
### PL-16: Content-free logs and bounded metric labels
- **Alternatives:** Rich logs with payloads (privacy and secret leakage). Per-tenant metric labels (cardinality explosion).
- **Consequences:** Tenant diagnostics use traces and restricted logs.

<a id="pl-17"></a>
### PL-17: Identity resource prefixes, stored `locked` challenges, and the step-up response shape (Phase 1B amendment)
- **Decision:** Register `ses_` (`identity.session`), `mfa_` (`identity.mfa_factor`), and `oid_` (`identity.oauth_identity`), so sessions, factors, and linked identities are addressable for listing, revocation, and unlinking. `locked` joins the step-up challenge states as a stored terminal state, set by the failed verification that reaches `STEP_UP_MAX_ATTEMPTS` (a new 1B parameter). The 0C/0D authorization response shapes gain `step_up_required`.
- **Alternatives:** Implementation-only prefixes (two registries). Locking as a derived condition (it changes when the parameter changes, and nothing records the transition).
- **Consequences:** 64 ID prefixes and 31 named parameters. A locked challenge can never verify or yield a token.

<a id="pl-18"></a>
### PL-18: Audit change entries carry a value digest and a redaction reason (Phase 1F amendment)
- **Decision:** Each `changes[]` entry carries `digest` (`sha256:` of the canonical entry without the digest), so the tamper-evidence chain covers values through digests and an explicit redaction (which replaces values with `redacted: true` and a `reason` of `purge`, `account_deletion`, `privacy_request`, or `legal_request`) keeps the chain valid while an undeclared value edit does not. The chain is one sequence per workspace.
- **Alternatives:** Hashing values directly into the chain (any redaction would break it). No per-entry fingerprint (a value edit and a recorded redaction would look the same).
- **Consequences:** A redacted entry remains verifiable against its `audit_redaction` record. Verification detects edits, gaps, reordering, unrecorded redactions, and truncation below a checkpoint. It is not cryptographic non-repudiation.

<a id="pl-19"></a>
### PL-19: Tenancy telemetry and the tenant-isolation readiness check (Phase 1C amendment)
- **Decision:** Five bounded tenancy signals are registered: `tenancy.commands` (command, outcome), `tenancy.authz_decisions` (action_key, outcome), `tenancy.context_failures` (reason), `tenancy.context_fallbacks` (reason), and `tenancy.rls_denials` (module). The forbidden metric labels also cover `workspace`, `brand`, `membership`, `membership_id`, `account`, `account_id`, `timezone`, and `content`. Readiness gains a `tenant_isolation` check that reads only the catalog: every tenant table in `tenancy` and `access` has forced RLS with exactly one `tenant_isolation` policy, and the account directory functions are security-definer functions owned by their dedicated role. It reports a check name and state only.
- **Alternatives:** Unregistered runtime signals (drift between code and contract). A data-reading isolation probe (would touch tenant rows from an unscoped context).
- **Consequences:** The runtime only accepts registered signals with declared labels, and a validation test checks every emitted signal's name, type, and label set against the registry. A schema restored without its RLS or directory ownership fails readiness instead of serving traffic.

<a id="pl-20"></a>
### PL-20: Membership, invitation, team, grant, and ownership contracts (Phase 1D amendment)
- **Decision:**
  - Public ID prefixes `inv` (invitation) and `otr` (ownership transfer).
  - Five C1 internal events: `tenancy.membership.activated`, `tenancy.membership.suspended`, `access.role.revoked`, `tenancy.team.membership_changed`, and `tenancy.ownership.transferred`. With the existing `access.role.assigned`, `access.grant.created/revoked`, and `tenancy.membership.removed`, they are the hooks the notification phase consumes. None carries names, emails, or content.
  - Five bounded tenancy signals: `tenancy.invitation_outcomes` (stage, outcome), `tenancy.revocations` (kind, outcome), `tenancy.epoch_stale` (consumer), `tenancy.ownership_hook_failures` (hook), `tenancy.context_strategy` (strategy).
  - Named parameters `PRINCIPAL_CONTEXT_ARRAY_MAX`, `INVITATION_LIFETIME`, and `OWNERSHIP_TRANSFER_LIFETIME`.
- **Alternatives:** Unregistered runtime events and metrics (drift). Per-tenant plan numbers for these limits (OD-44 is unset).
- **Consequences:** Values are operational defaults, not product promises. The runtime emits only registered events and signals, and the drift tests enforce it.

<a id="pl-21"></a>
### PL-21: Shell, personal navigation, and view-state contracts (Phase 1E amendment)
- **Decision:**
  - Eight bounded signals: `views.recent_writes` (outcome), `views.favorite_changes` (op, outcome), `views.state_ops` (op, outcome), `views.state_decode_failures` (source, reason), `views.omitted_targets` (list), `views.cleanup` (kind), `shell.commands` (command, trigger), and `identity.preference_updates` (outcome). `shell.commands` takes its `command` values only from the fixed shell command registry in `@pm/contracts`; any other value is rejected before counting.
  - Named parameters `FAVORITES_MAX`, `RECENT_ITEMS_MAX`, `RECENT_VISIT_COALESCE`, `VIEW_STATE_MAX_BYTES`, and `VIEW_STATE_TTL`.
  - No new events or public ID prefixes: favorites, recents, view state, and preferences are personal hints that never change authority, so they produce no outbox events, and none is addressable.
- **Alternatives:** Auditing every recent visit or view-state write (it would flood the immutable audit with churn). Free-form command or route labels (unbounded cardinality, and route parameters could carry identifiers).
- **Consequences:** No signal carries a tenant, account, brand, route parameter, record, title, or query value. Values are operational defaults, not product promises.

<a id="pl-22"></a>
### PL-22: Project contracts (Phase 2A amendment)
- **Decision:**
  - Public ID prefixes `phs` (phase), `sco` (scope item), `cri` (criteria item), `pup` (project update), and `rcs` (recurrence series).
  - Sixteen C1 internal events for project updates, moves, and ownership; phases; milestones; decisions and questions; update posting and verification; relationship removal; template creation and application; and recurrence definition and state. Lifecycle stays on the existing `core.record.*` events.
  - Named bounds `PROJECT_DEPTH_MAX` (10), `TEMPLATE_ITEMS_MAX` (500), and `RECURRENCE_CATCHUP_MAX` (12). The database depth ceiling of 32 is an invariant, not a parameter.
  - Recurrence discovery bounds `RECURRENCE_WORKSPACE_DISCOVERY_MAX` (200, range 1–1000) and `RECURRENCE_SERIES_DISCOVERY_MAX` (50, range 1–500). Three distinct layers: workspaces per run, series per workspace per run, occurrences per series per run (`RECURRENCE_CATCHUP_MAX`). Both discovery layers take the oldest-waiting work first (a series' last run time, set at creation and on every run), so work beyond a batch stays eligible and is reached in a bounded number of runs.
  - Two bounded signals: `work.recurrence.occurrences` (outcome) and `work.hierarchy.moves` (outcome).
  - Cycle and depth refusals are `validation_failed` issues (`cycle`, `depth_exceeded`). Share refusals follow 0C AZ-21: `not_found` for unreadable targets, `forbidden` for readable but unshareable ones.
- **Alternatives:** New error codes for cycles and depth (they are field validation, not new failure classes). Per-entity lifecycle events (the `core.record.*` events already cover archive, trash, restore, and purge).
- **Consequences:** Event payloads carry identifiers, kinds, and states only, never titles, descriptions, risks, budgets, or hidden endpoint data. 71 ID prefixes, 68 events, 44 named parameters.

<a id="pl-23"></a>
### PL-23: Rich text version 1 (Phase 2A amendment)
- **Decision:**
  - Schema `rich-text` defines the canonical rich-text envelope `{type: "doc", version, content}`. Version 1 is the plain-text subset: paragraphs of unmarked text nodes, one paragraph per line. Other node types, marks, and attributes are refused, never stored.
  - Text nodes are non-empty and contain no line breaks or control characters (tab allowed). Length limits apply to the extracted text (paragraphs joined by a line break, in code points), never to serialized JSON.
  - A document without non-whitespace text is refused; `null` is the only empty value.
  - Field merges send `base_hash` (`sha256:` over the RFC 8785 canonical form) for rich-text fields (§4.2). The runtime validator (`@pm/contracts/rich-text`) and the database check (`tenancy.valid_rich_text`) apply the same rules.
  - First use: `work.project.description_rich` (20,000 characters). The Phase 2A editor is a plain multiline control encoding version 1.
- **Alternatives:** A plain-text column until 4C (a later destructive content migration). Storing arbitrary JSON (unvalidated content at rest). Choosing the full 4C format now (premature; PQ-06 stays with 4C).
- **Consequences:** Phase 4C adds node and mark types under the same envelope and `version`. Stored version 1 documents remain valid without migration. 30 schemas.

<a id="pl-24"></a>
### PL-24: Task contracts (Phase 2B amendment)
- **Decision:**
  - Public ID prefixes `chk` (checklist item), `lbl` (label), and `lnk` (record link). Tasks keep `tsk`; task criteria use `cri`.
  - Four new C1 events: `work.task.moved`, `work.task.reopened`, `work.label.created`, and `work.label.updated`. Task creation, update, status, completion, and assignment use the existing `work.task.*` events; relationships use `relations.relationship.*`; lifecycle stays on `core.record.*`.
  - Named bounds `TASK_DEPTH_MAX` (20, range 1–64), `TASK_SUBTREE_MAX` (500), `TASK_ITEMS_MAX` (200 per kind), `TASK_ASSIGNEES_MAX` (20), `TASK_LABELS_MAX` (50), `BRAND_LABELS_MAX` (1000), and `TASK_ESTIMATE_MINUTES_MAX` (100000). The database depth ceiling of 64 is an invariant, not a parameter. Task and project lists page with `PAGE_LIMIT_DEFAULT` and `PAGE_LIMIT_MAX`.
  - Two bounded signals: `work.task.moves` (outcome) and `work.task.completions` (outcome).
  - Cycle, depth, and criteria refusals are `validation_failed` issues (`cycle`, `depth_exceeded`, `criteria_incomplete`); share refusals follow 0C AZ-21/AZ-22.
- **Alternatives:** A separate history table (the 1F audit ledger is the history). Per-entity events for checklist items and links (they are task content; `work.task.updated` names the changed fields).
- **Consequences:** Event payloads carry identifiers, kinds, and states only, never titles, descriptions, checklist text, URLs, or label names. 74 ID prefixes, 72 events, 51 named parameters, 51 telemetry signals.

<a id="pl-28"></a>
### PL-28: Query and saved-view contracts (Phase 3A amendment)
- **Decision:**
  - **Queries.** `POST …/tasks:query` and `POST …/projects:query` (§2.4) take the 0B query AST (`v: 1`, entity, AND/OR filter groups, multi-sort, grouping), an optional presentation, an optional brand `scope`, `limit`, `cursor`, `include_total`, and the caller's `today` for relative dates.
    - Responses are `collection-page` envelopes with an optional `view` object: columns, group summaries computed with the identical authorized predicate, and labels for readable filter values.
    - Cursors are opaque, MAC-bound keyset positions over the sort keys and the record ID. Totals are capped at `TOTAL_COUNT_CAP`.
  - **Exports.** `POST …/tasks:export` and `…/projects:export` return CSV (formula-neutralized) or JSON directly, bounded by `EXPORT_ROWS_MAX`, with `Cache-Control: private, no-store`. Larger views are refused with `validation_failed` (`too_many`). The stored `export` operation and `exf_` artifacts stay with 4E and 6D.
  - **Saved views.** Prefix `view` (registered in 0B) is implemented. `…/views` (list, create), `…/views/{view}` (read, `PATCH` with `If-Match`, delete), verbs `:share`, `:unshare`, `:pin`, `:unpin`, and `…/views/defaults` (`GET` resolution, `PUT` set or clear).
  - **Non-resource envelopes.** `view_catalog` (usable fields and operators), `view_field_options` (readable choices for a reference field), `view_default_resolution`, and `view_default`.
  - **Events.** Seven: `views.saved_view.created`, `.updated`, `.shared`, `.unshared`, `.deleted`, `views.default.changed`, and `views.pin.changed`.
  - **Bounds.** `QUERY_CONDITIONS_MAX` (40), `QUERY_DEPTH_MAX` (3), `QUERY_SORTS_MAX` (5), `QUERY_VALUES_MAX` (100), `QUERY_GROUPS_MAX` (200), `VIEW_COLUMNS_MAX` (20), `SAVED_VIEWS_MAX` (200), `VIEW_PINS_MAX` (20), `EXPORT_ROWS_MAX` (5000), with `TOTAL_COUNT_CAP` (10000) now configured.
  - **Signals.** `views.queries` (entity, outcome), `views.query_duration` (entity), and `views.exports` (entity, format).
- **Alternatives:** `GET` with the AST in the URL (it would land in logs and the 0D field-selection rule). Offset pages (forbidden for mutable collections).
- **Consequences:** Payloads carry identifiers, kinds, and counts only, never names or query text. 83 ID prefixes, 104 events, 99 named parameters, 63 telemetry signals.

<a id="pl-27"></a>
### PL-27: Capture contracts (Phase 2E amendment)
- **Decision:**
  - Prefixes `inb`, `note`, and `form` (registered in 0B) are implemented; lineage and submissions have no public ID.
  - Events: `capture.inbox.captured` (source kind, intent) and `capture.inbox.triaged` are implemented. Six are added: `capture.inbox.merged`, `capture.note.created`, `capture.note.converted`, `capture.intake_form.created`, `capture.intake_form.updated`, and `capture.intake.submitted`.
  - Named bounds: `CAPTURE_TEXT_MAX` (10000), `CAPTURE_PASTE_LINES_MAX` (100), `CAPTURE_LINKS_MAX` (10), `CAPTURE_FILES_MAX` (10), `CAPTURE_PARSE_TOKENS_MAX` (64), `CAPTURE_RATE_PER_MINUTE` (60), `TRIAGE_BATCH_MAX` (50), `INBOX_MERGE_MAX` (20), `INTAKE_FORMS_MAX` (50), and `INTAKE_SUBMISSIONS_PER_HOUR` (20).
  - Three signals: `capture.items`, `capture.parse`, and `capture.triage` (outcome).
  - Non-resource envelopes: `capture_preview` (deterministic parse with spans, values, and ambiguities), `triage_preview`, and `merge_preview`.
  - Refusals: rate limits are `rate_limited`; oversize text and pastes are `validation_failed` (`too_long`, `too_many`); files are `dependency_unavailable` per attachment (`storage_unavailable`, 4E), and the capture is kept.
- **Alternatives:** AI parsing (7F; 2E is deterministic and claims no AI). One event per pasted line (a capture batch is one command).
- **Consequences:** Payloads carry identifiers, kinds, and counts only, never captured text. 83 ID prefixes, 97 events, 90 named parameters, 60 telemetry signals.

<a id="pl-26"></a>
### PL-26: Task interaction contracts (Phase 2D amendment)
- **Decision:**
  - Public ID prefixes `rem` (task reminder), `bop` (bulk operation), and `und` (undo entry). Task series keep `rcs`; task templates keep `tpl`.
  - Five C1 events: `planning.task_reminder.scheduled`, `planning.task_reminder.fired` (the content-free outbox fact 4B delivers), `work.bulk_operation.executed`, `work.task.undone`, and `templates.template.versioned` (a new immutable template version). Generated task occurrences reuse `planning.occurrence.generated`; edits reuse `work.task.*`.
  - Named bounds:
    - Freshness (OD-17): `TASK_STALE_ACTIVE_DAYS` (7), `TASK_STALE_PLANNED_DAYS` (14), `TASK_RESCHEDULE_COUNT` (3), `TASK_RESCHEDULE_WINDOW_DAYS` (14).
    - Personal state: `TASK_REMINDERS_MAX` (10), `REMINDER_FIRE_BATCH_MAX` (500), `TASK_SNOOZE_MAX_DAYS` (365).
    - Bulk and undo: `BULK_ITEMS_MAX` (200), `BULK_PREVIEW_TTL_SECONDS` (600), `UNDO_WINDOW_SECONDS` (30).
    - Duplicates: `DUPLICATE_WINDOW_DAYS` (90), `DUPLICATE_CANDIDATES_MAX` (5).
  - One job, `work.reminders` (every minute; discovery through a payload-free dispatcher function). Task recurrence runs in the existing `work.recurrence` job.
  - Three bounded signals: `work.reminders.fired`, `work.bulk.items`, and `work.undo.applied` (outcome).
  - Refusals: an expired or superseded undo, bulk preview, or inline base is `conflict` (`stale`); a bulk set over the bound or a snooze beyond its bound is `validation_failed` (`too_many`, `out_of_range`); unreadable items are `not_found`.
- Review 01: the non-resource `bulk_status_options` envelope lists a selection's statuses (custom included) with per-status task counts; task origin gains `template`.
- **Alternatives:** Per-channel reminder events (channels are 4B). A bulk job per item (one command, one report).
- **Consequences:** Event payloads carry identifiers, kinds, counts, and states only, never titles, reminder notes, or field values. 83 ID prefixes, 91 events, 80 named parameters, 57 telemetry signals.

<a id="pl-25"></a>
### PL-25: Workflow and custom-field contracts (Phase 2C amendment)
- **Decision:**
  - Public ID prefixes `sts` (workflow status), `trn` (transition), `wap` (workflow approval request; `apr` is the agent action approval), `fld` (field definition), `fop` (field option), and `fst` (field set). Workflows keep `wf`.
  - Fourteen C1 events. Five for configuration: `workflow.workflow.created`/`updated`, `workflow.status.created`/`updated`, `workflow.transition.created`/`updated`. Three for approvals: `workflow.approval_request.created`/`decided`/`closed`. Fields: `workflow.field_definition.created`/`updated`, `workflow.field_set.versioned`/`applied`, and `workflow.field_value.changed`. Status changes keep `work.task.status_changed` and `work.project.status_changed`.
  - Named bounds:
    - Workflows: `WORKFLOW_STATUSES_MAX` (50), `WORKFLOW_TRANSITIONS_MAX` (400), `TRANSITION_REQUIREMENTS_MAX` (30).
    - Approvals and previews: `TRANSITION_APPROVERS_MAX` (10), `APPROVAL_EXPIRY_HOURS` (168), `TRANSITION_PREVIEW_TTL_SECONDS` (600).
    - Fields and sets: `FIELD_DEFINITIONS_MAX` (200), `FIELD_OPTIONS_MAX` (200), `FIELD_SETS_MAX` (100), `FIELD_SET_ITEMS_MAX` (100), `FIELD_TEXT_MAX` (5000), `FIELD_PATTERN_MAX` (200).
    - Formulas: `FORMULA_SOURCE_MAX` (2000), `FORMULA_AST_NODES_MAX` (200), `FORMULA_DEPTH_MAX` (8), `FORMULA_REFS_MAX` (20).
    - Bulk migration: `FIELD_VALUE_BULK_MAX` (500).
  - Three bounded signals: `workflow.transitions` (outcome), `workflow.transition.duration` (outcome), and `workflow.formula.evaluations` (outcome).
  - Refusals:
    - Transition refusals are `validation_failed` issues (`transition_not_allowed`, `required`, `invalid`).
    - Approval gates are `approval_required`.
    - Stale previews and approvals are `conflict` (`stale`).
    - In-use configuration is `conflict` (`in_use`).
    - Formula problems are `validation_failed` issues (`cycle`, `depth_exceeded`, `formula_invalid`).
- **Alternatives:** A dedicated error code per workflow refusal (the 0D set is closed; issue codes carry the detail). Unbounded formula graphs.
- **Consequences:** Event payloads carry identifiers, kinds, categories, and states only, never names, values, formulas, option labels, or emails. 80 ID prefixes, 86 events, 68 named parameters, 54 telemetry signals.
