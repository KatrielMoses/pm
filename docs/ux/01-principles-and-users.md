# 1. UX Principles and User Model

[← UX foundation index](README.md)

## 1.1 The product in one sentence (UX view)

A person who runs several brands, possibly with a team, uses one workspace to capture, plan, delegate, review and ship work. Every brand stays separate unless they choose to look across them or share between them. AI, automations, integrations and agents are supervised helpers, never silent actors.

## 1.2 User model

These are *roles in a moment*, not account types. One person can be the founder in the morning, a reviewer at noon and a supervisor of agent runs in the afternoon. Permission roles (owner, administrator, member, limited member, guest, read-only) are defined by 0C and named by 0A ([DEP-0A-03](09-decisions-and-risks.md#dep-0a-03)). This model describes what each person needs from the interface.

### U1 — Multi-brand founder (primary design target)

- **Situation.** Owns or runs two or more brands (for example MailAccess, API Access and Optestra) with one shared pool of personal time. Often works alone or with a small team, on desktop most of the day and on mobile web between commitments.
- **Jobs.** Capture anything instantly. Decide each morning what fits today across all brands. See conflicts between brands' commitments. Delegate to people and agents. Approve what matters. Know what was *actually* accepted, not just claimed.
- **Primary fears.** Doing work for the wrong brand. Sending something externally from the wrong brand. Missing a deadline hidden in another brand. Overspending on AI. An agent "finishing" something that isn't done.
- **Design consequences.** An all-brands home, a cross-brand Today, an ever-visible brand identity, capacity shown against commitments, and approvals gathered in one queue ([J-03](03-journeys.md#j-03-plan-today-across-brands), [J-08](03-journeys.md#j-08-ai-proposes-record-changes-for-selective-approval)).

### U2 — Team member focused on assigned work

- **Situation.** Works inside one brand or a few. Most of their day lives in My Work, a project's task list, and notifications.
- **Jobs.** Know what's assigned and what's next. Update status quickly. Ask questions. Submit deliverables for review.
- **Design consequences.** My Work is the default landing for non-owners ([IA-04](02-information-architecture.md#ia-04)). Brand switching is out of their way when they have only one brand. Inline status and quick updates come before configuration.

### U3 — Administrator configuring the workspace

- **Situation.** Sets up brands, people, roles, workflows, templates, integrations, AI policies, billing and security. Visits rarely but makes high-impact changes.
- **Jobs.** Understand the current configuration. Preview the effect of a change before making it. Change safely. Audit who did what.
- **Design consequences.** The Administration area is separate from daily work ([§7](02-information-architecture.md#7-administration-and-settings-map)). Every access-changing or policy-changing action shows a consequence preview ([ST-30](06-interaction-states.md#st-30)). Configuration screens always show their *scope* (workspace, brand or project).

### U4 — Limited member or guest

- **Situation.** Sees only what was explicitly shared: one project, a few tasks, a document, a deliverable to review.
- **Jobs.** Find the shared items. Do the requested action (comment, upload, review). Leave.
- **Hard constraint.** Must not be able to infer anything unauthorized. That covers other brands' names or count, other projects, record counts, hidden assignees, related-record titles, search snippets and activity mentions ([P-07](#p-07)).
- **Design consequences.** Guests land on a "Shared with me" home ([IA-05](02-information-architecture.md#ia-05)). They have no scope switcher, no workspace-wide navigation and no aggregate counts. The not-available state is identical whether a record does not exist or is not theirs ([ST-41](06-interaction-states.md#st-41)).

### U5 — Reviewer and approver

- **Situation.** Approves deliverables, AI-proposed changes, agent outputs, test results, defect verifications, releases (go/no-go) and time sheets. The founder is often the reviewer; in a team it may be a lead.
- **Jobs.** See everything awaiting their decision in one place. Understand *what* is being approved, *against what criteria*, with *what evidence*. Decide quickly and leave a reason.
- **Design consequences.** A single **Reviews** queue in My Work ([IA-06](02-information-architecture.md#ia-06)) and one review pattern across every reviewable thing ([ST-50](06-interaction-states.md#st-50)). Evidence and acceptance criteria sit next to the decision buttons, not behind tabs.

### U6 — Supervisor of AI, automations, integrations and agents

- **Situation.** Starts AI actions, assigns tasks to agents, relies on automations and integrations, and monitors cost.
- **Jobs.** Know what is running, what is waiting for them, what failed and what it cost. Stop things. Retry safely.
- **Design consequences.** A persistent **Activity tray** in the shell for background work ([IA-12](02-information-architecture.md#ia-12)), the execution-state vocabulary in [§6.3](06-interaction-states.md#3-execution-states-ai-agents-automations-integrations-imports), an emergency stop reachable on every breakpoint ([RS-31](04-responsive-shell.md#rs-31)), and a pre-run cost estimate whenever a run would be expensive ([ST-62](06-interaction-states.md#st-62)).

### Secondary: external participants

Intake-form submitters, public-view readers (if enabled; [UXD-05](09-decisions-and-risks.md#uxd-05)) and email recipients of notifications are not workspace users. Anything they see must be designed as public: the minimum information, nothing that reveals other records.

## 1.3 Principles

Each principle is a test a design review can apply. "Visible at the moment it matters" means visible *without an extra click* at the point a person is deciding or acting.

<a id="p-01"></a>
### P-01 — Brand context is always visible where confusion is possible

Every project, task, document, file, notification, search result, approval and AI or agent action shows its owning brand (the **brand marker**, [DS-40](05-design-system.md#ds-40)). In a single-brand context the shell shows the brand once and rows may omit repeated markers. In any multi-brand context, every row carries its own marker. Anything that sends, publishes or acts externally names the brand inside the confirmation itself.

<a id="p-02"></a>
### P-02 — Aggregation is a lens, not an owner

"All brands" and "selected brands" are filters over records the user may already see. Nothing is *created in* "All brands". Creating something from an aggregated view asks which brand owns it ([IA-21](02-information-architecture.md#ia-21)). Totals in aggregated views are labelled as covering *your accessible brands*, never as workspace totals.

<a id="p-03"></a>
### P-03 — Provenance is shown, not implied

Every record and every statement can answer "where did this come from?" Records show their creation source: typed, captured by email, form, API, integration, AI proposal or agent output. Activity entries show their actor type: person, AI, automation, integration or agent ([DS-44](05-design-system.md#ds-44)). AI answers and briefings cite their sources, and estimated or incomplete data is labelled.

<a id="p-04"></a>
### P-04 — Save state is never ambiguous

At any moment the user can tell whether their change is unsaved, saving, saved, retrying, failed, or in conflict ([§6.2](06-interaction-states.md#2-save-states)). A failed save is never silent and never auto-dismissed. Closing or navigating away from unsaved work warns the user and offers a way to keep it.

<a id="p-05"></a>
### P-05 — Execution state is honest

Running, waiting, partial, failed and cancelled are distinct, visible states. "Finished" is not "accepted". Streaming commentary is not progress, and partial output is not completion. Only accepted or verified outcomes use success styling ([ST-60](06-interaction-states.md#st-60)).

<a id="p-06"></a>
### P-06 — Consequence is proportionate and explicit

The more irreversible, external, financial, access-changing or production-affecting an action is, the more explicit the confirmation, up to requiring another person's approval ([§6.6](06-interaction-states.md#6-confirmation-tiers)). Reversible actions are fast and undoable rather than confirmed.

<a id="p-07"></a>
### P-07 — Permission boundaries are silent, not leaky

The interface never reveals the existence, name, count, snippet, relationship or activity of records the user cannot access. Hidden things are *absent*, not greyed out or labelled "1 hidden item". Limits the user *can* know about (for example "you can view but not edit") are shown plainly, with the reason.

<a id="p-08"></a>
### P-08 — Core work never depends on optional layers

Capture, planning, task updates, comments and reviews work when AI, an integration or an automation is down. Optional-layer failures degrade their own surfaces and leave the rest of the screen alone ([ST-45](06-interaction-states.md#st-45)).

<a id="p-09"></a>
### P-09 — One pattern per kind of action

Equivalent actions behave identically everywhere. Approving a deliverable, an AI proposal, an agent output and a release decision share one review pattern. Bulk actions, undo, inline editing, filters and detail opening behave the same in every list-like view. A new interaction model needs a recorded reason ([P-09 exceptions](09-decisions-and-risks.md#3-ux-decision-register)).

<a id="p-10"></a>
### P-10 — The browser is respected

URLs are meaningful and shareable within permissions. Back and Forward do what users expect. Reload restores what they were looking at. Opening something in a new tab works. View state (filters, sort, grouping, selection where safe, scroll) survives navigation ([RS-20](04-responsive-shell.md#rs-20)).

<a id="p-11"></a>
### P-11 — Accessible and responsive by construction

Every interaction works with keyboard alone, with a screen reader, at 400% zoom, with reduced motion, and on a touch screen. Drag, hover, colour and gestures are shortcuts, never the only path ([07](07-accessibility.md)).

<a id="p-12"></a>
### P-12 — Calm by default, dense on request

Defaults suit a founder scanning across brands: clear hierarchy, few simultaneous alerts, progressive disclosure of advanced fields. Power users can opt into compact density, keyboard-first operation and saved views without the defaults becoming cluttered.

## 1.4 Visible-at-the-moment-it-matters checklist

Use this in design and code review. For each screen or flow, confirm the user can see each item at the point listed, without an extra interaction.

| Must be visible | At the moment of… | Rule |
|---|---|---|
| Owning brand | Creating, editing, sharing, sending, publishing, approving, running AI/agent | P-01, [IA-20](02-information-architecture.md#ia-20) |
| Active scope (one brand, selected brands, all) | Reading any aggregated list, total or chart | P-02, [IA-22](02-information-architecture.md#ia-22) |
| Data provenance and freshness | Trusting a number, briefing statement, AI answer or synced field | P-03, [ST-47](06-interaction-states.md#st-47) |
| Save state | Leaving a field, form, document or page | P-04, [§6.2](06-interaction-states.md#2-save-states) |
| Execution state | Deciding whether work is done, waiting or failed | P-05, [§6.3](06-interaction-states.md#3-execution-states-ai-agents-automations-integrations-imports) |
| Audience and access consequence | Inviting, sharing, changing roles, making public | P-06, P-07, [ST-30](06-interaction-states.md#st-30) |
| Cost and remaining allowance | Starting an expensive AI or agent run, approving extra usage | [ST-62](06-interaction-states.md#st-62) |
| Approval criteria and evidence | Accepting, rejecting, going/no-going | [ST-50](06-interaction-states.md#st-50) |
