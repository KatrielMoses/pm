# ADR-0034: Google Calendar (Phase 6C)

Status: **proposed** (completed by the Phase 6 integration review, ADR-0037; awaiting one clean current-head no-skip CI run).
Extends ADR-0033 at the top of the work service chain.

## Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Mirror | `integrations.calendar_event` (`cev_`) stores personal busy time mirrored from a connection. Titles stay inside workspace RLS; they are not indexed as document body. |
| D2 | Provider | Google Calendar uses the connection framework. A deployment configures the live Google OAuth 2.0 + Calendar v3 adapter (ADR-0037 G1–G2); without it Google Calendar is reported as not configured. Local and test may enable the in-process double with `GOOGLE_CALENDAR_LOOPBACK_ENABLED=1`; its connections say `test_double`. |
| D3 | Sync | Inbound sync upserts events from the provider with per-calendar incremental checkpoints (ADR-0037 G3); disconnect with `remove` deletes mirrored rows. |
| D4 | Visibility | Members read only their own mirrored events. Connection health and sync runs reuse 6A envelopes. |
| D5 | Today | Today shows the person's own meetings and busy minutes when a calendar is connected, and says so honestly when none is (ADR-0037 G8). |
| D6 | Boundaries | Two-way block moves use explicit deadline protection: a calendar move changes a linked block's time only, never a due date or deadline (ADR-0037 G6). No other calendar provider and no AI scheduling (7F). |

Correction (Phase 6 integration review): the first version of this record said production OAuth wiring, live Google API calls, two-way moves, and Today meetings were out of scope or would follow. Those were open requirements of this subphase, not boundaries. They are implemented now, and D2, D5, and D6 describe the running behavior.

## Acceptance tests (0C AZ-42)

| Test | Test file | Test title |
|---|---|---|
| AT-315 | packages/work/test/integration/calendar.test.ts | AT-315 mirrors calendar events after sync |
| AT-316 | packages/work/test/integration/calendar.test.ts | AT-316 removes imported events when disconnecting with remove |
| AT-317 | packages/work/test/integration/calendar-live.test.ts | AT-317 connects with OAuth, PKCE and a bound state; lists calendars; narrows declined scopes |
| AT-318 | packages/work/test/integration/calendar-live.test.ts | AT-318 selects multiple calendars, maps a brand, and refuses hidden brands and read-only two-way |
| AT-319 | packages/work/test/integration/calendar-live.test.ts | AT-319 pages, keeps incremental checkpoints, and recovers from an invalidated sync token |
| AT-320 | packages/work/test/integration/calendar-live.test.ts | AT-320 refreshes expired access, and a revoked grant needs reauthorization (never retried) |
| AT-321 | packages/work/test/integration/calendar-live.test.ts | AT-321 an outage retries with bounded backoff, shows degraded, and recovers truthfully |
| AT-322 | packages/work/test/integration/calendar-live.test.ts | AT-322 expands recurrence in its anchor zone across DST with EXDATE, moved, cancelled and all-day occurrences |
| AT-323 | packages/work/test/integration/calendar-live.test.ts | AT-323 moves linked blocks both ways without loops or date changes, and makes conflicts visible |
| AT-324 | packages/work/test/integration/calendar-live.test.ts | AT-324 feeds Today, calendar reads and capacity for the owner only (no anonymous free/busy) |
| AT-325 | packages/work/test/integration/calendar-live.test.ts | AT-325 disconnecting while work is queued stops it, revokes at the provider, and applies retention |
| AT-326 | packages/work/test/integration/calendar-live.test.ts | AT-326 reports unconfigured and test-double states honestly |
| AT-327 | packages/work/test/integration/calendar-live.test.ts | AT-327 keeps the Lisbon local time across a DST change over a long horizon |

## Migration and rollback evidence

Migration `0047_google_calendar` creates `integrations.calendar_event` and `integrations.connection_mapping` with workspace RLS. Its down migration restores the exact 0046 catalog. Migration `0051_calendar_completion` (ADR-0037) completes the model without editing 0047 and rolls back to the exact 0050 catalog.
