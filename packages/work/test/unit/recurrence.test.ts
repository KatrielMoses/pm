import { describe, expect, it } from 'vitest';
import {
  composeRule,
  describeRule,
  localToUtc,
  occurrences,
  parseRule,
  RuleError,
} from '../../src/recurrence.ts';
import { parseRecurrence } from '../../src/validation.ts';

const issues = (body: unknown) => {
  try {
    parseRecurrence(body);
    return [];
  } catch (e) {
    return (e as { issues: Array<{ pointer: string; code: string }> }).issues.map(
      (i) => `${i.code}@${i.pointer}`,
    );
  }
};
const base = { start: '2026-11-02T09:00', anchor_tz: 'Europe/Lisbon' };

describe('recurrence rules (OD-14, 0B temporal model)', () => {
  it('all four frequencies, with interval, weekdays, and month days', () => {
    const occ = (body: Record<string, unknown>, n = 4) => {
      const r = parseRecurrence({ ...base, ...body });
      return occurrences(parseRule(r.rrule), r.start, null, n);
    };
    expect(occ({ frequency: 'daily', interval: 2 })).toEqual([
      '2026-11-02T09:00',
      '2026-11-04T09:00',
      '2026-11-06T09:00',
      '2026-11-08T09:00',
    ]);
    // 2026-11-02 is a Monday.
    expect(occ({ frequency: 'weekly', weekdays: ['WE', 'MO'] })).toEqual([
      '2026-11-02T09:00',
      '2026-11-04T09:00',
      '2026-11-09T09:00',
      '2026-11-11T09:00',
    ]);
    // Months without day 31 are skipped, never moved.
    expect(occ({ frequency: 'monthly', month_days: [31] }, 3)).toEqual([
      '2026-12-31T09:00',
      '2027-01-31T09:00',
      '2027-03-31T09:00',
    ]);
    expect(occ({ frequency: 'yearly' }, 2)).toEqual(['2026-11-02T09:00', '2027-11-02T09:00']);
    expect(
      parseRecurrence({ ...base, frequency: 'weekly', weekdays: ['WE', 'MO'], interval: 2 }).rrule,
    ).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE');
  });

  it('end conditions: after N occurrences (counted from the start) or on a local date (inclusive)', () => {
    const count = parseRecurrence({
      ...base,
      frequency: 'daily',
      ends: { type: 'after', count: 3 },
    });
    expect(count.rrule).toBe('FREQ=DAILY;COUNT=3');
    const rule = parseRule(count.rrule);
    expect(occurrences(rule, base.start, null, 10)).toHaveLength(3);
    expect(occurrences(rule, base.start, '2026-11-03T09:00', 10)).toEqual(['2026-11-04T09:00']);
    expect(occurrences(rule, base.start, '2026-11-04T09:00', 10)).toEqual([]);
    const until = parseRecurrence({
      ...base,
      frequency: 'weekly',
      weekdays: ['MO'],
      ends: { type: 'on', date: '2026-11-16' },
    });
    expect(until.rrule).toBe('FREQ=WEEKLY;BYDAY=MO;UNTIL=20261116');
    expect(occurrences(parseRule(until.rrule), base.start, null, 10)).toEqual([
      '2026-11-02T09:00',
      '2026-11-09T09:00',
      '2026-11-16T09:00',
    ]);
    expect(describeRule(until.rrule)).toEqual({
      frequency: 'weekly',
      interval: 1,
      weekdays: ['MO'],
      monthDays: null,
      ends: { type: 'on', date: '2026-11-16' },
    });
    expect(composeRule(describeRule('FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1,15;COUNT=5'))).toBe(
      'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1,15;COUNT=5',
    );
    expect(() => parseRule('FREQ=DAILY;COUNT=2;UNTIL=20270101')).toThrow(RuleError);
    expect(() => parseRule('FREQ=MONTHLY;BYSETPOS=1;BYDAY=MO')).toThrow(RuleError);
  });

  it('local time is the intent across DST (0A example 5): UTC shifts, the local key does not', () => {
    const r = parseRecurrence({
      frequency: 'weekly',
      weekdays: ['FR'],
      start: '2026-10-23T16:00',
      anchor_tz: 'Europe/Lisbon',
    });
    const keys = occurrences(parseRule(r.rrule), r.start, null, 2);
    expect(keys).toEqual(['2026-10-23T16:00', '2026-10-30T16:00']);
    expect(localToUtc(keys[0]!, 'Europe/Lisbon').toISOString()).toBe('2026-10-23T15:00:00.000Z');
    expect(localToUtc(keys[1]!, 'Europe/Lisbon').toISOString()).toBe('2026-10-30T16:00:00.000Z');
    // A local time inside the spring-forward gap keeps its key and resolves forward.
    expect(localToUtc('2027-03-28T01:30', 'Europe/Lisbon').toISOString()).toBe(
      '2027-03-28T01:30:00.000Z',
    );
    expect(localToUtc('2026-11-01T01:30', 'America/New_York').toISOString()).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });

  it('unsupported combinations are field errors, never normalized', () => {
    expect(issues({ ...base, frequency: 'hourly' })).toEqual(['invalid_option@/frequency']);
    expect(issues({ ...base })).toEqual(['required@/frequency']);
    expect(issues({ ...base, frequency: 'daily', interval: 0 })).toEqual([
      'invalid_number@/interval',
    ]);
    expect(issues({ ...base, frequency: 'daily', interval: '2' })).toEqual([
      'invalid_number@/interval',
    ]);
    expect(issues({ ...base, frequency: 'daily', weekdays: ['MO'] })).toEqual([
      'not_applicable@/weekdays',
    ]);
    expect(issues({ ...base, frequency: 'weekly', weekdays: [] })).toEqual([
      'invalid_option@/weekdays',
    ]);
    expect(issues({ ...base, frequency: 'weekly', weekdays: ['MO', 'MO'] })).toEqual([
      'invalid_option@/weekdays',
    ]);
    expect(issues({ ...base, frequency: 'weekly', month_days: [1] })).toEqual([
      'not_applicable@/month_days',
    ]);
    expect(issues({ ...base, frequency: 'monthly', month_days: [32] })).toEqual([
      'invalid_option@/month_days',
    ]);
    expect(issues({ ...base, frequency: 'daily', start: '2026-02-30T09:00' })).toEqual([
      'invalid_date@/start',
    ]);
    expect(issues({ ...base, frequency: 'daily', start: '2026-02-01T24:00' })).toEqual([
      'invalid_date@/start',
    ]);
    expect(issues({ ...base, frequency: 'daily', anchor_tz: 'Mars/Olympus' })).toEqual([
      'invalid_timezone@/anchor_tz',
    ]);
    expect(issues({ ...base, frequency: 'daily', ends: { type: 'after', count: 1000 } })).toEqual([
      'invalid_number@/ends/count',
    ]);
    expect(
      issues({ ...base, frequency: 'daily', ends: { type: 'on', date: '2026-11-01' } }),
    ).toEqual(['before_start@/ends/date']);
    expect(issues({ ...base, frequency: 'daily', ends: { type: 'sometime' } })).toEqual([
      'invalid_option@/ends',
    ]);
    expect(issues({ ...base, frequency: 'daily', rrule: 'FREQ=DAILY' })).toEqual([
      'unsupported_field@/rrule',
    ]);
  });
});
