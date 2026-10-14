# ADR-0035: MCP-compatible access foundation (Phase 6E)

Status: **proposed** (implementation candidate; acceptance evidence pending).

Extends ADR-0033's public API and policy boundary. The MCP endpoint is a transport adapter over existing workspace commands; it does not create a second authorization policy or business model.

## Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Protocol | Support the stable MCP `2025-11-25` JSON-RPC Streamable HTTP request shape on one workspace-scoped POST endpoint. Return JSON responses; GET/DELETE return 405 because this service does not expose server streams or session state. |
| D2 | Authority | OAuth access tokens are hash-only, short-lived, workspace-bound, and narrowed by active member consent. Each call resolves live consent and membership, then delegates to existing task commands and the compiled policy checks. MCP tool descriptions and schemas confer no authority. |
| D3 | Registry | Publish only the static, versioned `pm.tasks.*` tools and `pm://workspace/mcp/*` resources registered in `packages/work/src/integrations/mcp/registry.ts`. Inputs, pages, and response bytes are bounded. |
| D4 | Mutations | Tool mutations require a caller-supplied idempotency key; destructive operations require explicit `confirm: true`. Replays render current resource state and never repeat a one-time client or access secret. |
| D5 | Audit | Invocation rows record the workspace, actor membership/principal, public actor label, consent/token reference, registered name/version, outcome, bounded duration, and a fixed safe detail. Request arguments and credentials are not recorded. Existing lifecycle/audit events remain the source of domain change facts. |
| D6 | Transport limits | One request is bounded by configured timeout, per-token read/write rate limits, JSON output byte ceiling, and non-streaming pagination cursors. Notifications receive HTTP 202 with no body. A cancellation notification is audited but cannot interrupt work already executing. A disconnected client may not infer cancellation; mutations remain safe to retry with the same key. |
| D7 | Degraded mode | With `MCP_ENABLED=0`, capability discovery reports disabled and invocation returns a safe unconfigured error. OAuth client records and secrets are not exposed by MCP resources. |

## Consequences

- Existing API routes, event payloads, and task policy decisions remain authoritative.
- There is no agent autonomy, AI retrieval, provider SDK dependency, long-running task store, or MCP-specific domain workflow in this phase.
- The standard HTTP transport permits JSON responses and optional SSE. This implementation explicitly does not offer SSE or persistent sessions; clients must use one POST request/response at a time.
