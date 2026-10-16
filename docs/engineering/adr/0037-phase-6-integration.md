# ADR-0037: Phase 6 integration review and Google Calendar completion

Status: **proposed** (implemented; awaiting one clean current-head no-skip CI run).
Date: 2026-10-17. Brief P6-IR1. Base: accepted 6D head `6b4bb78`, which contains 6E (`5917b9e`), 6C (`d5e5eb1`), 6B (`17ccc67`), and 6A (`9eeee12`).

## Context

6A–6E were built in parallel pairs and accepted one at a time. The integrated tree had one service chain (`McpAccessService` → `PortabilityService` → `CalendarService` → `PublicApiService` → `IntegrationService` → `ReportService` …) but three kinds of drift:

- **Behavior gaps.** 6C closed requirements on a reserved `linked_work_block_id` column, a JSON-free recurrence note, ADR prose, and placeholder text. Google Calendar had only a loopback double: no OAuth client, no provider API, no recurrence, no two-way moves, and no Today or capacity wiring.
- **Identifier drift.** 6A and 6B both took `pl-42`. 6C cited AT-315/AT-316 and AZ-42/ADR-42 without registering them. `closure-6a.json` had no evidence and listed other owners' requirements.
- **Policy drift.** The 0047 and 0050 tenant policies used a raw setting without `WITH CHECK`, unlike every other tenant table.

## Decisions — calendar completion (G)

| # | Topic | Decision |
|---|---|---|
| G1 | Provider boundary | `CalendarProvider` is the only provider surface: authorization URL, code exchange, refresh, revoke, calendar list, event list (sync token, page token), instances, conditional patch (If-Match), and insert. It never sees tenants, principals, or records. `GoogleCalendarProvider` is a plain HTTPS client configured by `GOOGLE_CALENDAR_*`. Without a full client configuration Google Calendar is truthfully unconfigured. Errors carry a kind and status only, never a body or token. |
| G2 | Authorization | OAuth 2.0 authorization code with PKCE (S256) and offline access. The state binds workspace, connection, and a random nonce, is held only in the vault, and is compared in constant time before any exchange. Only the initiating member completes it. A scope declined at the provider narrows `granted_scopes`; nothing widens. The callback route redirects with an outcome only. Disconnect and reauthorization revoke at the provider (best effort) before the local secret is destroyed. |
| G3 | Synchronization | Each selected calendar keeps a compare-and-set checkpoint (`calendar:<cal id>`) holding a sync token or a resumable page cursor. Pages are bounded (`CALENDAR_SYNC_PAGES_MAX`); a run that stops early is `partial` and resumes. A 410 resets to a full listing, and a completed full listing sweeps what the provider no longer has. Access tokens refresh before expiry and once on 401. A refused grant is `needs_reauthorization` and dead-letters (never retried). Outages and rate limits retry with the 6A backoff (honoring Retry-After) and show `degraded`. One delivery is one run whose attempt count grows. Delivery is at-least-once with idempotent upserts, never exactly-once. |
| G4 | Calendars | The provider's calendar list becomes `calendar_source` rows (`cal_`). The primary is selected by default; the owner chooses others, a direction (`read`, or `two_way` for writable calendars with the write scope), and an optional readable brand mapping. Deselecting removes that calendar's mirror at once. |
| G5 | Recurrence | A recurring provider event is a `calendar_series` anchored to its own zone, evaluated with the shared recurrence engine. EXDATE, cancelled instances, and moved instances are `calendar_exception` rows by original occurrence key; detached (moved) occurrences are never regenerated over. All-day spans are whole local days in the calendar's zone. Rules outside the engine subset use the provider's own instance expansion. Nothing is approximated. |
| G6 | Block links (CAL-012/013) | A block is linked by publishing it to a two-way calendar or by linking an existing event. Each link keeps the last agreed block version and provider etag. A provider-only change moves the block through `applyBlockMove`, the same rules as a drag (lock, focus, per-day limit, readable task) under the owner's current authority. A local-only change is pushed with If-Match. A change on both sides, a refused move, or a 412 becomes a visible `schedule` conflict. The echo of our own write matches the agreed etag and moves nothing, so there is no loop. Due dates and deadlines are never written by any of this. |
| G7 | Conflict resolution | Only the owner sees and resolves schedule conflicts: keep my plan (pushes deliberately, two-way only), use the calendar's time (canonical move), or unlink. Resolution reuses the 6A conflict record and route. |
| G8 | Today, calendar, capacity | Today lists the person's own events and busy minutes, and marks linked blocks. The calendar view adds an external-events layer. Busy events are unavailable time and `calendar_overlap` conflicts; brand-mapped events join cross-brand overlaps. All of it is for the person only: no other viewer receives calendar time, counts, or titles (DQ-06, anonymous free/busy off). A block's own calendar copy is never counted twice. |
| G9 | Privacy and retention | Calendars, events, series, and conflicts are personal (`R-PERSONAL`). Disconnect `retain` keeps the mirror readable to its owner as not synchronized and excludes it from busy time; `remove` deletes every row. Purge of a connection deletes the same rows and the vault secret. Event titles are stored as plain text inside workspace RLS: the 0B model's "encrypted at rest" target needs a secret store or KMS that is not approved (DQ-28), and is recorded as a residual risk. |
| G10 | Honest configuration | `provider_mode` is `live`, `test_double`, or null. The loopback double cannot publish to a calendar (nothing real would exist). Automated acceptance runs the real adapter against a deterministic HTTP contract fixture (`startGoogleCalendarFixture`), never against Google, and never presents fixture results as live synchronization. |

## Decisions — integration reconciliation (R)

| # | Topic | Decision |
|---|---|---|
| R1 | One service chain | Calendar, portability, and MCP keep extending the chain. Provider behavior plugs into 6A through protected hooks (`oauthStart`, `oauthExchange`, `afterAuthorized`, `revokeAtProvider`, `syncProviderData`, `resolveFieldConflict`, `recordConflict`, `integrationAuditAs`). It never adds a parallel authority. Planning exposes `applyBlockMove`, `afterBlockMoved`, and `beforeBlockDeleted`; capacity exposes `externalBusy`. |
| R2 | Migrations | 0045–0050 are byte-identical to their accepted heads. Migration 0051 completes the calendar model and moves the 0047 and 0050 policies onto `exec.current_workspace_id()` with `WITH CHECK`. Its down migration restores the exact 0050 catalog, proven by the boundary walk. |
| R3 | Identifiers | Allocated from the integrated tree (table below). Applied migration headers are immutable history; the decision records are authoritative. |
| R4 | Closures | `closure-6a.json` is normalized to the standard schema with evidence and contributions. `closure-6c.json` cites behavior and tests, not reserved fields or prose. `closure-6.json` and `phase6.py` aggregate 6A–6E: each owned requirement is closed once by its owner, deferrals are valid, and every validator passes. |
| R5 | Recorded boundaries | Named vendor import adapters stay incremental under OD-33. AI, agent, and automation history stays with 7A/8A/8B. Commercial audit-export entitlement stays with 10A (production defaults to denied). CAP-006 email capture stays unresolved under OD-29 (owner 2E); 6A only lists `email_inbound` as not configured. |
| R6 | Web | The API tokens page read list and create responses from the wrong envelope level (a crash on load). It now reads `data`, and gains revoke and webhook settings. Placeholder "arrives in 6C" copy is removed only where behavior now exists. |
| R7 | Verification | A cross-boundary matrix spans three workspaces and every role. A browser exit journey runs on desktop, tablet, and mobile against the real API, worker, and adapter, with the provider fixture. Provider-transport failure is a separate, labeled browser test. |

## Identifier reconciliation

| Kind | Identifier | Owner | Note |
|---|---|---|---|
| Migration | 0045–0050 | 6A, 6B, 6C, 6E, 6E, 6D | Unchanged |
| Migration | 0051 | Phase 6 review | `0051_calendar_completion` |
| Engineering ADR | 0032–0036 | 6A, 6B, 6C, 6E, 6D | 0034 corrected in place |
| Engineering ADR | 0037 | Phase 6 review | This record |
| 0B decision | ADR-42 | 6C (completed here) | Claimed by the 0047 header; now written |
| 0C decision | AZ-42 | 6C (completed here) | Claimed by ADR-0034; now written |
| 0D decision | PL-43 | 6B | Renumbered from its duplicate `pl-42`; the 0046 header keeps "PL-42" |
| 0D decision | PL-44 | 6C (completed here) | The 0047 header's "PL-43" is history; PL-43 is 6B's |
| Threats | T-86–T-90 | Phase 6 review | Calendar privacy, write-back, authorization, honesty, cross-surface authority |
| Tests | AT-315, AT-316 | 6C | Registered now |
| Tests | AT-317–AT-327 | Phase 6 review (calendar) | `calendar-live.test.ts` |
| Tests | AT-328, AT-329 | Phase 6 review (browser) | `e2e/phase6-exit-journey.spec.ts` |

6D and 6E recorded their decisions only in their engineering ADRs (0036, 0035) and added no 0B/0C/0D anchors. That stays as recorded.

## Acceptance tests (0C AZ-42)

The calendar tests are listed in ADR-0034.

| Test | Test file | Test title |
|---|---|---|
| AT-328 | e2e/phase6-exit-journey.spec.ts | AT-328 Phase 6 exit journey |
| AT-329 | e2e/phase6-exit-journey.spec.ts | AT-329 provider outage is shown as degraded and recovers |

## Migration and rollback evidence

`0051_calendar_completion` adds `integrations.calendar_source`, `integrations.calendar_series`, and `integrations.calendar_exception` with forced workspace RLS and grants to `app_rw` and `app_worker`. It also adds the event link and occurrence columns, constraints, and indexes, and replaces six tenant policies. The down migration drops exactly these and restores the 0050 policies. `packages/db/test/integration/migrations.test.ts` walks every boundary through 0051 up, down, and up again, comparing objects, RLS flags, constraints, grants, and policies.
