# ADR-0038: AI gateway, privacy, and budgets (Phase 7A)

Status: **accepted** (engineering scope only: the architect accepted the 7A subphase within its recorded boundaries at head `2f2b61e`, CI run 39026967712 attempt 1, draft PR #36; corrective reviews below are resolved history). Production use is not approved, and the Phase 7 exit gate is pending its integration review ([ADR-0044](0044-phase-7-integration.md)).

Phase 7A adds one AI gateway inside the modular monolith. Every later AI feature calls it: 7B retrieval and citations, 7C drafting, 7D proposals, 7E briefings, 7F voice and planning, and Phase 8 agents. None of them gets its own provider, spending, or history authority. 7A delivers the gateway, an authorized test-run, history, and settings path, and the privacy and spending controls. It is not a general assistant. Production AI stays disabled: deployed environments refuse every real provider until a secret store (DQ-28) and provider data-use approval (OD-41) exist.

Records: 0B ADR-44 and ADR-45, 0C AZ-44 and AZ-45, 0D PL-46 and PL-47. Migrations `0053_ai_gateway` and `0054_ai_gateway_corrections`. Threats T-91 to T-98, tests AT-354 to AT-389.

## Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Provider and model boundary | One typed provider interface (`packages/work/src/ai/provider.ts`). Each adapter speaks one protocol and never sees tenants, records, or the database. The versioned registry (`registry.ts`, version `2026-10-17.2` since corrective review 01) names each model, its explicit model id, capabilities (streaming, output ceiling, no provider idempotency, best-effort cancellation, final-event usage, whether error responses are chargeable, no additional chargeable usage), price table, privacy guarantees, and input bound. Each price and input bound carries its own verification state: verified (official source and date), unverified (with the reason), or synthetic. There is no implicit "latest", and no capability is assumed across providers. The one real adapter is the Anthropic Messages API (`POST /v1/messages`, version `2023-06-01`, server-sent events), written as a plain HTTPS client. Earlier phase validators forbid AI SDK dependencies, and the same adapter must point at the deterministic protocol fixture (`packages/test-support/src/ai-provider-fixture.ts`). Choosing this adapter is an engineering choice, not approval of its commercial terms. Server-side model fallbacks are never requested, so a model is never substituted silently. |
| D2 | Production disabled, explicit approval | `AI_PROVIDER` defaults to `none`, and readiness reports `ai_provider: not_configured`, a healthy core-product state. Deployed environments refuse `fixture`, refuse `anthropic` until DQ-28 and OD-41 are decided, and refuse `secretref:` keys. A real model receives workspace data only when its key is in `AI_APPROVED_MODELS` (empty by default); otherwise dispatch is refused with `ai_not_approved`. The synthetic fixture model is labelled synthetic everywhere it appears and charges synthetic prices. No paid account, production credential, real customer prompt, or billed smoke test was used. |
| D3 | Dispatch prerequisites | Before every estimate and every dispatch, and again after queueing and on retry, the gateway checks: the initiator's current membership and principal; a live delegating token or consent with `ai:execute`, narrowing brands; `ai.execute` in the explicit scope; the entitlement port; the workspace policy; the authorized model and funding; and that every context source is readable now. The context boundary accepts at most five explicit task or project references and nothing else: no SQL, crawl, retrieval, or tools. A hidden or unknown source refuses the whole request identically. Readable sources outside policy are recorded as excluded (restricted brand, field not AI-eligible, data class above the workspace limit, outside the chosen brand). Context is sent as JSON data under a system instruction that the user text is untrusted data. Credential shapes in the prompt, brand instructions, and context are redacted before storage and dispatch (SEC-014). |
| D4 | Workspace keys and entitlements | Workspace-provided keys are designed and tested: stored through the existing `SecretVault` by reference, metered with funding `workspace_key`, counted against hard limits but not against the product allowance, never billed. They stay off while OD-46 is open (`AI_BYOK_ENABLED` is refused when deployed). Commercial entitlements are 10A; the AI entitlement port denies by default in deployed environments. |
| D5 | Exact money and hard reservations | Amounts are integer picodollars in memory and `numeric(20, 6)` micro-dollars in PostgreSQL; tokens use the same scale. Each potentially chargeable attempt reserves an upper bound before it is sent: one token per UTF-8 byte plus request framing for input, and the full output maximum, which is also sent as `max_tokens`. The input figure is an estimate, not an evidenced bound. A real model's bound is therefore unverified, and real monetary dispatch is refused (`ai_bound_unverified`) until an evidenced bound exists, whatever the OD-41 approval says. The synthetic fixture's bound is exact by construction. The reservation covers `ai.cost`, `ai.input_tokens`, and `ai.output_tokens` in the same transaction that records the dispatch, all or nothing. Balance rows are locked in a fixed order, and held or unknown reservations carried from closed periods count against the current one. A request whose bound exceeds the price tier is refused (`ai_cost_unbounded`), never priced at a lower tier. Defaults are finite (USD 1.00); unconfigured is never unlimited. Lowering a limit blocks new spend and never erases usage. |
| D6 | Settlement and unknown outcomes | A reservation settles exactly once: `held` or `unknown` moves to `settled` (measured, reported, or charged at the bound), and a repeat finds nothing open. Known usage settles exactly and writes attempt-level usage events. Each attempt settles and reconciles against its own price and capability snapshot, never the current registry. An HTTP error settles at zero only for a model whose registry entry proves its errors uncharged (the synthetic fixture). The real adapter's error charging is `unknown`: an error keeps its reservation, is never retried automatically, and is reconciled. Usage is validated (finite, non-negative safe integers). Usage beyond the attempt's bound is settled in full, recorded as a breach, and pauses AI for the workspace until an owner or administrator resumes it. A timeout after sending, a reset, an interrupted stream, or a cancellation is `unknown`: the full reservation stays counted, the run says so, and an owner or administrator reconciles it once, with step-up. A closed period's late usage settles as a correction in the current period. Retry is refused while a cost awaits reconciliation. |
| D7 | Durable operations and safe retry | A run is an `ai_action` operation with its typed detail, a job on the existing execution engine, attempts, and an idempotency key. Nothing lives only in web-process memory. Job checkpoints hold references only. The request content is re-read and re-authorized from the AI content tables at send time, never carried in a checkpoint, job argument, result, or effect ledger. Each dispatch is committed as `dispatching` before the request leaves. If a later attempt finds it still `dispatching`, the worker was lost mid-call: it is marked `unknown` and never resent. The platform effect ledger would treat that `pending` effect as retryable, so the AI ledger does not rely on it. Only failures the provider cannot have charged are retried automatically, with full-jitter backoff where a longer Retry-After wins, within `AI_MAX_ATTEMPTS`. A completed Idempotency-Key re-renders through current authority and never dispatches again. A person's retry is a new operation, re-authorized and re-estimated. |
| D8 | Honest cancellation | Cancel stops a queued run at once. For a running run, the worker polls the request and closes the stream; publication stops, and the attempt is kept as `unknown` with its full reservation. The interface says plainly that a request already sent cannot be recalled and may still be charged. A cancelled run is never shown as failed or successful. |
| D9 | History, exports, and administration | Content (redacted prompt, output, context references) belongs to the initiator alone. Every read, completed-key replay, and export re-checks every source and the run's brand; if any is no longer readable, the whole content is withheld. Usage metadata stays visible. `usage.view` shows usage and per-run metadata to owners and administrators (and brand managers on the dashboard figure), never another person's content. DATA-013 (owner 6D) gains the 7A portion: `ai_history` exports through the 6D boundary (`moduleHistoryRows`), with the same gates and rules. Agent and automation histories remain 8A and 8B. |
| D10 | Retention, erasure, and departure | AI content is personal-scope data. Departure erases the leaver's content through the ownership hook registry and stops their queued work (OD-39 safe default for personal-scope data). Usage, cost, operation, and audit facts remain. Erasure includes execution checkpoints (`ai.scrub_dispatch_checkpoints`), so no copy survives. Account erasure reaches AI content through the personal-data registry (`productPersonalDataRegistry`). The content retention sweep is a technical setting, off by default because OD-36 is undecided; no legal duration is invented. Holds are not offered (OD-37). Output is immutable except for erasure. |
| D11 | Observability, readiness, and the metric port | Bounded counters cover runs, dispatches, refusals, reservations, cancellations, tokens, cost, and erasure, plus the existing `ai.request.duration`. None carries a prompt, output, secret, raw id, or high-cardinality label. Spend thresholds (basis points of the hard limit) notify the owners and administrators who can change limits, once per threshold per period; a changed limit is announced afresh. AI cost and tokens reach dashboards and reports through the 5D metric port (`ai.usage`). |
| D12 | Interface and manual fallback | AI settings and an AI test-run page are linked from workspace settings; AI is never a navigation dependency or a completion gate. Settings show provider, model, privacy, and approval status, the data class allowed, the confirm-above amount, allowance and hard limit, workspace key status, brand AI profiles, and usage with reconciliation. A run is estimated first and above the threshold must be confirmed. Running, cancelling, partial, failed, and unknown-cost states are labelled, and synthetic output is labelled synthetic. When AI is off or unconfigured, the page says so and every manual workflow continues. |

## Production, legal, and commercial boundaries

- **OD-41 (legal):** open. The product promises nothing beyond what a reviewed provider contract guarantees. The registry records the Anthropic configuration as `contract_review_required` with standard provider retention and `zero_retention: false`. Training exclusion is a hard default (`require_training_exclusion` cannot be turned off).
- **OD-46 (commercial):** open. Workspace keys are off when deployed.
- **DQ-28 (secret store):** open. The development vault is not a production secret store. Production provider keys and workspace keys fail closed.
- **OD-36, OD-37, OD-39:** open. Content is kept until departure or workspace deletion; holds are not offered; departed members' AI content is erased.
- **10A:** commercial entitlements and customer billing. 7A usage events are never billable.
- No billed call, paid account, or production credential was used. Real-provider validation is a separate, unapproved step.

## Identifier reconciliation

| Kind | Allocated | Next free before 7A |
|---|---|---|
| Migration | `0053_ai_gateway` | 0053 |
| Engineering ADR | 0038 | 0038 |
| 0B decision | ADR-44 | ADR-44 |
| 0C decision | AZ-44 | AZ-44 |
| 0D decision | PL-46 | PL-46 |
| Threats | T-91 to T-95 | T-91 |
| Access tests | AT-354 to AT-381 | AT-354 |
| Actions | none (122) | — |
| Events | none (reuses `execution.operation.state_changed`, `metering.usage.*`) | — |

Tests: AT-354 to AT-371 and AT-380 in `packages/work/test/integration/ai-gateway.test.ts`; AT-372 to AT-377 in `packages/work/test/integration/ai-budget.test.ts`; AT-378 and AT-379 in `apps/api/test/integration/ai-api.test.ts`; AT-381 in `e2e/ai.spec.ts`. The provider contract, money, registry, redaction, policy, and period rules are covered in `packages/work/test/unit/ai-gateway.test.ts`; configuration in `packages/config/test/unit/config.test.ts`; the pages in `apps/web/test/ai.test.tsx`.

## Corrections made on the way

- **Personal step-up actions inside a workspace.** Identity refused a step-up challenge for `api_tokens.personal` as an unknown action, so a personal API token with write scopes, including `ai:execute`, could not be created over HTTP. Such actions now use the workspace membership binding, as their consumption already did.
- **Phase 5D evidence.** The `ai.usage` slot the 5D metric port reserved for 7A is answered by the 7A provider in the same catalog. The 5D evidence for GOAL-011 and RPT-012 now points at that registration; their dispositions and deferrals are unchanged.

## Consequences

- Later AI phases add operation purposes and context types to the gateway. They do not add providers, spending, or history.
- The gateway has no tool use, retrieval, vector store, queue, or orchestration service. AI never mutates records.
- Residual risks:
  - Real monetary dispatch stays refused until an evidenced input bound exists.
  - Unknown outcomes, including provider errors that may have been charged, need a person to reconcile.
  - The provider's data-use terms remain open under OD-41.

## Corrective review 01

Review 01 found three defects in the candidate. Migration `0054_ai_gateway_corrections` (expand; 0053 and earlier files are unchanged) and the changes below fix them. 7A remains unaccepted until its acceptance run passes.

### 1. User content in generic execution checkpoints

The preparation step returned the rendered prompt and source content, and `WorkerRuntime.step` stored them in `exec.job.checkpoint`. Departure and retention then reported content erased while that copy remained.

- The step now returns references only: the outcome and the dispatch id. A separate tenant transaction re-reads and re-authorizes the content from the AI tables immediately before the request is sent.
- An erased or no longer authorized run is settled at zero and refused with nothing sent (`failure_detail` `content_unavailable` or `configuration_changed`). A stale row parks for reconciliation, so a stale worker never publishes erased content.
- Fencing, exactly-once settlement, cancellation, and unknown-outcome handling are unchanged.
- `ai.scrub_dispatch_checkpoints` removes old-format copies whenever content is erased, including for runs the old eraser had already marked erased. 0054 also removed every copy in every workspace.
- Evidence: AT-382 (completed, queued, running, and recovered runs: no marker in any generic execution, usage, audit, or delivery table), AT-383 (departure through member removal, account erasure, retention, and a restart afterwards: no copy anywhere outside the source records), AT-384 (a seeded old-format checkpoint). The 0054 migration-boundary tests cover the upgrade cleanup, workspace scoping, grants, and rollback. A mutation check (disabling the scrub) fails AT-384.

### 2. Hard-spend claims independent of optimistic assumptions

Registry evidence for `anthropic/claude-haiku-5-5@2026-10-06` (model id `claude-haiku-5-5`), checked on 2026-10-17:

| Fact | State | Source |
|---|---|---|
| Price `anthropic-first-party-2026-10-17`: base tier for prompts up to 100,000 tokens, USD 0.10 input and USD 0.50 output per million tokens; longer prompts are refused, never priced at a lower tier. Restrictions: global routing only (no `inference_geo`), no prompt caching, no batch processing, tools, fast mode, images, or documents | verified | https://platform.claude.com/docs/en/about-claude/pricing |
| Input upper bound (one token per UTF-8 byte plus framing) | **unverified**: the token-counting endpoint documents an estimate, not a strict upper bound | https://platform.claude.com/docs/en/build-with-claude/token-counting |
| Error responses chargeable | **unknown**: an error name is not evidence of non-billing | https://platform.claude.com/docs/en/api/errors |

- Separate gates, none implying another: price verification, an evidenced input bound, privacy approval (OD-41), and a secret store (DQ-28). The settings view lists each gate per model. Real monetary dispatch is refused with `ai_bound_unverified` even when the model is approved and a key is configured.
- Each dispatch stores its own price and capability snapshot. Settlement and reconciliation use them, so a later price, a removed model, or a configuration deployment cannot reprice or strand an old attempt. A price changed after confirmation refuses the run with nothing sent, and the run says why (`refusal.code` `configuration_changed`). A retry is a new run that needs its own confirmation.
- Usage must be finite, non-negative safe integers before it is priced. Invalid usage leaves the outcome unknown and reserved.
- Usage beyond the reserved bound:
  - is settled in full (never clamped);
  - records `bound_breach`;
  - suspends dispatch for the workspace (`ai_suspended`) until an owner or administrator resumes it with step-up (`resume_after_review`).
  The same applies to reconciliation.
- Evidence: AT-363 (unverified bound refused even when approved), AT-385 (529 and 504 with unknown charging: reservation held, one request, retry refused until reconciled; the synthetic model proves its own errors uncharged), AT-386 (price change after confirmation, new confirmation, historical reconciliation after the model's removal at its own snapshot price, duplicate refused), AT-387 (over-bound usage and over-bound reconciliation). Each asserts ledger conservation and no unreserved dispatch.

### 3. Bounded, validated provider stream

The parser previously had two reproduced defects. A six-character delta clipped to two characters with `end_turn` was reported as complete. Negative usage was accepted.

- Local clipping now sets `clipped` and outcome `truncated`, whatever the provider's stop reason. The known full usage is kept for settlement.
- Event order, message shape, usage, the final usage figure, and stop reasons are validated. Anything invalid or contradictory is a protocol failure. Valid known usage is kept separately from the unknown remainder.
- `AI_STREAM_EVENT_MAX_BYTES` bounds each event, including one still waiting for its separator. `AI_STREAM_MAX_BYTES` bounds the whole stream, and `AI_OUTPUT_MAX_CHARS` bounds retained text. Overflow aborts the stream. The reader is cancelled on overflow, protocol failure, cancellation, and timeout, and released after success.
- Evidence: `packages/work/test/unit/ai-provider-stream.test.ts` (both reproduced cases; oversized and unterminated events; wire overflow; byte-by-byte multi-chunk CRLF framing; negative, fractional, unsafe, and string usage; an unsupported stop reason; missing final usage; out-of-order events; cancellation and timeout, each asserting the reader closed), AT-388 (gateway: clipped answer partial and truncated with full measured usage), and AT-389 (gateway: invalid provider data is never success, never free, and never retried).

### Scope boundaries

- **Effect-ledger reliability follow-up (tracked: `REL-FU-7A-01`).** The generic effect ledger treats a `pending` effect as retryable after a crash. That is unsafe for any effect that cannot be repeated. 7A does not use it for provider calls; its own dispatch ledger marks a lost call unknown and never resends it. 7A has not repaired the shared ledger. Before another module depends on crash recovery for an unrepeatable effect, the ledger needs an "outcome unknown, never retried" state. Owner: platform (the execution engine). Recorded in `closure-7a.json` `follow_ups`.
- **PRJ-007 (project AI budget).** 7A budgets are per workspace and per test run, and 7A test runs carry no project scope. 7A does not enforce project budgets, and no project-budget enforcement port exists. The future contract a project-scoped AI caller must meet:
  - resolve the project and its AI budget at estimate time, and again at every dispatch;
  - reserve against the project budget in the same transaction as the workspace reservation, all or nothing, with the same per-attempt snapshot and settlement rules;
  - refuse with nothing sent when either limit would be exceeded;
  - keep project budget changes from erasing recorded usage.
  Until a phase builds that, project AI budgets are not enforced.
- **Unchanged and still open:** OD-41, OD-46, and DQ-28. Production AI stays disabled, and no legal, provider, or commercial approval, customer-data call, or paid account was used.

### Identifiers added

| Kind | Allocated |
|---|---|
| Migration | `0054_ai_gateway_corrections` |
| 0B decision | ADR-45 |
| 0C decision | AZ-45 |
| 0D decision | PL-47 |
| Threats | T-96 to T-98 |
| Access tests | AT-382 to AT-389 (`packages/work/test/integration/ai-corrections.test.ts`) |
| Parameters | `AI_OUTPUT_MAX_CHARS`, `AI_STREAM_EVENT_MAX_BYTES`, `AI_STREAM_MAX_BYTES` |
