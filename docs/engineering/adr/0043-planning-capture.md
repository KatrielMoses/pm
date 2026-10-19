# ADR-0043: AI-assisted planning and capture (Phase 7F)

Status: **proposed** (implementation candidate; acceptance evidence pending).

Phase 7F adds two assisted journeys on the accepted foundations:
- **Capture:** natural-language and voice capture into the 2E Inbox, through the 7A gateway (privacy, budgets, history) and a registered 7C action;
- **Planning:** a capacity-aware daily plan from 3C Today and blocks, 3D estimates, 3E capacity, and 6C meeting mirrors, applied only through the 7D change-proposal protocol with new canonical planning operations.

Both are explicit and reviewable. Interpretation suggests spans of the person's own words and the server derives every value; voice transcription goes through the gateway to a provider-neutral transport whose only implementation is a synthetic fixture (production stays unconfigured); the daily plan is computed by a deterministic, rule-based planner, never a model. Nothing is saved, scheduled, or changed until the person saves or applies it, and task dates never change. 7F adds no agents or automations (Phase 8), no new calendar adapter, and no test execution (voice-derived test cases remain a 9B contribution).

Records: 0B ADR-50, 0C AZ-50, 0D PL-52, UXD-31. Migration `0059_planning_capture`. Threats T-124 to T-133, tests AT-481 to AT-514; corrective review 01 adds T-134, T-135 and AT-515 to AT-523.

## Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | One intake store | Interpretation and voice extend the 2E capture dialog and Inbox; there is no second intake store. A capture keeps its original text, source, actor, time, and correlation. Typed and pasted capture, and the deterministic rule-based parser, work whether or not AI or transcription is available. A manually typed or pasted transcript is typed capture, never `voice`. |
| D2 | Interpretation is spans; the server derives values | `interpret_capture.v1` is a registered 7C action (kind `interpretation`) run through the same context preview, estimate, input digest, confirmation, dispatch, cancellation, and history as every action, over no sources. The model returns only `{field, span}` pairs (`interpretation.v1`): each span must occur in the redacted text it was sent, or it is dropped and counted; unknown fields, extra keys, incomplete transport, and malformed output are refused whole. The server then derives every value itself (`packages/work/src/capture/interpret.ts`): dates, priority, duration, and recurrence with the capture rules in the person's zone and today (ambiguous dates stay choices, unknown stays unknown, never zero); brands, projects, owners, and labels with the 2E authorized lookup, so a hidden name and an unknown one are indistinguishable. Explicit capture syntax wins over an overlapping span. The interpretation is bound to its exact text and person: an edited text needs a new interpretation. No names are offered to the model (the assist list omits the action; the capture dialog runs it). |
| D3 | Voice through the gateway, ephemeral audio | Recording needs a deliberate gesture, shows its elapsed time against the bound, and has Stop and Cancel; a file can be uploaded instead. Bytes go to 4E object storage through an upload URL bound to the exact size, type, and checksum; the server then checks the stored object (size, checksum, container: PCM WAV, Ogg Opus or Vorbis, WebM; duration from the container where it has one) before one transcription run starts. Transcription is an `ai_action` of purpose `transcription` with its own dispatch row and reservation (synthetic price per audio second), settled by the measured duration; a possibly charged outcome is never resent. The transport (`TranscriptionProvider`) is provider-neutral; the only implementation is the fixture protocol, refused when deployed. The transcript lives in the protected output boundary (`ai.ai_output`, redacted for credentials); the audio is deleted at every outcome and the cleanup sweep deletes any leftover object. Unconfigured transcription, AI, or storage refuses before anything is stored. |
| D4 | A deterministic, capacity-aware plan | `packages/work/src/planning/planner.ts` ranks the person's readable open work (assigned to them, or on that day's Today list, in the chosen brands and projects) by explicit rules: locked commitment, commitment, deadline today, overdue, due today, priority, due date, estimate, id. It places work into free time (working hours, time off, observed holidays, connected-calendar busy time, and existing blocks with their preparation and buffer, after now on today) in real instants, so DST days have their true length. A missing estimate is a question, never zero; an entered assumption is used and labelled and changes no task. Splitting is opt-in. What does not fit says why (`missing_estimate`, `blocked`, `already_scheduled`, `does_not_fit`, `over_capacity`), postponement suggestions name their trade-off, and locked work that cannot fit is a conflict, never moved. Candidates are bounded (60) and the coverage says so. |
| D5 | Plans are change proposals | `POST /planning/day-plans` turns the current plan into a 7D proposal of origin `planner` on an exec operation of kind `plan_proposal`, with the canonical 3C operations: `commitment.add` and `block.create` (source `plan`) for scheduled work, and unselected `commitment.remove` and `block.delete` for unlocked postponements. A proposal holds at most 99 changes; what does not fit is listed (`proposal_limit`). The person edits block times, selects, approves, and applies on the proposals page; the trust note and provenance say rule-based planner, not AI, and the changes are the person's own (source `ui`) referencing the proposal. |
| D6 | Atomic Apply against an unchanged day | Approve and Apply lock the plan inputs in one order (the capacity profile, the day's commitments, the person's blocks, the holidays of their reservation brands, then the plan's tasks for share), recompute the plan, and compare its constraint snapshot (windows, available minutes, meetings, blocks and versions, candidates, estimates and versions, commitment versions, blockers, scope) with the reviewed one; any change refuses as `plan_changed`. Edited blocks are re-checked: overlaps with blocks, meetings, or each other are errors; outside working hours and after a deadline are warnings. Rebase rebinds the day only when the person sends the snapshot they reviewed, and keeps their edits. Apply runs every selected change through the canonical commands in one transaction (all or nothing), with block version locks; a replay re-renders and never applies twice. The day, block, and holiday writers take the same advisory locks, so a concurrent change either lands before the recompute (and refuses the plan) or waits for Apply. |
| D7 | Evidence and re-checks | A plan stores its complete authorization basis (every candidate, blocker, and scope record or brand) as protected evidence; review, validation, approval, Apply, and replay re-check it. Any loss withholds the plan whole; there is no empty or sampled basis. An interpretation and a transcript are AI content: shown only to their person while present. |
| D8 | Privacy and lifecycle | Plan content (title, plan, payloads), transcripts, interpretations, and prompts are content. Departure erases them, ends open recordings, and leaves their audio to the sweep; technical retention erases planner proposals (discovered on their own) and AI content. Applied blocks and commitments and saved Inbox items stay. No audio or transcript text is placed in job arguments, checkpoints, logs, audit, or metrics. Unsaved transcript edits and plan options use the personal-draft store (per account, expiring, removed on sign-out and session change). |
| D9 | Bounds | 120 seconds, 10 MiB, `audio/wav`, `audio/webm`, `audio/ogg`, three open recordings per person, a 15-minute upload window, 4000 transcript characters, 20 interpreted fields, 60 plan candidates, 14 days ahead, 99 changes per plan. All are configuration (`VOICE_*`, `TRANSCRIPTION_*`) or code constants recorded here. |
| D10 | One UI per journey | The Capture dialog offers "Interpret with AI" (estimate, confirm, evidence marks, server values, opt in to save with it) and "Speak instead" (record or upload, transcript preview and edit, use as capture text), each truthful when unavailable, denied, unsupported, offline, or failed. Today links to `/workspaces/{ws}/today/plan` (plan preview, missing-estimate assumptions, split option, what is planned and why, what is not, postponement suggestions, locked work, then "Create plan proposal"). The proposals page reviews plan changes with editable block times, per-block conflicts, and snapshot rebase. |

## Requirement and section matrix

| Requirement | Capability | Runtime evidence | UI | Boundary |
|---|---|---|---|---|
| CAP-005 | voice recording or upload → transcript → edit → explicit save with `voice` provenance | AT-500 to AT-508, AT-511 | AT-513 | synthetic transcription only |
| PLAN-010 | a realistic daily plan from capacity | AT-481, AT-482, AT-509 | AT-514 | rule-based, not generated |
| PLAN-011 | every placement explained | AT-482 | AT-514 | — |
| PLAN-012 | deferred work and why, with a complete basis | AT-482, AT-490 | AT-514 | 60 candidates, coverage stated |
| PLAN-013 | accept, edit, reject through a proposal | AT-484, AT-485, AT-486, AT-487 | AT-514 | — |
| AI-021 | postponement suggestions when capacity is exceeded | AT-482, AT-488 | AT-514 | unselected until chosen |
| CAP-003 | natural-language capture | AT-493, AT-497, AT-510 | AT-513 | — |
| CAP-009 | brand, project, owner, dates, priority, duration, recurrence, labels detected | AT-493, AT-494 | AT-513 | names among what the person can read |
| PLAN-017 | locked tasks and blocks preserved | AT-488, AT-491 | — | — |
| TEST-003 | voice transcription available to test-case creation | AT-501 | — | test cases are 9B |
| TIME-016 | capacity-aware rescheduling suggestions | AT-482, AT-488 | AT-514 | task dates never change |

## Boundaries kept

- **DQ-28, OD-31, OD-41, OD-46, real-model cost bounds, 10A entitlements:** unchanged. No paid or live request, customer data, or secret was used. The transcription transport is a synthetic fixture, refused when deployed; no browser or cloud speech service is used. Real-device and live-provider usefulness of voice capture is unproven (manual).
- **PRJ-007:** project AI budgets are still not enforced; interpretation runs with no project scope.
- **DOC-019:** attachment text is not read.
- **REL-FU-7A-01:** still tracked; nothing new depends on it.
- **9B:** voice-derived test cases (TEST-003) are a contribution only: the transcript is available, no test is created or run.
- **8A, 8C, 12A:** agents and automations, agent-run review, and the launch gate are later phases.

## Identifier reconciliation

| Kind | Allocated | Next free before 7F |
|---|---|---|
| Migration | `0059_planning_capture` | 0059 |
| Engineering ADR | 0043 | 0043 |
| 0B decision | ADR-50 | ADR-50 |
| 0C decision | AZ-50 | AZ-50 |
| 0D decision | PL-52 | PL-52 |
| UX decision | UXD-31 | UXD-31 |
| Threats | T-124 to T-133; T-134, T-135 (corrective review 01) | T-124 |
| Access tests | AT-481 to AT-514; AT-515 to AT-523 (corrective review 01) | AT-481 |
| ID prefixes | `vcp` | — |
| Operation kinds | `plan_proposal` | — |
| Non-resource types | `day_plan_preview`, `capture_interpretation`, `voice_settings` | — |
| Telemetry | `planning.plans`, `capture.voice`, `capture.interpretations` | — |

Tests:
- `packages/work/test/integration/day-plans.test.ts`: AT-481 to AT-492.
- `packages/work/test/integration/capture-interpretation.test.ts`: AT-493 to AT-499.
- `packages/work/test/integration/capture-voice.test.ts`: AT-500 to AT-508.
- `apps/api/test/integration/planning-capture-api.test.ts`: AT-509 to AT-512.
- `e2e/planning-capture.spec.ts`: AT-513, AT-514 (desktop, tablet, mobile).
- `packages/work/test/integration/day-plans-review01.test.ts`: AT-515 to AT-520 (corrective review 01 R1).
- `packages/work/test/integration/capture-voice-review01.test.ts`: AT-521 to AT-523 (corrective review 01 R2).
- `packages/work/test/unit/transcription-transport.test.ts`: the bounded transport contract (R2).
- `packages/work/test/unit/planner.test.ts`: ranking, overload, missing estimates, constraints, splitting, DST, edit checks.
- `packages/work/test/unit/capture-interpretation.test.ts`: the contract, span rules, audio containers, and the transcription transport.
- `apps/web/test/planning-capture.test.tsx`: the capture assistance, plan page, and planner proposal review.
- `packages/db/test/integration/migrations.test.ts`: the 0059 boundary.

## Consequences

- Phase 8 agents may propose plans or captures only through the same proposal and action protocols.
- Residual risks:
  - a change to a plan input committed after a plan was applied is a later event: the applied plan was consistent with the day when it committed, and nothing keeps it valid afterwards (calendars keep changing at the provider);
  - WebM recordings without a container duration are bounded by size and checked against the measured duration;
  - the transcription fixture proves the path, not recognition quality; production transcription needs a provider, privacy, secret, entitlement, and cost decision;
  - the e2e machine time zone affects one accepted 7E briefing test that uses the database session zone; CI runs in UTC.

## Corrective review 01

- **R1: every controlling plan input serializes with Apply.**
  - One transaction-scoped lock per person and workspace, `planning.constraints:<workspace>:<member>` (`planning.lock_plan_constraints`, `packages/work/src/planning/constraints.ts`), covers everything that controls a plan:
    - calendar mirrors, their sources and connection health;
    - capacity reservations (including one in a brand new to the person), the capacity profile, availability rules and time off;
    - blocks and Today commitments.
  - Who takes it:
    - Approval, validation, rebase and Apply take it first, then the capacity profile, the day, the person's blocks, the holidays of their reservation brands, the workspace dependency lock (shared), and the plan's tasks for share. They recompute the constraint snapshot under those locks and hold them through the atomic Apply.
    - The canonical writers take it before their own locks: calendar sync, the calendar list refresh and disconnect; reservation set and delete; profile and time-off commands; and the day and block locks.
    - `plan_constraint_guard` triggers on every controlling table take it for any other writer, so a meeting or reservation that did not exist when the plan was checked cannot appear unserialized.
    - Removing a blocker takes the workspace dependency lock, as adding one already did.
  - Guarantee: a writer that commits first is reflected and makes Apply refuse (`plan_changed`, nothing applied) until an explicit rebase and fresh approval. A writer that starts while Apply runs waits for Apply to commit. A change committed after the plan is a later event (see Consequences).
  - Lock order everywhere: constraints, capacity profile, day, blocks, brand holidays, dependencies, task rows. Other people's inputs and other workspaces are never serialized behind a plan.
  - Also fixed: the planner subtracts meetings from free time itself instead of relying on the availability windows to exclude them, so a block is never proposed over a meeting.
  - Tests AT-515 to AT-520 (two connections, real lock observation, the canonical Google sync and reservation commands, and a non-canonical writer). On the reviewed head `0e75e35` all six fail.
- **R2: bounded transcription responses, never clipped.**
  - `HttpTranscriptionProvider` refuses a declared length over the byte budget (`maxChars × 4 + 2048`) before reading. It reads the body chunk by chunk and cancels it as soon as the budget is exceeded; a missing or forged length changes nothing.
  - It decodes strict UTF-8 only once the body is complete, and validates the shape and a safe integer duration (at most 24 hours) before any arithmetic.
  - A transcript over the character bound is refused with its measured duration (`transcript_too_long`): the known liability is settled, and nothing is stored, shown, saved or interpreted.
  - An oversized or malformed answer (`response_too_large`, `malformed_response`) keeps the possibly charged reservation unknown for review and is never resent.
  - The audio is deleted in every case (the sweep retries a failed delete).
  - Tests: the transport contract (`packages/work/test/unit/transcription-transport.test.ts`) and AT-521 to AT-523. On the reviewed head the contract cases and all three integration tests fail.
- **Verification repair:** AT-476 now sets its schedule's due instant explicitly (00:00 UTC today) instead of the database session's local midnight. It passes under UTC, Asia/Kolkata, America/Sao_Paulo and America/Los_Angeles sessions. The reviewed test fails under a UTC−3 session at 04:54 UTC.
