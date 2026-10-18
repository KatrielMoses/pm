# ADR-0042: Daily and weekly briefings and reviews (Phase 7E)

Status: **proposed** (implementation candidate; acceptance evidence pending).

Phase 7E adds recipient-specific briefings on the accepted foundations:
- the canonical domain readers (task signals, reviews, workflow and timesheet approvals, the 3D time report, 3E capacity, 4E deliverable acceptance, 2A project updates);
- the 7A usage ledger, operations, and content lifecycle;
- the 4B notification fan-out, preferences, and delivery jobs.

Briefings are fact-only: every statement is a deterministic record fact, calculation, exact excerpt, unknown, user note, or explicit unavailability, with evidence references. Generated wording is never part of a briefing; it stays a separate, confirmed 7C run over the same scope. 7E adds no voice or capacity-based planning (7F), no agents (Phase 8), and no release execution (Phase 9). Production AI stays disabled; no schedule queues an AI run.

Records: 0B ADR-49, 0C AZ-49, 0D PL-51. Migration `0058_ai_briefings`. Threats T-114 to T-119, tests AT-455 to AT-467.

## Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | One recipient-specific pipeline | Five types (`owner_daily`, `brand_daily`, `weekly_review`, `project_status`, `release_readiness`) share one engine (`packages/work/src/ai/briefing/facts.ts`, `buildStatements`). A briefing separates type, recipient, scope (`workspace`, `brand:…`, `project:…`), template version, window, and baseline. Every figure is read in one transaction as the recipient's compiled principal through the canonical readers bound in the gateway (`#briefingReaders`). Nothing is computed for one person and shown to another; a scope must be readable now. Generating changes no business record. |
| D2 | Sections and evidence semantics | Completed work in the window (marked done is labelled a claim, not acceptance); accepted deliverable versions (4E review evidence, with a later-replaced acceptance labelled not current) separately from done tasks that need acceptance and have none; overdue (dates in the briefing zone), blocked and stale (2D signals over a bounded candidate set, reported as a subset when larger), at-risk projects (latest update health, verified or not); reviews, workflow approvals, and timesheet approvals awaiting the person; deadlines in the next 7 local days; 3E capacity and conflicts (time off as unavailable minutes; guests get an unavailable statement); 3D planned versus actual over the window's local work dates; the person's own AI usage from the 7A ledger (actual, synthetic, reserved, unknown; no real-model bound advertised). |
| D3 | Honest coverage | Lists are bounded (20 items per section, 200 signal candidates, 400 statements); counts cover every authorized item. Coverage records `complete`, `truncated`, `partial`, or `unavailable` per section and is shown. A malformed statement (unknown kind or section, empty or oversized text, control characters, oversized references, a substantive statement without evidence) fails the briefing (`statement_invalid`) rather than publishing it as complete. |
| D4 | Baselines and windows | The window ends at a frozen cutoff and is half-open. With a comparable baseline (same recipient, type, scope, template, last published) it starts exactly at the baseline's end; otherwise it is the previous local day (daily types) or the previous seven local days (weekly), and the first briefing says it has no baseline. Windows longer than 31 local days are clamped and say so. Comparisons (the previous window's count) are recomputed today as the recipient, so a revoked record contributes nothing. Composition takes an advisory lock per recipient, type, and scope. A regeneration copies its original's window, cutoff, and baseline and never advances the baseline. |
| D5 | Display-time authority | Detail, list, and replay re-check every statement's evidence (`#briefingReadable`: readable records, readable brands, the timesheet-approval right). Any loss withholds the whole briefing with no title, count, or type. Briefings belong to their recipient alone. |
| D6 | Schedules and the sweep | A schedule holds an IANA zone, local time, ISO weekdays, channels, enabled, and a revision. `packages/work/src/ai/briefing/schedule.ts` resolves occurrences: a time in a spring-forward gap runs at the first valid instant after it; a time repeated by a fold runs once, at the earlier instant; a late sweep owes only the latest missed occurrence. The occurrence key (`bsc:r<revision>:<local date>T<HH:MM>`) is unique, so overlapping sweeps, restarts, and timeouts after commit cannot duplicate a briefing. `ai.briefing.sweep` claims due schedules with `FOR UPDATE SKIP LOCKED`, queues occurrences, advances schedules, then composes queued briefings one per transaction; a crash leaves the occurrence queued and the next sweep resumes it (at most 3 attempts). A changed or disabled schedule supersedes queued occurrences (operation `cancelled`, `superseded`). A departed recipient's schedule is turned off. |
| D7 | Publication and delivery | Statements, the published state, the succeeded operation, the `ai.briefing.generated` event, and the 4B notification for a scheduled briefing are one transaction. The notice carries only the briefing id; the schedule's channels limit email, and 4B preferences, mutes, quiet hours, dedupe, and limits decide within them. At send time the email line links to the briefing only while it is published, present, and the recipient's; otherwise the delivery is suppressed. Unconfigured email is `suppressed` (`provider_unconfigured`), never delivered. A person who generates a briefing is not notified about it. |
| D8 | Corrections | A note is proposed on one statement (bound to its key and evidence version), edited while proposed (revision), and approved or rejected by its author for their own future briefings of the same type and scope (OD-25 safe default). An approved note is shown as an annotation beside the same statement while its evidence is unchanged and readable; changed evidence marks it stale; rejected, superseded, stale, and erased notes never return. Notes never edit records, never become workspace rules, and are never sent to a model. Text is redacted for credentials, at most 1000 characters, and at most 50 open notes per person. |
| D9 | Privacy and lifecycle | Statement text, figures, references, coverage, and note text are content. Departure and account erasure erase them, mark notes erased, and turn schedules off; configured technical retention erases briefing content and the notes on it that are not approved memory, discovered independently of AI runs (corrective review 01). Rows, operations, audit, and business records stay. Unsaved notes use the personal-draft store (per account, bounded, expiring, removed on sign-out and session change, and dropped when the server reports the briefing withheld, erased, or not found). |
| D10 | One UI | `/workspaces/{ws}/briefings` (list and Generate now with a scope and window preview), `/workspaces/{ws}/briefings/{brf}` (sections, trust kinds, evidence links, coverage notes, delivery state, notes, regenerate), and `/workspaces/{ws}/settings/briefings` (schedules with next runs in the schedule zone, email state, and note review). Notification links open the briefing. |

## Requirement and section matrix

| Requirement | Section or capability | Source reader | Runtime evidence | UI | Boundary |
|---|---|---|---|---|---|
| BRF-001 | `owner_daily` over every readable brand | all readers | AT-455, AT-456, AT-464 | AT-467 | — |
| BRF-002 | `brand_daily` for one readable brand | all readers, brand-filtered | AT-458, AT-459 | list page | — |
| BRF-003 | `weekly_review`, seven local days | all readers | AT-457 | list page | — |
| BRF-004 | `project_status`: verified update excerpt, unverified updates, task counts | 2A updates and verification | AT-460 | list page | — |
| BRF-005 | `release_readiness`: deliverables accepted and not, missing test and release evidence, no certification | 4E deliverables | AT-460 | list page | test and release evidence is 9D |
| BRF-006 | `completed` since the baseline | tasks (`completed_at`) | AT-455, AT-457 | AT-467 | — |
| BRF-007 | `accepted` versus claimed | 4E deliverable versions | AT-455 | AT-467 | — |
| BRF-008 | `attention`: overdue, blocked, stale, at risk | 2D signals, project updates | AT-455 | AT-467 | blocked and stale over at most 200 open tasks |
| BRF-009 | `decisions` awaiting the person | reviews, workflow approvals, timesheets | AT-455 | detail page | — |
| BRF-010 | `agent_runs` foundation | — | AT-455 | detail page | real agent runs are 8C |
| BRF-011 | `deadlines`, `capacity` | tasks, 3E capacity | AT-455, AT-464 | detail page | guests: unavailable |
| BRF-012 | `time`: planned versus actual | 3D time report | AT-455, AT-464 | detail page | local work dates |
| BRF-013 | `ai_cost`: own usage | 7A usage ledger | AT-455, AT-464 | detail page | real-model bounds unverified |
| BRF-014 | evidence on every statement; withheld on loss | all | AT-455, AT-458 | AT-467 | — |
| BRF-015 | propose, edit, approve, reject notes | — | AT-459, AT-466 | AT-467 | — |
| BRF-016 | reuse approved notes; stale on change | — | AT-459 | AT-467 | OD-25 personal default |
| BRF-017 | schedules by person and zone; DST | recurrence arithmetic | AT-461, AT-464, unit tests | AT-467 | — |
| BRF-018 | in-app and email through 4B | 4B fan-out and jobs | AT-461, AT-464 | settings page | email provider unconfigured here |
| PRJ-025 | latest verified project update in project status | 2A verification | AT-460 | — | OD-16 unchanged |
| LA-007 | a founder's source-linked cross-brand daily briefing | — | AT-455, AT-464 | AT-467 | launch gate is 12A |

## Boundaries kept

- **DQ-28, OD-31, OD-41, OD-46, real-model cost bounds, 10A entitlements:** unchanged. No paid or live request, customer data, or secret was used. Briefings never call a provider; generated wording stays a separate 7C run with its own confirmation.
- **PRJ-007:** project AI budgets are still not enforced; nothing here spends.
- **DOC-019:** attachment text is not read.
- **REL-FU-7A-01:** still tracked; nothing new depends on it.
- **OD-25:** notes are personal to their author (safe default); brand-scoped notes remain undecided.
- **OD-16:** a verified update is one with a verification fact; generated or unverified updates are labelled as such.
- **8C, 9D, 7F, 12A:** agent-run review, test and release evidence, planning and voice, and the launch gate are later phases.

## Identifier reconciliation

| Kind | Allocated | Next free before 7E |
|---|---|---|
| Migration | `0058_ai_briefings` | 0058 |
| Engineering ADR | 0042 | 0042 |
| 0B decision | ADR-49 | ADR-49 |
| 0C decision | AZ-49 | AZ-49 |
| 0D decision | PL-51 | PL-51 |
| Threats | T-114 to T-119; T-120 to T-122 (corrective review 01) | T-114 |
| Access tests | AT-455 to AT-467; AT-468 to AT-475 (corrective review 01) | AT-455 |
| ID prefixes | `bsc`, `brf`, `bco` | — |
| Non-resource types | `ai_briefings`, `ai_briefing_preview`, `ai_briefing_schedules`, `ai_briefing_corrections` | — |
| Telemetry | `ai.briefings` | — |

Tests:
- `packages/work/test/integration/briefings.test.ts`: AT-455 to AT-465.
- `packages/work/test/integration/briefings-review01.test.ts`: AT-468 to AT-475 (corrective review 01).
- `apps/api/test/integration/ai-api.test.ts`: AT-466.
- `e2e/briefings.spec.ts`: AT-467 (desktop, tablet, mobile).
- `packages/work/test/unit/briefing-schedule.test.ts`: gap, fold, weekdays, late sweeps, 23- and 25-hour windows.
- `apps/web/test/ai-briefings.test.tsx`: the pages and drafts.
- `packages/db/test/integration/migrations.test.ts`: the 0058 boundary.

## Consequences

- Phase 8C adds agent runs to the `agent_runs` section and 9D adds test and release evidence to `release_readiness`, through the same engine.
- Residual risks:
  - blocked and stale signals cover at most 200 open tasks and say so;
  - an email already handed to a provider cannot be recalled;
  - live-model wording is out of scope, so briefings read as lists of facts.
- Also fixed: the 3C recurring-block test moved a fixture focus block to tomorrow 09:00 UTC, which collided with its fixed-date series when the suite ran on 2026-10-18; the fixture block now sits in the evening.

## Corrective review 01

Review 01 (reviewed head `b0d4d42`) found three defects. All are fixed with runtime regressions. Every regression in `briefings-review01.test.ts` was run against the reviewed head and failed there:
- AT-468 (outside-sample contributor), AT-469 (previous-window-only contributor), AT-470 (aggregate without listed rows), and AT-471 (exact-brand timesheet approval) kept the saved briefing `available` after the loss.
- AT-472 returned the note markers and statement identifiers on the corrections list after revocation.
- AT-473 kept a proposed note on an erased briefing.
- AT-474 found no briefing discovery (the AI-run discovery alone missed the briefing-only and AI-erased workspaces).
- AT-475 found no evidence table or discovery function.

- **R1, only the displayed sample was re-authorized.**
  - Before: `completed.count` and similar figures stored their full total, but only the at most 20 listed items as references; previous-window contributors and aggregates without rows had no basis; a timesheet decision passed if the person could approve in any brand.
  - Now: every statement records its complete basis (`Statement.basis`): every contributing record, including unlisted items and previous-window contributors; capacity and report brands; and `timesheet.approve` on the exact brands whose pending lines made the decision. The basis is stored in `ai.briefing_evidence` in the publishing transaction. One decision, `briefingAvailable` (`packages/work/src/ai/briefing/evidence.ts`), re-checks the whole basis through `readableRecords`, the visibility context's brands, and the canonical brand decision before display, completed-key replay, and notification rendering; any loss withholds the briefing whole. A statement basis above 1000 records is not kept: the figure becomes an explicit `unknown`, never a sample presented as a total, and an open-task total is omitted when its basis is too large. Claimed completion and at-risk projects gained count statements so their coverage totals have a basis too.
  - Notes on calculations are bound to the statement's figures (an order-independent digest), so a changed total makes them stale.
- **R2, correction notes bypassed source revocation.**
  - Before: the list, detail, commands, and completed-key renderers checked only ownership.
  - Now: each note keeps its own copy of its statement's basis plus the briefing scope. `#correctionEligible` decides before anything is returned: the list omits ineligible notes, detail and replay return an opaque withheld shape, edit, approve, and reject refuse as not found, and reuse skips them without marking them stale. A note whose origin briefing content is erased stays eligible only as approved memory. The web page drops the unsaved note on an authoritative refusal and keeps it when offline.
- **R3, configured retention never discovered briefing-only workspaces.**
  - Before: the retention job used `discover_ai_retention_work` alone, which reads `ai.ai_action`.
  - Now: `discover_briefing_retention_work` finds expired briefing content independently (dispatcher only, ids only), and the job interleaves both lists so neither family starves the other. Retention erases notes that are not approved memory with their briefing. With retention unset nothing is erased (OD-36 unchanged).
- **Also restored:** `docs/engineering/database.md`, which a scripted append in the reviewed head truncated to its Phase 7E section; the full document (purge order, every phase's migrations) is back, and the 7E validator now checks it.
