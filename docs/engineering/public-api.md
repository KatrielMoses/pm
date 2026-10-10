# Public API (v1)

Bearer tokens use `Authorization: Bearer pm_…`. The secret is shown once when the token is created or rotated. A token never widens the member's access: scopes and an optional brand list only narrow it. Writes send `Idempotency-Key`.

```bash
curl -sS https://example.com/v1/workspaces/wsp_EXAMPLE/tasks \
  -H "authorization: Bearer <token>" \
  -H "content-type: application/json"
```

Create a task:

```bash
curl -sS -X POST https://example.com/v1/workspaces/wsp_EXAMPLE/tasks \
  -H "authorization: Bearer <token>" \
  -H "content-type: application/json" \
  -H "idempotency-key: example-write-0001" \
  -d '{"title":"Ship the notes","brand":"br_EXAMPLE"}'
```

Inbound capture (`task.capture`) is `POST /v1/hooks/{path_token}` with `Webhook-Id`, `Webhook-Timestamp`, and `Webhook-Signature: v1,<base64 hmac>`. The signature covers `{id}.{timestamp}.{raw body}`. A duplicate `event_id` returns 202 again. An unknown endpoint, a bad signature, and a stale timestamp all return `unauthenticated`.

Outbound deliveries use the same signature headers. Receivers deduplicate on `Webhook-Id`. Delivery is at least once.
