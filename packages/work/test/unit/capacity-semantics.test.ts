import { describe, expect, it } from 'vitest';
import {
  allDayInterval,
  allocation,
  availability,
  crossBrandOverlaps,
  intersect,
  merge,
  minutes,
  nominalWeekMinutes,
  subtract,
  workingIntervals,
} from '../../src/capacity/semantics.ts';

const d = (s: string) => new Date(s);
const NINE_FIVE = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: 540, end: 1020 }));

/** ADR-0022 C1–C3: working hours in the person's zone, availability, allocation, overlaps. */
describe('capacity semantics (3E)', () => {
  it('turns local windows into instants per date, keeping DST days their real length', () => {
    const allDay = [{ weekday: 7, start: 0, end: 1440 }];
    expect(minutes(workingIntervals('2026-03-29', 'Europe/Berlin', allDay))).toBe(23 * 60);
    expect(minutes(workingIntervals('2026-10-25', 'Europe/Berlin', allDay))).toBe(25 * 60);
    expect(minutes(workingIntervals('2026-03-08', 'America/New_York', allDay))).toBe(23 * 60);
    // 09:00–17:00 on a DST day is still 8 hours of wall-clock work.
    const sunday = [{ weekday: 7, start: 540, end: 1020 }];
    expect(minutes(workingIntervals('2026-03-29', 'Europe/Berlin', sunday))).toBe(480);
    const [w] = workingIntervals('2026-03-29', 'Europe/Berlin', sunday);
    expect(w!.start.toISOString()).toBe('2026-03-29T07:00:00.000Z');
    // A window on another weekday contributes nothing.
    expect(workingIntervals('2026-03-30', 'Europe/Berlin', sunday)).toEqual([]);
  });

  it('merges, subtracts, and intersects intervals', () => {
    const a = { start: d('2026-01-05T09:00Z'), end: d('2026-01-05T12:00Z') };
    const b = { start: d('2026-01-05T11:00Z'), end: d('2026-01-05T14:00Z') };
    expect(minutes(merge([a, b]))).toBe(300);
    expect(minutes(subtract([a], [b]))).toBe(120);
    expect(
      minutes(subtract([a], [{ start: d('2026-01-05T10:00Z'), end: d('2026-01-05T10:30Z') }])),
    ).toBe(150);
    expect(minutes(intersect([a], [b]))).toBe(60);
    expect(nominalWeekMinutes(NINE_FIVE)).toBe(2400);
  });

  it('removes time off and observed holidays, and scales by a weekly override', () => {
    const base = { from: '2026-01-05', to: '2026-01-11', tz: 'UTC', windows: NINE_FIVE };
    const plain = availability({ ...base, timeOff: [], holidays: new Set(), weeklyOverride: null });
    expect(plain.map((x) => x.available)).toEqual([480, 480, 480, 480, 480, 0, 0]);
    const off = availability({
      ...base,
      timeOff: [
        allDayInterval('2026-01-06', '2026-01-06', 'UTC'),
        { start: d('2026-01-07T09:00Z'), end: d('2026-01-07T10:30Z') },
      ],
      holidays: new Set(['2026-01-09']),
      weeklyOverride: 1200,
    });
    expect(off.map((x) => x.available)).toEqual([240, 0, 195, 240, 0, 0, 0]);
    expect(off[1]).toMatchObject({ working: 480, off: 480 });
    expect(off[4]).toMatchObject({ holiday: true, off: 480 });
  });

  it('reads all-day time off in its own zone', () => {
    const i = allDayInterval('2026-03-29', '2026-03-29', 'Europe/Berlin');
    expect(i.start.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(i.end.toISOString()).toBe('2026-03-29T22:00:00.000Z');
  });

  it('classifies over, under, and ok allocation', () => {
    expect(allocation(480, 540)).toMatchObject({ over: 60, under: 0, state: 'over' });
    expect(allocation(480, 120)).toMatchObject({ over: 0, under: 360, state: 'under' });
    expect(allocation(480, 400)).toMatchObject({ state: 'ok' });
    expect(allocation(0, 0)).toMatchObject({ state: 'ok' });
  });

  it('reports overlaps only between different brands', () => {
    const at = (h: number) => d(`2026-01-05T${String(h).padStart(2, '0')}:00Z`);
    const out = crossBrandOverlaps([
      { id: 'a', brand: 'H', start: at(9), end: at(11) },
      { id: 'b', brand: 'S', start: at(10), end: at(12) },
      { id: 'c', brand: 'H', start: at(10), end: at(11) },
      { id: 'd', brand: null, start: at(9), end: at(12) },
    ]);
    expect(out.map((o) => [o.a.id, o.b.id, o.minutes])).toEqual([
      ['a', 'b', 60],
      ['b', 'c', 60],
    ]);
  });
});
