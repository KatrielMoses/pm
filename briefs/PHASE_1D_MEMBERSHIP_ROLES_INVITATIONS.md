# Developer Brief — Phase 1D: Membership, Roles, and Invitations

## Objective

Turn the single-owner tenancy foundation into a secure collaboration system. Workspace owners and authorized administrators must be able to invite and manage internal members and tightly scoped guests, create teams, assign built-in roles and scope grants, preview effective permissions, transfer ownership safely, and remove access immediately without losing owned work or leaking hidden scopes.

Extend the canonical Phase 1C tables, resolver, policy compiler, epochs, audit pipeline, and lifecycle integration. Do not create a parallel membership or authorization system.

## Read first

- `FEATURES.md` and requirement catalog entries COL-001 through COL-004, PERM-001 through PERM-006, PERM-011 through PERM-014, and ADM-013;
- `BUILD_ROADMAP.md`, `ROADMAP_CHECKLIST.md`, and all accepted Phase 0 contracts;
- the complete 0C authorization package, especially principals, roles/actions, effective permissions, guests/sharing, revocation, approvals, trash, threats, and SQL compilation;
- 0B tenancy/access entities: membership, team, team_member, invitation, ownership_transfer, role, role_assignment, share_group, record_grant, permission_epoch, and workspace_policy;
- Phase 1B sessions/step-up; Phase 1F audit/lifecycle; Phase 1C ADR-0010 and its exact nine-item 1D handoff.

Run the Phase 0 validator first and keep it green. Do not edit `BUILD_ROADMAP.md`, mark the checklist complete, implement paid custom roles, or push/commit unless the product owner asks.

## Requirement scope

Complete:

- COL-001 invite members by email;
- COL-002 invite guests with limited access;
- COL-003 teams/groups;
- COL-004 workspace and brand role assignment foundations, plus generic project/record grant primitives ready for later record modules;
- PERM-001 all six built-in roles;
- PERM-003 and PERM-004 canonical scope/action enforcement foundation;
- PERM-005 guest access only to explicitly shared records;
- PERM-006 sensitive-brand restriction and restricted-scope extension points;
- PERM-011 effective-permission preview;
- PERM-012 pre-change exposure warnings;
- PERM-013 immediate access/session revocation contribution;
- PERM-014 ownership preservation on departure;
- ADM-013 ownership-transfer flow and last-owner safety foundation.

Foundation only:

- Project/document/field/integration scopes have schemas and compiler interfaces, but their concrete owning records arrive later.
- Explicit cross-brand sharing uses `share_group` plus one fixed `record_grant` per selected record. Test with registered foundation fixtures and brands; do not invent future business records or implicit descendants.
- Custom roles remain an entitlement-gated Phase 10C feature. Preserve the schema/validator extension point but expose no creation UI/API.

## Canonical data model and migrations

Add ordered expand migrations after 0018. Extend, never replace, Phase 1C tables.

### Memberships and invitations

Extend `tenancy.membership` only where the accepted model requires additional state/revocation metadata. Preserve IDs and bootstrap ownership. Enforce:

- one membership per `(workspace, account)`;
- kind `member|guest` and state `invited|active|suspended|removed` with guarded transitions;
- removed/suspended principals cannot regain authority through stale assignments, teams, sessions, jobs, streams, tokens, or cached epochs;
- guests cannot receive workspace/brand/project role assignments—only fixed record grants;
- no deletion of membership history that audit/ownership references.

Create `tenancy.invitation` with public ID, workspace, normalized invited email, intended membership kind and built-in role, explicit brand/record scope proposal, inviter, state, expiry, resend/supersession lineage, accepted account/membership, timestamps, version, and safe delivery metadata. Store raw invitation tokens only through the Phase 1B hashed token/vault boundary. Add `invitation_acceptance` to the canonical identity token purpose if it is not already present, at the authoritative source and generated contracts.

Invitation state must be a guarded state machine such as `pending → accepted|revoked|expired`, with resend superseding earlier tokens safely. Acceptance is single-use, race-safe, and atomically creates or activates the membership and assignments/grants.

### Roles, assignments, policy, and epochs

Use the existing built-in role rows and `access.role_assignment`. Add only the column-scoped grants required for managed transitions. Maintain:

- exactly one active workspace role per active internal membership;
- grantable-authority checks: an administrator cannot create another owner, and no assigner can grant authority they do not possess;
- owner-only/non-delegable action invariants;
- expiry/revocation/elevation metadata for scope assignments;
- sensitive brands always requiring explicit grants;
- every authority-affecting mutation atomically bumping the correct workspace/principal epoch.

Create `access.workspace_policy` with the accepted typed fields and secure defaults, including guest-invitation, member-invites-guests, sharing, archived-comment, default workspace-record access, and related policy toggles. Do not add public links. Policy changes use the canonical action, step-up where required, exposure analysis, epochs, audit, and security events.

### Teams and sharing

Implement `tenancy.team` as an addressable `core.record` extension and `tenancy.team_member` with canonical workspace FKs, RLS, lifecycle, audit, and purge hooks. Teams may span brands but never act as scopes themselves.

Implement `access.share_group` and `access.record_grant` exactly as accepted:

- one explicit row per record selected at share time;
- no automatic descendants, future children, relationships, or inferred related records;
- grantee is membership, team, or eligible brand context;
- guest shares target fixed records only and cap at edit;
- active uniqueness, expiry, revoke facts, source brand, creator, and group lineage;
- both endpoints of every later relationship remain independently authorized;
- RLS backstop plus indexes supporting record lookup and “shared with me” semi-joins.

Add only generic grant primitives and fixture-backed tests. Product sharing UI for tasks/projects/documents will be integrated by their owning phases.

### Ownership transfer and departure registry

Implement `tenancy.ownership_transfer` as an immutable/locked request and acceptance state machine. The recipient must be an active internal member, accept explicitly, and satisfy step-up. Transfer atomically adds owner authority and optionally changes the previous owner to administrator only after last-owner invariants remain true.

Create a reusable ownership/departure hook registry. Every module with an accountable owner must later register how it reassigns or suspends owned resources. In this phase register existing applicable foundations. Member removal must fail safely with an actionable ownership plan if any registered owner-bearing object cannot be reassigned or suspended.

## Invitation and acceptance flows

- Owners may invite any supported role; administrators may invite administrator/member/limited/read-only/guest but never owner; members may invite guests only if workspace policy allows; others cannot invite.
- Invitation creation is enumeration-safe and idempotent. Existing active members, pending invitations, removed memberships, and unknown emails produce safe, policy-correct outcomes without leaking account existence to unauthorized callers.
- Delivery uses the existing durable mail/outbox adapter, with invitation templates and no tenant/customer secrets in logs.
- The invitation link carries only an opaque single-use token in the fragment pattern established by 1B.
- An unauthenticated recipient is directed through registration/verification or sign-in. Acceptance requires the authenticated verified account's normalized email to match the invitation; do not auto-link or reveal another account.
- Resend, revoke, expiry, already-used, changed-email, concurrent acceptance, and inviter/member departure states are explicit and tested.
- Guest invitations must include at least one explicit record share proposal and can never create broad workspace/brand authority. If no shareable record exists yet, the UI explains that guests can be invited from a specific record later; do not grant empty implicit access as a workaround.
- Seat/billing enforcement remains provider-neutral and deferred where OD-44 is unset; expose an entitlement/limit hook that can deny before mutation without inventing plan numbers.

## Effective-permission compiler

Extend the Phase 1C compiler to implement the full accepted algorithm for currently available scopes:

- principal context includes active membership, role, teams, assignments, record grants, workspace/principal epochs, role cap, and workspace policy;
- workspace access never flows into brands;
- non-sensitive owner/admin implicit brand manage; sensitive brands require explicit grants;
- scope grants flow only down actual containment and stop at restrictions;
- record grants apply to that exact record only;
- role cap applies last; guests use share level capped at edit and have no aggregation/directory/trash access;
- lifecycle, expiry, revocation, step-up, approval, entitlement, and delegation gates occur in the accepted order;
- unreadable results are `not_found`; readable-but-insufficient results may be `forbidden`;
- all list/count/facet/single/write checks reuse the same compiled predicate.

Do not implement a generic “is admin” bypass. Application, worker, search, future AI, and future agent consumers must use the same decision/predicate contract.

## Membership, role, team, and grant commands

Provide idempotent, optimistic, same-transaction audited commands for:

- list/invite/resend/revoke invitations;
- list/read/suspend/reactivate/remove memberships;
- change built-in workspace role;
- grant/revoke brand access and future-scope assignments;
- create/edit/archive/restore teams and add/remove team members;
- create/revoke/expire explicit record shares;
- preview a proposed permission change before applying it;
- preview effective permissions for a selected member on workspace, brand, and fixture-backed record targets;
- request/accept/cancel/expire ownership transfer.

High-risk membership management, owner elevation/demotion, sensitive access, sharing-policy changes, and ownership transfer use the canonical step-up protocol bound to session, membership, workspace, action, target, and idempotency key.

Every permission-changing command must:

1. load the target through the current visibility predicate;
2. verify grantable authority and last-owner rules;
3. compute an exposure/revocation diff before mutation;
4. require explicit confirmation when existing content becomes newly visible or access is broadly removed;
5. mutate canonical rows;
6. bump epochs;
7. write audit and security events;
8. enqueue content-safe notifications/hooks for Phase 4B without requiring that module now.

## Immediate revocation and departure

On suspension/removal, in one logical operation with safe checkpoints where cross-module work is necessary:

- membership authority becomes inactive and principal epoch increments immediately;
- subsequent requests and SSE authorization checks fail on the next check;
- revoke all account sessions as required by the accepted departure contract, plus personal tokens/OAuth consents when those modules exist;
- cancel queued jobs whose effective principal is that membership and stop future scheduled output for it;
- remove team memberships and revoke/expire grants held solely by that membership as policy specifies;
- reassign or suspend owned resources through registered hooks; never leave required ownership null;
- preserve creator/actor history as a former member without exposing personal data beyond policy;
- schedule personal-scope deletion through retention hooks, with no administrator export unless a future explicitly approved capability exists.

Already-sent external content cannot be recalled; record this honestly. Tests must prove stale cookies, cached decisions, queued jobs, and reused DB connections cannot retain access.

## Permission preview and exposure warnings

Build one server-side explanation engine used by both preview UI and enforcement tests. It returns public, display-safe reasons—not policy internals or hidden-record existence.

- Effective-permission preview is available only to authorized managers and only for scopes they may inspect.
- Show role/cap, explicit scope grants, team contributions, sensitive/restricted boundaries, fixed record shares, expiry, lifecycle gates, and final effective levels/actions.
- Hidden scopes/records are omitted rather than shown as denied.
- Proposed-change preview compares before/after authorization using the same compiler and returns counts/categories of newly visible or revoked content. Do not enumerate hidden content the caller cannot see.
- Applying a preview requires a short-lived signed preview fingerprint or recomputation under lock; stale previews produce conflict and require review again.

## API and UI deliverables

Use Phase 0D envelopes, public IDs, idempotency, ETags, cursors, safe errors, and step-up. Provide coherent workspace routes for people, invitations, teams, built-in roles, brand access, permission preview, record-share primitives, and ownership transfer.

Extend the current workspace UI with accessible responsive screens for:

- People: members/guests, roles, status, invited/pending, safe search/filter, actions and empty states;
- invite flow with role/scope explanation, resend/revoke, expiry, and guest limitations;
- invitation acceptance journey through sign-in/registration/verification;
- teams and membership management;
- built-in role and brand-access assignment;
- effective-permission preview and proposed-change exposure warning;
- member suspension/removal with ownership reassignment/suspension plan;
- ownership-transfer request and recipient acceptance;
- current user's “leave workspace” only when last-owner and owned-resource checks pass.

Do not expose custom-role editing. Do not display emails or directory entries to guests. Lists, counts, autocomplete, errors, and cursors must be permission filtered.

Cover loading, empty, pending, accepted, expired, revoked, validation, conflict, step-up, approval-needed, offline/retry, forbidden/not-found, concurrent change, last-owner, and partial-background-cleanup states. Meet all 0E responsive/accessibility requirements.

## Audit, observability, privacy, and performance

- Every material invitation, membership, role, team, grant, share, policy, transfer, preview-application, and departure event is audited in the same transaction where applicable and emits required security events.
- Never audit invitation tokens, session credentials, full IPs, secret values, or unrestricted email content. Personal fields follow classified/redaction rules.
- Register all new bounded telemetry at the authoritative 0D source before use. No tenant/principal/record/email identifiers as metric labels.
- Add metrics for command outcomes, authorization decisions, invitation delivery/acceptance outcome class, revocation propagation, epoch staleness, and ownership-hook failures.
- Add query-plan tests for representative owner, administrator, member, limited member, read-only, guest, team-heavy, grant-heavy, and sensitive-brand principals. Filter before pagination/counts.
- Bound principal-context sizes; use the accepted temporary-table strategy above configured array thresholds and test both paths.

## Required security and isolation tests

Use at least three workspaces and all six roles. Prove:

- cross-workspace invitation, membership, team, role, grant, preview, and transfer reads/writes fail through API, services, app/worker roles, forged IDs, cursors, and reused connections;
- no body/header/query role, account, membership, workspace, brand, team, or permission claim overrides server context;
- administrators cannot assign owners or exceed grantable authority;
- last owner cannot be removed, suspended, demoted, leave, or delete the account;
- sensitive brands never become visible through implicit admin/owner access after explicit grants are revoked;
- guests see only explicitly granted records, no directory/brand aggregation/Trash, no children/parents/relationships/future records, and cannot reshare;
- teams add only their valid current grants; removing a member/team grant takes effect on the next check;
- expired/revoked invitations and grants cannot be replayed;
- permission preview matches actual enforcement before and after mutation;
- revocation invalidates sessions/caches/streams/jobs and prevents pooled-context leakage;
- audit/activity/errors/notifications/counts never disclose hidden scope or membership data.

## Required automated tests

At minimum:

- unit tests for role cells, grantable authority, effective-level precedence/caps, guest rules, invitation normalization/state, preview diff/fingerprint, epoch behavior, and ownership plans;
- real-PostgreSQL migration up/down/checksum, FK/index/RLS/grant/trigger/state-machine tests;
- integration and concurrency tests for duplicate/resend/accept invitations, role races, last-owner races, grant expiry/revocation, teams, preview/apply races, transfer acceptance, member departure, jobs, sessions, and epoch invalidation;
- API tests for every route and safe error/non-disclosure behavior;
- browser/accessibility tests for invitation sender and recipient journeys, people/teams/roles, preview/warning, removal, and transfer on desktop/mobile;
- Phase 0/generated drift checks covering new runtime actions/events/metrics/states;
- all existing identity, tenancy isolation, audit/lifecycle, browser, scans, Testcontainers, and production-image gates.

## Non-goals

- Paid custom roles and role builder (10C/10A).
- Final application shell/navigation (1E).
- Comments, presence, mentions, reactions, reviews, or notifications product (4A/4B/4D).
- Concrete project/document/field/integration permission UIs before those modules exist.
- Public links, anonymous access, guest directory access, or inherited guest access.
- Billing seat counts/prices, real entitlement plans, legal retention durations, or provider selection.
- Full account/workspace deletion.

## Acceptance criteria

- Owners can invite and manage internal collaborators; authorized users can accept safely; guests remain fixed-record-only.
- All six built-in roles and teams use the canonical compiler and grantable-authority rules.
- Permission changes show accurate, non-disclosing exposure previews and take effect immediately after application.
- Last-owner and ownership-preservation rules hold under concurrency and departure.
- Ownership transfer is explicit, step-up protected, accepted by the recipient, and auditable.
- Tenant/brand/record separation holds through RLS, compiled predicates, API filtering, counts, audit, jobs, and UI.
- No parallel membership/role/grant model or admin bypass is introduced.
- Phase 0 validation, generated contracts, full Testcontainers suite, browser/accessibility tests, scans, and production-image smoke pass without skips.

## Required completion response

Return:

1. Outcome summary and exact dependency/version changes.
2. Every changed file and migration.
3. Canonical membership/invitation/team/role/grant/share/policy/transfer schemas and Phase 1C handoff implementation.
4. Effective-permission algorithm, SQL predicate strategy, guest behavior, preview engine, and revocation propagation.
5. API/UI flows and explicit deferred work.
6. Test inventory/counts, isolation matrix, concurrency evidence, and query-plan evidence.
7. Clean verification command, exit status, immutable CI run/commit, PostgreSQL image, production-image digest/size/non-root result, scans, and zero-skipped-gate confirmation.
8. Any deviation, limitation, failed gate, or unresolved product decision.

Do not report Phase 1D complete if guests receive inherited scope access, permission preview differs from enforcement, revoked principals retain access past the next check, ownership can become empty, runtime actions/events/metrics are outside authoritative registries, or any acceptance gate is skipped.
