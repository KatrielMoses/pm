# Corrective Brief — Phase 2D Review 01

Status: **Changes requested; Phase 2D is not accepted.**

This is an authoritative corrective brief under `briefs/AUTHORITATIVE_DELIVERY_PROTOCOL.md`. Continue on the existing `phase-2d-task-interaction-quality` branch and draft PR. Do not wait for intermediate approval. Implement both corrections, update the authoritative sources and generated/validated closure data, commit and push, then run the complete acceptance pipeline again. Hand back only after one clean, current-head, no-skip CI run passes every gate.

The reported run `37463832813` is evidence that the existing implementation is otherwise healthy, but it is not acceptance evidence while these scope gaps remain.

## Correction 1 — template provenance is a first-class task origin

The Phase 2D brief's binding decision keeps task source kinds closed, but it explicitly requires template-created tasks to retain template provenance. Recording those tasks as `manual` is not acceptable.

- Add `template` to the canonical task source-kind registry and contract. The resulting closed set is `manual`, `recurring`, `template`, `intake`, `import`, `integration`, and `ai_draft`.
- Update the database enum/constraint or equivalent authoritative persistence rule, generated contracts, API schemas, service logic, and UI/source display consistently.
- Template instantiation must persist the template's public identifier and version alongside the immutable origin. Existing manual tasks remain manual; do not reinterpret historical data.
- Preserve authorization, tenant isolation, audit/event semantics, and safe public-ID handling. Do not persist secrets or expose inaccessible template details.
- Add regression coverage proving a task created from a template has `source=template` and the correct template/version provenance, while ordinary manual, recurring, import, integration, intake, and AI-draft creation paths retain their existing origins.
- Update ADR-0016, the relevant 0B/0C/0D/0E source records, closure evidence, validators, and generated outputs so the decision and implementation agree.

## Correction 2 — bulk status UI must support custom workflow statuses

Bulk status change is in Phase 2D scope. The UI may not expose only built-in statuses when the API and Phase 2C workflow model support custom statuses.

- The bulk status control must enumerate statuses applicable to the selected tasks, including authorized custom workflow statuses.
- For selections spanning projects or workflows, compute the authorized intersection and clearly explain mixed-workflow or unavailable-status cases. Never silently map a requested custom status to a built-in status.
- The preview must show each task's proposed target, refusals, required fields or approvals, and stale/conflict outcomes before apply.
- If a status is not valid for some selected records, either require an explicit partial operation or return per-item refusals under the existing all-or-nothing/partial semantics. Preserve ETags, permission checks, audit/events, and canonical workflow evaluation.
- Add API, integration, and responsive browser/accessibility tests for custom statuses, mixed workflows, restricted/share-only records, and permission loss between preview and apply.
- Update ADR/closure evidence, validators, and generated outputs to cover the completed behavior.

## Delivery requirements

- Keep all Phase 2D scope boundaries and later-phase deferrals intact; do not add 3B, 3C, 4B, 5C, 7C, or 10B work.
- Run the full required pipeline from a clean checkout. Do not skip, retry around, weaken, or conceal a gate; do not inflate timeouts to mask a failure.
- The handoff must include the current head, draft PR, one passing no-skip CI run, all gate counts/evidence, scanners, production image/non-root evidence, changed files, and any remaining explicitly approved deferrals.

