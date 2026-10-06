import type { RichTextDoc } from '@pm/contracts/rich-text';
import { api, protectedRequest, type StepUpResolver } from '../api.ts';
import type { Series, StatusView } from '../projects/client.ts';
import type { BrandMarkerData } from '../shell/client.ts';

/** Typed client for the 2B tasks API. Every identifier is a public ID. */

export type Deadline = { date: string } | { at: string; tz: string } | null;

export interface TaskSummary {
  id: string;
  type: 'task';
  title: string;
  status: StatusView;
  priority: string;
  start_date: string | null;
  due_date: string | null;
  deadline: Deadline;
  estimate_minutes: number | null;
  remaining_estimate_minutes: number | null;
  depth: number;
  children: number;
  version: number;
  assignees: Array<{ id: string; name: string; primary: boolean }>;
  lifecycle_state: 'active' | 'archived';
  brand: BrandMarkerData;
}

export interface TaskCapabilities {
  edit: boolean;
  edit_context: boolean;
  comment: boolean;
  complete: boolean;
  override_completion: boolean;
  move: boolean;
  move_brand: boolean;
  relate: boolean;
  share: boolean;
  archive: boolean;
  restore: boolean;
  trash: boolean;
  create_subtask: boolean;
  history: boolean;
  manage_recurrence: boolean;
  save_template: boolean;
}

export interface Task {
  id: string;
  type: 'task';
  title: string;
  description: RichTextDoc | null;
  brand: BrandMarkerData;
  project: { id: string; name: string } | null;
  parent: { id: string; title: string } | null;
  ancestors: Array<{ id: string; title: string }>;
  depth: number;
  status: StatusView;
  priority: string;
  start_date: string | null;
  due_date: string | null;
  deadline: Deadline;
  estimate_minutes: number | null;
  remaining_estimate_minutes: number | null;
  completed_at: string | null;
  completion_override: { reason: string } | null;
  expected_deliverable: {
    type: string;
    detail: string | null;
    requires_acceptance: boolean;
  } | null;
  requires_acceptance: boolean;
  assignees: Array<{ id: string; name: string; primary: boolean }>;
  labels: Array<{ id?: string; name: string; color: string; archived?: boolean }>;
  progress: { done: number; total: number } | null;
  scheduled: { available: false };
  lifecycle_state: 'active' | 'archived' | 'trashed';
  shared_only: boolean;
  capabilities: TaskCapabilities;
  /** Origin (2D): a closed kind plus safe identifiers (template, series, occurrence). */
  source: { kind: TaskOriginKind } & Record<string, string | number>;
  last_meaningful_update_at: string | null;
  version: number;
  /** The actor's undo handle after an edit (2D); null on replays and for other commands. */
  undo?: UndoHandle | null;
}

export interface RelatedTask {
  id: string;
  title: string;
  status: StatusView;
  lifecycle_state: string;
  brand: BrandMarkerData;
}

export interface TaskDetail {
  checklist: Array<{ id: string; text: string; done: boolean; version: number }>;
  criteria: Array<{
    id: string;
    kind: 'acceptance' | 'definition_of_done';
    text: string;
    met: boolean;
    required: boolean;
    version: number;
  }>;
  inherited_criteria: Array<{ id: string; text: string; state: 'open' | 'met' | 'dismissed' }>;
  subtasks: Array<{ id: string; title: string; status: StatusView; lifecycle_state: string }>;
  links: Array<
    | { id: string; kind: 'url'; url: string; title: string | null; version: number }
    | {
        id: string;
        kind: 'record';
        record: { id: string; type: string };
        title: string | null;
        version: number;
      }
  >;
  relationships: { blocks: RelatedTask[]; blocked_by: RelatedTask[]; related: RelatedTask[] };
  unavailable: string[];
}

export interface HistoryEntry {
  key: string;
  at: string;
  action: string;
  actor: { type: string; name: string | null };
  changes: Array<{ field: string; changed?: true; before?: unknown; after?: unknown }>;
}

export interface Label {
  id: string;
  name: string;
  color: string;
  archived: boolean;
  version: number;
}

export type TaskOriginKind =
  'manual' | 'recurring' | 'intake' | 'import' | 'integration' | 'ai_draft';

export interface UndoHandle {
  id: string;
  expires_at: string;
}

/** 2D: signals are independent and computed only from what the viewer may read. */
export interface TaskSignals {
  stale: boolean;
  blocked: boolean | null;
  repeatedly_rescheduled: boolean;
  missing_owner: boolean | null;
  missing_date: boolean;
  missing_criteria: boolean | null;
  missing_dependency: boolean | null;
}

export interface Reminder {
  id: string;
  type: 'task_reminder';
  remind_at: string;
  state: 'scheduled' | 'fired' | 'dismissed' | 'cancelled';
  fired_at: string | null;
  version: number;
  task: { id: string; title?: string };
}

export interface TaskInteraction {
  type: 'task_signals';
  task: { id: string; version: number };
  signals: TaskSignals;
  freshness: {
    last_meaningful_update_at: string | null;
    stale_after_days: number | null;
    reschedule_rule: { count: number; window_days: number };
  };
  source: { kind: TaskOriginKind } & Record<string, string | number>;
  recurrence: Array<{ id: string; state: string }>;
  reminders: Reminder[];
  snooze: { until: string; version: number } | null;
}

export type BulkOperation =
  | 'set_status'
  | 'set_priority'
  | 'set_due_date'
  | 'add_label'
  | 'remove_label'
  | 'archive'
  | 'trash';
export type BulkOutcome =
  | 'ready'
  | 'no_change'
  | 'applied'
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'invalid'
  | 'skipped';

export interface BulkOp {
  id: string;
  type: 'bulk_operation';
  operation: BulkOperation;
  mode: 'atomic' | 'partial';
  destructive: boolean;
  state: 'previewed' | 'executed' | 'expired';
  expires_at: string;
  executed_at: string | null;
  items: Array<{ task: string; outcome: BulkOutcome; code?: string }>;
  counts: Partial<Record<BulkOutcome, number>>;
  version: number;
  undo?: UndoHandle | null;
}

export interface TaskTemplate {
  id: string;
  type: 'template';
  target: 'task';
  name: string;
  version: number;
  item_count: number;
  brand: string | null;
  not_copied?: string[];
}

const base = (ws: string) => `/v1/workspaces/${ws}/tasks`;
const wsBase = (ws: string) => `/v1/workspaces/${ws}`;
type Ref = { id: string; type: string };

export const tasks = {
  async list(ws: string, query: Record<string, string | undefined> = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) q.set(k, v);
    const r = await api<{
      data: TaskSummary[];
      page: { has_more: boolean; next_cursor?: string; total?: { value: number } };
    }>('GET', `${base(ws)}${q.toString() ? `?${q}` : ''}`);
    return { data: r.body.data, page: r.body.page };
  },
  async get(ws: string, tsk: string) {
    return (await api<{ data: Task & { detail: TaskDetail } }>('GET', `${base(ws)}/${tsk}`)).body
      .data;
  },
  async history(ws: string, tsk: string, cursor?: string) {
    const r = await api<{
      data: HistoryEntry[];
      page: { has_more: boolean; next_cursor?: string };
    }>('GET', `${base(ws)}/${tsk}/history${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    return r.body;
  },
  async create(ws: string, body: Record<string, unknown>, stepUp: StepUpResolver) {
    return (await protectedRequest<{ data: Task }>('POST', base(ws), body, stepUp)).body.data;
  },
  async update(
    ws: string,
    tsk: string,
    version: number,
    changes: Record<
      string,
      { base: unknown; value: unknown } | { base_hash: string; value: unknown }
    >,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: Task }>(
        'PATCH',
        `${base(ws)}/${tsk}`,
        { version, changes },
        stepUp,
        { ifMatch: version },
      )
    ).body.data;
  },
  async verb<T = Task>(
    ws: string,
    tsk: string,
    verb: string,
    body: unknown,
    stepUp: StepUpResolver,
    ifMatch?: number,
  ) {
    return (
      await protectedRequest<{ data: T }>(
        'POST',
        `${base(ws)}/${tsk}:${verb}`,
        body ?? {},
        stepUp,
        { ifMatch },
      )
    ).body.data;
  },
  async preview(ws: string, tsk: string, body: unknown) {
    return (
      await api<{
        data: {
          members_gaining: number;
          members_losing: number;
          assignees_losing_access: number;
          tasks: number;
          omitted: { labels: number; inherited_criteria: number };
          preview_token: string;
        };
      }>('POST', `${base(ws)}/${tsk}:preview_move_brand`, { body })
    ).body.data;
  },
  async child(ws: string, tsk: string, segment: string, body: unknown, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: Ref }>('POST', `${base(ws)}/${tsk}/${segment}`, body, stepUp)
    ).body.data;
  },
  async patchChild(
    ws: string,
    tsk: string,
    segment: string,
    id: string,
    body: unknown,
    stepUp: StepUpResolver,
    version?: number,
  ) {
    return (
      await protectedRequest<{ data: Ref }>(
        'PATCH',
        `${base(ws)}/${tsk}/${segment}/${id}`,
        body,
        stepUp,
        { ifMatch: version },
      )
    ).body.data;
  },
  async childVerb(
    ws: string,
    tsk: string,
    segment: string,
    id: string,
    verb: string,
    body: unknown,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: Ref }>(
        'POST',
        `${base(ws)}/${tsk}/${segment}/${id}:${verb}`,
        body ?? {},
        stepUp,
      )
    ).body.data;
  },
  async deleteChild(ws: string, tsk: string, segment: string, id: string, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: Ref }>(
        'DELETE',
        `${base(ws)}/${tsk}/${segment}/${id}`,
        {},
        stepUp,
      )
    ).body.data;
  },
  async labels(ws: string, brand: string) {
    return (await api<{ data: Label[] }>('GET', `/v1/workspaces/${ws}/brands/${brand}/labels`)).body
      .data;
  },
  async createLabel(ws: string, brand: string, body: unknown, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: Label }>(
        'POST',
        `/v1/workspaces/${ws}/brands/${brand}/labels`,
        body,
        stepUp,
      )
    ).body.data;
  },
  // ---- 2D: signals, duplicates, personal state, ordering, bulk, undo, templates ----------------
  async signals(ws: string, tsk: string, signal?: AbortSignal) {
    return (
      await api<{ data: TaskInteraction }>('GET', `${base(ws)}/${tsk}/signals`, {
        ...(signal ? { signal } : {}),
      })
    ).body.data;
  },
  async signalsFor(ws: string, ids: string[], signal?: AbortSignal) {
    if (!ids.length) return [];
    return (
      await api<{
        data: {
          items: Array<{ task: string; signals: TaskSignals }>;
        };
      }>('GET', `${wsBase(ws)}/task-signals?tasks=${ids.map(encodeURIComponent).join(',')}`, {
        ...(signal ? { signal } : {}),
      })
    ).body.data.items;
  },
  async duplicates(
    ws: string,
    query: { brand: string; title: string; project?: string; exclude?: string },
    signal?: AbortSignal,
  ) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) q.set(k, v);
    return (
      await api<{
        data: {
          candidates: Array<{ id: string; title: string; status: StatusView; created_at: string }>;
        };
      }>('GET', `${wsBase(ws)}/task-duplicates?${q}`, { ...(signal ? { signal } : {}) })
    ).body.data.candidates;
  },
  async reminders(ws: string) {
    return (await api<{ data: Reminder[] }>('GET', `${wsBase(ws)}/reminders`)).body.data;
  },
  async remind(ws: string, tsk: string, remindAt: string, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: Reminder }>(
        'POST',
        `${base(ws)}/${tsk}/reminders`,
        { remind_at: remindAt },
        stepUp,
      )
    ).body.data;
  },
  async updateReminder(ws: string, rem: string, body: unknown, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: Reminder }>(
        'PATCH',
        `${wsBase(ws)}/reminders/${rem}`,
        body,
        stepUp,
      )
    ).body.data;
  },
  async reorder(
    ws: string,
    tsk: string,
    body: { position: 'up' | 'down' | 'top' | 'bottom' | 'to'; index?: number },
    version: number,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{
        data: {
          id: string;
          position: number;
          total: number;
          announcement: string;
          undo: UndoHandle | null;
        };
      }>('POST', `${base(ws)}/${tsk}:reorder`, body, stepUp, { ifMatch: version })
    ).body.data;
  },
  async previewBulk(
    ws: string,
    body: {
      operation: BulkOperation;
      params?: Record<string, unknown>;
      tasks: string[];
      mode?: 'atomic' | 'partial';
    },
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: BulkOp }>('POST', `${wsBase(ws)}/task-bulk`, body, stepUp)
    ).body.data;
  },
  async executeBulk(ws: string, bop: string, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: BulkOp }>(
        'POST',
        `${wsBase(ws)}/task-bulk/${bop}:execute`,
        {},
        stepUp,
      )
    ).body.data;
  },
  async undo(ws: string, und: string, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: { id: string; state: string; tasks: string[] } }>(
        'POST',
        `${wsBase(ws)}/undo/${und}:apply`,
        {},
        stepUp,
      )
    ).body.data;
  },
  async templates(ws: string) {
    return (await api<{ data: TaskTemplate[] }>('GET', `${wsBase(ws)}/task-templates`)).body.data;
  },
  async applyTemplate(
    ws: string,
    tpl: string,
    body: Record<string, unknown>,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{
        data: { task: Task; copied: Record<string, number> | null; omitted: string[] | null };
      }>('POST', `${wsBase(ws)}/task-templates/${tpl}:apply`, body, stepUp)
    ).body.data;
  },
  async recurrences(ws: string, tsk: string) {
    return (await api<{ data: Series[] }>('GET', `${base(ws)}/${tsk}/recurrences`)).body.data;
  },
};
