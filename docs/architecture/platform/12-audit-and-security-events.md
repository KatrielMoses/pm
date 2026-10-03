# 12. Audit and security-event contract

Storage: 0B [§7](../data/07-audit-provenance.md). Schemas: internal `audit-event` and `security-event` (maximum class C3, internal only). Customer-facing audit views and exports are rendered from these through the viewer's field policy.

## 12.1 Audit event envelope

| Field | Rule |
|---|---|
| `id`, `occurred_at`, `workspace_id`, `brand_id` | UUIDv7, statement time, scope at event time |
| `action` | `<resource>.<verb>` (e.g., `task.status_changed`, `grant.revoked`, `export.generated`, `agent.tool_called`) |
| `actor` | `{type, id, on_behalf_of, delegation_chain}`. Actor type is one of the six 0A/0B types. Delegated actions record the full chain (member → agent run …). |
| `target` | `{record_id, type, public_id}`. No foreign key, so it survives purge as a tombstone reference. |
| `changes[]` | `{field, class, digest, old?, new?, hash?, version_ref?, redacted?, reason?, changed?}` per field-class rules (`digest` fingerprints the entry's values, see PL-18): `plain` → values; `content` → `hash` + `version_ref`; `personal` → values marked for redaction on account deletion; `secret` → **only** `changed: true` (schema-enforced: `old`/`new`/`hash` are forbidden); `credential_ref` → the reference changed only |
| `operation_id`, `attempt_id`, `correlation_id`, `causation_id`, `source`, `workflow_revision_id` | Correlation and provenance |
| `retention_class` | Constant `R-AUDIT`; the period comes from the retention policy (OD-36) |

## 12.2 Write rules

- An audit event is written **in the same transaction** as the material change, through the shared command pipeline.
- **If the audit write fails, the transaction fails** and the material change does not happen. The caller receives the `internal_error` error, and `audit.write_failures` raises an alert ([17](17-observability.md)).
- Append-only enforcement, redaction records, and hash chaining follow 0B §7.1/§7.7. Redaction is always explicit (`audit_redaction`) and never a silent rewrite.

## 12.3 Security events

`security-event` categories:

- authentication, session, step-up, token, permission, sharing, export;
- support access, elevation;
- denial (R3/R4 denials and repeated not-found probing);
- secret (configured or rotated; never the value);
- RLS assertion.

Each records outcome (`success`, `failure`, `denied`), actor, subject principal, network context, and correlation. Network context (IP, user agent family) is C3, retained under audit policy, and displayed masked to customers.

## 12.4 Display and export safety

- Audit views apply the viewer's field policy. Values of fields the viewer cannot read are shown as `{"redacted": true}` (0C AT-043).
- Audit exports (`audit.export` action, eligible plans, step-up) include redaction markers and never secrets.
- Exports carry public IDs. Internal UUIDs are mapped to public IDs where they exist and omitted otherwise.
