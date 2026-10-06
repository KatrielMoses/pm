/**
 * Deterministic capture parser, version 1 (ADR-0017 C3, CAP-003/CAP-009/CAP-010). Rule-based and
 * explainable: every detected value carries the span of text it came from and the rule that
 * matched. Ambiguous values (a numeric date that could be day/month or month/day, a weekday that
 * could be this week or next) list their options and must be confirmed before they apply. This is
 * not AI and never calls a model.
 *
 * Grammar (case-insensitive, whitespace-separated tokens):
 * - Dates: `today`, `tomorrow`, weekdays (`mon`…`sunday`, `next fri`), `in 3 days`, `in 2 weeks`,
 *   ISO `2026-12-01`, `dec 3` / `3 dec`, and numeric `3/4` (ambiguous unless one side is over 12).
 *   A date after `due` (or bare) is the due date; after `deadline` or `by` it is the deadline.
 * - Priority: `!urgent`, `!high`, `!medium`, `!low`, `p1`–`p4`, `!!!` (urgent), `!!` (high).
 * - Duration: `30m`, `45min`, `2h`, `1.5h`, `1d` (8 hours), optionally prefixed `~` or `for`.
 * - Recurrence: `daily`, `weekly`, `monthly`, `yearly`, `every day|weekday|week|month|year`,
 *   `every monday`, `every 2 weeks`.
 * - Labels `#name`; project `+name` or `+"two words"`; brand `brand:name` or `brand:"two words"`;
 *   owner `@name`.
 * Everything else forms the title, in order.
 */

export const PARSER_VERSION = 1;

export type ParseField =
  | 'due_date'
  | 'deadline'
  | 'priority'
  | 'estimate_minutes'
  | 'recurrence'
  | 'label'
  | 'project'
  | 'brand'
  | 'owner';

export interface ParseToken {
  field: ParseField;
  /** Character offsets into the original line (end exclusive). */
  start: number;
  end: number;
  text: string;
  /** The rule that matched, for explanations. */
  rule: string;
  /** The detected value; null when ambiguous. */
  value: unknown;
  /** When set, the person must choose one of these before the value applies. */
  options?: Array<{ value: unknown; label: string }>;
}

export interface ParseResult {
  version: typeof PARSER_VERSION;
  title: string;
  tokens: ParseToken[];
  /** True when the line had more tokens than the parser examines (CAPTURE_PARSE_TOKENS_MAX). */
  truncated: boolean;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const PRIORITY: Record<string, string> = {
  '!urgent': 'urgent',
  '!high': 'high',
  '!medium': 'medium',
  '!med': 'medium',
  '!low': 'low',
  p1: 'urgent',
  p2: 'high',
  p3: 'medium',
  p4: 'low',
  '!!!': 'urgent',
  '!!': 'high',
};
const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

interface Word {
  text: string;
  lower: string;
  start: number;
  end: number;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (today: string, n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
const weekdayOf = (today: string) => new Date(`${today}T00:00:00Z`).getUTCDay();
const validDate = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
    ? iso(dt)
    : null;
};
/** The next occurrence of a month/day on or after today. */
const nextMonthDay = (today: string, m: number, d: number) => {
  const y = Number(today.slice(0, 4));
  const thisYear = validDate(y, m, d);
  if (thisYear && thisYear >= today) return thisYear;
  return validDate(y + 1, m, d);
};
const monthIndex = (w: string) => {
  const i = MONTHS.indexOf(w.slice(0, 3));
  return i >= 0 && (w.length === 3 || MONTHS[i] === w.slice(0, 3)) ? i + 1 : 0;
};

/** Splits a line into words with offsets, keeping `"quoted phrases"` after `+` or `brand:`. */
function words(line: string, max: number): { list: Word[]; truncated: boolean } {
  const list: Word[] = [];
  const re = /(?:\+|brand:)"[^"]{1,100}"|\S+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (list.length >= max) return { list, truncated: true };
    list.push({
      text: m[0],
      lower: m[0].toLowerCase(),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return { list, truncated: false };
}

/**
 * Parses one line. `today` is the person's local date (YYYY-MM-DD); relative dates resolve from it.
 * Pure and deterministic: the same input and `today` always give the same result.
 */
export function parseCapture(line: string, ctx: { today: string; tokensMax: number }): ParseResult {
  const { list, truncated } = words(line, ctx.tokensMax);
  const used = new Set<number>();
  const tokens: ParseToken[] = [];
  const take = (from: number, to: number, t: Omit<ParseToken, 'start' | 'end' | 'text'>) => {
    for (let k = from; k <= to; k++) used.add(k);
    tokens.push({
      ...t,
      start: list[from]!.start,
      end: list[to]!.end,
      text: line.slice(list[from]!.start, list[to]!.end),
    });
  };
  const dateAt = (
    i: number,
  ): {
    span: number;
    value: string | null;
    rule: string;
    options?: ParseToken['options'];
  } | null => {
    const w = list[i]?.lower.replace(/[.,;]$/, '');
    if (!w) return null;
    if (w === 'today') return { span: 1, value: ctx.today, rule: 'today' };
    if (w === 'tomorrow' || w === 'tmr' || w === 'tmrw')
      return { span: 1, value: addDays(ctx.today, 1), rule: 'tomorrow' };
    if (w === 'in' && /^\d{1,3}$/.test(list[i + 1]?.lower ?? '')) {
      const n = Number(list[i + 1]!.lower);
      const unit = list[i + 2]?.lower.replace(/[.,;]$/, '') ?? '';
      if (/^days?$/.test(unit)) return { span: 3, value: addDays(ctx.today, n), rule: 'in N days' };
      if (/^weeks?$/.test(unit))
        return { span: 3, value: addDays(ctx.today, 7 * n), rule: 'in N weeks' };
    }
    const next = w === 'next';
    const dayWord = next ? list[i + 1]?.lower.replace(/[.,;]$/, '') : w;
    const wd = dayWord ? WEEKDAYS.findIndex((d) => d === dayWord || d.slice(0, 3) === dayWord) : -1;
    if (wd >= 0) {
      const diff = (wd - weekdayOf(ctx.today) + 7) % 7 || 7;
      // "next friday" is genuinely ambiguous (the coming one, or the one after) unless today is
      // that weekday; the person chooses.
      if (next) {
        if (diff === 7) return { span: 2, value: addDays(ctx.today, 7), rule: 'next weekday' };
        const coming = addDays(ctx.today, diff);
        const after = addDays(ctx.today, diff + 7);
        return {
          span: 2,
          value: null,
          rule: 'next weekday',
          options: [
            { value: coming, label: `${coming} (this coming one)` },
            { value: after, label: `${after} (the week after)` },
          ],
        };
      }
      return { span: 1, value: addDays(ctx.today, diff), rule: 'weekday' };
    }
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(w);
    if (m) {
      const v = validDate(Number(m[1]), Number(m[2]), Number(m[3]));
      return v ? { span: 1, value: v, rule: 'iso date' } : null;
    }
    m = /^(\d{1,2})\/(\d{1,2})$/.exec(w);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      const dm = a <= 31 && b <= 12 ? nextMonthDay(ctx.today, b, a) : null; // day/month
      const md = a <= 12 && b <= 31 ? nextMonthDay(ctx.today, a, b) : null; // month/day
      if (dm && md && dm !== md)
        return {
          span: 1,
          value: null,
          rule: 'numeric date',
          options: [
            { value: md, label: `${md} (month/day)` },
            { value: dm, label: `${dm} (day/month)` },
          ],
        };
      const v = dm ?? md;
      return v ? { span: 1, value: v, rule: 'numeric date' } : null;
    }
    const mon = monthIndex(w);
    const nextW = list[i + 1]?.lower.replace(/[.,;]$/, '') ?? '';
    if (mon && /^\d{1,2}(st|nd|rd|th)?$/.test(nextW)) {
      const v = nextMonthDay(ctx.today, mon, parseInt(nextW, 10));
      return v ? { span: 2, value: v, rule: 'month day' } : null;
    }
    if (/^\d{1,2}(st|nd|rd|th)?$/.test(w) && monthIndex(nextW)) {
      const v = nextMonthDay(ctx.today, monthIndex(nextW), parseInt(w, 10));
      return v ? { span: 2, value: v, rule: 'day month' } : null;
    }
    return null;
  };
  for (let i = 0; i < list.length; i++) {
    if (used.has(i)) continue;
    const w = list[i]!;
    const lw = w.lower.replace(/[.,;]$/, '');
    // Dates, with an optional due/deadline keyword before them.
    const keyword = lw === 'due' || lw === 'deadline' || lw === 'by' || lw === 'on';
    const at = keyword ? i + 1 : i;
    const d = dateAt(at);
    if (d) {
      const field: ParseField = lw === 'deadline' || lw === 'by' ? 'deadline' : 'due_date';
      take(i, at + d.span - 1, {
        field,
        rule: d.rule,
        value: d.value,
        ...(d.options ? { options: d.options } : {}),
      });
      continue;
    }
    if (PRIORITY[lw]) {
      take(i, i, { field: 'priority', rule: 'priority marker', value: PRIORITY[lw] });
      continue;
    }
    const dur = /^~?(\d{1,3}(?:\.\d{1,2})?)(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/.exec(lw);
    const forDur =
      lw === 'for' && list[i + 1]
        ? /^(\d{1,3}(?:\.\d{1,2})?)(m|min|mins|h|hr|hrs|d)$/.exec(list[i + 1]!.lower)
        : null;
    const dm = dur ?? forDur;
    if (dm) {
      const n = Number(dm[1]);
      const unit = dm[2]!.charAt(0);
      const minutes = Math.round(unit === 'm' ? n : unit === 'h' ? n * 60 : n * 480);
      if (minutes > 0) {
        take(i, forDur ? i + 1 : i, {
          field: 'estimate_minutes',
          rule: 'duration',
          value: minutes,
        });
        continue;
      }
    }
    const simple: Record<string, { frequency: string; interval: number }> = {
      daily: { frequency: 'daily', interval: 1 },
      weekly: { frequency: 'weekly', interval: 1 },
      monthly: { frequency: 'monthly', interval: 1 },
      yearly: { frequency: 'yearly', interval: 1 },
    };
    if (simple[lw]) {
      take(i, i, { field: 'recurrence', rule: 'repeat word', value: simple[lw] });
      continue;
    }
    if (lw === 'every' && list[i + 1]) {
      let j = i + 1;
      let interval = 1;
      if (/^\d{1,2}$/.test(list[j]!.lower) || list[j]!.lower === 'other') {
        interval = list[j]!.lower === 'other' ? 2 : Number(list[j]!.lower);
        j++;
      }
      const unit = list[j]?.lower.replace(/[.,;]$/, '') ?? '';
      const freq = /^days?$/.test(unit)
        ? 'daily'
        : /^weeks?$/.test(unit)
          ? 'weekly'
          : /^months?$/.test(unit)
            ? 'monthly'
            : /^years?$/.test(unit)
              ? 'yearly'
              : null;
      const day = WEEKDAYS.findIndex((x) => x === unit || x.slice(0, 3) === unit);
      if (freq && interval >= 1) {
        take(i, j, { field: 'recurrence', rule: 'every', value: { frequency: freq, interval } });
        continue;
      }
      if (unit === 'weekday' || unit === 'weekdays') {
        take(i, j, {
          field: 'recurrence',
          rule: 'every weekday',
          value: { frequency: 'weekly', interval: 1, weekdays: ['MO', 'TU', 'WE', 'TH', 'FR'] },
        });
        continue;
      }
      if (day >= 0) {
        take(i, j, {
          field: 'recurrence',
          rule: 'every weekday name',
          value: { frequency: 'weekly', interval, weekdays: [BYDAY[day]] },
        });
        continue;
      }
    }
    const label = /^#([\p{L}\p{N}_-]{1,60})$/u.exec(w.text.replace(/[.,;]$/, ''));
    if (label) {
      take(i, i, { field: 'label', rule: '#label', value: label[1] });
      continue;
    }
    const project = /^\+(?:"([^"]{1,100})"|([\p{L}\p{N}_.-]{1,100}))$/u.exec(w.text);
    if (project) {
      take(i, i, { field: 'project', rule: '+project', value: project[1] ?? project[2] });
      continue;
    }
    const brand = /^brand:(?:"([^"]{1,100})"|([\p{L}\p{N}_.-]{1,100}))$/iu.exec(w.text);
    if (brand) {
      take(i, i, { field: 'brand', rule: 'brand:', value: brand[1] ?? brand[2] });
      continue;
    }
    const owner = /^@([\p{L}\p{N}_.-]{1,100})$/u.exec(w.text.replace(/[,;]$/, ''));
    if (owner) {
      take(i, i, { field: 'owner', rule: '@owner', value: owner[1] });
      continue;
    }
  }
  const title = list
    .filter((_, k) => !used.has(k))
    .map((w) => w.text)
    .join(' ')
    .concat(truncated ? ` ${line.slice(list.at(-1)!.end).trim()}` : '')
    .replace(/\s+/g, ' ')
    .trim();
  return { version: PARSER_VERSION, title, tokens, truncated };
}

/**
 * Splits pasted text into candidate lines (CAP-004): one per non-empty line, without list markers
 * (`-`, `*`, `•`, `1.`, `1)`, `[ ]`, `[x]`).
 */
export function splitPaste(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/^\s*(?:[-*•]|\d{1,3}[.)]|\[[ xX]?\])\s+/, '')
        .replace(/^\s*\[[ xX]?\]\s*/, '')
        .trim(),
    )
    .filter((l) => l.length > 0);
}
