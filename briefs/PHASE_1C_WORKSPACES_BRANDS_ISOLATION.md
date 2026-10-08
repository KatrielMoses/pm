# Developer Brief — Phase 1C: Workspaces, Brands, and Tenant Isolation

## Objective

Deliver the first real multi-tenant product journey. A verified account must be able to create a workspace, become its protected bootstrap owner, configure workspace defaults, create and manage multiple brands, switch between a brand and an all-authorized-brands scope, and archive or restore brands without cross-tenant or cross-brand disclosure.

This phase must prove strict isolation in the database, service layer, API, derived results, audit trail, lifecycle engine, and browser UI. Phase 1D will expand the bootstrap owner model into complete membership, roles, invitations, teams, and grants.

## Read first

- `FEATURES.md` and requirement catalog entries WSB-001 through WSB-011;
- `BUILD_ROADMAP.md`, `ROADMAP_CHECKLIST.md`, and accepted Phase 0 contracts;
- 0B workspace, brand, membership, brand-setting, record-envelope, lifecycle, time, and isolation models;
- 0C effective permissions, sensitive brands, non-disclosure, RLS, revocation, and trash/archive rules;
- 0D API, errors, idempotency, step-up, audit, events, observability, and public-ID contracts;
- 0E brand-context, responsive, form, destructive-action, accessibility, and state patterns;
- Phase 1B identity/session contracts and Phase 1F audit/lifecycle implementation, including its 1C handoffs.

Run the Phase 0 validator before and after implementation. Do not edit `BUILD_ROADMAP.md`, mark the checklist complete, weaken existing gates, select storage/vendors, or push/commit unless the product owner asks.

## Requirement ownership

Complete in this phase:

- WSB-001 workspace creation;
- WSB-002 workspace name, logo reference, timezone, locale, currency, and week-start settings;
- WSB-003 multiple brands;
- WSB-004 brand identity, description, status, timezone, and sensitivity settings;
- WSB-005 brand archive and restore through the Phase 1F lifecycle engine;
- WSB-006 switch between one brand and all authorized brands;
- WSB-007 brand separation foundation for every later record module;
- WSB-009 prevention of accidental cross-brand exposure;
- WSB-010 brand working-hours/calendar foundations;
- WSB-011 brand goals/priorities settings foundation.

Foundation only:

- WSB-008: preserve the accepted explicit, revocable record-grant boundary and prove there is no implicit cross-brand sharing. The full sharing UI belongs to 1D/later record phases.
- WSB-012 through WSB-014: provide typed setting namespaces/extension points only; do not implement AI, integrations, or notifications.
- WSB-015 and later global views: return safe brand presentation metadata through a shared contract, but final display across business records belongs to their owning phases.

## Critical sequencing decision: bootstrap ownership

Workspace creation cannot safely wait for the full Phase 1D membership system. Implement only the minimum canonical membership foundation needed for bootstrap ownership:

- create the accepted `tenancy.membership` table now, with the complete durable columns and constraints that 1D will extend without destructive replacement;
- workspace creation atomically creates one active `member` membership for the authenticated account and one built-in owner assignment/authority fact;
- only this bootstrap owner role may exist through public 1C routes; do not implement invitation, guest, administrator/member/read-only assignment, teams, custom roles, or membership management;
- the last/bootstrap owner cannot be removed, suspended, or demoted, and no 1C route exposes such operations;
- record this as a subset of 1D, not an alternate authorization system. Phase 1D must consume the same membership ID and migrate/extend the same policy data.

Do not use `workspace.created_by_account_id`, a browser claim, email address, or session-only flag as a substitute for membership authority.

## Required database model and migrations

Add ordered expand migrations after 0016.

### Workspace

Extend the Phase 1A `tenancy.workspace` anchor in place. Preserve its IDs and all existing execution foreign keys. Add:

- public `ws_` identifier if the canonical registry requires it;
- name, logo/file reference boundary, IANA timezone, BCP 47 locale, ISO 4217 currency, week start, state, version, created/updated times, and bootstrap provenance;
- explicit active/read-only/deletion-pending/purging states from the authoritative model, without implementing deletion yet;
- checks, indexes, and optimistic concurrency.

Do not store logo bytes in PostgreSQL or invent an object-storage vendor. Use a nullable validated file/reference boundary and a local preview mechanism; final upload comes in 4E.

### Membership foundation

Create `tenancy.membership` with canonical identity, public ID if registered, workspace/account foreign keys, kind/state, display override, version/timestamps, and unique `(workspace_id, account_id)`. Add the minimal built-in owner role/assignment representation required by the canonical access model. Seed built-in role definitions deterministically if the accepted schema calls for them.

The initial workspace transaction must create the workspace, active owner membership, owner authority, workspace permission epoch, audit/security events, and initial settings atomically. A retry with the same idempotency key returns the original result and never creates a second workspace.

### Brand and settings

Implement `tenancy.brand` as an addressable `core.record` extension:

- brand ID/public `br_` ID must be the same identity as its record envelope;
- for a brand row, `brand_id = id`, `scope_key = id`, and workspace matches across envelope/typed row;
- name, short name, logo reference, color, icon, description, operational status, timezone, sensitivity, notification-content mode, created/updated/version fields;
- case-insensitive active/non-purged name uniqueness within a workspace;
- the accepted composite deferrable FK from typed row to the envelope;
- tenant FK, `FORCE RLS`, indexes, lifecycle predicates, and registered Phase 1F containment/purge/projection hooks.

Implement typed brand settings rather than an unrestricted JSON dumping ground:

- weekly working-hours rules with local weekday/time ranges and explicit brand timezone;
- calendar foundation containing display/default working-calendar metadata only—not external connections or mirrored events;
- goals/priorities text or structured ordered entries with validation and bounded sizes;
- reserved, schema-versioned namespaces for later notification, AI, and integration owners; 1C must not write opaque future settings into them.

Add the Phase 1C foreign keys and consistency constraints explicitly deferred by 1F, including brand references from core records/batches where the owning brand exists. Ensure workspace-scoped records remain valid with `brand_id = NULL`.

## Tenant and brand authorization

Implement a narrow Phase 1C authorization compiler using canonical actions and the bootstrap owner membership. It must be designed for Phase 1D extension, not hard-coded route checks.

- Resolve the authenticated account to one active membership in the workspace selected from the URL/path or signed context—not request bodies.
- Every tenant request runs in exactly one workspace transaction and sets the membership/principal context from trusted server lookup.
- Workspace creation is the only authenticated platform-scope tenant-creation command.
- Bootstrap owners may manage their workspace and its non-sensitive brands.
- Creating a brand creates an explicit manage grant/owner authority for its creator in the same transaction, particularly so a brand can safely become sensitive.
- Sensitive brands do not rely on implicit owner/admin access. Reads and writes require the explicit creator/brand grant accepted in 0C.
- All-brands scope means the union of brands currently authorized for that membership. It is never a wildcard database context and never bypasses sensitive-brand restrictions.
- Archived brands remain readable to authorized viewers but are excluded from default/all-brands active results and are writable only through allowed restore/comment exceptions.
- Purged or unauthorized brands resolve as the same `not_found` result. Do not leak existence through counts, errors, switcher order, settings, audit, recent context, timings, or public-ID resolution.

Do not implement custom roles or broad membership administration. Use canonical policy-decision objects; browser-supplied role or brand lists are untrusted.

## Workspace and brand services

Implement idempotent, audited commands with optimistic concurrency:

### Workspace creation and settings

- verified accounts only;
- validate timezone/locale/currency/week start against maintained canonical datasets or platform libraries;
- create workspace, owner membership/authority, permission epoch, defaults, audit event, security event, and optional first-brand continuation atomically;
- support safe update with `If-Match`/version semantics and per-field audit changes;
- settings changes that affect authorization or derived context bump the correct epoch;
- no workspace deletion, ownership transfer, subscription, billing, or arbitrary retention configuration in this phase.

### Brand creation and editing

- create the record envelope and typed brand row in one transaction;
- enforce name uniqueness under races;
- validate color/icon/short name/description and prevent active-content injection;
- create explicit creator manage authority and audit material changes;
- edit identity/settings through versioned commands; presentation-only client state is not audited as a brand mutation;
- sensitivity changes require the canonical step-up action and must never lock the acting creator out;
- brand status must not duplicate lifecycle state. Define exactly which status is operational metadata and which states use archive/trash.

### Archive and restore

- use Phase 1F commands/hooks; do not implement a second archive mechanism;
- archive the brand envelope and future contained records through registered containment only;
- archived brands disappear from the default switcher/all-active scope, integrations/automations later observe the lifecycle hook, and new runs will be blocked by later owners;
- restore reverses only the correct archive batch and keeps the same IDs/settings;
- concurrency and retries must be idempotent;
- deletion/trash/purge UI and public commands remain out of scope unless required solely for tested lifecycle hooks.

### Context selection

- expose a server-derived workspace/brand context endpoint with authorized active brands, optionally authorized archived brands for settings, and the current selection;
- persist a user's last selected context only as a preference owned by that account/membership and validate it on every use;
- stale, archived, revoked, sensitive-without-grant, cross-workspace, or malformed selections fall back safely to an authorized scope or require selection; never silently broaden to all brands;
- all-brands responses contain only authorized brands and an explicit scope kind. Counts and empty states are calculated from the same visibility set.

## API requirements

Use Phase 0D envelopes, public IDs, errors, pagination, idempotency, versions, and step-up. Provide coherent routes for:

- create/list/select/update workspace;
- create/list/read/update/archive/restore brands;
- read/update working hours, calendar foundation, and goals/priorities settings;
- retrieve current workspace/brand context.

Exact route names may follow existing conventions. Every workspace/brand identifier in public APIs is a public ID. Never expose UUIDs, membership internals, grant IDs, or permission compiler internals.

Collection filtering must happen before pagination and counts. Single-resource checks must use the same predicate. Cross-workspace and hidden-sensitive-brand results return non-disclosing errors.

## UI and onboarding vertical slice

Replace the Phase 1B placeholder with a working guided flow:

- after verification/sign-in, accounts with no membership see “Create workspace”;
- workspace form covers name and sensible locale/timezone/currency/week-start defaults that remain editable before submission;
- after workspace creation, prompt for the first brand; allow additional brands from settings;
- provide workspace settings and brand settings screens;
- provide a compact context switcher for one brand versus all authorized brands. Phase 1E will place/refine it in the final shell, so keep it reusable;
- provide brand cards/list with active/archived separation, identity preview, archive confirmation, restore action, settings summaries, and empty states;
- provide accessible working-hours editor with overlapping-range validation, timezone explanation, closed-day support, and keyboard operation;
- provide bounded goals/priorities editor without pretending Phase 5 goals exist;
- surface sensitive-brand consequences before confirmation and require step-up where prescribed.

Cover initial/loading/submitting/success/empty/validation/conflict/offline/retry/forbidden/not-found/stale-version states. Preserve entered values after recoverable errors. Meet 0E desktop, tablet, 320px mobile, 200% zoom, reduced-motion, forced-colors/high-contrast, keyboard, focus, and screen-reader requirements.

Do not build the final global navigation, dashboards, projects, tasks, invitation UI, role management, or sample workspaces.

## Audit, lifecycle, and observability

- Every material workspace/brand/settings/context-authority mutation writes a valid same-transaction audit event. Security-sensitive changes also write security events.
- Register real brand lifecycle/purge hooks with Phase 1F. A future brand purge must fail safely until all contained domain modules register their hooks; do not claim full brand purge support now.
- Activity projections and account security activity must not leak brand/workspace data to unauthorized accounts.
- Add bounded metrics for workspace/brand command outcomes, tenant-context failures, RLS denials, authorization decisions by outcome/reason class, archive/restore, and context fallback. No workspace, brand, membership, account, public ID, name, timezone, or content labels.
- Propagate request/correlation/operation context without logging customer settings or names.
- Add privacy-safe health/readiness checks for required schema/policy state; do not reveal tenant counts or identifiers.

## Required isolation and security tests

Use at least three workspaces, multiple brands per workspace, two separate account owners, sensitive and archived brands, and reused pooled connections. Prove:

- a user cannot list/read/write/count/select/archive/restore another workspace or its brands through API, service, direct app/worker DB roles, guessed public IDs, cursor reuse, stale URLs, or context manipulation;
- unset/wrong tenant context fails closed and pooled context never leaks;
- changing body/query/header workspace or membership claims cannot override server-derived path/session context;
- ordinary owner visibility includes authorized non-sensitive brands but sensitive brands require explicit grants;
- all-brands union excludes unauthorized, sensitive-without-grant, archived-by-default, trashed, and purged brands from rows and counts;
- brand-scoped versus workspace-scoped record predicates behave distinctly;
- same brand names are allowed across workspaces but race-safe uniqueness holds within one workspace;
- creating a workspace twice with one idempotency key creates one workspace/membership;
- creator authority and last-owner protection survive retries and concurrent requests;
- lifecycle operations preserve IDs, audit truth, settings, and exact archive batches;
- public responses/logs/errors never expose internal UUIDs or hidden brand/workspace existence;
- account-only identity/security endpoints remain platform scoped and tenant data never appears there.

Include SQL `EXPLAIN` tests for representative workspace/brand list predicates and indexes. Add concurrency tests for duplicate workspace submission, duplicate brand names, concurrent settings versions, sensitivity transition, archive/restore, and stale context selection.

## Additional required tests

- unit tests for normalization, IANA timezone/locale/currency/week start, brand presentation fields, working-hours overlaps, context fallback, and policy compilation;
- real-PostgreSQL migration up/down/checksum, FK, RLS, role/grant, composite-envelope, and lifecycle-hook tests;
- same-transaction audit rollback and classified-change tests;
- API tests for every route and safe error;
- browser tests for account → workspace → first brand onboarding, second/third brand creation, settings, switcher/all-brands, sensitivity step-up, archive/restore, conflict/offline states, desktop/mobile, and accessibility;
- all existing identity, audit, lifecycle, buffer, recovery, scanning, process, and production-image gates.

## Non-goals

- Invitations, guests, membership management, teams, full built-in/custom roles, effective-permission preview, or ownership transfer (1D).
- Final shell, navigation, favorites, history, themes, or command palette (1E).
- Project/task/document/file business records or final cross-brand record sharing.
- Connected calendars, holidays, time off, capacity calculation, goals objects, AI configuration, integrations, or notification rules.
- Brand deletion/purge product flow, workspace/account deletion, billing/read-only transitions, or retention/legal-hold administration.
- A production file/object-storage, email, OAuth, ledger, or hosting provider.

## Acceptance criteria

- A verified account can create one workspace and three brands through accessible responsive UI, configure their identity/settings, and switch between each brand and an authorized all-brands scope.
- Workspace creation atomically establishes one canonical protected owner membership/authority without introducing a parallel permission model.
- Sensitive and archived brands behave according to accepted policy and never leak through all-brands results.
- Database RLS, foreign keys, composite envelope constraints, server authorization, API filtering, audit, and tests independently enforce tenant/brand separation.
- Brand archive/restore uses Phase 1F and preserves identity/settings/audit truth.
- Working-hours/calendar and priorities foundations are useful but do not prematurely implement later modules.
- No full 1D or 1E feature is smuggled into this phase.
- Phase 0 validation, generated contracts, all real-PostgreSQL tests, browser/accessibility suites, scans, and production-image smoke pass with no skipped gate.

## Required completion response

Return:

1. Outcome summary and exact dependencies/versions changed.
2. Every changed file and migration.
3. Workspace, membership-foundation, brand, setting, FK/RLS, envelope, and lifecycle-hook design.
4. Bootstrap-owner and authorization compiler behavior, including the exact Phase 1D handoff.
5. API and UI flows, context selection/fallback, sensitive/archived behavior, and deferred functionality.
6. Isolation matrix and automated test counts by unit, database/integration, concurrency, browser/accessibility, and security category.
7. Query-plan/index evidence for critical visibility paths.
8. Clean verification command, exit status, immutable CI run/commit, PostgreSQL image, production-image digest/size/non-root evidence, scans, and confirmation of zero skipped gates.
9. Any deviation, limitation, unresolved product decision, or failed/skipped gate.

Do not report Phase 1C complete if workspace authority is inferred outside canonical membership, all-brands behaves as a wildcard, sensitive brands rely on implicit owner access, archived brands appear in default active scope, brand lifecycle bypasses Phase 1F, or any acceptance gate is skipped.
