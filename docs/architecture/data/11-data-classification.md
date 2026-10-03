# 11. Data classification and ownership

The per-entity and per-family matrix is generated in [generated/classification-matrix.md](generated/classification-matrix.md) from the classification fields in [model/model.json](model/model.json). This document defines the classes and the handling rules attached to them.

## 11.1 Confidentiality classes

| Class | Contents | Handling |
|---|---|---|
| **C0 Public** | Platform content (help, changelog, roadmap, status), plan catalog | Cacheable, no tenant data |
| **C1 Internal metadata** | Configuration, IDs, states, counts, rank keys | Tenant-scoped and access-controlled, but low harm if disclosed within the tenant |
| **C2 Customer confidential** | Work content: titles, descriptions, comments, documents, files, test evidence, AI outputs | Per-record authorization on every surface. AI and search eligible within authorization. |
| **C3 Sensitive** | Personal data (emails, names, time-off kind, external calendar titles), billing details, security events, audit with values, intake contact data | Restricted roles. Application-level encryption where listed in [10 §10.10](10-postgresql-guidance.md#1010-encryption-and-credential-separation). Redaction on account deletion. Excluded from AI context except the user's own data when required. |
| **C4 Secret** | Credentials, keys, token hashes, MFA secrets, connector credentials | **Never** in ordinary application records (references only), logs, search, AI context, exports, error reports, diagnostics, or audit values. The model validator enforces `export = never` and `search_ai = no` for C4 entities. |

## 11.2 Other classification fields

| Field | Values (from the model vocabulary) |
|---|---|
| Retention class | R-LIVE, R-EVIDENCE, R-AUDIT, R-EXEC, R-PERSONAL, R-BILLING, R-DERIVED, R-EPHEMERAL, R-PLATFORM ([08](08-deletion-retention.md)) |
| Export eligibility | `full`, `filtered` (requester's permissions), `admin`, `self`, `never` |
| Search/AI eligibility | `yes` (within authorization), `metadata` (non-content fields only), `no` |
| May contain secrets | `no`, `possible` (untrusted input such as inbound payloads or diagnostics: redaction before logs, AI, export), `hash-only`, `secret-ref` |
| Personal data | `no`, `incidental` (free text may mention people), `yes` (structurally personal) |
| Volume | `low`, `medium`, `high`, `very-high` (append-heavy) |
| Authorization sensitivity (derived) | `high` for C3/C4 and grant/policy tables; `standard (per-record)` for C2; `low` for C0/C1 |
| Audit requirement (derived) | `is evidence / append-only`, `all changes + access` (C3/C4), `material changes` (C2), `configuration changes` (C1), `none (technical)` (ephemeral) |

## 11.3 Rules that follow from classification

1. **Allow-list serialization.** API responses, exports, webhook payloads, and AI context are built from per-entity allow-lists of fields with class ≤ the surface's permitted class. A new column is excluded until classified.
2. **Free text is untrusted for secrets.** Comments, descriptions, documents, Inbox raw text, inbound payloads, and diagnostics may contain pasted secrets. The redaction layer (SEC-014) scans for credential patterns before logging, AI context assembly, and exports. Values matching are masked in those outputs. The stored record is unchanged, because it is the user's own data. The scan is applied to error reports as well.
3. **AI eligibility follows authorization, then class.** AI context includes only records the initiating person can read, in the selected scope, and only fields with `search_ai` = `yes` (or `metadata`). C3 fields are excluded unless the action is about the person's own data. Provider requests follow workspace privacy settings (SEC-027).
4. **Search indexes only `search_ai = yes` content,** so search projections never contain C3/C4 data.
5. **Exports** respect `export` and requester permissions. C4 is never exported, and secret references are replaced by "configured: yes/no".
6. **Logs** contain IDs, actor types, operation and correlation IDs, and error classes. They never contain C2+ content or C4 material.
7. **Regulated personal data:** the product does not intentionally collect special-category data. `time_off.kind` (e.g., sick leave) is the known sensitive field. It is classified C3, visible only to the person and authorized admins, and excluded from AI and search. Other regulated data can enter only incidentally through free text. This is handled by the data-subject request process (SEC-023), with the legal scope still to be confirmed.

## 11.4 Ownership summary

Each entity has exactly one owning module (the `module` field), which is the only writer. The generated matrix lists module, scope, class, derived authorization sensitivity and audit requirement, retention, export, volume, search/AI eligibility, secrets, and personal data for all 204 entities, plus a per-module family summary.
