import { describe, expect, it } from 'vitest';
import {
  dayStart,
  dueOccurrence,
  nextOccurrence,
  occurrenceInstant,
  occurrenceKey,
  reportingWindow,
} from '../../src/ai/briefing/schedule.ts';

const ALL = [1, 2, 3, 4, 5, 6, 7];

describe('Phase 7E briefing schedule arithmetic (BRF-014)', () => {
  it('a local time inside a spring-forward gap runs at the first valid instant after the gap', () => {
    // New York, 2026-03-08: 02:00 -> 03:00 local. 02:30 does not exist.
    expect(occurrenceInstant('2026-03-08', 150, 'America/New_York').toISOString()).toBe(
      '2026-03-08T07:00:00.000Z',
    );
    // An unaffected time the same day keeps its offset.
    expect(occurrenceInstant('2026-03-08', 8 * 60, 'America/New_York').toISOString()).toBe(
      '2026-03-08T12:00:00.000Z',
    );
    // Half-hour shift (Lord Howe, 02:00 -> 02:30 on 2026-10-04).
    expect(occurrenceInstant('2026-10-04', 135, 'Australia/Lord_Howe').toISOString()).toBe(
      '2026-10-03T15:30:00.000Z',
    );
  });

  it('an ambiguous fall-back time runs only at its earlier instant', () => {
    // New York, 2026-11-01: 01:30 happens at 05:30Z (EDT) and 06:30Z (EST).
    const o = occurrenceInstant('2026-11-01', 90, 'America/New_York');
    expect(o.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    const s = { timezone: 'America/New_York', local_minute: 90, weekdays: ALL };
    // The next occurrence after the earlier instant is the next local day, never the repeat.
    expect(nextOccurrence(s, o)!.day).toBe('2026-11-02');
    expect(dueOccurrence(s, o, new Date('2026-11-01T06:45:00Z'))!.at.toISOString()).toBe(
      o.toISOString(),
    );
  });

  it('weekday filters, next run, and the stable occurrence key', () => {
    const s = { timezone: 'Asia/Kolkata', local_minute: 9 * 60, weekdays: [1, 2, 3, 4, 5] };
    // Friday 2026-10-16 10:00 IST -> next is Monday 2026-10-19 09:00 IST.
    const n = nextOccurrence(s, new Date('2026-10-16T04:30:00Z'))!;
    expect(n).toMatchObject({ day: '2026-10-19', time: '09:00' });
    expect(n.at.toISOString()).toBe('2026-10-19T03:30:00.000Z');
    expect(occurrenceKey('bsc_x', 3, n)).toBe('bsc_x:r3:2026-10-19T09:00');
    expect(nextOccurrence({ ...s, weekdays: [] }, new Date())).toBeNull();
  });

  it('a late sweep owes only the latest missed occurrence, and nothing before next_run_at', () => {
    const s = { timezone: 'UTC', local_minute: 8 * 60, weekdays: ALL };
    const due = dueOccurrence(
      s,
      new Date('2026-10-10T08:00:00Z'),
      new Date('2026-10-13T09:00:00Z'),
    );
    expect(due!.day).toBe('2026-10-13');
    expect(
      dueOccurrence(s, new Date('2026-10-14T08:00:00Z'), new Date('2026-10-13T09:00:00Z')),
    ).toBeNull();
    // Exactly at the occurrence instant it is due.
    const at = new Date('2026-10-13T08:00:00Z');
    expect(dueOccurrence(s, at, at)!.day).toBe('2026-10-13');
  });

  it('windows follow the local calendar: 23- and 25-hour days, weekly spans, baselines, clamps', () => {
    const tz = 'America/New_York';
    // A first daily briefing on 2026-03-09 covers local 2026-03-08, a 23-hour day.
    const cut = occurrenceInstant('2026-03-09', 0, tz);
    const w = reportingWindow('owner_daily', tz, cut, null);
    expect(w.start.toISOString()).toBe(dayStart('2026-03-08', tz).toISOString());
    expect((w.end.getTime() - w.start.getTime()) / 3_600_000).toBe(23);
    const fall = reportingWindow('brand_daily', tz, occurrenceInstant('2026-11-02', 0, tz), null);
    expect((fall.end.getTime() - fall.start.getTime()) / 3_600_000).toBe(25);
    // A weekly review spanning the spring change is 7 local days, 167 hours.
    const wk = reportingWindow('weekly_review', tz, occurrenceInstant('2026-03-12', 0, tz), null);
    expect((wk.end.getTime() - wk.start.getTime()) / 3_600_000).toBe(167);
    // With a baseline, the window starts exactly at its end.
    const base = new Date('2026-10-12T12:00:00Z');
    const b = reportingWindow('owner_daily', 'UTC', new Date('2026-10-13T12:00:00Z'), base);
    expect(b).toMatchObject({ start: base, clamped: false });
    // An ancient baseline is clamped and says so.
    const c = reportingWindow(
      'owner_daily',
      'UTC',
      new Date('2026-10-13T12:00:00Z'),
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(c.clamped).toBe(true);
    expect(c.start.toISOString()).toBe('2026-09-12T00:00:00.000Z');
  });
});
