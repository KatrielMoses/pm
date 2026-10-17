# ADR-0040: Change proposal protocol (Phase 7D)

Status: **proposed** (implementation candidate; acceptance evidence pending).

Phase 7D adds the one way AI-suggested record changes reach the product. An AI run over a previewed, authorized context produces a typed proposal. A person reviews it, edits it, selects changes, approves exactly what they reviewed, and explicitly applies it. One transaction then runs the ordinary domain commands. 7D runs before 7C so that drafting can use this boundary instead of a second write path. It does not add 7C drafting or analysis, briefings (7E), AI planning (7F), or agents (Phase 8). Production AI stays disabled exactly as accepted in 7A and 7B: in 7D only the labelled synthetic fixture may generate proposals.

Records: 0B ADR-47, 0C AZ-47, 0D PL-49. Migration `0056_ai_change_proposals`. Threats T-103 to T-107, tests AT-407 to AT-430.

## Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Generation is separate from change | A proposal is a new purpose (`change_proposal`) of the 7A `ai_action` over the 7B manifest: the same preview, digest confirmation, estimate, budgets, operation, job, cancellation, history, and export. Settlement parses the output into typed changes in the AI content tables and changes nothing else. A truncated or partial response is rejected (`truncated_response`, `partial_response`), and so is an invalid proposal (`invalid_proposal`, with reasons); neither stores a proposal. If a source changed or became unreadable before settlement, the proposal is withheld. Parsing, showing, editing, and approving never write a business record; only an explicit Apply does. No endpoint accepts client JSON as model output. In 7D a non-synthetic model is refused before anything is sent (`ai_proposal_generation_unavailable`) (AI-023). |
| D2 | The typed, versioned contract | `change_proposal.v1`: `{title, changes}` with at most `AI_PROPOSAL_CHANGES_MAX` changes (default 25). Seven operations: `task.create`, `task.update`, `project.create`, `project.update`, `milestone.create`, `relation.add` (`blocks` or `related`), and `document.replace` (a new immutable version). Each has an exact field allowlist; status is allowed on updates only. Existing records are named only by manifest handles (S1..S20) of the matching kind, so a proposal can never reach outside the reviewed context. New records are proposal-local references (`new:<ref>`) to a create of the right kind in the same proposal. Unknown keys, operations, fields, raw identifiers, handles outside the manifest, foreign or duplicate references, conflicting updates of the same field, duplicate relations, self relations, and dependency cycles refuse the whole proposal. Nothing is patched or dropped. No delete, permission, assignment, label, URL, or code. |
| D3 | Transaction-aware adapters over canonical commands | Each operation has one adapter that calls the same transaction-scoped command the ordinary API uses, extracted without changing its callers: `insertTask` (after `resolveContainer` and the create decision), `applyTaskChanges` (through `parseMerge` and `applyFieldMerge` against current values), `createProjectIn`, `updateProjectIn` (with `gateStatusChange`), `createMilestoneIn`, `addRelationshipIn` (cycle and depth rules), and `saveContentIn` (the live-edit guard and base-version check). Workflow gates, required fields, dates, hierarchy, dependency cycles, live editing, and record permissions therefore apply unchanged. The expected version recorded at generation is checked first (`target_changed`). Unsupported operations do not exist in the registry, so they cannot be proposed. |
| D4 | Ordering, temporary references, and selection | Changes run in a deterministic dependency order (stable by position). Dependencies are explicit plus implicit (every `new:` reference). A temporary reference resolves only to a create in the same proposal that already ran in the same Apply. A selection must be dependency-complete: an unselected or rejected dependency is refused with the exact change named (`dependency_not_selected`), never added silently. Generated record ids are recorded and shown only after a committed Apply. |
| D5 | Review, edit, and revisions | The detail view shows every change with the current authorized before-value (read through the record's own loader; no base values are stored), the proposed value, the target, the dependencies, an out-of-date warning, the selection, the decision, and the outcome. It keeps the 7B trust note: a proposal is a suggestion, not a fact or evidence of completion. Editing values (through the same field rules), decisions, or the selection creates a new revision and fingerprint and supersedes any approval. A stale revision is refused (`revision_changed`). History is reference-only: kind, revision, change keys, fingerprint, actor (AI-024). |
| D6 | Approval binds exactly what applies | Approval requires the current revision and fingerprint, a dependency-complete selection, and a dry run of every selected change through the adapters inside a savepoint that is always rolled back (`:validate` shows the same result). It binds the approver, revision, selection, fingerprint, target versions, effective scope (scope references and the approver's permission epochs), risk class R1, and the step-up requirement. It expires after `AI_PROPOSAL_APPROVAL_HOURS` (default 24, 1 to 168), is used by one Apply attempt, and is never an access grant. The person may approve and apply their own R1 proposal. Workflow approvals, locks, and step-up still control: a command that needs step-up challenges the whole Apply. |
| D7 | Atomic Apply and truthful results | Apply locks the proposal and its approval. It re-checks the state, revision, approver, expiry, fingerprint, the 7B current-content decision, and the bound scope, then creates a `proposal_apply` operation. Every selected change runs in dependency order inside one savepoint. On any failure, everything rolls back to the savepoint, and the attempt is recorded in the same transaction: the failed change and its code, the changes that ran and were rolled back, the changes not attempted, the used approval, the failed operation, and no domain or success event. On success, the results, created ids, proposal state, audit, the operation, and the one `ai.proposal.applied` event commit together. Applying a selection is not partial success: unselected changes are reported as not selected (AI-025, AI-029). |
| D8 | Idempotency and provenance | Every write takes an Idempotency-Key. The key's request fingerprint covers the revision and fingerprint, and the reservation lives in the same transaction, so double clicks, concurrent requests, timeout after commit, and a restarted process apply once. A completed-key replay re-renders through current authority and never runs a change. The person is the actor of every change; the command source is `ai_proposal` (with the proposal id); the operation is the Apply; and the causation is the generating AI action. Neither is presented as the other. New tasks keep origin `ai_draft` (with the proposal and change). No provider call or external effect runs inside Apply, and nothing depends on REL-FU-7A-01. |
| D9 | Privacy and lifecycle | Titles, reasons, and proposed values live only in the AI content tables, are personal to the initiator, and render only through the current-content decision. If a source or field is no longer allowed, the whole proposal is withheld (no title, changes, counts, or history) and cannot be approved or applied. Job checkpoints, operations, audit, logs, events, and metrics hold references and counts only. Erasure (departure, retention, account deletion) clears the content and revokes unused approvals, while applied records, the reference-only history, and application outcomes stay. The AI history export carries each proposal through the same renderer. |
| D10 | Journey | The Ask page offers "Propose changes (synthetic fixture)" after an estimate. A finished run links to the review page (`/workspaces/{ws}/ai/proposals/{prp}`); the list is at `/workspaces/{ws}/ai/proposals`. The review page has an editable diff, per-change selection and rejection, live dependency feedback, Save edits, Approve, an explicit "Apply n of m changes", outcome screens ("Applied by you · proposed by AI", or "Nothing was applied" with per-change states), and history. Unsaved edits are kept per proposal on the device across a refresh, a conflict, or going offline. A repeated click sends one request, and a retry after a dropped connection reuses the same key. |

## Boundaries kept

- **DQ-28, OD-41, OD-46, unverified real-model bounds, 10A entitlements:** unchanged from 7A and 7B. No paid or live request, customer data, or secret-store purchase was used. Proposals come only from the labelled fixture (`proposalFixtureReply`), whose invalid scenarios prove the boundary, not live proposal quality.
- **OD-31 (semantic search) and DOC-019:** unchanged; proposals use the 7B lexical manifest and no attachment text.
- **PRJ-007:** project AI budgets are still not enforced. Paid project-scoped runs are refused, and in 7D every paid proposal run is refused.
- **REL-FU-7A-01:** still tracked. Apply has no external effect and no unsafe recovery path.
- **7C, 7E, 7F, Phase 8:** drafting and analysis, briefings, planning proposals (PLAN-013), test-step review (TEST-004), and agents consume this boundary later. PRJ-016 and LA-006 need 7C generation on top of it.

## Identifier reconciliation

| Kind | Allocated | Next free before 7D |
|---|---|---|
| Migration | `0056_ai_change_proposals` | 0056 |
| Engineering ADR | 0040 | 0040 |
| 0B decision | ADR-47 | ADR-47 |
| 0C decision | AZ-47 | AZ-47 |
| 0D decision | PL-49 | PL-49 |
| Threats | T-103 to T-106; T-107 (corrective review 01) | T-103 |
| Access tests | AT-407 to AT-425; AT-426 to AT-430 (corrective review 01) | AT-407 |
| ID prefix | `prp` (`ai.change_proposal`) | — |
| Non-resource types | `ai_proposals`, `ai_proposal_validation` | — |
| Parameters | `AI_PROPOSAL_APPROVAL_HOURS`, `AI_PROPOSAL_CHANGES_MAX` | — |
| Telemetry | `ai.proposals`, `ai.proposal_applications` | — |

Reused, not replaced: the 0B entities `change_proposal` and `proposed_change` (reconciled and extended), the 0C action `ai.apply_proposal`, the 0D operation kind `proposal_apply`, and the event `ai.proposal.applied`.

Tests:
- `packages/work/test/integration/ai-proposals.test.ts`: AT-407 to AT-421, AT-424 to AT-428, and the 0056 rollback refusal.
- `apps/api/test/integration/ai-api.test.ts`: AT-422 and AT-429.
- `e2e/ai-proposals.spec.ts`: AT-423 and AT-430.
- `apps/web/test/ai-proposals-review01.test.tsx`: the review 01 browser-state and key regressions.
- `packages/work/test/unit/ai-proposals.test.ts`: the contract, ordering, selection, fingerprint, and fixture.
- `apps/web/test/ai-proposals.test.tsx`: the review page.
- `packages/db/test/integration/migrations.test.ts`: the 0056 boundary.

## Consequences

- 7C drafting, 7F planning, and later agents add operations to the adapter registry and generation over this boundary; they do not add a write path.
- Residual risks:
  - an Apply that needs step-up for one change challenges the whole Apply;
  - an approval is invalidated by any permission-epoch change in the workspace, which can mean approving again;
  - live-provider proposal quality is unproven.

## Corrective review 01

Review 01 (reviewed head `352552d`) found two defects. Both are fixed, with runtime regressions. Each regression was run against the reviewed head and failed there:
- The 8 page regressions in `apps/web/test/ai-proposals-review01.test.tsx`: 8 of 8 failed.
- AT-426 and AT-427: both failed. AT-426 failed because no recovery was offered (`can.rebase` undefined).
- AT-428, the server-side expiry case, passed on the reviewed head: the server already accepted a new approval after expiry, and the defect was the page's key reuse, which the mounted-page regression proves.

- **R1, browser drafts outside the content lifecycle.**
  - Before: unsaved proposal edits went to `sessionStorage` under an unscoped key (`pm.ai.proposal.draft.<prp>`). They were loaded even when the server reported the content withheld or erased, were never deleted on those states or on not found, and survived sign-out.
  - Now: they use the personal-draft store as `pm.draft.<account>.ai-proposal.<workspace>.<proposal>`. That store is bounded at 64 KB and cleared on sign-out. On top of it, drafts expire after 72 hours and are validated before use. They are removed when the session is observed to be invalid or the account changes. The page reads them only after a successful authoritative answer, and discards them when that answer is erased, withheld, applied, rejected, not found, forbidden, or unauthenticated. Only the latest response may change what is shown. A network failure is not treated as revocation: an offline device keeps its draft until the next authoritative check, and never shows it before that check. The legacy namespace is purged on sign-out, on session change, and when the app starts.
  - Evidence: the page regressions cover refresh, offline and recovery, sign-out, an account change and session invalidation in the same tab (unrelated drafts kept), withheld (source access revoked), erased, and not found. AT-430 covers the same in a real browser.
- **R2, no recovery from a changed target, and approval key reuse.**
  - Before: generation froze `expected_version`, and nothing refreshed it, so a changed target could never be applied again. The page reused one key per action and revision, so after an approval expired a deliberate new Approve replayed the old completed request.
  - Now: `POST …:rebase` is the explicit review. The person sends the target versions they reviewed. The server locks and re-reads each target through its canonical loader and binds those versions only when exactly the out-of-date targets are still at the reviewed versions. The result is a new revision and fingerprint; every earlier approval is superseded, and a `rebased` history entry is written. Validation, approval, and Apply still never advance a version. A second concurrent change fails closed again. A live session still blocks a document replacement. An unreadable or ineligible source keeps the proposal withheld. The page offers **Use the current versions** next to the current values. A key is now kept only while an attempt's outcome is unknown, so a deliberate new attempt after a known result or expiry gets a new key, and Apply keeps its exactly-once recovery.
  - Evidence: AT-426, AT-427, AT-428, AT-429, and AT-430, plus the mounted-page expiry and rebase regressions.

