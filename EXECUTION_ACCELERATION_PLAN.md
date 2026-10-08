# Execution Acceleration Plan

This plan becomes active after the accepted Phase 2D handoff. It does not change the current Phase 2D delivery or its acceptance requirements.

## Operating principle

Keep one authoritative brief and one final no-skip CI gate per deliverable, but stop serializing work that has a stable contract boundary. Parallel work is allowed only when each brief has an isolated branch/output and an explicitly named integration owner.

Every developer brief remains full authorization under `briefs/AUTHORITATIVE_DELIVERY_PROTOCOL.md`: the assigned developer implements, commits, runs CI, fixes in-scope failures, and hands back only a clean current-head acceptance report.

## Model routing

Use the fastest model that can safely own the work, not one model for every brief.

| Work | Default model/effort | Escalate when |
|---|---|---|
| Clear, bounded UI, tests, docs, generated-output reconciliation, small corrective fixes | GPT-6 Luna, low/medium | Cross-package behavior or repeated CI failure |
| Normal phase implementation with multiple packages, migrations, API and UI | GPT-6 Luna, medium or GPT-6 Sol, low/medium | Authorization, data migration, concurrency, or unclear contracts |
| Security/RLS, lifecycle, migration design, closure validators, integration reconciliation, release-gate diagnosis | GPT-6 Sol, medium/high | Irreconcilable contract or high-risk data/security change |
| Final architecture decisions, phase integration reviews, threat/privacy/recovery decisions | GPT-6 Astra or strongest available architect model | Never delegate unresolved authority decisions to a speed model |

OpenAI’s official model guidance positions Luna for focused, high-volume work and recommends Luna medium for creating from clear briefs; it positions Sol as the balanced choice for everyday coding and Astra for the hardest reasoning. See [model selection](https://developers.openai.com/api/docs/guides/model-selection) and [GPT-6 model guidance](https://developers.openai.com/api/docs/guides/latest-model).

Do not assume Sonnet or DeepSeek availability in this Codex environment. If another provider is connected later, benchmark it on a fixed representative task before routing production briefs to it.

## Parallel delivery waves

### Immediately after Phase 2D

Keep Phase 2E sequential. It depends on the complete task interaction surface and affects the Phase 2 exit journey. Run the Phase 2 integration review after 2E.

### Phase 3

After the Phase 2 exit gate:

1. Run 3A (query/saved-view engine) and 3D (time tracking/timesheets) in parallel on separate branches.
2. Integrate both, then run 3B (core views) and 3C (Today/manual planning) in parallel if the query and time contracts are frozen.
3. Run 3E (capacity/conflicts) after 3C and 3D are accepted.
4. Run the Phase 3 integration review.

### Phase 4

Likely parallel wave: 4A (comments/reviews) and 4B (notifications). Then 4C (documents) and 4E (files/deliverables) may run in parallel once the collaboration and notification contracts are frozen. 4D follows 4C because it depends on document editing conflict semantics.

### Later waves

Use the same dependency rule: parallelize only independent ownership areas, then run a dedicated integration review before opening the next wave. Candidate examples are 5A search with 5B goals after their source contracts are frozen, and 6A integrations with 6D portability when their shared provenance contracts are settled.

## Integration controls

- One migration-number owner per wave; parallel branches reserve disjoint migration ranges before coding.
- One contract/registry owner per wave; changes to shared 0B/0C/0D sources are merged through the integration owner.
- Each parallel brief must state its base commit, output files, migration range, public contracts, and integration tests.
- No branch may silently modify another active brief’s tables, routes, or generated source. Shared changes become an explicit integration subtask.
- CI runs independently on each branch, then again on the integrated head. Only the integrated no-skip run is the wave acceptance evidence.
- Merge bottom-up without squashing, then retarget later PRs and rerun CI on each new base.

## Throughput target

After Phase 2D, target one implementation wave per working day where scope permits:

- same-day brief execution and local verification;
- parallel branches for independent briefs;
- CI running while the next independent branch progresses;
- one integration owner resolving shared migrations/contracts;
- no waiting for architect approval between implementation, fixes, and CI.

The quality bar does not change: speed comes from concurrency and model routing, not reduced tests, weaker isolation, skipped scanners, or premature handoffs.
