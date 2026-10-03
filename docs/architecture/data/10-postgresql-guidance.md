# 10. PostgreSQL storage and scale guidance

Target: one managed PostgreSQL (current major version at Phase 1A, ≥ 15) with no Elasticsearch, Kafka, separate vector database, or microservices. Extensions are limited to those widely available on managed services: `pgcrypto`, `citext`, `btree_gist`, `pg_trgm`, `unaccent`, and optionally `vector` later.

## 10.1 Schemas and migration ownership

- One schema per module (`exec`, `audit`, `core`, `identity`, `tenancy`, `access`, `governance`, `metering`, `billing`, `workflow`, `relations`, `collab`, `notify`, `work`, `files`, `capture`, `planning`, `timetrack`, `knowledge`, `goals`, `views`, `search`, `insights`, `integrations`, `transfer`, `quality`, `delivery`, `templates`, `ai`, `automation`, `agents`, `support`). Names are in the model's `schema` field.
- Migrations live with their module and run in **one ordered migration stream** (a single tool and history table) so cross-module foreign keys apply in dependency order. A module's migration may reference only schemas it `depends_on`.
- **Roles:** `app_rw` (application: DML on its tables, no DDL); `app_ro` (read replicas and reports); `audit_maintainer` (redaction and purge procedures); `migrator` (DDL); `platform_admin` (bypasses RLS for support tooling, every use audited). The application never connects as owner.
- **Expand/contract migrations only.** Add nullable columns or new tables, backfill in jobs, switch reads, then drop in a later release. A deployment must work against both the previous and the next schema (zero-downtime rolling deploys).

## 10.2 Keys and public identifiers

- `id uuid PRIMARY KEY` (UUIDv7, app-generated) on every table. Append-heavy tables use a composite primary key `(occurred_at, id)` or `(created_at, id)` when partitioned.
- `public_id text` with `UNIQUE` on `core.record` and on API-visible non-addressable tables. Format `^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{26}$` enforced by `CHECK`.
- Composite unique keys exist solely to serve tenant-consistent foreign keys: `(workspace_id, id)`, `(workspace_id, brand_id, id)`, `(workspace_id, scope_key, id)`, and on `core.record` `(id, workspace_id, scope_key, lifecycle_state)`.

## 10.3 Constraints

| Kind | Use |
|---|---|
| Composite foreign keys including `workspace_id` (and `brand_id`/`scope_key`) | Tenant and brand consistency (T1, T2, T7) |
| `DEFERRABLE INITIALLY DEFERRED` foreign keys | Envelope ↔ typed row agreement; brand moves; bulk lifecycle changes |
| `CHECK` | Enum-like states (prefer PostgreSQL enums for stable vocabularies such as `actor_type`, `lifecycle_state`, `status_category`, `exec_state`; use lookup tables for vocabularies that grow); `num_nonnulls` exclusive arcs; deadline forms; terminal-reason consistency; non-negative quantities; `from <> to` |
| Partial `UNIQUE` | Active shares, one running timer, one active run per (task, agent), operation dedupe while non-terminal, names among non-retired |
| Exclusion (`btree_gist`) | Optional: non-overlapping period locks per (brand, person); non-overlapping availability rules per (person, weekday) |
| Constraint triggers (deferred) | The few cross-row rules that need nullable equality ([03 §3.3](03-tenancy-brand-sharing.md#33-database-enforced-invariants)), locked-period backstop, evidence-lock backstop, audit append-only guard |

## 10.4 Row-level security (defense in depth)

- Enable `ROW LEVEL SECURITY` with `FORCE` on tenant tables. Policy: `USING (workspace_id = current_setting('app.workspace_id')::uuid)`, with the same `WITH CHECK`.
- The application sets `SET LOCAL app.workspace_id` at the start of every transaction (works with transaction-mode connection pooling). Jobs set it per workspace they process. Ordinary application, worker, support, dispatcher, and scheduler roles never receive `BYPASSRLS`. Cross-workspace discovery uses tightly scoped, payload-free `SECURITY DEFINER` scheduling functions; processing then occurs in one fail-closed workspace transaction at a time. Migration and restore tooling use separate audited operational identities.
- RLS does **not** implement brand/project/record authorization. That stays in the 0C policy layer, which composes SQL predicates. RLS only guarantees that a missing filter cannot cross tenants.

## 10.5 Index guidance

Lead every tenant index with `workspace_id` (and `scope_key`/`brand_id` where queries filter by brand). Use **partial indexes on active rows** for hot paths.

| Query | Index (illustrative) |
|---|---|
| Brand task lists by status | `work.task (workspace_id, scope_key, status_category, rank_in_parent, id) WHERE lifecycle_state = 'active'` |
| Project task lists | `(workspace_id, project_id, status_category, rank_in_parent, id) WHERE lifecycle_state = 'active'` |
| My Work / assignee | `work.task_assignee (workspace_id, membership_id, task_id)` + task by id |
| Due and overdue | `(workspace_id, scope_key, due_date) WHERE lifecycle_state = 'active' AND status_category IN ('planned','active','paused')` |
| Deadlines | `(workspace_id, scope_key, coalesce(deadline_at::date, deadline_date))` partial as above |
| Subtrees | GIN `(ancestor_ids)`; children `(workspace_id, parent_task_id, rank_in_parent, id)` |
| Relationships | `(to_record_id, kind)`, `(from_record_id, kind)`, plus `(workspace_id, to_brand_id)` |
| Custom field filters | `field_value (field_id, value_numeric)`, `(field_id, value_date)`, `(field_id, value_text)` partials; GIN `(value_option_ids)` |
| Work blocks in a range | `planning.work_block (workspace_id, owner_membership_id, starts_at)` and GiST on `tstzrange(starts_at, ends_at)` for overlap/conflict detection |
| Today | `today_commitment (workspace_id, membership_id, day, rank, id)` |
| Notifications | `(workspace_id, recipient_membership_id, state, created_at DESC)` |
| Audit by target | `(workspace_id, target_record_id, occurred_at DESC)`; by actor `(workspace_id, actor_id, occurred_at DESC)` |
| Execution | `operation (workspace_id, kind, execution_state, created_at DESC)`; jobs `(queue, state, run_at) WHERE state = 'queued'` |
| Public ID lookups | `UNIQUE (public_id)` |

**Cursor pagination:** keyset on `(sort_key, id)` with an opaque cursor encoding both. `OFFSET` is never used for user-facing lists. The total count, where shown, is computed on the authorized set and may be capped or estimated with a label (IA-41).

## 10.6 JSON policy

`jsonb` is allowed for: versioned definitions (workflow revisions, query ASTs, automation versions, template packages, calculated-field ASTs), provider payloads kept for provenance, snapshots (readiness, daily records), audit `changes`, redacted error details, and parsed suggestions. Every JSON column has a `schema_version`, owner-module validation, and a size cap. **Never** in JSON: tenant keys, brand keys, lifecycle, status, assignee, dates, or anything used in authorization, filtering, sorting, or uniqueness.

## 10.7 Full-text search foundation

- `search.search_document`: one row per (record, part), where a part is the record itself, a comment, or extracted attachment text. Columns: `workspace_id`, `scope_key`, `brand_id`, `project_id`, `record_type`, `lifecycle_state`, `title`, `snippet_source`, `tsv tsvector`, `language regconfig`, `source_version`, `indexed_at`.
- `tsv = setweight(to_tsvector(cfg, title), 'A') || setweight(to_tsvector(cfg, body), 'B') || …`, with GIN on `tsv`. `pg_trgm` GIN on `title` supports quick-search prefix and fuzzy matching (command palette).
- Fed by outbox consumers. Failures are written to `search.index_status` (SRCH-012).
- **Authorization is applied in the query** with the same scope predicates as list views, then record grants. Highlights (`ts_headline`) are computed only for rows that pass authorization.
- Natural-language concepts (SRCH-004): at launch, AI-assisted query interpretation over full-text search (OD-31). If semantic search is approved, add `pgvector` embeddings in `search.search_embedding` keyed like `search_document`, with the same authorization predicates. No separate vector database.

## 10.8 Object storage

- Keys are random: `ws/{workspace_uuid}/{random_128_bit}`. They carry no names, brands, or titles. Objects are immutable, and a new version is a new object.
- `files.file_object` stores the key, sha256, size, content type, scan state, and storage class. Deduplication is **within a workspace only**, so another tenant can never infer content by hash.
- Uploads use pre-signed PUT to a quarantine prefix. A scan job promotes clean objects. Downloads use short-lived pre-signed GETs issued after authorization, with `Content-Disposition: attachment` for active content types.
- Server-side encryption is required. Per-workspace keys are an extension point if a customer requirement appears.

## 10.9 Append-heavy tables and partitioning

Do **not** partition at launch. Design every append-heavy table to be **partition-ready**: the primary key includes the time column, there are no foreign keys **into** these tables, and retention purge runs by time range.

| Table | Partition key when needed | Trigger to partition (any of) |
|---|---|---|
| `audit.audit_event`, `audit.security_event` | `occurred_at` monthly range | > ~100 M rows or > ~100 GB, or retention deletes cause sustained bloat or vacuum lag |
| `audit.activity_item` | `created_at` monthly | same |
| `notify.notification`, `notify.notification_delivery` | `created_at` monthly | same |
| `integrations.webhook_delivery`, `integrations.inbound_message` | `created_at` weekly or monthly | same |
| `execution.attempt`, `execution.operation` (terminal) | `created_at` monthly | same |
| `metering.usage_event` | `occurred_at` monthly | same; billing retention may keep partitions longer |
| `quality.test_result`, `delivery.external_fact`, `agents.agent_tool_call`, `automation.automation_step_run` | `created_at` monthly | same |
| `execution.outbox_event`, `execution.job` | Not partitioned. Kept small by prompt deletion. | — |

Thresholds are starting points to validate with measurements in 11D. Per-workspace retention differences are handled by deletes within partitions. Dropping a whole partition is used only for the platform maximum.

## 10.10 Encryption and credential separation

- TLS in transit (SEC-001). Storage encryption at rest by the managed service (SEC-002).
- **Application-level encryption** (envelope encryption with keys in a KMS, `pgcrypto` not used for key storage) for: MFA secrets, calendar event titles mirrored from external calendars, intake submission contact data, diagnostics bundles, and any field later classified C3 that needs it.
- **Secrets never live in application tables.** OAuth tokens, API keys for providers, webhook signing secrets, and agent connector credentials live in the secret store. Tables hold `*_secret_ref` only ([ADR-16](12-decisions.md#adr-16)). API tokens and session tokens are stored as SHA-256 hashes of high-entropy values with a display prefix. Passwords use a modern KDF (Argon2id; parameters in 1B).
- Logs, error reports, search, AI context, and exports go through the redaction layer (SEC-014). Columns classified C4 are excluded by allow-list serializers, not deny-lists.

## 10.11 Backup, restore, and migration compatibility

- Managed point-in-time recovery plus periodic logical exports per workspace for portability tests. RPO/RTO targets are decided by OD-42 after 11C measurements.
- The restore runbook includes the purge-ledger replay ([08 §8.11](08-deletion-retention.md#811-external-systems-and-backups)) and outbox dispatcher reconciliation (events after the backup point are regenerated or ignored by consumer inbox dedupe).
- Backups and restores are tested regularly (SEC-018), including a restored-environment authorization test.
- Per-workspace restore (restoring one tenant's data from backup) is **not** a launch capability. The stable IDs and envelope design make it possible later.
