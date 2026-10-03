# 4. Reusable relationship primitives

Every primitive below is **typed** and has a real foreign key wherever it references "any addressable record", through `core.record` ([ADR-04](12-decisions.md#adr-04)). Only append-only evidence that must outlive its target (audit events, activity items) stores target IDs without foreign keys.

## 4.1 Hierarchies

Hierarchies in scope: project trees (`work.project.parent_project_id`), task/subtask trees (`work.task.parent_task_id`), and document page trees (`knowledge.document.parent_document_id`).

**Representation ([ADR-05](12-decisions.md#adr-05)):** adjacency list (`parent_id`) as the source of truth, plus a materialized `ancestor_ids uuid[]` (root first, excluding self) and `depth smallint` on each row, maintained in the same transaction as any structural change.

| Operation | How |
|---|---|
| Ancestors | `ancestor_ids` (no recursion) |
| Descendants / subtree | `WHERE ancestor_ids @> ARRAY[:id]` using a GIN index on `ancestor_ids`, scoped by `workspace_id` |
| Children in order | `WHERE parent_id = :id ORDER BY rank, id` |
| Depth cap | `CHECK (depth <= 32)` as a hard technical ceiling. The product cap (OD-08 safe default: 10, lower per workspace) is enforced by the command on create, move, and import. |
| Cycle prevention | Moving node *N* under *P* is rejected if `P = N` or `N = ANY(P.ancestor_ids)`. |
| Concurrent moves | Every structural change takes `pg_advisory_xact_lock(hashtextextended('tree:' || root_id, 0))` on the tree root(s) involved. A move between trees locks both roots in ID order. This prevents two concurrent moves from creating a cycle that neither saw. |
| Move | One statement updates the subtree: `ancestor_ids = :new_prefix || ancestor_ids[k+1:]`, `depth = depth - :old_depth + :new_depth`. Containment foreign keys (same brand or scope) are verified at commit. |
| Subtree lifecycle (archive, trash, purge, brand move) | Selects the subtree with the GIN index and writes batch membership in one statement. |
| Rollups (progress, effort) | Computed asynchronously into rollup tables from `task.*` events, never by recursive queries on hot paths. |

**Why not the alternatives:**

- A closure table has one row per ancestor pair and more writes on move.
- `ltree` needs label encoding of UUIDs and cannot carry foreign keys either.
- Nested sets make every insert expensive.
- A pure adjacency list with recursive CTEs makes subtree operations and authorization filters slow at depth.

The array approach keeps one row per node, bounded depth makes moves cheap, and the GIN index serves subtree lookups.

## 4.2 Dependencies and related records

`relations.record_relationship (kind, from_record_id, to_record_id, from_brand_id, to_brand_id, …)`

| Rule | Mechanism |
|---|---|
| Kinds | `blocks` (from blocks to; the default dependency type, OD-09) and `related` (non-blocking, stored once with `from_record_id < to_record_id` to avoid duplicates). Further dependency subtypes (start-to-start, …) can be added as new `kind` values. |
| No self-links, no duplicates | `CHECK (from_record_id <> to_record_id)`, `UNIQUE (from_record_id, to_record_id, kind)` |
| No dependency cycles | The command runs a bounded recursive check over `blocks` edges reachable from `to` before inserting. It serializes with an advisory lock on the workspace's dependency graph partition (keyed by the smaller endpoint's brand) to prevent concurrent cycle creation. |
| Allowed endpoints | Tasks, projects, milestones (project dependencies, PRJ-011). Containment never uses this table. |
| Cross-brand | Allowed when the creator can read both ends (approved). Both brands are stored, and viewers who cannot read an end never see the row ([03 §3.5](03-tenancy-brand-sharing.md#35-hidden-endpoints-counts-and-derived-conditions)). |
| Lifecycle | Rows survive trash of an endpoint and are hidden while it is trashed. When an endpoint is purged the row is deleted, and a tombstone-aware audit event records the removal. |

## 4.3 Links and mentions

- `relations.record_link`: a non-blocking link from a record to another record or to a URL (DOC-008, TSK-017). Links to synced external objects target the internal record mapped by `integrations.external_identity`, or a URL when no mirror exists.
- `relations.mention`: extracted from authored content (comment, document version, rich-text field) on save. Columns: `source_kind`, `source_id`, `target_kind` (record, membership, team, agent), `target_id`, `notified`. Mentions are **re-extracted from the content** on each revision, so stored rows reflect the current text.
- Rendering of an unreadable mention target is the neutral "Restricted item" token. The token is produced at read time, and nothing about the target is stored in the source content (only its ID).

## 4.4 Followers

`relations.follower (record_id, membership_id, source)` with `UNIQUE (record_id, membership_id)`. `source` is `manual`, `assigned`, `mentioned`, or `created` (auto-follow rules). Notification fan-out re-checks read access per follower at delivery.

## 4.5 Labels

`relations.label` (workspace or brand scope, `UNIQUE (scope_key, lower(name))`) and `relations.label_assignment (record_id, label_id)`. A label may be applied only to records in a scope where it is valid: workspace labels anywhere in the workspace, brand labels only within that brand. The command enforces this, and bulk cross-brand labeling follows ST-13.

## 4.6 Custom fields

| Table | Role |
|---|---|
| `workflow.field_definition` | Scope (workspace, brand, project), record type, `field_type` (immutable), validation, visibility, advanced flag, `retired_at` |
| `workflow.field_option` | Options for select and multi-select, ranked |
| `workflow.field_set` | Reusable bundles |
| `workflow.calculated_field_definition` | Versioned expression AST, declared dependencies |
| `workflow.field_value` | **One row per (record, field)** with typed columns: `value_text`, `value_numeric`, `value_date`, `value_ts`, `value_bool`, `value_ref` (person/record), `value_option_ids uuid[]` |

- A `CHECK` ensures exactly the column matching the definition's type is populated. The type is copied into `field_value.field_type` and covered by a composite foreign key to `(field_id, field_type)`.
- Values for currency carry `value_numeric` plus a currency code in `value_text`. URL and email values are validated text.
- **Indexes:** `(field_id, value_numeric)`, `(field_id, value_date)`, `(field_id, value_text)` (partial per type), and GIN on `value_option_ids`. The saved-view engine (3A) can then filter and sort on any field.
- **Evolution:** a definition's type never changes. Changing a type means creating a new field and migrating values in an explicit job. Retiring hides the field and keeps its values for history and export (WFL-014).
- **Calculated fields** are evaluated by a sandboxed, side-effect-free interpreter. Values are **materialized** into `field_value` with `calc_version` and `computed_at` by an async job triggered by changes to declared dependencies. Views show "Calculating…" while `computed_at` is behind the dependency watermark. The interpreter is never run inside SQL.
- Brief-specific rule: core fields (status, dates, priority, assignees, estimates) are **never** stored as custom fields.

## 4.7 Saved views and query definitions

`views.saved_view.query` is a **versioned query AST** (JSON) over a whitelisted field catalog: core columns, custom fields by ID, and relationships with explicit join semantics. It supports AND/OR groups, multi-sort, grouping, columns, density, and layout. The view engine compiles the AST to SQL with mandatory scope and authorization predicates added by the engine, never by the AST. A view therefore cannot express "ignore permissions", and a shared view returns different rows to different viewers. Personal state (`views.view_state`) is separate from the shared definition (DEP-0A-09 assumption).

## 4.8 Comments, reactions, reviews

- `collab.comment (host_record_id → core.record, root_comment_id, body_rich, body_text, author_*, edited_at, deleted_at, version)`. Threads are one level deep (root + replies), so no tree is needed. Edits create `collab.comment_revision` rows, retained per OD-38. A deletion sets `deleted_at` and blanks the visible body. The prior body goes to a revision under the same rule.
- `collab.reaction` has `UNIQUE (comment_id, membership_id, emoji)`.
- `collab.review_request (subject_kind, subject_id, subject_version_ref, requested_by, reviewer_rule, state, previous_request_id)`. Subjects: task, deliverable version, document version (approved-source verification), change proposal, agent action approval, timesheet, release. One request has **at most one terminal decision**.
- `collab.review_decision` is append-only: `decision`, `reviewer_id`, `reviewer_actor_type` (`CHECK (reviewer_actor_type = 'human')`), `subject_version_ref`, `self_approval`, `decided_at`. `UNIQUE (review_request_id)` enforces a single terminal decision. Resubmission creates a new request linked by `previous_request_id`. Agent self-approval is structurally impossible (the reviewer must be human). Human self-approval is recorded with a flag and allowed only when the policy setting permits it (OD-20).

## 4.9 Files, attachments, versions, deliverables, evidence

| Table | Role |
|---|---|
| `files.file_object` | Immutable object-storage blob: random key, sha256, size, content type, scan state. Never shared across workspaces. |
| `files.file` (addressable) | Logical file with name, owner, source, `host_record_id` (one host: workspace-level document, brand, project, task, document, or the host of a comment plus `comment_id`), `current_version_id` |
| `files.file_version` | Immutable version pointing to a `file_object` **or** an external URL (FILE-005, never copied) |
| `files.deliverable` (addressable) | The designated output of a task |
| `files.deliverable_version` | Submitted iteration (file version, URL, or agent artifact). `review_state` is derived from the latest review request. `accepted_review_decision_id` and `evidence_locked` are set on acceptance. |
| `files.evidence_item` | Evidence attached to a subject (test result, defect, release decision, review, environment). `locked_by_kind/id` records which immutable decision locks it. |

**Downloads** require an authorization check and a scan state of `clean`, and use short-lived signed URLs ([10 §10.8](10-postgresql-guidance.md#108-object-storage)). **Comparisons** (FILE-008) are computed on demand from two versions. **Purge** of objects happens only through the purge job, after no `file_version` references the object.

## 4.10 External-record links and synchronization identity

`integrations.external_identity (connection_id, external_type, external_id, record_id, remote_version, last_synced_at, detached)` with:

- `UNIQUE (connection_id, external_type, external_id)`: one internal mirror per external object per connection, which prevents duplicate imports from webhooks plus polling;
- `UNIQUE (record_id, connection_id, external_type)`: one external counterpart per record per connection.

Field-level sync conflicts become `integrations.sync_conflict` rows. Disconnecting with "retain" sets `detached = true` and `record.source_kind` keeps the provenance. Disconnecting with "remove" trashes mirrored records as one deletion batch (0A deletion §6). Development links (`delivery.dev_link`) and external code facts (`delivery.external_fact`) build on `external_identity`.

## 4.11 Templates and instantiation provenance

- `templates.template_version.content` is a typed, versioned package (JSON validated per template kind) describing records to create. It never contains IDs from the source workspace except as package-local references.
- Installing runs a `templates.template_installation` operation. Every created envelope gets `template_installation_id` and `source_kind = 'template'` (or `'sample'`). "Remove sample data cleanly" (ONB-016) then means "trash everything with this installation ID that the user has not modified", with modified records listed for an explicit choice (0A deletion §3).
- Templates created from existing projects (PRJ-015) are produced by a serializer that strips personal data, secrets, and cross-brand references.
