import { api, protectedRequest, type StepUpResolver } from '../api.ts';

/** Typed client for the 3C planning API (ADR-0020). Every identifier is a public ID. */

export interface TaskBrief {
  id: string;
  title: string;
  brand: { id: string; name: string };
  due_date: string | null;
  deadline_date: string | null;
  estimate_minutes: number | null;
  committed?: boolean;
  reason?: 'overdue' | 'due_today' | 'deadline_soon';
}

export interface Commitment {
  task: TaskBrief & { status_category: string };
  rank: string;
  locked: boolean;
  outcome: 'open' | 'done' | 'carried' | 'returned' | 'dropped';
  carried_to: string | null;
  source: 'manual' | 'plan' | 'carry';
  done: boolean;
  blocks: string[];
  version: number;
}

export interface Block {
  id: string;
  type: 'work_block';
  task: { id: string; title: string } | null;
  unavailable: boolean;
  title: string | null;
  starts_at: string;
  ends_at: string;
  minutes: number;
  source_tz: string;
  focus: boolean;
  locked: boolean;
  prep_minutes: number;
  buffer_minutes: number;
  source: 'manual' | 'estimate' | 'recurrence';
  series: string | null;
  warnings: Array<'after_due_date' | 'after_deadline'>;
  version: number;
}

export interface DayRecord {
  day: string;
  closed_by: 'shutdown' | 'auto';
  committed: number;
  completed: number;
  carried: number;
  returned: number;
  dropped: number;
  planned_minutes: number;
  unestimated: number;
  block_minutes: number;
  focus_minutes: number;
  actual_seconds: number;
}

export interface TodayView {
  day: string;
  tz: string;
  today: string;
  server_now: string;
  closed: boolean;
  committed: Commitment[];
  scheduled: Block[];
  overdue: { items: TaskBrief[]; has_more: boolean };
  due_today: { items: TaskBrief[]; has_more: boolean };
  upcoming_deadlines: { items: TaskBrief[]; has_more: boolean };
  totals: {
    committed: number;
    estimate_minutes: number;
    unestimated: number;
    block_minutes: number;
    focus_minutes: number;
  };
  available_minutes: null;
  record: DayRecord | null;
  can_shutdown: boolean;
}

export interface Series {
  id: string;
  type: 'block_series';
  rrule: string;
  anchor_tz: string;
  start_local: string;
  duration_minutes: number;
  focus: boolean;
  state: 'active' | 'ended';
  title: string | null;
  task: string | null;
  version: number;
}

const w = (ws: string) => `/v1/workspaces/${ws}`;
export const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export const planning = {
  async today(ws: string, day = 'today') {
    return (await api<{ data: TodayView }>('GET', `${w(ws)}/today/${day}`)).body.data;
  },
  async plan(ws: string, day = 'today') {
    return (
      await api<{ data: { day: string; suggestions: TaskBrief[]; committed: string[] } }>(
        'GET',
        `${w(ws)}/today/${day}/plan`,
      )
    ).body.data;
  },
  async commit(ws: string, day: string, tasks: string[], stepUp: StepUpResolver) {
    return protectedRequest(
      'POST',
      `${w(ws)}/today/${day}/items`,
      tasks.length === 1 ? { task: tasks[0] } : { tasks },
      stepUp,
    );
  },
  async update(
    ws: string,
    day: string,
    task: string,
    version: number,
    body: Record<string, unknown>,
    stepUp: StepUpResolver,
  ) {
    return protectedRequest('PATCH', `${w(ws)}/today/${day}/items/${task}`, body, stepUp, {
      ifMatch: version,
    });
  },
  async remove(ws: string, day: string, task: string, version: number, stepUp: StepUpResolver) {
    return protectedRequest('DELETE', `${w(ws)}/today/${day}/items/${task}`, {}, stepUp, {
      ifMatch: version,
    });
  },
  async shutdown(
    ws: string,
    day: string,
    items: Array<{ task: string; action: string; day?: string }>,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: DayRecord }>(
        'POST',
        `${w(ws)}/today/${day}:shutdown`,
        { items },
        stepUp,
      )
    ).body.data;
  },
  async records(ws: string) {
    return (await api<{ data: { records: DayRecord[] } }>('GET', `${w(ws)}/daily-records`)).body
      .data.records;
  },
  async createBlock(ws: string, body: Record<string, unknown>, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: Block }>(
        'POST',
        `${w(ws)}/work-blocks`,
        { tz: deviceZone(), ...body },
        stepUp,
      )
    ).body.data;
  },
  async fromEstimate(ws: string, body: Record<string, unknown>, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: Block }>(
        'POST',
        `${w(ws)}/work-blocks/from-estimate`,
        { tz: deviceZone(), ...body },
        stepUp,
      )
    ).body.data;
  },
  async updateBlock(
    ws: string,
    blk: string,
    version: number,
    body: Record<string, unknown>,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: Block }>(
        'PATCH',
        `${w(ws)}/work-blocks/${blk}`,
        body,
        stepUp,
        { ifMatch: version },
      )
    ).body.data;
  },
  async deleteBlock(ws: string, blk: string, version: number, stepUp: StepUpResolver) {
    await protectedRequest('DELETE', `${w(ws)}/work-blocks/${blk}`, {}, stepUp, {
      ifMatch: version,
    });
  },
  async series(ws: string) {
    return (await api<{ data: Series[] }>('GET', `${w(ws)}/block-series`)).body.data;
  },
  async createSeries(ws: string, body: Record<string, unknown>, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: Series & { generated: number; skipped: number } }>(
        'POST',
        `${w(ws)}/block-series`,
        { tz: deviceZone(), ...body },
        stepUp,
      )
    ).body.data;
  },
  async endSeries(ws: string, bls: string, version: number, stepUp: StepUpResolver) {
    await protectedRequest('POST', `${w(ws)}/block-series/${bls}:end`, {}, stepUp, {
      ifMatch: version,
    });
  },
};

/** A local `HH:MM` on `day` (this device's zone) as an ISO instant. */
export const localInstant = (day: string, hhmm: string) => new Date(`${day}T${hhmm}`).toISOString();
export const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
