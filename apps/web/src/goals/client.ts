import { api, ApiError, protectedRequest, type StepUpResolver } from '../api.ts';
import type { BrandMarkerData } from '../shell/client.ts';

/**
 * Typed client for the 5B goals and portfolio API (ADR-0028). Every identifier is a public ID.
 * Every figure that depends on linked work is computed by the server for the viewer; nothing here
 * recomputes, infers, or hints at work the viewer cannot read.
 */

export type GoalStatus = 'draft' | 'active' | 'achieved' | 'missed' | 'cancelled';
export type PeriodKind = 'quarter' | 'half' | 'year' | 'custom';
export type GoalBasis = 'manual' | 'key_results' | 'linked_work';
export type Confidence = 'on_track' | 'at_risk' | 'off_track';
export type UpdateState = 'never' | 'fresh' | 'stale';
export type PeriodState = 'upcoming' | 'current' | 'ended';
export type Lifecycle = 'active' | 'archived' | 'trashed' | 'purged';
export type ProjectHealth = 'on_track' | 'at_risk' | 'off_track' | 'complete' | 'unknown';
export type ProjectCategory = 'planned' | 'active' | 'paused' | 'done' | 'cancelled';

export const GOAL_STATUS_LABEL: Record<GoalStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  achieved: 'Achieved',
  missed: 'Missed',
  cancelled: 'Cancelled',
};
export const GOAL_STATUSES = Object.keys(GOAL_STATUS_LABEL) as GoalStatus[];
export const BASIS_LABEL: Record<GoalBasis, string> = {
  manual: 'Updated by hand',
  key_results: 'Average of key results',
  linked_work: 'Completion of linked work',
};
export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  off_track: 'Off track',
};
export const HEALTH_LABEL: Record<ProjectHealth, string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  off_track: 'Off track',
  complete: 'Complete',
  unknown: 'Not enough information',
};
export const CATEGORY_LABEL: Record<ProjectCategory, string> = {
  planned: 'Planned',
  active: 'Active',
  paused: 'Paused',
  done: 'Done',
  cancelled: 'Cancelled',
};

export interface PersonRef {
  id: string;
  name: string;
  type: 'member';
}

export interface Period {
  kind: PeriodKind;
  start: string;
  end: string;
  label: string;
  calendar: boolean;
  state: PeriodState;
}

export interface Metric {
  unit: string | null;
  baseline: number | null;
  target: number | null;
  current: number | null;
}

export type IncompleteReason =
  'no_measurement' | 'no_target' | 'no_key_results' | 'no_readable_work' | 'unmeasured_key_results';

export interface Progress {
  percent: number | null;
  source: 'metric' | 'manual_percent' | 'key_results' | 'linked_work' | 'none';
  explanation: string;
  work: { done: number; total: number } | null;
  key_results: { counted: number; total: number } | null;
  incomplete: IncompleteReason[];
}

export interface Freshness {
  update_state: UpdateState;
  period_state: PeriodState;
  stale_after_days: number;
  recalculation: { state: 'pending' | 'current' | 'failing'; computed_at: string | null };
}

export type GoalScope =
  | { kind: 'workspace' }
  | { kind: 'brand'; brand: BrandMarkerData }
  | { kind: 'project'; brand: BrandMarkerData; project: { id: string; name: string } | null };

export interface LatestUpdate {
  checkin: string | null;
  at: string | null;
  confidence: Confidence | null;
}

export interface Goal {
  id: string;
  type: 'goal';
  title: string;
  description: string | null;
  scope: GoalScope;
  owner: PersonRef | null;
  status: GoalStatus;
  period: Period;
  basis: GoalBasis;
  metric: Metric;
  progress: Progress;
  latest: LatestUpdate;
  freshness: Freshness;
  work: { visible_links: number; active_links: number; relative_to: 'viewer' };
  key_results_count: number;
  lifecycle_state: Lifecycle;
  version: number;
}

export interface KeyResult {
  id: string;
  type: 'key_result';
  title: string;
  owner: PersonRef | null;
  basis: 'manual' | 'linked_work';
  metric: Metric;
  progress: Progress;
  latest: LatestUpdate;
  lifecycle_state: 'active' | 'archived';
  version: number;
}

export interface LinkedTarget {
  id: string;
  type: 'project' | 'task';
  name: string;
  status_category: string;
  brand: BrandMarkerData;
}

export interface GoalLink {
  target: LinkedTarget;
  key_result: string | null;
}

export interface GoalDetail extends Goal {
  key_results: KeyResult[];
  links: GoalLink[];
  capabilities: {
    update: boolean;
    check_in: boolean;
    archive: boolean;
    restore?: boolean;
    trash: boolean;
  } | null;
  as_of: string;
}

export interface Checkin {
  id: string;
  type: 'goal_checkin';
  source: string;
  key_result: string | null;
  value: number | null;
  progress_percent: number | null;
  confidence: Confidence | null;
  note: string | null;
  author: PersonRef | null;
  created_at: string;
}

export interface CreatedCheckin extends Checkin {
  goal: { id: string; version: number };
  confidence_label: string | null;
}

export interface WorkTask {
  id: string;
  type: 'task';
  title: string;
  status: { category: string };
  done: boolean;
  due_date: string | null;
  project: { id: string; name: string | null } | null;
}

export interface GoalWork {
  type: 'goal_work';
  data: WorkTask[];
  summary: { done: number; total: number };
  coverage: { truncated: boolean; relative_to: 'viewer'; note: string };
  as_of: string;
}

/** A trashed goal or portfolio the viewer may restore. */
export interface TrashedItem {
  id: string;
  type: 'goal' | 'portfolio';
  title?: string;
  name?: string;
  scope?: unknown;
  lifecycle_state: 'trashed';
  version: number;
}

export interface PageOf<T> {
  data: T[];
  page: { limit: number; has_more: boolean; next_cursor?: string };
  as_of?: string;
  scope_note?: string;
}

export interface GoalQuery {
  brand?: string;
  project?: string;
  status?: string;
  owner?: string;
  basis?: string;
  confidence?: string;
  update?: string;
  period?: string;
  from?: string;
  to?: string;
  q?: string;
  /** `true` lists archived goals instead of active ones. */
  archived?: string;
  limit?: number;
  cursor?: string;
}

export interface GoalCreate {
  title: string;
  description?: string;
  brand?: string;
  project?: string;
  owner?: string;
  status: 'draft' | 'active';
  period: { kind: PeriodKind; year?: number; index?: number; start?: string; end?: string };
  basis: GoalBasis;
  metric?: Partial<Metric>;
}

export interface GoalPatch {
  title?: string;
  description?: string | null;
  owner?: string;
  status?: GoalStatus;
  period?: GoalCreate['period'];
  basis?: GoalBasis;
  metric?: Partial<Metric> | null;
}

export interface KeyResultInput {
  title?: string;
  owner?: string;
  basis?: 'manual' | 'linked_work';
  metric?: Partial<Metric> | null;
  after?: string | null;
}

export interface CheckinInput {
  key_result?: string;
  value?: number;
  percent?: number;
  confidence?: Confidence;
  note?: string;
}

// ---- Portfolios -------------------------------------------------------------------------------

export interface HealthReason {
  code: string;
  severity: 'at_risk' | 'off_track';
  message: string;
  facts: Record<string, number | string>;
}

export type HealthIncomplete =
  'no_dates' | 'no_tasks' | 'no_time_budget' | 'paused' | 'cancelled' | 'not_started';

export interface PortfolioProject {
  id: string;
  type: 'project';
  name: string;
  brand: BrandMarkerData;
  status: { category: ProjectCategory; label: string };
  priority: string;
  owner: PersonRef | null;
  dates: {
    start: string | null;
    target: string | null;
    deadline: string | null;
    next_deadline: string | null;
  };
  declared_health: { value: string; source: string | null } | null;
  health: {
    value: ProjectHealth;
    label: string;
    reasons: HealthReason[];
    incomplete: HealthIncomplete[];
    differs_from_declared: boolean;
  };
  progress: { done: number; total: number; percent: number | null; basis: 'readable_leaf_tasks' };
  tasks: { open: number; overdue: number; blocked: number };
  effort: { open_estimate_minutes: number; unestimated_open_tasks: number; logged_minutes: number };
  budget: {
    money: { amount: number | null; currency: string | null; spend: null } | null;
    time: { minutes: number; logged_minutes: number } | null;
    ai: { micros: number; usage: null } | null;
  };
  goals: { direct: number; inherited: number; linked: boolean };
  dependencies: { blocking: number; blocked_by: number };
  version: number;
}

export interface PortfolioCoverage {
  evaluated_projects: number;
  truncated: boolean;
  scope: 'portfolio' | 'readable_projects';
  note: string;
  not_tracked: string[];
}

export interface PortfolioSummary {
  projects: number;
  by_status: Record<string, number>;
  by_health: Record<string, number>;
  schedule: {
    overdue_projects: number;
    due_in_30_days: number;
    upcoming: Array<{ id: string; name: string; date: string; kind: 'target' | 'deadline' }>;
  };
  effort: { open_estimate_minutes: number; unestimated_open_tasks: number; logged_minutes: number };
  budgets: {
    money: {
      by_currency: Array<{ currency: string; budgeted: number; projects: number }>;
      spend_tracked: boolean;
    };
    time: {
      budgeted_minutes: number;
      logged_minutes: number;
      over_budget_projects: number;
      projects: number;
    };
    ai: { budgeted_micros: number; usage_tracked: boolean; projects: number };
  };
  goals: { projects_without_goals: number };
  dependencies: { open: number; overdue: number; late: number };
}

export interface PortfolioOverview {
  type: 'portfolio_overview';
  data: PortfolioProject[];
  summary: PortfolioSummary;
  page: { limit: number; has_more: boolean };
  coverage: PortfolioCoverage;
  as_of: string;
  computed: 'live';
  /** Only on a saved portfolio's overview. */
  portfolio?: Portfolio;
}

export type DependencyState = 'resolved' | 'open' | 'overdue' | 'late';
export interface DependencyEnd {
  id: string;
  title: string;
  status_category: string;
  due: string | null;
}
export interface DependencyPair {
  blocker_project: { id: string; name: string; brand: BrandMarkerData };
  blocked_project: { id: string; name: string; brand: BrandMarkerData };
  counts: Record<DependencyState, number>;
  edges: Array<{ blocker: DependencyEnd; blocked: DependencyEnd; state: DependencyState }>;
}
export interface PortfolioDependencies {
  type: 'portfolio_dependencies';
  data: DependencyPair[];
  summary: Record<DependencyState, number>;
  coverage: { evaluated_projects: number; truncated: boolean; note: string };
  as_of: string;
  computed: 'live';
}

export interface OrphanProject {
  id: string;
  type: 'project';
  name: string;
  brand: BrandMarkerData;
  status: { category: ProjectCategory; label: string };
  owner: PersonRef | null;
  reason: 'no_linked_goal';
}
export interface OrphanGoal {
  id: string;
  type: 'goal';
  title: string;
  scope: 'workspace' | 'brand' | 'project';
  brand: BrandMarkerData | null;
  owner: PersonRef | null;
  period_end: string;
  reason: 'no_visible_work' | 'no_active_work';
}
export interface PortfolioOrphans {
  type: 'portfolio_orphans';
  projects: { data: OrphanProject[]; truncated: boolean };
  goals: { data: OrphanGoal[]; truncated: boolean };
  coverage: { relative_to: 'viewer'; note: string };
  as_of: string;
  computed: 'live';
}

export interface Portfolio {
  id: string;
  type: 'portfolio';
  name: string;
  description: string | null;
  scope: { kind: 'workspace' } | { kind: 'brand'; brand: BrandMarkerData };
  owner: PersonRef | null;
  projects: string[];
  projects_count: number;
  lifecycle_state: Lifecycle;
  capabilities: { update: boolean; archive: boolean; trash: boolean };
  version: number;
}

export interface OverviewQuery {
  portfolio?: string;
  brand?: string;
  status?: string;
  health?: string;
  owner?: string;
  limit?: number;
}

// ---- Requests ---------------------------------------------------------------------------------

const w = (ws: string) => `/v1/workspaces/${ws}`;
const qs = (o: Record<string, string | number | undefined>) => {
  const e = Object.entries(o).filter(([, v]) => v !== undefined && v !== '');
  return e.length ? `?${e.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}` : '';
};

/**
 * A GET whose success response is a file (goal and portfolio exports). Errors use the JSON error
 * envelope like every other request; the body is returned as text with its suggested name.
 */
async function downloadGet(
  path: string,
): Promise<{ text: string; filename: string; contentType: string }> {
  if (!navigator.onLine)
    throw new ApiError({ code: 'offline', status: 0, message: "You're offline." });
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'GET',
      headers: { accept: 'text/csv, application/json' },
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError({ code: 'network', status: 0, message: 'Network error.' });
  }
  if (!res.ok) {
    let e: Record<string, unknown> = {};
    try {
      e = ((await res.json()) as { error?: Record<string, unknown> }).error ?? {};
    } catch {
      // not JSON
    }
    throw new ApiError({
      code: typeof e.code === 'string' ? e.code : 'internal_error',
      status: res.status,
      message: typeof e.message === 'string' ? e.message : 'Something went wrong.',
      issues: Array.isArray(e.issues)
        ? (e.issues as Array<{ pointer?: string; code: string; message: string }>)
        : [],
    });
  }
  const disposition = res.headers.get('content-disposition') ?? '';
  return {
    text: await res.text(),
    filename: /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'export',
    contentType: (res.headers.get('content-type') ?? 'text/plain').split(';')[0]!,
  };
}

/** Saves a downloaded export through the browser. */
export function saveFile(file: { text: string; filename: string; contentType: string }): void {
  const url = URL.createObjectURL(new Blob([file.text], { type: file.contentType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file.filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Options every write accepts: the loaded version (If-Match) and a key a retry may reuse. */
export interface WriteOptions {
  version?: number;
  key?: string;
}
const write = (o?: WriteOptions) => ({
  ...(o?.version !== undefined ? { ifMatch: o.version } : {}),
  ...(o?.key ? { idempotencyKey: o.key } : {}),
});

export const goals = {
  async list(ws: string, q: GoalQuery = {}, signal?: AbortSignal) {
    return (
      await api<PageOf<Goal>>('GET', `${w(ws)}/goals${qs({ ...q })}`, signal ? { signal } : {})
    ).body;
  },
  async trashed(ws: string) {
    return (await api<PageOf<TrashedItem>>('GET', `${w(ws)}/goals?trashed=true`)).body;
  },
  async get(ws: string, goal: string) {
    return (await api<{ data: GoalDetail }>('GET', `${w(ws)}/goals/${goal}`)).body.data;
  },
  async create(ws: string, body: GoalCreate, stepUp: StepUpResolver, o?: WriteOptions) {
    return (
      await protectedRequest<{ data: GoalDetail }>('POST', `${w(ws)}/goals`, body, stepUp, write(o))
    ).body.data;
  },
  async update(
    ws: string,
    goal: string,
    version: number,
    body: GoalPatch,
    stepUp: StepUpResolver,
    o?: WriteOptions,
  ) {
    return (
      await protectedRequest<{ data: GoalDetail }>(
        'PATCH',
        `${w(ws)}/goals/${goal}`,
        body,
        stepUp,
        write({ ...o, version }),
      )
    ).body.data;
  },
  async verb(
    ws: string,
    goal: string,
    verb: 'archive' | 'unarchive' | 'trash' | 'restore' | 'purge',
    version: number,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: { id: string; type: 'goal'; lifecycle_state: Lifecycle } }>(
        'POST',
        `${w(ws)}/goals/${goal}:${verb}`,
        {},
        stepUp,
        write({ version }),
      )
    ).body.data;
  },
  async recalculate(ws: string, goal: string, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: GoalDetail }>(
        'POST',
        `${w(ws)}/goals/${goal}:recalculate`,
        {},
        stepUp,
      )
    ).body.data;
  },
  async createKeyResult(
    ws: string,
    goal: string,
    body: KeyResultInput & { title: string },
    stepUp: StepUpResolver,
    o?: WriteOptions,
  ) {
    return (
      await protectedRequest<{ data: KeyResult }>(
        'POST',
        `${w(ws)}/goals/${goal}/key-results`,
        body,
        stepUp,
        write(o),
      )
    ).body.data;
  },
  async updateKeyResult(
    ws: string,
    goal: string,
    kr: string,
    version: number,
    body: KeyResultInput,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: KeyResult }>(
        'PATCH',
        `${w(ws)}/goals/${goal}/key-results/${kr}`,
        body,
        stepUp,
        write({ version }),
      )
    ).body.data;
  },
  async keyResultVerb(
    ws: string,
    goal: string,
    kr: string,
    verb: 'archive' | 'unarchive',
    version: number,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: { id: string; lifecycle_state: string } }>(
        'POST',
        `${w(ws)}/goals/${goal}/key-results/${kr}:${verb}`,
        {},
        stepUp,
        write({ version }),
      )
    ).body.data;
  },
  async addLink(
    ws: string,
    goal: string,
    body: { target: string; key_result?: string },
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: GoalDetail }>(
        'POST',
        `${w(ws)}/goals/${goal}/links`,
        body,
        stepUp,
      )
    ).body.data;
  },
  async removeLink(
    ws: string,
    goal: string,
    target: string,
    keyResult: string | null,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: GoalDetail }>(
        'DELETE',
        `${w(ws)}/goals/${goal}/links${qs({ target, key_result: keyResult ?? undefined })}`,
        undefined,
        stepUp,
      )
    ).body.data;
  },
  async checkins(
    ws: string,
    goal: string,
    q: { key_result?: string; cursor?: string; limit?: number } = {},
  ) {
    return (await api<PageOf<Checkin>>('GET', `${w(ws)}/goals/${goal}/check-ins${qs({ ...q })}`))
      .body;
  },
  async checkin(ws: string, goal: string, body: CheckinInput, stepUp: StepUpResolver, key: string) {
    return (
      await protectedRequest<{ data: CreatedCheckin }>(
        'POST',
        `${w(ws)}/goals/${goal}/check-ins`,
        body,
        stepUp,
        { idempotencyKey: key },
      )
    ).body.data;
  },
  async work(ws: string, goal: string, keyResult?: string) {
    return (
      await api<{ data: GoalWork }>(
        'GET',
        `${w(ws)}/goals/${goal}/work${qs({ key_result: keyResult })}`,
      )
    ).body.data;
  },
  async ofProject(ws: string, prj: string) {
    return (await api<PageOf<Goal>>('GET', `${w(ws)}/projects/${prj}/goals`)).body;
  },
  exportFile(ws: string, format: 'csv' | 'json', q: GoalQuery = {}) {
    const { cursor: _c, limit: _l, ...rest } = q;
    return downloadGet(`${w(ws)}/goals/export${qs({ ...rest, format })}`);
  },
};

export const portfolios = {
  async list(ws: string, archived = false) {
    return (
      await api<PageOf<Portfolio>>(
        'GET',
        `${w(ws)}/portfolios${qs({ archived: archived ? 'true' : undefined })}`,
      )
    ).body;
  },
  async trashed(ws: string) {
    return (await api<PageOf<TrashedItem>>('GET', `${w(ws)}/portfolios?trashed=true`)).body;
  },
  async get(ws: string, pf: string) {
    return (await api<{ data: Portfolio }>('GET', `${w(ws)}/portfolios/${pf}`)).body.data;
  },
  async create(
    ws: string,
    body: { name: string; description?: string; brand?: string; owner?: string },
    stepUp: StepUpResolver,
    o?: WriteOptions,
  ) {
    return (
      await protectedRequest<{ data: Portfolio }>(
        'POST',
        `${w(ws)}/portfolios`,
        body,
        stepUp,
        write(o),
      )
    ).body.data;
  },
  async update(
    ws: string,
    pf: string,
    version: number,
    body: { name?: string; description?: string | null; owner?: string },
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: Portfolio }>(
        'PATCH',
        `${w(ws)}/portfolios/${pf}`,
        body,
        stepUp,
        write({ version }),
      )
    ).body.data;
  },
  async setProjects(
    ws: string,
    pf: string,
    version: number,
    projects: string[],
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: Portfolio }>(
        'PUT',
        `${w(ws)}/portfolios/${pf}/projects`,
        { projects },
        stepUp,
        write({ version }),
      )
    ).body.data;
  },
  async verb(
    ws: string,
    pf: string,
    verb: 'archive' | 'unarchive' | 'trash' | 'restore' | 'purge',
    version: number,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: { id: string; lifecycle_state: Lifecycle } }>(
        'POST',
        `${w(ws)}/portfolios/${pf}:${verb}`,
        {},
        stepUp,
        write({ version }),
      )
    ).body.data;
  },
  async overview(ws: string, q: OverviewQuery = {}, signal?: AbortSignal) {
    const { portfolio, ...rest } = q;
    const path = portfolio
      ? `${w(ws)}/portfolios/${portfolio}/overview`
      : `${w(ws)}/portfolio/overview`;
    return (
      await api<{ data: PortfolioOverview }>(
        'GET',
        `${path}${qs({ ...rest })}`,
        signal ? { signal } : {},
      )
    ).body.data;
  },
  async dependencies(ws: string, q: OverviewQuery = {}) {
    return (
      await api<{ data: PortfolioDependencies }>(
        'GET',
        `${w(ws)}/portfolio/dependencies${qs({ ...q })}`,
      )
    ).body.data;
  },
  async orphans(ws: string, q: OverviewQuery = {}) {
    return (
      await api<{ data: PortfolioOrphans }>('GET', `${w(ws)}/portfolio/orphans${qs({ ...q })}`)
    ).body.data;
  },
  exportFile(ws: string, format: 'csv' | 'json', q: OverviewQuery = {}) {
    const { limit: _l, ...rest } = q;
    return downloadGet(`${w(ws)}/portfolio/export${qs({ ...rest, format })}`);
  },
};
