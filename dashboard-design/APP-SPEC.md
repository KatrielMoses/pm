# Product prototype spec: the whole app in "Paper"

Katriel locked Round 1 design **02 Paper** (2026-10-06). The full product is built in that
language at **http://localhost:4400/app**. Each page borrows its *structure* from a different
inspiration (or Round 1 mockup) but is drawn strictly in Paper.

## Paper language (non-negotiable)

- Canvas → rounded frame → white cards (radius 24) and sub tiles (radius 18, `--sub`).
- Everything is a pill: tabs (segmented, black active), buttons, badges, the rail, the switcher.
- **One ink hero per page** (`--ink` tile: black in light mode, warm white in dark). The thing
  that needs attention lives there.
- Big confident numbers (52 / 34 / 22 px, weight 700, tight tracking, tabular).
- Over capacity = red hatch. Free = grey hatch. Planned = ink. Today / current = accent (`--k1`).
- Accent is ONLY `var(--k1)` / `--k1-ink` / `--k1Soft` / `--k1Text` (it changes with the brand's
  identity kit). Neutrals and status colours ONLY from tokens in `app/app/paper.css`
  (`--canvas --frame --card --sub --sub2 --line --line2 --text --text2 --mute --faint --ink
  --ink-text --red --redSoft --green --greenSoft --amber --amberSoft --blue --blueSoft`, hatches,
  radii `--r-*`). **No raw hex in page CSS**, so dark mode (moon icon, top right) just works.
- Minimal text. Labels 1–3 words. No helper sentences. Numbers and graphics talk. Status always
  carries a word (not only colour). Brand = rounded-square `<BrandChip>`; status = pill.
- Motion: cards `fadeUp` with small staggered `animationDelay`; bars `anim-grow-y/x`; live dots
  pulse; drawers slide.

## Building blocks (use them; don't re-invent)

- `components/paper/ui.tsx`: `Card` (title/icon/actions), `Tile` (`hero` for ink), `PageHead`
  (title, count, right-side actions), `Badge` (tones), `StatusBadge`, `HealthBadge`, `Priority`,
  `Button` (dark/light/ghost/accent/danger/text · sm/md/lg), `IconButton`, `Segmented` (pill
  tabs; `sub` variant for inside cards), `SearchField`, `Checkbox`, `Toggle`, `Kbd`, `Avatar`
  (people + agents), `AvatarStack`, `CapacityBar`, `Thin`, `Live`, `Source` (citation chip),
  `Empty`. Raw classes via `u` (e.g. `u.table`, `u.tableWrap`, `u.big`, `u.num`, `u.cap`).
- `components/charts.tsx`: `Bars`, `Spark`, `Ring`, `Gauge`, `Heat`, `Dots`, `Meter`, `Stack`,
  `Ticks`, `CountUp`, `series`.
- `components/brand.tsx`: `BrandChip`, `BrandDot`, `brandColor(id)` (brand's own colour, e.g. for
  Gantt bars / calendar blocks), `Logo`.
- State: `useWorkspace()` → `{ brand, setBrand, s }` (brand filter + summary);
  `useApp()` → `{ openTask(id), tasks, updateTask(id, patch), toast(text), setCapture, setPanel('ai'),
  timer, mode }`. Any task row/card click should `openTask(task.id)` (the shared drawer).
- Data: `lib/app-data.ts` (tasks, people, calendar, plan, inbox, goalsFull, docs, agents, runSteps,
  proposedChanges, releases, suites, defects, automations, integrations, apiTokens,
  webhookDeliveries, notifications, activity, workload, timesheet, reports, billing, templates,
  helpers `byBrand`, `fmtMin`, `dueLabel`, `projectById`, `personById`, `tasksFor`) and
  `lib/data.ts` (projects, runs, release, goals, week, throughput, heat, NOW, USER…). Always filter
  by the active brand with `byBrand(rows, brand)` (or `.filter(t => !brand || t.brand === brand)`).
- Reference implementation: `app/app/page.tsx` + `home.module.css` (Home).

## Pages, features (from FEATURES.md) and structural inspiration

Inspirations live in `inspirations/`; Round 1 mockups in `designs/dNN/` (run at `/mockups/N`).

| Route | Must cover | Structure from |
|---|---|---|
| `/app/today` | Today across brands, overdue separate, meetings, available vs estimated time, over-capacity warning, AI-proposed plan with **reason per item**, deferred list, accept / edit / reject plan, locked items, focus blocks, shutdown routine, planned vs done | Top "schedule rail" pill with now-marker (`fbf4459a…`, mockup 07) + KPI tiles + right day timeline (`d9a1e65e…`, mockup 11) |
| `/app/inbox` | Captured items with source icon (voice/email/form/github/typed), detected brand/project/due/priority chips, low-confidence asks, duplicate warning + merge, triage to task/note/project/discard, bulk select | Folder tabs with counts + triage cards (`31949ae3…`, mockup 18); selected item opens ink detail panel (`b097a6b1…`) |
| `/app/my-work` | My Work, Assigned by me, Following, Recently viewed, favourites/pinned; group by status (collapsible), table/list toggle | Grouped collapsible list (`bb2685a4…`), table/kanban/list tabs + counted title (`b9d55a6e…`) |
| `/app/calendar` | Week (default) + day/month/agenda switch, tasks vs meetings vs focus vs deadlines, Google sync state, conflicts highlighted, now line, unscheduled tray to drag onto grid, working hours shading | Left "Today" to-do column + week grid with card events (`a2f27a4a…`), filter pills + now-line pill (`c4c7a5c2…`) |
| `/app/projects` | Portfolio of all projects: health, progress, due, open/blocked/overdue, planned vs actual hours, owner; grid ↔ table; filter by health; create project (incl. from template / AI draft) | Card grid with cut-corner arrow buttons (mockup 07) + table view; ink detail panel on select (mockup 12) |
| `/app/projects/[id]` | Project header (brand, health, progress, due, owner); tabs **Overview** (success criteria, risks, decisions & open questions, milestones, latest verified update, budget/time/AI budget), **Board** (kanban, drag between status columns via HTML5 DnD → `updateTask`), **List**, **Timeline**, **Docs**, **Activity** | Kanban from `58a6c6be…` (weihu: tag chips, dot progress, avatars, counts) + mockup 09, drawn in Paper |
| `/app/timeline` | Portfolio Gantt across brands, milestones, dependencies, now line, health, zoom week/month/quarter | `99198827…` top Gantt + mockup 08 |
| `/app/goals` | Workspace/brand goals, KRs, baseline/current/target, confidence, trend, linked projects, projects without goals / goals without work | Coloured goal cards with mini charts (`9251223a…`, `4b333485…`), Monex bars (`70968e0f…`) |
| `/app/agents` | Agent profiles (scope, model, tools, approval policy, budget), run queue with states (queued/running/waiting/failed/ready for review/accepted), run detail with step log + cost, review: accept / reject / request changes, proposed changes diff, **emergency stop** | List + detail split (`6483e2cb…`), usage gauge (`3c82df68…`, mockup 17) |
| `/app/releases` | Release list, readiness (scope, excluded, blockers), checklist stepper, test suites (pass/fail/flaky/skipped + history), defects (severity, status merged vs verified), environments, **go / no-go** with approver | Tracking stepper + heatmap (`original-93f5…`, mockup 16) |
| `/app/reports` | Dashboards: throughput, created vs completed, cycle time, task aging, time in status, planned vs actual by brand, deliverables accepted/pending/rejected, agent success, AI cost; date + brand filters; data freshness; export | Big-number + density band (`f62f9275…`, mockup 06), heat-grid (`6ff20e92…`) |
| `/app/workload` | Capacity per person and per brand, day/week view, over/under allocation, time off, timesheet (billable), founder capacity across brands | Dot matrices (`1fcdefde…`, mockup 20), bubble chart (mockup 13) |
| `/app/knowledge` | Doc tree by brand, doc types, status (draft/current/stale/archived), owner + review date, **approved AI source** toggle, stale-context warning, doc view with version history, linked records | Collapsible sidebar (`bb2685a4…`), card grid with one ink card (`61a6c1ab…`) |
| `/app/automations` | Trigger → conditions → actions builder (visual), templates, enable/disable, run history with errors, usage vs limit, loop protection, preview before activation | Outlined flow blocks (`0c3231a0…`, mockup 14) drawn in Paper |
| `/app/integrations` | GitHub, Google Calendar, Test results, Webhooks (delivery log, retries), MCP, CSV, Slack (off); status, owner, last sync, test / reauth / disconnect; API tokens with scopes, rotate/revoke | Card grid (`31949ae3…`) + table |
| `/app/settings` | Tabs: Workspace, **Brands & identity kits** (upload logo → 3 colours → live preview of the theme), Members & roles (incl. guests, effective permissions preview), AI & limits (providers, hard cap, allowances), Billing & usage (meters, invoices, plan), Notifications (per event × channel, quiet hours), Security (MFA, sessions), Import/Export | Team switcher (`b9d55a6e…`), Dark/Light/System segmented (`bb2685a4…`), usage gauge (`3c82df68…`) |
| `/app/onboarding` | Guided setup steps (workspace → brands → first project → connect GitHub/Calendar → template), skip, progress, template picker with preview | Colourful pick cards (`4b333485…`, `b10f7c56…`) in Paper |

## Interaction minimums

Every page: brand filter respected; rows/cards open the task drawer where they are tasks; at
least one real interaction (tabs switch content, toggle works, drag works, selection updates a
panel, buttons toast). Empty states for filtered-out data. Fits 1440 × 900 without horizontal
scroll; vertical scroll is fine for long pages.
