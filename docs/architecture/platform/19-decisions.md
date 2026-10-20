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
<a id="pl-35"></a>
### PL-35: Document contracts (Phase 4C amendment)
- **Decision:**
  - Prefixes `doc` (document), `dcv` (document version), and `dsg` (document suggestion) are implemented; `dsg` is added.
  - Resources and verbs, all under the workspace:
    - `documents`: list (tree and filters, by cursor) and create; `documents/{id}`: read and `PATCH` (state, owner, review date, `If-Match`); `{id}:archive`, `:unarchive`, `:trash`, `:restore`, `:purge`, `:export`, `:approve_source`, and `:revoke_source`.
    - `documents/{id}/content` (`PUT`, naming the version loaded), `documents/{id}/restore-version`, `documents/{id}/location` (move and reorder), `documents/{id}/links`, `documents/{id}/versions` and `…/versions/{number}`.
    - `documents/{id}/suggestions` and `suggestions/{id}` with `:decide` and `:withdraw`; `records/{id}/documents` (backlinks).
    - Comments, following, reviews, and mention candidates reach a document through the existing record routes.
  - Events: `knowledge.document.created`, `.version_saved`, `.updated`, `.mention_added`, `.suggestion_created`, `.suggestion_decided`, and `.source_approved` (existing, with a `kind` field). Payloads carry identifiers, kinds, and counts, never a title, text, or address.
  - Named bounds (owner 4C): `DOCUMENT_BODY_MAX_BYTES` (262144), `DOCUMENT_BLOCKS_MAX` (2000), `DOCUMENT_BLOCK_TEXT_MAX_CHARS` (20000), `DOCUMENT_TABLE_CELLS_MAX` (1000), `DOCUMENT_DEPTH_MAX` (6), `DOCUMENT_CHILDREN_MAX` (200), `DOCUMENT_TREE_MAX` (1000), `DOCUMENT_VERSIONS_MAX` (1000), `DOCUMENT_REFERENCES_MAX` (500), `DOCUMENT_SUGGESTIONS_OPEN_MAX` (100), `DOCUMENT_EXPORT_PAGES_MAX` (100), `DOCUMENT_EXPORT_MAX_BYTES` (5242880), `DOCUMENT_REVIEW_HORIZON_DAYS` (730), `DOCUMENT_SAVE_RATE_PER_MINUTE` (60), and `DOCUMENT_EMBED_URL_MAX_CHARS` (2048).
  - Five signals: `knowledge.documents`, `knowledge.versions`, `knowledge.suggestions`, `knowledge.exports`, and `knowledge.references`.
  - Non-resource envelope: `document_export`.
  - Refusals: `conflict` issues `document_archived`, `already_current`, `already_decided`, `version_changed`, `invalid_state`, `too_large`, and `documents_attached` (a task with documents cannot change brand), with `conflict.current_version` on a stale content save; `validation_failed` issues `not_linkable`, `invalid_placement`, `different_place`, `cycle`, `depth_exceeded`, `too_many`, `too_long`, `too_far`, `invalid_date`, `invalid_url`, `unsupported_embed`, `unsupported_block`, `duplicate_block_id`, and `ragged_table`; `rate_limited` for save bursts.
- **Alternatives:** Per-host document routes (`/tasks/{id}/documents`) would multiply one contract; placement is a field of the document. A PDF export now (6D owns file generation); the HTML export carries a print stylesheet.
- **Consequences:** 89 ID prefixes, 142 events, 163 named parameters, 89 telemetry signals.
<a id="pl-38"></a>
### PL-38: Search contracts (Phase 5A amendment)
- **Decision:**
  - No identifier prefix is added: a result is addressed by the public identifier of the record, comment, file, or deliverable it is, and a recent search by an opaque handle that names no record.
  - Routes, all under `workspaces/{ws}/search` and answered for the caller alone (`Cache-Control: private, no-store`; no `Idempotency-Key`, because none of them changes anything shared): `GET` (search; `search_results`), `GET status` (`search_status`), `POST open` with `{type, id}` (`search_open`), `GET recent`, `POST recent` with `{q, filters}` (202), `DELETE recent` (forget all), and `DELETE recent/{handle}` (forget one) (`search_recent`).
  - Search parameters: `q` (required), `kind` and `brand` (lists, repeated or comma separated), `project`, `state` (`active`, `archived`, `any`), `updated` (`day`, `week`, `month`, `year`), `mine`, `mentioning_me`, `limit`, and `cursor`. The response carries `results` (type, public identifier, title and title parts, an excerpt as parts with `hit` marks, brand, the holder only when visible, project, owner, state, update time, and `index` of `current`, `updating`, or `failed`), `total` with `total_is_lower_bound`, `facets` (`kinds`, `brands`, `capped`), `page` (`limit`, `position`, `has_more`, `next_cursor`), `limits`, and `index` (`state` of `complete`, `catching_up`, or `degraded`, with `pending`, `failed`, and `oldest_pending_seconds`, counted only over records the caller can read).
  - Refusals: `validation_failed` issues `empty`, `no_terms`, `too_long`, `too_many_terms`, `required`, `invalid_option`, `unavailable` (a hidden or unknown brand or project, the same issue for both), and `too_long` for a remembered search; `cursor_invalid` for a cursor that is not the caller's or the search's; `not_found` for opening a hidden, deleted, trashed, purged, or unknown result (and for forgetting an unknown handle); `rate_limited` (policy `search.member`).
  - Named bounds (owner 5A): `SEARCH_QUERY_MAX_CHARS` (200), `SEARCH_TERMS_MAX` (12), `SEARCH_PAGE_SIZE_MAX` (50), `SEARCH_RESULTS_MAX` (200), `SEARCH_COUNT_MAX` (1000), `SEARCH_SNIPPET_CHARS` (220), `SEARCH_BODY_MAX_CHARS` (100000), `SEARCH_INDEX_BATCH_MAX` (200), `SEARCH_INDEX_DISCOVERY_MAX` (50), `SEARCH_INDEX_MAX_ATTEMPTS` (5), `SEARCH_INDEX_BACKOFF_SECONDS` (30), `SEARCH_FAILED_RETRY_MINUTES` (360), `SEARCH_RECENT_MAX` (25), `SEARCH_RECENT_RETENTION_DAYS` (90), and `SEARCH_RATE_PER_MINUTE` (120).
  - Signals: `search.requests` (op, outcome), `search.index.jobs` (kind, outcome), and `search.query.duration` (outcome). No event is added: indexing is driven by database keys, not by events, and a search or a remembered search emits nothing.
  - Non-resource envelopes: `search_results`, `search_status`, `search_open`, and `search_recent`.
  - The worker job `search.index` (every ten seconds) discovers workspaces through the payload-free `exec_dispatch.discover_search_work(now, retention_before, limit)`, which returns workspace identifiers only.
- **Alternatives:** Offset paging (0B §10.5). Server-sent search suggestions per keystroke (the palette's debounced lookup is the same request). Public identifiers for recent searches (a prefix for a personal hint). An event per indexed change (content-free events cannot drive an index).
- **Consequences:** 89 ID prefixes, 145 events, 195 named parameters, 95 telemetry signals.
<a id="pl-42"></a>
### PL-42: Integration connection contracts (Phase 6A amendment)
- **Decision:**
  - Prefixes `ext` (external identity) and `cnf` (sync conflict) are added. `conn` was already registered.
  - Routes under `/v1/workspaces/{ws}`: `integrations/providers` (`GET`), `integrations/connections` (`GET`, `POST`), `integrations/connections/rotate` (`POST`), `integrations/connections/{conn}` (`GET`), and `{conn}/oauth/complete`, `{conn}/test`, `{conn}/reauthorize`, `{conn}/disconnect`, `{conn}/sync`, `{conn}/runs`, `{conn}/conflicts`, `{conn}/conflicts/{cnf}/resolve`, `{conn}/identities/{ext}/local`. Unsafe requests take `Idempotency-Key`. Responses are `private, no-store`.
  - A connection resource never includes a credential, only `credential_configured`. Provider, owner, scopes, health, and last success are included (INT-005).
  - Non-resource envelopes: `integration_providers`, `integration_connections`, `integration_rotation`, `sync_runs`, `sync_conflicts`.
  - Refusals: `validation_failed` issues `provider_unconfigured`, `insufficient_scope`, `invalid_option`, and `too_many`; `not_found` for unknown and hidden connections; `forbidden` for guests; `conflict` when a checkpoint loses a compare-and-set.
  - Events (class C1): `integrations.connection.created`, `.reauthorized`, `.disconnected`, `.health_changed`, `integrations.sync.completed`, `integrations.sync.failed`, `integrations.conflict.detected`, `integrations.conflict.resolved`, `integrations.credential.rotated`. Fields are enums, counts, and identifiers.
  - Named bounds (owner 6A): `CONNECTIONS_PER_SCOPE_MAX` (50), `CONNECTION_SCOPES_MAX` (16), `SYNC_BATCH_MAX` (100), `SYNC_MAX_ATTEMPTS` (5), `SYNC_BACKOFF_SECONDS` (30), `SYNC_LEASE_SECONDS` (120), `SYNC_HISTORY_RETENTION_DAYS` (90), `SYNC_RATE_PER_MINUTE` (30).
  - Signals: `integrations.requests` (op, outcome) and `integrations.jobs` (kind, outcome). `integration.sync.duration` was already registered.
  - Job: `integrations.sync`, every minute, through `exec_dispatch.discover_integration_work` (workspace identifiers only).
  - Loopback is configured for local and test when `INTEGRATION_LOOPBACK_ENABLED` is `auto`, and nowhere else unless the value is `1`. An unconfigured provider is a property of the connection catalog, not a process readiness failure, so core work stays ready (LA-020).
- **Alternatives:** A readiness check that fails when no provider is configured (it would make the product unusable without an integration). Storing the one-time API key in the idempotency response (idempotency stores references only).
- **Consequences:** Two new identifier prefixes, the events and bounds above, and two signals.
<a id="pl-41"></a>
### PL-41: Dashboard and report contracts (Phase 5D amendment)
- **Decision:**
  - Identifier prefixes: `dash` (dashboard) and `rpt` (report definition) are records in the core envelope; `rsh` (report share) is a child with its own public identifier. Recipients and delivery runs have none.
  - Routes under `/v1/workspaces/{ws}`: `insights/metrics` (`GET` the catalog, with the metrics not yet available and why), `insights/trash` (`GET`), `dashboards` (`GET` list, `POST`), `dashboards/{dash}` (`GET`, `PATCH` with `If-Match`; verbs `:archive`, `:unarchive`, `:trash`, `:restore`, `:purge`), `dashboards/{dash}/widgets/{widget}` and `.../records` (`GET`; `filters`, `cursor`, `limit`), `dashboards/{dash}/export` (`GET`; `format=csv|pdf`, `widget`, `filters`), and for reports `reports`, `reports/{rpt}` (verbs as above plus `:resume` and `:leave`), `reports/{rpt}/widgets/{widget}`, `.../records`, `reports/{rpt}/export`, `reports/{rpt}/schedule` (`PUT`), `reports/{rpt}/recipients` (`GET`, `PUT`), `reports/{rpt}/runs` (`GET`), and `reports/{rpt}/shares` (`GET`, `POST`) with `DELETE reports/{rpt}/shares/{rsh}`.
  - Computed reads are non-resource envelopes `widget_result`, `widget_records`, `insight_metrics`, `report_runs`, `report_recipients`, and `report_shares`, sent `Cache-Control: private, no-store`. Each figure says what it covers, its source, when it was computed (`freshness`), which filters applied, and what is estimated or incomplete. Exports are files (`text/csv` or `application/pdf`) with `Content-Disposition: attachment`, `no-store`, and `nosniff`.
  - Refusals: `conflict` issues `dashboard_archived`, `report_archived`, `brand_archived`, `invalid_state`, and `already_shared`; `validation_failed` issues `unknown_metric`, `not_available` (a metric defined by a later phase), `invalid_reference` (the one answer for an unreadable, unknown, or unable-to-read target), `no_recipients`, `schedule_needs_recipient`, `invalid_range`, `invalid_zone`, `too_many`, `duplicate`, and `unsupported_field`; `rate_limited` for exports.
  - Events (owner 5D, class C1, enums and counts only): `insights.dashboard.created`, `.updated`, `insights.report.created`, `.updated`, `.shared`, `.share_revoked`, `.schedule_changed`, `.suspended`, and `.resumed`. Audit actions `insights.exported`, `report.shared`, `report.share_revoked`, `report.schedule_changed`, `report.recipients_changed`, `report.suspended`, and `report.resumed` carry counts, with a security event of category export for exports.
  - Named bounds (owner 5D): `DASHBOARDS_PER_SCOPE_MAX` (100), `DASHBOARD_PERSONAL_MAX` (20), `DASHBOARD_WIDGETS_MAX` (24), `REPORTS_PER_SCOPE_MAX` (200), `REPORT_RECIPIENTS_MAX` (50), `REPORT_SHARES_MAX` (100), `REPORT_EXPORT_ROWS_MAX` (5000), `REPORT_EMAIL_ROWS_MAX` (25), `REPORT_EXPORT_RATE_PER_MINUTE` (20), `REPORT_RUN_RETENTION_DAYS` (90), `REPORT_BATCH_MAX` (25), `REPORT_LEASE_SECONDS` (300), `REPORT_MAX_ATTEMPTS` (5), and `REPORT_FRESHNESS_MINUTES` (720).
  - Signals: `insights.reads` (view, outcome), `insights.changes` (kind, outcome), `insights.jobs` (kind, outcome), and `insights.widgets` (metric, outcome). No label, log field, or event carries a title, a figure, or a recipient.
  - Job: `insights.deliver`, scheduled every minute, discovers workspaces through `exec_dispatch.discover_report_work` (workspace identifiers only) and delivers in each workspace's own transactions through the 4B email provider boundary, recording `skipped` with `provider_unconfigured` rather than claiming a send.
- **Alternatives:** A report resource carrying its computed figures (a cacheable resource would outlive a revocation). Attaching the rendered PDF to the email (viewer data in the provider, with no way to recall it). An error that names which target was unreadable.
- **Consequences:** 91 ID prefixes, 165 events, 222 named parameters, 102 telemetry signals.

<a id="pl-39"></a>
### PL-39: Goal and portfolio contracts (Phase 5B amendment)
- **Decision:**
  - Identifier prefixes: `goal` (goal), `kr` (key result), `pf` (portfolio) are records in the core envelope; `gci` (check-in) is a child with its own public identifier. Links and portfolio members have none.
  - Routes under `/v1/workspaces/{ws}`: `goals` (`GET` list with filters and a cursor, or `?trashed=true` for the goals the caller may restore; `POST` create), `goals/export` (`GET`; CSV or JSON), `goals/{goal}` (`GET`, `PATCH` with `If-Match`; verbs `:archive`, `:unarchive`, `:trash`, `:restore`, `:purge`, `:recalculate`), `goals/{goal}/check-ins` (`GET` history with a cursor, `POST`), `goals/{goal}/key-results` (`POST`), `goals/{goal}/key-results/{kr}` (`PATCH`; verbs `:archive`, `:unarchive`), `goals/{goal}/links` (`POST`, `DELETE`), `goals/{goal}/work` (`GET`; the readable tasks behind the goal's linked-work figures, optionally for one key result; `goal_work`), `projects/{project}/goals` (`GET`), `portfolios` (`GET`, also `?trashed=true` for those the caller may restore; `POST`), `portfolios/{pf}` (`GET`, `PATCH`; verbs `:archive`, `:unarchive`, `:trash`, `:restore`, `:purge`), `portfolios/{pf}/projects` (`PUT`, the explicit member list), `portfolios/{pf}/overview` (`GET`), and `portfolio/overview`, `portfolio/dependencies`, `portfolio/orphans`, `portfolio/export` (`GET`). Unsafe requests take `Idempotency-Key`; edits take `If-Match` (a stale version is `conflict`, a missing one `precondition_required`).
  - Computed reads (overview, dependencies, orphans, and a goal's work drill-down) are non-resource envelopes `portfolio_overview`, `portfolio_dependencies`, `portfolio_orphans`, and `goal_work`, sent `Cache-Control: private, no-store`. Each says what it covers (`coverage`, `scope_note`), when (`as_of`, `computed: live`), and what is missing (`incomplete`, `truncated`, `not_tracked`). Exports are files (`text/csv` or `application/json`) with `Content-Disposition: attachment`, `no-store`, and `nosniff`.
  - Refusals: `conflict` issues `goal_archived`, `portfolio_archived`, `goal_closed` (a closed goal refuses check-ins), `brand_archived`, and `invalid_state` (a goal that left draft cannot return to it); `validation_failed` issues `invalid_reference` (the one answer for an unreadable, unknown, or wrongly placed target), `wrong_scope`, `too_many`, `invalid_option`, `invalid_number`, `invalid_type`, `required`, `too_long`, `conflicting`, `empty`, and `incomplete`; `forbidden` for a caller who may read but not write (and for guests on collections); `not_found` for an unreadable or unknown goal or portfolio; `cursor_invalid`; `precondition_required` for an edit without a version; `rate_limited` for check-in bursts (policy `goal.checkin`).
  - Events (owner 5B, class C1, enums and counts only, no title, note, or identifier of work): `goals.goal.created`, `.updated`, `.status_changed`, `.checkin_recorded`, `.link_changed`, `.update_stale` (for 4B to consume later; no consumer yet), `goals.key_result.created`, `.updated`, `goals.portfolio.created`, `.updated`, and `.members_changed`. Audit actions `goals.exported` and `portfolio.exported` carry counts, with a security event of category export.
  - Named bounds (owner 5B): `GOALS_PER_SCOPE_MAX` (500), `GOAL_KEY_RESULTS_MAX` (20), `GOAL_LINKS_MAX` (200), `GOAL_UPDATE_STALE_DAYS` (14), `GOAL_CHECKIN_RATE_PER_MINUTE` (30), `PORTFOLIOS_MAX` (100), `PORTFOLIO_PROJECTS_MAX` (200), `PORTFOLIO_READ_PROJECTS_MAX` (500), `GOALS_EXPORT_ROWS_MAX` (5000), `GOALS_RECALC_BATCH_MAX` (200), `GOALS_RECALC_LEASE_SECONDS` (300), `GOALS_RECALC_INTERVAL_MINUTES` (360), and `GOALS_RECALC_MAX_ATTEMPTS` (5).
  - Signals: `goals.reads` (view, outcome), `goals.changes` (kind, outcome), and `goals.jobs` (kind, outcome). No label, log field, or event carries goal text.
  - Job: `goals.recalculate`, scheduled every minute, discovers workspaces through `exec_dispatch.discover_goal_work` (workspace identifiers only) and recalculates in each workspace's own transactions.
- **Alternatives:** Storing health and progress and refreshing them by job (one viewer's view served to every viewer). A single `portfolio` resource carrying its computed figures (a cacheable resource would outlive a revocation). An error that names which target was unreadable.
- **Consequences:** 90 ID prefixes, 156 events, 193 named parameters, 95 telemetry signals.
<a id="pl-40"></a>
### PL-40: Metric contracts (Phase 5C amendment)
- **Decision:**
  - No identifier prefix is added: a metric is addressed by its registered name (`project.completion`, `work.cycle_time`, ...) and a version, and the records behind a figure by their own public identifiers.
  - Routes under `/v1/workspaces/{ws}/metrics`, all answered for the caller alone (`Cache-Control: private, no-store`; no `Idempotency-Key`, because reading changes nothing): `GET` (the catalog of definitions with version, whether it is current, unit, scopes, window, whether a past time can be reproduced, numerator, denominator, sources, zone, freshness basis, rollup rule, incomplete reasons, authorization rule, drill roles, what it does not claim, availability, changelog, and digest; `metric_catalog`), `GET {metric}` (one figure; `metric_result`), `GET {metric}/records` (the records behind a role; `metric_records`), `GET {metric}/export` (CSV with `Content-Disposition`, `nosniff`), and `POST metrics:reconcile` (202; `metric_reconcile`; `workspace.configure`).
  - Parameters: `version`, `brand` and `project` (public identifiers), `subprojects` (default true), `from` and `to` (local dates in the workspace zone), `as_of` (an instant with an offset), `person` (members only; the workload drill), and for records `member` (the role), `limit`, and `cursor`. A result carries `definition` (id, version, name, unit, digest), `scope`, `window`, `as_of`, `timezone`, `state` (`complete`, `partial`, `estimated`, `empty`, `unavailable`), `value`, `parts` (numerator and denominator), `incomplete` (code, message, count), `groups`, `freshness` (`current`, `catching_up`, `degraded`, the time of the data, the basis, and for ledger metrics the reconciliation state), `provenance`, `limits`, `unavailable` (phase and reason), `drill` (roles with counts), and `reproducibility` (definition digest, `as_of`, whether historical, result digest).
  - Refusals: `validation_failed` issues `invalid_option` (a malformed value), `unavailable` (a hidden or unknown brand or project, or a version that does not exist; one issue for hidden and unknown), `invalid_date`, `order`, `too_long` (a window or a scope), `not_supported` (a past `as_of` on a metric that describes the present, or a scope the metric cannot take); `cursor_invalid`; `not_found` (an unknown metric or a workspace the caller is not in); `forbidden` (reconciliation without `workspace.configure`); `rate_limited` (policy `metrics.member`).
  - Named bounds (owner 5C): `METRICS_WINDOW_DAYS_MAX` (366), `METRICS_DEFAULT_WINDOW_DAYS` (30), `METRICS_DRILL_PAGE_MAX` (100), `METRICS_DRILL_RESULTS_MAX` (1000), `METRICS_SCOPE_TASKS_MAX` (20000), `METRICS_SAMPLE_MIN` (5), `METRICS_RATE_PER_MINUTE` (60), `METRICS_RECONCILE_BATCH_MAX` (500), `METRICS_RECONCILE_DISCOVERY_MAX` (50), `METRICS_RECONCILE_INTERVAL_MINUTES` (360), `METRICS_RECONCILE_LEASE_SECONDS` (300), `METRICS_RECONCILE_MAX_ATTEMPTS` (5), and `METRICS_RECONCILE_BACKOFF_SECONDS` (60).
  - Signals: `metrics.requests` (op, outcome), `metrics.query.duration` (outcome), and `metrics.reconcile.jobs` (outcome). No event is added: figures are computed at request time and the ledger is written by database triggers.
  - Non-resource envelopes: `metric_catalog`, `metric_result`, `metric_records`, and `metric_reconcile`.
  - The worker job `metrics.reconcile` (every five minutes) discovers workspaces through the payload-free `exec_dispatch.discover_metrics_work(now, limit)`, which returns workspace identifiers only.
- **Alternatives:** A resource per metric value with an identifier (a cacheable, shareable figure). Storing snapshots and serving them (one viewer's figure to another). An event per status change for the ledger (a missed or reordered event leaves a gap; the trigger shares the task's transaction).
- **Consequences:** 90 ID prefixes, 156 events, 221 named parameters, 101 telemetry signals.

<a id="pl-37"></a>
### PL-37: Live editing contracts (Phase 4D amendment)
- **Decision:**
  - No identifier prefix is added: a live session is addressed by an unguessable handle that names no record, and it is never an identifier of one.
  - Routes, all under `workspaces/{ws}/documents/{doc}/live/` and authorized per request: `session` (`POST`, join; `live_session`), `operations` (`POST`; `live_update`), `events` (`GET`, a bounded long poll with `session`, `after`, `wait`, and `presence_tag`; `live_update`; `Cache-Control: no-store`), `heartbeat` (`POST`), `checkpoint` (`POST`, the explicit save), and `leave` (`POST`). They carry no `Idempotency-Key`: an operation's own `op_id` makes a retry idempotent, and a checkpoint with nothing new makes no version.
  - Operations are `insert`, `replace`, `delete`, and `move` on blocks. `replace` and `delete` name the block hash the client last received; a refused operation (`block_changed`, `block_missing`, `block_exists`, `anchor_missing`) is listed in `rejected` with the current block as the caller may see it, and never stored. Accepted operations are numbered in one gapless order (`seq`); a request's `after` returns what was missed. A client whose position is older than the retained log, or newer than the draft, receives `resync` with a snapshot.
  - Refusals are `conflict` with issue codes `live_disabled`, `live_capacity`, `session_expired`, `session_read_only`, `live_edit_in_progress` (a plain save or restore while a session is open), and `document_archived`; `not_found` for an unreadable document; `rate_limited` (policy `document.live`); `validation_failed` issues as for content, with `invalid_session`, `invalid_hash`, `duplicate`, and `too_many`.
  - Named bounds (owner 4D): `LIVE_EDITING_ENABLED` (1), `LIVE_SESSION_TTL_SECONDS` (45), `LIVE_SESSIONS_MAX` (20), `LIVE_SESSIONS_PER_MEMBER_MAX` (5), `LIVE_OPS_BATCH_MAX` (50), `LIVE_POLL_WAIT_SECONDS` (20), `LIVE_OP_LOG_MAX` (2000), and `LIVE_RATE_PER_MINUTE` (1200).
  - Signal: `knowledge.live` (action, outcome). No event is added: operations and presence emit nothing, and a checkpoint emits the existing `knowledge.document.version_saved` and `.mention_added`.
  - Non-resource envelopes: `live_session` and `live_update`.
  - Transport is HTTP with a bounded long poll, not WebSocket or SSE: every exchange re-authorizes, a revoked editor cannot be held open by an idle connection, and no sticky routing or new infrastructure is needed (§10's one-way push stays for notices).
- **Alternatives:** WebSocket with per-connection authorization (revocation needs a push channel and sticky routing). A CRDT sync protocol (hidden content in transit). Server-sent events per document (the same revocation gap, and proxies buffer them).
<a id="pl-36"></a>
### PL-36: File and deliverable contracts (Phase 4E amendment)
- **Decision:**
  - Prefixes `file`, `fv`, `upl`, `dlv`, and `dv` (registered in Phase 0) are implemented; none is added.
  - Resources and verbs, all under the workspace:
    - `storage` (`GET`): whether object storage and malware scanning are configured, whether uploads are accepted, and the workspace's used and reserved bytes against its quota (`storage_status`).
    - `uploads` (`POST`, `Idempotency-Key`), `uploads/{upl}` (`GET`), and `uploads/{upl}:complete`. The session carries a signed `PUT` (method, URL, required headers, expiry); an idempotent replay signs a fresh URL.
    - `files?host=` (list), `files/{file}` (`GET`, `PATCH` name with `If-Match`), `files/{file}:download` (`303` to a signed URL or to an external link, `Cache-Control: no-store`), `files/{file}:preview` and `files/{file}:compare` (`file_url`, `file_comparison`), `files/{file}:trash` (`file_trashed`), and `file-links` (`POST`).
    - `tasks/{tsk}/deliverables` (list with counts, `deliverable_list`; create), `projects/{prj}/deliverables` (list with counts, PRJ-023), `deliverables/{dlv}` (`GET`), and `deliverables/{dlv}:submit`.
    - The local development adapter serves `/v1/storage/local/{key}` for `PUT` and `GET`, authorized only by its HMAC signature (no session), and refused when deployed.
  - Object keys are identifier-free: `q.{64 hex}` while quarantined and `o.{same}` once promoted (this replaces §15.1's `ws/{workspace}/{random}`). Download is `files/{file}:download` on the file's current or a named version, not a separate `file-versions` route.
  - Events: `files.file.added`, `files.file.version_added`, and `files.deliverable.state_changed` are added; `files.file.scanned` and `files.deliverable.version_submitted` are implemented. They carry identifiers, version numbers, sources, and states, never names, URLs, signatures, or keys.
  - Named bounds (owner 4E): `SIGNED_URL_LIFETIME` (300 seconds) and `UPLOAD_SESSION_LIFETIME` (3600 seconds) gain values; `FILE_UPLOAD_MAX_BYTES` (104857600), `WORKSPACE_STORAGE_QUOTA_BYTES` (10737418240, a technical limit until 10A plans), `FILE_COMPARE_MAX_BYTES` (262144), `FILE_SCAN_MAX_ATTEMPTS` (5), `FILE_VERSIONS_MAX` (100), `FILES_LIST_MAX` (200), `DELIVERABLES_PER_TASK_MAX` (50), `FILE_DISCOVERY_MAX` (100), and `FILE_EXPIRY_BATCH_MAX` (200) are added.
  - Signals: `files.requests` (op, outcome) and `files.jobs` (kind, outcome) are added; `upload.completed` and `file.scan.duration` are implemented.
  - Non-resource envelopes: `storage_status`, `file_url`, `file_comparison`, `file_trashed`, and `deliverable_list`.
  - Readiness gains `object_storage`: `ok` when the configured store answers, `not_configured` when none is configured, and `fail` when a configured store is unreachable. Without storage or a scanner, upload initiation is `dependency_unavailable` (`storage_not_configured`, `scanner_not_configured`); nothing is ever reported as stored or scanned.
  - Refusals: `file_not_ready` (scan pending, or `missing_object` when the bytes have not arrived, retryable), `file_blocked` (infected or scan failed), `checksum_mismatch` (the session is rejected), `evidence_locked`, `usage_limit_reached` (quota), `conflict` with `upload_expired`; `validation_failed` issues `unsupported_type`, `type_mismatch`, `size_mismatch`, `too_large`, `too_many_files`, `too_many_versions`, `too_many`, `invalid_option`, and `invalid`; `forbidden` with `not_author` for a comment attachment by someone else.
- **Alternatives:** Proxying every download through the API (bandwidth and timeouts; reserved as a later option for sensitive brands). A provider SDK (the SigV4 presigner needs none). Multipart uploads (deferred until `FILE_UPLOAD_MAX_BYTES` needs them).
- **Consequences:** 88 ID prefixes, 139 events, 157 named parameters, 86 telemetry signals.

<a id="pl-34"></a>
### PL-34: Notification contracts (Phase 4B amendment)
- **Decision:**
  - Prefix `ndl` (notification delivery) is added; `ntf` (notification) is implemented.
  - Resources and verbs, all under the workspace and the caller's own unless noted:
    - `me/notifications`: list (tabs, filters, search, grouping, cursor), `counts`, `{id}` read and `PATCH` of state, `browser-pending`; `me/notification-bulk` for several at once.
    - `me/notification-profile` (`GET`, `PUT` with `If-Match`), `me/notification-preferences` (`GET`, `PUT`, `DELETE`).
    - `me/notification-deliveries` (history) and `…/{id}/ack` (the browser reports shown or declined).
    - Administration: `notification-deliveries` (failed and dead-lettered, `health.view`), `…/{id}/retry` (`workspace.configure`), and `brands/{id}` or `projects/{id}` `/notification-defaults`.
  - Events: `notify.notification.created` and `notify.delivery.state_changed`, carrying identifiers, types, channels, states, and classes, never a title, name, address, or body. The fan-out consumes the existing 4A and earlier events.
  - Named bounds (owner 4B): `NOTIFY_FANOUT_RECIPIENTS_MAX` (500), `NOTIFY_DEDUPE_WINDOW_MINUTES` (60), `NOTIFY_DELIVERY_BATCH_MAX` (100), `NOTIFY_DELIVERY_MAX_ATTEMPTS` (6), `NOTIFY_RETRY_BASE_SECONDS` (60), `NOTIFY_RETRY_MAX_SECONDS` (3600), `NOTIFY_DIGEST_ITEMS_MAX` (50), `NOTIFY_EMAIL_PER_HOUR_MAX` (20), `NOTIFY_RETENTION_DAYS` (365), `NOTIFY_PREFERENCES_MAX` (200), `NOTIFY_BROWSER_ACK_TTL_MINUTES` (30), `NOTIFY_SEARCH_QUERY_MAX` (100), `NOTIFY_DISCOVERY_MAX` (100), `NOTIFY_BULK_STATE_MAX` (200), `NOTIFY_DEADLINES_BATCH_MAX` (500), and `NOTIFY_FACTS_MAX_BYTES` (1024).
  - Four signals: `notify.fanout`, `notify.deliveries`, `notify.digests`, and `notify.reads`.
  - Non-resource envelopes: `notification_counts`, `notification_profile`, `notification_preference`, `notification_update`, and `notification_default`.
  - Readiness gains `email_delivery`: `ok` when a mail transport is configured, `not_configured` (never `fail`) when none is, so a missing provider is stated and never presented as delivery.
  - Refusals: `conflict` issues `not_pending` and `not_retryable`; `validation_failed` issues `invalid_option`, `invalid_reference`, `invalid_timezone`, `too_long`, `too_many`, and `required`; `forbidden` for delivery health, retry, and defaults without the permission.
- **Alternatives:** A webhook or SSE feed for notifications (6B decides what leaves the system). Per-channel routes (one preference resource serves every channel).
- **Consequences:** 88 ID prefixes, 136 events, 148 named parameters, 84 telemetry signals.

<a id="pl-33"></a>
### PL-33: Collaboration contracts (Phase 4A amendment)
- **Decision:**
  - Prefixes `cmt` (comment) and `rvw` (review request) are implemented; no new prefix is added.
  - Resources and verbs, all under the workspace:
    - `records/{id}/comments`: list (roots, with inline replies, by cursor) and create; `comments/{id}`: read, `PATCH` with `If-Match`, `DELETE` (a tombstone); `comments/{id}/replies` and `comments/{id}/revisions`; `PUT` and `DELETE` on `comments/{id}/reactions/{key}`.
    - `records/{id}/mention-candidates`: people who can read the record, teams, and readable records.
    - `records/{id}/collaboration`: the caller's follow state, comment count, capabilities, and latest review; `PUT` and `DELETE` on `records/{id}/follow`; `records/{id}/followers`; `me/following`.
    - `records/{id}/reviews`: list and create; `reviews/{id}`: read, with `:decide`, `:withdraw`, and `:refresh`; `me/reviews`.
    - `tasks/{id}:delegate` and `tasks/{id}/assignment-history`.
  - Events: `collab.comment.created` (existing), `collab.comment.edited`, `.deleted`, and `.reaction_changed`; `relations.mention.created` (existing); `relations.follow.added` and `.removed`; `collab.review.requested` and `.decided` (existing, fields extended), `collab.review.withdrawn` and `.superseded`; and `work.task.delegated`. Payloads carry identifiers and flags only; no event carries a comment body, note, or message.
  - Named bounds: `COMMENT_BODY_MAX_CHARS` (10000), `COMMENT_EDIT_WINDOW_MINUTES` (1440), `COMMENT_MENTIONS_MAX` (20), `COMMENTS_PER_RECORD_MAX` (5000), `COMMENT_RATE_PER_MINUTE` (30), `COMMENT_REPLIES_INLINE_MAX` (20), `FOLLOWERS_LIST_MAX` (200), and `REVIEW_REVIEWERS_MAX` (10).
  - Five signals: `collab.comments` (action, outcome), `collab.reactions` (change, outcome), `collab.follows` (change, outcome), `collab.reviews` (action, outcome), and `collab.delegations` (kind, outcome).
  - Non-resource envelope: `collaboration_summary`.
  - Refusals: `conflict` issues `deleted`, `review_open`, `review_closed`, `already_decided`, `subject_changed` (with `conflict.current_version`), `review_replaced`, and `record_archived`; `forbidden` issues `window_closed`, `not_reviewer`, `self_decision`, and `not_assignee`; `validation_failed` issues `not_mentionable`, `not_reviewer`, `self_review`, `not_assignable`, `too_many`, `too_long`, `required`, and `invalid_reference`; `rate_limited` for comment bursts.
- **Alternatives:** Per-host comment routes (`/tasks/{id}/comments`, `/projects/{id}/comments`, and later documents and deliverables) would multiply the same contract; one record-addressed family serves every host. Webhooks for the new events (6B decides what leaves the system).
- **Consequences:** Payloads carry identifiers, kinds, and flags only. 87 ID prefixes, 134 events, 132 named parameters, 80 telemetry signals.
<a id="pl-32"></a>
### PL-32: Capacity contracts (Phase 3E amendment)
- **Decision:**
  - Prefixes `tof` (time off), `hol` (brand holiday), and `rsv` (capacity reservation) are added.
  - Resources and verbs:
    - `me/capacity-profile`: `GET`, and `PUT` with `If-Match`.
    - `me/time-off`: list and create; `PATCH` and `DELETE` with `If-Match`.
    - `brands/{brand}/holidays`: list, create, and delete.
    - `capacity-reservations`: list and set; `DELETE` with `If-Match`.
    - `capacity`: one person's capacity over a range.
    - `capacity/team`: over and under allocation for a brand or the workspace.
    - `me/rescheduling-inputs`.
  - Events (8): `planning.capacity_profile.updated`, `planning.time_off.created`, `.updated`, `.deleted`, `planning.holiday.created`, `.deleted`, `planning.capacity_reservation.set`, and `.removed`. Time-off events carry the kind. No event carries labels or names.
  - Named bounds: `AVAILABILITY_WINDOWS_MAX` (28), `TIME_OFF_ENTRIES_MAX` (500), `BRAND_HOLIDAYS_MAX` (1000), `CAPACITY_RANGE_DAYS_MAX` (93), and `CAPACITY_PEOPLE_MAX` (100).
  - Two signals: `capacity.reads` (view, outcome) and `capacity.changes` (kind, outcome).
  - Non-resource envelopes: `capacity_profile`, `capacity`, `team_capacity`, and `rescheduling_inputs`. Rescheduling inputs carry `proposals: null`, because 7F proposes.
  - The Today `day_plan` gains `available_minutes` and `capacity` (`available`, `planned_minutes`, `over_minutes`, `warning`), or `{available: false, reason: 'no_working_hours'}`. The workload layout gains per-person, per-bucket `{available, over, under}`.
  - Refusals: `conflict` (stale version) and `validation_failed` issues `invalid`, `required`, `too_many`, `too_long`, and `duplicate`.
- **Alternatives:** Capacity on the Today endpoint alone (team and founder views need ranges). Proposals in 3E (7F owns them).
- **Consequences:** Payloads carry identifiers, days, minutes, and flags only. Time-off labels and holiday names appear only to people allowed to see them. 87 ID prefixes, 126 events, 124 named parameters, 75 telemetry signals.

<a id="pl-31"></a>
### PL-31: Today and planning contracts (Phase 3C amendment)
- **Decision:**
  - Prefix `blk` (registered in 0D) is implemented; `bls` (block series) is added. Commitments are addressed by day and task; records by day.
  - Resources and verbs: `today/{day}` (the Today view), `today/{day}/plan`, `today/{day}/items` (commit; `PATCH` to reorder, lock, or move with `If-Match`; `DELETE`), `today/{day}:shutdown`, `daily-records`, `work-blocks` (list, create, `from-estimate`, `PATCH` and `DELETE` with `If-Match`), and `block-series` (create, list, `:end`).
  - Events: `planning.work_block.moved` is implemented; seven are added: `planning.work_block.created`, `planning.work_block.deleted`, `planning.block_series.defined`, `planning.block_series.ended`, `planning.today.committed`, `planning.today.changed`, and `planning.day.closed`.
  - Named bounds: `TODAY_ITEMS_MAX` (100), `TODAY_LIST_MAX` (50), `UPCOMING_DEADLINE_DAYS` (14), `WORK_BLOCKS_PER_DAY_MAX` (50), `WORK_BLOCKS_RANGE_DAYS_MAX` (42), `BLOCK_SERIES_MAX` (50), `BLOCK_SERIES_HORIZON_DAYS` (28), `DAY_CLOSE_DISCOVERY_MAX` (100), and `DAY_CLOSE_BATCH_MAX` (200).
  - Four signals: `planning.today` (action, outcome), `planning.blocks` (action, outcome), `planning.block_series` (outcome), and `planning.day_close` (outcome).
  - Non-resource envelopes: `today_view`, `day_plan`, `daily_records`, and (addressed by day and task, without a public ID) `today_commitment` and `daily_record`; commitment versions travel as the `ETag`.
  - Refusals: `conflict` issues `locked`, `focus_protected`, `already_committed`, `already_closed`, `day_closed`, and `ended`; `validation_failed` issues `past_day`, `future_day`, `too_many`, `too_short`, `too_long`, `too_wide`, `unlock_first`, and `no_estimate`. Block moves report `after_due_date` and `after_deadline` warnings and change nothing else.
- **Alternatives:** Moving due dates as part of a block move (CAL-013 requires an explicit, separate choice).
- **Consequences:** Payloads carry identifiers, days, counts, and flags only, never task titles or block titles. 84 ID prefixes, 118 events, 116 named parameters, 72 telemetry signals.

<a id="pl-30"></a>
### PL-30: Core view layout contracts (Phase 3B amendment)
- **Decision:**
  - **Saved views.** Resources gain `layout` on create and `PATCH`; a layout another entity uses is `validation_failed`. Presentation accepts `board_field`, `date_field`, `calendar_mode`, `zoom`, and `bucket`.
  - **Layout reads.** These take the view's query AST, scope, and `today`:
    - `POST …/tasks:workload` (`bucket`, `from`, `to`; at most `WORKLOAD_DAYS_MAX` days; members only)
    - `…/tasks:dependencies`, `…/tasks:my_time`, `…/projects:milestones`, and `…/projects:progress` (`ids`, at most `LAYOUT_ITEMS_MAX`)
    - `…/tasks:activity` and `…/projects:activity` (`actor`, `actor_type`, `action`; MAC-bound cursor; at most `ACTIVITY_RECORDS_MAX` records)
  - **Non-resource envelopes:** `view_workload`, `view_dependencies`, `view_time`, `view_milestones`, `view_progress`, and `view_activity`.
  - **Identifiers.** Group keys in query collections are public IDs (or status keys), never internal identifiers. This corrects 3A.
  - **Bounds:** `LAYOUT_ITEMS_MAX` (200), `WORKLOAD_DAYS_MAX` (366), and `ACTIVITY_RECORDS_MAX` (500).
  - **Signal:** `views.layout_reads` (layout, outcome).
  - **Changes from layouts** use existing contracts only: transition preview and apply, task and project merge `PATCH`, and reorder. No new mutation endpoint.
- **Alternatives:** One generic `:layout` endpoint (its responses would differ by layout; separate envelopes keep them typed).
- **Consequences:** No new events. 83 ID prefixes, 111 events, 110 named parameters, 69 telemetry signals.

<a id="pl-29"></a>
### PL-29: Time tracking contracts (Phase 3D amendment)
- **Decision:**
  - Prefixes `te` (time entry) and `tsh` (timesheet), registered in 0D, are implemented; segments, lines, approvals, and lock rows have no public ID.
  - Resources and verbs: `time-entries` (list, create, read, `PATCH` and `DELETE` with `If-Match`, and `:pause`, `:resume`, `:stop`), `timer` (start; the live timer as a non-resource view), `timesheets` (submit; the approval queue; read; `:withdraw`, `:decide`, and `:unlock` with `If-Match`; unlock needs `Step-Up`), and `time-export` (a direct CSV or JSON download).
  - Timer actions are idempotent by state as well as by key: pausing a paused timer, resuming a running one, or stopping a stopped one returns the current entry, so an offline action replayed with its key and instant applies once. Client instants are accepted from `TIME_ENTRY_MAX_HOURS` in the past to five minutes ahead.
  - Events: `time.time_entry.recorded` (now with `source`) and `time.timesheet.approved` are implemented. Seven are added: `time.time_entry.updated`, `time.time_entry.deleted`, `time.timer.auto_stopped`, `time.timesheet.submitted`, `time.timesheet.withdrawn`, `time.timesheet.rejected`, and `time.timesheet.unlocked`.
  - Named bounds: `TIME_ENTRY_MAX_HOURS` (24), `TIME_TIMER_MAX_HOURS` (12), `TIME_REPORT_RANGE_DAYS_MAX` (366), `TIME_REPORT_ROWS_MAX` (500), `TIME_EXPORT_ROWS_MAX` (10000), `TIME_TIMESHEET_ENTRIES_MAX` (2000), `TIME_RUNAWAY_DISCOVERY_MAX` (100), and `TIME_RUNAWAY_BATCH_MAX` (200).
  - Five signals: `time.entries` (source, outcome), `time.timers` (action, outcome), `time.timesheets` (action, outcome), `time.exports` (format), and `time.timer_guard` (outcome).
  - Non-resource envelopes: `timer_status`, `timesheet_period`, `time_report`, and `time_summary`.
  - Refusals: `conflict` issues `overlap`, `timer_running`, `timer_live`, `timer_stopped`, `period_submitted`, `period_locked`, `time_locked`, `already_submitted`, `not_pending`, and `stale`; `forbidden` issues `self_approval` and `incomplete_visibility`; `validation_failed` issues `future`, `too_long`, `day_full`, `too_wide`, `too_many`, and `nothing_to_submit`; unlock without step-up is `step_up_required`.
  - Rounding: durations are exact seconds; displays and exports round once, half-up, to hundredths of an hour.
- **Alternatives:** A stored export artifact (needs 4E storage and the 6D platform). A dedicated error code per time refusal (the 0D set is closed; issue codes carry the detail).
- **Consequences:** Payloads carry identifiers, durations, dates, and flags only, never notes or reasons. With 3A's PL-28: 83 ID prefixes, 111 events, 107 named parameters, 68 telemetry signals.

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

<a id="pl-43"></a>
### PL-43: Public API and webhook contracts (Phase 6B amendment)
Renumbered in the Phase 6 integration review: 6B was accepted with a second `pl-42` anchor beside 6A's. The header comment of the applied migration `0046_public_api_webhooks` keeps its original text; this record is authoritative.

- **Decision:** Bearer tokens authenticate `Authorization: Bearer pm_…` on existing `/v1` record routes. Token and webhook management stays on the session. Inbound intake is `POST /v1/hooks/{token}` and answers 202 with an empty body after the message is stored. Outbound signatures are `v1,` HMAC-SHA256 over `id.timestamp.body`. Named bounds added for 6B include `API_TOKENS_PERSONAL_MAX` (25), `API_TOKENS_SERVICE_MAX` (50), `API_READ_RATE_PER_MINUTE` (600), `API_WRITE_RATE_PER_MINUTE` (120), `API_EXPORT_RATE_PER_MINUTE` (20), `WEBHOOK_SUBSCRIPTIONS_MAX` (50), `WEBHOOK_INBOUND_MAX` (20), `WEBHOOK_MAX_ATTEMPTS` (8), `WEBHOOK_CONCURRENCY_PER_DESTINATION` (4), `WEBHOOK_BODY_MAX_BYTES` (262144), `WEBHOOK_DELIVERY_RETENTION_DAYS` (30), `WEBHOOK_EVENT_TYPES_MAX` (20), and `WEBHOOK_SWEEP_BATCH_MAX` (25). `WEBHOOK_TIMESTAMP_TOLERANCE` defaults to 300 seconds, `WEBHOOK_DISABLE_THRESHOLD` to 10, and `WEBHOOK_RESPONSE_TIMEOUT` to 10000 milliseconds.
- **Alternatives:** A second public resource tree that bypasses the session routes. Storing webhook response bodies for debugging.
- **Consequences:** Events `integrations.api_token.created`, `integrations.api_token.rotated`, and `integrations.api_token.revoked`.

<a id="pl-44"></a>
### PL-44: Google Calendar contracts (Phase 6C, completed in the Phase 6 integration review)
- **Decision:**
  - Prefix `cal` (`calendar_source`, a connected calendar) is added. `cev` (`calendar_event`) was already registered.
  - Routes under `/v1/workspaces/{ws}`: `calendar-events` (`GET`, a bounded window of at most 62 days), `calendar-conflicts` (`GET`), `integrations/connections/{conn}/calendars` (`GET`, `PUT`), `work-blocks/{blk}/calendar` (`POST` publish, `DELETE` unlink), and `calendar-events/{cev}/link` (`POST`). Unsafe requests take `Idempotency-Key`. Every response is `private, no-store` and describes only the caller's own calendars.
  - The OAuth redirect lands on `GET /v1/integrations/oauth/google_calendar/callback`. It completes the pending authorization for the session's own connection after matching the state, then redirects to the integrations settings page with an outcome (`connected`, `denied`, `invalid`, `unavailable`, `scope_declined`, `not_found`). It never carries a token or provider text.
  - A connection resource gains `provider_mode` (`live`, `test_double`, or null) so a test double is never presented as live synchronization. Creating or reauthorizing a live OAuth connection returns `authorization_url`.
  - Today gains `meetings` (`available: false` with `reason: not_connected`, or the person's events and busy minutes) and each scheduled block gains `calendar` (the linked event, or null). Capacity conflicts gain `calendar_overlap` for the person themself.
  - Non-resource envelopes: `calendar_events`, `calendar_sources`, `calendar_conflicts`.
  - Refusals: `validation_failed` issues `read_only_calendar`, `insufficient_scope`, `provider_unavailable`, `all_day`, `invalid`; `conflict` issues `already_linked`, `locked`, `focus_protected`, `unavailable`, `too_many`; `not_found` for a connection, calendar, event, or conflict the caller does not own (the same refusal as an unknown identifier).
  - Named bounds (owner 6C): `CALENDAR_SYNC_PAGES_MAX` (20), `CALENDAR_SYNC_PAST_DAYS` (30), `CALENDAR_SYNC_HORIZON_DAYS` (120), `CALENDARS_PER_CONNECTION_MAX` (25), `CALENDAR_OCCURRENCES_MAX` (400), `CALENDAR_EVENTS_LIST_MAX` (500). Provider configuration: `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `GOOGLE_CALENDAR_REDIRECT_URI` (all or none), `GOOGLE_CALENDAR_AUTHORIZE_URL`, `GOOGLE_CALENDAR_TOKEN_URL`, `GOOGLE_CALENDAR_REVOKE_URL`, `GOOGLE_CALENDAR_API_BASE` (https outside local and test), and `GOOGLE_CALENDAR_TIMEOUT_MS` (10000). `GOOGLE_CALENDAR_LOOPBACK_ENABLED` and `WEBHOOK_ALLOW_LOOPBACK` are now registered too.
  - Signals reuse `integrations.requests` (op `calendar_revoke`, `calendar_block_move`) and `integrations.jobs` (kind `calendar_sync`, `calendar_list`). Events reuse `planning.work_block.moved` (actor `integration` on behalf of the owner) and the 6A sync and conflict events.
- **Alternatives:** A separate calendar resource tree outside the connection framework (two authorities). An unbounded events read.
- **Consequences:** 96 ID prefixes and 279 named parameters; no new event types or signals.

<a id="pl-45"></a>
### PL-45: Webhook delivery contract corrections (Phase 6 integration review, corrective review 01)
- **Decision:**
  - **Envelope.** The outbound envelope follows the public `webhook-outbound` schema. `workspace` and optional `brand` are public ids. `data.object` is the public domain object the event is about (`{id, type, version?}`: a task, project, deliverable, comment, review request, or the archived or trashed record). `created_at` is the event's original time on every attempt. The `Webhook-Timestamp` is the send time. A test delivery is `webhook.test` with a synthetic object (`type: "webhook_test"`) and no tenant fields.
  - **Routes.** `POST /v1/workspaces/{ws}/webhook-subscriptions/{id}:pause` and `…:resume` require `If-Match` with the subscription version and an `Idempotency-Key`.
    - Pause is idempotent and takes effect when it commits. It waits for at most one request already in flight, which cannot be recalled. Queued deliveries are recorded as `skipped` (`paused`), and nothing is projected while paused.
    - Resume needs a test delivered after the stop (0D §9.1). It does not replay the backlog.
  - **Replay.** `…/webhook-deliveries/{id}:replay` accepts only `failed` and `disabled_endpoint` deliveries; any other state is a `conflict` with issue `not_replayable`. A command that cannot obtain its lock within one request's time answers `conflict` with issue `in_progress`. Other refusals: `version_conflict`, `test_required`, `suspended`.
  - **History.** Delivery history adds `cycle`, `total_attempts`, `replayable`, `event_created_at`, `replayed_at`, and the state `skipped` with a reason.
- **Alternatives:** Hard delete as the stop control. Replaying the backlog on resume.
- **Consequences:** No new events, actions, parameters, or prefixes. The `webhook-delivery` schema gains `skipped` and the new history fields.


<a id="pl-46"></a>
### PL-46: AI gateway routes, usage meters, telemetry, and parameters (Phase 7A)
- **Decision:**
  - **Routes.** Under `/v1/workspaces/{ws}`:
    - `GET /ai` (`ai_overview`: availability, model and privacy status, usage);
    - `GET` and `PATCH /ai/settings` (`ai_settings`, a non-resource singleton whose version travels in the ETag; If-Match and step-up on change);
    - `PUT` and `DELETE /ai/settings/workspace-key`, which refuse while OD-46 keeps workspace keys off; the key is never returned;
    - `PUT /ai/limits`;
    - `GET` and `PATCH /brands/{id}/ai-profile`;
    - `POST /ai/estimates` (`ai_estimate`, nothing reserved or sent);
    - `POST /ai/test-runs` (202 and an `ai_run` resource on the `op_` operation id; Idempotency-Key required; `confirm_cost` above the workspace threshold);
    - `GET /ai/runs` (`ai_runs`: the caller's own) and `GET /ai/runs/{op}`;
    - `POST /ai/runs/{op}:cancel` and `…:retry`;
    - `POST /ai/runs/{op}/attempts/{n}:reconcile`;
    - `GET /ai/usage` (`ai_usage`).
    Bearer callers need `ai:execute` (`usage:read` for usage) and are refused on settings, keys, limits, reconciliation, and brand-profile changes. A completed run key re-renders through current authority and never dispatches again. AI history exports go through 6D: `GET …/portability/exports/ai_history.csv`.
  - **Meters.** `ai.cost` (`usd_micros`), `ai.input_tokens`, and `ai.output_tokens` are reserved before every chargeable attempt and settled once per attempt with a `cost_basis` (`measured`, `estimated` for a charged reservation bound, `reported` for provider-reported usage entered at reconciliation). A closed period's late usage settles in the current period. `metering.usage.threshold_reached` and `metering.usage.limit_reached` are emitted as registered and notify the people who can change limits (`spend_threshold`).
  - **Errors.** Unconfigured AI is `dependency_unavailable` (issue `ai_unconfigured`). Policy refusals are `forbidden` with a stable issue code (`ai_disabled`, `ai_not_approved`, `ai_key_unavailable`, `ai_not_entitled`, `ai_byok_disabled`, `ai_sensitive_brand`, `ai_cost_unbounded`, `context_unavailable`). A run that could exceed a hard limit is `usage_limit_reached`. An unconfirmed estimate above the threshold is `conflict` with issue `confirmation_required`.
  - **Telemetry.** `ai.runs`, `ai.dispatches`, `ai.policy_refusals`, `ai.reservations`, `ai.cancellations`, `ai.tokens`, `ai.cost_micros`, and `ai.history.erased` are counters with bounded labels; `ai.request.duration` already exists. Readiness adds `ai_provider` (`not_configured` is healthy).
  - **Parameters (owner 7A).** `AI_PROVIDER`, `AI_PROVIDER_BASE_URL`, `AI_PROVIDER_API_KEY`, `AI_PROVIDER_TIMEOUT_MS`, `AI_APPROVED_MODELS`, `AI_BYOK_ENABLED`, `AI_DEFAULT_MONTHLY_ALLOWANCE_MICROS`, `AI_DEFAULT_HARD_LIMIT_MICROS`, `AI_DEFAULT_INPUT_TOKEN_LIMIT`, `AI_DEFAULT_OUTPUT_TOKEN_LIMIT`, `AI_MAX_OUTPUT_TOKENS`, `AI_MAX_ATTEMPTS`, `AI_HISTORY_RETENTION_DAYS`, and `USAGE_WARNING_THRESHOLDS`, which is now basis points of the hard limit.
- **Alternatives:** A second, AI-specific operation resource (the `op_` operation already carries state, cancel, and retry). A streaming response to the browser (7A publishes the settled answer; partial output is stored and labelled).
- **Consequences:** No new events, actions, ID prefixes, or schemas.

<a id="pl-47"></a>
### PL-47: AI stream bounds, attempt evidence, and dispatch suspension (Phase 7A corrective review 01)
- **Decision:**
  - **Parameters (owner 7A).**
    - `AI_OUTPUT_MAX_CHARS` (default 40000, 256–40000): answer text kept per attempt. Text beyond it is clipped locally, and the attempt is labelled truncated and partial, never complete.
    - `AI_STREAM_EVENT_MAX_BYTES` (default 65536, 4096–1048576): the largest single stream event, including one still waiting for its separator.
    - `AI_STREAM_MAX_BYTES` (default 4194304, 65536–33554432, at least the event bound): total stream bytes per attempt.
    - Exceeding either byte bound aborts the stream and closes the reader. The reservation stays held as an unknown outcome.
  - **Errors.** New `forbidden` issue codes: `ai_price_unverified`, `ai_bound_unverified`, and `ai_suspended`.
  - **Settings and runs.**
    - `PATCH /ai/settings` accepts `resume_after_review: true` (step-up, If-Match). The settings view reports `suspended` and, per model, `gates` (price and input-bound verification with source and date, error chargeability, and the monetary-dispatch state) and `price_restrictions`.
    - A run's attempts report `bound_breach`, `clipped_locally`, and `failure_detail`.
    - A run refused at dispatch reports `refusal` (a stable code and a sentence, never content). For example, `configuration_changed` when the price changed after confirmation; nothing was sent, and a retry needs a new confirmation.
  - **Meters.** Each attempt settles and reconciles against its own price and capability snapshot. A breach settles the full measured usage, never clamped.
- **Alternatives:** Unbounded buffering until a separator arrives, which lets one provider response exhaust memory.
- **Consequences:**
  - No new routes, events, actions, ID prefixes, schemas, or telemetry signals.
  - Job error codes for dispatch refusals become `ai_refused.<code>`.

<a id="pl-48"></a>
### PL-48: Context previews, grounded answers, and retrieval parameters (Phase 7B)
- **Decision:**
  - **Routes.** Under `/v1/workspaces/{ws}`:
    - `POST /ai/context-previews` returns `ai_context_manifest`, a new non-resource type: the scope, sources with handles, selection, exclusion reasons, suitability flags, counts, limits, index state, a notice, warnings, and the digest. It sends nothing, reserves nothing, works while AI is off, and is `no-store`.
    - `POST /ai/answer-estimates` returns `ai_estimate` with the manifest.
    - `POST /ai/answers` (202, an `ai_run` on the `op_` operation; Idempotency-Key) requires `manifest_digest` and `confirm_cost` above the threshold.
    Runs, cancellation, retry, history, reconciliation, and export are the 7A routes. A grounded run carries `purpose: grounded_answer`, `content.answer`, `scope`, and its manifest entries.
  - **Bearer access.** The routes inherit the `/ai/` rule: bearer callers need `ai:execute`.
  - **Errors.** New issue codes:
    - `scope_unavailable` and `scope_conflict` (403);
    - `context_unavailable` (403), reused for named sources;
    - `manifest_changed` (409 `conflict`);
    - `context_empty` (422);
    - `ai_project_budget_unenforced` (403).
    A run refused at dispatch for a changed manifest reports `refusal.code: manifest_changed`.
  - **Telemetry.** Two new counters: `ai.context_previews` (label `index`) and `ai.answer_validations` (label `status`). Neither carries content.
  - **Parameters (owner 7B).** `AI_CONTEXT_SOURCES_MAX` (default 8, 1–20) and `AI_CONTEXT_SOURCE_CHARS` (default 1500, 200–6000). Fixed bounds:
    - the listing bound (20 sources);
    - search candidates per preview (20, within the 5A page size);
    - scope brands (5);
    - activity entries (10).
  - **Answer contract (corrective review 01).**
    - `content.answer.status` is `checked` (format and citations checked; generated statements remain unverified), `downgraded`, `rejected`, or `withheld`.
    - `reason` adds `partial_response`. A truncated or partial transport is always `rejected` with `truncated_response` or `partial_response`, and `facts` and `calculations` are kept.
    - Statement kinds are `excerpt` (verbatim source text), `unverified`, `suggestion`, and `unknown`.
    - Each citation carries `excerpt`, the source's own matched text or null.
    - `trust_note` states that only record facts and calculations are established.
    - A withheld run returns no prompt, answer, scope, or sources.
  - **Response format.** `grounded_answer.v1` (recorded in the Phase 7B engineering decision record, docs/engineering/adr/0039): JSON statements of kind fact, suggestion, or unknown, with citations by handle and an optional exact quotation.
- **Alternatives:** A separate retrieval API with its own operation type (the 7A `ai_action` operation already carries budgets, cancellation, and history).
- **Consequences:** No new events, actions, ID prefixes, or schemas. Citation handles are manifest-local, not public identifiers.

<a id="pl-49"></a>
### PL-49: Change proposals, approvals, and Apply (Phase 7D)
- **Decision:**
  - **Routes.** Under `/v1/workspaces/{ws}`, all session only (bearer callers are refused at the edge, whatever their scopes):
    - `POST /ai/proposal-runs` (202, an `ai_run` with `purpose: change_proposal`; Idempotency-Key) takes the same body as `POST /ai/answers`. The run's `content.proposal` reports `proposed` (with the proposal id), `rejected` (with reasons), or `withheld`.
    - `GET /ai/proposals` returns `ai_proposals`, a new non-resource type, with the caller's own proposals.
    - `GET /ai/proposals/{prp}` returns the `change_proposal` resource: state, revision, fingerprint, the trust note, every change with its current authorized before-values, dependencies, warnings, selection, decision, outcome, and history.
    - `PATCH /ai/proposals/{prp}` (Idempotency-Key) edits values, decisions, or the selection, with `revision` as the precondition.
    - `POST /ai/proposals/{prp}:validate` returns `ai_proposal_validation`, a new non-resource type: a dry run of the selected changes through the domain commands, always rolled back.
    - `POST /ai/proposals/{prp}:approve`, `:apply`, and `:reject` (Idempotency-Key). Approve and apply take `revision` and `fingerprint`.
    - `POST /ai/proposals/{prp}:rebase` (Idempotency-Key; corrective review 01) takes `revision` and `reviewed`, a map from each out-of-date change to the target version the person reviewed. It succeeds only when the reviewed versions equal the current versions of exactly the out-of-date targets, and returns the new revision with no approval. The detail view adds `can.rebase`.
  - **Errors.** New issue codes: `proposal_closed`, `revision_changed`, `fingerprint_mismatch`, `proposal_invalid`, `approval_required`, `approval_expired`, `approval_mismatch`, `approval_stale`, `proposal_already_applied`, `proposal_erased`, and for rebase `target_changed`, `target_unavailable`, `nothing_to_rebase` (409 `conflict`); `dependency_not_selected`, `change_rejected`, `nothing_selected`, `unknown_change` (422); `proposal_sources_unavailable` and `ai_proposal_generation_unavailable` (403). Per-change failure codes: `target_unavailable`, `not_permitted`, `target_changed`, `step_up_required`, `dependency_failed`, `not_attempted`, or the domain command's own issue code.
  - **Operation and event.** Apply uses the existing `proposal_apply` operation kind (R1) and the existing `ai.proposal.applied` event (`applied_count`, `failed_count`), which is written only for a successful Apply.
  - **Identifier.** The `prp` prefix names `ai.change_proposal`.
  - **Telemetry.** Two new counters: `ai.proposals` (label `outcome`: proposed, rejected) and `ai.proposal_applications` (label `outcome`: applied, failed). Neither carries content.
  - **Parameters (owner 7D).** `AI_PROPOSAL_APPROVAL_HOURS` (default 24, 1 to 168) and `AI_PROPOSAL_CHANGES_MAX` (default 25, 1 to 100).
  - **Response format.** `change_proposal.v1` (Phase 7D engineering decision record, docs/engineering/adr/0040): JSON `{title, changes}`; each change has an id, an op, handles or `new:` references, fields, dependencies, and sources.
- **Alternatives:** A generic "apply JSON patch" endpoint (no typed adapters, and client JSON would be trusted).
- **Consequences:** No new actions, scopes, or webhook types. Generated record ids are exposed only after a committed Apply.

<a id="pl-50"></a>
### PL-50: The AI action catalog, assist estimates, and assist runs (Phase 7C)
- **Decision:**
  - **Routes.** Under `/v1/workspaces/{ws}`:
    - `GET /ai/actions` returns `ai_actions`, a new non-resource type: every action's id, kind, input, required context, source kinds, item kinds, operations, choices, bound, and limitations.
    - `POST /ai/assist-estimates` returns `ai_estimate` with `action`, `input_digest`, and the manifest.
    - `POST /ai/assist-runs` (202, an `ai_run`; Idempotency-Key) requires `input_digest` equal to the server's recomputation.

    The body has the 7B retrieval fields plus `action`, `instruction`, `brief` (at most 4000 characters), and `answers` (at most 5). A run shows `purpose` (`analysis` or `change_proposal`), `action`, and `content.analysis`, or `content.proposal` with `questions` and `assumptions`.
  - **Bearer access.** The routes inherit the `/ai/` rule (bearer callers need `ai:execute`); drafting actions refuse delegated callers.
  - **Choices (corrective review 01).**
    - `POST /ai/context-previews` (and the action requests) accept `offer_choices`. With it, the manifest lists the context brand's active labels (at most 20) and active members (at most 20) as sources of type `label` or `member`, with handles L…/M…, exclusion reasons, and redacted text.
    - Listing a choice in `exclude` omits it.
    - Drafting actions with choices require the preview to have offered them; otherwise the digests differ (`manifest_changed`).
    - Labels and members cannot be named in `include`.
  - **Errors.** New issue codes:
    - `input_changed` (409 `conflict`);
    - `input_required` and `source_kind_unsupported` (422);
    - in proposals, `unknown_choice`, `duplicate_label`, and `needs_input` outcomes.
  - **Analysis contract.** `analysis.v1`: status `checked`, `downgraded`, `rejected`, `needs_input`, or `withheld`. Items carry `basis` (`generated` or `rule`), `rule`, `reasoning`, `sources`, `excerpt`, and `issues`. The result also has `draft`, `questions`, `assumptions`, `facts`, `calculations`, and `limitations`.
  - **Telemetry.** `ai.analyses` (label `status`).
- **Alternatives:** A route per action, which would be ten surfaces with duplicated gates.
- **Consequences:** No new events, scopes, ID prefixes, or parameters.

<a id="pl-51"></a>
### PL-51: Briefing routes, schedules, notes, and the briefing sweep (Phase 7E)
- **Decision:**
  - **Routes.** Under `/v1/workspaces/{ws}`, session only:
    - `GET /ai/briefings` (`ai_briefings`), `POST /ai/briefings` (201, a `briefing`; Idempotency-Key), `GET /ai/briefings/{brf}`, `POST /ai/briefings/{brf}:regenerate`.
    - `POST /ai/briefing-previews` (`ai_briefing_preview`): the scope, window, baseline, and mode a briefing would use now; nothing is written.
    - `GET /ai/briefing-schedules` (`ai_briefing_schedules`), `POST /ai/briefing-schedules`, `PATCH /ai/briefing-schedules/{bsc}` (If-Match).
    - `POST /ai/briefings/{brf}/corrections`, `GET /ai/briefing-corrections` (`ai_briefing_corrections`), `PATCH /ai/briefing-corrections/{bco}`, `POST /ai/briefing-corrections/{bco}:approve` and `:reject`.
  - **ID prefixes.** `bsc` (briefing_schedule), `brf` (briefing), `bco` (briefing_correction).
  - **Operation and event.** The registered `briefing` operation (R0) and `ai.briefing.generated` event (`kind`, `period_key`) are now emitted. `briefing_ready` notifications carry only `briefing`.
  - **Job.** `ai.briefing.sweep` every minute: payload-free discovery, then per workspace a `FOR UPDATE SKIP LOCKED` claim of due schedules, one briefing per occurrence, and composition one briefing per transaction (at most 3 attempts).
  - **Errors.** New issue codes: `invalid_zone`, `just_published` (409), `not_applicable`, `not_editable`, `decided`, `too_many`.
  - **Telemetry.** `ai.briefings` (label `outcome`).
- **Alternatives:** Briefings as a generic report type, which would lose the recipient, baseline, and occurrence semantics.
- **Consequences:** No new scopes, webhook types, or parameters. The notification type `briefing_ready` already existed; when a schedule opts into email, its email default is immediate.
- **Corrective review 01:**
  - Correction responses carry `availability` (`available` or `withheld`); a withheld note has null text, scope, statement, briefing, and history. Ineligible notes are omitted from `ai_briefing_corrections`; their commands return `not_found`.
  - New failure codes on a briefing: `evidence_unresolved`, `evidence_unverifiable` (corrective review 02: a basis that cannot be kept whole refuses publication).
  - The retention job (`ai.history.retention`) also discovers briefing content through `discover_briefing_retention_work` and interleaves the two lists.

<a id="pl-52"></a>
### PL-52: Plan, interpretation, and voice routes; transcription jobs (Phase 7F)
- **Decision:**
  - **Routes.** Under `/v1/workspaces/{ws}`, session only:
    - `POST /planning/day-plan-previews` (`day_plan_preview`): the rule-based plan for a day; nothing is written. `POST /planning/day-plans` (201, a `change_proposal` of origin `planner`; Idempotency-Key), then the 7D proposal routes.
    - `POST /capture/interpretations` (`capture_interpretation`): the checked candidate of an interpreted capture (the run comes from `POST /ai/assist-runs` with `interpret_capture.v1`).
    - `GET /capture/voice-settings` (`voice_settings`), `POST /capture/voice` (201, a `voice_capture` with a bound upload), `GET /capture/voice/{vcp}`, `POST /capture/voice/{vcp}:transcribe` and `:cancel`. `POST /capture` accepts `interpretation` (a run id) and `voice` (a `vcp_` id) for one item.
  - **ID prefix.** `vcp` (voice_capture). **Operation kind.** `plan_proposal` (R0).
  - **Jobs.** `ai.transcription` (one attempt per transcription operation; a possibly charged outcome is never resent) and `capture.voice.cleanup` every five minutes (payload-free discovery; a bounded batch per workspace).
  - **Errors.** New issue codes: `plan_changed`, `plan_unavailable`, `nothing_to_plan`, `plan_unverifiable`, `overlaps_block`, `overlaps_meeting`, `overlaps_plan`, `past_day`, `too_far`, `interpretation_stale`, `interpretation_pending`, `interpretation_unusable`, `interpretation_erased`, `transcription_unavailable`, `storage_unavailable`, `voice_not_uploaded`, `upload_missing`, `voice_closed`, `voice_not_transcribed`, `voice_already_saved`, `too_many`.
  - **Parameters.** `TRANSCRIPTION_PROVIDER` (`none` or the fixture, refused when deployed), `TRANSCRIPTION_BASE_URL`, `TRANSCRIPTION_API_KEY`, `TRANSCRIPTION_TIMEOUT_MS`, `VOICE_MAX_SECONDS`, `VOICE_MAX_BYTES`, `VOICE_FORMATS`, `VOICE_QUEUE_MAX`, `VOICE_UPLOAD_TTL_SECONDS`, `VOICE_TRANSCRIPT_MAX_CHARS`.
  - **Telemetry.** `planning.plans` (label `outcome`), `capture.voice` (label `outcome`), `capture.interpretations` (label `status`).
- **Alternatives:** A raw audio upload through the API (unbounded request bodies on the web tier).
- **Consequences:** No new scopes or webhook types. The worker registers the two jobs with the AI jobs.
- **Corrective review 01:** new voice failure codes `transcript_too_long` (measured charge settled), `response_too_large` and `malformed_response` (charge unknown, held for reconciliation). Lock order for plan inputs: the person's `planning.constraints` lock, then the capacity profile, day, blocks, brand holidays, the shared workspace dependency lock, and task rows. The transcription response budget is `VOICE_TRANSCRIPT_MAX_CHARS × 4 + 2048` bytes.

<a id="pl-53"></a>
### PL-53: Automation routes, jobs, consumers, effects, and limits (Phase 8A)
- **Decision:**
  - **Routes.** Under `/v1/workspaces/{ws}`: `GET|POST /automations` (`automations`; 201 an `automation`), `GET /automation-templates` (`automation_templates`), `GET /automation-usage` (`automation_usage`), `GET /automation-health` (`automation_health`), `GET|PATCH /automations/{auto}` (If-Match on edits), `GET /automations/{auto}/revisions` (`automation_revisions`), `GET /automations/{auto}/runs` (`automation_runs`), and the commands `POST /automations/{auto}:activate|enable|disable|duplicate|reassign|archive|unarchive|trash|preview|run`. Runs are addressed by their run operation: `GET /automation-runs/{op}` and `POST /automation-runs/{op}:retry|cancel` return `{ run }` in an `automation_run` envelope; a link taken before a retry keeps opening the same run. Unsafe requests carry `Idempotency-Key`; a possibly-sent webhook is reconciled through the P8-W0 operation routes. Run history exports through 6D: `GET …/portability/exports/automation_history.csv` (DATA-013, 8A portion).
  - **Jobs and consumers.** `automation.run` on the `automation` queue (one fenced step per unit, the continuation job of a delay waits as `waiting`/`delay` with a stored wake time, and a skipped run ends `skipped` with `policy_rejected`); `automation.sweep` every minute for date and schedule triggers (payload-free discovery, a bounded batch per workspace). Two outbox consumers: `automation.triggers` admits at most one run per automation and trigger occurrence, and `automation.outcomes` settles slots, usage, streaks, and alerts once per terminal operation.
  - **Attribution and lineage.** Writes made inside a run carry the actor `automation` on behalf of its owner, with the run's operation as causation, from the trusted execution context (never from a payload). Lineage follows `causation_id` to the run that caused an event.
  - **Effects.** Automation webhooks use the registered destination `automation.webhook` (class `unsafe`, contract `automation-webhook.v1`) through the P8-W0 claim, typed proof, and reconciliation path.
  - **Notifications and meters.** `automation_failure` (persistent failures to the owner, once per interval) and the new `automation_notice` (the notify action); usage thresholds raise `metering.usage.threshold_reached` for the meter `automation.runs`.
  - **Parameters.** `AUTOMATIONS_PER_WORKSPACE_MAX`, `AUTOMATION_DEFINITION_BYTES_MAX`, `AUTOMATION_NODES_MAX`, `AUTOMATION_CONDITION_DEPTH_MAX`, `AUTOMATION_CONDITIONS_MAX`, `AUTOMATION_TARGET_FANOUT_MAX`, `AUTOMATION_CHAIN_DEPTH_MAX`, `AUTOMATION_RUN_STEPS_MAX`, `AUTOMATION_ACTIVE_RUNS_MAX`, `AUTOMATION_DELAY_HORIZON_MINUTES`, `AUTOMATION_RETRIES_MAX`, `AUTOMATION_RUNS_PER_MONTH`, `AUTOMATION_TRIGGER_FANOUT_MAX`, `AUTOMATION_SWEEP_BATCH_MAX`, `AUTOMATION_ALERT_FAILURE_THRESHOLD`, `AUTOMATION_ALERT_INTERVAL_MINUTES`: technical limits with finite defaults and hard maximums, separate from 10A plan entitlements.
  - **Telemetry.** `automation.runs` (label `outcome`) only; no titles, bodies, or field values.
- **Alternatives:** A broker or workflow service beside the outbox and job ledger (a second execution engine).
- **Consequences:** No new scopes, webhook types, or ID prefixes (`auto` and the `automation_run` operation kind were reserved by 0D).
- **Corrective review 01:** An automation webhook is acknowledged only by a 2xx; any other answer after dispatch, a reset, or a timeout is `unknown` (`outcome_unknown`), and typed not-sent proof (`precondition_failed`, `refused_before_send`) comes only from refusals before any request. `automation.run` checkpoints hold references only (step and logical effect key); the payload is rebuilt in memory under fresh authorization just before sending. Migration 0063 removes payload copies earlier candidate workers stored in checkpoints. New step codes: `binding_changed`, `run_closed`, `automation_disabled` (a dispatch refused before any request).

<a id="pl-54"></a>
### PL-54: Agent profile, connector, and assignment routes, the connector test job, and limits (Phase 8B)
- **Decision:**
  - **Routes.** Under `/v1/workspaces/{ws}`: `GET|POST /agents` (a list; 201 an `agent_profile`), `GET /agent-templates` (`agent_templates`), `GET /agent-tools` (`agent_tools`: the registered tools with their class, risk, minimum approval, status and owning phase, and the registered models), `GET|PATCH /agents/{agt}` (If-Match on edits), `GET /agents/{agt}/revisions` (`agent_profile_revisions`), and the commands `POST /agents/{agt}:activate|disable|duplicate|reassign|archive|unarchive|trash|restore`. The connector: `POST /agents/{agt}/connector` (configure; a webhook signing secret is returned once), `POST /agents/{agt}/connector:test` (requires `{ "confirm": true }`; 202 `{ test }` in an `agent_connector_test` envelope), `POST /agents/{agt}/connector:disconnect`, and `GET /agents/{agt}/connector-tests/{op}`. Task assignments: `GET|POST /tasks/{tsk}/agents` (`agent_assignments`; 201 `{ assignment }` in an `agent_assignment` envelope), `POST /tasks/{tsk}/agent-preview` (`agent_assignment_preview`), `PATCH /tasks/{tsk}/agents/{agt}` (If-Match), and `POST /tasks/{tsk}/agents/{agt}:withdraw`. `POST /tasks/{tsk}/agents/{agt}:run` is refused with `dependency_unavailable` until 8C. Unsafe requests carry `Idempotency-Key`.
  - **Tokens.** The bearer gate refuses every token on `/agents`, `/agent-templates`, and `/agent-tools` (configuration is session-only); writes under `/tasks/{tsk}/agent*` need `agents:execute`, and the service checks the scope again (also when rendering a replay).
  - **Connector protocol.** `pm-agent/1` (version `1`): API kind `POST {endpoint}/pm-agent/handshake` with `Authorization: Bearer {secret}`; webhook kind `POST {endpoint}` signed and answered with the 6B signature scheme; MCP kind JSON-RPC `initialize` at protocol `2025-11-25` with the manifest in the experimental capabilities. The request carries only the protocol, version, and a nonce; the answer must echo the nonce and name registered tools. Bounded by `AGENT_CONNECTOR_TIMEOUT_MS` and `AGENT_CONNECTOR_RESPONSE_MAX_BYTES` (more is refused, never truncated); redirects are refused.
  - **Jobs and effects.** `agents.connector_test` on the `default` queue: a checkpointed preparation (references only), then one handshake through the registered destination `agents.connector_test` (class `naturally_idempotent`) re-decided immediately before the request; the result binds to the settings version it prepared or ends `stale`.
  - **The 8C contract (published, not issued).** An 8C run will receive a run-bound, narrowing, revocable credential scoped to the assignment's current ceiling, the pinned revision's tools, and one run; it is never a personal token or an OAuth grant, and 8B mints nothing. Dispatch to a connector will reuse the same protocol and destination boundary with a run operation; no assignment is sent automatically.
  - **Parameters.** `AGENT_PROFILES_PER_WORKSPACE_MAX`, `AGENT_INSTRUCTIONS_MAX_CHARS`, `AGENT_SCOPE_GRANTS_MAX`, `AGENT_TOOL_GRANTS_MAX`, `AGENT_CONFIG_BYTES_MAX`, `AGENT_ASSIGNMENTS_PER_TASK_MAX`, `AGENT_CONTEXT_REFS_MAX`, `AGENT_CRITERIA_MAX`, `AGENT_ASSIGNMENT_TEXT_MAX_CHARS`, `AGENT_CONNECTOR_TIMEOUT_MS`, `AGENT_CONNECTOR_RESPONSE_MAX_BYTES`, `AGENT_CONNECTOR_TESTS_PER_HOUR`: technical limits with finite defaults and hard maximums, separate from 10A plan entitlements; `AGENT_CONNECTOR_TRANSPORT` (`none`, `fixture`; the fixture is refused when deployed).
- **Alternatives:** Reusing personal API tokens or MCP consent as agent credentials (a credential that outlives the assignment and is not narrowed to it).
- **Consequences:** One new operation kind, `agent_connector_test` (detail `agents.agent_connector_test`). No new scopes, webhook types, or ID prefixes (`agt` and `agents:execute` were reserved by 0D).
