#!/usr/bin/env bash
# Provider-portable verification: the same ordered gates CI runs. Usage: pnpm verify
# Acceptance runs need a Docker-compatible container runtime: integration tests use Testcontainers
# (PM_TEST_PG=container) and gate 11 builds and runs the production image.
#
# Developer-only escape hatches (refused when CI=true; never valid for acceptance):
#   PM_DEV_ALLOW_EMBEDDED_PG=1   integration tests on embedded PostgreSQL binaries
#   PM_DEV_SKIP_IMAGE_GATE=1     skip the production image gate
#
# PM_VERIFY_SHARD splits the same gates across parallel CI jobs so each fits its time limit; an
# acceptance result needs every shard green on one head. Default (unset/"all") runs every gate.
#   core            gates 1-8, 10, 11 (everything except the browser smoke)
#   e2e-desktop     gates 1, 7 and the desktop browser project of gate 9
#   e2e-tablet      gates 1, 7 and the tablet browser project of gate 9
#   e2e-mobile      gates 1, 7 and the mobile browser project of gate 9
set -euo pipefail
step() { printf '\n==> %s\n' "$*"; }
die() { printf '\nVERIFY FAILED: %s\n' "$*" >&2; exit 1; }

if [ "${CI:-}" = "true" ] && { [ -n "${PM_DEV_ALLOW_EMBEDDED_PG:-}" ] || [ -n "${PM_DEV_SKIP_IMAGE_GATE:-}" ]; }; then
  die "developer-only skips are not allowed in CI"
fi
container_runtime() { docker info >/dev/null 2>&1; }
SKIPPED=()
SHARD="${PM_VERIFY_SHARD:-all}"
case "$SHARD" in
  all|core|e2e-desktop|e2e-tablet|e2e-mobile) ;;
  *) die "unknown PM_VERIFY_SHARD: $SHARD" ;;
esac
# gate_in <shard>...: true when the running shard includes the gate ("all" includes everything).
gate_in() { local s; [ "$SHARD" = "all" ] && return 0; for s in "$@"; do [ "$s" = "$SHARD" ] && return 0; done; return 1; }
# The Playwright projects defined in playwright.config.ts (scripts/test/verify-shards.test.mjs keeps
# this list equal to the config). An e2e shard runs its one project; a full local run names every
# real project; there is no aggregate project.
E2E_PROJECTS="desktop tablet mobile"
e2e_args() {
  local p
  case "$1" in
    e2e-*) printf -- '--project=%s\n' "${1#e2e-}" ;;
    all) for p in $E2E_PROJECTS; do printf -- '--project=%s\n' "$p"; done ;;
  esac
}
# PM_VERIFY_PRINT_E2E=1: print the browser-gate arguments for this shard and stop (tooling test).
if [ "${PM_VERIFY_PRINT_E2E:-}" = "1" ]; then e2e_args "$SHARD"; exit 0; fi

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
if gate_in core; then
  step "2. Phase 0 integration validator, Phase 1-5 closure checks with the Phase 5 aggregate, Phase 6A-6E closure checks with the Phase 6 aggregate, the Phase 7A-7F closure checks with the Phase 7 aggregate, the P8-W0 effect-recovery check, the Phase 8A automation-engine check, the Phase 8B agent check, and the Phase 8C agent run check"
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
  python3 docs/engineering/tools/phase5c.py
  python3 docs/engineering/tools/phase5d.py
  python3 docs/engineering/tools/phase5.py
  python3 docs/engineering/tools/phase6a.py
  python3 docs/engineering/tools/phase6b.py
  python3 docs/engineering/tools/phase6c.py
  python3 docs/engineering/tools/phase6d.py
  python3 docs/engineering/tools/phase6e.py
  python3 docs/engineering/tools/phase6.py
  python3 docs/engineering/tools/phase7a.py
  python3 docs/engineering/tools/phase7b.py
  python3 docs/engineering/tools/phase7d.py
  python3 docs/engineering/tools/phase7c.py
  python3 docs/engineering/tools/phase7e.py
  python3 docs/engineering/tools/phase7f.py
  python3 docs/engineering/tools/phase7.py
  python3 docs/engineering/tools/phase8w0.py
  python3 docs/engineering/tools/phase8a.py
  python3 docs/engineering/tools/phase8b.py
  python3 docs/engineering/tools/phase8c.py
  step "3. formatting and lint (incl. SQL safety and the complete workspace graph)"
  pnpm format:check
  pnpm lint
  step "4. type checks (sources, tests, browser app) + generated contracts are current"
  pnpm contracts:generate:check
  pnpm mcp:contracts:generate:check
  pnpm typecheck
  step "5. unit and component tests"
  pnpm test:unit
  step "6. migrations, tamper checks, workspace integrity, RLS and integration tests (PostgreSQL: $PM_TEST_PG)"
  pnpm test:integration
fi
if gate_in core e2e-desktop e2e-tablet e2e-mobile; then
  step "7. application build"
  pnpm build
fi
if gate_in core; then
  step "8. API/worker process smoke against the built artifact"
  PM_SMOKE_DIST=1 pnpm vitest run --project integration apps/worker
fi
E2E_ARGS="$(e2e_args "$SHARD")"
if [ -n "$E2E_ARGS" ]; then
  # Project names contain no spaces, so word splitting yields one argument per line.
  # shellcheck disable=SC2086
  step "9. browser smoke (Playwright, built artifact, $(echo $E2E_ARGS))"
  # shellcheck disable=SC2086
  PM_SMOKE_DIST=1 pnpm test:e2e $E2E_ARGS
fi
if gate_in core; then
  step "10. dependency, license, and secret scanning"
  pnpm scan:deps
  pnpm deps:licenses
  pnpm scan:secrets
fi
if ! gate_in core; then
  :
elif [ "${PM_DEV_SKIP_IMAGE_GATE:-}" = "1" ]; then
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
if [ "$SHARD" = "all" ]; then printf '\nVERIFY: all gates passed\n'; else printf '\nVERIFY: shard %s passed (acceptance needs every shard green on one head)\n' "$SHARD"; fi
