# UX turnaround: simple to navigate and track, still Paper

Katriel's verdict on the full prototype (2026-10-07): "very cool and elegant, but not very UI
friendly". This plan keeps the Paper look and removes the complexity. Sources: NN/g, Material,
Linear, Plane, Notion, Things, Sunsama, Basecamp, Stephen Few, WCAG 2.2 (links in each rule).

## What was wrong (audit)

| Problem | Evidence | Rule broken |
|---|---|---|
| 17 icon-only destinations | Rail had no labels; tooltips on hover only | Label nav icons ([NN/g icons](https://www.nngroup.com/articles/icon-usability/)); 3–7 destinations ([Material rail](https://m3.material.io/components/navigation-rail/guidelines)) |
| Same thing in many places | Home, Today and My work all showed today's tasks, capacity and plan | One object, many views ([Linear](https://linear.app/docs/display-options), [Plane](https://plane.so/blog/introducing-plane-navigation-2)) |
| Dashboard overload | Home had 11 blocks and 3 competing heroes; pages mixed gauges, donuts, bubbles | ≤4 summary numbers, bars and lines over area and angle ([Few](https://blogs.ischool.berkeley.edu/i247s13/files/2013/02/WhyMostDashboardsFail.pdf), [NN/g](https://www.nngroup.com/articles/dashboards-preattentive/)) |
| Every page invented its layout | Different headers, filters, tabs per page | One page template, one detail peek ([Notion](https://www.notion.com/help/views-filters-and-sorts)) |
| Grey text too light | `--mute` #8b887f was 3.2:1 on tiles | 4.5:1 minimum ([WCAG](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html)) |
| Buttons and statuses looked alike | Both were pills | Clickable must look clickable ([NN/g](https://www.nngroup.com/articles/clickable-elements/)) |

## New structure (6 + settings)

| Nav | Replaces | Inside |
|---|---|---|
| **Home** | Home, Today, My work | Tabs: Today · Upcoming · Assigned. One ink "Your day" card, "Needs attention", the day list |
| **Inbox** | Inbox, notifications, agent reviews | Tabs: All · Captured · Reviews · Mentions; one action row per item |
| **Projects** | Projects, Releases | Project list with health. Project tabs: Overview · Tasks (List / Board / Timeline) · Release · Docs · Activity |
| **Plan** | Calendar, Timeline, Workload | Switcher: Calendar · Timeline · Workload |
| **Goals** | Goals, Reports | Tabs: Goals · Reports |
| **Docs** | Knowledge | Doc tree + doc |
| Settings (footer) | Settings, Agents setup, Automations, Integrations | Settings sections |

Brand switcher lives in the sidebar as a visible list (All + each brand, colour square + name).
Agents are assignees; their output arrives in Inbox › Reviews; their setup is in Settings.

## Rules for every page

1. Labeled sidebar, always visible (collapsible to a rail on demand).
2. Page header: breadcrumb › title › one primary button. View bar under it: tabs left, layout
   switcher + filter + count right.
3. Summary strip only on overview pages, max 4 tiles, each with a visible label and a link.
4. Body is one list, table or board. Rows: status, title, brand, assignee, due, priority.
5. Any item opens the same right-side peek (task drawer). Esc closes.
6. One ink hero per page, only for the thing that needs action.
7. Pills = status only (small, rounded-rect tags). Buttons = pill with fill or border + hover.
8. Text ≥ 12 px; secondary text ≥ 4.5:1; targets ≥ 32 px.
9. Empty states say why and offer one action.
10. Charts: bars and lines. No gauges, donuts or bubbles for decisions.

## Keep (the aesthetic)

Warm paper canvas and frame, white cards with big radii, black ink hero, hatched over-capacity,
big confident numbers, accent from the identity kit, Plus Jakarta Sans, generous whitespace.
