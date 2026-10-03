# Requirement catalog

The catalog gives every checklist item in [`FEATURES.md`](../../../FEATURES.md) a permanent ID and maps it to the roadmap. It does **not** change scope: the requirement text is copied verbatim, and `FEATURES.md` remains authoritative.

| File | Role |
|---|---|
| [catalog.json](catalog.json) | **Authoritative, machine-readable catalog.** Edit mappings here. |
| [catalog.md](catalog.md) | Generated human-readable tables, one per source section. Do not edit by hand. |
| [summary.md](summary.md) | Generated counts by type, section, and sub-phase; concern counts; every flag; decision cross-reference. Do not edit by hand. |
| [../tools/reqcat.py](../tools/reqcat.py) | Validator, renderer, and maintenance commands (Python 3.8+, standard library only). |

## Entry fields

| Field | Meaning |
|---|---|
| `id` | `<PREFIX>-<NNN>`. The prefix identifies the source section (`section_prefixes` in catalog.json), and the number is the item's original position. **Permanent:** never renumbered, never reused. |
| `type` | `product` (661 items) or `launch-acceptance` (the 23 items under *Launch acceptance requirements*). |
| `text` | Exact source wording. The validator fails if it differs from `FEATURES.md`. |
| `source` | `file`, `section`, `position` (1-based within the section), `line` in FEATURES.md. |
| `owner_subphase` | The **one** roadmap sub-phase accountable for delivering the requirement. For launch-acceptance items this is 12A (executable acceptance), and the contributors build the capability. |
| `contributing_subphases` | Other sub-phases that must deliver part of it (e.g., the foundation, or the later phase that extends it). |
| `concerns` | Cross-cutting contracts the implementation must satisfy (vocabulary below). |
| `flags` | Ambiguity, conflict, duplication, missing decision, or roadmap gap, with a note and, where relevant, an [open-decision](../open-decisions.md) ID. |

### Owner assignment conventions

- Owners come from the sub-phase descriptions in `BUILD_ROADMAP.md`. Where no sub-phase names a requirement, the closest owner was chosen and a `roadmap-gap` flag was added for the architect.
- Cross-cutting quality requirements (accessibility, timezone correctness, security hardening) are **owned by the Phase 11 verification sub-phase** and list their foundation sub-phase (0E, 1A, 1B…) as a contributor. Every feature sub-phase must still meet them for its own UI; the owner proves closure.
- An owner assignment is a plan, not evidence of completion (11A performs the closure audit).

### Concern vocabulary

| Concern | The requirement touches… |
|---|---|
| `authorization` | Who may see or do something; sharing, guests, scopes, tokens, sessions |
| `audit` | Recorded history, approvals, decisions, provenance, previous values |
| `notification` | Notifications, reminders, alerts, digests, warnings, briefing delivery |
| `accessibility` | Keyboard, screen reader, focus, contrast, responsive, drag-and-drop alternatives |
| `reliability` | Retries, idempotency, sync, failure handling, saving, performance under load |
| `privacy` | Personal or customer data handling, retention, deletion, secrets, training use |
| `usage-metering` | Metered usage, limits, budgets, costs, storage, billable time, plan limits |
| `export` | Data leaving the product as files |
| `degraded-mode` | Behavior when AI, integrations, or a job fail or are unavailable |
| `brand-context` | Brand identity, separation, or aggregation |
| `actor-provenance` | Non-human actors (AI, agent, automation, integration) or record source |
| `time-semantics` | Dates, schedules, timezones, recurrence, capacity |
| `i18n` | Locale formatting and future localization |
| `launch-gate` | A launch acceptance requirement |

Concern tags were seeded by section and keyword rules and spot-reviewed. They are a starting checklist for briefs, **not** an exhaustive impact analysis. Brief authors should add concerns they discover.

### Flag types

| Flag | Meaning |
|---|---|
| `conflict` | Two source requirements cannot both be true as written |
| `ambiguity` | The wording admits materially different implementations |
| `duplication` | The same capability appears under several IDs. All IDs remain; implement once and trace all of them. |
| `missing-decision` | A product, commercial, legal, or numeric decision is needed |
| `roadmap-gap` | No roadmap sub-phase clearly owns it, or the phase order makes completion depend on a later phase |

## Commands

Run from the repository root:

```sh
python3 docs/product/tools/reqcat.py validate     # all checks below; exits 1 on any error
python3 docs/product/tools/reqcat.py render       # regenerate catalog.md and summary.md
python3 docs/product/tools/reqcat.py relocate     # refresh line/position after FEATURES.md edits that move items
python3 docs/product/tools/reqcat.py add-missing  # assign next free IDs to new FEATURES.md items (owner = TBD)
```

`validate` fails on:

- duplicate, malformed, or retired-but-active IDs, and IDs whose prefix doesn't match their section;
- any FEATURES.md item missing from the catalog, or any catalog entry whose text no longer matches a source item;
- identical items within one FEATURES.md section (they could not be told apart);
- stale source line or position;
- a wrong `type`, or count mismatches between catalog, FEATURES.md, and the counts stated in BUILD_ROADMAP.md (661 + 23);
- an owner or contributor that is not a `### NX.` sub-phase in BUILD_ROADMAP.md; owner `TBD` (unmapped); unknown concerns or flag types;
- flag decisions, or `OD-` references in any `docs/product` document, that are missing from open-decisions.md;
- requirement IDs referenced in any `docs/product` document that are not in the catalog;
- generated catalog.md or summary.md being out of date.

## Change process when FEATURES.md changes

1. **Item added:** run `add-missing`. It receives the next unused number in its section and an owner of `TBD`. Set the owner, contributors, concerns, and flags, then run `render` and `validate`.
2. **Item reworded:** validation reports one missing and one extra item. If the meaning is unchanged, update `text` on the existing entry to keep its ID. If the meaning changed, move the old entry to `retired` (with a reason) and add the new one.
3. **Item removed:** move the entry to `retired` with `{ "id", "text", "reason", "date" }`. Its ID is never reused.
4. **Items reordered:** run `relocate`. IDs do not change.
5. **New section:** add it to `section_prefixes` before running `add-missing`.
