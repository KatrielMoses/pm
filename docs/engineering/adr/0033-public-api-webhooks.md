# ADR-0033: Public API tokens and webhooks (Phase 6B)

**Numbering.** Phase 6B was built in parallel with 6A from the Phase 5 final integration head; 6A was integrated first and keeps migration `0045`, ADR-0032, 0B ADR-40, 0C AZ-40, and threats T-73 to T-80 with tests AT-310 to AT-309. Phase 6C integration renumbered 6B to migration `0046`, ADR-0033, 0B ADR-41, 0C AZ-41, threats T-81 to T-85, and tests AT-310 to AT-314.

Status: **proposed** (decisions recorded before code; implemented; awaiting one clean current-head no-skip CI run on the draft PR).

Extends the Phase 5 final integration. Does not implement provider connections (6A) or calendar sync (6C).

Accepted sources: 0D HTTP, idempotency, and webhook contracts; 0C delegation for `api_token_personal`, `service_principal`, and `inbound_webhook`; 0B entities `api_token`, `webhook_subscription`, `webhook_delivery`, `inbound_endpoint`, and `inbound_message`.

## Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Tokens | Personal tokens act as their creator. Service tokens act as the accountable owner, narrowed to explicit scopes, and require an expiry. Secrets are shown once, stored as SHA-256, and never written to logs, errors, or later reads. |
| D2 | Authority | Every request loads the membership and applies the canonical compiler and RLS. A token's scopes and optional brand list only narrow that result. |
| D3 | Rotation and revocation | Rotating a token replaces the hash immediately. Revocation is terminal. A service token is suspended when its owner leaves. |
| D4 | Public writes | Existing record routes accept a bearer token. Writes keep `Idempotency-Key`. The command source is `api` or `webhook`, with the token's public id as the source reference. |
| D5 | Bounds | Rate, body, page, export, webhook, replay-window, and per-destination concurrency limits are registered and enforced. Excess outbound deliveries wait; they are not dropped. |
| D6 | Outbound | Subscriptions are records. Payloads use the version 1 allow-list (no internal ids, no response bodies). HMAC-SHA256 covers id, timestamp, and raw body. Delivery is at least once, retried with jitter, then dead-lettered. A manager can replay. |
| D7 | Inbound | `POST /v1/hooks/{token}` verifies size, signature, and timestamp before any tenant detail is returned. Unknown endpoints, bad signatures, and stale timestamps are the same `unauthenticated` error. Duplicates return 202. Invalid payloads are quarantined. |
| D8 | Capture | API and inbound `task.capture` create inbox items through the 2E capture service, with source `api` or `webhook`. |
| D9 | Disablement | After `WEBHOOK_DISABLE_THRESHOLD` consecutive failures the subscription is `disabled_endpoint` and `integrations.webhook.delivery_failed` notifies the owner. |
| D10 | SSRF | Destinations are HTTPS with no redirects. Private and loopback addresses are refused except when `WEBHOOK_ALLOW_LOOPBACK` is on for local and test. |
| D11 | Lifecycle | Brand-scoped subscriptions leave with the brand. Departure suspends subscriptions, inbound endpoints, and service tokens. |
| D12 | Boundaries | No provider connection, OAuth install, sync checkpoint, or calendar mirror is created here. |

## Requirement closure

Owned: CAP-008, INT-010 through INT-021, INT-029. Contributions: AGT-007, TEST-010, AUTO-008, INT-028, SEC-009, ADM-007.

## Acceptance tests

| AT-310 | packages/work/test/integration/public-api.test.ts | AT-310 shows a personal token once and omits it from later reads |
| AT-311 | packages/work/test/integration/public-api.test.ts | AT-311 refuses a read-only token that tries to create a task |
| AT-312 | packages/work/test/integration/public-api.test.ts | AT-312 keeps a brand-scoped token inside that brand |
| AT-313 | packages/work/test/integration/public-api.test.ts | AT-313 accepts a signed inbound capture and rejects a bad signature the same way |
| AT-314 | packages/work/test/integration/public-api.test.ts | AT-314 signs an outbound delivery and retries a server error |
