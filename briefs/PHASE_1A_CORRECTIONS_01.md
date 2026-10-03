# Corrective Developer Brief — Phase 1A Review 01

## Objective

Close the specific acceptance gaps found during architectural review of Phase 1A. Preserve the working implementation and avoid unrelated redesign.

Phase 1A remains incomplete until every item below is implemented and evidenced.

## Read first

- `briefs/PHASE_1A_FOUNDATION_PIPELINE.md`;
- the Phase 1A completion report provided to the solutions architect;
- `docs/engineering/adr/0007-deviations.md`;
- the accepted Phase 0 data/RLS/platform contracts.

Do not edit `BUILD_ROADMAP.md` or mark `ROADMAP_CHECKLIST.md` complete.

## Accepted deviations

The following do not require correction:

- **D1:** PostgreSQL schema name `exec` is accepted because it matches the authoritative Phase 0B model.
- **D3:** Current foreign keys into possible future partition candidates are accepted until measured partitioning work in Phase 11D.
- **D4:** Active job deduplication is correctly workspace-scoped.
- **D5:** Platform jobs may remain absent and `workspace_id` non-null in this phase.
- **D6:** `/v1/status` may omit a resource `id`; it is a non-record singleton health/status response. Document this as an accepted platform-envelope specialization and ensure it cannot generalize to ordinary resources.
- **D7:** The additional execution columns are accepted.
- **D8:** Marking the actually lost attempt as `worker_lost` is accepted and is clearer than marking its replacement.
- **D9:** Tail-based error sampling remains provider-dependent.
- **D10:** Embedded PostgreSQL remains a supported local fallback, but does not replace the required container path below.
- **D11:** `audit_maintainer` belongs to Phase 1F; read-replica and support roles remain deferred until they have consumers.
- **D12:** TypeScript 6.0.3 is accepted for current lint-tool compatibility.

## Required corrections

### 1. Remove every workspace dependency cycle

`pnpm install --frozen-lockfile` currently reports a cyclic dependency among `@pm/contracts`, `@pm/test-support`, and `@pm/db`:

```text
contracts → test-support → db → contracts
```

The existing custom checker examines only runtime `dependencies`, so its “acyclic” result is incomplete.

Required outcome:

- `pnpm` emits no cyclic-workspace warning during a clean frozen install.
- No cycle exists across `dependencies`, `devDependencies`, or `optionalDependencies` among workspace packages.
- Update `scripts/check-workspace-graph.mjs` to validate the complete workspace graph and separately validate the allowed runtime graph.
- Refactor test support into a genuinely downstream/leaf arrangement. Runtime packages must not dev-depend on a test-support package that itself depends on those runtime packages.
- Prefer dependency inversion or narrowly scoped test helpers. Do not duplicate production database or migration logic merely to hide the cycle.
- Preserve strict pnpm dependency declarations; do not rely on accidental root-hoisted resolution.
- Add a regression test or fixture proving the checker catches a dev-dependency-only cycle.

Document the corrected package graph.

### 2. Add database-enforced workspace existence

Deviation D2 is rejected. Every tenant-owned execution row must be prevented from referencing a nonexistent workspace at the database layer.

Required outcome:

- Add reviewed expand migrations that create foreign keys from tenant execution tables' `workspace_id` to `tenancy.workspace(id)`.
- Use explicit `ON DELETE` behavior consistent with the deletion architecture—normally `RESTRICT`/`NO ACTION`, because audited workspace purge deletes child rows in module order. Do not cascade-delete execution/audit history casually.
- Retain composite same-workspace foreign keys between execution entities.
- Preserve `FORCE ROW LEVEL SECURITY`, fail-closed context, and worker/dispatcher behavior.
- If the existing `exec.actor_type` dependency creates an initialization cycle, move truly shared platform vocabulary to a lower-level neutral schema through an expand/contract-safe migration, or otherwise restructure bootstrap ordering cleanly. Do not use the module-layer diagram as a reason to omit referential integrity.
- Update the authoritative implementation ADR and engineering database documentation. Do not rewrite the Phase 0 logical model unless a genuine architecture contradiction is discovered.

Add integration tests proving:

- inserting any tenant execution row for a nonexistent workspace fails even under an operationally privileged migration/test setup;
- deleting a workspace with retained execution rows fails;
- the documented purge order permits deletion once dependent rows are removed;
- all foreign-key columns and referenced columns have appropriate indexes;
- empty-database migration and complete down/up cycles still work.

### 3. Execute the real containerized database path

The Testcontainers path was authored but never run.

Required outcome:

- Run the full migration, RLS, job, outbox, idempotency, and effect integration suite with `PM_TEST_PG=container` against the pinned PostgreSQL image.
- Prove the Testcontainers path starts from an isolated empty database, performs bootstrap/migrations with the intended identities, and cleans up after success and failure.
- Retain embedded PostgreSQL as an optional local fallback, but CI must exercise the container path.
- Record PostgreSQL server version and container image digest in the completion evidence.

Do not install a container runtime on the user's machine without authorization. Use an already available runtime or a real CI runner. If neither is available, the brief remains incomplete.

### 4. Build and execute the production image gate

Filesystem rehearsal is not equivalent to building the image. Execute `scripts/image-smoke.sh` against the actual production image.

The evidence must demonstrate:

- image build succeeds from a clean context;
- runtime user is non-root;
- health check and stop signal are present;
- source files, test packages, test fixtures, `.env` files, repository metadata, build caches, scanners, and development tooling are absent;
- the same image successfully runs `bootstrap`, `migrate up`, `migrate verify`, `web`, `worker`, and `healthcheck`;
- web and worker become healthy against the pinned PostgreSQL container;
- readiness works;
- browser shell is served;
- web and worker stop gracefully under `SIGTERM` with exit code 0;
- credentials and database URLs do not appear in container logs;
- image digest and size are reported.

Run this either locally with an approved container runtime or on the configured CI runner.

### 5. Produce one complete clean verification run

After the corrections, run from a clean dependency/build state:

1. `pnpm install --frozen-lockfile` with no workspace-cycle warning;
2. Phase 0 integration validation;
3. format and lint, including the complete graph checker;
4. type checks and generated-contract checks;
5. unit/component tests;
6. containerized integration/RLS tests;
7. build;
8. built-process smoke tests;
9. browser smoke tests;
10. dependency, license, and secret scans;
11. production image build and runtime smoke.

Do not use `VERIFY_SKIP_IMAGE=1` in the acceptance run. Do not present separate partial runs as though they were one successful clean gate.

If a remote CI runner is used, provide the immutable run URL/identifier and commit SHA. If local, preserve a sanitized complete log under `reports/` and report its checksum.

## Additional review requirements

- Keep `.env`, `.local/`, reports, test results, build outputs, and dependency directories ignored and untracked.
- Do not commit or push unless the product owner asks.
- Do not install Colima, Docker Desktop, Homebrew packages, or other host software without explicit user authorization.
- Do not weaken scanner, migration, image, RLS, or architecture gates.
- The clean verification command must not silently skip a gate based only on runtime absence; it should fail with an actionable message unless an explicitly named developer-only skip is supplied. CI must never skip it.

## Acceptance criteria

- Package manager and enhanced graph checker both report a completely acyclic workspace graph.
- Tenant execution rows have database-enforced workspace foreign keys and deletion behavior tests.
- Testcontainers integration path passes.
- Production image build, inspection, and runtime smoke pass.
- One clean end-to-end verification run passes without skipped acceptance gates.
- Phase 0 integration validator remains green.
- No sensitive or generated local artifacts are tracked.

## Required completion response

Return:

1. Concise correction summary.
2. Every file changed.
3. Before/after package graph and explanation of cycle removal.
4. Migration and foreign-key changes with deletion behavior.
5. Containerized PostgreSQL test evidence.
6. Production image digest, size, non-root identity, runtime commands tested, and smoke result.
7. Complete clean verification command, exit status, log path/checksum, and CI run reference if applicable.
8. Updated test counts and scan results.
9. Any remaining limitation or failed/skipped gate.

Do not report Phase 1A complete while any required gate is skipped.
