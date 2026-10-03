# 9. Webhook contracts

## 9.1 Outbound webhooks

| Aspect | Contract |
|---|---|
| Subscriptions | `integrations.webhook_subscription`: workspace- or brand-scoped, owned by an accountable member, `api_version` pinned, event type filter (public webhook types only; 20 at launch), destination URL |
| Destination rules | HTTPS only. Redirects are not followed. Private, loopback, and link-local addresses are rejected at configuration **and** at connect time (SSRF). Response timeout `WEBHOOK_RESPONSE_TIMEOUT`. |
| Envelope | Public schema `webhook-outbound`: `{id: "evt_…", type, api_version, created_at, workspace, brand?, data: {object: {id, type, version}, fields: {allow-listed}, changes: [field names]}}`. Maximum class C2. |
| Payload authorization | Built **at delivery time** as the subscription's accountable owner, intersected with the subscription scope and a per-type field allow-list (0C §9.5). If the owner can no longer read the record, the delivery is skipped and recorded. A subscription whose owner lost authority is suspended. |
| Headers | `Webhook-Id: evt_…` (stable across retries), `Webhook-Timestamp: <unix seconds>`, `Webhook-Signature: v1,<base64 HMAC-SHA256>`, `Content-Type: application/json`, `User-Agent` |
| Signature | HMAC-SHA256 with the subscription secret over `"{Webhook-Id}.{Webhook-Timestamp}.{raw body}"`. During rotation, both the old and new signatures are sent (space-separated `v1,…` entries) until the old secret is retired. Secrets live in the secret store and are shown once. |
| Success | Any 2xx within the timeout |
| Retry | On timeout, network error, 408, 425, 429, and 5xx, with exponential backoff and full jitter (the same parameters as jobs) up to the cap. On other 4xx, no retry: the delivery is `failed`. |
| Unknown outcome | Webhooks are `deduplicated_by_receiver` ([05 §5.4](05-idempotency-and-effects.md#54-external-effects-never-exactly-once)). Retries carry the same `Webhook-Id`, and **receivers must deduplicate by it**. Delivery is at least once and never exactly once. |
| Delivery history | `webhook-delivery` records: attempt, state, response status, duration, and next attempt. **Response bodies are not stored.** Visible to webhook managers (INT-015). |
| Disablement | After the `WEBHOOK_DISABLE_THRESHOLD` failure policy, the endpoint becomes `disabled_endpoint`. The owner is notified (the `integrations.webhook.delivery_failed` event), and re-enabling requires a successful test. |
| Test delivery | `webhook.test_send` sends `type: "webhook.test"` with a synthetic payload containing no tenant data |
| Rate limits | Per-destination concurrency and rate caps. Excess deliveries queue (`retry_scheduled`) and are never dropped silently. |

## 9.2 Inbound webhooks

| Aspect | Contract |
|---|---|
| Endpoint | `POST /v1/hooks/{endpoint_public_token}`. The token is random and unguessable, and it is **not** the workspace or resource ID. |
| Verification order | (1) Size and content-type limits. (2) Signature verification with the endpoint secret (provider scheme or our `Webhook-Signature` scheme). (3) Timestamp within `WEBHOOK_TIMESTAMP_TOLERANCE`. (4) Dedupe by `(endpoint, provider_event_id)`. **All of this happens before any tenant or resource lookup is exposed.** Unknown endpoint, bad signature, and expired timestamp all return the same `unauthenticated` error. |
| Acknowledgement | Once the message is durably stored (`integrations.inbound_message`), return `202` with an empty body. Processing is asynchronous through the consumer inbox. Duplicates return the same `202`. |
| Generic envelope | Public schema `webhook-inbound-generic`: `{event_id, type, occurred_at, data}` for our generic intake (test results, task creation). Provider-specific formats are adapted into it. |
| Authority | The endpoint principal can invoke exactly one configured intake action into one configured scope (0C §9.5). Payload fields naming other brands are rejected during processing and recorded, never echoed. |
| Secrets | Endpoint secrets can be rotated with an overlap during which both are accepted |

## 9.3 Payload allow-lists

Each public webhook type has a versioned allow-list of fields, published in the API documentation (INT-019) and limited to ≤ C2. Fields not on the list never leave, even when the internal event contains them.
