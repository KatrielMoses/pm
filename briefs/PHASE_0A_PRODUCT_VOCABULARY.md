# Developer Brief — Phase 0A: Product Vocabulary and Scope Contract

## Objective

Create the canonical product-language and requirement-traceability foundation for the SaaS application described in `FEATURES.md`. This is a documentation and architecture-contract brief, not an application implementation brief.

The result must remove ambiguity for later developers about record hierarchy, ownership, lifecycle, completion, acceptance, scheduling, deletion, and cross-brand behavior.

## Read first

- `FEATURES.md`
- `BUILD_ROADMAP.md`
- `ROADMAP_CHECKLIST.md`

Do not edit `BUILD_ROADMAP.md` or mark `ROADMAP_CHECKLIST.md` complete. The solutions architect will update tracking after review.

## Required deliverables

Create a coherent documentation set under `docs/product/`. You may choose sensible filenames, but the set must cover all of the following.

### 1. Canonical glossary

Define every important product term, including at minimum:

- account, user, member, guest, team, workspace, brand, and all-brands view;
- project, parent/child project, phase, milestone, task, subtask, checklist item, Inbox item, note, and Today commitment;
- document, file, attachment, deliverable, deliverable version, evidence, comment, activity entry, and notification;
- goal, key result, portfolio, estimate, scheduled work block, due date, deadline, completion date, working time, capacity, time entry, and timesheet;
- status, workflow, transition, custom field, template, saved view, approval, review, acceptance, rejection, and definition of done;
- integration, connection, synchronization, webhook, API token, automation, AI action, agent, agent run, tool call, and artifact;
- test case, test suite, test run/result, defect, environment, release, release blocker, verification, and go/no-go decision;
- archive, soft delete, restore, retention, purge, export, audit event, source/provenance, stale, and freshness.

For each term, state what it means, what it does not mean, its likely parent/scope, and closely related terms that must not be confused with it.

### 2. Record hierarchy and scope contract

Define the canonical containment and scope rules for workspace, brand, project, task, documents, files, goals, integrations, agents, views, notifications, and other major records.

Explicitly resolve:

- which records are workspace-scoped, brand-scoped, project-scoped, task-scoped, or personal;
- which records must belong to exactly one brand;
- which records may exist without a project;
- how a record can be shared across brands without silently changing ownership or leaking related data;
- what the all-brands view means—it is an authorized aggregation, not a separate ownership scope;
- whether relationships can cross brands, and the validation and display rules when they can;
- how brand identity remains visible in aggregated views and notifications;
- containment versus association, and what happens to children when parents are archived, restored, or deleted.

Use diagrams or tables where they clarify the contract. Do not design database tables in this brief; Phase 0B owns the physical/logical data architecture.

### 3. Lifecycle and state semantics

Document lifecycle semantics and state distinctions for major records. Include transition tables where helpful.

At minimum, resolve:

- active, paused, completed, archived, soft-deleted, restored, and purged;
- task completion versus submitted for review versus approved/accepted;
- claimed work completion versus accepted deliverable;
- project completion versus completion percentage;
- code merged versus defect verified;
- agent run finished versus deliverable ready for review versus accepted;
- failed, cancelled, partial, blocked, skipped, flaky, and not-run states where applicable;
- draft, current, stale, approved source, and archived document states;
- idempotent retry behavior at the product-semantics level: a retry must not create a second logical outcome.

Prescribe that failed, cancelled, or partial AI, agent, automation, integration, or test execution must never be presented as successful.

### 4. Time and scheduling semantics

Define the differences and interaction rules among:

- start date, due date, deadline, scheduled start/end, duration, estimate, remaining estimate, and completion date;
- moving a work block versus changing a deadline;
- committing an item to Today versus changing its dates;
- user timezone, workspace timezone, brand timezone/working calendar, and stored timestamps;
- recurrence definitions and generated occurrences;
- working hours, unavailable time, time off, brand capacity reservations, and shared founder capacity.

Include clear examples involving multiple brands and different timezones.

### 5. Deletion, recovery, retention, and historical truth

Define product-level behavior—not final commercial durations—for archive, trash/soft deletion, recovery, irreversible purge, legal/retention holds if applicable, account/workspace deletion, post-cancellation read-only access, and exports.

Specify which historical records must remain immutable or retained as evidence, including approvals, release decisions, billing records, audit history, and accepted deliverables, subject to later legal/privacy decisions.

Flag every duration that still requires a product-owner decision instead of inventing a promise.

### 6. Requirement catalog and traceability

Create a machine-readable and human-readable catalog for every checklist item in `FEATURES.md` without changing the wording or losing its source location.

Requirements:

- assign a stable, readable unique ID to all 684 checklist items;
- distinguish 661 product requirements from the 23 launch acceptance requirements;
- include source section, exact requirement text, requirement type, and initial owning roadmap sub-phase;
- identify cross-cutting concerns such as authorization, audit, notification, accessibility, reliability, privacy, usage metering, export, and degraded-mode behavior;
- flag genuine ambiguity, conflict, duplication, or missing product decision; do not silently reinterpret the source;
- include a summary showing total counts and counts by source section and roadmap sub-phase;
- provide a lightweight validation mechanism or repeatable command that detects duplicate IDs, missing source requirements, extra catalog entries, and count mismatches.

The source feature text remains authoritative. The catalog adds identity and mapping; it does not rewrite scope.

### 7. Open-decisions register

List unresolved product decisions with:

- decision required;
- why it matters;
- affected requirements and future phases;
- safe default recommendation;
- consequence of deferring the decision.

Do not make commercial, legal, compliance, retention-duration, provider, or regional promises without explicit product-owner approval.

## Architecture constraints

- Preserve strict workspace tenancy and explicit brand context in all definitions.
- Cross-brand sharing must be explicit, revocable, auditable, and incapable of exposing unrelated parent/child records.
- Search, exports, AI retrieval, agents, integrations, and automations must use the same authorization concepts as ordinary application access.
- Human action, AI action, automation action, integration action, and agent action are distinct actor/source types.
- Completion, acceptance, verification, and deployment are distinct facts.
- Core work-management concepts must remain usable without AI or integrations.
- Prefer a small set of reusable concepts; do not invent a different lifecycle vocabulary for each screen without a real domain reason.

## Non-goals

- Do not implement application code, database schemas, APIs, UI components, or infrastructure.
- Do not select vendors or lock the application to a particular framework.
- Do not reduce or remove requirements.
- Do not treat a proposed roadmap phase as proof that a requirement has been completed.
- Do not edit the approved roadmap or execution checklist.

## Acceptance criteria

- Every feature checklist item has exactly one stable requirement ID and at least one owning roadmap sub-phase.
- Automated validation reports exactly 684 source requirements: 661 product requirements and 23 launch acceptance requirements.
- The glossary, hierarchy, lifecycle, time, and deletion contracts do not contradict one another.
- Ambiguities and decisions are exposed rather than guessed.
- Cross-brand examples cover aggregation, explicit sharing, permissions, and accidental-exposure prevention.
- A later developer could use the documentation to design the data model without inventing basic product semantics.
- Documentation is readable, internally linked where useful, and free of placeholder sections presented as complete.

## Required completion response

Return:

1. A concise summary of decisions made.
2. Every file created or changed.
3. The requirement-validation command and its output.
4. Counts by requirement type and any unmapped items.
5. Open questions requiring product-owner approval.
6. Known limitations or work intentionally deferred to 0B–0D.

Do not merely state that the work is complete; provide reviewable evidence.
