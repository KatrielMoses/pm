# 1. Domain module map

The product is a **modular monolith**: one deployable, one PostgreSQL database, and 32 modules with explicit ownership. The full table (responsibilities, dependencies, published facts, FEATURES sections, entity counts) and the dependency graph are generated in [generated/module-index.md](generated/module-index.md) from [model/model.json](model/model.json). This document states the rules.

## 1.1 Layers

Modules may depend only on modules in the **same or a lower layer**. The validator enforces this and rejects cycles.

| Layer | Modules | Character |
|---|---|---|
| 0 Platform | `execution`, `audit`, `core` | Operations, jobs, outbox/inbox, audit, the record envelope and lifecycle. No domain knowledge. |
| 1 Tenancy and commercial | `identity`, `tenancy`, `access`, `governance`, `metering`, `billing` | Who and where: accounts, workspaces, brands, memberships, grants, retention policy, usage, plans |
| 2 Shared primitives | `workflow`, `relations`, `collab`, `notify` | Reusable mechanics that any domain record uses through `core.record` |
| 3 Core work | `work`, `files`, `capture`, `planning`, `time`, `knowledge`, `goals`, `views` | The product without AI or integrations (roadmap principle 5) |
| 4 Platform features | `search`, `insights`, `integrations`, `transfer`, `delivery`, `quality`, `templates`, `support` | Projections, external systems, data movement, development and test workflows |
| 5 Execution layers | `ai`, `automation`, `agents` | Optional layers that act **through** lower modules' commands, never by writing their tables |

Core work (layers 0–3) has **no dependency on AI, automation, agents, or integrations**. This is what keeps it usable during their outages (LA-020).

## 1.2 Ownership and write rules

1. **One owner per table.** Each table lives in its module's schema (`work.task`, `planning.work_block`). Only the owning module issues `INSERT`/`UPDATE`/`DELETE` on it.
2. **Reads across modules** go through the owning module's query API or a published read view in the module's schema. Foreign keys may point into the tables of a module it depends on (same or lower layer). This is a read dependency and is declared in `depends_on`.
3. **Commands across modules** are synchronous in-process calls to the owning module's command API inside the caller's transaction, used when one invariant spans both. Example: triage in `capture` calls `work.create_task` in the same transaction that marks the Inbox item converted.
4. **Facts across modules** are published as outbox events (`publishes` in the model). Consumers update their own tables. Examples: `task.completed` feeds `insights` metric snapshots, `search` re-indexing, and `notify`. `test_result.recorded` feeds `delivery` release readiness.
5. **`core` owns lifecycle.** Archive, trash, restore, purge, and brand move are commands on `core`. It updates the envelope and calls each owning module's lifecycle hook in the same transaction, or in a batch job for large subtrees.
6. **Upper layers act as principals.** `ai` applies change proposals, `automation` runs actions, and `agents` executes tools by calling the same command APIs a human request uses. Each call carries the actor type and operation ID, so authorization (0C), validation, and audit are identical.

## 1.3 Module list

| Module | Owns (summary) | Main published facts |
|---|---|---|
| `execution` | operations, attempts, idempotency keys, jobs, outbox, inbox receipts, external-effect ledger | `operation.*`, `job.*` |
| `audit` | audit events, redactions, security events, activity projection | `audit.redacted` |
| `core` | record envelope, deletion and archive batches, brand moves, tombstones | `record.archived/restored/trashed/purged/moved_brand` |
| `identity` | accounts, credentials, MFA, sessions, OAuth identities, tokens, step-up challenges | `account.*`, `session.revoked` |
| `tenancy` | workspaces, brands, brand settings, memberships, teams, invitations, ownership transfer | `workspace.*`, `brand.*`, `membership.*` |
| `access` | roles, role assignments (incl. time-boxed elevation), share groups and record grants, field policies, permission epochs, service principals, support access grants, typed workspace policy | `grant.*`, `role.assigned` |
| `governance` | retention policy, legal-hold extension point, deletion requests | `retention.policy_changed`, `workspace.deletion_requested` |
| `metering` | usage events, balances, spend limits, reservations | `usage.threshold_reached`, `usage.limit_reached` |
| `billing` | billing accounts, plans, subscriptions, entitlements, invoices, payment events, coupons | `subscription.*`, `entitlement.changed` |
| `workflow` | workflows, statuses, revisions, field definitions/options/sets, calculated fields, field values | `workflow.revised`, `field.values_changed` |
| `relations` | record relationships, labels, mentions, record links, followers | `relationship.*`, `mention.created`, `follow.*` |
| `collab` | comments, revisions, reactions, review requests and decisions | `comment.*`, `review.*` |
| `notify` | notifications, deliveries, preferences, digests | `notification.delivered` |
| `work` | projects, members, phases, milestones, tasks, assignees, checklists, criteria, updates, decisions, reminders | `project.*`, `task.*` |
| `files` | objects, files, versions, upload sessions, deliverables and versions, evidence, storage usage | `file.scanned`, `deliverable.version_submitted` |
| `capture` | Inbox items, notes, intake forms and submissions, email capture | `inbox.captured`, `inbox.triaged` |
| `planning` | Today commitments, daily records, work blocks, recurrence, availability, holidays, time off, capacity reservations | `commitment.*`, `work_block.*`, `occurrence.generated` |
| `time` | time entries and timers, timesheets, approvals, period locks | `time_entry.*`, `timesheet.*` |
| `knowledge` | documents, versions, source approvals, suggestions | `document.*` |
| `goals` | goals, key results, links, check-ins, portfolios | `goal.*` |
| `views` | saved views, defaults, favorites, recent items, view state | `view.*` |
| `search` | search projection, index status, recent searches | `search.index_failed` |
| `insights` | metric definitions and snapshots, dashboards, reports, report runs | `report.delivered` |
| `integrations` | connections, mappings, external identities, calendar-event mirrors, syncs, inbound/outbound webhooks, API tokens, OAuth clients | `connection.*`, `sync.*`, `webhook.delivery_failed` |
| `transfer` | imports, mappings, row outcomes, exports, export files | `import.*`, `export.*` |
| `delivery` | development links, external code facts, environments, deployments, releases, scope, checklist, waivers, decisions | `release.decided`, `deployment.recorded` |
| `quality` | test cases and versions, suites, runs, results, flaky classification, defect details, verifications | `test_result.recorded`, `defect.verified` |
| `templates` | templates, versions, installations, onboarding progress | `template.installed` |
| `ai` | provider configs, brand AI profiles, AI actions, context refs, outputs, proposals, briefings | `ai_action.*`, `proposal.applied`, `briefing.generated` |
| `automation` | automations, versions, runs, step runs | `automation_run.*` |
| `agents` | agent profiles, scope/tool grants, connectors, assignments, runs, tool calls, artifacts, action approvals, emergency stop | `agent_run.*`, `action_approval.*` |
| `support` | support requests, diagnostics, feedback, platform content | `support.request_created` |

## 1.4 Dependency choices worth knowing

- **`files` depends on `work`, not the reverse.** Deliverables are contained by tasks. Task completion gates read review decisions from `collab`, and reviews reference their subject polymorphically through `core.record`. The resulting chain is `files → work → collab` with no cycle.
- **`quality` depends on `delivery`.** Test runs and defects reference environments and releases. Release readiness in `delivery` consumes `test_result.recorded` and `defect.verified` events into its own readiness snapshot instead of reading `quality` tables.
- **`integrations` depends on `planning`.** The calendar adapter writes work blocks through `planning` commands and mirrors external events in `integrations.calendar_event`. Planning knows nothing about Google.
- **`audit` and `execution` sit below `core`.** Audit events carry target IDs **without foreign keys**, so they survive purge ([07](07-audit-provenance.md)).
- **`search` and `insights` are pure consumers.** They are rebuildable from source tables and events, and never written by other modules.

## 1.5 Integration boundaries

| Boundary | Mechanism |
|---|---|
| External systems (GitHub, Google Calendar, test runners, webhooks) | `integrations` adapters. Inbound messages are deduplicated in `integrations.inbound_message`, processed via consumer inbox, and turned into commands on owning modules. Outbound effects go through `execution.external_effect`. |
| AI providers | `ai` gateway only. Context is assembled from authorized records through module query APIs, after redaction ([11](11-data-classification.md)). |
| Payments | `billing` adapters with provider event deduplication (`billing.payment_event`). |
| Object storage | `files` only, via signed URLs ([10 §10.8](10-postgresql-guidance.md#108-object-storage)). |
| Secret store | Referenced by ID only (`*_secret_ref`). There is no secret table in the application schemas ([ADR-16](12-decisions.md#adr-16)). |

## 1.6 When a module may be extracted

Extraction is **not planned**. The evidence that would justify it:

- one module's workload dominates database resources despite indexing and partitioning (likely candidates: `audit`, `search`, `execution` jobs);
- independent scaling or release cadence is demonstrably blocked;
- a compliance boundary requires physical separation (for example, the secret store or billing).

The boundaries above (no cross-module writes, events for facts, IDs without cross-module foreign keys in `audit`) keep that option open.
