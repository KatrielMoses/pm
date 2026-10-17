# ADR-0039: Authorized retrieval and citations (Phase 7B)

Status: **proposed** (implementation candidate; acceptance evidence pending).

Phase 7B adds authorized retrieval and validated citations to the one 7A AI gateway. A person chooses an explicit scope, reviews a bounded context manifest, and asks a read-only question. The answer separates facts from the records, deterministic calculations, sourced statements, suggestions, and unknowns, and every citation opens the record through the person's current access. 7B does not add drafting (7C), change proposals (7D), briefings (7E), voice or planning (7F), or agents (Phase 8). Production AI stays disabled exactly as accepted in 7A: real monetary dispatch is refused for an unverified input bound, and DQ-28, OD-41, and OD-46 remain open.

Records: 0B ADR-46, 0C AZ-46, 0D PL-48. Migration `0055_ai_retrieval_citations`. Threats T-99 to T-102, tests AT-019, AT-020, and AT-390 to AT-406.

## Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Effective scope | The scope of an AI context is the intersection of the initiator's current membership and token authority, record and field permissions, the AI data policy (C0–C2, restricted brands excluded, a brand's approved-source policy), and the person's explicit choices (up to five brands, an optional project and task, search words, up to twenty includes and excludes). An include is never a grant. A contradictory scope refuses (`scope_conflict`) and never falls back to all brands or the workspace. `ai.execute` is required over every chosen brand, or the workspace. A guest's share is visibility, never AI-execute authority, and read-only and limited members keep their 7A outcome. The preview shows the workspace, brands, project, task, and effective exclusions before any AI action (AI-006). |
| D2 | Candidates are pointers | 5A search proposes candidates through an in-transaction `searchIn` that applies the same parsing, rate limit, visibility, live checks, ranking, and index status as the search API; no second search authority exists. The scope's brands and project are passed as 5A filters (the 3A brand primitives resolve them). Every candidate is then resolved through its module's own loader and action decision. A search pointer that fails is dropped silently. A named source that is hidden, foreign, or unknown refuses the whole request with one sentence that reveals nothing (`context_unavailable`). An index that is catching up or degraded is reported as "may be incomplete", never as "nothing relevant exists" (AI-005, PERM-007, SRCH-007). |
| D3 | Typed source adapters | Only kinds with a genuine canonical read path are offered. The adapters and what each sends:<ul><li>**Task** (`loadTask`, `record.read`): title, description, status, due date.</li><li>**Project** (`loadProject`): name, description, status, dates.</li><li>**Document** (`loadDocument`, `record.read`): the current saved version's plain text, with references removed as in 5A, plus 4C approval and effective state.</li><li>**Comment** (`loadComment`, authorized through its task, project, or document host).</li><li>**Task activity** (the permission-filtered task history; it needs ownership-derived access, so a share alone does not reach it).</li></ul>Not offered: milestones, decisions, files, deliverables, comments on deliverables, connections, attachment text and file bytes (DOC-019 and 4E quarantine), remote URLs, and semantic search (OD-31). Custom fields are never sent. Each field carries its data class, and fields above the workspace class are dropped. |
| D4 | The context manifest | A deterministic, versioned list (`context_manifest.v1`). Order: explicit includes, then the scope's anchors (the task and its activity, the project), then search candidates, deduplicated. At most twenty readable sources are listed (citation handles S1..S20); more are counted as "not listed", readable only. Up to `AI_CONTEXT_SOURCES_MAX` sources are sent, each cut at `AI_CONTEXT_SOURCE_CHARS` after credential redaction. Each entry records:<ul><li>its kind and public reference;</li><li>the version;</li><li>a SHA-256 of exactly what was sent;</li><li>its flags: stale, draft, unapproved, approved-version-differs, archived, truncated;</li><li>its selection;</li><li>its exclusion reason.</li></ul>A stale, draft, unapproved, superseded, or archived source is listed but used only by an explicit visible choice, and stays flagged (DOC-017, DOC-018). A brand whose profile limits AI sources to the brand excludes everything outside it. The manifest digest is what the person confirms (AI-007). |
| D5 | Re-checks at every stage | Sources are re-checked:<ul><li>at preview;</li><li>at estimate and start, where the confirmed digest must match the rediscovered manifest;</li><li>before dispatch, where the worker re-resolves the recorded manifest as the initiator now;</li><li>before publication, in the settlement transaction;</li><li>on every history, export, and citation display.</li></ul>A revoked or unknown source refuses as at preview. A changed version, content, field policy, or sensitivity invalidates the manifest with an honest notice (`manifest_changed`). Nothing is narrowed silently, a retry needs the same manifest, and a changed meaning needs a fresh preview and confirmation. |
| D6 | One gateway | A grounded answer is a new purpose (`grounded_answer`) of the 7A `ai_action`. It uses the same privacy gates, redaction, reservations and settlement, operation, job, cancellation, unknown-outcome handling, history, and export. There is no separate provider client, key store, pricing table, or execution engine. Production-AI gates are unchanged. A paid run scoped to a project with an AI budget the gateway cannot enforce is refused (`ai_project_budget_unenforced`, PRJ-007), never relabelled as a workspace run. The preview works while AI is off. |
| D7 | Honest trust labels and completeness | The model must answer in `grounded_answer.v1`: JSON statements of kind fact, suggestion, or unknown, citing handles with optional quotations. **Transport completeness is checked first and on its own.** A truncated or partial provider response is rejected (`truncated_response`, `partial_response`) even when it ends at a valid JSON boundary; its server facts and calculations stay, labelled as independent. **Trust model:** only canonical record fields (facts) and server calculations are established. A generated statement is an `excerpt` only when its own text appears verbatim in a cited source, and the presentation shows the source's own matched text. Every other generated claim is `unverified`, even when it cites a source or carries a valid quotation; the quotation is kept as provenance and shown as the source's text. **Verbatim matching:** Unicode NFC, runs of whitespace treated as one space, leading and trailing space ignored. Case, punctuation, and characters are compared exactly; case folding never counts as verbatim. Invalid handles and mismatched quotations are removed and counted, with no identifier shown. Figure and status notes (`unsupported_figure`, `contradicts_record`) are informational only: their absence never makes a claim true. Links and record identifiers in generated text are rendered as text. A malformed or empty answer is rejected with a visible reason, never patched. The overall status is `checked`, `downgraded`, `rejected`, or `withheld`. `checked` means the format and citations were checked, not that the generated statements are true (AI-008, AI-009, AI-010). |
| D8 | Privacy and lifecycle | Context and answers live only in the protected AI content tables. Job checkpoints, operation results, effect ledgers, audit, metrics, and traces hold references only. The manifest entries store hashes, never text, and the validated answer is in `ai_output.grounding`. Erasure (departure, retention, account deletion) clears it with the content. Departure now also closes the departing member's queued AI operations, which were previously left queued forever after the generic job cancel. History is all-or-nothing: if the scope or any contributing source is no longer readable, or its brand has become restricted, the prompt, answer, scope, and source list are withheld, with no types, versions, or counts. **Historical policy:** history, exports, completed-key replays, and citation presentation share one current-content decision (`currentEligibility`, built on the same `policyExclusion` the manifest uses). The scope and every source the run used must still be readable now, and the current AI policy (data class, restricted brands, a brand's approved-source policy) must still allow every field the run used. Otherwise the whole prompt, answer, scope, and source list are withheld; usage and audit metadata remain. This includes 7A test runs, whose recorded fields are checked by the same decision. Ordinary drift that stays authorized keeps the answer, with an honest `changed` mark on the source. Restoring the policy makes non-erased content eligible again. Erasure is final. |
| D9 | Read-only journey and manual fallback | "Ask with sources" (`/workspaces/{ws}/ai/ask`, linked from AI test runs) has these steps:<ul><li>Choose the scope and words, and name sources.</li><li>Review the manifest: include or exclude each source, see warnings, bounds, and index freshness.</li><li>Estimate and confirm through the 7A path.</li><li>Read the answer by kind, with working citations and visible unverified, rejected, withheld, refused, and partial states.</li></ul>Generated text renders as text only. With AI off, the preview still works and says so. Nothing advertises drafting or applying changes. |
| D10 | Verification tooling | Local full-browser verification ran `playwright test --project=all`, a project that does not exist. `scripts/verify.sh` now names each real project (desktop, tablet, mobile) for a full run, and exactly one for each CI shard. `scripts/test/verify-shards.test.mjs` keeps the list equal to `playwright.config.ts`. |

## Boundaries kept

- **OD-31 (semantic search):** open. Retrieval is lexical (5A full text) and says so in the preview (`semantic_search: false`). No embeddings, vector store, or provider were added.
- **DOC-019, 4E:** attachment text, OCR, and file bytes are not sources.
- **DQ-28, OD-41, OD-46, unverified real-model bounds, 10A entitlements:** unchanged from 7A. No paid or live request, customer data, or secret-store purchase was used. The fixture (`groundedFixtureReply`) answers only from the sources it was sent, and its invalid scenarios prove validation, not live answer quality.
- **REL-FU-7A-01:** still tracked. 7B adds no unsafe-effect recovery path.
- **PRJ-007:** project AI budgets are still not enforced. Paid project-scoped runs are refused.

## Identifier reconciliation

| Kind | Allocated | Next free before 7B |
|---|---|---|
| Migration | `0055_ai_retrieval_citations` | 0055 |
| Engineering ADR | 0039 | 0039 |
| 0B decision | ADR-46 | ADR-46 |
| 0C decision | AZ-46 | AZ-46 |
| 0D decision | PL-48 | PL-48 |
| Threats | T-99 to T-102 | T-99 |
| Access tests | AT-390 to AT-406 (and AT-019, AT-020 implemented) | AT-390 |
| Non-resource type | `ai_context_manifest` | — |
| Parameters | `AI_CONTEXT_SOURCES_MAX`, `AI_CONTEXT_SOURCE_CHARS` | — |
| Telemetry | `ai.context_previews`, `ai.answer_validations` | — |

Tests:
- `packages/work/test/integration/ai-retrieval.test.ts`: AT-019, AT-020, AT-390 to AT-401, AT-404 to AT-406.
- `apps/api/test/integration/ai-api.test.ts`: AT-402.
- `e2e/ai-ask.spec.ts`: AT-403.
- `packages/work/test/unit/ai-retrieval.test.ts` and `ai-grounding-review01.test.ts`: the manifest engine, validation, trust labels, completeness, and the fixture contract.
- `apps/web/test/ai-ask.test.tsx`: the page.
- `scripts/test/verify-shards.test.mjs`: browser-gate selection.
- `packages/db/test/integration/migrations.test.ts`: the 0055 boundary.

## Consequences

- 7C and later phases reuse the manifest, adapters, and validation; they do not add retrieval authority.
- Residual risks:
  - lexical retrieval can miss relevant records (the preview says so);
  - activity covers task history only;
  - a source that changes during a provider call withholds the answer, and the person must ask again;
  - generated statements other than verbatim excerpts are always unverified; live-provider semantic answer quality is unproven.

## Corrective review 01

Review 01 found three defects in the 7B candidate (head `0ae54e9`). All three are fixed with runtime regressions. Each regression was run against the reviewed head and failed there:
- R2 and R3: 5 of 5 new unit tests failed.
- AT-404, AT-405, and AT-406: all 3 failed.

- **R1, historical content and current policy.**
  - Before: history checked only record visibility and restricted brands, so lowering the data class after completion still showed C2-derived answers.
  - Now: history, exports, completed-key replays, and citations share one current-content decision (D8), and 7A test runs use it too.
  - Evidence: AT-404 covers:
    - C2 to C1 and C0 with access unchanged;
    - export and replay, with no new dispatch;
    - restored policy;
    - a run created under C1;
    - authorized drift marked changed;
    - a policy change during execution;
    - no resurrection after erasure.
- **R2, incomplete transport.**
  - Before: completeness mattered only when parsing failed, so a truncated response at a valid JSON boundary was "validated".
  - Now: completeness is checked first (D7). The `truncate_valid` fixture scenario (a complete answer that stops at `max_tokens`) proves it end to end in AT-405, with cancellation and the UI's incomplete label.
- **R3, quotations are provenance.**
  - Before: a valid quotation promoted an unrelated claim to "sourced".
  - Now: only record facts and calculations are established, a verbatim statement is an excerpt showing the source's own text, and everything else is unverified (D7). The UI headings are "Exact excerpts from the sources", "Unverified statements (generated)", and "Suggestions (generated)".
  - Evidence: AT-406 and the unit cases cover the reproduced unrelated-quote claim, spelled-out amounts, negated and contradicted status, an unrelated real date and amount, case folding, and genuine excerpts.
- **Also fixed:** a second question on the same page no longer inherits the previous cost confirmation.
