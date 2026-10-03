# 2. HTTP/API conventions (resolves DQ-17)

## 2.1 Resources and routing

- Base: `https://<host>/v1`. JSON over HTTPS only. There is no GraphQL at launch.
- **Tenant context comes from the path:** `/v1/workspaces/{ws_id}/…`. The workspace is verified against the authenticated membership or the token binding. A workspace the caller cannot access is `not_found`.
- **Collections** are plural kebab-case: `/tasks`, `/projects`, `/file-versions`. **Items** are `/{collection}/{public_id}`.
- **Actions** that are not CRUD use a colon suffix on the resource or collection: `POST …/tasks/{id}:complete`, `POST …/tasks:bulk-update`, `POST …/operations/{id}:cancel`.
- Account-level routes (no tenant): `/v1/me`, `/v1/auth/…`.

## 2.2 Request context (derived server-side)

The execution context ([07](07-jobs-and-execution-context.md), `execution-context` schema) is built from authenticated server state **only**:

| Field | Source |
|---|---|
| Workspace | Path, verified against the membership or token binding |
| Effective principal, authenticated principal, initiating human, delegation chain | Session, token, OAuth grant, run binding, service principal |
| Selected brand or context | Query parameters (`brand=br_…`, AI context selection) treated as **filters**, validated against authorization. Never an authority claim. |
| Authorization epochs | Read from `access.permission_epoch` per request |
| Locale | Profile → `Accept-Language` → workspace default. Affects only human-readable `message` text. |
| Timezone | Profile timezone. An explicit `tz` query parameter is accepted only where a resource documents date-relative evaluation (for example, overdue on a personal surface). It is validated IANA and never affects authorization. |

Client-supplied `workspace_id`, `brand_id` authority, `role`, `plan`, `approval`, `actor`, or `on_behalf_of` fields are ignored or rejected (I-09). Bodies may contain `brand` only as the **target** of a create or move, which is validated.

## 2.3 Envelopes

- **Single resource:** `{"data": {...}, "meta": {"request_id", "correlation_id", "api_version"}}` (`success-envelope`). Every resource has `id`, `type`, and `version` where mutable.
- **Collection:** `{"data": [...], "page": {...}, "meta": {...}}` (`collection-page`).
- **Error:** `{"error": {...}}` (`error-envelope`, [03](03-errors-and-non-disclosure.md)).
- **Content types:** `application/json; charset=utf-8` for requests and responses. Uploads go directly to object storage ([15](15-files.md)). `application/x-ndjson` is used only for export artifacts.
- References to other records appear as `{"id", "type"}` (`common#/$defs/record_ref`). **A reference to a record the caller cannot read is absent**, not null (0C I-07).

## 2.4 Field selection, filtering, sorting, expansion

| Feature | Contract |
|---|---|
| Field selection | `fields=title,status_category,due_date`, limited to the resource's public allow-list. Fields the caller cannot read are silently absent, exactly like unselected fields. |
| Filtering (simple) | `filter[status_category]=planned,active`, `filter[due_date][lte]=2026-10-14`, `filter[brand]=br_…` |
| Filtering (complex) | `POST …/tasks:query` with the 0B query AST (`views.saved_view` format): AND/OR groups |
| Unknown or unreadable filter and sort fields | `validation_failed` error with issue code `unsupported_field`, **identical** for nonexistent and unreadable fields (0C AT-026) |
| Sorting | `sort=due_date,-priority`. The ID is always the implicit final tiebreaker. |
| Expansion | `expand=project,assignees`: depth 1, at most 3 expansions per request. Expanded records pass the same authorization, and unreadable ones are absent. |

## 2.5 Keyset pagination (resolves DQ-17)

- **Request:** `limit` (default `PAGE_LIMIT_DEFAULT`, maximum `PAGE_LIMIT_MAX`, schema hard cap 200) and `cursor`.
- **Cursor:** opaque base64url. It encodes the last row's sort-key values and ID, plus a MAC binding it to (workspace, principal, query fingerprint). A cursor used with a different query, principal, or workspace, or tampered with, gives the `cursor_invalid` error with no detail. Cursors carry no expiry. Results always reflect **current** authorization, so a permission change between pages changes later pages rather than failing.
- **Response:** `page.has_more`, `page.next_cursor` (and `prev_cursor` where supported). **Offset pagination is not offered** for mutable collections.
- **Totals:** returned only on request (`include_total=true`) and computed with the **identical authorized predicate** as the rows (0C §4.5). Up to `TOTAL_COUNT_CAP` the total is exact (`estimated: false, capped: false`). Above it, it is `{"value": TOTAL_COUNT_CAP, "capped": true}` or a planner estimate labelled `estimated: true`. A total never counts hidden rows (IA-41).

## 2.6 Conditional requests and concurrency

- Every mutable resource returns `ETag: "<version>"` and a `version` field.
- `If-None-Match` on GET returns 304 for unchanged resources, with `Cache-Control: private, no-store` semantics for tenant data. 304 only avoids re-transfer and is re-authorized like any read.
- Whole-record operations (transitions with gates, moves, archive, trash, restore, share changes) **require** `If-Match`. Missing → `precondition_required` error. Mismatch → `conflict` error.
- Field-level edits use the merge body ([04](04-concurrency.md)).

## 2.7 Bulk operations

`POST …/{collection}:bulk-{verb}` with `{"items": [...], "atomic": false}`:

- Up to `BULK_SYNC_LIMIT` items run synchronously and return a `partial-result` body inside an `operation` (kind `bulk_edit`, state `succeeded`/`partial`/`failed`).
- Larger requests return `202` with the operation for polling or SSE.
- `atomic: true` is accepted up to `ATOMIC_BULK_LIMIT`: all items apply or none do.
- Per-item statuses are `applied`, `conflict`, `failed`, `skipped`, and `not_found`. An item the caller cannot read is reported as `not_found`, identical to a nonexistent item.

## 2.8 Rate limits

- Responses carry `RateLimit-Policy` and `RateLimit` headers (IETF RateLimit fields). A `429` returns the `rate_limited` error with `Retry-After`.
- Limits apply per principal and per workspace, with per-tenant fairness (REL-018). Quotas are the configuration `RATE_LIMIT_POLICIES` and are not published promises.
- Rate-limit buckets never reveal other tenants' usage.

## 2.9 Localization

Machine fields (codes, enums, IDs, timestamps, numbers) are never localized. `message` strings in errors follow the request locale. Clients render dates, numbers, and currency with their locale (0E 08).

## 2.10 Safe defaults

- `Cache-Control: private, no-store` on tenant responses.
- HSTS.
- No JSONP and no CORS wildcard with credentials.
- Request size limits, giving the `payload_too_large` error.
- Unknown JSON properties in requests produce `validation_failed` (issue `unknown_field`), so typos never silently drop.
