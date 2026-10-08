# Developer Brief — Phase 2B: Tasks and Relationships

## Objective

Deliver the core unit of work: secure brand-owned tasks, optionally inside projects, with multi-assignment, dates and estimates, subtasks, checklists, acceptance/definition-of-done criteria, labels, typed links, dependencies and related records, exact task sharing, and complete material history.

Build on accepted Phase 2A head `50d6fc0`. Extend `@pm/work`, migrations 0021/0022, the canonical project/brand permission compiler, `core.record`, relationship primitive, lifecycle engine, rich-text contract, shell registries, exact-share registry, audit pipeline, and Phase 2 closure validator. Do not build parallel task authorization, status, relationship, attachment, history, or view systems.

## Authority

This brief is the binding Phase 2B implementation decision. Reconcile conflicting or incomplete older sources to the explicit decisions below before writing runtime code; regenerate outputs and make validators enforce them. Engineering must not choose alternative product semantics for decided items.

The complete `briefs/AUTHORITATIVE_DELIVERY_PROTOCOL.md` applies. This brief is the approval to implement, create the Phase 2B branch and logical commits, push, open a draft stacked PR, run full CI, diagnose and fix every in-scope failure, and repeat the complete pipeline until one clean current-head no-skip run passes. Do not return for intermediate approval.

Run Phase 0, Phase 1, and Phase 2 validators first. Do not edit `BUILD_ROADMAP.md`, mark the checklist complete, begin 2C/2D/2E, merge the PR, or include checklist/brief/local/report/build-output files in product commits.

## Requirement scope

Complete: TSK-001–007, TSK-010–015, TSK-017, TSK-020–023, and TSK-039.

Contribute without falsely completing later ownership:

- WSB-007: tasks remain strictly brand-separated;
- TSK-008: register an assignee/principal extension point only; no AI/agent assignment until 8B;
- TSK-009: followers/watchers are one concept owned by 4A; add no rows, counts, or UI;
- TSK-034: one canonical task identity supports later multi-view display; do not create saved/query views;
- TIME-003: estimates and remaining estimates are stored now; time entries/timesheets remain 3D.

Inline editing, bulk actions, drag/drop, undo, duplicate detection, freshness warnings, reminders, snooze, recurrence, and task templates remain 2D. Inbox capture/triage remains 2E. Comments/followers remain 4A; documents/files 4C/4E; external-record connectors 6A; agents 8B.

## Binding domain decisions

Record these in ADR-0014 and at authoritative 0A/0B/0C/0D/0E sources before implementation:

1. **OD-02 task scope.** Every task has exactly one workspace and one brand. `project_id` is optional. If present, the project must be in the same workspace and brand. A task may be moved between same-brand projects or made projectless. Cross-brand move is an explicit command allowed only for a projectless task or together with a valid destination project in the target brand; it requires manage authority in both brands, exposure preview, confirmation, and atomic revalidation.
2. **Default task statuses.** Seed immutable platform defaults through the existing workflow schema: Backlog (`planned`), To do (`planned`), In progress (`active`), Blocked (`paused`), Done (`done`), Cancelled (`cancelled`). Phase 2C adds custom statuses/transitions and an editor. No second status table.
3. **Dates (OD-01).** `start_date` is planned earliest start. `due_date` is an internal desired completion date and may be changed during planning. `deadline` is an external/hard commitment, stored as either a date or timezone-bearing instant, never changed implicitly. `scheduled time` is a separate planning work block; 2B exposes an adapter/empty state but does not store schedule fields on the task. `duration` in TSK-005 means `estimate_minutes`; work-block duration belongs to 3C. Completing/moving/recurring never rewrites a deadline.
4. **Assignments.** `work.task_assignee` supports zero or more active internal memberships with ordered primary display but no authority effect. Assignment is responsibility, never an access grant. Guests and removed/suspended members cannot be assignees. The first assignee may be marked primary; at most one primary is enforced. Unassigned is valid.
5. **Subtasks (OD-08).** Tasks form a same-workspace, same-brand tree; parent and child must share project identity, including both being projectless. Maximum application depth is `TASK_DEPTH_MAX=20` with a database corruption ceiling of 64, root depth 0. Reparenting is lock-ordered, cycle-safe, and atomically rewrites ancestry. “Unlimited nesting safeguards” is satisfied by a generous explicit bound, not literal infinity.
6. **Checklists.** Checklist items are ordered mutable child facts with text, completion state, completer/time, and version. They are not tasks, have no assignees/dates/dependencies, and do not affect task status automatically. Completion is reversible and audited.
7. **Dependencies (OD-09/OD-05).** `blocks` is the single directed dependency edge; “blocked by” is its inverse presentation. A task cannot block itself, duplicate an active edge, or create a dependency cycle. `related` is a separate symmetric relationship stored canonically once. Cross-brand/projectless/project relationships are allowed only when both endpoints are independently readable and the actor has `record.relate`; display re-authorizes both and omits unreadable counterparts without counts or clues. Relationships never grant access.
8. **Labels/tags (OD-10).** They are one concept: `work.label`, scoped to exactly one brand, with normalized unique name, color/icon, lifecycle, and ordering. `work.task_label` joins tasks only to labels in the same workspace/brand. Labels do not grant authority. Renames preserve identity; archived labels remain on tasks but are hidden from default pickers.
9. **Rich description.** Use the Phase 2A versioned `description_rich` contract and canonical hashing. The 2B editor may use the same multiline subset; do not add a task-specific rich format.
10. **Acceptance and definition of done.** Use ordered structured criteria items with `kind = acceptance|definition_of_done`. Project definition-of-done items are inherited as read-only defaults for project tasks unless explicitly dismissed/overridden by a task; inheritance is evaluated, not copied. Task items have completion state and audit. Completing a task with incomplete required criteria is refused unless an authorized explicit override action records reason and actor.
11. **Expected deliverable.** Store a registered type from `document|file|url|pull_request|test_report|other`, optional human-readable detail, and `requires_acceptance`. This is an expectation, not a fabricated deliverable. Phase 4E connects real versions/reviews.
12. **Estimates.** `estimate_minutes` and `remaining_estimate_minutes` are nullable non-negative integers with a registered maximum. Remaining may exceed the original estimate after re-estimation. Completing a task does not erase either value; actual time arrives in 3D.
13. **Typed links and later attachments.** Implement safe URL links now (`https` only by default, normalized, titled, ordered). Add the canonical relationship/reference adapter for documents, files, and external records, but expose those choices only when the owning registered record type exists and is independently readable. Do not create placeholder document/file/external rows, upload bytes, fetch remote previews, or leak inaccessible targets.
14. **History.** The immutable 1F audit ledger is the authoritative material task history, including safe previous/new values, actor/source, and correlation. Do not add a mutable duplicate history table. Provide a permission-filtered task-history API projection suitable for the later Activity UI; redact content-class fields according to policy and omit hidden relationship endpoints.
15. **Task sharing.** Register `task` as explicitly shareable at levels the task module enforces (`view|comment|edit`, stored view=`read`). A task share grants the task representation plus checklist and task criteria facts. It never grants parent/children, project, assignees' directory data, labels beyond safe displayed names, dependencies/related endpoints, links to inaccessible records, history, comments, attachments, or future descendants. The share-only representation may show the owning brand marker but not brand aggregation. No onward sharing.
16. **Completion and status.** A human with `task.complete` moves to a `done` category after required-criteria validation. Reopening chooses the prior nonterminal status when still valid, otherwise To do. Parent completion never completes descendants; a parent with incomplete descendants requires explicit confirmed override and records the count visible to the actor only. Child completion updates project/task rollups but never changes parent/project status automatically.
17. **Duplication.** Duplicate copies task fields, task-local criteria, checklist text/state reset to incomplete, labels, and safe URL links. It never copies assignees, shares, history, comments, dependencies/related links, external references, acceptance facts, recurrence, or child tasks unless the caller explicitly chooses `include_subtasks`; that option copies the authorized subtree within depth/item bounds and reports omissions.
18. **Lifecycle.** Archive is reversible and read-only; Trash/restore/purge uses 1F. A lifecycle command applies only to the selected task unless `include_subtasks=true` is explicitly confirmed. Purge is blocked while live children exist. Hidden/unavailable ancestors are omitted from breadcrumbs. Lifecycle never cascades through dependency/related edges.

## Data and migrations

Extend `@pm/work` with exactly two ordered migrations after 0022:

- `0023_work_tasks`: task, assignee, checklist, task criteria, labels/task-labels, safe URL links, status seeds/extensions, ancestry, lifecycle, versions, indexes, RLS/grants, and constraints;
- `0024_task_relationships_sharing`: task relationship enforcement/adapters, shareability registration support, history projection helpers, lifecycle/purge/ownership hooks, and worker-safe functions actually required by 2B.

Both require paired down migrations and boundary-catalog tests restoring exactly 0022. Do not introduce later-phase schemas.

Use `core.record` for task identity and registered public prefix. Every row carries canonical workspace/brand roots and composite foreign keys. Project/parent consistency, ancestry, status category, assignee eligibility, label brand, primary assignee, criteria kinds, ranks, and relationship invariants need database backstops. Denormalized ancestry/status is writable only through guarded commands.

Register typed parameters, including `TASK_DEPTH_MAX=20`, database ceiling as invariant, task-subtree/duplicate bounds, estimate maximum, checklist/criteria/link bulk bounds, and query page caps. No operational magic numbers.

## Authorization

Extend the canonical compiler:

- project-contained tasks inherit project visibility/grants until a restricted boundary; projectless tasks use brand authority;
- exact task grants add only the task-share representation decided above;
- role caps, sensitive brands, lifecycle, membership state, permission epochs, and explicit restrictions apply in the canonical order;
- responsibility fields—creator and assignees—never grant access;
- list, count, hierarchy, project rollup, single read, history, relationships, favorites, recents, palette, breadcrumbs, and writes use the same predicate before pagination/aggregation;
- unreadable targets return `not_found`; readable-but-insufficient actions return safe `forbidden`;
- preview and exposure warnings reuse the 1D engine and must equal actual enforcement.

No generic owner/admin bypass. No request-supplied principal/role/scope override. Worker actions recheck principal freshness before each consequential step.

## Commands and API

Provide idempotent, optimistic, audited commands for task CRUD/duplicate/move/lifecycle; status/complete/reopen; assignments; reparent/reorder; checklist/criteria; labels; URL/reference links; estimates/dates/deliverable expectation; dependency/related edges; exact shares; and history reads.

Use public IDs, ETags/field-merge hashes, idempotency keys, cursors, safe errors, canonical step-up/confirmation tiers, same-transaction audit/outbox, epochs, and registered envelopes/events. Cross-brand move, subtree operations, criteria override, and broad access changes require preview/confirmation appropriate to exposure.

## UI

Replace task placeholders within real Projects and add projectless task entry paths without implementing My Work/Inbox saved views.

- Project Tasks section: accessible paged task list and hierarchy with status, priority, assignees, dates, estimates, brand marker, and authorized totals.
- Task page/panel: context/breadcrumbs, rich description, fields, assignees, criteria, checklist, subtasks, labels, dates, expected deliverable, safe links, relationships, lifecycle, sharing, and history projection.
- Creation in aggregate scope requires explicit brand; inside a project inherits its brand read-only.
- Responsive Expanded/Wide, Medium, and Compact layouts; real links/deep links; shell scope behavior; favorites/recents/palette/brand markers.
- Provide non-drag Move/Indent/Outdent/Reorder controls. Drag/drop, bulk/inline editing, and undo remain 2D.
- Honest unavailable states for comments, files, documents, external integrations, followers, agents, reminders, recurrence, and advanced views.

Cover loading, empty, validation, save, conflict/merge, offline/retry, archived/trashed/read-only, not-found/forbidden, concurrent move, cycle/depth, stale preview, criteria override, partial omission, and permission-loss states.

## Events, audit, performance, and privacy

Register every new prefix, action, status, error, event, parameter, envelope type, and bounded metric before runtime use. Audit content fields as hashes/redacted changes where required. Never place titles, descriptions, checklist text, URLs, labels, personal IDs, hidden endpoints, tenant IDs, or arbitrary status names in metric labels.

Index and test project/brand/status lists, ancestry/children, assignees, labels, checklist/criteria, relationships in both directions, shares, lifecycle, and history projection. Add query-plan evidence at representative 5,000 and 50,000 task volumes, including restricted projects and grant-heavy principals. Bound subtree rewrites and duplicate operations.

## Required tests

Use at least three workspaces/brands, sensitive/restricted projects, projectless tasks, all six roles, share-only guests, multiple assignees, deep trees, and concurrent actors. Prove:

- cross-tenant/brand reads/writes fail through UI/API/service/direct roles/worker/forged IDs/cursors/reused connections;
- project optionality and mandatory brand invariants cannot be bypassed;
- cycles, cross-brand parents, cross-project parent mismatch, excessive depth, opposing moves, and stale reorder cannot commit;
- assignments never grant access and ineligible members cannot be assigned;
- share-only payload and commands match the exact boundary with no parent/project/child/relationship/history leak;
- hidden relationship endpoints and aggregate counts disappear consistently;
- status completion, required criteria, override, reopening, dates/deadlines, estimates, checklists, labels, links, duplicate, lifecycle, and history follow the decisions above;
- permission preview equals enforcement and revocation takes effect on the next check everywhere;
- migration up/down/catalog, RLS/grants, constraint/concurrency, query-plan, API/process, and desktop/tablet/mobile Playwright+axe pass;
- keyboard-only, 320 px, breakpoint edges, zoom, reduced motion, forced colors, and accessible tree/list/detail behavior pass.

Extend the Phase 2 closure validator for every owned/contributed requirement and every binding decision.

## Acceptance workflow

Execute the full delivery in one cycle under the authoritative protocol:

1. reconcile sources and validators;
2. implement and verify locally;
3. create `phase-2b-tasks-relationships` from accepted head `50d6fc0`;
4. create logical commits, excluding `ROADMAP_CHECKLIST.md`, `briefs/`, `.local/`, reports, secrets and build output;
5. push and open a draft PR into `phase-2a-projects-hierarchy`;
6. run the complete CI pipeline;
7. root-cause and fix every failure within this brief's authority, push corrective commits, and rerun the entire pipeline;
8. hand back only after one current-head no-skip run passes Testcontainers PostgreSQL, all tests, pinned scanners, licence policy, and production-image migration/readiness/web/non-root gates.

Do not self-mark the roadmap or ADR accepted and do not merge. Do not ask for permission at intermediate steps.

## Completion response

Return:

1. outcome, versions, requirements and decisions;
2. source reconciliation, files, migrations, schemas, constraints, indexes, contracts;
3. task lifecycle, scope/moves, tree, assignments, statuses, dates, criteria/checklists, labels, links, estimates and history;
4. authorization, restricted/projectless behavior, shares, relationships, preview and revocation;
5. API/UI flows, responsive/accessibility states, and honest deferrals;
6. tests, isolation, concurrency, migration and query-plan evidence;
7. final current-head no-skip CI run, PostgreSQL digest, scanners, production image ID/size/non-root/readiness, plus earlier failed-run causes and corrective commits;
8. deviations, limitations, operational notes and proposed branch/PR topology.

## Stop conditions

The authoritative delivery protocol's narrow early-stop rules apply. In particular, task access requiring parallel authority, responsibility granting access, share leakage, hidden endpoints affecting counts, unenforceable tree invariants, fabricated later records, divergent history, or unsafe rollback are genuine blockers only if they cannot be safely corrected within the binding decisions. Ordinary implementation bugs and CI failures must be fixed without an intermediate handoff. A gate may never be weakened, blindly retried, or skipped.
