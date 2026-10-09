import { createHash } from 'node:crypto';
import { addDays, daysBetween, isoWeekday, validDay, validZone } from '../time/semantics.ts';
import { localToUtc, utcToLocal } from '../recurrence.ts';

/**
 * Pure rules of Phase 5D (ADR-0031): dashboard kinds and sizes, filters and their date ranges,
 * schedule arithmetic, the report PDF, and the plain-text email. Nothing here reads data; every
 * number a dashboard shows is computed per viewer elsewhere, from what that viewer may read.
 */

export const DASHBOARD_KINDS = ['owner', 'brand', 'project', 'release', 'personal'] as const;
export type DashboardKindKey = (typeof DASHBOARD_KINDS)[number];

export const WIDGET_SIZES = ['small', 'medium', 'large'] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number];

export const RANGE_PRESETS = [
  'last_7_days',
  'last_30_days',
  'last_90_days',
  'this_week',
  'this_month',
  'last_month',
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export const STATUS_CATEGORIES = ['planned', 'active', 'paused', 'done', 'cancelled'] as const;
export const RANGE_DAYS_MAX = 366;

/** A date range a viewer chose: a named preset or an explicit pair of days. */
export type RangeInput = { preset: RangePreset } | { from: string; to: string };

export interface DashboardFilters {
  range: RangeInput | null;
  /** Public brand identifiers. */
  brands: string[];
  /** Public project identifiers. */
  projects: string[];
  /** Public member identifiers or `me`. */
  people: string[];
  statuses: string[];
}

export const EMPTY_FILTERS: DashboardFilters = {
  range: null,
  brands: [],
  projects: [],
  people: [],
  statuses: [],
};

export interface WidgetSpec {
  id: string;
  metric: string;
  title: string | null;
  size: WidgetSize;
  params: Record<string, unknown>;
}

export interface Layout {
  v: 1;
  widgets: WidgetSpec[];
}

/** A resolved, concrete range in the workspace's calendar. */
export interface ResolvedRange {
  from: string;
  to: string;
  label: string;
}

/** The first day of a week starting on `weekStart` (ISO 1–7) containing `day`. */
function weekStartOf(day: string, weekStart: number): string {
  const back = (isoWeekday(day) - weekStart + 7) % 7;
  return addDays(day, -back);
}

/** The range a filter means on `today` (the workspace's calendar day). */
export function resolveRange(
  range: RangeInput | null,
  today: string,
  weekStart = 1,
): ResolvedRange | null {
  if (!range) return null;
  if ('from' in range)
    return { from: range.from, to: range.to, label: `${range.from} to ${range.to}` };
  switch (range.preset) {
    case 'last_7_days':
      return { from: addDays(today, -6), to: today, label: 'Last 7 days' };
    case 'last_30_days':
      return { from: addDays(today, -29), to: today, label: 'Last 30 days' };
    case 'last_90_days':
      return { from: addDays(today, -89), to: today, label: 'Last 90 days' };
    case 'this_week': {
      const from = weekStartOf(today, weekStart);
      return { from, to: addDays(from, 6), label: 'This week' };
    }
    case 'this_month': {
      const from = `${today.slice(0, 7)}-01`;
      const next = new Date(Date.parse(`${from}T00:00:00Z`));
      next.setUTCMonth(next.getUTCMonth() + 1);
      return { from, to: addDays(next.toISOString().slice(0, 10), -1), label: 'This month' };
    }
    case 'last_month': {
      const first = new Date(Date.parse(`${today.slice(0, 7)}-01T00:00:00Z`));
      const to = addDays(first.toISOString().slice(0, 10), -1);
      return { from: `${to.slice(0, 7)}-01`, to, label: 'Last month' };
    }
  }
}

export function validRange(from: string, to: string): boolean {
  return !!validDay(from) && !!validDay(to) && to >= from && daysBetween(from, to) < RANGE_DAYS_MAX;
}

// ---------------------------------------------------------------------------------------------
// Schedules (RPT-021)
// ---------------------------------------------------------------------------------------------

export const FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export interface Schedule {
  frequency: Frequency;
  /** ISO weekday 1 (Monday) to 7 (Sunday); weekly only. */
  weekday: number | null;
  /** 1 to 28; monthly only (every month has these days). */
  monthday: number | null;
  /** Minutes after local midnight. */
  minute: number;
  timezone: string;
}

export function scheduleValid(s: Schedule): boolean {
  if (!validZone(s.timezone)) return false;
  if (!Number.isInteger(s.minute) || s.minute < 0 || s.minute > 1439) return false;
  if (s.frequency === 'weekly')
    return s.monthday === null && s.weekday !== null && s.weekday >= 1 && s.weekday <= 7;
  if (s.frequency === 'monthly')
    return s.weekday === null && s.monthday !== null && s.monthday >= 1 && s.monthday <= 28;
  return s.frequency === 'daily' && s.weekday === null && s.monthday === null;
}

const clock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/**
 * The instant of a local date-time. A time that does not exist (inside a spring-forward gap) is
 * sent forward by the length of the gap, so the report goes out right after the clock jumps,
 * never an hour early; an ambiguous time (a fall-back overlap) is the first one.
 */
function atLocal(local: string, tz: string): Date {
  const at = localToUtc(local, tz);
  const got = utcToLocal(at, tz);
  if (got === local) return at;
  const ms = (l: string) =>
    Date.UTC(
      +l.slice(0, 4),
      +l.slice(5, 7) - 1,
      +l.slice(8, 10),
      +l.slice(11, 13),
      +l.slice(14, 16),
    );
  const gap = ms(local) - ms(got);
  return gap > 0 && gap <= 2 * 3_600_000 ? new Date(at.getTime() + gap) : at;
}

/** The first occurrence strictly after `after`, as an instant. */
export function nextRun(s: Schedule, after: Date): Date {
  const startDay = utcToLocal(after, s.timezone).slice(0, 10);
  for (let i = -1; i <= 62; i++) {
    const day = addDays(startDay, i);
    if (s.frequency === 'weekly' && isoWeekday(day) !== s.weekday) continue;
    if (s.frequency === 'monthly' && Number(day.slice(8, 10)) !== s.monthday) continue;
    const at = atLocal(`${day}T${clock(s.minute)}`, s.timezone);
    if (at.getTime() > after.getTime()) return at;
  }
  // Unreachable for a valid schedule: a daily, weekly, or monthly day always occurs within 62 days.
  throw new Error('schedule has no next occurrence');
}

/**
 * The latest occurrence at or before `now`: what a sweep that was down for a while owes. A schedule
 * delivers once for the most recent missed occurrence, never a backlog (ADR-0031 D12).
 */
export function dueOccurrence(s: Schedule, nextAt: Date, now: Date): Date {
  let at = nextAt;
  // Every schedule fires at least monthly, so a long outage can start close to now.
  if (now.getTime() - nextAt.getTime() > 40 * 86_400_000)
    at = nextRun(s, new Date(now.getTime() - 33 * 86_400_000));
  for (let i = 0; i < 400; i++) {
    const n = nextRun(s, at);
    if (n.getTime() > now.getTime()) break;
    at = n;
  }
  return at;
}

export function describeSchedule(s: Schedule): string {
  const t = `${clock(s.minute)} ${s.timezone}`;
  if (s.frequency === 'daily') return `Every day at ${t}`;
  if (s.frequency === 'weekly') {
    const names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    return `Every ${names[(s.weekday ?? 1) - 1]} at ${t}`;
  }
  return `Day ${s.monthday} of every month at ${t}`;
}

// ---------------------------------------------------------------------------------------------
// Freshness (RPT-024)
// ---------------------------------------------------------------------------------------------

export interface Freshness {
  as_of: string;
  /** `live` is computed from current records at this moment; `derived` carries a source time. */
  basis: 'live' | 'derived';
  source_as_of: string | null;
  stale: boolean;
}

export function freshness(now: Date, sourceAsOf: Date | null, staleMinutes: number): Freshness {
  if (!sourceAsOf)
    return { as_of: now.toISOString(), basis: 'live', source_as_of: null, stale: false };
  const ageMin = (now.getTime() - sourceAsOf.getTime()) / 60_000;
  return {
    as_of: now.toISOString(),
    basis: 'derived',
    source_as_of: sourceAsOf.toISOString(),
    stale: ageMin > staleMinutes,
  };
}

// ---------------------------------------------------------------------------------------------
// Rendered tables, the PDF, and the email
// ---------------------------------------------------------------------------------------------

/** One rendered widget as plain tabular data: what CSV, PDF, and email all start from. */
export interface RenderedTable {
  title: string;
  caption: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
  notes: string[];
}

export const contentHash = (v: unknown): string =>
  `sha256:${createHash('sha256').update(JSON.stringify(v)).digest('hex')}`;

/** Characters a base-14 PDF font can show: Latin-1 letters lose accents, everything else is `?`. */
export function pdfSafe(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7e]/g, '?');
}

const pdfEsc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

function wrap(s: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of s.split(' ')) {
    if (word.length > width) {
      if (line) out.push(line);
      for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width));
      line = '';
      continue;
    }
    if (line.length + word.length + (line ? 1 : 0) > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

const COLS = 96;

/** The text lines of the report: headings, captions, a padded table per widget, and notes. */
export function reportLines(title: string, subtitle: string, tables: RenderedTable[]): string[] {
  const lines: string[] = [...wrap(pdfSafe(title), COLS), ...wrap(pdfSafe(subtitle), COLS), ''];
  for (const t of tables) {
    lines.push(...wrap(pdfSafe(t.title).toUpperCase(), COLS));
    if (t.caption) lines.push(...wrap(pdfSafe(t.caption), COLS));
    const cells = [
      t.columns,
      ...t.rows.map((r) => r.map((c) => (c === null ? '' : String(c)))),
    ].map((r) => r.map(pdfSafe));
    const n = t.columns.length;
    const widths = Array.from({ length: n }, (_, i) =>
      Math.min(40, Math.max(...cells.map((r) => (r[i] ?? '').length), 1)),
    );
    const fit = widths.reduce((a, b) => a + b, 0) + 2 * (n - 1);
    if (fit > COLS) {
      const over = fit - COLS;
      const biggest = widths.indexOf(Math.max(...widths));
      widths[biggest] = Math.max(8, widths[biggest]! - over);
    }
    cells.forEach((r, ri) => {
      lines.push(
        r
          .map((c, i) =>
            c.length > widths[i]! ? `${c.slice(0, widths[i]! - 1)}~` : c.padEnd(widths[i]!),
          )
          .join('  ')
          .trimEnd(),
      );
      if (ri === 0)
        lines.push('-'.repeat(Math.min(COLS, widths.reduce((a, b) => a + b, 0) + 2 * (n - 1))));
    });
    for (const note of t.notes) lines.push(...wrap(`Note: ${pdfSafe(note)}`, COLS));
    lines.push('');
  }
  return lines;
}

/**
 * A plain, dependency-free PDF 1.4 document: Courier, 9 pt, A4, paginated. Text only; it contains
 * exactly the lines it is given, so a recipient's export holds only what was rendered for them.
 */
export function renderPdf(lines: string[], footer: string): Buffer {
  const perPage = 62;
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  if (!pages.length) pages.push(['']);
  const objs: string[] = [];
  const add = (body: string) => objs.push(body) && objs.length;
  const catalog = add('<< /Type /Catalog /Pages 2 0 R >>');
  void catalog;
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  add(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
  pages.forEach((pl, i) => {
    const text = [
      'BT /F1 9 Tf 12 TL 40 800 Td',
      ...pl.map((l) => `(${pdfEsc(l)}) Tj T*`),
      'ET',
      `BT /F1 7 Tf 40 24 Td (${pdfEsc(pdfSafe(footer))}   Page ${i + 1} of ${pages.length}) Tj ET`,
    ].join('\n');
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    add(`<< /Length ${Buffer.byteLength(text, 'latin1')} >>\nstream\n${text}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The plain-text and HTML bodies of a scheduled report for one recipient. */
export function composeReportEmail(input: {
  title: string;
  scheduleText: string;
  tables: RenderedTable[];
  url: string;
  footer: string;
  rowsMax: number;
}): { text: string; html: string } {
  const text: string[] = [input.title, input.scheduleText, ''];
  const html: string[] = [`<h1>${esc(input.title)}</h1><p>${esc(input.scheduleText)}</p>`];
  for (const t of input.tables) {
    text.push(t.title.toUpperCase());
    if (t.caption) text.push(t.caption);
    html.push(`<h2>${esc(t.title)}</h2>`);
    if (t.caption) html.push(`<p>${esc(t.caption)}</p>`);
    const shown = t.rows.slice(0, input.rowsMax);
    text.push(t.columns.join(' | '));
    for (const r of shown) text.push(r.map((c) => (c === null ? '' : String(c))).join(' | '));
    if (t.rows.length > shown.length)
      text.push(`(${t.rows.length - shown.length} more rows in the report)`);
    for (const n of t.notes) text.push(`Note: ${n}`);
    text.push('');
    html.push(
      `<table><thead><tr>${t.columns.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>${shown
        .map(
          (r) =>
            `<tr>${r.map((c) => `<td>${esc(c === null ? '' : String(c))}</td>`).join('')}</tr>`,
        )
        .join('')}</tbody></table>`,
    );
    if (t.rows.length > shown.length)
      html.push(`<p>${t.rows.length - shown.length} more rows in the report.</p>`);
    for (const n of t.notes) html.push(`<p>Note: ${esc(n)}</p>`);
  }
  text.push(`Open the report: ${input.url}`, '', input.footer);
  html.push(`<p><a href="${esc(input.url)}">Open the report</a></p><p>${esc(input.footer)}</p>`);
  return {
    text: text.join('\n'),
    html: `<!doctype html><html><body>${html.join('')}</body></html>`,
  };
}

/** The idempotency key of one scheduled delivery. */
export const occurrenceKey = (reportId: string, recipientId: string, at: Date): string =>
  `${reportId}:${recipientId}:${at.toISOString()}`;
