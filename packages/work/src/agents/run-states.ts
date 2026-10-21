import type { ExecState, WaitingReason } from '@pm/contracts';

/**
 * Phase 8C run states (AGT-010; ADR-0048 D2; 0B §5.5). The platform operation is the one authority
 * for where a run is; the run's display state is derived from it by this table and never stored
 * on its own. `accepted` is reserved for a real 8D human decision: nothing here produces it.
 */
export const RUN_STATES = [
  'queued',
  'running',
  'waiting',
  'failed',
  'cancelled',
  'ready_for_review',
] as const;
export type RunState = (typeof RUN_STATES)[number];

/** Why a run waits (shown in words; `paused` names who paused it). */
export type RunWaiting =
  | 'paused'
  | 'authorization_changed'
  | 'approval'
  | 'reconciliation_required'
  | 'rate_limit'
  | 'dependency_unavailable'
  | 'delay'
  | 'input';

/** The operation states and reasons each run state corresponds to. */
export const RUN_STATE_TABLE: ReadonlyArray<{
  op: ExecState;
  reason?: WaitingReason;
  run: RunState;
  waiting?: RunWaiting;
}> = [
  { op: 'queued', run: 'queued' },
  { op: 'running', run: 'running' },
  // Waiting for the agent's or the model's own answer is work in progress, not a block.
  { op: 'waiting', reason: 'external_confirmation', run: 'running' },
  {
    op: 'waiting',
    reason: 'authorization_changed',
    run: 'waiting',
    waiting: 'authorization_changed',
  },
  { op: 'waiting', reason: 'approval', run: 'waiting', waiting: 'approval' },
  {
    op: 'waiting',
    reason: 'reconciliation_required',
    run: 'waiting',
    waiting: 'reconciliation_required',
  },
  { op: 'waiting', reason: 'rate_limit', run: 'waiting', waiting: 'rate_limit' },
  {
    op: 'waiting',
    reason: 'dependency_unavailable',
    run: 'waiting',
    waiting: 'dependency_unavailable',
  },
  { op: 'waiting', reason: 'delay', run: 'waiting', waiting: 'delay' },
  { op: 'waiting', reason: 'input', run: 'waiting', waiting: 'input' },
  { op: 'paused', run: 'waiting', waiting: 'paused' },
  // A finished run is ready for a person's review; its task is not complete (0D §6).
  { op: 'succeeded', run: 'ready_for_review' },
  { op: 'partial', run: 'failed' },
  { op: 'failed', run: 'failed' },
  { op: 'skipped', run: 'failed' },
  { op: 'cancelled', run: 'cancelled' },
];

export function runStateOf(
  op: ExecState,
  reason: WaitingReason | null,
): { state: RunState; waiting: RunWaiting | null } {
  const row =
    RUN_STATE_TABLE.find((r) => r.op === op && r.reason !== undefined && r.reason === reason) ??
    RUN_STATE_TABLE.find((r) => r.op === op && r.reason === undefined) ??
    RUN_STATE_TABLE.find((r) => r.op === op);
  if (!row) return { state: 'failed', waiting: null };
  return { state: row.run, waiting: row.waiting ?? null };
}

export const TERMINAL_OPS: readonly ExecState[] = [
  'succeeded',
  'partial',
  'failed',
  'cancelled',
  'skipped',
];
export const isTerminalOp = (s: ExecState) => TERMINAL_OPS.includes(s);

/**
 * Run controls (AGT-009) and the operation states each may start from. Every control is decided
 * against current authority; none of them can produce `accepted`.
 */
export const RUN_CONTROLS = {
  pause: ['queued', 'running', 'waiting'],
  resume: ['paused', 'waiting'],
  cancel: ['queued', 'running', 'waiting', 'paused'],
  retry: ['failed', 'partial'],
} as const satisfies Record<string, readonly ExecState[]>;
export type RunControl = keyof typeof RUN_CONTROLS;
