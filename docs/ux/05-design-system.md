# 5. Design-System Foundation

[← UX foundation index](README.md) · Related: [States](06-interaction-states.md) · [Accessibility](07-accessibility.md) · [Shell](04-responsive-shell.md)

This is a **functional** foundation: token structure, semantic roles, verified reference values and component behavior. It is not a marketing identity. Hues, type family and illustration style can be refined by a later visual-design pass, provided the semantic roles and the contrast pairs in [Required contrast pairs](#required-contrast-pairs) still pass ([DS-21](#ds-21)).

## 1. Token architecture

<a id="ds-00"></a>
### DS-00 — Three tiers

| Tier | Example | Used by | May change per theme |
|---|---|---|---|
| **Reference** | `ref.blue.600 = #1D5BD6` | Semantic tokens only | No |
| **Semantic** | `color.action.primary`, `space.4`, `motion.duration.short` | Components and layouts | Yes (colour tokens) |
| **Component** | `button.primary.bg → color.action.primary` | One component | Rarely; only via semantic tokens |

- Components never use reference tokens or literal values.
- Themes (light, dark) are sets of semantic colour values. Size, space, type and motion tokens are theme-independent.
- Density ([DS-07](#ds-07)) is a token set over control sizing and spacing.
- The recommended interchange format for 1E is the W3C Design Tokens Community Group JSON format. The values in this document are the source until 1E creates the token files, and [`tools/check_contrast.py`](tools/check_contrast.py) reads them from here.

## 2. Typography

<a id="ds-01"></a>
### DS-01 — Type family

System UI font stack (`system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif`) for interface text, and a system monospace stack for code, IDs and logs. There is no brand typeface decision in this phase. The stack must render the scripts of supported locales ([I18N-30](08-i18n-and-time.md#i18n-30)).

<a id="ds-02"></a>
### DS-02 — Type scale

Sizes in CSS px at 100% zoom; implement in `rem` so user text-size preferences scale them.

| Token | Size / line height | Weight | Use |
|---|---|---|---|
| `type.caption` | 12 / 16 | 400 | Metadata, timestamps, badge text. Never for instructions or errors |
| `type.body-sm` | 13 / 18 | 400 | Dense table cells (compact density only) |
| `type.body` | 14 / 20 | 400 | Default UI text on fine-pointer devices |
| `type.body-lg` | 16 / 24 | 400 | Default UI text on coarse-pointer devices; long-form reading; **all form inputs on Compact** |
| `type.label` | 14 / 20 | 600 | Field labels, column headers, button text |
| `type.title-sm` | 16 / 24 | 600 | Card titles, panel section headings |
| `type.title` | 20 / 28 | 600 | Panel and dialog titles, record titles in panel |
| `type.heading` | 24 / 32 | 600 | Page titles (`h1`) |
| `type.display` | 30 / 38 | 600 | Dashboard hero numbers, onboarding |

- Numeric data in tables, timers, charts and money uses tabular figures.
- The measure for long-form text (documents, descriptions, help) is at most 72 characters.
- Text spacing must survive user overrides (line height 1.5, paragraph spacing 2×, letter spacing 0.12 em, word spacing 0.16 em) without clipping ([A11Y-VI-05](07-accessibility.md#a11y-vi-05)).
- Heading levels follow document structure, not visual size ([A11Y-SR-02](07-accessibility.md#a11y-sr-02)).

<a id="ds-03"></a>
### DS-03 — Text truncation

Truncate with an ellipsis only where space is structurally limited (table cells, cards, breadcrumbs, chips). The full text must be available on focus and hover (tooltip), in the record itself, and in the accessible name. Titles in record headers wrap rather than truncate. Never truncate numbers, dates, money or status labels; reflow or wrap them instead.

## 3. Space, size, shape and motion

<a id="ds-04"></a>
### DS-04 — Spacing scale (4 px base)

`space.0` 0 · `space.1` 2 · `space.2` 4 · `space.3` 8 · `space.4` 12 · `space.5` 16 · `space.6` 24 · `space.7` 32 · `space.8` 48 · `space.9` 64

Layouts use `space.5` gutters on Compact and `space.6` on Medium and larger. Related items use smaller steps than unrelated groups. Proximity, not lines, expresses grouping.

<a id="ds-05"></a>
### DS-05 — Icon sizes

`icon.sm` 16 · `icon.md` 20 · `icon.lg` 24. Icons convey meaning only together with text, or with an accessible name when standing alone (icon buttons). Decorative icons are hidden from assistive technology.

<a id="ds-06"></a>
### DS-06 — Radii

`radius.none` 0 · `radius.sm` 4 (chips, badges, inputs) · `radius.md` 6 (buttons, cards) · `radius.lg` 12 (dialogs, sheets, panels) · `radius.full` (avatars, pills).

Shape is semantic in two places. **Status badges are pills** (`radius.full`). **Brand markers are rounded squares** (`radius.sm`) ([DS-41](#ds-41)), so a brand can never look like a status.

<a id="ds-07"></a>
### DS-07 — Control sizing and density

| Token | Comfortable (default) | Compact | Coarse pointer (overrides density) |
|---|---|---|---|
| `size.control` (buttons, inputs, selects) | 36 | 28 | 44 |
| `size.row` (list/table row) | 44 | 32 | 48 (with ≥ 44 px tap target) |
| `size.icon-button` | 32 | 28 | 44 |
| Minimum gap between adjacent targets | 4 | 4 | 8 |

- Density changes padding and row height, never font size below `type.body-sm`, and never target size below 24 × 24 ([A11Y-PT-01](07-accessibility.md#a11y-pt-01)).
- Density is a personal setting (Comfortable or Compact), with optional per-view overrides on tables (*FEATURES › Views: compact and comfortable density*).
- On coarse pointers, Compact density reduces padding but keeps the 44 px target, so rows may be visually compact with an extended hit area.

<a id="ds-08"></a>
### DS-08 — Layout tokens

`breakpoint.medium` 600 · `breakpoint.expanded` 1024 · `breakpoint.wide` 1440 (behavior in [RS-01](04-responsive-shell.md#rs-01)).

`layout.sidebar` 248 (collapsed rail 64) · `layout.panel.default` 480 (min 360, max 720) · `layout.content.min` 480 · `layout.reading.max` 72ch · `layout.dialog.sm` 400 · `layout.dialog.md` 560 · `layout.dialog.lg` 720.

<a id="ds-09"></a>
### DS-09 — Elevation

| Token | Use | Light | Dark |
|---|---|---|---|
| `elevation.0` | Page content | None | None |
| `elevation.1` | Cards, sticky headers | 1 px border `color.border.subtle` | Border only |
| `elevation.2` | Popovers, menus, tooltips | Shadow + border | Lighter surface (`color.bg.raised`) + border |
| `elevation.3` | Side panels, drawers, sheets | Larger shadow | Raised surface + border |
| `elevation.4` | Modal dialogs (with scrim at 40% black) | Largest shadow | Raised surface + border + scrim |

In dark theme, elevation is expressed by surface lightness and borders, because shadows are not visible enough. Elevation is never the only cue for modality; modals also use a scrim and focus trapping.

<a id="ds-10"></a>
### DS-10 — Motion

| Token | Duration | Use |
|---|---|---|
| `motion.duration.instant` | 0 ms | Reduced-motion substitute |
| `motion.duration.short` | 120 ms | Hover, press, toggle, tooltip |
| `motion.duration.medium` | 200 ms | Popovers, menus, toasts |
| `motion.duration.long` | 280 ms | Panels, sheets, dialogs |
| `motion.easing.standard` | cubic-bezier(0.2, 0, 0, 1) | Entering and moving |
| `motion.easing.exit` | cubic-bezier(0.3, 0, 1, 1) | Leaving |

- Motion explains spatial change (where a panel came from, where a card moved). It is never decorative looping.
- Nothing flashes more than three times per second ([A11Y-VI-08](07-accessibility.md#a11y-vi-08)).
- Indeterminate progress indicators may animate. Under reduced motion they become a static indicator plus text ("Running · 2 min").

<a id="ds-11"></a>
### DS-11 — Reduced motion

When the user's operating system requests reduced motion, or the in-product override is set (Settings › Preferences):

- slide, scale, parallax, auto-scroll and spring animations are replaced by an instant change or an opacity fade of `motion.duration.short` or less;
- drag previews do not animate snapping;
- smooth scrolling is disabled;
- carousels and auto-advancing content are never used.

## 4. Colour

<a id="ds-20"></a>
### DS-20 — Semantic colour roles and reference values

Values were verified with [`tools/check_contrast.py`](tools/check_contrast.py). Neutral and functional colours are deliberately plain. The hues are a functional baseline, not a brand identity.

#### Surfaces

| Token | Light | Dark | Role |
|---|---|---|---|
| `color.bg.canvas` | `#F6F7F9` | `#101216` | App background behind content |
| `color.bg.surface` | `#FFFFFF` | `#181B21` | Content surfaces, cards, list rows |
| `color.bg.raised` | `#FFFFFF` | `#20242B` | Popovers, panels, dialogs |
| `color.bg.sunken` | `#EEF0F3` | `#0B0D10` | Wells, code blocks, inputs on canvas |
| `color.bg.hover` | `#EDEFF2` | `#22262D` | Hover/pressed rows |
| `color.bg.selected` | `#E6EEFC` | `#1B2A47` | Selected rows and current navigation |

#### Text, borders, focus

| Token | Light | Dark | Role |
|---|---|---|---|
| `color.text.primary` | `#1A1D23` | `#ECEEF2` | Body text, titles |
| `color.text.secondary` | `#474D59` | `#B6BBC5` | Supporting text, labels |
| `color.text.tertiary` | `#5F6673` | `#959CA8` | Metadata, placeholders (still ≥ 4.5:1) |
| `color.text.disabled` | `#8B919C` | `#6B717C` | Disabled text (exempt from contrast; always paired with a reason per [ST-42](06-interaction-states.md#st-42)) |
| `color.border.subtle` | `#DCDFE4` | `#2C3038` | Dividers, card outlines (decorative) |
| `color.border.strong` | `#7C828D` | `#737A86` | Input borders, checkbox outlines, meaningful boundaries (≥ 3:1) |
| `color.border.focus` | `#1D5BD6` | `#7EA8FF` | Focus indicator ([DS-30](#ds-30)) |

#### Actions

| Token | Light | Dark | Role |
|---|---|---|---|
| `color.action.primary` | `#1D5BD6` | `#7EA8FF` | Primary buttons, links, selected controls |
| `color.text.on-primary` | `#FFFFFF` | `#0B1530` | Text/icons on primary |
| `color.action.danger` | `#C0261C` | `#FF8077` | Destructive buttons |
| `color.text.on-danger` | `#FFFFFF` | `#2A0B08` | Text/icons on danger |

#### Status (system-reserved)

| Token | Light | Dark | Role |
|---|---|---|---|
| `color.status.info.fg` | `#1D5BD6` | `#7EA8FF` | Running, informational |
| `color.status.info.bg` | `#E6EEFC` | `#17264A` | Info badge/banner fill |
| `color.status.success.fg` | `#1B7339` | `#5BC882` | Accepted, verified, completed ([ST-60](06-interaction-states.md#st-60)) |
| `color.status.success.bg` | `#E4F4E9` | `#132E1F` | Success fill |
| `color.status.warning.fg` | `#8A5300` | `#F2B54A` | Needs attention, partial, at risk, retrying |
| `color.status.warning.bg` | `#FDF1D8` | `#33260C` | Warning fill |
| `color.status.danger.fg` | `#C0261C` | `#FF8077` | Failed, error, off track, blocked by failure |
| `color.status.danger.bg` | `#FCE8E6` | `#3A1715` | Danger fill |
| `color.status.proposed.fg` | `#6B3FC4` | `#B79DFF` | AI/agent-proposed or unreviewed content; ready for review |
| `color.status.proposed.bg` | `#F0EAFB` | `#271D45` | Proposed fill (used with dashed border) |

Neutral states (queued, paused, cancelled, draft) use `color.text.secondary` on `color.bg.sunken`.

#### Label palette (user-selectable colours for labels and custom statuses)

| Token | Light | Dark |
|---|---|---|
| `color.label.gray.fg` | `#454B57` | `#C3C8D1` |
| `color.label.gray.bg` | `#ECEEF1` | `#2A2E35` |
| `color.label.blue.fg` | `#1A4FB8` | `#A9C4FF` |
| `color.label.blue.bg` | `#E3ECFC` | `#1A2A4D` |
| `color.label.teal.fg` | `#0B5E63` | `#86D9D6` |
| `color.label.teal.bg` | `#DDF3F2` | `#11353A` |
| `color.label.green.fg` | `#1C6331` | `#8FD8A6` |
| `color.label.green.bg` | `#E2F3E6` | `#163221` |
| `color.label.amber.fg` | `#7A4A00` | `#F3C979` |
| `color.label.amber.bg` | `#FCEFD2` | `#382A0E` |
| `color.label.orange.fg` | `#94400A` | `#F8AE82` |
| `color.label.orange.bg` | `#FDE9DC` | `#3D2112` |
| `color.label.red.fg` | `#A82219` | `#FFA59E` |
| `color.label.red.bg` | `#FCE6E4` | `#401917` |
| `color.label.pink.fg` | `#9C1F5E` | `#F7A3CB` |
| `color.label.pink.bg` | `#FBE5EF` | `#3D1A2C` |
| `color.label.purple.fg` | `#5B36AD` | `#C6B2FF` |
| `color.label.purple.bg` | `#EEE8FB` | `#2A2048` |

<a id="ds-21"></a>
### DS-21 — Contrast is a build gate

Every pair in [Required contrast pairs](#required-contrast-pairs) must meet its minimum in both themes. A change to any colour token must pass `python3 docs/ux/tools/check_contrast.py`, or its 1E successor in CI, before merge. Thresholds: 4.5:1 for text (including text at `type.caption`), 3:1 for large text (≥ 24 px, or ≥ 18.66 px bold), meaningful non-text boundaries, icons and focus indicators ([A11Y-VI-01](07-accessibility.md#a11y-vi-01), [A11Y-VI-02](07-accessibility.md#a11y-vi-02)).

<a id="ds-22"></a>
### DS-22 — Users choose from palettes, never free colour, for system-meaningful things

Custom statuses and labels use the label palette, so contrast is guaranteed in both themes. Brand colours are free-form (customers own them), but they are constrained to the brand marker ([DS-41](#ds-41)).

<a id="ds-23"></a>
### DS-23 — Themes

- **Light**, **Dark** and **System** (default; follows the operating-system preference and updates live).
- The theme applies instantly, with no reload and without losing state. The choice is stored per user and applied before first paint to avoid a flash of the wrong theme.
- **Forced colours / high-contrast modes** (Windows): components rely on system colours. Focus, selection, borders and status icons stay visible. Information conveyed by background fills is also conveyed by border, icon or text ([A11Y-VI-07](07-accessibility.md#a11y-vi-07)).
- Images and brand logos: brands may upload a dark-theme logo variant. Without one, logos sit on a neutral tile in dark theme rather than being inverted.

### Required contrast pairs

The checker evaluates each row in **both** themes.

| Foreground | Background | Minimum | Why |
|---|---|---|---|
| `color.text.primary` | `color.bg.surface` | 4.5 | Body text |
| `color.text.primary` | `color.bg.canvas` | 4.5 | Body text on canvas |
| `color.text.primary` | `color.bg.raised` | 4.5 | Panels and dialogs |
| `color.text.primary` | `color.bg.selected` | 4.5 | Selected rows |
| `color.text.primary` | `color.bg.hover` | 4.5 | Hovered rows |
| `color.text.secondary` | `color.bg.surface` | 4.5 | Labels |
| `color.text.secondary` | `color.bg.canvas` | 4.5 | Labels on canvas |
| `color.text.secondary` | `color.bg.selected` | 4.5 | Labels in selected rows |
| `color.text.secondary` | `color.bg.sunken` | 4.5 | Neutral status badges |
| `color.text.tertiary` | `color.bg.surface` | 4.5 | Metadata |
| `color.text.tertiary` | `color.bg.canvas` | 4.5 | Metadata on canvas |
| `color.text.tertiary` | `color.bg.sunken` | 4.5 | Placeholders in inputs |
| `color.text.tertiary` | `color.bg.raised` | 4.5 | Metadata in panels |
| `color.text.tertiary` | `color.bg.hover` | 4.5 | Metadata in hovered rows |
| `color.border.strong` | `color.bg.surface` | 3 | Input boundaries |
| `color.border.strong` | `color.bg.canvas` | 3 | Input boundaries on canvas |
| `color.border.strong` | `color.bg.raised` | 3 | Inputs in dialogs |
| `color.border.focus` | `color.bg.surface` | 3 | Focus indicator |
| `color.border.focus` | `color.bg.canvas` | 3 | Focus indicator |
| `color.border.focus` | `color.bg.raised` | 3 | Focus in dialogs |
| `color.border.focus` | `color.bg.selected` | 3 | Focus on selected row |
| `color.action.primary` | `color.bg.surface` | 4.5 | Link text |
| `color.action.primary` | `color.bg.raised` | 4.5 | Links in panels |
| `color.text.on-primary` | `color.action.primary` | 4.5 | Primary button text |
| `color.text.on-danger` | `color.action.danger` | 4.5 | Danger button text |
| `color.action.danger` | `color.bg.surface` | 4.5 | Danger text buttons |
| `color.status.info.fg` | `color.bg.surface` | 4.5 | Status text |
| `color.status.info.fg` | `color.status.info.bg` | 4.5 | Badge text |
| `color.text.primary` | `color.status.info.bg` | 4.5 | Banner text |
| `color.status.success.fg` | `color.bg.surface` | 4.5 | Status text |
| `color.status.success.fg` | `color.status.success.bg` | 4.5 | Badge text |
| `color.text.primary` | `color.status.success.bg` | 4.5 | Banner text |
| `color.status.warning.fg` | `color.bg.surface` | 4.5 | Status text |
| `color.status.warning.fg` | `color.status.warning.bg` | 4.5 | Badge text |
| `color.text.primary` | `color.status.warning.bg` | 4.5 | Banner text |
| `color.status.danger.fg` | `color.bg.surface` | 4.5 | Status text |
| `color.status.danger.fg` | `color.status.danger.bg` | 4.5 | Badge text |
| `color.text.primary` | `color.status.danger.bg` | 4.5 | Banner text |
| `color.status.proposed.fg` | `color.bg.surface` | 4.5 | Status text |
| `color.status.proposed.fg` | `color.status.proposed.bg` | 4.5 | Badge text |
| `color.text.primary` | `color.status.proposed.bg` | 4.5 | Proposal body text |
| `color.label.gray.fg` | `color.label.gray.bg` | 4.5 | Label chip |
| `color.label.blue.fg` | `color.label.blue.bg` | 4.5 | Label chip |
| `color.label.teal.fg` | `color.label.teal.bg` | 4.5 | Label chip |
| `color.label.green.fg` | `color.label.green.bg` | 4.5 | Label chip |
| `color.label.amber.fg` | `color.label.amber.bg` | 4.5 | Label chip |
| `color.label.orange.fg` | `color.label.orange.bg` | 4.5 | Label chip |
| `color.label.red.fg` | `color.label.red.bg` | 4.5 | Label chip |
| `color.label.pink.fg` | `color.label.pink.bg` | 4.5 | Label chip |
| `color.label.purple.fg` | `color.label.purple.bg` | 4.5 | Label chip |

### Focus indicator

<a id="ds-30"></a>
**DS-30 — Focus ring.** A 2 px solid `color.border.focus` outline with 2 px offset, on every focusable element, for keyboard focus (`:focus-visible`). Pointer clicks on buttons may omit it; text inputs always show focus. The ring must not be clipped by `overflow` containers or covered by sticky elements ([A11Y-FO-02](07-accessibility.md#a11y-fo-02), [A11Y-FO-04](07-accessibility.md#a11y-fo-04)). On elements whose own fill is `color.action.primary`, a 2 px inner `color.bg.surface` gap separates the ring from the fill.

## 6. Status, priority and risk representation

<a id="ds-45"></a>
### DS-45 — Never colour alone

Every status, priority, health, risk, execution, save and validation indicator combines **shape (icon)** + **text label** + colour. In dense layouts the label may be visually hidden *only* if the icon is unique in that view and the label is in the accessible name and tooltip. Charts use pattern or direct labels in addition to colour ([A11Y-VI-06](07-accessibility.md#a11y-vi-06)).

<a id="ds-46"></a>
### DS-46 — Workflow status

Custom statuses keep their user-chosen name and label-palette colour. Their **icon is fixed by status category**, so meaning survives any naming or colour choice. The categories are the five proposed by 0A (*lifecycle-and-states §2*; [DEP-0A-04](09-decisions-and-risks.md#dep-0a-04)):

| Category | Icon | Example statuses |
|---|---|---|
| `planned` | Empty circle | To do, Backlog, Triaged |
| `active` | Half circle | In progress, In review, Fixed – awaiting verification |
| `paused` | Circle with pause bars | On hold |
| `done` | Filled circle with check | Done, Verified |
| `cancelled` | Circle with slash | Cancelled, Closed – not fixed |

Two **conditions** are shown as small overlay badges on the status icon, plus text, because they are not categories in 0A:

- **Blocked** is derived from an open blocking dependency or a manual blocked flag with a reason. It uses a bar badge and the text "Blocked". When it is derived from a dependency the viewer cannot read, see [UXD-28](09-decisions-and-risks.md#uxd-28).
- **Review state** (`requested`, `changes requested`, `accepted`, `rejected`) is a separate axis, shown as an eye badge and the review label.

Status badges are pills ([DS-06](#ds-06)).

<a id="ds-47"></a>
### DS-47 — Priority

There are four priority levels plus "No priority". The icon is ascending bars (1–3 filled) with an "!" mark for Urgent. Labels: Urgent, High, Medium, Low, No priority. Only Urgent uses `color.status.danger.fg`; other levels use neutral text colour, so priority is not confused with errors.

<a id="ds-48"></a>
### DS-48 — Health and risk

| Health | Icon | Colour role | Label |
|---|---|---|---|
| On track | Upward check | Success | On track |
| At risk | Triangle-! | Warning | At risk |
| Off track | Octagon-! | Danger | Off track |
| Not set | Dashed circle | Neutral | No health set |

Derived (suggested) health shows "Suggested" with an explanation link, and is distinct from health a person set ([ST-47](06-interaction-states.md#st-47)).

## 7. Brand identity inside the product

<a id="ds-40"></a>
### DS-40 — Brand marker

The brand marker is the single component used everywhere to show a record's owning brand ([IA-20](02-information-architecture.md#ia-20)).

- **Anatomy.** A rounded-square tile (16, 20 or 24 px) containing the brand icon, logo or initials, followed by the brand name (or short name where space is constrained, with the full name in the accessible name and tooltip).
- **Variants.** `marker` (tile + name), `marker-tile` (tile only, allowed only where the name appears in the same row or the accessible name, and never in multi-brand lists without a visible name at least once per group), `marker-stack` (up to three overlapping tiles + "+n", where n counts only *accessible* brands).
- **Workspace marker.** A neutral tile with a fixed workspace glyph, labelled "Workspace", for workspace-scoped records.
- **No brand yet.** A dashed empty tile labelled "No brand yet" ([IA-28](02-information-architecture.md#ia-28)).
- **Archived brand.** The marker plus an "Archived" badge.

<a id="ds-41"></a>
### DS-41 — Brand colour constraints

Customer brand colours are arbitrary, so they are confined:

1. A brand colour is used **only** as the fill of the brand-marker tile, and optionally as a 3 px accent stripe on the brand home header and brand cards. It is never used for text, links, buttons, focus, selection, status, charts' status series, or backgrounds behind content.
2. Tile glyph/initial colour is computed automatically as black or white, whichever contrasts more with the brand colour. Against any colour, the better of black or white achieves at least 4.58:1 (verified by the checker's exhaustive sweep), so the glyph always meets 4.5:1.
3. If the brand colour contrasts below 3:1 with the current surface, the tile gets a 1 px `color.border.strong` outline, so its boundary is perceivable in both themes.
4. Uploaded logos render inside the tile on a neutral background when the logo has transparency. Logos are never recoloured.
5. **No impersonation of system state.** The brand marker shape (rounded square) is reserved and differs from status pills. Brand colour stripes never appear on banners, toasts or badges. A brand colour that is close to a system status hue is allowed (red brands exist), because brand colour never occupies a status position.
6. Brand names and logos are user content. They are rendered as text or images, never interpreted as markup, and never shown in system-authored surfaces (for example "Security warning" dialogs) in a way that could be confused with product chrome.

<a id="ds-42"></a>
### DS-42 — Brand identity in external surfaces

Emails, browser notifications and exported reports include the brand name in text (subject or title prefix, or header) and may include the logo. They follow the same no-impersonation rule: product system messages (security, billing) are visually distinct from brand-originated content. Minimal-content mode for sensitive brands is [UXD-10](09-decisions-and-risks.md#uxd-10).

<a id="ds-44"></a>
### DS-44 — Actor-type markers

Activity entries, comments, history, approvals and notifications identify **who or what** acted:

| Actor type | Avatar treatment | Text suffix |
|---|---|---|
| Person | Photo or initials, circular | — |
| AI | Circular avatar with fixed "AI" spark glyph | "· AI" |
| Agent | Rounded-hexagon avatar with agent icon or initials | "· Agent" |
| Automation | Circular avatar with lightning glyph | "· Automation" |
| Integration | Circular avatar with integration logo | "· via {integration}" |
| System | Neutral glyph | "· System" |

The suffix text is always present in the accessible name and visible in activity and history. When a person applies something an AI or agent proposed, both are shown ("Ana · proposed by AI").

## 8. Component behavior

Each component must implement the states in [06 §12](06-interaction-states.md#12-reusable-state-matrix) and the accessibility pattern in [07 §5](07-accessibility.md#5-component-patterns). This table is the behavioral contract; it is not a visual spec.

<a id="ds-50"></a>
### DS-50 — Component catalogue

| Component | Variants | Key behavior rules | A11y pattern |
|---|---|---|---|
| **Button** | Primary, secondary, tertiary (ghost), danger, icon-only; sizes per [DS-07](#ds-07) | One primary per region. Label is a verb ("Create project"). Busy state keeps width and shows a spinner + "Saving…" in its accessible name. Disabled only with an adjacent visible reason ([ST-42](06-interaction-states.md#st-42)). Never a link styled as a button for navigation, or vice versa ([RS-24](04-responsive-shell.md#rs-24)) | Button; [A11Y-PT-01](07-accessibility.md#a11y-pt-01) |
| **Link** | Inline, standalone, external | Underlined inline; standalone links may drop the underline but must be distinguishable by more than colour. External links show an icon and "(opens in new tab)" when they do so | Link |
| **Text input / textarea** | Single-line, multi-line, with prefix/suffix, search | Visible persistent label (no placeholder-as-label). Help text below the label. Error below the field ([ST-75](06-interaction-states.md#st-75)). Character count only near limits | [A11Y-FM-01](07-accessibility.md#a11y-fm-01) |
| **Select / combobox** | Single select, multi select, creatable (labels), async search (people, records) | Type-ahead filtering. Async results show "Searching…". Options carry brand markers for records. Multi-select shows chips with remove buttons. Options the user may not see never appear ([IA-47](02-information-architecture.md#ia-47)) | Combobox + listbox |
| **Checkbox, radio, switch** | — | Switch only for immediate-effect settings. Checkbox for form values. Mixed state for parent selections | Native semantics |
| **Date / time / duration pickers** | Date, date range, time, date-time, duration, recurrence | Typed entry always allowed alongside the calendar. Shows timezone when relevant ([I18N-10](08-i18n-and-time.md#i18n-10)). Clear distinction of Due date, Deadline and Scheduled block fields ([DEP-0A-08](09-decisions-and-risks.md#dep-0a-08)). Week start per [I18N-04](08-i18n-and-time.md#i18n-04) | Dialog grid date picker; [A11Y-PA-07](07-accessibility.md#a11y-pa-07) |
| **Rich-text editor** | Comment (compact), description, document | Markdown shortcuts, "/" commands, mentions with brand-aware results, paste sanitization, embeds. Save state per [ST-01](06-interaction-states.md#st-01) | [A11Y-PA-09](07-accessibility.md#a11y-pa-09) |
| **Table / data grid** | Read table, editable grid | Sticky header, frozen first column, sortable headers with sort direction in text, resize and reorder via menu as well as drag, virtualization ([DS-60](#ds-60)) | Table, or grid when cells are editable; [A11Y-PA-05](07-accessibility.md#a11y-pa-05) |
| **List row / card** | Task row, record card, board card | Whole row opens detail via a primary link. Secondary controls are separate focusable elements. Brand marker per [IA-20](02-information-architecture.md#ia-20) | List / link; [A11Y-PA-06](07-accessibility.md#a11y-pa-06) for board |
| **Tabs** | Page tabs (navigational = links), in-panel tabs (content switching) | Navigational tabs change the URL ([RS-21](04-responsive-shell.md#rs-21)). Overflow into "More" ([RS-41](04-responsive-shell.md#rs-41)) | Tabs pattern for in-panel; nav links for page tabs |
| **Menu** | Action menu, context menu (also on a visible "⋯" button) | Destructive items last, separated, danger-coloured with icon. Never the only path to an action available elsewhere | Menu button |
| **Tooltip** | Label tooltip, description tooltip | Appears on hover *and* focus. Dismissible with Esc. Hoverable. Never contains interactive content or essential information unavailable elsewhere | Tooltip; [A11Y-PT-04](07-accessibility.md#a11y-pt-04) |
| **Popover** | Picker, preview card | Light dismiss. Focus moves in and returns on close ([ST-90](06-interaction-states.md#st-90)) | Non-modal dialog |
| **Dialog** | Confirm, form, alert | Title + description. Modal with scrim. Max one level ([RS-34](04-responsive-shell.md#rs-34)). Primary action on the right on larger classes; stacked full-width on Compact | Modal dialog; alertdialog for Tier 2 |
| **Drawer / side panel / sheet** | See [RS-34](04-responsive-shell.md#rs-34) | Resizable panel on larger classes. Sheets have a grab handle *and* a close button | Region or dialog per modality |
| **Toast** | Info, success, warning (no error toasts requiring action) | [ST-21](06-interaction-states.md#st-21) | Status (polite live region) |
| **Banner** | Page, section; info, warning, danger, proposed | Persistent until the condition ends or the user dismisses it (dismissible only if non-critical). Stacking per [ST-22](06-interaction-states.md#st-22) | Region with heading; status/alert per severity |
| **Badge / chip** | Status pill, count badge, label chip, filter chip (removable) | Count badges cap at "99+" with the exact count in the accessible name. Counts follow [IA-41](02-information-architecture.md#ia-41) | Text; removable chips are buttons |
| **Avatar** | Person, AI, agent, automation, integration ([DS-44](#ds-44)), group | Initials fallback. Groups show up to 3 + "+n" (accessible people only) | Image with name |
| **Progress** | Determinate bar, indeterminate, step progress, capacity bar | Determinate only when measurable ([ST-60](06-interaction-states.md#st-60)). Capacity bars show numeric values ("6.5 h of 8 h") and an over-capacity marker with text | Progressbar or meter |
| **Skeleton** | Row, card, text block, chart | Matches final layout. Static under reduced motion. Hidden from assistive technology, which hears the busy announcement instead ([ST-40](06-interaction-states.md#st-40)) | aria-hidden + region aria-busy |
| **Empty state** | First-use, filtered-empty, no-access-to-anything, guest-nothing-shared | Content rules [ST-43](06-interaction-states.md#st-43), [ST-44](06-interaction-states.md#st-44) | Region with heading |
| **Brand marker** | [DS-40](#ds-40) | [DS-41](#ds-41) | Image/text with brand name |
| **Save-state indicator** | Field, record, document | [ST-01](06-interaction-states.md#st-01) | Status live region |
| **Execution-state badge** | All states in [ST-60](06-interaction-states.md#st-60) | Icon + label always | Status |
| **Diff / change card** | Inline diff, side-by-side, field before/after | Additions and removals marked with +/− symbols and text ("Added", "Removed") as well as colour | [A11Y-PA-10](07-accessibility.md#a11y-pa-10) |
| **Filter bar** | Chips + "Add filter", AND/OR groups | Active filters always visible as chips. AND/OR groups shown as nested readable sentences ("Status is Open **and** (Priority is High **or** Label is Launch)") | Toolbar + buttons |

## 9. Large-data display

<a id="ds-60"></a>
### DS-60 — Large lists and tables

- Lists beyond about 100 rows are virtualized or paginated (*FEATURES › Reliability and performance*). Virtualization must keep:
  - **find-in-page fallback**: a "Search in this list" filter, since off-screen rows are not in the DOM;
  - correct `aria-rowcount`/`aria-rowindex` (or `aria-setsize`/`aria-posinset`);
  - focus retention when rows recycle.
- Totals are shown as "1–50 of 1,240". When the total is expensive or unknown, show "50 of many" or "1,000+". The total is always of authorized records ([IA-41](02-information-architecture.md#ia-41)).
- Numbers are right-aligned with tabular figures. Text is left-aligned (or start-aligned for RTL readiness, [I18N-31](08-i18n-and-time.md#i18n-31)). Money shows its currency ([I18N-22](08-i18n-and-time.md#i18n-22)).
- Long values truncate per [DS-03](#ds-03). Empty cells show "—" with the accessible text "Empty", never blank, so "no value" is distinguishable from "loading".
- Grouped lists show group headers with counts and collapse controls. Collapsed state is part of view state ([RS-20](04-responsive-shell.md#rs-20)).

<a id="ds-61"></a>
### DS-61 — Large numbers and compact notation

Dashboards may use compact notation ("12.4k", "$1.2M") with the exact value in the tooltip and accessible name. Tables always show exact values. Localized per [I18N-21](08-i18n-and-time.md#i18n-21).

<a id="ds-62"></a>
### DS-62 — Charts

Every chart has a title, the scope caption ([IA-22](02-information-architecture.md#ia-22)), freshness ([ST-47](06-interaction-states.md#st-47)), direct labels or a legend with patterns, a "View data" table equivalent ([A11Y-SR-08](07-accessibility.md#a11y-sr-08)), and drill-through to records (*FEATURES › Dashboards and reporting*). Estimated segments are visibly marked (hatched) and labelled.

<a id="ds-63"></a>
### DS-63 — Long-running list updates

New or changed items arriving in a list the user is reading follow [ST-07](06-interaction-states.md#st-07): they queue behind an "updates" chip, so rows never jump under the pointer or screen-reader cursor.
