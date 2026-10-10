# 1. Contract principles, encodings, identifiers, and versioning

## 1.1 Public identifiers (resolves DQ-10)

| Rule | Contract |
|---|---|
| Format | `<prefix>_<26 Crockford base32 characters>`. The body encodes 128 random bits: uppercase, digits plus `A–H J K M N P–T V–Z`, with no `I L O U`. Schema: `common#/$defs/public_id`. |
| Prefix | 2–5 lowercase letters naming the resource type. Registry: 61 prefixes ([generated/registries.md](generated/registries.md#public-id-prefixes)). Every addressable 0B entity's prefix is included, and the validator checks this. |
| Input | Prefixes are case-sensitive lowercase. The body is accepted case-insensitively and normalized to uppercase. Lookups are exact after normalization. |
| Properties | Random: the ID encodes no creation time, tenant, name, sequence, or count. It is never reused, and stable across brand moves, restores, exports, and imports into the same workspace. |
| Internal keys | UUIDv7 keys appear **only** in internal contracts (`x-visibility: internal`: execution context, jobs, internal events, idempotency records, audit, security events, usage events). Public schemas cannot reference `internal_uuid`, and the validator enforces this. |
| Type mismatch | A public ID with the wrong prefix for the route is treated as `not_found`, never as a type error. |

## 1.2 Encodings

| Kind | Encoding | Schema |
|---|---|---|
| Instant | RFC 3339 UTC, millisecond precision, `Z` suffix: `2026-10-14T09:00:00.000Z` | `common#/$defs/timestamp` |
| Floating date | `YYYY-MM-DD`, no timezone | `common#/$defs/date` |
| Local date-time with zone | `{"local": "2026-10-23T16:00", "tz": "Europe/Lisbon"}` (recurrences, deadlines with time) | `common#/$defs/local_datetime` |
| Deadline | Either `{"date": "2026-10-15"}` or a local date-time object; exactly one form (0B §6.1) | Resource schemas |
| Timezone | IANA name. Offsets are never stored. | `common#/$defs/tz` |
| Locale | BCP 47 tag | `common#/$defs/locale` |
| Money | `{"amount_micros": "1250000", "currency": "USD"}`. Integer micros as a **string** (int64-safe for JavaScript), ISO 4217 code. | `common#/$defs/money` |
| Decimal quantities | String `"12.5"`. Binary floats are never used for quantities or money. | `common#/$defs/decimal` |
| Durations | Integer fields with an explicit unit suffix: `estimate_minutes`, `duration_seconds`, `timeout_seconds`. ISO 8601 durations are not used in fields. | — |
| Enums | Lowercase `snake_case` strings. Clients **must tolerate unknown values** (additive evolution) and treat them as "other". | — |
| Booleans and nulls | `null` means "known empty". An **absent** field means "not selected, not applicable, or not readable by this caller". Clients must not infer anything from absence ([07 of 0C](../access/07-field-secret-derived-data.md)). | — |
| Rich text | A versioned JSON document `{type: "doc", version, content}`. Version 1 (plain-text subset) is fixed by PL-23; 4C extends node and mark types (DQ-25). It is never HTML in contracts. | `rich-text` |

## 1.3 Identifiers for correlation and reliability

| Identifier | Form | Scope | Carried in |
|---|---|---|---|
| `request_id` | `req_<26>` | One HTTP request | Response `meta`, `X-Request-Id` header, errors, logs |
| `correlation_id` | W3C trace-id (32 hex) | One logical user action across requests, jobs, events | `traceparent` header, every envelope, logs |
| `traceparent` | W3C Trace Context | Distributed trace | HTTP headers, job context |
| `causation_id` | Internal UUID of the event or operation that caused this one | Event chains, automation loop detection | Internal events, audit, execution context |
| `operation_id` | `op_<26>` publicly, UUID internally | One logical outcome | Operation resource, audit, usage, events |
| `attempt_id` | `att_<26>` publicly | One try | Attempt resource, usage, audit |
| `event_id` | UUID internally; `evt_<26>` in webhooks | One fact | Events, webhook `Webhook-Id` |
| Idempotency key | Client string ([05](05-idempotency-and-effects.md)) | (workspace, principal) | `Idempotency-Key` header |
| `effect_key` | `<operation_id>:<effect_name>[:<n>]` | One external effect | Effect ledger, provider idempotency headers |

## 1.4 Versioning

| Surface | Rule |
|---|---|
| Public HTTP API | Major version in the path (`/v1/`). Within a major version, only **additive** changes: new resources, optional request fields, response fields, enum values, error codes, and headers. |
| Breaking changes | Removing or renaming fields, changing types or semantics, tightening validation of existing input, or changing defaults or status codes. These require a new major version, or an opt-in per-request header for narrow cases. |
| Internal events | `type` + integer `schema_version` per event type. Consumers accept the versions they declare. Producers emit one version. A breaking change adds a new version, and both are emitted until all consumers move. Since the monolith deploys together, this is normally a single release, but in-flight outbox rows still need old-version handling. |
| Webhooks | Each subscription pins an `api_version`. Payloads follow that version's public schema. New fields arrive additively. |
| JSON Schemas | `$id` is stable per contract. A breaking schema change gets a new `$id` (`…-v2`). |
| Deprecation | Announced with the `Deprecation` and `Sunset` response headers (RFC 8594 family), the changelog, and webhook delivery headers. The **minimum notice period is the product-owner decision `DEPRECATION_NOTICE_PERIOD`** (PQ-08). No compatibility window is promised here. |

## 1.5 Canonical serialization and signing

- **JSON:** UTF-8, no BOM, no duplicate keys. Numbers must not be used for money or IDs.
- **Canonical form for hashing** (request fingerprints, audit hash chains, base-hash merges): JSON Canonicalization Scheme (RFC 8785).
- **Webhook signatures** sign the **raw body bytes** as sent, not a re-canonicalized form ([09](09-webhooks.md)).
- **Hash notation:** `sha256:<64 hex>`.

## 1.6 Redaction and classification in contracts

- Every schema declares `x-max-class`, and sensitive properties declare `x-class` (C0–C4, 0B [§11](../data/11-data-classification.md)). The validator rejects any C4 property and any property above its schema's maximum class.
- Public envelopes are built by **allow-list serializers** per resource and viewer (0C [§7](../access/07-field-secret-derived-data.md)). A newly added field is excluded until classified.
- SSE notices are capped at C1, internal events and webhooks at C2, and audit at C3 (internal only).
- Secrets never appear: not in responses, events, webhooks, logs, traces, errors, notifications, exports, or AI context (I-16).
