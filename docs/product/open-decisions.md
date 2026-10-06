# Open product decisions register

Status: register accepted with Phase 0A (P0-W1). Each entry stays open until it is marked decided. Open entries need a product-owner decision, and entries marked **legal** or **commercial** also need that review. A **safe default** is what engineering may build *for now*: it keeps the decision reversible and makes no customer-facing promise. No default here may be published as a commitment until approved.

Requirements flagged with each decision are listed automatically in [requirements/summary.md](requirements/summary.md#open-decisions-referenced-by-requirements). When a decision is approved, the solutions architect records it in `ROADMAP_CHECKLIST.md` → *Decisions and scope changes*, and this entry is marked **Decided (date)**.

| Group | Decisions | Blocking before |
|---|---|---|
| A. Product semantics | OD-01 – OD-26 | 0B/0C for OD-01–07; owning phase for the rest |
| B. Launch scope boundaries | OD-27 – OD-33 | The owning phase's brief |
| C. Retention, deletion, privacy, legal | OD-34 – OD-43 | 1F (behavior); publication before paid launch |
| D. Commercial | OD-44 – OD-46 | 10A (behavior can be built entitlement-driven earlier) |

---

## A. Product semantics

<a id="od-01"></a>
### OD-01 — Due date versus deadline
- **Decided (2026-10-05, architect, Phase 2B brief):** *Start date* is the planned earliest start. *Due date* is the internal desired completion date and may change during planning. *Deadline* is an external or hard commitment, stored as a date or as an instant with its time zone, and never changed implicitly: completing, moving, or recurring never rewrites it. *Scheduled time* is a separate planning work block (3C); tasks store no schedule fields. *Duration* in TSK-005 means the task estimate (`estimate_minutes`); work-block duration belongs to 3C.
- **Why it matters:** FEATURES uses both terms (TSK-005, PLAN-003, CAL-013). Without a distinction, "prevent deadline changes when moving work" is either meaningless or blocks every reschedule.
- **Affects:** TSK-005, PLAN-002, PLAN-003, CAL-013, RPT-003 · phases 2B, 3C, 5C, 6C.
- **Safe default:** As in [time-and-scheduling.md §1](time-and-scheduling.md#1-the-date-and-time-fields). Both fields are optional, and most tasks will only have a due date.
- **If deferred:** No longer applicable (decided).

<a id="od-02"></a>
### OD-02 — Is a project required for every task?
- **Decided (2026-10-05, architect, Phase 2B brief):** Every task has exactly one workspace and one brand; the project is optional and, when present, in the same workspace and brand. A task may move between same-brand projects or become projectless. A cross-brand move is an explicit command, allowed only for a projectless task or together with a valid destination project in the target brand. It requires manage authority in both brands, an exposure preview, confirmation, and atomic revalidation.
- **Why it matters:** It determines whether projectless tasks exist, where triaged Inbox items land, and whether a task can be restored without its project.
- **Affects:** TSK-002, TSK-003, CAP-012 · phases 0B, 2B, 2E.
- **Safe default:** Brand mandatory, project optional ([hierarchy §2](hierarchy-and-scope.md#2-scope-of-every-major-record)).
- **If deferred:** No longer applicable (decided).

<a id="od-03"></a>
### OD-03 — Unbranded Inbox items
- **Decision (approved for architecture):** Inbox items may exist without a brand until triage, despite WSB-007's brand separation. They are personal records visible only to their owner; triage into operational work requires a brand.
- **Why it matters:** CAP-011 requires capture "without requiring configuration". Forcing a brand at capture adds friction, and allowing none creates a personal, brandless record type.
- **Affects:** CAP-011, CAP-012, WSB-007 · phases 0B, 0C, 2E.
- **Safe default:** Inbox items are personal records with an optional brand, visible only to their owner. Triage requires a brand.
- **If deferred:** The capture flows in 2E either block on brand selection or need rework later.

<a id="od-04"></a>
### OD-04 — Cross-brand sharing model
- **Decided (2026-10-04, architect, Phase 1 integration review):** WSB-008 is owned by **2A**. 1D remains the generic exact-record-grant foundation, and 2A delivers the first user-facing sharing, for projects.
  - **Shareable types:** Record types are **non-shareable by default**. Every record-owning phase must register whether its type is shareable and which levels it supports. Projects, tasks, documents, files, goals, and saved views are candidates, but each is shareable only once its phase registers it.
  - **Levels:** Shares grant only `view`, `comment`, or `edit` (read-only by default). A share is further capped by what the target module implements and by what the sharer may grant. Guests are capped at `edit`.
  - **No onward sharing:** Access received through a share never permits sharing onward, moving, deletion, or configuration.
  - **Exactly the selected records:** A share covers only explicitly selected records, with one grant per selected record. It never covers descendants, related records, future children, or inferred content. A child is shared only when it is itself selected.
  - **Expiry and revocation:** Shares may expire and are revocable.
- **Why it matters:** WSB-008 requires sharing and WSB-009 requires preventing exposure. No implementation sub-phase named sharing (a roadmap gap). 1C was the provisional owner until this decision.
- **Affects:** WSB-008, WSB-009, PERM-012, PRJ-028, COL-002 · phases 0B, 0C, 1D, 2A, and every later record-owning phase.
- **Contract:** [hierarchy §5.2](hierarchy-and-scope.md#52-explicit-sharing), plus the decision above.
- **If deferred:** No longer applicable (decided).

<a id="od-05"></a>
### OD-05 — Cross-brand relationships
- **Decision (approved for architecture):** Associations may cross brands only when the creator can read both ends; containment never crosses brands. For a viewer who cannot read the other end, the relationship, its type, its count, and any derived condition caused solely by it are omitted. The responsible owner is notified and may add a permission-safe manual status or reason.
- **Why it matters:** Founders' brands depend on each other (shared SDKs, shared launches). Showing the other end risks existence disclosure, and hiding it leaves "blocked" unexplained.
- **Affects:** TSK-012, TSK-013, TSK-014, GOAL-010, PRJ-011 · phases 0B, 0C, 2A, 2B.
- **Approved contract:** Apply the decision above. In-text author-created mentions may still render as a neutral "Restricted item" token because the surrounding authored text already discloses that a reference exists; system-generated relationship metadata may not.
- **If deferred:** Allow only same-brand links initially. This is cheap to relax later and expensive to tighten.

<a id="od-06"></a>
### OD-06 — Workspace-scoped records
- **Decision (approved for architecture):** Documents, files, goals, templates, automations, and integration connections may belong to the workspace with no brand as a distinct scope. Workspace-level read grants control access; guests receive no implicit workspace-level access.
- **Why it matters:** WSB-007 says these are "separated by brand", while other requirements allow workspace-level ones. The answer decides who can see workspace-level documents.
- **Affects:** WSB-007, DOC-003, FILE-001, GOAL-001, INT-004 · phases 0B, 0C, 4C, 4E, 5B, 6A.
- **Safe default:** Workspace-scoped records are readable by members holding workspace-level read grants, never by guests unless shared, and carry a "Workspace" marker.
- **If deferred:** 0B must still model an optional brand on these records, and authorization rules for them stay undefined.

<a id="od-07"></a>
### OD-07 — Restricted brands in aggregated views
- **Decision (approved for architecture):** Aggregate views disclose nothing about brands the viewer cannot access. Counts, totals, facets, pagination, capacity, and summaries are calculated from authorized records only and labeled as covering visible scope where clarification is needed.
- **Why it matters:** Disclosure of a confidential brand's existence is itself a leak.
- **Affects:** WSB-016, PERM-006, RPT-001 · phases 0C, 1C, 5D.
- **Safe default:** No disclosure. Aggregates cover visible brands only and are labeled as such.
- **If deferred:** The safe default applies, and nothing needs rework if it is later relaxed.

<a id="od-08"></a>
### OD-08 — Subtask nesting depth
- **Decided (2026-10-05, architect, Phase 2B brief):** Subtasks form a same-workspace, same-brand tree whose parent and child share project identity (both may be projectless). The application bound is `TASK_DEPTH_MAX` = 20 (root = 0) with a database corruption ceiling of 64. Reparenting is lock-ordered, cycle-safe, and rewrites ancestry atomically. "Unlimited nesting safeguards" is met by this generous explicit bound, not literal infinity.
- **Why it matters:** Depth affects query cost, UI layout on mobile, rollups, and import/export.
- **Affects:** TSK-010, DATA-001, VIEW-001 · phases 0B, 2B, 3B.
- **Safe default:** A system cap (recommended 10 levels, configurable lower per workspace), cycle prevention, and depth checks on move and import.
- **If deferred:** No longer applicable (decided).

<a id="od-09"></a>
### OD-09 — Dependencies versus blocking relationships
- **Decided (2026-10-05, architect, Phase 2B brief):** One family. `blocks` is the single directed dependency edge and *blocked by* is its inverse presentation. A task cannot block itself, duplicate an edge, or create a cycle. `related` is a separate symmetric relationship stored once. Relationships never grant access; cross-brand edges follow [OD-05](#od-05).
- **Why it matters:** Two parallel models produce inconsistent "blocked" calculations across views, Gantt, and briefings.
- **Affects:** TSK-012, TSK-013, PRJ-011, GOAL-010, VIEW-005 · phases 0B, 2A, 2B, 3B.
- **Safe default:** One family, with *blocks/blocked by* as the default dependency type. Finish-to-start style types may be added later, and *related* is non-blocking.
- **If deferred:** No longer applicable (decided).

<a id="od-10"></a>
### OD-10 — Synonyms: watchers/followers, labels/tags
- **Decided (2026-10-05, architect, Phase 2B brief):** Each pair is one concept. *Label* is the canonical name: one brand-scoped `work.label` with a normalized unique name, colour or icon, lifecycle, and order, joined to tasks of the same brand. Labels never grant authority; renames keep identity; archived labels stay on tasks but leave default pickers. *Follower* is canonical and belongs entirely to 4A.
- **Why it matters:** Duplicate concepts double the notification and filter logic.
- **Affects:** TSK-009, TSK-015, COL-010, PRJ-026, VIEW-012 · phases 2B, 4A.
- **Safe default:** Use *follower* and *label* in UI and API, and accept the other word in search and import mapping.
- **If deferred:** No longer applicable (decided).

<a id="od-11"></a>
### OD-11 — Formula fields versus calculated fields
- **Decided (2026-10-05, architect, Phase 2C brief):** One capability. *Formula* is a custom-field type, and WFL-011's calculated fields are formula fields. A formula compiles to a versioned typed AST (never `eval`, JavaScript, SQL, templates, or user code). It may use field references on the same record, literals, arithmetic, comparison, boolean conditionals, null handling, and a small deterministic function registry. It has no network, current time, randomness, secrets, context, cross-record queries, or side effects. Results are read-only, errors are typed (`missing`, `invalid`, `divide_by_zero`, `cycle`, `overflow`), and a result is visible only where every input is visible.
- **Original question:** Are WFL-008's "formula" type and WFL-011's "calculated fields" the same capability?
- **Why it matters:** Each expression engine is a security and performance surface.
- **Affects:** WFL-008, WFL-011 · phases 0D, 2C.
- **Safe default:** One calculated-field type with a sandboxed, side-effect-free expression language, with limits defined in 0B/0D.
- **If deferred:** No longer applicable (decided).

<a id="od-12"></a>
### OD-12 — Timeline versus Gantt
- **Decision:** Define the difference between VIEW-004 and VIEW-005.
- **Why it matters:** Without a difference, one of the two requirements is unverifiable.
- **Affects:** VIEW-004, VIEW-005 · phase 3B.
- **Safe default:** *Timeline* shows date bars grouped by brand, project, or milestone, with no dependency arrows. *Gantt* adds dependency arrows, dependency-aware rescheduling, and baseline versus actual.
- **If deferred:** 3B acceptance criteria for these two views stay ambiguous.

<a id="od-13"></a>
### OD-13 — Project completion percentage formula
- **Decided (2026-10-04, architect, Phase 2A brief):** The basis is count-based on **leaf** tasks.
  - Until tasks exist (2A), a completed project shows 100% and any other project 0%, labelled *Status-based*.
  - From 2B, completion is done leaf tasks divided by all non-cancelled leaf tasks the viewer may read. Paused tasks count in the denominator.
  - There is no estimate weighting until 5C explicitly replaces the basis.
  - Hidden work never affects a visible numerator, denominator, count, or explanation in a way that discloses existence.
- **Why it matters:** It is shown on every project and portfolio, and it must never be mistaken for completion ([lifecycle §3](lifecycle-and-states.md#project-completion-versus-completion-percentage)).
- **Affects:** PRJ-020, RPT-005, GOAL-005 · phases 2A, 2B, 5C.
- **If deferred:** No longer applicable (decided). 5C versions the metric if it changes the basis.

<a id="od-14"></a>
### OD-14 — Recurring projects
- **Decided (2026-10-04, architect, Phase 2A brief):** A recurring project is a schedule that creates a new, independent project for each occurrence from an **immutable snapshot**.
  - **Snapshot:** frozen once, when the series is defined, from an approved template or project serialization, and stored in the planning-owned series.
  - **Copied:** phases and milestones (with the project's own fields).
  - **Never copied:** activity, audit, shares, collaborators, personal data, secrets, and cross-brand references.
  - **Idempotency:** each occurrence has a stable occurrence key, unique per series.
  - **Missed occurrences:** catch-up is bounded by `RECURRENCE_CATCHUP_MAX`.
  - **Phase split:** 2A delivers definition, pause and resume, manual next occurrence, and worker generation. 2D may improve the interaction but not these semantics.
- **Why it matters:** It could mean template instantiation, repeating phases, or a reopened project, and each has a different data model.
- **Affects:** PRJ-013, PRJ-014 · phases 2A, 2D.
- **If deferred:** No longer applicable (decided).

<a id="od-15"></a>
### OD-15 — "Decision" as a record type
- **Decided (2026-10-04, architect, Phase 2A brief):** Decisions and open questions are one structured record type, the decision record (`dec_`), with a kind of *decision* or *open question*.
  - **Fields:** statement, outcome or resolution, owner, and applicable dates.
  - **Decision states:** proposed → decided → superseded.
  - **Question states:** open → resolved.
  - **Rejected:** cross-kind states.
  - **Documents:** may link to decision records later, but they are not the authority.
- **Why it matters:** AI extraction (AI-013), project display (PRJ-024), and briefings (BRF-009) need somewhere structured to put decisions.
- **Affects:** PRJ-024, SRCH-001, DOC-006, AI-013, BRF-009 · phases 0B, 2A, 4C, 7C.
- **If deferred:** No longer applicable (decided).

<a id="od-16"></a>
### OD-16 — "Latest verified project update"
- **Decided (2026-10-04, architect, Phase 2A brief):** An update is verified only by an explicit verification action by an authorized human project owner or collaborator.
  - **Authoring alone never verifies.** AI-drafted, imported, and system updates stay unverified until that action.
  - **Updates stay append-only.** Verification is a separate fact recording the verifier and time.
  - **Latest verified update:** the newest update that has a verification fact.
- **Why it matters:** Unverified AI drafts could otherwise be presented as the project's status.
- **Affects:** PRJ-025, AI-016, BRF-004 · phases 2A, 7C, 7E.
- **If deferred:** No longer applicable (decided).

<a id="od-17"></a>
### OD-17 — Staleness and freshness thresholds
- **Decided (2026-10-06, architect, Phase 2D brief) for tasks:** A *meaningful update* is a change to the title or description, status, assignees, start or due date or deadline, estimate, criteria or checklist, labels, relationships, custom field values, links, lifecycle, or a manual update. Reads, view state, favorites, recents, reminders, and snoozes are not meaningful. An *active* or *blocked* task is stale after 7 calendar days without a meaningful update, a *planned* task after 14; paused, cancelled, and done tasks are never stale. A task is *repeatedly rescheduled* after 3 material due-date or deadline edits within 14 days. The thresholds are registered, bounded parameters (`TASK_STALE_ACTIVE_DAYS`, `TASK_STALE_PLANNED_DAYS`, `TASK_RESCHEDULE_COUNT`, `TASK_RESCHEDULE_WINDOW_DAYS`). Documents, search freshness, and briefings (4C, 5A, 5C) decide their own thresholds against this definition.
- **Original question:** The definition of a "meaningful update" (TSK-041), thresholds for stale tasks and documents and for repeated rescheduling (TSK-044, RPT-003, DOC-015), and the indexing freshness target (SRCH-011).
- **Why it matters:** Too-sensitive thresholds create noise in briefings, and too-lax ones hide neglected work.
- **Affects:** TSK-041, TSK-044, RPT-003, SRCH-011, DOC-015, BRF-008 · phases 2D, 4C, 5A, 5C.
- **Safe default:** A meaningful update is a change to status, assignee, dates, description, or deliverable, or a comment, by a non-system actor. Thresholds are configurable per workspace with conservative product defaults. Passing a review date warns but does not change document state.
- **If deferred:** Each phase invents its own threshold, and metrics become inconsistent.

<a id="od-18"></a>
### OD-18 — "Scheduled for today" and Today's timezone
- **Decision:** Confirm Today uses the viewer's timezone and shows committed or block-scheduled items, with due-today items in a separate section (PLAN-001).
- **Why it matters:** It defines the most-used screen.
- **Affects:** PLAN-001, PLAN-002, PLAN-003 · phase 3C.
- **Safe default:** As in [time-and-scheduling.md §6](time-and-scheduling.md#6-today).
- **If deferred:** 3C cannot finalize acceptance tests.

<a id="od-19"></a>
### OD-19 — Holiday calendars
- **Decision:** Where holidays come from (CAL-010): manual entry, a country calendar per brand or person, or the connected calendar.
- **Why it matters:** Holidays change availability and capacity warnings across brands in different countries.
- **Affects:** CAL-010, WSB-010, TIME-010 · phases 3E, 6C.
- **Safe default:** Manual holiday entries per brand and per person at launch, plus whatever the connected calendar provides.
- **If deferred:** Capacity ignores public holidays unless entered manually.

<a id="od-20"></a>
### OD-20 — Human self-approval
- **Decision:** May a person approve their own work, deliverable, timesheet, or go/no-go decision? This matters most for a solo founder. AGT-018 prohibits self-approval for agents only.
- **Why it matters:** A strict rule makes the product unusable for one-person workspaces, and a loose rule weakens evidence for teams.
- **Affects:** AGT-018, TSK-029, TEST-024, TIME-012, FILE-009 · phases 4A, 8D, 9D, 3D.
- **Safe default:** Allowed when workspace policy permits it. The default is **on** for workspaces with one member who has approval rights and **off** once there are two. Self-approval is always recorded and visibly labeled, and agents can never approve.
- **If deferred:** The launch acceptance flows LA-009 and LA-012 cannot be completed by a solo founder.
- **Status (Phase 3D, 2026-10-07):** Timesheet approval (TIME-012) applies the workspace `self_approval_mode` exactly as workflow approvals do (2C): under `auto`, a person may approve their own brand line only while the workspace has one active member; every decision records `self_approval`, and the timesheet shows it as self-approved.

<a id="od-21"></a>
### OD-21 — Defect verification and flaky-result policy
- **Decision:** The default "configured verification" before a defect resolves (TEST-017), and whether `flaky` results can count toward release readiness.
- **Why it matters:** This is what makes "merged ≠ verified" enforceable.
- **Affects:** TEST-016, TEST-017, TEST-018, TEST-023 · phases 9B, 9C, 9D.
- **Safe default:** Verification requires a passing rerun of the linked test on a version containing the fix, or a manual verification by someone other than the fixer when no test is linked (subject to OD-20 for solo workspaces). Flaky results never count as passed by default.
- **If deferred:** 9C cannot set the default workflow.

<a id="od-22"></a>
### OD-22 — Validating agent deliverables against acceptance criteria
- **Decision:** Is AGT-019 validation automated (checks or tests), AI-assisted, human, or layered?
- **Why it matters:** Automated "validation" must never be mistaken for acceptance.
- **Affects:** AGT-019, AGT-020, LA-009 · phase 8D.
- **Safe default:** Layered. Automated checks and AI assessment are **advisory evidence** attached to the review, and acceptance is always a human decision.
- **If deferred:** 8D cannot define what "validated" displays.

<a id="od-23"></a>
### OD-23 — Low-impact agent action classes
- **Decision:** Which actions agents may take without review under workspace policy (AGT-015).
- **Why it matters:** Requiring review for everything makes agents useless, and requiring it for too little creates risk.
- **Affects:** AGT-014, AGT-015, AGT-016 · phases 0C, 8D.
- **Safe default:** Reading authorized records, drafting comments and documents in draft state, creating subtasks under the agent's own task, and attaching artifacts. Everything in AGT-016 always requires approval.
- **If deferred:** Every agent action requires review, which is safe but slow.

<a id="od-24"></a>
### OD-24 — Externally reported agent cost
- **Decision:** How to treat cost that an external agent reports about itself (AGT-012).
- **Why it matters:** Cost displays must not mix measured and self-reported figures (AI-010 forbids invented costs).
- **Affects:** AGT-012, RPT-012, BRF-013 · phases 8C, 5D.
- **Safe default:** Store and show it as "reported by <agent>", kept separate from measured costs and never summed into them without a label.
- **If deferred:** The safe default applies.

<a id="od-25"></a>
### OD-25 — Briefing corrections memory
- **Decision:** The scope and approval of remembered corrections (BRF-015, BRF-016): personal, brand-wide, or workspace-wide, and whether they expire.
- **Why it matters:** A correction made by one person could change what others are told.
- **Affects:** BRF-015, BRF-016 · phase 7E.
- **Safe default:** Personal by default, promotable to brand level by a brand admin. Every correction is listed, editable, and removable.
- **If deferred:** The safe default applies.

<a id="od-26"></a>
### OD-26 — Unlocking approved time periods
- **Decision:** Who may unlock an approved, locked period (TIME-013), and whether re-approval is required.
- **Why it matters:** Locked periods may feed invoices or payroll.
- **Affects:** TIME-012, TIME-013 · phase 3D.
- **Safe default:** Workspace admins only, with a reason. The unlock is audited, and re-approval is required.
- **If deferred:** The safe default applies.
- **Status (Phase 3D, 2026-10-07):** Decided as the safe default (Phase 0 exit gate, admin-only unlock) and implemented: `timesheet.unlock` is limited to workspace owners and administrators, needs step-up and a reason (3–500 characters), appends an audited `unlock` row and a security event, and returns the brand line to the person, who must submit it again for a fresh approval (ADR-0019 T11).

## B. Launch scope boundaries

<a id="od-27"></a>
### OD-27 — Public (unauthenticated) views
- **Decision:** Does PRJ-028 include link-based public views without sign-in at launch?
- **Why it matters:** Public links bypass membership and are the highest-risk exposure path.
- **Affects:** PRJ-028, VIEW-017, WSB-009 · phases 0C, 1D, 3A.
- **Safe default:** Authenticated guest views only at launch. If public links are approved: off by default per workspace, read-only, expiring, no comments, no children unless selected, and revocable.
- **If deferred:** PRJ-028 is satisfied by guest views only, and public links become a later decision.

<a id="od-28"></a>
### OD-28 — Intake forms
- **Decision:** May forms (CAP-007, PRJ-017) accept submissions from people without accounts? How are abuse, spam, and attachments controlled, and how is a submission routed to a brand?
- **Why it matters:** This is an unauthenticated write path into a tenant.
- **Affects:** CAP-007, PRJ-017 · phases 2E, 0C, 11B.
- **Safe default:** Each form belongs to one brand. Submissions land in that brand's intake queue, with rate limits, bot protection, and attachment scanning.
- **If deferred:** Forms are limited to authenticated members.
- **Status (Phase 2E, 2026-10-06):** Still open; recorded as a blocker. 2E implements only the deferred rule: a form belongs to one brand and accepts submissions from signed-in members who can read that brand, rate-limited per person and form (`INTAKE_SUBMISSIONS_PER_HOUR`), into the form owner's Inbox as brand intake items. No anonymous access, bot protection, or attachment scanning is implemented until OD-28 is decided (11B).

<a id="od-29"></a>
### OD-29 — Capture by forwarding email
- **Decision:** Per-user or per-brand forwarding addresses, sender verification, and attachment handling (CAP-006). No roadmap sub-phase names inbound email.
- **Why it matters:** It needs inbound mail infrastructure, a provider choice, and spoofing protection.
- **Affects:** CAP-006 · phases 2E (provisional), 6A.
- **Safe default:** A personal forwarding address that lands in the owner's Inbox, accepts only verified sender addresses, and scans attachments. The architect should assign an owning sub-phase.
- **If deferred:** CAP-006 slips past 2E.
- **Status (Phase 2E, 2026-10-06):** Still open. Email forwarding is owned by 6A; 2E keeps the adapter-ready `email` source kind on Inbox items and creates no address, inbound mail, or sender verification (CAP-006 is a foundation deferred to 6A).

<a id="od-30"></a>
### OD-30 — Realtime collaborative editing at launch
- **Decision:** Already listed in BUILD_ROADMAP "Proposed approval decisions" (DOC-011, COL-011).
- **Why it matters:** Realtime editing is costly infrastructure.
- **Affects:** DOC-011, COL-011 · phase 4D.
- **Safe default:** Optimistic concurrency, version history, and conflict prompts at launch, with realtime later.
- **If deferred:** 4D builds the safe default.

<a id="od-31"></a>
### OD-31 — Semantic search and attachment content
- **Decision:** Do "natural-language concepts" (SRCH-004) require semantic/vector search at launch, and is attachment **content** (PDF text, OCR) indexed (DOC-019)?
- **Why it matters:** Cost, infrastructure (the roadmap avoids a separate vector DB), and authorization-safe indexing.
- **Affects:** SRCH-004, DOC-019 · phases 5A, 7B.
- **Safe default:** Keyword full-text search plus AI-assisted query interpretation at launch. Text is extracted from common text formats, and OCR comes later.
- **If deferred:** 5A builds the safe default.

<a id="od-32"></a>
### OD-32 — Document export formats
- **Decision:** Which "common formats" (DOC-020).
- **Why it matters:** Without a list, the requirement cannot be verified.
- **Affects:** DOC-020, DATA-011 · phases 4C, 6D.
- **Safe default:** Markdown, HTML, and PDF at launch.
- **If deferred:** 4C exports Markdown only.

<a id="od-33"></a>
### OD-33 — Imports from other PM tools
- **Decision:** Confirm DATA-010 ("incrementally after launch") is outside the first-paid-launch scope.
- **Why it matters:** The roadmap's closure audit (11A) would otherwise treat it as a launch blocker.
- **Affects:** DATA-010 · phases 6D, 11A.
- **Safe default:** Out of launch scope, with launch covering CSV only (DATA-001).
- **If deferred:** 11A cannot close.

## C. Retention, deletion, privacy, legal

<a id="od-34"></a>
### OD-34 — Trash recovery and workspace deletion grace periods
- **Decision:** The published values of `TRASH_RECOVERY_PERIOD` and `WORKSPACE_DELETION_GRACE_PERIOD` (LA-018), and whether they vary by plan.
- **Why it matters:** LA-018 requires a *published* recovery period, and storage costs depend on it.
- **Affects:** LA-018, PRJ-001, TSK-001, SEC-021 · phases 1F, 10A, 10D.
- **Safe default:** Both are configurable, and no number is published. Automatic purge stays disabled in production until a value is approved.
- **If deferred:** LA-018 cannot pass, and trashed data accumulates.

<a id="od-35"></a>
### OD-35 — Cancellation and payment-failure periods (commercial, legal)
- **Decision:** `CANCELLATION_READ_ONLY_PERIOD`, `PAYMENT_GRACE_PERIOD`, and the meaning of restricted access after grace (BILL-016, BILL-019, DATA-015).
- **Why it matters:** These are customer-facing promises in terms and checkout (LA-023).
- **Affects:** BILL-016, BILL-019, DATA-015, LA-023 · phases 10A, 6D.
- **Safe default:** Read-only plus export after both events, with no deletion caused by payment state alone. Durations are configurable and unpublished.
- **If deferred:** LA-023 cannot pass.

<a id="od-36"></a>
### OD-36 — Retention periods by data class (legal)
- **Decision:** Retention for AI history, agent runs, audit events, notifications, integration events, webhook deliveries, files, exports, backups, and billing records (FILE-013, AUD-008, SEC-020, NTF-012).
- **Why it matters:** Privacy law, storage cost, and evidence value pull in different directions.
- **Affects:** FILE-013, AUD-008, SEC-020, NTF-012, AI-026, AGT-026 · phases 1F, 11B.
- **Safe default:** Retain until the record or workspace is deleted, except backups and export files, whose lifetimes are technical settings. Every value is configurable, and none is published.
- **If deferred:** Unbounded growth, plus potential non-compliance with data minimization.

<a id="od-37"></a>
### OD-37 — Legal and retention holds
- **Decision:** Whether holds are offered, on which plans, and who may place or release them.
- **Why it matters:** Business customers may need them, and they override purge.
- **Affects:** SEC-020 · phases 0B, 1F.
- **Safe default:** Not offered at launch. The model reserves a hold that blocks purge.
- **If deferred:** The safe default applies.

<a id="od-38"></a>
### OD-38 — Content values in audit history after edit, delete, or purge (privacy)
- **Decision:** Whether earlier comment text and previous field values remain in audit history after the author deletes them or the record is purged (COL-009, AUD-003).
- **Why it matters:** Audit integrity conflicts with erasure expectations.
- **Affects:** COL-009, AUD-003, SEC-023 · phases 1F, 4A, 11B.
- **Safe default:** Earlier values stay visible to admins while the record exists. On purge, content values are removed and structural audit facts remain.
- **If deferred:** 1F must still support redacting content inside events.

<a id="od-39"></a>
### OD-39 — Account deletion and departing members (privacy)
- **Decision:** Whether a deleted person's name is retained or pseudonymized in audit and history, what happens to a departing member's personal-scope data, and what happens when a sole owner deletes their account (SEC-021, ADM-013).
- **Why it matters:** This combines data-subject rights with record integrity.
- **Affects:** SEC-021, SEC-023, ADM-013, PERM-014 · phases 1B, 1D, 11B.
- **Safe default:** Pseudonymize ("Former member #id") after account deletion. Block sole-owner deletion until ownership is transferred or the workspace is deleted.
- **If deferred:** Account deletion cannot ship.

<a id="od-40"></a>
### OD-40 — Import rollback period
- **Decision:** The value of `IMPORT_ROLLBACK_PERIOD` (DATA-009).
- **Why it matters:** The rollback window is a promise and needs a defined end.
- **Affects:** DATA-009 · phase 6D.
- **Safe default:** Configurable and unpublished, with semantics as in [deletion §6](deletion-retention-history.md#6-integration-and-import-removal).
- **If deferred:** DATA-009 cannot pass ("within a defined recovery period").

<a id="od-41"></a>
### OD-41 — AI provider data use (legal)
- **Decision:** What the product promises about excluding model training and about provider retention (AI-036, SEC-027, SEC-028).
- **Why it matters:** Customer trust, contractual exposure, and provider selection.
- **Affects:** AI-036, SEC-027, SEC-028, SUP-005 · phases 7A, 10D, 11B.
- **Safe default:** Use only provider configurations that contractually exclude training, and document providers as subprocessors. Publish nothing beyond what provider contracts guarantee.
- **If deferred:** AI features cannot be launched to paying customers.

<a id="od-42"></a>
### OD-42 — Backup RPO/RTO targets
- **Decision:** Recovery-point and recovery-time objectives (SEC-019), and how long backups (and so purged data) persist.
- **Why it matters:** These are published reliability commitments and affect cost.
- **Affects:** SEC-019, REL-017, LA-022 · phases 1A, 11C.
- **Safe default:** Measure achievable values in 11C before publishing any target.
- **If deferred:** LA-022 can verify that restoration works, but no target can be stated.

<a id="od-43"></a>
### OD-43 — Hosting region and data residency
- **Decision:** Already in the roadmap approval decisions: the first region and any residency promise.
- **Why it matters:** It affects hosting, subprocessors, and legal documents.
- **Affects:** SEC-022 · phases 1A, 11B.
- **Safe default:** A single region with no residency promise.
- **If deferred:** 1A cannot provision production.

## D. Commercial

<a id="od-44"></a>
### OD-44 — Plan boundaries, seats, brands, guests, lifetime offers (commercial)
- **Decision:** The single-user plan contents, the number of brands in the founder plan, seat minimums, whether guests or extra brands consume seats, included usage, and whether lifetime/founder offers exist and on what terms (BILL-001..007, BILL-017, BILL-018, COL-002).
- **Why it matters:** Pricing must be visible before purchase (LA-023), and entitlements gate features across every phase.
- **Affects:** BILL-001, BILL-002, BILL-003, BILL-006, BILL-007, BILL-017, BILL-018, COL-002, LA-023 · phases 10A, 10C.
- **Safe default:** Entitlements are data-driven and server-enforced (BILL-020), with no prices or limits in product copy until approved. BILL-003 (no per-brand seat for the same owner) is a requirement, not an open choice.
- **If deferred:** 10A cannot finish, and LA-023 cannot pass.

<a id="od-45"></a>
### OD-45 — "Eligible plans"
- **Decision:** Which plans include custom roles (PERM-002) and audit export (AUD-009).
- **Why it matters:** These are plan differentiators and need entitlement keys.
- **Affects:** PERM-002, AUD-009 · phases 10A, 10C.
- **Safe default:** Build both behind entitlements, enabled in development and undecided for production.
- **If deferred:** The safe default applies.

<a id="od-46"></a>
### OD-46 — Workspace-provided AI keys (commercial)
- **Decision:** Under what commercial terms workspaces may bring their own AI provider keys (AI-032), and whether usage on those keys counts toward allowances.
- **Why it matters:** It changes margins, support burden, and the cost display.
- **Affects:** AI-032, AI-033, BILL-007 · phases 7A, 10A.
- **Safe default:** Supported in the gateway design and switched off in production until approved. If enabled, usage is metered for visibility and is not billed.
- **If deferred:** The safe default applies.
