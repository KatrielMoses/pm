/*
 * One shared, deterministic sample workspace so all 20 mockups show the same truth and differ
 * only in design. "Now" is Tue 6 Oct 2026, 10:40. Every number a design shows should come from
 * here (via `summary(brand)`) so switching brand filters the dashboard for real.
 */

export type BrandId = 'ma' | 'ax' | 'op';
export type Health = 'on' | 'risk' | 'off';
export type AgentState = 'queued' | 'running' | 'waiting' | 'review' | 'failed' | 'accepted';

export const NOW = { label: 'Tue 6 Oct', day: 6, weekday: 'Tue', month: 'Oct', year: 2026, time: '10:40', minutes: 10 * 60 + 40 };
export const USER = { name: 'Katriel', initials: 'KM' };
export const PRODUCT = { name: 'Untitled', mark: 'U' }; // product name is undecided

export const brands: { id: BrandId; name: string; short: string }[] = [
  { id: 'ma', name: 'MailAccess', short: 'MA' },
  { id: 'ax', name: 'API Access', short: 'AX' },
  { id: 'op', name: 'Optestra', short: 'OP' },
];

export const brandName = (id: BrandId) => brands.find((b) => b.id === id)!.name;
export const brandShort = (id: BrandId) => brands.find((b) => b.id === id)!.short;

export type Project = {
  id: string; brand: BrandId; name: string; health: Health; progress: number;
  due: string; dueDays: number; open: number; blocked: number; overdue: number;
  hoursPlanned: number; hoursActual: number;
};

export const projects: Project[] = [
  { id: 'p1', brand: 'op', name: 'v1.4 release', health: 'risk', progress: 78, due: 'Thu 8 Oct', dueDays: 2, open: 9, blocked: 2, overdue: 1, hoursPlanned: 46, hoursActual: 41 },
  { id: 'p2', brand: 'op', name: 'Android runner', health: 'on', progress: 54, due: '23 Oct', dueDays: 17, open: 14, blocked: 0, overdue: 0, hoursPlanned: 60, hoursActual: 31 },
  { id: 'p3', brand: 'op', name: 'Pricing launch', health: 'on', progress: 35, due: '30 Oct', dueDays: 24, open: 11, blocked: 0, overdue: 1, hoursPlanned: 28, hoursActual: 9 },
  { id: 'p4', brand: 'op', name: 'Docs site', health: 'on', progress: 90, due: '12 Oct', dueDays: 6, open: 3, blocked: 0, overdue: 0, hoursPlanned: 12, hoursActual: 11 },
  { id: 'p5', brand: 'ma', name: 'Inbox API v2', health: 'off', progress: 41, due: 'Fri 9 Oct', dueDays: 3, open: 12, blocked: 1, overdue: 2, hoursPlanned: 38, hoursActual: 44 },
  { id: 'p6', brand: 'ma', name: 'Pro checkout', health: 'on', progress: 66, due: '19 Oct', dueDays: 13, open: 6, blocked: 0, overdue: 0, hoursPlanned: 20, hoursActual: 13 },
  { id: 'p7', brand: 'ma', name: 'Deliverability audit', health: 'risk', progress: 22, due: '15 Oct', dueDays: 9, open: 8, blocked: 1, overdue: 1, hoursPlanned: 16, hoursActual: 5 },
  { id: 'p8', brand: 'ax', name: 'Scanner rules', health: 'on', progress: 71, due: '16 Oct', dueDays: 10, open: 7, blocked: 0, overdue: 0, hoursPlanned: 30, hoursActual: 22 },
  { id: 'p9', brand: 'ax', name: 'Partner portal', health: 'on', progress: 18, due: '6 Nov', dueDays: 31, open: 15, blocked: 0, overdue: 0, hoursPlanned: 40, hoursActual: 6 },
];

export type Task = {
  id: string; brand: BrandId; project: string; title: string; est: number; // minutes
  start?: number; // minutes from midnight when scheduled today
  status: 'todo' | 'doing' | 'done' | 'blocked'; priority: 1 | 2 | 3; overdue?: boolean; locked?: boolean;
  agent?: boolean;
};

export const today: Task[] = [
  { id: 't1', brand: 'op', project: 'v1.4 release', title: 'Fix flaky checkout heal', est: 60, start: 9 * 60, status: 'done', priority: 1 },
  { id: 't2', brand: 'ma', project: 'Inbox API v2', title: 'Rate-limit regression', est: 90, start: 11 * 60, status: 'doing', priority: 1, overdue: true },
  { id: 't3', brand: 'op', project: 'v1.4 release', title: 'Review agent PR #212', est: 30, start: 12 * 60 + 30, status: 'todo', priority: 1, agent: true },
  { id: 't4', brand: 'ax', project: 'Scanner rules', title: 'CVE rule pack QA', est: 60, start: 14 * 60, status: 'todo', priority: 2 },
  { id: 't5', brand: 'ma', project: 'Pro checkout', title: 'Dodo webhook retries', est: 45, start: 15 * 60 + 30, status: 'todo', priority: 2, locked: true },
  { id: 't6', brand: 'op', project: 'Pricing launch', title: 'Credits page copy', est: 45, status: 'todo', priority: 3 },
  { id: 't7', brand: 'ax', project: 'Partner portal', title: 'Portal auth spike', est: 60, status: 'todo', priority: 3 },
];

export type CalEvent = { id: string; brand: BrandId | null; title: string; start: number; end: number };
export const events: CalEvent[] = [
  { id: 'e1', brand: 'op', title: 'Standup', start: 10 * 60, end: 10 * 60 + 15 },
  { id: 'e2', brand: 'ma', title: 'Customer call', start: 13 * 60, end: 13 * 60 + 30 },
  { id: 'e3', brand: null, title: 'Focus', start: 16 * 60 + 30, end: 18 * 60 },
];

export type Run = { id: string; brand: BrandId; agent: string; task: string; state: AgentState; cost: number; mins: number };
export const runs: Run[] = [
  { id: 'r1', brand: 'op', agent: 'Dev agent', task: 'Heal selector drift', state: 'running', cost: 0.42, mins: 6 },
  { id: 'r2', brand: 'ax', agent: 'Research', task: 'CVE-2026-4471 notes', state: 'running', cost: 0.18, mins: 3 },
  { id: 'r3', brand: 'op', agent: 'Dev agent', task: 'PR #212 retry logic', state: 'review', cost: 1.12, mins: 14 },
  { id: 'r4', brand: 'ma', agent: 'Docs', task: 'API v2 changelog', state: 'review', cost: 0.31, mins: 4 },
  { id: 'r5', brand: 'op', agent: 'Test agent', task: 'Android smoke suite', state: 'review', cost: 0.87, mins: 11 },
  { id: 'r6', brand: 'ma', agent: 'Growth', task: 'Pro upsell variants', state: 'failed', cost: 0.09, mins: 1 },
  { id: 'r7', brand: 'ax', agent: 'Dev agent', task: 'Portal OAuth scaffold', state: 'queued', cost: 0, mins: 0 },
];

export const release = {
  brand: 'op' as BrandId, version: 'v1.4', name: 'Optestra v1.4', decision: 'Thu 8 Oct',
  tests: 214, passed: 206, failed: 3, flaky: 3, skipped: 2, blockers: 2,
  checks: [
    { label: 'Scope frozen', done: true }, { label: 'Tests green', done: false },
    { label: 'Docs', done: true }, { label: 'Approval', done: false },
  ],
};

export type Briefing = { id: string; brand: BrandId; text: string; kind: 'done' | 'risk' | 'decision'; source: string };
export const briefing: Briefing[] = [
  { id: 'b1', brand: 'op', kind: 'done', text: '4 deliverables accepted', source: 'PR #208, #209' },
  { id: 'b2', brand: 'ma', kind: 'risk', text: 'Inbox API v2 is 6h over plan', source: 'Time log' },
  { id: 'b3', brand: 'op', kind: 'decision', text: 'v1.4 go / no-go due Thu', source: 'Release' },
  { id: 'b4', brand: 'ax', kind: 'done', text: 'Rule pack 3 merged, not verified', source: 'PR #77' },
];

/* Week capacity (Mon..Sun): available focus hours vs committed estimates. */
export const week = [
  { d: 'Mon', avail: 6, planned: 5.5, done: 5 },
  { d: 'Tue', avail: 5, planned: 6.5, done: 1 },
  { d: 'Wed', avail: 6, planned: 5, done: 0 },
  { d: 'Thu', avail: 4, planned: 6, done: 0 },
  { d: 'Fri', avail: 6, planned: 3.5, done: 0 },
  { d: 'Sat', avail: 2, planned: 1, done: 0 },
  { d: 'Sun', avail: 0, planned: 0, done: 0 },
];

/* Hours per brand this week (planned). */
export const brandHours: Record<BrandId, number> = { op: 14.5, ma: 9, ax: 4 };

/* 12 weeks of throughput: tasks completed per week, per brand. */
export const throughput: Record<BrandId, number[]> = {
  op: [9, 11, 8, 12, 14, 10, 13, 15, 12, 16, 14, 17],
  ma: [6, 5, 7, 6, 8, 7, 5, 6, 9, 7, 6, 5],
  ax: [3, 4, 2, 5, 4, 6, 5, 4, 6, 5, 7, 6],
};
export const weeksLabels = ['Jul 20', 'Jul 27', 'Aug 3', 'Aug 10', 'Aug 17', 'Aug 24', 'Aug 31', 'Sep 7', 'Sep 14', 'Sep 21', 'Sep 28', 'Oct 5'];

/* Activity heatmap: 7 days x 12 weeks of completed items (all brands). */
export const heat: number[][] = Array.from({ length: 7 }, (_, d) =>
  Array.from({ length: 12 }, (_, w) => {
    const v = ((d * 7 + w * 13 + d * w) % 9) - (d > 4 ? 4 : 0);
    return Math.max(0, v);
  }),
);

export const goals: { brand: BrandId; label: string; current: number; target: number; unit: string }[] = [
  { brand: 'op', label: 'MRR', current: 1240, target: 5000, unit: '$' },
  { brand: 'ma', label: 'Pro users', current: 312, target: 500, unit: '' },
  { brand: 'ax', label: 'Partners', current: 4, target: 10, unit: '' },
];

export const ai = { spent: 18.4, cap: 40, actions: 126 };

/* ---------- derived ---------- */

const inBrand = <T extends { brand: BrandId | null }>(rows: T[], b: BrandId | null) =>
  b ? rows.filter((r) => r.brand === b) : rows;

const sum = (xs: number[]) => xs.reduce((a, c) => a + c, 0);

export function summary(b: BrandId | null) {
  const ps = inBrand(projects, b);
  const ts = inBrand(today, b);
  const rs = inBrand(runs, b);
  const committed = sum(ts.map((t) => t.est)) / 60;
  const scale = b ? brandHours[b] / sum(Object.values(brandHours)) : 1;
  const available = b ? Math.round(5 * scale * 2) / 2 : 5;
  const tp = b ? throughput[b] : throughput.op.map((_, i) => throughput.op[i] + throughput.ma[i] + throughput.ax[i]);
  const aiSpent = b ? Math.round(ai.spent * { op: 0.58, ma: 0.27, ax: 0.15 }[b] * 10) / 10 : ai.spent;
  return {
    brand: b,
    projects: ps,
    active: ps.length,
    health: { on: ps.filter((p) => p.health === 'on').length, risk: ps.filter((p) => p.health === 'risk').length, off: ps.filter((p) => p.health === 'off').length },
    open: sum(ps.map((p) => p.open)),
    blocked: sum(ps.map((p) => p.blocked)),
    overdue: sum(ps.map((p) => p.overdue)),
    dueSoon: ps.filter((p) => p.dueDays <= 7).length,
    today: ts,
    todayDone: ts.filter((t) => t.status === 'done').length,
    committed, // hours
    available, // hours
    over: Math.max(0, committed - available),
    events: inBrand(events, b),
    runs: rs,
    running: rs.filter((r) => r.state === 'running').length,
    review: rs.filter((r) => r.state === 'review').length,
    failed: rs.filter((r) => r.state === 'failed').length,
    queued: rs.filter((r) => r.state === 'queued').length,
    needsYou: rs.filter((r) => r.state === 'review' || r.state === 'failed').length + (b === null || b === 'op' ? 1 : 0),
    briefing: inBrand(briefing, b),
    throughput: tp,
    goals: inBrand(goals, b),
    ai: { spent: aiSpent, cap: b ? Math.round(ai.cap * { op: 0.5, ma: 0.3, ax: 0.2 }[b]) : ai.cap },
    release: b === null || b === 'op' ? release : null,
    week: week.map((d) => ({ ...d, avail: Math.round(d.avail * scale * 2) / 2, planned: Math.round(d.planned * scale * 2) / 2, done: Math.round(d.done * scale * 2) / 2 })),
    hoursPlanned: sum(ps.map((p) => p.hoursPlanned)),
    hoursActual: sum(ps.map((p) => p.hoursActual)),
  };
}

export type Summary = ReturnType<typeof summary>;

export const fmtH = (h: number) => (Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`);
export const fmtClock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const pct = (a: number, b: number) => (b === 0 ? 0 : Math.round((a / b) * 100));
