# ADR-0001: TypeScript and pnpm modular monolith

Status: accepted (1A). Context: roadmap reference architecture, 0B ADR-01 (modular monolith), 0B
module map.

**Decision.** One repository; `pnpm` workspaces; strict TypeScript on Node.js 24 LTS. Apps
(`web`, `api`, `worker`) and foundation packages (`contracts`, `config`, `observability`, `db`,
`platform`, `test-support`). TypeScript project references give a reliable build graph;
`scripts/check-workspace-graph.mjs` enforces an acyclic, layered runtime graph and forbids generic
`utils` packages. Sources use `.ts` import specifiers with `rewriteRelativeImportExtensions` and
`erasableSyntaxOnly`, so Node runs sources directly in development and tests resolve sources via
the `@pm/source` export condition.

**Versions.** Node 24.21.0, pnpm 12.8.1, **TypeScript 6.0.3**. TypeScript 7.0 is the latest
release, but `typescript-eslint` 8.71 supports `<6.1` and TS 7 exposes no stable compiler API yet;
6.0 is the newest version the lint toolchain supports. Revisit when typescript-eslint supports 7.

**Consequences.** Business modules (0B's 32) become packages or folders as their phases arrive;
the graph script is the gate. Cost to change later: low (package boundaries are explicit).

## Package graph

Corrected in 1A review 01. **Before:** `@pm/contracts` and `@pm/db` dev-depended on
`@pm/test-support`, which runtime-depended on `@pm/db` and `@pm/contracts`:
`contracts → test-support → db → contracts` (dev-only edge; pnpm warned, the old checker inspected
runtime edges only).

**After:** test support is split by dependency direction (dependency inversion):

- `@pm/test-infra` — leaf, no `@pm` dependencies: disposable PostgreSQL (Testcontainers /
  embedded / external), `createDisposableDatabase({ prepare })` with an injected preparation
  callback, 0D JSON-Schema validation.
- `@pm/test-support` — downstream: binds `@pm/db`'s `bootstrapRoles`, `grantDatabaseAccess`, and
  `Migrator` into those helpers; fixtures, harness, Vitest global setup.
- `@pm/contracts` and `@pm/db` dev-depend only on `@pm/test-infra`. `@pm/db`'s tests use a narrow
  local helper (`test/integration/databases.ts`) that injects db's own bootstrap — no duplicated
  production logic.

```text
runtime:  contracts   config
             ↑          ↑
          observability─┘
             ↑
             db ──────────────┐
             ↑                │ (runtime)
          platform        test-support ──→ test-infra (leaf)
           ↑    ↑             ↑ (dev only: platform, api, worker, root e2e)
          api  worker
          web → config/public            contracts, db ··dev··→ test-infra
```

`scripts/check-workspace-graph.mjs` checks cycles across every dependency field and the runtime
allow-list separately; `scripts/test/workspace-graph.test.mjs` proves it catches dev-only,
optional, and peer cycles. `scripts/verify.sh` also fails on pnpm's cyclic-workspace warning.
