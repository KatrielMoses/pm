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
