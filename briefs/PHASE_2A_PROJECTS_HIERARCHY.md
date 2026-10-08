# Developer Brief — Phase 2A: Projects and Hierarchy

## Objective

Deliver the first genuinely useful brand-owned work record: secure projects with lifecycle, ownership and collaborators, hierarchy, phases, milestones, dependencies, planning metadata, updates/decisions, templates, recurrence, project permissions, and explicit cross-brand sharing.

Build on the accepted Phase 1 head `9fe1045`. Projects must use the canonical `core.record`, brand/workspace context, policy compiler, exact-record grants, audit/lifecycle, shell registry, favorites/recents, and public contracts. Do not create parallel authorization, sharing, hierarchy, status, relationship, template, or navigation systems.

## Authority and conflict resolution

This brief is the binding implementation decision for Phase 2A. The decisions below are approved architecture amendments, not questions for the developer. Before code, record them at the authoritative 0B/0C/0D/product/UX sources, regenerate derived outputs, and extend the validators so drift fails. Where older accepted text differs, this brief's explicit decision governs and the older source must be reconciled rather than implemented in parallel.

No additional product choice is required for the items decided here. Stop only for a new, material contradiction not resolved by this brief.

## Read first

- `FEATURES.md`; `BUILD_ROADMAP.md`; `ROADMAP_CHECKLIST.md`;
- the Phase 1 exit report, closure validator, ADR-0008 through ADR-0012, and accepted deviations;
- requirement catalog entries WSB-007, WSB-008, PRJ-001 through PRJ-015, PRJ-019 through PRJ-021, PRJ-024, PRJ-025, PRJ-027, and contributing requirements GOAL-008, GOAL-010, ONB-013, and LA-002;
- 0B `work`, `relations`, `workflow`, `template`, `core.record`, hierarchy/concurrency, temporal, deletion/retention, and brand-sharing contracts;
- 0C project permissions, restricted scopes, exact shares, sensitive brands, aggregation, grantable authority, and SQL-compilation rules;
- 0E project information architecture, record-page anatomy, responsive shell, state/error patterns, and accessibility rules.

Run Phase 0 and Phase 1 validators first and keep them green. Do not edit `BUILD_ROADMAP.md`, mark the checklist complete, begin tasks/custom workflows/saved views, or commit/push unless the product owner asks.

## Requirement ownership and scope

Complete in 2A:

- PRJ-001–008, PRJ-010–015, PRJ-019–021, PRJ-024, PRJ-025;
- the concrete project contribution to PRJ-027 and WSB-007;
- WSB-008: the first user-facing exact-record cross-brand sharing integration;
- the project contributions to GOAL-008, GOAL-010, ONB-013, and LA-002.

Foundation/contribution only:

- PRJ-009 custom statuses: use the canonical default project status set now; configuration arrives in 2C.
- Task-derived completion, overdue, blocked, unassigned, and at-risk details become richer in 2B/5C. Show only project-native facts now and label unavailable task-derived sections honestly.
- Later project sections—Tasks, Calendar, Documents, Files, Activity, Time, Costs, and Reports—must be real addressable routes with honest unavailable states, not fabricated empty data. Timeline is real in 2A. Tests and Releases routes exist but their tabs remain hidden until a software template or setting enables them.
- The shared reusable query/view engine, advanced portfolio/timeline/Gantt rendering, goals, reporting, comments, files, and notifications remain with their owning phases.

## Architecture decisions to implement

Record these in the Phase 2A ADR and authoritative sources. These dispositions are final for 2A:

1. **OD-13 completion percentage.** Amend the safe default from top-level tasks to leaf tasks. Until tasks exist, a completed project is 100% and any other project is 0%, labelled `Status-based`. From 2B onward the canonical rollup is completed leaf tasks divided by all leaf tasks the viewer may read; no estimate weighting until 5C explicitly replaces the basis. Hidden work never affects a visible numerator, denominator, count, or explanation in a way that discloses existence.
2. **OD-14 recurring projects and module layering.** Recurrence creates a new project instance from an immutable snapshot. Store that frozen snapshot in `planning.recurrence_series.template_payload`; `work` and `planning` must not depend on layer-4 `templates`. `templates.template` and `template_version` may read/serialize `work`, never the reverse. Add `recurrence_series_id` and `occurrence_key` to `work.project`, as required for recurrence targets. Copy phases and milestones; never copy activity, audit, shares, collaborators, personal data, secrets, or cross-brand references. Stable occurrence keys plus uniqueness make generation idempotent. Implement definition, pause/resume, manual next occurrence, bounded worker generation, and catch-up now; 2D may improve interaction but not change these semantics.
3. **OD-15 decisions/questions.** Keep the accepted entity and prefix: `work.decision_record` with public prefix `dec_`. Add `kind = decision|open_question`, statement, outcome/resolution, owner, and applicable dates. Decision state is `proposed → decided → superseded`; question state is `open → resolved`. Invalid cross-kind transitions are database- and service-rejected. Documents may link later; they are not the authority.
4. **OD-16 verified updates.** Adopt explicit human verification. Keep `work.project_update` append-only. Add a separate append-only project-update verification row containing update, verifier membership, verification time, and audit linkage. Authoring alone does not verify. An authorized human project owner or collaborator with the registered verification action may verify; AI/imported/system drafts remain unverified until that action. The latest verified update is selected from update-plus-verification facts without mutating the update.
5. **Collaborator authority and ownership.** `access.role_assignment` at project scope is the only collaborator authority, using `view|comment|edit|manage`; do not create `work.project_member` as a second authority table. `owner_id` is accountable responsibility, not implicit authority. Project creation, ownership transfer, or switching to restricted mode atomically creates/retains an explicit project `manage` grant for the responsible manager. Add a deferred last-project-manager guard so no active project can commit without an eligible manager. Ownership and authority remain separately auditable.
6. **Readable but unshareable.** If the caller can read a target but lacks `record.share`, return safe `forbidden`; only unreadable targets return `not_found`. This intentionally amends the conflicting Phase 1 behavior. Update the accepted Phase 1 assertion and 0C AT-050/source language together, with regression tests proving no hidden target becomes distinguishable.
7. **Project sections.** The fixed visible order is Overview, Tasks, Timeline, Calendar, Documents, Files, Activity, Time, Costs, Reports, Settings. Timeline is functional in 2A as accessible phase, milestone, and dependency lists. Later sections display an honest unavailable state, not a misleading empty collection. Tests and Releases are addressable but their tabs are absent until enabled by a software template or setting, per UXD-14.
8. **Phase lifecycle.** Amend 0B so a phase has active and archived lifecycle states in addition to Trash/recovery. Archive is reversible, preserves order and history, and is distinct from Trash. Phase archive/restore uses canonical lifecycle decisions and audit.
9. **Default project statuses.** Seed one immutable platform-default set through the minimal workflow/status schema: Planned (`planned`), Active (`active`), On hold (`paused`), Completed (`done`), Cancelled (`cancelled`). It is usable immediately. Phase 2C adds custom status editing and transition configuration; 2A exposes no custom-status editor.
10. **Scope/risk records.** Add ordered mutable `work.scope_item` with `kind = scope|exclusion|risk|assumption|constraint`, content-classified text, public identity if the canonical model requires addressability, versioning, lifecycle, audit, and project containment. Do not overload descriptions or custom fields.
11. **Project hierarchy.** A project has at most one parent, must remain in the same workspace and brand, and cannot be its own ancestor. Moving a subtree is lock-ordered and concurrency-safe, atomically updates ancestry, and is bounded by `PROJECT_DEPTH_MAX=10`; the database has a hard corruption-prevention ceiling of 32. Both limits count the root at depth 0.
12. **Dependencies and OD-05.** Use the canonical relationship primitive. Cross-brand project dependencies are permitted only when the acting principal can independently read both endpoints at creation. On every later display, independently re-authorize endpoints; omit an unreadable counterpart entirely, including its title, type, brand, state, counts, and any broken-link clue. Relationship containment never grants access.
13. **Templates.** `templates.template`/`template_version` are the template authority and may serialize project-owned structures. A template created from a project strips personal data, collaborators, shares, activity/audit, secrets, unsupported later-module data, and cross-brand references. Limit the serialized structure to `TEMPLATE_ITEMS_MAX=500`. The recurrence snapshot is copied once from an approved template/project serialization into `planning.recurrence_series.template_payload` and thereafter remains immutable.
14. **Sharing registry.** Add one canonical per-record-type shareability registry used by API and service enforcement. Project registers as shareable for the levels it enforces. Phase, milestone, decision, update, scope item, and every unregistered type are non-shareable. Reject unregistered targets even if an arbitrary `core.record` exists. API `view` maps to the existing stored `read` level; do not add a second stored level.
15. **Lifecycle issuer.** Extend the Phase 1 confinement rule to allow the work routes module to obtain lifecycle decisions only through a tenancy-exported issuer. Work code cannot mint decisions or write lifecycle tables directly. Register this permitted boundary and test that all other callers remain rejected.
16. **PRJ-017 contribution.** Project creation accepts an optional validated intake/form source reference and records provenance. It does not implement intake forms, anonymous submission, routing, or abuse protection; those remain 2E/OD-28. Unknown, foreign, or unreadable sources are rejected without disclosure.
17. **Followers.** Do not implement followers in 2A. PRJ-026 and the roadmap mention are fulfilled by 4A; 2A may expose only a future adapter/event boundary with no follower rows, counts, or UI.
18. **Registered bounds and events.** Register `PROJECT_DEPTH_MAX=10`, database ceiling 32 as an invariant (not a tunable runtime parameter), `TEMPLATE_ITEMS_MAX=500`, and `RECURRENCE_CATCHUP_MAX=12` at 0D. Register all used project update/move, phase, milestone, decision/question, relationship removal, template create/apply, recurrence, verification, and lifecycle events before runtime use. Event payloads obey existing data-class and disclosure rules.

## Data model and migrations

Create `@pm/work` as the canonical layer-3 package. Use exactly two ordered expand migrations after 0020: `0021_work_projects` for the work/workflow project structures and authoritative constraints, then `0022_project_relations_templates_recurrence` for canonical relationships, template integration, and planning recurrence. Do not renumber existing migrations or combine unrelated later-phase schemas. Both migrations require paired down files and boundary-catalog tests back to 0020.

Implement the accepted `work` entities and required extensions:

- `work.project` as a `core.record` extension with brand, parent/ancestor/depth, name/description, default status/category, priority, dates, completion, manual health, owner, budgets, ordering, access mode, and version;
- project collaborator authority through project-scoped `access.role_assignment` only; do not add a parallel project-member authority table;
- phases and milestones with stable rank, dates, status, ownership where specified, lifecycle, and containment;
- structured success criteria/definition-of-done items, `work.scope_item`, append-only project updates and verification facts, and `work.decision_record` decisions/open questions according to the decisions above;
- canonical project relationships for dependencies;
- layer-correct templates and planning-owned immutable recurrence snapshots/occurrences without copying personal data, audit history, secrets, grants, or cross-brand references;
- target adapters for favorites, recents, breadcrumbs, palette, personal state, ownership/departure, lifecycle/purge, search-ready projection, and exact record grants.

Every tenant row must carry canonical workspace/brand foreign keys as required, use RLS for `app_rw` and `app_worker`, and enforce containment consistency in the database. Use deferred constraints or locked commands where commit-time invariants are necessary. Migration down must restore the exact 0020 catalog.

Do not store computed authorization in denormalized project fields. Denormalized ancestry/status category must have guarded write paths and consistency tests.

## Lifecycle and commands

Provide idempotent, optimistic, same-transaction audited commands for:

- create, read, edit, duplicate, archive, restore, trash, restore-from-trash, and request purge;
- move/reorder/reparent project subtrees;
- assign/transfer owner and manage collaborators;
- create/edit/reorder/archive/restore phases and create/edit/reorder/lifecycle-manage milestones;
- add/remove project dependencies;
- manage criteria, scope statements, risks, assumptions, constraints, updates, and decisions/questions;
- set manual health and planning/budget fields;
- create template from project, create project from template, define/pause/resume recurrence, and generate an occurrence idempotently;
- share/revoke the project as one exact record and preview the resulting exposure.

All commands must use public IDs, idempotency keys, ETags/version checks, safe errors, canonical step-up where required, permission epochs, and same-transaction audit/security/outbox hooks. Duplicate/template operations must report exactly what is copied and omit personal/cross-brand/private state.

Archiving a project makes its operational content read-only according to policy. Trash/restore/purge uses the 1F lifecycle machinery and retention windows. A project lifecycle command applies only to the selected project, never implicitly archives/trashes/purges child projects; children retain their own lifecycle and remain discoverable only through authorized views. A parent that becomes unavailable is omitted from child breadcrumbs without leaking it. Purge is blocked while a live child still references the parent; the operator must reparent or independently dispose of children. Ownership hooks must prevent departure from leaving an invalid owner or last manager.

## Authorization and cross-brand sharing

Extend the 1D compiler rather than branching from it:

- project authority derives from readable brand context, built-in role cap, explicit project collaborator/grant, project restriction, sensitive-brand grants, lifecycle, and ownership;
- owners/admins have no global bypass; sensitive brands still require explicit access;
- restricted projects do not inherit broad brand access beyond the accepted policy and default `allow_record_shares=false`;
- list, count, hierarchy, dependency, milestone, overview, recent/favorite, palette, breadcrumb, and mutation checks use the same compiled predicate before pagination or aggregation;
- unauthorized single targets return `not_found`; readable-but-insufficient mutations may return safe `forbidden`;
- a share covers the project record only—never phases, milestones, tasks, descendants, dependencies, activity, or future children unless separately registered and granted;
- share levels are only those the project module actually enforces (`view`, `comment`, `edit`), capped by the sharer and guest rules; received share authority cannot reshare;
- cross-brand display shows only brands/endpoints the viewer can independently read, with no hidden counts or placeholders.

Implement permission preview and exposure warnings through the existing 1D engine. Tests must prove preview and enforcement remain identical.

## API and UI

Replace the Projects placeholder with production routes and integrate them into the existing shell:

- project list grouped by brand in multi-brand scope and by fixed platform status in single-brand scope, with authorized totals only;
- create/duplicate/template flows with explicit brand selection in aggregate scope;
- project overview with identity, accountable owner, project-role collaborators, status, priority, dates, health, criteria, scope/risk sections, phases/milestones, dependency summary, decisions/questions, latest verified update, completion basis, and honest empty states;
- project hierarchy/tree with keyboard tree behavior, type-ahead, expand/collapse, and non-drag Move/Indent/Outdent actions;
- settings for identity, access/restriction/sharing, templates/recurrence, archive/trash, and ownership;
- section navigation in the exact order and conditional visibility decided above, with permission filtering and honest later-phase routes;
- favorites, recents, breadcrumbs, page titles, brand markers, deep links, Back/Forward, scope switching, command palette, and shortcuts through existing registries.

Support Expanded/Wide, Medium, and Compact behavior. Cover loading, empty, validation, save, offline/retry, conflict/merge, forbidden/not-found, archived, trashed, read-only, concurrent move, depth/cycle failure, stale preview, partial background work, and recurrence failure states. No hover-, color-, drag-, or pointer-only operation.

## Audit, events, observability, and performance

Register new record types, actions, statuses, commands, events, errors, parameters, job kinds, and bounded metrics at authoritative Phase 0 sources before use.

Audit every material create/edit/status/health/owner/collaborator/hierarchy/dependency/share/template/recurrence/lifecycle/verification change with safe before/after values. Never log descriptions, risks, budgets, titles, hidden endpoint data, or unrestricted content as metric labels or error context.

Add indexes and query-plan tests for brand/status lists, ancestry, children, project-scoped assignments, phases/milestones, dependencies, exact grants, lifecycle, and recurrence due-work. Enforce `PROJECT_DEPTH_MAX`, `TEMPLATE_ITEMS_MAX`, and `RECURRENCE_CATCHUP_MAX` exactly as decided above; other batches use registered bounds, never magic numbers. Worker jobs must recheck principal freshness and authority before each consequential step.

## Required tests

Use at least three workspaces, three brands including sensitive/archived, all six roles, restricted and inherited projects, a guest, exact cross-brand shares, and concurrent actors. Prove:

- cross-tenant/brand project reads and writes fail through UI, API, services, direct roles, forged IDs/cursors, worker payloads, and pooled connections;
- hierarchy cycles, cross-brand parents, excessive depth, concurrent reparent/reorder, and stale ancestry cannot commit;
- dependency endpoints are independently authorized and hidden endpoints/counts never leak;
- guests and cross-brand recipients see exactly the project record granted, cannot infer or inherit children, and cannot reshare;
- owner/collaborator departure, last-owner rules, sensitive grant revocation, archive/trash/purge, and permission epochs take effect on the next check;
- duplicate/template/recurrence operations are idempotent and strip forbidden state;
- completion basis, verified updates, manual health, budgets, dates, criteria, and decision/question states follow the recorded contracts;
- every list/count/overview/navigation/palette/favorite/recent/breadcrumb surface agrees with single-record enforcement;
- desktop/tablet/mobile Playwright + axe journeys work with keyboard-only, 320 px, boundary widths, zoom, reduced motion, forced colors, and conflict/offline states.

At minimum run unit/component, real-PostgreSQL migration/RLS/grant/query-plan/concurrency, API/process, and browser/accessibility suites. Add a Phase 2 closure validator entry for owned/contributed requirements and decisions rather than relying only on prose.

## Documentation and acceptance

Add a Phase 2A ADR and update data/access/platform sources, generated contracts, engineering database/tenancy/lifecycle/observability/environment docs, UX implementation notes, and requirement closure. Record any deviation explicitly for architect review.

Run the full local verification, then request authorization before creating a branch/commit/PR. Acceptance requires one clean no-skip CI run with Testcontainers PostgreSQL, pinned scanners, license policy, production image migration/startup/readiness/web smoke, exact image identity/size, and non-root runtime proof.

## Completion response

Return:

1. outcome, versions, requirement/decision closure;
2. files, migration, schemas, constraints, indexes, and generated contracts;
3. project lifecycle, hierarchy, phases/milestones, dependencies, templates, recurrence, and ownership behavior;
4. authorization, restricted projects, collaborators, cross-brand shares, preview, and revocation behavior;
5. API/UI flows, responsive/accessibility coverage, and honest later-section handling;
6. test inventory with isolation, concurrency, query-plan, lifecycle, and migration results;
7. full local/CI evidence, PostgreSQL digest, scanners, production image ID/size/non-root/readiness;
8. deviations, limitations, deferred work, operational notes, and proposed branch/PR topology.

## Stop conditions

Stop and report instead of improvising if accepted contracts conflict, an open decision lacks the disposition above, projects require a parallel authority/status/hierarchy system, shares would imply descendants, hidden dependencies leak, hierarchy invariants cannot be enforced transactionally, template/recurrence copies private state, a later module must be fabricated, migration rollback is unsafe, the prior navigation flake recurs, or any required gate is weakened, retried blindly, or skipped.
