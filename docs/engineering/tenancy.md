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
