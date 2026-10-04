# ADR-0010: Workspaces, brands, and tenant isolation (Phase 1C) — decisions, deviations, 1D handoff

Status: **accepted and implemented** (P1-W3; no-skip CI run `37145703535` on `30919ff`: all gates passed on `postgres:18.6-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650`; osv-scanner, pnpm audit, and gitleaks 8.30.1 clean; image `sha256:26c180ffa6594cfaefc5f57d3c890fe657c1e6e2cd92f3d8eb1bcf76082baf40`, 260,503,749 bytes, runs as `uid=1000(node)`). Phase 1C review 01 reconciled D1, D2, and D7 at
their Phase 0 sources; D3–D6 and D8–D12 accepted). Engineering detail:
[tenancy.md](../tenancy.md). Accepted sources: 0A (WSB catalog), 0B data model, 0C authorization
policy, 0D platform contracts, 0E UX patterns.

## Context

1C delivers the first multi-tenant product journey: a verified account creates a workspace,
becomes its protected bootstrap owner, configures defaults, creates and manages brands, switches
between one brand and all authorized brands, and archives or restores brands. All of it must be
isolated across workspaces and across brands. The authority it creates must be the canonical model
that 1D extends, not a parallel system.

## Decisions

| # | Topic | Decision | Why |
|---|---|---|---|
| C1 | Canonical membership | `tenancy.membership` is created now (0B entity, all 0B key columns, states `invited/active/suspended/removed`). Authority is membership + `access.role_assignment`, never `workspace.created_by_*` or `bootstrap_account_id` (provenance only, documented on the column) | Brief; 0C §3 |
| C2 | Built-in roles | `access.role` rows are seeded per workspace by `access.seed_builtin_roles()`: the six 0C workspace roles (`kind = workspace_role`) and four scope levels `scope_view…scope_manage` (`kind = scope_level`). Custom roles (1D) are more rows of the same table | 0B `role` is workspace-scoped; 0C §5 |
| C3 | Brand grants | A brand grant is a `role_assignment` with `scope_type = 'brand'` and a `scope_level` role. A composite FK pins `role_kind`, and CHECKs tie workspace scope ⇔ workspace role. A partial unique index allows exactly one workspace role per membership | 0C §6 |
| C0 | Account command | `workspace.create` is a registered 0C account command (AZ-18): personal kind, every workspace role cell `deny`, human `account` principal only, no 0D scope. `authorizeAccountCommand` checks the generated catalog. Then the command enforces the four mandatory gates: verified email and active account (re-read from the database), the per-account rate limit `workspace.create` (default 10/hour; replays of a completed key consume nothing), and the Idempotency-Key | 0C AZ-18, T-36, AT-087…094 |
| C4 | Bootstrap atomicity | One workspace transaction creates the workspace, membership, built-in roles, owner assignment (`grant_source = bootstrap_owner`), workspace + principal epochs, audit events (`workspace.created`, `membership.created`, `role_assignment.created`), a `permission` security event, and the optional first brand. A deferred constraint trigger refuses to commit a workspace that has bootstrap provenance but no active owner | Brief |
| C5 | Workspace creation idempotency | `workspace.creation_key_hash = sha256(account ‖ Idempotency-Key)` (globally unique) and `creation_request_hash` (the 0D request fingerprint). A retry returns the original workspace; a different body is `idempotency_key_reuse`; a concurrent duplicate loses the unique race and replays the winner. `exec.idempotency_key` is not used, because a platform-scope key cannot commit atomically with the tenant rows | 0D §8; brief: "never creates a second workspace" |
| C6 | Last-owner protection | Deferred constraint triggers on `role_assignment` and `membership` (UPDATE/DELETE) require at least one active owner at commit. `app_rw` has INSERT only on membership and assignment tables (no UPDATE/DELETE), and no 1C route changes them | Brief; 0C §3.4 |
| C7 | Directory | NOLOGIN role `pm_directory` (role bootstrap) owns four `SECURITY DEFINER` functions: `account_workspaces`, `resolve_membership`, `workspace_by_creation_key`, `account_selected_workspace`. Each requires platform scope and returns only the calling account's own active memberships. These functions are why a public workspace ID can be resolved before any RLS context exists | RLS makes the lookup otherwise impossible without a bypass |
| C8 | Brand envelope | `tenancy.brand` is an addressable `core.record` extension: same `id`/`br_` public ID, `brand_id = id` (CHECK `record_brand_self`), `scope_key = id` (CHECK; a plain column because PostgreSQL rejects cascading FKs over generated columns), mirrored `lifecycle_state` through the deferrable composite FK `ON UPDATE CASCADE` | 0B §2.3 |
| C9 | Status vs. lifecycle | `operational_status ∈ {operating, paused, planned}` is business metadata only. Archive, trash, and purge are `core.record.lifecycle_state` (1F). One vocabulary: the 0B key column → the generated `BRAND_OPERATIONAL_STATUSES` → API validation; the DB CHECK and the web options are checked against 0B by the Phase 0 validator | 0B ADR-19 |
| C10 | Name uniqueness | Unique index `(workspace_id, lower(name)) WHERE lifecycle_state <> 'purged'`. The service pre-checks for a friendly field error; the index decides races (mapped to `validation_failed /name name_taken`) | Brief |
| C11 | Deferred 1F FKs | `core.record`, `core.archive_batch`, `core.deletion_batch` → `tenancy.brand (workspace_id, id)` (deferrable). Workspace-scoped records keep `brand_id = NULL`. `role_assignment.brand_scope_id` → brand | ADR-0009 future owners |
| C12 | Brand settings | `tenancy.brand_setting`: `working_hours`, `calendar`, `priorities` (schema_version 1, validated by SQL functions and mirrored in TypeScript); reserved `notification_settings`, `ai_settings`, `integration_settings` with CHECK `IS NULL` (owners 4B, 7A, 6A). One row version for the whole settings record | WSB-010/011; WSB-012–014 reserved |
| C13 | Scope preference | New 0B personal entity `tenancy.scope_preference` (model.json updated, generated docs re-rendered, Phase 0 validator green): `(workspace, owner_membership)` → `brand` or `all`. Validated on every read; never grants access | Brief: preference per membership |
| C14 | Policy compiler | `@pm/tenancy` `policy.ts` reads the generated 0C matrix (the generator now emits `roles` and `requiredLevel`). Effective brand level = max(explicit grant, implicit `manage` for owner/admin on **non-sensitive** brands). No level → `not_found`; `forbidden` only when readable. An `implicit` cell on a sensitive brand needs an explicit `manage` grant | 0C §4–§6 |
| C15 | All-brands | The union of brands the principal can view, as an SQL predicate (`is_sensitive = false` only when implicit applies, `OR id IN (granted)`) applied before ordering, pagination, and counts. The context response lists the brand public IDs explicitly. There is never a wildcard RLS context | Brief |
| C16 | Creator grant | Brand creation adds an explicit `scope_manage` grant (`brand_creator`). Marking sensitive adds one (`sensitivity_creator`) only if the actor lacks it, so the actor can never lock themselves out. Grants bump the principal epoch; sensitivity changes bump the workspace epoch | 0C §6.3 |
| C17 | Step-up | `brand.mark_sensitive` (R3) consumes a step-up inside the workspace transaction via the new public `IdentityService.consumeWorkspaceStepUp`, bound to account, session, membership, workspace, action, target (`brand:<public id>`), and Idempotency-Key. Account-level consumption now also requires a null tenant binding (tightened) | 0C, 0D §11.2 |
| C18 | Lifecycle | Archive/restore call 1F `LifecycleService.archive/unarchive` with a `brand.archive` decision issued by the restricted `@pm/lifecycle/policy-issuer` subpath (only importer: `packages/tenancy/src/service.ts`, confinement test). Lifecycle refuses `brand.archive` for non-brand roots and record actions for brand roots. The brand adapter unions `rootsInBrand` from registered adapters as containment children | Brief: no second archive mechanism |
| C19 | Brand purge | The brand adapter registers **no** purge hooks, so purging a brand batch blocks with `missing_purge_hook`. 1C makes no claim of brand purge support | Brief |
| C20 | Resolution | Path workspace → directory (platform scope) → one workspace transaction → `loadPrincipal` re-checks account binding and membership state under RLS. Body, query, and header claims are never read; unknown body fields are `unsupported_field` | Brief |
| C21 | Optimistic concurrency | PATCH workspace/brand = 0D field-merge (`base` per field, atomic, `conflict` payload with `would_merge` and readable `theirs`). Archive, restore, sensitivity, and settings PUT require `If-Match` (`precondition_required` / `conflict`) | 0D §4 |
| C22 | Cursors | AES-GCM sealed `{lower(name), id}` with AAD = workspace ‖ membership ‖ query; key derived from `AUTH_SIGNING_KEY`; any mismatch → `cursor_invalid` | 0D §2.5 |
| C23 | Audit classes | Names and short presentation fields are `plain`; `description` and structured settings (working hours, calendar, priorities) are `content` (canonical-JSON hash): audit values must be scalars | 1F F4 |
| C24 | Logo boundary | `logo_file_ref` columns (format `file_…`) exist on workspace and brand. Every non-null reference is refused (`logo_upload_unavailable`) until file storage exists. No bytes, no vendor | Brief |

## Dispositions D1–D12 (Phase 1C review 01)

| # | Item | Disposition | Where it is authoritative |
|---|---|---|---|
| D1 | `workspace.create` as an account-level command | **Accepted, registered at source** | 0C `policy.json` action row and `account_commands` entry; AZ-18; threat T-36 with tests AT-087…094; validator rules (all-deny cells, human-only principal, four gates, no 0D scope); Phase 0 runtime check that every authorization call uses a catalog action and that account commands never reach tenant, lifecycle, step-up, or delegated evaluation |
| D2 | Brand `operational_status` vocabulary `operating/paused/planned`, distinct from lifecycle | **Accepted, registered at source** | 0B `brand` key column and notes; ADR-19; 03 §3.6 prose; generated `BRAND_OPERATIONAL_STATUSES` (API validation); Phase 0 drift check across 0B, the migrated CHECK, the server validator, and the web options |
| D3 | `tenancy.scope_preference` personal entity | Accepted | 0B model |
| D4 | `pm_directory` role and definer functions; **re-run the role bootstrap before migration 0017** | Accepted | Role bootstrap; role catalog and readiness tests |
| D5 | `workspace_context` closed non-resource response | Accepted | `NON_RESOURCE_TYPES`; confinement test |
| D6 | Optional `conflict` member in the error envelope | Accepted | 0D error-envelope schema (already defined) |
| D7 | Tenancy telemetry and the `tenant_isolation` readiness check | **Accepted, registered at source** | 0D `registry.json` telemetry (area `tenancy`) and forbidden labels; PL-19; 0D §17.3–17.4; generated `TELEMETRY_SIGNALS`; registry-drift test over every runtime emission |
| D8 | Runtime-supported IANA identifiers and aliases | Accepted | `validation.ts`; no private canonicalization table |
| D9 | Archived brands are read-only (no comment exception yet) | Accepted | Revisit when comments land |
| D10 | Brand trash/purge product actions deferred | Accepted | No purge hooks; purge blocks |
| D11 | WSB-008 foundation only; no implicit cross-brand sharing | Accepted | One brand or none per record; 1D provides exact-record grants. OD-04 (decided 2026-10-04): WSB-008 is owned by 2A |
| D12 | WSB-015 shared brand-presentation contract | Accepted | `brandSummary` shape; universal placement is 1E and the owning modules |

## Phase 1D handoff (exact)

1D **extends** these; it must not create parallel tables, roles, or resolution paths.

1. **Tables are canonical.** `tenancy.membership`, `access.role`, `access.role_assignment`,
   `access.permission_epoch`. 1D adds columns and migrations; it never replaces them.
2. **Grants to add, carefully.** 1C gives `app_rw` only SELECT/INSERT on membership, role, and
   assignment tables. Membership state changes (suspend, remove, rejoin), role changes, and
   assignment revocation need column-scoped UPDATE (and DELETE only where 0B says hard delete)
   in a 1D migration. The deferred last-owner triggers (`access.assert_workspace_has_owner`)
   must stay and must be covered by 1D tests for every new mutation path.
3. **Policy compiler.** Extend `packages/tenancy/src/policy.ts`:
   - `cell()` already reads every 0C cell, and `grant:<level>` works for brand actions;
   - `decideWorkspace` currently allows only `implicit` cells, so 1D adds workspace-scope grants
     if 0C introduces them;
   - add record-scope decisions (`record.*`, project scope), guest restrictions, and people
     visibility;
   - `Principal` (`membershipId`, `role`, `grants`, `epochs`) is the stable input shape;
   - `loadPrincipal` must also load team/share-group derived grants once those exist.
4. **Decision issuance.** `issueLifecycleDecision` (`@pm/lifecycle/policy-issuer`) is the only
   request-reachable issuer. 1D wires `record.archive/restore/trash/purge` and `trash.manage`
   (per-record trash visibility, ADR-0009) through the same compiler. The confinement test lists
   the allowed importers; extend it explicitly.
5. **Epochs.** 1C bumps the principal epoch on grants and the workspace epoch on sensitivity and
   archive/restore. 1D must:
   - consume them: cached decisions and queued jobs compare `workspace_epoch_at_enqueue` /
     `principal_epoch_at_enqueue` before acting;
   - bump the principal epoch on every membership or role change.
6. **Membership routes.** Invitations, member lists, role assignment, brand-grant management,
   ownership transfer, and teams belong to 1D, under `/v1/workspaces/{ws}/…`. They use the same
   `TenancyService` plumbing (`#inWorkspace` → `#mutate`: directory resolution, one workspace
   transaction, idempotency, audit, security events).
7. **Directory.** `account_workspaces` returns `active` memberships only. Invitations (`invited`)
   need a separate own-invitations function owned by `pm_directory`, with the same
   platform-scope and own-account rules.
8. **Sensitive brands.** Granting someone access to a sensitive brand is a 1D brand-grant action
   (`grant_source = 'assigned'`). The rule that sensitive brands never rely on implicit access
   stays in `brandLevel()` and the SQL predicate. Both must change together, and the unit and
   isolation tests guard them.
9. **Step-up.** Use `consumeWorkspaceStepUp` for every tenant step-up action (`brand.delete`,
   role elevation, ownership transfer). Never consume tenant step-ups through the account path.

## Consequences

- The isolation suite proves that authority comes only from canonical rows: three workspaces, two
  owners, a second owner, sensitive and archived brands, direct `app_rw`/`app_worker` SQL, and a
  reused pooled connection.
- Brand purge remains blocked until contained modules register purge hooks.
