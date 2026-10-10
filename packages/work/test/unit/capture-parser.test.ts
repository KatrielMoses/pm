import { describe, expect, it } from 'vitest';
import { parseCapture, PARSER_VERSION, splitPaste } from '../../src/capture/parser.ts';

// 2026-10-06 is a Tuesday.
const ctx = { today: '2026-10-06', tokensMax: 64 };
const fields = (line: string) =>
  Object.fromEntries(parseCapture(line, ctx).tokens.map((t) => [t.field, t.value]));

describe('deterministic capture parser (ADR-0017, CAP-003/CAP-009/CAP-010)', () => {
  it('detects dates, priority, duration, recurrence, labels, project, brand, and owner with spans', () => {
    const line =
      'Renew SSL cert due tomorrow !high 30m every month #ops +"Site Ops" brand:Harbor @dana';
    const r = parseCapture(line, ctx);
    expect(r.version).toBe(PARSER_VERSION);
    expect(r.title).toBe('Renew SSL cert');
    expect(fields(line)).toEqual({
      due_date: '2026-10-07',
      priority: 'high',
      estimate_minutes: 30,
      recurrence: { frequency: 'monthly', interval: 1 },
      label: 'ops',
      project: 'Site Ops',
      brand: 'Harbor',
      owner: 'dana',
    });
    for (const t of r.tokens) expect(line.slice(t.start, t.end)).toBe(t.text);
  });

  it('is deterministic and covers each date form', () => {
    expect(fields('a today').due_date).toBe('2026-10-06');
    expect(fields('a fri').due_date).toBe('2026-10-09');
    expect(fields('a tue').due_date).toBe('2026-10-13');
    expect(fields('a in 3 days').due_date).toBe('2026-10-09');
    expect(fields('a in 2 weeks').due_date).toBe('2026-10-20');
    expect(fields('a 2026-12-01').due_date).toBe('2026-12-01');
    expect(fields('a dec 3').due_date).toBe('2026-12-03');
    expect(fields('a 3 jan').due_date).toBe('2027-01-03');
    expect(fields('a deadline nov 30').deadline).toBe('2026-11-30');
    expect(fields('a by friday').deadline).toBe('2026-10-09');
    expect(fields('a 25/12').due_date).toBe('2026-12-25');
    expect(fields('a 2026-02-30')).toEqual({});
    expect(parseCapture('x due tomorrow', ctx)).toEqual(parseCapture('x due tomorrow', ctx));
  });

  it('marks genuinely ambiguous values with options instead of guessing', () => {
    const t = parseCapture('Call 3/4', ctx).tokens[0]!;
    expect(t).toMatchObject({ field: 'due_date', value: null });
    expect(t.options!.map((o) => o.value)).toEqual(['2027-03-04', '2027-04-03']);
    const n = parseCapture('Ship next fri', ctx).tokens[0]!;
    expect(n.value).toBeNull();
    expect(n.options!.map((o) => o.value)).toEqual(['2026-10-09', '2026-10-16']);
  });

  it('priority, duration, and recurrence variants', () => {
    expect(fields('a p1').priority).toBe('urgent');
    expect(fields('a !!').priority).toBe('high');
    expect(fields('a 2h').estimate_minutes).toBe(120);
    expect(fields('a for 45m').estimate_minutes).toBe(45);
    expect(fields('a ~1.5h').estimate_minutes).toBe(90);
    expect(fields('a daily').recurrence).toEqual({ frequency: 'daily', interval: 1 });
    expect(fields('a every 2 weeks').recurrence).toEqual({ frequency: 'weekly', interval: 2 });
    expect(fields('a every weekday').recurrence).toMatchObject({
      weekdays: ['MO', 'TU', 'WE', 'TH', 'FR'],
    });
    expect(fields('a every monday').recurrence).toMatchObject({ weekdays: ['MO'] });
  });

  it('leaves ordinary words alone and bounds the work', () => {
    expect(parseCapture('Read on the train', ctx)).toMatchObject({
      title: 'Read on the train',
      tokens: [],
    });
    const long = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ') + ' tomorrow';
    const r = parseCapture(long, { ...ctx, tokensMax: 10 });
    expect(r.truncated).toBe(true);
    expect(r.tokens).toEqual([]);
    expect(r.title.endsWith('tomorrow')).toBe(true);
  });

  it('splits pasted text into candidates without list markers', () => {
    expect(
      splitPaste('- Buy milk\n\n* Call Ana tomorrow\r\n1. Draft brief\n[ ] Pay rent\n  plain  '),
    ).toEqual(['Buy milk', 'Call Ana tomorrow', 'Draft brief', 'Pay rent', 'plain']);
  });
});
