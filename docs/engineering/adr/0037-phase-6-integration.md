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

## Decisions — webhook delivery boundary (W, corrective review 01)

| # | Topic | Decision |
|---|---|---|
| W1 | Authorized at send | A delivery is authorized when it is sent, as the subscription's accountable owner. The owner must still hold `webhooks.manage` at the subscription's placement (otherwise the subscription is suspended). The owner must still read the governing record through `compileVisibility`, which covers restricted projects, sensitive grants, record shares, membership, and lifecycle, intersected with the subscription's brand. Brand access alone never suffices. A missing, purged, out-of-scope, or unsupported source is `skipped` and recorded with a reason. Source resolution per type is explicit (`webhook-sources.ts`): records, comments by host, reviews by subject, and deliverables. Archive and trash events follow a tombstone contract authorized against the record's placement. Queued facts pass the version 1 allow-list again at send. |
| W2 | One send per transaction | The sweep lists due deliveries, then sends each in its own transaction. That transaction holds the subscription (shared) and then the delivery (for update, skipping locked rows). Subscription counters, automatic disablement, and suspension change in a short transaction after the send commits, so overlapping workers never upgrade the same lock. |
| W3 | Replay | Only dead-lettered deliveries (`failed`, `disabled_endpoint`) are replayable; others get a `not_replayable` conflict. Replay takes the same lock order, so it waits for a send in progress and then re-checks the state. It never clears an active claim. It re-checks the manager, scope, subscription state, and source visibility. It starts a new `cycle` (bounded at 100) and keeps `total_attempts`, the event id, its time, and the last outcome. It is audited without payload. The same mutation key returns the stored answer and never resets twice. |
| W4 | Pause | `…:pause` (If-Match, idempotent) is the owner's stop control. After it commits, nothing is projected and nothing queued starts; queued deliveries become `skipped` (`paused`). The worker holds the subscription while sending, so a pause waits for at most one request in flight, which cannot be recalled. History is kept. Commands that wait on a send raise `lock_timeout` locally to one response timeout plus a margin. |
| W5 | Resume | `…:resume` needs a test delivered after `stopped_at`, for both a pause and an automatic disablement (0D §9.1). It never replays the backlog. Tests are allowed while stopped (not while suspended), and a failed test never counts towards disablement. |
| W6 | Envelope | `workspace` and `brand` are public ids. `data.object` is the public domain object. `created_at` is the event's original time across retries, and the signature timestamp is the send time. Synthetic tests carry no tenant record or fields. Management is decided per subscription placement, so a brand manager can manage and stop their own brand endpoints. |

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
| Tests | AT-330–AT-344 | Phase 6 review (matrix) | `packages/work/test/integration/phase6-matrix.test.ts` |
| Migration | 0052 | Corrective review 01 | `0052_webhook_delivery_controls` |
| 0B / 0C / 0D | ADR-43, AZ-43, PL-45 | Corrective review 01 | Webhook delivery controls, authority, and contract |
| Tests | AT-345–AT-350 | Corrective review 01 (webhooks) | `packages/work/test/integration/webhook-delivery.test.ts` |
| Tests | AT-351–AT-353 | Corrective review 02 (completed-key rendering) | `webhook-delivery.test.ts`, `apps/api/test/integration/integrations-api.test.ts` |

6D and 6E recorded their decisions only in their engineering ADRs (0036, 0035) and added no 0B/0C/0D anchors. That stays as recorded.

## Acceptance tests (0C AZ-42)

The calendar tests are listed in ADR-0034.

| Test | Test file | Test title |
|---|---|---|
| AT-328 | e2e/phase6-exit-journey.spec.ts | AT-328 Phase 6 exit journey |
| AT-329 | e2e/phase6-exit-journey.spec.ts | AT-329 provider outage is shown as degraded and recovers (provider-transport failure, fixture-injected) |
| AT-330 | packages/work/test/integration/phase6-matrix.test.ts | AT-330 connection ownership and provider scopes never widen record permissions |
| AT-331 | packages/work/test/integration/phase6-matrix.test.ts | AT-331 hidden, foreign, and unknown identifiers fail identically on every Phase 6 surface |
| AT-332 | packages/work/test/integration/phase6-matrix.test.ts | AT-332 API-token scopes never widen permissions and are re-checked on every request |
| AT-333 | packages/work/test/integration/phase6-matrix.test.ts | AT-333 MCP consent never widens permissions and revocation stops the next call |
| AT-334 | packages/work/test/integration/phase6-matrix.test.ts | AT-334 API and MCP run the same domain command with provenance, one idempotent effect, and confirmation |
| AT-335 | packages/work/test/integration/phase6-matrix.test.ts | AT-335 departure and revocation stop every token, consent, webhook, connection, and queued sync |
| AT-336 | packages/work/test/integration/phase6-matrix.test.ts | AT-336 webhooks deliver duplicate and out-of-order events once each under overlapping workers, retry, dead-letter, and replay |
| AT-337 | packages/work/test/integration/phase6-matrix.test.ts | AT-337 inbound webhooks refuse bad signatures, stale timestamps, and replayed event ids |
| AT-338 | packages/work/test/integration/phase6-matrix.test.ts | AT-338 exports never reveal Vault or restricted work and neutralize spreadsheet formulas |
| AT-339 | packages/work/test/integration/phase6-matrix.test.ts | AT-339 imports bind to a preview, refuse stale rollback and cross-workspace references, and keep errors private |
| AT-340 | packages/work/test/integration/phase6-matrix.test.ts | AT-340 audit export needs entitlement, fresh verification, and never rides a record export |
| AT-341 | packages/work/test/integration/phase6-matrix.test.ts | AT-341 a member’s calendar never shows to an administrator, and departure ends its authority |
| AT-342 | packages/work/test/integration/phase6-matrix.test.ts | AT-342 lifecycle: archive and restore never resurrect revoked authority; purge removes calendar rows and secrets |
| AT-343 | packages/work/test/integration/phase6-matrix.test.ts | AT-343 one person in two workspaces keeps each workspace’s delegation apart |
| AT-344 | packages/work/test/integration/phase6-matrix.test.ts | AT-344 operational logs and audit never carry a token, client, webhook, or provider secret |
| AT-345 | packages/work/test/integration/webhook-delivery.test.ts | AT-345 re-authorizes at send through the canonical record: a restricted record revoked before send is skipped while brand access remains |
| AT-346 | packages/work/test/integration/webhook-delivery.test.ts | AT-346 matches brand subscriptions exactly and authorizes every workspace-subscription event at send |
| AT-347 | packages/work/test/integration/webhook-delivery.test.ts | AT-347 follows record, brand, and subscription lifecycle, with an explicit tombstone contract |
| AT-348 | packages/work/test/integration/webhook-delivery.test.ts | AT-348 sends the public envelope built at send, with a verifiable signature and no internal identifiers |
| AT-349 | packages/work/test/integration/webhook-delivery.test.ts | AT-349 replays only dead-lettered deliveries, once, serialized with the worker, and audited |
| AT-350 | packages/work/test/integration/webhook-delivery.test.ts | AT-350 pauses at once without recalling a send in flight, keeps history, and resumes only after a delivered test |
| AT-351 | packages/work/test/integration/webhook-delivery.test.ts | AT-351 re-renders completed Retry, Pause, and Resume keys through current authority only |
| AT-352 | packages/work/test/integration/webhook-delivery.test.ts | AT-352 re-renders completed create, rotate, test-send, and inbound keys through current authority only |
| AT-353 | apps/api/test/integration/integrations-api.test.ts | AT-353 refuses an HTTP idempotent replay of a completed pause once the caller loses the brand or its management |

## Migration and rollback evidence

`0052_webhook_delivery_controls` adds the `paused` subscription state with its pauser and stop time, the delivery source and object, the original event time, the replay cycle and lifetime attempts, the replayer, and the `skipped` state. It backfills queued deliveries so they authorize again at send. The down migration restores the exact 0051 catalog, and the boundary walk covers 0051 and 0052.

`0051_calendar_completion` adds `integrations.calendar_source`, `integrations.calendar_series`, and `integrations.calendar_exception` with forced workspace RLS and grants to `app_rw` and `app_worker`. It also adds the event link and occurrence columns, constraints, and indexes, and replaces six tenant policies. The down migration drops exactly these and restores the 0050 policies. `packages/db/test/integration/migrations.test.ts` walks every boundary through 0051 up, down, and up again, comparing objects, RLS flags, constraints, grants, and policies.
