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
