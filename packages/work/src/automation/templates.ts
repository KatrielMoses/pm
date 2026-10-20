/**
 * Starter templates (AUTO-002, ONB-013 contribution): a few real, small automations a person can
 * start from. Each produces an ordinary draft that is validated, previewed, and activated like any
 * other; a template grants nothing. The 10B catalog will distribute templates later.
 */

export interface StarterTemplate {
  key: string;
  name: string;
  description: string;
  trigger: string;
  /** Values the person chooses when starting from it. */
  needs: Array<'project' | 'member' | 'label' | 'timezone'>;
  build(values: Record<string, string>): Record<string, unknown>;
}

export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  {
    key: 'escalate_overdue',
    name: 'Escalate tasks on their due date',
    description:
      'At 9:00 on the due date, raise an unfinished task to high priority and tell its assignees.',
    trigger: 'date',
    needs: ['timezone'],
    build: (v) => ({
      schema_version: 1,
      trigger: {
        kind: 'date',
        record: 'task',
        field: 'due_date',
        offset_days: 0,
        at: '09:00',
        timezone: v.timezone ?? 'UTC',
      },
      conditions: { all: [{ field: 'status_category', op: 'not_in', value: ['done', 'cancelled'] }] },
      steps: [
        {
          id: 'urgent_check',
          type: 'branch',
          when: { field: 'priority', op: 'in', value: ['urgent', 'high'] },
          then: 'tell',
          else: 'raise',
        },
        { id: 'raise', type: 'action', action: 'task.update', params: { fields: { priority: 'high' } }, next: 'tell' },
        {
          id: 'tell',
          type: 'action',
          action: 'task.notify',
          params: { recipients: ['assignees'], message: 'This task is due today.' },
          next: null,
        },
      ],
    }),
  },
  {
    key: 'label_new_tasks',
    name: 'Label new tasks in a project',
    description: 'When a task is created, add a label so it shows up in triage.',
    trigger: 'record.created',
    needs: ['label'],
    build: (v) => ({
      schema_version: 1,
      trigger: { kind: 'record.created', record: 'task' },
      conditions: null,
      steps: [
        {
          id: 'label',
          type: 'action',
          action: 'task.label',
          params: { mode: 'add', label: v.label ?? '' },
          next: null,
        },
      ],
    }),
  },
  {
    key: 'follow_up_done',
    name: 'Follow up when a task is done',
    description:
      'When a task moves to done, wait a day and then create a follow-up task in its project.',
    trigger: 'record.status_changed',
    needs: [],
    build: () => ({
      schema_version: 1,
      trigger: { kind: 'record.status_changed', record: 'task', to_category: 'done' },
      conditions: { all: [{ field: 'project', op: 'is_set' }] },
      steps: [
        { id: 'wait', type: 'delay', minutes: 1440 },
        {
          id: 'follow_up',
          type: 'action',
          action: 'task.create',
          params: { title: 'Follow up on completed work', project: 'trigger.project', due: { days: 7 } },
          fallback: { on: ['policy_rejected', 'validation_failed'], next: null },
          next: null,
        },
      ],
    }),
  },
  {
    key: 'assign_on_review_changes',
    name: 'Assign changes requested in review',
    description: 'When a review asks for changes, assign the task to a chosen person and tell them.',
    trigger: 'approval.decided',
    needs: ['member'],
    build: (v) => ({
      schema_version: 1,
      trigger: { kind: 'approval.decided', record: 'task', decision: 'changes_requested' },
      conditions: null,
      steps: [
        {
          id: 'assign',
          type: 'action',
          action: 'task.assign',
          params: { mode: 'add', assignees: [v.member ?? ''] },
          next: 'tell',
        },
        {
          id: 'tell',
          type: 'action',
          action: 'task.notify',
          params: { recipients: ['assignees'], message: 'Changes were requested on this task.' },
          next: null,
        },
      ],
    }),
  },
  {
    key: 'weekly_planning_task',
    name: 'Weekly planning task',
    description: 'Every Monday at 9:00, create a planning task in a chosen project.',
    trigger: 'schedule',
    needs: ['project', 'timezone'],
    build: (v) => ({
      schema_version: 1,
      trigger: {
        kind: 'schedule',
        rule: 'FREQ=WEEKLY;BYDAY=MO',
        start: '2026-01-05T09:00',
        timezone: v.timezone ?? 'UTC',
      },
      conditions: null,
      steps: [
        {
          id: 'plan',
          type: 'action',
          action: 'task.create',
          params: { title: 'Plan this week', project: v.project ?? '', due: { days: 0 } },
          next: null,
        },
      ],
    }),
  },
];

/** A draft definition from a template and the person's chosen values (validated later). */
export function templateDraft(
  key: unknown,
  values: unknown,
  _scope: { brandId: string | null; brandPublicIds: string[] },
): { key: string; definition: Record<string, unknown> } | null {
  const t = STARTER_TEMPLATES.find((x) => x.key === key);
  if (!t) return null;
  const v: Record<string, string> = {};
  if (values && typeof values === 'object' && !Array.isArray(values))
    for (const [k, x] of Object.entries(values as Record<string, unknown>))
      if (typeof x === 'string' && x.length <= 64 && (t.needs as string[]).includes(k)) v[k] = x;
  return { key: t.key, definition: t.build(v) };
}
