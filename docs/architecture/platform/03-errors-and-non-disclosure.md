# 3. Uniform errors and non-disclosure (resolves AQ-01)

## 3.1 Error envelope

Schema: `error-envelope`, with examples in [generated/schema-reference.md](generated/schema-reference.md).

```json
{"error": {
  "code": "validation_failed",              // stable machine code (registry)
  "status": 422,                            // mirrors HTTP status
  "message": "Some fields need attention.", // safe, localized, no tenant data beyond the caller's own input
  "retryable": false,
  "request_id": "req_…", "correlation_id": "4bf9…",
  "issues": [{"pointer": "/filter/margin", "code": "unsupported_field", "message": "…"}],
  "retry_after_seconds": 30,                // optional
  "operation_id": "op_…",                   // optional: the logical operation this concerns
  "approval": {…}, "step_up": {…}, "conflict": {…}, "entitlement": {"key": "…"}, "usage": {"meter": "…"}
}}
```

**Codes:** there are 32 codes in the registry ([generated/registries.md](generated/registries.md#error-codes)). Each has an HTTP status (or "outcome only" for operation results), a category, retryability, a safe message, and a disclosure rule.

| Brief case | Code | HTTP |
|---|---|---|
| Validation | `validation_failed` error (issues), `malformed_request` error, `unsupported_media_type` error, `payload_too_large` error | 422 / 400 / 415 / 413 |
| Unauthenticated | `unauthenticated` error | 401 |
| Uniform not-found | `not_found` error | 404 |
| Conflict | `conflict` error (with `conflict` payload), `precondition_required` error, `evidence_locked` error | 409 / 428 / 409 |
| Rate-limited | `rate_limited` error | 429 |
| Idempotency conflict | `idempotency_key_reuse` error, `idempotency_in_progress` error | 409 |
| Approval required | `approval_required` error (with `approval`) **or** `202` + operation `waiting(approval)` | 403 / 202 |
| Step-up required | `step_up_required` error (with `step_up` challenge); `step_up_unavailable` error for non-human principals | 403 |
| Suspended | `principal_suspended` error | 403 |
| Entitlement limit | `entitlement_required` error | 403 |
| Usage limit | `usage_limit_reached` error | 403 |
| Unavailable dependency | `dependency_unavailable` error, `service_unavailable` error | 503 |
| Partial operation | `partial_failure` error (outcome code inside operation and bulk results; never an HTTP status) | — |
| Internal | `internal_error` error | 500 |
| Readable target, action not allowed | `forbidden` error | 403 |
| Read-only workspace | `workspace_read_only` error | 403 |

Every 0C response shape maps to exactly one platform response (registry `authz_response_shapes`, validated against 0C).

## 3.2 When an action needs approval

There are two patterns:

- **The action creates the approval request.** Examples: an agent's gated tool call, a production deploy, purge. The response is `202 Accepted` with the operation in `waiting` and `waiting_reason: approval`, plus an `approval` reference. Nothing consequential happens until approval.
- **The action requires an approval that should already exist.** Example: applying a release decision that references an approval. The response is the `approval_required` error with the approval reference, if one exists and is readable.

Both are returned **only for readable targets**.

## 3.3 Non-disclosure rules

1. **Unauthorized equals nonexistent.** For any target the caller cannot read (including wrong-workspace IDs, wrong-prefix IDs, purged records, and records in sensitive brands), the response is the `not_found` error, with:
   - the **same** status, body (code and message; `request_id`/`correlation_id` differ per request as always), headers (including `Cache-Control`, `Vary`, and the absence of `ETag`), and content length class;
   - the **same** timing envelope: the server always runs the authorized lookup. It never short-circuits on "ID does not exist" before checking authorization, and never skips work only for nonexistent IDs. Timing uniformity is tested statistically (0C AQ-11);
   - the **same** caller-visible logging. Request logs exposed to customers (audit, API-request history) record "not found" for both.
2. **Readable-only signals.** `forbidden`, `step_up_required`, `approval_required`, `entitlement_required`, `usage_limit_reached`, `workspace_read_only`, `evidence_locked`, `file_not_ready`, and `conflict` are returned **only** when the caller can read the target. Otherwise the answer is `not_found`.
3. **Validation without oracles:**
   - Issue codes are generic. `unsupported_field` covers unknown and unreadable fields. `invalid_reference` covers nonexistent and unreadable referenced records.
   - Uniqueness errors name a conflict only when the caller can read the conflicting record. Otherwise they report `invalid_value` (0C AT-025).
4. **Ordering of checks:** authentication, then the tenant (path workspace), then readability of the target, then capability and level, then gates (lifecycle, step-up, approval, entitlement, usage). The first failing check decides, and the readability check always comes before any readable-only signal.
5. **Inbound webhooks** with a bad signature or unknown endpoint get the `unauthenticated` error with an identical body, before any tenant lookup ([09](09-webhooks.md)).
6. **Internal logs** keep the real cause (`not_found.reason = unauthorized|nonexistent|purged|wrong_workspace`) in a restricted security log stream, redacted per [17](17-observability.md). They are never returned to the caller.
7. **No stack traces, SQL, internal IDs, hostnames, or provider error bodies** appear in errors. Dependency failures name only a class (`ai_provider`, `integration`, `storage`).

## 3.4 Retry guidance

| `retryable` | Client behavior |
|---|---|
| `true` (`rate_limited`, `idempotency_in_progress`, `dependency_unavailable`, `service_unavailable`, `internal_error`, `file_not_ready`) | Retry with the same `Idempotency-Key`, honoring `retry_after_seconds` or exponential backoff with jitter, bounded (0E ST-04) |
| `false` | Do not retry automatically. `conflict` requires a user decision ([04](04-concurrency.md)). |
