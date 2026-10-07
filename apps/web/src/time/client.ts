import {
  api,
  downloadPost,
  newIdempotencyKey,
  protectedRequest,
  type StepUpResolver,
} from '../api.ts';

/** Typed client for the 3D time API (ADR-0019). Every identifier is a public ID. */

export interface TimeEntry {
  id: string;
  type: 'time_entry';
  target: { type: 'task' | 'project'; id: string; title: string } | null;
  brand: { id: string; name: string };
  person: { id: string; name: string };
  source: 'manual' | 'timer';
  state: 'running' | 'paused' | 'stopped';
  started_at: string | null;
  ended_at: string | null;
  running_since: string | null;
  work_date: string;
  tz: string;
  duration_seconds: number;
  hours: number;
  billable: boolean;
  note: string;
  auto_stopped: boolean;
  segments: Array<{ started_at: string; ended_at: string | null }>;
  status: 'open' | 'submitted' | 'locked';
  own: boolean;
  editable: boolean;
  version: number;
}

export interface TimesheetLine {
  brand: { id: string; name: string };
  state: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'unlocked' | null;
  submitted: { seconds: number; billable_seconds: number; entries: number; hours: number } | null;
  decisions: Array<{
    decision: 'approve' | 'reject';
    by: { id: string; name: string };
    at: string;
    self_approval: boolean;
    total_seconds: number;
  }>;
  locks: Array<{
    action: 'lock' | 'unlock';
    by: { id: string; name: string };
    at: string;
    reason?: string;
  }>;
  locked: boolean;
  can_approve: boolean;
  can_unlock: boolean;
  self_approval?: boolean;
}

export interface TimesheetPeriod {
  period: { start: string; end: string };
  week_start: number;
  today: string;
  timesheet: {
    id: string;
    state: 'open' | 'submitted' | 'approved';
    version: number;
    submitted_at: string | null;
  } | null;
  lines: TimesheetLine[];
  days: Array<{ date: string; seconds: number; hours: number }>;
  totals: {
    seconds: number;
    billable_seconds: number;
    non_billable_seconds: number;
    hours: number;
  };
  entries: TimeEntry[];
  has_live_timer: boolean;
  can_submit: boolean;
  can_withdraw: boolean;
}

export interface Timesheet {
  id: string;
  type: 'timesheet';
  person: { id: string; name: string };
  period: { start: string; end: string };
  state: 'open' | 'submitted' | 'approved';
  submitted_at: string | null;
  own: boolean;
  lines: TimesheetLine[];
  entries: TimeEntry[];
  version: number;
}

export interface ReportRow {
  key: { type: string; id: string | null; label: string };
  planned_minutes: number | null;
  estimated_tasks: number;
  actual_seconds: number;
  actual_hours: number;
  billable_seconds: number;
  non_billable_seconds: number;
  entries: number;
  budget_minutes?: number | null;
}

export interface TimeReport {
  range: { from: string; to: string };
  group: string;
  planned_measure: 'task_estimate' | 'task_estimate_by_due_date';
  billable: 'all' | 'billable' | 'non_billable';
  rows: ReportRow[];
  truncated: boolean;
  totals: {
    planned_minutes: number;
    actual_seconds: number;
    actual_hours: number;
    billable_seconds: number;
    non_billable_seconds: number;
    entries: number;
  };
}

export interface WorkSummary {
  target: { type: 'task' | 'project'; id: string };
  planned: {
    estimate_minutes?: number | null;
    remaining_estimate_minutes?: number | null;
    budget_minutes?: number | null;
    task_estimate_minutes?: number | null;
    estimated_tasks?: number;
    tasks?: number;
  };
  actual: {
    seconds: number;
    hours: number;
    billable_seconds: number;
    non_billable_seconds: number;
    mine_seconds: number;
    entries: number;
  };
  remaining: {
    minutes: number | null;
    open_tasks: number;
    unestimated_open_tasks: number;
    method: string;
  };
  live_timer: string | null;
}

const w = (ws: string) => `/v1/workspaces/${ws}`;
const qs = (query: Record<string, string | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) q.set(k, v);
  return q.toString() ? `?${q}` : '';
};

/** The person's IANA zone as the browser reports it (sent with every logged time). */
export const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export const time = {
  async timer(ws: string) {
    return (
      await api<{ data: { timer: TimeEntry | null; server_now: string; max_seconds: number } }>(
        'GET',
        `${w(ws)}/timer`,
      )
    ).body.data;
  },
  async start(ws: string, body: Record<string, unknown>, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: TimeEntry }>(
        'POST',
        `${w(ws)}/timer`,
        { tz: browserZone(), ...body },
        stepUp,
      )
    ).body.data;
  },
  /**
   * A timer action with a caller-chosen idempotency key, so an action queued while offline is
   * replayed exactly once when the connection returns (the server is also idempotent by state).
   */
  async action(
    ws: string,
    te: string,
    verb: 'pause' | 'resume' | 'stop',
    body: { at?: string },
    key: string = newIdempotencyKey(),
  ) {
    return (
      await api<{ data: TimeEntry }>('POST', `${w(ws)}/time-entries/${te}:${verb}`, {
        body,
        headers: { 'idempotency-key': key },
      })
    ).body.data;
  },
  async entries(ws: string, query: Record<string, string | undefined>) {
    return (
      await api<{ data: TimeEntry[]; page: { has_more: boolean; next_cursor?: string } }>(
        'GET',
        `${w(ws)}/time-entries${qs(query)}`,
      )
    ).body;
  },
  async create(ws: string, body: Record<string, unknown>, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: TimeEntry }>(
        'POST',
        `${w(ws)}/time-entries`,
        { tz: browserZone(), ...body },
        stepUp,
      )
    ).body.data;
  },
  async update(
    ws: string,
    te: string,
    version: number,
    body: Record<string, unknown>,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: TimeEntry }>(
        'PATCH',
        `${w(ws)}/time-entries/${te}`,
        body,
        stepUp,
        {
          ifMatch: version,
        },
      )
    ).body.data;
  },
  async remove(ws: string, te: string, version: number, stepUp: StepUpResolver) {
    await protectedRequest('DELETE', `${w(ws)}/time-entries/${te}`, {}, stepUp, {
      ifMatch: version,
    });
  },
  async period(ws: string, date?: string) {
    return (await api<{ data: TimesheetPeriod }>('GET', `${w(ws)}/timesheet-period${qs({ date })}`))
      .body.data;
  },
  async submit(ws: string, periodStart: string, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: Timesheet }>(
        'POST',
        `${w(ws)}/timesheets`,
        { period_start: periodStart },
        stepUp,
      )
    ).body.data;
  },
  async withdraw(ws: string, tsh: string, version: number, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: Timesheet }>(
        'POST',
        `${w(ws)}/timesheets/${tsh}:withdraw`,
        {},
        stepUp,
        {
          ifMatch: version,
        },
      )
    ).body.data;
  },
  async approvals(ws: string, state: 'pending' | 'decided' = 'pending') {
    return (await api<{ data: Timesheet[] }>('GET', `${w(ws)}/timesheets${qs({ state })}`)).body
      .data;
  },
  async decide(
    ws: string,
    tsh: string,
    version: number,
    body: { brand: string; decision: 'approve' | 'reject'; note?: string },
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: Timesheet }>(
        'POST',
        `${w(ws)}/timesheets/${tsh}:decide`,
        body,
        stepUp,
        {
          ifMatch: version,
        },
      )
    ).body.data;
  },
  async unlock(
    ws: string,
    tsh: string,
    version: number,
    body: { brand: string; reason: string },
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: Timesheet }>(
        'POST',
        `${w(ws)}/timesheets/${tsh}:unlock`,
        body,
        stepUp,
        {
          ifMatch: version,
        },
      )
    ).body.data;
  },
  async report(ws: string, query: Record<string, string | undefined>) {
    return (await api<{ data: TimeReport }>('GET', `${w(ws)}/time-report${qs(query)}`)).body.data;
  },
  async summary(ws: string, target: string) {
    return (await api<{ data: WorkSummary }>('GET', `${w(ws)}/time-summary/${target}`)).body.data;
  },
  /** Downloads an export (the browser saves the file; nothing is stored server-side). */
  async export(ws: string, body: Record<string, unknown>): Promise<{ name: string; blob: Blob }> {
    const r = await downloadPost(`${w(ws)}/time-export`, body);
    return { name: r.filename, blob: new Blob([r.text], { type: r.contentType }) };
  },
};

/** `h:mm` from seconds (minutes floored: never shows more than was recorded). */
export const clock = (seconds: number) => {
  const m = Math.floor(Math.max(seconds, 0) / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};

/** `h:mm:ss` for a running timer. */
export const stopwatch = (seconds: number) => {
  const s = Math.max(Math.floor(seconds), 0);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** Spoken duration for assistive technology ("1 hour 5 minutes"). */
export const spoken = (seconds: number) => {
  const m = Math.floor(Math.max(seconds, 0) / 60);
  const h = Math.floor(m / 60);
  const parts = [];
  if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (m % 60 || !h) parts.push(`${m % 60} minute${m % 60 === 1 ? '' : 's'}`);
  return parts.join(' ');
};
