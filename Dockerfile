# syntax=docker/dockerfile:1.7
# One production image, two long-running commands (web, worker) plus operational commands
# (migrate, bootstrap). Base image pinned by digest; Node and pnpm versions match the repository.
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

# --- build: full install, compile, bundle the browser app ------------------------------------
FROM ${NODE_IMAGE} AS build
ENV CI=true PNPM_HOME=/pnpm
RUN corepack enable && corepack prepare pnpm@12.8.1 --activate
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/audit/package.json packages/audit/
COPY packages/db/package.json packages/db/
COPY packages/identity/package.json packages/identity/
COPY packages/lifecycle/package.json packages/lifecycle/
COPY packages/observability/package.json packages/observability/
COPY packages/platform/package.json packages/platform/
COPY packages/test-infra/package.json packages/test-infra/
COPY packages/test-support/package.json packages/test-support/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm run contracts:generate:check && pnpm exec tsc -b && pnpm --filter @pm/web build

# --- deploy: isolated production closures for the two long-running commands --------------------
# `pnpm deploy` copies each command's production dependency closure (workspace packages included,
# limited to their `files`), so build tooling, test packages, and sources never reach the image.
RUN pnpm --filter @pm/api deploy --prod --legacy /out/api \
 && pnpm --filter @pm/worker deploy --prod --legacy /out/worker \
 && mkdir -p /out/web && cp -R apps/web/dist /out/web/dist \
 && cp scripts/container-entrypoint.mjs /out/entrypoint.mjs \
 && find /out -name '*.tsbuildinfo' -delete \
 && find /out -path '*/dist/*' -name '*.map' -delete

# --- runtime: deployed closures, migrations, static web assets; non-root ------------------------
FROM ${NODE_IMAGE} AS runtime
ARG BUILD_VERSION=0.0.0-dev
ARG BUILD_ID=dev
ENV NODE_ENV=production BUILD_VERSION=${BUILD_VERSION} BUILD_ID=${BUILD_ID} \
    HTTP_HOST=0.0.0.0 HTTP_PORT=3000 WEB_DIST_DIR=/app/web/dist WORKER_HEALTH_FILE=/tmp/pm-worker-health
WORKDIR /app
# The runtime needs only `node`: remove the package managers bundled with the base image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && rm -rf /root/.npm /tmp/*
COPY --from=build /out /app
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 CMD ["node", "/app/entrypoint.mjs", "healthcheck"]
ENTRYPOINT ["node", "/app/entrypoint.mjs"]
CMD ["web"]
