# ADR-0032: Integration framework (Phase 6A)

Status: **proposed** (decisions recorded before code; implemented; awaiting one clean current-head no-skip CI run on the draft PR).
Extends ADR-0031 at the top of the work service chain. Reuses the vault, audit, lifecycle, search, notifications, and job runtime. Does not implement public API tokens, webhooks, or Google Calendar.

## Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Connection authority | `integrations.connection` (`conn_`) is a core record, workspace- or brand-scoped, with an owner, granted scopes, and a health. OAuth and API-key connections share this row. |
| D2 | Credentials | The row stores `credential_secret_ref` only. The vault holds AES-256-GCM ciphertext. Responses, events, audit changes, logs, and search never contain the secret. `key_id` records which vault key wrapped it. Rotation writes a new reference and destroys the old one. |
| D3 | Least privilege | A connection stores only scopes the provider offers. Sync reads require `read`. Applying remote changes requires `write`. A degraded provider does not write. |
| D4 | Authorization | `integrations.configure` and `integration.sync_now` are decided at the connection's placement. Guests are forbidden. A hidden brand connection and an unknown connection are both `not_found`. Sensitive brands need an explicit manage grant. |
| D5 | Disconnect and retention | Disconnect always destroys the vault secret. The user chooses `retain` (default) or `remove`. Remove deletes identities, checkpoints, conflicts, and deliveries in this product and does not call the remote system (DQ-37). Sync run history is kept. |
| D6 | Departure | The connection moves to the chosen member. The secret is destroyed and health becomes `needs_reauthorization` with `owner_departed`. The successor must reauthorize. |
| D7 | Sync | Checkpoints advance by compare-and-set. A delivery dedupe key makes a repeated sync a no-op. Transient failures back off and dead-letter at `SYNC_MAX_ATTEMPTS`. Permanent and unconfigured failures dead-letter without pretending success. |
| D8 | Conflicts | When local and remote versions both differ from the last synced base, an open conflict is recorded with versions only. The user keeps local, keeps remote, or dismisses it once. |
| D9 | Providers | Loopback is the in-process provider, on for local and test unless `INTEGRATION_LOOPBACK_ENABLED=0`, and off elsewhere unless set to `1`. Google Calendar (6C), GitHub (9A), and email forwarding (OD-29) are listed as not configured. |
| D10 | Provenance | User actions are audited as the member. Sync writes are audited as actor type `integration` on behalf of the owner, with `source_kind` integration. |
| D11 | Reuse | Search indexes the connection name and provider, governed by the connection record. Integration failures notify the owner through the existing `integration_failure` type. Purge deletes children and the vault secret. |
| D12 | Boundaries | No public API tokens, inbound or outbound webhooks, Google Calendar events, or email forwarding addresses. |

## Requirement closure

6A owns INT-001 to INT-009, INT-023 to INT-025, WSB-013, and PERM-009. CAP-006 stays deferred (OD-29). INT-010 to INT-022 and INT-026 are later phases.

## Acceptance tests (0C AZ-40)

| Test | Test file | Test title |
|---|---|---|
| AT-298 | packages/work/test/integration/integrations.test.ts | refuses a guest and a member without authority, and hides another brand |
| AT-299 | packages/work/test/integration/integrations.test.ts | stores credentials only as a vault reference and never returns them |
| AT-300 | packages/work/test/integration/integrations.test.ts | rotates a credential onto a new vault reference and destroys the old one |
| AT-301 | packages/work/test/integration/integrations.test.ts | tests, reauthorizes, and disconnects with a retention choice |
| AT-302 | packages/work/test/integration/integrations.test.ts | advances a checkpoint once under a repeated sync and dead-letters a failing provider |
| AT-303 | packages/work/test/integration/integrations.test.ts | opens a conflict when both sides changed and resolves it once |
| AT-304 | packages/work/test/integration/integrations.test.ts | reports an unconfigured provider and a degraded provider honestly |
| AT-305 | packages/work/test/integration/integrations.test.ts | suspends and revokes the secret when the owner leaves |
| AT-306 | packages/work/test/integration/integrations.test.ts | answers unknown and hidden connections the same way |
| AT-307 | e2e/integrations.spec.ts | connects with an API key, sees status, and disconnects |
| AT-308 | apps/web/test/integrations.test.tsx | names the owner, scopes, and last success without showing a secret |
| AT-309 | packages/work/test/unit/integration-sync.test.ts | backs off and stops at the attempt bound |

## Migration and rollback evidence

Migration `0045_integration_framework` creates schema `integrations` and six tables, each with workspace row-level security and an index on every foreign key, adds `key_id` to the development vault, and adds payload-free `exec_dispatch.discover_integration_work`. Its down migration restores the exact 0044 catalog.

## Consequences

The API gains connection, test, reauthorize, disconnect, sync, conflict, and rotation routes (PL-42). The worker gains `integrations.sync`. The service chain ends in `IntegrationService`. Eight named bounds (owner 6A), seven events, and two signals are registered. No new authorization action is added (122).
