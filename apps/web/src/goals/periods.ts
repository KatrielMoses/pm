/**
 * Period selection for the Goals list (5B). Periods are calendar periods (ADR-0028 G2: fiscal
 * calendars are not modelled). The selector maps to the list's `from`/`to` days, which return the
 * goals whose period overlaps the chosen range.
 */

export type PeriodMode = 'quarter' | 'half' | 'year' | 'custom' | 'all';

export interface PeriodSel {
  mode: PeriodMode;
  year: number;
  /** Quarter 1-4 or half 1-2. */
  index: number;
  start: string;
  end: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
export const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The calendar quarter containing the day (the default selection). */
export function currentQuarter(now = new Date()): PeriodSel {
  const year = now.getFullYear();
  const q = Math.floor(now.getMonth() / 3) + 1;
  const first = (q - 1) * 3 + 1;
  return {
    mode: 'quarter',
    year,
    index: q,
    start: `${year}-${pad(first)}-01`,
    end: `${year}-${pad(first + 2)}-${pad(lastDay(year, first + 2))}`,
  };
}

/** The first and last day a selection covers, or null for "all periods" and an invalid custom range. */
export function rangeOf(sel: PeriodSel): { from: string; to: string } | null {
  switch (sel.mode) {
    case 'quarter': {
      const first = (sel.index - 1) * 3 + 1;
      return {
        from: `${sel.year}-${pad(first)}-01`,
        to: `${sel.year}-${pad(first + 2)}-${pad(lastDay(sel.year, first + 2))}`,
      };
    }
    case 'half': {
      const first = sel.index === 1 ? 1 : 7;
      return {
        from: `${sel.year}-${pad(first)}-01`,
        to: `${sel.year}-${pad(first + 5)}-${pad(lastDay(sel.year, first + 5))}`,
      };
    }
    case 'year':
      return { from: `${sel.year}-01-01`, to: `${sel.year}-12-31` };
    case 'custom':
      return /^\d{4}-\d{2}-\d{2}$/.test(sel.start) &&
        /^\d{4}-\d{2}-\d{2}$/.test(sel.end) &&
        sel.start <= sel.end
        ? { from: sel.start, to: sel.end }
        : null;
    default:
      return null;
  }
}

/** "2026 Q4", "2026 H2", "2026", "2026-10-01 to 2026-12-15", or "All periods". */
export function selLabel(sel: PeriodSel): string {
  switch (sel.mode) {
    case 'quarter':
      return `${sel.year} Q${sel.index}`;
    case 'half':
      return `${sel.year} H${sel.index}`;
    case 'year':
      return String(sel.year);
    case 'custom':
      return `${sel.start || '…'} to ${sel.end || '…'}`;
    default:
      return 'All periods';
  }
}

/** The previous (-1) or next (+1) period of the same size. Custom and all have none. */
export function shiftSel(sel: PeriodSel, by: -1 | 1): PeriodSel {
  if (sel.mode === 'year') return { ...sel, year: sel.year + by };
  if (sel.mode === 'quarter') {
    const n = sel.index - 1 + by;
    return { ...sel, year: sel.year + Math.floor(n / 4), index: (((n % 4) + 4) % 4) + 1 };
  }
  if (sel.mode === 'half') {
    const n = sel.index - 1 + by;
    return { ...sel, year: sel.year + Math.floor(n / 2), index: (((n % 2) + 2) % 2) + 1 };
  }
  return sel;
}

/** Switches the size of the period, keeping the one that contains the same day. */
export function changeMode(sel: PeriodSel, mode: PeriodMode, now = new Date()): PeriodSel {
  if (mode === sel.mode) return sel;
  const base = rangeOf(sel);
  const anchor = base ? new Date(`${base.from}T12:00:00`) : now;
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const next: PeriodSel = { ...sel, mode, year };
  if (mode === 'quarter') next.index = Math.floor(month / 3) + 1;
  if (mode === 'half') next.index = month < 6 ? 1 : 2;
  if (mode === 'custom' && base) {
    next.start = base.from;
    next.end = base.to;
  }
  return next;
}
