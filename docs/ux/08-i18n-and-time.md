# 8. Internationalization and Time Display

[← UX foundation index](README.md) · Related: [Design system](05-design-system.md) · [Decisions](09-decisions-and-risks.md)

This document covers how times, dates, numbers, currencies and text are **displayed and entered**. Storage rules (instants stored consistently, typically UTC) belong to 0B. What due date, deadline, scheduled block and recurrence *mean* belongs to 0A ([DEP-0A-08](09-decisions-and-risks.md#dep-0a-08)). Where 0A could choose differently, the display rule below states both outcomes.

## 1. Time contexts

Four time contexts can apply to one screen. The UI must never mix them silently.

| Context | Source | Used for | Example |
|---|---|---|---|
| **Viewer time** | User's profile timezone (default: detected at sign-up, confirmed) | Default display of every instant | "Comment posted 14:05" |
| **Workspace time** | Workspace timezone setting | Workspace-wide reports and periods, default for new members, automation schedules marked "workspace time" | "Weekly review generated Mondays 08:00 (workspace time, UTC+1)" |
| **Brand working time** | Brand working-hours calendar and timezone | Brand capacity, brand working hours, brand-scheduled briefings and notification rules | "Optestra hours: 09:00–17:00 Lisbon" |
| **Event-native time** | The timezone an external event or recurrence was defined in | External calendar events, recurrences, guest-facing times | "Call with vendor 10:00 New York" |

<a id="i18n-01"></a>
### I18N-01 — Viewer time is the default

Every instant is displayed in the viewer's profile timezone unless a rule below requires another context. Where another context is used, it is labelled ([I18N-10](#i18n-10)).

<a id="i18n-02"></a>
### I18N-02 — Locale preferences

Locale (language, date, number and currency format), time format (12 h or 24 h) and timezone are personal settings. Each defaults to: user setting, then browser locale, then workspace default. Changing them applies instantly without reload.

<a id="i18n-03"></a>
### I18N-03 — Time format

12- or 24-hour format follows the locale unless the user overrides it. Formats are never hard-coded. All formatting goes through locale-aware formatters (the `Intl` family or equivalent).

<a id="i18n-04"></a>
### I18N-04 — Week start

Week start is resolved as: user setting, then workspace setting, then locale default. It applies to calendar views, date pickers, "this week" filters, the weekly review and personal weekly capacity. **Workspace reports** use the workspace week start and say so ("Weeks start Monday (workspace setting)"), so team members with different personal settings see the same numbers.

<a id="i18n-05"></a>
### I18N-05 — Device timezone differs from profile timezone

When the device's timezone differs from the profile timezone (the user is travelling), a dismissible banner says "Times are shown in Lisbon time (UTC+1). Your device is set to New York (UTC−4). · Use New York time · Keep". The choice applies until changed again. The banner never changes the timezone automatically.

## 2. Showing timezones unambiguously

<a id="i18n-10"></a>
### I18N-10 — When and how to label a time with its timezone

- **Label when** the displayed time is not in viewer time, *or* the screen combines contexts (brand hours, events from other zones, guests in other zones), *or* the time is in a scheduling or recurrence editor.
- **Don't label** ordinary viewer-time timestamps, because labelling everything adds noise.
- **Format.** Use UTC offset plus a place name: "15:00 (UTC+1, Lisbon)". Avoid bare abbreviations such as "CST" or "IST", which are ambiguous. Use the offset in effect *on that date*, accounting for daylight saving.
- **Accessible name.** Includes the full form ("15:00, Lisbon time, UTC plus 1").

<a id="i18n-11"></a>
### I18N-11 — Dual display when contexts differ

Where a decision depends on two zones, show both, primary first. Examples are scheduling inside brand hours that differ from viewer time, sharing a time with a guest, and editing a recurrence defined elsewhere:

> **10:00 your time** · 15:00 Lisbon (Optestra working hours)

The calendar can show a secondary timezone gutter (a user setting).

<a id="i18n-12"></a>
### I18N-12 — Daylight-saving edge cases

- **Nonexistent local time** (clocks jump forward). Picking 02:30 on a jump-forward date resolves to the next valid time and shows a notice: "02:30 doesn't exist on 29 Mar in Lisbon; scheduled for 03:30".
- **Ambiguous local time** (clocks fall back). Picking 01:30 on a fall-back date shows both options with offsets ("01:30 UTC+1 · 01:30 UTC+0") and asks the user to choose.
- **Recurrences** keep their *local* time across daylight-saving changes (a 09:00 standup stays at 09:00 local). The recurrence summary states the timezone ([I18N-15](#i18n-15)).
- **Durations** display elapsed time correctly across transitions.

<a id="i18n-13"></a>
### I18N-13 — Date-only values versus instants

Whether due dates and deadlines are calendar dates or instants is [DEP-0A-08](09-decisions-and-risks.md#dep-0a-08). The display rules for each outcome:

- **If a value is date-only** (0A's proposal for due dates, start dates and date-only deadlines; *time-and-scheduling §3*): show it as a date with no time and no timezone conversion. "Due Fri 3 Oct" means 3 October for every viewer. When it becomes overdue follows 0A: on **personal surfaces** (Today, My Work, overdue badges, reminders) the **viewer's** day ends it; on **brand surfaces** (brand dashboard, brand briefing, brand automations) the **brand timezone** does. Brand surfaces say so on hover ("Overdue after 3 Oct, end of day New York time").
- **If a value is an instant** (for example a deadline at 17:00): show date and time in viewer time. Label the zone when it differs from the brand context ([I18N-10](#i18n-10)).
- **Past deadline vs overdue.** "Past deadline" (a hard external commitment) is shown as more severe than "Overdue" (missed internal target): danger styling and label for past deadline, warning for overdue, each with its own icon and text.
- Date-only and instant fields use different editors (date picker versus date-time picker), so the user can see which kind they are setting.

<a id="i18n-14"></a>
### I18N-14 — Relative time

- **Past instants up to 7 days old.** Relative ("5 min ago", "Yesterday at 14:02"). Older than 7 days: absolute ("12 Sep", or "12 Sep 2025" if not the current year).
- **Future dates and deadlines.** Relative plus absolute together: "Due tomorrow · Fri 3 Oct", "In 3 days · Mon 6 Oct". Relative alone is never used for commitments.
- **Accessible name and tooltip.** Always the full absolute value.
- Relative labels refresh at most once a minute and are never announced by live regions.
- "Today", "Tomorrow" and "Overdue" are computed in the context named by [I18N-13](#i18n-13), and the Today view's day boundary in viewer time ([I18N-16](#i18n-16)).
- All phrases come from locale-aware relative-time formatting, never concatenated English.

<a id="i18n-15"></a>
### I18N-15 — Recurrence summaries

Recurrences are shown as a full sentence with zone and context: "Every weekday at 09:00 (Optestra working hours, Lisbon) · next: Mon 6 Oct". Generated occurrences show their position ("Occurrence 3 of a weekly series").

<a id="i18n-16"></a>
### I18N-16 — The Today boundary

"Today" in the Today view is the viewer's local calendar day. A Today commitment made before midnight and unfinished after midnight appears in **Unfinished from yesterday** for rescheduling ([J-03](03-journeys.md#j-03-plan-today-across-brands)), never silently moved. Users whose working day crosses midnight can set a day-start offset (for example 04:00) in Settings ([UXD-19](09-decisions-and-risks.md#uxd-19)).

<a id="i18n-17"></a>
### I18N-17 — Periods in reports

Day, week and month buckets are computed in a stated context: viewer time for personal reports, workspace time for workspace reports, brand working time for brand capacity. Every report shows which context it uses.

### Worked example: one founder, three brands, three zones

The founder is in **Lisbon (UTC+1)**. MailAccess works in **New York hours (UTC−4)**, Optestra in **Lisbon hours**, and API Access in **Singapore hours (UTC+8)**. All dates are in October 2026, before the European clock change.

| Item | Stored as | Founder sees | Teammate in New York sees |
|---|---|---|---|
| MailAccess due date (date-only) | 3 Oct | "Due Fri 3 Oct" | "Due Fri 3 Oct" |
| MailAccess task becomes overdue | Floating date 3 Oct | In the founder's Today and My Work: from 00:00 Sat 4 Oct Lisbon. On the MailAccess brand dashboard: from 05:00 Sat 4 Oct Lisbon (end of day New York), with that context on hover | Personal and brand surfaces both: from 00:00 Sat 4 Oct New York |
| Optestra scheduled block | 09:00–10:30 Lisbon | "09:00–10:30" (no label; viewer time = brand time) | "04:00–05:30 (your time) · 09:00–10:30 Lisbon" |
| API Access standup recurrence | Weekdays 09:00 Singapore | "02:00 your time · 09:00 Singapore (API Access hours)" and an "Outside your working hours" warning in Today | "21:00 previous day your time · 09:00 Singapore" |
| Founder capacity strip, Today | Sum of brand reservations in viewer time | "MailAccess 14:00–18:00 · Optestra 09:00–13:00 · API Access none today" | Not shown (personal) |

## 3. Numbers, currency and units

<a id="i18n-20"></a>
### I18N-20 — Input parsing

- Dates accept the locale's numeric formats, month names and common natural-language phrases ("tomorrow", "next Fri", "in 2 weeks"). Natural-language support at launch is English; other languages fall back to formats and pickers ([UXD-23](09-decisions-and-risks.md#uxd-23)).
- Ambiguous numeric dates ("03/04") are interpreted by the locale and echoed back unambiguously ("3 Apr 2026") before saving.
- Numbers accept the locale's decimal and grouping separators. Pasted values with other separators are interpreted only when unambiguous, and otherwise flagged.
- Durations accept "1h30", "90m", "1.5 h" and localized equivalents, and display as "1 h 30 min".

<a id="i18n-21"></a>
### I18N-21 — Number formatting

All numbers, percentages and compact notation use locale-aware formatting, with tabular figures in tables ([DS-60](05-design-system.md#ds-60)). Percentages show precision suitable to the metric, never false precision ("33%", not "33.3333%").

<a id="i18n-22"></a>
### I18N-22 — Currency

- **Always show currency explicitly.** Use a symbol when only one currency can appear on the screen, and the ISO code or an unambiguous symbol ("US$", "A$", "USD") when more than one can, or when the symbol is shared ("$").
- **No silent conversion.** Several currencies can legitimately appear together: workspace currency (budgets), AI/provider costs (often USD) and billing currency. If a converted value is shown, label it "≈ €42 (converted from US$45.60 at the rate on 2 Oct)" and keep the original reachable.
- **Totals** across currencies are shown only after explicit conversion with a stated rate, or split by currency.
- **Billing amounts** show tax treatment ("excl. VAT" or "incl. VAT") and the billing period ([J-12](03-journeys.md#j-12-plan-limit-spending-warning-cancellation-and-export)).
- **AI cost estimates** show their range and currency ([ST-62](06-interaction-states.md#st-62)).

<a id="i18n-23"></a>
### I18N-23 — Units

Time quantities (estimates, capacity, time entries) use hours and minutes, localized. Storage size uses binary or decimal consistently (a decision for 10A) and is labelled (KB/MB/GB). File sizes are rounded to meaningful precision.

## 4. Text, layout and language

<a id="i18n-30"></a>
### I18N-30 — Scripts and fonts

The system font stack ([DS-01](05-design-system.md#ds-01)) renders Latin, Cyrillic, Greek, CJK, Arabic, Hebrew and Indic scripts through system fallbacks. User content in any script displays correctly in every surface, including brand markers (initials from the first grapheme, not the first byte), avatars, exports and emails.

<a id="i18n-31"></a>
### I18N-31 — Right-to-left readiness

RTL interface localization is not a launch commitment ([UXD-23](09-decisions-and-risks.md#uxd-23)), but it must not be precluded:

- use logical layout properties (start/end, not left/right);
- mirror directional icons (back arrows, progress direction) through a token, not per screen;
- render user-authored RTL text correctly within LTR UI, using automatic direction detection on user-content containers.

<a id="i18n-32"></a>
### I18N-32 — Text expansion

- Design for translated strings up to **40% longer** than English for sentences, and **up to 100% or more** for short labels of under 10 characters.
- Buttons, tabs, menu items, labels, badges and column headers have no fixed widths. They wrap or truncate per [DS-03](05-design-system.md#ds-03).
- Labels wrap to two lines before truncating. Tab rows overflow into "More" ([RS-41](04-responsive-shell.md#rs-41)).
- Icon-only compaction is never used to "fix" long labels on primary actions.

<a id="i18n-33"></a>
### I18N-33 — Strings and messages

- No string concatenation. Every message is a complete template with named placeholders (ICU MessageFormat or equivalent) and handles plural categories for every count ("1 task", "2 tasks", and other languages' plural forms).
- Messages about people use neutral phrasing that does not need grammatical gender ("Ana assigned you", not constructions that inflect by the actor's gender).
- User content (brand names, project names, task titles) is never translated or case-transformed.
- Errors and notifications are translated at render time in the recipient's locale, including emails.

<a id="i18n-34"></a>
### I18N-34 — Sorting, search and names

- Sorting by text uses locale-aware collation.
- Search folds case and diacritics where the language allows ("cafe" finds "Café").
- People have one **display name** field (with an optional pronunciation or short name). Layouts never assume first/last-name order.

<a id="i18n-35"></a>
### I18N-35 — Terminology

Product terms (*brand, Inbox, Today, deliverable, agent run…*) come from the 0A glossary and form the localization term base, with definitions for translators ([DEP-0A-13](09-decisions-and-risks.md#dep-0a-13)). The UI uses each term with exactly one meaning, and a term change in 0A propagates through the term base rather than ad hoc edits.

<a id="i18n-36"></a>
### I18N-36 — Pseudo-localization in testing

A pseudo-locale (accented characters, +40% length, bracketed strings) is available in non-production environments from 1E onward. Visual and end-to-end tests run under it to catch truncation, concatenation and hard-coded strings ([07 §8](07-accessibility.md#8-testing-protocol) complements this).
