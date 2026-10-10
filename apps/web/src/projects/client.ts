import type { RichTextDoc } from '@pm/contracts/rich-text';
import { api, protectedRequest, type StepUpResolver } from '../api.ts';
import type { BrandMarkerData } from '../shell/client.ts';

/** Typed client for the 2A projects API. Every identifier is a public ID. */

export interface StatusView {
  key: string;
  name: string;
  category: 'planned' | 'active' | 'paused' | 'done' | 'cancelled';
}

export interface ProjectSummary {
  id: string;
  type: 'project';
  name: string;
  status: StatusView;
  priority: string;
  health: string | null;
  target_date: string | null;
  depth: number;
  parent: string | null;
  children: number;
  lifecycle_state: 'active' | 'archived';
  brand: BrandMarkerData;
}

export interface ProjectCapabilities {
  edit: boolean;
  edit_structure: boolean;
  comment: boolean;
  complete: boolean;
  create_child: boolean;
  manage_access: boolean;
  restrict: boolean;
  share: boolean;
  move: boolean;
  relate: boolean;
  archive: boolean;
  restore: boolean;
  trash: boolean;
  verify_update: boolean;
  manage_recurrence: boolean;
  save_template: boolean;
  /** 3D: may log own time here. */
  log_time: boolean;
}

export interface Project {
  id: string;
  type: 'project';
  name: string;
  /** Rich text version 1 (0D PL-23); the 2A editor reads and writes its plain-text subset. */
  description: RichTextDoc | null;
  icon: string | null;
  color: string | null;
  brand: BrandMarkerData;
  parent: { id: string; name: string } | null;
  ancestors: Array<{ id: string; name: string }>;
  depth: number;
  status: StatusView;
  priority: string;
  start_date: string | null;
  target_date: string | null;
  deadline_date: string | null;
  completed_at: string | null;
  health: { value: string; source: string | null } | null;
  budget: { amount: string; currency: string | null } | null;
  time_budget_minutes: number | null;
  ai_budget_micros: string | null;
  completion: { percent: number; basis: 'status' | 'leaf_tasks' };
  owner: { id: string; name: string } | null;
  access_mode: 'inherit' | 'restricted';
  allow_record_shares: boolean;
  recurrence: { series: string; occurrence: string } | null;
  lifecycle_state: 'active' | 'archived' | 'trashed';
  your_level: string;
  capabilities: ProjectCapabilities;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface Overview {
  project: Project;
  criteria: Array<{
    id: string;
    kind: string;
    text: string;
    met: boolean;
    met_at: string | null;
    version: number;
  }>;
  scope_items: Array<{ id: string; kind: string; text: string; version: number }>;
  phases: Array<{
    id: string;
    name: string;
    start_date: string | null;
    end_date: string | null;
    status: string;
    lifecycle_state: string;
    version: number;
  }>;
  milestones: Array<{
    id: string;
    name: string;
    due_date: string | null;
    status: string;
    phase: string | null;
    lifecycle_state: string;
    version: number;
  }>;
  decisions: Array<{
    id: string;
    kind: 'decision' | 'open_question';
    state: string;
    statement: string;
    outcome: string | null;
    due_date: string | null;
    version: number;
  }>;
  updates: Array<{
    id: string;
    body: string;
    health: string | null;
    source_kind: string;
    created_at: string;
    verified: boolean;
  }>;
  /** Share-only readers get `{id, body}` only (ADR-0013 P5). */
  latest_verified_update: {
    id: string;
    body: string;
    health?: string | null;
    created_at?: string;
    verified_at?: string;
  } | null;
  dependencies: {
    blocked_by: Array<{
      id: string;
      name: string;
      status: StatusView;
      brand: BrandMarkerData;
      lifecycle_state: string;
    }>;
    blocks: Array<{
      id: string;
      name: string;
      status: StatusView;
      brand: BrandMarkerData;
      lifecycle_state: string;
    }>;
  };
  children: Array<{ id: string; name: string; status: StatusView }>;
  task_facts:
    | { available: false }
    | { available: true; total: number; overdue: number; blocked: number; unassigned: number };
}

export interface Series {
  id: string;
  state: 'active' | 'paused';
  /** `catching_up`: due occurrences wait for the next bounded run; `ended`: no more occurrences. */
  status: 'active' | 'paused' | 'ended' | 'catching_up';
  rule: {
    frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
    interval: number;
    weekdays: string[] | null;
    month_days: number[] | null;
    ends: { type: 'never' } | { type: 'after'; count: number } | { type: 'on'; date: string };
  };
  rrule: string;
  anchor_tz: string;
  /** Anchor local date-time `YYYY-MM-DDTHH:mm`. */
  start: string;
  generated_through: string | null;
  /** The next occurrence's local date-time in the anchor zone (null when paused or ended). */
  next_occurrence: string | null;
  next_due_at: string | null;
  item_count: number;
  version: number;
}

export interface TemplateSummary {
  id: string;
  name: string;
  item_count: number;
  brand: string | null;
}

const base = (ws: string) => `/v1/workspaces/${ws}/projects`;
type Ref = { id: string; type: string };

export const projects = {
  async list(ws: string, query: { brands?: string[]; state?: 'active' | 'archived' } = {}) {
    const q = new URLSearchParams();
    if (query.brands?.length) q.set('brands', query.brands.join(','));
    if (query.state) q.set('state', query.state);
    const r = await api<{
      data: ProjectSummary[];
      page: { total?: { value: number; capped: boolean } };
    }>('GET', `${base(ws)}${q.toString() ? `?${q}` : ''}`);
    return { data: r.body.data, total: r.body.page.total ?? null };
  },
  async get(ws: string, prj: string) {
    return (await api<{ data: Project }>('GET', `${base(ws)}/${prj}`)).body.data;
  },
  async overview(ws: string, prj: string) {
    return (await api<{ data: Overview & { type: string } }>('GET', `${base(ws)}/${prj}/overview`))
      .body.data;
  },
  async create(ws: string, body: Record<string, unknown>, stepUp: StepUpResolver) {
    return (await protectedRequest<{ data: Project }>('POST', base(ws), body, stepUp)).body.data;
  },
  async update(
    ws: string,
    prj: string,
    version: number,
    changes: Record<
      string,
      { base: unknown; value: unknown } | { base_hash: string; value: unknown }
    >,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: Project }>(
        'PATCH',
        `${base(ws)}/${prj}`,
        { version, changes },
        stepUp,
        { ifMatch: version },
      )
    ).body.data;
  },
  async verb<T = Ref>(
    ws: string,
    prj: string,
    verb: string,
    body: unknown,
    stepUp: StepUpResolver,
    ifMatch?: number,
  ) {
    return (
      await protectedRequest<{ data: T }>(
        'POST',
        `${base(ws)}/${prj}:${verb}`,
        body ?? {},
        stepUp,
        { ifMatch },
      )
    ).body.data;
  },
  async child(ws: string, prj: string, segment: string, body: unknown, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: Ref }>('POST', `${base(ws)}/${prj}/${segment}`, body, stepUp)
    ).body.data;
  },
  async patchChild(
    ws: string,
    prj: string,
    segment: string,
    id: string,
    body: unknown,
    stepUp: StepUpResolver,
    version?: number,
  ) {
    return (
      await protectedRequest<{ data: Ref }>(
        'PATCH',
        `${base(ws)}/${prj}/${segment}/${id}`,
        body,
        stepUp,
        { ifMatch: version },
      )
    ).body.data;
  },
  async childVerb(
    ws: string,
    prj: string,
    segment: string,
    id: string,
    verb: string,
    body: unknown,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: Ref }>(
        'POST',
        `${base(ws)}/${prj}/${segment}/${id}:${verb}`,
        body ?? {},
        stepUp,
      )
    ).body.data;
  },
  async deleteChild(ws: string, prj: string, segment: string, id: string, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: Ref }>(
        'DELETE',
        `${base(ws)}/${prj}/${segment}/${id}`,
        {},
        stepUp,
      )
    ).body.data;
  },
  async recurrences(ws: string, prj: string) {
    return (await api<{ data: Series[] }>('GET', `${base(ws)}/${prj}/recurrences`)).body.data;
  },
  async templates(ws: string) {
    return (await api<{ data: TemplateSummary[] }>('GET', `/v1/workspaces/${ws}/templates`)).body
      .data;
  },
};
