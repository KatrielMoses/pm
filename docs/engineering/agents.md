# Agents (Phase 8B): implementation and operator notes

Engineering record: [ADR-0047](adr/0047-agent-profiles-connectors.md). Closure: [phase8/closure-8b.json](phase8/closure-8b.json), checked by `tools/phase8b.py`. Data: [database.md](database.md#phase-8b-agent-profiles-connectors-and-assignments).

Phase 8B configures agents and assigns them to tasks. **Nothing runs an agent yet**: runs, run credentials, tool calls, progress, artifacts, and emergency stop arrive in 8C; per-action approval and acceptance in 8D. `POST /tasks/{tsk}/agents/{agt}:run` answers `dependency_unavailable`.

## Profiles

- Created blank (internal or external) or from a starter template (development, research, growth, documentation, testing). Every profile starts as a turned-off draft with an empty scope.
- Editing changes only the draft. **Turn on** compiles it, checks that nothing is missing or unavailable, checks grantability for the person and the owner, and selects an immutable revision (identical configuration reuses its revision). Assignments keep the revision they were given.
- Tools come from `docs/architecture/platform/contracts/agent-tools.json`; `pnpm mcp:contracts:generate` regenerates `packages/work/src/agents/tool-registry.ts` (CI checks it is current). A tool marked `unavailable` names the phase that brings it and cannot be granted.
- Readiness is derived on every read: archived, not turned on, off, suspended (`owner_departed`), `owner_authority` (the owner can no longer grant the active scope), `owner_unavailable`, model availability for internal agents (the workspace AI policy now), and connector verification for external agents.

## Connectors and tests

- Kinds: `api` (`POST {endpoint}/pm-agent/handshake`, bearer secret), `webhook` (6B signatures both ways; the `whs_` signing secret is shown once at configuration), `mcp` (`initialize` at `2025-11-25`). Secrets live in the secret store (`agent_connector` purpose); rows hold a reference only.
- Endpoints must be https and public; private, link-local, metadata, and loopback ranges, credentials in URLs, and this product's own endpoints are refused. This product's own tokens are refused as connector secrets.
- A test is a confirmed operation (`{ "confirm": true }`), at most `AGENT_CONNECTOR_TESTS_PER_HOUR` per profile. The `agents.connector_test` job re-decides authority and the connector right before the request, sends only the protocol, version, and a nonce, and records a typed outcome against the settings version it prepared (`stale` if they changed).
- **Transport.** `AGENT_CONNECTOR_TRANSPORT=none` (the default) makes tests `dependency_unavailable`; `fixture` (tests and the browser suite only, refused when deployed) lets them reach the synthetic peers from `startAgentConnectorFixture()` over loopback. Fixture results are labelled synthetic. **Live connectors are blocked** until an approved secret store and credentials exist (DQ-28).

## Outcome codes

| Code | Meaning |
|---|---|
| `bad_signature` | The webhook answer was not signed with the profile's signing secret |
| `protocol_unsupported`, `version_unsupported` | Not `pm-agent/1` version `1` (or MCP not at `2025-11-25`) |
| `nonce_mismatch` | The answer did not echo this test's nonce |
| `too_large` | The answer exceeded `AGENT_CONNECTOR_RESPONSE_MAX_BYTES` (refused, never truncated) |
| `redirect_refused` | The peer redirected; redirects are never followed |
| `malformed_response` | Not a valid bounded manifest |
| `upstream_error`, `timeout` | The peer failed or did not answer within `AGENT_CONNECTOR_TIMEOUT_MS` |
| `transport_unavailable` | No connector transport is configured here |

## Assignments

- On a task, a person with `agent.assign` (edit level; never through a record share) previews, assigns, edits, and withdraws agents. Agents are listed separately from people and never change task status.
- The stored ceiling is the pinned revision's grants ∩ the assigner's access ∩ the explicit scope ∩ the owner's authority. It only narrows: later grants never widen it; lost access shows the assignment as blocked with its reasons (`scope_narrowed`, `scope_lost`, `owner_authority`, `assigner_unavailable`, readiness reasons).
- A personal token may assign only with `agents:execute`; every `/agents` configuration route refuses tokens.

## Limits

`AGENT_PROFILES_PER_WORKSPACE_MAX` (under a workspace lock), `AGENT_ASSIGNMENTS_PER_TASK_MAX` (under the task lock), `AGENT_SCOPE_GRANTS_MAX`, `AGENT_TOOL_GRANTS_MAX`, `AGENT_CONTEXT_REFS_MAX`, `AGENT_CRITERIA_MAX`, `AGENT_INSTRUCTIONS_MAX_CHARS`, `AGENT_ASSIGNMENT_TEXT_MAX_CHARS`, `AGENT_CONFIG_BYTES_MAX`, `AGENT_CONNECTOR_TIMEOUT_MS`, `AGENT_CONNECTOR_RESPONSE_MAX_BYTES`, `AGENT_CONNECTOR_TESTS_PER_HOUR`: technical limits ([environments.md](environments.md)), not plan entitlements (10A).
