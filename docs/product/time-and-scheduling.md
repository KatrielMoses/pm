# Time and scheduling semantics

Status: proposed (Phase 0A), awaiting architect review. Terms are defined in the [glossary](glossary.md).

## 1. The date and time fields

| Field | On | Kind | Meaning | Changes when… | Drives |
|---|---|---|---|---|---|
| **Start date** | task, project | calendar date (optional time) | Earliest date work is expected to begin | A person edits it | Timeline/Gantt bars; "not yet startable" |
| **Due date** | task | calendar date, optional time | The **internal target**: the date the owner commits to finish ([OD-01](open-decisions.md#od-01)) | A person edits it, or explicitly chooses "also move due date" when rescheduling | `overdue` |
| **Target date** | project | calendar date | The project's due date (same semantics) | A person edits it | Portfolio deadlines, at-risk |
| **Deadline** | task, project, milestone | calendar date or instant with timezone | An **external or hard commitment**: missing it has consequences beyond the plan (customer, launch, legal) | **Only** through an explicit deadline edit. Never through scheduling, drag, AI plan acceptance, recurrence, or rescheduling (CAL-013) | `past deadline`; upcoming-deadline lists (PLAN-003) |
| **Scheduled start/end** (work block) | work block, belonging to a task | instants | Calendar time reserved to **do** the work. A task may have zero or many blocks. | Drag, resize, calendar sync, plan acceptance | Calendar, capacity, Today |
| **Duration** | work block | length | Length of one block (resize changes it, CAL-004) | Resize | Capacity use |
| **Estimate** | task, project (rolled up) | effort | Total effort expected (TSK-023) | A person edits it | Planned effort, capacity warnings |
| **Remaining estimate** | task | effort | Effort still needed; does not have to equal estimate minus logged time | A person edits it; may be suggested from logged time | Remaining project effort (TIME-006) |
| **Completion date** | task, project | instant | When the record entered a `done`-category status. Projects may record an overridden completion date with audit (PRJ-004, imports). | System, on transition | Cycle time, planned-vs-completed |
| **Reminder** | task | instant or relative | When to notify. It is not a date of the work. | A person edits it | Notifications |
| **Snoozed until** | task, Inbox item, notification | instant | Hide from active personal lists until then. **Does not** change due date or deadline. | Snooze | Personal lists only |

TSK-005 lists both "scheduled time" and "duration". They map to the task's **work blocks**: a task with one block shows that block's time and duration inline.

### Derived conditions

- **Overdue**: the due date has passed, evaluated as defined in §3, and the task is not in `done`/`cancelled`.
- **Past deadline**: the deadline has passed and the task is open. Shown as more severe than overdue.
- **Scheduled after due date / after deadline**: a work block ends after the due date or deadline. This is a warning, not a change.
- **Unscheduled remaining effort**: remaining estimate minus the total duration of future work blocks, when positive.
- **Repeatedly rescheduled** (TSK-044): the count of due-date or work-block moves in a window ([OD-17](open-decisions.md#od-17) sets thresholds).

## 2. Moving work versus changing commitments

| User action | Changes | Never changes (unless the user selects the explicit option) |
|---|---|---|
| Drag a work block on the calendar | Block start/end | Due date, deadline, estimate |
| Resize a work block | Block duration | Estimate (a prompt may offer to update it), due date, deadline |
| Calendar event moved in Google (CAL-012) | Linked block start/end | Due date, deadline |
| Commit item to Today | Creates a Today commitment | Any date on the item (PLAN-008) |
| Remove from Today / carry over at shutdown | Commitment for that day | Any date on the item |
| "Reschedule" (snooze or move) | Due date **or** block, as the dialog states explicitly | Deadline |
| Accept an AI-proposed daily plan (PLAN-013) | Commitments and work blocks listed in the proposal | Due dates and deadlines, unless an individual proposed change says so and the user keeps it selected |
| Bulk "schedule" (TSK-035) | The field named in the bulk dialog | Everything else |
| Edit deadline | Deadline (with audit; notifies followers) | Blocks, due date |

When a block is moved after the due date or deadline, the UI shows the warning and offers **"Also move due date"**. Moving the deadline is offered **only** as a separate, explicit control (CAL-013). Neither box is pre-checked.

## 3. Timezones and stored time

| Concept | Rule |
|---|---|
| Stored instants | Every instant (created/updated/completed, work blocks, deadlines with time, events, audit) is stored as an absolute UTC instant. Instants that a person entered in local time also store the source **IANA timezone**, so recurrences and display intent survive DST (A11Y-013). |
| Date-only fields | Due dates, start dates, and date-only deadlines are stored as **calendar dates without a timezone** ("floating"). |
| Evaluating date-only fields | For **personal** surfaces (Today, My Work, overdue badges, reminders), the **viewer's timezone** decides when the day ends. For **brand-level** surfaces (brand dashboard, brand briefing, brand automations), the **brand timezone** decides. A date-only deadline that must be exact for an external party should be given a time and timezone. |
| User timezone | From the person's profile (A11Y-011); defaults to the workspace timezone. Used for Today, the personal calendar, reminders, quiet hours (NTF-009), digests, and personal briefings (BRF-017). |
| Workspace timezone | Default for new users and brands; used by workspace-level schedules (workspace reports, workspace automations). |
| Brand timezone and working calendar | Each brand may set a timezone, working hours, and holidays (WSB-010). These are used for brand capacity, brand briefings, brand-scheduled automations, and SLA-style calculations. **A brand calendar does not change a person's own working hours.** |
| Display | Times show in the viewer's timezone. A time anchored to another timezone (a brand's 17:00 deadline) shows the viewer's local time plus the source zone where it matters ("22:00 Lisbon · 17:00 New York"). |

## 4. Recurrence

| Concept | Meaning |
|---|---|
| **Recurrence definition (series)** | A rule (frequency, interval, days, end condition) plus a template of field values, anchored to an IANA timezone. It belongs to the recurring task, project, or work block. |
| **Occurrence** | An independent record (task, project, or work block) generated from the series, with its own ID, status, history, and comments. Completing one occurrence never completes the series. |
| **Mode** | *On schedule*: occurrences are generated for fixed dates regardless of completion. *After completion*: the next occurrence is generated relative to when the previous one was completed. |
| **Editing** | Edits apply to *this occurrence* or to *this and future occurrences*. Past occurrences are never rewritten. |
| **Generation** | Idempotent per (series, occurrence date). A retried generation job never creates two occurrences for the same date ([lifecycle §8](lifecycle-and-states.md#8-retries-reruns-and-idempotency)). |
| **DST** | Rules are evaluated in their anchor timezone: "Fridays 16:00 Europe/Lisbon" stays at 16:00 local when the UTC offset changes. |
| **Recurring calendar work** (CAL-005) | Recurring **work blocks** (e.g., "Mon/Wed 09:00–11:00 deep work on Optestra"), which is different from recurring **tasks**. A recurring block can be attached to one ongoing task or to none (a capacity reservation). |
| **Recurring projects** (PRJ-013) | Recommended: a project series that instantiates a project from a template on a schedule ([OD-14](open-decisions.md#od-14)). |

## 5. Availability and capacity

| Concept | Meaning | Scope |
|---|---|---|
| **Working hours** | A person's recurring weekly availability windows in their own timezone (TIME-001) | Personal |
| **Weekly capacity** | The hours a person can work per week, from working hours unless overridden | Personal |
| **Unavailable time** | Time removed from availability: time off, holidays (personal or brand-calendar), busy external calendar events (TIME-010, CAL-010) | Personal (brand holidays affect only brand-capacity calculations unless the person opts in) |
| **Time off** | A typed unavailable period (vacation, sick, personal), optionally all-day | Personal |
| **Focus block** | A work block marked *protected*: plan proposals and auto-scheduling must not move or overlap it (PLAN-014, PLAN-017) | Personal |
| **Buffer / preparation time** | Unassigned time added around blocks or meetings; counts as used capacity (PLAN-015) | Personal |
| **Locked** | Locked tasks or blocks are never moved by AI proposals or capacity-aware rescheduling (PLAN-017) | Personal |
| **Brand capacity reservation** | The hours or share of a person's capacity intended for one brand in a period (TIME-002). It is a **planning target**, not a hard block: overspending it warns but never prevents work. | Brand × person |
| **Shared founder capacity** | One person's total availability across all brands, showing per-brand reservations, scheduled blocks, committed estimates, and conflicts (WSB-017, TIME-008) | Computed, shown to that person and authorized admins |
| **Available working time (today)** | Working hours today, minus unavailable time, minus meetings, minus buffers | Computed |
| **Overcommitment** | Committed or scheduled estimates exceed available time for the period (PLAN-007, TIME-015) | Computed warning |
| **Cross-brand conflict** | Overlapping blocks or events across brands, or a brand reservation that cannot be met because of another brand's commitments (WSB-018, CAL-009) | Computed warning |

Capacity and availability shown to a viewer are computed only from commitments the viewer may read. Time occupied by commitments the viewer cannot read is not shown. Anonymous free/busy disclosure to colleagues requires a separate explicit policy and is off by default ([hierarchy §4](hierarchy-and-scope.md#4-the-all-brands-view)). A person may always see their own authorized connected-calendar availability.

## 6. Today

- A **Today commitment** is a personal record: (person, item, calendar day in the person's timezone, manual order, locked?). Committing never changes the item's dates (PLAN-008).
- **Today shows** (PLAN-001..006): items committed for today, items with a work block today, overdue items (in a separate section), upcoming deadlines (separate), meetings and events, available time versus estimated time.
- **"Scheduled for today"** means committed for today or having a work block today. An item merely *due* today appears under "Due today" until it is committed or scheduled ([OD-18](open-decisions.md#od-18)).
- **Shutdown** (PLAN-018): unfinished commitments are offered **carry to tomorrow**, **pick a day**, **return to backlog**, or **leave**. None of these choices changes the due date or deadline unless the user explicitly selects it.
- **Daily record** (PLAN-019): a snapshot at end of day of what was committed, completed, carried over, and dropped, plus planned versus actual time. Snapshots are not rewritten by later edits.

## 7. Time tracking

- A **time entry** records person, task or project, start/end or duration, billable flag, and note. It belongs to the brand of the work.
- A **timer** is a running time entry. Only one timer per person runs at a time. Stopping it finalizes the entry.
- A **timesheet** is a person's entries for a period. Submission locks editing for that person. Approval is per brand line by authorized approvers. An **approved, locked period** (TIME-013) blocks edits. Corrections require an unlock action by an authorized role ([OD-26](open-decisions.md#od-26)), and that action is audited.
- Planned versus actual: *planned* = estimates (or scheduled block durations, labeled as such); *actual* = time entries. Reports must say which planned measure they use.

## 8. Worked examples (multiple brands, multiple timezones)

Setup: Katriel works in **Europe/Lisbon**, with working hours Mon–Fri 09:00–18:00 local, 40 h/week. The workspace timezone is Europe/Lisbon. Brands:

| Brand | Brand timezone | Brand working hours | Katriel's reservation |
|---|---|---|---|
| MailAccess | America/New_York | 09:00–17:00 | 50% (20 h/week) |
| Optestra | Europe/Lisbon | 09:00–18:00 | 30% (12 h/week) |
| API Access | Asia/Singapore | 09:00–18:00 | 20% (8 h/week) |

UTC offsets on 2026-10-14: Lisbon UTC+1, New York UTC−4, Singapore UTC+8. After 2026-10-25, Lisbon is UTC+0 while New York stays UTC−4 until 2026-11-01.

**Example 1: work block versus due date versus deadline.** The MailAccess task "Ship v2.3 changelog" has due date 2026-10-14 (floating), a deadline of 2026-10-15 17:00 America/New_York (= 21:00 UTC = 22:00 Lisbon), an estimate of 3 h, and a work block on 2026-10-14 from 10:00–12:00 Lisbon (09:00–11:00 UTC).
- Katriel drags the block to 2026-10-15 15:00–17:00 Lisbon. The block moves. The due date stays 2026-10-14, so the task is **overdue** on Katriel's Today from the start of 2026-10-15 Lisbon time. The deadline is unchanged and not yet past. The UI warns "Scheduled after due date" and offers "Also move due date", unchecked.
- If the block had moved to 2026-10-15 23:00 Lisbon, it would end after the deadline (22:00 Lisbon), and the UI would show "Scheduled after deadline". The deadline itself can only be changed in the deadline field.
- A MailAccess teammate in New York sees the deadline as "17:00 (New York)" and the due date as 2026-10-14 in their own day.

**Example 2: committing to Today without changing dates.** On 2026-10-14 Katriel commits the Optestra task "Review flaky-test report" (due 2026-10-20) to Today. Today shows it in "Committed". Its due date stays 2026-10-20, and it does not appear as overdue. At shutdown it is unfinished, and Katriel chooses "carry to tomorrow". A new commitment for 2026-10-15 is created, the 2026-10-14 daily record shows it as "carried over", and the due date is still 2026-10-20.

**Example 3: brand capacity and conflicts.** In the week of 2026-10-12, MailAccess blocks total 26 h against a 20 h reservation. The founder-capacity view shows MailAccess +6 h over its reservation. API Access has 2 h scheduled of 8 h reserved. Total scheduled time is 36 h of 40 h available. The result is a brand-reservation warning (not a hard stop) and no overall overcommitment. A capacity-aware rescheduling suggestion (TIME-016) may propose moving unlocked MailAccess blocks. It must not touch the locked Wednesday focus block or any deadline.

**Example 4: cross-brand overlap.** An API Access sync call on 2026-10-14 at 17:00–17:30 Singapore (= 10:00–10:30 Lisbon) overlaps the MailAccess block at 10:00–12:00 Lisbon. Katriel, who can read both items, sees both with brand markers and receives one cross-brand-conflict warning (CAL-009). A MailAccess-only teammate sees only the MailAccess block; neither the API Access event nor an anonymous busy interval or derived cross-brand warning is disclosed.

**Example 5: recurrence across DST.** The Optestra "Weekly review" recurs every Friday 16:00 Europe/Lisbon. On 2026-10-23 it occurs at 15:00 UTC, and on 2026-10-30 at 16:00 UTC: local time is stable and UTC shifts. The generation job runs twice for 2026-10-30 after a worker restart. The (series, date) key ensures one occurrence.

**Example 6: brand versus personal schedules.** The API Access brand briefing is scheduled for 08:00 brand time (Asia/Singapore) for that brand's team. Katriel's owner briefing is scheduled for 07:30 personal time (Europe/Lisbon) (BRF-017). The 2026-10-26 API Access briefing (08:00 SGT = 00:00 UTC) is generated once. Katriel's owner briefing at 07:30 Lisbon (now UTC+0) is 07:30 UTC that day. The two schedules are independent.

**Example 7: date-only due date across timezones.** An API Access task has due date 2026-10-14 and two assignees: one in Singapore and Katriel in Lisbon. On the Singapore assignee's Today it becomes overdue at 00:00 on 2026-10-15 Singapore time. On Katriel's it becomes overdue at 00:00 on 2026-10-15 Lisbon time, seven hours later. The brand dashboard uses Singapore time. This is intentional: date-only fields are floating. If the commitment is external and exact, the task should carry a deadline with a time.
