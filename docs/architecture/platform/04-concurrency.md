# 4. Optimistic concurrency and conflict protocol (resolves DQ-11)

Data foundations: 0B [§9](../data/09-concurrency-consistency.md). UX: 0E ST-06 (merge different fields, conflict on the same field, never lose input).

## 4.1 Row-version conditional updates

Every mutable resource exposes `version` (an integer, incremented per update) and `ETag: "<version>"`.

**Whole-record operations** require `If-Match: "<version>"` and an exact match:

- workflow transitions with gates;
- archive, trash, restore;
- move and move between brands;
- share create, change, or revoke;
- settings;
- review decisions (on the review request version).

## 4.2 Field-level merge requests

Schema: `field-merge-request`. Method: `PATCH`. Content type `application/json` (not JSON Merge Patch, which cannot carry base values).

```json
{"version": 42,
 "changes": {
   "due_date":    {"base": "2026-10-14", "value": "2026-10-16"},
   "description": {"base_hash": "sha256:…", "value": {"type": "doc", "content": [...]}}}}
```

- `base` holds the exact JSON value the client last saw, for scalar and small fields (dates, enums, references, numbers, short text, arrays of IDs).
- `base_hash` holds `sha256:` over the RFC 8785 canonical form of the last-seen value, for rich text and large values.
- `version` is advisory for field-merge requests. When it matches, the server can skip the comparison.
- Server rule per field:
  - current equals base → apply;
  - current equals the new value → no-op;
  - otherwise → conflict.
- **The request is atomic:** if any field conflicts, nothing is applied.
- Success returns `200` with the resource (new `version`).
- Writing a field requires reading it. Requests that include unwritable fields get the `validation_failed` error (`unsupported_field`), identical for nonexistent fields.

## 4.3 Conflict response

The `conflict` error with the `conflict` payload (schema `conflict`):

```json
{"current_version": 43, "would_merge": ["priority"],
 "fields": [{"field": "due_date", "yours": "2026-10-16", "theirs": "2026-10-15", "theirs_readable": true,
             "changed_by": {"type": "human", "id": "mem_…"}, "changed_at": "2026-10-14T09:00:00.000Z"}]}
```

- `theirs` is included **only if the caller can read the field now**. Otherwise `theirs_readable: false` and no value (0C AT-042).
- `changed_by` follows people visibility: it is absent if the caller cannot see that person (guests, IA-47). The actor type is always present.
- `would_merge` lists fields from the same request that would apply cleanly. The client resubmits them with the user's resolution for the conflicting fields: *keep theirs*, *keep mine* (new base = theirs), or *edit merged*.

## 4.4 Rich-text and documents

- Document saves send `base_version_id` (public `dcv_…`). On mismatch the server:
  1. stores the caller's content as a **new version** (never lost, ST-02);
  2. returns the `conflict` error with `saved_as_version_id` and `current_version`, so the client can open the per-section conflict view.
- Realtime collaborative editing (4D, OD-30, [PL-37](19-decisions.md#pl-37)) is a server-sequenced block-operation log on a draft inside the document: an operation names the block hash it was based on and is refused with the current block when it no longer fits. The version contract above remains the durable boundary, and a checkpoint is an ordinary version.

## 4.5 Bulk and per-item boundaries

| Mode | Boundary | Result |
|---|---|---|
| Default (`atomic: false`) | One transaction per item, the same rules as single edits | `partial-result` per item: `applied`, `conflict` (with payload), `failed`, `skipped`, `not_found`; the operation outcome is `succeeded`, `partial`, or `failed` |
| `atomic: true` (≤ `ATOMIC_BULK_LIMIT`) | One transaction | All applied, or a `conflict`/`validation_failed` error listing per-item issues, with nothing applied |
| AI proposal application | Atomic per apply (UXD-15) | As atomic, with per-change results |

## 4.6 Undo

- `POST …/operations/{op}:undo` creates an `undo` operation that reverts **exactly** the changes recorded under `op`. Each change is reverted only if the field's current value still equals the value the operation set. Otherwise it is reported `conflict`, and nothing is overwritten.
- Undo is available while the server retains the operation's change set (`UNDO_RETENTION`). The 0E 10-second toast is a UI affordance within that window.
- These are not undoable, and are confirmed instead (0E ST-11):
  - external sends;
  - publishes;
  - purges;
  - approvals and decisions;
  - purchases;
  - permission changes, which are reverted by a new change.

## 4.7 Retry guidance

- Never retry a `conflict` automatically. Present it to the user.
- `version` mismatches with no overlapping fields never reach the client. The server merges them.
- Offline-queued edits ([05](05-idempotency-and-effects.md#55-offline-replay)) replay with their original base values, so offline edits never silently overwrite.
