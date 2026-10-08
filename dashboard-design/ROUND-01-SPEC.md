# Round 1 spec: owner home dashboard, 20 directions

Run: `npm run dev` in `dashboard-design/`, open http://localhost:4400/mockups.
Each mockup lives in `designs/dNN/` (`index.tsx` + `styles.module.css`) and is routed at `/mockups/N`.

## Non-negotiable principles (from Katriel, 2026-10-06)

1. **Minimal, to the point, clean.** No fluff. No subtitles, helper sentences or marketing copy
   nobody reads. Labels are 1 to 3 words. If a sentence can be a number, make it a number.
2. **Graphics over text.** The inspirations talk through big numbers, bars, rings, gauges,
   heatmaps, dot matrices, timelines and motion. Every card leads with a figure or a visual.
3. **Key points always highlighted.** One hero element per screen (an accent-filled tile, a lit
   bar, a giant number). Over-capacity, blockers, failures and "needs you" must pop.
4. **Colour comes from the identity kit.** Never hard-code the accent. Use `var(--k1)` (accent),
   `var(--k2)`, `var(--k3)` and their `-ink` pairs (readable text on that colour). All-brands
   view uses the design's house kit; selecting a brand swaps to that brand's kit (animated).
   Neutrals (canvas, surfaces, text, lines) belong to the design and stay fixed.
5. **Brand markers are rounded squares** (`<BrandChip>`, always in the brand's own colour);
   status badges are pills. Colour is never the only signal: statuses also carry a word.
6. **Product name and logo are placeholders**: use `<Logo>` / `<LogoMark>` from `components/brand.tsx`.
7. **Real data only.** Every number comes from `useWorkspace().s` (a `summary()` of `lib/data.ts`),
   so switching brand changes the numbers. No invented figures in JSX.
8. **Motion with purpose.** Bars grow, rings draw, numbers count up, cards fade up with a stagger,
   live agents pulse. Use the classes in `app/globals.css` (`anim-*`) and chart primitives.

## The screen: owner home (all brands)

Content to choose from (not every design shows everything, but each shows the essentials):

| Block | Data | Must show |
|---|---|---|
| Today / capacity | `s.committed`, `s.available`, `s.over`, `s.today`, `s.todayDone`, `s.week` | committed vs free hours, over-capacity warning |
| Needs you | `s.needsYou`, `s.review`, `s.failed`, release decision | count + breakdown |
| Portfolio health | `s.active`, `s.health`, `s.projects` | on / risk / off |
| Agents | `s.runs`, `s.running`, `s.review`, `s.failed` | live state |
| Release | `s.release` (null when brand has none) | pass rate, blockers, go/no-go |
| Throughput | `s.throughput` (12 weeks), `weeksLabels` | trend + current week |
| Briefing | `s.briefing` | 3 to 4 source-linked lines |
| AI spend | `s.ai.spent`, `s.ai.cap` | spend vs cap |
| Goals | `s.goals` | progress |
| Brand switcher | `brands`, `brand`, `setBrand` | All + 3 brands, inside the design |

Target viewport 1440 × 900. Aim for everything important above the fold. Keep ~72 px clear at the
bottom centre (the review toolbar floats there).

## The 20 directions

| # | Name | Mode | Idea | Type | Inspiration |
|---|---|---|---|---|---|
| 01 | Obsidian | dark | Charcoal cards, sidebar, one accent-filled hero, glowing current-week bar | Geist | Findexa, Fintrixity, InsightX |
| 02 | Paper | light | Warm off-white, floating pill icon rail + top pill tabs, black hero tile, big greeting, hatched over-capacity bars, checkbox activity table | Plus Jakarta Sans | Finexy, Salleist, Skillset |
| 03 | Terminal Bento | dark | All monospace, top ticker strip of per-brand stats, flat square tiles, uppercase labels, fraction numbers ("6.5 / 5H"), one tile filled accent and one filled with a raw kit colour | Space Mono / JetBrains | Horizontal-view bento |
| 04 | Lime Pulse | dark | Pitch black + neon accent, capsule bars with striped empty parts and a lit current capsule with value bubble, right column of KPI tiles with tiny sparkline / tick arc / barcode charts | Sora | Chain, InsightX, Dwison |
| 05 | Command Deck | mixed | Top bar with centred segmented nav; full-width dark chart band (throughput line + volume ticks) with a left overlay stat list; light cards below: brand carousel, hours-allocation bar, agents | Manrope | Qubix, TransGlobal |
| 06 | One Number | light | Grey canvas, icon top nav, one giant centred figure, full-width barcode density band with a highlighted range, hairline-split row of four small panels, floating dark "Ask or capture" bar | Geist | Ledgerix |
| 07 | Schedule Rail | light | Black pill "Your schedule" bar across the top with today's blocks + now marker in accent; huge wordmark title; counters top right; brand filter pills; cards with cut-corner arrow buttons; first task card accent-filled | Urbanist | HubSpot Workspace (light + dark) |
| 08 | Portfolio Map | dark | Navy-black; Gantt of all projects across October coloured by brand with health dots, dependency curves and a now line; brand team cards below; right "alerts" column of needs-you items | Poppins | PM board |
| 09 | Pastel Columns | light | Soft pastel gradient canvas; all-brands view = one column per brand with brand-tinted project cards and dot progress; single brand = status columns of that brand's work | DM Sans | weihu, myflow |
| 10 | Violet Glass | dark | Plum gradient, glass cards, AI assistant card first (suggestion chips + ask input), KPI trio, smooth dual line chart with hatched area, credits widget in sidebar | Outfit | MONEF, Content AI |
| 11 | Day Planner | light | Narrow dark icon rail; greeting with bold name; KPI tiles with progress bars (first accent-filled); full-height day timeline on the right with brand-coloured blocks, now line, struck-through done items; week capacity chart | Manrope | doc+track, schedule, calendar |
| 12 | Split Focus | mixed | White list of projects grouped by urgency; selected row filled accent; dark detail panel on the right (big progress number, due, phase stepper with pulsing current step, action button); clicking rows changes the panel | Archivo | Beyond |
| 13 | Two-Tone | mixed | Top half a dark rounded band (pill nav, accent hero tile with tick-wave capacity chart, stacked capsule bars per day); bottom half cream with activity list, a "release card" visual and a bubble chart of hours by brand | Space Grotesk | Monex |
| 14 | Neo Brutal | light | Thick black outlines, hard offset shadows, flat fills (accent, k2, black), big bold numbers, outlined pill rows, dark bottom dock nav | Bricolage Grotesque | Softnet |
| 15 | Editorial | light | Airy, serif display for greeting and hero numbers, sans for labels, soft white cards, tall gradient tile (k1 → k2) with white bars, thin-tick meters, brand donut | Instrument Serif + Inter | myflow, Goodfolio |
| 16 | Heat Ops | dark | Warm black, two-line big title, KPI trio with icon tiles, warning strip with actions, 7 × 12 heatmap with min/avg/max, release stepper timeline, compact table | Outfit | TransGlobal |
| 17 | Gauges | dark | Pure black, rounded cards, tick-segment gauges for capacity and AI spend, counter tiles with arrow buttons, a slanted ribbon banner, estimate-vs-actual badges, stacked hours bar | Sora | Content AI, Salesforce invoices |
| 18 | Sage Triage | light | Sage canvas, folder-style tabs with counts (All / Review / Failed / Decisions), grid of triage cards (brand chip, priority pill, two info boxes, title, View + dark Accept buttons), toast "Accepted" | Outfit | Offers, Attio-like switcher |
| 19 | Swiss | light | Pure white, strict grid, hairline rules, no cards or shadows, oversized numerals, accent used once or twice, small caps labels, tabular list with brand squares | Inter / Archivo | Ledgerix, Goodfolio |
| 20 | Orbit | mixed | Light canvas, mixed dark and white tiles, multi-colour line over a gradient barcode strip, abstract gradient orbit hero tile, dot-matrix mini charts per brand, dark card of pill rows | Geist | Metric.IQ |

## How to judge (for Katriel)

Pick by: (1) can you read the state of all three companies in 5 seconds, (2) does the hero
point at the right thing, (3) does it still look good in each brand's colours (press **B**, or
paste logo colours via **Kit** in the toolbar), (4) would you open it every morning.
