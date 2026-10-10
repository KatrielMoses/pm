# Phase 2 Integration Review and Exit Gate

Status: **Authoritative implementation and review brief.**

Phase 2A–2E are now the accepted feature slices. This brief authorizes the integration review under `briefs/AUTHORITATIVE_DELIVERY_PROTOCOL.md`. Work on a new branch from the accepted Phase 2E head. The developer owns the integration implementation, test diagnosis, and all in-scope fixes. Hand back only after one clean, current-head, no-skip CI run passes every gate; no intermediate approval is required.

## Objective

Prove that the Phase 2 project/task/workflow/interaction/inbox slices operate as one secure product, without adding Phase 3 or later feature scope. Find and fix integration defects, contract drift, migration incompatibilities, authorization leaks, accessibility regressions, and cross-surface UX breaks.

## Required journeys and evidence

- First-use journey: create a brand and useful project, capture a task/note, see it in the personal Inbox, triage it into authorized work, and use it on desktop, tablet, and mobile.
- Project/task journey: create and edit projects, hierarchy, tasks, subtasks, checklists, dependencies, labels, custom fields, workflows, assignments, relationships, templates, recurrence, reminders, ordering, bulk preview/apply/undo, and source/provenance without conflicting validators or stale writes.
- Inbox journey: capture from every shell route, paste multiple items, parse deterministic values with ambiguity confirmation, attach links, triage, merge, return items, convert notes, and preserve original text/source/audit facts.
- Authorization/isolation matrix across owner, members, guests, share-only users, multiple workspaces/brands, hidden fields, custom workflows, revoked/suspended/removed users, and permission loss between preview and apply. Verify constant-shape behavior for hidden data.
- Concurrency and recovery: ETags/version conflicts, idempotent retries, offline/background-refresh recovery, worker freshness, recurring/reminder jobs, bulk partial/all-or-nothing semantics, and migration rollback/reapply boundaries.
- Contract closure: run Phase 0, Phase 1, and Phase 2 validators; verify every Phase 2 owned/contributed requirement has evidence, correct ownership, and an explicit later-phase deferral where applicable. Do not mark deferred requirements implemented.
- Accessibility and responsive UX: Playwright/axe at desktop, tablet, mobile, 320px, breakpoints, 200% zoom, forced colours, reduced motion, and keyboard-only flows, including capture, triage, task editing, bulk operations, and conflict/recovery states.

## Boundaries

Do not implement Phase 3 views/planning/capacity, 3B board status drag, 3C work blocks, 4B delivery, 4E file storage, 5C rollups, 6A/6B adapters, 7F AI/voice, or 10B template catalog. Integration may add only the minimum compatibility fixes, migrations, contracts, docs, and tests required to make accepted Phase 2 behavior coherent.

## Delivery

- Run the complete acceptance pipeline from a clean checkout, including containerized PostgreSQL, scanners, production image smoke, and non-root evidence.
- Fix ordinary failures yourself. No skipped gates, blind retries, weakened assertions, or timeout inflation.
- Handoff must include current head, draft PR, changed files, journey/isolation results, closure counts, migration-boundary evidence, scanner results, PostgreSQL image digest, production image ID/size, and runtime user check.
- Do not modify `BUILD_ROADMAP.md`, `ROADMAP_CHECKLIST.md`, `briefs/`, local reports, secrets, or build output in product commits.

