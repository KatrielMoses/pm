import { createHash, randomUUID } from 'node:crypto';
import { change, CommandContext } from '@pm/audit';
import { newPublicId, newTraceId, newUuidV7, type ExecutionContext } from '@pm/contracts';
import { sql, type AutomationRunStatus, type WorkspaceTransaction } from '@pm/db';
import {
  AwaitReconciliationError,
  CancelRequestedError,
  contextFromRow,
  createOperation,
  defineEffectDestination,
  enqueueJob,
  isTerminalState,
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
  actionDef,
  compilePrincipal,
  decideBrand,
  decideRecord,
  decideWorkspace,
  invalid,
  issue,
  parseIfMatch,
  projectChainOf,
  requireVersion,
  TenancyError,
  type BrandFacts,
  type Caller,
  type Mutation,
  type Principal,
} from '@pm/tenancy';
import type { ActionKey as PolicyActionKey } from '@pm/contracts';
import { AiGatewayService } from '../ai/ai-gateway-service.ts';
import { NotificationFanOut } from '../notify/fanout.ts';
import { localToUtc, occurrences, parseRule, utcToLocal } from '../recurrence.ts';
import { isPublic, PROJECT_FIELDS } from '../validation.ts';
import {
  parseRelationship,
  parseTaskCreate,
  parseTaskMove,
  TASK_FIELDS,
  taskField,
} from '../task-validation.ts';
import { applyFieldMerge, parseMerge } from '@pm/tenancy';
import type { LoadedTask } from '../task-core.ts';
import {
  ACTION_MATRIX,
  actionClass,
  canonical,
  compileDefinition,
  DefinitionError,
  INTEGRATION_SOURCE_KINDS,
  TRIGGERS,
  triggerEvents,
  type ActionNode,
  type Compiled,
  type Condition,
  type Definition,
  type DefinitionLimits,
  type FailureClass,
  type RecordKind,
  type StepNode,
  type Trigger,
} from './definition.ts';
import {
  addDaysLocal,
  customFieldsOf,
  evaluate,
  InputUnavailable,
  type RecordFacts,
} from './evaluate.ts';
import { STARTER_TEMPLATES, templateDraft } from './templates.ts';

/**
 * Phase 8A automation engine (ADR-0046). One engine on the existing platform: definitions are
 * `automation` records with a draft and immutable revisions; a trigger occurrence becomes one
 * `automation_run` operation pinned to its revision, owner, and scope snapshot; the run executes
 * in the job runtime one fenced step at a time through the canonical domain commands, as the
 * automation acting for its accountable owner. Authority is always the intersection of the
 * declared scope and actions, the owner's current authority, and the trigger record's scope
 * (0C §9.4), rechecked at every step, wake, retry, and rendering. Nothing here writes a business
 * table directly.
 */

export const AUTOMATION_QUEUE = 'automation';
export const AUTOMATION_RUN_JOB = 'automation.run';
export const AUTOMATION_SWEEP_JOB = 'automation.sweep';
/**
 * Automation webhooks are an unsafe destination (ADR-0046 D9): the receiver may act on a payload
 * without deduplicating it, so an ambiguous send is never repeated automatically; it waits for the
 * owner's reconciliation (P8-W0).
 */
export const AUTOMATION_WEBHOOK_DESTINATION = defineEffectDestination(
  'automation.webhook',
  'unsafe',
  'automation-webhook.v1',
);

/** The automation acting inside a run (attribution and lineage; never authority). */
export interface AutomationActor {
  automationId: string;
  automationPublicId: string;
  ownerMembershipId: string;
  runId: string;
  operationId: string;
  attemptId?: string;
}
type AutomationCaller = Caller & { automation?: AutomationActor };

const OPEN: AutomationRunStatus[] = ['queued', 'running', 'waiting'];
const TERMINAL_RUN: ReadonlySet<string> = new Set([
  'succeeded',
  'partial',
  'failed',
  'policy_rejected',
  'cancelled',
  'skipped',
]);
const RUN_JOB_ATTEMPTS = 5;
const RUN_JOB_TIMEOUT_SECONDS = 300;
const RUNS_PAGE_MAX = 50;
const NIL = '00000000-0000-7000-8000-000000000000';

/** Bounded, content-free failure codes (step history and run reasons). */
type StepFailure = { cls: FailureClass | 'error' | 'limit_exceeded'; code: string };

class StepRefused extends Error {
  readonly failure: StepFailure;
  constructor(cls: StepFailure['cls'], code: string) {
    super(`automation step refused: ${cls}/${code}`);
    this.name = 'StepRefused';
    this.failure = { cls, code };
  }
}

/** The stored draft: an untrusted definition and the declared scope (public ids). */
interface Draft {
  definition: unknown;
  scope: { brands: string[]; projects: string[] };
}

interface AutomationRow {
  id: string;
  public_id: string;
  brand_id: string | null;
  lifecycle_state: string;
  name: string;
  description: string | null;
  owner_membership_id: string;
  enabled: boolean;
  active_revision_id: string | null;
  trigger_kind: string | null;
  trigger_event: string | null;
  activated_at: Date | null;
  draft: Draft;
  draft_base_revision: number | null;
  template_key: string | null;
  suspended_reason: string | null;
  suspended_at: Date | null;
  active_runs: number;
  consecutive_failures: number;
  alerted_at: Date | null;
  created_at: Date;
  updated_at: Date;
  version: number;
}

interface RevisionRow {
  id: string;
  automation_id: string;
  revision_number: number;
  definition: Definition;
  definition_hash: string;
  trigger_kind: string;
  record_kind: RecordKind | null;
  declared_brand_ids: string[];
  declared_project_ids: string[];
  action_keys: string[];
  action_classes: string[];
  created_at: Date;
}

interface RunRow {
  id: string;
  automation_id: string;
  revision_id: string;
  operation_id: string;
  current_operation_id: string;
  owner_membership_id: string;
  trigger_kind: string;
  trigger_key: string;
  trigger_event_id: string | null;
  trigger_record_id: string | null;
  root_causation_id: string | null;
  lineage: string[];
  chain_depth: number;
  scope_snapshot: {
    brands: string[];
    projects: string[];
    epochs: { workspace: number; principal: number };
  };
  run_day: string;
  timezone: string;
  status: AutomationRunStatus;
  reason: string | null;
  cursor: string | null;
  wake_at: Date | null;
  steps_executed: number;
  retry_count: number;
  usage_state: string;
  slot_held: boolean;
  initiated_by_membership_id: string | null;
  created_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  version: number;
}

/** One unit of run progress, decided inside a fenced step transaction. */
type Advance =
  | { kind: 'continue' }
  | { kind: 'done'; result: JobResult }
  | { kind: 'fail'; errorClass: 'authorization' | 'policy' | 'deterministic'; code: string }
  | { kind: 'cancel' }
  | {
      kind: 'effect';
      node: string;
      logicalKey: string;
      subscriptionId: string;
      fingerprint: string;
      envelope: Record<string, unknown>;
    };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const monthStart = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;

/**
 * The risk label of an automation's operations: 0C has one automation execution action (R2, no
 * step-up), whether a run is triggered or started by hand.
 */
const AUTOMATION_RUN_ACTION = 'automation.run_manual';

export class AutomationService extends AiGatewayService {
  // ---------------------------------------------------------------------------------------------
  // Attribution: under an automation caller, every canonical command records the automation as
  // the actor on behalf of its accountable owner, and carries the run's operation as causation.
  // ---------------------------------------------------------------------------------------------

  protected override exec(caller: Caller, p: Principal): ExecutionContext {
    const base = super.exec(caller, p);
    const a = (caller as AutomationCaller).automation;
    if (!a) return base;
    const principal = { type: 'automation' as const, id: a.automationId };
    return {
      ...base,
      authenticatedPrincipal: principal,
      effectivePrincipal: principal,
      initiatingMembershipId: a.ownerMembershipId,
      delegationChain: [
        { type: 'member', id: a.ownerMembershipId },
        { type: 'automation', id: a.automationId },
      ],
      operationId: a.operationId,
      ...(a.attemptId ? { attemptId: a.attemptId } : {}),
      causationId: a.operationId,
      dataClassLimit: 'C2',
    };
  }

  protected override cmd(caller: Caller, p: Principal, brandId: string | null = null) {
    const a = (caller as AutomationCaller).automation;
    if (!a) return super.cmd(caller, p, brandId);
    return CommandContext.fromExecution(
      this.exec(caller, p),
      { kind: 'automation', ref: a.automationPublicId },
      { brandId },
    );
  }

  get automationLimits(): DefinitionLimits {
    return {
      definitionBytesMax: this.ws.automationDefinitionBytesMax,
      nodesMax: this.ws.automationNodesMax,
      conditionDepthMax: this.ws.automationConditionDepthMax,
      conditionsMax: this.ws.automationConditionsMax,
      targetFanoutMax: this.ws.automationTargetFanoutMax,
      delayHorizonMinutes: this.ws.automationDelayHorizonMinutes,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Loading and deciding
  // ---------------------------------------------------------------------------------------------

  async #brandFacts(tx: WorkspaceTransaction, brandId: string): Promise<BrandFacts | null> {
    const b = await tx.db
      .selectFrom('tenancy.brand')
      .select(['id', 'is_sensitive', 'lifecycle_state'])
      .where('id', '=', brandId)
      .executeTakeFirst();
    return b ? { id: b.id, isSensitive: b.is_sensitive, lifecycleState: b.lifecycle_state } : null;
  }

  /** The automation's own scope decision: its brand, or the workspace for workspace automations. */
  async #decideScope(
    tx: WorkspaceTransaction,
    p: Principal,
    action: PolicyActionKey,
    brandId: string | null,
  ) {
    if (p.kind === 'guest') return { allowed: false as const, code: 'not_found' as const };
    if (brandId === null) return decideWorkspace(p, action);
    const facts = await this.#brandFacts(tx, brandId);
    if (!facts) return { allowed: false as const, code: 'not_found' as const };
    return decideBrand(p, action, facts);
  }

  async #rows(tx: WorkspaceTransaction, where: { publicId?: string; id?: string }, lock = false) {
    let q = tx.db
      .selectFrom('automation.automation as a')
      .innerJoin('core.record as r', 'r.id', 'a.id')
      .selectAll('a')
      .select('r.public_id');
    if (where.publicId) q = q.where('r.public_id', '=', where.publicId);
    if (where.id) q = q.where('a.id', '=', where.id);
    if (lock) q = q.forUpdate('a');
    const row = await q.executeTakeFirst();
    if (!row) return null;
    return {
      ...row,
      version: Number(row.version),
      draft: row.draft as unknown as Draft,
    } as unknown as AutomationRow;
  }

  /**
   * A visible automation for a person: configurers and health viewers of its scope. Anything
   * else (another tenant, a guest, an unreadable brand) is the same `not_found`.
   */
  async #visible(
    tx: WorkspaceTransaction,
    p: Principal,
    publicId: unknown,
    opts: { lock?: boolean; need?: 'view' | 'configure' | 'run' } = {},
  ): Promise<AutomationRow> {
    if (!isPublic(publicId, 'auto')) throw new TenancyError('not_found');
    const row = await this.#rows(tx, { publicId }, opts.lock);
    if (!row || row.lifecycle_state === 'purged' || row.lifecycle_state === 'trashed')
      throw new TenancyError('not_found');
    const configure = await this.#decideScope(tx, p, 'automations.configure', row.brand_id);
    const health = await this.#decideScope(tx, p, 'health.view', row.brand_id);
    if (!configure.allowed && !health.allowed) throw new TenancyError('not_found');
    const need = opts.need ?? 'view';
    if (need === 'configure' && !configure.allowed) throw new TenancyError('forbidden');
    if (need === 'run') {
      const run = await this.#decideScope(tx, p, 'automation.run_manual', row.brand_id);
      if (!run.allowed) throw new TenancyError('forbidden');
    }
    this.decision('automations.configure', configure);
    return row;
  }

  async #revision(tx: WorkspaceTransaction, id: string): Promise<RevisionRow> {
    const r = await tx.db
      .selectFrom('automation.automation_revision')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return r as unknown as RevisionRow;
  }

  async #publicIds(tx: WorkspaceTransaction, ids: readonly string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = await tx.db
      .selectFrom('core.record')
      .select(['id', 'public_id'])
      .where('id', 'in', [...new Set(ids)])
      .execute();
    return new Map(rows.map((r) => [r.id, r.public_id]));
  }

  async #internalIds(
    tx: WorkspaceTransaction,
    publicIds: readonly string[],
    type: string,
  ): Promise<Map<string, string>> {
    if (!publicIds.length) return new Map();
    const rows = await tx.db
      .selectFrom('core.record')
      .select(['id', 'public_id', 'lifecycle_state'])
      .where('public_id', 'in', [...new Set(publicIds)])
      .where('record_type', '=', type)
      .execute();
    return new Map(
      rows.filter((r) => r.lifecycle_state !== 'purged').map((r) => [r.public_id, r.id]),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------------------------

  async #memberRef(tx: WorkspaceTransaction, id: string | null) {
    if (!id) return null;
    const m = await tx.db
      .selectFrom('tenancy.membership as m')
      .innerJoin('identity.account as acc', 'acc.id', 'm.account_id')
      .select(['m.public_id', 'm.display_name_override', 'acc.display_name', 'm.state'])
      .where('m.id', '=', id)
      .executeTakeFirst();
    return m
      ? {
          id: m.public_id,
          name: m.display_name_override ?? m.display_name,
          active: m.state === 'active',
        }
      : null;
  }

  async #automationView(tx: WorkspaceTransaction, p: Principal, a: AutomationRow) {
    const configure = (await this.#decideScope(tx, p, 'automations.configure', a.brand_id)).allowed;
    const run = (await this.#decideScope(tx, p, 'automation.run_manual', a.brand_id)).allowed;
    const brand = a.brand_id ? await this.projectBrandRow(tx, a.brand_id) : null;
    const revision = a.active_revision_id ? await this.#revision(tx, a.active_revision_id) : null;
    const latest = await tx.db
      .selectFrom('automation.automation_revision')
      .select((eb) => eb.fn.max('revision_number').as('n'))
      .where('automation_id', '=', a.id)
      .executeTakeFirst();
    let draftStatus: {
      valid: boolean;
      issues: Array<{ pointer: string; code: string; message: string }>;
      unavailable: Array<{ pointer: string; code: string; owner: string }>;
      actions: string[];
      outbound: Array<{ node: string; webhook: string; fields: string[] }>;
      matches_active: boolean;
    };
    try {
      const c = compileDefinition(a.draft.definition, this.automationLimits);
      draftStatus = {
        valid: true,
        issues: [],
        unavailable: c.unavailable,
        actions: c.actions,
        outbound: c.outbound,
        matches_active:
          !!revision &&
          sha256(c.canonical + canonical(this.#scopeKey(a.draft))) === revision.definition_hash,
      };
    } catch (err) {
      if (!(err instanceof DefinitionError)) throw err;
      draftStatus = {
        valid: false,
        issues: err.issues,
        unavailable: [],
        actions: [],
        outbound: [],
        matches_active: false,
      };
    }
    const last = await tx.db
      .selectFrom('automation.automation_run as r')
      .innerJoin('exec.operation as o', 'o.id', 'r.current_operation_id')
      .select(['o.public_id', 'r.status', 'r.reason', 'o.execution_state', 'r.created_at'])
      .where('r.automation_id', '=', a.id)
      .orderBy('r.created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    const state =
      a.lifecycle_state === 'archived'
        ? 'archived'
        : a.suspended_reason
          ? 'suspended'
          : a.enabled
            ? 'active'
            : 'disabled';
    return {
      id: a.public_id,
      type: 'automation' as const,
      name: a.name,
      description: a.description,
      scope: brand
        ? { kind: 'brand' as const, brand: { id: brand.public_id, name: brand.name } }
        : { kind: 'workspace' as const },
      owner: await this.#memberRef(tx, a.owner_membership_id),
      state,
      enabled: a.enabled,
      suspended_reason: a.suspended_reason,
      trigger_kind: revision?.trigger_kind ?? null,
      active_revision: revision?.revision_number ?? null,
      latest_revision: latest?.n ? Number(latest.n) : null,
      template: a.template_key,
      draft: { definition: a.draft.definition, scope: a.draft.scope },
      draft_status: draftStatus,
      last_run: last
        ? {
            id: last.public_id,
            status: this.#displayStatus(last.status, last.execution_state),
            reason: last.reason,
            created_at: new Date(last.created_at).toISOString(),
          }
        : null,
      failures_in_a_row: a.consecutive_failures,
      capabilities: {
        configure: configure && a.lifecycle_state === 'active',
        run: run && a.enabled,
        activate: configure && a.lifecycle_state === 'active' && !a.enabled,
      },
      created_at: new Date(a.created_at).toISOString(),
      updated_at: new Date(a.updated_at).toISOString(),
      version: a.version,
    };
  }

  /** A run's status for display: the run's own terminal outcome, else its operation's state. */
  #displayStatus(status: string, opState: string): string {
    if (TERMINAL_RUN.has(status)) return status;
    if (isTerminalState(opState as never)) return opState === 'succeeded' ? 'running' : opState;
    return status;
  }

  #scopeKey(d: Draft) {
    return {
      brands: [...(d.scope?.brands ?? [])].sort(),
      projects: [...(d.scope?.projects ?? [])].sort(),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Configuration commands (AUTO-001, AUTO-002, AUTO-013)
  // ---------------------------------------------------------------------------------------------

  async listAutomations(caller: Caller, ws: unknown, query: Record<string, unknown> = {}) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      if (p.kind === 'guest') throw new TenancyError('not_found');
      const rows = await tx.db
        .selectFrom('automation.automation as a')
        .innerJoin('core.record as r', 'r.id', 'a.id')
        .selectAll('a')
        .select('r.public_id')
        .where('a.lifecycle_state', 'in', query.archived === 'true' ? ['archived'] : ['active'])
        .orderBy('a.name')
        .orderBy('a.id')
        .limit(this.ws.automationsPerWorkspaceMax)
        .execute();
      const items = [];
      for (const r of rows) {
        const row = {
          ...r,
          version: Number(r.version),
          draft: r.draft as unknown as Draft,
        } as unknown as AutomationRow;
        const c = await this.#decideScope(tx, p, 'automations.configure', row.brand_id);
        const h = await this.#decideScope(tx, p, 'health.view', row.brand_id);
        if (!c.allowed && !h.allowed) continue;
        items.push(await this.#automationView(tx, p, row));
      }
      const configurable = await this.#configurableScopes(tx, p);
      return {
        data: items,
        page: { next_cursor: null },
        capabilities: {
          create: configurable.workspace || configurable.brands.length > 0,
          workspace_scope: configurable.workspace,
        },
      };
    });
  }

  async #configurableScopes(tx: WorkspaceTransaction, p: Principal) {
    const brands = await tx.db
      .selectFrom('tenancy.brand as b')
      .innerJoin('core.record as r', 'r.id', 'b.id')
      .select(['b.id', 'r.public_id', 'b.name', 'b.is_sensitive', 'b.lifecycle_state'])
      .where('b.lifecycle_state', '=', 'active')
      .orderBy('b.name')
      .execute();
    return {
      workspace: p.kind === 'member' && decideWorkspace(p, 'automations.configure').allowed,
      brands: brands
        .filter(
          (b) =>
            p.kind === 'member' &&
            decideBrand(p, 'automations.configure', {
              id: b.id,
              isSensitive: b.is_sensitive,
              lifecycleState: b.lifecycle_state,
            }).allowed,
        )
        .map((b) => ({ id: b.public_id, name: b.name })),
    };
  }

  async getAutomation(caller: Caller, ws: unknown, aut: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) =>
      this.#automationView(tx, p, await this.#visible(tx, p, aut)),
    );
  }

  listAutomationTemplates() {
    return {
      data: STARTER_TEMPLATES.map((t) => ({
        key: t.key,
        name: t.name,
        description: t.description,
        needs: t.needs,
        trigger_kind: t.trigger,
      })),
    };
  }

  /** Creates a disabled automation with a draft (blank or from a starter template). */
  async createAutomation(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    for (const k of Object.keys(b))
      if (
        !['name', 'description', 'scope', 'template', 'template_values', 'definition'].includes(k)
      )
        throw invalid(issue(`/${k}`, 'unknown_field', 'This field is not accepted.'));
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 120)
      throw invalid(issue('/name', 'invalid_length', 'Enter a name of 1 to 120 characters.'));
    const description =
      b.description === undefined || b.description === null ? null : String(b.description);
    if (description !== null && description.length > 1000)
      throw invalid(issue('/description', 'invalid_length', 'Use up to 1000 characters.'));
    return this.mutate(
      caller,
      'automation.create',
      ws,
      req,
      async (tx, p) => {
        if (p.kind !== 'member') throw new TenancyError('forbidden');
        const scope = await this.#parseScope(tx, p, b.scope);
        const count = await tx.db
          .selectFrom('automation.automation')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('lifecycle_state', '<>', 'purged')
          .executeTakeFirstOrThrow();
        if (Number(count.n) >= this.ws.automationsPerWorkspaceMax)
          throw new TenancyError('conflict', {
            issues: [
              issue(
                '/',
                'limit_reached',
                `A workspace has at most ${this.ws.automationsPerWorkspaceMax} automations.`,
              ),
            ],
          });
        let definition: unknown = b.definition ?? null;
        let templateKey: string | null = null;
        if (b.template !== undefined) {
          const made = templateDraft(b.template, b.template_values, scope);
          if (!made)
            throw invalid(issue('/template', 'invalid_option', 'Choose a starter template.'));
          definition = made.definition;
          templateKey = made.key;
        }
        const draft: Draft = {
          definition: definition ?? { schema_version: 1 },
          scope: { brands: scope.brandPublicIds, projects: [] },
        };
        const id = newUuidV7();
        const publicId = newPublicId('auto');
        const cmd = this.cmd(caller, p, scope.brandId);
        await tx.db
          .insertInto('core.record')
          .values({
            id,
            public_id: publicId,
            record_type: 'automation',
            workspace_id: tx.workspaceId,
            brand_id: scope.brandId,
            source_kind: templateKey ? 'template' : 'ui',
            source_ref: null,
            created_by_actor_type: cmd.actor.type,
            created_by_actor_id: cmd.actor.id,
          })
          .execute();
        await tx.db
          .insertInto('automation.automation')
          .values({
            id,
            workspace_id: tx.workspaceId,
            brand_id: scope.brandId,
            scope_key: scope.brandId ?? tx.workspaceId,
            name,
            description,
            owner_membership_id: p.membershipId,
            draft: JSON.stringify(draft),
            template_key: templateKey,
            created_by_membership_id: p.membershipId,
          })
          .execute();
        await this.workAudit(
          tx,
          caller,
          p,
          'automation.created',
          { recordId: id, type: 'automation', publicId },
          [change.plain('name', null, name), change.plain('template', null, templateKey)],
          scope.brandId,
        );
        const row = (await this.#rows(tx, { id }))!;
        return {
          status: 201,
          ref: { id: publicId, type: 'automation' },
          data: await this.#automationView(tx, p, row),
        };
      },
      async (tx, p, ref) => this.#automationView(tx, p, await this.#visible(tx, p, ref.id)),
    );
  }

  /**
   * Scope: a brand (`{kind:'brand', brand}`) or the workspace with an explicit brand list
   * (`{kind:'workspace', brands}`); workspace scope is never all-brands authority. The person
   * needs `automations.configure` there.
   */
  async #parseScope(tx: WorkspaceTransaction, p: Principal, raw: unknown) {
    const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (s.kind === 'brand') {
      if (!isPublic(s.brand, 'br'))
        throw invalid(issue('/scope/brand', 'invalid_reference', 'Choose a brand.'));
      const brand = await this.#brandByPublic(tx, s.brand);
      if (!brand) throw invalid(issue('/scope/brand', 'invalid_reference', 'Choose a brand.'));
      const o = decideBrand(p, 'automations.configure', brand.facts);
      if (!o.allowed)
        throw invalid(
          issue('/scope/brand', 'invalid_reference', 'Choose a brand you can configure.'),
        );
      return { brandId: brand.facts.id, brandPublicIds: [s.brand] };
    }
    if (s.kind === 'workspace') {
      if (!decideWorkspace(p, 'automations.configure').allowed) throw new TenancyError('forbidden');
      const list = Array.isArray(s.brands) ? s.brands : [];
      if (list.length < 1 || list.length > 100 || list.some((x) => !isPublic(x, 'br')))
        throw invalid(
          issue(
            '/scope/brands',
            'required',
            'List the brands this workspace automation may act in.',
          ),
        );
      return { brandId: null, brandPublicIds: [...new Set(list as string[])].sort() };
    }
    throw invalid(issue('/scope', 'required', 'Choose a brand or the workspace.'));
  }

  async #brandByPublic(tx: WorkspaceTransaction, publicId: string) {
    const b = await tx.db
      .selectFrom('tenancy.brand as b')
      .innerJoin('core.record as r', 'r.id', 'b.id')
      .select(['b.id', 'b.is_sensitive', 'b.lifecycle_state', 'r.public_id', 'b.name'])
      .where('r.public_id', '=', publicId)
      .executeTakeFirst();
    if (!b || b.lifecycle_state !== 'active') return null;
    return {
      facts: { id: b.id, isSensitive: b.is_sensitive, lifecycleState: b.lifecycle_state },
      publicId: b.public_id,
      name: b.name,
    };
  }

  /** Edits the draft (never an active revision), name, or description, with If-Match. */
  async updateAutomation(caller: Caller, ws: unknown, aut: unknown, body: unknown, req: Mutation) {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    for (const k of Object.keys(b))
      if (!['name', 'description', 'definition', 'scope'].includes(k))
        throw invalid(issue(`/${k}`, 'unknown_field', 'This field is not accepted.'));
    return this.mutate(
      caller,
      'automation.update',
      ws,
      req,
      async (tx, p) => {
        const a = await this.#visible(tx, p, aut, { lock: true, need: 'configure' });
        if (a.lifecycle_state !== 'active')
          throw new TenancyError('conflict', {
            issues: [issue('/', 'automation_archived', 'Restore this automation to edit it.')],
          });
        if (req.ifMatch === undefined) throw new TenancyError('precondition_required');
        requireVersion(parseIfMatch(req.ifMatch), a.version);
        const set: Record<string, unknown> = {};
        const changes: ReturnType<typeof change.plain>[] = [];
        if (b.name !== undefined) {
          const n = typeof b.name === 'string' ? b.name.trim() : '';
          if (!n || n.length > 120)
            throw invalid(issue('/name', 'invalid_length', 'Enter a name of 1 to 120 characters.'));
          set.name = n;
          changes.push(change.plain('name', a.name, n));
        }
        if (b.description !== undefined) {
          const d = b.description === null ? null : String(b.description);
          if (d !== null && d.length > 1000)
            throw invalid(issue('/description', 'invalid_length', 'Use up to 1000 characters.'));
          set.description = d;
        }
        if (b.definition !== undefined || b.scope !== undefined) {
          const draft: Draft = {
            definition: b.definition !== undefined ? b.definition : a.draft.definition,
            scope: a.draft.scope,
          };
          if (b.scope !== undefined) {
            const sc = (b.scope && typeof b.scope === 'object' ? b.scope : {}) as Record<
              string,
              unknown
            >;
            const projects = Array.isArray(sc.projects) ? sc.projects : [];
            if (projects.length > 100 || projects.some((x) => !isPublic(x, 'prj')))
              throw invalid(
                issue('/scope/projects', 'invalid_reference', 'Choose up to 100 projects.'),
              );
            let brands = draft.scope.brands;
            if (a.brand_id === null) {
              const parsed = await this.#parseScope(tx, p, {
                kind: 'workspace',
                brands: sc.brands,
              });
              brands = parsed.brandPublicIds;
            } else if (sc.brands !== undefined) {
              throw invalid(
                issue(
                  '/scope/brands',
                  'not_applicable',
                  'A brand automation acts in its own brand.',
                ),
              );
            }
            draft.scope = { brands, projects: [...new Set(projects as string[])].sort() };
          }
          const size = Buffer.byteLength(JSON.stringify(draft), 'utf8');
          if (size > this.ws.automationDefinitionBytesMax * 2)
            throw invalid(
              issue(
                '/definition',
                'too_large',
                'This automation is too large. Split it into smaller automations.',
              ),
            );
          set.draft = JSON.stringify(draft);
          changes.push(change.plain('draft', null, sha256(canonical(draft)).slice(0, 16)));
        }
        if (!Object.keys(set).length)
          return {
            status: 200,
            ref: { id: a.public_id, type: 'automation' },
            data: await this.#automationView(tx, p, a),
          };
        await tx.db
          .updateTable('automation.automation')
          .set({
            ...set,
            updated_at: new Date(),
            updated_by_membership_id: p.membershipId,
            version: sql`version + 1`,
          })
          .where('id', '=', a.id)
          .execute();
        await tx.db
          .updateTable('core.record')
          .set({ version: sql`version + 1` })
          .where('id', '=', a.id)
          .execute();
        await this.workAudit(
          tx,
          caller,
          p,
          'automation.updated',
          { recordId: a.id, type: 'automation', publicId: a.public_id },
          changes,
          a.brand_id,
        );
        return {
          status: 200,
          ref: { id: a.public_id, type: 'automation' },
          data: await this.#automationView(tx, p, (await this.#rows(tx, { id: a.id }))!),
        };
      },
      async (tx, p, ref) => this.#automationView(tx, p, await this.#visible(tx, p, ref.id)),
    );
  }

  /**
   * Resolves and authorizes a compiled draft for a principal (the activator, the owner, or a
   * preview viewer): the declared brands and projects, every referenced record, and grantable
   * authority for each declared action in each declared brand (0C §9.4, I-11).
   */
  async #resolveDraft(
    tx: WorkspaceTransaction,
    who: Principal,
    a: AutomationRow,
    c: Compiled,
    mode: 'activation' | 'preview',
  ) {
    const issues: Array<ReturnType<typeof issue>> = [];
    const brandIds = await this.#internalIds(tx, a.draft.scope?.brands ?? [], 'brand');
    const brands: BrandFacts[] = [];
    for (const pub of a.draft.scope?.brands ?? []) {
      const id = brandIds.get(pub);
      const facts = id ? await this.#brandFacts(tx, id) : null;
      if (!facts || facts.lifecycleState !== 'active' || (a.brand_id && id !== a.brand_id)) {
        issues.push(
          issue(
            '/scope/brands',
            'invalid_reference',
            'Choose active brands in this automation’s scope.',
          ),
        );
        continue;
      }
      brands.push(facts);
    }
    if (!brands.length)
      issues.push(issue('/scope/brands', 'required', 'Choose at least one brand.'));
    for (const b of brands) {
      if (!decideBrand(who, 'automations.configure', b).allowed)
        issues.push(
          issue(
            '/scope/brands',
            'not_grantable',
            'You cannot configure automations in one of the declared brands.',
          ),
        );
      for (const action of c.actions) {
        const def = ACTION_MATRIX[action];
        if (def.status !== 'supported') continue;
        // Record-only actions (assign, relate) are granted through edit authority on the brand;
        // notifying needs only that the records are readable there.
        const perm = def.permission as PolicyActionKey;
        const brandPerm: PolicyActionKey = (actionDef(perm).scopes as readonly string[]).includes(
          'brand',
        )
          ? perm === 'record.read'
            ? 'record.read'
            : perm
          : 'record.update';
        const ok = decideBrand(who, brandPerm, b).allowed;
        if (!ok)
          issues.push(
            issue(
              '/steps',
              'not_grantable',
              `You cannot grant “${action}” in one of the declared brands.`,
            ),
          );
      }
    }
    const projects = await this.#internalIds(tx, a.draft.scope?.projects ?? [], 'project');
    const declaredProjects: string[] = [];
    for (const pub of a.draft.scope?.projects ?? []) {
      const id = projects.get(pub);
      if (!id) {
        issues.push(issue('/scope/projects', 'invalid_reference', 'Choose projects you can see.'));
        continue;
      }
      try {
        const pr = await this.loadProject(tx, who, pub);
        if (!brands.some((b) => b.id === pr.brand.id)) throw new TenancyError('not_found');
        declaredProjects.push(pr.id);
      } catch (err) {
        if (!(err instanceof TenancyError)) throw err;
        issues.push(issue('/scope/projects', 'invalid_reference', 'Choose projects you can see.'));
      }
    }
    // Referenced records: each must be readable now, inside the declared scope.
    const refCheck = async (pubs: Set<string>, kind: 'project' | 'task', pointer: string) => {
      for (const pub of pubs) {
        try {
          const r =
            kind === 'project'
              ? await this.loadProject(tx, who, pub)
              : await this.loadTask(tx, who, pub);
          if (!brands.some((b) => b.id === r.brand.id)) throw new TenancyError('not_found');
        } catch (err) {
          if (!(err instanceof TenancyError)) throw err;
          issues.push(
            issue(
              pointer,
              'invalid_reference',
              'A referenced record is not available in this scope.',
            ),
          );
        }
      }
    };
    await refCheck(c.refs.projects, 'project', '/steps');
    await refCheck(c.refs.tasks, 'task', '/steps');
    for (const m of c.refs.members) {
      const row = await tx.db
        .selectFrom('tenancy.membership')
        .select(['kind', 'state'])
        .where('public_id', '=', m)
        .executeTakeFirst();
      if (!row || row.kind !== 'member' || row.state !== 'active')
        issues.push(issue('/steps', 'invalid_reference', 'Choose active members.'));
    }
    for (const l of c.refs.labels) {
      const row = await tx.db
        .selectFrom('work.label')
        .select(['brand_id', 'state'])
        .where('public_id', '=', l)
        .executeTakeFirst();
      if (!row || row.state !== 'active' || !brands.some((b) => b.id === row.brand_id))
        issues.push(issue('/steps', 'invalid_reference', 'Choose labels of the declared brands.'));
    }
    for (const f of c.refs.fields) {
      const row = await tx.db
        .selectFrom('workflow.field_definition')
        .select(['state'])
        .where('public_id', '=', f)
        .executeTakeFirst();
      if (!row || row.state !== 'active')
        issues.push(issue('/conditions', 'invalid_reference', 'Choose an active custom field.'));
    }
    const webhooks = new Map<string, { id: string; fingerprint: string }>();
    for (const w of c.refs.webhooks) {
      const d = await this.automationWebhookDestination(tx, w);
      const brandOk =
        d &&
        (d.brandId === null
          ? decideWorkspace(who, 'webhooks.manage').allowed
          : brands.some((b) => b.id === d.brandId) &&
            decideBrand(who, 'webhooks.manage', (await this.#brandFacts(tx, d.brandId))!).allowed);
      if (!d || d.state !== 'active' || d.lifecycleState !== 'active' || !brandOk)
        issues.push(issue('/steps', 'invalid_reference', 'Choose an active webhook you manage.'));
      else webhooks.set(w, { id: d.id, fingerprint: d.fingerprint });
    }
    if (mode === 'activation' && issues.length) throw invalid(...issues);
    return { brands, declaredProjects, webhooks, issues };
  }

  /**
   * Activation (AUTO-013, 0C §9.4): selects an immutable revision of the current draft after
   * permission, grantability (the activator's and the owner's), limits, and outbound standing
   * approval checks. Unavailable triggers and actions are refused with their owning phase.
   */
  async activateAutomation(
    caller: Caller,
    ws: unknown,
    aut: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    return this.mutate(
      caller,
      'automation.activate',
      ws,
      req,
      async (tx, p) => {
        const a = await this.#visible(tx, p, aut, { lock: true, need: 'configure' });
        if (p.kind !== 'member' || caller.delegation) throw new TenancyError('forbidden');
        if (a.lifecycle_state !== 'active')
          throw new TenancyError('conflict', {
            issues: [issue('/', 'automation_archived', 'Restore this automation first.')],
          });
        if (req.ifMatch !== undefined) requireVersion(parseIfMatch(req.ifMatch), a.version);
        let c: Compiled;
        try {
          c = compileDefinition(a.draft.definition, this.automationLimits);
        } catch (err) {
          if (err instanceof DefinitionError)
            throw invalid(
              ...err.issues.map((i) =>
                issue(`/definition${i.pointer === '/' ? '' : i.pointer}`, i.code, i.message),
              ),
            );
          throw err;
        }
        if (c.unavailable.length)
          throw new TenancyError('dependency_unavailable', {
            issues: c.unavailable.map((u) =>
              issue(
                `/definition${u.pointer}`,
                u.code,
                `This is not available yet; it arrives with phase ${u.owner}.`,
              ),
            ),
          });
        const resolved = await this.#resolveDraft(tx, p, a, c, 'activation');
        // The accountable owner's own grantability (a configurer never lends authority).
        const owner = await this.#ownerPrincipal(tx, a.owner_membership_id);
        if (!owner)
          throw new TenancyError('conflict', {
            issues: [issue('/owner', 'owner_unavailable', 'Assign an active owner first.')],
          });
        if (owner.membershipId !== p.membershipId) {
          const ownerCheck = await this.#resolveDraft(tx, owner, a, c, 'preview');
          if (ownerCheck.issues.length)
            throw new TenancyError('conflict', {
              issues: [
                issue(
                  '/owner',
                  'owner_not_grantable',
                  'The owner cannot grant this automation’s actions in its scope.',
                ),
              ],
            });
        }
        // R3 outbound: the exact destination and field set, approved now under step-up.
        const approvals: Array<{
          node: string;
          subscriptionId: string;
          fingerprint: string;
          fields: string[];
        }> = [];
        if (c.outbound.length) {
          const given = Array.isArray(b.approvals)
            ? (b.approvals as Array<Record<string, unknown>>)
            : [];
          for (const o of c.outbound) {
            const g = given.find((x) => x.node === o.node);
            const fields = Array.isArray(g?.fields) ? [...(g!.fields as string[])].sort() : null;
            if (
              !g ||
              g.webhook !== o.webhook ||
              !fields ||
              canonical(fields) !== canonical(o.fields)
            )
              throw new TenancyError('conflict', {
                issues: [
                  issue(
                    `/approvals`,
                    'approval_required',
                    'Approve each webhook step’s destination and fields to activate.',
                  ),
                ],
              });
            const dest = resolved.webhooks.get(o.webhook)!;
            approvals.push({
              node: o.node,
              subscriptionId: dest.id,
              fingerprint: dest.fingerprint,
              fields,
            });
          }
        }
        const stepUpId = approvals.length
          ? await this.stepUp(tx, caller, p, req, 'webhooks.manage', {
              type: 'automation',
              id: a.public_id,
            })
          : null;
        // Immutable revision: reuse the latest when the draft and scope are unchanged.
        const scopeKey = canonical({
          brands: resolved.brands.map((x) => x.id).sort(),
          projects: [...resolved.declaredProjects].sort(),
        });
        const hash = sha256(c.canonical + canonical(this.#scopeKey(a.draft)));
        const latest = await tx.db
          .selectFrom('automation.automation_revision')
          .selectAll()
          .where('automation_id', '=', a.id)
          .orderBy('revision_number', 'desc')
          .limit(1)
          .executeTakeFirst();
        let revisionId: string;
        let revisionNumber: number;
        if (latest && latest.definition_hash === hash) {
          revisionId = latest.id;
          revisionNumber = latest.revision_number;
        } else {
          revisionId = newUuidV7();
          revisionNumber = (latest?.revision_number ?? 0) + 1;
          await tx.db
            .insertInto('automation.automation_revision')
            .values({
              id: revisionId,
              workspace_id: tx.workspaceId,
              automation_id: a.id,
              revision_number: revisionNumber,
              schema_version: 1,
              definition: JSON.stringify(c.definition),
              definition_hash: hash,
              trigger_kind: c.definition.trigger.kind,
              record_kind: c.recordKind,
              declared_brand_ids: resolved.brands.map((x) => x.id).sort(),
              declared_project_ids: [...resolved.declaredProjects].sort(),
              action_keys: c.actions,
              action_classes: c.classes,
              created_by_membership_id: p.membershipId,
            })
            .execute();
        }
        // Approvals belong to exactly one revision: older ones are superseded, new ones recorded.
        await tx.db
          .updateTable('automation.standing_approval')
          .set({ state: 'superseded', ended_at: new Date() })
          .where('automation_id', '=', a.id)
          .where('state', '=', 'active')
          .execute();
        for (const ap of approvals)
          await tx.db
            .insertInto('automation.standing_approval')
            .values({
              id: newUuidV7(),
              workspace_id: tx.workspaceId,
              automation_id: a.id,
              revision_id: revisionId,
              node_id: ap.node,
              subscription_id: ap.subscriptionId,
              destination_fingerprint: ap.fingerprint,
              field_set: ap.fields,
              scope_hash: sha256(scopeKey),
              action_class: 'outbound.webhook',
              approved_by_membership_id: p.membershipId,
              step_up_id: stepUpId!,
            })
            .execute();
        const trigger = c.definition.trigger;
        await tx.db
          .updateTable('automation.automation')
          .set({
            enabled: true,
            active_revision_id: revisionId,
            trigger_kind: trigger.kind,
            trigger_event: triggerEvents(trigger)[0] ?? null,
            activated_at: new Date(),
            draft_base_revision: revisionNumber,
            consecutive_failures: 0,
            // A suspension ends only here: a person with authority activated it again, with the
            // owner's grantability checked afresh.
            suspended_reason: null,
            suspended_at: null,
            updated_at: new Date(),
            updated_by_membership_id: p.membershipId,
            version: sql`version + 1`,
          })
          .where('id', '=', a.id)
          .execute();
        await tx.db
          .updateTable('core.record')
          .set({ version: sql`version + 1` })
          .where('id', '=', a.id)
          .execute();
        await this.#scheduleTrigger(tx, a.id, revisionId, trigger, new Date());
        await this.workAudit(
          tx,
          caller,
          p,
          'automation.activated',
          { recordId: a.id, type: 'automation', publicId: a.public_id },
          [
            change.plain('revision', null, revisionNumber),
            change.plain('enabled', false, true),
            change.plain('standing_approvals', null, approvals.length),
          ],
          a.brand_id,
        );
        return {
          status: 200,
          ref: { id: a.public_id, type: 'automation' },
          data: await this.#automationView(tx, p, (await this.#rows(tx, { id: a.id }))!),
        };
      },
      async (tx, p, ref) => this.#automationView(tx, p, await this.#visible(tx, p, ref.id)),
    );
  }

  /** The next due instant of a date or schedule trigger, from `now` (never a backfill). */
  async #scheduleTrigger(
    tx: WorkspaceTransaction,
    automationId: string,
    revisionId: string,
    t: Trigger,
    now: Date,
  ) {
    await tx.db
      .deleteFrom('automation.trigger_schedule')
      .where('automation_id', '=', automationId)
      .execute();
    if (t.kind !== 'schedule' && t.kind !== 'date') return;
    const next = t.kind === 'schedule' ? this.#nextScheduled(t, now) : this.#nextDateSweep(t, now);
    await tx.db
      .insertInto('automation.trigger_schedule')
      .values({
        automation_id: automationId,
        workspace_id: tx.workspaceId,
        revision_id: revisionId,
        kind: t.kind,
        next_due_at: next?.at ?? null,
        last_key: null,
      })
      .execute();
  }

  /** The next schedule occurrence strictly after `after` (stable local key, explicit zone). */
  #nextScheduled(
    t: Extract<Trigger, { kind: 'schedule' }>,
    after: Date,
    afterKey: string | null = null,
  ) {
    const localNow = utcToLocal(after, t.timezone);
    const from = afterKey && afterKey > localNow ? afterKey : localNow;
    const [key] = occurrences(parseRule(t.rule), t.start, from, 1);
    return key ? { key, at: localToUtc(key, t.timezone) } : null;
  }

  /** Date triggers sweep once per local day at their time of day. */
  #nextDateSweep(t: Extract<Trigger, { kind: 'date' }>, after: Date) {
    const local = utcToLocal(after, t.timezone);
    const day = local.slice(0, 10);
    const today = `${day}T${t.at}`;
    const key = today > local ? today : `${addDaysLocal(day, 1)}T${t.at}`;
    return { key, at: localToUtc(key, t.timezone) };
  }

  /** Disable: no new runs; undispatched steps of open runs stop; liability is kept (AUTO-013). */
  async disableAutomation(caller: Caller, ws: unknown, aut: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'automation.disable',
      ws,
      req,
      async (tx, p) => {
        const a = await this.#visible(tx, p, aut, { lock: true, need: 'configure' });
        if (req.ifMatch !== undefined) requireVersion(parseIfMatch(req.ifMatch), a.version);
        const stopped = await this.#stop(tx, a, 'disabled');
        await this.workAudit(
          tx,
          caller,
          p,
          'automation.disabled',
          { recordId: a.id, type: 'automation', publicId: a.public_id },
          [change.plain('enabled', a.enabled, false), change.plain('runs_stopped', null, stopped)],
          a.brand_id,
        );
        return {
          status: 200,
          ref: { id: a.public_id, type: 'automation' },
          data: await this.#automationView(tx, p, (await this.#rows(tx, { id: a.id }))!),
        };
      },
      async (tx, p, ref) => this.#automationView(tx, p, await this.#visible(tx, p, ref.id)),
    );
  }

  /**
   * Stops an automation (disable, suspension, archive): no trigger listens, schedules are removed,
   * and every open run that has not left a possibly-sent effect is cancelled. A run waiting for a
   * reconciliation keeps waiting: what may have left is never relabelled.
   */
  async #stop(
    tx: WorkspaceTransaction,
    a: { id: string },
    why: 'disabled' | 'suspended' | 'archived',
    suspended?: 'owner_authority' | 'owner_departed' | 'admin',
  ): Promise<number> {
    await tx.db
      .updateTable('automation.automation')
      .set({
        enabled: false,
        trigger_event: null,
        ...(suspended ? { suspended_reason: suspended, suspended_at: new Date() } : {}),
        updated_at: new Date(),
        version: sql`version + 1`,
      })
      .where('id', '=', a.id)
      .execute();
    await tx.db
      .updateTable('core.record')
      .set({ version: sql`version + 1` })
      .where('id', '=', a.id)
      .execute();
    await tx.db
      .deleteFrom('automation.trigger_schedule')
      .where('automation_id', '=', a.id)
      .execute();
    const open = await tx.db
      .selectFrom('automation.automation_run')
      .selectAll()
      .where('automation_id', '=', a.id)
      .where('status', 'in', OPEN)
      .forUpdate()
      .execute();
    let n = 0;
    for (const raw of open) {
      const run = raw as unknown as RunRow;
      if (run.status === 'waiting' && run.reason === 'reconciliation_required') continue;
      const op = await tx.db
        .selectFrom('exec.operation')
        .select(['execution_state'])
        .where('id', '=', run.current_operation_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (op.execution_state === 'waiting' || op.execution_state === 'queued') {
        // Nothing is running: the queued (or continuation) job is withdrawn and the run ends now.
        const jobs = await tx.db
          .selectFrom('exec.job')
          .select('id')
          .where('operation_id', '=', run.current_operation_id)
          .where('state', 'in', ['queued', 'retry_scheduled'])
          .execute();
        for (const j of jobs) await requestJobCancel(tx, j.id);
        if ((await uncertainEffects(tx, run.current_operation_id)).length) continue;
        await this.#terminalize(tx, run, 'cancelled', `automation_${why}`);
        await transitionOperation(tx, {
          operationId: run.current_operation_id,
          to: 'cancelled',
          terminalReason: 'user_cancelled',
          actor: { type: 'system' },
          context: await this.#runContext(tx, run),
        });
      } else {
        await requestOperationCancel(tx, run.current_operation_id);
      }
      n++;
    }
    return n;
  }

  async #runContext(tx: WorkspaceTransaction, run: RunRow): Promise<ExecutionContext> {
    const op = await tx.db
      .selectFrom('exec.operation')
      .selectAll()
      .where('id', '=', run.current_operation_id)
      .executeTakeFirstOrThrow();
    return contextFromRow(op as never);
  }

  async enableAutomation(caller: Caller, ws: unknown, aut: unknown, body: unknown, req: Mutation) {
    // Re-enabling activates the current draft again with every check; it never replays history.
    return this.activateAutomation(caller, ws, aut, body, req);
  }

  /** A disabled copy of the draft: no standing approvals, no credentials, the copier as owner. */
  async duplicateAutomation(caller: Caller, ws: unknown, aut: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'automation.duplicate',
      ws,
      req,
      async (tx, p) => {
        const a = await this.#visible(tx, p, aut, { need: 'configure' });
        const count = await tx.db
          .selectFrom('automation.automation')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('lifecycle_state', '<>', 'purged')
          .executeTakeFirstOrThrow();
        if (Number(count.n) >= this.ws.automationsPerWorkspaceMax)
          throw new TenancyError('conflict', {
            issues: [
              issue(
                '/',
                'limit_reached',
                `A workspace has at most ${this.ws.automationsPerWorkspaceMax} automations.`,
              ),
            ],
          });
        const id = newUuidV7();
        const publicId = newPublicId('auto');
        const cmd = this.cmd(caller, p, a.brand_id);
        const name = `Copy of ${a.name}`.slice(0, 120);
        await tx.db
          .insertInto('core.record')
          .values({
            id,
            public_id: publicId,
            record_type: 'automation',
            workspace_id: tx.workspaceId,
            brand_id: a.brand_id,
            source_kind: 'ui',
            source_ref: null,
            created_by_actor_type: cmd.actor.type,
            created_by_actor_id: cmd.actor.id,
          })
          .execute();
        await tx.db
          .insertInto('automation.automation')
          .values({
            id,
            workspace_id: tx.workspaceId,
            brand_id: a.brand_id,
            scope_key: a.brand_id ?? tx.workspaceId,
            name,
            description: a.description,
            owner_membership_id: p.membershipId,
            draft: JSON.stringify(a.draft),
            template_key: a.template_key,
            duplicated_from_id: a.id,
            created_by_membership_id: p.membershipId,
          })
          .execute();
        await this.workAudit(
          tx,
          caller,
          p,
          'automation.duplicated',
          { recordId: id, type: 'automation', publicId },
          [change.plain('source', null, a.public_id)],
          a.brand_id,
        );
        return {
          status: 201,
          ref: { id: publicId, type: 'automation' },
          data: await this.#automationView(tx, p, (await this.#rows(tx, { id }))!),
        };
      },
      async (tx, p, ref) => this.#automationView(tx, p, await this.#visible(tx, p, ref.id)),
    );
  }

  /**
   * Reassigns the accountable owner after fresh grantability validation of the new owner. The
   * automation stays disabled until someone activates it again; open runs keep the owner they
   * were pinned to, so a reassignment never broadens them.
   */
  async reassignAutomation(
    caller: Caller,
    ws: unknown,
    aut: unknown,
    body: unknown,
    req: Mutation,
  ) {
    const ownerRef =
      body && typeof body === 'object' ? (body as Record<string, unknown>).owner : undefined;
    if (!isPublic(ownerRef, 'mem'))
      throw invalid(issue('/owner', 'invalid_reference', 'Choose a person.'));
    return this.mutate(
      caller,
      'automation.reassign',
      ws,
      req,
      async (tx, p) => {
        const a = await this.#visible(tx, p, aut, { lock: true, need: 'configure' });
        if (caller.delegation) throw new TenancyError('forbidden');
        if (req.ifMatch !== undefined) requireVersion(parseIfMatch(req.ifMatch), a.version);
        const m = await tx.db
          .selectFrom('tenancy.membership')
          .select(['id', 'kind', 'state', 'account_id'])
          .where('public_id', '=', ownerRef)
          .executeTakeFirst();
        if (!m || m.kind !== 'member' || m.state !== 'active')
          throw invalid(
            issue('/owner', 'invalid_reference', 'Choose an active member of this workspace.'),
          );
        const next = await compilePrincipal(tx, m.id, m.account_id, 'member');
        const scopeOk = (await this.#decideScope(tx, next, 'automations.configure', a.brand_id))
          .allowed;
        let grantable = scopeOk;
        if (grantable) {
          try {
            const c = compileDefinition(a.draft.definition, this.automationLimits);
            grantable = (await this.#resolveDraft(tx, next, a, c, 'preview')).issues.length === 0;
          } catch (err) {
            if (!(err instanceof DefinitionError)) throw err;
          }
        }
        if (!grantable)
          throw invalid(
            issue(
              '/owner',
              'not_grantable',
              'That person cannot own this automation in its scope.',
            ),
          );
        await this.#stop(tx, a, 'disabled');
        await tx.db
          .updateTable('automation.automation')
          .set({
            owner_membership_id: m.id,
            suspended_reason: null,
            suspended_at: null,
            updated_by_membership_id: p.membershipId,
          })
          .where('id', '=', a.id)
          .execute();
        await this.workAudit(
          tx,
          caller,
          p,
          'automation.owner_changed',
          { recordId: a.id, type: 'automation', publicId: a.public_id },
          [change.plain('owner', null, ownerRef)],
          a.brand_id,
        );
        return {
          status: 200,
          ref: { id: a.public_id, type: 'automation' },
          data: await this.#automationView(tx, p, (await this.#rows(tx, { id: a.id }))!),
        };
      },
      async (tx, p, ref) => this.#automationView(tx, p, await this.#visible(tx, p, ref.id)),
    );
  }

  /** Archive, restore, or trash through the canonical lifecycle (archived automations never run). */
  async automationLifecycle(
    caller: Caller,
    ws: unknown,
    aut: unknown,
    verb: 'archive' | 'unarchive' | 'trash',
    req: Mutation,
  ) {
    return this.mutate(
      caller,
      `automation.${verb}`,
      ws,
      req,
      async (tx, p) => {
        const a = await this.#visible(tx, p, aut, { lock: true, need: 'configure' });
        const brand = a.brand_id ? await this.#brandFacts(tx, a.brand_id) : null;
        const facts = { id: a.id, brand, lifecycleState: a.lifecycle_state as 'active', chain: [] };
        const input = { exec: this.exec(caller, p), source: { kind: 'ui' as const } };
        if (verb === 'archive') {
          if (a.lifecycle_state !== 'active') throw new TenancyError('conflict');
          await this.#stop(tx, a, 'archived');
          await this.d.lifecycle.archive(
            tx,
            this.issueLifecycle(tx, p, 'record.archive', facts),
            input,
            a.id,
          );
        } else if (verb === 'unarchive') {
          if (a.lifecycle_state !== 'archived') throw new TenancyError('conflict');
          await this.d.lifecycle.unarchive(
            tx,
            this.issueLifecycle(tx, p, 'record.restore', facts),
            input,
            a.id,
          );
        } else {
          await this.#stop(tx, a, 'archived');
          await this.d.lifecycle.trash(
            tx,
            this.issueLifecycle(tx, p, 'record.trash', facts),
            input,
            a.id,
          );
        }
        const r = await tx.db
          .selectFrom('core.record')
          .select(['lifecycle_state'])
          .where('id', '=', a.id)
          .executeTakeFirstOrThrow();
        return {
          status: 200,
          ref: { id: a.public_id, type: 'automation' },
          data: {
            id: a.public_id,
            type: 'automation' as const,
            lifecycle_state: r.lifecycle_state,
          },
        };
      },
      async (tx, _p, ref) => {
        const r = await tx.db
          .selectFrom('core.record')
          .select(['public_id', 'lifecycle_state'])
          .where('public_id', '=', ref.id)
          .executeTakeFirstOrThrow();
        return { id: r.public_id, type: 'automation' as const, lifecycle_state: r.lifecycle_state };
      },
    );
  }

  async listAutomationRevisions(caller: Caller, ws: unknown, aut: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const a = await this.#visible(tx, p, aut);
      const rows = await tx.db
        .selectFrom('automation.automation_revision')
        .selectAll()
        .where('automation_id', '=', a.id)
        .orderBy('revision_number', 'desc')
        .limit(100)
        .execute();
      const approvals = await tx.db
        .selectFrom('automation.standing_approval')
        .selectAll()
        .where('automation_id', '=', a.id)
        .execute();
      const brands = await this.#publicIds(
        tx,
        rows.flatMap((r) => r.declared_brand_ids),
      );
      const subs = await this.#publicIds(
        tx,
        approvals.map((x) => x.subscription_id),
      );
      return {
        data: rows.map((r) => ({
          revision: r.revision_number,
          active: r.id === a.active_revision_id,
          trigger_kind: r.trigger_kind,
          actions: r.action_keys,
          brands: r.declared_brand_ids.map((id) => brands.get(id) ?? null).filter(Boolean),
          definition: r.definition,
          approvals: approvals
            .filter((x) => x.revision_id === r.id)
            .map((x) => ({
              node: x.node_id,
              webhook: subs.get(x.subscription_id) ?? null,
              fields: x.field_set,
              state: x.state,
            })),
          created_at: new Date(r.created_at).toISOString(),
        })),
      };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Owner authority and the run principal (0C §9.4)
  // ---------------------------------------------------------------------------------------------

  async #ownerPrincipal(tx: WorkspaceTransaction, membershipId: string): Promise<Principal | null> {
    const m = await tx.db
      .selectFrom('tenancy.membership')
      .select(['id', 'account_id', 'kind', 'state'])
      .where('id', '=', membershipId)
      .executeTakeFirst();
    if (!m || m.kind !== 'member' || m.state !== 'active') return null;
    const ws = await tx.db.selectFrom('tenancy.workspace').select('state').executeTakeFirst();
    if (!ws || ws.state !== 'active') return null;
    return compilePrincipal(tx, m.id, m.account_id, 'member');
  }

  /**
   * The run's effective principal now: the pinned owner's current authority narrowed to the
   * declared brands that are still in the run's snapshot and still configurable by the owner.
   * Access only shrinks. Null with a reason when the owner is gone or lost the scope.
   */
  async #runPrincipal(
    tx: WorkspaceTransaction,
    run: Pick<RunRow, 'owner_membership_id' | 'scope_snapshot'>,
    revision: RevisionRow,
  ): Promise<{ p: Principal } | { refused: 'owner_departed' | 'owner_authority' }> {
    const owner = await this.#ownerPrincipal(tx, run.owner_membership_id);
    if (!owner) return { refused: 'owner_departed' };
    const allow = new Set<string>();
    for (const id of revision.declared_brand_ids) {
      if (!run.scope_snapshot.brands.includes(id)) continue;
      const facts = await this.#brandFacts(tx, id);
      if (!facts || facts.lifecycleState !== 'active') continue;
      if (!decideBrand(owner, 'automations.configure', facts).allowed)
        return { refused: 'owner_authority' };
      allow.add(id);
    }
    if (!allow.size) return { refused: 'owner_authority' };
    const projects = await tx.db
      .selectFrom('work.project')
      .select(['id'])
      .where('brand_id', 'in', [...allow])
      .execute();
    const projectIds = new Set(projects.map((r) => r.id));
    return {
      p: {
        ...owner,
        brandAllowlist: allow,
        grants: new Map([...owner.grants].filter(([id]) => allow.has(id))),
        grantSources: owner.grantSources.filter((s) => allow.has(s.brandId)),
        projectGrants: new Map([...owner.projectGrants].filter(([id]) => projectIds.has(id))),
        projectGrantSources: owner.projectGrantSources.filter((s) => projectIds.has(s.projectId)),
      },
    };
  }

  /** A record is in the run's declared project scope (no declared projects: the whole brands). */
  async #inDeclaredProjects(
    tx: WorkspaceTransaction,
    revision: RevisionRow,
    recordProjectId: string | null,
    recordId?: string,
  ) {
    if (!revision.declared_project_ids.length) return true;
    const pid = recordProjectId ?? null;
    if (recordId && revision.declared_project_ids.includes(recordId)) return true;
    if (!pid) return false;
    const chain = await projectChainOf(tx, pid);
    return !!chain && chain.chain.some((n) => revision.declared_project_ids.includes(n.id));
  }

  /** The caller an automation step acts through (attribution only; authority is `p`). */
  #automationCaller(
    run: RunRow,
    a: { id: string; public_id: string },
    correlationId: string,
    attemptId?: string,
  ): AutomationCaller {
    return {
      auth: {
        principal: 'account',
        account: {
          id: NIL,
          publicId: 'acc_00000000000000000000000000',
          email: 'automation@invalid',
          displayName: 'Automation',
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
      automation: {
        automationId: a.id,
        automationPublicId: a.public_id,
        ownerMembershipId: run.owner_membership_id,
        runId: run.id,
        operationId: run.current_operation_id,
        ...(attemptId ? { attemptId } : {}),
      },
    } as AutomationCaller;
  }

  // ---------------------------------------------------------------------------------------------
  // Admission: one run per (automation, trigger occurrence) (AUTO-003, AUTO-011, AUTO-017)
  // ---------------------------------------------------------------------------------------------

  /**
   * The trigger consumer (one inbox receipt per event): matches enabled automations listening for
   * the event type, filters on the event's own verified facts, and admits a run for each, pinned
   * to its revision on first consumption. Redelivery and competing workers converge on the same
   * run through the occurrence key. Events an automation caused carry its run as causation, so
   * repeated automation identities and over-deep chains are refused (loop guard).
   */
  async consumeTriggerEvent(tx: WorkspaceTransaction, e: InternalEvent): Promise<void> {
    const listening = await tx.db
      .selectFrom('automation.automation')
      .select(['id', 'active_revision_id', 'brand_id'])
      .where('enabled', '=', true)
      .where('trigger_event', '=', e.type)
      .where('lifecycle_state', '=', 'active')
      // Only what happened after this activation: enabling again never replays history.
      .where('activated_at', '<=', new Date(e.occurred_at))
      .orderBy('id')
      .limit(this.ws.automationTriggerFanoutMax + 1)
      .execute();
    if (!listening.length) return;
    if (listening.length > this.ws.automationTriggerFanoutMax)
      this.d.metrics.count('automation.runs', 1, { outcome: 'fanout_bounded' });
    const record = await this.#eventRecord(tx, e);
    if (!record) return;
    const parent = e.causation_id
      ? await tx.db
          .selectFrom('automation.automation_run')
          .select(['automation_id', 'lineage', 'root_causation_id', 'trigger_event_id'])
          .where((eb) =>
            eb.or([
              eb('current_operation_id', '=', e.causation_id!),
              eb('operation_id', '=', e.causation_id!),
            ]),
          )
          .executeTakeFirst()
      : undefined;
    for (const l of listening.slice(0, this.ws.automationTriggerFanoutMax)) {
      const revision = await this.#revision(tx, l.active_revision_id!);
      if (!this.#matches(revision.definition.trigger, e, record)) continue;
      if (!e.brand_id || !revision.declared_brand_ids.includes(e.brand_id)) continue;
      const lineage = parent ? [...parent.lineage, parent.automation_id] : [];
      const loop =
        parent && (lineage.includes(l.id) || lineage.length >= this.ws.automationChainDepthMax)
          ? 'loop_guard'
          : null;
      await this.#admit(tx, {
        automationId: l.id,
        revision,
        triggerKey: `event:${e.event_id}`,
        triggerKind: revision.trigger_kind,
        triggerEventId: e.event_id,
        triggerRecordId: record.id,
        rootCausation: parent?.root_causation_id ?? e.event_id,
        lineage: loop ? lineage.slice(0, 31) : lineage,
        correlationId: e.correlation_id,
        refuse: loop,
        initiatedBy: null,
      });
    }
  }

  /** The record an event is about (task or project) from the event's own trusted columns. */
  async #eventRecord(tx: WorkspaceTransaction, e: InternalEvent) {
    const data = e.data as Record<string, unknown>;
    let id: string | null = e.aggregate.id;
    if (e.type === 'collab.comment.created')
      id = typeof data.host_record_id === 'string' ? data.host_record_id : null;
    if (e.type === 'collab.review.decided') {
      const ref = typeof data.subject_ref === 'string' ? data.subject_ref : null;
      id = ref && /^[0-9a-f-]{36}$/.test(ref) ? ref : null;
      if (ref && !id) {
        const r = await tx.db
          .selectFrom('core.record')
          .select('id')
          .where('public_id', '=', ref)
          .executeTakeFirst();
        id = r?.id ?? null;
      }
    }
    if (!id) return null;
    const r = await tx.db
      .selectFrom('core.record')
      .select(['id', 'record_type', 'source_kind'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r || (r.record_type !== 'task' && r.record_type !== 'project')) return null;
    return { id: r.id, kind: r.record_type as RecordKind, sourceKind: r.source_kind as string };
  }

  #matches(
    t: Trigger,
    e: InternalEvent,
    record: { kind: RecordKind; sourceKind: string },
  ): boolean {
    const data = e.data as Record<string, unknown>;
    if (!('record' in t) || t.record !== record.kind) return false;
    switch (t.kind) {
      case 'record.created':
        return true;
      case 'integration.record_created':
        return (INTEGRATION_SOURCE_KINDS as readonly string[]).includes(
          String(data.source_kind ?? record.sourceKind),
        );
      case 'record.field_changed': {
        const changed = String(data.changed_fields ?? '')
          .split(',')
          .filter(Boolean);
        return t.fields.some((f) => changed.includes(f));
      }
      case 'record.status_changed':
        return t.to_category === null || data.to_category === t.to_category;
      case 'comment.created':
        return true;
      case 'approval.decided':
        return t.decision === null || data.decision === t.decision;
      default:
        return false;
    }
  }

  /**
   * Admits one run: the occurrence row (deduplicated), its operation, the concurrency slot and the
   * monthly reservation (each taken atomically under concurrency), and its job. A loop, a limit,
   * or an owner without authority still records the run, terminal, without a job.
   */
  async #admit(
    tx: WorkspaceTransaction,
    input: {
      automationId: string;
      revision: RevisionRow;
      triggerKey: string;
      triggerKind: string;
      triggerEventId: string | null;
      triggerRecordId: string | null;
      rootCausation: string | null;
      lineage: string[];
      correlationId: string;
      refuse: 'loop_guard' | null;
      initiatedBy: string | null;
      runDay?: { day: string; timezone: string };
    },
  ): Promise<{ runId: string; operationId: string; operationPublicId: string } | null> {
    const exists = await tx.db
      .selectFrom('automation.automation_run')
      .select('id')
      .where('automation_id', '=', input.automationId)
      .where('trigger_key', '=', input.triggerKey)
      .executeTakeFirst();
    if (exists) return null;
    const a = (await this.#rows(tx, { id: input.automationId }, true))!;
    if (!a.enabled || a.lifecycle_state !== 'active' || a.active_revision_id !== input.revision.id)
      return null;
    const owner = await this.#ownerPrincipal(tx, a.owner_membership_id);
    const runId = newUuidV7();
    const auto = { type: 'automation' as const, id: a.id };
    const context: ExecutionContext = {
      workspaceId: tx.workspaceId,
      correlationId: /^[0-9a-f]{32}$/.test(input.correlationId)
        ? input.correlationId
        : newTraceId(),
      authenticatedPrincipal: auto,
      effectivePrincipal: auto,
      initiatingMembershipId: a.owner_membership_id,
      delegationChain: [
        { type: 'member', id: a.owner_membership_id },
        { type: 'automation', id: a.id },
      ],
      ...(input.triggerEventId ? { causationId: input.triggerEventId } : {}),
      epochs: { workspace: owner?.epochs.workspace ?? 0, principal: owner?.epochs.principal ?? 0 },
      selectedScope: {
        brand_ids: input.revision.declared_brand_ids,
        project_ids: input.revision.declared_project_ids,
      },
      risk: { actionKey: AUTOMATION_RUN_ACTION, riskClass: 'R2' },
      dataClassLimit: 'C2',
    };
    await sql`SAVEPOINT automation_admit`.execute(tx.db);
    let op: { id: string; publicId: string };
    try {
      op = await createOperation(tx, {
        kind: 'automation_run',
        context,
        initiatedBy: {
          type: 'automation',
          id: a.id,
          onBehalfOfMembershipId: a.owner_membership_id,
        },
      });
      const tz = input.runDay?.timezone ?? (await this.#workspaceZone(tx));
      await tx.db
        .insertInto('automation.automation_run')
        .values({
          id: runId,
          workspace_id: tx.workspaceId,
          automation_id: a.id,
          revision_id: input.revision.id,
          operation_id: op.id,
          current_operation_id: op.id,
          owner_membership_id: a.owner_membership_id,
          trigger_kind: input.triggerKind,
          trigger_key: input.triggerKey,
          trigger_event_id: input.triggerEventId,
          trigger_record_id: input.triggerRecordId,
          root_causation_id: input.rootCausation,
          lineage: input.lineage,
          chain_depth: input.lineage.length,
          scope_snapshot: JSON.stringify({
            brands: input.revision.declared_brand_ids,
            projects: input.revision.declared_project_ids,
            epochs: context.epochs,
          }),
          run_day: input.runDay?.day ?? utcToLocal(new Date(), tz).slice(0, 10),
          timezone: tz,
          initiated_by_membership_id: input.initiatedBy,
        })
        .execute();
      await sql`RELEASE SAVEPOINT automation_admit`.execute(tx.db);
    } catch (err) {
      await sql`ROLLBACK TO SAVEPOINT automation_admit`.execute(tx.db);
      if ((err as { code?: string }).code === '23505') return null;
      throw err;
    }
    const run = (await this.#runRow(tx, runId, true))!;
    const end = async (
      status: AutomationRunStatus,
      reason: string,
      terminalReason: 'policy_rejected' | 'limit_exceeded' | null,
    ) => {
      await this.#terminalize(tx, run, status, reason);
      await transitionOperation(tx, {
        operationId: op.id,
        to: status === 'skipped' ? 'skipped' : 'failed',
        // A skipped run records the automation's own policy (scope, conditions, loop guard)
        // as its registered reason; the precise reason is in the outcome detail.
        terminalReason: terminalReason ?? 'policy_rejected',
        outcomeDetail: { reason },
        actor: { type: 'system' },
        context,
      });
      this.d.metrics.count('automation.runs', 1, { outcome: status });
      return { runId, operationId: op.id, operationPublicId: op.publicId };
    };
    if (input.refuse) return end('skipped', input.refuse, null);
    if (!owner) {
      await this.#stop(tx, a, 'suspended', 'owner_departed');
      return end('policy_rejected', 'owner_departed', 'policy_rejected');
    }
    // Concurrency slot (per automation) and the monthly run reservation, both atomic.
    const slot = await tx.db
      .updateTable('automation.automation')
      .set({ active_runs: sql`active_runs + 1` })
      .where('id', '=', a.id)
      .where('active_runs', '<', this.ws.automationActiveRunsMax)
      .returning('id')
      .executeTakeFirst();
    if (!slot) return end('failed', 'concurrency_limit', 'limit_exceeded');
    await tx.db
      .updateTable('automation.automation_run')
      .set({ slot_held: true })
      .where('id', '=', runId)
      .execute();
    const reserved = await this.#reserveRun(tx);
    if (!reserved) return end('failed', 'monthly_limit', 'limit_exceeded');
    await tx.db
      .updateTable('automation.automation_run')
      .set({ usage_state: 'reserved' })
      .where('id', '=', runId)
      .execute();
    await enqueueJob(tx, {
      queue: AUTOMATION_QUEUE,
      kind: AUTOMATION_RUN_JOB,
      context,
      operationId: op.id,
      payloadRef: runId,
      maxAttempts: RUN_JOB_ATTEMPTS,
      timeoutSeconds: RUN_JOB_TIMEOUT_SECONDS,
    });
    await writeOutboxEvent(tx, {
      type: 'execution.operation.state_changed',
      aggregate: { type: 'execution.operation', id: op.id, sequence: 0 },
      data: {
        kind: 'automation_run',
        state: 'queued',
        terminal_reason: null,
        waiting_reason: null,
      },
      actor: { type: 'automation', id: a.id, onBehalfOfMembershipId: a.owner_membership_id },
      context,
      operationId: op.id,
    });
    this.d.metrics.count('automation.runs', 1, { outcome: 'admitted' });
    return { runId, operationId: op.id, operationPublicId: op.publicId };
  }

  async #workspaceZone(tx: WorkspaceTransaction) {
    const w = await tx.db.selectFrom('tenancy.workspace').select('timezone').executeTakeFirst();
    return w?.timezone ?? 'UTC';
  }

  /** Reserves one run of this month's technical limit (atomic under concurrency). */
  async #reserveRun(tx: WorkspaceTransaction): Promise<boolean> {
    const period = monthStart(new Date());
    await tx.db
      .insertInto('automation.usage_period')
      .values({ workspace_id: tx.workspaceId, period_start: period })
      .onConflict((oc) => oc.columns(['workspace_id', 'period_start']).doNothing())
      .execute();
    const r = await tx.db
      .updateTable('automation.usage_period')
      .set({ runs_reserved: sql`runs_reserved + 1`, updated_at: new Date() })
      .where('period_start', '=', period)
      .where(sql<boolean>`runs_reserved - runs_released < ${this.ws.automationRunsPerMonth}`)
      .returning(['runs_reserved', 'runs_released', 'alerted_bp'])
      .executeTakeFirst();
    if (!r) return false;
    await this.#usageThreshold(
      tx,
      period,
      Number(r.runs_reserved) - Number(r.runs_released),
      Number(r.alerted_bp),
    );
    return true;
  }

  /** NTF-006: one alert per threshold per period as admitted runs approach the technical limit. */
  async #usageThreshold(tx: WorkspaceTransaction, period: string, used: number, alerted: number) {
    const bp = Math.floor((used * 10_000) / this.ws.automationRunsPerMonth);
    const crossed = [8000, 10_000].filter((t) => t > alerted && bp >= t);
    if (!crossed.length) return;
    const top = crossed[crossed.length - 1]!;
    await tx.db
      .updateTable('automation.usage_period')
      .set({ alerted_bp: top })
      .where('period_start', '=', period)
      .execute();
    await writeOutboxEvent(tx, {
      type: 'metering.usage.threshold_reached',
      aggregate: { type: 'automation.usage_period', id: tx.workspaceId, sequence: top },
      data: { meter: 'automation.runs', threshold_bp: top },
      actor: { type: 'system' },
      context: {
        workspaceId: tx.workspaceId,
        correlationId: newTraceId(),
        authenticatedPrincipal: { type: 'system_job', id: tx.workspaceId },
        effectivePrincipal: { type: 'system_job', id: tx.workspaceId },
        delegationChain: [{ type: 'system_job', id: tx.workspaceId }],
        epochs: { workspace: 0, principal: 0 },
        dataClassLimit: 'C1',
      },
    });
  }

  async #runRow(tx: WorkspaceTransaction, id: string, lock = false): Promise<RunRow | null> {
    let q = tx.db.selectFrom('automation.automation_run').selectAll().where('id', '=', id);
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    if (!r) return null;
    return {
      ...r,
      run_day:
        typeof r.run_day === 'string'
          ? r.run_day
          : new Date(r.run_day as unknown as Date).toISOString().slice(0, 10),
      version: Number(r.version),
    } as unknown as RunRow;
  }

  /**
   * Ends a run (exactly once per outcome): status and reason, the concurrency slot released once
   * (guarded by `slot_held`), and the monthly reservation settled or released once (guarded by
   * `usage_state`). Replays and redelivery find nothing left to release.
   */
  async #terminalize(
    tx: WorkspaceTransaction,
    run: Pick<RunRow, 'id' | 'automation_id' | 'created_at'>,
    status: AutomationRunStatus,
    reason: string | null,
  ) {
    const released = await tx.db
      .updateTable('automation.automation_run')
      .set({ slot_held: false })
      .where('id', '=', run.id)
      .where('slot_held', '=', true)
      .returning('id')
      .executeTakeFirst();
    if (released)
      await tx.db
        .updateTable('automation.automation')
        .set({ active_runs: sql`greatest(active_runs - 1, 0)` })
        .where('id', '=', run.automation_id)
        .execute();
    const executed = status !== 'skipped';
    const usage = await tx.db
      .updateTable('automation.automation_run')
      .set({ usage_state: executed ? 'settled' : 'released' })
      .where('id', '=', run.id)
      .where('usage_state', '=', 'reserved')
      .returning('id')
      .executeTakeFirst();
    if (usage)
      // Settled in the month the run was admitted (its reservation's period).
      await tx.db
        .updateTable('automation.usage_period')
        .set(
          executed
            ? { runs_settled: sql`runs_settled + 1`, updated_at: new Date() }
            : { runs_released: sql`runs_released + 1`, updated_at: new Date() },
        )
        .where('period_start', '=', monthStart(new Date(run.created_at)))
        .execute();
    await tx.db
      .updateTable('automation.automation_run')
      .set({
        status,
        reason,
        ended_at: TERMINAL_RUN.has(status) ? new Date() : null,
        wake_at: null,
        updated_at: new Date(),
        version: sql`version + 1`,
      })
      .where('id', '=', run.id)
      .execute();
  }

  // ---------------------------------------------------------------------------------------------
  // Execution (the `automation.run` job): one fenced step at a time
  // ---------------------------------------------------------------------------------------------

  async runAutomationJob(ctx: JobHandlerContext): Promise<JobResult> {
    const runId = ctx.job.payloadRef;
    if (!runId) throw new JobError('deterministic', 'automation_run_missing');
    for (let i = 0; i < this.ws.automationRunStepsMax + 3; i++) {
      const name = `u${i}`;
      const next = (await ctx.step(name, async (tx) => ({
        advance: await this.#advance(tx as WorkspaceTransaction, runId, ctx),
      }))) as { advance: Advance };
      const a = next.advance;
      if (a.kind === 'continue') continue;
      if (a.kind === 'done')
        return a.result.state === 'waiting'
          ? { ...a.result, resumeAt: new Date(a.result.resumeAt) }
          : a.result;
      if (a.kind === 'fail') throw new JobError(a.errorClass, a.code);
      if (a.kind === 'cancel') throw new CancelRequestedError();
      // External effect: claimed and performed outside any transaction, outcome recorded after.
      try {
        await ctx.effect(a.logicalKey, AUTOMATION_WEBHOOK_DESTINATION, async () => {
          await this.sendAutomationWebhook({
            workspaceId: ctx.job.workspaceId!,
            subscriptionId: a.subscriptionId,
            fingerprint: a.fingerprint,
            effectKey: a.logicalKey,
            envelope: a.envelope,
          });
          return {};
        });
      } catch (err) {
        if (err instanceof AwaitReconciliationError) {
          await ctx.step(`w${i}`, async (tx) => {
            const t = tx as WorkspaceTransaction;
            await t.db
              .updateTable('automation.automation_step_run')
              .set({
                state: 'unknown',
                failure_class: 'unknown_outcome',
                code: 'outcome_unknown',
                ended_at: new Date(),
              })
              .where('run_id', '=', runId)
              .where('node_id', '=', a.node)
              .where('state', '=', 'dispatching')
              .execute();
            await t.db
              .updateTable('automation.automation_run')
              .set({ status: 'waiting', reason: 'reconciliation_required', updated_at: new Date() })
              .where('id', '=', runId)
              .execute();
          });
        }
        throw err;
      }
      await ctx.step(`s${i}`, async (tx) => {
        await this.#effectSent(tx as WorkspaceTransaction, runId, a.node);
      });
    }
    throw new JobError('policy', 'limit_exceeded');
  }

  async #effectSent(tx: WorkspaceTransaction, runId: string, node: string) {
    const run = (await this.#runRow(tx, runId, true))!;
    const step = await tx.db
      .selectFrom('automation.automation_step_run')
      .selectAll()
      .where('run_id', '=', runId)
      .where('node_id', '=', node)
      .where('state', '=', 'dispatching')
      .executeTakeFirst();
    if (!step) return;
    await tx.db
      .updateTable('automation.automation_step_run')
      .set({ state: 'succeeded', ended_at: new Date() })
      .where('id', '=', step.id)
      .execute();
    const revision = await this.#revision(tx, run.revision_id);
    const n = revision.definition.steps.find((s) => s.id === node) as ActionNode;
    await this.#countStep(tx, run);
    await tx.db
      .updateTable('automation.automation_run')
      .set({ cursor: n.next, status: 'running', updated_at: new Date() })
      .where('id', '=', runId)
      .execute();
  }

  async #countStep(tx: WorkspaceTransaction, run: RunRow) {
    await tx.db
      .updateTable('automation.automation_run')
      .set({ steps_executed: sql`steps_executed + 1` })
      .where('id', '=', run.id)
      .execute();
    await tx.db
      .insertInto('automation.usage_period')
      .values({ workspace_id: tx.workspaceId, period_start: monthStart(new Date()) })
      .onConflict((oc) => oc.columns(['workspace_id', 'period_start']).doNothing())
      .execute();
    await tx.db
      .updateTable('automation.usage_period')
      .set({ steps_executed: sql`steps_executed + 1` })
      .where('period_start', '=', monthStart(new Date()))
      .execute();
  }

  /** Records a step attempt (bounded decision, target references, output references). */
  async #recordStep(
    tx: WorkspaceTransaction,
    run: RunRow,
    s: {
      node: string;
      kind: 'admission' | 'conditions' | 'action' | 'branch' | 'delay';
      action?: string;
      state:
        'succeeded' | 'failed' | 'refused' | 'skipped' | 'waiting' | 'dispatching' | 'cancelled';
      failure?: StepFailure | null;
      decision?: Record<string, unknown> | null;
      targets?: unknown[] | null;
      output?: Record<string, unknown> | null;
      logicalKey?: string | null;
    },
  ) {
    const prior = await tx.db
      .selectFrom('automation.automation_step_run')
      .select((eb) => eb.fn.max('attempt').as('n'))
      .where('run_id', '=', run.id)
      .where('node_id', '=', s.node)
      .executeTakeFirst();
    await tx.db
      .insertInto('automation.automation_step_run')
      .values({
        id: newUuidV7(),
        workspace_id: tx.workspaceId,
        run_id: run.id,
        node_id: s.node,
        attempt: Number(prior?.n ?? 0) + 1,
        kind: s.kind,
        action_key: s.action ?? null,
        state: s.state,
        failure_class: s.failure?.cls ?? null,
        code: s.failure?.code ?? null,
        decision: s.decision ? JSON.stringify(s.decision) : null,
        targets: s.targets ? JSON.stringify(s.targets) : null,
        output: s.output ? JSON.stringify(s.output) : null,
        logical_key: s.logicalKey ?? null,
        operation_id: run.current_operation_id,
        ended_at: s.state === 'waiting' || s.state === 'dispatching' ? null : new Date(),
      })
      .execute();
  }

  /**
   * One unit of progress for a run, in the step's fenced transaction. Everything is rechecked
   * here: the automation's state, the owner's authority, the scope, and the target.
   */
  async #advance(
    tx: WorkspaceTransaction,
    runId: string,
    ctx: JobHandlerContext,
  ): Promise<Advance> {
    const run = await this.#runRow(tx, runId, true);
    if (!run) return { kind: 'fail', errorClass: 'deterministic', code: 'automation_run_missing' };
    if (TERMINAL_RUN.has(run.status)) return { kind: 'done', result: this.#resultOf(run) };
    const a = (await this.#rows(tx, { id: run.automation_id }))!;
    const revision = await this.#revision(tx, run.revision_id);
    // Disable, suspension, or archive stop undispatched steps (a sent effect keeps its liability).
    if (!a.enabled || a.lifecycle_state !== 'active' || a.suspended_reason) {
      await this.#terminalize(
        tx,
        run,
        'cancelled',
        a.suspended_reason
          ? 'automation_suspended'
          : a.lifecycle_state !== 'active'
            ? 'automation_archived'
            : 'automation_disabled',
      );
      await requestOperationCancel(tx, run.current_operation_id);
      return { kind: 'cancel' };
    }
    if (run.status === 'queued') {
      await tx.db
        .updateTable('automation.automation_run')
        .set({
          status: 'running',
          started_at: run.started_at ?? new Date(),
          updated_at: new Date(),
        })
        .where('id', '=', run.id)
        .execute();
    }
    const authority = await this.#runPrincipal(tx, run, revision);
    if ('refused' in authority) {
      await this.#stop(tx, a, 'suspended', authority.refused);
      await this.#terminalize(tx, run, 'policy_rejected', authority.refused);
      return { kind: 'fail', errorClass: 'authorization', code: 'owner_authority' };
    }
    const p = authority.p;
    const caller = this.#automationCaller(run, a, ctx.context.correlationId, ctx.job.attemptId);
    const def = revision.definition;
    // Admission: the trigger record must be readable now and in the declared scope.
    if (run.cursor === null && run.status !== 'waiting') {
      const done = await tx.db
        .selectFrom('automation.automation_step_run')
        .select('id')
        .where('run_id', '=', run.id)
        .where('node_id', '=', '_conditions')
        .where('state', '=', 'succeeded')
        .executeTakeFirst();
      if (!done) {
        let facts: RecordFacts | null = null;
        if (run.trigger_record_id) {
          facts = await this.#facts(tx, p, revision, run.trigger_record_id, def.conditions);
          if (!facts) {
            await this.#recordStep(tx, run, {
              node: '_conditions',
              kind: 'admission',
              state: 'refused',
              failure: { cls: 'policy_rejected', code: 'trigger_unavailable' },
            });
            await this.#terminalize(tx, run, 'skipped', 'out_of_scope');
            return {
              kind: 'done',
              result: {
                state: 'skipped',
                terminalReason: 'policy_rejected',
                result: { reason: 'out_of_scope' },
              },
            };
          }
        }
        if (def.conditions) {
          if (!facts)
            return this.#refuseRun(tx, run, '_conditions', 'conditions', {
              cls: 'policy_rejected',
              code: 'input_unavailable',
            });
          let outcome: ReturnType<typeof evaluate>;
          try {
            outcome = evaluate(def.conditions, facts, run.run_day);
          } catch (err) {
            if (err instanceof InputUnavailable)
              return this.#refuseRun(tx, run, '_conditions', 'conditions', {
                cls: 'policy_rejected',
                code: 'input_unavailable',
              });
            throw err;
          }
          await this.#recordStep(tx, run, {
            node: '_conditions',
            kind: 'conditions',
            state: outcome.result ? 'succeeded' : 'skipped',
            decision: { result: outcome.result, comparisons: outcome.decisions.slice(0, 50) },
          });
          if (!outcome.result) {
            await this.#terminalize(tx, run, 'skipped', 'conditions_not_met');
            return {
              kind: 'done',
              result: {
                state: 'skipped',
                terminalReason: 'policy_rejected',
                result: { reason: 'conditions_not_met' },
              },
            };
          }
        } else {
          await this.#recordStep(tx, run, {
            node: '_conditions',
            kind: 'conditions',
            state: 'succeeded',
            decision: { result: true, comparisons: [] },
          });
        }
        await tx.db
          .updateTable('automation.automation_run')
          .set({ cursor: def.steps[0]!.id, updated_at: new Date() })
          .where('id', '=', run.id)
          .execute();
        return { kind: 'continue' };
      }
    }
    if (run.cursor === null) return this.#finish(tx, run);
    if (run.steps_executed >= this.ws.automationRunStepsMax)
      return this.#refuseRun(
        tx,
        run,
        run.cursor,
        'action',
        { cls: 'limit_exceeded', code: 'run_steps_limit' },
        'failed',
      );
    const node = def.steps.find((s) => s.id === run.cursor);
    if (!node)
      return { kind: 'fail', errorClass: 'deterministic', code: 'automation_cursor_invalid' };
    // A step that already succeeded (a crash after its commit) is never repeated.
    const succeeded = await tx.db
      .selectFrom('automation.automation_step_run')
      .select('id')
      .where('run_id', '=', run.id)
      .where('node_id', '=', node.id)
      .where('state', '=', 'succeeded')
      .executeTakeFirst();
    if (succeeded) {
      await tx.db
        .updateTable('automation.automation_run')
        .set({ cursor: this.#nextOf(node, true), updated_at: new Date() })
        .where('id', '=', run.id)
        .execute();
      return { kind: 'continue' };
    }
    switch (node.type) {
      case 'branch':
        return this.#branch(tx, p, run, revision, node);
      case 'delay':
        return this.#delay(tx, run, node);
      case 'action':
        return this.#action(tx, caller, p, run, revision, node);
    }
  }

  #nextOf(node: StepNode, ok: boolean): string | null {
    if (node.type === 'branch') return ok ? node.then : node.else;
    return node.next;
  }

  #resultOf(run: RunRow): JobResult {
    if (run.status === 'skipped')
      return {
        state: 'skipped',
        terminalReason: 'policy_rejected',
        result: { reason: run.reason ?? 'skipped' },
      };
    if (run.status === 'partial')
      return { state: 'partial', result: { reason: run.reason ?? 'fallback' } };
    return { state: 'succeeded' };
  }

  async #finish(tx: WorkspaceTransaction, run: RunRow): Promise<Advance> {
    // A run that took a fallback after a failed step is partial, never an unqualified success. A
    // failed attempt that a retry later ran successfully is superseded, not a fallback.
    const failedSteps = await tx.db
      .selectFrom('automation.automation_step_run as f')
      .select('f.id')
      .where('f.run_id', '=', run.id)
      .where('f.state', 'in', ['failed', 'refused'])
      .where('f.kind', '=', 'action')
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('automation.automation_step_run as s')
              .select('s.id')
              .whereRef('s.run_id', '=', 'f.run_id')
              .whereRef('s.node_id', '=', 'f.node_id')
              .where('s.state', '=', 'succeeded'),
          ),
        ),
      )
      .executeTakeFirst();
    const status: AutomationRunStatus = failedSteps ? 'partial' : 'succeeded';
    await this.#terminalize(tx, run, status, failedSteps ? 'fallback_taken' : null);
    return {
      kind: 'done',
      result:
        status === 'partial'
          ? { state: 'partial', result: { reason: 'fallback_taken' } }
          : { state: 'succeeded' },
    };
  }

  async #refuseRun(
    tx: WorkspaceTransaction,
    run: RunRow,
    node: string,
    kind: 'conditions' | 'action',
    failure: StepFailure,
    status: AutomationRunStatus = 'policy_rejected',
  ): Promise<Advance> {
    await this.#recordStep(tx, run, {
      node,
      kind: kind === 'conditions' ? 'conditions' : 'action',
      ...(kind === 'action' ? { action: 'run.limit' } : {}),
      state: 'refused',
      failure,
    });
    await this.#terminalize(tx, run, status, failure.code);
    return {
      kind: 'fail',
      errorClass: status === 'policy_rejected' ? 'authorization' : 'policy',
      code: status === 'policy_rejected' ? 'policy_rejected' : 'limit_exceeded',
    };
  }

  async #branch(
    tx: WorkspaceTransaction,
    p: Principal,
    run: RunRow,
    revision: RevisionRow,
    node: Extract<StepNode, { type: 'branch' }>,
  ): Promise<Advance> {
    const facts = run.trigger_record_id
      ? await this.#facts(tx, p, revision, run.trigger_record_id, node.when)
      : null;
    if (!facts)
      return this.#refuseRun(tx, run, node.id, 'conditions', {
        cls: 'policy_rejected',
        code: 'input_unavailable',
      });
    let outcome: ReturnType<typeof evaluate>;
    try {
      outcome = evaluate(node.when, facts, run.run_day);
    } catch (err) {
      if (err instanceof InputUnavailable)
        return this.#refuseRun(tx, run, node.id, 'conditions', {
          cls: 'policy_rejected',
          code: 'input_unavailable',
        });
      throw err;
    }
    await this.#recordStep(tx, run, {
      node: node.id,
      kind: 'branch',
      state: 'succeeded',
      decision: {
        result: outcome.result,
        next: (outcome.result ? node.then : node.else) ?? null,
        comparisons: outcome.decisions.slice(0, 50),
      },
    });
    await tx.db
      .updateTable('automation.automation_run')
      .set({ cursor: outcome.result ? node.then : node.else, updated_at: new Date() })
      .where('id', '=', run.id)
      .execute();
    return { kind: 'continue' };
  }

  /** A delay persists its wake time and releases the worker; the wake rechecks everything. */
  async #delay(
    tx: WorkspaceTransaction,
    run: RunRow,
    node: Extract<StepNode, { type: 'delay' }>,
  ): Promise<Advance> {
    const waiting = await tx.db
      .selectFrom('automation.automation_step_run')
      .selectAll()
      .where('run_id', '=', run.id)
      .where('node_id', '=', node.id)
      .where('state', '=', 'waiting')
      .executeTakeFirst();
    const now = new Date();
    if (waiting) {
      const wake = run.wake_at ? new Date(run.wake_at) : now;
      if (wake > now) {
        // Woken early (a retry or a duplicate job): wait again for the same instant.
        return { kind: 'done', result: { state: 'waiting', reason: 'delay', resumeAt: wake } };
      }
      await tx.db
        .updateTable('automation.automation_step_run')
        .set({ state: 'succeeded', ended_at: now })
        .where('id', '=', waiting.id)
        .execute();
      await this.#countStep(tx, run);
      await tx.db
        .updateTable('automation.automation_run')
        .set({ cursor: node.next, status: 'running', reason: null, wake_at: null, updated_at: now })
        .where('id', '=', run.id)
        .execute();
      return { kind: 'continue' };
    }
    const wake = new Date(now.getTime() + node.minutes * 60_000);
    await this.#recordStep(tx, run, {
      node: node.id,
      kind: 'delay',
      state: 'waiting',
      decision: { wake_at: wake.toISOString(), minutes: node.minutes },
    });
    await tx.db
      .updateTable('automation.automation_run')
      .set({ status: 'waiting', reason: 'delay', wake_at: wake, updated_at: now })
      .where('id', '=', run.id)
      .execute();
    return { kind: 'done', result: { state: 'waiting', reason: 'delay', resumeAt: wake } };
  }

  /** Stable logical key: revision, run, step, targets, and semantic parameters (never attempts). */
  #logicalKey(run: RunRow, node: ActionNode, targets: string[]) {
    return sha256(
      canonical({
        revision: run.revision_id,
        run: run.id,
        node: node.id,
        action: node.action,
        targets: [...targets].sort(),
        params: node.params,
      }),
    );
  }

  /**
   * Runs one action through its canonical command inside a savepoint: success and the step record
   * commit together; a typed failure rolls the command back, is recorded, and either takes the
   * declared fallback or ends the run. Committed earlier steps are never rolled back or rerun.
   */
  async #action(
    tx: WorkspaceTransaction,
    caller: AutomationCaller,
    p: Principal,
    run: RunRow,
    revision: RevisionRow,
    node: ActionNode,
  ): Promise<Advance> {
    const def = ACTION_MATRIX[node.action];
    if (def.status !== 'supported')
      return this.#failStep(tx, run, node, { cls: 'unavailable', code: 'action_unavailable' }, []);
    let targets: Array<{
      id: string;
      publicId: string;
      kind: RecordKind;
      projectId: string | null;
    }>;
    try {
      targets = await this.#targets(tx, p, run, revision, node);
    } catch (err) {
      const f = this.#classify(err);
      if (!f) throw err;
      return this.#failStep(tx, run, node, f, []);
    }
    const logicalKey = this.#logicalKey(
      run,
      node,
      targets.map((t) => t.id),
    );
    if (node.action === 'webhook.send')
      return this.#prepareWebhook(tx, p, run, revision, node, targets, logicalKey);
    await sql`SAVEPOINT automation_action`.execute(tx.db);
    let output: Record<string, unknown>;
    try {
      output = await this.#perform(tx, caller, p, run, revision, node, targets, logicalKey);
      await sql`RELEASE SAVEPOINT automation_action`.execute(tx.db);
    } catch (err) {
      await sql`ROLLBACK TO SAVEPOINT automation_action`.execute(tx.db);
      const f = this.#classify(err);
      if (!f) throw err;
      return this.#failStep(
        tx,
        run,
        node,
        f,
        targets.map((t) => t.publicId),
      );
    }
    await this.#recordStep(tx, run, {
      node: node.id,
      kind: 'action',
      action: node.action,
      state: 'succeeded',
      targets: targets.map((t) => ({ id: t.publicId, type: t.kind })),
      output,
      logicalKey,
    });
    await this.#countStep(tx, run);
    await tx.db
      .updateTable('automation.automation_run')
      .set({ cursor: node.next, updated_at: new Date() })
      .where('id', '=', run.id)
      .execute();
    return { kind: 'continue' };
  }

  async #failStep(
    tx: WorkspaceTransaction,
    run: RunRow,
    node: ActionNode,
    f: StepFailure,
    targets: string[],
  ): Promise<Advance> {
    await this.#recordStep(tx, run, {
      node: node.id,
      kind: 'action',
      action: node.action,
      state: f.cls === 'policy_rejected' ? 'refused' : 'failed',
      failure: f,
      targets: targets.map((id) => ({ id })),
    });
    await this.#countStep(tx, run);
    if (
      node.fallback &&
      f.cls !== 'error' &&
      f.cls !== 'limit_exceeded' &&
      node.fallback.on.includes(f.cls)
    ) {
      await tx.db
        .updateTable('automation.automation_run')
        .set({ cursor: node.fallback.next, updated_at: new Date() })
        .where('id', '=', run.id)
        .execute();
      if (node.fallback.next === null) return this.#finish(tx, { ...run, cursor: null });
      return { kind: 'continue' };
    }
    const status: AutomationRunStatus = f.cls === 'policy_rejected' ? 'policy_rejected' : 'failed';
    await this.#terminalize(tx, run, status, f.code);
    return {
      kind: 'fail',
      errorClass:
        status === 'policy_rejected'
          ? 'authorization'
          : f.cls === 'limit_exceeded'
            ? 'policy'
            : 'deterministic',
      code:
        status === 'policy_rejected'
          ? 'policy_rejected'
          : f.cls === 'limit_exceeded'
            ? 'limit_exceeded'
            : f.code.slice(0, 64),
    };
  }

  /** Typed failure of a canonical command (null: not a domain refusal; let the job retry). */
  #classify(err: unknown): StepFailure | null {
    if (err instanceof StepRefused) return err.failure;
    if (err instanceof TenancyError) {
      const code = (err.issues[0]?.code ?? err.code).replace(/[^a-z_.]/g, '_').slice(0, 64);
      // AI availability (no provider, AI off, not entitled) is a configuration fact, not a hidden
      // record: it is reported as unavailable with its own code (7A wording, nothing sent).
      if (/^ai_/.test(code) && (err.code === 'forbidden' || err.code === 'dependency_unavailable'))
        return { cls: 'unavailable', code };
      switch (err.code) {
        case 'not_found':
        case 'forbidden':
          // Opaque: hidden and absent targets are indistinguishable in history.
          return { cls: 'policy_rejected', code: 'not_permitted' };
        case 'validation_failed':
          return { cls: 'validation_failed', code };
        case 'conflict':
        case 'precondition_required':
          return { cls: 'conflict', code };
        case 'step_up_required':
          return { cls: 'policy_rejected', code: 'human_only' };
        case 'dependency_unavailable':
          return { cls: 'unavailable', code };
        case 'usage_limit_reached':
          return { cls: 'limit_exceeded', code };
        default:
          return { cls: 'error', code: 'domain_refused' };
      }
    }
    if ((err as { name?: string }).name === 'StepUpNeeded')
      return { cls: 'policy_rejected', code: 'human_only' };
    return null;
  }

  /** Bounded target selection related to the trigger record, through current authority. */
  async #targets(
    tx: WorkspaceTransaction,
    p: Principal,
    run: RunRow,
    revision: RevisionRow,
    node: ActionNode,
  ) {
    // A webhook step discloses facts about the trigger record (its only subject).
    const target = node.target ?? (node.action === 'webhook.send' ? 'trigger' : null);
    if (target === null || node.action === 'task.create') return [];
    if (!run.trigger_record_id) throw new StepRefused('validation_failed', 'no_trigger_record');
    const trig = await tx.db
      .selectFrom('core.record')
      .select(['id', 'public_id', 'record_type'])
      .where('id', '=', run.trigger_record_id)
      .executeTakeFirst();
    if (!trig) throw new StepRefused('policy_rejected', 'not_permitted');
    const out: Array<{ id: string; publicId: string; kind: RecordKind; projectId: string | null }> =
      [];
    const addTask = async (publicId: string) => {
      const t = await this.loadTask(tx, p, publicId);
      if (!(await this.#inDeclaredProjects(tx, revision, t.row.project_id)))
        throw new StepRefused('policy_rejected', 'not_permitted');
      out.push({ id: t.id, publicId: t.publicId, kind: 'task', projectId: t.row.project_id });
      return t;
    };
    const addProject = async (publicId: string) => {
      const pr = await this.loadProject(tx, p, publicId);
      if (!(await this.#inDeclaredProjects(tx, revision, pr.row.parent_project_id, pr.id)))
        throw new StepRefused('policy_rejected', 'not_permitted');
      out.push({ id: pr.id, publicId: pr.publicId, kind: 'project', projectId: pr.id });
    };
    if (target === 'trigger') {
      if (trig.record_type === 'task') await addTask(trig.public_id);
      else await addProject(trig.public_id);
    } else if (target === 'trigger.project') {
      if (trig.record_type === 'project') await addProject(trig.public_id);
      else {
        const t = await this.loadTask(tx, p, trig.public_id);
        if (!t.row.project_id) throw new StepRefused('validation_failed', 'no_project');
        await addProject((await this.publicOf(tx, t.row.project_id))!);
      }
    } else if (target === 'trigger.parent') {
      const t = await this.loadTask(tx, p, trig.public_id);
      if (!t.row.parent_task_id) throw new StepRefused('validation_failed', 'no_parent');
      await addTask((await this.publicOf(tx, t.row.parent_task_id))!);
    } else {
      await this.loadTask(tx, p, trig.public_id);
      const children = await tx.db
        .selectFrom('work.task as t')
        .innerJoin('core.record as r', 'r.id', 't.id')
        .select(['r.public_id'])
        .where('t.parent_task_id', '=', trig.id)
        .where('r.lifecycle_state', '=', 'active')
        .orderBy('t.rank')
        .orderBy('t.id')
        .limit(this.ws.automationTargetFanoutMax + 1)
        .execute();
      if (children.length > this.ws.automationTargetFanoutMax)
        throw new StepRefused('validation_failed', 'fanout_limit');
      for (const c of children) {
        try {
          await addTask(c.public_id);
        } catch (err) {
          // A subtask outside the automation's authority is omitted, never a branch hint.
          if (!(err instanceof TenancyError) && !(err instanceof StepRefused)) throw err;
        }
      }
    }
    return out;
  }

  /** Days from the run's local day (deterministic across retries and wakes). */
  #relativeDay(run: RunRow, d: unknown): string | null | undefined {
    if (d === undefined) return undefined;
    if (d === null) return null;
    return addDaysLocal(run.run_day, (d as { days: number }).days);
  }

  /** The typed adapters: each calls the canonical transaction-scoped command (AUTO-005..008). */
  async #perform(
    tx: WorkspaceTransaction,
    caller: AutomationCaller,
    p: Principal,
    run: RunRow,
    revision: RevisionRow,
    node: ActionNode,
    targets: Array<{ id: string; publicId: string; kind: RecordKind; projectId: string | null }>,
    logicalKey: string,
  ): Promise<Record<string, unknown>> {
    const prm = node.params;
    const req: Mutation = {
      idempotencyKey: `automation:${logicalKey.slice(0, 48)}`,
      fingerprint: Buffer.from(logicalKey, 'hex'),
    };
    const touched: string[] = [];
    switch (node.action) {
      case 'task.create': {
        const trig = run.trigger_record_id
          ? await tx.db
              .selectFrom('core.record')
              .select(['public_id', 'record_type'])
              .where('id', '=', run.trigger_record_id)
              .executeTakeFirst()
          : null;
        let project: string | null | undefined = prm.project as string | null | undefined;
        if (project === 'trigger.project') {
          if (!trig) throw new StepRefused('validation_failed', 'no_trigger_record');
          if (trig.record_type === 'project') project = trig.public_id;
          else {
            const t = await this.loadTask(tx, p, trig.public_id);
            if (!t.row.project_id) throw new StepRefused('validation_failed', 'no_project');
            project = await this.publicOf(tx, t.row.project_id);
          }
        }
        const parent = prm.parent === 'trigger' ? (trig?.public_id ?? null) : null;
        const input = parseTaskCreate(
          {
            ...(project ? { project } : {}),
            ...(parent ? { parent } : {}),
            title: prm.title,
            ...(prm.priority ? { priority: prm.priority } : {}),
            ...(prm.due !== undefined ? { due_date: this.#relativeDay(run, prm.due) } : {}),
            ...(prm.start !== undefined ? { start_date: this.#relativeDay(run, prm.start) } : {}),
          },
          this.ws.taskEstimateMinutesMax,
        );
        const container = await this.resolveContainer(
          tx,
          p,
          {
            brand: input.brand,
            ...(input.project ? { project: input.project } : {}),
            parent: input.parent,
          },
          null,
        );
        if (container.parent)
          this.requireTaskAction(p, 'record.create', container.parent, { shares: false });
        else this.requireCreateIn(p, container);
        if (
          !(await this.#inDeclaredProjects(
            tx,
            revision,
            container.project?.id ?? container.parent?.row.project_id ?? null,
          )) ||
          !revision.declared_brand_ids.includes(container.brand.id)
        )
          throw new StepRefused('policy_rejected', 'not_permitted');
        const made = await this.insertTask(tx, caller, p, container, input.fields, {
          source: 'automation',
        });
        return { created: [{ id: made.publicId, type: 'task' }] };
      }
      case 'task.update':
      case 'task.schedule':
        for (const t of targets) {
          const task = await this.editableTask(tx, p, t.publicId);
          const current = this.currentFields(task.row, tx);
          const changes: Record<string, unknown> =
            node.action === 'task.update'
              ? { ...(prm.fields as Record<string, unknown>) }
              : {
                  ...(prm.start !== undefined
                    ? { start_date: this.#relativeDay(run, prm.start) }
                    : {}),
                  ...(prm.due !== undefined ? { due_date: this.#relativeDay(run, prm.due) } : {}),
                };
          const version = Number(task.row.version);
          const merge = parseMerge(
            {
              version,
              changes: Object.fromEntries(
                Object.entries(changes).map(([k, v]) => [
                  k,
                  { base: current[k] ?? null, value: v },
                ]),
              ),
            },
            TASK_FIELDS,
          );
          const next = applyFieldMerge(merge, current, version, (field, value, issues) =>
            taskField(field, value, issues, this.ws.taskEstimateMinutesMax),
          );
          if (Object.keys(next).length) {
            await this.applyTaskChanges(tx, caller, req, p, task, current, next);
            touched.push(t.publicId);
          }
        }
        return {
          changed: touched.map((id) => ({ id, type: 'task' })),
          fields: Object.keys((prm.fields ?? {}) as object).concat(
            prm.start !== undefined ? ['start_date'] : [],
            prm.due !== undefined ? ['due_date'] : [],
          ),
        };
      case 'task.assign':
        for (const t of targets) {
          const task = await this.ownedTask(tx, p, t.publicId, 'record.assign');
          const existing = await tx.db
            .selectFrom('work.task_assignee as a')
            .innerJoin('tenancy.membership as m', 'm.id', 'a.membership_id')
            .select(['m.public_id', 'a.is_primary'])
            .where('a.task_id', '=', task.id)
            .orderBy('a.is_primary', 'desc')
            .orderBy('a.rank')
            .execute();
          const wanted =
            prm.mode === 'replace'
              ? (prm.assignees as string[])
              : [...new Set([...existing.map((e) => e.public_id), ...(prm.assignees as string[])])];
          if (canonical([...wanted].sort()) === canonical(existing.map((e) => e.public_id).sort()))
            continue;
          await this.setAssigneesIn(
            tx,
            caller,
            p,
            task,
            {
              assignees: wanted,
              primary:
                existing.find((e) => e.is_primary && wanted.includes(e.public_id))?.public_id ??
                wanted[0] ??
                null,
            },
            Number(task.row.version),
          );
          touched.push(t.publicId);
        }
        return { changed: touched.map((id) => ({ id, type: 'task' })) };
      case 'task.label':
        for (const t of targets) {
          const task = await this.loadTask(tx, p, t.publicId, { lock: true });
          if (
            await this.toggleLabel(
              tx,
              caller,
              p,
              task,
              prm.label as string,
              prm.mode as 'add' | 'remove',
            )
          )
            touched.push(t.publicId);
        }
        return { changed: touched.map((id) => ({ id, type: 'task' })) };
      case 'task.move':
        for (const t of targets) {
          await this.moveTaskIn(tx, caller, p, t.publicId, parseTaskMove({ project: prm.project }));
          touched.push(t.publicId);
        }
        return { changed: touched.map((id) => ({ id, type: 'task' })) };
      case 'task.archive':
        for (const t of targets) {
          await this.archiveTaskIn(tx, caller, p, t.publicId);
          touched.push(t.publicId);
        }
        return { changed: touched.map((id) => ({ id, type: 'task' })) };
      case 'task.relate':
        for (const t of targets) {
          await this.addRelationshipIn(
            tx,
            caller,
            p,
            t.publicId,
            parseRelationship({ kind: prm.kind, target: prm.to }),
          );
          touched.push(t.publicId);
        }
        return { changed: touched.map((id) => ({ id, type: 'task' })) };
      case 'project.update':
      case 'project.schedule':
        for (const t of targets) {
          const pr = await this.loadProject(tx, p, t.publicId, { lock: true });
          const r = pr.row;
          const current: Record<string, unknown> = {
            name: r.name,
            priority: r.priority,
            start_date: r.start_date,
            target_date: r.target_date,
            status: this.statusView(r.status_id, tx).key,
          };
          const changes: Record<string, unknown> =
            node.action === 'project.update'
              ? { ...(prm.fields as Record<string, unknown>) }
              : {
                  ...(prm.start !== undefined
                    ? { start_date: this.#relativeDay(run, prm.start) }
                    : {}),
                  ...(prm.target !== undefined
                    ? { target_date: this.#relativeDay(run, prm.target) }
                    : {}),
                };
          const merge = parseMerge(
            {
              version: Number(r.version),
              changes: Object.fromEntries(
                Object.entries(changes).map(([k, v]) => [
                  k,
                  { base: current[k] ?? null, value: v },
                ]),
              ),
            },
            PROJECT_FIELDS,
          );
          await this.updateProjectIn(tx, caller, p, pr.publicId, merge, req);
          touched.push(t.publicId);
        }
        return { changed: touched.map((id) => ({ id, type: 'project' })) };
      case 'project.archive':
        for (const t of targets) {
          await this.archiveProjectIn(tx, caller, p, t.publicId);
          touched.push(t.publicId);
        }
        return { changed: touched.map((id) => ({ id, type: 'project' })) };
      case 'task.notify':
      case 'project.notify':
        return this.#notify(tx, p, run, node, targets);
      case 'ai.draft': {
        const trig = run.trigger_record_id
          ? await tx.db
              .selectFrom('core.record')
              .select(['public_id', 'record_type'])
              .where('id', '=', run.trigger_record_id)
              .executeTakeFirst()
          : null;
        if (!trig) throw new StepRefused('validation_failed', 'no_trigger_record');
        // Readable now (the gateway re-checks the scope through its own retrieval authority).
        if (trig.record_type === 'task') await this.loadTask(tx, p, trig.public_id);
        else await this.loadProject(tx, p, trig.public_id);
        const out = await this.startAutomationAiRun(tx, caller, p, {
          action: prm.action as string,
          instruction: (prm.instruction as string | undefined) ?? null,
          scope:
            trig.record_type === 'task' ? { task: trig.public_id } : { project: trig.public_id },
        });
        // A request, not a result: proposals wait for the owner's explicit 7D review and apply.
        return {
          ai_run: out.runPublicId,
          kind: out.kind,
          review_required: out.kind === 'proposal',
        };
      }
      default:
        throw new StepRefused('unavailable', 'action_unavailable');
    }
  }

  /**
   * The notify action (4B): an `automation_notice` to the chosen people who can read the record
   * now (the fan-out re-checks authorization and applies preferences, quiet hours, and dedupe).
   * Recipients the record is hidden from are dropped without a trace.
   */
  async #notify(
    tx: WorkspaceTransaction,
    p: Principal,
    run: RunRow,
    node: ActionNode,
    targets: Array<{ id: string; publicId: string; kind: RecordKind }>,
  ) {
    const fan = new NotificationFanOut(
      {
        notifyFanoutRecipientsMax: this.ws.notifyFanoutRecipientsMax,
        notifyDedupeWindowMinutes: this.ws.notifyDedupeWindowMinutes,
        notifyEmailPerHourMax: this.ws.notifyEmailPerHourMax,
        notifyFactsMaxBytes: this.ws.notifyFactsMaxBytes,
        principalContextArrayMax: this.c.settings.principalContextArrayMax,
      },
      this.d.metrics,
    );
    let notified = 0;
    for (const t of targets) {
      const recipients = new Set<string>();
      for (const r of node.params.recipients as string[]) {
        if (r === 'owner') {
          if (t.kind === 'task') {
            const task = await tx.db
              .selectFrom('work.task')
              .select('created_by_membership_id')
              .where('id', '=', t.id)
              .executeTakeFirst();
            void task;
            recipients.add(run.owner_membership_id);
          } else {
            const pr = await tx.db
              .selectFrom('work.project')
              .select('owner_membership_id')
              .where('id', '=', t.id)
              .executeTakeFirst();
            if (pr?.owner_membership_id) recipients.add(pr.owner_membership_id);
          }
        } else if (r === 'assignees') {
          const as = await tx.db
            .selectFrom('work.task_assignee')
            .select('membership_id')
            .where('task_id', '=', t.id)
            .execute();
          for (const x of as) recipients.add(x.membership_id);
        } else {
          const m = await tx.db
            .selectFrom('tenancy.membership')
            .select('id')
            .where('public_id', '=', r)
            .executeTakeFirst();
          if (m) recipients.add(m.id);
        }
      }
      void p;
      const before = await tx.db
        .selectFrom('notify.notification')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('record_id', '=', t.id)
        .where('type', '=', 'automation_notice')
        .executeTakeFirstOrThrow();
      await fan.persist(tx, null, {
        type: 'automation_notice' as never,
        recordId: t.id,
        actorId: null,
        recipients: [...recipients],
        facts: { message: String(node.params.message).slice(0, 280) },
        occasion: `${run.id}:${node.id}`,
      });
      const after = await tx.db
        .selectFrom('notify.notification')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('record_id', '=', t.id)
        .where('type', '=', 'automation_notice')
        .executeTakeFirstOrThrow();
      notified += Number(after.n) - Number(before.n);
    }
    return {
      notified_records: targets.map((t) => ({ id: t.publicId, type: t.kind })),
      notifications: notified,
    };
  }

  /**
   * Phase one of a webhook step (in the step transaction): the standing approval must match this
   * revision, node, destination fingerprint, field set, and scope; the owner must still manage
   * the destination and read the record; the payload is the approved fields read now. The step is
   * recorded `dispatching` with its logical key, then the effect is claimed and sent.
   */
  async #prepareWebhook(
    tx: WorkspaceTransaction,
    p: Principal,
    run: RunRow,
    revision: RevisionRow,
    node: ActionNode,
    targets: Array<{ id: string; publicId: string; kind: RecordKind }>,
    logicalKey: string,
  ): Promise<Advance> {
    const existing = await tx.db
      .selectFrom('automation.automation_step_run')
      .select(['id', 'logical_key'])
      .where('run_id', '=', run.id)
      .where('node_id', '=', node.id)
      .where('state', '=', 'dispatching')
      .executeTakeFirst();
    const approval = await tx.db
      .selectFrom('automation.standing_approval')
      .selectAll()
      .where('revision_id', '=', revision.id)
      .where('node_id', '=', node.id)
      .where('state', '=', 'active')
      .executeTakeFirst();
    const pub = node.params.subscription as string;
    const dest = await this.automationWebhookDestination(tx, pub);
    const scopeHash = sha256(
      canonical({
        brands: [...revision.declared_brand_ids].sort(),
        projects: [...revision.declared_project_ids].sort(),
      }),
    );
    const fields = [...(node.params.fields as string[])].sort();
    if (
      !approval ||
      !dest ||
      approval.subscription_id !== dest.id ||
      approval.destination_fingerprint !== dest.fingerprint ||
      canonical([...approval.field_set].sort()) !== canonical(fields) ||
      approval.scope_hash !== scopeHash ||
      dest.state !== 'active' ||
      dest.lifecycleState !== 'active'
    )
      return this.#failStep(
        tx,
        run,
        node,
        { cls: 'policy_rejected', code: 'approval_invalid' },
        targets.map((t) => t.publicId),
      );
    const manage =
      dest.brandId === null
        ? decideWorkspace(p, 'webhooks.manage')
        : decideBrand(
            p,
            'webhooks.manage',
            (await this.#brandFacts(tx, dest.brandId)) ?? {
              id: NIL,
              isSensitive: true,
              lifecycleState: 'trashed',
            },
          );
    if (!manage.allowed)
      return this.#failStep(
        tx,
        run,
        node,
        { cls: 'policy_rejected', code: 'not_permitted' },
        targets.map((t) => t.publicId),
      );
    const t = targets[0];
    if (!t)
      return this.#failStep(
        tx,
        run,
        node,
        { cls: 'validation_failed', code: 'no_trigger_record' },
        [],
      );
    const facts = await this.#facts(tx, p, revision, t.id, null);
    if (!facts)
      return this.#failStep(tx, run, node, { cls: 'policy_rejected', code: 'not_permitted' }, []);
    const values: Record<string, string | null> = {};
    for (const f of fields)
      values[f] = ((facts as unknown as Record<string, unknown>)[f] as string | null) ?? null;
    const ws = await tx.db
      .selectFrom('tenancy.workspace')
      .select('public_id')
      .executeTakeFirstOrThrow();
    const envelope = {
      type: 'automation.action',
      api_version: 'v1',
      created_at: new Date().toISOString(),
      workspace: ws.public_id,
      data: {
        object: { id: t.publicId, type: t.kind },
        fields: values,
        automation: (await this.#rows(tx, { id: run.automation_id }))!.public_id,
      },
    };
    if (!existing)
      await this.#recordStep(tx, run, {
        node: node.id,
        kind: 'action',
        action: node.action,
        state: 'dispatching',
        targets: [{ id: t.publicId, type: t.kind }],
        output: { webhook: pub, fields },
        logicalKey,
      });
    return {
      kind: 'effect',
      node: node.id,
      logicalKey: existing?.logical_key ?? logicalKey,
      subscriptionId: dest.id,
      fingerprint: dest.fingerprint,
      envelope,
    };
  }

  /**
   * Facts of the trigger record through the run's current authority: null when it is not
   * readable now or not in the declared scope (opaque). Custom fields are loaded through the
   * canonical field reader; an unreadable field is simply absent.
   */
  async #facts(
    tx: WorkspaceTransaction,
    p: Principal,
    revision: RevisionRow,
    recordId: string,
    cond: Condition | null,
  ): Promise<RecordFacts | null> {
    const r = await tx.db
      .selectFrom('core.record')
      .select(['public_id', 'record_type'])
      .where('id', '=', recordId)
      .executeTakeFirst();
    if (!r) return null;
    try {
      const custom = new Map<string, unknown>();
      const needed = customFieldsOf(cond);
      if (r.record_type === 'task') {
        const t: LoadedTask = await this.loadTask(tx, p, r.public_id);
        if (
          t.lifecycleState !== 'active' ||
          !(await this.#inDeclaredProjects(tx, revision, t.row.project_id))
        )
          return null;
        if (needed.size) await this.#customFacts(tx, p, r.public_id, needed, custom);
        const assignees = await tx.db
          .selectFrom('work.task_assignee as a')
          .innerJoin('tenancy.membership as m', 'm.id', 'a.membership_id')
          .select('m.public_id')
          .where('a.task_id', '=', t.id)
          .execute();
        const labels = await tx.db
          .selectFrom('work.task_label as tl')
          .innerJoin('work.label as l', 'l.id', 'tl.label_id')
          .select('l.public_id')
          .where('tl.task_id', '=', t.id)
          .execute();
        return {
          status: this.currentFields(t.row, tx).status as string,
          status_category: t.row.status_category,
          priority: t.row.priority,
          due_date: t.row.due_date ? String(t.row.due_date).slice(0, 10) : null,
          start_date: t.row.start_date ? String(t.row.start_date).slice(0, 10) : null,
          target_date: null,
          assignee: assignees.map((x) => x.public_id),
          label: labels.map((x) => x.public_id),
          project: t.row.project_id ? await this.publicOf(tx, t.row.project_id) : null,
          title: t.row.title,
          custom,
        };
      }
      const pr = await this.loadProject(tx, p, r.public_id);
      if (
        pr.lifecycleState !== 'active' ||
        !(await this.#inDeclaredProjects(tx, revision, pr.row.parent_project_id, pr.id))
      )
        return null;
      if (needed.size) await this.#customFacts(tx, p, r.public_id, needed, custom);
      const d = (v: unknown) =>
        v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null;
      return {
        status: this.statusView(pr.row.status_id, tx).key,
        status_category: pr.row.status_category,
        priority: pr.row.priority,
        due_date: null,
        start_date: d(pr.row.start_date),
        target_date: d(pr.row.target_date),
        assignee: [],
        label: [],
        project: null,
        title: pr.row.name,
        custom,
      };
    } catch (err) {
      if (err instanceof TenancyError) return null;
      throw err;
    }
  }

  async #customFacts(
    tx: WorkspaceTransaction,
    p: Principal,
    recordPublic: string,
    needed: Set<string>,
    out: Map<string, unknown>,
  ) {
    const r = await this.workRecord(tx, p, recordPublic);
    const o = decideRecord(p, 'field.value_read', r.facts);
    if (!o.allowed) return;
    const payload = await this.fieldsPayload(tx, p, r);
    for (const f of payload.fields) {
      if (!needed.has(f.id)) continue;
      const v = f.value as unknown;
      out.set(
        f.id,
        v && typeof v === 'object'
          ? ((v as { id?: unknown; amount?: unknown }).id ??
              (v as { amount?: unknown }).amount ??
              null)
          : v,
      );
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Terminal accounting from operation outcomes (one inbox receipt per state change)
  // ---------------------------------------------------------------------------------------------

  /**
   * Keeps runs truthful whatever ended their operation (a dead-lettered job, a reaped lease, a
   * reconciliation decision): syncs the run's status, releases its slot and reservation once, and
   * tracks failures in a row. Persistent failures alert the owner (AUTO-016) through 4B, at most
   * once per AUTOMATION_ALERT_INTERVAL_MINUTES per automation.
   */
  async consumeOperationState(tx: WorkspaceTransaction, e: InternalEvent): Promise<void> {
    const data = e.data as Record<string, unknown>;
    if (data.kind !== 'automation_run') return;
    const run = await tx.db
      .selectFrom('automation.automation_run')
      .selectAll()
      .where('current_operation_id', '=', e.aggregate.id)
      .forUpdate()
      .executeTakeFirst();
    if (!run) return;
    const r = { ...run, version: Number(run.version) } as unknown as RunRow;
    const state = String(data.state);
    if (state === 'waiting' && data.waiting_reason === 'reconciliation_required') {
      if (!TERMINAL_RUN.has(r.status))
        await tx.db
          .updateTable('automation.automation_run')
          .set({
            status: 'waiting',
            reason: 'reconciliation_required',
            wake_at: null,
            updated_at: new Date(),
          })
          .where('id', '=', r.id)
          .execute();
      return;
    }
    if (!isTerminalState(state as never)) return;
    if (!TERMINAL_RUN.has(r.status)) {
      const status: AutomationRunStatus =
        state === 'failed'
          ? data.terminal_reason === 'policy_rejected'
            ? 'policy_rejected'
            : 'failed'
          : (state as AutomationRunStatus);
      await this.#terminalize(
        tx,
        r,
        status,
        (data.terminal_reason as string | null) ??
          (state === 'cancelled' ? 'user_cancelled' : null),
      );
    } else {
      // Already ended by the engine: release whatever is still held (idempotent).
      await this.#terminalize(tx, r, r.status, r.reason);
    }
    const final = (await this.#runRow(tx, r.id))!;
    const a = await tx.db
      .selectFrom('automation.automation')
      .select(['id', 'consecutive_failures', 'alerted_at', 'owner_membership_id'])
      .where('id', '=', r.automation_id)
      .forUpdate()
      .executeTakeFirst();
    if (!a) return;
    if (final.status === 'failed' || final.status === 'policy_rejected') {
      const streak = a.consecutive_failures + 1;
      const due =
        streak >= this.ws.automationAlertFailureThreshold &&
        (!a.alerted_at ||
          Date.now() - new Date(a.alerted_at).getTime() >=
            this.ws.automationAlertIntervalMinutes * 60_000);
      await tx.db
        .updateTable('automation.automation')
        .set({ consecutive_failures: streak, ...(due ? { alerted_at: new Date() } : {}) })
        .where('id', '=', a.id)
        .execute();
      if (due)
        await writeOutboxEvent(tx, {
          type: 'automation.automation_run.failed',
          aggregate: { type: 'automation.automation_run', id: r.id, sequence: streak },
          data: {
            automation_id: a.id,
            terminal_reason: (data.terminal_reason as string | null) ?? 'error',
          },
          actor: { type: 'system' },
          context: await this.#runContext(tx, r),
        });
      this.d.metrics.count('automation.runs', 1, { outcome: final.status });
    } else if (final.status === 'succeeded' || final.status === 'partial') {
      if (a.consecutive_failures)
        await tx.db
          .updateTable('automation.automation')
          .set({ consecutive_failures: 0 })
          .where('id', '=', a.id)
          .execute();
      this.d.metrics.count('automation.runs', 1, { outcome: final.status });
    } else {
      this.d.metrics.count('automation.runs', 1, { outcome: final.status });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Date and schedule triggers (the existing scheduler; stable occurrence keys)
  // ---------------------------------------------------------------------------------------------

  /**
   * One workspace's due date and schedule triggers. Each occurrence has a stable local key, so a
   * retried or concurrent sweep admits it once; occurrences missed while the worker was down are
   * not replayed beyond the latest one (no catch-up storm).
   */
  async runTriggerSweep(workspaceId: string, now: Date): Promise<number> {
    let admitted = 0;
    await this.d.tenant.withWorkspace(workspaceId, { module: 'automation' }, async (tx) => {
      const due = await tx.db
        .selectFrom('automation.trigger_schedule')
        .selectAll()
        .where('next_due_at', '<=', now)
        .orderBy('next_due_at')
        .limit(this.ws.automationSweepBatchMax)
        .forUpdate()
        .skipLocked()
        .execute();
      for (const s of due) {
        const a = await this.#rows(tx, { id: s.automation_id });
        if (
          !a ||
          !a.enabled ||
          a.lifecycle_state !== 'active' ||
          a.active_revision_id !== s.revision_id
        ) {
          await tx.db
            .deleteFrom('automation.trigger_schedule')
            .where('automation_id', '=', s.automation_id)
            .execute();
          continue;
        }
        const revision = await this.#revision(tx, s.revision_id);
        const t = revision.definition.trigger;
        if (t.kind === 'schedule') {
          const key = utcToLocal(new Date(s.next_due_at!), t.timezone);
          const made = await this.#admit(tx, {
            automationId: a.id,
            revision,
            triggerKey: `schedule:${key}`,
            triggerKind: 'schedule',
            triggerEventId: null,
            triggerRecordId: null,
            rootCausation: null,
            lineage: [],
            correlationId: newTraceId(),
            refuse: null,
            initiatedBy: null,
            runDay: { day: key.slice(0, 10), timezone: t.timezone },
          });
          if (made) admitted++;
          const next = this.#nextScheduled(t, now, key);
          await tx.db
            .updateTable('automation.trigger_schedule')
            .set({ next_due_at: next?.at ?? null, last_key: key, updated_at: new Date() })
            .where('automation_id', '=', a.id)
            .execute();
        } else if (t.kind === 'date') {
          const key = utcToLocal(new Date(s.next_due_at!), t.timezone);
          const day = key.slice(0, 10);
          const target = addDaysLocal(day, -t.offset_days);
          const column = t.field === 'due_date' ? 't.due_date' : 't.start_date';
          const tasks = await tx.db
            .selectFrom('work.task as t')
            .innerJoin('core.record as r', 'r.id', 't.id')
            .select(['t.id'])
            .where(sql.ref(column), '=', target)
            .where('t.brand_id', 'in', revision.declared_brand_ids)
            .where('r.lifecycle_state', '=', 'active')
            .orderBy('t.id')
            .limit(this.ws.automationSweepBatchMax)
            .execute();
          for (const task of tasks) {
            const made = await this.#admit(tx, {
              automationId: a.id,
              revision,
              triggerKey: `date:${task.id}:${day}`,
              triggerKind: 'date',
              triggerEventId: null,
              triggerRecordId: task.id,
              rootCausation: null,
              lineage: [],
              correlationId: newTraceId(),
              refuse: null,
              initiatedBy: null,
              runDay: { day, timezone: t.timezone },
            });
            if (made) admitted++;
          }
          const next = this.#nextDateSweep(
            t,
            new Date(Math.max(now.getTime(), new Date(s.next_due_at!).getTime()) + 60_000),
          );
          await tx.db
            .updateTable('automation.trigger_schedule')
            .set({ next_due_at: next.at, last_key: key, updated_at: new Date() })
            .where('automation_id', '=', a.id)
            .execute();
        }
      }
    });
    return admitted;
  }

  // ---------------------------------------------------------------------------------------------
  // Manual run, preview, history, retry, cancel (AUTO-012, AUTO-014, AUTO-015)
  // ---------------------------------------------------------------------------------------------

  async #triggerRecord(
    tx: WorkspaceTransaction,
    p: Principal,
    revisionKind: RecordKind | null,
    ref: unknown,
  ) {
    if (revisionKind === null) {
      if (ref !== undefined && ref !== null)
        throw invalid(issue('/record', 'not_applicable', 'This automation has no trigger record.'));
      return null;
    }
    if (revisionKind === 'task' ? !isPublic(ref, 'tsk') : !isPublic(ref, 'prj'))
      throw invalid(issue('/record', 'required', `Choose a ${revisionKind} to run it on.`));
    // The person must read the record; they lend no authority to the run.
    return revisionKind === 'task'
      ? (await this.loadTask(tx, p, ref)).id
      : (await this.loadProject(tx, p, ref)).id;
  }

  /** A manual run of the active revision on a chosen record, as the automation (never the caller). */
  async runAutomationNow(caller: Caller, ws: unknown, aut: unknown, body: unknown, req: Mutation) {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    return this.mutate(
      caller,
      'automation.run_manual',
      ws,
      req,
      async (tx, p) => {
        const a = await this.#visible(tx, p, aut, { need: 'run' });
        if (p.kind !== 'member') throw new TenancyError('forbidden');
        if (!a.enabled || !a.active_revision_id)
          throw new TenancyError('conflict', {
            issues: [issue('/', 'automation_disabled', 'Activate this automation to run it.')],
          });
        const revision = await this.#revision(tx, a.active_revision_id);
        const recordId = await this.#triggerRecord(tx, p, revision.record_kind, b.record);
        const made = await this.#admit(tx, {
          automationId: a.id,
          revision,
          triggerKey: `manual:${randomUUID()}`,
          triggerKind: 'manual',
          triggerEventId: null,
          triggerRecordId: recordId,
          rootCausation: null,
          lineage: [],
          correlationId: caller.meta.correlationId,
          refuse: null,
          initiatedBy: p.membershipId,
        });
        if (!made) throw new TenancyError('conflict');
        await this.workAudit(
          tx,
          caller,
          p,
          'automation.run_requested',
          { recordId: a.id, type: 'automation', publicId: a.public_id },
          [change.plain('run', null, made.operationPublicId)],
          a.brand_id,
        );
        return {
          status: 202,
          ref: { id: made.operationPublicId, type: 'automation_run' },
          data: await this.#runView(tx, p, made.operationPublicId),
        };
      },
      async (tx, p, ref) => this.#runView(tx, p, ref.id),
    );
  }

  /**
   * Preview (AUTO-012): the same compiler and evaluator, the viewer's current authority narrowed
   * to the declared scope and the owner's authority. Actions run as a dry run of the canonical
   * commands inside a savepoint that is always rolled back: no domain change, notification,
   * effect, AI reservation, or outbound request survives. Not a promise about the future.
   */
  async previewAutomation(caller: Caller, ws: unknown, aut: unknown, body: unknown) {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    return this.inWorkspace(caller, ws, {}, async (tx, p) => {
      const a = await this.#visible(tx, p, aut, { need: 'configure' });
      if (p.kind !== 'member') throw new TenancyError('forbidden');
      let c: Compiled;
      try {
        c = compileDefinition(a.draft.definition, this.automationLimits);
      } catch (err) {
        if (err instanceof DefinitionError)
          return {
            valid: false,
            issues: err.issues,
            unavailable: [],
            conditions: null,
            steps: [],
            bounds: this.#bounds(),
          };
        throw err;
      }
      const resolved = await this.#resolveDraft(tx, p, a, c, 'preview');
      const owner = await this.#ownerPrincipal(tx, a.owner_membership_id);
      const ownerBrands = new Set(
        (owner
          ? resolved.brands.filter((x) => decideBrand(owner, 'automations.configure', x).allowed)
          : []
        ).map((x) => x.id),
      );
      const allowed = resolved.brands.filter((x) => ownerBrands.has(x.id));
      const pv: Principal = {
        ...p,
        brandAllowlist: new Set(allowed.map((x) => x.id)),
        grants: new Map([...p.grants].filter(([id]) => ownerBrands.has(id))),
      };
      const revision: RevisionRow = {
        id: NIL,
        automation_id: a.id,
        revision_number: 0,
        definition: c.definition,
        definition_hash: '',
        trigger_kind: c.definition.trigger.kind,
        record_kind: c.recordKind,
        declared_brand_ids: allowed.map((x) => x.id),
        declared_project_ids: resolved.declaredProjects,
        action_keys: c.actions,
        action_classes: c.classes,
        created_at: new Date(),
      };
      const recordId = c.recordKind
        ? await this.#triggerRecord(tx, pv, c.recordKind, b.record).catch((err) => {
            if (err instanceof TenancyError && err.code === 'not_found')
              throw invalid(
                issue(
                  '/record',
                  'invalid_reference',
                  'Choose a record this automation can act on.',
                ),
              );
            throw err;
          })
        : null;
      const zone = await this.#workspaceZone(tx);
      const fakeRun: RunRow = {
        id: NIL,
        automation_id: a.id,
        revision_id: NIL,
        operation_id: NIL,
        current_operation_id: NIL,
        owner_membership_id: a.owner_membership_id,
        trigger_kind: c.definition.trigger.kind,
        trigger_key: 'preview:0',
        trigger_event_id: null,
        trigger_record_id: recordId,
        root_causation_id: null,
        lineage: [],
        chain_depth: 0,
        scope_snapshot: {
          brands: revision.declared_brand_ids,
          projects: revision.declared_project_ids,
          epochs: p.epochs,
        },
        run_day: utcToLocal(new Date(), zone).slice(0, 10),
        timezone: zone,
        status: 'running',
        reason: null,
        cursor: null,
        wake_at: null,
        steps_executed: 0,
        retry_count: 0,
        usage_state: 'none',
        slot_held: false,
        initiated_by_membership_id: p.membershipId,
        created_at: new Date(),
        started_at: null,
        ended_at: null,
        version: 0,
      };
      const steps: Array<Record<string, unknown>> = [];
      let conditions: Record<string, unknown> | null = null;
      const facts = recordId
        ? await this.#facts(tx, pv, revision, recordId, c.definition.conditions)
        : null;
      if (recordId && !facts)
        return {
          valid: true,
          issues: resolved.issues,
          unavailable: c.unavailable,
          conditions: { result: null, refused: 'out_of_scope' },
          steps,
          bounds: this.#bounds(),
        };
      if (c.definition.conditions) {
        try {
          const o = evaluate(c.definition.conditions, facts!, fakeRun.run_day);
          conditions = { result: o.result, comparisons: o.decisions };
          if (!o.result)
            return {
              valid: true,
              issues: resolved.issues,
              unavailable: c.unavailable,
              conditions,
              steps,
              bounds: this.#bounds(),
            };
        } catch (err) {
          if (!(err instanceof InputUnavailable)) throw err;
          return {
            valid: true,
            issues: resolved.issues,
            unavailable: c.unavailable,
            conditions: { result: null, refused: 'input_unavailable' },
            steps,
            bounds: this.#bounds(),
          };
        }
      }
      const caller2: AutomationCaller = { ...caller };
      await sql`SAVEPOINT automation_preview`.execute(tx.db);
      try {
        let cursor: string | null = c.definition.steps[0]?.id ?? null;
        let guard = 0;
        while (cursor && guard++ < this.ws.automationNodesMax) {
          const node = c.definition.steps.find((s) => s.id === cursor)!;
          if (node.type === 'branch') {
            try {
              const o = evaluate(node.when, facts!, fakeRun.run_day);
              steps.push({
                node: node.id,
                kind: 'branch',
                outcome: o.result ? 'then' : 'else',
                next: (o.result ? node.then : node.else) ?? null,
              });
              cursor = o.result ? node.then : node.else;
            } catch (err) {
              if (!(err instanceof InputUnavailable)) throw err;
              steps.push({
                node: node.id,
                kind: 'branch',
                outcome: 'would_refuse',
                code: 'input_unavailable',
              });
              break;
            }
            continue;
          }
          if (node.type === 'delay') {
            steps.push({
              node: node.id,
              kind: 'delay',
              outcome: 'would_wait',
              minutes: node.minutes,
            });
            cursor = node.next;
            continue;
          }
          const entry: Record<string, unknown> = {
            node: node.id,
            kind: 'action',
            action: node.action,
            class: actionClass(node.action),
          };
          if (
            node.action === 'webhook.send' ||
            node.action === 'ai.draft' ||
            node.action === 'agent.invoke' ||
            node.action === 'task.notify' ||
            node.action === 'project.notify'
          ) {
            // Reported, never performed: no notification, request, reservation, or delivery.
            try {
              const targets = node.target
                ? await this.#targets(tx, pv, fakeRun, revision, node)
                : [];
              entry.outcome = node.action === 'agent.invoke' ? 'unavailable' : 'would_run';
              entry.targets = targets.map((t) => ({ id: t.publicId, type: t.kind }));
              if (node.action === 'webhook.send')
                entry.discloses = { webhook: node.params.subscription, fields: node.params.fields };
              if (node.action === 'ai.draft')
                entry.note = 'Creates a draft for review; nothing is applied without a person.';
            } catch (err) {
              const f = this.#classify(err);
              if (!f) throw err;
              entry.outcome = 'would_refuse';
              entry.code = f.code;
              entry.failure_class = f.cls;
            }
            steps.push(entry);
            cursor = node.next;
            continue;
          }
          await sql`SAVEPOINT automation_preview_step`.execute(tx.db);
          try {
            const targets = await this.#targets(tx, pv, fakeRun, revision, node);
            const out = await this.#perform(
              tx,
              caller2,
              pv,
              fakeRun,
              revision,
              node,
              targets,
              this.#logicalKey(
                fakeRun,
                node,
                targets.map((t) => t.id),
              ),
            );
            entry.outcome = 'would_run';
            entry.targets = targets.map((t) => ({ id: t.publicId, type: t.kind }));
            entry.result = out;
            await sql`RELEASE SAVEPOINT automation_preview_step`.execute(tx.db);
            cursor = node.next;
          } catch (err) {
            await sql`ROLLBACK TO SAVEPOINT automation_preview_step`.execute(tx.db);
            const f = this.#classify(err);
            if (!f) throw err;
            entry.outcome = 'would_refuse';
            entry.code = f.code;
            entry.failure_class = f.cls;
            if (
              node.fallback &&
              f.cls !== 'error' &&
              f.cls !== 'limit_exceeded' &&
              node.fallback.on.includes(f.cls)
            ) {
              entry.fallback = node.fallback.next;
              cursor = node.fallback.next;
            } else cursor = null;
          }
          steps.push(entry);
        }
      } finally {
        await sql`ROLLBACK TO SAVEPOINT automation_preview`.execute(tx.db);
        await sql`RELEASE SAVEPOINT automation_preview`.execute(tx.db);
      }
      return {
        valid: true,
        issues: resolved.issues,
        unavailable: c.unavailable,
        conditions,
        steps,
        bounds: this.#bounds(),
      };
    });
  }

  #bounds() {
    return {
      steps_max: this.ws.automationRunStepsMax,
      fanout_max: this.ws.automationTargetFanoutMax,
      delay_max_minutes: this.ws.automationDelayHorizonMinutes,
      chain_depth_max: this.ws.automationChainDepthMax,
      note: 'A preview uses your current access and today’s data. It is not a promise about later runs.',
    };
  }

  /** Runs of one automation, newest first (configurers and health viewers of its scope). */
  async listAutomationRuns(
    caller: Caller,
    ws: unknown,
    aut: unknown,
    query: Record<string, unknown> = {},
  ) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const a = await this.#visible(tx, p, aut);
      const limit = Math.min(Number(query.limit ?? 25) || 25, RUNS_PAGE_MAX);
      let q = tx.db
        .selectFrom('automation.automation_run as r')
        .innerJoin('exec.operation as o', 'o.id', 'r.current_operation_id')
        .select(['o.public_id'])
        .where('r.automation_id', '=', a.id)
        .orderBy('r.created_at', 'desc')
        .orderBy('r.id', 'desc')
        .limit(limit);
      if (typeof query.before === 'string' && /^\d{4}-/.test(query.before))
        q = q.where('r.created_at', '<', new Date(query.before));
      const rows = await q.execute();
      const data = [];
      for (const r of rows) data.push(await this.#runView(tx, p, r.public_id, false));
      return {
        data,
        page: {
          next_cursor:
            rows.length === limit
              ? (data[data.length - 1] as { created_at: string }).created_at
              : null,
        },
      };
    });
  }

  /**
   * Automation run history as export rows (DATA-013, 8A portion) through the 6D boundary: the runs
   * of every automation the caller may configure or watch, each rendered exactly as its run page
   * renders it now (current access; records the caller cannot read are omitted). Bounded; trashed
   * and purged automations and raw event bodies are never exported.
   */
  protected override async moduleHistoryRows(
    caller: Caller,
    ws: unknown,
    kind: string,
    max: number,
  ): Promise<Record<string, unknown>[] | null> {
    if (kind !== 'automation_history') return super.moduleHistoryRows(caller, ws, kind, max);
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      if (p.kind !== 'member') throw new TenancyError('not_found');
      const automations = await tx.db
        .selectFrom('automation.automation')
        .select(['id', 'brand_id'])
        .where('lifecycle_state', 'in', ['active', 'archived'])
        .execute();
      const visible: string[] = [];
      for (const a of automations) {
        const configure = await this.#decideScope(tx, p, 'automations.configure', a.brand_id);
        const health = await this.#decideScope(tx, p, 'health.view', a.brand_id);
        if (configure.allowed || health.allowed) visible.push(a.id);
      }
      if (!visible.length) return [];
      const runs = await tx.db
        .selectFrom('automation.automation_run as r')
        .innerJoin('exec.operation as o', 'o.id', 'r.operation_id')
        .select('o.public_id')
        .where('r.automation_id', 'in', visible)
        .orderBy('r.created_at')
        .orderBy('r.id')
        .limit(max + 1)
        .execute();
      if (runs.length > max) throw new TenancyError('limit_exceeded');
      const out: Record<string, unknown>[] = [];
      for (const r of runs) {
        const run = await this.#runView(tx, p, r.public_id);
        out.push({ public_id: run.id, host_public_id: run.automation.id, data: run });
      }
      return out;
    });
  }

  async getAutomationRun(caller: Caller, ws: unknown, op: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) =>
      this.#runView(tx, p, op),
    );
  }

  /**
   * A run addressed by its first operation or its current one: a link taken before a retry (a
   * notification, the history) keeps opening the same run, which shows its current attempt.
   */
  async #runByOp(tx: WorkspaceTransaction, op: string) {
    return tx.db
      .selectFrom('automation.automation_run as r')
      .innerJoin('exec.operation as k', (j) =>
        j.on((eb) =>
          eb.or([
            eb('k.id', '=', eb.ref('r.current_operation_id')),
            eb('k.id', '=', eb.ref('r.operation_id')),
          ]),
        ),
      )
      .select(['r.id', 'r.automation_id'])
      .where('k.public_id', '=', op)
      .executeTakeFirst();
  }

  /**
   * One run as a viewer may see it now: history is re-rendered through the viewer's current
   * access (records they cannot read are omitted, never named), with bounded codes.
   */
  async #runView(tx: WorkspaceTransaction, p: Principal, opPublic: unknown, steps = true) {
    if (!isPublic(opPublic, 'op')) throw new TenancyError('not_found');
    const found = await this.#runByOp(tx, opPublic);
    if (!found) throw new TenancyError('not_found');
    const row = await tx.db
      .selectFrom('automation.automation_run as r')
      .innerJoin('exec.operation as o', 'o.id', 'r.current_operation_id')
      .innerJoin('automation.automation_revision as v', 'v.id', 'r.revision_id')
      .selectAll('r')
      .select([
        'o.public_id as op_public_id',
        'o.execution_state',
        'o.waiting_reason',
        'o.terminal_reason',
        'v.revision_number',
      ])
      .where('r.id', '=', found.id)
      .executeTakeFirst();
    if (!row) throw new TenancyError('not_found');
    const a = (await this.#rows(tx, { id: row.automation_id }))!;
    await this.#visible(tx, p, a.public_id);
    const readable = async (publicId: string, type: string) => {
      try {
        if (type === 'task') await this.loadTask(tx, p, publicId);
        else if (type === 'project') await this.loadProject(tx, p, publicId);
        else return false;
        return true;
      } catch (err) {
        if (err instanceof TenancyError) return false;
        throw err;
      }
    };
    let trigger: { id: string; type: string } | null = null;
    if (row.trigger_record_id) {
      const t = await tx.db
        .selectFrom('core.record')
        .select(['public_id', 'record_type'])
        .where('id', '=', row.trigger_record_id)
        .executeTakeFirst();
      if (t && (await readable(t.public_id, t.record_type)))
        trigger = { id: t.public_id, type: t.record_type };
    }
    const filterRefs = async (list: unknown) => {
      if (!Array.isArray(list)) return [];
      const out = [];
      for (const x of list as Array<{ id?: string; type?: string }>)
        if (x.id && x.type && (await readable(x.id, x.type))) out.push({ id: x.id, type: x.type });
      return out;
    };
    const stepRows = steps
      ? await tx.db
          .selectFrom('automation.automation_step_run')
          .selectAll()
          .where('run_id', '=', row.id)
          .orderBy('started_at')
          .orderBy('id')
          .limit(500)
          .execute()
      : [];
    const stepViews = [];
    for (const s of stepRows) {
      const out = (s.output ?? {}) as Record<string, unknown>;
      const view: Record<string, unknown> = {
        node: s.node_id,
        attempt: s.attempt,
        kind: s.kind,
        action: s.action_key,
        state: s.state,
        failure_class: s.failure_class,
        code: s.code,
        decision: s.decision,
        targets: await filterRefs(s.targets),
        started_at: new Date(s.started_at).toISOString(),
        ended_at: s.ended_at ? new Date(s.ended_at).toISOString() : null,
        duration_ms: s.ended_at
          ? new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()
          : null,
      };
      if (out.created) view.created = await filterRefs(out.created);
      if (out.changed) view.changed = await filterRefs(out.changed);
      if (out.ai_run) view.ai_run = out.ai_run;
      if (out.review_required !== undefined) view.review_required = out.review_required;
      if (out.webhook) view.webhook = { id: out.webhook, fields: out.fields };
      if (out.notifications !== undefined) view.notifications = out.notifications;
      stepViews.push(view);
    }
    const status = this.#displayStatus(row.status, row.execution_state);
    const configure = (await this.#decideScope(tx, p, 'automations.configure', a.brand_id)).allowed;
    const uncertain = row.status === 'waiting' && row.reason === 'reconciliation_required';
    // P8-W0: what may have left, with the version a reconciliation must name (owners and
    // administrators decide it under step-up through the existing operations command).
    const effects = uncertain
      ? (
          await tx.db
            .selectFrom('exec.external_effect')
            .select(['effect_key', 'state', 'version', 'uncertainty_reason'])
            .where('operation_id', '=', row.current_operation_id)
            .where('state', '=', 'unknown')
            .execute()
        ).map((e) => ({
          key: e.effect_key,
          state: e.state,
          version: Number(e.version),
          reason: e.uncertainty_reason,
          destination: 'automation webhook',
        }))
      : [];
    return {
      id: row.op_public_id,
      type: 'automation_run' as const,
      automation: { id: a.public_id, name: a.name },
      revision: row.revision_number,
      status,
      reason: row.reason,
      operation_state: row.execution_state,
      trigger: { kind: row.trigger_kind, record: trigger },
      chain_depth: row.chain_depth,
      steps_executed: row.steps_executed,
      retries: row.retry_count,
      wake_at: row.wake_at ? new Date(row.wake_at).toISOString() : null,
      created_at: new Date(row.created_at).toISOString(),
      started_at: row.started_at ? new Date(row.started_at).toISOString() : null,
      ended_at: row.ended_at ? new Date(row.ended_at).toISOString() : null,
      duration_ms:
        row.ended_at && row.started_at
          ? new Date(row.ended_at).getTime() - new Date(row.started_at).getTime()
          : null,
      explanation: this.#explain(status, row.reason),
      reconciliation_required: uncertain,
      effects,
      steps: stepViews,
      capabilities: {
        reconcile: uncertain && decideWorkspace(p, 'operation.reconcile_effect').allowed,
        retry:
          configure &&
          (row.status === 'failed' || row.status === 'policy_rejected') &&
          row.retry_count < this.ws.automationRetriesMax,
        cancel: configure && OPEN.includes(row.status as AutomationRunStatus) && !uncertain,
      },
    };
  }

  #explain(status: string, reason: string | null): string {
    const by: Record<string, string> = {
      conditions_not_met: 'The conditions were not met, so nothing ran.',
      out_of_scope: 'The record was not available to this automation, so nothing ran.',
      loop_guard: 'Stopped to prevent an automation loop.',
      concurrency_limit: 'Too many runs of this automation were already in progress.',
      monthly_limit: 'This workspace reached its automation run limit for the month.',
      owner_departed: 'The owner left, so the automation was suspended.',
      owner_authority:
        'The owner no longer has access to this automation’s scope, so it was suspended.',
      not_permitted: 'A step was not permitted with the automation’s current access.',
      input_unavailable: 'A value the conditions need is not available to this automation.',
      approval_invalid: 'The webhook approval no longer matches its destination or fields.',
      reconciliation_required:
        'A webhook may have been sent; an owner or administrator must confirm what happened before it continues.',
      delay: 'Waiting for a delay to end.',
      fallback_taken: 'A step failed and its fallback ran. Some work may not have happened.',
      automation_disabled: 'Stopped because the automation was disabled.',
      automation_suspended: 'Stopped because the automation was suspended.',
      automation_archived: 'Stopped because the automation was archived.',
      ai_unconfigured: 'AI is not configured for this deployment; no draft was requested.',
      ai_disabled: 'AI is turned off for this workspace; no draft was requested.',
      human_only: 'This step needs a person to confirm it.',
    };
    if (reason && by[reason]) return by[reason];
    switch (status) {
      case 'succeeded':
        return 'Every step finished.';
      case 'failed':
        return 'A step failed. Earlier steps are kept; retry runs the failed step again.';
      case 'policy_rejected':
        return 'A step was refused by the automation’s current access.';
      case 'cancelled':
        return 'The run was cancelled before it finished.';
      case 'skipped':
        return 'Nothing ran.';
      case 'waiting':
        return 'Waiting.';
      default:
        return 'In progress.';
    }
  }

  /**
   * Retry (AUTO-015): a new operation on the same run that resumes at the failed step; steps that
   * succeeded are never repeated (their logical keys bind the run, not the attempt), and every
   * step reauthorizes. Refused while any effect of the run is uncertain (reconcile first).
   */
  async retryAutomationRun(caller: Caller, ws: unknown, op: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'automation.run_retry',
      ws,
      req,
      async (tx, p) => {
        if (!isPublic(op, 'op')) throw new TenancyError('not_found');
        const found = await this.#runByOp(tx, op);
        if (!found) throw new TenancyError('not_found');
        const a = (await this.#rows(tx, { id: found.automation_id }, true))!;
        await this.#visible(tx, p, a.public_id, { need: 'configure' });
        if (p.kind !== 'member') throw new TenancyError('forbidden');
        const run = (await this.#runRow(tx, found.id, true))!;
        if (run.status !== 'failed' && run.status !== 'policy_rejected')
          throw new TenancyError('conflict', {
            issues: [issue('/', 'not_retryable', 'Only failed runs can be retried.')],
          });
        if (run.retry_count >= this.ws.automationRetriesMax)
          throw new TenancyError('conflict', {
            issues: [issue('/', 'retry_limit', 'This run was retried too many times.')],
          });
        if (!a.enabled)
          throw new TenancyError('conflict', {
            issues: [
              issue('/', 'automation_disabled', 'Activate this automation to retry its runs.'),
            ],
          });
        const opRow = await tx.db
          .selectFrom('exec.operation')
          .selectAll()
          .where('id', '=', run.current_operation_id)
          .executeTakeFirstOrThrow();
        if (!isTerminalState(opRow.execution_state))
          throw new TenancyError('conflict', {
            issues: [issue('/', 'not_retryable', 'This run is still in progress.')],
          });
        if ((await uncertainEffects(tx, run.current_operation_id)).length)
          throw new TenancyError('conflict', {
            issues: [
              issue('/', 'reconciliation_required', 'Confirm what happened to its webhook first.'),
            ],
          });
        const slot = await tx.db
          .updateTable('automation.automation')
          .set({ active_runs: sql`active_runs + 1` })
          .where('id', '=', a.id)
          .where('active_runs', '<', this.ws.automationActiveRunsMax)
          .returning('id')
          .executeTakeFirst();
        if (!slot)
          throw new TenancyError('conflict', {
            issues: [
              issue('/', 'concurrency_limit', 'Too many runs of this automation are in progress.'),
            ],
          });
        const context = contextFromRow(opRow as never);
        const next = await createOperation(tx, {
          kind: 'automation_run',
          context,
          initiatedBy: { type: 'human', id: p.membershipId },
          rerunOfOperationId: run.current_operation_id,
        });
        // The failed step's cursor stays; a run refused at admission starts its admission again.
        await tx.db
          .updateTable('automation.automation_run')
          .set({
            current_operation_id: next.id,
            status: 'queued',
            reason: null,
            ended_at: null,
            slot_held: true,
            retry_count: run.retry_count + 1,
            updated_at: new Date(),
            version: sql`version + 1`,
          })
          .where('id', '=', run.id)
          .execute();
        await enqueueJob(tx, {
          queue: AUTOMATION_QUEUE,
          kind: AUTOMATION_RUN_JOB,
          context,
          operationId: next.id,
          payloadRef: run.id,
          maxAttempts: RUN_JOB_ATTEMPTS,
          timeoutSeconds: RUN_JOB_TIMEOUT_SECONDS,
        });
        await writeOutboxEvent(tx, {
          type: 'execution.operation.state_changed',
          aggregate: { type: 'execution.operation', id: next.id, sequence: 0 },
          data: {
            kind: 'automation_run',
            state: 'queued',
            terminal_reason: null,
            waiting_reason: null,
          },
          actor: { type: 'human', id: p.membershipId },
          context: { ...context, workspaceId: tx.workspaceId },
          operationId: next.id,
        });
        await this.workAudit(
          tx,
          caller,
          p,
          'automation.run_retried',
          { recordId: a.id, type: 'automation', publicId: a.public_id },
          [change.plain('run', opRow.public_id, next.publicId)],
          a.brand_id,
        );
        return {
          status: 202,
          ref: { id: next.publicId, type: 'automation_run' },
          data: await this.#runView(tx, p, next.publicId),
        };
      },
      async (tx, p, ref) => this.#runView(tx, p, ref.id),
    );
  }

  /** Cancels an open run: undispatched steps stop; what may have left keeps its liability. */
  async cancelAutomationRun(caller: Caller, ws: unknown, op: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'automation.run_cancel',
      ws,
      req,
      async (tx, p) => {
        if (!isPublic(op, 'op')) throw new TenancyError('not_found');
        const found = await this.#runByOp(tx, op);
        if (!found) throw new TenancyError('not_found');
        const a = (await this.#rows(tx, { id: found.automation_id }))!;
        await this.#visible(tx, p, a.public_id, { need: 'configure' });
        const run = (await this.#runRow(tx, found.id, true))!;
        if (!OPEN.includes(run.status) || run.reason === 'reconciliation_required')
          throw new TenancyError('conflict', {
            issues: [issue('/', 'not_cancellable', 'This run cannot be cancelled now.')],
          });
        const opRow = await tx.db
          .selectFrom('exec.operation')
          .select(['execution_state'])
          .where('id', '=', run.current_operation_id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (opRow.execution_state === 'waiting' || opRow.execution_state === 'queued') {
          const jobs = await tx.db
            .selectFrom('exec.job')
            .select('id')
            .where('operation_id', '=', run.current_operation_id)
            .where('state', 'in', ['queued', 'retry_scheduled'])
            .execute();
          for (const j of jobs) await requestJobCancel(tx, j.id);
          await this.#terminalize(tx, run, 'cancelled', 'user_cancelled');
          await transitionOperation(tx, {
            operationId: run.current_operation_id,
            to: 'cancelled',
            terminalReason: 'user_cancelled',
            actor: { type: 'human', id: p.membershipId },
            context: await this.#runContext(tx, run),
          });
        } else {
          await requestOperationCancel(tx, run.current_operation_id);
        }
        await this.workAudit(
          tx,
          caller,
          p,
          'automation.run_cancelled',
          { recordId: a.id, type: 'automation', publicId: a.public_id },
          [change.plain('run', null, op)],
          a.brand_id,
        );
        return {
          status: 202,
          ref: { id: op as string, type: 'automation_run' },
          data: await this.#runView(tx, p, op),
        };
      },
      async (tx, p, ref) => this.#runView(tx, p, ref.id),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Usage, limits, and health (AUTO-017, AUTO-018, ADM-010, REL-006)
  // ---------------------------------------------------------------------------------------------

  async automationUsage(caller: Caller, ws: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      if (p.kind !== 'member') throw new TenancyError('not_found');
      const scopes = await this.#configurableScopes(tx, p);
      const health = decideWorkspace(p, 'health.view').allowed;
      if (!scopes.workspace && !scopes.brands.length && !health)
        throw new TenancyError('forbidden');
      const period = monthStart(new Date());
      const u = await tx.db
        .selectFrom('automation.usage_period')
        .selectAll()
        .where('period_start', '=', period)
        .executeTakeFirst();
      const runs = u ? Number(u.runs_reserved) - Number(u.runs_released) : 0;
      return {
        period_start: period,
        measured: {
          runs,
          runs_finished: u ? Number(u.runs_settled) : 0,
          steps: u ? Number(u.steps_executed) : 0,
        },
        technical_limits: {
          runs_per_month: this.ws.automationRunsPerMonth,
          active_runs_per_automation: this.ws.automationActiveRunsMax,
          steps_per_run: this.ws.automationRunStepsMax,
          chain_depth: this.ws.automationChainDepthMax,
          target_fanout: this.ws.automationTargetFanoutMax,
          delay_horizon_minutes: this.ws.automationDelayHorizonMinutes,
          retries_per_run: this.ws.automationRetriesMax,
          automations_per_workspace: this.ws.automationsPerWorkspaceMax,
        },
        // 10A owns plans: no plan allowance is invented here.
        plan_entitlement: {
          status: 'unavailable',
          owner_phase: '10A',
          note: 'Plan limits arrive with billing. These are the deployment’s technical limits.',
        },
      };
    });
  }

  /** Health (ADM-010) for the automations the person may see: counts and attention items. */
  async automationHealth(caller: Caller, ws: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      if (p.kind !== 'member') throw new TenancyError('not_found');
      const rows = await tx.db
        .selectFrom('automation.automation as a')
        .innerJoin('core.record as r', 'r.id', 'a.id')
        .select([
          'a.id',
          'r.public_id',
          'a.name',
          'a.brand_id',
          'a.enabled',
          'a.suspended_reason',
          'a.consecutive_failures',
        ])
        .where('a.lifecycle_state', '=', 'active')
        .limit(this.ws.automationsPerWorkspaceMax)
        .execute();
      const since = new Date(Date.now() - 30 * 86_400_000);
      const items = [];
      const totals: Record<string, number> = {};
      for (const a of rows) {
        const c = await this.#decideScope(tx, p, 'automations.configure', a.brand_id);
        const h = await this.#decideScope(tx, p, 'health.view', a.brand_id);
        if (!c.allowed && !h.allowed) continue;
        const counts = await tx.db
          .selectFrom('automation.automation_run')
          .select(['status', (eb) => eb.fn.countAll<string>().as('n')])
          .where('automation_id', '=', a.id)
          .where('created_at', '>=', since)
          .groupBy('status')
          .execute();
        const by = Object.fromEntries(counts.map((x) => [x.status, Number(x.n)]));
        for (const [k, v] of Object.entries(by)) totals[k] = (totals[k] ?? 0) + v;
        items.push({
          id: a.public_id,
          name: a.name,
          state: a.suspended_reason ? 'suspended' : a.enabled ? 'active' : 'disabled',
          suspended_reason: a.suspended_reason,
          failures_in_a_row: a.consecutive_failures,
          runs_30d: by,
        });
      }
      return { window_days: 30, totals, automations: items };
    });
  }

  /** The trigger catalog with each source's availability (configuration shows the unavailable). */
  static readonly TRIGGER_CATALOG = TRIGGERS;
}
