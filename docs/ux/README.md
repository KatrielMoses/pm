# UX Foundation (Phase 0E)

Status: **accepted** (Phase 0E, P0-W1); accepted at the Phase 0 exit gate (P0-IR1; [exit-gate report](../architecture/PHASE_0_EXIT_GATE.md)).

This folder is the product-design contract for the multi-brand work-management application described in [`FEATURES.md`](../../FEATURES.md). Later phases implement against it. It defines *how the product behaves* — structure, navigation, states, accessibility, responsive behavior and design-system foundations. It does not define final visual polish, the product name, data schemas, APIs or authorization algorithms.

## Documents

| # | Document | What it settles | Primary consumers |
|---|---|---|---|
| 1 | [Principles and user model](01-principles-and-users.md) | Who we design for, and the ten rules every screen must follow | Everyone |
| 2 | [Information architecture](02-information-architecture.md) | Navigation, hierarchy, scope switching, URLs, search, notifications, admin map | 1C, 1E, 5A, 4B, 10C |
| 3 | [Core journey maps](03-journeys.md) | Twelve journeys with happy, alternate and recovery paths | Every feature phase; 12D |
| 4 | [Responsive application shell](04-responsive-shell.md) | Breakpoints, shell layouts, detail opening, history, mobile adaptations, parity | 1E, 3B |
| 5 | [Design-system foundation](05-design-system.md) | Tokens, themes, brand-identity rules, component behavior, density | 1E and all UI work |
| 6 | [Interaction and state standards](06-interaction-states.md) | Save/execution/page states, confirmation tiers, validation, review patterns, focus | All UI work |
| 7 | [Accessibility baseline](07-accessibility.md) | WCAG 2.2 AA rules as testable criteria, pattern specs, test protocol | All UI work; 11E |
| 8 | [Internationalization and time](08-i18n-and-time.md) | Timezones, locale formatting, relative time, text expansion | 1E, 3C, 6C, 11E |
| 9 | [Decision and risk register](09-decisions-and-risks.md) | Open UX decisions with defaults, 0A dependencies, risks | Product owner, solutions architect |
| — | [`tools/`](tools/) | Repeatable checks: token contrast and documentation links | Reviewers, 1E |

Phase 1E implementation notes: the shell, the route registry, the key map, view-state ownership, and the accepted deviations are recorded in [ADR-0012](../engineering/adr/0012-application-shell-navigation.md). Region navigation is by skip links and permission-filtered palette actions; F6 is not bound ([A11Y-KB-04](07-accessibility.md#a11y-kb-04), with [A11Y-KB-07](07-accessibility.md#a11y-kb-07) controlling; reconciled in RS-12, RS-33, and A11Y-PA-11). The token contrast gate (DS-21) also runs as `scripts/test/web-design-tokens.test.mjs` against the stylesheet.

Suggested reading order: 1 → 2 → 4 → 6 → 5 → 7 → 8 → 3 → 9. Journeys (3) are the most useful once the rules they apply are familiar.

## Conventions used across this set

**Normative language.** *Must* is a requirement that later implementation will be accepted against. *Should* is the default; deviating needs a recorded reason. *May* is permitted.

**Identifiers.** Rules carry stable IDs so later briefs and test plans can cite them.

| Prefix | Meaning | Defined in |
|---|---|---|
| `P-nn` | UX principle | [01](01-principles-and-users.md) |
| `IA-nn` | Information-architecture rule | [02](02-information-architecture.md) |
| `J-nn` | Journey map | [03](03-journeys.md) |
| `RS-nn` | Responsive/shell rule | [04](04-responsive-shell.md) |
| `DS-nn` | Design-system rule | [05](05-design-system.md) |
| `ST-nn` | Interaction/state rule | [06](06-interaction-states.md) |
| `A11Y-xx-nn` | Accessibility acceptance criterion | [07](07-accessibility.md) |
| `I18N-nn` | Internationalization/time rule | [08](08-i18n-and-time.md) |
| `UXD-nn` | Open UX decision with recommended default | [09](09-decisions-and-risks.md) |
| `DEP-0A-nn` | Dependency on Phase 0A vocabulary | [09](09-decisions-and-risks.md#2-dependencies-on-phase-0a) |
| `UXR-nn` | UX risk | [09](09-decisions-and-risks.md#4-ux-risk-register) |

**Requirement references.** Phase 0A's requirement catalog ([`docs/product/requirements/`](../product/requirements/README.md)) arrived during this work and is now accepted (P0-W1). This set still cites `FEATURES.md` by section name, for example *FEATURES › Today and planning*. Replacing those citations with catalog IDs is a mechanical follow-up and changes no meaning (tracked as [UXD-24](09-decisions-and-risks.md#uxd-24)).

**Provisional vocabulary.** Terms such as *brand*, *Inbox item*, *Today commitment*, *scheduled work block*, *deliverable*, *acceptance* and *agent run* follow their plain reading in `FEATURES.md`. Where 0A could reasonably define a term differently, the text marks it with its `DEP-0A-nn` ID. If 0A resolves a term differently, the UX rule follows 0A; the interaction rule itself does not change. This set has been reconciled against 0A's proposal in [`docs/product/`](../product/README.md). The status of each dependency, and the one conflict left for review ([UXD-28](09-decisions-and-risks.md#uxd-28)), are in [09 §2.1](09-decisions-and-risks.md#21-reconciliation-with-the-0a-proposal).

**Placeholders.** `{Product}` stands for the undecided product name. URL shapes are illustrative of *browser behavior* (what is addressable, what survives reload). Route syntax belongs to 1E, and identifiers to 0B.

**Boundaries with other Phase 0 work.**

| Topic | This set defines | Owned elsewhere |
|---|---|---|
| Terminology, lifecycles, state meanings | How each state is *displayed* and what the user can do in it | 0A defines what each state *means* |
| Records, IDs, relationships | Which views are addressable and how they are linked | 0B |
| Permissions | What the UI must never reveal; how denied and limited access look | 0C evaluates access |
| Async jobs, errors, events | How each job/error/event state is presented | 0D defines states and envelopes |

## How this set meets the brief

| Brief deliverable | Where |
|---|---|
| 1. UX principles and user model | [01](01-principles-and-users.md) |
| 2. Information architecture | [02](02-information-architecture.md); destination coverage matrix in [§9](02-information-architecture.md#9-destination-coverage-matrix) |
| 3. Core journey maps (12 required) | [03](03-journeys.md) — J-01 to J-12 |
| 4. Responsive application shell | [04](04-responsive-shell.md); view adaptation and parity in [§7](04-responsive-shell.md#7-complex-view-adaptations) and [§8](04-responsive-shell.md#8-feature-parity-tiers) |
| 5. Design-system foundation | [05](05-design-system.md) |
| 6. Interaction and state standards | [06](06-interaction-states.md); per-component state matrix in [§12](06-interaction-states.md#12-reusable-state-matrix) |
| 7. Accessibility baseline | [07](07-accessibility.md); WCAG 2.2 traceability in [§10](07-accessibility.md#10-wcag-22-aa-traceability) |
| 8. Internationalization and time display | [08](08-i18n-and-time.md) |
| 9. UX decision and risk register | [09](09-decisions-and-risks.md) |

## Verification

```sh
python3 docs/ux/tools/check_contrast.py   # verifies every colour pairing in 05 against WCAG thresholds
python3 docs/ux/tools/check_docs.py       # verifies internal links/anchors and destination coverage
```

Both scripts use only the Python standard library and exit non-zero on failure.
