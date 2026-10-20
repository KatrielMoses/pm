import type { Comparison, Condition, ConditionValue } from './definition.ts';

/**
 * The one condition evaluator (ADR-0046 D4), used identically by preview and execution. Pure: the
 * service loads the trigger record through the automation's current authority and hands over a
 * typed snapshot. An input the automation cannot read now is not "false" and not a branch hint:
 * evaluation stops with `InputUnavailable`, which the run records as an opaque policy refusal.
 */

/** Facts about one readable record (only what conditions compare; never stored). */
export interface RecordFacts {
  status: string | null;
  status_category: string | null;
  priority: string | null;
  due_date: string | null;
  start_date: string | null;
  target_date: string | null;
  /** Membership public ids of the assignees. */
  assignee: string[];
  /** Label public ids. */
  label: string[];
  /** Project public id or null. */
  project: string | null;
  title: string | null;
  /** Custom fields the automation may read now (public id → value); absent = unreadable. */
  custom: ReadonlyMap<string, unknown>;
}

export class InputUnavailable extends Error {
  constructor() {
    super('automation input unavailable');
    this.name = 'InputUnavailable';
  }
}

export interface Decision {
  /** JSON pointer of the comparison or group inside the definition. */
  pointer: string;
  result: boolean;
}

/** `YYYY-MM-DD` plus whole days (pure calendar arithmetic, UTC-free). */
export function addDaysLocal(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return t.toISOString().slice(0, 10);
}

const isRelative = (v: ConditionValue | undefined): v is { relative_days: number } =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && 'relative_days' in v;

function compare(c: Comparison, facts: RecordFacts, today: string): boolean {
  let actual: unknown;
  if (c.field.startsWith('custom:')) {
    const id = c.field.slice(7);
    if (!facts.custom.has(id)) throw new InputUnavailable();
    actual = facts.custom.get(id);
  } else {
    actual = (facts as unknown as Record<string, unknown>)[c.field];
  }
  const v = c.value;
  switch (c.op) {
    case 'is_set':
      return Array.isArray(actual) ? actual.length > 0 : actual !== null && actual !== undefined && actual !== '';
    case 'is_not_set':
      return Array.isArray(actual) ? actual.length === 0 : actual === null || actual === undefined || actual === '';
    case 'eq':
      return actual !== null && actual !== undefined && String(actual) === String(v);
    case 'neq':
      return actual === null || actual === undefined || String(actual) !== String(v);
    case 'in':
      return Array.isArray(v) && actual !== null && v.includes(String(actual));
    case 'not_in':
      return !(Array.isArray(v) && actual !== null && v.includes(String(actual)));
    case 'includes':
      return Array.isArray(actual) && actual.includes(v);
    case 'excludes':
      return !(Array.isArray(actual) && actual.includes(v));
    case 'contains':
    case 'not_contains': {
      const hay = typeof actual === 'string' ? actual.toLocaleLowerCase('en') : null;
      const has = hay !== null && typeof v === 'string' && hay.includes(v.toLocaleLowerCase('en'));
      return c.op === 'contains' ? has : !has;
    }
    case 'gt':
    case 'lt': {
      const a = typeof actual === 'number' ? actual : Number(actual);
      const b = typeof v === 'number' ? v : Number(v);
      if (actual === null || actual === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return false;
      return c.op === 'gt' ? a > b : a < b;
    }
    case 'before':
    case 'after':
    case 'on': {
      if (typeof actual !== 'string' || !isRelative(v)) return false;
      const ref = addDaysLocal(today, v.relative_days);
      const day = actual.slice(0, 10);
      return c.op === 'before' ? day < ref : c.op === 'after' ? day > ref : day === ref;
    }
  }
  return false;
}

/**
 * Evaluates a condition tree. Every comparison and group visited is recorded (bounded by the
 * definition's own limits); groups short-circuit like the words "all" and "any" read.
 */
export function evaluate(
  condition: Condition,
  facts: RecordFacts,
  today: string,
  pointer = '',
  out: Decision[] = [],
): { result: boolean; decisions: Decision[] } {
  let result: boolean;
  if ('all' in condition) {
    result = true;
    for (let i = 0; i < condition.all.length; i++)
      if (!evaluate(condition.all[i]!, facts, today, `${pointer}/all/${i}`, out).result) {
        result = false;
        break;
      }
  } else if ('any' in condition) {
    result = false;
    for (let i = 0; i < condition.any.length; i++)
      if (evaluate(condition.any[i]!, facts, today, `${pointer}/any/${i}`, out).result) {
        result = true;
        break;
      }
  } else {
    result = compare(condition, facts, today);
  }
  out.push({ pointer: pointer || '/', result });
  return { result, decisions: out };
}

/** Every custom field a condition tree reads (loaded before evaluation, policy-checked). */
export function customFieldsOf(condition: Condition | null, out = new Set<string>()): Set<string> {
  if (!condition) return out;
  if ('all' in condition) for (const c of condition.all) customFieldsOf(c, out);
  else if ('any' in condition) for (const c of condition.any) customFieldsOf(c, out);
  else if (condition.field.startsWith('custom:')) out.add(condition.field.slice(7));
  return out;
}
