# Phase 3 integration review and exit gate (P3-IR1)

Status: **developer review complete; awaiting product-owner acceptance.** This report is not
accepted until the product owner records P3-IR1. Nothing is merged. ADR-0018 to ADR-0022 stay
proposed.

Candidate: the Phase 3E head `3a5688b`, which already contains 3A–3E (migrations 0031–0035; 3B and
3C reconciled in merge `0949051`), plus the narrow integration fixes listed below on
`phase-3-integration-review`.

## Exit gate

| Evidence | Where |
|---|---|
| One founder, from nothing, across 3A–3E at desktop, tablet, and mobile, on real web, API, and worker processes and PostgreSQL. It covers a saved view, every core layout, Today commitments and blocks, a timer and logged time, working hours, time off, reservations, and a cross-brand conflict. Today, Capacity, and workload must report the same numbers. Axe runs at every major state, including forced colours and reduced motion. There is a keyboard-only stretch. Pages reflow at 320, 599/600, and 1023/1024 px and at 200% zoom. No sleeps, retries, skips, or longer timeouts are used. | `e2e/phase3-exit-journey.spec.ts` |
| Cross-surface authorization, isolation, concurrency, and recovery matrix (see below) | `packages/work/test/integration/phase3-matrix.test.ts` |
| Migrations stepped through every accepted boundary 0009–0035, including 0031–0035 after the 3B/3C reconciliation. Each step matches the one-shot catalog, reverses to the prior boundary's exact catalog, and re-applies. | `packages/db/test/integration/migrations.test.ts` |
| Requirement closure per subphase, plus the aggregate Phase 3 exit check. The aggregate check verifies that 3A–3E owned requirements are closed exactly once, that every in-phase hand-off is picked up, and that the out-of-phase deferrals are still recorded. It runs in verify gate 2. | `docs/engineering/phase3/closure-3*.json`, `docs/engineering/tools/phase3e.py` (`check_phase3_exit`) |
| Embedded PostgreSQL now propagates failures, so a failing local integration run exits non-zero (fix `3a5688b`). | `packages/test-infra/src/postgres.ts` (`keepFailureExitCode`) |

The subphase suites still own their deeper journeys: `views`, `core-views`, `today`, `time`, and
`capacity`. The tablet project now runs `capacity`, `core-views`, and `phase3-exit-journey`
explicitly.

## Authorization, isolation, and concurrency matrix

The fixtures:

- **Workspaces:** two.
- **People:**
  - owner and administrator;
  - member, and a brand manager (`manage` grant);
  - limited member and read-only;
  - share-only member and guest;
  - a suspended member and a removed member.
- **Hidden data:** a sensitive brand (owner only), a restricted project, and hidden tasks carrying
  time, plans, reservations, and a holiday.

| Check | Result |
|---|---|
| About 35 Phase 3 reads per person never name a hidden ID or name. The owner positive control confirms the check is meaningful. The reads cover saved-view results, groups, totals, and exports; layouts (workload, timeline, Gantt, milestones, portfolio, activity); Today and blocks; entries, timesheets, approvals, reports, and exports; and capacity, team, reservations, holidays, and conflicts. | pass |
| Share-only members and guests see no capacity, no history, and no brand-wide aggregates (activity excludes share-only access, AZ-22). Guests see only their own time (ADR-0019 T8). | pass |
| Capacity names only readable brands. Others see minutes only, never time-off kinds or labels, and never hidden reservations. | pass |
| Cross-workspace identifiers are `not_found`. Hidden and unknown identifiers return the same error on every Phase 3 route. | pass |
| Concurrency: saved-view edits, board transitions, Today commits and reorders, timers, approvals versus edits and period locks, and reservation sets. Each race has exactly one winner, and the loser gets a typed refusal. | pass |
| Permission revoked between a read and a write is refused at the write. | pass |
| An idempotency-key replay returns the same result, with exactly one audit row and one outbox event. | pass |
| Suspension and removal stop the person's reads and writes. Removal stops a running timer at the moment of removal. A suspended person's timer is stopped once, at the guard's limit. The departure sweep erases plans, time off, profile, and reservations. | pass |

## Integration fixes

1. **Removed members' capacity was readable** by anyone with `capacity.view` (privacy). `subject()`
   now treats any member who is not active or suspended as unknown (`not_found`).
2. **The departure sweep skipped people whose only personal data was plans or capacity.** The eraser
   and the sweep now share one table list, so anyone with blocks, commitments, time off, a profile,
   or reservations is erased.
3. **A removed member's running timer kept accruing time until the guard's limit.** A new
   `running_timer` ownership hook stops it in the removal transaction, using the guard's audited stop
   (reason `departure`).
4. **CAL-003 and CAL-004 were handed from 3B to 3C, and 3C never delivered them.** CAL-004 was not
   even recorded in 3C. Both are now complete. The calendar has **Schedule…**, a keyboard dialog that
   creates a 3C work block. Today has **Shorter** and **Longer**, which resize a block in 15-minute
   steps. No date is mutated. The calendar's stale "when planning arrives (3C)" hint is gone. The
   aggregate check now fails on any such dropped hand-off.
5. **Reservations required a typed member ID.** They now use a Person dropdown of assignable people.
6. **Naming collisions:**
   - The layout options panel shared the name "Layout" with the layout picker. It is now "Layout
     options".
   - The workload's day/week/month picker reused "Group by". It is now "Time buckets".
7. **The header overflowed at 320 px with "All brands" chosen.** The scope switcher now shrinks and
   truncates.
8. **Test drift:**
   - The boundary-test title said "every Phase 1 boundary". It now says 0009–0035.
   - The RLS and workspace-integrity catalogs now classify the 3E tables (3E CI root cause).
   - Embedded PostgreSQL no longer swallows failing exit codes.

## Deferred, explicitly

| Item | Owner | Recorded in |
|---|---|---|
| Rescheduling proposals (TIME-016 stays a foundation; 3E supplies the inputs) | 7F | `closure-3e.json`, ADR-0022 C9 |
| Connected calendars, meetings, holiday feeds | 6C | ADR-0021, ADR-0022 C4/C9 |
| Rollups and baselines | 5C | ADR-0020, ADR-0022 C9 |
| Delivery of capacity warnings | 4B | ADR-0022 C9 |
| AI | 7F | ADR-0022 C9 |

3C's capacity inputs (PLAN-005–007) remain 3C foundations, and 3E records them as contributions.
`check_phase3_exit` enforces both of these hand-offs.

## Product decisions left open

- Today commits from its Overdue and Due today lists only on the real today (OD-18). Committing to a
  future day goes through Upcoming deadlines, a task's Plan panel, or the API.
- Share-only members see others' time on the records shared with them (ADR-0019 T8: time follows the
  work's visibility). Only guests are limited to their own time.
