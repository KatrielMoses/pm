/*
 * Route-local project metadata for the Projects, Project detail and Timeline pages: owner, span,
 * milestones, success criteria, risks, decisions, latest verified update and budgets. Days are
 * "day of October 2026" (0 = 30 Sep, 32 = 1 Nov). Deterministic.
 */

import { activity, personById, type Activity, type WorkItem } from '@/lib/app-data';
import { NOW, type Project } from '@/lib/data';

export type Milestone = { id: string; label: string; day: number };
export type Risk = { text: string; level: 'high' | 'med' | 'low'; owner: string };
export type ProjectMeta = {
  owner: string; start: number; deps: string[];
  milestones: Milestone[];
  criteria: { text: string; done: boolean }[];
  risks: Risk[];
  decisions: { text: string; when: string }[];
  questions: { text: string; owner: string }[];
  update: { text: string; by: string; when: string; verified: boolean; sources: string[] };
  budget: { money: number; spent: number; ai: number; aiSpent: number };
};

export const META: Record<string, ProjectMeta> = {
  p1: {
    owner: 'km', start: -16, deps: [],
    milestones: [{ id: 'm1', label: 'Scope freeze', day: 1 }, { id: 'm2', label: 'RC1', day: 7 }, { id: 'm3', label: 'GA', day: 8 }],
    criteria: [
      { text: '214 tests, ≥ 98% pass', done: false }, { text: 'Zero S1 defects open', done: false },
      { text: 'Heal review < 2 min', done: true }, { text: 'Release notes published', done: false },
    ],
    risks: [
      { text: 'Emulator boot timeout blocks Android', level: 'high', owner: 'dp' },
      { text: 'Retry logic PR not reviewed', level: 'med', owner: 'km' },
      { text: 'Flaky checkout suite', level: 'low', owner: 'ag-test' },
    ],
    decisions: [{ text: 'Ship web first, Android in v1.4.1', when: '2 Oct' }, { text: 'Cap retries at 3', when: '5 Oct' }],
    questions: [{ text: 'Hold GA if Android smoke < 90%?', owner: 'km' }, { text: 'Announce on HN or wait?', owner: 'km' }],
    update: { text: '206 / 214 tests green. Two blockers left, both on Android.', by: 'ag-test', when: '40m', verified: true, sources: ['CI #1882', 'PR #208'] },
    budget: { money: 600, spent: 410, ai: 25, aiSpent: 11.6 },
  },
  p2: {
    owner: 'dp', start: -9, deps: ['p1'],
    milestones: [{ id: 'm1', label: 'Pool PoC', day: 9 }, { id: 'm2', label: 'Beta', day: 16 }, { id: 'm3', label: 'Launch', day: 23 }],
    criteria: [{ text: '4 emulators in parallel', done: false }, { text: 'Boot < 40s p95', done: false }, { text: 'Smoke suite green', done: true }],
    risks: [{ text: 'API 36 image instability', level: 'med', owner: 'dp' }, { text: 'Runner cost > 1¢ / boot', level: 'low', owner: 'km' }],
    decisions: [{ text: 'Use API 36 images', when: '29 Sep' }],
    questions: [{ text: 'Support physical devices?', owner: 'km' }],
    update: { text: 'Pool runs 3 emulators; 4th fails on memory.', by: 'dp', when: '1d', verified: true, sources: ['Run #77'] },
    budget: { money: 800, spent: 380, ai: 15, aiSpent: 4.1 },
  },
  p3: {
    owner: 'km', start: 1, deps: ['p1'],
    milestones: [{ id: 'm1', label: 'Copy final', day: 12 }, { id: 'm2', label: 'Dodo live', day: 22 }, { id: 'm3', label: 'Launch', day: 30 }],
    criteria: [{ text: 'Credits page live', done: false }, { text: 'Top-ups via Dodo', done: false }, { text: 'Founder offer terms', done: false }],
    risks: [{ text: 'Dodo fee above Stripe', level: 'med', owner: 'km' }],
    decisions: [{ text: '1 credit = 1¢', when: '3 Oct' }, { text: 'Seatless plans', when: '3 Oct' }],
    questions: [{ text: 'Annual = 2 months free?', owner: 'km' }],
    update: { text: 'Plan matrix agreed; usage meter in review.', by: 'km', when: '2d', verified: false, sources: ['Pricing memo'] },
    budget: { money: 300, spent: 90, ai: 8, aiSpent: 1.2 },
  },
  p4: {
    owner: 'ag-docs', start: -12, deps: [],
    milestones: [{ id: 'm1', label: 'Search', day: 5 }, { id: 'm2', label: 'MCP guide', day: 10 }, { id: 'm3', label: 'Live', day: 12 }],
    criteria: [{ text: 'Search on every page', done: true }, { text: 'MCP setup guide', done: false }],
    risks: [{ text: 'Guide drifts from CLI flags', level: 'low', owner: 'ag-docs' }],
    decisions: [{ text: 'Docs in repo as Markdown', when: '20 Sep' }],
    questions: [],
    update: { text: 'Search shipped; MCP guide 50% drafted.', by: 'ag-docs', when: '3h', verified: true, sources: ['PR #241'] },
    budget: { money: 120, spent: 105, ai: 6, aiSpent: 3.8 },
  },
  p5: {
    owner: 'km', start: -20, deps: [],
    milestones: [{ id: 'm1', label: 'Beta', day: 2 }, { id: 'm2', label: 'v2.0', day: 9 }],
    criteria: [{ text: 'Cursor pagination', done: true }, { text: 'OAuth refresh', done: false }, { text: 'Signed webhooks', done: false }, { text: 'p95 < 200 ms', done: false }],
    risks: [
      { text: 'Rate-limit regression in prod', level: 'high', owner: 'km' },
      { text: '6h over plan', level: 'high', owner: 'km' },
      { text: 'OAuth blocked by MA-88', level: 'med', owner: 'km' },
    ],
    decisions: [{ text: 'Keep v1 alive 90 days', when: '24 Sep' }],
    questions: [{ text: 'Slip v2.0 to 16 Oct?', owner: 'km' }],
    update: { text: 'MA-88 fix in PR #341, CI failing on 2 tests.', by: 'km', when: '2h', verified: false, sources: ['PR #341'] },
    budget: { money: 500, spent: 560, ai: 10, aiSpent: 5.1 },
  },
  p6: {
    owner: 'km', start: -3, deps: ['p5'],
    milestones: [{ id: 'm1', label: 'Webhooks', day: 9 }, { id: 'm2', label: 'Launch', day: 19 }],
    criteria: [{ text: 'Mobile checkout', done: false }, { text: 'Webhook retries', done: false }, { text: '$5 founder Pro', done: true }],
    risks: [{ text: 'Upsell agent failing', level: 'med', owner: 'ag-growth' }],
    decisions: [{ text: 'Dodo as merchant of record', when: '15 Sep' }],
    questions: [{ text: 'Show annual first?', owner: 'ar' }],
    update: { text: 'Layout 50% done; retries next.', by: 'ar', when: '5h', verified: true, sources: ['Figma v12'] },
    budget: { money: 250, spent: 160, ai: 5, aiSpent: 1.8 },
  },
  p7: {
    owner: 'km', start: 0, deps: [],
    milestones: [{ id: 'm1', label: 'Report', day: 12 }, { id: 'm2', label: 'Done', day: 15 }],
    criteria: [{ text: 'SPF / DKIM on all domains', done: false }, { text: 'Bounce < 2%', done: false }],
    risks: [{ text: 'Bounce dashboard stale', level: 'med', owner: 'ar' }],
    decisions: [],
    questions: [{ text: 'Use dedicated IP?', owner: 'km' }],
    update: { text: 'Not started; due in 9 days.', by: 'km', when: '6d', verified: false, sources: [] },
    budget: { money: 200, spent: 40, ai: 4, aiSpent: 0.4 },
  },
  p8: {
    owner: 'ln', start: -6, deps: [],
    milestones: [{ id: 'm1', label: 'Pack QA', day: 6 }, { id: 'm2', label: 'r3.3', day: 16 }],
    criteria: [{ text: 'False positives < 3%', done: false }, { text: 'CVE-2026-4471 rule', done: false }, { text: 'Rule SOP current', done: true }],
    risks: [{ text: 'FP triage backlog', level: 'low', owner: 'ln' }],
    decisions: [{ text: 'Rules ship weekly', when: '28 Sep' }],
    questions: [],
    update: { text: 'Rule pack 3 merged, not verified.', by: 'ln', when: '1d', verified: true, sources: ['PR #77'] },
    budget: { money: 350, spent: 250, ai: 6, aiSpent: 1.9 },
  },
  p9: {
    owner: 'km', start: 5, deps: ['p8'],
    milestones: [{ id: 'm1', label: 'Auth spike', day: 9 }, { id: 'm2', label: 'Pilot', day: 26 }, { id: 'm3', label: 'Live', day: 37 }],
    criteria: [{ text: '5 signed pilots', done: false }, { text: 'Self-serve keys', done: false }],
    risks: [{ text: 'Only 2 pilots signed', level: 'med', owner: 'ln' }],
    decisions: [],
    questions: [{ text: 'Rev share or flat fee?', owner: 'km' }],
    update: { text: 'Auth spike scheduled Fri.', by: 'km', when: '4d', verified: false, sources: [] },
    budget: { money: 900, spent: 60, ai: 12, aiSpent: 0.3 },
  },
};

export const metaFor = (id: string) => META[id];
export const dueDay = (p: Project) => NOW.day + p.dueDays;
export const NOW_DAY = NOW.day + NOW.minutes / 1440;

export function dayLabel(d: number) {
  if (d <= 0) return `${30 + d} Sep`;
  if (d > 61) return `${d - 61} Dec`;
  if (d > 31) return `${d - 31} Nov`;
  return `${d} Oct`;
}
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** Oct 5 2026 is a Monday. */
export const weekday = (d: number) => WD[(((d - 5) % 7) + 7) % 7];
export const isWeekend = (d: number) => (((d - 5) % 7) + 7) % 7 >= 5;

/** Task bar span on a timeline: ends on its due day, length from the estimate. */
export function taskSpan(t: WorkItem) {
  if (t.due === undefined) return null;
  const len = Math.max(1, Math.min(6, Math.round(t.est / 45)));
  return { start: t.due - len + 1, end: t.due + 1 };
}

export function teamOf(tasks: WorkItem[]) {
  return [...new Set(tasks.map((t) => t.assignee))];
}

const verb: Record<WorkItem['status'], string> = {
  done: 'completed', review: 'sent for review', blocked: 'flagged blocked', doing: 'started', todo: 'planned', backlog: 'added',
};

export type FeedItem = { id: string; actor: string; kind: Activity['kind']; verb: string; target: string; to?: string; time: string };

/** Project activity: workspace events touching this project's tasks + one event per task. */
export function projectActivity(tasks: WorkItem[]): FeedItem[] {
  const keys = tasks.flatMap((t) => [t.key, t.pr].filter(Boolean) as string[]);
  const fromLog = activity
    .filter((a) => keys.some((k) => a.target.includes(k)))
    .map((a) => ({ id: a.id, actor: a.actor, kind: a.kind, verb: a.verb, target: a.target, to: a.to, time: a.time }));
  const rank = (u: string) => (u.endsWith('m') ? parseInt(u) : u.endsWith('h') ? parseInt(u) * 60 : parseInt(u) * 1440);
  const fromTasks = [...tasks]
    .sort((a, b) => rank(a.updated) - rank(b.updated))
    .map((t) => {
      const p = personById(t.assignee);
      return { id: 'f' + t.id, actor: p?.name ?? t.assignee, kind: (p?.kind === 'agent' ? 'agent' : 'human') as Activity['kind'], verb: verb[t.status], target: `${t.key} ${t.title}`, time: `${t.updated} ago` };
    });
  return [...fromLog, ...fromTasks];
}
