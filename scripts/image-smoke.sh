#!/usr/bin/env bash
# Builds the production image and verifies: non-root user, health check, no forbidden content,
# and that the same image runs bootstrap, migrate, web, and worker against PostgreSQL, becomes
# healthy and ready, and stops gracefully on SIGTERM. Requires Docker.
set -euo pipefail
IMAGE="${1:-pm-app:ci}"
PG_IMAGE="postgres:18.6-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650"
NET="pm-smoke-$$"
fail() { echo "IMAGE SMOKE FAILED: $*" >&2; exit 1; }
cleanup() {
  docker rm -f pm-smoke-web pm-smoke-worker pm-smoke-db >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build --pull --build-arg BUILD_VERSION=0.1.0 --build-arg "BUILD_ID=${BUILD_ID:-ci}" -t "$IMAGE" .

echo "== static inspection"
[ "$(docker inspect -f '{{.Config.User}}' "$IMAGE")" = "node" ] || fail "image must run as the non-root node user"
docker inspect -f '{{json .Config.Healthcheck.Test}}' "$IMAGE" | grep -q healthcheck || fail "missing HEALTHCHECK"
[ "$(docker inspect -f '{{.Config.StopSignal}}' "$IMAGE")" = "SIGTERM" ] || fail "stop signal must be SIGTERM"
[ "$(docker run --rm --entrypoint id "$IMAGE" -u)" != "0" ] || fail "runtime uid is root"
docker run --rm --entrypoint sh "$IMAGE" -c '
  set -e
  bad=$(find /app \( -path "*/node_modules/.pnpm" -prune \) -o \( -name ".env*" -o -name ".git" -o -name "*.test.*" -o -name "test-support" -o -name "*.tsbuildinfo" -o -name "*.map" -o \( -name "*.ts" ! -name "*.d.ts" \) -o -name "src" -o -name "test" \) -print)
  [ -z "$bad" ] || { echo "$bad"; exit 1; }
  [ ! -d /pnpm/store ] && [ ! -d /root/.cache ] && [ ! -d /home/node/.cache ]
  ! ls /app/*/node_modules/.pnpm | grep -E "^(vitest|vite@|typescript@|eslint|embedded-postgres|@testcontainers|@playwright)"
' || fail "forbidden content in image"
docker run --rm --entrypoint sh "$IMAGE" -c '
  set -e
  for tool in gitleaks osv-scanner pnpm corepack npm npx yarn tsc vite vitest playwright eslint git; do
    ! command -v "$tool" >/dev/null 2>&1 || { echo "tool present: $tool"; exit 1; }
  done
  [ ! -e /app/.github ] && [ ! -e /app/docs ] && [ ! -e /app/briefs ] && [ ! -e /app/e2e ] && [ ! -e /app/scripts ]
' || fail "scanners, development tools, or repository metadata in image"
echo "image id (digest): $(docker image inspect -f '{{.Id}}' "$IMAGE")"
echo "image size: $(docker image inspect -f '{{.Size}}' "$IMAGE") bytes"
echo "runtime user: $(docker run --rm --entrypoint id "$IMAGE")"

echo "== runtime"
pw() { openssl rand -hex 18; }
ADMIN=$(pw); MIG=$(pw); RES=$(pw); APP=$(pw); WRK=$(pw); DSP=$(pw)
docker network create "$NET" >/dev/null
docker run -d --name pm-smoke-db --network "$NET" -e POSTGRES_USER=pm_admin -e POSTGRES_PASSWORD="$ADMIN" -e POSTGRES_DB=pm_test "$PG_IMAGE" >/dev/null
# Wait on TCP: during first-run init the image serves only its Unix socket from a temporary server.
for _ in $(seq 90); do docker exec pm-smoke-db pg_isready -h 127.0.0.1 -p 5432 -U pm_admin -d pm_test >/dev/null 2>&1 && break; sleep 1; done
docker exec pm-smoke-db pg_isready -h 127.0.0.1 -p 5432 -U pm_admin -d pm_test || fail "PostgreSQL did not become ready on TCP"
url() { echo "postgres://$1:$2@pm-smoke-db:5432/pm_test"; }
run() { docker run --rm --network "$NET" "$@"; }
run -e BOOTSTRAP_ADMIN_URL="$(url pm_admin "$ADMIN")" -e BOOTSTRAP_DATABASE=pm_test \
  -e PM_ROLE_PASSWORD_MIGRATOR="$MIG" -e PM_ROLE_PASSWORD_RESTORE_OPERATOR="$RES" -e PM_ROLE_PASSWORD_APP_RW="$APP" \
  -e PM_ROLE_PASSWORD_APP_WORKER="$WRK" -e PM_ROLE_PASSWORD_DISPATCHER="$DSP" "$IMAGE" bootstrap
run -e APP_ENV=test -e DATABASE_MIGRATOR_URL="$(url migrator "$MIG")" "$IMAGE" migrate up
run -e APP_ENV=test -e DATABASE_MIGRATOR_URL="$(url migrator "$MIG")" "$IMAGE" migrate verify
docker run -d --name pm-smoke-worker --network "$NET" -e APP_ENV=test \
  -e DATABASE_WORKER_URL="$(url app_worker "$WRK")" -e DATABASE_DISPATCHER_URL="$(url dispatcher "$DSP")" "$IMAGE" worker >/dev/null
docker run -d --name pm-smoke-web --network "$NET" -p 127.0.0.1:3999:3000 -e APP_ENV=test \
  -e DATABASE_APP_URL="$(url app_rw "$APP")" "$IMAGE" web >/dev/null
for c in pm-smoke-web pm-smoke-worker; do
  for _ in $(seq 90); do [ "$(docker inspect -f '{{.State.Health.Status}}' $c)" = healthy ] && break; sleep 1; done
  [ "$(docker inspect -f '{{.State.Health.Status}}' $c)" = healthy ] || { docker logs $c; fail "$c not healthy"; }
done
docker exec pm-smoke-web node /app/entrypoint.mjs healthcheck || fail "web healthcheck command failed"
docker exec pm-smoke-worker node /app/entrypoint.mjs healthcheck || fail "worker healthcheck command failed"
curl -fsS http://127.0.0.1:3999/readyz | tee /dev/stderr | grep -q '"status":"ready"' || fail "web not ready"
curl -fsS http://127.0.0.1:3999/ | grep -q '<div id="root">' || fail "browser shell not served"
docker stop -t 30 pm-smoke-web pm-smoke-worker >/dev/null
for c in pm-smoke-web pm-smoke-worker; do
  [ "$(docker inspect -f '{{.State.ExitCode}}' $c)" = 0 ] || { docker logs $c; fail "$c did not stop gracefully"; }
done
docker logs pm-smoke-web 2>&1 | grep -q '"event":"api.stopped"' || fail "web shutdown not logged"
docker logs pm-smoke-worker 2>&1 | grep -q '"event":"worker.stopped"' || fail "worker shutdown not logged"
for c in pm-smoke-web pm-smoke-worker; do
  ! docker logs $c 2>&1 | grep -qE "$APP|$WRK|$DSP|$MIG|$ADMIN|postgres://" || fail "credentials or database URLs in $c logs"
done
echo "IMAGE SMOKE PASSED"
