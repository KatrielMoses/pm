# Dashboard design brief

Distilled from `FEATURES.md` (790 lines, 33 sections) and the existing functional design system in
`docs/ux/05-design-system.md`. Every mockup round is judged against this.

## What the product is

A multi-brand work OS for a founder running several companies (MailAccess, API Access, Optestra),
sold later as SaaS. Project, program and portfolio management, plus AI agents, dev/test/release
evidence and capacity planning.

## The six ideas the UI must express

1. **Brand is the spine.** Every record shows its brand. You can switch between one brand and all
   brands, and filter by several at once. Brand markers are rounded squares, status badges are
   pills, so a brand never looks like a status (DS-06, DS-41).
2. **One founder, finite hours.** Today, capacity and conflicts across brands are first-class:
   available time vs. committed estimates, over-capacity warnings, focus blocks, deferred work.
3. **Evidence over claims.** The UI separates *claimed* from *accepted/verified*: deliverables,
   agent runs, "code merged" vs. "defect verified", latest *verified* update, source-linked
   briefings. This is the product's character and the main visual differentiator.
4. **AI is scoped, previewed and priced.** A scope chip (brand/project) before every AI action,
   citations, proposed changes as a reviewable diff (approve / edit / reject per change), cost
   shown before expensive runs, hard limits.
5. **Agents are workers with states.** Queued, running, waiting, failed, cancelled, ready for
   review, accepted. Review queue, emergency stop, audit trail.
6. **Ship loop built in.** GitHub PRs/CI, test cases and evidence, defects, release readiness,
   go/no-go approval.

## Surfaces to design (priority order)

| # | Surface | Why it matters |
|---|---|---|
| 1 | **Owner home (all brands)** | First screen; tests brand identity, density, cards, health, briefing |
| 2 | Today / daily plan | Capacity bar, schedule + task list, AI plan with reasons |
| 3 | Project (overview + list/board) | The workhorse screen |
| 4 | Task detail panel | Dense fields, acceptance criteria, evidence, timer, comments |
| 5 | Portfolio / goals | Health across brands, risks, budgets, timeline |
| 6 | Inbox / capture + command palette | Speed and keyboard feel |
| 7 | Agent runs + review queue | Run states, diff review, cost |
| 8 | Release readiness | Blockers, test evidence, approvals |
| 9 | AI briefing | Source-linked statements, corrections |
| 10 | Settings / billing usage | Usage meters, limits |

## Hard constraints (already decided)

- Light, dark and system themes; compact and comfortable density.
- WCAG 2.2 AA contrast; colour is never the only status signal.
- Breakpoints 600 / 1024 / 1440; sidebar 248 px, collapsed rail 64 px; header 56 px.
- 4 px spacing base; radii 4 / 6 / 12 / full; tabular numerals for numbers, money, timers.
- Navigation: Today, Inbox, Projects, Calendar, Knowledge, Goals, Reports, Settings.
- Typeface, hues and illustration style are open (the current system-font, blue `#1D5BD6` set is a
  placeholder that a visual pass may replace, as long as the contrast pairs still pass).

## Identity kits (decided 2026-10-06)

- Each brand, project or customer company loads an **identity kit**: three colours from its logo
  (primary, secondary, tertiary). The dashboard re-themes to that kit.
- Logos are often one colour plus white or black, so the app derives the theme rather than using
  raw colours: the most saturated colour becomes the accent, missing accents are generated from
  its hue, and readable ink is computed for each (`lib/kits.ts`, `deriveTheme`).
- Only accents change. Neutrals (canvas, surfaces, text, lines) stay fixed per theme, so contrast
  and legibility hold for any logo.
- Customers who skip the kit get the product's own palette (still to be chosen; each Round 1
  design proposes one as its "house" kit).

## Visual principles (decided 2026-10-06)

- Minimal, to the point, clean. No fluff text; labels of 1 to 3 words.
- Graphics, motion and clear values do the talking; every card leads with a number or a visual.
- One highlighted hero per screen; key points (over capacity, blockers, failures, needs you)
  always stand out.
- Name and logo are placeholders until decided.

## Mockup process

- Next.js app in this folder: `npm run dev`, then http://localhost:4400/mockups (gallery) and
  `/mockups/1` to `/mockups/20`.
- Each round: 20 mockups of the **same screen** (owner home) so designs compare like for like.
  Round 1 brief: [ROUND-01-SPEC.md](ROUND-01-SPEC.md).
- Shortlist, refine, repeat, then lock the winner into `design.md` for the product.
