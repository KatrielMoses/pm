import { describe, expect, it } from 'vitest';
import {
  ACTION_MATRIX,
  actionClass,
  compileDefinition,
  DefinitionError,
  TRIGGERS,
  triggerEvents,
  type DefinitionLimits,
} from '../../src/automation/definition.ts';
import {
  addDaysLocal,
  evaluate,
  InputUnavailable,
  type RecordFacts,
} from '../../src/automation/evaluate.ts';
import { STARTER_TEMPLATES, templateDraft } from '../../src/automation/templates.ts';

const LIMITS: DefinitionLimits = {
  definitionBytesMax: 32_768,
  nodesMax: 25,
  conditionDepthMax: 4,
  conditionsMax: 20,
  targetFanoutMax: 25,
  delayHorizonMinutes: 43_200,
};
const PRJ = 'prj_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const MEM = 'mem_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const LBL = 'lbl_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const WHK = 'whk_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const base = (over: Record<string, unknown> = {}) => ({
  schema_version: 1,
  trigger: { kind: 'record.created', record: 'task' },
  conditions: null,
  steps: [
    { id: 'a', type: 'action', action: 'task.update', params: { fields: { priority: 'high' } } },
  ],
  ...over,
});
const codes = (raw: unknown, limits = LIMITS) => {
  try {
    compileDefinition(raw, limits);
    return [];
  } catch (err) {
    if (err instanceof DefinitionError) return err.issues.map((i) => `${i.pointer}:${i.code}`);
    throw err;
  }
};
const facts = (over: Partial<RecordFacts> = {}): RecordFacts => ({
  status: 'todo',
  status_category: 'planned',
  priority: 'high',
  due_date: '2026-10-22',
  start_date: null,
  target_date: null,
  assignee: [MEM],
  label: [],
  project: PRJ,
  title: 'Fix the Gate',
  custom: new Map([['fld_A', 7]]),
  ...over,
});

describe('automation definitions (8A compiler)', () => {
  it('AT-565 compiles a typed graph to a canonical form with ordered default edges', () => {
    const c = compileDefinition(
      base({
        conditions: {
          any: [
            { field: 'priority', op: 'eq', value: 'high' },
            { all: [{ field: 'label', op: 'includes', value: LBL }] },
          ],
        },
        steps: [
          {
            id: 'b',
            type: 'branch',
            when: { field: 'status_category', op: 'eq', value: 'planned' },
            then: 'a',
            else: null,
          },
          { id: 'a', type: 'action', action: 'task.label', params: { label: LBL, mode: 'add' } },
          { id: 'w', type: 'delay', minutes: 30 },
          {
            id: 'n',
            type: 'action',
            action: 'task.notify',
            params: { recipients: ['assignees', MEM], message: 'Hello' },
          },
        ],
      }),
      LIMITS,
    );
    // Defaults follow the written order; explicit edges win.
    expect(c.definition.steps.map((s) => [s.id, 'next' in s ? s.next : null])).toEqual([
      ['b', null],
      ['a', 'w'],
      ['w', 'n'],
      ['n', null],
    ]);
    expect(c.actions).toEqual(['task.label', 'task.notify']);
    expect(c.refs.labels).toEqual(new Set([LBL]));
    expect(c.refs.members).toEqual(new Set([MEM]));
    expect(c.depth).toBe(4);
    // Key order never changes the canonical text (stable hashes and revisions).
    expect(compileDefinition(JSON.parse(JSON.stringify(c.definition)), LIMITS).canonical).toBe(
      c.canonical,
    );
  });

  it('AT-566 refuses unsupported configuration instead of ignoring it', () => {
    expect(codes({ ...base(), extra: 1 })).toContain('/extra:unknown_field');
    expect(codes(base({ schema_version: 2 }))).toContain('/schema_version:unsupported_version');
    expect(codes(base({ trigger: { kind: 'record.created', record: 'goal' } }))).toContain(
      '/trigger/record:invalid_option',
    );
    expect(codes(base({ trigger: { kind: 'sql', record: 'task' } }))).toContain(
      '/trigger/kind:invalid_option',
    );
    expect(
      codes(
        base({
          steps: [
            {
              id: 'a',
              type: 'action',
              action: 'task.update',
              params: { fields: { description: 'x' } },
            },
          ],
        }),
      ),
    ).toContain('/steps/0/params/fields/description:invalid_option');
    expect(
      codes(
        base({
          steps: [
            {
              id: 'a',
              type: 'action',
              action: 'task.update',
              params: { fields: { priority: 'high' }, script: 'x' },
            },
          ],
        }),
      ),
    ).toContain('/steps/0/params/script:unknown_field');
    expect(codes(base({ steps: [{ id: 'a', type: 'script', code: 'x' }] }))).toContain(
      '/steps/0/type:invalid_option',
    );
    expect(codes(base({ conditions: { field: 'title', op: 'matches', value: '.*' } }))).toContain(
      '/conditions/op:invalid_option',
    );
    // Project actions that grant access or move access are refused with a reason.
    for (const action of [
      'project.create',
      'project.assign',
      'project.move',
      'project.label',
      'project.relate',
    ])
      expect(
        codes(
          base({
            trigger: { kind: 'record.created', record: 'project' },
            steps: [{ id: 'a', type: 'action', action, params: {} }],
          }),
        ),
      ).toContain('/steps/0/action:action_unsupported');
    // A task action cannot target a project trigger record.
    expect(codes(base({ trigger: { kind: 'record.created', record: 'project' } }))).toContain(
      '/steps/0/target:target_not_applicable',
    );
  });

  it('AT-582 graph checks: references, cycles, reachability, depth, node and size caps', () => {
    expect(
      codes(base({ steps: [{ id: 'a', type: 'action', action: 'task.archive', next: 'zz' }] })),
    ).toContain('/steps/0/next:invalid_reference');
    expect(
      codes(
        base({
          steps: [
            { id: 'a', type: 'action', action: 'task.archive', next: 'b' },
            {
              id: 'b',
              type: 'branch',
              when: { field: 'priority', op: 'eq', value: 'high' },
              then: 'a',
              else: null,
            },
          ],
        }),
      ),
    ).toContain('/steps:cycle');
    expect(
      codes(
        base({
          steps: [
            { id: 'a', type: 'action', action: 'task.archive', next: null },
            { id: 'b', type: 'action', action: 'task.archive' },
          ],
        }),
      ),
    ).toContain('/steps/1:unreachable');
    expect(
      codes(
        base({
          steps: [
            { id: 'a', type: 'action', action: 'task.archive' },
            { id: 'a', type: 'delay', minutes: 1 },
          ],
        }),
      ),
    ).toContain('/steps/1/id:duplicate');
    const many = Array.from({ length: 4 }, (_, i) => ({
      id: `n${i}`,
      type: 'action',
      action: 'task.archive',
    }));
    expect(codes(base({ steps: many }), { ...LIMITS, nodesMax: 3 })).toContain('/steps:too_many');
    const deep = {
      all: [
        { any: [{ all: [{ any: [{ all: [{ field: 'priority', op: 'eq', value: 'high' }] }] }] }] },
      ],
    };
    expect(codes(base({ conditions: deep }))).toContain(
      '/conditions/all/0/any/0/all/0/any/0:too_deep',
    );
    expect(codes(base({ steps: [{ id: 'w', type: 'delay', minutes: 50_000 }] }))).toContain(
      '/steps/0/minutes:out_of_range',
    );
    expect(
      codes(
        base({
          conditions: {
            all: Array.from({ length: 21 }, () => ({ field: 'priority', op: 'eq', value: 'high' })),
          },
        }),
      ),
    ).toContain('/conditions/all:invalid_length');
    expect(
      codes(
        base({
          steps: [
            {
              id: 'a',
              type: 'action',
              action: 'task.notify',
              params: { recipients: ['owner'], message: 'x'.repeat(40_000) },
            },
          ],
        }),
      ),
    ).toEqual(['/:too_large']);
  });

  it('AT-583 fallbacks name typed failures only; unknown external outcomes are never one', () => {
    const fb = (on: unknown) =>
      base({
        steps: [{ id: 'a', type: 'action', action: 'task.archive', fallback: { on, next: null } }],
      });
    expect(codes(fb(['validation_failed', 'conflict']))).toEqual([]);
    expect(codes(fb(['unknown_outcome']))).toContain('/steps/0/fallback/on:invalid_option');
    expect(codes(fb([]))).toContain('/steps/0/fallback/on:invalid_option');
  });

  it('AT-584 future triggers compile as typed, unavailable boundaries (agent workflows became real in 8C)', () => {
    const t = compileDefinition(base({ trigger: { kind: 'test.result', record: 'task' } }), LIMITS);
    expect(t.unavailable).toEqual([
      { pointer: '/trigger/kind', code: 'trigger_unavailable', owner: '9B' },
    ]);
    const a = compileDefinition(
      base({
        steps: [{ id: 'a', type: 'action', action: 'agent.invoke', params: { agent: 'reviewer' } }],
      }),
      LIMITS,
    );
    expect(a.unavailable).toEqual([]);
    expect(TRIGGERS['agent.result'].status).toBe('available');
    expect(ACTION_MATRIX['agent.invoke'].status).toBe('supported');
  });

  it('AT-585 outbound steps declare an exact destination and structural field set', () => {
    const c = compileDefinition(
      base({
        steps: [
          {
            id: 'hook',
            type: 'action',
            action: 'webhook.send',
            params: { subscription: WHK, fields: ['status', 'priority'] },
          },
        ],
      }),
      LIMITS,
    );
    expect(c.outbound).toEqual([{ node: 'hook', webhook: WHK, fields: ['priority', 'status'] }]);
    expect(c.classes).toEqual(['outbound']);
    expect(actionClass('webhook.send')).toBe('outbound');
    // Content fields (titles, names, descriptions) are never disclosable by an automation.
    expect(
      codes(
        base({
          steps: [
            {
              id: 'hook',
              type: 'action',
              action: 'webhook.send',
              params: { subscription: WHK, fields: ['title'] },
            },
          ],
        }),
      ),
    ).toContain('/steps/0/params/fields:invalid_option');
  });

  it('AT-564 schedules use the one recurrence parser and explicit zones', () => {
    const s = (over: Record<string, unknown>) =>
      base({
        trigger: {
          kind: 'schedule',
          rule: 'FREQ=WEEKLY;BYDAY=MO',
          start: '2026-03-02T09:00',
          timezone: 'Europe/London',
          ...over,
        },
        steps: [
          {
            id: 'a',
            type: 'action',
            action: 'task.create',
            params: { title: 'Plan', project: PRJ },
          },
        ],
      });
    expect(codes(s({}))).toEqual([]);
    expect(codes(s({ rule: 'FREQ=HOURLY' }))).toContain('/trigger/rule:invalid_format');
    expect(codes(s({ timezone: 'Mars/Base' }))).toContain('/trigger/timezone:invalid_timezone');
    // A scheduled automation has no trigger record to compare or target.
    expect(codes(s({ x: 1 }))).toContain('/trigger/x:unknown_field');
    expect(
      codes({ ...s({}), conditions: { field: 'priority', op: 'eq', value: 'high' } }),
    ).toContain('/conditions/field:field_not_applicable');
    expect(
      triggerEvents({ kind: 'record.status_changed', record: 'project', to_category: null }),
    ).toEqual(['work.project.status_changed']);
  });

  it('AT-586 every starter template compiles (values supplied)', () => {
    for (const t of STARTER_TEMPLATES) {
      const d = templateDraft(
        t.key,
        { project: PRJ, member: MEM, label: LBL, timezone: 'Asia/Kolkata' },
        { brandId: null, brandPublicIds: [] },
      )!;
      expect(codes(d.definition), t.key).toEqual([]);
    }
    expect(templateDraft('nope', {}, { brandId: null, brandPublicIds: [] })).toBeNull();
  });
});

describe('automation condition evaluator (8A)', () => {
  it('AT-587 AND/OR with short-circuit decisions, relative dates in the run day', () => {
    const cond = {
      any: [
        { field: 'priority', op: 'eq' as const, value: 'low' },
        {
          all: [
            { field: 'due_date', op: 'on' as const, value: { relative_days: 2 } },
            { field: 'assignee', op: 'includes' as const, value: MEM },
          ],
        },
      ],
    };
    const r = evaluate(cond, facts(), '2026-10-20');
    expect(r.result).toBe(true);
    expect(r.decisions.map((d) => [d.pointer, d.result])).toEqual([
      ['/any/0', false],
      ['/any/1/all/0', true],
      ['/any/1/all/1', true],
      ['/any/1', true],
      ['/', true],
    ]);
    expect(
      evaluate({ field: 'title', op: 'contains', value: 'gate' }, facts(), '2026-10-20').result,
    ).toBe(true);
    expect(
      evaluate({ field: 'project', op: 'is_not_set' }, facts({ project: null }), '2026-10-20')
        .result,
    ).toBe(true);
    expect(addDaysLocal('2026-02-27', 2)).toBe('2026-03-01');
  });

  it('AT-588 an unreadable custom field is never false and never a branch hint', () => {
    expect(
      evaluate({ field: 'custom:fld_A', op: 'gt', value: 3 }, facts(), '2026-10-20').result,
    ).toBe(true);
    expect(() =>
      evaluate({ field: 'custom:fld_HIDDEN', op: 'is_not_set' }, facts(), '2026-10-20'),
    ).toThrow(InputUnavailable);
    // Even inside an OR whose other side is true, the hidden input stops evaluation.
    expect(() =>
      evaluate(
        {
          any: [
            { field: 'custom:fld_HIDDEN', op: 'eq', value: 'x' },
            { field: 'priority', op: 'eq', value: 'high' },
          ],
        },
        facts(),
        '2026-10-20',
      ),
    ).toThrow(InputUnavailable);
  });
});
