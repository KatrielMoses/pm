# Developer Brief — Phase 0C: Authorization and Policy Model

## Objective

Define the complete authorization and policy architecture for the multi-tenant, multi-brand SaaS application. The result must provide one server-side decision model that every read and write surface can use: application UI, API, search, exports, notifications, reports, AI retrieval, agents, automations, integrations, webhooks, background jobs, and administrative/support tools.

The model must be secure by default, compile into efficient PostgreSQL query predicates, preserve the accepted hidden-data rules, and remain understandable enough to preview a user's effective permissions before changes are applied.

This is an architecture-contract brief. Do not implement application code, migrations, or production policies.

## Read first

- `FEATURES.md`
- `BUILD_ROADMAP.md`
- `ROADMAP_CHECKLIST.md`
- all accepted files under `docs/product/`, `docs/ux/`, and `docs/architecture/data/`;
- especially the Phase 0B blockers DQ-01 through DQ-08 in `docs/architecture/data/13-open-questions.md`.

Treat recorded decisions in `ROADMAP_CHECKLIST.md` as approved. Do not edit `BUILD_ROADMAP.md` or mark checklist items complete. If the accepted contracts conflict, document the contradiction and propose the narrowest safe amendment.

## Required deliverables

Create a coherent authorization architecture under `docs/architecture/access/`. Include a README with reading order and links. Provide machine-readable matrices or policy definitions where they improve validation.

### 1. Security model and authorization invariants

Define non-negotiable invariants, including:

- deny by default;
- every request is evaluated inside one workspace tenant context unless it is an explicitly privileged platform operation;
- tenant isolation is mandatory before all finer authorization;
- access is never inferred from IDs, URLs, relationships, mentions, notifications, search indexes, cached projections, or ownership labels;
- relationships never grant access;
- all-brands views aggregate authorized records and own no data;
- inaccessible records, brands, relationships, counts, types, snippets, derived conditions, and related metadata are omitted;
- authorization applies before data contributes to counts, calculations, recommendations, AI context, exports, or notifications;
- no client-side permission check is a security boundary;
- ownership is a responsibility field, not an implicit access grant;
- permission grants cannot exceed the granting principal's own grantable authority;
- revocation takes effect promptly across sessions, caches, jobs, and external access paths.

Document trust boundaries and likely failure modes.

### 2. Principals, actors, and execution identity

Define authorization identity for:

- account, workspace membership, guest, team/group, and service/support operator;
- API token and OAuth client/connection;
- integration connection and inbound webhook identity;
- automation definition and automation run;
- AI action running on behalf of a human;
- internal/external agent profile, agent assignment, agent run, and tool invocation;
- background/system jobs;
- public/anonymous access as a disabled-by-default future principal class.

Distinguish the authenticated principal, initiating human, effective actor, tool/service identity, delegated scope, and audit actor. Define impersonation/support access rules so platform support cannot silently become a customer user.

### 3. Roles, actions, and capabilities

Define default roles:

- owner;
- administrator;
- member;
- limited member;
- guest;
- read-only.

Define custom-role extension points without requiring launch implementation on every plan.

Create an action vocabulary covering at minimum:

- create, read, update, archive, restore, delete, purge;
- comment, follow, assign, delegate, relate, upload, download;
- share, export, invite, manage membership, and transfer ownership;
- approve, reject, verify, release, unlock, and self-approve;
- configure workflows, fields, views, templates, notifications, AI, agents, automations, integrations, API/webhooks, security, retention, billing, and feature availability;
- execute AI, agents, automations, integrations, imports/exports, tests, and production/release actions;
- view audit, usage/cost, billing, secrets metadata, health, and administration.

Separate record permissions, administrative capabilities, execution permissions, and tool/action permissions. A role label alone must not be the policy algorithm.

### 4. Scope hierarchy and effective-permission algorithm

Define how grants and restrictions combine at:

- workspace;
- brand;
- project;
- individual record;
- document/view/field/integration scopes;
- explicit cross-brand share;
- team membership;
- personal records.

The effective-permission model must compile to SQL predicates over scope keys for list/search/report queries. Specify inheritance, grant precedence, explicit restrictions, restricted/sensitive brands and projects, record grants, expiration, revocation, and conflicts.

Prescribe these decisions:

- brand grants normally flow to non-restricted projects in that brand;
- a project may be `restricted`, in which case brand access alone is insufficient and an explicit project grant is required;
- explicit record grants add only the named record; they never traverse relationships;
- cross-brand shares include only records individually selected at share time and never future children;
- narrower restrictions can remove inherited access for sensitive brands/projects or fields;
- deny/restriction wins over an inherited allow at the same or broader path; platform tenant isolation can never be overridden;
- owner status does not silently bypass explicit sensitive-scope policy—define the controlled emergency/admin path if one exists.

Provide pseudocode and SQL-predicate examples for single-record checks and paginated list queries. Do not rely on application-side post-filtering for ordinary collections because it breaks counts and pagination.

### 5. Default permission matrix

Create a machine-readable and rendered matrix crossing default roles with actions and scope levels. Cover at minimum:

- workspace and brand administration;
- projects, tasks, comments, documents, files, deliverables, goals, views, reports, and time;
- membership, teams, guests, sharing, and exports;
- approvals and reviews;
- AI retrieval/action, agents/tools, automations, integrations, API tokens, and webhooks;
- testing, defects, environments, releases, and production actions;
- audit, security, sessions, retention, deletion, billing, and ownership transfer.

Identify permissions that are always non-delegable, permissions limited by plan entitlement, and actions requiring step-up authentication or a second approval.

### 6. Guest, read-only, sharing, and public-link policy

Define:

- guest access only to explicitly shared records;
- no implicit workspace directory, all-brands, brand, parent, child, or relationship visibility;
- read-only versus comment/edit share levels;
- share creation, expiry, revocation, onward-sharing prohibition, and recipient validation;
- attachment, comment, mention, search, notification, export, and AI behavior on shared records;
- what happens when a share's source record moves, archives, trashes, restores, or purges;
- authenticated guest project views as the launch-safe behavior;
- public unauthenticated links as disabled by default and a separately threat-modeled future capability.

The permission-safe not-found behavior must not distinguish nonexistent from unauthorized resources.

### 7. Field, secret, and derived-data authorization

Define field-level rules for visibility, editing, export, search indexing/snippets, formulas/calculated fields, audit display, conflict payloads, activity, notifications, AI retrieval, and API serialization.

Prescribe:

- outputs derived from a hidden field are hidden unless they have a separately reviewed disclosure-safe policy;
- conflict responses never return a current value the caller cannot read;
- search snippets and highlights are generated only from readable fields;
- logs, errors, exports, prompts, and audit display never reveal secret values;
- credentials live outside ordinary application records and are never readable after storage;
- sensitive notification channels may use minimal content;
- permission previews explain effective access without exposing restricted records.

### 8. Search, reporting, notifications, and cache safety

Define how authorization is enforced at query/delivery time for:

- full-text and future semantic search;
- dashboards, counts, facets, metrics, capacity, and portfolio rollups;
- activity feeds and recent/favorite items;
- in-app, email, browser, and digest notifications;
- saved/shared views and report delivery;
- SSE change notices and other live updates;
- cached derived conditions and projections.

Authorization decisions must not be copied into long-lived projections as the source of truth. Revocation should not require reindexing before access disappears. Define cache keys/invalidation and when caching authorization decisions is forbidden.

Anonymous free/busy disclosure remains off by default. A user's own availability remains visible to that user; colleagues see only commitments they are authorized to read unless a future explicit free/busy policy is approved.

### 9. AI, agent, automation, and integration delegation

Define least-privilege execution rules:

- AI action scope = initiating human access intersected with the explicitly selected context;
- agent run scope = agent-profile grants ∩ assigner access ∩ assignment scope at start, then re-evaluated on every tool call so access can only shrink;
- automation run access derives from its configured service principal and trigger scope, never from whichever user happens to view it;
- integration access is limited to configured workspace/brand scopes and provider scopes;
- API tokens have explicit granular scopes, expiry/rotation/revocation, and cannot exceed the creator's grantable authority;
- background jobs carry a durable workspace and effective-principal context;
- execution-layer permissions are separate from record-read permissions;
- external messages, publishing, spending, access changes, destructive actions, production changes, and scope expansion require the configured approval class;
- agents cannot approve their own output.

Define scope snapshots for audit/reproducibility and live rechecks for safety. Revocation wins over a historical snapshot.

### 10. Approval, self-approval, and separation of duties

Resolve the solo-founder case without weakening team evidence:

- human self-approval may be enabled by workspace policy;
- default it on only while exactly one approval-capable human belongs to the workspace and default it off when two or more exist;
- always label and audit self-approval;
- agents, automations, integrations, and AI can never approve their own output;
- production, security, billing, ownership-transfer, purge, and other high-risk actions may require step-up authentication or an independent approver where the plan/policy supports it;
- approval authority is evaluated at decision time, not only request time.

Create an action-risk classification that Phase 8D and Phase 9D can reuse.

### 11. Trash, archive, retention, and departed-user access

Resolve Phase 0B DQ-08:

- Trash visibility and restore authority use the viewer's current effective permission, not permission as of deletion;
- workspace administrators with explicit trash-management capability may inspect/restore within their authorized scope;
- guests do not receive Trash access merely because a record was formerly shared;
- archive does not change authorization, but archived records are excluded from ordinary views;
- purge, legal holds, workspace deletion, and account deletion require distinct capabilities and audit;
- ownership is reassigned when members leave, sessions and tokens are revoked promptly, and departed users retain no access.

### 12. PostgreSQL RLS and application policy responsibilities

Resolve Phase 0B DQ-03 with a defense-in-depth design:

- use transaction-local tenant context and `FORCE ROW LEVEL SECURITY` on tenant tables where operationally compatible;
- RLS guarantees workspace isolation, not the complete brand/project/record policy;
- application query compilation enforces fine-grained authorization and field filtering;
- ordinary application and worker roles cannot bypass RLS;
- cross-tenant maintenance/support jobs use a separate tightly controlled role and explicit workspace iteration, never an unset wildcard tenant;
- connection pooling must set and clear tenant context transactionally and must test against context leakage;
- migrations and restore tooling use separate operational identities with audited access.

Document limitations, failure modes, test strategy, and how background workers operate safely.

### 13. Permission changes, exposure preview, and revocation

Define workflows for:

- previewing effective permissions for one user/team/service principal;
- warning before a role, grant, team, share, field, or project restriction exposes existing content;
- explaining why access is granted without revealing inaccessible ancestor/sibling data;
- revoking shares, memberships, sessions, tokens, connections, agent runs, and queued jobs;
- ownership transfer and last-owner protection;
- immutable audit/security events for material permission changes;
- permission-version or epoch mechanisms for cache invalidation and live execution rechecks.

Revocation must affect new reads immediately and in-flight external effects as far as safely cancellable. Already-sent external content cannot be recalled silently; record that limitation.

### 14. Threat model and verification matrix

Create an abuse-case/threat model and an automated authorization-test matrix covering at minimum:

- cross-workspace ID substitution;
- cross-brand traversal through parents, children, dependencies, mentions, activity, notifications, files, exports, search, AI, reports, and APIs;
- hidden counts/snippets/timing/error differences;
- restricted projects inside visible brands;
- revoked or expired shares/tokens/sessions;
- team membership changes;
- field-level leaks through formulas, conflicts, history, export, or AI;
- background-job and cache authorization staleness;
- guest escalation and onward sharing;
- agent/tool scope expansion and confused-deputy attacks;
- webhook/integration spoofing;
- support/admin misuse;
- owner transfer and departed-member access;
- RLS context leakage through pooled connections.

The test matrix must identify principal, scope, action, expected allow/deny, expected response shape, and every secondary surface that must remain silent.

### 15. Decisions and unresolved questions

Record authorization decisions as ADRs with alternatives and consequences. Explicitly resolve Phase 0B DQ-01 through DQ-08 using this brief's prescribed rules.

Maintain a small unresolved register grouped into:

- blockers for Phase 0D;
- decisions safely deferred to the owning implementation phase;
- legal/commercial/public promises requiring product-owner approval.

Do not reopen settled tenant-isolation or hidden-metadata decisions merely because a less secure UX is more convenient.

## Architecture constraints

- The effective authorization function is server-side and shared conceptually by every surface.
- Ordinary list queries must be permission-filtered in SQL before pagination, aggregation, and sorting.
- Tenant isolation is structural and cannot be granted around.
- Authorization cannot depend on trusting client-supplied workspace, brand, role, price plan, approval, or actor fields.
- Plan entitlements limit available capabilities but never grant data access.
- Search, AI, exports, notifications, integrations, and agents cannot have a broader read path than the application.
- Public links and support impersonation remain disabled by default.
- Do not store readable credentials or secret values in permission records.

## Non-goals

- Do not implement authorization middleware, SQL migrations, RLS policies, UI, or tests.
- Do not define public API envelopes; Phase 0D owns them.
- Do not choose identity, secrets, or support-tool vendors.
- Do not promise enterprise compliance certifications or legal retention periods.
- Do not design a bespoke policy language when a clear capability/grant model suffices.
- Do not alter the roadmap or mark the checklist complete.

## Acceptance criteria

- Default roles and all required action classes have an explicit, machine-readable matrix.
- The effective-permission algorithm handles workspace, brand, restricted project, record share, team, personal, and field scopes without post-filtering ordinary list results.
- Guests see only explicitly shared records; selected children are fixed at share time.
- Restricted endpoints and derived metadata remain absent across every read surface.
- Field-level restrictions propagate to conflicts, formulas, search, audit display, notifications, exports, and AI.
- AI, agents, automations, integrations, tokens, and jobs have explicit delegated identities and bounded scopes.
- Revocation and permission-cache invalidation are defined.
- RLS responsibilities and limitations are realistic and safe with pooled connections and workers.
- DQ-01 through DQ-08 are explicitly resolved.
- The threat model and test matrix cover both direct and inference-based leaks.
- Internal links and any machine-readable policy artifacts validate with a repeatable command.

## Required completion response

Return:

1. A concise authorization architecture summary and the most consequential decisions.
2. Every file created or changed.
3. Principal types, default roles, action count, capability count, and permission-matrix dimensions.
4. Effective-permission algorithm and SQL-filtering summary.
5. Resolutions for DQ-01 through DQ-08.
6. RLS, cache/revocation, field-security, and execution-delegation strategies.
7. Threat/test coverage counts and validation commands with complete results.
8. Any contradiction found in accepted Phase 0A/0B/0E contracts.
9. Open questions grouped by whether they block 0D or may wait for implementation.

Do not merely state that the work is complete; provide reviewable evidence.
