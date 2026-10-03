# Product Build Roadmap (Proposed)

Status: awaiting product-owner approval

Source of scope: `FEATURES.md` (661 product requirements plus 23 launch acceptance requirements)

## Delivery principles

1. Build a modular monolith first. Keep domain boundaries clear, but do not pay the operational cost of microservices before scale requires them.
2. Use one relational database as the source of truth, object storage for files, and a durable background-job mechanism. Add specialized infrastructure only when measured needs justify it.
3. Every tenant-owned record carries a workspace boundary; every brand-owned record also carries a brand boundary. Authorization is enforced server-side at every read, write, search, export, AI retrieval, integration, and agent boundary.
4. Use stable IDs, soft deletion where recovery is promised, append-only audit events, idempotency keys for retried writes, and an outbox-style mechanism for reliable asynchronous work.
5. Treat AI, agents, integrations, and automations as optional execution layers. Core work management must continue when any of them is unavailable.
6. Build responsive, accessible interfaces and automated tests during each phase. The final phase is not where quality begins; it is where the complete product is proven ready for manual and user-experience testing.
7. Every sub-phase must finish with working UI, server-side authorization, migrations, automated tests, observability, and updated documentation—not only data models or mock screens.
8. Prefer configurable primitives over separate implementations: records, relationships, statuses, custom fields, views, approvals, files, comments, audit events, notifications, and usage meters should be reusable across domains.

## Cost-conscious reference architecture

The exact technology choices should be confirmed before Phase 1. The intended shape is:

- A single web application and API deployment, organized into domain modules.
- Managed PostgreSQL for transactional data, full-text search initially, job state, and optionally vector search.
- S3-compatible object storage with signed access for files and evidence.
- A database-backed worker queue initially; introduce Redis or a dedicated broker only when operational evidence requires it.
- Server-sent events for one-way live progress; add broader realtime infrastructure only for collaborative editing or presence where necessary.
- CDN-backed static assets and aggressively cached public/help content.
- Usage-based third-party services for email, payments, malware scanning, AI models, and error monitoring, behind provider adapters.
- Separate local, development, staging, and production configurations, with infrastructure defined reproducibly.
- A provider-neutral deployment boundary so hosting can move without rewriting product logic.

Avoid at the outset: microservices, Kafka, Elasticsearch, a separate vector database, multi-region active-active operation, and custom infrastructure for solved commodity functions.

## Phase 0 — Product and engineering contracts

Goal: remove decisions that would otherwise cause expensive rewrites.

### 0A. Product vocabulary and scope contract

Define canonical terms, record hierarchy, lifecycle meanings, deletion/recovery promises, acceptance versus completion, due date versus scheduled time, and launch-plan boundaries. Convert every item in `FEATURES.md` into a traceable requirement ID.

### 0B. Domain and data architecture

Define bounded modules, entity relationships, stable identifiers, tenancy rules, brand ownership and controlled cross-brand sharing, record relationships, activity events, soft deletion, retention, and concurrency strategy.

### 0C. Authorization and policy model

Define roles, grants, inheritance, guest restrictions, field/integration/action permissions, effective-permission evaluation, agent permissions, and the rule that search and AI retrieval use the same authorization layer as ordinary reads.

### 0D. Platform contracts

Define API conventions, error format, pagination, idempotency, async job states, webhook envelopes, audit-event schema, notification-event schema, usage metering, feature entitlements, file access, and observability conventions.

### 0E. UX foundation

Define information architecture, responsive breakpoints, design tokens, accessibility baseline, form and validation behavior, loading/empty/error states, destructive-action conventions, and the shell for desktop, tablet, and mobile web.

Exit gate: approved architecture decision records, domain map, permission matrix, requirement traceability matrix, and initial release topology.

## Phase 1 — Secure SaaS foundation

Goal: establish a deployable, observable multi-tenant product shell.

### 1A. Repository, environments, and delivery pipeline

Create the application skeleton, automated checks, migration workflow, seed strategy, preview/staging/production environments, secret management, dependency scanning, error tracking, request tracing, health checks, and backup policy.

### 1B. Identity and sessions

Implement registration, verification, sign-in, password reset/recovery, secure sessions, remote sign-out, OAuth-ready identity boundaries, abuse protection, and MFA foundations.

### 1C. Workspaces, brands, and tenant isolation

Implement workspace and brand creation/editing, brand identity and settings, archive/restore, brand switcher, all-brands scope, working hours, calendars, goals/priorities settings, and strict isolation tests.

### 1D. Membership, roles, and invitations

Implement owners, administrators, members, limited members, guests, read-only access, invitations, teams, role assignment, server-side policy enforcement, effective-permission preview, and ownership preservation/transfer foundations.

### 1E. Application shell and personal navigation

Implement main navigation, workspace/brand context, breadcrumbs/history, themes, responsive shell, command palette foundation, keyboard-shortcut foundation, recently viewed, favorites, and persistent view state.

### 1F. Audit, deletion, and recovery primitives

Implement immutable material-event logging, actor types, previous/new values, soft deletion, restore windows, retention hooks, and security-event logging.

Exit gate: a user can securely create a workspace with three isolated brands, invite a scoped guest, switch contexts, and prove isolation with automated authorization tests.

## Phase 2 — Core work-management engine

Goal: make the product genuinely useful without AI or integrations.

### 2A. Projects and hierarchy

Implement project CRUD, lifecycle, ownership/collaboration, success criteria, scope/risk/budget fields, health, phases, milestones, dependencies, parent/child projects, followers, permissions, templates, and project sections.

### 2B. Tasks and relationships

Implement task CRUD and history, projectless tasks, multi-assignee work, dates and scheduling semantics, estimates, subtasks with cycle/depth safeguards, checklists, dependencies, blockers, related records, labels, attachments/links, acceptance criteria, and deliverable expectations.

### 2C. Configurable workflows and fields

Implement default/custom statuses, transition rules, required fields, approval gates, reusable custom fields and field sets, validation, calculated-field safety, visibility, and preservation through imports/exports.

### 2D. Task interaction quality

Implement inline editing, bulk actions, drag/drop, undo for reversible actions, duplicate detection foundations, freshness, missing-data warnings, task source, reminders, snoozing, recurrence, and templates.

### 2E. Inbox and universal capture

Implement task/note capture from any screen, incomplete Inbox items, paste-to-multiple capture, triage, merge, conversion, attachments, source preservation, and a deterministic parsing layer that can later be enhanced by AI.

Exit gate: the first-use flow creates a brand, useful project, tasks, and daily Inbox without configuration assistance; all mutations are authorized and auditable.

## Phase 3 — Views, planning, time, and capacity

Goal: turn stored work into an operational system for a multi-brand founder and team.

### 3A. Reusable query and saved-view engine

Implement composable AND/OR filters, multi-sort, grouping, column configuration, personal/shared/default views, view permissions, exports, deep links, and preserved state.

### 3B. Core views

Implement list, board, table, calendar, timeline, Gantt, milestone, activity, portfolio, workload, and timesheet views using the shared query engine rather than separate data rules.

### 3C. Today and manual planning

Implement Today, overdue/upcoming separation, manual commitment and ordering, work blocks distinct from deadlines, locked focus blocks, buffers, shutdown flow, unfinished-work rescheduling, and planned-versus-completed daily records.

### 3D. Time tracking and timesheets

Implement manual entries, timers, billable state, approvals, period locking, planned/actual/remaining effort, and exports.

### 3E. Capacity and cross-brand conflicts

Implement personal working hours, time off, brand capacity reservations, allocation views, founder capacity, conflict warnings, and capacity-aware rescheduling inputs.

Exit gate: users can plan, schedule, execute, and measure work across brands from desktop and mobile layouts without relying on external calendars or AI.

## Phase 4 — Collaboration, knowledge, files, and notifications

Goal: make work reviewable, explainable, and safely shareable.

### 4A. Comments, mentions, following, and reviews

Implement comments, threads, reactions, mentions, followers, delegation/reassignment history, review requests, approvals, and permission-safe activity displays.

### 4B. Notification platform

Implement durable in-app notifications, preferences, quiet hours, mute scopes, deduplication, grouping, searchable history, digests, email delivery, browser delivery, and delivery-failure handling.

### 4C. Documents and knowledge

Implement rich documents, nested pages, templates/types, record linking and mentions, embedded content, owner/review state, draft/current/stale/archive states, comments/suggestions, version history, restoration, and export.

### 4D. Collaborative editing

Add predictable conflict handling first; introduce live collaborative editing and presence using a proven collaboration engine rather than a bespoke synchronization algorithm.

### 4E. Files and deliverables

Implement signed uploads/downloads, previews, metadata, versions, external links, deliverable workflow, comparisons where formats permit, acceptance evidence, malware scanning, quotas, authorization, retention, and deletion.

Exit gate: a scoped guest can collaborate only on explicitly granted content; documents and deliverables have reviewable histories and protected file access.

## Phase 5 — Search, goals, portfolios, dashboards, and reporting

Goal: make information discoverable and management decisions evidence-backed.

### 5A. Permission-aware search

Implement PostgreSQL full-text search initially across supported records, authorization filtering before result disclosure, snippets/highlights, filters, in-context opening, recent searches, indexing jobs, and visible indexing failures.

### 5B. Goals and portfolio management

Implement goals, key results, linked-work progress, confidence, updates, portfolio health, dependencies, budgets, deadlines, effort, and orphaned-goal/project detection.

### 5C. Metrics model

Define versioned metric semantics and provenance for health, cycle time, age, workload, completion, accepted deliverables, tests, costs, and data freshness. Never infer business outcomes from activity without evidence.

### 5D. Dashboards and reports

Implement owner, brand, project, release, and personal dashboards; configurable widgets; filtering; drill-through; saved/shared reports; scheduled delivery; CSV/PDF export; and estimated/incomplete data labels.

Exit gate: every metric drills into authorized source records and displays its freshness/source.

## Phase 6 — Integration, API, calendar, and migration platform

Goal: open the product safely to external systems while preserving provenance and reliability.

### 6A. Integration framework

Implement encrypted OAuth/API-key connections, scopes, ownership/status, test/reauthorize/disconnect flows, retention choices, sync checkpoints, conflict records, and integration event history.

### 6B. Public API and webhooks

Implement granular API tokens, rotation/revocation, rate limiting, idempotent writes, signed outbound webhooks, verified inbound webhooks, retries/backoff, delivery history, and versioned documentation/examples.

### 6C. Google Calendar

Implement multiple calendars, two-way synchronization, recurrence, conflict handling, timezones/working hours/holidays, event movement, task work blocks, disconnection, and sync-state visibility.

### 6D. CSV import/export and data portability

Implement preview, field mapping, validation, row errors, saved mappings, resumability, deduplication, rollback window, stable IDs/relationships, complete authorized exports, cancellation export, and attachment archives/references.

### 6E. MCP-compatible access foundation

Expose narrowly scoped, auditable tools backed by the same authorization and idempotency layers as the public API.

Exit gate: Calendar, generic webhooks, API access, CSV portability, and integration failures meet their launch requirements without weakening tenant isolation.

## Phase 7 — AI assistance and briefings

Goal: add grounded, reviewable intelligence without making the product dependent on it.

### 7A. AI gateway, privacy, and budgets

Implement provider/model adapters, workspace keys where supported, context-policy enforcement, redaction, training/retention settings, token/cost metering, estimates, allowances, hard limits, cancellation, retries, and complete AI history.

### 7B. Authorized retrieval and citations

Implement retrieval over records the user can already access, explicit workspace/brand/project/task scope, include/exclude controls, source citations, stale/unapproved-source warnings, and separation of facts, calculations, suggestions, and unknowns.

### 7C. AI drafting and analysis

Implement summaries, extraction, project/task plans, milestones/dependencies/estimates/criteria, updates/release notes, rewriting, categorization, duplicate/stale/conflict detection, and recommendations.

### 7D. Change proposal protocol

AI never silently edits business records. It returns typed proposed changes with validation, preview, per-change selection, user editing, approval/rejection, atomic application, and accurate partial-failure reporting.

### 7E. Daily and weekly briefings

Implement source-linked owner/brand daily briefings, weekly reviews, status/release reports, correction capture, scheduling by timezone, in-app/email delivery, and accepted-deliverable versus claimed-completion distinctions.

### 7F. AI-assisted planning and capture

Add natural-language/voice capture interpretation and capacity-aware daily-plan proposals with reasons, deferrals, locked items, and accept/edit/reject behavior.

Exit gate: a founder can generate and edit a sourced project plan and briefing, see cost before expensive work, and continue all core workflows when AI is unavailable.

## Phase 8 — Automations and agent execution

Goal: execute work safely with explicit limits, approvals, and recoverability.

### 8A. Automation engine

Implement versioned trigger-condition-action definitions, AND/OR rules, delays, branches/fallbacks, previews, limits, loop prevention, deterministic run history, idempotent retries, failure alerts, and usage metering.

### 8B. Agent profiles and connectors

Implement internal and external agent profiles, templates, tool/model/scope configuration, API/webhook/MCP-compatible connections, and task assignment with structured context, constraints, deliverables, and acceptance criteria.

### 8C. Durable agent runs

Implement queue/start/pause/cancel/retry/resume, explicit run states, progress streaming distinct from completion, artifacts, tool-call history, errors, usage/cost, timeouts, deduplication, and emergency stop.

### 8D. Approval and review control plane

Classify action risk; require approval for external messages, publishing, spending, access/destructive/production changes, and scope expansion. Prevent self-approval, validate deliverables, and create follow-up work from review feedback.

Exit gate: one connected agent can execute a scoped task, fail safely, return a reviewable deliverable, and never complete the task before acceptance.

## Phase 9 — Development, testing, and release operations

Goal: support evidence-based software delivery as a first-class workflow.

### 9A. GitHub integration

Implement organization/repository connection, brand/project mapping, issues and selected-field sync, task/issue creation, branch/commit/PR/release/action links, CI/review/merge state, deployments, provenance, sync errors, and event history.

### 9B. Test management

Implement manual/automated cases, typed/voice scenarios with review, suites, requirement/work/release/environment links, results and evidence, generic API/webhook/report ingestion, and flaky-test detection.

### 9C. Defect lifecycle

Create evidence-preserving defects from failures; track severity/reproducibility/version/environment/owner; link fixes and PRs; distinguish merged from verified; and enforce configured rerun verification before resolution.

### 9D. Release management

Implement environments, release scope/exclusions, blockers, coverage, checklist, readiness, go/no-go approvals, immutable evidence/decision timestamps, deployed version, known issues, verification results, and draft release notes.

### 9E. Named launch contexts

Validate MailAccess, API Access, and Optestra as separate brand contexts, including equivalent evidence ingestion from Optestra and other test runners.

Exit gate: a failed test creates a defect, a linked fix is verified by rerun, and a release presents complete scope, blockers, approvals, evidence, and deployed version.

## Phase 10 — Commercial product, onboarding, and administration

Goal: make the system operable, sellable, transparent, and supportable.

### 10A. Entitlements and billing

Implement server-enforced plan entitlements, true single-user/multi-brand founder pricing, monthly/annual billing, seats, trials, transparent limits/overages, spending approvals/caps, invoices/tax details, proration explanations, payment recovery, cancellation/read-only/export windows, and coupons with explicit terms.

### 10B. Templates and onboarding

Implement guided setup, skippable integrations, removable sample workspace, first-value tracking, required template families, previews, selective installation, and reusable project/task/document/automation/agent templates.

### 10C. Administration console

Complete management for workspace, brands, people, roles, workflows, templates, automations, agents, integrations, notifications, billing, AI, security, sessions, retention, API/webhooks, storage, usage, health, audit, ownership, permissions, and role-based feature availability.

### 10D. Support and public information

Implement searchable help, contextual guidance, shortcut and integration guides, AI/agent/billing explanations, support requests with consented diagnostics, bug/feature feedback, changelog, honest roadmap, migration help, service status, and vulnerability-reporting channel.

Exit gate: a customer can understand price and limits before purchase, onboard to first value, administer the workspace, recover from payment failure, cancel, and export data.

## Phase 11 — Completeness and production hardening

Goal: close every remaining requirement and prove the full product behaves safely under realistic conditions.

### 11A. Requirements closure audit

Map every `FEATURES.md` item to implementation, automated evidence, documentation, or an explicit approved scope decision. No item is considered complete solely because a screen exists.

### 11B. Security and privacy verification

Complete threat modeling, tenant-boundary and authorization testing, secret/log/export/AI-context redaction, upload protection, dependency/infrastructure scanning, account/workspace deletion, retention controls, legal/privacy documentation, data-subject handling, incident procedures, and provider disclosures.

### 11C. Reliability and recovery

Load-test critical paths, enforce tenant fairness, verify idempotency/dead letters, test concurrency and degraded modes, exercise monitoring/alerts/traces, test backup restoration/failover/disaster recovery, and measure recovery objectives.

### 11D. Performance and scale

Set and verify budgets for load, interaction, search, saves, large lists, dashboards, uploads, jobs, and syncs. Add pagination, virtualization, caching, progressive loading, and indexes based on measurements.

### 11E. Accessibility and internationalization

Verify keyboard and screen-reader operation, focus, names, contrast, non-color status cues, reduced motion, text resize/reflow, errors, WCAG 2.2 AA expectations, timezone correctness, locale formatting, consistent timestamp storage, and localization-ready layouts.

### 11F. Operational readiness

Finalize dashboards, on-call/incident runbooks, customer communications, data recovery procedures, release/rollback process, capacity assumptions, cost alarms, status page, and production-change controls.

Exit gate: all automated security, reliability, accessibility, performance, backup, billing, and authorization gates pass in a production-like environment.

## Phase 12 — Release-candidate acceptance

Goal: deliver a feature-complete candidate whose remaining work is structured manual testing and user-experience validation.

### 12A. Automated launch-acceptance suite

Turn all 23 launch acceptance requirements into executable end-to-end scenarios with retained evidence. Run them across supported browsers, responsive sizes, roles, brand scopes, and degraded-service conditions.

### 12B. Seeded acceptance environment

Provide realistic multi-brand data, integrations or safe test doubles, users/guests, AI budgets, agent runs, test failures, defects, releases, history, and billing states for repeatable manual review.

### 12C. Manual QA handoff

Produce a traceable test plan, account matrix, supported-environment matrix, known limitations, migration/rollback instructions, monitoring checklist, and defect-severity policy.

### 12D. UX-research handoff

Define role-based journeys and success measures for onboarding, capture, planning, collaboration, AI review, agent review, defect-to-release, billing, export, and cancellation. Do not treat feature presence as usability proof.

Exit gate: no known release blocker remains; every feature requirement is traceable; the product is ready for manual QA and user-experience testing.

## How developer briefs will be issued

After this roadmap is approved, each sub-phase becomes a standalone developer brief in dependency order. Every brief will contain:

1. Objective and user outcome.
2. In-scope requirements with IDs from `FEATURES.md`.
3. Explicit non-goals.
4. Required UX states and responsive/accessibility behavior.
5. Data, API, authorization, audit, notification, and background-job behavior.
6. Architecture constraints and prescribed solutions only where consistency or risk demands them.
7. Edge cases, failure modes, concurrency, retries, and recovery behavior.
8. Acceptance criteria and required automated tests.
9. Observability, security, privacy, performance, and cost expectations.
10. Dependencies, migration/compatibility notes, and completion evidence.

Briefs should normally describe outcomes and constraints while allowing developers to choose local implementation details. They should prescribe the approach when tenant isolation, permissions, idempotency, irreversible data behavior, money, external side effects, cryptography, concurrency, or cross-module contracts are involved.

## Proposed approval decisions

Before engineering begins, the product owner should approve or amend:

- The phase ordering and the decision to build a modular monolith.
- Whether all 661 product requirements remain required before the first paid launch, or whether some represent post-launch releases.
- The first supported deployment region and any data-residency promise.
- The initial identity, payment, email, AI, calendar, GitHub, file-scanning, and hosting providers.
- The published deletion-recovery period, post-cancellation export period, backup objectives, supported browsers, and initial plan boundaries.
- Whether collaborative document editing must be realtime at first launch or can begin with safe optimistic concurrency and version history.
