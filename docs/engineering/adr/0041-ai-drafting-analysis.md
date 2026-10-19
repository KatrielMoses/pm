# ADR-0041: AI drafting and analysis (Phase 7C)

Status: **accepted** (engineering scope only: the architect accepted the 7C subphase within its recorded boundaries at head `730c6e4`, CI run 39057392016 attempt 1, draft PR #39; corrective reviews below are resolved history). Production use is not approved, and the Phase 7 exit gate is pending its integration review ([ADR-0044](0044-phase-7-integration.md)).

Phase 7C adds AI drafting and analysis as one typed action surface on the accepted foundations:
- the 7A gateway (budgets, transport, operation, cancellation, history, protected content);
- 7B retrieval, manifests, and citations;
- the 7D proposal protocol (review, edit, rebase, approval, atomic Apply).

Every feature is a registered action. Analysis actions return a validated typed result; drafting actions return a 7D proposal, so nothing reaches a record without the person's explicit Apply. 7C adds no scheduled briefings (7E), voice or capacity-based planning (7F), agents or automations (Phase 8), release management (9), or commercial entitlements (10A). Production AI stays disabled under the accepted gates: every run in this phase uses the labelled synthetic fixture.

Records: 0B ADR-48, 0C AZ-48, 0D PL-50. Migration `0057_ai_drafting_analysis`. Threats T-108 to T-113, tests AT-431 to AT-454.

## Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | One catalog, one gateway | Ten registered, versioned actions (`packages/work/src/ai/actions/catalog.ts`). Each declares its kind, input, required context, source kinds, item kinds or proposal operations, choices, output bound, instructions, and visible limitations, and is served by `GET /ai/actions`. The person picks the action, and the server composes the request from bounded fields (instruction, brief, answers). Free text cannot switch the action, widen the scope, or add a tool. Actions run as `ai_action` purposes (`analysis`, or `change_proposal` with an action key) through the same gates, budget reservation, transport, operation and job, cancellation, retry, history, export, and erasure. There is no second engine, client, secret store, or pricing table. |
| D2 | Confirmation binds the exact input | The estimate returns `input_digest`: the SHA-256 of the action and template, the composed request, every source payload, the offered choices, and the output bound. Start must present the same digest. Any material change (action, instruction, brief, answers, sources, choices, bounds) refuses with `input_changed`, and the person estimates again. Same-key replays re-render and never dispatch. |
| D3 | Honest analysis (`analysis.v1`) | Completeness is checked first. Then the strict shape and item kinds are checked, every citation must be a readable manifest handle (an item with none is dropped and counted), quotations count only when verbatim, links render as text, and a completion claim about a task the records show open is flagged `contradicts_record`. Record facts and calculations come from the server. Deterministic rule findings are computed over the readable manifest only and name their rule: overdue, identical titles (the TSK-042 rule), open without a due date, overdue first, and due within 7 days. Generated items are labelled suggestions or candidate interpretations, never facts, decisions, or evidence of completion. |
| D4 | Missing information | Each action declares the context it needs (a brief or goal, a project or task scope, a task or document, tasks). Missing context refuses before anything is sent, with the question to answer (`input_required`), and an unsupported source kind is refused by name. The model may return `questions` (and `assumptions`) instead of a result, which shows as `needs_input`. Answers join the request as a new input revision with a new digest and estimate. Nothing is invented or auto-applied. |
| D5 | Sources | These are the 7B adapters, plus two typed adapters. Goals go through `loadGoal` and the goal read decision (never shared). Meetings are the caller's own mirrored 6C calendar events, through `ownCalendarEvent` (owner-only). The meeting mirror holds only title, time, busy, and status, so nothing else can be sent. A meeting belongs to no brand and is excluded from brand, project, and task scopes. Another member, an administrator, or an unknown id gets the same `context_unavailable`. Attachment text and external calendars are never fetched. |
| D6 | Drafts become 7D proposals | Drafting actions (`draft_project`, `draft_tasks`, `rewrite`, `categorize`) may propose only their declared operations. Labels and members are offered as typed manifest entries (corrective review 01). The 7D registry gains three adapters over canonical transaction-scoped commands: `task.assign` (`setAssigneesIn`: ownership, active members, history), `label.add` (`toggleLabel`: same brand, active label, limit), and `criterion.add` (`addCriterionIn`). `task.create` and `task.update` gain `estimate_minutes`, bounded by the canonical rule. Labels and members are server-issued choices (L…, M…) from current lookups; a model-supplied id or name is refused (`unknown_choice`), and nothing new is created. In one Apply, each existing record a change will change is locked as its canonical writer locks it and compared with the version the proposal expects, or with the version this Apply already produced for it; a merely referenced record is never trusted (corrective review 01). Plans carry visible assumptions. |
| D7 | PRJ-016 end to end | A brief, or a readable goal, becomes a proposal with a new project, tasks with estimates, a milestone, a `blocks` dependency, an acceptance criterion, an assignment, and a label. The person edits values, selects a dependency-complete subset, approves, and applies once. The records are the ordinary project, tasks (origin `ai_draft`, source `ai_proposal`), milestone, criterion, assignee, and link, and the audit shows the person as actor. |
| D8 | Text drafts | Status updates and release notes are `analysis.v1` results with a `draft` text and cited key points. Nothing is posted as a project update, and nothing is published (DEV-012 publishing and release readiness stay in 9D). |
| D9 | Privacy and lifecycle | Briefs, answers, results, and assumptions live only in the AI content tables and personal drafts. Revocation and policy changes withhold the whole result. Retention, departure, and account deletion erase it, and applied records stay. Checkpoints, logs, and metrics hold references and counts only. Unsaved assist input uses the personal-draft store (per account and workspace, bounded, expiring, removed on sign-out, session end, and account change), restored only after the catalog loads for the workspace. |
| D10 | One UI | `/workspaces/{ws}/ai/assist` is linked from task and project pages (scope preselected) and from AI test runs (workspace, brand). It covers action choice, inputs, scope, source preview (works with AI off), estimate and confirmation, progress and cancel, a typed result with rule findings, generated suggestions, facts and assumptions, questions to answer, and links to proposals for review. Repeated clicks reuse the attempt key. |

## Action matrix

| Action | Requirements | Input and context | Clarification | Output | Fixture scenarios | Runtime evidence | UI | Boundary |
|---|---|---|---|---|---|---|---|---|
| `summarize.v1` | AI-012, AI-001–AI-004 | optional focus; any readable source kind, any scope | questions → needs_input | analysis.v1 `summary` | ok, ask, cite_forged, inject, claim_status | AT-431, AT-432, AT-437, AT-441, AT-446 | AT-447 | lexical retrieval (OD-31) |
| `extract.v1` | AI-013 | optional focus; any source | questions | `decision`, `action_item`, `risk`, `blocker`, `assumption`, `open_question` (candidates) | ok, cite_forged, inject, claim_status, malformed, unsupported, truncate_valid | AT-433, AT-443 | AT-447 | candidates only; nothing recorded |
| `analyze_work.v1` | AI-019 (TSK-042 rule) | tasks required | questions | `duplicate`, `stale`, `ambiguous`, `conflict` + rule findings | ok | AT-434 | assist page | suggestions; no merge or transition |
| `recommend_next.v1` | AI-020, AI-022 | tasks required | questions | `recommendation` with reasoning + named rules | ok | AT-434 | assist page | capacity postponement is 7F (AI-021) |
| `draft_status_update.v1` | AI-016 | optional emphasis | questions | `draft` text + `highlight`, `risk` | ok, claim_status | AT-435 | assist page | not posted as a project update |
| `draft_release_notes.v1` | AI-016 (DEV-012 contribution) | optional release name | questions | `draft` text + `change` | ok | AT-435 | assist page | publishing and readiness are 9D |
| `draft_project.v1` | AI-014, PRJ-016, AI-015 | brief or goal; single-brand scope for a new project | questions + assumptions | change_proposal.v1 (project, tasks, milestone, relation, criterion, assign, label) | ok, ask, unsupported | AT-436, AT-438, AT-439 | AT-448 | LA-006 launch gate is 12A |
| `draft_tasks.v1` | AI-015 | project or task scope; instruction | questions | tasks, subtasks, milestones, dependencies, estimates, criteria | ok | AT-440 | assist page | — |
| `rewrite.v1` | AI-017 | task or document; instruction | questions | `task.update` description, `document.replace` | ok, unsupported | AT-440 | assist page | live editing still blocks |
| `categorize.v1` | AI-018 | tasks | questions | priority, `label.add`, `task.assign` | ok, inject | AT-440 | assist page | no new labels or people |

## Boundaries kept

- **DQ-28, OD-41, OD-46, unverified real-model bounds, 10A entitlements:** unchanged. A model without verified bounds is refused. No paid or live request, customer data, or secret was used. The fixture (`actionFixtureReply`) answers only from what it was sent, and its scenarios prove the boundary, not live usefulness.
- **OD-31:** retrieval stays lexical and says so; no embeddings or vector store.
- **PRJ-007:** project AI budgets are still not enforced; paid runs scoped to such a project are refused.
- **DOC-019:** attachment text and file bytes are not sources.
- **REL-FU-7A-01:** still tracked; nothing new depends on it.
- **7E, 7F, 8, 9, 10A:** briefings, capacity-based postponement (AI-021), invoking actions from automations (AUTO-006), release publishing (DEV-012), and commercial gates are later phases.

## Identifier reconciliation

| Kind | Allocated | Next free before 7C |
|---|---|---|
| Migration | `0057_ai_drafting_analysis` | 0057 |
| Engineering ADR | 0041 | 0041 |
| 0B decision | ADR-48 | ADR-48 |
| 0C decision | AZ-48 | AZ-48 |
| 0D decision | PL-50 | PL-50 |
| Threats | T-108 to T-111; T-112, T-113 (corrective review 01) | T-108 |
| Access tests | AT-431 to AT-448; AT-449 to AT-454 (corrective review 01) | AT-431 |
| Non-resource type | `ai_actions` | — |
| Telemetry | `ai.analyses` | — |

Tests:
- `packages/work/test/integration/ai-assist.test.ts`: AT-431 to AT-445 and AT-449 to AT-451.
- `packages/work/test/integration/ai-proposals.test.ts`: AT-452 to AT-454 (two-connection races).
- `apps/api/test/integration/ai-api.test.ts`: AT-446.
- `e2e/ai-assist.spec.ts`: AT-447 and AT-448.
- `packages/work/test/unit/ai-actions.test.ts`: the catalog, contract, rules, choices, and fixture.
- `apps/web/test/ai-assist.test.tsx`: the page.
- `packages/db/test/integration/migrations.test.ts`: the 0057 boundary.

## Consequences

- 7E and 7F add actions to the catalog, and their proposals use the same adapters.
- Residual risks:
  - lexical retrieval can miss relevant records;
  - meetings are limited to the caller's own title and time;
  - generated suggestions are unverified, and live-model usefulness is unproven.

## Corrective review 01

Review 01 (reviewed head `d60ae4d`) found two defects. Both are fixed, with runtime regressions. Each core regression was run against the reviewed head and failed there:
- The outbound-redaction probe failed: the raw synthetic label marker reached the provider.
- AT-452 and AT-453 failed: the raced Apply was reported `applied` over the concurrent edit.
- AT-454 passed there when run alone. It is a non-regression guard for legitimate same-record changes.

- **R1, offered choices bypassed the privacy boundary.**
  - Before: label and member display names were appended as a separate "Choices" block. They were not redacted, not classified, not shown in the preview, and not re-checked after start.
  - Now: choices are manifest entries of kind `label` and `member`, with handles L…/M… and registered C1 fields (`AI_CHOICE_FIELDS`). They go through the same redaction, data-class policy, digest, dispatch and publication re-check, current eligibility (history, export, proposal rendering, replay), and erasure as sources. The preview lists them, and the person can omit any. Under C0 none are sent. A choice that becomes unavailable refuses the start or dispatch, or withholds the result or proposal, whole. The separate `choice_refs` column and choices path were removed. Proposal choices are built from the offered entries.
  - Evidence: AT-449 (redacted markers, digest over the exact bytes, no raw copies), AT-450 (omission, C0, a policy change after the run with history, export, and replay), AT-451 (unavailable at start, dispatch, and publication), and the page test for omission.
- **R2, first-touch checks did not hold the record lock.**
  - Before: `#firstTouch` read versions without the domain-row lock and marked every touched record, including a relationship's other end, as checked.
  - Now: `#guardBefore` locks the row canonical writers lock (`work.task`, `work.project`, `knowledge.document`) in a stable order and compares it with the version this Apply produced or the proposal's expected version. `#guardAfter` records only the versions of records the change's canonical command actually changed: an update, replacement, or assignment target; the task of a label or criterion; the owned end of a relationship. Proposal-local creation ids live in a separate map. Validation restores the trusted state when a step rolls back to its savepoint.
  - Evidence: AT-452 (relationship endpoint) and AT-453 (container) race a concurrent edit under the real row lock with a lock-observed barrier, and get a stale conflict, rollback, no success event, and a no-op replay. AT-454 covers two valid same-record changes and savepoint recovery.

