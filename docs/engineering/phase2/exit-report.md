# Phase 2 integration review and exit gate (P2-IR1)

Status: **developer review complete; awaiting product-owner acceptance.** This report is not
accepted until the product owner records P2-IR1. Nothing is merged, and ADR-0013 to ADR-0017 stay
proposed.

Candidate: the accepted Phase 2E head `c764532` (2A–2E, migrations 0021–0030), plus the narrow
integration fixes listed below on `phase-2-integration-review`.

## Exit gate

| Evidence | Where |
|---|---|
| One person, from nothing, across 2A–2E at desktop, tablet, and mobile, on real web/API/worker processes and PostgreSQL. Axe runs at every major state, including forced colours. Capture works keyboard-only. Pages reflow at 320 px, at 599/600/1023/1024 px, and at 200% zoom. No sleeps, retries, skips, or longer timeouts. | `e2e/phase2-exit-journey.spec.ts` |
| Cross-surface authorization and isolation matrix (see below) | `packages/work/test/integration/phase2-matrix.test.ts` |
| Migrations stepped through every accepted boundary, including the Phase 2 boundaries 0021–0030. Each step matches the one-shot catalog, reverses to the prior boundary's exact catalog, and re-applies. | `packages/db/test/integration/migrations.test.ts` |
| Requirement closure per subphase, plus the aggregate Phase 2 closure check, run in verify gate 2 | `docs/engineering/phase2/closure*.json`, `docs/engineering/tools/phase2.py` |

### Journey steps

1. Sign in, create a workspace and a brand, and create the project Launch.
2. Capture opens and closes from every shell route (home, projects, a project, tasks, Inbox, notes,
   forms, workflow settings) with nothing configured.
3. Capture "Draft pricing page tomorrow !high 1h". The detected tokens are explained, and the item
   is saved to the Inbox with its original text.
4. Triage it into Launch. The resulting task shows its intake source.
5. Work the task: checklist, subtask, reminder, and a daily repeat.
6. In the project list, add tasks, reorder by keyboard (Move to top), then bulk-set priority with a
   preview. Apply it, then Undo.
7. Accessibility checks:
   - Capture opens from the keyboard, focus lands in the text field, and Escape returns focus to
     the opener;
   - forced colours and reduced motion pass axe;
   - pages reflow at every width class.

The subphase suites still own their deeper journeys: `projects`, `tasks`, `workflows`,
`task-interaction`, `capture`, and `collaboration` specs.

## Authorization and isolation matrix

There are three workspaces. The roles are:

- owner, administrator, member, limited member, and read-only;
- a share-only user (record share, edit);
- a guest (record share, comment).

The fixtures are:

- a sensitive brand, granted to the owner only;
- a restricted project;
- a brand-specific custom workflow;
- a manage-level hidden field;
- open, restricted, secret, and shared tasks.

| Check | Result |
|---|---|
| Every surface agrees with the read decision: task read, signals, lists, duplicate candidates, bulk preview, reminders, history, record fields, triage into a restricted project | pass |
| Capture parsing resolves a restricted project only for those who can read it | pass |
| Cross-workspace identifiers are `not_found` | pass |
| Suspended and removed users: the removed member's reminders are cancelled, and the suspended owner's series pause | pass |
| Permission lost between preview and apply (bulk, triage, template apply, workflow transition) is refused at apply | pass |
| Hidden versus unknown has the same response, the same statement shape, and timing within the shared threshold (task read, task signals, triage into a hidden brand) | pass |

## Integration defects found and fixed

1. **Statement-shape leak on hidden records with custom workflows.**
   - The problem: `loadTask` and `loadProject` primed status rows *before* the read decision. A
     task in a brand with a custom workflow therefore ran one more `SELECT` than an unknown
     identifier, which revealed that the record exists.
   - The fix: statuses are now primed only after authorization (`packages/work/src/task-core.ts`,
     `packages/work/src/service.ts`).
   - Proof: the matrix's constant-shape test.
2. **Capture opened with focus on a radio button instead of the text field.**
   - The problem: the dialog's initial-focus rule matched only `input`.
   - The fix: `[data-initial]` now takes precedence, and the Capture text area sets it
     (`apps/web/src/ui/dialog.tsx`, `apps/web/src/ui/form.tsx`).
   - Proof: the exit journey's keyboard-only step.

No contract drift, migration incompatibility, or cross-surface UX break needed any other change.

## Closure

`phase 2: integration closure (2A-2E, deferrals explicit)` fails if any of these is true:

- an owned requirement is not closed exactly once, by its owner;
- a contribution is marked `implemented`;
- a closure lists a requirement its subphase neither owns nor contributes to;
- a `foundation` (deferred) disposition does not name the subphase that completes it.

| Subphase | Owned | Contributions | Implemented | Foundation (deferred) |
|---|---|---|---|---|
| 2A | 20 | 8 | 20 | 0 |
| 2B | 19 | 5 | 19 | 0 |
| 2C | 17 | 3 | 17 | 0 |
| 2D | 15 | 2 | 15 | 0 |
| 2E | 15 | 5 | 14 | 1 (CAP-006: the email source kind is adapter-ready; forwarding is 6A, OD-29 open) |
| **Total** | **86** | **23** | **85** | **1** |

### Explicit deferrals

These are out of scope by brief and are not marked implemented:

- Phase 3 views, planning and capacity;
- 3B board drag;
- 3C work blocks;
- 4A followers;
- 4B delivery;
- 4E file storage;
- 5C rollups;
- 6A/6B adapters, including email forwarding (CAP-006);
- 7F AI and voice;
- 10B catalog.

## Pipeline evidence

The clean-checkout verify results, scanner output, PostgreSQL image digest, production image
ID and size, and the runtime-user check are recorded in the draft PR for the candidate head and in
its CI run.
