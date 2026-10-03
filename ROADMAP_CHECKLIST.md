# Roadmap Delivery Checklist

This is the execution tracker for `BUILD_ROADMAP.md`. The build roadmap is the approved architectural source and should not be edited to record progress.

## Tracking rules

- A checkbox is marked complete only after the developer response and implementation evidence have been reviewed and accepted by the solutions architect.
- Issuing a brief, receiving a developer claim of completion, or having partial work does not complete an item.
- Work proceeds in dependency-safe batches. A later batch starts only after every brief in the active batch has been accepted.
- Parallel briefs must have separate outputs or an explicit integration owner to avoid conflicting changes.
- If review finds gaps, the item remains unchecked and receives a corrective follow-up brief.
- Completion evidence should include changed files, migrations, automated-test results, manual verification, known limitations, and architecture decisions.
- Status values: `Not started`, `Brief issued`, `Developer complete—awaiting review`, `Changes requested`, `Accepted`, or `Blocked`.

## Current batch

Batch: `P1-W1`

Status: Brief issued

Active brief:

- [ ] 1A — Repository, environments, and delivery pipeline
  - Status: Changes requested
  - Brief: `briefs/PHASE_1A_FOUNDATION_PIPELINE.md`
  - Corrective brief: `briefs/PHASE_1A_CORRECTIONS_01.md`
  - Developer response: Received; production image/Testcontainers gates not executed
  - Review evidence: Phase 0 and reported code/database tests pass; package manager reports a workspace cycle; tenant execution rows lack required workspace foreign keys

Completed in the previous batch:

- [x] Phase 0 integration reconciliation

Next dependency-safe sequence after `P1-W1` is accepted:

1. `P1-W2`: 1B — Identity and sessions, and 1F — Audit, deletion, and recovery primitives, in parallel
2. `P1-W3`: 1C — Workspaces, brands, and tenant isolation
3. `P1-W4`: 1D — Membership, roles, and invitations
4. `P1-W5`: 1E — Application shell and personal navigation
5. Phase 1 integration review and exit-gate decision

## Master checklist

### Phase 0 — Product and engineering contracts

- [x] 0A — Product vocabulary and scope contract
- [x] 0B — Domain and data architecture
- [x] 0C — Authorization and policy model
- [x] 0D — Platform contracts
- [x] 0E — UX foundation
- [x] Phase 0 exit gate accepted

### Phase 1 — Secure SaaS foundation

- [ ] 1A — Repository, environments, and delivery pipeline
- [ ] 1B — Identity and sessions
- [ ] 1C — Workspaces, brands, and tenant isolation
- [ ] 1D — Membership, roles, and invitations
- [ ] 1E — Application shell and personal navigation
- [ ] 1F — Audit, deletion, and recovery primitives
- [ ] Phase 1 exit gate accepted

### Phase 2 — Core work-management engine

- [ ] 2A — Projects and hierarchy
- [ ] 2B — Tasks and relationships
- [ ] 2C — Configurable workflows and fields
- [ ] 2D — Task interaction quality
- [ ] 2E — Inbox and universal capture
- [ ] Phase 2 exit gate accepted

### Phase 3 — Views, planning, time, and capacity

- [ ] 3A — Reusable query and saved-view engine
- [ ] 3B — Core views
- [ ] 3C — Today and manual planning
- [ ] 3D — Time tracking and timesheets
- [ ] 3E — Capacity and cross-brand conflicts
- [ ] Phase 3 exit gate accepted

### Phase 4 — Collaboration, knowledge, files, and notifications

- [ ] 4A — Comments, mentions, following, and reviews
- [ ] 4B — Notification platform
- [ ] 4C — Documents and knowledge
- [ ] 4D — Collaborative editing
- [ ] 4E — Files and deliverables
- [ ] Phase 4 exit gate accepted

### Phase 5 — Search, goals, portfolios, dashboards, and reporting

- [ ] 5A — Permission-aware search
- [ ] 5B — Goals and portfolio management
- [ ] 5C — Metrics model
- [ ] 5D — Dashboards and reports
- [ ] Phase 5 exit gate accepted

### Phase 6 — Integration, API, calendar, and migration platform

- [ ] 6A — Integration framework
- [ ] 6B — Public API and webhooks
- [ ] 6C — Google Calendar
- [ ] 6D — CSV import/export and data portability
- [ ] 6E — MCP-compatible access foundation
- [ ] Phase 6 exit gate accepted

### Phase 7 — AI assistance and briefings

- [ ] 7A — AI gateway, privacy, and budgets
- [ ] 7B — Authorized retrieval and citations
- [ ] 7C — AI drafting and analysis
- [ ] 7D — Change proposal protocol
- [ ] 7E — Daily and weekly briefings
- [ ] 7F — AI-assisted planning and capture
- [ ] Phase 7 exit gate accepted

### Phase 8 — Automations and agent execution

- [ ] 8A — Automation engine
- [ ] 8B — Agent profiles and connectors
- [ ] 8C — Durable agent runs
- [ ] 8D — Approval and review control plane
- [ ] Phase 8 exit gate accepted

### Phase 9 — Development, testing, and release operations

- [ ] 9A — GitHub integration
- [ ] 9B — Test management
- [ ] 9C — Defect lifecycle
- [ ] 9D — Release management
- [ ] 9E — Named launch contexts
- [ ] Phase 9 exit gate accepted

### Phase 10 — Commercial product, onboarding, and administration

- [ ] 10A — Entitlements and billing
- [ ] 10B — Templates and onboarding
- [ ] 10C — Administration console
- [ ] 10D — Support and public information
- [ ] Phase 10 exit gate accepted

### Phase 11 — Completeness and production hardening

- [ ] 11A — Requirements closure audit
- [ ] 11B — Security and privacy verification
- [ ] 11C — Reliability and recovery
- [ ] 11D — Performance and scale
- [ ] 11E — Accessibility and internationalization
- [ ] 11F — Operational readiness
- [ ] Phase 11 exit gate accepted

### Phase 12 — Release-candidate acceptance

- [ ] 12A — Automated launch-acceptance suite
- [ ] 12B — Seeded acceptance environment
- [ ] 12C — Manual QA handoff
- [ ] 12D — UX-research handoff
- [ ] Phase 12 exit gate accepted

## Batch history

| Batch | Briefs | Issued | Accepted | Result |
|---|---|---|---|---|
| P0-W1 | 0A, 0E | Previous cycle | Current cycle | Accepted; validators passed and cross-document relationship disclosure conflict reconciled |
| P0-W2 | 0B | Previous cycle | Current cycle | Accepted; all validators passed, three contract ambiguities reconciled |
| P0-W3 | 0C | Previous cycle | Current cycle | Accepted; authorization validators passed and six source-contract conflicts reconciled |
| P0-W4 | 0D | Previous cycle | Current cycle | Accepted; all contract schemas/examples and full validator suite passed |
| P0-IR1 | Phase 0 integration reconciliation | Previous cycle | Current cycle | Accepted; full integration validator passed and release topology approved |
| P1-W1 | 1A | Current cycle | Pending | Changes requested: remove workspace dependency cycles, add tenant-root foreign keys, and execute container/image gates |

## Decisions and scope changes

Record approved deviations from `BUILD_ROADMAP.md` here without rewriting the source roadmap.

| Date | Decision | Reason | Affected briefs |
|---|---|---|---|
| Current cycle | Tasks require a brand; projects are optional | Resolves the direct TSK-002/TSK-003 conflict while retaining projectless tasks | 0A, 0B, 2B |
| Current cycle | Inbox items may be personal and unbranded until triage | Preserves low-friction capture; operational work still requires a brand | 0A, 0B, 0C, 2E |
| Current cycle | Explicit cross-brand sharing uses revocable record grants; no implicit children | Meets sharing needs without turning relationships or containment into authorization | 0A, 0B, 0C, 1C, 1D |
| Current cycle | Cross-brand associations are allowed, but inaccessible endpoints and derived metadata are fully omitted | Prevents unauthorized existence, count, type, and state disclosure across every read surface | 0A, 0B, 0C, 0E, 2A, 2B |
| Current cycle | Workspace-scoped records are valid and guests receive no implicit workspace access | Reconciles workspace-level documents/goals/files/integrations with brand separation | 0A, 0B, 0C |
| Current cycle | Aggregates disclose only authorized brands and records | Makes counts, reports, search, AI, and capacity permission-safe | 0A, 0C, 0E, 5D |
| Current cycle | Anonymous colleague free/busy disclosure is off by default | Prevents hidden calendar commitments from leaking through availability and conflict calculations | 0A, 0B, 0C, 3E, 6C |
| Current cycle | Shares include only records explicitly selected at share time, never future children | Keeps grants reviewable and prevents silent access expansion | 0A, 0B, 0C, 1C, 1D |
| Current cycle | Phase 0B ADRs accepted, with external delivery described as at-least-once internally and provider-dependent deduplication externally | Avoids false exactly-once guarantees while preserving durable retries and reconciliation | 0B, 0D, 6A, 6B, 8A |
| Current cycle | Phase 0C authorization ADRs and permission matrix accepted | Establishes one server-side, SQL-compilable, deny-by-default policy model for every data and execution surface | 0C and all implementation phases |
| Current cycle | Guests use fixed record grants only; public links and request-access disclosure remain disabled | Prevents inheritance and existence leaks for external collaborators | 0C, 1D, 3A, 4A |
| Current cycle | Departed-member personal data is not administrator-exportable by default | Protects personal-scope privacy unless a later audited legal/commercial capability is approved | 0C, 11B |
| Current cycle | No ordinary application, worker, support, dispatcher, or scheduler role bypasses tenant RLS | Keeps cross-tenant work fail-closed and auditable | 0B, 0C, 1A, 11B |
| Current cycle | Phase 0D platform ADRs, 20 public webhook event types, and reference-only SSE topics accepted | Establishes the shared API, execution, event, delivery, metering, file, and observability contracts | 0D and all implementation phases |
| Current cycle | Short-lived signed URLs have bounded residual access after issuance; revocation blocks new URLs immediately | Reflects actual object-storage behavior; sensitive brands may later require proxied downloads | 0C, 0D, 4E, 11B |
| Current cycle | Phase 0 exit gate passed and initial release topology accepted | All architecture packages and cross-package integration checks pass with zero true blockers | Phase 0, Phase 1 |
| Current cycle | Phase 1 begins provider-neutral with a TypeScript modular monolith, React web client, Node API/worker, and PostgreSQL | Keeps local and CI implementation moving without prematurely locking hosting, region, or secret-store vendors | 1A and later implementation phases |
| Current cycle | Phase 1A schema name `exec` accepted; missing `workspace_id` foreign keys rejected | `exec` matches the authoritative model, while tenant rows must retain database-enforced workspace existence | 1A, 1C |
| Current cycle | Phase 1A cannot pass with a package-manager dependency cycle or an unexecuted production-image gate | Clean dependency ordering and the actual deployable artifact are foundation acceptance requirements | 1A |
