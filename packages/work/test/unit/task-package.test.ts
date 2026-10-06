import { describe, expect, it } from 'vitest';
import { occurrences, parseRule, localToUtc } from '../../src/recurrence.ts';
import {
  normalizeTitle,
  readTaskPackage,
  taskPackageItems,
  TASK_NOT_COPIED,
  type TaskPackage,
} from '../../src/task-package.ts';
import { BULK_OPERATIONS } from '../../src/task-interaction.ts';

const pkg = (over: Partial<TaskPackage> = {}): TaskPackage => ({
  schema_version: 1,
  kind: 'task',
  task: {
    title: 'Weekly report',
    description_rich: null,
    priority: 'high',
    estimate_minutes: 30,
    expected_deliverable_type: null,
    expected_deliverable_detail: null,
    requires_acceptance: false,
  },
  checklist: ['Gather', 'Send'],
  criteria: [{ kind: 'acceptance', text: 'Reviewed', required: true }],
  labels: ['Ops'],
  links: [{ url: 'https://example.com', title: null }],
  fields: [{ definition: 'fld_0000000000000000000000000A', value: 3 }],
  ...over,
});

const code = (raw: unknown, max = 100) => {
  try {
    readTaskPackage(raw, max);
    return null;
  } catch (e) {
    return (e as { issues?: Array<{ code: string }> }).issues?.[0]?.code ?? 'thrown';
  }
};

describe('task package (ADR-0016 D2)', () => {
  it('accepts a well-formed package and counts its items', () => {
    expect(readTaskPackage(pkg(), 100)).toEqual(pkg());
    expect(taskPackageItems(pkg())).toBe(1 + 2 + 1 + 1 + 1 + 1);
  });

  it('refuses project packages, unknown versions, malformed parts, and oversized packages', () => {
    expect(code({ schema_version: 1, project: { name: 'x' } })).toBe('template_invalid');
    expect(code({ ...pkg(), schema_version: 2 })).toBe('template_invalid');
    expect(code({ ...pkg(), checklist: [''] })).toBe('template_invalid');
    expect(code({ ...pkg(), criteria: [{ kind: 'success', text: 'x', required: true }] })).toBe(
      'template_invalid',
    );
    expect(code({ ...pkg(), links: [{ url: 'x'.repeat(2001), title: null }] })).toBe(
      'template_invalid',
    );
    expect(code({ ...pkg(), task: { ...pkg().task, title: '' } })).toBe('template_invalid');
    expect(code(pkg(), 3)).toBe('template_invalid');
  });

  it('never carries people, shares, history, comments, relationships, or approvals', () => {
    expect(TASK_NOT_COPIED).toEqual(
      expect.arrayContaining([
        'assignees',
        'shares',
        'history',
        'comments',
        'relationships',
        'approvals',
      ]),
    );
    expect(Object.keys(pkg())).not.toContain('assignees');
  });

  it('normalizes titles deterministically for duplicate matching', () => {
    expect(normalizeTitle('  Renew   SSL\tCertificate ')).toBe('renew ssl certificate');
    expect(normalizeTitle('RENEW ssl certificate')).toBe(normalizeTitle('renew  SSL certificate'));
    expect(normalizeTitle('Renew SSL certificates')).not.toBe(
      normalizeTitle('Renew SSL certificate'),
    );
  });

  it('task occurrences keep their local time across DST in the anchor zone', () => {
    const rule = parseRule('FREQ=WEEKLY;BYDAY=MO');
    const keys = occurrences(rule, '2026-03-23T09:00', null, 3);
    expect(keys).toEqual(['2026-03-23T09:00', '2026-03-30T09:00', '2026-04-06T09:00']);
    expect(localToUtc(keys[0]!, 'Europe/Lisbon').toISOString()).toBe('2026-03-23T09:00:00.000Z');
    expect(localToUtc(keys[1]!, 'Europe/Lisbon').toISOString()).toBe('2026-03-30T08:00:00.000Z');
  });

  it('bulk operations are a closed set matching the database', () => {
    expect([...BULK_OPERATIONS]).toEqual([
      'set_status',
      'set_priority',
      'set_due_date',
      'add_label',
      'remove_label',
      'archive',
      'trash',
    ]);
  });
});
