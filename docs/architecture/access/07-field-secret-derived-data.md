# 7. Field, secret, and derived-data authorization

## 7.1 Field policy

A field policy (proposed `access.field_policy`, AC-03) attaches to a **record type + scope** (workspace, brand, project) and a **field**, which is either a core field key or a custom field definition. It sets:

| Setting | Values | Default |
|---|---|---|
| `read` | `all_readers`, `min_level:<comment\|edit\|manage>`, `roles:[…]`, `teams:[…]` | `all_readers` |
| `edit` | Same vocabulary, always ⊆ read | Follows the record's `edit` level |
| `guests` | `visible` / `hidden` | `visible` for core fields, configurable for custom fields |
| `index_for_search` | true / false | true only when `read = all_readers` |

Core fields that 0C makes **always hidden from guests**:

- internal cost and budget fields (`budget_*`, `ai_budget_micros`, `time_budget_minutes`);
- billable rates;
- internal-only custom fields marked `internal`;
- other people's time entries.

Field policies use the same compiled-context approach as records. The context includes, per (record type, scope), the set of readable and editable field keys.

## 7.2 Propagation rules (I-18)

| Output | Rule |
|---|---|
| API and UI serialization | Allow-list per (record type, viewer): only readable fields are serialized. Hidden fields are **absent**, not null and not masked, so their existence is not signalled. |
| Filters, sorts, grouping (views, reports, API queries) | A query that references a field the viewer cannot read is rejected for that viewer with a generic validation message (AT-026). A shared view using such a field shows "This view uses fields you can't access" and returns no rows, never a silently altered result. |
| Calculated fields | Visibility = the **intersection** of the visibility of every dependency, computed when the definition is saved. A calculated field over a hidden field is hidden (AT-041). A separately reviewed "disclosure-safe" aggregate policy (for example, a project total over hidden rates) is an explicit extension that requires owner approval per field and an audit entry. It is never the default. |
| Conflict responses (0B §9.1) | `theirs` includes only readable fields. If a conflict involves a field the caller can no longer read, the response says the field changed and cannot be shown (AT-042). Writing a field requires reading it, so this arises only after a mid-edit policy change. |
| Audit display and activity | Previous and new values of fields the viewer cannot read are redacted per viewer (AT-043). Activity items about hidden fields are omitted. |
| Notifications | Field-change notifications go only to followers who can read the field. Bodies are rendered per recipient (AT-044). |
| Search | Only `index_for_search` fields are indexed. Snippets and highlights are generated only from indexed, readable parts. |
| Exports | Column allow-list per requester. Hidden fields are absent from headers too. |
| AI context | The context builder serializes records through the same allow-list. Prompts, citations, and generated text never include hidden fields. |
| Webhooks and integration sync | Per-destination field allow-list, intersected with what the connection owner (accountable principal) can read |
| Permission previews | Explain which field policies apply, by name, without values |

## 7.3 Secrets

- Credentials (OAuth tokens, provider keys, webhook signing secrets, connector credentials) live in the secret store (0B ADR-16). Application rows hold `*_secret_ref` only. **No one can read a stored secret.** A secret can be used, rotated, replaced, or deleted.
- `secrets_metadata.view` (owner and administrator) shows only:
  - whether a secret is configured;
  - its type and scopes;
  - who configured it and when;
  - when it was last rotated or used.
- API and session tokens are shown **once** at creation, then stored as hashes with a display prefix.
- Permission records (grants, roles, policies, previews) never contain secrets.
- Redaction (SEC-014) applies to logs, error reports, exports, AI prompts, audit display, and diagnostics. Allow-list serializers exclude C4 data by construction (0B §11.3). Free-text content is scanned for credential patterns before it leaves through those channels.

## 7.4 Notification channels for sensitive content

Brands may set **minimal** external notification content (UXD-10): email and browser notifications say "You have a new mention in {brand} · Open" with no record title or snippet. Sensitive brands default to minimal. In-app notifications are re-authorized at display (IA-53), but external channels cannot be recalled after sending (I-12).

## 7.5 Derived data in general

The rule is that **an output derived from inputs the viewer cannot read is hidden**, unless a reviewed disclosure-safe policy exists. This covers:

| Derived output | Treatment |
|---|---|
| Completion %, rollups, capacity | Computed only from readable records. Labelled as covering the visible scope where a viewer's view is partial (IA-41). |
| Recommendations, AI prioritization | Computed only from the initiating human's readable context |
| Metric snapshots | Stored per scope key and summed per viewer (0B §3.6) |
| Blocked, at-risk, stale derived from relationships | Per viewer ([04 §4.5](04-effective-permissions.md#45-compiling-to-sql)) |
| Health suggested from tasks | Computed per viewer, or stored as the project's manual or suggested health set by a manager. A stored health value is a **project field**, visible to project readers, and its explanation lists only readable reasons. |
