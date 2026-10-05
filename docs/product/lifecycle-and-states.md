# Lifecycle and state semantics

Status: accepted (Phase 0A, P0-W1; Phase 0 exit gate P0-IR1). See the [glossary](glossary.md) for terms and [hierarchy-and-scope.md](hierarchy-and-scope.md) for cascade rules.

## 1. One vocabulary, several independent axes

Most screens show one "status" chip, but a record's state is several **independent facts**. Mixing them is the main source of wrong reports, such as "done" meaning merged, accepted, or deployed depending on the screen. The product therefore keeps these axes separate:

| Axis | Values | Applies to | Who sets it |
|---|---|---|---|
| **Lifecycle** | `active`, `archived`, `trashed`, `purged` | Every tenant record | People with archive/delete rights; retention jobs (purge only) |
| **Workflow status** | Configurable statuses, each mapped to one **status category** | Projects, tasks (incl. defects), test cases, releases (fixed workflow) | Assignees/owners, automations, integrations, within allowed transitions |
| **Review** | `requested`, `changes_requested`, `approved`/`accepted`, `rejected`, `withdrawn` | Tasks, deliverable versions, documents (as approved source), timesheets, AI change proposals, agent actions needing approval, go/no-go | Authorized human reviewers only |
| **Execution** | `queued`, `running`, `waiting`, `paused`, `succeeded`, `partial`, `failed`, `cancelled`, `skipped` | AI actions, agent runs, automation runs, integration syncs, imports, exports, test runs, webhook deliveries | The system, reporting facts |
| **Derived conditions** | `overdue`, `past deadline`, `blocked`, `at risk`, `stale`, `unassigned`, `needs review` | Computed; never stored as the source of truth | Calculated from other facts with a documented rule |

**Rules:**

1. Lifecycle is orthogonal to workflow. An archived task keeps its workflow status, so "archived" is never a workflow status, and "completed" is never a lifecycle state.
2. *Restored* is an **event**, not a state. A restored record returns to the lifecycle state it had before (normally `active`).
3. *Blocked* is a **derived condition** (an open blocking dependency, or a manual "blocked" flag with a required reason). Custom workflows may also contain a status named "Blocked". Its category is `active`, and the derived condition still applies independently.
4. *Paused* is a status category for projects and tasks ("on hold") and an execution state for runs. The two are unrelated and must not be reported together.

## 2. Status categories

Every workflow status, including custom ones (WFL-002/003), maps to exactly one category. Reports, Today, briefings, and metrics use **categories**, never status names.

| Category | Meaning | Counts as open work? | Counts toward completion % ? |
|---|---|---|---|
| `planned` | Accepted into the plan, not started (backlog, to do) | Yes | Denominator |
| `active` | Work in progress (incl. statuses like "In review", "Blocked") | Yes | Denominator |
| `paused` | Deliberately on hold; not expected to progress | Yes, shown separately | Denominator ([OD-13](open-decisions.md#od-13)) |
| `done` | Work finished according to its workflow | No | Numerator and denominator |
| `cancelled` | Will not be done (won't fix, duplicate, descoped) | No | Excluded from both |

Project status categories map to the portfolio states that FEATURES requires (GOAL-008): planned → *planned*, active → *active*, paused → *paused*, done → *completed*, plus lifecycle *archived*.

### Default task workflow (WFL-001)

| Status | Category | Allowed next (default) | Notes |
|---|---|---|---|
| Backlog | planned | To do, In progress, Cancelled | |
| To do | planned | Backlog, In progress, Blocked, Cancelled | |
| In progress | active | To do, Blocked, Done, Cancelled | |
| Blocked | paused | To do, In progress, Cancelled | A manual state; a `blocks` dependency is shown, never a status change |
| Done | done | Reopen | Only through *complete*: required acceptance and definition-of-done items must be met, or an authorized override records a reason |
| Cancelled | cancelled | Reopen | |

These six statuses are the immutable platform defaults seeded in Phase 2B; 2C adds custom statuses and transitions without a second status table. Reopening returns to the prior non-terminal status when it is still valid, otherwise To do. Completing a parent never completes its descendants, and completing a child never changes its parent's or project's status.

## 3. Completion, review, and acceptance are different facts

| Fact | Definition | Recorded as | Can an agent, automation, or integration set it? |
|---|---|---|---|
| **Claimed complete** | Someone or something *asserted* the work is done: a comment, an agent's final message, a PR description, an external tool marking its own item done | An activity entry with actor type; never a status | Yes (it is only a claim) |
| **Submitted for review** | A review request is open on the task or a deliverable version | Review: `requested` | Agents and automations may submit |
| **Changes requested** | Reviewer returned it with feedback; follow-up tasks may be created (AGT-021) | Review: `changes_requested` | No, human reviewer only |
| **Approved / accepted** | An authorized human reviewer accepted a specific version against the acceptance criteria | Review: `accepted` + reviewer + timestamp + version reference; immutable (FILE-009) | **No.** Agents may never approve their own output (AGT-018). Humans: see [OD-20](open-decisions.md#od-20) |
| **Rejected** | Reviewer refused the deliverable; the work does not satisfy the request | Review: `rejected` | No |
| **Task completed** | The task entered a `done`-category status | Status change + `completed_at` | Only when the workflow allows it **and** every gate passes (below) |
| **Project completed** | An authorized person set a `done`-category project status | Status change + completion date | No automatic completion |

**Completion gates.** A task cannot enter `done` while any of these holds:

- a required completion field is empty (WFL-006, TSK-031);
- the transition requires approval (WFL-007, TSK-029) and no approved review exists for the current version;
- the task is assigned to an agent: agent-assigned tasks always require human acceptance of the returned deliverable (AGT-014, LA-009);
- the task declares an expected deliverable (TSK-022) and the deliverable is not accepted, when the workflow is configured to require acceptance (DEV-014 detects violations elsewhere).

**Reporting rule.** Briefings, dashboards, and AI answers report **accepted deliverables separately from claimed or status-only completion** (BRF-007, PRJ-023, RPT-014). A task in `done` with no acceptance requirement is reported as "completed (no acceptance required)", never as "accepted".

### Project completion versus completion percentage

- **Completion percentage** is a derived progress metric. It is status-based (0% or 100%) until tasks exist; from 2B it is the share of non-cancelled leaf tasks in `done` that the viewer may read, displayed with its method ([OD-13](open-decisions.md#od-13)). It is informational and **never** completes a project.
- **Project completion** is a human decision (setting a `done` project status). It may be gated by the project's definition of done and success criteria checklist (PRJ-005). A project can be completed below 100% (descoped work is cancelled), and a project at 100% is not complete until someone completes it.
- Completing a project with open tasks requires a confirmation listing them ([hierarchy §3.1](hierarchy-and-scope.md#31-lifecycle-effects-on-children)).

## 4. Development and defect states

Each of these is a separate fact, and none implies the next:

```
code merged ─► deployed to environment ─► verified ─► defect resolved ─► (release) go decision ─► deployed version recorded
```

| Fact | Source of truth | Meaning |
|---|---|---|
| PR **merged** | Git provider event (DEV-007) | The code is in a branch. It says nothing about correctness. |
| **Deployed** to environment | Deployment provider event or recorded release (DEV-009) | A version containing the change runs in an environment. |
| Defect **verified** | A passing rerun of the linked test(s) on a version containing the fix, in the defect's environment, **or** a manual verification by an authorized person, as allowed by the configured policy ([OD-21](open-decisions.md#od-21)) | The defect no longer reproduces. |
| Defect **resolved** | Defect enters `done`. It is allowed only after verification when the policy requires it (TEST-017). | |
| Defect **closed without fix** | `cancelled` category with reason: duplicate, cannot reproduce, won't fix | Never counts as verified. |

Merging a linked PR may move a defect to "Fixed – awaiting verification" (category `active`) by automation. It must not move it to `done` (TEST-016, DEV-013).

### Default defect workflow

| Status | Category | Transition rule |
|---|---|---|
| New | planned | Created manually or from a failed test result (TEST-011), with the original evidence copied by reference (TEST-012) |
| Triaged | planned | Severity, reproducibility, affected version, environment, and owner required (TEST-013) |
| In progress | active | |
| Fixed – awaiting verification | active | Entered manually or when a linked PR merges |
| Verified | done | Requires a verification result per policy |
| Reopened | active | Verification failed or the defect recurred; links the failing result |
| Closed – not fixed | cancelled | Reason required |

## 5. Execution states (AI, agents, automations, integrations, tests, imports, webhooks)

### 5.1 Shared execution vocabulary

| State | Terminal? | Meaning |
|---|---|---|
| `queued` | No | Accepted for execution; not started |
| `running` | No | Executing; progress may stream |
| `waiting` | No | Blocked on something external: approval, user input, a rate limit, a delay step, a webhook reply |
| `paused` | No | Deliberately paused by a person or emergency stop; resumable |
| `succeeded` | Yes | Every required step finished as intended |
| `partial` | Yes | Some steps succeeded and at least one required step failed or was skipped. **This is not success.** |
| `failed` | Yes | Did not achieve its outcome. Subtypes: error, timed out, limit exceeded, rejected by policy |
| `cancelled` | Yes | Stopped by a person, an emergency stop, or a superseding run before finishing |
| `skipped` | Yes | Did not execute because its conditions were not met (automations) or it was deduplicated |

**Non-negotiable rule (LA-017, AGT-022, AI-029, REL-006):** `failed`, `cancelled`, `partial`, and timed-out executions must **never** be displayed, counted, notified, summarized, or exported as successful. Badges, aggregate success rates (RPT-013), briefings, and API responses all keep the terminal state. Partial results must list what succeeded, what failed, and which records changed.

Streamed progress, commentary, or a "done!" message from a model or agent is **not** a terminal state (AGT-011). Only the execution engine sets the terminal state, from verified step outcomes.

### 5.2 Agent runs

FEATURES requires the displayed states queued, running, waiting, failed, cancelled, ready-for-review, and accepted (AGT-010). These combine the execution axis with the review axis:

| Displayed state | Execution | Review of returned deliverable | Task effect |
|---|---|---|---|
| Queued | queued | — | none |
| Running | running | — | none |
| Waiting | waiting / paused | — | none; shows what it waits for (approval, input) |
| Failed | failed or partial | — | **Never completes the task** (AGT-022); partial artifacts kept and labeled partial |
| Cancelled | cancelled | — | none |
| Ready for review | succeeded, deliverable returned | requested | Task moves to "In review" at most |
| Changes requested | succeeded | changes_requested | Follow-up run or task; task stays open |
| Accepted | succeeded | accepted (by a human) | Task **may** now be completed; completing is a separate event, possibly automatic by explicit policy |
| Rejected | succeeded | rejected | Task stays open |

"Agent run finished", "deliverable ready for review", and "accepted" are three distinct facts with three timestamps.

### 5.3 Test results

| Result | Meaning | Counts as pass? |
|---|---|---|
| `passed` | Executed; expected result observed | Yes |
| `failed` | Executed; expected result not observed | No |
| `blocked` | Could not execute: a prerequisite failed, the environment was unavailable, or a harness error occurred (reason required) | No |
| `skipped` | Intentionally not executed in this run (excluded by plan or condition) | No |
| `not_run` | Planned for the run but no result was recorded | No |
| `flaky` | Passed only after a retry within the same run, or the result conflicts with recent history for the same version | **No** by default; release policy may allow it with an explicit flag ([OD-21](open-decisions.md#od-21)) |

A test run's summary must show all six counts. A run is "passing" only when every **required** case is `passed`. Missing results are `not_run`, never assumed passed. Equivalent evidence from Optestra or other runners (TEST-028) maps into these same states; unmappable states become `blocked` with the original value preserved.

**Flaky classification** of a test case (TEST-018) is a separate derived label computed over history. It does not change past results.

### 5.4 Releases

| Status | Category | Notes |
|---|---|---|
| Draft | planned | Scope and exclusions being assembled (TEST-022) |
| Preparing | active | Checklist, coverage, blockers tracked |
| Ready for decision | active | Readiness computed (TEST-023); unresolved blockers listed |
| Go approved | active | Immutable decision record: approver, decision, evidence snapshot, timestamp (TEST-025) |
| No-go | active | Immutable decision record; a new decision is required to proceed |
| Deployed | active | Deployed version and environment recorded |
| Verified | done | Post-deploy verification results recorded (TEST-026) |
| Rolled back | done | Rollback recorded with reason; a new release is needed for redeployment |
| Cancelled | cancelled | |

Decisions are immutable. Changing course requires a **new** decision that references the earlier one. The UI must never edit the old one.

### 5.5 AI actions and change proposals

1. **Requested.** Scope and estimated cost are shown; expensive runs require confirmation (AI-034).
2. **Execution:** `running` → `succeeded` | `partial` | `failed` | `cancelled`.
3. **Proposal.** When output includes record changes, they are a **proposal**: typed changes, each individually `pending` → `accepted` | `edited-then-accepted` | `rejected`. AI never edits business records silently (AI-023..025).
4. **Application.** Applying the selected changes is a separate operation with its own outcome: `applied` | `partially applied` (each failed change listed with its reason) | `failed`.

### 5.6 Automation runs and integration syncs

- **Automation run:** `queued` → `running` → (`waiting` for delays) → `succeeded` | `partial` (a step failed and a fallback ran or did not exist) | `failed` | `cancelled` | `skipped` (conditions false, loop guard, or limit). Each step records its own state (AUTO-014).
- **Integration sync operation:** `queued` → `running` → `succeeded` | `partial` (some items failed or conflicted) | `failed`. Conflicts become **conflict records** awaiting resolution (INT-024/025). They are not silently resolved by "last write wins" unless that policy was chosen for the field.
- **Connection health** is separate from sync outcomes: `connected`, `needs reauthorization`, `error`, `disconnected` (INT-005/007).

## 6. Documents

| State | Meaning | AI use |
|---|---|---|
| `draft` | Work in progress; not authoritative | Usable only if explicitly included; labeled draft |
| `current` | The authoritative version | Normal |
| `stale` | Known or suspected out of date (set manually, or flagged when the review date passes — [OD-17](open-decisions.md#od-17)) | Usable with a stale warning (DOC-018) |
| `archived` | Lifecycle archived; read-only | Excluded unless explicitly included |

**Approved source** is a separate verification fact, not a state (DOC-017). An authorized person verifies a **specific version** as an approved AI source. Editing the document creates a new version that is *not* approved until re-verified. AI uses the latest version and warns "approved version differs from current" (DOC-018). A passed review date (DOC-016) produces a "review overdue" warning.

## 7. Deliverables

Deliverable review states follow FILE-007: `draft` → `ready for review` → `changes requested` | `accepted` | `rejected`. Acceptance applies to **one version**. A new version after acceptance starts at `draft` and does not inherit acceptance. Who accepted which version and when is immutable (FILE-009).

## 8. Retries, reruns, and idempotency

| Term | Meaning | Logical outcomes |
|---|---|---|
| **Retry** | Another **attempt** to achieve the *same* logical operation after a failure: a job retry, AI action retry (AI-027), agent run retry (AGT-009), webhook redelivery, or automation step retry (AUTO-015) | **Exactly one** logical outcome. Attempts are recorded under the same operation. |
| **Rerun** | A deliberate **new** execution whose outcome should be recorded separately, such as a test rerun after a fix (TEST-015) or rerunning a briefing | A new operation that links to the earlier one (`rerun of`) |
| **Duplicate request** | The same request delivered twice (double-click, network retry, webhook re-sent by sender) | Collapsed to the first operation by its idempotency key (INT-021) |

Product-level guarantees:

1. A retry must not create a second logical outcome: no second task, comment, external message, charge, calendar event, PR comment, or deliverable (AGT-023, REL-004).
2. Every side effect outside the product uses a stable effect key. Automatic delivery may be retried and is therefore at least once; receivers or providers deduplicate by that key where supported. If an outcome is unknown and the destination cannot deduplicate safely, the operation enters `waiting` for human confirmation rather than repeating it. The product never claims exactly-once external delivery.
3. A retry reuses the original inputs and authorization check **re-evaluated at retry time**. If access was revoked, the retry fails as `failed: rejected by policy`.
4. Usage and cost are metered per attempt, so the person sees real spend, while the logical outcome is counted once in success-rate metrics.
5. The UI shows retries as attempts under one operation, never as separate successes.

## 9. Transition authority summary

| Transition | Human | AI (proposal) | Automation | Integration | Agent |
|---|---|---|---|---|---|
| Workflow status change (non-done) | ✓ | propose only | ✓ (within rules) | ✓ (mapped fields) | ✓ on its own task, within scope |
| Into `done` | ✓ (gates apply) | propose only | only by explicit policy after acceptance | only for mapped fields, gates apply | ✗ |
| Accept / approve / go-no-go | ✓ authorized reviewers | ✗ | ✗ | ✗ | ✗ |
| Archive | ✓ | propose only | ✓ if configured | ✗ | ✗ unless the action class is explicitly allowed (AGT-016 approval) |
| Trash / purge | ✓ / admins | ✗ | ✗ (trash only, if explicitly configured) | removal on disconnect only by user choice (INT-009) | ✗ without approval |

Every transition records the actor type (human, AI, automation, integration, agent, system) and, for non-human actors, the person or policy on whose behalf it acted (AUD-002).
