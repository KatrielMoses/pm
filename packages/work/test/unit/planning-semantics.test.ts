import { describe, expect, it } from 'vitest';
import {
  blockWarnings,
  dayBounds,
  minutesBetween,
  validClock,
  wholeMinute,
} from '../../src/planning/semantics.ts';

/** ADR-0020 P1–P3: Today's day bounds, block arithmetic, and deadline warnings (no database). */
describe('planning semantics (3C)', () => {
  it('bounds a day by local midnights, so DST days are 23 or 25 hours', () => {
    const hours = (d: { start: Date; end: Date }) =>
      (d.end.getTime() - d.start.getTime()) / 3_600_000;
    expect(hours(dayBounds('2026-03-29', 'Europe/Berlin'))).toBe(23);
    expect(hours(dayBounds('2025-10-26', 'Europe/Lisbon'))).toBe(25);
    expect(hours(dayBounds('2026-07-01', 'Asia/Singapore'))).toBe(24);
    expect(dayBounds('2026-10-14', 'America/New_York').start.toISOString()).toBe(
      '2026-10-14T04:00:00.000Z',
    );
    expect(dayBounds('2026-10-14', 'Asia/Singapore').start.toISOString()).toBe(
      '2026-10-13T16:00:00.000Z',
    );
  });

  it('works in whole minutes and accepts only real clock times', () => {
    expect(wholeMinute(new Date('2026-10-14T09:12:59.999Z')).toISOString()).toBe(
      '2026-10-14T09:12:00.000Z',
    );
    expect(minutesBetween(new Date('2026-10-14T09:00:00Z'), new Date('2026-10-14T10:30:00Z'))).toBe(
      90,
    );
    expect(validClock('09:30')).toBe('09:30');
    for (const v of ['9:30', '24:00', '12:60', 930, null]) expect(validClock(v)).toBeNull();
  });

  it('warns when a block ends after the due day or the deadline, in the viewer zone', () => {
    const task = {
      due_date: '2026-10-14',
      deadline_date: null,
      deadline_at: new Date('2026-10-15T21:00:00Z'),
    };
    // 22:30 Lisbon on the due day is still the due day there; 23:30 UTC on the 14th is the 15th in Singapore.
    expect(blockWarnings(new Date('2026-10-14T21:30:00Z'), 'Europe/Lisbon', task)).toEqual([]);
    expect(blockWarnings(new Date('2026-10-14T23:30:00Z'), 'Asia/Singapore', task)).toEqual([
      'after_due_date',
    ]);
    expect(blockWarnings(new Date('2026-10-15T22:00:00Z'), 'Europe/Lisbon', task)).toEqual([
      'after_due_date',
      'after_deadline',
    ]);
    expect(
      blockWarnings(new Date('2026-10-15T00:01:00Z'), 'UTC', {
        due_date: null,
        deadline_date: '2026-10-14',
        deadline_at: null,
      }),
    ).toEqual(['after_deadline']);
  });
});
