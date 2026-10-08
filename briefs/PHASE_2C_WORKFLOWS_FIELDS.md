# Developer Brief — Phase 2C: Configurable Workflows and Fields

## Objective

Make project and task behavior configurable without weakening the canonical status, authorization, audit, or data model. Deliver scoped custom statuses and transitions, required fields and approval gates, typed custom fields and reusable field sets, safe formulas, validation, visibility, and lossless serialization for future imports/exports.

Build on accepted Phase 2B head `1ab61f4`. Extend the existing `workflow` schema, platform default statuses, `@pm/work`, permission compiler, audit/lifecycle, contracts, shell, projects/tasks UI, and Phase 2 closure validator. Do not create parallel status, approval, form, formula-execution, field-value, or authorization systems.

## Authority and delivery

This brief is the binding Phase 2C product and architecture decision. The complete [Authoritative Delivery Protocol](AUTHORITATIVE_DELIVERY_PROTOCOL.md) applies: implement the entire scope, reconcile sources, create the branch/commits/draft PR, run full CI, root-cause and fix all in-scope failures, and return only after one clean current-head no-skip run passes. No intermediate approval is required.

Base branch/head: `phase-2b-tasks-relationships` at `1ab61f4`.

Delivery branch: `phase-2c-workflows-fields`.

Draft PR base: `phase-2b-tasks-relationships`.

Do not edit `BUILD_ROADMAP.md`, self-mark the checklist/ADR accepted, start 2D/2E, merge, or include `ROADMAP_CHECKLIST.md`, `briefs/`, `.local/`, reports, secrets, or build output in product commits.

## Requirement scope

Complete: PRJ-009, TSK-016, TSK-031, WFL-001–014.

Contribute without claiming later completion:

- TSK-029/030 and FILE-007: generic workflow approval facts and gates now; collaborative task/deliverable review journeys and review-state UI belong to 4A/4E;
- WFL-009: item-type visibility is enforced now and view-visibility metadata is stored; saved-view application/editing belongs to 3A;
- WFL-014: canonical lossless serialization/deserialization now; import/export jobs and user flows belong to 6D;
- WFL-013: advanced-field collapsing works in current project/task forms; later views reuse the same metadata.

## Binding workflow decisions

Record these in ADR-0015 and authoritative product/data/access/platform/UX sources before runtime code:

1. **One workflow system.** Extend `workflow.platform_status`; add configurable workflow/status/transition records in the same schema. Platform defaults remain immutable seeds and are never copied into a competing table.
2. **Workflow scope and precedence.** A workflow definition targets exactly one record kind (`project` or `task`) and one scope: workspace, brand, or project. Resolution is most specific applicable scope: project → brand → workspace → platform default. A project-scoped task workflow applies only to tasks in that project; projectless tasks use brand/workspace/default. Changing scope never changes record authority.
3. **Status identity/category.** Custom status has stable public ID, name, description, color/icon, rank, lifecycle, and exactly one canonical category `planned|active|paused|done|cancelled`. Category drives product semantics and cannot be custom. Rename/recolor/reorder preserves identity/history. A status in use cannot be deleted; archive removes it from new choices while records retain it until migrated.
4. **Useful defaults (WFL-001).** Existing Phase 2A/2B platform project/task statuses remain the default workflows. Default transition behavior allows any nonterminal status to another nonterminal status, explicit Complete into `done`, explicit Cancel into `cancelled`, and Reopen from terminal to the previous valid nonterminal status or default planned status. Custom workflows may restrict edges.
5. **Transitions.** `workflow.transition` is a directed from-status/to-status rule with stable identity, rank, optional description, required-field rules, optional confirmation tier, and optional approval policy. If any active transition rules exist for a workflow, only registered edges are allowed. Status category invariants and special Complete/Reopen commands remain enforced; a generic patch may never bypass transitions.
6. **Required fields.** Requirements attach to a transition and refer to canonical built-in fields or active custom-field definitions. Validation occurs on the final merged record under lock, before mutation. Missing/invalid fields return pointer-addressed errors. TSK-031 completion requirements are transition rules into `done`; completion override cannot bypass workflow-required fields unless the rule explicitly permits an audited manager override.
7. **Approval gates.** A transition may require `none|one_manager|all_named_approvers`. Create immutable `workflow.approval_request` and `workflow.approval_decision` facts bound to record version, transition, requester, approvers, and expiry. Minimal 2C UI lets eligible human approvers approve/reject and the requester apply once satisfied. Any record/version/field/status change that affects the proposal makes it stale. No self-approval when the policy forbids it. Phase 4A adds review-requested/changes-requested collaborative states, comments, notifications, and richer review journeys; 2C does not fabricate them.
8. **Transition application.** Preview returns required fields, approvals, warnings, and before/after category. Applying requires a signed short-lived fingerprint and recomputation under lock. It atomically changes status, records field values, consumes the approval request, updates completion facts where applicable, bumps versions/epochs, audits, and emits registered events.
9. **Lifecycle.** Workflow/status/transition/field/field-set configuration uses active/archived lifecycle. Archive is reversible. Purge is refused while referenced. Configuration history and records using archived definitions remain readable.

## Binding custom-field decisions

10. **Field types.** Support exactly: text, number, currency, percentage, date, person, label, checkbox, URL, email, select, and formula. Formula is the calculated-field capability from OD-11—not a separate type/system.
11. **Definition scope.** A field definition belongs to workspace, brand, or project and declares applicable record kinds (`project`, `task`, or both). Resolution uses the same project → brand → workspace precedence, but fields from broader scopes accumulate unless shadowed by the same stable definition lineage. Names are not identity.
12. **Typed values.** Store values in one canonical `workflow.field_value` relation keyed by definition and target record, with validated typed JSON plus normalized/indexable typed columns where required. Never add one database column per custom field. Values carry workspace/brand roots, version, updater/time, and RLS.
13. **Validation.** Definitions may specify required, min/max length/value, decimal scale, regex from a safe bounded engine, allowed URL schemes, email normalization, select options, person eligibility, label scope, and date bounds. Server/database enforce compatible invariants. Client validation is assistance only.
14. **Currency/percentage.** Currency stores integer minor units plus ISO 4217 code; no floating money. Percentage stores a bounded decimal using an explicitly registered scale/range and displays the configured convention. No silent currency conversion.
15. **Person/label references.** Person values reference active eligible memberships but grant no access. Label values use canonical same-brand labels and grant no access. On removal/archive, historical value identity remains while new selection is refused; display is permission filtered.
16. **Select options.** Options have stable IDs, label, color, rank, active/archived state. Renaming preserves stored meaning. Removing an in-use option requires migration/replacement or archival.
17. **Formula safety.** Formula definitions compile to a versioned typed AST—never `eval`, JavaScript, SQL, templates, or user code. Allow only field references, literals, arithmetic, comparison, boolean conditionals, null handling, and an explicit small deterministic function registry. No network, time-now, randomness, secret/context access, cross-record queries, or side effects.
18. **Formula graph.** Dependencies are stored explicitly; creation/edit uses cycle detection and a registered maximum depth/reference count. Recompute deterministically from authorized stored values in the same transaction for direct dependencies, with bounded queued recomputation for larger fan-out if needed. Errors are typed (`missing`, `invalid`, `divide_by_zero`, `cycle`, `overflow`) and never expose hidden input values. Formula results are read-only.
19. **Formula authorization.** A formula may reference only fields whose definitions and values are readable wherever the formula result is readable. If a viewer lacks an input field, omit/redact the result—never compute a revealing derivative. Authorization is compiled with field visibility, not checked only in the UI.
20. **Visibility.** Field visibility is an intersection of record readability, definition applicability, explicit role/field policy, and current surface. Hidden fields are omitted from API payloads, filters, sorts, exports, audit projections, formula explanations, counts, and errors. Visibility never grants record access. View-specific visibility is stored as metadata and consumed by 3A; 2C implements current project/task forms and detail surfaces.
21. **Advanced fields.** A definition may be `primary|advanced`. Advanced fields render under “More fields,” remain keyboard reachable and searchable by label, and surface validation errors by expanding/focusing the group. This is presentation only; it does not change authorization.
22. **Field sets.** A reusable field set is a versioned ordered collection of definition references and presentation overrides, scoped workspace/brand/project with record-kind applicability. Applying a set attaches a version snapshot/lineage without duplicating field definitions or values. Later set changes do not silently mutate existing records; authorized managers explicitly upgrade and preview effects.
23. **Serialization (WFL-014).** Provide a versioned canonical schema containing field definitions, option IDs/labels, set lineage, typed values, formula AST/dependencies, visibility/applicability, and unknown-extension preservation. Round-trip export→import in memory must be lossless. Unknown future fields are retained as opaque extensions and never executed. Phase 6D supplies files, mapping, jobs, user review, and cross-workspace ID resolution.

## Data and migrations

Create exactly two ordered migrations after 0024:

- `0025_workflow_configuration`: workflows, custom statuses, transitions, required-field rules, approval policies/requests/decisions, lifecycle, constraints, RLS/grants, indexes;
- `0026_custom_fields`: definitions, options, values, formula dependencies/results, field sets/versions/attachments, serialization metadata, lifecycle, RLS/grants, indexes.

Both require paired down migrations and boundary-catalog tests restoring exactly 0024. Extend `@pm/work` or create a layer-correct `@pm/workflow` package only if the accepted module map supports it; do not create a dependency cycle. One package owns workflow evaluation.

Register public prefixes, actions, scopes, errors, events, commands, parameters, job kinds, envelopes, and bounded metrics at 0D before use. Register bounds for workflows/statuses/transitions, fields/options/sets, formula depth/references/AST size/evaluation, approval approvers/expiry, and bulk value operations. No magic limits.

Database backstops must cover tenant/scope consistency, status/workflow membership, immutable categories where required, active uniqueness, transition endpoints, typed value shape, option/reference scope, formula dependency cycles where feasible plus deferred service/commit guard, approval immutability, and reference-safe archival/purge.

## Authorization

Add canonical actions for workflow/field configure, value read/edit, transition preview/apply, approval request/decide, and formula inspect. Configuration authority follows workspace/brand/project manage rules with grantable-authority limits. No owner/admin bypass for sensitive/restricted scopes.

Every list/single/count/form/transition/formula/approval/export-serialization surface uses the canonical record predicate plus field policy before pagination or aggregation. Unreadable record/field/approval targets return `not_found`; readable-but-insufficient actions return safe `forbidden`. Assignee/approver responsibility grants no record access.

Preview and enforcement must share the same evaluator. Permission/status/config changes invalidate stale fingerprints and approvals on the next check. Worker recomputation runs tenant-scoped and rechecks current definition/value visibility.

## API and UI

Provide typed, cursor-based, ETag/idempotent APIs for workflow/status/transition CRUD and ordering; transition preview/apply; approval requests/decisions; field definitions/options/values; field sets/version/apply/upgrade; formula validate/preview; and canonical serialization.

Add accessible responsive administration screens at workspace/brand/project scope:

- Workflows: record kind, statuses, ordering/colors, transition map/list, required fields, confirmation and approval policy;
- Custom fields: type-specific configuration, applicability, visibility, validation, options, formula builder, dependencies and safe preview;
- Field sets: ordered composition, scope/applicability, version and explicit upgrade preview;
- Pending workflow approvals: minimal request detail, before/after, approve/reject, stale/expired state.

Integrate resolved custom statuses and fields into existing project/task create/edit/detail/settings and completion/transition flows. Do not implement drag-only builders: every reorder/connection has buttons/menu and keyboard alternatives. Complex editors follow the 0E responsive rule; Compact may use the approved view/edit adaptation but must allow essential completion fields and approval decisions.

Cover loading, empty, validation, duplicate name, archived/in-use, stale ETag, conflict/merge, offline/retry, invalid transition, missing required fields, approval pending/rejected/stale/expired, formula errors/cycles, hidden input/result, option migration, partial recomputation, and not-found/forbidden states.

## Audit, observability, privacy, and performance

Audit every material configuration/version/transition/approval/value/set/formula change with safe before/after facts. Content-class field values and formulas are hashed/redacted according to classification; metric/log labels never contain tenant IDs, field names, values, formulas, option labels, emails, or record IDs.

Add query-plan and bounded-load tests for workflow resolution, available transitions, required-field evaluation, field definitions/values/options, formula dependency lookup, approval queues, and serialization at representative high cardinality. Cache only by permission/config epochs and invalidate on configuration/authority change. Measure formula/recompute and transition latency with bounded outcome labels.

## Required tests

Use at least three workspaces/brands, sensitive/restricted projects, projectless tasks, all six roles, share-only principals, custom workflows at all three scopes, fields of every type, hidden fields, formula chains, and concurrent managers. Prove:

- resolution/precedence is deterministic and tenant-safe;
- custom statuses cannot corrupt canonical categories or bypass Complete/Reopen/transition rules;
- missing fields and approvals prevent transitions atomically; stale approvals/fingerprints cannot replay;
- responsibilities/approvals never grant access and hidden records/fields/options/formula inputs never leak through payloads, errors, counts, sorting, serialization, audit, or timing-visible branches;
- type validation, currency precision, percentage bounds, person/label eligibility, select archival, field-set upgrades, formula cycles/depth/errors, and lossless serialization follow the decisions;
- concurrent reorder/config/value/transition/approval operations resolve through locks/versions without partial state;
- migrations up/down/catalog, RLS/grants, direct app roles, pooled connections, query plans, API/process and production image pass;
- desktop/tablet/mobile Playwright+axe covers configuration, project/task fields, completion-required fields, approval, formulas, conflicts, forced colors, zoom, 320 px and keyboard-only use.

Extend Phase 2 closure to cover every owned/contributed requirement, decision, action/event/error/parameter, migration, and deviation.

## Final handoff

Follow the authoritative protocol. Do not hand back local-only or failed/pending CI work. Return one final eight-section report after the latest head passes the complete no-skip pipeline, including all failed-run root causes/corrective commits, PostgreSQL digest, scanners, image ID/size/non-root/readiness, limitations, and stacked merge order. Keep the PR draft and unmerged.

## Narrow early-stop conditions

Only the protocol's genuine authority/safety blockers permit an early handoff. In particular, stop only if the binding type/formula/visibility/approval model is irreconcilably inconsistent with an accepted higher-priority contract or would require unsafe data loss/external authority. Ordinary schema, validator, UI, migration, formula, concurrency, accessibility, scanner, image, test, and CI failures must be corrected through the authorized one-cycle workflow.
