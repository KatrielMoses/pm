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
### PL-38: Goal and portfolio contracts (Phase 5B amendment)
- **Decision:**
  - Identifier prefixes: `goal` (goal), `kr` (key result), `pf` (portfolio) are records in the core envelope; `gci` (check-in) is a child with its own public identifier. Links and portfolio members have none.
  - Routes under `/v1/workspaces/{ws}`: `goals` (`GET` list with filters and a cursor, `POST` create), `goals/export` (`GET`; CSV or JSON), `goals/{goal}` (`GET`, `PATCH` with `If-Match`; verbs `:archive`, `:unarchive`, `:trash`, `:restore`, `:purge`, `:recalculate`), `goals/{goal}/check-ins` (`GET` history with a cursor, `POST`), `goals/{goal}/key-results` (`POST`), `goals/{goal}/key-results/{kr}` (`PATCH`; verbs `:archive`, `:unarchive`), `goals/{goal}/links` (`POST`, `DELETE`), `goals/{goal}/work` (`GET`; the readable tasks behind the goal's linked-work figures, optionally for one key result; `goal_work`), `projects/{project}/goals` (`GET`), `portfolios` (`GET`, `POST`), `portfolios/{pf}` (`GET`, `PATCH`; verbs `:archive`, `:unarchive`, `:trash`, `:restore`, `:purge`), `portfolios/{pf}/projects` (`PUT`, the explicit member list), `portfolios/{pf}/overview` (`GET`), and `portfolio/overview`, `portfolio/dependencies`, `portfolio/orphans`, `portfolio/export` (`GET`). Unsafe requests take `Idempotency-Key`; edits take `If-Match` (a stale version is `conflict`, a missing one `precondition_required`).
  - Computed reads (overview, dependencies, orphans, and a goal's work drill-down) are non-resource envelopes `portfolio_overview`, `portfolio_dependencies`, `portfolio_orphans`, and `goal_work`, sent `Cache-Control: private, no-store`. Each says what it covers (`coverage`, `scope_note`), when (`as_of`, `computed: live`), and what is missing (`incomplete`, `truncated`, `not_tracked`). Exports are files (`text/csv` or `application/json`) with `Content-Disposition: attachment`, `no-store`, and `nosniff`.
  - Refusals: `conflict` issues `goal_archived`, `portfolio_archived`, `goal_closed` (a closed goal refuses check-ins), `brand_archived`, and `invalid_state` (a goal that left draft cannot return to it); `validation_failed` issues `invalid_reference` (the one answer for an unreadable, unknown, or wrongly placed target), `wrong_scope`, `too_many`, `invalid_option`, `invalid_number`, `invalid_type`, `required`, `too_long`, `conflicting`, `empty`, and `incomplete`; `forbidden` for a caller who may read but not write (and for guests on collections); `not_found` for an unreadable or unknown goal or portfolio; `cursor_invalid`; `precondition_required` for an edit without a version; `rate_limited` for check-in bursts (policy `goal.checkin`).
  - Events (owner 5B, class C1, enums and counts only, no title, note, or identifier of work): `goals.goal.created`, `.updated`, `.status_changed`, `.checkin_recorded`, `.link_changed`, `.update_stale` (for 4B to consume later; no consumer yet), `goals.key_result.created`, `.updated`, `goals.portfolio.created`, `.updated`, and `.members_changed`. Audit actions `goals.exported` and `portfolio.exported` carry counts, with a security event of category export.
  - Named bounds (owner 5B): `GOALS_PER_SCOPE_MAX` (500), `GOAL_KEY_RESULTS_MAX` (20), `GOAL_LINKS_MAX` (200), `GOAL_UPDATE_STALE_DAYS` (14), `GOAL_CHECKIN_RATE_PER_MINUTE` (30), `PORTFOLIOS_MAX` (100), `PORTFOLIO_PROJECTS_MAX` (200), `PORTFOLIO_READ_PROJECTS_MAX` (500), `GOALS_EXPORT_ROWS_MAX` (5000), `GOALS_RECALC_BATCH_MAX` (200), `GOALS_RECALC_LEASE_SECONDS` (300), `GOALS_RECALC_INTERVAL_MINUTES` (360), and `GOALS_RECALC_MAX_ATTEMPTS` (5).
  - Signals: `goals.reads` (view, outcome), `goals.changes` (kind, outcome), and `goals.jobs` (kind, outcome). No label, log field, or event carries goal text.
  - Job: `goals.recalculate`, scheduled every minute, discovers workspaces through `exec_dispatch.discover_goal_work` (workspace identifiers only) and recalculates in each workspace's own transactions.
- **Alternatives:** Storing health and progress and refreshing them by job (one viewer's view served to every viewer). A single `portfolio` resource carrying its computed figures (a cacheable resource would outlive a revocation). An error that names which target was unreadable.
- **Consequences:** 90 ID prefixes, 156 events, 193 named parameters, 95 telemetry signals.
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
