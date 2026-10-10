# Product vocabulary and scope contract (Phase 0A)

Status: **accepted** (Phase 0A, P0-W1); accepted at the Phase 0 exit gate (P0-IR1; [exit-gate report](../architecture/PHASE_0_EXIT_GATE.md)). Open product decisions remain open until each is marked decided in [open-decisions.md](open-decisions.md).

This folder is the canonical product-language and requirement-traceability foundation for the application described in [`FEATURES.md`](../../FEATURES.md). It fixes the meaning of records, scopes, states, dates, and deletion, so that Phases 0B (data), 0C (authorization), 0D (platform contracts), and 0E (UX) build on one vocabulary.

## Documents

| Document | Answers |
|---|---|
| [glossary.md](glossary.md) | What each product term means, what it does not mean, its scope, and its look-alikes |
| [hierarchy-and-scope.md](hierarchy-and-scope.md) | What owns what; workspace, brand, project, task, and personal scopes; containment versus association; the all-brands view; cross-brand sharing, links, moves, and exposure prevention |
| [lifecycle-and-states.md](lifecycle-and-states.md) | Lifecycle versus workflow versus review versus execution states; completion versus acceptance; merged versus verified; agent, test, release, AI, and automation states; retry versus rerun |
| [time-and-scheduling.md](time-and-scheduling.md) | Due date, deadline, work blocks, estimates, Today, timezones, recurrence, capacity, with multi-brand and multi-timezone examples |
| [deletion-retention-history.md](deletion-retention-history.md) | Archive, trash, restore, purge, workspace and account deletion, cancellation, exports, immutable evidence |
| [open-decisions.md](open-decisions.md) | 46 decisions that need the product owner, each with a safe default and the cost of deferring |
| [requirements/](requirements/README.md) | Catalog of all 684 FEATURES.md items with stable IDs, owning sub-phase, cross-cutting concerns, and flags, plus the validator |

## Precedence

1. **`FEATURES.md` is authoritative for scope and wording.** The catalog adds identity and mapping only.
2. **`BUILD_ROADMAP.md` is authoritative for phase structure.** Sub-phase codes used here are parsed from it.
3. Within this folder, when two documents seem to disagree, the **more specific** document wins (e.g., the lifecycle doc over a glossary one-liner). The disagreement is a defect to fix, not a choice to make.
4. Anything marked *recommended* or linked to an `OD-` entry is a proposal pending the product owner.

## Invariants every later phase must preserve

These summarize the architecture constraints from the 0A brief as they are applied throughout this folder:

1. **Tenancy.** Every tenant record carries its workspace. Every brand-owned record carries exactly one brand explicitly ([hierarchy §1–2](hierarchy-and-scope.md#1-scope-levels)).
2. **The all-brands view is an aggregation, not an owner** ([hierarchy §4](hierarchy-and-scope.md#4-the-all-brands-view)).
3. **Cross-brand sharing is explicit, revocable, audited, and never exposes parents, children, or links** ([hierarchy §5](hierarchy-and-scope.md#5-cross-brand-rules)).
4. **One authorization path.** Search, exports, AI retrieval, agents, integrations, automations, notifications, and briefings use the same per-record authorization as ordinary reads.
5. **Distinct actor types.** Human, AI (on behalf of a person), automation, integration, agent, and system actions are recorded and displayed as distinct.
6. **Distinct facts.** Completion, acceptance, verification, merge, and deployment are separate facts with separate timestamps ([lifecycle §3–4](lifecycle-and-states.md#3-completion-review-and-acceptance-are-different-facts)).
7. **No false success.** Failed, cancelled, partial, or timed-out executions are never presented as successful ([lifecycle §5](lifecycle-and-states.md#5-execution-states-ai-agents-automations-integrations-tests-imports-webhooks)).
8. **One logical outcome per retry** ([lifecycle §8](lifecycle-and-states.md#8-retries-reruns-and-idempotency)).
9. **AI and integrations are optional.** Every core work-management concept here works without them.
10. **Few reusable concepts.** One lifecycle axis, five status categories, one review vocabulary, and one execution vocabulary are shared across domains.
11. **No invented promises.** Durations, prices, regions, and legal commitments appear only as named parameters linked to open decisions.

## Validating the requirement catalog

From the repository root:

```sh
python3 docs/product/tools/reqcat.py validate
```

See [requirements/README.md](requirements/README.md) for what it checks and how to maintain the catalog when `FEATURES.md` changes.

## Dependencies with parallel work

- **0E (UX foundation)** runs in parallel and should take its terminology from [glossary.md](glossary.md): brand marker, "Restricted item", status categories, execution-state labels, and archive/trash/permanent-delete wording.
- **0B/0C/0D** own physical data design, the permission matrix, and API/event envelopes. Each document here ends with, or links to, the contract it hands over.
