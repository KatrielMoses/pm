/*
 * Inbox › Reviews data (copied from the old Agents page): the shared run queue (lib/data `runs`) enriched with the detail a run view
 * needs (step log, deliverable, diff, proposed changes). Two extra runs show the waiting and
 * accepted states. Deterministic; "now" is Tue 6 Oct 10:40.
 */

import { runs as baseRuns, type BrandId } from '@/lib/data';
import { proposedChanges, runSteps } from '@/lib/app-data';

export type RunState = 'queued' | 'running' | 'waiting' | 'review' | 'failed' | 'accepted' | 'changes' | 'rejected' | 'stopped';
export type StepKind = 'ok' | 'wait' | 'run' | 'fail';
export type Step = { t: string; label: string; kind: StepKind };
export type Change = { id: string; kind: 'create' | 'update' | 'link'; label: string; target: string };
export type DiffLine = { n: number; sign: '+' | '-' | ' '; code: string };

export type AgentRun = {
  id: string; brand: BrandId; agent: string; agentId: string; task: string; taskId: string; state: RunState;
  cost: number; mins: number; tokens: number; model: string; started: string; progress: number;
  steps: Step[]; changes: Change[];
  deliverable?: { kind: 'PR' | 'Doc' | 'Suite' | 'Notes' | 'Copy'; ref: string; ci?: 'pass' | 'fail' | 'running'; plus?: number; minus?: number; files?: number };
  diff?: { file: string; lines: DiffLine[] };
  error?: string;
};

const agentIdByName: Record<string, string> = { 'Dev agent': 'ag-dev', 'Test agent': 'ag-test', Research: 'ag-res', Docs: 'ag-docs', Growth: 'ag-growth' };
const modelById: Record<string, string> = { 'ag-dev': 'sonnet-5.5', 'ag-test': 'haiku-4.5', 'ag-res': 'sonnet-5.5', 'ag-docs': 'haiku-4.5', 'ag-growth': 'haiku-4.5' };

type Extra = Omit<AgentRun, 'id' | 'brand' | 'agent' | 'agentId' | 'task' | 'state' | 'cost' | 'mins' | 'model'>;

const extra: Record<string, Extra> = {
  r1: {
    taskId: 'w7', tokens: 48_200, started: '10:34', progress: 0.6,
    steps: [
      { t: '10:34', label: 'Read failing run #4471', kind: 'ok' },
      { t: '10:35', label: 'Located login selector', kind: 'ok' },
      { t: '10:37', label: 'Proposed heal · 2 steps', kind: 'ok' },
      { t: '10:40', label: 'Replaying suite', kind: 'run' },
    ],
    changes: [{ id: 'x1', kind: 'update', label: 'Selector #login → [data-test=login]', target: 'Login spec' }],
    deliverable: { kind: 'Suite', ref: 'Login · 12 tests', ci: 'running' },
  },
  r2: {
    taskId: 'w29', tokens: 21_900, started: '10:37', progress: 0.35,
    steps: [
      { t: '10:37', label: 'Fetched NVD record', kind: 'ok' },
      { t: '10:38', label: 'Read 3 advisories', kind: 'ok' },
      { t: '10:40', label: 'Drafting notes', kind: 'run' },
    ],
    changes: [],
    deliverable: { kind: 'Notes', ref: 'CVE-2026-4471.md' },
  },
  r3: {
    taskId: 'w1', tokens: 131_400, started: '10:26', progress: 1,
    steps: runSteps.map((s) => ({ ...s })),
    changes: proposedChanges.map((c) => ({ ...c })),
    deliverable: { kind: 'PR', ref: '#212', ci: 'pass', plus: 42, minus: 9, files: 3 },
    diff: {
      file: 'src/runner/retry.ts',
      lines: [
        { n: 18, sign: ' ', code: 'export async function withRetry(run: Run) {' },
        { n: 19, sign: '-', code: '  for (let i = 0; ; i++) {' },
        { n: 19, sign: '+', code: '  const key = run.idempotencyKey ?? newKey();' },
        { n: 20, sign: '+', code: '  for (let i = 0; i < MAX_RETRIES; i++) {' },
        { n: 21, sign: '+', code: '    const res = await send(run, { key });' },
        { n: 22, sign: ' ', code: '    if (res.ok) return res;' },
      ],
    },
  },
  r4: {
    taskId: 'w20', tokens: 36_800, started: '09:27', progress: 1,
    steps: [
      { t: '09:27', label: 'Read 14 merged PRs', kind: 'ok' },
      { t: '09:29', label: 'Grouped by endpoint', kind: 'ok' },
      { t: '09:31', label: 'Drafted changelog', kind: 'ok' },
      { t: '09:31', label: 'Awaiting review', kind: 'wait' },
    ],
    changes: [
      { id: 'y1', kind: 'create', label: 'Create doc "API v2 changelog"', target: 'Inbox API v2' },
      { id: 'y2', kind: 'link', label: 'Link 14 PRs', target: 'MA-91' },
    ],
    deliverable: { kind: 'Doc', ref: 'API v2 changelog' },
  },
  r5: {
    taskId: 'w9', tokens: 88_700, started: '09:58', progress: 1,
    steps: [
      { t: '09:58', label: 'Booted emulator · API 35', kind: 'ok' },
      { t: '10:01', label: 'Wrote 5 smoke tests', kind: 'ok' },
      { t: '10:07', label: 'Ran suite · 4 pass 1 flaky', kind: 'ok' },
      { t: '10:09', label: 'Awaiting review', kind: 'wait' },
    ],
    changes: [
      { id: 'z1', kind: 'create', label: 'Add suite "Android smoke"', target: 'Android runner' },
      { id: 'z2', kind: 'create', label: 'Create defect "Back nav flake"', target: 'v1.4 release' },
      { id: 'z3', kind: 'update', label: 'Status → Review', target: 'OP-195' },
    ],
    deliverable: { kind: 'Suite', ref: 'Android smoke · 5', ci: 'pass' },
  },
  r6: {
    taskId: 'w25', tokens: 6_100, started: '10:18', progress: 0.25,
    steps: [
      { t: '10:18', label: 'Read Pro pricing brief', kind: 'ok' },
      { t: '10:18', label: 'Brief marked stale', kind: 'fail' },
    ],
    changes: [],
    error: 'Source doc stale · 74d',
  },
  r7: {
    taskId: 'w32', tokens: 0, started: '—', progress: 0,
    steps: [{ t: '—', label: 'Waits for Dev agent slot', kind: 'wait' }],
    changes: [],
  },
};

const enriched: AgentRun[] = baseRuns.map((r) => {
  const agentId = agentIdByName[r.agent];
  return { ...r, agentId, model: modelById[agentId], state: r.state as RunState, ...extra[r.id] };
});

export const seedRuns: AgentRun[] = [
  ...enriched,
  {
    id: 'r8', brand: 'op', agent: 'Docs', agentId: 'ag-docs', task: 'MCP setup guide', taskId: 'w16', state: 'waiting', cost: 0.22, mins: 5,
    tokens: 18_300, model: 'haiku-4.5', started: '10:22', progress: 0.7,
    steps: [
      { t: '10:22', label: 'Read MCP spec', kind: 'ok' },
      { t: '10:25', label: 'Drafted 4 sections', kind: 'ok' },
      { t: '10:27', label: 'Needs approval · push to docs', kind: 'wait' },
    ],
    changes: [{ id: 'm1', kind: 'update', label: 'Publish to docs site', target: 'Docs site' }],
    deliverable: { kind: 'Doc', ref: 'MCP setup guide' },
  },
  {
    id: 'r9', brand: 'op', agent: 'Dev agent', agentId: 'ag-dev', task: 'Fix flaky checkout heal', taskId: 'w2', state: 'accepted', cost: 0.64, mins: 9,
    tokens: 74_000, model: 'sonnet-5.5', started: '08:51', progress: 1,
    steps: [
      { t: '08:51', label: 'Reproduced heal loop', kind: 'ok' },
      { t: '08:56', label: 'Edited heal.ts (+18 −6)', kind: 'ok' },
      { t: '08:59', label: 'Opened PR #208', kind: 'ok' },
      { t: '10:05', label: 'Accepted by Katriel', kind: 'ok' },
    ],
    changes: [],
    deliverable: { kind: 'PR', ref: '#208', ci: 'pass', plus: 18, minus: 6, files: 2 },
  },
];

export const STATE_META: Record<RunState, { label: string; tone: 'red' | 'green' | 'amber' | 'blue' | 'neutral' | 'accent' | 'outline' }> = {
  queued: { label: 'Queued', tone: 'outline' },
  running: { label: 'Running', tone: 'accent' },
  waiting: { label: 'Waiting', tone: 'amber' },
  review: { label: 'Ready for review', tone: 'blue' },
  failed: { label: 'Failed', tone: 'red' },
  accepted: { label: 'Accepted', tone: 'green' },
  changes: { label: 'Changes asked', tone: 'amber' },
  rejected: { label: 'Rejected', tone: 'red' },
  stopped: { label: 'Stopped', tone: 'neutral' },
};
