# 3. Tenancy, brand scope, and sharing

Inputs: [0A hierarchy-and-scope](../../product/hierarchy-and-scope.md), and the approved decisions in `ROADMAP_CHECKLIST.md`: tasks require a brand and projects are optional; Inbox items may be personal and unbranded; sharing uses revocable record grants with no implicit children; associations may cross brands but inaccessible endpoints and derived metadata are fully omitted; workspace-scoped records are valid and guests receive no implicit workspace access; aggregates disclose only authorized brands and records. Also [UXD-28](../../ux/09-decisions-and-risks.md#uxd-28).

## 3.1 Who enforces what

No single layer can enforce everything. Each invariant is assigned to the **cheapest layer that can enforce it completely**:

| Layer | Enforces | Cannot enforce |
|---|---|---|
| **Database constraints** (foreign keys, composite foreign keys, check, unique, exclusion, deferrable constraints, triggers for the few cross-row rules) | Tenant consistency: a child cannot reference another workspace's parent. Containment within one brand. Envelope ↔ typed-row agreement. One running timer. Unique shares. No self-links. Immutability of append-only tables. | Who may read or write; cross-brand association validity (needs read rights); omission of hidden endpoints |
| **Row-level security** on `workspace_id` (defense in depth, [ADR-13](12-decisions.md#adr-13)) | A query that forgets a workspace filter returns nothing from other tenants | Brand-, project-, or record-level access |
| **Transactional domain validation** in the owning module's command | Multi-row rules: cycle prevention, depth cap, subtask same-project rule, projectless-restore rule, triage requires a brand, a move re-validating links, completion gates, share child selection limited to the source's children | Viewer-specific visibility |
| **Policy layer (Phase 0C)** | Per-record read/write/share/approve/execute decisions, the same evaluator for every surface (UI, API, search, AI, export, agents, integrations, notifications, briefings) | Structural consistency (assumes the two layers above) |

**Foreign keys do not enforce authorization.** A valid foreign key from a MailAccess task to an API Access task (a `blocks` relationship) says nothing about who may see it. The policy layer decides that per viewer.

## 3.2 Invariants

| # | Invariant | Mechanism |
|---|---|---|
| T1 | Every tenant row belongs to exactly one workspace | `workspace_id NOT NULL` + foreign key; composite foreign keys `(workspace_id, parent_id)` to every parent; RLS backstop |
| T2 | Brand-owned rows belong to exactly one brand **in that workspace** | `brand_id NOT NULL` + `FOREIGN KEY (workspace_id, brand_id) REFERENCES tenancy.brand (workspace_id, id)` |
| T3 | Tasks always have a brand; the project is optional | `work.task.brand_id NOT NULL`, `project_id NULL`; `FOREIGN KEY (workspace_id, brand_id, project_id) REFERENCES work.project (workspace_id, brand_id, id)` (MATCH SIMPLE skips the check when `project_id` is null and enforces same brand otherwise) |
| T4 | Inbox items may be personal and unbranded until triage | `capture.inbox_item.owner_membership_id NOT NULL`, `brand_id NULL`. The triage command requires a brand for every conversion target. A converted item records `converted_record_id`. |
| T5 | Workspace-scoped documents, files, goals, templates, automations, and connections are valid | Scope `workspace_or_brand` with nullable `brand_id` and generated `scope_key`. No brand placeholder is ever used. |
| T6 | The all-brands view owns no data | No table has an "all brands" value. Workspace-scoped rows have `brand_id IS NULL`, which means "workspace scope", not "all brands". Aggregation is a query over authorized scope keys ([§3.6](#36-aggregation-and-the-all-brands-view)). |
| T7 | Containment never crosses brands | Composite containment foreign keys include `scope_key` ([§3.3](#33-database-enforced-invariants)). The model validator rejects any containment edge with incompatible scopes. |
| T8 | Cross-brand associations need authorized creation and never grant access | Association tables store both endpoint brands. Creation checks read rights on both ends (0C). No policy rule reads association tables to grant access ([§3.5](#35-hidden-endpoints-counts-and-derived-conditions)). |
| T9 | Shares are revocable grants: read-only by default, children excluded unless selected, may expire, never imply onward sharing or ownership change | `access.record_grant` ([§3.4](#34-explicit-cross-brand-shares)) |
| T10 | Inaccessible relationship endpoints, counts, types, and derived conditions are not exposed | Viewer-filtered relationship queries; no viewer-independent derived columns on the record; cached derivations keyed by visibility scope ([§3.5](#35-hidden-endpoints-counts-and-derived-conditions)) |
| T11 | Moving between brands is distinct from sharing and auditable | `core.brand_move` operation; a share never touches `brand_id` ([§3.7](#37-moving-a-record-to-another-brand)) |

## 3.3 Database-enforced invariants

Illustrative DDL fragments (not migrations):

```sql
-- Parent tables expose composite unique keys used by children.
ALTER TABLE tenancy.brand ADD UNIQUE (workspace_id, id);
ALTER TABLE work.project  ADD UNIQUE (workspace_id, brand_id, id);
ALTER TABLE work.task     ADD UNIQUE (workspace_id, brand_id, id);

-- T3: a task's project must be in the same workspace AND brand (skipped when project_id is null).
ALTER TABLE work.task ADD FOREIGN KEY (workspace_id, brand_id, project_id)
  REFERENCES work.project (workspace_id, brand_id, id);

-- T7: a subtask's parent must be in the same brand.
ALTER TABLE work.task ADD FOREIGN KEY (workspace_id, brand_id, parent_task_id)
  REFERENCES work.task (workspace_id, brand_id, id);
-- Same project as parent: enforced in the task command (both columns may be null) and
-- checked by a constraint trigger: NEW.project_id IS NOT DISTINCT FROM parent.project_id.

-- T5 + T7 for optional-brand trees: same brand OR same workspace-level scope.
ALTER TABLE knowledge.document ADD COLUMN scope_key uuid
  GENERATED ALWAYS AS (coalesce(brand_id, workspace_id)) STORED;
ALTER TABLE knowledge.document ADD UNIQUE (workspace_id, scope_key, id);
ALTER TABLE knowledge.document ADD FOREIGN KEY (workspace_id, scope_key, parent_document_id)
  REFERENCES knowledge.document (workspace_id, scope_key, id);

-- Hosted children (comments, attachments, field values, followers) agree with the host envelope.
ALTER TABLE collab.comment ADD FOREIGN KEY (workspace_id, scope_key, host_record_id)
  REFERENCES core.record (workspace_id, scope_key, id);
```

Where a rule needs two nullable columns to agree (subtask and parent project, document attached to a task in the same brand), a **constraint trigger** (`DEFERRABLE INITIALLY DEFERRED`) checks it at commit. These are the only triggers used for integrity. Everything else is declarative.

## 3.4 Explicit cross-brand shares

`access.record_grant` is the only structure that makes a brand-owned record visible outside its brand's ordinary grants. Each share action creates one `access.share_group` and **one grant row per shared record** (0C AZ-05, applied in Phase 0 integration).

| Column | Rule |
|---|---|
| `record_id` → `core.record` | One record per grant. The grant row stores `source_brand_id` (copied from the envelope) for audit and display. |
| `grantee_type`, `grantee_id` | `brand` (visible in that brand's context to its members), `membership` (person or guest), or `team`. A public link is a reserved grantee type, inactive until OD-27 is decided. |
| `level` | `read` (default), `comment`, `edit`. The command rejects levels above the sharer's own effective level. `delete`, `share`, `move`, and `configure` are never grantable. |
| `share_group_id`, `grantee_key` | Children are excluded by default. Each child the sharer selects is validated as a current containment descendant and receives **its own grant row** in the same share group at share time. Records created later are never included (approved decision; [DQ-04](13-open-questions.md#dq-04)). `grantee_key` (= `grantee_id`) is indexed for the visibility semi-join. |
| `state`, `expires_at`, `revoked_at/by` | `active` → `revoked`/`expired`. Expiry is evaluated at read time (`expires_at > now()`), and a job flips the state for display and audit. |
| Uniqueness | `UNIQUE (record_id, grantee_type, grantee_id) WHERE state = 'active'`; `UNIQUE (share_group_id, record_id)`. Revoking a share group revokes all its rows in one transaction. |

Rules:

- Shares are created, changed, and revoked through `access` commands that emit `grant.*` events and audit events. They are never edited silently.
- A grantee cannot create a share on a record received through a share. The policy layer checks the share permission against **ownership-derived** access only, never share-derived access.
- On revocation the grant row stays (history). Search and notification projections re-filter on the next read, because the grant is evaluated at query time and never copied into the projections ([09 §9.8](09-concurrency-consistency.md#98-read-models-and-acceptable-lag)).
- Moving or trashing the record leaves the grant rows unchanged. A trashed record is invisible to grantees because of its lifecycle state, and restoring it makes it visible again unless the grant expired or was revoked (0A deletion §2).

## 3.5 Hidden endpoints, counts, and derived conditions

Approved rule (UXD-28): for a viewer who cannot read the other end of a relationship, **omit the relationship, its type, its count, and any derived condition caused solely by it**. In-text author-created mentions may render as the neutral "Restricted item" token (OD-05 approved contract).

Data consequences:

1. **No viewer-independent derived columns that reveal relationships.** `work.task` has **no** `is_blocked` or `blocker_count` column. The manual flag `manual_blocked_reason` is stored and always visible (UXD-28 allows a permission-safe manual reason).
2. **Derived conditions are computed per viewer.** "Blocked" = `manual_blocked_reason IS NOT NULL` **or** there exists a `blocks` relationship into the task whose `from` endpoint the viewer can read and whose status category is not `done`/`cancelled`. The endpoint filter is applied as a join against the viewer's authorized scope set, which 0C defines and which must be expressible as SQL predicates over `(scope_key, project_id, record_id)`.
3. **Relationship rows carry both endpoint brands** (`from_brand_id`, `to_brand_id`). Most filtering can then happen on indexed brand columns before record-level checks.
4. **Caches are keyed by visibility.** If performance requires caching derived conditions (dependency counts on boards), the cache key must include the endpoint's visibility scope, e.g., `(task_id, blocker_scope_key, blocker_project_id) → count`. Each viewer then sums only rows they can see. A single global count is prohibited. This works only if 0C's grant granularity is brand/project plus explicit record grants ([DQ-01](13-open-questions.md#dq-01)).
5. **The same rule applies on every surface:** API responses, exports, webhooks, AI context, notifications, briefings, search facets, and activity projections. Activity items about a relationship to a hidden record are filtered by **both** endpoints, not only the target.
6. **Owner notification (UXD-28 mitigation)** is an outbox event (`relationship.hidden_dependency_affects_assignee`). It is delivered only to people who can read both ends, so the owner of the hidden blocker hears about the affected assignee without the assignee learning anything.

## 3.6 Aggregation and the all-brands view

- An all-brands query is `WHERE workspace_id = :ws AND scope_key = ANY(:authorized_scope_keys)` plus record-level grants (`OR id IN (shared ids)`), with project restrictions per 0C.
- Aggregates (counts, totals, facets, capacity, metric snapshots) are computed from the same filtered set. Pre-aggregated `insights.metric_snapshot` rows are stored **per scope key** (and per project where relevant), and a viewer's total is the sum over authorized keys. There is no cross-brand pre-aggregate.
- Brand filters are lists of brand IDs intersected with authorized scope keys at query time. "All" is never stored as a value.

## 3.7 Moving a record to another brand

A move is a `core.brand_move` operation (extends `execution.operation`) that runs in **one transaction** for subtrees up to an implementation-defined size. Larger subtrees run in a job that holds the subtree lock and keeps every record read-only until it finishes.

1. Lock the root's tree (advisory lock on the tree root, [04 §4.1](04-relationship-primitives.md#41-hierarchies)) and the envelope rows of the subtree (`SELECT … FOR UPDATE`).
2. Validate permissions (0C), the status mapping (every source status maps to a target-brand status), the field mapping, and that no containment parent remains in the source brand. The root is detached from a source-brand parent or project, or the move includes that container.
3. Update `brand_id` on the envelope **and** the typed row for every record in the subtree. Hosted children (comments, field values, attachments, followers, checklist items) are updated through their scope columns. Deferrable composite foreign keys verify agreement at commit.
4. Re-validate associations. Links the actor could not create in the target are recorded in `dropped_associations` and removed (with audit), or kept if still valid. Grants stay, with `source_brand_id` updated, and their audit records the change.
5. Emit `record.moved_brand` with old and new brand. Search, metrics, and notification projections re-key. Audit events written **before** the move keep the old `brand_id` (history is not rewritten).

Brand status is not lifecycle: a brand's `operational_status` (`operating`, `paused`, `planned`) is business metadata. Archiving, trashing, and purging a brand use the envelope's `lifecycle_state` like every other record ([ADR-19](12-decisions.md#adr-19)).

## 3.8 Personal records

Personal rows (`today_commitment`, `notification`, `view_state`, `favorite`, `recent_item`, `work_block`, `availability_rule`, `time_off`, `reminder`, `briefing`, `inbox_item`) are filtered by `owner_membership_id = :me` in addition to workspace. When they reference brand-owned records, the reference never grants access, and lists drop referenced records the owner can no longer read. A Today commitment to a task whose access was revoked disappears from Today, and the row stays for the daily record.

Phase 1E makes this concrete for `favorite`, `recent_item`, and `view_state` ([ADR-20](12-decisions.md#adr-20)). Entries are re-authorized at display and activation and dropped silently when unreadable. A URL or stored scope naming a brand the viewer cannot access is normalized server-side to an accessible scope, never broadened.

## 3.9 Guests

Guests are memberships with `kind = 'guest'`. They have **no implicit workspace-level access**. Workspace-scoped records are visible to them only through explicit record grants. Guest queries never use workspace, brand, project, team, or containment-inherited role assignments. Each shared child is its own fixed grant row; future children are never included.
