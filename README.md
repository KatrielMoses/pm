# PM — engineering README

Modular-monolith SaaS foundation (Phase 1A) with identity and sessions (Phase 1B). One TypeScript codebase, one production image, two
long-running commands:

| Process | Command (image) | Source | Does | Never does |
|---|---|---|---|---|
| **Web/API** | `web` | `apps/api` | Serves the browser app, the `/v1` JSON API, `/healthz`, `/readyz` | Claim jobs or dispatch the outbox |
| **Worker** | `worker` | `apps/worker` | Claims durable jobs, dispatches the outbox, recovers expired leases, runs retention sweeps | Accept inbound traffic (no public ingress) |
| Migrate (one-shot) | `migrate up` | `packages/db` | Applies reviewed SQL migrations as the `migrator` identity | Run inside web or worker |

Accepted architecture (authoritative; do not edit casually): [docs/architecture/PHASE_0_DECISIONS.md](docs/architecture/PHASE_0_DECISIONS.md),
[RELEASE_TOPOLOGY.md](docs/architecture/RELEASE_TOPOLOGY.md). Engineering notes and ADRs: [docs/engineering/](docs/engineering/README.md).

## Requirements

- Node.js **24.21.0** (active LTS; pinned in `.node-version`, `package.json#engines`)
- pnpm **12.8.1** (pinned in `package.json#packageManager`; `corepack enable` or any pnpm ≥ 10 switches automatically)
- Python 3.9+ (Phase 0 validators)
- PostgreSQL 18 from **one** of: Docker (Compose/Testcontainers) **or** nothing at all — `pnpm db:local`
  downloads real PostgreSQL binaries (`embedded-postgres`) into `node_modules` and keeps data in `.local/pg`.

## Quick start

```sh
pnpm install --frozen-lockfile
pnpm db:local          # terminal 1: PostgreSQL on 127.0.0.1:54329, roles, migrations, writes .env
pnpm dev               # terminal 2: web/API :3000, worker, Vite dev server :5173 (proxies /v1)
```

Open http://localhost:5173 (or the port Vite prints) and create an account at `/register`. Local
mail (verification, reset, security notices) is not sent; the worker writes each message to
`.local/mailbox/` as a file. Open the link it contains to continue. The local OAuth provider
(`OAUTH_PROVIDERS=local`) is a deterministic test stand-in, not a real identity provider.

With Docker instead:

```sh
cp compose.env.example compose.env    # replace every value
docker compose --env-file compose.env up --build   # db -> bootstrap -> migrate -> web + worker
```

## Commands

| Goal | Command |
|---|---|
| Install (lockfile enforced) | `pnpm install --frozen-lockfile` |
| Local database (no Docker) | `pnpm db:local` |
| Local development (web/API + worker + Vite) | `pnpm dev` |
| Build (contracts check, `tsc -b`, Vite) | `pnpm build` |
| Unit + component tests | `pnpm test:unit` |
| Integration tests (real PostgreSQL: migrations, RLS, jobs, outbox, API, processes) | `pnpm test:integration` |
| Browser smoke (Playwright; run `pnpm build` first) | `pnpm test:e2e` |
| All Phase 0 validators | `pnpm validate:phase0` |
| Lint (ESLint + SQL safety + package graph) / format | `pnpm lint`, `pnpm format:check` |
| Type checks (sources, tests, browser) | `pnpm typecheck` |
| Migrations | `pnpm migrate up [--contract]`, `pnpm migrate verify`, `pnpm migrate status`, `pnpm migrate down --to N` (local/test only) — after `pnpm build` |
| Regenerate contract constants from the 0D registry | `pnpm contracts:generate` |
| Dependency / license / secret scans | `pnpm scan:deps`, `pnpm deps:licenses`, `pnpm scan:secrets` |
| **Everything CI runs (acceptance gate)** | `pnpm verify` — needs a container runtime; developer-only escapes `PM_DEV_ALLOW_EMBEDDED_PG=1`, `PM_DEV_SKIP_IMAGE_GATE=1` exit 3 and are refused in CI |

Integration tests pick PostgreSQL via `PM_TEST_PG`: `container` (Testcontainers, CI default),
`embedded` (real binaries, no Docker), `external` (`PM_TEST_PG_ADMIN_URL`), or `auto`.

## Repository layout

```text
apps/web            React + Vite browser app (imports only @pm/config/public)
apps/api            Fastify web/API process (serves apps/web/dist same-origin)
apps/worker         Worker process (job runtime, outbox dispatch, maintenance)
packages/contracts  Constants generated from the 0D registry + IDs, envelopes, execution context
packages/config     Typed fail-fast configuration, secrets boundary, browser-safe public config
packages/db         Pools, fail-closed tenant transactions, discovery, migrator, SQL migrations, role bootstrap
packages/observability  Allow-listed JSON logger, redaction, OpenTelemetry tracing/metrics, error reporting
packages/platform   Operations, jobs, outbox/inbox, idempotency, external effects, worker runtime
packages/identity   Accounts, passwords, sessions, MFA, step-up, OAuth boundary, rate limits, mail outbox (1B)
packages/test-infra     Leaf test infrastructure (no @pm deps): disposable PostgreSQL, databases, 0D schema validation
packages/test-support   Downstream test support: binds @pm/db bootstrap/migrator, fixtures, harness, Vitest global setup
e2e/                Playwright browser smoke
scripts/            verify, scans, guards, local tooling, container entrypoint
```

Package graph (enforced by `scripts/check-workspace-graph.mjs` and pnpm's own cycle check): the
**complete** graph (dependencies, devDependencies, optionalDependencies, peerDependencies) is
acyclic, and runtime edges follow `contracts`, `config` → `observability` → `db` → `platform` →
`identity` → `api`, `worker`; `web` → `config/public`. Test packages are dev-only: `test-infra` is a leaf any
package may use; `test-support` sits downstream of `db` and is used only by `platform`, `api`,
`worker`, and e2e. Details: [ADR-0001](docs/engineering/adr/0001-typescript-pnpm-modular-monolith.md#package-graph).

## Dependencies

Exact versions only (`saveExact`); the lockfile is committed and CI installs with
`--frozen-lockfile`. pnpm's release-age supply-chain policy is on, and install scripts run only
for allow-listed packages (`allowBuilds` in `pnpm-workspace.yaml`). Inventory and licenses:
[docs/engineering/dependency-inventory.md](docs/engineering/dependency-inventory.md); policy:
[ADR-0006](docs/engineering/adr/0006-dependency-policy.md).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `invalid configuration: APP_ENV ...` | Set `APP_ENV` (`local` reads `.env`; nothing else does). Run `pnpm db:local` to generate `.env`. |
| `must authenticate as role app_rw` | Each process uses its own identity; see [environments](docs/engineering/environments.md#database-identities). |
| `database is bound to a different environment` | The database was migrated for another `APP_ENV`. Use a database from the right namespace. |
| `/readyz` 503 with `dispatcher: fail` | No worker is running (or its heartbeat is stale). Start `pnpm dev` or the worker command. |
| `/readyz` 503 with `migrations: fail` | The database is behind the artifact: run `pnpm migrate up`. |
| Sign-in or form posts return `403 forbidden` locally | The page origin is not allowed. Use `PUBLIC_BASE_URL` (default http://localhost:5173) or add the origin to `ALLOWED_ORIGINS`. |
| No verification email arrives | Local mail is captured to `.local/mailbox/`, and only while the worker runs (`pnpm dev`). |
| `SECRET_VAULT`/`MAIL_TRANSPORT` rejected in a deployed mode | Expected: no KMS or mail provider is approved yet ([ADR-0008](docs/engineering/adr/0008-identity-and-sessions.md#production-blockers-product-owner-decisions)). |
| `migration history verification failed` | A migration file changed after it was applied. Never edit applied migrations; add a new one. |
| Integration tests hang on start | No Docker and `PM_TEST_PG=container`; use `PM_TEST_PG=embedded`. |
| Vite says port 5173 is in use | Another program holds it; Vite picks the next port automatically. |
| Playwright: `Run pnpm build before...` | The browser smoke serves the built app: `pnpm build && pnpm test:e2e`. |
