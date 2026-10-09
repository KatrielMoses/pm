import { describe, expect, it } from 'vitest';
import { utcToLocal } from '../../src/recurrence.ts';
import {
  composeReportEmail,
  describeSchedule,
  dueOccurrence,
  freshness,
  nextRun,
  pdfSafe,
  renderPdf,
  reportLines,
  resolveRange,
  scheduleValid,
  validRange,
  type Schedule,
} from '../../src/insights/semantics.ts';
import {
  parseDashboardCreate,
  parseExportQuery,
  parseFilters,
  parseRecipients,
  parseScheduleInput,
  parseShare,
  parseWidgetQuery,
} from '../../src/insights/validation.ts';

/** A tiny seeded generator so the "property" loops are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

const ZONES = [
  'UTC',
  'Europe/Berlin',
  'America/New_York',
  'Australia/Lord_Howe',
  'Asia/Kolkata',
  'Pacific/Auckland',
];
const params = (_m: string, raw: unknown) =>
  raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

/** ADR-0030 D12: schedules are local-time occurrences, DST-safe, never a backlog. */
describe('schedules (5D)', () => {
  const daily = (tz: string, minute: number): Schedule => ({
    frequency: 'daily',
    weekday: null,
    monthday: null,
    minute,
    timezone: tz,
  });

  it('validates the shape of each frequency', () => {
    expect(scheduleValid(daily('UTC', 0))).toBe(true);
    expect(scheduleValid({ ...daily('UTC', 0), weekday: 3 })).toBe(false);
    expect(
      scheduleValid({
        frequency: 'weekly',
        weekday: 7,
        monthday: null,
        minute: 5,
        timezone: 'UTC',
      }),
    ).toBe(true);
    expect(
      scheduleValid({
        frequency: 'weekly',
        weekday: 8,
        monthday: null,
        minute: 5,
        timezone: 'UTC',
      }),
    ).toBe(false);
    expect(
      scheduleValid({
        frequency: 'monthly',
        weekday: null,
        monthday: 28,
        minute: 5,
        timezone: 'UTC',
      }),
    ).toBe(true);
    expect(
      scheduleValid({
        frequency: 'monthly',
        weekday: null,
        monthday: 29,
        minute: 5,
        timezone: 'UTC',
      }),
    ).toBe(false);
    expect(scheduleValid(daily('Not/AZone', 0))).toBe(false);
    expect(scheduleValid(daily('UTC', 1440))).toBe(false);
  });

  it('the next occurrence is strictly later, at the scheduled local time, and nothing is skipped (property)', () => {
    const r = rng(5);
    for (let i = 0; i < 400; i++) {
      const tz = pick(r, ZONES);
      const minute = Math.floor(r() * 1440);
      const kind = pick(r, ['daily', 'weekly', 'monthly'] as const);
      const s: Schedule = {
        frequency: kind,
        weekday: kind === 'weekly' ? 1 + Math.floor(r() * 7) : null,
        monthday: kind === 'monthly' ? 1 + Math.floor(r() * 28) : null,
        minute,
        timezone: tz,
      };
      const after = new Date(Date.UTC(2026, 0, 1) + Math.floor(r() * 365 * 86_400_000));
      const n = nextRun(s, after);
      expect(n.getTime()).toBeGreaterThan(after.getTime());
      // At most one period later (a month, at most 32 days).
      expect(n.getTime() - after.getTime()).toBeLessThanOrEqual(33 * 86_400_000);
      const local = utcToLocal(n, tz);
      const [h, m] = [Number(local.slice(11, 13)), Number(local.slice(14, 16))];
      const atMinute = h * 60 + m;
      // A local time inside a DST gap resolves forward (never earlier than asked, within 2 hours).
      const delta = (atMinute - minute + 1440) % 1440;
      expect(delta === 0 || delta <= 120).toBe(true);
      // Nothing between `after` and `n` is an occurrence: stepping from `after` finds `n` again.
      expect(nextRun(s, new Date(n.getTime() - 1)).getTime()).toBe(n.getTime());
      // The one after is later still.
      expect(nextRun(s, n).getTime()).toBeGreaterThan(n.getTime());
    }
  });

  it('keeps the local clock across a DST change', () => {
    const s = daily('Europe/Berlin', 9 * 60);
    const before = nextRun(s, new Date('2026-03-27T12:00:00Z'));
    const across = nextRun(s, new Date('2026-03-28T12:00:00Z'));
    expect(utcToLocal(before, 'Europe/Berlin').slice(11)).toBe('09:00');
    expect(utcToLocal(across, 'Europe/Berlin').slice(11)).toBe('09:00');
    // The UTC hour moved by one: 08:00Z before the change, 07:00Z after.
    expect(before.getUTCHours()).toBe(8);
    expect(across.getUTCHours()).toBe(7);
  });

  it('a nonexistent local time resolves forward and an ambiguous one to the first', () => {
    const gap = nextRun(daily('America/New_York', 2 * 60 + 30), new Date('2026-03-07T12:00:00Z'));
    expect(utcToLocal(gap, 'America/New_York')).toMatch(/2026-03-08T0[3-4]/);
    const overlap = nextRun(daily('America/New_York', 60 + 30), new Date('2026-10-31T12:00:00Z'));
    expect(overlap.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('owes one delivery for a long outage, never a backlog (property)', () => {
    const r = rng(11);
    for (let i = 0; i < 60; i++) {
      const s = daily(pick(r, ZONES), Math.floor(r() * 1440));
      const first = nextRun(s, new Date(Date.UTC(2026, 5, 1)));
      const now = new Date(first.getTime() + Math.floor(r() * 90 * 86_400_000));
      const due = dueOccurrence(s, first, now);
      expect(due.getTime()).toBeLessThanOrEqual(now.getTime());
      expect(due.getTime()).toBeGreaterThanOrEqual(first.getTime());
      expect(nextRun(s, due).getTime()).toBeGreaterThan(now.getTime());
    }
  }, 30_000);

  it('describes a schedule in words with its zone', () => {
    expect(
      describeSchedule({
        frequency: 'weekly',
        weekday: 1,
        monthday: null,
        minute: 510,
        timezone: 'UTC',
      }),
    ).toBe('Every Monday at 08:30 UTC');
    expect(
      describeSchedule({
        frequency: 'monthly',
        weekday: null,
        monthday: 3,
        minute: 0,
        timezone: 'UTC',
      }),
    ).toBe('Day 3 of every month at 00:00 UTC');
  });
});

describe('ranges and freshness (5D)', () => {
  it('resolves presets in the workspace calendar', () => {
    expect(resolveRange({ preset: 'last_7_days' }, '2026-10-09')).toMatchObject({
      from: '2026-10-03',
      to: '2026-10-09',
    });
    expect(resolveRange({ preset: 'this_month' }, '2026-02-10')).toMatchObject({
      from: '2026-02-01',
      to: '2026-02-28',
    });
    expect(resolveRange({ preset: 'last_month' }, '2026-03-05')).toMatchObject({
      from: '2026-02-01',
      to: '2026-02-28',
    });
    expect(resolveRange({ preset: 'this_week' }, '2026-10-09', 1)).toMatchObject({
      from: '2026-10-05',
      to: '2026-10-11',
    });
    expect(resolveRange({ preset: 'this_week' }, '2026-10-09', 7)).toMatchObject({
      from: '2026-10-04',
      to: '2026-10-10',
    });
    expect(resolveRange(null, '2026-10-09')).toBeNull();
  });
  it('accepts only real, ordered, bounded custom ranges', () => {
    expect(validRange('2026-01-01', '2026-12-31')).toBe(true);
    expect(validRange('2026-02-30', '2026-03-01')).toBe(false);
    expect(validRange('2026-03-02', '2026-03-01')).toBe(false);
    expect(validRange('2024-01-01', '2026-01-01')).toBe(false);
  });
  it('labels derived data stale only past the threshold', () => {
    const now = new Date('2026-10-09T12:00:00Z');
    expect(freshness(now, null, 60)).toMatchObject({ basis: 'live', stale: false });
    expect(freshness(now, new Date('2026-10-09T11:30:00Z'), 60)).toMatchObject({
      basis: 'derived',
      stale: false,
    });
    expect(freshness(now, new Date('2026-10-09T09:00:00Z'), 60).stale).toBe(true);
  });
});

describe('export documents (5D)', () => {
  const tables = [
    {
      title: 'Open tasks (Café)',
      caption: 'Work you can read · live',
      columns: ['Group', 'Count'],
      rows: [
        ['Launch', 3],
        ['=cmd|calc', 1],
      ] as Array<Array<string | number | null>>,
      notes: ['The count stopped at its limit.'],
    },
  ];
  it('writes a valid, paginated PDF that contains only the lines it was given', () => {
    const lines = reportLines('Weekly', 'Prepared for you', tables);
    const pdf = renderPdf(lines, 'footer');
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('Launch');
    expect(text).not.toContain('Vault');
    // xref offsets point at their objects.
    const start = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(start, start + 4)).toBe('xref');
    const many = renderPdf(
      Array.from({ length: 200 }, (_, i) => `line ${i}`),
      'f',
    ).toString('latin1');
    expect(/Count (\d+)/.exec(many)![1]).toBe('4');
  });
  it('escapes parentheses and maps what a base font cannot show', () => {
    expect(pdfSafe('Café – 日本')).toBe('Cafe ? ??');
    const pdf = renderPdf(['a (b) \\ c'], 'f').toString('latin1');
    expect(pdf).toContain('(a \\(b\\) \\\\ c)');
  });
  it('composes an email whose figures are the recipient’s own and bounded', () => {
    const big = Array.from({ length: 40 }, (_, i) => [`r${i}`, i] as Array<string | number | null>);
    const mail = composeReportEmail({
      title: 'Digest <b>',
      scheduleText: 'Every day',
      tables: [{ ...tables[0]!, rows: big }],
      url: 'https://pm.test/x',
      footer: 'footer',
      rowsMax: 5,
    });
    expect(mail.text).toContain('(35 more rows in the report)');
    expect(mail.text).not.toContain('r39');
    expect(mail.html).toContain('&lt;b&gt;');
    expect(mail.html).not.toContain('<b>');
  });
});

describe('input parsers (5D)', () => {
  const ctx = { maxWidgets: 3, params };
  it('refuses unknown fields, too many widgets, and duplicate ids with pointer-precise issues', () => {
    const e = (() => {
      try {
        parseDashboardCreate(
          {
            title: 'X',
            kind: 'owner',
            extra: 1,
            layout: { widgets: [1, 2, 3, 4].map((i) => ({ id: `w${i}`, metric: 'm' })) },
          },
          ctx,
        );
      } catch (err) {
        return err as { issues: Array<{ pointer: string; code: string }> };
      }
      return { issues: [] };
    })();
    expect(e.issues.map((i) => i.pointer).sort()).toEqual(['/extra', '/layout/widgets']);
    const dup = (() => {
      try {
        parseDashboardCreate(
          {
            title: 'X',
            kind: 'owner',
            layout: {
              widgets: [
                { id: 'a', metric: 'm' },
                { id: 'a', metric: 'm' },
              ],
            },
          },
          ctx,
        );
      } catch (err) {
        return err as { issues: Array<{ pointer: string; code: string }> };
      }
      return { issues: [] };
    })();
    expect(dup.issues[0]).toMatchObject({ code: 'duplicate' });
  });
  it('ties a dashboard kind to its placement', () => {
    const code = (b: Record<string, unknown>) => {
      try {
        parseDashboardCreate({ title: 'X', ...b }, ctx);
        return 'ok';
      } catch (err) {
        return (err as { issues: Array<{ code: string; pointer: string }> }).issues[0]!.code;
      }
    };
    expect(code({ kind: 'brand' })).toBe('required');
    expect(code({ kind: 'brand', brand: 'br_nope' })).toBe('invalid_reference');
    expect(code({ kind: 'owner' })).toBe('ok');
    expect(code({ kind: 'nonsense' })).toBe('invalid_option');
  });
  it('parses filters strictly', () => {
    const f = parseFilters({
      range: { preset: 'last_30_days' },
      statuses: ['active', 'active'],
      people: ['me'],
    });
    expect(f.value).toMatchObject({ statuses: ['active'], people: ['me'] });
    expect(
      parseFilters({ range: { from: '2026-02-30', to: '2026-03-01' } }).issues.list[0]?.code,
    ).toBe('invalid_range');
    expect(parseFilters({ bogus: 1 }).issues.list[0]?.code).toBe('unsupported_field');
    expect(parseFilters({ statuses: ['nope'] }).issues.list[0]?.code).toBe('invalid_option');
  });
  it('parses schedules, recipients, shares, and export options', () => {
    expect(
      parseScheduleInput({
        version: 1,
        schedule: { frequency: 'weekly', weekday: 2, time: '08:30', timezone: 'Europe/Berlin' },
      }).schedule,
    ).toMatchObject({
      minute: 510,
    });
    expect(parseScheduleInput({ schedule: null }).schedule).toBeNull();
    expect(() =>
      parseScheduleInput({ schedule: { frequency: 'weekly', time: '25:00', timezone: 'UTC' } }),
    ).toThrow();
    expect(() => parseRecipients({ members: ['nope'] }, 5)).toThrow();
    expect(() =>
      parseShare({ grantee: 'mem_01HZZZZZZZZZZZZZZZZZZZZZZZ', expires_at: '2001-01-01T00:00:00Z' }),
    ).toThrow();
    expect(parseExportQuery({}).format).toBe('csv');
    expect(() => parseExportQuery({ format: 'xlsx' })).toThrow();
    expect(
      parseWidgetQuery({ filters: JSON.stringify({ people: ['me'] }), limit: '500' }, 100).limit,
    ).toBe(100);
    expect(() => parseWidgetQuery({ filters: '{not json' }, 100)).toThrow();
  });
});
