import { createHash, randomBytes } from 'node:crypto';
import { change, CommandContext } from '@pm/audit';
import {
  newTraceId,
  newUuidV7,
  plainFromRichText,
  type ExecState,
  type ExecutionContext,
  type WaitingReason,
} from '@pm/contracts';
import { sql, type WorkspaceTransaction } from '@pm/db';
import {
  cancelOpenEffects,
  CancelRequestedError,
  createOperation,
  defineEffectDestination,
  EffectNotSentError,
  EffectOutcomeUnknownError,
  enqueueJob,
  JobError,
  requestJobCancel,
  requestOperationCancel,
  transitionOperation,
  uncertainEffects,
  writeOutboxEvent,
  type InternalEvent,
  type JobHandlerContext,
  type JobResult,
} from '@pm/platform';
import {
  decideWorkspace,
  invalid,
  issue,
  TenancyError,
  type Caller,
  type Mutation,
  type Principal,
} from '@pm/tenancy';
import type { RichTextDoc } from '@pm/contracts/rich-text';
import { isPublic } from '../validation.ts';
import type { McpRpcRequest, McpRpcResponse } from '../integrations/mcp-access-service.ts';
import { MCP_PROTOCOL_VERSION } from '../integrations/mcp/registry.ts';
import { APPROVAL_ORDER, TOOL_CLASSES, type ScopeKind } from './config.ts';
import { dispatchRun } from './connectors.ts';
import {
  parseAck,
  parseArtifact,
  parseEvent,
  parseResult,
  parseToolCall,
  RUN_PROTOCOL_VERSION,
  sha256Hex,
  type ArtifactInput,
} from './run-protocol.ts';
import { isTerminalOp, runStateOf, RUN_CONTROLS, type RunControl } from './run-states.ts';
import { AgentService, type Grants, type ProfileRow, type ScopeItem } from './service.ts';
import { AGENT_PROTOCOL, AGENT_TOOLS, agentTool } from './tool-registry.ts';

/**
 * Phase 8C durable, bounded agent runs (AGT-009–013, AGT-022–026; ADR-0048; 0D PL-55). A run is
 * the detail of one `agent_run` operation on the existing platform: the job ledger executes it,
 * P8-W0 effects carry its dispatch, 7A carries an internal agent's model turn, and the 8B
 * assignment decision is called again before admission, every step, every tool call, every
 * credential, and every dispatch. Nothing here approves, accepts, or completes anything: a
 * finished run is ready for a person's review (8D decides).
 */
export const AGENT_RUN_QUEUE = 'agents';
export const AGENT_RUN_JOB = 'agents.run';
/** A dispatch hands work to an agent that may act on it: an unknown outcome is never re-sent. */
export const AGENT_RUN_DISPATCH_DESTINATION = defineEffectDestination(
  'agents.run_dispatch',
  'unsafe',
  'pm-agent-run.v1',
);
const RUN_JOB_ATTEMPTS = 3;
const RUN_JOB_TIMEOUT_SECONDS = 120;
const RUN_ACTION = 'agent.run_control';
/** Tools 8C can execute: the accepted R0 `read_records` class with minimum approval `none`. */
const EXECUTABLE_TOOLS = new Set(['pm.tasks.get', 'pm.tasks.list', 'pm.documents.get']);
const VIEW_TEXT_MAX = 4000;
const LIST_MAX = 25;
const NIL = '00000000-0000-0000-0000-000000000000';

type Tool = Grants['tools'][number];
type Ceiling = Pick<Grants, ScopeKind>;

export interface RunRow {
  id: string;
  workspace_id: string;
  brand_id: string;
  task_id: string;
  profile_id: string;
  assignment_id: string;
  assignment_revision_id: string;
  profile_revision_id: string;
  kind: 'internal' | 'external';
  instructions_hash: string;
  initiator_membership_id: string | null;
  initiator_kind: 'human' | 'automation';
  source_ref: string | null;
  assigner_membership_id: string;
  owner_membership_id: string;
  connector_id: string | null;
  connector_config_version: number | null;
  model_key: string | null;
  scope_brand_ids: string[];
  scope_project_ids: string[];
  scope_record_ids: string[];
  scope_integration_ids: string[];
  tools: Tool[];
  limits: { max_runtime_minutes: number; max_tool_calls: number; max_artifacts: number; cost_confirmed?: boolean };
  operation_id: string;
  current_operation_id: string;
  attempt_number: number;
  phase: 'start' | 'awaiting_model' | 'awaiting_agent' | 'finished';
  model_operation_id: string | null;
  deadline_at: Date | null;
  tool_calls_used: number;
  artifacts_used: number;
  output_bytes_used: number;
  events_used: number;
  event_seq: number;
  measured_cost_micros: number | null;
  reported_cost_micros: number | null;
  reported_cost_currency: string | null;
  pause_requested_at: Date | null;
  paused_by: 'human' | 'emergency_stop' | null;
  paused_by_membership_id: string | null;
  result_status: 'completed' | 'failed' | null;
  result_summary: string | null;
  ended_at: Date | null;
  created_at: Date;
  version: number;
  // Joined: the run's public id (its first operation) and the current operation.
  run_public_id: string;
  op_public_id: string;
  op_state: ExecState;
  op_waiting: WaitingReason | null;
  op_terminal: string | null;
  op_detail: Record<string, unknown> | null;
  op_cancel_requested: Date | null;
}

/** The caller an internal run step acts through (attribution only; authority is the assigner's). */
export interface AgentRunCaller extends Caller {
  agentRun?: { runId: string; runPublicId: string; operationId: string; attemptId?: string };
}

type LiveDecision = {
  ok: boolean;
  terminal: boolean;
  reasons: string[];
  ceiling: Ceiling;
  tools: Tool[];
};

type GuardOutcome =
  | { outcome: 'go'; kind: 'internal' | 'external'; phase: RunRow['phase']; deadline: string; attempt: number }
  | { outcome: 'finished'; status: 'completed' | 'failed' }
  | { outcome: 'paused' }
  | { outcome: 'authorization'; reasons: string[] }
  | { outcome: 'withdrawn' }
  | { outcome: 'deadline' }
  | { outcome: 'cancel' }
  | { outcome: 'stale' };

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex');
const set = (a: readonly string[]) => new Set(a);
const ceilingOf = (r: RunRow): Ceiling => ({
  brand: set(r.scope_brand_ids),
  project: set(r.scope_project_ids),
  record: set(r.scope_record_ids),
  integration: set(r.scope_integration_ids),
});
const rank = (x: string) => APPROVAL_ORDER.indexOf(x as (typeof APPROVAL_ORDER)[number]);

function newCredential() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(40);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  const token = `par_${out}`;
  return { token, prefix: token.slice(0, 12), hash: createHash('sha256').update(token).digest() };
}

/** A refusal decided inside a transaction whose records must still commit (raised afterwards). */
class Refusal {
  readonly err: TenancyError;
  constructor(err: TenancyError) {
    this.err = err;
  }
}
const refuse = (code: Parameters<typeof issue>[1], err: ConstructorParameters<typeof TenancyError>[0] = 'conflict', message = 'This run cannot continue now.') =>
  new Refusal(new TenancyError(err, { issues: [issue('/', code, message)] }));

function rpcOk(id: McpRpcRequest['id'], result: unknown): McpRpcResponse {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id: McpRpcRequest['id'], code: number, message: string): McpRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export class AgentRunService extends AgentService {
  // -------------------------------------------------------------------------------------------
  // Attribution: work done inside a run is the agent run's, on behalf of its assigner.
  // -------------------------------------------------------------------------------------------

  #runOf(caller: Caller): { runId: string; runPublicId: string; operationId: string; attemptId?: string } | null {
    const a = (caller as AgentRunCaller).agentRun;
    if (a) return a;
    const d = caller.delegation?.agentRun;
    return d ? { runId: d.runId, runPublicId: '', operationId: d.operationId } : null;
  }

  protected override exec(caller: Caller, p: Principal): ExecutionContext {
    const base = super.exec(caller, p);
    const r = this.#runOf(caller);
    if (!r) return base;
    const principal = { type: 'agent_run' as const, id: r.runId };
    return {
      ...base,
      authenticatedPrincipal: caller.delegation
        ? { type: 'agent_run', id: caller.delegation.tokenId }
        : principal,
      effectivePrincipal: principal,
      initiatingMembershipId: p.membershipId,
      delegationChain: [
        { type: 'member', id: p.membershipId },
        { type: 'agent_run', id: r.runId },
      ],
      operationId: r.operationId,
      ...(r.attemptId ? { attemptId: r.attemptId } : {}),
      causationId: r.operationId,
      dataClassLimit: 'C2',
    };
  }

  protected override cmd(caller: Caller, p: Principal, brandId: string | null = null) {
    const r = this.#runOf(caller);
    if (!r) return super.cmd(caller, p, brandId);
    return CommandContext.fromExecution(
      this.exec(caller, p),
      { kind: 'agent', ...(r.runPublicId ? { ref: r.runPublicId } : {}) },
      { brandId },
    );
  }

  #runCaller(run: RunRow, correlationId: string, attemptId?: string): AgentRunCaller {
    return {
      auth: {
        principal: 'account',
        account: {
          id: NIL,
          publicId: 'acc_00000000000000000000000000',
          email: 'agent@invalid',
          displayName: 'Agent',
          locale: 'en',
          timezone: 'UTC',
          emailVerified: true,
        },
        session: {
          id: run.id,
          publicId: 'ses_00000000000000000000000000',
          assurance: 'single_factor',
          authMethods: [],
          createdAt: new Date(),
          idleExpiresAt: new Date(),
          absoluteExpiresAt: new Date(),
          mfaVerifiedAt: null,
        },
      },
      meta: { correlationId },
      agentRun: {
        runId: run.id,
        runPublicId: run.run_public_id,
        operationId: run.current_operation_id,
        ...(attemptId ? { attemptId } : {}),
      },
    } as AgentRunCaller;
  }

  // -------------------------------------------------------------------------------------------
  // Run-bound credentials (0D §11): resolved before a workspace is known, like 6B tokens.
  // -------------------------------------------------------------------------------------------

  async authenticateAgentRunCredential(secret: string): Promise<{
    accountId: string;
    workspacePublicId: string;
    delegation: NonNullable<Caller['delegation']>;
  } | null> {
    if (!/^par_[A-Za-z0-9]{40}$/.test(secret)) return null;
    const prefix = secret.slice(0, 12);
    const hash = createHash('sha256').update(secret).digest();
    const row = await this.d.platform.withPlatform({ module: 'agents', readOnly: true }, async (tx) => {
      const res = await sql<{
        workspace_id: string;
        credential_id: string;
        run_id: string;
        operation_id: string;
        membership_id: string;
        account_id: string;
        workspace_public_id: string;
      }>`SELECT workspace_id, credential_id, run_id, operation_id, membership_id, account_id, workspace_public_id
           FROM agents.resolve_run_credential(${prefix}, ${hash})`.execute(tx.db);
      return res.rows[0] ?? null;
    });
    if (!row) return null;
    return {
      accountId: row.account_id,
      workspacePublicId: row.workspace_public_id,
      delegation: {
        tokenId: row.credential_id,
        tokenPublicId: prefix,
        kind: 'agent_run',
        principalType: 'agent_run',
        // A run credential carries no general scope: every call is decided against its one run.
        scopes: [],
        brandIds: null,
        membershipId: row.membership_id,
        accountId: row.account_id,
        sourceKind: 'api',
        agentRun: { credentialId: row.credential_id, runId: row.run_id, operationId: row.operation_id },
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------------------------

  async #run(
    tx: WorkspaceTransaction,
    w: { id?: string; publicId?: string; currentOperationId?: string; modelOperationId?: string },
    lock = false,
  ): Promise<RunRow | null> {
    let q = tx.db
      .selectFrom('agents.agent_run as r')
      .innerJoin('exec.operation as o', 'o.id', 'r.operation_id')
      .innerJoin('exec.operation as c', 'c.id', 'r.current_operation_id')
      .selectAll('r')
      .select([
        'o.public_id as run_public_id',
        'c.public_id as op_public_id',
        'c.execution_state as op_state',
        'c.waiting_reason as op_waiting',
        'c.terminal_reason as op_terminal',
        'c.outcome_detail as op_detail',
        'c.cancel_requested_at as op_cancel_requested',
      ]);
    if (w.id) q = q.where('r.id', '=', w.id);
    if (w.publicId) q = q.where('o.public_id', '=', w.publicId);
    if (w.currentOperationId) q = q.where('r.current_operation_id', '=', w.currentOperationId);
    if (w.modelOperationId) q = q.where('r.model_operation_id', '=', w.modelOperationId);
    if (lock) q = q.forUpdate('r');
    const r = await q.executeTakeFirst();
    if (!r) return null;
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return {
      ...(r as unknown as RunRow),
      tool_calls_used: Number(r.tool_calls_used),
      artifacts_used: Number(r.artifacts_used),
      output_bytes_used: Number(r.output_bytes_used),
      events_used: Number(r.events_used),
      event_seq: Number(r.event_seq),
      version: Number(r.version),
      measured_cost_micros: num(r.measured_cost_micros),
      reported_cost_micros: num(r.reported_cost_micros),
      tools: r.tools as Tool[],
      limits: r.limits as RunRow['limits'],
      op_detail: (r.op_detail as Record<string, unknown> | null) ?? null,
    };
  }

  /** The emergency stop's current state (the latest toggle). */
  async #stop(tx: WorkspaceTransaction): Promise<{ stopped: boolean; epoch: number; since: Date | null; by: string | null }> {
    const s = await tx.db
      .selectFrom('agents.emergency_stop')
      .select(['action', 'epoch', 'created_at', 'actor_membership_id'])
      .orderBy('epoch', 'desc')
      .limit(1)
      .executeTakeFirst();
    return s
      ? {
          stopped: s.action === 'stop',
          epoch: Number(s.epoch),
          since: s.action === 'stop' ? new Date(s.created_at as unknown as string) : null,
          by: s.action === 'stop' ? s.actor_membership_id : null,
        }
      : { stopped: false, epoch: 0, since: null, by: null };
  }

  // -------------------------------------------------------------------------------------------
  // The shared live guard (ADR-0048 D4): the 8B assignment decision again, intersected with what
  // the run was admitted with. A broader current profile or assignment never widens a run.
  // -------------------------------------------------------------------------------------------

  async #live(tx: WorkspaceTransaction, run: RunRow): Promise<LiveDecision> {
    const empty: Ceiling = { brand: new Set(), project: new Set(), record: new Set(), integration: new Set() };
    const a = await tx.db
      .selectFrom('agents.agent_assignment')
      .selectAll()
      .where('id', '=', run.assignment_id)
      .executeTakeFirst();
    if (!a || a.state !== 'assigned')
      return { ok: false, terminal: true, reasons: ['assignment_withdrawn'], ceiling: empty, tools: [] };
    const rev = await tx.db
      .selectFrom('agents.agent_assignment_revision')
      .selectAll()
      .where('id', '=', a.current_revision_id!)
      .executeTakeFirstOrThrow();
    const d = await this.agDecide(tx, { profile_id: a.profile_id, task_id: a.task_id }, rev);
    const pinned = ceilingOf(run);
    const ceiling: Ceiling = {
      brand: new Set([...d.live.brand].filter((x) => pinned.brand.has(x))),
      project: new Set([...d.live.project].filter((x) => pinned.project.has(x))),
      record: new Set([...d.live.record].filter((x) => pinned.record.has(x))),
      integration: new Set([...d.live.integration].filter((x) => pinned.integration.has(x))),
    };
    const tools = run.tools.flatMap((t) => {
      const c = d.tools.find((x) => x.tool === t.tool && x.version === t.version);
      if (!c) return [];
      return [{ ...t, approval_class: rank(c.approval_class) > rank(t.approval_class) ? c.approval_class : t.approval_class }];
    });
    const reasons = new Set(d.reasons);
    const [task] = await this.agItemsOf(tx, { brand: new Set(), project: new Set(), record: new Set([run.task_id]), integration: new Set() });
    if (!task || !(await this.agWithin(tx, task, ceiling))) reasons.add('scope_lost');
    if (run.kind === 'external') {
      const c = run.connector_id
        ? await tx.db.selectFrom('agents.agent_connector').selectAll().where('id', '=', run.connector_id).executeTakeFirst()
        : null;
      if (!c || c.state === 'revoked' || c.config_version !== run.connector_config_version)
        reasons.add('connector_changed');
    }
    return { ok: reasons.size === 0, terminal: false, reasons: [...reasons], ceiling, tools };
  }

  async #revokeCredentials(tx: WorkspaceTransaction, runId: string, reason: string) {
    await tx.db
      .updateTable('agents.agent_run_credential')
      .set({ state: 'revoked', revoked_reason: reason, revoked_at: new Date() })
      .where('run_id', '=', runId)
      .where('state', '=', 'active')
      .execute();
  }

  async #cancelQueuedJobs(tx: WorkspaceTransaction, operationId: string) {
    const jobs = await tx.db
      .selectFrom('exec.job')
      .select('id')
      .where('operation_id', '=', operationId)
      .where('state', 'in', ['queued', 'retry_scheduled'])
      .execute();
    for (const j of jobs) await requestJobCancel(tx, j.id);
  }

  async #event(
    tx: WorkspaceTransaction,
    run: RunRow,
    e: { kind: string; source: 'agent' | 'system' | 'human'; text: string | null; data?: Record<string, unknown>; key?: string },
  ): Promise<{ seq: number; duplicate: boolean }> {
    if (e.key) {
      const prior = await tx.db
        .selectFrom('agents.agent_run_event')
        .select('seq')
        .where('run_id', '=', run.id)
        .where('source_key', '=', e.key)
        .executeTakeFirst();
      if (prior) return { seq: Number(prior.seq), duplicate: true };
    }
    const next = await tx.db
      .updateTable('agents.agent_run')
      .set({
        event_seq: sql`event_seq + 1`,
        events_used: e.source === 'agent' ? sql`events_used + 1` : sql`events_used`,
        updated_at: new Date(),
      })
      .where('id', '=', run.id)
      .returning('event_seq')
      .executeTakeFirstOrThrow();
    const seq = Number(next.event_seq);
    await tx.db
      .insertInto('agents.agent_run_event')
      .values({
        id: newUuidV7(),
        workspace_id: tx.workspaceId,
        run_id: run.id,
        operation_id: run.current_operation_id,
        seq,
        kind: e.kind,
        source: e.source,
        source_key: e.key ?? null,
        text: e.text === null ? null : e.text.slice(0, 2000),
        data: JSON.stringify(e.data ?? {}),
      })
      .execute();
    return { seq, duplicate: false };
  }

  #context(run: RunRow, correlationId?: string): ExecutionContext {
    const principal = { type: 'agent_run' as const, id: run.id };
    return {
      workspaceId: run.workspace_id,
      correlationId: correlationId && /^[0-9a-f]{32}$/.test(correlationId) ? correlationId : newTraceId(),
      authenticatedPrincipal:
        run.initiator_kind === 'human' && run.initiator_membership_id
          ? { type: 'member', id: run.initiator_membership_id }
          : { type: 'automation', id: run.source_ref ?? run.id },
      effectivePrincipal: principal,
      initiatingMembershipId: run.assigner_membership_id,
      delegationChain: [
        { type: 'member', id: run.assigner_membership_id },
        { type: 'agent_profile', id: run.profile_id },
        { type: 'agent_run', id: run.id },
      ],
      epochs: { workspace: 0, principal: 0 },
      selectedScope: {
        brand_ids: run.scope_brand_ids,
        project_ids: run.scope_project_ids,
        record_ids: run.scope_record_ids,
      },
      risk: { actionKey: RUN_ACTION, riskClass: 'R2' },
      dataClassLimit: 'C2',
      operationId: run.current_operation_id,
    };
  }

  /**
   * Closes the current operation now (a result, a cancel, a refusal) and settles the run once:
   * credentials revoked, queued jobs cancelled, the run ended, the agent's events written.
   */
  async #close(
    tx: WorkspaceTransaction,
    run: RunRow,
    to: 'succeeded' | 'failed' | 'cancelled',
    terminalReason: 'error' | 'user_cancelled' | 'policy_rejected' | 'limit_exceeded' | 'emergency_stop' | null,
    detail: Record<string, unknown>,
  ) {
    await this.#cancelQueuedJobs(tx, run.current_operation_id);
    await transitionOperation(tx, {
      operationId: run.current_operation_id,
      to,
      ...(terminalReason ? { terminalReason } : {}),
      outcomeDetail: detail,
      actor: { type: 'agent', id: run.id, onBehalfOfMembershipId: run.assigner_membership_id },
      context: this.#context(run),
    });
    await this.#settle(tx, run.id, to, terminalReason);
  }

  /**
   * Exactly-once settlement when the run's current operation ends (here or in the consumer):
   * the run is ended, its credentials revoked, and its outcome published once.
   */
  async #settle(tx: WorkspaceTransaction, runId: string, state: ExecState, terminalReason: string | null) {
    const run = await this.#run(tx, { id: runId }, true);
    if (!run || run.ended_at) return;
    await tx.db
      .updateTable('agents.agent_run')
      .set({ ended_at: new Date(), phase: 'finished', updated_at: new Date(), version: sql`version + 1` })
      .where('id', '=', run.id)
      .execute();
    await this.#revokeCredentials(tx, run.id, state === 'succeeded' ? 'run_finished' : 'run_closed');
    // An automation-invoked run's outcome is caused by that automation run (8A loop guard).
    const parent =
      run.initiator_kind === 'automation' && run.source_ref
        ? await tx.db
            .selectFrom('automation.automation_run')
            .select('current_operation_id')
            .where('id', '=', run.source_ref)
            .executeTakeFirst()
        : undefined;
    const context = { ...this.#context(run), ...(parent ? { causationId: parent.current_operation_id } : {}) };
    const outcome = state === 'succeeded' ? 'ready_for_review' : state;
    await this.#event(tx, run, {
      kind: 'state',
      source: 'system',
      text: state === 'succeeded' ? 'Ready for review.' : `Run ${outcome.replace('_', ' ')}.`,
      data: { state: outcome, terminal_reason: terminalReason },
    });
    if (state === 'succeeded') {
      const artifacts = await tx.db
        .selectFrom('agents.agent_artifact')
        .select((eb) => eb.fn.count<string>('artifact_key').distinct().as('n'))
        .where('run_id', '=', run.id)
        .executeTakeFirstOrThrow();
      await writeOutboxEvent(tx, {
        type: 'agents.agent_run.output_returned',
        aggregate: { type: 'agents.agent_run', id: run.id, sequence: run.attempt_number },
        data: { run_id: run.id, task_id: run.task_id, artifact_count: Number(artifacts.n), deliverable_version_id: null },
        actor: { type: 'agent', id: run.id, onBehalfOfMembershipId: run.assigner_membership_id },
        context,
        operationId: run.current_operation_id,
        brandId: run.brand_id,
      });
    } else if (state === 'failed' || state === 'partial') {
      await writeOutboxEvent(tx, {
        type: 'agents.agent_run.failed',
        aggregate: { type: 'agents.agent_run', id: run.id, sequence: run.attempt_number },
        data: { run_id: run.id, task_id: run.task_id, terminal_reason: terminalReason ?? 'error' },
        actor: { type: 'agent', id: run.id, onBehalfOfMembershipId: run.assigner_membership_id },
        context,
        operationId: run.current_operation_id,
        brandId: run.brand_id,
      });
    }
    this.d.metrics.count('agent.runs', 1, { outcome });
  }

  /** A run that lost its authority waits for a person; credentials stop working at once. */
  async #holdForAuthority(tx: WorkspaceTransaction, run: RunRow, reasons: string[]) {
    await this.#revokeCredentials(tx, run.id, 'authorization_changed');
    if (run.op_state === 'waiting' && run.op_waiting === 'external_confirmation') {
      await this.#cancelQueuedJobs(tx, run.current_operation_id);
      await transitionOperation(tx, {
        operationId: run.current_operation_id,
        to: 'waiting',
        waitingReason: 'authorization_changed',
        outcomeDetail: { reasons },
        actor: { type: 'system' },
        context: this.#context(run),
      });
      await this.#event(tx, run, {
        kind: 'state',
        source: 'system',
        text: 'Waiting: the authority this run depends on changed.',
        data: { state: 'waiting', reasons: reasons.filter((r) => !r.startsWith('model_')) },
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Admission (AGT-009, AGT-023): one open run per task and agent, pinned at admission.
  // -------------------------------------------------------------------------------------------

  #tokenScope(caller: Caller) {
    if (caller.delegation && !caller.delegation.scopes.includes('agents:execute'))
      throw new TenancyError('forbidden');
    if (caller.delegation?.principalType === 'agent_run') throw new TenancyError('not_found');
  }

  /** What a run would be admitted with now: scope, tools, limits, readiness (no side effect). */
  async previewAgentRun(caller: Caller, ws: unknown, tsk: unknown, agt: unknown) {
    this.#tokenScope(caller);
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const t = await this.loadTask(tx, p, tsk);
      this.requireTaskAction(p, 'agent.assign', t, { shares: false, excluded: 'forbidden' });
      const profile = isPublic(agt, 'agt') ? await this.agRows(tx, { publicId: agt as string }) : null;
      if (!profile || profile.lifecycle_state !== 'active') throw new TenancyError('not_found');
      const e = await this.agentAssignmentEligibility(tx, t.publicId, profile.public_id);
      if (e.reasons.includes('not_found') || e.reasons.includes('not_assigned'))
        throw new TenancyError('not_found');
      const refusals = await this.#admissionRefusals(tx, p, profile, e);
      const ceiling: Ceiling = e.ceiling
        ? {
            brand: set(e.ceiling.brand),
            project: set(e.ceiling.project),
            record: set(e.ceiling.record),
            integration: set(e.ceiling.integration),
          }
        : { brand: new Set(), project: new Set(), record: new Set(), integration: new Set() };
      const rev = profile.active_revision_id ? await this.agRevision(tx, profile.active_revision_id) : null;
      return {
        type: 'agent_run_preview' as const,
        profile: { id: profile.public_id, name: profile.name, kind: profile.kind },
        scope: await this.agScopeView(tx, p, ceiling),
        tools: e.tools.map((x) => this.#toolView(x)),
        limits: (rev?.config as { limits?: Record<string, number> } | undefined)?.limits ?? {},
        costs: {
          measured: profile.kind === 'internal' ? 'Model usage is measured by the AI gateway within its budget.' : null,
          reported:
            profile.kind === 'external'
              ? `Any cost is reported by ${profile.name} and shown as reported, never as measured.`
              : null,
        },
        refusals,
        can_start: refusals.length === 0,
      };
    });
  }

  #toolView(t: Tool) {
    const executable = t.tool_class === 'read_records' && t.approval_class === 'none' && EXECUTABLE_TOOLS.has(t.tool);
    return {
      name: t.tool,
      version: t.version,
      tool_class: t.tool_class,
      approval_class: t.approval_class,
      // 8D owns per-action approval: until then only R0 reads run; anything else waits there.
      mode: executable ? ('runs' as const) : ('approval_required' as const),
    };
  }

  async #admissionRefusals(
    tx: WorkspaceTransaction,
    p: Principal,
    profile: ProfileRow,
    e: Awaited<ReturnType<AgentService['agentAssignmentEligibility']>>,
  ): Promise<Array<{ pointer: string; code: string; message: string }>> {
    const out: Array<{ pointer: string; code: string; message: string }> = [];
    const stop = await this.#stop(tx);
    if (stop.stopped)
      out.push({ pointer: '/', code: 'emergency_stop', message: 'All agent runs are stopped in this workspace.' });
    if (!e.eligible)
      for (const r of e.reasons)
        out.push({
          pointer: '/',
          code: this.agCanConfigure(p) || ['assigner_authority', 'assigner_unavailable', 'task_ineligible', 'scope_lost'].includes(r) ? r : 'agent_not_ready',
          message: 'The assignment is not ready to run.',
        });
    if (e.eligible && !e.tools.length)
      out.push({ pointer: '/tools', code: 'no_tools', message: 'This agent has no tools it may use here.' });
    if (profile.kind === 'external') {
      if (this.agentDeps.transport !== 'fixture')
        out.push({
          pointer: '/connector',
          code: 'connector_transport_unavailable',
          message: 'Agent connections are not available in this environment (live connectors need approved credentials).',
        });
      if (!this.agentDeps.productOrigin)
        out.push({ pointer: '/connector', code: 'callback_unavailable', message: 'The product address for agent callbacks is not configured.' });
    }
    return [...new Map(out.map((x) => [x.code, x])).values()];
  }

  override async startAgentRun(caller: Caller, ws: unknown, tsk: unknown, agt: unknown, body?: unknown, req?: Mutation) {
    this.#tokenScope(caller);
    const b = isObj(body) ? body : {};
    for (const k of Object.keys(b))
      if (k !== 'confirm') throw invalid(issue(`/${k}`, 'unknown_field', 'This field is not accepted.'));
    if (b.confirm !== undefined && typeof b.confirm !== 'boolean')
      throw invalid(issue('/confirm', 'invalid_type', 'Confirm with true or false.'));
    if (!req) throw new TenancyError('validation_failed');
    return this.mutate(
      caller,
      'agent.run',
      ws,
      req,
      async (tx, p) => {
        const t = await this.loadTask(tx, p, tsk, { lock: true });
        this.requireTaskAction(p, 'agent.assign', t, { shares: false, excluded: 'forbidden' });
        this.requireTaskActive(t);
        const run = await this.admitAgentRun(tx, p, {
          taskPublicId: t.publicId,
          profilePublicId: agt,
          initiator: { kind: 'human', membershipId: p.membershipId },
          requestKey: `h:${p.membershipId}:${req.idempotencyKey ?? newUuidV7()}`,
          correlationId: caller.meta.correlationId,
          // The person starting the run confirms its possible model cost (ST-62); never inferred.
          costConfirmed: b.confirm === true,
        });
        return {
          status: 202,
          ref: { id: run.run_public_id, type: 'agent_run' },
          data: await this.#runView(tx, p, run),
        };
      },
      async (tx, p, ref) => this.#renderRun(tx, p, ref.id),
    );
  }

  /**
   * The one admission boundary (people and 8A automations): eligibility now, the emergency stop,
   * readiness, a workspace concurrency reservation under a lock, and one open run per task and
   * agent (database constraint). Pins the assignment and profile revisions, the instructions
   * hash, the live ceiling, the tools, the limits, and the connector or model.
   */
  protected async admitAgentRun(
    tx: WorkspaceTransaction,
    p: Principal,
    input: {
      taskPublicId: string;
      profilePublicId: unknown;
      initiator: { kind: 'human'; membershipId: string } | { kind: 'automation'; sourceRef: string; causationId?: string };
      requestKey: string;
      correlationId: string;
      costConfirmed?: boolean;
    },
  ): Promise<RunRow> {
    const prior = await tx.db
      .selectFrom('agents.agent_run')
      .select('id')
      .where('request_key', '=', input.requestKey)
      .executeTakeFirst();
    if (prior) return (await this.#run(tx, { id: prior.id }))!;
    const profile = isPublic(input.profilePublicId, 'agt')
      ? await this.agRows(tx, { publicId: input.profilePublicId as string })
      : null;
    if (!profile || profile.lifecycle_state !== 'active') throw new TenancyError('not_found');
    const e = await this.agentAssignmentEligibility(tx, input.taskPublicId, profile.public_id);
    if (e.reasons.includes('not_found') || e.reasons.includes('not_assigned')) throw new TenancyError('not_found');
    const refusals = await this.#admissionRefusals(tx, p, profile, e);
    if (refusals.length)
      throw new TenancyError(
        refusals.some((r) => r.code === 'connector_transport_unavailable' || r.code === 'callback_unavailable')
          ? 'dependency_unavailable'
          : 'conflict',
        { issues: refusals.map((r) => issue(r.pointer, r.code, r.message)) },
      );
    const task = await tx.db
      .selectFrom('work.task as t')
      .innerJoin('core.record as r', 'r.id', 't.id')
      .select(['t.id', 't.brand_id'])
      .where('r.public_id', '=', input.taskPublicId)
      .executeTakeFirstOrThrow();
    const assignment = await tx.db
      .selectFrom('agents.agent_assignment')
      .selectAll()
      .where('task_id', '=', task.id)
      .where('profile_id', '=', profile.id)
      .where('state', '=', 'assigned')
      .executeTakeFirstOrThrow();
    const rev = await tx.db
      .selectFrom('agents.agent_assignment_revision')
      .selectAll()
      .where('id', '=', assignment.current_revision_id!)
      .executeTakeFirstOrThrow();
    const profileRev = await this.agRevision(tx, profile.active_revision_id!);
    const config = profileRev.config as { instructions?: string; limits?: RunRow['limits'] };
    // One concurrency reservation per workspace at a time (a count alone would race).
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'agents.runs:' + tx.workspaceId}, 0))`.execute(tx.db);
    const open = await tx.db
      .selectFrom('agents.agent_run')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('ended_at', 'is', null)
      .executeTakeFirstOrThrow();
    const sameTask = await tx.db
      .selectFrom('agents.agent_run as r')
      .innerJoin('exec.operation as o', 'o.id', 'r.operation_id')
      .select(['r.id', 'o.public_id'])
      .where('r.task_id', '=', task.id)
      .where('r.profile_id', '=', profile.id)
      .where('r.ended_at', 'is', null)
      .executeTakeFirst();
    if (sameTask)
      throw new TenancyError('conflict', {
        issues: [issue('/', 'run_in_progress', 'A run for this task is already in progress.')],
      });
    if (Number(open.n) >= this.ws.agentRunsActiveMax)
      throw new TenancyError('conflict', {
        issues: [issue('/', 'limit_reached', `At most ${this.ws.agentRunsActiveMax} agent runs can be open at once here.`)],
      });
    const connector = profile.kind === 'external' ? await this.agConnector(tx, profile.id) : null;
    const runId = newUuidV7();
    const limits = {
      max_runtime_minutes: config.limits?.max_runtime_minutes ?? 60,
      max_tool_calls: config.limits?.max_tool_calls ?? 100,
      max_artifacts: config.limits?.max_artifacts ?? 10,
      cost_confirmed: input.costConfirmed === true,
    };
    const stop = await this.#stop(tx);
    const human = input.initiator.kind === 'human';
    const principal = { type: 'agent_run' as const, id: runId };
    const context: ExecutionContext = {
      workspaceId: tx.workspaceId,
      correlationId: /^[0-9a-f]{32}$/.test(input.correlationId) ? input.correlationId : newTraceId(),
      authenticatedPrincipal:
        input.initiator.kind === 'human'
          ? { type: 'member', id: input.initiator.membershipId }
          : { type: 'automation', id: input.initiator.sourceRef },
      effectivePrincipal: principal,
      initiatingMembershipId: rev.assigner_membership_id,
      delegationChain: [
        { type: 'member', id: rev.assigner_membership_id },
        { type: 'agent_profile', id: profile.id },
        { type: 'agent_run', id: runId },
      ],
      ...(input.initiator.kind === 'automation' && input.initiator.causationId
        ? { causationId: input.initiator.causationId }
        : {}),
      epochs: { workspace: p.epochs.workspace, principal: p.epochs.principal, agentClass: stop.epoch },
      selectedScope: {
        brand_ids: e.ceiling!.brand,
        project_ids: e.ceiling!.project,
        record_ids: e.ceiling!.record,
      },
      risk: { actionKey: RUN_ACTION, riskClass: 'R2' },
      dataClassLimit: 'C2',
    };
    const op = await createOperation(tx, {
      kind: 'agent_run',
      context,
      initiatedBy:
        input.initiator.kind === 'human'
          ? { type: 'human', id: input.initiator.membershipId }
          : { type: 'automation', id: input.initiator.sourceRef, onBehalfOfMembershipId: rev.assigner_membership_id },
    });
    await tx.db
      .insertInto('agents.agent_run')
      .values({
        id: runId,
        workspace_id: tx.workspaceId,
        brand_id: task.brand_id,
        task_id: task.id,
        profile_id: profile.id,
        assignment_id: assignment.id,
        assignment_revision_id: rev.id,
        profile_revision_id: profileRev.id,
        kind: profile.kind,
        instructions_hash: sha256Hex(config.instructions ?? ''),
        initiator_membership_id: input.initiator.kind === 'human' ? input.initiator.membershipId : null,
        initiator_kind: input.initiator.kind,
        source_ref: input.initiator.kind === 'automation' ? input.initiator.sourceRef : null,
        assigner_membership_id: rev.assigner_membership_id,
        owner_membership_id: profile.owner_membership_id,
        connector_id: connector?.id ?? null,
        connector_config_version: connector?.config_version ?? null,
        model_key: profile.kind === 'internal' ? profileRev.model_key : null,
        scope_brand_ids: e.ceiling!.brand,
        scope_project_ids: e.ceiling!.project,
        scope_record_ids: e.ceiling!.record,
        scope_integration_ids: e.ceiling!.integration,
        tools: JSON.stringify(e.tools),
        limits: JSON.stringify(limits),
        operation_id: op.id,
        current_operation_id: op.id,
        request_key: input.requestKey,
        deadline_at: new Date(Date.now() + limits.max_runtime_minutes * 60_000),
      })
      .execute();
    await enqueueJob(tx, {
      queue: AGENT_RUN_QUEUE,
      kind: AGENT_RUN_JOB,
      context,
      operationId: op.id,
      payloadRef: runId,
      maxAttempts: RUN_JOB_ATTEMPTS,
      timeoutSeconds: RUN_JOB_TIMEOUT_SECONDS,
    });
    await writeOutboxEvent(tx, {
      type: 'execution.operation.state_changed',
      aggregate: { type: 'execution.operation', id: op.id, sequence: 0 },
      data: { kind: 'agent_run', state: 'queued', terminal_reason: null, waiting_reason: null },
      actor: human ? { type: 'human', id: (input.initiator as { membershipId: string }).membershipId } : { type: 'system' },
      context,
      operationId: op.id,
    });
    const run = (await this.#run(tx, { id: runId }, true))!;
    await this.#event(tx, run, { kind: 'state', source: human ? 'human' : 'system', text: 'Queued.', data: { state: 'queued' } });
    await this.workAudit(
      tx,
      this.#runCaller(run, context.correlationId),
      p,
      'agent.run_started',
      { recordId: task.id, type: 'task', publicId: input.taskPublicId },
      [change.plain('agent', null, profile.public_id)],
      task.brand_id,
    );
    this.d.metrics.count('agent.runs', 1, { outcome: 'admitted' });
    return run;
  }

  // -------------------------------------------------------------------------------------------
  // Reading runs (task readers; current authority on every read, hidden scope omitted)
  // -------------------------------------------------------------------------------------------

  async #readable(tx: WorkspaceTransaction, p: Principal, run: RunRow) {
    const taskPublic = (await this.publicOf(tx, run.task_id))!;
    const t = await this.loadTask(tx, p, taskPublic);
    return { t, taskPublic };
  }

  async #renderRun(tx: WorkspaceTransaction, p: Principal, runPublic: string) {
    const run = await this.#run(tx, { publicId: runPublic });
    if (!run) throw new TenancyError('not_found');
    await this.#readable(tx, p, run);
    return this.#runView(tx, p, run);
  }

  async #runView(tx: WorkspaceTransaction, p: Principal, run: RunRow) {
    const { t, taskPublic } = await this.#readable(tx, p, run);
    const profile = (await this.agRows(tx, { id: run.profile_id }))!;
    const s = runStateOf(run.op_state, run.op_waiting);
    const canConfigure = this.agCanConfigure(p);
    let control = false;
    try {
      this.requireTaskAction(p, RUN_ACTION, t, { shares: false, excluded: 'forbidden' });
      control = true;
    } catch {
      control = false;
    }
    const artifacts = await tx.db
      .selectFrom('agents.agent_artifact')
      .select(['artifact_key', 'version_number', 'title', 'media_type', 'byte_size', 'sha256', 'producer', 'created_at'])
      .where('run_id', '=', run.id)
      .orderBy('artifact_key')
      .orderBy('version_number', 'desc')
      .execute();
    const latest = new Map<string, (typeof artifacts)[number]>();
    for (const a of artifacts) if (!latest.has(a.artifact_key)) latest.set(a.artifact_key, a);
    const calls = await tx.db
      .selectFrom('agents.agent_tool_call')
      .select(['sequence', 'tool', 'tool_version', 'tool_class', 'decision', 'code', 'duration_ms', 'created_at'])
      .where('run_id', '=', run.id)
      .orderBy('sequence', 'desc')
      .limit(50)
      .execute();
    const detail = run.op_detail ?? {};
    const lastJob =
      s.state === 'failed'
        ? await tx.db
            .selectFrom('exec.job')
            .select('last_error')
            .where('operation_id', '=', run.current_operation_id)
            .orderBy('created_at', 'desc')
            .limit(1)
            .executeTakeFirst()
        : null;
    const jobCode = (lastJob?.last_error as { code?: string } | null | undefined)?.code ?? null;
    return {
      id: run.run_public_id,
      type: 'agent_run' as const,
      task: { id: taskPublic },
      profile: { id: profile.public_id, name: profile.name, kind: profile.kind },
      state: s.state,
      waiting: s.waiting,
      paused_by: s.waiting === 'paused' ? run.paused_by : null,
      // 8D owns review and acceptance: a ready run is never accepted here.
      review: s.state === 'ready_for_review' ? { required: true, owner: '8D' } : null,
      attempt: run.attempt_number,
      failure:
        s.state === 'failed' || s.state === 'cancelled'
          ? {
              terminal_reason: run.op_terminal,
              code: typeof detail.code === 'string' ? detail.code : typeof detail.reason === 'string' ? detail.reason : jobCode,
              liability: isObj(detail.effect_liability) ? detail.effect_liability : null,
            }
          : null,
      waiting_reasons:
        s.waiting === 'authorization_changed' && Array.isArray(detail.reasons)
          ? (detail.reasons as string[]).map((r) =>
              canConfigure || ['assigner_authority', 'assigner_unavailable', 'task_ineligible', 'scope_lost', 'assignment_withdrawn'].includes(r)
                ? r
                : 'agent_not_ready',
            )
          : [],
      result: run.result_summary ? { status: run.result_status, summary: run.result_summary } : null,
      limits: run.limits,
      usage: {
        tool_calls: run.tool_calls_used,
        artifacts: run.artifacts_used,
        output_bytes: run.output_bytes_used,
        deadline_at: run.deadline_at ? new Date(run.deadline_at).toISOString() : null,
      },
      costs: {
        measured: run.measured_cost_micros === null ? null : { micros: run.measured_cost_micros, basis: 'measured' },
        reported:
          run.reported_cost_micros === null
            ? null
            : {
                micros: run.reported_cost_micros,
                currency: run.reported_cost_currency,
                label: `reported by ${profile.name}`,
              },
      },
      artifacts: [...latest.values()].map((a) => ({
        key: a.artifact_key,
        version: a.version_number,
        title: a.title,
        media_type: a.media_type,
        byte_size: a.byte_size,
        sha256: a.sha256,
        producer: a.producer,
        created_at: new Date(a.created_at as unknown as string).toISOString(),
      })),
      tool_calls: calls.map((c) => ({
        sequence: c.sequence,
        tool: c.tool,
        version: c.tool_version,
        tool_class: c.tool_class,
        decision: c.decision,
        code: c.code,
        duration_ms: c.duration_ms,
        at: new Date(c.created_at as unknown as string).toISOString(),
      })),
      scope: await this.agScopeView(tx, p, ceilingOf(run)),
      capabilities: {
        pause: control && (RUN_CONTROLS.pause as readonly string[]).includes(run.op_state) && !run.ended_at,
        resume: control && (RUN_CONTROLS.resume as readonly string[]).includes(run.op_state) && run.op_waiting !== 'reconciliation_required' && run.op_waiting !== 'external_confirmation',
        cancel: control && (RUN_CONTROLS.cancel as readonly string[]).includes(run.op_state) && run.op_waiting !== 'reconciliation_required',
        retry: control && (RUN_CONTROLS.retry as readonly string[]).includes(run.op_state),
        accept: false,
      },
      created_at: new Date(run.created_at).toISOString(),
      ended_at: run.ended_at ? new Date(run.ended_at).toISOString() : null,
      version: run.version,
    };
  }

  async listTaskAgentRuns(caller: Caller, ws: unknown, tsk: unknown) {
    this.#tokenScope(caller);
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const t = await this.loadTask(tx, p, tsk);
      const rows = await tx.db
        .selectFrom('agents.agent_run')
        .select('id')
        .where('task_id', '=', t.id)
        .orderBy('created_at', 'desc')
        .limit(20)
        .execute();
      const data = [];
      for (const r of rows) data.push(await this.#runView(tx, p, (await this.#run(tx, { id: r.id }))!));
      return { type: 'agent_runs' as const, task: t.publicId, data };
    });
  }

  async getAgentRun(caller: Caller, ws: unknown, run: unknown) {
    this.#tokenScope(caller);
    if (!isPublic(run, 'op')) throw new TenancyError('not_found');
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => this.#renderRun(tx, p, run as string));
  }

  async getAgentArtifact(caller: Caller, ws: unknown, run: unknown, key: unknown) {
    this.#tokenScope(caller);
    if (!isPublic(run, 'op') || typeof key !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(key))
      throw new TenancyError('not_found');
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const r = await this.#run(tx, { publicId: run as string });
      if (!r) throw new TenancyError('not_found');
      await this.#readable(tx, p, r);
      const versions = await tx.db
        .selectFrom('agents.agent_artifact')
        .select(['version_number', 'title', 'media_type', 'content', 'byte_size', 'sha256', 'producer', 'created_at'])
        .where('run_id', '=', r.id)
        .where('artifact_key', '=', key)
        .orderBy('version_number', 'desc')
        .limit(20)
        .execute();
      if (!versions.length) throw new TenancyError('not_found');
      return {
        type: 'agent_artifact' as const,
        run: r.run_public_id,
        key,
        // Draft evidence for review: never a deliverable acceptance (8D).
        draft: true,
        versions: versions.map((v) => ({
          version: v.version_number,
          title: v.title,
          media_type: v.media_type,
          content: v.content,
          byte_size: v.byte_size,
          sha256: v.sha256,
          producer: v.producer,
          created_at: new Date(v.created_at as unknown as string).toISOString(),
        })),
      };
    });
  }

  /**
   * Progress by bounded long poll (the established 4D transport, PL-35): each check is its own
   * workspace transaction with access decided again, so revocation ends disclosure on the next
   * check; the wait is capped; the cursor is the run's event sequence.
   */
  async agentRunEvents(caller: Caller, ws: unknown, run: unknown, query: Record<string, unknown>) {
    this.#tokenScope(caller);
    if (!isPublic(run, 'op')) throw new TenancyError('not_found');
    const after = Number.isSafeInteger(Number(query.after)) && Number(query.after) >= 0 ? Number(query.after) : 0;
    const wait = Math.min(
      this.ws.agentRunPollWaitSeconds,
      Number.isFinite(Number(query.wait)) && Number(query.wait) >= 0 ? Number(query.wait) : 0,
    );
    const deadline = Date.now() + wait * 1000;
    for (;;) {
      const out = await this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const r = await this.#run(tx, { publicId: run as string });
        if (!r) throw new TenancyError('not_found');
        await this.#readable(tx, p, r);
        const events = await tx.db
          .selectFrom('agents.agent_run_event')
          .select(['seq', 'kind', 'source', 'text', 'data', 'created_at'])
          .where('run_id', '=', r.id)
          .where('seq', '>', after)
          .orderBy('seq')
          .limit(100)
          .execute();
        const s = runStateOf(r.op_state, r.op_waiting);
        return {
          events: events.map((e) => ({
            seq: Number(e.seq),
            kind: e.kind,
            source: e.source,
            // Agent commentary and progress are notes, not verified facts, and never completion.
            verified: e.source !== 'agent',
            text: e.text,
            data: e.data as Record<string, unknown>,
            at: new Date(e.created_at as unknown as string).toISOString(),
          })),
          state: s.state,
          waiting: s.waiting,
          cursor: events.length ? Number(events.at(-1)!.seq) : after,
          ended: !!r.ended_at,
        };
      });
      if (out.events.length || out.ended || Date.now() >= deadline)
        return { type: 'agent_run_events' as const, ...out };
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now()))));
    }
  }

  // -------------------------------------------------------------------------------------------
  // Controls (AGT-009): pause, resume, cancel, retry, decided now against current authority.
  // -------------------------------------------------------------------------------------------

  async controlAgentRun(caller: Caller, ws: unknown, runPublic: unknown, verb: RunControl, req: Mutation) {
    this.#tokenScope(caller);
    if (!isPublic(runPublic, 'op')) throw new TenancyError('not_found');
    return this.mutate(
      caller,
      `agent.run_${verb}`,
      ws,
      req,
      async (tx, p) => {
        const run = await this.#run(tx, { publicId: runPublic as string }, true);
        if (!run) throw new TenancyError('not_found');
        const { t } = await this.#readable(tx, p, run);
        this.requireTaskAction(p, RUN_ACTION, t, { shares: false, excluded: 'forbidden' });
        const from = run.op_state;
        if (!(RUN_CONTROLS[verb] as readonly ExecState[]).includes(from))
          throw new TenancyError('conflict', { issues: [issue('/', 'invalid_state', `This run cannot be ${verb}d now.`)] });
        const caller2 = this.#runCaller(run, caller.meta.correlationId);
        let report: Record<string, unknown> = {};
        if (verb === 'pause') report = await this.#pause(tx, run, 'human', p.membershipId);
        else if (verb === 'resume') await this.#resume(tx, p, run);
        else if (verb === 'cancel') report = await this.#cancel(tx, run);
        else await this.#retry(tx, p, run);
        await this.workAudit(
          tx,
          caller,
          p,
          `agent.run_${verb === 'pause' ? 'paused' : verb === 'resume' ? 'resumed' : verb === 'cancel' ? 'cancelled' : 'retried'}`,
          { recordId: run.task_id, type: 'task', publicId: t.publicId },
          [change.plain('run', null, run.run_public_id)],
          run.brand_id,
        );
        void caller2;
        const fresh = (await this.#run(tx, { id: run.id }))!;
        return {
          status: 200,
          ref: { id: run.run_public_id, type: 'agent_run' },
          data: { ...(await this.#runView(tx, p, fresh)), ...(Object.keys(report).length ? { report } : {}) },
        };
      },
      async (tx, p, ref) => this.#renderRun(tx, p, ref.id),
    );
  }

  /** Pause prevents new work at once: credentials stop, queued work stops; a running step pauses next. */
  async #pause(tx: WorkspaceTransaction, run: RunRow, by: 'human' | 'emergency_stop', membershipId: string | null) {
    await tx.db
      .updateTable('agents.agent_run')
      .set({ pause_requested_at: new Date(), paused_by: by, paused_by_membership_id: membershipId, updated_at: new Date(), version: sql`version + 1` })
      .where('id', '=', run.id)
      .execute();
    await this.#revokeCredentials(tx, run.id, by === 'emergency_stop' ? 'emergency_stop' : 'paused');
    if (run.model_operation_id) await requestOperationCancel(tx, run.model_operation_id);
    let state: 'paused' | 'finishing' | 'already' | 'not_stoppable' = 'paused';
    if (run.op_state === 'paused') state = 'already';
    else if (run.op_state === 'waiting' && run.op_waiting === 'reconciliation_required') state = 'not_stoppable';
    else if (run.op_state === 'running') state = 'finishing';
    else {
      await this.#cancelQueuedJobs(tx, run.current_operation_id);
      await transitionOperation(tx, {
        operationId: run.current_operation_id,
        to: 'paused',
        outcomeDetail: { paused_by: by },
        actor: by === 'human' && membershipId ? { type: 'human', id: membershipId } : { type: 'system' },
        context: this.#context(run),
      });
    }
    await this.#event(tx, run, {
      kind: 'state',
      source: by === 'human' ? 'human' : 'system',
      text: by === 'emergency_stop' ? 'Paused by the emergency stop.' : 'Paused.',
      data: { state: 'waiting', waiting: 'paused', paused_by: by },
    });
    return { paused: state };
  }

  async #resume(tx: WorkspaceTransaction, p: Principal, run: RunRow) {
    if (run.op_waiting === 'reconciliation_required' || run.op_waiting === 'external_confirmation')
      throw new TenancyError('conflict', { issues: [issue('/', 'invalid_state', 'This run cannot be resumed now.')] });
    const stop = await this.#stop(tx);
    if (stop.stopped)
      throw new TenancyError('conflict', { issues: [issue('/', 'emergency_stop', 'All agent runs are stopped in this workspace.')] });
    if (run.deadline_at && new Date(run.deadline_at).getTime() <= Date.now())
      throw new TenancyError('conflict', { issues: [issue('/', 'limit_reached', 'This run reached its time limit.')] });
    const live = await this.#live(tx, run);
    if (!live.ok)
      throw new TenancyError('conflict', {
        issues: live.reasons.map((r) =>
          issue('/', this.agCanConfigure(p) || ['assigner_authority', 'assigner_unavailable', 'task_ineligible', 'scope_lost', 'assignment_withdrawn'].includes(r) ? r : 'agent_not_ready', 'The run cannot continue with current authority.'),
        ),
      });
    await tx.db
      .updateTable('agents.agent_run')
      .set({ pause_requested_at: null, paused_by: null, paused_by_membership_id: null, updated_at: new Date(), version: sql`version + 1` })
      .where('id', '=', run.id)
      .execute();
    await transitionOperation(tx, {
      operationId: run.current_operation_id,
      to: 'queued',
      actor: { type: 'human', id: p.membershipId },
      context: this.#context(run),
    });
    await enqueueJob(tx, {
      queue: AGENT_RUN_QUEUE,
      kind: AGENT_RUN_JOB,
      context: this.#context(run),
      operationId: run.current_operation_id,
      payloadRef: run.id,
      maxAttempts: RUN_JOB_ATTEMPTS,
      timeoutSeconds: RUN_JOB_TIMEOUT_SECONDS,
    });
    await this.#event(tx, run, { kind: 'state', source: 'human', text: 'Resumed.', data: { state: 'queued' } });
  }

  /** Cancel is terminal for future actions; anything that may already have left is reported. */
  async #cancel(tx: WorkspaceTransaction, run: RunRow) {
    if (run.op_waiting === 'reconciliation_required')
      throw new TenancyError('conflict', {
        issues: [issue('/', 'reconciliation_required', 'Confirm what happened to the dispatch before cancelling.')],
      });
    await this.#revokeCredentials(tx, run.id, 'cancelled');
    if (run.model_operation_id) await requestOperationCancel(tx, run.model_operation_id);
    if (run.op_state === 'running') {
      await requestOperationCancel(tx, run.current_operation_id);
      await this.#event(tx, run, { kind: 'state', source: 'human', text: 'Cancelling…', data: { state: 'running', cancelling: true } });
      return { cancelling: true };
    }
    const effects = await cancelOpenEffects(tx, run.current_operation_id);
    const liability = effects.reported.reduce<Record<string, number>>((acc, e) => {
      acc[e.liability] = (acc[e.liability] ?? 0) + 1;
      return acc;
    }, {});
    await this.#close(tx, run, 'cancelled', 'user_cancelled', { effect_liability: liability });
    return {
      cancelled: true,
      // A dispatch already sent cannot be recalled: the agent may still act on it.
      sent_before_cancel: liability.sent ?? 0,
      unknown_before_cancel: liability.unknown ?? 0,
    };
  }

  /** Retry keeps the logical run: a linked operation, the same counters and deadline, no resend. */
  async #retry(tx: WorkspaceTransaction, p: Principal, run: RunRow) {
    if (run.attempt_number - 1 >= this.ws.agentRunRetriesMax)
      throw new TenancyError('conflict', { issues: [issue('/', 'limit_reached', 'This run reached its retry limit.')] });
    if ((await uncertainEffects(tx, run.current_operation_id)).length)
      throw new TenancyError('conflict', { issues: [issue('/', 'reconciliation_required', 'Confirm what happened to the dispatch first.')] });
    if (run.deadline_at && new Date(run.deadline_at).getTime() <= Date.now())
      throw new TenancyError('conflict', { issues: [issue('/', 'limit_reached', 'This run reached its time limit.')] });
    const stop = await this.#stop(tx);
    if (stop.stopped)
      throw new TenancyError('conflict', { issues: [issue('/', 'emergency_stop', 'All agent runs are stopped in this workspace.')] });
    const live = await this.#live(tx, run);
    if (!live.ok)
      throw new TenancyError('conflict', {
        issues: live.reasons.map((r) => issue('/', this.agCanConfigure(p) ? r : 'agent_not_ready', 'The run cannot continue with current authority.')),
      });
    const other = await tx.db
      .selectFrom('agents.agent_run')
      .select('id')
      .where('task_id', '=', run.task_id)
      .where('profile_id', '=', run.profile_id)
      .where('ended_at', 'is', null)
      .where('id', '<>', run.id)
      .executeTakeFirst();
    if (other)
      throw new TenancyError('conflict', { issues: [issue('/', 'run_in_progress', 'A run for this task is already in progress.')] });
    const context = this.#context(run);
    const next = await createOperation(tx, {
      kind: 'agent_run',
      context,
      initiatedBy: { type: 'human', id: p.membershipId },
      rerunOfOperationId: run.current_operation_id,
    });
    await tx.db
      .updateTable('agents.agent_run')
      .set({
        current_operation_id: next.id,
        attempt_number: run.attempt_number + 1,
        phase: 'start',
        model_operation_id: null,
        result_status: null,
        result_summary: null,
        pause_requested_at: null,
        paused_by: null,
        paused_by_membership_id: null,
        ended_at: null,
        updated_at: new Date(),
        version: sql`version + 1`,
      })
      .where('id', '=', run.id)
      .execute();
    const fresh = (await this.#run(tx, { id: run.id }))!;
    await enqueueJob(tx, {
      queue: AGENT_RUN_QUEUE,
      kind: AGENT_RUN_JOB,
      context: this.#context(fresh),
      operationId: next.id,
      payloadRef: run.id,
      maxAttempts: RUN_JOB_ATTEMPTS,
      timeoutSeconds: RUN_JOB_TIMEOUT_SECONDS,
    });
    await writeOutboxEvent(tx, {
      type: 'execution.operation.state_changed',
      aggregate: { type: 'execution.operation', id: next.id, sequence: 0 },
      data: { kind: 'agent_run', state: 'queued', terminal_reason: null, waiting_reason: null },
      actor: { type: 'human', id: p.membershipId },
      context: this.#context(fresh),
      operationId: next.id,
    });
    await this.#event(tx, fresh, { kind: 'state', source: 'human', text: `Retry ${fresh.attempt_number} queued.`, data: { state: 'queued', attempt: fresh.attempt_number } });
  }

  // -------------------------------------------------------------------------------------------
  // Emergency stop (AGT-025): owner/administrator, session only; restart is a separate action.
  // -------------------------------------------------------------------------------------------

  async triggerAgentEmergencyStop(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    if (caller.delegation) throw new TenancyError('forbidden');
    const b = isObj(body) ? body : {};
    const reason = typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, 500) : null;
    return this.mutate(
      caller,
      'emergency_stop.trigger',
      ws,
      req,
      async (tx, p) => {
        if (!decideWorkspace(p, 'emergency_stop.trigger').allowed) throw new TenancyError('forbidden');
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'agents.stop:' + tx.workspaceId}, 0))`.execute(tx.db);
        const current = await this.#stop(tx);
        const summary = { paused: 0, finishing: 0, already: 0, not_stoppable: 0 };
        if (!current.stopped) {
          const open = await tx.db.selectFrom('agents.agent_run').select('id').where('ended_at', 'is', null).execute();
          for (const o of open) {
            const run = (await this.#run(tx, { id: o.id }, true))!;
            const r = await this.#pause(tx, run, 'emergency_stop', null);
            summary[r.paused] += 1;
          }
          // Credentials of every run stop working at once, whatever state the run is in.
          await tx.db
            .updateTable('agents.agent_run_credential')
            .set({ state: 'revoked', revoked_reason: 'emergency_stop', revoked_at: new Date() })
            .where('state', '=', 'active')
            .execute();
          await tx.db
            .insertInto('agents.emergency_stop')
            .values({
              id: newUuidV7(),
              workspace_id: tx.workspaceId,
              action: 'stop',
              epoch: current.epoch + 1,
              actor_membership_id: p.membershipId,
              reason,
              summary: JSON.stringify(summary),
            })
            .execute();
          await this.workAudit(tx, caller, p, 'agent.emergency_stopped', { recordId: null, type: 'workspace', publicId: null }, [change.plain('runs', null, String(open.length))], null);
        }
        return {
          status: 200,
          ref: { id: 'agent_emergency_stop', type: 'agent_emergency_stop' },
          data: { id: 'agent_emergency_stop', type: 'agent_emergency_stop' as const, ...(await this.#stopView(tx)), report: summary },
        };
      },
      async (tx) => ({ id: 'agent_emergency_stop', type: 'agent_emergency_stop' as const, ...(await this.#stopView(tx)) }),
    );
  }

  async restartAgentExecution(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    if (caller.delegation) throw new TenancyError('forbidden');
    void body;
    return this.mutate(
      caller,
      'emergency_stop.trigger',
      ws,
      req,
      async (tx, p) => {
        if (!decideWorkspace(p, 'emergency_stop.trigger').allowed) throw new TenancyError('forbidden');
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'agents.stop:' + tx.workspaceId}, 0))`.execute(tx.db);
        const current = await this.#stop(tx);
        if (current.stopped) {
          await tx.db
            .insertInto('agents.emergency_stop')
            .values({
              id: newUuidV7(),
              workspace_id: tx.workspaceId,
              action: 'restart',
              epoch: current.epoch + 1,
              actor_membership_id: p.membershipId,
              reason: null,
              summary: JSON.stringify({}),
            })
            .execute();
          await this.workAudit(tx, caller, p, 'agent.emergency_restarted', { recordId: null, type: 'workspace', publicId: null }, [], null);
        }
        // Paused runs stay paused: each is resumed explicitly, re-checking its authority.
        return {
          status: 200,
          ref: { id: 'agent_emergency_stop', type: 'agent_emergency_stop' },
          data: { id: 'agent_emergency_stop', type: 'agent_emergency_stop' as const, ...(await this.#stopView(tx)) },
        };
      },
      async (tx) => ({ id: 'agent_emergency_stop', type: 'agent_emergency_stop' as const, ...(await this.#stopView(tx)) }),
    );
  }

  async #stopView(tx: WorkspaceTransaction) {
    const s = await this.#stop(tx);
    return { stopped: s.stopped, since: s.since ? s.since.toISOString() : null, epoch: s.epoch };
  }

  /** ADR-010 health: open and recent runs by state, and the stop switch (health.view or the stop). */
  async agentHealth(caller: Caller, ws: unknown) {
    if (caller.delegation) throw new TenancyError('forbidden');
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const stopAllowed = decideWorkspace(p, 'emergency_stop.trigger').allowed;
      if (p.kind !== 'member' || !(stopAllowed || decideWorkspace(p, 'health.view').allowed)) throw new TenancyError('not_found');
      const rows = await tx.db
        .selectFrom('agents.agent_run as r')
        .innerJoin('exec.operation as c', 'c.id', 'r.current_operation_id')
        .select(['c.execution_state', 'c.waiting_reason'])
        .where((eb) => eb.or([eb('r.ended_at', 'is', null), eb('r.ended_at', '>', new Date(Date.now() - 30 * 86_400_000))]))
        .execute();
      const counts: Record<string, number> = { queued: 0, running: 0, waiting: 0, failed: 0, cancelled: 0, ready_for_review: 0 };
      for (const r of rows) counts[runStateOf(r.execution_state, r.waiting_reason).state]! += 1;
      return {
        type: 'agent_health' as const,
        window_days: 30,
        runs: counts,
        emergency_stop: { ...(await this.#stopView(tx)), can_trigger: stopAllowed },
      };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Tools (ADR-0048 D5–D6): registered, granted, inside the live ceiling, current authority.
  // -------------------------------------------------------------------------------------------

  async #invokeTool(
    tx: WorkspaceTransaction,
    run: RunRow,
    assigner: Principal,
    call: { key: string; tool: string; version: string; arguments: Record<string, unknown> },
  ): Promise<{ decision: string; code: string | null; result: unknown }> {
    const started = Date.now();
    const registered = agentTool(call.tool, call.version);
    let decision: 'executed' | 'approval_required' | 'refused' | 'unavailable' | 'limit_reached' = 'refused';
    let code: string | null = 'not_available';
    let result: unknown = null;
    const targets: string[] = [];
    const live = await this.#live(tx, run);
    const stop = await this.#stop(tx);
    const granted = live.tools.find((t) => t.tool === call.tool && t.version === call.version);
    if (stop.stopped) code = 'emergency_stop';
    else if (run.pause_requested_at) code = 'paused';
    else if (!live.ok) code = 'authorization_changed';
    else if (registered && registered.status === 'unavailable') {
      decision = 'unavailable';
      code = 'tool_unavailable';
    } else if (!registered || !granted) code = 'not_available';
    else if (run.tool_calls_used >= run.limits.max_tool_calls) {
      decision = 'limit_reached';
      code = 'limit_reached';
    } else if (!(granted.tool_class === 'read_records' && granted.approval_class === 'none' && EXECUTABLE_TOOLS.has(granted.tool))) {
      // 8D owns per-instance approval: nothing executes; the request is recorded as a boundary.
      decision = 'approval_required';
      code = TOOL_CLASSES[granted.tool_class] ? 'approval_required' : 'not_available';
    } else {
      const owner = await this.agMemberPrincipal(tx, run.owner_membership_id);
      const out = owner ? await this.#read(tx, run, live.ceiling, assigner, owner, granted.tool, call.arguments, targets) : null;
      if (out === null) code = 'not_available';
      else {
        decision = 'executed';
        code = null;
        result = out;
      }
    }
    const prior = await tx.db
      .selectFrom('agents.agent_tool_call')
      .select('id')
      .where('run_id', '=', run.id)
      .where('operation_id', '=', run.current_operation_id)
      .where('call_key', '=', call.key)
      .executeTakeFirst();
    if (!prior) {
      const seq = await tx.db
        .selectFrom('agents.agent_tool_call')
        .select((eb) => eb.fn.coalesce(eb.fn.max('sequence'), sql<number>`0`).as('n'))
        .where('run_id', '=', run.id)
        .executeTakeFirstOrThrow();
      await tx.db
        .insertInto('agents.agent_tool_call')
        .values({
          id: newUuidV7(),
          workspace_id: tx.workspaceId,
          run_id: run.id,
          operation_id: run.current_operation_id,
          sequence: Number(seq.n) + 1,
          call_key: call.key,
          tool: call.tool,
          tool_version: call.version,
          tool_class: registered?.tool_class ?? null,
          decision,
          code,
          target_ids: targets.slice(0, 50),
          args_digest: digest(call.arguments),
          duration_ms: Date.now() - started,
        })
        .execute();
      if (decision === 'executed')
        await tx.db
          .updateTable('agents.agent_run')
          .set({ tool_calls_used: sql`tool_calls_used + 1`, updated_at: new Date() })
          .where('id', '=', run.id)
          .execute();
      await this.#event(tx, run, {
        kind: 'tool_call',
        source: 'system',
        text: `${call.tool}: ${decision.replace('_', ' ')}`,
        data: { tool: call.tool, decision, code },
      });
      this.d.metrics.count('agent.tool_calls', 1, { tool_class: registered?.tool_class ?? 'unregistered', outcome: decision });
    }
    if (!live.ok && code === 'authorization_changed') await this.#holdForAuthority(tx, run, live.reasons);
    return { decision, code, result };
  }

  /** One registered read, as the assigner, inside the live ceiling and the owner's authority. */
  async #read(
    tx: WorkspaceTransaction,
    run: RunRow,
    ceiling: Ceiling,
    assigner: Principal,
    owner: Principal,
    tool: string,
    args: Record<string, unknown>,
    targets: string[],
  ): Promise<unknown> {
    const allowed = async (item: ScopeItem) =>
      (await this.agWithin(tx, item, ceiling)) &&
      (await this.agLevelOn(tx, assigner, item)) !== null &&
      (await this.agLevelOn(tx, owner, item)) !== null;
    if (tool === 'pm.tasks.get') {
      const ref = args.task ?? args.task_id;
      if (!isPublic(ref, 'tsk')) return null;
      const item = await this.agFind(tx, 'record', ref as string);
      if (!item || item.recordType !== 'task' || !(await allowed(item))) return null;
      targets.push(item.id);
      const t = await this.loadTask(tx, assigner, ref as string);
      const status = this.taskStatusView(t.row.status_id, tx) as { name?: string; category?: string } | null;
      return {
        id: t.publicId,
        title: t.row.title,
        status: status ? { name: status.name ?? null, category: status.category ?? null } : null,
        priority: t.row.priority,
        due_date: t.row.due_date,
        description: plainFromRichText(t.row.description_rich as RichTextDoc | null).slice(0, VIEW_TEXT_MAX),
      };
    }
    if (tool === 'pm.tasks.list') {
      const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), LIST_MAX) : LIST_MAX;
      const cursor = typeof args.cursor === 'string' && isPublic(args.cursor, 'tsk') ? (args.cursor as string) : null;
      let q = tx.db
        .selectFrom('work.task as t')
        .innerJoin('core.record as r', 'r.id', 't.id')
        .select(['t.id', 'r.public_id', 't.title'])
        .where('r.lifecycle_state', '=', 'active')
        .where((eb) => {
          const ors = [];
          if (ceiling.record.size) ors.push(eb('t.id', 'in', [...ceiling.record]));
          if (ceiling.project.size) ors.push(eb('t.project_id', 'in', [...ceiling.project]));
          if (ceiling.brand.size) ors.push(eb('t.brand_id', 'in', [...ceiling.brand]));
          return ors.length ? eb.or(ors) : eb.val(false);
        })
        .orderBy('r.public_id')
        .limit(limit * 4);
      if (cursor) q = q.where('r.public_id', '>', cursor);
      const rows = await q.execute();
      const items: Array<{ id: string; title: string }> = [];
      for (const row of rows) {
        if (items.length >= limit) break;
        const item: ScopeItem = { kind: 'record', id: row.id, publicId: row.public_id, recordType: 'task' };
        if (!(await allowed(item))) continue;
        targets.push(row.id);
        items.push({ id: row.public_id, title: row.title });
      }
      return { items, next_cursor: items.length === limit ? items.at(-1)!.id : null };
    }
    if (tool === 'pm.documents.get') {
      const ref = args.document;
      if (!isPublic(ref, 'doc')) return null;
      const item = await this.agFind(tx, 'record', ref as string);
      if (!item || item.recordType !== 'document' || !(await allowed(item))) return null;
      targets.push(item.id);
      const d = await tx.db
        .selectFrom('knowledge.document as d')
        .leftJoin('knowledge.document_version as v', 'v.id', 'd.current_version_id')
        .select(['d.title', 'v.content', 'd.lifecycle_state'])
        .where('d.id', '=', item.id)
        .executeTakeFirst();
      if (!d || d.lifecycle_state !== 'active') return null;
      return {
        id: ref,
        title: d.title,
        text: plainFromRichText((d.content ?? null) as RichTextDoc | null).slice(0, VIEW_TEXT_MAX * 2),
      };
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // Callbacks from an external agent (run-bound credential only; ADR-0048 D5, D9, D10)
  // -------------------------------------------------------------------------------------------

  async #credentialRun(tx: WorkspaceTransaction, caller: Caller, runPublic: unknown): Promise<RunRow> {
    const d = caller.delegation?.agentRun;
    if (caller.delegation?.principalType !== 'agent_run' || !d || !isPublic(runPublic, 'op'))
      throw new TenancyError('not_found');
    const c = await tx.db
      .selectFrom('agents.agent_run_credential')
      .select(['state', 'expires_at', 'run_id', 'operation_id'])
      .where('id', '=', d.credentialId)
      .forUpdate()
      .executeTakeFirst();
    if (!c || c.state !== 'active' || new Date(c.expires_at as unknown as string).getTime() <= Date.now())
      throw new TenancyError('not_found');
    const run = await this.#run(tx, { id: c.run_id }, true);
    if (!run || run.run_public_id !== runPublic || run.current_operation_id !== c.operation_id)
      throw new TenancyError('not_found');
    return run;
  }

  async #callback<T>(
    caller: Caller,
    ws: unknown,
    runPublic: unknown,
    fn: (tx: WorkspaceTransaction, p: Principal, run: RunRow) => Promise<T | Refusal>,
  ): Promise<T> {
    const out = await this.inWorkspace(caller, ws, {}, async (tx, p) => {
      const run = await this.#credentialRun(tx, caller, runPublic);
      if (run.ended_at || isTerminalOp(run.op_state)) throw new TenancyError('not_found');
      return fn(tx, p, run);
    });
    if (out instanceof Refusal) throw out.err;
    return out;
  }

  /** What the agent was asked (re-read with the credential; the same as the dispatch, now). */
  async agentRunContext(caller: Caller, ws: unknown, runPublic: unknown) {
    return this.#callback(caller, ws, runPublic, async (tx, p, run) => {
      const live = await this.#live(tx, run);
      if (!live.ok) {
        await this.#holdForAuthority(tx, run, live.reasons);
        return refuse('run_unavailable');
      }
      return { type: 'agent_run_context' as const, ...(await this.#brief(tx, run, live, p)) };
    });
  }

  async agentRunPostEvent(caller: Caller, ws: unknown, runPublic: unknown, body: unknown) {
    const parsed = parseEvent(body, this.ws.agentRunEventTextMaxChars);
    if (!parsed.ok) throw invalid(...parsed.issues.map((i) => issue(i.pointer, i.code, i.message)));
    return this.#callback(caller, ws, runPublic, async (tx, _p, run) => {
      if (run.events_used >= this.ws.agentRunEventsMax)
        throw new TenancyError('limit_exceeded', { issues: [issue('/', 'limit_reached', 'This run has recorded its maximum number of events.')] });
      const e = await this.#event(tx, run, {
        kind: parsed.value.kind,
        source: 'agent',
        key: parsed.value.key,
        text: parsed.value.text,
        data: parsed.value.percent === null ? {} : { percent: parsed.value.percent },
      });
      // Progress and commentary never complete a run.
      return { type: 'agent_run_event_receipt' as const, seq: e.seq, duplicate: e.duplicate };
    });
  }

  async agentRunCallTool(caller: Caller, ws: unknown, runPublic: unknown, body: unknown) {
    const parsed = parseToolCall(body);
    if (!parsed.ok) throw invalid(...parsed.issues.map((i) => issue(i.pointer, i.code, i.message)));
    return this.#callback(caller, ws, runPublic, async (tx, p, run) => {
      const out = await this.#invokeTool(tx, run, p, parsed.value);
      if (out.decision === 'executed') return { type: 'agent_tool_result' as const, decision: 'executed', result: out.result };
      // The decision is recorded either way; the agent gets a bounded answer.
      if (out.decision === 'approval_required')
        return refuse('approval_required', 'approval_required', 'This action needs a person’s approval, which arrives in Phase 8D. Nothing was done.');
      if (out.decision === 'unavailable') return refuse('tool_unavailable', 'dependency_unavailable', 'This tool is not available yet.');
      if (out.decision === 'limit_reached') return refuse('limit_reached', 'limit_exceeded', 'This run reached its tool call limit.');
      if (out.code === 'paused' || out.code === 'emergency_stop' || out.code === 'authorization_changed') return refuse('run_unavailable');
      // Unregistered, ungranted, outside scope, unknown, or hidden: one opaque answer.
      return new Refusal(new TenancyError('not_found'));
    });
  }

  async agentRunPostArtifact(caller: Caller, ws: unknown, runPublic: unknown, body: unknown) {
    const parsed = parseArtifact(body, this.ws.agentArtifactMaxBytes);
    if (!parsed.ok) throw invalid(...parsed.issues.map((i) => issue(i.pointer, i.code, i.message)));
    return this.#callback(caller, ws, runPublic, async (tx, _p, run) => {
      const live = await this.#live(tx, run);
      if (!live.ok || run.pause_requested_at || (await this.#stop(tx)).stopped) {
        if (!live.ok) await this.#holdForAuthority(tx, run, live.reasons);
        return refuse('run_unavailable');
      }
      const a = await this.#addArtifact(tx, run, parsed.value, 'external');
      return { type: 'agent_artifact_receipt' as const, key: parsed.value.key, version: a.version, duplicate: a.duplicate };
    });
  }

  async #addArtifact(tx: WorkspaceTransaction, run: RunRow, input: ArtifactInput, producer: 'internal' | 'external') {
    if (run.result_status)
      throw new TenancyError('conflict', { issues: [issue('/', 'run_closed', 'This run already returned its result.')] });
    const latest = await tx.db
      .selectFrom('agents.agent_artifact')
      .select(['version_number', 'sha256'])
      .where('run_id', '=', run.id)
      .where('artifact_key', '=', input.key)
      .orderBy('version_number', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (latest && latest.sha256 === input.sha256) return { version: latest.version_number, duplicate: true };
    if (!latest && run.artifacts_used >= run.limits.max_artifacts)
      throw new TenancyError('limit_exceeded', { issues: [issue('/', 'limit_reached', 'This run reached its artifact limit.')] });
    const bytes = Buffer.byteLength(input.content);
    if (run.output_bytes_used + bytes > this.ws.agentRunOutputMaxBytes)
      throw new TenancyError('limit_exceeded', { issues: [issue('/', 'limit_reached', 'This run reached its output size limit.')] });
    const version = (latest?.version_number ?? 0) + 1;
    // A new version never replaces an earlier one: earlier versions stay as evidence.
    await tx.db
      .insertInto('agents.agent_artifact')
      .values({
        id: newUuidV7(),
        workspace_id: tx.workspaceId,
        run_id: run.id,
        operation_id: run.current_operation_id,
        artifact_key: input.key,
        version_number: version,
        title: input.title,
        media_type: input.media_type,
        content: input.content,
        byte_size: bytes,
        sha256: input.sha256,
        producer,
      })
      .execute();
    await tx.db
      .updateTable('agents.agent_run')
      .set({
        artifacts_used: latest ? sql`artifacts_used` : sql`artifacts_used + 1`,
        output_bytes_used: sql`output_bytes_used + ${bytes}`,
        updated_at: new Date(),
      })
      .where('id', '=', run.id)
      .execute();
    await this.#event(tx, run, { kind: 'artifact', source: 'system', text: `Draft artifact: ${input.title}`, data: { key: input.key, version } });
    return { version, duplicate: false };
  }

  /**
   * The one structured final result (AGT-022): bound to the attempt, validated, and recorded as
   * ready for review (completed) or failed. Never accepted, never task completion. A result for
   * an older attempt or after the run closed is kept as bounded evidence and changes nothing.
   */
  async agentRunPostResult(caller: Caller, ws: unknown, runPublic: unknown, body: unknown) {
    const parsed = parseResult(body);
    if (!parsed.ok) throw invalid(...parsed.issues.map((i) => issue(i.pointer, i.code, i.message)));
    const out = await this.inWorkspace(caller, ws, {}, async (tx): Promise<{ type: 'agent_run_result_receipt'; status: string } | Refusal> => {
      const run = await this.#credentialRun(tx, caller, runPublic);
      const r = parsed.value;
      const late = run.ended_at || isTerminalOp(run.op_state) || r.attempt !== run.attempt_number || run.result_status;
      if (late) {
        await this.#event(tx, run, {
          kind: 'late_result',
          source: 'agent',
          key: `result:${r.key}`,
          text: 'A result arrived after the run closed or for another attempt; it changed nothing.',
          data: { attempt: r.attempt, status: r.status },
        });
        return refuse('run_closed', 'conflict', 'This run attempt is closed.');
      }
      const live = await this.#live(tx, run);
      if (!live.ok) {
        await this.#holdForAuthority(tx, run, live.reasons);
        return refuse('run_unavailable');
      }
      const present = r.artifacts.length
        ? await tx.db
            .selectFrom('agents.agent_artifact')
            .select('artifact_key')
            .distinct()
            .where('run_id', '=', run.id)
            .where('artifact_key', 'in', r.artifacts)
            .execute()
        : [];
      if (present.length !== r.artifacts.length)
        throw invalid(issue('/artifacts', 'artifact_missing', 'Return every artifact the result names first.'));
      const rev = await tx.db
        .selectFrom('agents.agent_assignment_revision')
        .select('deliverable')
        .where('id', '=', run.assignment_revision_id)
        .executeTakeFirstOrThrow();
      if (r.status === 'completed' && rev.deliverable && !r.artifacts.length)
        throw invalid(issue('/artifacts', 'deliverable_missing', 'The assignment expects a deliverable: return it as an artifact.'));
      await tx.db
        .updateTable('agents.agent_run')
        .set({
          result_status: r.status,
          result_summary: r.summary,
          ...(r.reported_cost
            ? { reported_cost_micros: r.reported_cost.amount_micros, reported_cost_currency: r.reported_cost.currency }
            : {}),
          updated_at: new Date(),
          version: sql`version + 1`,
        })
        .where('id', '=', run.id)
        .execute();
      await this.#event(tx, run, {
        kind: 'result',
        source: 'agent',
        key: `result:${r.key}`,
        text: r.status === 'completed' ? 'The agent returned its result for review.' : 'The agent reported that it failed.',
        data: { status: r.status, artifacts: r.artifacts.length },
      });
      const fresh = (await this.#run(tx, { id: run.id }, true))!;
      if (fresh.op_state !== 'running') {
        if (r.status === 'completed') await this.#close(tx, fresh, 'succeeded', null, { result: 'ready_for_review' });
        else await this.#close(tx, fresh, 'failed', 'error', { code: 'agent_reported_failure' });
      }
      // While a step is running, the job sees the result at its next boundary and ends with it.
      return { type: 'agent_run_result_receipt' as const, status: r.status === 'completed' ? 'ready_for_review' : 'failed' };
    });
    if (out instanceof Refusal) throw out.err;
    return out;
  }

  /** MCP for a run credential: initialize, the run's own executable tools, and nothing else. */
  override async handleMcpRpc(caller: Caller, ws: unknown, req: McpRpcRequest, mutationReq: Mutation): Promise<McpRpcResponse> {
    if (caller.delegation?.principalType !== 'agent_run') return super.handleMcpRpc(caller, ws, req, mutationReq);
    const runId = caller.delegation.agentRun?.runId;
    try {
      const runPublic = await this.inWorkspace(caller, ws, { readOnly: true }, async (tx) => {
        const r = runId ? await this.#run(tx, { id: runId }) : null;
        if (!r) throw new TenancyError('not_found');
        return r.run_public_id;
      });
      switch (req.method) {
        case 'initialize':
          return rpcOk(req.id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'pm-agent-run', version: RUN_PROTOCOL_VERSION },
          });
        case 'ping':
        case 'notifications/initialized':
          return rpcOk(req.id, {});
        case 'resources/list':
          return rpcOk(req.id, { resources: [] });
        case 'tools/list': {
          const tools = await this.#callback(caller, ws, runPublic, async (tx, _p, run) => {
            const live = await this.#live(tx, run);
            return live.ok ? live.tools.filter((t) => this.#toolView(t).mode === 'runs') : [];
          });
          return rpcOk(req.id, {
            tools: tools.map((t) => {
              const def = AGENT_TOOLS.find((x) => x.name === t.tool && x.version === t.version)!;
              return { name: t.tool, description: def.description, inputSchema: def.inputSchema };
            }),
          });
        }
        case 'tools/call': {
          const prm = isObj(req.params) ? req.params : {};
          const meta = isObj(prm._meta) ? prm._meta : {};
          const name = typeof prm.name === 'string' ? prm.name : '';
          const def = AGENT_TOOLS.find((x) => x.name === name && x.status === 'available');
          const out = await this.agentRunCallTool(caller, ws, runPublic, {
            key: typeof meta.idempotencyKey === 'string' ? meta.idempotencyKey : `mcp:${String(req.id ?? newUuidV7())}`,
            tool: name,
            version: def?.version ?? '1',
            arguments: isObj(prm.arguments) ? prm.arguments : {},
          });
          return rpcOk(req.id, { content: [{ type: 'text', text: JSON.stringify(out.result) }], isError: false });
        }
        default:
          return rpcError(req.id, -32601, 'Method not found.');
      }
    } catch (err) {
      if (err instanceof TenancyError && err.code === 'approval_required')
        return rpcError(req.id, -32002, 'This action needs approval (Phase 8D). Nothing was done.');
      if (err instanceof TenancyError && err.code === 'validation_failed') return rpcError(req.id, -32602, 'Invalid parameters.');
      if (err instanceof TenancyError && err.code === 'limit_exceeded') return rpcError(req.id, -32004, 'Limit reached.');
      return rpcError(req.id, -32001, 'Not found.');
    }
  }

  /** The brief an agent works from: built now, in memory, from current authority. */
  async #brief(tx: WorkspaceTransaction, run: RunRow, live: LiveDecision, assigner: Principal) {
    const rev = await tx.db
      .selectFrom('agents.agent_assignment_revision')
      .selectAll()
      .where('id', '=', run.assignment_revision_id)
      .executeTakeFirstOrThrow();
    const prof = await this.agRevision(tx, run.profile_revision_id);
    const task = await tx.db.selectFrom('work.task').select('title').where('id', '=', run.task_id).executeTakeFirstOrThrow();
    const taskPublic = (await this.publicOf(tx, run.task_id))!;
    const owner = await this.agMemberPrincipal(tx, run.owner_membership_id);
    const context: Array<{ id: string; type: string; name: string }> = [];
    for (const id of rev.context_refs) {
      const [item] = await this.agItemsOf(tx, { brand: new Set(), project: new Set(), record: new Set([id]), integration: new Set() });
      if (!item || !owner || !(await this.agWithin(tx, item, live.ceiling))) continue;
      if ((await this.agLevelOn(tx, assigner, item)) === null || (await this.agLevelOn(tx, owner, item)) === null) continue;
      const named = await this.agNamed(tx, assigner, 'record', id);
      if (named) context.push({ id: named.publicId, type: item.recordType ?? 'record', name: named.name });
    }
    return {
      run: { id: run.run_public_id, attempt: run.attempt_number },
      task: { id: taskPublic, title: task.title },
      brief: {
        goal: rev.goal,
        constraints: rev.constraints,
        deliverable: rev.deliverable,
        criteria: rev.criteria as string[],
        instructions: String((prof.config as { instructions?: unknown }).instructions ?? ''),
      },
      context,
      tools: live.tools.filter((t) => this.#toolView(t).mode === 'runs').map((t) => ({ name: t.tool, version: t.version })),
      limits: run.limits,
    };
  }

  // -------------------------------------------------------------------------------------------
  // The job (`agents.run`): fenced steps, reference-only checkpoints, no I/O under a lock.
  // -------------------------------------------------------------------------------------------

  async #guard(tx: WorkspaceTransaction, runId: string, opId: string): Promise<GuardOutcome> {
    const run = await this.#run(tx, { id: runId }, true);
    if (!run || run.current_operation_id !== opId) return { outcome: 'stale' };
    if (run.result_status) return { outcome: 'finished', status: run.result_status };
    if (run.op_cancel_requested) return { outcome: 'cancel' };
    const stop = await this.#stop(tx);
    if (stop.stopped && !run.pause_requested_at) await this.#pause(tx, { ...run, op_state: 'running' }, 'emergency_stop', null);
    if (stop.stopped || run.pause_requested_at) {
      await this.#revokeCredentials(tx, run.id, 'paused');
      return { outcome: 'paused' };
    }
    if (run.deadline_at && new Date(run.deadline_at).getTime() <= Date.now()) return { outcome: 'deadline' };
    const live = await this.#live(tx, run);
    if (!live.ok) {
      await this.#revokeCredentials(tx, run.id, 'authorization_changed');
      return live.terminal ? { outcome: 'withdrawn' } : { outcome: 'authorization', reasons: live.reasons };
    }
    return {
      outcome: 'go',
      kind: run.kind,
      phase: run.phase,
      deadline: new Date(run.deadline_at ?? Date.now()).toISOString(),
      attempt: run.attempt_number,
    };
  }

  async runAgentJob(ctx: JobHandlerContext): Promise<JobResult> {
    const runId = ctx.job.payloadRef!;
    const opId = ctx.job.operationId!;
    const ws = ctx.job.workspaceId!;
    const g = (await ctx.step('guard', async (tx) => ({ g: await this.#guard(tx as WorkspaceTransaction, runId, opId) }))).g;
    const decided = this.#decidedResult(g);
    if (decided) return decided;
    const go = g as Extract<GuardOutcome, { outcome: 'go' }>;
    if (go.kind === 'internal') {
      if (go.phase === 'start') {
        await ctx.step('read', async (tx) => {
          await this.#internalRead(tx as WorkspaceTransaction, runId, ctx);
          return {};
        });
        const m = await ctx.step('model', async (tx) => this.#internalModel(tx as WorkspaceTransaction, runId, ctx));
        if ('fail' in m) throw new JobError('deterministic', m.fail as string);
        return { state: 'waiting', reason: 'external_confirmation', resumeAt: new Date(go.deadline) };
      }
      const c = await ctx.step('collect', async (tx) => this.#internalCollect(tx as WorkspaceTransaction, runId));
      if (c.wait) return { state: 'waiting', reason: 'external_confirmation', resumeAt: new Date(go.deadline) };
      if (c.fail) throw new JobError('deterministic', c.fail as string);
      return { state: 'succeeded' };
    }
    if (go.phase === 'start') {
      await ctx.effect(`dispatch:${runId}:${go.attempt}`, AGENT_RUN_DISPATCH_DESTINATION, async () => {
        const plan = await this.d.tenant.withWorkspace(ws, { module: 'agents' }, (tx) =>
          this.#dispatchPlan(tx as WorkspaceTransaction, runId, opId),
        );
        if ('refused' in plan) throw new EffectNotSentError('precondition_failed');
        const res = await dispatchRun(
          plan.target,
          { id: plan.dispatchId, body: plan.body },
          {
            timeoutMs: this.ws.agentConnectorTimeoutMs,
            maxBytes: this.ws.agentConnectorResponseMaxBytes,
            allowLoopback: this.agentDeps.transport === 'fixture',
            productOrigin: this.agentDeps.productOrigin,
            ...(this.agentDeps.fetchImpl ? { fetchImpl: this.agentDeps.fetchImpl } : {}),
          },
          (b) => parseAck(b, plan.dispatchId),
        );
        if (!res.ok && !res.sent) throw new EffectNotSentError('refused_before_send');
        // A request may have left: anything but a valid acknowledgment is an unknown outcome.
        if (!res.ok) throw new EffectOutcomeUnknownError();
        return { externalRef: plan.dispatchId };
      });
      const after = await ctx.step('dispatched', async (tx) => {
        const run = await this.#run(tx as WorkspaceTransaction, { id: runId }, true);
        if (!run) return { status: null };
        if (run.result_status) return { status: run.result_status };
        await tx.db.updateTable('agents.agent_run').set({ phase: 'awaiting_agent', updated_at: new Date() }).where('id', '=', runId).execute();
        await this.#event(tx as WorkspaceTransaction, run, { kind: 'state', source: 'system', text: 'Sent to the agent; it acknowledged receipt (not completion).', data: { state: 'running' } });
        return { status: null };
      });
      if (after.status === 'completed') return { state: 'succeeded' };
      if (after.status === 'failed') throw new JobError('deterministic', 'agent_reported_failure');
      return { state: 'waiting', reason: 'external_confirmation', resumeAt: new Date(go.deadline) };
    }
    // The continuation of an awaited agent: only the deadline brings it here.
    throw new JobError('policy', 'limit_exceeded');
  }

  #decidedResult(g: GuardOutcome): JobResult | null {
    switch (g.outcome) {
      case 'go':
        return null;
      case 'stale':
        return { state: 'succeeded' };
      case 'finished':
        if (g.status === 'completed') return { state: 'succeeded' };
        throw new JobError('deterministic', 'agent_reported_failure');
      case 'paused':
        return { state: 'paused', result: { paused: true } };
      case 'authorization':
        return { state: 'waiting', reason: 'authorization_changed', result: { reasons: g.reasons } };
      case 'withdrawn':
        throw new JobError('policy', 'assignment_withdrawn');
      case 'deadline':
        throw new JobError('policy', 'limit_exceeded');
      case 'cancel':
        throw new CancelRequestedError();
    }
  }

  /** Internal agents first read their own task through the granted read tool (if granted). */
  async #internalRead(tx: WorkspaceTransaction, runId: string, ctx: JobHandlerContext) {
    const run = (await this.#run(tx, { id: runId }, true))!;
    if (!run.tools.some((t) => t.tool === 'pm.tasks.get')) return;
    const assigner = await this.agMemberPrincipal(tx, run.assigner_membership_id);
    if (!assigner) return;
    const taskPublic = (await this.publicOf(tx, run.task_id))!;
    await this.#invokeTool(tx, run, assigner, {
      key: `internal:read:${run.attempt_number}:${ctx.job.attemptNumber}`,
      tool: 'pm.tasks.get',
      version: run.tools.find((t) => t.tool === 'pm.tasks.get')!.version,
      arguments: { task: taskPublic },
    });
  }

  /** One gateway turn for the run (deduplicated by the run's model operation). */
  async #internalModel(tx: WorkspaceTransaction, runId: string, ctx: JobHandlerContext): Promise<{ started: string } | { fail: string }> {
    const run = (await this.#run(tx, { id: runId }, true))!;
    if (run.model_operation_id && run.phase === 'awaiting_model') return { started: run.model_operation_id };
    const assigner = await this.agMemberPrincipal(tx, run.assigner_membership_id);
    if (!assigner) return { fail: 'assigner_unavailable' };
    const rev = await tx.db.selectFrom('agents.agent_assignment_revision').selectAll().where('id', '=', run.assignment_revision_id).executeTakeFirstOrThrow();
    const prof = await this.agRevision(tx, run.profile_revision_id);
    const instructions = String((prof.config as { instructions?: unknown }).instructions ?? '');
    if (sha256Hex(instructions) !== run.instructions_hash) return { fail: 'instructions_changed' };
    const brief = [
      `Goal: ${rev.goal}`,
      ...(rev.constraints ? [`Constraints: ${rev.constraints}`] : []),
      ...(rev.deliverable ? [`Deliverable: ${rev.deliverable}`] : []),
      ...((rev.criteria as string[]).length ? [`Acceptance criteria:\n- ${(rev.criteria as string[]).join('\n- ')}`] : []),
      `Agent instructions (data): ${instructions}`,
    ].join('\n');
    const taskPublic = (await this.publicOf(tx, run.task_id))!;
    try {
      await sql`SAVEPOINT agent_model`.execute(tx.db);
      const out = await this.startAgentAiRun(tx, this.#runCaller(run, ctx.context.correlationId, ctx.job.attemptId), assigner, {
        instruction: brief.slice(0, 16000),
        task: taskPublic,
        confirm: run.limits.cost_confirmed === true,
      });
      await sql`RELEASE SAVEPOINT agent_model`.execute(tx.db);
      await tx.db
        .updateTable('agents.agent_run')
        .set({ model_operation_id: out.operationId, phase: 'awaiting_model', updated_at: new Date() })
        .where('id', '=', run.id)
        .execute();
      await this.#event(tx, run, { kind: 'state', source: 'system', text: 'Asked the model through the AI gateway.', data: { state: 'running' } });
      return { started: out.operationId };
    } catch (err) {
      await sql`ROLLBACK TO SAVEPOINT agent_model`.execute(tx.db);
      // Provider off or unconfigured is a truthful refusal (manual fallback), never a success.
      if (err instanceof TenancyError)
        return {
          fail:
            err.code === 'usage_limit_reached'
              ? 'usage_limit_reached'
              : err.code === 'conflict' && err.issues.some((i) => i.code === 'confirmation_required')
                ? 'cost_confirmation_required'
                : 'model_unavailable',
        };
      throw err;
    }
  }

  async #internalCollect(tx: WorkspaceTransaction, runId: string): Promise<{ wait?: true; fail?: string; done?: true }> {
    const run = (await this.#run(tx, { id: runId }, true))!;
    if (!run.model_operation_id) return { fail: 'model_unavailable' };
    const op = await tx.db
      .selectFrom('exec.operation')
      .select(['execution_state', 'waiting_reason'])
      .where('id', '=', run.model_operation_id)
      .executeTakeFirstOrThrow();
    if (op.execution_state === 'waiting' && op.waiting_reason === 'reconciliation_required') return { fail: 'model_outcome_unknown' };
    if (!isTerminalOp(op.execution_state)) return { wait: true };
    if (op.execution_state !== 'succeeded' && op.execution_state !== 'partial') return { fail: 'model_failed' };
    const output = await tx.db
      .selectFrom('ai.ai_output')
      .select(['content', 'completeness'])
      .where('operation_id', '=', run.model_operation_id)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    let draft = '';
    try {
      const parsed = output?.content ? (JSON.parse(output.content) as { draft?: unknown; status?: unknown }) : null;
      draft = typeof parsed?.draft === 'string' ? parsed.draft : '';
    } catch {
      draft = '';
    }
    if (!draft || output?.completeness !== 'complete') return { fail: 'model_output_incomplete' };
    const settled = await tx.db
      .selectFrom('ai.ai_dispatch')
      .select((eb) => eb.fn.sum<string>('settled_micros').as('micros'))
      .where('operation_id', '=', run.model_operation_id)
      .executeTakeFirst();
    const content = draft.slice(0, this.ws.agentArtifactMaxBytes);
    await this.#addArtifact(tx, run, { key: 'draft', title: 'Draft', media_type: 'text/markdown', content, sha256: sha256Hex(content) }, 'internal');
    await tx.db
      .updateTable('agents.agent_run')
      .set({
        result_status: 'completed',
        result_summary: 'The internal agent returned a draft for review.',
        measured_cost_micros: settled?.micros === null || settled?.micros === undefined ? null : Number(settled.micros),
        updated_at: new Date(),
      })
      .where('id', '=', run.id)
      .execute();
    return { done: true };
  }

  /**
   * Immediately before the dispatch leaves: the run, the stop, the live authority, and the
   * connector are decided again; a fresh run-bound credential is minted (hash at rest); the body
   * is built in memory. Nothing of it is stored in the job checkpoint.
   */
  async #dispatchPlan(
    tx: WorkspaceTransaction,
    runId: string,
    opId: string,
  ): Promise<
    | { refused: string }
    | { target: { kind: 'api' | 'webhook' | 'mcp'; endpoint: string; secret: string }; dispatchId: string; body: Record<string, unknown> }
  > {
    const run = await this.#run(tx, { id: runId }, true);
    if (!run || run.current_operation_id !== opId || run.ended_at || run.result_status) return { refused: 'run_closed' };
    if (run.pause_requested_at || (await this.#stop(tx)).stopped) return { refused: 'paused' };
    if (run.deadline_at && new Date(run.deadline_at).getTime() <= Date.now()) return { refused: 'limit_reached' };
    const live = await this.#live(tx, run);
    if (!live.ok) return { refused: 'authorization_changed' };
    const c = run.connector_id
      ? await tx.db.selectFrom('agents.agent_connector').selectAll().where('id', '=', run.connector_id).executeTakeFirst()
      : null;
    if (!c || c.state !== 'verified' || c.config_version !== run.connector_config_version) return { refused: 'connector_changed' };
    if (this.agentDeps.transport !== 'fixture' || !this.agentDeps.productOrigin) return { refused: 'transport_unavailable' };
    const secret = c.secret_ref ? await this.integrationVault().get(c.secret_ref, { scope: tx }) : undefined;
    if (!secret) return { refused: 'secret_unavailable' };
    const assigner = await this.agMemberPrincipal(tx, run.assigner_membership_id);
    if (!assigner) return { refused: 'authorization_changed' };
    await this.#revokeCredentials(tx, run.id, 'superseded');
    const cred = newCredential();
    const ttl = Math.min(this.ws.agentRunCredentialTtlSeconds * 1000, new Date(run.deadline_at ?? Date.now()).getTime() - Date.now());
    const expires = new Date(Date.now() + Math.max(ttl, 1000));
    await tx.db
      .insertInto('agents.agent_run_credential')
      .values({
        id: newUuidV7(),
        workspace_id: tx.workspaceId,
        run_id: run.id,
        operation_id: run.current_operation_id,
        token_prefix: cred.prefix,
        token_hash: cred.hash,
        expires_at: expires,
        stop_epoch: (await this.#stop(tx)).epoch,
      })
      .execute();
    const ws = await tx.db.selectFrom('tenancy.workspace').select('public_id').executeTakeFirstOrThrow();
    const base = `${this.agentDeps.productOrigin!.replace(/\/+$/, '')}/v1/workspaces/${ws.public_id}`;
    const runPath = `${base}/agent-runs/${run.run_public_id}`;
    const dispatchId = `${run.run_public_id}.${run.attempt_number}`;
    const brief = await this.#brief(tx, run, live, assigner);
    await this.#event(tx, run, { kind: 'state', source: 'system', text: 'Dispatching to the agent.', data: { state: 'running' } });
    return {
      target: { kind: c.kind as 'api' | 'webhook' | 'mcp', endpoint: c.endpoint_url, secret },
      dispatchId,
      body: {
        type: 'agent.run.dispatch',
        protocol: AGENT_PROTOCOL,
        version: RUN_PROTOCOL_VERSION,
        dispatch_id: dispatchId,
        ...brief,
        callback: {
          base_url: runPath,
          events: `${runPath}/events`,
          tools: `${runPath}/tools`,
          artifacts: `${runPath}/artifacts`,
          result: `${runPath}/result`,
          mcp: `${base}/mcp`,
        },
        credential: { token: cred.token, expires_at: expires.toISOString() },
        issued_at: new Date().toISOString(),
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // The outcome consumer: settles runs once, wakes runs waiting for their model turn.
  // -------------------------------------------------------------------------------------------

  async consumeAgentOperationState(tx: WorkspaceTransaction, e: InternalEvent) {
    const data = e.data as { kind?: string; state?: ExecState; terminal_reason?: string | null };
    if (data.kind === 'agent_run') {
      const run = await this.#run(tx, { currentOperationId: e.aggregate.id });
      if (!run || !data.state) return;
      if (isTerminalOp(data.state)) await this.#settle(tx, run.id, data.state, data.terminal_reason ?? null);
      else if (data.state === 'paused' || (data.state === 'waiting' && run.op_waiting !== 'external_confirmation'))
        await this.#revokeCredentials(tx, run.id, data.state === 'paused' ? 'paused' : 'waiting');
      return;
    }
    if (data.kind === 'ai_action' && data.state && isTerminalOp(data.state)) {
      const run = await this.#run(tx, { modelOperationId: e.aggregate.id });
      if (!run || run.phase !== 'awaiting_model' || run.op_state !== 'waiting') return;
      // Wake the run's continuation now instead of at its deadline.
      await tx.db
        .updateTable('exec.job')
        .set({ run_at: new Date() })
        .where('operation_id', '=', run.current_operation_id)
        .where('state', '=', 'queued')
        .execute();
    }
  }

  // -------------------------------------------------------------------------------------------
  // 8A automations invoke agents through the same admission (AUTO-007).
  // -------------------------------------------------------------------------------------------

  protected override async automationAgentIssues(tx: WorkspaceTransaction, p: Principal, agents: string[]) {
    const out: Array<ReturnType<typeof issue>> = [];
    for (const a of agents) {
      const profile = isPublic(a, 'agt') ? await this.agRows(tx, { publicId: a }) : null;
      if (!profile || profile.lifecycle_state !== 'active' || profile.state !== 'active' || p.kind !== 'member')
        out.push(issue('/steps', 'agent_unavailable', 'Choose an agent that is turned on.'));
    }
    return out;
  }

  protected override async invokeAgentForAutomation(
    tx: WorkspaceTransaction,
    owner: Principal,
    input: { taskPublicId: string; profilePublicId: string; automationRunId: string; operationId: string; node: string },
  ) {
    const run = await this.admitAgentRun(tx, owner, {
      taskPublicId: input.taskPublicId,
      profilePublicId: input.profilePublicId,
      initiator: { kind: 'automation', sourceRef: input.automationRunId, causationId: input.operationId },
      requestKey: `a:${input.operationId}:${input.node}`,
      correlationId: newTraceId(),
    });
    return { runPublicId: run.run_public_id };
  }
}

export type { Ceiling as AgentRunCeiling };
