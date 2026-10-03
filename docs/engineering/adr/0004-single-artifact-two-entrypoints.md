# ADR-0004: Single artifact with web/API and worker entrypoints

Status: accepted (1A). Context: RELEASE_TOPOLOGY §1 ("same artifact, differing only in entrypoint").

**Decision.** One multi-stage OCI image (`Dockerfile`), base `node:24.21.0-bookworm-slim` pinned by
digest. `ENTRYPOINT node /app/entrypoint.mjs`; commands `web` (default), `worker`, `migrate`,
`bootstrap`, `healthcheck`. The runtime stage contains only `pnpm deploy --prod` closures for the
two long-running commands, the built browser assets, and the migrations; it runs as the non-root
`node` user, declares `HEALTHCHECK` (command-aware: HTTP `/healthz` for web, heartbeat file for
worker) and `STOPSIGNAL SIGTERM`. `scripts/image-smoke.sh` verifies non-root, health check, absence
of `.env`/sources/tests/build caches/dev tooling, and runs bootstrap → migrate → web + worker
against PostgreSQL through to graceful shutdown.

**Trade-off.** Two deploy closures duplicate shared dependencies (~80–115 MB each before
compression). A plain `pnpm install --prod --filter` was rejected: pnpm still populated its store
with packages reachable through dev-only workspace edges (test tooling), which a filesystem
rehearsal detected.
