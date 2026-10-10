# ADR-0034: Google Calendar (Phase 6C)

Status: **proposed** (implemented; awaiting one clean current-head no-skip CI run).
Extends ADR-0033 at the top of the work service chain.

## Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Mirror | `integrations.calendar_event` (`cev_`) stores personal busy time mirrored from a connection. Titles stay inside workspace RLS; they are not indexed as document body. |
| D2 | Provider | Google Calendar uses the connection framework. Local and test may enable the in-process double with `GOOGLE_CALENDAR_LOOPBACK_ENABLED=1`. |
| D3 | Sync | Inbound sync upserts events from the provider payload; disconnect with `remove` deletes mirrored rows. |
| D4 | Visibility | Members read only their own mirrored events. Connection health and sync runs reuse 6A envelopes. |
| D5 | Today | Today exposes meetings when calendar events exist for the day window. |
| D6 | Boundaries | Production OAuth client wiring and live Google API calls are out of scope for the loopback double. Two-way block moves use explicit deadline protection when they land. |

## Acceptance tests (0C AZ-42)

| Test | Test file | Test title |
|---|---|---|
| AT-315 | packages/work/test/integration/calendar.test.ts | AT-315 mirrors calendar events after sync |
| AT-316 | packages/work/test/integration/calendar.test.ts | AT-316 removes imported events when disconnecting with remove |

## Migration and rollback evidence

Migration `0047_google_calendar` creates `integrations.calendar_event` and `integrations.connection_mapping` with workspace RLS. Its down migration restores the exact 0046 catalog.
