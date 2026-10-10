# ADR-0022: Capacity and cross-brand conflicts (Phase 3E)

Status: **proposed** (implemented; awaiting one clean current-head no-skip CI run on the stacked draft PR). Engineering detail: [database.md](../database.md#phase-3e-capacity), [tenancy.md](../tenancy.md#phase-3e-capacity), [lifecycle.md](../lifecycle.md#phase-3e-capacity), [observability.md](../observability.md#capacity-3e).
Extends ADR-0021 (3C), ADR-0020 (3B), ADR-0019 (3D), and ADR-0018 (3A). Reuses ADR-0013's zone conversion (2A).

Accepted sources (the Phase 3E brief's decisions, recorded before code):
- 0A: WSB-017, WSB-018, CAL-009, CAL-010, TIME-001, TIME-002, TIME-007–010, TIME-015, and TIME-016 (owned). Contributions: WSB-010, VIEW-007, PLAN-005–007, CAL-008, BRF-011, RPT-010, and LA-013. OD-19 decided (manual brand holidays) and applied. §5 of time-and-scheduling.
- 0B: ADR-30. `planning.capacity_profile`, `planning.availability_rule`, `planning.time_off`, `planning.holiday`, `planning.capacity_reservation`.
- 0C: AZ-30 (`capacity.view` and `capacity.reserve`, for 122 actions). T-48, AT-177 to AT-184.
- 0D: PL-32 (`tof`, `hol`, and `rsv` prefixes, resources and verbs, eight events, five bounds, two signals, four envelopes).
- 0E: the Phase 3E implementation note in 02-information-architecture.

## Decisions

| # | Topic | Decision |
|---|---|---|
| C1 | Working hours | Working hours are local wall-clock windows per weekday in the person's account zone, falling back to the workspace calendar zone. Each date is converted with the same `localToUtc` used by 2A and 3C (`capacity/semantics.ts`). A DST day keeps its real length: an all-day window is 23 or 25 hours, while a 09:00–17:00 window stays 8 hours. Windows on one weekday never overlap (guard trigger), and a person has at most `AVAILABILITY_WINDOWS_MAX` windows. |
| C2 | Weekly capacity | An optional weekly override scales each day's working minutes by override ÷ nominal week. Time off and observed holidays are then subtracted. Without working hours, a person has no availability, never an assumed default. |
| C3 | Time off is personal | Time off (vacation, sick, personal, holiday, unavailable) is either all-day local dates read in its own zone or timed instants. It is `personal.manage_own`. Others with `capacity.view` see only unavailable minutes, never the kind, label, or entries. Someone else's entry is `not_found`. At most `TIME_OFF_ENTRIES_MAX` entries per person. |
| C4 | Holidays (OD-19) | Holidays are manual brand holidays under `brand.configure`, at most `BRAND_HOLIDAYS_MAX` per brand. There are no external holiday feeds or connected calendars (6C). A brand holiday removes a person's day only if the person observes brand holidays and holds a reservation in that brand covering the day. Only brands the viewer can read count. Individual holidays are personal time off of kind `holiday`. |
| C5 | Reservations | A reservation is a weekly planning target for one person in one brand (TIME-002). It warns and never blocks. Setting one needs `capacity.reserve` at the brand: owners and administrators hold it implicitly, and members need a manage grant. A new reservation from a later `effective_from` closes the previous open one the day before. Changes are `If-Match` versioned and serialized by an advisory lock per brand and member. |
| C6 | Computation | Capacity is availability. Use is the larger of scheduled blocks (preparation and buffer included) and open estimates. Open estimates are remaining, else original, for primary-assigned open tasks due in the window, found through the 3A compiled query. Allocation is over, under (planned below 50% of available), or ok. Per brand: reserved (pro-rated by days), scheduled, and estimated. Conflicts are cross-brand block overlaps and `reservation_unmet`. Founder capacity is the person view over every readable brand. A person's own view lists all their blocks, and unreadable ones become unbranded busy time. Others see only blocks on tasks the viewer can read, in brands where the viewer holds `capacity.view`. Unreadable brands are never named. Ranges are at most `CAPACITY_RANGE_DAYS_MAX` days, and team reads at most `CAPACITY_PEOPLE_MAX` people. |
| C7 | Surfaces | Today (3C `dayView`) fills `available_minutes` and `capacity {available, planned_minutes, over_minutes, warning}`. The warning only informs and never blocks (PLAN-005–007, TIME-015). Without working hours, capacity is `{available: false, reason: 'no_working_hours'}`. The 3B workload layout adds per-person, per-bucket `{available, over, under}`. Rescheduling inputs (TIME-016) give per-day free and over minutes, committed items (3C commitments), the locked count, conflicts, and `proposals: null`. |
| C8 | Concurrency and contracts | Profile, time off, and reservations use `If-Match` versions. The profile is serialized by a per-person advisory lock, so concurrent edits produce one conflict. Signals are `capacity.reads` (view, outcome) and `capacity.changes` (kind, outcome). Events are `planning.capacity_profile.updated`, `planning.time_off.created`, `.updated`, and `.deleted`, `planning.holiday.created` and `.deleted`, and `planning.capacity_reservation.set` and `.removed`. Payloads never carry labels or names. |
| C9 | Honest absences | 7F proposes reschedules; 3E makes no proposal and uses no AI. 6C owns connected-calendar events and holiday feeds. 5C owns rollups and baselines, and 4B owns delivery of capacity warnings. No tables or adapters are added for any of them. |

## Recorded deviations and clarifications

- **Brand calendar.** The brand zone (`tenancy.brand.timezone`) and `planning.holiday` serve as the brand calendar (WSB-010). Brand working hours stay with 1C and 6C.
- **Holidays apply through reservations.** A brand holiday affects a person only where that person has a reservation and observes brand holidays. This keeps one brand's holiday from emptying a founder's week in other brands.
- **No capacity cache.** The 0B "capacity caches" read model is not built. Capacity is computed on each read for the viewer, so revocation takes effect at once.
- **Contributions.** VIEW-007 is 3B's workload layout with capacity added. PLAN-005–007 are 3C's Today with available time added. CAL-008 and WSB-010 prepare for 6C. BRF-011 and RPT-010 are inputs for 7E and 5D. LA-013 uses the person view.

## Consequences

Migration `0035_capacity` reverses exactly to 0034. The `capacity` destination shows the week by day and brand, the person's working hours and time off, team allocation, and brand reservations and holidays. Today shows available time, and the workload layout shows availability.
