import { describe, expect, it } from 'vitest';
import {
  addDays,
  bucketOf,
  clockOf,
  csv,
  csvCell,
  entriesHash,
  hoursOf,
  isoWeekday,
  localDay,
  parseInstant,
  periodOf,
  secondsBetween,
  validDay,
  validZone,
} from '../../src/time/semantics.ts';

/** ADR-0019 T1–T4: deterministic time semantics with no database. */
describe('time semantics (3D)', () => {
  it('accepts only real IANA zones and real calendar days', () => {
    expect(validZone('Europe/Lisbon')).toBe('Europe/Lisbon');
    expect(validZone('America/Argentina/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires');
    for (const z of ['Mars/Olympus', 'UTC; DROP', '', 42, 'x'.repeat(70)])
      expect(validZone(z)).toBeNull();
    expect(validDay('2028-02-29')).toBe('2028-02-29');
    for (const d of ['2026-02-29', '2026-13-01', '2026-1-1', '20260101', null])
      expect(validDay(d)).toBeNull();
  });

  it('parses only instants with an explicit offset, truncated to whole seconds', () => {
    expect(parseInstant('2026-03-29T01:30:00+01:00')!.toISOString()).toBe(
      '2026-03-29T00:30:00.000Z',
    );
    expect(parseInstant('2026-03-29T01:30:59.999Z')!.toISOString()).toBe(
      '2026-03-29T01:30:59.000Z',
    );
    for (const v of ['2026-03-29T01:30:00', '2026-03-29', 'yesterday', 1_700_000_000])
      expect(parseInstant(v)).toBeNull();
  });

  it('measures durations in UTC so DST days count the hours that passed', () => {
    // Berlin spring forward (23-hour day) and Lisbon fall back (25-hour day).
    const a = parseInstant('2026-03-29T00:00:00+01:00')!;
    const b = parseInstant('2026-03-30T00:00:00+02:00')!;
    expect(secondsBetween(a, b)).toBe(23 * 3600);
    const c = parseInstant('2025-10-26T00:00:00+01:00')!;
    const d = parseInstant('2025-10-27T00:00:00Z')!;
    expect(secondsBetween(c, d)).toBe(25 * 3600);
    // The local day of an instant depends on the zone.
    const late = new Date('2026-10-14T23:30:00Z');
    expect(localDay(late, 'Europe/Lisbon')).toBe('2026-10-15');
    expect(localDay(late, 'America/New_York')).toBe('2026-10-14');
    expect(localDay(late, 'Asia/Singapore')).toBe('2026-10-15');
  });

  it('places days in the workspace week for every week start', () => {
    expect(isoWeekday('2026-10-05')).toBe(1);
    expect(isoWeekday('2026-10-11')).toBe(7);
    expect(periodOf('2026-10-07', 1)).toEqual({ start: '2026-10-05', end: '2026-10-11' });
    expect(periodOf('2026-10-07', 7)).toEqual({ start: '2026-10-04', end: '2026-10-10' });
    expect(periodOf('2026-10-04', 7)).toEqual({ start: '2026-10-04', end: '2026-10-10' });
    for (let ws = 1; ws <= 7; ws++)
      for (let i = 0; i < 14; i++) {
        const day = addDays('2026-12-25', i);
        const p = periodOf(day, ws);
        expect(isoWeekday(p.start)).toBe(ws);
        expect(day >= p.start && day <= p.end).toBe(true);
        expect(addDays(p.start, 6)).toBe(p.end);
      }
    expect(bucketOf('2026-10-07', 'month', 1)).toBe('2026-10-01');
    expect(bucketOf('2026-10-07', 'week', 1)).toBe('2026-10-05');
    expect(bucketOf('2026-10-07', 'day', 1)).toBe('2026-10-07');
  });

  it('rounds once, half-up, to hundredths of an hour from exact seconds', () => {
    expect(hoursOf(0)).toBe(0);
    expect(hoursOf(17)).toBe(0); // 0.0047 h
    expect(hoursOf(18)).toBe(0.01); // exactly 0.005 h rounds up
    expect(hoursOf(5400)).toBe(1.5);
    expect(hoursOf(26_400)).toBe(7.33);
    // Summing then rounding differs from rounding each entry: totals always use exact seconds.
    expect(hoursOf(18 * 3)).toBe(0.02);
    expect(clockOf(5415)).toBe('1:30');
    expect(clockOf(59)).toBe('0:00');
  });

  it('hashes an entry set independent of order and sensitive to every recorded fact', () => {
    const e = (id: string, s: number, b = false, v = 0) => ({
      public_id: id,
      duration_seconds: s,
      billable: b,
      version: v,
    });
    const h = entriesHash([e('te_A', 60), e('te_B', 120, true)]);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(entriesHash([e('te_B', 120, true), e('te_A', 60)])).toBe(h);
    for (const changed of [
      [e('te_A', 61), e('te_B', 120, true)],
      [e('te_A', 60, true), e('te_B', 120, true)],
      [e('te_A', 60, false, 1), e('te_B', 120, true)],
      [e('te_A', 60)],
    ])
      expect(entriesHash(changed)).not.toBe(h);
  });

  it('writes RFC 4180 CSV and neutralizes spreadsheet formulas', () => {
    expect(csvCell('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(null)).toBe('');
    expect(csv(['A', 'B'], [[1, 'x\ny']])).toBe('A,B\r\n1,"x\ny"\r\n');
  });
});
