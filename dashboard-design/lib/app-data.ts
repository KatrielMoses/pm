/*
 * Full sample workspace for the product prototype (/app). Extends lib/data.ts (projects, today,
 * runs, release, goals…) with everything the feature list needs. Deterministic; "now" is
 * Tue 6 Oct 2026 10:40; the visible week is Mon 5 – Sun 11 Oct. Pages read from here and filter
 * by the active brand with `byBrand`.
 */

import { projects, type BrandId, type Health } from './data';

export { projects };

export const byBrand = <T extends { brand: BrandId | null }>(rows: T[], b: BrandId | null) => (b ? rows.filter((r) => r.brand === b || r.brand === null) : rows);
export const projectById = (id: string) => projects.find((p) => p.id === id);

/* ---------------- people & agents ---------------- */

export type Person = { id: string; name: string; initials: string; role: string; kind: 'human' | 'agent'; brands: BrandId[]; hue: number; capacity: number };
export const people: Person[] = [
  { id: 'km', name: 'Katriel', initials: 'KM', role: 'Owner', kind: 'human', brands: ['ma', 'ax', 'op'], hue: 20, capacity: 30 },
  { id: 'dp', name: 'Dev Patel', initials: 'DP', role: 'Engineer', kind: 'human', brands: ['op'], hue: 210, capacity: 32 },
  { id: 'ar', name: 'Ana Ruiz', initials: 'AR', role: 'Designer', kind: 'human', brands: ['ma', 'op'], hue: 300, capacity: 20 },
  { id: 'ln', name: 'Lea Novak', initials: 'LN', role: 'Guest', kind: 'human', brands: ['ax'], hue: 150, capacity: 10 },
  { id: 'ag-dev', name: 'Dev agent', initials: 'DA', role: 'Agent', kind: 'agent', brands: ['op', 'ax'], hue: 0, capacity: 0 },
  { id: 'ag-test', name: 'Test agent', initials: 'TA', role: 'Agent', kind: 'agent', brands: ['op'], hue: 0, capacity: 0 },
  { id: 'ag-res', name: 'Research', initials: 'RA', role: 'Agent', kind: 'agent', brands: ['ax'], hue: 0, capacity: 0 },
  { id: 'ag-docs', name: 'Docs', initials: 'DO', role: 'Agent', kind: 'agent', brands: ['ma', 'op'], hue: 0, capacity: 0 },
  { id: 'ag-growth', name: 'Growth', initials: 'GR', role: 'Agent', kind: 'agent', brands: ['ma'], hue: 0, capacity: 0 },
];
export const personById = (id: string) => people.find((p) => p.id === id);

/* ---------------- tasks ---------------- */

export type Status = 'backlog' | 'todo' | 'doing' | 'review' | 'done' | 'blocked';
export const STATUSES: { id: Status; label: string }[] = [
  { id: 'backlog', label: 'Backlog' }, { id: 'todo', label: 'To do' }, { id: 'doing', label: 'In progress' },
  { id: 'review', label: 'Review' }, { id: 'blocked', label: 'Blocked' }, { id: 'done', label: 'Done' },
];
export const PRIORITY = { 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' } as const;
export type Source = 'typed' | 'voice' | 'email' | 'github' | 'agent' | 'form' | 'api';

export type WorkItem = {
  id: string; key: string; brand: BrandId; projectId: string; title: string; status: Status; priority: 1 | 2 | 3 | 4;
  assignee: string; due?: number; // day of October
  est: number; logged: number; // minutes
  labels: string[]; subtasks: [number, number]; comments: number; files: number; source: Source;
  acceptance?: string[]; deliverable?: 'draft' | 'ready' | 'changes' | 'accepted' | 'rejected'; pr?: string; ci?: 'pass' | 'fail' | 'running';
  milestone?: string; blockedBy?: string; stale?: boolean; updated: string;
};

const T = (o: Omit<WorkItem, 'logged' | 'files' | 'comments' | 'updated'> & Partial<Pick<WorkItem, 'logged' | 'files' | 'comments' | 'updated'>>): WorkItem =>
  ({ logged: 0, files: 0, comments: 0, updated: '2h', ...o });

export const tasks: WorkItem[] = [
  // Optestra · v1.4 release (p1)
  T({ id: 'w1', key: 'OP-212', brand: 'op', projectId: 'p1', title: 'Review agent PR #212 retry logic', status: 'review', priority: 1, assignee: 'km', due: 6, est: 30, labels: ['agent'], subtasks: [2, 3], comments: 4, source: 'agent', acceptance: ['Retries capped at 3', 'Idempotency key per run', 'Unit tests pass'], deliverable: 'ready', pr: '#212', ci: 'pass', milestone: 'RC1', updated: '14m' }),
  T({ id: 'w2', key: 'OP-208', brand: 'op', projectId: 'p1', title: 'Fix flaky checkout heal', status: 'done', priority: 1, assignee: 'km', due: 6, est: 60, logged: 55, labels: ['bug', 'flaky'], subtasks: [3, 3], comments: 2, source: 'github', deliverable: 'accepted', pr: '#208', ci: 'pass', milestone: 'RC1' }),
  T({ id: 'w3', key: 'OP-214', brand: 'op', projectId: 'p1', title: 'Android emulator boot timeout', status: 'blocked', priority: 1, assignee: 'dp', due: 7, est: 120, logged: 70, labels: ['bug', 'android'], subtasks: [1, 4], comments: 6, source: 'form', blockedBy: 'OP-216', ci: 'fail', milestone: 'RC1', updated: '1d' }),
  T({ id: 'w4', key: 'OP-216', brand: 'op', projectId: 'p1', title: 'Upgrade emulator image to API 36', status: 'doing', priority: 1, assignee: 'dp', due: 7, est: 90, logged: 40, labels: ['infra'], subtasks: [2, 5], comments: 1, source: 'typed', ci: 'running', milestone: 'RC1' }),
  T({ id: 'w5', key: 'OP-219', brand: 'op', projectId: 'p1', title: 'Release notes v1.4', status: 'todo', priority: 2, assignee: 'ag-docs', due: 8, est: 30, labels: ['docs'], subtasks: [0, 2], source: 'agent', milestone: 'GA' }),
  T({ id: 'w6', key: 'OP-220', brand: 'op', projectId: 'p1', title: 'Go / no-go checklist', status: 'todo', priority: 1, assignee: 'km', due: 8, est: 20, labels: ['release'], subtasks: [2, 4], source: 'typed', milestone: 'GA' }),
  T({ id: 'w7', key: 'OP-221', brand: 'op', projectId: 'p1', title: 'Heal selector drift on login', status: 'doing', priority: 2, assignee: 'ag-dev', due: 7, est: 45, logged: 6, labels: ['agent', 'heal'], subtasks: [0, 1], source: 'agent', ci: 'running' }),
  // Optestra · Android runner (p2)
  T({ id: 'w8', key: 'OP-190', brand: 'op', projectId: 'p2', title: 'Parallel emulator pool', status: 'doing', priority: 2, assignee: 'dp', due: 14, est: 240, logged: 130, labels: ['android'], subtasks: [3, 6], comments: 3, source: 'typed', milestone: 'Beta' }),
  T({ id: 'w9', key: 'OP-195', brand: 'op', projectId: 'p2', title: 'Android smoke suite', status: 'review', priority: 2, assignee: 'ag-test', due: 9, est: 60, logged: 11, labels: ['tests', 'agent'], subtasks: [5, 5], source: 'agent', deliverable: 'ready' }),
  T({ id: 'w10', key: 'OP-197', brand: 'op', projectId: 'p2', title: 'Spoken test → steps (voice)', status: 'todo', priority: 3, assignee: 'km', due: 16, est: 180, labels: ['ai'], subtasks: [0, 3], source: 'voice' }),
  T({ id: 'w11', key: 'OP-199', brand: 'op', projectId: 'p2', title: 'Device matrix UI', status: 'backlog', priority: 3, assignee: 'ar', est: 120, labels: ['design'], subtasks: [0, 2], source: 'typed' }),
  // Optestra · Pricing launch (p3)
  T({ id: 'w12', key: 'OP-230', brand: 'op', projectId: 'p3', title: 'Credits page copy', status: 'todo', priority: 3, assignee: 'km', due: 9, est: 45, labels: ['growth'], subtasks: [0, 2], source: 'typed' }),
  T({ id: 'w13', key: 'OP-231', brand: 'op', projectId: 'p3', title: 'Dodo plans + top-ups', status: 'doing', priority: 2, assignee: 'dp', due: 12, est: 180, logged: 60, labels: ['billing'], subtasks: [2, 5], comments: 2, source: 'typed' }),
  T({ id: 'w14', key: 'OP-232', brand: 'op', projectId: 'p3', title: 'Usage meter design', status: 'review', priority: 3, assignee: 'ar', due: 8, est: 90, logged: 80, labels: ['design'], subtasks: [3, 3], source: 'typed', deliverable: 'changes', comments: 5 }),
  T({ id: 'w15', key: 'OP-233', brand: 'op', projectId: 'p3', title: 'Founder offer terms', status: 'backlog', priority: 3, assignee: 'km', est: 30, labels: ['growth'], subtasks: [0, 1], source: 'email', stale: true, updated: '9d' }),
  // Optestra · Docs site (p4)
  T({ id: 'w16', key: 'OP-240', brand: 'op', projectId: 'p4', title: 'MCP setup guide', status: 'doing', priority: 3, assignee: 'ag-docs', due: 10, est: 40, logged: 15, labels: ['docs'], subtasks: [1, 2], source: 'agent' }),
  T({ id: 'w17', key: 'OP-241', brand: 'op', projectId: 'p4', title: 'Search on docs', status: 'done', priority: 4, assignee: 'dp', due: 5, est: 60, logged: 50, labels: ['docs'], subtasks: [2, 2], source: 'typed', deliverable: 'accepted' }),
  // MailAccess · Inbox API v2 (p5)
  T({ id: 'w18', key: 'MA-88', brand: 'ma', projectId: 'p5', title: 'Rate-limit regression', status: 'doing', priority: 1, assignee: 'km', due: 5, est: 90, logged: 50, labels: ['bug', 'api'], subtasks: [1, 3], comments: 7, source: 'github', pr: '#341', ci: 'fail', milestone: 'v2.0' }),
  T({ id: 'w19', key: 'MA-90', brand: 'ma', projectId: 'p5', title: 'OAuth token refresh', status: 'blocked', priority: 1, assignee: 'km', due: 8, est: 120, logged: 30, labels: ['api', 'security'], subtasks: [0, 3], comments: 2, source: 'typed', blockedBy: 'MA-88', milestone: 'v2.0' }),
  T({ id: 'w20', key: 'MA-91', brand: 'ma', projectId: 'p5', title: 'API v2 changelog', status: 'review', priority: 2, assignee: 'ag-docs', due: 9, est: 30, logged: 4, labels: ['docs', 'agent'], subtasks: [1, 1], source: 'agent', deliverable: 'ready' }),
  T({ id: 'w21', key: 'MA-92', brand: 'ma', projectId: 'p5', title: 'Webhook signatures', status: 'todo', priority: 2, assignee: 'km', due: 9, est: 90, labels: ['api', 'security'], subtasks: [0, 2], source: 'typed', milestone: 'v2.0' }),
  T({ id: 'w22', key: 'MA-93', brand: 'ma', projectId: 'p5', title: 'Pagination cursors', status: 'done', priority: 2, assignee: 'km', due: 2, est: 120, logged: 150, labels: ['api'], subtasks: [4, 4], source: 'typed', deliverable: 'accepted', pr: '#336', ci: 'pass' }),
  // MailAccess · Pro checkout (p6)
  T({ id: 'w23', key: 'MA-70', brand: 'ma', projectId: 'p6', title: 'Dodo webhook retries', status: 'todo', priority: 2, assignee: 'km', due: 6, est: 45, labels: ['billing'], subtasks: [0, 2], source: 'email' }),
  T({ id: 'w24', key: 'MA-72', brand: 'ma', projectId: 'p6', title: 'Checkout mobile layout', status: 'doing', priority: 3, assignee: 'ar', due: 13, est: 120, logged: 45, labels: ['design'], subtasks: [2, 4], source: 'typed' }),
  T({ id: 'w25', key: 'MA-73', brand: 'ma', projectId: 'p6', title: 'Pro upsell variants', status: 'blocked', priority: 3, assignee: 'ag-growth', due: 10, est: 30, labels: ['growth', 'agent'], subtasks: [0, 3], source: 'agent', comments: 1 }),
  // MailAccess · Deliverability audit (p7)
  T({ id: 'w26', key: 'MA-60', brand: 'ma', projectId: 'p7', title: 'SPF/DKIM report', status: 'todo', priority: 2, assignee: 'km', due: 12, est: 60, labels: ['audit'], subtasks: [0, 3], source: 'form' }),
  T({ id: 'w27', key: 'MA-61', brand: 'ma', projectId: 'p7', title: 'Bounce dashboard', status: 'backlog', priority: 3, assignee: 'ar', est: 90, labels: ['design'], subtasks: [0, 2], source: 'typed', stale: true, updated: '12d' }),
  // API Access · Scanner rules (p8)
  T({ id: 'w28', key: 'AX-77', brand: 'ax', projectId: 'p8', title: 'CVE rule pack QA', status: 'todo', priority: 2, assignee: 'km', due: 6, est: 60, labels: ['security'], subtasks: [1, 4], source: 'github', pr: '#77', ci: 'pass' }),
  T({ id: 'w29', key: 'AX-78', brand: 'ax', projectId: 'p8', title: 'CVE-2026-4471 notes', status: 'doing', priority: 2, assignee: 'ag-res', due: 7, est: 30, logged: 3, labels: ['research', 'agent'], subtasks: [0, 1], source: 'agent' }),
  T({ id: 'w30', key: 'AX-79', brand: 'ax', projectId: 'p8', title: 'False-positive triage', status: 'review', priority: 3, assignee: 'ln', due: 9, est: 90, logged: 60, labels: ['security'], subtasks: [2, 3], source: 'typed', deliverable: 'ready' }),
  // API Access · Partner portal (p9)
  T({ id: 'w31', key: 'AX-90', brand: 'ax', projectId: 'p9', title: 'Portal auth spike', status: 'todo', priority: 3, assignee: 'km', due: 9, est: 60, labels: ['spike'], subtasks: [0, 2], source: 'typed' }),
  T({ id: 'w32', key: 'AX-91', brand: 'ax', projectId: 'p9', title: 'Portal OAuth scaffold', status: 'todo', priority: 3, assignee: 'ag-dev', due: 14, est: 120, labels: ['agent'], subtasks: [0, 4], source: 'agent' }),
  T({ id: 'w33', key: 'AX-92', brand: 'ax', projectId: 'p9', title: 'Partner pricing page', status: 'backlog', priority: 4, assignee: 'ln', est: 60, labels: ['growth'], subtasks: [0, 1], source: 'email' }),
];

export const taskById = (id: string) => tasks.find((t) => t.id === id);
export const tasksFor = (projectId: string) => tasks.filter((t) => t.projectId === projectId);

/* ---------------- calendar (Mon 5 – Sun 11 Oct) ---------------- */

export const WEEK_DAYS = [
  { i: 0, d: 'Mon', n: 5 }, { i: 1, d: 'Tue', n: 6 }, { i: 2, d: 'Wed', n: 7 }, { i: 3, d: 'Thu', n: 8 },
  { i: 4, d: 'Fri', n: 9 }, { i: 5, d: 'Sat', n: 10 }, { i: 6, d: 'Sun', n: 11 },
];
export const TODAY_INDEX = 1;

export type CalBlock = {
  id: string; day: number; start: number; end: number; title: string; brand: BrandId | null;
  kind: 'meeting' | 'task' | 'focus' | 'deadline' | 'milestone'; taskId?: string; locked?: boolean; external?: 'google'; conflict?: boolean; done?: boolean;
};
const h = (hh: number, mm = 0) => hh * 60 + mm;
export const calendar: CalBlock[] = [
  { id: 'c1', day: 0, start: h(9), end: h(10, 30), title: 'Pagination cursors', brand: 'ma', kind: 'task', taskId: 'w22', done: true },
  { id: 'c2', day: 0, start: h(10), end: h(10, 15), title: 'Standup', brand: 'op', kind: 'meeting', external: 'google' },
  { id: 'c3', day: 0, start: h(11), end: h(12), title: 'Search on docs', brand: 'op', kind: 'task', taskId: 'w17', done: true },
  { id: 'c4', day: 0, start: h(14), end: h(15), title: 'Partner intro', brand: 'ax', kind: 'meeting', external: 'google' },
  { id: 'c5', day: 0, start: h(15, 30), end: h(17, 30), title: 'Focus', brand: null, kind: 'focus' },
  { id: 'c6', day: 1, start: h(9), end: h(10), title: 'Fix flaky checkout heal', brand: 'op', kind: 'task', taskId: 'w2', done: true },
  { id: 'c7', day: 1, start: h(10), end: h(10, 15), title: 'Standup', brand: 'op', kind: 'meeting', external: 'google' },
  { id: 'c8', day: 1, start: h(11), end: h(12, 30), title: 'Rate-limit regression', brand: 'ma', kind: 'task', taskId: 'w18' },
  { id: 'c9', day: 1, start: h(12, 30), end: h(13), title: 'Review PR #212', brand: 'op', kind: 'task', taskId: 'w1' },
  { id: 'c10', day: 1, start: h(13), end: h(13, 30), title: 'Customer call', brand: 'ma', kind: 'meeting', external: 'google', conflict: true },
  { id: 'c11', day: 1, start: h(14), end: h(15), title: 'CVE rule pack QA', brand: 'ax', kind: 'task', taskId: 'w28' },
  { id: 'c12', day: 1, start: h(15, 30), end: h(16, 15), title: 'Dodo webhook retries', brand: 'ma', kind: 'task', taskId: 'w23', locked: true },
  { id: 'c13', day: 1, start: h(16, 30), end: h(18), title: 'Focus', brand: null, kind: 'focus' },
  { id: 'c14', day: 2, start: h(9), end: h(11), title: 'OAuth token refresh', brand: 'ma', kind: 'task', taskId: 'w19' },
  { id: 'c15', day: 2, start: h(10), end: h(10, 15), title: 'Standup', brand: 'op', kind: 'meeting', external: 'google', conflict: true },
  { id: 'c16', day: 2, start: h(13), end: h(14), title: 'Design review', brand: 'op', kind: 'meeting', external: 'google' },
  { id: 'c17', day: 2, start: h(14, 30), end: h(16), title: 'Webhook signatures', brand: 'ma', kind: 'task', taskId: 'w21' },
  { id: 'c18', day: 3, start: h(9), end: h(9, 30), title: 'v1.4 go / no-go', brand: 'op', kind: 'milestone' },
  { id: 'c19', day: 3, start: h(10), end: h(10, 15), title: 'Standup', brand: 'op', kind: 'meeting', external: 'google' },
  { id: 'c20', day: 3, start: h(11), end: h(12), title: 'Release notes v1.4', brand: 'op', kind: 'task', taskId: 'w5' },
  { id: 'c21', day: 3, start: h(14), end: h(15, 30), title: 'Usage meter review', brand: 'op', kind: 'meeting' },
  { id: 'c22', day: 4, start: h(10), end: h(10, 15), title: 'Standup', brand: 'op', kind: 'meeting', external: 'google' },
  { id: 'c23', day: 4, start: h(11), end: h(12), title: 'Portal auth spike', brand: 'ax', kind: 'task', taskId: 'w31' },
  { id: 'c24', day: 4, start: h(17), end: h(17, 30), title: 'Inbox API v2 due', brand: 'ma', kind: 'deadline' },
  { id: 'c25', day: 4, start: h(15), end: h(16), title: 'Weekly review', brand: null, kind: 'focus' },
  { id: 'c26', day: 5, start: h(10), end: h(11), title: 'Credits page copy', brand: 'op', kind: 'task', taskId: 'w12' },
];

/* ---------------- AI daily plan ---------------- */

export const plan = {
  available: 300, committed: 390, // minutes
  proposed: [
    { taskId: 'w18', why: 'Overdue · blocks MA-90', locked: false, start: h(11), dur: 90 },
    { taskId: 'w1', why: 'Unblocks v1.4 · due today', locked: false, start: h(12, 30), dur: 30 },
    { taskId: 'w28', why: 'Due today', locked: false, start: h(14), dur: 60 },
    { taskId: 'w23', why: 'You locked it', locked: true, start: h(15, 30), dur: 45 },
  ],
  deferred: [
    { taskId: 'w12', why: 'Due Fri · fits Thu' },
    { taskId: 'w31', why: 'Low priority · fits Fri' },
  ],
};

/* ---------------- inbox (captured, untriaged) ---------------- */

export type InboxItem = {
  id: string; raw: string; source: Source; time: string; attachments?: number;
  detected: { brand?: BrandId; projectId?: string; due?: string; priority?: 1 | 2 | 3 | 4; est?: number; owner?: string; type: 'task' | 'note' | 'project' };
  confidence: 'high' | 'low'; duplicateOf?: string;
};
export const inbox: InboxItem[] = [
  { id: 'i1', raw: 'fix rate limit headers on mailaccess v2 before friday, urgent', source: 'voice', time: '8m', detected: { brand: 'ma', projectId: 'p5', due: 'Fri 9 Oct', priority: 1, est: 60, owner: 'km', type: 'task' }, confidence: 'high', duplicateOf: 'MA-88' },
  { id: 'i2', raw: 'Customer: export fails for >10k rows (forwarded)', source: 'email', time: '34m', attachments: 2, detected: { brand: 'ma', type: 'task', priority: 2 }, confidence: 'low' },
  { id: 'i3', raw: 'Idea: Optestra badge for READMEs', source: 'typed', time: '1h', detected: { brand: 'op', type: 'note' }, confidence: 'high' },
  { id: 'i4', raw: 'Partner form: Acme wants sandbox keys', source: 'form', time: '2h', detected: { brand: 'ax', projectId: 'p9', priority: 2, est: 30, owner: 'ln', type: 'task' }, confidence: 'high' },
  { id: 'i5', raw: 'GitHub #352 · Crash on empty selector', source: 'github', time: '3h', detected: { brand: 'op', projectId: 'p1', priority: 1, est: 45, type: 'task' }, confidence: 'high' },
  { id: 'i6', raw: 'Q4 content plan for all three brands', source: 'typed', time: '1d', detected: { type: 'project' }, confidence: 'low' },
];

/* ---------------- goals ---------------- */

export type Goal = {
  id: string; brand: BrandId | null; title: string; owner: string; period: string; unit: string;
  baseline: number; current: number; target: number; confidence: 'high' | 'medium' | 'low'; trend: number[];
  keyResults: { title: string; current: number; target: number; unit: string }[]; projects: string[]; update: string;
};
export const goalsFull: Goal[] = [
  { id: 'g1', brand: 'op', title: 'Optestra MRR', owner: 'km', period: 'Q4 2026', unit: '$', baseline: 300, current: 1240, target: 5000, confidence: 'medium', trend: [300, 420, 510, 640, 780, 910, 1050, 1240], keyResults: [{ title: 'Paid accounts', current: 58, target: 300, unit: '' }, { title: 'Activation', current: 41, target: 60, unit: '%' }, { title: 'Churn', current: 5.2, target: 4, unit: '%' }], projects: ['p1', 'p3'], update: '2d' },
  { id: 'g2', brand: 'ma', title: 'MailAccess Pro users', owner: 'km', period: 'Q4 2026', unit: '', baseline: 180, current: 312, target: 500, confidence: 'high', trend: [180, 205, 230, 251, 270, 288, 301, 312], keyResults: [{ title: 'Checkout conversion', current: 3.1, target: 5, unit: '%' }, { title: 'API v2 adopters', current: 22, target: 80, unit: '' }], projects: ['p5', 'p6'], update: '5d' },
  { id: 'g3', brand: 'ax', title: 'API Access partners', owner: 'ln', period: 'Q4 2026', unit: '', baseline: 1, current: 4, target: 10, confidence: 'low', trend: [1, 1, 2, 2, 3, 3, 4, 4], keyResults: [{ title: 'Signed pilots', current: 2, target: 5, unit: '' }, { title: 'Portal live', current: 0, target: 1, unit: '' }], projects: ['p9'], update: '11d' },
  { id: 'g4', brand: null, title: 'Founder focus hours', owner: 'km', period: 'Oct 2026', unit: 'h', baseline: 60, current: 41, target: 100, confidence: 'medium', trend: [0, 8, 15, 21, 27, 33, 38, 41], keyResults: [{ title: 'Deep-work blocks', current: 9, target: 20, unit: '' }], projects: [], update: 'today' },
];

/* ---------------- knowledge ---------------- */

export type Doc = { id: string; brand: BrandId | null; title: string; type: 'Brief' | 'SOP' | 'Spec' | 'Decision' | 'Meeting' | 'Release notes'; status: 'Draft' | 'Current' | 'Stale' | 'Archived'; owner: string; updated: string; aiSource: boolean; parent?: string; projectId?: string; words: number };
export const docs: Doc[] = [
  { id: 'd1', brand: 'op', title: 'Optestra brand brief', type: 'Brief', status: 'Current', owner: 'km', updated: '3d', aiSource: true, words: 1840 },
  { id: 'd2', brand: 'op', title: 'v1.4 release plan', type: 'Spec', status: 'Current', owner: 'km', updated: '1d', aiSource: true, projectId: 'p1', words: 960 },
  { id: 'd3', brand: 'op', title: 'Heal review SOP', type: 'SOP', status: 'Current', owner: 'dp', updated: '6d', aiSource: true, parent: 'd2', words: 620 },
  { id: 'd4', brand: 'op', title: 'Pricing v1 decision', type: 'Decision', status: 'Current', owner: 'km', updated: '3d', aiSource: true, projectId: 'p3', words: 1200 },
  { id: 'd5', brand: 'ma', title: 'MailAccess brand brief', type: 'Brief', status: 'Stale', owner: 'km', updated: '74d', aiSource: false, words: 1500 },
  { id: 'd6', brand: 'ma', title: 'Inbox API v2 spec', type: 'Spec', status: 'Current', owner: 'km', updated: '2d', aiSource: true, projectId: 'p5', words: 3100 },
  { id: 'd7', brand: 'ma', title: 'Customer call · 6 Oct', type: 'Meeting', status: 'Draft', owner: 'km', updated: '1h', aiSource: false, words: 380 },
  { id: 'd8', brand: 'ax', title: 'Rule authoring SOP', type: 'SOP', status: 'Current', owner: 'ln', updated: '9d', aiSource: true, projectId: 'p8', words: 870 },
  { id: 'd9', brand: 'ax', title: 'Partner portal brief', type: 'Brief', status: 'Draft', owner: 'km', updated: '4d', aiSource: false, projectId: 'p9', words: 540 },
  { id: 'd10', brand: 'op', title: 'v1.3 release notes', type: 'Release notes', status: 'Archived', owner: 'ag-docs', updated: '31d', aiSource: false, words: 700 },
  { id: 'd11', brand: null, title: 'Weekly review template', type: 'SOP', status: 'Current', owner: 'km', updated: '20d', aiSource: false, words: 240 },
];

/* ---------------- agents ---------------- */

export type AgentProfile = { id: string; name: string; purpose: string; brands: BrandId[]; model: string; tools: string[]; approval: 'always' | 'external' | 'none'; budget: number; spent: number; runs7d: number; success: number };
export const agents: AgentProfile[] = [
  { id: 'ag-dev', name: 'Dev agent', purpose: 'Code changes', brands: ['op', 'ax'], model: 'claude-sonnet-5-5', tools: ['GitHub', 'Tests', 'MCP'], approval: 'always', budget: 20, spent: 9.2, runs7d: 31, success: 87 },
  { id: 'ag-test', name: 'Test agent', purpose: 'Write & run tests', brands: ['op'], model: 'claude-haiku-4-5', tools: ['Optestra', 'GitHub'], approval: 'external', budget: 10, spent: 3.4, runs7d: 44, success: 93 },
  { id: 'ag-res', name: 'Research', purpose: 'CVE & market notes', brands: ['ax'], model: 'claude-sonnet-5-5', tools: ['Web', 'Docs'], approval: 'external', budget: 6, spent: 1.9, runs7d: 12, success: 100 },
  { id: 'ag-docs', name: 'Docs', purpose: 'Docs & changelogs', brands: ['ma', 'op'], model: 'claude-haiku-4-5', tools: ['Docs', 'GitHub'], approval: 'always', budget: 5, spent: 2.1, runs7d: 18, success: 94 },
  { id: 'ag-growth', name: 'Growth', purpose: 'Copy experiments', brands: ['ma'], model: 'claude-haiku-4-5', tools: ['Docs'], approval: 'always', budget: 4, spent: 1.8, runs7d: 9, success: 67 },
];

export const runSteps = [
  { t: '10:26', label: 'Read task + acceptance', kind: 'ok' },
  { t: '10:27', label: 'Cloned repo · branch op-212', kind: 'ok' },
  { t: '10:31', label: 'Edited retry.ts (+42 −9)', kind: 'ok' },
  { t: '10:36', label: 'Ran 38 unit tests · pass', kind: 'ok' },
  { t: '10:39', label: 'Opened PR #212', kind: 'ok' },
  { t: '10:40', label: 'Awaiting review', kind: 'wait' },
] as const;

export const proposedChanges = [
  { id: 'pc1', kind: 'create', label: 'Create task "Cap retries at 3"', target: 'v1.4 release' },
  { id: 'pc2', kind: 'update', label: 'Due date Thu → Wed', target: 'OP-219 Release notes' },
  { id: 'pc3', kind: 'update', label: 'Assign Dev Patel', target: 'OP-214 Emulator timeout' },
  { id: 'pc4', kind: 'link', label: 'Link PR #212', target: 'OP-212' },
] as const;

/* ---------------- releases, tests, defects ---------------- */

export type Release = {
  id: string; brand: BrandId; version: string; name: string; status: 'planning' | 'testing' | 'ready' | 'shipped'; decision: string;
  scope: number; excluded: number; tests: number; passed: number; failed: number; flaky: number; skipped: number; blockers: number;
  checklist: { label: string; done: boolean; owner: string }[]; env: { name: string; version: string; ok: boolean }[];
};
export const releases: Release[] = [
  { id: 'rl1', brand: 'op', version: 'v1.4', name: 'Optestra v1.4', status: 'testing', decision: 'Thu 8 Oct', scope: 18, excluded: 3, tests: 214, passed: 206, failed: 3, flaky: 3, skipped: 2, blockers: 2,
    checklist: [{ label: 'Scope frozen', done: true, owner: 'km' }, { label: 'Tests green', done: false, owner: 'dp' }, { label: 'Docs', done: true, owner: 'ag-docs' }, { label: 'Security review', done: true, owner: 'km' }, { label: 'Approval', done: false, owner: 'km' }],
    env: [{ name: 'Dev', version: '1.4.0-rc3', ok: true }, { name: 'Staging', version: '1.4.0-rc2', ok: true }, { name: 'Prod', version: '1.3.2', ok: true }] },
  { id: 'rl2', brand: 'ma', version: 'v2.0', name: 'Inbox API v2.0', status: 'planning', decision: 'Fri 16 Oct', scope: 12, excluded: 1, tests: 96, passed: 88, failed: 6, flaky: 1, skipped: 1, blockers: 3,
    checklist: [{ label: 'Scope frozen', done: false, owner: 'km' }, { label: 'Tests green', done: false, owner: 'km' }, { label: 'Docs', done: false, owner: 'ag-docs' }, { label: 'Approval', done: false, owner: 'km' }],
    env: [{ name: 'Dev', version: '2.0.0-b4', ok: false }, { name: 'Staging', version: '1.9.8', ok: true }, { name: 'Prod', version: '1.9.8', ok: true }] },
  { id: 'rl3', brand: 'ax', version: 'r3.2', name: 'Rules 3.2', status: 'shipped', decision: 'Thu 1 Oct', scope: 9, excluded: 0, tests: 140, passed: 140, failed: 0, flaky: 0, skipped: 0, blockers: 0,
    checklist: [{ label: 'Scope frozen', done: true, owner: 'km' }, { label: 'Tests green', done: true, owner: 'ln' }, { label: 'Approval', done: true, owner: 'km' }],
    env: [{ name: 'Prod', version: '3.2.0', ok: true }] },
];
export const suites = [
  { name: 'Checkout', total: 42, pass: 40, fail: 1, flaky: 1, history: [1, 1, 1, 0, 1, 1, 1, 1, 0, 1] },
  { name: 'Auth', total: 36, pass: 36, fail: 0, flaky: 0, history: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
  { name: 'Android smoke', total: 28, pass: 25, fail: 2, flaky: 1, history: [1, 0, 1, 1, 0, 1, 0, 1, 1, 0] },
  { name: 'Heal engine', total: 64, pass: 63, fail: 0, flaky: 1, history: [1, 1, 0, 1, 1, 1, 1, 1, 1, 1] },
  { name: 'Billing', total: 44, pass: 42, fail: 0, flaky: 0, history: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
];
export const defects = [
  { id: 'DF-31', title: 'Emulator boot > 90s', severity: 'S1', status: 'open', owner: 'dp', env: 'Staging', pr: null, repro: 'Always' },
  { id: 'DF-32', title: 'Checkout heal loops', severity: 'S2', status: 'merged', owner: 'km', env: 'Staging', pr: '#208', repro: 'Sometimes' },
  { id: 'DF-29', title: 'Android back nav flake', severity: 'S3', status: 'fixing', owner: 'ag-test', env: 'Dev', pr: '#215', repro: 'Rare' },
  { id: 'DF-27', title: 'Selector drift on login', severity: 'S2', status: 'verified', owner: 'ag-dev', env: 'Staging', pr: '#204', repro: 'Always' },
] as const;

/* ---------------- automations ---------------- */

export const automations = [
  { id: 'au1', brand: 'op' as BrandId | null, name: 'Failed test → defect', trigger: 'Test failed', conditions: ['Suite is critical'], actions: ['Create defect', 'Attach evidence', 'Notify owner'], on: true, runs: 46, fails: 0, last: '12m', series: [3, 5, 2, 6, 4, 8, 5, 7, 6] },
  { id: 'au2', brand: null, name: 'Daily owner briefing', trigger: 'Every day 08:00', conditions: [], actions: ['AI briefing', 'Send in app + email'], on: true, runs: 30, fails: 1, last: '2h', series: [1, 1, 1, 1, 1, 1, 1, 1, 1] },
  { id: 'au3', brand: 'ma' as BrandId | null, name: 'PR merged → review', trigger: 'PR merged', conditions: ['Has linked task', 'No acceptance check'], actions: ['Move to Review', 'Request review'], on: true, runs: 21, fails: 0, last: '1d', series: [2, 1, 3, 2, 4, 2, 3, 1, 3] },
  { id: 'au4', brand: 'ax' as BrandId | null, name: 'Partner form → task', trigger: 'Form submitted', conditions: ['Brand is API Access'], actions: ['Create task', 'Assign Lea', 'Due +2d'], on: true, runs: 8, fails: 2, last: '2h', series: [0, 1, 1, 0, 2, 1, 1, 0, 2] },
  { id: 'au5', brand: null, name: 'Stale task nudge', trigger: 'No update 7d', conditions: ['Status not Done'], actions: ['Notify assignee', 'Label stale'], on: false, runs: 0, fails: 0, last: '—', series: [0, 0, 0, 0, 0, 0, 0, 0, 0] },
];

/* ---------------- integrations ---------------- */

export const integrations = [
  { id: 'gh', name: 'GitHub', status: 'connected', scope: '6 repos', owner: 'km', sync: '2m', brand: null as BrandId | null, events: 1284 },
  { id: 'gc', name: 'Google Calendar', status: 'connected', scope: '2 calendars', owner: 'km', sync: '1m', brand: null as BrandId | null, events: 312 },
  { id: 'tr', name: 'Test results', status: 'connected', scope: 'Optestra · JUnit', owner: 'km', sync: '12m', brand: 'op' as BrandId | null, events: 640 },
  { id: 'wh', name: 'Webhooks', status: 'warning', scope: '3 endpoints', owner: 'km', sync: '2h', brand: null as BrandId | null, events: 98 },
  { id: 'mcp', name: 'MCP server', status: 'connected', scope: '2 assistants', owner: 'km', sync: 'live', brand: null as BrandId | null, events: 57 },
  { id: 'csv', name: 'CSV import', status: 'idle', scope: 'Manual', owner: 'km', sync: '4d', brand: null as BrandId | null, events: 2 },
  { id: 'sl', name: 'Slack', status: 'off', scope: '—', owner: '—', sync: '—', brand: null as BrandId | null, events: 0 },
] as const;
export const apiTokens = [
  { id: 'tk1', name: 'CI pipeline', scopes: ['tests:write', 'tasks:read'], created: '12 Sep', last: '12m', prefix: 'pm_live_7f3a' },
  { id: 'tk2', name: 'Zapier', scopes: ['tasks:write'], created: '2 Aug', last: '9d', prefix: 'pm_live_c21e' },
];
export const webhookDeliveries = [
  { id: 'wd1', url: 'hooks.optestra.dev/pm', event: 'task.updated', code: 200, ms: 182, t: '2m' },
  { id: 'wd2', url: 'api.mailaccess.io/hook', event: 'release.approved', code: 500, ms: 3012, t: '2h' },
  { id: 'wd3', url: 'api.mailaccess.io/hook', event: 'release.approved', code: 500, ms: 3008, t: '2h' },
  { id: 'wd4', url: 'n8n.local/pm', event: 'defect.created', code: 200, ms: 94, t: '3h' },
];

/* ---------------- notifications & activity ---------------- */

export type Notice = { id: string; brand: BrandId | null; kind: 'mention' | 'review' | 'failure' | 'deadline' | 'approval' | 'spend' | 'assign'; text: string; time: string; read: boolean };
export const notifications: Notice[] = [
  { id: 'n1', brand: 'op', kind: 'review', text: 'Dev agent → PR #212 ready', time: '14m', read: false },
  { id: 'n2', brand: 'ma', kind: 'failure', text: 'Growth agent run failed', time: '22m', read: false },
  { id: 'n3', brand: 'op', kind: 'mention', text: 'Dev Patel mentioned you on OP-214', time: '1h', read: false },
  { id: 'n4', brand: 'ma', kind: 'deadline', text: 'MA-88 is 1 day overdue', time: '2h', read: true },
  { id: 'n5', brand: null, kind: 'spend', text: 'AI spend at 46% of cap', time: '3h', read: true },
  { id: 'n6', brand: 'ax', kind: 'failure', text: 'Webhook delivery failing (500)', time: '2h', read: false },
  { id: 'n7', brand: 'op', kind: 'approval', text: 'v1.4 go / no-go needs you Thu', time: '5h', read: true },
];

export type Activity = { id: string; brand: BrandId | null; actor: string; kind: 'human' | 'ai' | 'agent' | 'automation' | 'integration'; verb: string; target: string; from?: string; to?: string; time: string };
export const activity: Activity[] = [
  { id: 'a1', brand: 'op', actor: 'Dev agent', kind: 'agent', verb: 'opened', target: 'PR #212', time: '10:39' },
  { id: 'a2', brand: 'op', actor: 'Katriel', kind: 'human', verb: 'accepted', target: 'OP-208 deliverable', time: '10:05' },
  { id: 'a3', brand: 'op', actor: 'Failed test → defect', kind: 'automation', verb: 'created', target: 'DF-31', time: '09:52' },
  { id: 'a4', brand: 'ma', actor: 'GitHub', kind: 'integration', verb: 'linked', target: 'PR #341 → MA-88', time: '09:40' },
  { id: 'a5', brand: 'ma', actor: 'AI', kind: 'ai', verb: 'drafted', target: 'API v2 changelog', time: '09:31' },
  { id: 'a6', brand: 'op', actor: 'Dev Patel', kind: 'human', verb: 'changed status', target: 'OP-214', from: 'In progress', to: 'Blocked', time: '09:12' },
  { id: 'a7', brand: 'ax', actor: 'Lea Novak', kind: 'human', verb: 'moved', target: 'AX-79', from: 'In progress', to: 'Review', time: '08:58' },
  { id: 'a8', brand: null, actor: 'Daily briefing', kind: 'automation', verb: 'sent', target: 'Owner briefing', time: '08:00' },
];

/* ---------------- workload & time ---------------- */

export const workload = [
  { person: 'km', days: [5.5, 6.5, 5, 6, 3.5, 1, 0], avail: [6, 5, 6, 4, 6, 2, 0], brands: { op: 14.5, ma: 9, ax: 4 } as Record<BrandId, number> },
  { person: 'dp', days: [7, 7.5, 6, 7, 5, 0, 0], avail: [6.5, 6.5, 6.5, 6.5, 6, 0, 0], brands: { op: 32.5, ma: 0, ax: 0 } as Record<BrandId, number> },
  { person: 'ar', days: [3, 4, 2, 4, 3, 0, 0], avail: [4, 4, 4, 4, 4, 0, 0], brands: { op: 7, ma: 9, ax: 0 } as Record<BrandId, number> },
  { person: 'ln', days: [1, 2, 2, 1, 2, 0, 0], avail: [2, 2, 2, 2, 2, 0, 0], brands: { op: 0, ma: 0, ax: 8 } as Record<BrandId, number> },
];
export const timesheet = [
  { taskId: 'w18', days: [0, 50, 0, 0, 0, 0, 0], billable: true },
  { taskId: 'w22', days: [90, 0, 0, 0, 0, 0, 0], billable: true },
  { taskId: 'w2', days: [0, 55, 0, 0, 0, 0, 0], billable: false },
  { taskId: 'w17', days: [50, 0, 0, 0, 0, 0, 0], billable: false },
  { taskId: 'w28', days: [30, 0, 0, 0, 0, 0, 0], billable: true },
];

/* ---------------- reports ---------------- */

export const reports = {
  cycleTime: [4.2, 3.9, 4.6, 3.8, 3.5, 3.9, 3.2, 3.4, 3.1, 2.9, 3.3, 2.8], // days, 12 weeks
  created: [18, 22, 17, 25, 24, 21, 26, 23, 27, 25, 29, 31],
  completed: [18, 20, 17, 23, 26, 23, 23, 25, 27, 28, 27, 28],
  aging: [{ bucket: '<3d', n: 21 }, { bucket: '3–7d', n: 14 }, { bucket: '1–2w', n: 8 }, { bucket: '2–4w', n: 5 }, { bucket: '>4w', n: 3 }],
  timeInStatus: [{ s: 'To do', d: 2.1 }, { s: 'In progress', d: 1.6 }, { s: 'Review', d: 0.9 }, { s: 'Blocked', d: 2.8 }],
  plannedVsActual: [{ brand: 'op' as BrandId, planned: 146, actual: 92 }, { brand: 'ma' as BrandId, planned: 74, actual: 62 }, { brand: 'ax' as BrandId, planned: 70, actual: 28 }],
  deliverables: { accepted: 23, pending: 6, rejected: 2 },
  agentSuccess: [92, 88, 90, 86, 91, 89, 93, 87],
  aiCost: [1.2, 2.4, 1.8, 3.1, 2.6, 2.2, 3.4, 1.7], // last 8 days
};

/* ---------------- billing & usage ---------------- */

export const billing = {
  plan: 'Founder', price: 19, cycle: 'monthly', renews: '1 Nov', seats: 1, guests: 2,
  usage: [
    { label: 'AI spend', used: 18.4, cap: 40, unit: '$' },
    { label: 'Automation runs', used: 412, cap: 2000, unit: '' },
    { label: 'Agent runs', used: 114, cap: 300, unit: '' },
    { label: 'Storage', used: 3.2, cap: 10, unit: 'GB' },
  ],
  invoices: [{ id: 'INV-0009', date: '1 Oct', amount: 19, status: 'Paid' }, { id: 'INV-0008', date: '1 Sep', amount: 19, status: 'Paid' }, { id: 'INV-0007', date: '1 Aug', amount: 24.6, status: 'Paid' }],
};

/* ---------------- templates ---------------- */

export const templates = [
  { id: 'tp1', name: 'Software release', kind: 'Project', items: 24, uses: 6 },
  { id: 'tp2', name: 'Bug triage', kind: 'Workflow', items: 8, uses: 14 },
  { id: 'tp3', name: 'Security test', kind: 'Project', items: 16, uses: 2 },
  { id: 'tp4', name: 'Growth experiment', kind: 'Project', items: 10, uses: 4 },
  { id: 'tp5', name: 'Weekly review', kind: 'Doc', items: 1, uses: 20 },
  { id: 'tp6', name: 'Launch', kind: 'Project', items: 31, uses: 1 },
];

/* ---------------- helpers ---------------- */

export const healthLabel: Record<Health, string> = { on: 'On track', risk: 'At risk', off: 'Off track' };
export const fmtMin = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`);
export const dueLabel = (day?: number) => (day === undefined ? '—' : day === 6 ? 'Today' : day === 7 ? 'Tomorrow' : day < 6 ? `${6 - day}d late` : `${day} Oct`);
