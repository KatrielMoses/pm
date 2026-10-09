#!/usr/bin/env bash
# Provider-portable verification: the same ordered gates CI runs. Usage: pnpm verify
# Acceptance runs need a Docker-compatible container runtime: integration tests use Testcontainers
# (PM_TEST_PG=container) and gate 11 builds and runs the production image.
#
# Developer-only escape hatches (refused when CI=true; never valid for acceptance):
#   PM_DEV_ALLOW_EMBEDDED_PG=1   integration tests on embedded PostgreSQL binaries
#   PM_DEV_SKIP_IMAGE_GATE=1     skip the production image gate
set -euo pipefail
step() { printf '\n==> %s\n' "$*"; }
die() { printf '\nVERIFY FAILED: %s\n' "$*" >&2; exit 1; }

if [ "${CI:-}" = "true" ] && { [ -n "${PM_DEV_ALLOW_EMBEDDED_PG:-}" ] || [ -n "${PM_DEV_SKIP_IMAGE_GATE:-}" ]; }; then
  die "developer-only skips are not allowed in CI"
fi
container_runtime() { docker info >/dev/null 2>&1; }
SKIPPED=()

if [ "${PM_DEV_ALLOW_EMBEDDED_PG:-}" = "1" ]; then
  export PM_TEST_PG=embedded
  SKIPPED+=("containerized PostgreSQL (PM_DEV_ALLOW_EMBEDDED_PG=1)")
else
  export PM_TEST_PG=container
  container_runtime || die "no container runtime reachable (docker info failed). Integration tests require Testcontainers; start Docker/Podman, or set PM_DEV_ALLOW_EMBEDDED_PG=1 for a developer-only run."
fi
if [ "${PM_DEV_SKIP_IMAGE_GATE:-}" != "1" ] && ! container_runtime; then
  die "no container runtime reachable for the production image gate; set PM_DEV_SKIP_IMAGE_GATE=1 for a developer-only run."
fi

step "1. clean install with lockfile enforcement (no workspace cycles)"
install_log=$(mktemp)
pnpm install --frozen-lockfile 2>&1 | tee "$install_log"
if grep -qi "cyclic workspace dependencies" "$install_log"; then die "pnpm reported cyclic workspace dependencies"; fi
step "2. Phase 0 integration validator and Phase 1, 2, 3A, 3B, 3C, 3D, 3E, 4A, 4B, 4C, 4D, 4E, 5A, 5B, and the Phase 5 aggregate closure checks"
python3 docs/architecture/tools/phase0.py
python3 docs/engineering/tools/phase1.py
python3 docs/engineering/tools/phase2.py
python3 docs/engineering/tools/phase3.py
python3 docs/engineering/tools/phase3d.py
python3 docs/engineering/tools/phase3b.py
python3 docs/engineering/tools/phase3c.py
python3 docs/engineering/tools/phase3e.py
python3 docs/engineering/tools/phase4a.py
python3 docs/engineering/tools/phase4b.py
python3 docs/engineering/tools/phase4c.py
python3 docs/engineering/tools/phase4d.py
python3 docs/engineering/tools/phase4e.py
python3 docs/engineering/tools/phase5a.py
python3 docs/engineering/tools/phase5b.py
python3 docs/engineering/tools/phase5.py
step "3. formatting and lint (incl. SQL safety and the complete workspace graph)"
pnpm format:check
pnpm lint
step "4. type checks (sources, tests, browser app) + generated contracts are current"
pnpm contracts:generate:check
pnpm typecheck
step "5. unit and component tests"
pnpm test:unit
step "6. migrations, tamper checks, workspace integrity, RLS and integration tests (PostgreSQL: $PM_TEST_PG)"
pnpm test:integration
step "7. application build"
pnpm build
step "8. API/worker process smoke against the built artifact"
PM_SMOKE_DIST=1 pnpm vitest run --project integration apps/worker
step "9. browser smoke (Playwright, built artifact)"
PM_SMOKE_DIST=1 pnpm test:e2e
step "10. dependency, license, and secret scanning"
pnpm scan:deps
pnpm deps:licenses
pnpm scan:secrets
if [ "${PM_DEV_SKIP_IMAGE_GATE:-}" = "1" ]; then
  SKIPPED+=("production image gate (PM_DEV_SKIP_IMAGE_GATE=1)")
else
  step "11. production image build, non-root/health inspection, and runtime smoke"
  bash scripts/image-smoke.sh
fi

if [ ${#SKIPPED[@]} -gt 0 ]; then
  printf '\nVERIFY: DEVELOPER RUN - NOT AN ACCEPTANCE RESULT. Skipped:\n' >&2
  printf '  - %s\n' "${SKIPPED[@]}" >&2
  exit 3
fi
printf '\nVERIFY: all gates passed\n'
