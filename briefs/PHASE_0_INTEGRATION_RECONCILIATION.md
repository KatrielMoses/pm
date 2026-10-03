# Developer Brief — Phase 0 Integration Reconciliation

## Objective

Reconcile the accepted Phase 0A–0E architecture packages into one internally consistent source of truth and provide objective evidence for the Phase 0 exit gate.

This is a narrow integration brief, not a redesign. The primary task is to apply the accepted Phase 0C data-model refinements to the authoritative Phase 0B model and remove stale contradiction language after verifying that the source contracts have already been amended.

Do not begin Phase 1 application implementation.

## Read first

- `BUILD_ROADMAP.md` and `ROADMAP_CHECKLIST.md`;
- all accepted documentation under `docs/product/`, `docs/ux/`, and `docs/architecture/{data,access,platform}/`;
- `docs/architecture/access/16-open-questions.md`, especially AC-01 through AC-06;
- `docs/architecture/platform/20-open-questions.md`, especially PC-01 through PC-03 and PQ-01 through PQ-04.

Treat the decisions in `ROADMAP_CHECKLIST.md` as approved. Do not edit `BUILD_ROADMAP.md` or mark the checklist complete.

## Required work

### 1. Apply the accepted 0C refinements to the authoritative 0B model

Update `docs/architecture/data/model/model.json`, its schema only if structurally necessary, the Phase 0B prose, and all generated data-model documentation.

Apply at minimum:

- change cross-brand sharing to one `access.record_grant` row per shared record, grouped by `share_group_id` and keyed by grantee; remove the obsolete `include_children` and `selected_child_ids` representation;
- add `access.field_policy`;
- add `access.permission_epoch`;
- add `access.service_principal` with accountable-owner and suspension semantics;
- add `access.support_access_grant`;
- add `work.project.access_mode` and `allow_record_shares`;
- add `knowledge.document.access_mode` and the equivalent share restriction behavior;
- represent the accepted workspace-policy keys without creating an untyped dumping ground;
- add service-principal/owner-authority suspension fields or references needed by automations, integrations, webhook subscriptions, and other delegated execution;
- add `effective_principal_type/id`, `initiating_membership_id`, `delegation_chain`, `epochs_at_enqueue`, selected scope, and required risk/approval/data-class context to `execution.operation` and `execution.job` as prescribed by the Phase 0D execution-context contract;
- add elevated/reason/expiry representation for time-boxed sensitive-scope elevation;
- ensure every new public/addressable type has a consistent public-ID decision and reconcile it with the Phase 0D registry.

Preserve the modular-monolith ownership rules, tenant/brand invariants, classification rules, and typed-table approach. Do not weaken validation to make the additions pass.

### 2. Reconcile accepted source amendments

Verify that the authoritative contracts now consistently state:

- internal delivery is at least once and externally visible effects use provider/receiver deduplication where available; exactly-once external delivery is never promised;
- idempotent replay returns stored references re-rendered through current authorization, never a stored response body;
- Trash visibility uses current effective permission and excludes guests;
- guests use fixed record grants only, not brand/project/team inheritance;
- administrators cannot export departed-member personal data by default;
- ordinary application, worker, support, dispatcher, and scheduler roles never bypass tenant RLS;
- cross-brand shares contain only individually selected records at share time and never future children;
- inaccessible relationships and their derived metadata remain omitted;
- colleague free/busy disclosure remains off by default;
- a signed object-storage URL issued before revocation may remain usable until its short expiry, while new download requests fail immediately; optional proxied downloads for sensitive brands remain a later implementation decision.

Where open-question documents still describe these as unresolved conflicts, mark them resolved without deleting the historical explanation.

### 3. Cross-package identifier and vocabulary audit

Check the authoritative models and registries for drift across:

- entity and module names;
- public ID prefixes;
- lifecycle, workflow, review, execution, operation, job, delivery, and test-result states;
- actor/principal types;
- action, capability, scope, risk, and approval names;
- requirement IDs and owning sub-phases;
- event names, webhook types, notification types, meter names, and error codes;
- data-classification and visibility levels;
- named parameters.

Resolve genuine drift at its authoritative source and regenerate derived documentation. Do not paper over mismatches only in prose.

### 4. Contract dependency audit

Demonstrate that:

- every 0C principal/entity referenced by the permission model exists in the data model or is explicitly a platform-only identity;
- every 0D public ID prefix maps to a data-model entity or has a documented platform-only resource owner;
- every 0D action/scope maps to a valid 0C action;
- every 0D execution context can be durably represented by the reconciled 0B model;
- every public webhook event has an owning module, versioned field allow-list, maximum data class, and authorization-at-delivery rule;
- each SSE topic can be authorized using 0C predicates without per-view server-side state;
- every audit/event/notification actor maps to the accepted actor vocabulary;
- no schema allows internal UUIDs, secrets, C3/C4 data, unauthorized counts, or stored authorization decisions to escape through public surfaces.

### 5. Phase 0 decisions register

Create `docs/architecture/PHASE_0_DECISIONS.md` as a concise index—not a duplicate of every ADR—with:

- approved cross-phase decisions and links to their authoritative documents;
- product-owner decisions still intentionally deferred, with safe defaults and owning phase;
- legal/commercial/customer promises still unset;
- implementation parameters deliberately left unnamed or unvalued;
- a clear statement of which files are authoritative versus generated.

Include the approved decisions already recorded in `ROADMAP_CHECKLIST.md`.

### 6. Phase 0 exit-gate report

Create `docs/architecture/PHASE_0_EXIT_GATE.md` containing:

- evidence for the Phase 0 roadmap exit gate;
- deliverables produced by 0A–0E;
- validation commands and results;
- unresolved issues classified as either safe implementation-phase decisions or true blockers;
- confirmation that no true architecture blocker remains before Phase 1;
- a dependency-oriented recommendation for the first Phase 1 batch;
- explicit warning if any accepted contract is still represented only in prose but absent from its machine-readable authoritative model.

The report must not declare the gate passed if the authoritative models still disagree.

### 7. Integration validator

Add a repeatable integration validator under `docs/architecture/tools/` that runs or imports the existing validators and additionally checks cross-package references and drift that individual package validators cannot see.

At minimum it must detect:

- missing 0C-required data entities/fields;
- ID-prefix mismatches;
- unknown principals/actions/scopes/states across packages;
- stale generated files;
- unresolved cross-phase blockers;
- broken internal links in the Phase 0 decision and exit-gate documents.

Use the standard library where practical. Do not duplicate all existing validator logic when orchestration and focused cross-checks suffice.

## Accepted integration decisions

- PC-02 is approved: idempotent replay re-renders stored references through current authorization.
- PC-03 is approved with bounded residual risk: short-lived signed URLs cannot be individually revoked after issuance; revocation prevents new URLs. Sensitive brands may later opt into proxied downloads.
- PQ-03 is approved: the 20 public webhook event types may be the launch surface, provided their existing versioned allow-lists and authorization-at-delivery constraints remain enforced.
- PQ-04 is approved: record, operation, brand, project, and personal SSE topics satisfy the UX update needs; notices remain reference-only and clients re-fetch authorized state.
- Public links remain disabled by default.
- Legal, commercial, retention-duration, SLO, rate-limit, and compatibility-window promises remain unset unless explicitly approved later.

## Non-goals

- Do not implement application code, database migrations, APIs, workers, UI, or infrastructure.
- Do not redesign accepted product semantics, authorization, or platform contracts.
- Do not choose vendors or parameter values that require production measurements.
- Do not add requirements or reduce scope.
- Do not edit `BUILD_ROADMAP.md` or mark `ROADMAP_CHECKLIST.md` complete.

## Acceptance criteria

- The authoritative data model contains every accepted 0C addition and 0D execution-context dependency.
- Obsolete share-array fields and conflicting role/RLS/idempotency language are removed or clearly marked historical and resolved.
- All package validators and the new integration validator pass.
- Generated artifacts are current.
- Cross-package IDs, states, actors, actions, scopes, events, classifications, and prefixes are consistent.
- The Phase 0 decision index accurately distinguishes approved decisions, safe defaults, and unresolved promises.
- The exit-gate report identifies no true blocker before recommending Phase 1.
- No accepted architecture decision exists only in a completion report or checklist while contradicting an authoritative model.

## Required completion response

Return:

1. Summary of reconciliation work and consequential changes.
2. Every file created or changed.
3. Updated module/entity/addressable-entity counts and model changes.
4. Every cross-package inconsistency found and its resolution.
5. Integration-validator coverage and complete results from all validators.
6. Remaining deferred decisions grouped by owning phase and product-owner/legal/commercial approval.
7. Phase 0 exit-gate recommendation with evidence.
8. Recommended dependency-safe first Phase 1 batch.

Do not merely state that reconciliation is complete; provide reviewable evidence.
