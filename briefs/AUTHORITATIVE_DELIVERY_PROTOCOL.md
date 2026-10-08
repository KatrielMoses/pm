# Authoritative Delivery Protocol

This protocol applies to Phase 2B and every later developer brief unless that brief explicitly imposes a stricter rule.

## The brief is the approval

An issued brief authorizes the developer to complete the entire scoped delivery without returning for intermediate approval. This includes:

- reconciling the authoritative product, data, authorization, platform, UX, engineering, and generated sources required by the brief;
- implementing application, database, API, worker, web, test, documentation, validator, migration, observability, security, accessibility, and operational changes within scope;
- creating the branch named or implied by the brief from its stated accepted base;
- creating logical commits and pushing them;
- opening and updating a draft pull request against the stated stacked base;
- running local verification and the full CI acceptance pipeline;
- diagnosing and fixing every in-scope local or CI failure;
- pushing corrective commits and rerunning the entire acceptance pipeline until one clean current-head run passes every gate.

Do not ask whether to create the branch, commit, push, open the draft PR, fix an in-scope failure, or rerun CI. Those actions are already authorized by the brief.

## Auto-fix execution mode

Auto-fix is enabled by default for every phase. When CI fails on the current draft PR, the developer automation must wake the developer, diagnose the root cause, make an in-scope corrective commit, push it, and rerun the full pipeline without waiting for a user message. The developer must continue autonomously and must not send progress questions or intermediate approval requests. The only normal stop is the final completion handoff after a clean current-head no-skip run. Auto-fix must follow every rule below: no blind retries, skipped gates, weakened assertions, timeout inflation, automatic merging, or handoff before a clean current-head no-skip run. A genuine safety, authority, credential, or impossible-gate blocker remains the only exceptional stop condition and must be reported clearly.

## Definition of done before handoff

Do not hand work back while implementation is partial or while CI is pending, failed, cancelled, stale, or superseded. Handoff occurs only when all of the following are true:

1. every owned requirement and binding decision in the brief is implemented;
2. every contribution/foundation is implemented only to the boundary stated in the brief;
3. authoritative sources and generated outputs are reconciled and validators pass;
4. migrations, rollback/boundary checks, RLS/grants, concurrency and isolation tests pass;
5. unit, component, integration, process-smoke, browser and accessibility tests pass;
6. pinned dependency, vulnerability, secret and licence gates pass;
7. the production image builds, migrates, starts, serves the web application, reports truthful readiness and runs non-root;
8. one full no-skip CI run on the latest pushed head ends with the repository's success marker;
9. the draft PR remains unmerged and the roadmap checklist/brief files remain excluded from product commits;
10. the final completion report contains the exact head, run, test totals, PostgreSQL digest, scanner results, image ID/size/user/readiness and all limitations.

Only the latest current-head run is acceptance evidence. Earlier failed or superseded runs must be summarized as development history, not presented as acceptance.

## Authority to correct failures

The developer owns all fixes necessary to satisfy the brief and acceptance gates. This includes failures that appear only in CI and pre-existing defects exposed by the new test path when they prevent the scoped delivery from passing.

Permitted corrective work includes:

- fixing application behavior, authorization, migrations, contracts, documentation, generated output, tests, accessibility, build/image behavior, scanners and deterministic CI synchronization;
- adding narrowly relevant regression tests and diagnostics;
- splitting corrective work into additional clearly named commits;
- rerunning the full pipeline as many times as necessary after genuine fixes.

The developer must find root causes. Do not:

- increase global timeouts merely to hide a race;
- add blind retries or rerun until a flaky test happens to pass;
- skip, quarantine, weaken or delete a required test or gate;
- change expected behavior solely to match broken output;
- mark a requirement implemented through prose without executable evidence;
- broaden permissions, add bypasses, fabricate later-phase data, or create parallel authority;
- enable automatic merging or merge the draft PR.

## Decision hierarchy

Follow, in order:

1. the current developer brief's explicit binding decisions;
2. architect decisions recorded in `ROADMAP_CHECKLIST.md`;
3. accepted authoritative Phase 0 and later ADR/source contracts;
4. established repository patterns and the simplest safe implementation choice.

When details are not explicitly prescribed, choose the safest implementation that preserves tenant isolation, least privilege, data integrity, accessibility, deterministic behavior, low operating cost, and future extensibility. Record material implementation choices in the phase ADR; do not turn ordinary engineering choices into approval questions.

## The only early-stop conditions

Stop and report before completion only when continuing would require one of the following:

- choosing between genuinely contradictory binding requirements that cannot both be reconciled under the decision hierarchy;
- destructive or irreversible action outside the brief's scope;
- credentials, paid resources, external legal/product authority, or infrastructure that the developer cannot obtain or safely substitute;
- weakening an acceptance gate because it is objectively impossible to execute;
- a security or data-loss risk whose safe correction materially expands the product scope beyond the brief.

A failed test, flaky behavior with an investigable cause, migration bug, scanner finding, image failure, missing registration, documentation drift, or CI-only race is not an early-stop condition. Diagnose, fix, test, and continue.

## Final handoff format

Return one final eight-section completion report only after the clean acceptance run:

1. outcome, exact branch/head/base/PR and runtime versions;
2. requirements, decisions, authoritative-source and generated-output closure;
3. files, migrations, schemas, constraints, indexes and contracts;
4. domain behavior, authorization, isolation, lifecycle and concurrency evidence;
5. API/UI/responsive/accessibility behavior and honest deferrals;
6. test inventory plus failed-run root causes and corrective commits;
7. final no-skip CI run, PostgreSQL digest, scanners, production image ID/size/non-root/readiness;
8. limitations, residual risks, operational notes and recommended stacked merge order.

Do not ask for acceptance, permission to run CI, or permission to fix failures. The architect will review the final evidence and decide roadmap acceptance.
