# ADR-0002: React/Vite browser app and Fastify API in one deployable codebase

Status: accepted (1A). Context: RELEASE_TOPOLOGY §1 (web/API unit serves UI, `/v1`, SSE).

**Decision.** React 19 + Vite 8 build static assets; Fastify 5 serves them same-origin from the
web/API process (`@fastify/static`, SPA fallback for client routes, CSP, immutable asset caching)
alongside `/v1`, `/healthz`, `/readyz`. No separate frontend server, no Next.js, no GraphQL. The
browser bundle may import only `@pm/config/public` (lint rule); it learns build info from
`/v1/status`. Fastify's logger is off (allow-listed logging), it accepts JSON only, and every
error path returns a registry error envelope. Fastify handles SSE natively (long-lived replies);
the live-update endpoint itself is 1E.

**Consequences.** One origin: no CORS, cookies stay first-party (1B). A CDN can front static
assets later without code changes.
