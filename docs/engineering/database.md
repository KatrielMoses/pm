# Database: roles, RLS, tenant transactions, migrations

PostgreSQL 18 (0B §10 requires ≥ 15; role-membership options used here require ≥ 16). No
extensions are needed in 1A: UUIDv7 keys are application-generated, and `gen_random_uuid()` and
`sha256()` are built in.

## Schemas

| Schema | Owner module | Contents |
|---|---|---|
| `exec` | execution (0B model `schema: exec`) | operation, attempt, job, outbox_event, inbox_receipt, idempotency_key, external_effect; enums; `current_workspace_id()` |
| `exec_dispatch` | execution | Payload-free `SECURITY DEFINER` scheduling functions |
| `tenancy` | tenancy | `workspace` anchor (1C extends it additively) |
| `access` | access | empty (1D) |
| `ops` | operational | `schema_migration`, `environment_binding`, `worker_heartbeat`, `rate_limit_bucket`, `dev_secret_vault` (no tenant data) |
| `identity` | identity (1B) | account, credential, mfa_factor, recovery_code, session, oauth_identity, verification_token, step_up_challenge, mail_delivery, security_event_buffer. Platform scope, no tenant RLS; see [identity.md](identity.md) |

## Roles (0C §12.3)

Created by `packages/db/bootstrap/roles.sql` (provider admin, once per cluster), never by migrations.

| Role | Login | RLS | Purpose |
|---|---|---|---|
| `pm_owner` | no | subject (tables use `FORCE`) | Owns all schemas and objects |
| `migrator` | yes | subject | DDL via `SET ROLE pm_owner` (membership `INHERIT FALSE, SET TRUE`) |
| `restore_operator` | yes | subject | Break-glass restore / purge-ledger replay via `SET ROLE pm_owner` |
| `app_rw` | yes | **subject** | web/API. Column-scoped grants; owns nothing |
| `app_worker` | yes | **subject** | worker tenant work |
| `dispatcher` | yes | subject | `EXECUTE` on `exec_dispatch.*` only; cannot select any tenant table |
| `pm_scheduler` | no | subject + discovery policies | Owns the definer functions; column grants exclude payload, context, keys |

No role has `SUPERUSER`, `BYPASSRLS`, `CREATEROLE`, `CREATEDB`, or `REPLICATION` (catalog test).
`app_ro`, `audit_maintainer`, and `platform_support` arrive with the phases that need them.

**Managed providers.** If the provider reserves role creation for its admin user, run
`bootstrap` (`node /app/entrypoint.mjs bootstrap`) or `roles.sql` as that admin. The logical model
does not change. If a provider cannot grant role membership with `SET TRUE, INHERIT FALSE`, stop
and escalate rather than weakening it.

## RLS and tenant transactions

- Every table with `workspace_id` (and `tenancy.workspace` by `id`) has RLS **enabled and forced**
  with `tenant_isolation`: `USING/WITH CHECK (workspace_id = exec.current_workspace_id())`.
- `exec.current_workspace_id()` = `NULLIF(current_setting('app.workspace_id', true), '')::uuid`.
  Unset or cleared context is `NULL`, so every predicate is false (fail closed: zero rows, writes rejected).
- `TenantDatabase.withWorkspace(id, {module}, fn)` is the only SQL path for `app_rw`/`app_worker`:
  validates the UUIDv7, opens a transaction, `set_config('app.workspace_id', $1, true)`
  (transaction-local), asserts the setting and that the workspace exists, then runs `fn`. Session-level
  `SET`/`set_config(…, false)` are rejected by lint and by the SQL safety check.
- `PlatformDiscovery` (dispatcher) is the separate, explicitly named cross-tenant path. Its functions
  return only IDs, queue names, lease tokens, timestamps, and counts.
- `PlatformHealth` reads only `ops` metadata outside tenant context.
- **Workspace existence is database-enforced** (migration 0009): every `exec` tenant table has
  `<table>_workspace_fkey (workspace_id) REFERENCES tenancy.workspace(id) ON DELETE RESTRICT`.
  Foreign-key checks bypass RLS, so the constraint holds for every identity, including owners and
  superusers. Composite `(workspace_id, id)` keys additionally keep attempts, jobs, outbox events,
  idempotency keys, effects, and reruns in their operation's workspace. Every foreign key has a
  full (non-partial) index leading with its referencing columns (catalog test).

## Workspace purge order

`RESTRICT` means a workspace cannot be deleted while any execution history remains (error
`23001`). The audited workspace purge (implemented with deletion in 1F/later phases, under a
dedicated purge identity) deletes in this order, in the workspace's context:

1. `exec.inbox_receipt` 2. `exec.external_effect` 3. `exec.idempotency_key` 4. `exec.outbox_event`
5. `exec.attempt` 6. `exec.job` 7. `exec.operation` 8. `tenancy.workspace`

Attempts are append-only; their guard permits `DELETE` only when the transaction-local marker
`app.purge_workspace_id` equals the attempt's workspace. No application role holds `DELETE` on
`exec.attempt`, so the marker alone grants nothing. Later modules insert their tables before
`exec.*` in this order (dependents first).

## Migrations

- One ordered stream: `packages/db/migrations/NNNN_name.up.sql` + `.down.sql` (both required).
- Header `-- migrate:phase expand|contract`; optional `-- migrate:no-transaction`.
- Tamper evidence: `ops.schema_migration` stores the SHA-256 of each up and down file and a hash
  chain (`chain_hash = sha256(prev | version | name | checksum | down_checksum)`). `migrate verify`
  and every `migrate up` recompute it; any edited file, edited row, gap, or reorder stops the run.
- Only the `migrator` login may run migrations (checked); a session advisory lock serializes
  concurrent migrators; each migration runs in its own transaction with lock/statement timeouts.
- **Expand/contract.** `migrate up` applies expand migrations and stops at the first contract
  migration; `migrate up --contract` applies it once every running instance uses the new code.
  Readiness accepts a database that is *ahead* of the artifact (rolling deploys) but not behind.
  `scripts/check-sql-safety.mjs` rejects destructive statements in expand migrations.
- `migrate down --to N` exists for local and test only. Deployed environments roll forward.
- The first `migrate up` binds the database to `APP_ENV` (`ops.environment_binding`); later runs
  under another environment are refused.

| # | Migration | Creates |
|---|---|---|
| 0001 | foundation_schemas | `exec`, `tenancy`, `access`, `exec_dispatch`; enums; `exec.principal_type` domain; context and UUIDv7 functions |
| 0002 | ops_runtime | grants on `ops.schema_migration`; `ops.environment_binding`; `ops.worker_heartbeat` |
| 0003 | tenancy_workspace | `tenancy.workspace` + RLS |
| 0004 | exec_operation_attempt | `exec.operation`, `exec.attempt` (append-only guard) + RLS |
| 0005 | exec_job | `exec.job` + RLS + scheduler policies and column grants |
| 0006 | exec_outbox_inbox | `exec.outbox_event`, `exec.inbox_receipt` + RLS |
| 0007 | exec_idempotency_effects | `exec.idempotency_key`, `exec.external_effect` (transition guard) + RLS |
| 0008 | exec_dispatch_functions | `claim_jobs`, `discover_expired_leases`, `job_queue_stats`, `claim_outbox_events`, `outbox_backlog`, `discover_maintenance_workspaces` |
| 0009 | exec_workspace_foreign_keys | Workspace FKs (`RESTRICT`, added `NOT VALID` then validated) on all seven tenant `exec` tables; FK-supporting indexes; purge-aware attempt guard |

## Writing a new migration

1. Add `NNNN_name.up.sql` and `.down.sql`; never edit an applied file.
2. Tenant table: `workspace_id` with a `RESTRICT` foreign key to `tenancy.workspace(id)`, composite keys as needed, `ENABLE` + `FORCE` RLS, `tenant_isolation`
   policy, explicit column-scoped grants. Indexes lead with `workspace_id`.
3. Update `packages/db/src/schema.ts` (`Database` types and `TABLE_COLUMNS`; the drift test fails otherwise).
4. `pnpm lint` (SQL safety) and `pnpm test:integration` (catalog RLS checks, reversibility).

## Platform scope (migration 0010)

Some execution rows belong to no workspace: identity mail delivery, identity cleanup, and
account-level idempotency keys. `PlatformDatabase.withPlatform()` opens a transaction with
`app.platform_scope='platform'` and **no** workspace context, and `exec.in_platform_scope()`
gates RLS policies that admit only rows with `workspace_id IS NULL`. `exec.job.workspace_id` and
`exec.idempotency_key.workspace_id` are nullable; operations, attempts, effects, and outbox events
stay tenant-only (`CHECK (workspace_id IS NOT NULL OR operation_id IS NULL)`). The tenant and
platform scopes are mutually exclusive: a platform transaction cannot see tenant rows, and a tenant
transaction cannot see platform rows.
