# Tenancy: workspaces, brands, context, and isolation (Phase 1C)

Decisions, deviations, and the exact Phase 1D handoff: [ADR-0010](adr/0010-workspaces-brands-isolation.md).
Package: `@pm/tenancy` (depends on contracts, config, observability, db, platform, audit, lifecycle,
identity). API routes: `apps/api/src/tenancy/routes.ts`. UI: `apps/web/src/pages/workspace-pages.tsx`,
`apps/web/src/tenancy/`.

## Data (migrations 0017, 0018)

| Object | Notes |
|---|---|
| `tenancy.workspace` (extended in place) | `logo_file_ref`, `creation_key_hash`, `creation_request_hash`, `bootstrap_account_id` (provenance only), `bootstrap_membership_id`; `app_rw` may UPDATE settings columns only |
| `tenancy.membership` | canonical; `(workspace_id, account_id)` unique; `mem_` public ID (never returned by 1C APIs) |
| `access.role` | per-workspace built-ins via `access.seed_builtin_roles()` |
| `access.role_assignment` | workspace roles and brand-scope grants; generated `membership_principal_id`, `brand_scope_id` |
| `access.permission_epoch` | `workspace` / `principal` / `agent_class`; monotonic trigger |
| `tenancy.brand` | `core.record` extension (`brand_id = id = scope_key`), mirrored lifecycle state |
| `tenancy.brand_setting` | typed settings + reserved namespaces (NULL) |
| `tenancy.scope_preference` | the person's last selection; validated on every read |
| `core.record`, `core.archive_batch`, `core.deletion_batch` | brand FKs (deferrable); CHECK `record_brand_self` |

All tables carry `workspace_id`, a RESTRICT FK to the workspace, forced RLS with
`tenant_isolation`, and FK-covering indexes. The catalog tests in `packages/db` and
`packages/platform` list them exactly. **Before applying 0017 to an existing cluster, re-run the
role bootstrap** (it creates `pm_directory`).

### Settings formats (schema_version 1)

- Working hours: `{"schema_version":1,"days":[{"weekday":1..7,"ranges":[{"start":"HH:MM","end":"HH:MM|24:00"}]}]}`.
  ISO weekdays, unique; at most 4 sorted, non-overlapping ranges with `start < end`. Closed days
  are omitted. Times are local to the **brand's** time zone, so changing the time zone keeps the
  local times.
- Calendar foundation: `week_start` (null = workspace default), `show_weekends`,
  `default_view ∈ week|month|agenda`, `label`. Metadata only; no events.
- Goals/priorities: at most 10 ordered `{kind: goal|priority, text ≤ 280}`. Planning notes, not
  tracked goals (5A/5D).

The database functions `tenancy.valid_working_hours/valid_calendar/valid_priorities` and
`packages/tenancy/src/validation.ts` implement the same rules.

## Request path

```
session (identity) ──► path /v1/workspaces/{ws_…}
        │
        ▼  platform scope, read-only
tenancy.resolve_membership(account, ws public id)   ── unknown / not a member → not_found
        │
        ▼  ONE workspace transaction (RLS context = workspace)
loadPrincipal: active membership bound to this account, workspace role, unexpired brand grants, epochs
        │
        ▼
policy compiler (decideWorkspace / decideBrand / brand visibility predicate)
        │
        ▼  mutations only
idempotency reservation (principal = membership) → change → audit (+ security event) → epoch bump → completion
```

A replay re-renders the stored reference through the caller's **current** authorization. Brand
reads always go through `findBrand` / `listBrands` / `countBrands`, which share one predicate.

## Authorization summary

| Action | Owner / admin | Member / limited | Others | Notes |
|---|---|---|---|---|
| `workspace.create` | — | — | — | 0C account command (AZ-18): the verified human account only, before any membership; gates: verified + active account (re-read), per-account rate limit, Idempotency-Key |
| `workspace.view_settings` | ✓ | ✓ | read_only ✓, guest ✗ | |
| `workspace.configure`, `brand.create` | ✓ | ✗ | ✗ | |
| `brand.configure` | ✓ non-sensitive; explicit `manage` on sensitive | `grant:manage` | ✗ | |
| `brand.archive` (archive + restore) | ✓ non-sensitive; explicit `manage` on sensitive | ✗ | ✗ | `If-Match` |
| `brand.mark_sensitive` | ✓ (same rule) | ✗ | ✗ | step-up, `If-Match` |

Unreadable brands are `not_found` everywhere: single reads, actions, context selection, settings,
cursors, and counts.

## API

| Method & path | Purpose | Controls |
|---|---|---|
| `GET /v1/workspaces` | own workspaces, `selected` flag | |
| `POST /v1/workspaces` | create (+ optional `first_brand`) | account command (AZ-18): Idempotency-Key, verified active account, per-account rate limit |
| `GET /v1/workspaces/{ws}` | workspace + capabilities | ETag |
| `PATCH /v1/workspaces/{ws}` | field-merge update | Idempotency-Key |
| `POST /v1/workspaces/{ws}:select` | `{scope: brand|all, brand_id}` or `{}` | CSRF |
| `GET /v1/workspaces/{ws}/context[?include_archived=true]` | server-derived scope | |
| `GET /v1/workspaces/{ws}/brands?state=active|archived|all&limit&cursor&include_total` | keyset page | filter before page/count |
| `POST /v1/workspaces/{ws}/brands` | create | Idempotency-Key |
| `GET`/`PATCH /v1/workspaces/{ws}/brands/{br}` | read / field-merge edit | ETag / Idempotency-Key |
| `POST …/brands/{br}:archive` · `:restore` | 1F lifecycle | Idempotency-Key, If-Match |
| `POST …/brands/{br}:set-sensitivity` | `{is_sensitive}` | Idempotency-Key, If-Match, Step-Up |
| `GET …/brands/{br}/settings` | settings + version | ETag |
| `PUT …/brands/{br}/settings/{working-hours|calendar|priorities}` | replace one namespace | Idempotency-Key, If-Match |

Only public IDs appear in responses (`ws_`, `br_`); a test scans every response body for UUIDs and
membership or grant internals.

## Context selection

`GET …/context` returns `{workspace, scope, fallback, brands[, archived_brands]}`:

- `scope.kind = all` lists `brand_ids` explicitly: the authorized active brands right now.
- `scope.kind = brand` is used when the stored brand is still authorized and active.
- Otherwise `fallback = stale_selection` (stored but unavailable: archived, revoked, now sensitive)
  or `no_selection`, and the scope narrows to the first authorized active brand by name, or
  `none`. It never broadens to all brands. `tenancy.context_fallbacks{reason}` counts these.

## UI

- `/onboarding`: accounts without a membership create a workspace (defaults from the browser,
  all editable); with memberships it redirects to the last-used workspace.
- `/workspaces/{ws}/first-brand` → `/workspaces/{ws}`: context switcher (`ContextSwitcher`,
  reusable for 1E), active and archived brand cards, restore.
- `/workspaces/{ws}/settings`; `/workspaces/{ws}/brands/new`; `/workspaces/{ws}/brands/{br}`:
  identity, working-hours editor, goals/priorities editor, sensitive marking (consequences →
  step-up), archive (confirmation starting on Cancel).
- States: loading, submitting, success (polite live region), empty, validation (summary + field
  errors, input kept), conflict (keep mine / use latest), offline, retry, forbidden,
  not-found (identical to no access), stale version.
- Browser tests (`e2e/tenancy.spec.ts`, desktop + mobile) cover the journey, axe at every step,
  keyboard, forced colors with reduced motion, 200% zoom and 320 px reflow. Component tests:
  `apps/web/test/tenancy.test.tsx`.

## Observability

Metrics, registered in the 0D telemetry registry (PL-19, area `tenancy`), bounded labels only:
`tenancy.commands{command,outcome}`,
`tenancy.authz_decisions{action_key,outcome}`, `tenancy.context_failures{reason}`,
`tenancy.context_fallbacks{reason}`, `tenancy.rls_denials{module}`. No workspace, brand,
membership, account, public ID, name, time zone, or content labels: these are 0D forbidden labels,
and `packages/observability/test/unit/registry-drift.test.ts` checks every runtime emission's
name, type, and labels against the registry. Readiness adds
`tenant_isolation` (catalog check: forced RLS + one `tenant_isolation` policy on every
tenancy/access tenant table, directory functions definer-owned by `pm_directory`).

## Tests

| Suite | Proves |
|---|---|
| `packages/tenancy/test/unit` | policy compilation from the 0C matrix, normalization (IANA/BCP 47/ISO 4217), presentation fields, working hours, priorities, If-Match and merge parsing |
| `packages/tenancy/test/integration/tenancy.test.ts` | atomic bootstrap, idempotent creation under races, last-owner protection, orphan-workspace refusal, field merge, name races, cross-workspace not_found, sensitive visibility, cursor binding |
| `…/lifecycle-context.test.ts` | archive/restore through 1F with containment cascade, concurrent archive and sensitivity, blocked brand purge, settings versions, context fallback, EXPLAIN index use |
| `…/isolation.test.ts` | 3 workspaces × owners, direct `app_rw`/`app_worker` SQL on a reused connection, forged references, directory scoping, readiness drift, union semantics, brand- vs workspace-scoped records |
| `…/account-command.test.ts` | AZ-18 gates: non-human principals, deleted/unverified accounts (re-read), per-account rate limit with free replays, body claims |
| Phase 0 validator | `workspace.create` registration, runtime authorization actions ⊆ 0C, brand vocabularies 0B = DB = runtime |
| `apps/api/test/integration/tenancy-api.test.ts` | HTTP: onboarding, ETags, replay, non-disclosing 404s, If-Match, real bound step-up, no internal IDs |

## Phase 1D collaboration

Decisions and deviations: [ADR-0011](adr/0011-membership-roles-invitations.md). Modules:
- `@pm/tenancy`: `collaboration.ts`, `visibility.ts`, `preview.ts`, `ownership.ts`, `account-commands.ts`;
- `apps/api/src/tenancy/routes.ts`;
- `apps/web/src/pages/people-pages.tsx`.

### Data (migration 0019)

| Object | Notes |
|---|---|
| `tenancy.membership` | `departure_reason`, `state_changed_by_membership_id`; guarded transitions (`invited→active`, `active⇄suspended`, `→removed`, `removed→active` only by re-acceptance); never deleted |
| `tenancy.team`, `tenancy.team_member` | Teams are `core.record` envelopes (workspace scope, lifecycle via 1F; no purge hooks); internal members only |
| `access.role_assignment` | Team principals (`team_principal_id`); teams never hold a workspace role; column-scoped UPDATE (`role_id`, `expires_at`) and DELETE for revocation |
| Role shape (deferred trigger) | Guests: no assignments, no teams. Active/suspended members: exactly one workspace role. Removed: no authority |
| `access.workspace_policy` | Typed 0C fields; a missing row means the safe defaults; `public_links_enabled` fixed false |
| `tenancy.invitation` | `inv_`; one pending per email; terms immutable; decided rows immutable |
| `access.share_group`, `access.record_grant` | `shr_` / `grt_`; one active grant per (record, grantee); 0B semi-join indexes |
| `tenancy.ownership_transfer` | `otr_`; one pending per workspace; immutable once decided |
| `core.record.owner_membership_id` | FK to membership (deferred from 1F) |
| identity | Token purpose `invitation_acceptance`; mail template `workspace_invitation` |

### Who may do what (1D actions)

| Action | Owner | Administrator | Member | Limited / read-only | Guest |
|---|---|---|---|---|---|
| Invite members (`membership.invite_member`) | any role | never owner | — | — | — |
| Invite guests (`membership.invite_guest`) | ✓ | ✓ | if `members_invite_guests` | — | — |
| Manage people (`membership.manage`, step-up) | ✓ (incl. owners) | ✓ except owners | — | — | — |
| Teams (`team.manage`) | ✓ | ✓ | — | — | — |
| Brand access (`access.grant_scope`) | ✓ ≤ own level | ✓ ≤ own level (non-sensitive) | with manage on the brand | limited: with manage | — |
| Preview (`access.preview`) | ✓ | ✓ | in brands they manage | limited: in brands they manage | — |
| Sharing policy (`sharing.policy.configure`, step-up) | ✓ | ✓ | — | — | — |
| Transfer ownership (step-up) | ✓ | — | — | — | — |
| Accept ownership (own, step-up) | — | own | own | own | — |
| Leave | own | own | own | own | own |

### API (all under `/v1/workspaces/{ws}` unless noted)

| Route | Purpose |
|---|---|
| `GET /people[?state&kind&q]`, `GET /people/{mem}` | Directory (internal members only; emails only for people managers and inviters) |
| `GET /people/{mem}/access`, `GET /people/{mem}/departure-plan` | Effective-access explanation; ownership plan |
| `POST /access:preview` `{change}` → `{diff, preview_token}`; `POST /access:apply` `{change, preview_token}` | Reviewed changes: `role`, `suspend`, `remove`, `brand_grant`, `brand_revoke`, `team_add`, `team_remove` (step-up for membership changes) |
| `POST /people/{mem}:remove` `{preview_token, reassign_to}`, `POST /people/{mem}:reactivate`, `POST /{ws}:leave` | Departure and reactivation |
| `GET/POST /invitations`, `POST /invitations/{inv}:resend\|:revoke` | Invitations |
| `POST /v1/invitations:inspect` `{token}`, `POST /v1/invitations:accept` `{token}` | Recipient (no workspace in the path; the account is the session) |
| `GET/POST /teams`, `GET/PATCH /teams/{team}`, `POST /teams/{team}:archive\|:restore` | Teams |
| `GET /brands/{br}/access` | Grants on a brand (people and teams) |
| `POST /shares`, `POST /shares/{shr}:revoke`, `GET /shared` | Record-share primitives; the caller's readable records |
| `GET/PATCH /policy` | Workspace policy (governing actions per field; `confirm_exposure`) |
| `GET/POST /ownership-transfer`, `POST /ownership-transfer/{otr}:accept\|:cancel` | Ownership transfer |

### Revocation propagation

| Event | Next check | In flight |
|---|---|---|
| Removal / leave | Principal resolution fails (`not_found`); every account session is revoked, so the next request is unauthenticated | Queued and leased jobs acting as the member are cancelled; `principalFreshness` returns `revoked` for deferred consumers |
| Suspension | Principal resolution fails | Jobs cancelled; sessions kept (the account may belong to other workspaces) |
| Role, grant, or team change | Compiled per request from canonical rows (no cross-request cache) | Epochs bumped; `principalFreshness` returns `changed` |
| Share revoke or expiry | Query-time predicate | — |

Contexts are rebuilt on every request, so there is no cross-request cache to go stale. Pooled connections carry only transaction-local context, as tested in the isolation suites.

### Tests (1D)

| Suite | Proves |
|---|---|
| `packages/tenancy/test/unit/policy-validation.test.ts` | grantable authority, cells, caps, guests, workspace scope, team grants, onward sharing, preview fingerprints |
| `…/integration/collaboration.test.ts` | invitation lifecycle (single-use, email-bound, race-safe, resend/revoke), six roles, guests, preview/apply, sensitive brands with teams, removal with ownership plan, sessions, last owner, transfer, policy |
| `…/integration/collab-isolation.test.ts` | three workspaces × six roles cross-tenant `not_found`, teams, expiry, preview = enforcement for every role, temp-table/semi-join/array equivalence, role and last-owner races, EXPLAIN per principal shape |
| `…/integration/account-command.test.ts` | `workspace.create` gates (AT-087…094) |
| `apps/api/test/integration/collaboration-api.test.ts` | HTTP journey with real mail and step-up, guests, transfer, no internal IDs |
| `e2e/collaboration.spec.ts` | sender and recipient journeys, people, roles, brand access, removal, teams, policy, transfer, accessibility, forced colors, reflow (desktop + mobile) |

## Phase 1E shell and personal navigation

Decisions and deviations: [ADR-0012](adr/0012-application-shell-navigation.md).

| Module | Contents |
|---|---|
| `@pm/contracts/shell` | Browser-safe contracts: destinations, command ids, preference values, scope tokens, view-state schemas and decoders, fractional ranks |
| `@pm/tenancy` | `navigation.ts`, `personal-data.ts`, `jobs.ts`, and the context resolver in `service.ts` |
| `@pm/identity` | `preferences.ts` |
| Web | `apps/web/src/shell/*`, `pages/shell-pages.tsx`, `app-routes.tsx`, `tenancy/switcher.tsx` |

### Data (migration 0020)

| Object | Notes |
|---|---|
| `identity.account_preference` | One row per account; missing means defaults; column-scoped UPDATE; row version |
| `views.favorite` | `(workspace, owner membership, record)` unique; rank in the C collation; FKs to membership and `core.record` |
| `views.recent_item` | Same key; latest visit and visit count; index `(workspace, owner, visited_at DESC, record)` |
| `views.view_state` | `(workspace, owner, device hash, view key)`; JSON object ≤ 32 KiB hard cap (configured `VIEW_STATE_MAX_BYTES` is lower); `expires_at` index for cleanup |
| `views.view_pin` | Shared-view pins: schema, trigger (`saved_view` targets only), read grant; no write grant yet |
| `exec_dispatch.discover_views_cleanup` | Dispatcher definer function returning workspace ids only |

### API

| Route | Purpose |
|---|---|
| `GET/PATCH /v1/auth/preferences` | Typed preferences; `ETag`/`If-Match` (`409` on a stale version) |
| `GET /v1/workspaces/{ws}/context?scope=` + `X-Device-Key` | Context with the normalized scope, `scope_token`, `principal`, and `fallback` (`narrowed`, `invalid`, `stale_selection`, `no_selection`) |
| `POST /v1/workspaces/{ws}:select` `{scope: brand\|brands\|all}` + `X-Device-Key` | Stores the per-device default (and the membership selection for single-brand and all-brands scopes) |
| `GET /favorites`, `PUT/DELETE /favorites/{target}`, `POST /favorites/{target}:move {after}` | Favorites |
| `GET /recent?limit=&type=&brand=`, `POST /recent {target}`, `POST /recent:clear`, `DELETE /recent/{target}` | Recently viewed |
| `GET/PUT/DELETE /view-state/{view}` + `X-Device-Key` | Per-device view state |
| `GET /navigation/targets?q=`, `GET /navigation/pins` | Palette record provider; pins |
| `POST /v1/shell/events` | Allow-listed shell counters |

All workspace routes above are under `/v1/workspaces/{ws}`, use the caller's principal, and authorize through `personal.manage_own` (the `own` cell for every role, including guests). Responses carry public IDs only.

### Re-authorization and revocation

Personal lists are recompiled from canonical rows on every read, the same as every other tenant read. The browser re-reads the context and the navigation lists on every navigation. A lost grant, sensitive-brand grant, team, archive visibility, membership, or session therefore disappears from the shell on the next page; there are no stale cached entries.

### Tests (1E)

| Suite | Proves |
|---|---|
| `packages/contracts/test/unit/shell.test.ts` | Scope tokens, allow-listed decoding (prototype keys), URL round trips, ranks |
| `packages/tenancy/test/integration/navigation.test.ts` | Three workspaces × six roles + guest: AT-108…114, limits, concurrency, scope normalization, view state, retention cleanup, erasers, preferences, pins, EXPLAIN |
| `apps/api/test/integration/navigation-api.test.ts` | HTTP surface, ETags, CSRF, device partitioning, telemetry allow-list, no UUIDs |
| `apps/web/test/shell.test.tsx`, `scripts/test/web-design-tokens.test.mjs` | Registry coverage and permissions, width classes, key map conflicts, keyboard handling, palette, breadcrumbs, marker contrast, appearance, drafts, DS-21 contrast gate |
| `e2e/navigation.spec.ts` (desktop, tablet, mobile) | Surfaces, scope URLs and history, record scope switch, palette, shortcuts, favorites, recents and pruning, titles, preferences and first paint, read-only members and removal, width boundaries, reflow, forced colors, skip links |

## Phase 2A projects and hierarchy

Decisions and deviations: [ADR-0013](adr/0013-projects-hierarchy.md).

| Module | Contents |
|---|---|
| `@pm/work` | `service.ts` (`ProjectService`: projects, hierarchy, owner, access), `structures.ts` (`WorkService`: overview, phases, milestones, criteria, scope items, updates and verification, decisions, dependencies, templates, duplicate, recurrence), `templates.ts` (package schema v1), `instantiate.ts`, `recurrence.ts` (RRULE subset), `validation.ts` (fields and the three bounds), `lifecycle.ts`, `navigation.ts`, `ownership.ts`, `jobs.ts`, `factory.ts` |
| `@pm/tenancy` | `projects.ts` (project scope, chains, governing project), `sharing.ts` (shareability registry), `record-decisions.ts` (the record lifecycle issuer), and the project branch of `visibility.ts`, `principal.ts`, `policy.ts`, `preview.ts` |
| `@pm/contracts/shell` | Project statuses, priorities, health, kinds, `PROJECT_SECTIONS` |
| API | `apps/api/src/work/routes.ts`, shared helpers in `apps/api/src/route-kit.ts` |
| Web | `apps/web/src/projects/client.ts`, `pages/project-pages.tsx` |

### Authority

- **One collaborator authority.** Project collaborators are `access.role_assignment` rows with `scope_type = 'project'` (generated `project_scope_id`, FK to `work.project`). Levels are `view`, `comment`, `edit`, `manage`, capped by the workspace role. There is no project-member table.
- **Owner is responsibility.** `owner_membership_id` grants nothing by itself. Creation, ownership transfer, and restriction write or keep a `manage` assignment with `grant_source = 'project_manager'` in the same transaction. Deferred triggers on project, assignment, and membership refuse a commit that leaves an active project without an eligible manager.
- **Restriction.** `access_mode = 'restricted'` anywhere in the chain (self → root) stops brand, workspace, and implicit role access for that subtree, including owners and administrators. Explicit project grants flow down until the next restricted project. `allow_record_shares` (default false on restricted projects) controls new exact shares.
- **Scope loading.** `projectScope` loads only the rows that can change a decision: restricted projects and their descendants, plus projects reachable from the principal's grants. It is a recursive walk seeded from the `project_restricted` partial index and the primary key, descending by `parent_project_id`. Array operators are not leakproof, so under RLS an `ancestor_ids` predicate could never use an index.
- **Visibility.** The 1D compiler subtracts restricted chains from brand access and adds granted projects, before pagination and counts. Every project surface (list, totals, tree, overview, dependency display, palette, favorites, recents, breadcrumbs, targets) uses this predicate. Previews use the same code on hypothetical principals.
- **Sharing.** `SHAREABLE_RECORD_TYPES` holds `project` only (`read`, `comment`, `edit`; API `view` is stored `read`). Shares never carry children. A caller who cannot read the target gets `not_found`. A caller who can read it but lacks `record.share`, or targets an unshareable type, gets `forbidden`.
- **Share recipients** (share only, ADR-0013 P5) read the project, its criteria and scope items, and the latest verified update's content and ID. Phases, milestones, decisions, dependencies, children, recurrence, templates, collaborators, update history, verification details, and counts are absent; every command a share excludes returns `not_found`. Each overview section is authorized separately, so independent authority shows more.

### Hierarchy

A project has at most one parent in the same workspace and brand. `ancestor_ids` and `depth` are denormalized: a check ties `depth` to the ancestry length, a deferred trigger compares each row with its parent at commit, and the database ceiling is 32. Commands enforce `PROJECT_DEPTH_MAX`. A move:

1. takes transaction advisory locks on both brand roots in a fixed order;
2. locks the project and checks the target (same brand, readable, not a descendant);
3. measures the subtree height with a recursive walk and checks the depth bound;
4. computes a fractional rank among the destination siblings;
5. rewrites every descendant's ancestry in one statement, then the project itself.

Concurrent opposite moves serialize on the root locks, so one succeeds and the other sees the new ancestry and is refused as a cycle.

### API

| Route | Purpose |
|---|---|
| `GET /v1/workspaces/{ws}/projects?brands=&state=&parent=&limit=` | List (comma-separated brands; `parent=root`; authorized totals, at most 200) |
| `POST /projects` | Create (`brand` or `parent`; optional `template`, `intake_source`) |
| `GET /projects/{prj}`, `GET /projects/{prj}/overview`, `PATCH /projects/{prj}` | Read, overview, field-merge edit (`If-Match`). `description` is rich text version 1 (0D PL-23) and merges with `base_hash` |
| `POST /projects/{prj}:{verb}` | `move`, `owner`, `access`, `duplicate`, `template`, `archive`, `unarchive`, `trash`, `restore`, `purge` |
| `POST /projects/{prj}/phases`, `/milestones`, `PATCH …/{id}`, `POST …/{id}:{verb}` | Create, edit, `move`, `archive`, `unarchive`, `trash`, `restore` |
| `POST /projects/{prj}/criteria`, `/scope-items`, `PATCH`/`DELETE …/{id}`, `POST …/{id}:move` | Ordered criteria and scope entries |
| `POST /projects/{prj}/updates`, `POST …/updates/{pup}:verify` | Append-only updates; explicit verification |
| `POST /projects/{prj}/decisions`, `PATCH …/decisions/{dec}` | Decisions and open questions |
| `POST /projects/{prj}/dependencies {target}`, `DELETE …/dependencies/{prj}` | "Waits on" edges |
| `GET/POST /projects/{prj}/recurrences`, `POST …/recurrences/{rcs}:{pause\|resume\|generate}` | Recurrence. `POST` takes `{frequency, interval, weekdays, month_days, start, anchor_tz, ends}`; the series view returns the structured rule, `next_occurrence` (local intent), `next_due_at`, and `status` (`active`, `paused`, `catching_up`, `ended`) |
| `GET /v1/workspaces/{ws}/templates` | Template catalog |

Shares and collaborator grants use the 1D preview/apply changes `record_share`, `project_grant`, and `project_revoke`.

### Tests (2A)

| Suite | Proves |
|---|---|
| `packages/work/test/integration/projects.test.ts` | Creation with platform status and manager grant; field merge and conflicts; hierarchy (same brand, cycles, depth, atomic subtree move, stale ancestry refused); phases, milestones, criteria, and scope entries; append-only updates and verification; decision state machines; dependency cycles; templates, duplicate, and `TEMPLATE_ITEMS_MAX`; recurrence (frozen snapshot, idempotent keys, catch-up bound, pause); lifecycle without cascade and purge blocked by children |
| `packages/work/test/integration/project-access.test.ts` | Three workspaces, three brands (sensitive and archived), all six roles, restricted and inherited projects, a guest, exact cross-brand shares, every surface agreeing with single-record checks, hidden dependency endpoints, forged identifiers, departure and next-check revocation |
| `packages/work/test/integration/contracts.test.ts` | Planning and budget fields and the completion basis; intake provenance; concurrent reparenting and reordering; query plans at volume; direct `app_rw` on a pooled connection and `app_worker` isolation, including the recurrence job |
| `apps/api/test/integration/projects-api.test.ts`, `apps/api/test/unit/tenant-routes.test.ts` | HTTP flows with ETags; uniform `not_found`; the lifecycle-issuer boundary |
| `apps/web/test/projects.test.tsx`, `e2e/projects.spec.ts` | Section order and conditional tabs; tree keyboard and Move/Indent/Outdent; first project, overview, timeline, honest sections, conflict, offline, archive, restrict, duplicate, axe, forced colors, zoom, 320 px on desktop, tablet, and mobile |

## Phase 2B tasks

A task's governing project is its project (or none); `governingProjectId` resolves it for share
resolution before the project chain. Projectless tasks follow brand access; project tasks follow the
2A project chain, including restriction. `task` is in the shareability registry (`read`, `comment`,
`edit`): a share covers the task, its checklist, and its own criteria only (ADR-0014 T15).
Assignment never grants access. `label.manage` governs brand labels; `task.override_completion`
governs completing with unmet items; `record.move_brand` for tasks needs manage in both brands.

## Phase 2C workflows and fields

`workflow.configure` and `fields.configure` are decided at the configuration's own scope:
workspace, brand (`decideBrand`, so sensitive brands need explicit manage), or project
(`decideProject`, so restricted projects need explicit project manage). Record actions:
`workflow.transition` and `workflow.approval_request` (edit), `workflow.approval_decide` (view plus
policy eligibility), `field.value_read`, `field.value_edit`, and `field.formula_inspect`. Field
visibility intersects record readability, applicability, and `access.field_policy`; a formula is
readable only where all its inputs are (AZ-23). Approvers and person or label values grant nothing.

## Phase 2D task interaction

`TaskInteractionService` (AZ-24): `task.remind` and `task.snooze` are view-level and personal; `task.manage_recurrence` needs manage, and the worker rechecks `record.create` on the brand or project chain per run. Bulk items are authorized one by one through the task capability flags; ordering is `record.update` on owned context; undo entries belong to their actor and re-run current authorization. Signals and duplicates use the visibility predicate inside SQL, so hidden rows change neither results nor statements.

## Phase 2E capture

Capture, the Inbox, notes, merge, and parse previews are personal (`personal.manage_own`, OD-03): every query filters by the owner's membership, with no administrator bypass. Triage and note conversion decide `record.create` at the destination brand or project chain at preview and apply. Intake forms use `intake.manage` (brand admin) and `intake.submit` (brand view, members only while OD-28 is open). Name resolution and form lookups run fixed statements, so hidden and unknown are indistinguishable.

## Phase 3A views

`ViewService` (AZ-26) runs every query, saved or ad hoc, with the caller's own `compileVisibility` predicate:
- **Joined records.** A second, archive-inclusive predicate covers joined readable projects and parents, so hidden projects contribute no health, milestone, or name.
- **Value resolution.** Reference values resolve with one statement per referenced kind among readable records. People fields and non-`all_readers` custom fields are `unsupported_field` for whoever may not use them.
- **Shared views.** Sharing decides `view.share` at exactly one scope. Defaults and pins decide `views.configure` and require a view shared there.
- **Personal state.** Personal views, the person's default, and view state are `personal.manage_own`.
- **Lifecycle.** Delete uses tenancy's `issueSavedViewLifecycleDecision`.
## Phase 3D time tracking

`TimeService` (AZ-27): `time.log_own` (comment) on the task or project at every write; only the owner changes an entry. Reads use the work's compiled visibility (view, archived included) inside SQL, with guests limited to their own entries; `editable` uses the same compiler at `comment` on active work. `timesheet.submit_own` is personal; `timesheet.approve` is decided per brand line now, needs the whole line to be readable, and applies OD-20 through the shared `selfApprovalAllowed`; `timesheet.unlock` is the admin action with step-up (OD-26). Approvers never gain access through approval.


## Phase 3B views

`LayoutService` (AZ-28) computes every layout fact from the records the caller's compiled 3A query returns:
- **Totals, edges, and progress.** Workload is one aggregate. Gantt edges need both endpoints returned. Progress counts readable leaf tasks.
- **Activity** uses a no-share predicate (`compileVisibility({ shares: false })`).
- **Board and timeline changes** go through the workflow transition preview and apply, and through field merges, with versions.

## Phase 3C Today and planning

`PlanningService` (AZ-29): every command and read is `personal.manage_own` and filtered by owner, with no administrator bypass. Naming a task goes through the task loader (readable now, active). Today's lists run the 3A query engine with the viewer's predicate; commitments and blocks join the same compiled visibility, so unreadable tasks drop out (commitments) or lose their title and link (blocks). Planning never writes a task.
