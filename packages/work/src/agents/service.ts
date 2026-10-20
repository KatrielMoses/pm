import { createHash, randomBytes } from 'node:crypto';
import { change } from '@pm/audit';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import { sql, type WorkspaceTransaction } from '@pm/db';
import {
  createOperation,
  defineEffectDestination,
  enqueueJob,
  JobError,
  type JobHandlerContext,
  type JobResult,
} from '@pm/platform';
import {
  compilePrincipal,
  decideWorkspace,
  invalid,
  issue,
  levelRank,
  parseIfMatch,
  recordLevel,
  requireVersion,
  TenancyError,
  type Caller,
  type Level,
  type Mutation,
  type Principal,
} from '@pm/tenancy';
import { AutomationService } from '../automation/service.ts';
import { isPublic } from '../validation.ts';
import {
  APPROVAL_ORDER,
  compileConfig,
  ConfigError,
  missingConfiguration,
  PROFILE_SCHEMA_VERSION,
  TOOL_CLASSES,
  type CompiledConfig,
  type ConfigLimits,
  type ConnectorKind,
  type ScopeKind,
} from './config.ts';
import {
  checkEndpoint,
  handshake,
  isOwnCredential,
  type HandshakeCode,
  type Manifest,
} from './connectors.ts';
import { MODELS } from '../ai/registry.ts';
import { agentTemplate, AGENT_TEMPLATES } from './templates.ts';
import { AGENT_TOOLS, agentTool, type AgentToolClass } from './tool-registry.ts';

/** The agent connector handshake: a probe with no side effect at the peer (safe to repeat). */
export const AGENT_CONNECTOR_TEST_DESTINATION = defineEffectDestination(
  'agents.connector_test',
  'naturally_idempotent',
  'pm-agent-handshake.v1',
);
export const AGENT_CONNECTOR_TEST_JOB = 'agents.connector_test';
export const AGENT_QUEUE = 'default';

/** Where connectors may be tested from (0D PL-54). */
export interface AgentDeps {
  /** `none`: tests are unavailable; `fixture`: the local synthetic peer (local and test only). */
  transport: 'none' | 'fixture';
  /** The product's own public origin (its inbound API and MCP endpoints are never a connector). */
  productOrigin: string | null;
  /** Injected for tests (the real global fetch otherwise). */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

type ProfileState = 'draft' | 'active' | 'disabled' | 'suspended';
interface ProfileRow {
  id: string;
  public_id: string;
  workspace_id: string;
  lifecycle_state: 'active' | 'archived' | 'trashed' | 'purged';
  kind: 'internal' | 'external';
  name: string;
  purpose: string | null;
  owner_membership_id: string;
  state: ProfileState;
  active_revision_id: string | null;
  activated_at: Date | null;
  draft: Record<string, unknown>;
  template_key: string | null;
  duplicated_from_id: string | null;
  suspended_reason: string | null;
  created_at: Date;
  updated_at: Date;
  version: number;
}
interface RevisionRow {
  id: string;
  revision_number: number;
  kind: 'internal' | 'external';
  config: Record<string, unknown>;
  config_hash: string;
  model_key: string | null;
  created_at: Date;
}
interface Grants {
  brand: Set<string>;
  project: Set<string>;
  record: Set<string>;
  integration: Set<string>;
  tools: Array<{
    tool: string;
    version: string;
    tool_class: AgentToolClass;
    approval_class: string;
  }>;
}
interface ConnectorRow {
  id: string;
  profile_id: string;
  kind: ConnectorKind;
  endpoint_url: string;
  secret_ref: string | null;
  config_version: number;
  state: 'configured' | 'verified' | 'stale' | 'revoked' | 'unavailable';
  verified_version: number | null;
  verified_at: Date | null;
  verified_synthetic: boolean;
  capabilities: Record<string, unknown> | null;
  last_code: string | null;
  last_tested_at: Date | null;
  disconnected_at: Date | null;
  version: number;
}
/** One resolved scope item (internal ids) with the record type of a record grant. */
interface ScopeItem {
  kind: ScopeKind;
  id: string;
  publicId: string;
  recordType?: 'task' | 'project' | 'document';
}
type TestDecision =
  | { closed: true }
  | { stale: true }
  | { refused: string }
  | { send: { kind: ConnectorKind; endpoint: string; secret: string } };
interface AssignmentInput {
  profile: unknown;
  goal: string;
  constraints: string | null;
  deliverable: string | null;
  criteria: string[];
  context: string[];
  scope: Record<ScopeKind, string[]> | null;
}
type Readiness = {
  state: 'ready' | 'not_ready';
  reasons: string[];
  synthetic: boolean;
};

const EXECUTION = {
  available: false,
  owner: '8C',
  note: 'Assigned agents run when durable agent runs arrive (Phase 8C). Nothing has been sent to an agent.',
} as const;
const PROFILE_FIELDS = ['name', 'purpose', 'kind', 'template', 'draft'];
/** Assignment-level reasons every task reader may see; profile facts collapse to `agent_not_ready`. */
const ASSIGNMENT_REASONS = new Set([
  'assigner_unavailable',
  'assigner_authority',
  'task_ineligible',
  'scope_lost',
]);
const LEVEL_ORDER: Level[] = ['view', 'comment', 'edit', 'manage'];
const blankDraft = (kind: 'internal' | 'external') => ({
  schema_version: PROFILE_SCHEMA_VERSION,
  kind,
  instructions: '',
  model_key: null,
  limits: {},
  tools: [],
  scope: { brands: [], projects: [], records: [], integrations: [] },
  approval_policy: {},
});
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Phase 8B agent profiles, connectors, and scoped task assignments (ADR-0047; 0B ADR-52, 0C
 * AZ-52, 0D PL-54). Extends the 8A head of the work chain. It configures and assigns agents; it
 * never runs one: there is no run, run credential, tool execution, or dispatch here (8C), and no
 * per-instance approval or acceptance (8D). Every command decides now, for this person; an agent
 * is never a principal of its own in this phase.
 */
export class AgentService extends AutomationService {
  readonly #agents: AgentDeps;

  constructor(deps: ConstructorParameters<typeof AutomationService>[0] & { agents?: AgentDeps }) {
    super(deps);
    this.#agents = deps.agents ?? { transport: 'none', productOrigin: null };
  }

  #limits(): ConfigLimits {
    return {
      instructionsMaxChars: this.ws.agentInstructionsMaxChars,
      scopeGrantsMax: this.ws.agentScopeGrantsMax,
      toolGrantsMax: this.ws.agentToolGrantsMax,
      configBytesMax: this.ws.agentConfigBytesMax,
    };
  }

  /** Session-only commands refuse delegated callers before any idempotency work (and on replay). */
  #sessionOnly(caller: Caller) {
    if (caller.delegation) throw new TenancyError('forbidden');
  }

  #configure(p: Principal) {
    if (p.kind !== 'member') throw new TenancyError('not_found');
    const o = decideWorkspace(p, 'agents.configure');
    this.decision('agents.configure', o);
    if (!o.allowed) throw new TenancyError('forbidden');
  }

  /** A delegated caller assigns only with `agents:execute` (0D); a session is not narrowed. */
  #assignScope(caller: Caller) {
    if (caller.delegation && !caller.delegation.scopes.includes('agents:execute'))
      throw new TenancyError('forbidden');
  }

  #canConfigure(p: Principal) {
    return p.kind === 'member' && decideWorkspace(p, 'agents.configure').allowed;
  }

  // ---------------------------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------------------------

  async #rows(tx: WorkspaceTransaction, where: { publicId?: string; id?: string }, lock = false) {
    let q = tx.db
      .selectFrom('agents.agent_profile as a')
      .innerJoin('core.record as r', 'r.id', 'a.id')
      .selectAll('a')
      .select('r.public_id');
    if (where.publicId) q = q.where('r.public_id', '=', where.publicId);
    if (where.id) q = q.where('a.id', '=', where.id);
    if (lock) q = q.forUpdate('a');
    const r = await q.executeTakeFirst();
    if (!r) return null;
    return {
      ...r,
      version: Number(r.version),
      draft: r.draft as unknown as Record<string, unknown>,
      created_at: new Date(r.created_at as unknown as string),
      updated_at: new Date(r.updated_at as unknown as string),
      activated_at: r.activated_at ? new Date(r.activated_at as unknown as string) : null,
    } as unknown as ProfileRow;
  }

  /**
   * A profile as this person may see it: members see summaries (name, purpose, kind, state, and
   * readiness, never instructions, grants, or connector details); configurers see everything.
   * Guests and unknown or trashed profiles are the same `not_found`.
   */
  async #visible(
    tx: WorkspaceTransaction,
    p: Principal,
    publicId: unknown,
    opts: { lock?: boolean; need?: 'view' | 'configure'; allowTrashed?: boolean } = {},
  ): Promise<ProfileRow> {
    if (p.kind !== 'member' || !isPublic(publicId, 'agt')) throw new TenancyError('not_found');
    const row = await this.#rows(tx, { publicId }, opts.lock);
    if (!row || row.lifecycle_state === 'purged') throw new TenancyError('not_found');
    if (row.lifecycle_state === 'trashed' && !opts.allowTrashed)
      throw new TenancyError('not_found');
    if (opts.need === 'configure') this.#configure(p);
    return row;
  }

  async #revision(tx: WorkspaceTransaction, id: string): Promise<RevisionRow> {
    const r = await tx.db
      .selectFrom('agents.agent_profile_revision')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return {
      ...r,
      config: r.config as unknown as Record<string, unknown>,
      created_at: new Date(r.created_at as unknown as string),
    } as unknown as RevisionRow;
  }

  async #grants(tx: WorkspaceTransaction, revisionId: string): Promise<Grants> {
    const scope = await tx.db
      .selectFrom('agents.agent_scope_grant')
      .select(['kind', 'target_id'])
      .where('revision_id', '=', revisionId)
      .execute();
    const tools = await tx.db
      .selectFrom('agents.agent_tool_grant')
      .select(['tool', 'tool_version', 'tool_class', 'approval_class'])
      .where('revision_id', '=', revisionId)
      .orderBy('tool')
      .execute();
    const g: Grants = {
      brand: new Set(),
      project: new Set(),
      record: new Set(),
      integration: new Set(),
      tools: tools.map((t) => ({
        tool: t.tool,
        version: t.tool_version,
        tool_class: t.tool_class as AgentToolClass,
        approval_class: t.approval_class,
      })),
    };
    for (const s of scope) g[s.kind as ScopeKind].add(s.target_id);
    return g;
  }

  async #connector(tx: WorkspaceTransaction, profileId: string, lock = false) {
    let q = tx.db
      .selectFrom('agents.agent_connector')
      .selectAll()
      .where('profile_id', '=', profileId);
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    return r ? ({ ...r, version: Number(r.version) } as unknown as ConnectorRow) : null;
  }

  async #memberPrincipal(
    tx: WorkspaceTransaction,
    membershipId: string,
  ): Promise<Principal | null> {
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

  async #member(tx: WorkspaceTransaction, membershipId: string) {
    const m = await tx.db
      .selectFrom('tenancy.membership as m')
      .innerJoin('identity.account as a', 'a.id', 'm.account_id')
      .select(['m.public_id', 'm.state', 'a.display_name'])
      .where('m.id', '=', membershipId)
      .executeTakeFirst();
    return m ? { id: m.public_id, name: m.display_name, active: m.state === 'active' } : null;
  }

  // ---------------------------------------------------------------------------------------------
  // Scope: resolving references, a person's level on an item, containment in grants
  // ---------------------------------------------------------------------------------------------

  /** Resolves public references to items the person can see through their own authority. */
  async #resolveScope(
    tx: WorkspaceTransaction,
    p: Principal,
    scope: Record<ScopeKind, string[]>,
    pointer = '/scope',
  ): Promise<ScopeItem[]> {
    const out: ScopeItem[] = [];
    const issues = [];
    for (const kind of ['brand', 'project', 'record', 'integration'] as const) {
      for (const [i, pub] of scope[kind].entries()) {
        const item = await this.#find(tx, kind, pub);
        if (!item || (await this.#levelOn(tx, p, item)) === null)
          issues.push(
            issue(`${pointer}/${kind}s/${i}`, 'invalid_reference', 'Choose an item you can open.'),
          );
        else out.push(item);
      }
    }
    if (issues.length) throw invalid(...issues);
    return out;
  }

  async #find(tx: WorkspaceTransaction, kind: ScopeKind, pub: string): Promise<ScopeItem | null> {
    if (kind === 'integration') {
      const id = await this.connectionIdOf(tx, pub);
      return id ? { kind, id, publicId: pub } : null;
    }
    const r = await tx.db
      .selectFrom('core.record')
      .select(['id', 'record_type', 'lifecycle_state'])
      .where('public_id', '=', pub)
      .executeTakeFirst();
    if (!r || r.lifecycle_state !== 'active') return null;
    if (kind === 'brand')
      return r.record_type === 'brand' ? { kind, id: r.id, publicId: pub } : null;
    if (kind === 'project')
      return r.record_type === 'project' ? { kind, id: r.id, publicId: pub } : null;
    if (r.record_type !== 'task' && r.record_type !== 'project' && r.record_type !== 'document')
      return null;
    return { kind, id: r.id, publicId: pub, recordType: r.record_type };
  }

  /**
   * A person's own level on a scope item (shares never count: delegating needs own authority).
   * Integrations: `view` when the person can see the connection (its records keep their own
   * authorization). Null when it is not readable now.
   */
  async #levelOn(tx: WorkspaceTransaction, p: Principal, item: ScopeItem): Promise<Level | null> {
    try {
      if (item.kind === 'integration')
        return (await this.connectionVisibleTo(tx, p, item.id)) ? 'view' : null;
      if (item.kind === 'brand') {
        const { facts } = await this.brandFactsOf(tx, item.id);
        if (facts.lifecycleState !== 'active') return null;
        return recordLevel(p, {
          brand: facts,
          lifecycleState: 'active',
          shareLevel: null,
          projectChain: [],
        });
      }
      if (item.kind === 'project' || item.recordType === 'project')
        return (await this.loadProject(tx, p, item.publicId)).ownLevel;
      if (item.recordType === 'task') return (await this.loadTask(tx, p, item.publicId)).ownLevel;
      return (await this.loadDocument(tx, p, item.publicId)).ownLevel;
    } catch (err) {
      if (err instanceof TenancyError) return null;
      throw err;
    }
  }

  /** The brand, project chain, and id of a record or project (for containment in grants). */
  async #placement(tx: WorkspaceTransaction, item: ScopeItem) {
    if (item.kind === 'brand') return { brand: item.id, chain: [] as string[] };
    if (item.kind === 'integration') return null;
    const kind = item.kind === 'project' ? 'project' : item.recordType;
    if (kind === 'task') {
      const t = await tx.db
        .selectFrom('work.task')
        .select(['brand_id', 'project_id'])
        .where('id', '=', item.id)
        .executeTakeFirst();
      if (!t) return null;
      return {
        brand: t.brand_id,
        chain: (await this.chainOfProject(tx, t.project_id)).map((c) => c.id),
      };
    }
    if (kind === 'project') {
      const pr = await tx.db
        .selectFrom('work.project')
        .select(['brand_id'])
        .where('id', '=', item.id)
        .executeTakeFirst();
      if (!pr) return null;
      return {
        brand: pr.brand_id,
        chain: (await this.chainOfProject(tx, item.id)).map((c) => c.id),
      };
    }
    const d = await tx.db
      .selectFrom('knowledge.document as d')
      .leftJoin('work.task as t', 't.id', 'd.attached_task_id')
      .select(['d.brand_id', 'd.attached_project_id', 't.project_id as task_project_id'])
      .where('d.id', '=', item.id)
      .executeTakeFirst();
    if (!d || !d.brand_id) return null;
    const governing = d.attached_project_id ?? d.task_project_id ?? null;
    return {
      brand: d.brand_id,
      chain: (await this.chainOfProject(tx, governing)).map((c) => c.id),
    };
  }

  /**
   * Whether an item lies inside a set of grants, by the accepted containment rules: a brand grant
   * covers its projects and records; a project grant covers its subprojects and their records;
   * a record grant covers that record only; an integration grant covers that connection only and
   * never the records behind it.
   */
  async #within(tx: WorkspaceTransaction, item: ScopeItem, g: Pick<Grants, ScopeKind>) {
    if (item.kind === 'integration') return g.integration.has(item.id);
    if (item.kind === 'record' && g.record.has(item.id)) return true;
    const place = await this.#placement(tx, item);
    if (!place) return false;
    if (g.brand.has(place.brand)) return true;
    if (item.kind === 'brand') return false;
    return place.chain.some((id) => g.project.has(id));
  }

  #requiredLevel(tools: Array<{ tool_class: AgentToolClass }>): Level {
    let need: Level = 'view';
    for (const t of tools) {
      const l = TOOL_CLASSES[t.tool_class].level;
      if (LEVEL_ORDER.indexOf(l) > LEVEL_ORDER.indexOf(need)) need = l;
    }
    return need;
  }

  /**
   * Grantability (I-11): the person holds `agents.configure` and, on every scope item, at least
   * the level the granted tool classes need there. Returns the failing pointers (opaque).
   */
  async #grantable(
    tx: WorkspaceTransaction,
    p: Principal | null,
    items: ScopeItem[],
    need: Level,
    who: 'configurer' | 'owner',
  ) {
    if (!p || !decideWorkspace(p, 'agents.configure').allowed)
      return [
        issue(
          `/${who}`,
          'not_grantable',
          who === 'owner'
            ? 'The owner cannot configure agents now.'
            : 'You cannot configure agents.',
        ),
      ];
    const out = [];
    for (const item of items) {
      const l = await this.#levelOn(tx, p, item);
      if (levelRank(l) < levelRank(need))
        out.push(
          issue(
            `/scope/${item.kind}s`,
            'not_grantable',
            who === 'owner'
              ? 'The owner cannot grant this item at the level its tools need.'
              : 'You cannot grant this item at the level its tools need.',
          ),
        );
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Readiness and views
  // ---------------------------------------------------------------------------------------------

  /** Whether a profile could take work now (assignment readiness builds on it). */
  async #readiness(tx: WorkspaceTransaction, row: ProfileRow): Promise<Readiness> {
    const reasons: string[] = [];
    let synthetic = false;
    if (row.lifecycle_state !== 'active') reasons.push('archived');
    if (row.state === 'draft') reasons.push('not_activated');
    if (row.state === 'disabled') reasons.push('disabled');
    if (row.state === 'suspended') reasons.push(row.suspended_reason ?? 'suspended');
    const owner = await this.#memberPrincipal(tx, row.owner_membership_id);
    if (!owner) reasons.push('owner_unavailable');
    if (row.active_revision_id) {
      const rev = await this.#revision(tx, row.active_revision_id);
      // The owner's authority is decided now (I-12): an owner who can no longer grant the active
      // revision's scope at the level its tools need makes the profile not ready until a person
      // validates it again (reassignment or reactivation), without waiting for a sweep.
      if (owner && row.state === 'active') {
        const g = await this.#grants(tx, rev.id);
        const items = await this.#itemsOf(tx, g);
        if ((await this.#grantable(tx, owner, items, this.#requiredLevel(g.tools), 'owner')).length)
          reasons.push('owner_authority');
      }
      if (row.kind === 'internal') {
        const a = await this.agentModelAvailability(tx, rev.model_key);
        if (a.availability !== 'ready') reasons.push(`model_${a.availability}`);
        else synthetic = a.model?.synthetic === true;
      }
    }
    if (row.kind === 'external') {
      const c = await this.#connector(tx, row.id);
      if (!c || c.state === 'revoked') reasons.push('connector_missing');
      else if (c.state !== 'verified' || c.verified_version !== c.config_version)
        reasons.push(
          c.state === 'unavailable' ? 'connector_unavailable' : 'connector_not_verified',
        );
      else synthetic = c.verified_synthetic;
    }
    return {
      state: reasons.length ? 'not_ready' : 'ready',
      reasons: [...new Set(reasons)],
      synthetic,
    };
  }

  async #summary(tx: WorkspaceTransaction, p: Principal, row: ProfileRow) {
    const configure = this.#canConfigure(p);
    return {
      id: row.public_id,
      type: 'agent_profile' as const,
      name: row.name,
      purpose: row.purpose,
      kind: row.kind,
      state: row.lifecycle_state === 'active' ? row.state : (row.lifecycle_state as string),
      suspended_reason: row.suspended_reason,
      owner: await this.#member(tx, row.owner_membership_id),
      template: row.template_key,
      readiness: await this.#readiness(tx, row),
      execution: EXECUTION,
      capabilities: {
        configure,
        assign: row.state === 'active' && row.lifecycle_state === 'active',
      },
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
      version: row.version,
    };
  }

  /** What a configurer sees: the draft and its status, the active revision, and the connector. */
  async #full(tx: WorkspaceTransaction, p: Principal, row: ProfileRow) {
    const summary = await this.#summary(tx, p, row);
    if (!summary.capabilities.configure) return summary;
    const connector = await this.#connector(tx, row.id);
    let status: Record<string, unknown>;
    try {
      const c = compileConfig(row.draft, this.#limits());
      status = {
        valid: true,
        issues: [],
        unavailable: c.unavailable,
        missing: missingConfiguration(
          c,
          connector && connector.state !== 'revoked' ? { configured: true } : null,
        ),
        matches_active: false,
      };
      if (row.active_revision_id) {
        const rev = await this.#revision(tx, row.active_revision_id);
        status.matches_active = rev.config_hash === this.#hash(c);
      }
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      status = {
        valid: false,
        issues: err.issues,
        unavailable: [],
        missing: [],
        matches_active: false,
      };
    }
    let active: Record<string, unknown> | null = null;
    if (row.active_revision_id) {
      const rev = await this.#revision(tx, row.active_revision_id);
      const g = await this.#grants(tx, rev.id);
      active = {
        revision: rev.revision_number,
        model_key: rev.model_key,
        limits: (rev.config as { limits?: unknown }).limits ?? {},
        tools: g.tools,
        scope: await this.#scopeView(tx, p, g),
        activated_at: row.activated_at?.toISOString() ?? null,
      };
    }
    return {
      ...summary,
      draft: row.draft,
      draft_status: status,
      active_revision: active,
      connector: connector ? this.#connectorView(connector) : null,
    };
  }

  /**
   * Grants as this viewer may see them (review 01 R1): items they can open are named; every other
   * item is omitted completely. No count, total, flag, or placeholder reveals whether or how many
   * items are hidden.
   */
  async #scopeView(tx: WorkspaceTransaction, p: Principal, g: Pick<Grants, ScopeKind>) {
    const out: Array<{ kind: ScopeKind; id: string; name: string }> = [];
    for (const kind of ['brand', 'project', 'record', 'integration'] as const)
      for (const id of g[kind]) {
        const r =
          kind === 'integration'
            ? await this.connectionVisibleTo(tx, p, id)
            : await this.#named(tx, p, kind, id);
        if (r) out.push({ kind, id: r.publicId, name: r.name });
      }
    return { items: out };
  }

  async #named(tx: WorkspaceTransaction, p: Principal, kind: ScopeKind, id: string) {
    const r = await tx.db
      .selectFrom('core.record')
      .select(['public_id', 'record_type'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) return null;
    const item: ScopeItem = {
      kind,
      id,
      publicId: r.public_id,
      ...(kind === 'record' ? { recordType: r.record_type as 'task' } : {}),
    };
    if ((await this.#levelOn(tx, p, item)) === null) return null;
    const name = await this.#nameOf(tx, r.record_type, id);
    return name === null ? null : { publicId: r.public_id, name };
  }

  async #nameOf(tx: WorkspaceTransaction, type: string, id: string): Promise<string | null> {
    if (type === 'brand')
      return (
        (
          await tx.db
            .selectFrom('tenancy.brand')
            .select('name')
            .where('id', '=', id)
            .executeTakeFirst()
        )?.name ?? null
      );
    if (type === 'project')
      return (
        (
          await tx.db
            .selectFrom('work.project')
            .select('name')
            .where('id', '=', id)
            .executeTakeFirst()
        )?.name ?? null
      );
    if (type === 'task')
      return (
        (
          await tx.db
            .selectFrom('work.task')
            .select('title')
            .where('id', '=', id)
            .executeTakeFirst()
        )?.title ?? null
      );
    if (type === 'document')
      return (
        (
          await tx.db
            .selectFrom('knowledge.document')
            .select('title')
            .where('id', '=', id)
            .executeTakeFirst()
        )?.title ?? null
      );
    return null;
  }

  #connectorView(c: ConnectorRow) {
    return {
      kind: c.kind,
      endpoint_url: c.endpoint_url,
      state: c.state,
      config_version: c.config_version,
      secret_set: c.secret_ref !== null,
      verified: c.state === 'verified' && c.verified_version === c.config_version,
      synthetic: c.verified_synthetic,
      verified_at: c.verified_at ? new Date(c.verified_at).toISOString() : null,
      capabilities: c.capabilities,
      last_code: c.last_code,
      last_tested_at: c.last_tested_at ? new Date(c.last_tested_at).toISOString() : null,
      transport: this.#agents.transport === 'fixture' ? 'synthetic_fixture' : 'unavailable',
      production_note:
        'Live agent connectors need an approved secret store and credentials (DQ-28); only the synthetic local fixture can be tested here.',
    };
  }

  #hash(c: CompiledConfig): string {
    return createHashHex(c.canonical);
  }

  // ---------------------------------------------------------------------------------------------
  // Profiles
  // ---------------------------------------------------------------------------------------------

  listAgentTemplates() {
    return {
      data: AGENT_TEMPLATES.map((t) => ({
        key: t.key,
        name: t.name,
        purpose: t.purpose,
        kind: t.kind,
        needs: t.needs,
      })),
    };
  }

  /** The registered tools a profile can be granted (and the unavailable ones, with their phase). */
  listAgentTools() {
    return {
      data: AGENT_TOOLS.map((t) => ({
        name: t.name,
        version: t.version,
        tool_class: t.tool_class,
        status: t.status,
        owner: t.owner ?? null,
        description: t.description,
        risk: TOOL_CLASSES[t.tool_class].risk,
        minimum_approval: TOOL_CLASSES[t.tool_class].minimum,
      })),
      // Registered models an internal agent may name (whether one can run is the workspace's AI
      // policy, shown as readiness; nothing here enables a model).
      models: MODELS.map((m) => ({ key: m.key, label: m.label, synthetic: m.synthetic })),
    };
  }

  async listAgentProfiles(caller: Caller, ws: unknown, query: Record<string, unknown> = {}) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      if (p.kind !== 'member') throw new TenancyError('not_found');
      const rows = await tx.db
        .selectFrom('agents.agent_profile as a')
        .innerJoin('core.record as r', 'r.id', 'a.id')
        .select(['a.id'])
        .where('a.lifecycle_state', 'in', query.archived === 'true' ? ['archived'] : ['active'])
        .orderBy('a.name')
        .orderBy('a.id')
        .limit(this.ws.agentProfilesPerWorkspaceMax)
        .execute();
      const data = [];
      for (const r of rows)
        data.push(await this.#summary(tx, p, (await this.#rows(tx, { id: r.id }))!));
      return {
        data,
        page: { next_cursor: null },
        capabilities: { create: this.#canConfigure(p) },
      };
    });
  }

  async getAgentProfile(caller: Caller, ws: unknown, agt: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) =>
      this.#full(tx, p, await this.#visible(tx, p, agt)),
    );
  }

  async createAgentProfile(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    this.#sessionOnly(caller);
    const b = isObj(body) ? body : {};
    for (const k of Object.keys(b))
      if (!PROFILE_FIELDS.includes(k))
        throw invalid(issue(`/${k}`, 'unknown_field', 'This field is not accepted.'));
    const template = b.template === undefined ? null : agentTemplate(b.template);
    if (b.template !== undefined && !template)
      throw invalid(issue('/template', 'invalid_option', 'Choose a starter template.'));
    const kind = template?.kind ?? b.kind;
    if (kind !== 'internal' && kind !== 'external')
      throw invalid(issue('/kind', 'invalid_option', 'Choose an internal or an external agent.'));
    const name = typeof b.name === 'string' ? b.name.trim() : (template?.name ?? '');
    if (!name || name.length > 120)
      throw invalid(issue('/name', 'invalid_length', 'Enter a name of 1 to 120 characters.'));
    const purpose =
      b.purpose === undefined || b.purpose === null
        ? (template?.purpose ?? null)
        : String(b.purpose);
    if (purpose !== null && purpose.length > 1000)
      throw invalid(issue('/purpose', 'invalid_length', 'Use up to 1000 characters.'));
    const draft = template ? template.draft() : isObj(b.draft) ? b.draft : blankDraft(kind);
    if (Buffer.byteLength(JSON.stringify(draft)) > 131072)
      throw invalid(issue('/draft', 'too_large', 'This configuration is too large.'));
    if (isObj(draft) && draft.kind !== undefined && draft.kind !== kind)
      throw invalid(
        issue('/draft/kind', 'invalid_option', 'The configuration must match the agent kind.'),
      );
    return this.mutate(
      caller,
      'agent_profile.create',
      ws,
      req,
      async (tx, p) => {
        this.#configure(p);
        // The workspace limit holds under concurrency: creations serialize on one lock.
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'agents.profiles:' + tx.workspaceId}, 0))`.execute(
          tx.db,
        );
        const n = await tx.db
          .selectFrom('agents.agent_profile')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('lifecycle_state', '<>', 'purged')
          .executeTakeFirstOrThrow();
        if (Number(n.n) >= this.ws.agentProfilesPerWorkspaceMax)
          throw new TenancyError('conflict', {
            issues: [
              issue(
                '/',
                'limit_reached',
                `A workspace has at most ${this.ws.agentProfilesPerWorkspaceMax} agents.`,
              ),
            ],
          });
        const id = newUuidV7();
        const publicId = newPublicId('agt');
        const cmd = this.cmd(caller, p, null);
        await tx.db
          .insertInto('core.record')
          .values({
            id,
            public_id: publicId,
            record_type: 'agent_profile',
            workspace_id: tx.workspaceId,
            brand_id: null,
            source_kind: template ? 'template' : 'ui',
            source_ref: null,
            created_by_actor_type: cmd.actor.type,
            created_by_actor_id: cmd.actor.id,
          })
          .execute();
        await tx.db
          .insertInto('agents.agent_profile')
          .values({
            id,
            workspace_id: tx.workspaceId,
            scope_key: tx.workspaceId,
            kind,
            name,
            purpose,
            owner_membership_id: p.membershipId,
            draft: JSON.stringify({ ...draft, kind }),
            template_key: template?.key ?? null,
            created_by_membership_id: p.membershipId,
          })
          .execute();
        await this.workAudit(
          tx,
          caller,
          p,
          'agent_profile.created',
          { recordId: id, type: 'agent_profile', publicId },
          [
            change.plain('name', null, name),
            change.plain('kind', null, kind),
            change.plain('template', null, template?.key ?? null),
          ],
          null,
        );
        return {
          status: 201,
          ref: { id: publicId, type: 'agent_profile' },
          data: await this.#full(tx, p, (await this.#rows(tx, { id }))!),
        };
      },
      async (tx, p, ref) => {
        this.#sessionOnly(caller);
        return this.#full(tx, p, await this.#visible(tx, p, ref.id, { need: 'configure' }));
      },
    );
  }

  /** Draft edits (If-Match): the active revision, and so every assignment, is untouched. */
  async updateAgentProfile(
    caller: Caller,
    ws: unknown,
    agt: unknown,
    body: unknown,
    req: Mutation,
  ) {
    this.#sessionOnly(caller);
    const b = isObj(body) ? body : {};
    for (const k of Object.keys(b))
      if (!['name', 'purpose', 'draft'].includes(k))
        throw invalid(issue(`/${k}`, 'unknown_field', 'This field is not accepted.'));
    return this.mutate(
      caller,
      'agent_profile.update',
      ws,
      req,
      async (tx, p) => {
        const row = await this.#visible(tx, p, agt, { lock: true, need: 'configure' });
        requireVersion(parseIfMatch(req.ifMatch), row.version);
        if (row.lifecycle_state !== 'active')
          throw new TenancyError('conflict', {
            issues: [issue('/', 'profile_archived', 'Restore this agent first.')],
          });
        const set: Record<string, unknown> = {};
        const changes = [];
        if (b.name !== undefined) {
          const name = typeof b.name === 'string' ? b.name.trim() : '';
          if (!name || name.length > 120)
            throw invalid(issue('/name', 'invalid_length', 'Enter a name of 1 to 120 characters.'));
          set.name = name;
          changes.push(change.plain('name', row.name, name));
        }
        if (b.purpose !== undefined) {
          const purpose = b.purpose === null ? null : String(b.purpose);
          if (purpose !== null && purpose.length > 1000)
            throw invalid(issue('/purpose', 'invalid_length', 'Use up to 1000 characters.'));
          set.purpose = purpose;
        }
        if (b.draft !== undefined) {
          if (!isObj(b.draft))
            throw invalid(issue('/draft', 'invalid_type', 'The configuration is an object.'));
          if (b.draft.kind !== undefined && b.draft.kind !== row.kind)
            throw invalid(
              issue('/draft/kind', 'invalid_option', 'The kind of an agent cannot change.'),
            );
          if (Buffer.byteLength(JSON.stringify(b.draft)) > 131072)
            throw invalid(issue('/draft', 'too_large', 'This configuration is too large.'));
          set.draft = JSON.stringify({ ...b.draft, kind: row.kind });
          changes.push(change.plain('draft', 'changed', 'changed'));
        }
        await tx.db
          .updateTable('agents.agent_profile')
          .set({
            ...set,
            updated_by_membership_id: p.membershipId,
            updated_at: new Date(),
            version: sql`version + 1`,
          } as never)
          .where('id', '=', row.id)
          .execute();
        await this.workAudit(
          tx,
          caller,
          p,
          'agent_profile.updated',
          { recordId: row.id, type: 'agent_profile', publicId: row.public_id },
          changes,
          null,
        );
        return {
          status: 200,
          ref: { id: row.public_id, type: 'agent_profile' },
          data: await this.#full(tx, p, (await this.#rows(tx, { id: row.id }))!),
        };
      },
      async (tx, p, ref) => {
        this.#sessionOnly(caller);
        return this.#full(tx, p, await this.#visible(tx, p, ref.id, { need: 'configure' }));
      },
    );
  }

  /**
   * Activation: compiles the draft, refuses unavailable tools and incomplete configuration, and
   * checks grantability for the configurer and the accountable owner on every scope item at the
   * level the granted tool classes need. A new immutable revision (with relational grants) is
   * selected; an identical configuration reuses its revision.
   */
  async activateAgentProfile(caller: Caller, ws: unknown, agt: unknown, req: Mutation) {
    this.#sessionOnly(caller);
    return this.mutate(
      caller,
      'agent_profile.activate',
      ws,
      req,
      async (tx, p) => {
        const row = await this.#visible(tx, p, agt, { lock: true, need: 'configure' });
        if (req.ifMatch !== undefined) requireVersion(parseIfMatch(req.ifMatch), row.version);
        if (row.lifecycle_state !== 'active')
          throw new TenancyError('conflict', {
            issues: [issue('/', 'profile_archived', 'Restore this agent first.')],
          });
        let c: CompiledConfig;
        try {
          c = compileConfig(row.draft, this.#limits());
        } catch (err) {
          if (err instanceof ConfigError)
            throw invalid(
              ...err.issues.map((i) =>
                issue(`/draft${i.pointer === '/' ? '' : i.pointer}`, i.code, i.message),
              ),
            );
          throw err;
        }
        if (c.unavailable.length)
          throw new TenancyError('dependency_unavailable', {
            issues: c.unavailable.map((u) =>
              issue(
                `/draft${u.pointer}`,
                'tool_unavailable',
                `This tool arrives in phase ${u.owner}.`,
              ),
            ),
          });
        const connector = await this.#connector(tx, row.id);
        const missing = missingConfiguration(
          c,
          connector && connector.state !== 'revoked' ? { configured: true } : null,
        );
        if (missing.length)
          throw new TenancyError('conflict', {
            issues: missing.map((m) =>
              issue(
                `/draft/${m}`,
                'configuration_incomplete',
                `Add ${m.replace(/_/g, ' ')} before turning this agent on.`,
              ),
            ),
          });
        const items = await this.#resolveScope(tx, p, c.scope, '/draft/scope');
        const need = this.#requiredLevel(c.tools);
        const owner =
          row.owner_membership_id === p.membershipId
            ? p
            : await this.#memberPrincipal(tx, row.owner_membership_id);
        const refused = [
          ...(await this.#grantable(tx, p, items, need, 'configurer')),
          ...(row.owner_membership_id === p.membershipId
            ? []
            : await this.#grantable(tx, owner, items, need, 'owner')),
        ];
        if (refused.length) throw new TenancyError('forbidden', { issues: refused });
        const hash = this.#hash(c);
        let rev = await tx.db
          .selectFrom('agents.agent_profile_revision')
          .select(['id', 'revision_number'])
          .where('profile_id', '=', row.id)
          .where('config_hash', '=', hash)
          .executeTakeFirst();
        if (!rev) {
          const last = await tx.db
            .selectFrom('agents.agent_profile_revision')
            .select((eb) => eb.fn.max('revision_number').as('n'))
            .where('profile_id', '=', row.id)
            .executeTakeFirst();
          const id = newUuidV7();
          const number = Number(last?.n ?? 0) + 1;
          await tx.db
            .insertInto('agents.agent_profile_revision')
            .values({
              id,
              workspace_id: tx.workspaceId,
              profile_id: row.id,
              revision_number: number,
              schema_version: PROFILE_SCHEMA_VERSION,
              kind: c.kind,
              config: c.canonical,
              config_hash: hash,
              model_key: c.model_key,
              created_by_membership_id: p.membershipId,
            })
            .execute();
          for (const it of items)
            await tx.db
              .insertInto('agents.agent_scope_grant')
              .values({
                id: newUuidV7(),
                workspace_id: tx.workspaceId,
                revision_id: id,
                kind: it.kind,
                target_id: it.id,
              })
              .execute();
          for (const t of c.tools)
            await tx.db
              .insertInto('agents.agent_tool_grant')
              .values({
                id: newUuidV7(),
                workspace_id: tx.workspaceId,
                revision_id: id,
                tool: t.name,
                tool_version: t.version,
                tool_class: t.tool_class,
                approval_class: t.approval_class,
              })
              .execute();
          rev = { id, revision_number: number };
        }
        await tx.db
          .updateTable('agents.agent_profile')
          .set({
            state: 'active',
            active_revision_id: rev.id,
            activated_at: new Date(),
            suspended_reason: null,
            suspended_at: null,
            updated_by_membership_id: p.membershipId,
            updated_at: new Date(),
            version: sql`version + 1`,
          })
          .where('id', '=', row.id)
          .execute();
        await this.workAudit(
          tx,
          caller,
          p,
          'agent_profile.activated',
          { recordId: row.id, type: 'agent_profile', publicId: row.public_id },
          [
            change.plain(
              'revision',
              row.active_revision_id ? 'previous' : null,
              String(rev.revision_number),
            ),
          ],
          null,
        );
        return {
          status: 200,
          ref: { id: row.public_id, type: 'agent_profile' },
          data: await this.#full(tx, p, (await this.#rows(tx, { id: row.id }))!),
        };
      },
      async (tx, p, ref) => {
        this.#sessionOnly(caller);
        return this.#full(tx, p, await this.#visible(tx, p, ref.id, { need: 'configure' }));
      },
    );
  }

  async disableAgentProfile(caller: Caller, ws: unknown, agt: unknown, req: Mutation) {
    this.#sessionOnly(caller);
    return this.mutate(
      caller,
      'agent_profile.disable',
      ws,
      req,
      async (tx, p) => {
        const row = await this.#visible(tx, p, agt, { lock: true, need: 'configure' });
        if (row.state === 'active')
          await tx.db
            .updateTable('agents.agent_profile')
            .set({
              state: 'disabled',
              updated_by_membership_id: p.membershipId,
              updated_at: new Date(),
              version: sql`version + 1`,
            })
            .where('id', '=', row.id)
            .execute();
        await this.workAudit(
          tx,
          caller,
          p,
          'agent_profile.disabled',
          { recordId: row.id, type: 'agent_profile', publicId: row.public_id },
          [change.plain('state', row.state, row.state === 'active' ? 'disabled' : row.state)],
          null,
        );
        return {
          status: 200,
          ref: { id: row.public_id, type: 'agent_profile' },
          data: await this.#full(tx, p, (await this.#rows(tx, { id: row.id }))!),
        };
      },
      async (tx, p, ref) => {
        this.#sessionOnly(caller);
        return this.#full(tx, p, await this.#visible(tx, p, ref.id, { need: 'configure' }));
      },
    );
  }

  /** A disabled copy of the draft: no connector, credential, revision, or grant comes with it. */
  async duplicateAgentProfile(caller: Caller, ws: unknown, agt: unknown, req: Mutation) {
    this.#sessionOnly(caller);
    return this.mutate(
      caller,
      'agent_profile.duplicate',
      ws,
      req,
      async (tx, p) => {
        const row = await this.#visible(tx, p, agt, { need: 'configure' });
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'agents.profiles:' + tx.workspaceId}, 0))`.execute(
          tx.db,
        );
        const n = await tx.db
          .selectFrom('agents.agent_profile')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('lifecycle_state', '<>', 'purged')
          .executeTakeFirstOrThrow();
        if (Number(n.n) >= this.ws.agentProfilesPerWorkspaceMax)
          throw new TenancyError('conflict', {
            issues: [
              issue(
                '/',
                'limit_reached',
                `A workspace has at most ${this.ws.agentProfilesPerWorkspaceMax} agents.`,
              ),
            ],
          });
        const id = newUuidV7();
        const publicId = newPublicId('agt');
        const cmd = this.cmd(caller, p, null);
        const name = `Copy of ${row.name}`.slice(0, 120);
        await tx.db
          .insertInto('core.record')
          .values({
            id,
            public_id: publicId,
            record_type: 'agent_profile',
            workspace_id: tx.workspaceId,
            brand_id: null,
            source_kind: 'ui',
            source_ref: null,
            created_by_actor_type: cmd.actor.type,
            created_by_actor_id: cmd.actor.id,
          })
          .execute();
        await tx.db
          .insertInto('agents.agent_profile')
          .values({
            id,
            workspace_id: tx.workspaceId,
            scope_key: tx.workspaceId,
            kind: row.kind,
            name,
            purpose: row.purpose,
            owner_membership_id: p.membershipId,
            draft: JSON.stringify(row.draft),
            template_key: row.template_key,
            duplicated_from_id: row.id,
            created_by_membership_id: p.membershipId,
          })
          .execute();
        await this.workAudit(
          tx,
          caller,
          p,
          'agent_profile.duplicated',
          { recordId: id, type: 'agent_profile', publicId },
          [change.plain('duplicated_from', null, row.public_id)],
          null,
        );
        return {
          status: 201,
          ref: { id: publicId, type: 'agent_profile' },
          data: await this.#full(tx, p, (await this.#rows(tx, { id }))!),
        };
      },
      async (tx, p, ref) => {
        this.#sessionOnly(caller);
        return this.#full(tx, p, await this.#visible(tx, p, ref.id, { need: 'configure' }));
      },
    );
  }

  /**
   * A new accountable owner: an active member who can configure agents and grant the active
   * revision's scope. The profile is left disabled until a person turns it on again; historical
   * assignments keep their ceilings and are decided with the new owner's authority from now on.
   */
  async reassignAgentProfile(
    caller: Caller,
    ws: unknown,
    agt: unknown,
    body: unknown,
    req: Mutation,
  ) {
    this.#sessionOnly(caller);
    const ownerRef = isObj(body) ? body.owner : undefined;
    if (!isPublic(ownerRef, 'mem'))
      throw invalid(issue('/owner', 'invalid_reference', 'Choose a person.'));
    return this.mutate(
      caller,
      'agent_profile.reassign',
      ws,
      req,
      async (tx, p) => {
        const row = await this.#visible(tx, p, agt, { lock: true, need: 'configure' });
        if (req.ifMatch !== undefined) requireVersion(parseIfMatch(req.ifMatch), row.version);
        const m = await tx.db
          .selectFrom('tenancy.membership')
          .select(['id'])
          .where('public_id', '=', ownerRef)
          .executeTakeFirst();
        const owner = m ? await this.#memberPrincipal(tx, m.id) : null;
        if (!m || !owner)
          throw invalid(issue('/owner', 'invalid_reference', 'Choose an active member.'));
        if (row.active_revision_id) {
          const g = await this.#grants(tx, row.active_revision_id);
          const items = await this.#itemsOf(tx, g);
          const refused = await this.#grantable(
            tx,
            owner,
            items,
            this.#requiredLevel(g.tools),
            'owner',
          );
          if (refused.length) throw new TenancyError('forbidden', { issues: refused });
        } else if (!decideWorkspace(owner, 'agents.configure').allowed)
          throw new TenancyError('forbidden', {
            issues: [issue('/owner', 'not_grantable', 'This person cannot configure agents.')],
          });
        await tx.db
          .updateTable('agents.agent_profile')
          .set({
            owner_membership_id: m.id,
            state: row.state === 'draft' ? 'draft' : 'disabled',
            suspended_reason: null,
            suspended_at: null,
            updated_by_membership_id: p.membershipId,
            updated_at: new Date(),
            version: sql`version + 1`,
          })
          .where('id', '=', row.id)
          .execute();
        await this.workAudit(
          tx,
          caller,
          p,
          'agent_profile.owner_changed',
          { recordId: row.id, type: 'agent_profile', publicId: row.public_id },
          [change.plain('owner', 'previous', String(ownerRef))],
          null,
        );
        return {
          status: 200,
          ref: { id: row.public_id, type: 'agent_profile' },
          data: await this.#full(tx, p, (await this.#rows(tx, { id: row.id }))!),
        };
      },
      async (tx, p, ref) => {
        this.#sessionOnly(caller);
        return this.#full(tx, p, await this.#visible(tx, p, ref.id, { need: 'configure' }));
      },
    );
  }

  async #itemsOf(tx: WorkspaceTransaction, g: Pick<Grants, ScopeKind>): Promise<ScopeItem[]> {
    const out: ScopeItem[] = [];
    for (const kind of ['brand', 'project', 'record', 'integration'] as const)
      for (const id of g[kind]) {
        if (kind === 'integration') {
          out.push({ kind, id, publicId: id });
          continue;
        }
        const r = await tx.db
          .selectFrom('core.record')
          .select(['public_id', 'record_type'])
          .where('id', '=', id)
          .executeTakeFirst();
        if (r)
          out.push({
            kind,
            id,
            publicId: r.public_id,
            ...(kind === 'record' ? { recordType: r.record_type as 'task' } : {}),
          });
      }
    return out;
  }

  /**
   * Archive, restore, and trash. Archived and trashed profiles take no new work; restoring leaves
   * the profile disabled until a person validates and turns it on again. Trash also disconnects
   * the connector and destroys its secret.
   */
  async agentProfileLifecycle(
    caller: Caller,
    ws: unknown,
    agt: unknown,
    verb: 'archive' | 'unarchive' | 'trash' | 'restore',
    req: Mutation,
  ) {
    this.#sessionOnly(caller);
    return this.mutate(
      caller,
      `agent_profile.${verb}`,
      ws,
      req,
      async (tx, p) => {
        const row = await this.#visible(tx, p, agt, {
          lock: true,
          need: 'configure',
          allowTrashed: verb === 'restore',
        });
        const facts = {
          id: row.id,
          brand: null,
          lifecycleState: row.lifecycle_state as 'active',
          chain: [],
        };
        const input = { exec: this.exec(caller, p), source: { kind: 'ui' as const } };
        if (verb === 'archive') {
          if (row.lifecycle_state !== 'active') throw new TenancyError('conflict');
          await this.d.lifecycle.archive(
            tx,
            this.issueLifecycle(tx, p, 'record.archive', facts),
            input,
            row.id,
          );
        } else if (verb === 'unarchive') {
          if (row.lifecycle_state !== 'archived') throw new TenancyError('conflict');
          await this.d.lifecycle.unarchive(
            tx,
            this.issueLifecycle(tx, p, 'record.restore', facts),
            input,
            row.id,
          );
        } else if (verb === 'trash') {
          if (row.lifecycle_state === 'trashed') throw new TenancyError('conflict');
          await this.#revokeConnector(tx, p, row.id);
          await this.d.lifecycle.trash(
            tx,
            this.issueLifecycle(tx, p, 'record.trash', facts),
            input,
            row.id,
          );
        } else {
          if (row.lifecycle_state !== 'trashed') throw new TenancyError('conflict');
          const rec = await tx.db
            .selectFrom('core.record')
            .select('deletion_batch_id')
            .where('id', '=', row.id)
            .executeTakeFirst();
          const batch = rec?.deletion_batch_id
            ? await tx.db
                .selectFrom('core.deletion_batch')
                .select('id')
                .where('id', '=', rec.deletion_batch_id)
                .where('root_record_id', '=', row.id)
                .executeTakeFirst()
            : undefined;
          if (!batch) throw new TenancyError('conflict');
          await this.d.lifecycle.restore(
            tx,
            this.issueLifecycle(tx, p, 'record.restore', facts),
            input,
            batch.id,
          );
        }
        // Whatever the verb, a profile that leaves the active lifecycle comes back disabled.
        if (row.state === 'active')
          await tx.db
            .updateTable('agents.agent_profile')
            .set({ state: 'disabled', updated_at: new Date(), version: sql`version + 1` })
            .where('id', '=', row.id)
            .execute();
        const now = (await this.#rows(tx, { id: row.id }))!;
        return {
          status: 200,
          ref: { id: row.public_id, type: 'agent_profile' },
          data: {
            id: row.public_id,
            type: 'agent_profile' as const,
            lifecycle_state: now.lifecycle_state,
            state: now.state,
          },
        };
      },
      // A completed key renders through current authority (configurers only); purged is opaque.
      async (tx, p, ref) => {
        this.#sessionOnly(caller);
        const row = await this.#visible(tx, p, ref.id, { need: 'configure', allowTrashed: true });
        return {
          id: row.public_id,
          type: 'agent_profile' as const,
          lifecycle_state: row.lifecycle_state,
          state: row.state,
        };
      },
    );
  }

  async listAgentProfileRevisions(caller: Caller, ws: unknown, agt: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const row = await this.#visible(tx, p, agt, { need: 'configure' });
      const revs = await tx.db
        .selectFrom('agents.agent_profile_revision')
        .select(['id', 'revision_number', 'model_key', 'config_hash', 'created_at'])
        .where('profile_id', '=', row.id)
        .orderBy('revision_number', 'desc')
        .execute();
      const data = [];
      for (const r of revs) {
        const g = await this.#grants(tx, r.id);
        data.push({
          revision: r.revision_number,
          active: r.id === row.active_revision_id,
          model_key: r.model_key,
          tools: g.tools.map((t) => `${t.tool}@${t.version}`),
          scope_items: g.brand.size + g.project.size + g.record.size + g.integration.size,
          created_at: new Date(r.created_at as unknown as string).toISOString(),
        });
      }
      return { data };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Connectors
  // ---------------------------------------------------------------------------------------------

  async #revokeConnector(tx: WorkspaceTransaction, p: Principal, profileId: string) {
    const c = await this.#connector(tx, profileId, true);
    if (!c || c.state === 'revoked') return;
    if (c.secret_ref) await this.integrationVault().destroy(c.secret_ref, { scope: tx });
    await tx.db
      .updateTable('agents.agent_connector')
      .set({
        state: 'revoked',
        secret_ref: null,
        verified_version: null,
        verified_at: null,
        config_version: c.config_version + 1,
        disconnected_at: new Date(),
        updated_by_membership_id: p.membershipId,
        updated_at: new Date(),
        version: sql`version + 1`,
      })
      .where('id', '=', c.id)
      .execute();
  }

  /**
   * Configures (or replaces) an external profile's connector: kind, endpoint, and credential.
   * The endpoint is checked before anything is stored. A webhook connector's signing secret is
   * generated here and shown once; an API or MCP credential is provided by the person and never
   * shown again (a product token is refused). Every change bumps the configuration version, so a
   * verification of the old configuration no longer counts.
   */
  async configureAgentConnector(
    caller: Caller,
    ws: unknown,
    agt: unknown,
    body: unknown,
    req: Mutation,
  ) {
    this.#sessionOnly(caller);
    const b = isObj(body) ? body : {};
    for (const k of Object.keys(b))
      if (!['kind', 'endpoint_url', 'secret'].includes(k))
        throw invalid(issue(`/${k}`, 'unknown_field', 'This field is not accepted.'));
    const kind = b.kind;
    if (kind !== 'api' && kind !== 'webhook' && kind !== 'mcp')
      throw invalid(issue('/kind', 'invalid_option', 'Choose API, webhook, or MCP.'));
    const endpoint = typeof b.endpoint_url === 'string' ? b.endpoint_url.trim() : '';
    if (!endpoint || endpoint.length > 2048 || /\s/.test(endpoint))
      throw invalid(issue('/endpoint_url', 'invalid_url', 'Enter the agent endpoint URL.'));
    const guard = await checkEndpoint(endpoint, {
      allowLoopback: this.#agents.transport === 'fixture',
      productOrigin: this.#agents.productOrigin,
    });
    if (!guard.ok)
      throw invalid(
        issue(
          '/endpoint_url',
          guard.code,
          guard.code === 'own_endpoint'
            ? "This is this product's own API or MCP endpoint, not an agent."
            : guard.code === 'private_address'
              ? 'This address is private and cannot be used.'
              : 'Use an https URL without credentials.',
        ),
      );
    let provided: string | null = null;
    if (kind !== 'webhook') {
      if (b.secret !== undefined) {
        if (
          typeof b.secret !== 'string' ||
          b.secret.length < 16 ||
          b.secret.length > 512 ||
          /\s/.test(b.secret)
        )
          throw invalid(
            issue(
              '/secret',
              'invalid_length',
              'Enter the agent credential (16 to 512 characters).',
            ),
          );
        if (isOwnCredential(b.secret))
          throw invalid(
            issue(
              '/secret',
              'own_credential',
              "A token of this product is not an agent's credential.",
            ),
          );
        provided = b.secret;
      }
    } else if (b.secret !== undefined)
      throw invalid(
        issue('/secret', 'not_applicable', 'A webhook signing secret is generated for you.'),
      );
    return this.mutate(
      caller,
      'agent_connector.configure',
      ws,
      req,
      async (tx, p) => {
        const row = await this.#visible(tx, p, agt, { lock: true, need: 'configure' });
        if (row.kind !== 'external')
          throw new TenancyError('conflict', {
            issues: [issue('/', 'not_applicable', 'Only an external agent has a connector.')],
          });
        if (row.lifecycle_state !== 'active')
          throw new TenancyError('conflict', {
            issues: [issue('/', 'profile_archived', 'Restore this agent first.')],
          });
        const current = await this.#connector(tx, row.id, true);
        const live = current && current.state !== 'revoked' ? current : null;
        if (kind !== 'webhook' && !provided && (!live || live.kind !== kind || !live.secret_ref))
          throw invalid(issue('/secret', 'required', 'Enter the agent credential.'));
        let shown: string | null = null;
        let secretRef = live && live.kind === kind ? live.secret_ref : null;
        if (provided || (kind === 'webhook' && !secretRef)) {
          const secret = provided ?? `whs_${randomBytes(32).toString('base64url')}`;
          if (!provided) shown = secret;
          if (secretRef) await this.integrationVault().destroy(secretRef, { scope: tx });
          secretRef = await this.integrationVault().put('agent_connector', secret, { scope: tx });
        }
        if (current) {
          await tx.db
            .updateTable('agents.agent_connector')
            .set({
              endpoint_url: endpoint,
              secret_ref: secretRef,
              config_version: current.config_version + 1,
              state: 'configured',
              verified_version: null,
              verified_at: null,
              verified_synthetic: false,
              capabilities: null,
              last_code: null,
              disconnected_at: null,
              updated_by_membership_id: p.membershipId,
              updated_at: new Date(),
              version: sql`version + 1`,
            })
            .where('id', '=', current.id)
            .execute();
          if (current.kind !== kind)
            await sql`UPDATE agents.agent_connector SET kind = ${kind} WHERE id = ${current.id}`.execute(
              tx.db,
            );
        } else
          await tx.db
            .insertInto('agents.agent_connector')
            .values({
              id: newUuidV7(),
              workspace_id: tx.workspaceId,
              profile_id: row.id,
              kind,
              endpoint_url: endpoint,
              secret_ref: secretRef,
              created_by_membership_id: p.membershipId,
            })
            .execute();
        await this.workAudit(
          tx,
          caller,
          p,
          'agent_connector.configured',
          { recordId: row.id, type: 'agent_profile', publicId: row.public_id },
          [
            change.plain('connector_kind', current?.kind ?? null, kind),
            change.plain('endpoint', current ? 'previous' : null, 'changed'),
          ],
          null,
        );
        const view = await this.#full(tx, p, (await this.#rows(tx, { id: row.id }))!);
        return {
          status: 200,
          ref: { id: row.public_id, type: 'agent_profile' },
          // The generated signing secret is shown once, here; a replay never shows it again.
          data: shown ? { ...view, signing_secret: shown } : view,
        };
      },
      async (tx, p, ref) => {
        this.#sessionOnly(caller);
        return this.#full(tx, p, await this.#visible(tx, p, ref.id, { need: 'configure' }));
      },
    );
  }

  /** Disconnects: the credential is destroyed and the connector revoked (nothing else is touched). */
  async disconnectAgentConnector(caller: Caller, ws: unknown, agt: unknown, req: Mutation) {
    this.#sessionOnly(caller);
    return this.mutate(
      caller,
      'agent_connector.disconnect',
      ws,
      req,
      async (tx, p) => {
        const row = await this.#visible(tx, p, agt, { lock: true, need: 'configure' });
        await this.#revokeConnector(tx, p, row.id);
        await this.workAudit(
          tx,
          caller,
          p,
          'agent_connector.disconnected',
          { recordId: row.id, type: 'agent_profile', publicId: row.public_id },
          [change.plain('connector', 'connected', 'revoked')],
          null,
        );
        return {
          status: 200,
          ref: { id: row.public_id, type: 'agent_profile' },
          data: await this.#full(tx, p, (await this.#rows(tx, { id: row.id }))!),
        };
      },
      async (tx, p, ref) => {
        this.#sessionOnly(caller);
        return this.#full(tx, p, await this.#visible(tx, p, ref.id, { need: 'configure' }));
      },
    );
  }

  /**
   * Starts one connection test (a separate, confirmed operation). Nothing is sent from here: the
   * worker re-authorizes immediately before the request and binds the result to the tested
   * configuration version. The request carries only protocol metadata and a one-time nonce.
   */
  async testAgentConnector(
    caller: Caller,
    ws: unknown,
    agt: unknown,
    body: unknown,
    req: Mutation,
  ) {
    this.#sessionOnly(caller);
    if (!isObj(body) || body.confirm !== true)
      throw invalid(
        issue(
          '/confirm',
          'confirmation_required',
          'Confirm that protocol metadata and a test nonce are sent to the endpoint.',
        ),
      );
    return this.mutate(
      caller,
      'agent_connector.test',
      ws,
      req,
      async (tx, p) => {
        const row = await this.#visible(tx, p, agt, { need: 'configure' });
        if (row.lifecycle_state !== 'active')
          throw new TenancyError('conflict', {
            issues: [issue('/', 'profile_archived', 'Restore this agent first.')],
          });
        const c = await this.#connector(tx, row.id, true);
        if (!c || c.state === 'revoked')
          throw new TenancyError('conflict', {
            issues: [issue('/connector', 'connector_missing', 'Configure a connector first.')],
          });
        if (this.#agents.transport === 'none')
          throw new TenancyError('dependency_unavailable', {
            issues: [
              issue(
                '/connector',
                'transport_unavailable',
                'Agent connections cannot be tested here: live connectors need an approved secret store and credentials (DQ-28).',
              ),
            ],
          });
        // The hourly test limit holds under concurrency: the connector row is locked above.
        const recent = await tx.db
          .selectFrom('agents.agent_connector_test')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('connector_id', '=', c.id)
          .where('created_at', '>', new Date(Date.now() - 3_600_000))
          .executeTakeFirstOrThrow();
        if (Number(recent.n) >= this.ws.agentConnectorTestsPerHour)
          throw new TenancyError('rate_limited', { retryAfterSeconds: 600 });
        const context = this.exec(caller, p);
        const op = await createOperation(tx, {
          kind: 'agent_connector_test',
          context,
          initiatedBy: { type: 'human', id: p.membershipId },
        });
        const testId = newUuidV7();
        await tx.db
          .insertInto('agents.agent_connector_test')
          .values({
            id: testId,
            workspace_id: tx.workspaceId,
            connector_id: c.id,
            operation_id: op.id,
            config_version: c.config_version,
            requested_by_membership_id: p.membershipId,
          })
          .execute();
        await enqueueJob(tx, {
          queue: AGENT_QUEUE,
          kind: AGENT_CONNECTOR_TEST_JOB,
          context,
          operationId: op.id,
          payloadRef: testId,
          maxAttempts: 3,
          timeoutSeconds: 60,
        });
        await this.workAudit(
          tx,
          caller,
          p,
          'agent_connector.test_requested',
          { recordId: row.id, type: 'agent_profile', publicId: row.public_id },
          [change.plain('config_version', null, String(c.config_version))],
          null,
        );
        return {
          status: 202,
          ref: { id: op.publicId, type: 'agent_connector_test' },
          data: await this.#testView(tx, op.publicId),
        };
      },
      async (tx, p, ref) => {
        this.#sessionOnly(caller);
        this.#configure(p);
        return this.#testView(tx, ref.id);
      },
    );
  }

  async #testView(tx: WorkspaceTransaction, opPublic: string) {
    const r = await tx.db
      .selectFrom('agents.agent_connector_test as t')
      .innerJoin('exec.operation as o', 'o.id', 't.operation_id')
      .innerJoin('agents.agent_connector as c', 'c.id', 't.connector_id')
      .select([
        'o.public_id',
        't.state',
        't.code',
        't.synthetic',
        't.config_version',
        't.duration_ms',
        't.created_at',
        't.ended_at',
        'c.config_version as current_version',
      ])
      .where('o.public_id', '=', opPublic)
      .executeTakeFirst();
    if (!r) throw new TenancyError('not_found');
    return {
      id: r.public_id,
      type: 'agent_connector_test' as const,
      state: r.state,
      code: r.code,
      synthetic: r.synthetic,
      config_version: r.config_version,
      current: r.config_version === r.current_version,
      duration_ms: r.duration_ms,
      created_at: new Date(r.created_at as unknown as string).toISOString(),
      ended_at: r.ended_at ? new Date(r.ended_at as unknown as string).toISOString() : null,
      note: 'A passed test proves protocol compatibility only, not permission or the quality of future work.',
    };
  }

  async getAgentConnectorTest(caller: Caller, ws: unknown, agt: unknown, op: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const row = await this.#visible(tx, p, agt, { need: 'configure' });
      if (!isPublic(op, 'op')) throw new TenancyError('not_found');
      const belongs = await tx.db
        .selectFrom('agents.agent_connector_test as t')
        .innerJoin('exec.operation as o', 'o.id', 't.operation_id')
        .innerJoin('agents.agent_connector as c', 'c.id', 't.connector_id')
        .select('t.id')
        .where('o.public_id', '=', op)
        .where('c.profile_id', '=', row.id)
        .executeTakeFirst();
      if (!belongs) throw new TenancyError('not_found');
      return this.#testView(tx, op);
    });
  }

  /**
   * The decision immediately before a handshake (and again on any retry): the test is open; the
   * requester is still an active member who can configure agents; the profile is active and not
   * trashed; the connector is not revoked and still at the tested configuration version; the
   * transport is available. Returns what to send in memory only (the secret never reaches a
   * checkpoint, log, or error).
   */
  async #prepareTest(tx: WorkspaceTransaction, testId: string): Promise<TestDecision> {
    const t = await tx.db
      .selectFrom('agents.agent_connector_test')
      .selectAll()
      .where('id', '=', testId)
      .forUpdate()
      .executeTakeFirst();
    if (!t) return { refused: 'test_missing' };
    if (t.state !== 'queued' && t.state !== 'running') return { closed: true };
    const c = await tx.db
      .selectFrom('agents.agent_connector')
      .selectAll()
      .where('id', '=', t.connector_id)
      .executeTakeFirst();
    if (!c || c.state === 'revoked') return { refused: 'connector_revoked' };
    if (c.config_version !== t.config_version) return { stale: true };
    const row = await this.#rows(tx, { id: c.profile_id });
    if (!row || row.lifecycle_state !== 'active') return { refused: 'profile_archived' };
    const requester = await this.#memberPrincipal(tx, t.requested_by_membership_id);
    if (!requester || !decideWorkspace(requester, 'agents.configure').allowed)
      return { refused: 'requester_unauthorized' };
    if (this.#agents.transport === 'none') return { refused: 'transport_unavailable' };
    const secret = c.secret_ref
      ? await this.integrationVault().get(c.secret_ref, { scope: tx })
      : undefined;
    if (!secret) return { refused: 'secret_unavailable' };
    return { send: { kind: c.kind as ConnectorKind, endpoint: c.endpoint_url, secret } };
  }

  /** The `agents.connector_test` job: decide, probe once outside any transaction, record. */
  async runAgentConnectorTest(ctx: JobHandlerContext): Promise<JobResult> {
    const testId = ctx.job.payloadRef;
    const workspaceId = ctx.job.workspaceId;
    if (!testId || !workspaceId) throw new JobError('deterministic', 'agent_test_missing');
    // A bounded, reference-only checkpoint: nothing but the decision's outcome code.
    const gate = (await ctx.step('prepare', async (raw) => {
      const tx = raw as WorkspaceTransaction;
      const d = await this.#prepareTest(tx, testId);
      if ('closed' in d) return { go: false };
      if ('stale' in d) {
        await this.#closeTest(tx, testId, 'stale', 'config_changed', null);
        return { go: false };
      }
      if ('refused' in d) {
        await this.#closeTest(tx, testId, 'refused', d.refused, null);
        return { go: false };
      }
      await tx.db
        .updateTable('agents.agent_connector_test')
        .set({ state: 'running' })
        .where('id', '=', testId)
        .execute();
      return { go: true };
    })) as { go: boolean };
    if (!gate.go) return { state: 'succeeded' };
    const started = performance.now();
    const box: {
      result?: { ok: true; manifest: Manifest } | { ok: false; code: HandshakeCode | string };
    } = {};
    try {
      await ctx.effect(`connector-test:${testId}`, AGENT_CONNECTOR_TEST_DESTINATION, async () => {
        // Re-decided immediately before the request: a change since the step above stops it.
        const d = await this.d.tenant.withWorkspace(workspaceId, { module: 'agents' }, (tx) =>
          this.#prepareTest(tx as WorkspaceTransaction, testId),
        );
        if (!('send' in d)) {
          box.result = {
            ok: false,
            code: 'stale' in d ? 'config_changed' : 'closed' in d ? 'closed' : d.refused,
          };
          return {};
        }
        const nonce = randomBytes(16).toString('base64url');
        const r = await handshake(d.send, {
          nonce,
          timeoutMs: this.ws.agentConnectorTimeoutMs,
          maxBytes: this.ws.agentConnectorResponseMaxBytes,
          allowLoopback: this.#agents.transport === 'fixture',
          productOrigin: this.#agents.productOrigin,
          ...(this.#agents.fetchImpl ? { fetchImpl: this.#agents.fetchImpl } : {}),
        });
        box.result = r.ok ? { ok: true, manifest: r.manifest } : { ok: false, code: r.code };
        return {};
      });
    } catch (err) {
      if (err instanceof JobError) throw err;
      throw err;
    }
    const duration = Math.round(performance.now() - started);
    await ctx.step('record', async (raw) => {
      const tx = raw as WorkspaceTransaction;
      await this.#recordTest(
        tx,
        testId,
        box.result ?? { ok: false, code: 'interrupted' },
        duration,
      );
    });
    return { state: 'succeeded' };
  }

  async #closeTest(
    tx: WorkspaceTransaction,
    testId: string,
    state: 'stale' | 'refused' | 'failed' | 'passed',
    code: string | null,
    duration: number | null,
    synthetic = false,
  ) {
    await tx.db
      .updateTable('agents.agent_connector_test')
      .set({ state, code, synthetic, duration_ms: duration, ended_at: new Date() })
      .where('id', '=', testId)
      .where('state', 'in', ['queued', 'running'])
      .execute();
  }

  /**
   * Records a result for exactly the tested configuration version. Advertised tools are
   * metadata: they are intersected with the registry and the active revision's grants; anything
   * unregistered is reported and grants nothing. A fixture peer's result is labelled synthetic.
   */
  async #recordTest(
    tx: WorkspaceTransaction,
    testId: string,
    result: { ok: true; manifest: Manifest } | { ok: false; code: string },
    duration: number,
  ) {
    const t = await tx.db
      .selectFrom('agents.agent_connector_test')
      .selectAll()
      .where('id', '=', testId)
      .forUpdate()
      .executeTakeFirst();
    if (!t || (t.state !== 'queued' && t.state !== 'running')) return;
    const c = await tx.db
      .selectFrom('agents.agent_connector')
      .selectAll()
      .where('id', '=', t.connector_id)
      .forUpdate()
      .executeTakeFirst();
    if (!c || c.state === 'revoked' || c.config_version !== t.config_version) {
      await this.#closeTest(tx, testId, 'stale', 'config_changed', duration);
      return;
    }
    const synthetic = this.#agents.transport === 'fixture';
    if (!result.ok) {
      const code = /^[a-z_]{1,64}$/.test(result.code) ? result.code : 'failed';
      await this.#closeTest(
        tx,
        testId,
        code === 'config_changed' ? 'stale' : 'failed',
        code,
        duration,
        synthetic,
      );
      if (code !== 'config_changed')
        await tx.db
          .updateTable('agents.agent_connector')
          .set({
            state: 'configured',
            verified_version: null,
            verified_at: null,
            verified_synthetic: false,
            last_code: code,
            last_tested_at: new Date(),
            updated_at: new Date(),
            version: sql`version + 1`,
          })
          .where('id', '=', c.id)
          .execute();
      return;
    }
    const profile = (await this.#rows(tx, { id: c.profile_id }))!;
    const granted = profile.active_revision_id
      ? (await this.#grants(tx, profile.active_revision_id)).tools
      : [];
    const registered = result.manifest.tools.filter((x) => agentTool(x.name, x.version));
    const unregistered = result.manifest.tools.filter((x) => !agentTool(x.name, x.version));
    const effective = registered.filter((x) =>
      granted.some((g) => g.tool === x.name && g.version === x.version),
    );
    await tx.db
      .updateTable('agents.agent_connector')
      .set({
        state: 'verified',
        verified_version: c.config_version,
        verified_at: new Date(),
        verified_synthetic: synthetic,
        capabilities: JSON.stringify({
          protocol: result.manifest.protocol,
          version: result.manifest.version,
          agent: result.manifest.agent,
          advertised: registered.slice(0, 100),
          unregistered: unregistered.slice(0, 100),
          effective,
        }),
        last_code: null,
        last_tested_at: new Date(),
        updated_at: new Date(),
        version: sql`version + 1`,
      })
      .where('id', '=', c.id)
      .execute();
    await this.#closeTest(tx, testId, 'passed', null, duration, synthetic);
  }

  // ---------------------------------------------------------------------------------------------
  // Task assignments
  // ---------------------------------------------------------------------------------------------

  #assignmentInput(body: unknown): AssignmentInput {
    const b = isObj(body) ? body : {};
    const allowed = [
      'profile',
      'goal',
      'constraints',
      'deliverable',
      'criteria',
      'context',
      'scope',
    ];
    const issues = [];
    for (const k of Object.keys(b))
      if (!allowed.includes(k))
        issues.push(issue(`/${k}`, 'unknown_field', 'This field is not accepted.'));
    const max = this.ws.agentAssignmentTextMaxChars;
    const text = (k: string, required: boolean) => {
      const v = b[k];
      if (v === undefined || v === null || v === '') {
        if (required) issues.push(issue(`/${k}`, 'required', 'Describe the goal.'));
        return null;
      }
      if (typeof v !== 'string' || !v.trim() || v.length > max) {
        issues.push(issue(`/${k}`, 'invalid_length', `Use 1 to ${max} characters.`));
        return null;
      }
      return v.trim();
    };
    const goal = text('goal', true);
    const constraints = text('constraints', false);
    const deliverable = text('deliverable', false);
    const criteria: string[] = [];
    if (b.criteria !== undefined) {
      if (!Array.isArray(b.criteria) || b.criteria.length > this.ws.agentCriteriaMax)
        issues.push(
          issue('/criteria', 'too_many', `List up to ${this.ws.agentCriteriaMax} criteria.`),
        );
      else
        b.criteria.forEach((c, i) => {
          if (typeof c !== 'string' || !c.trim() || c.length > max)
            issues.push(issue(`/criteria/${i}`, 'invalid_length', `Use 1 to ${max} characters.`));
          else criteria.push(c.trim());
        });
    }
    const context: string[] = [];
    if (b.context !== undefined) {
      if (!Array.isArray(b.context) || b.context.length > this.ws.agentContextRefsMax)
        issues.push(
          issue(
            '/context',
            'too_many',
            `Choose up to ${this.ws.agentContextRefsMax} context items.`,
          ),
        );
      else
        b.context.forEach((c, i) => {
          if (typeof c !== 'string' || !/^(tsk|prj|doc)_[0-9A-HJKMNP-TV-Z]{26}$/.test(c))
            issues.push(
              issue(`/context/${i}`, 'invalid_reference', 'Choose an item you can open.'),
            );
          else if (!context.includes(c)) context.push(c);
        });
    }
    const scope: Record<ScopeKind, string[]> | null =
      b.scope === undefined ? null : { brand: [], project: [], record: [], integration: [] };
    if (b.scope !== undefined) {
      if (!isObj(b.scope)) issues.push(issue('/scope', 'invalid_type', 'The scope is an object.'));
      else
        for (const kind of ['brand', 'project', 'record', 'integration'] as const) {
          const list = b.scope[`${kind}s`] ?? [];
          if (!Array.isArray(list) || list.length > 100) {
            issues.push(issue(`/scope/${kind}s`, 'invalid_type', 'A list of references.'));
            continue;
          }
          for (const v of list) if (typeof v === 'string') scope![kind].push(v);
        }
    }
    if (issues.length) throw invalid(...issues);
    return { profile: b.profile, goal: goal!, constraints, deliverable, criteria, context, scope };
  }

  /**
   * Resolves an assignment against current authority: the profile (active, its pinned revision),
   * the explicit scope (default: the task and its chosen context), each item inside the profile's
   * grants and readable now by the assigner and the profile owner (own authority), and the context
   * inside that scope. Items that fail are refusals (named by the caller's own input only).
   */
  async #resolveAssignment(
    tx: WorkspaceTransaction,
    p: Principal,
    task: { id: string; publicId: string },
    profile: ProfileRow,
    input: AssignmentInput,
  ) {
    const refusals: Array<{ pointer: string; code: string; message: string }> = [];
    if (
      profile.lifecycle_state !== 'active' ||
      profile.state !== 'active' ||
      !profile.active_revision_id
    )
      throw new TenancyError('conflict', {
        issues: [issue('/profile', 'profile_not_active', 'This agent is not turned on.')],
      });
    const grants = await this.#grants(tx, profile.active_revision_id);
    const owner = await this.#memberPrincipal(tx, profile.owner_membership_id);
    const requested = input.scope ?? {
      brand: [],
      project: [],
      record: [task.publicId, ...input.context],
      integration: [],
    };
    const keep: ScopeItem[] = [];
    for (const kind of ['brand', 'project', 'record', 'integration'] as const)
      for (const [i, pub] of requested[kind].entries()) {
        const pointer = `/scope/${kind}s/${i}`;
        const item = await this.#find(tx, kind, pub);
        if (!item || (await this.#levelOn(tx, p, item)) === null) {
          refusals.push({ pointer, code: 'not_available', message: 'This item is not available.' });
          continue;
        }
        if (!(await this.#within(tx, item, grants))) {
          refusals.push({
            pointer,
            code: 'outside_profile_scope',
            message: "This item is outside the agent's scope.",
          });
          continue;
        }
        if (!owner || (await this.#levelOn(tx, owner, item)) === null) {
          refusals.push({
            pointer,
            code: 'outside_owner_access',
            message: "The agent's owner cannot open this item.",
          });
          continue;
        }
        if (!keep.some((k) => k.id === item.id)) keep.push(item);
      }
    const ceiling: Pick<Grants, ScopeKind> = {
      brand: new Set(),
      project: new Set(),
      record: new Set(),
      integration: new Set(),
    };
    for (const k of keep) ceiling[k.kind].add(k.id);
    const taskItem: ScopeItem = {
      kind: 'record',
      id: task.id,
      publicId: task.publicId,
      recordType: 'task',
    };
    const taskInScope = await this.#within(tx, taskItem, ceiling);
    if (!taskInScope)
      refusals.push({
        pointer: '/scope',
        code: 'task_out_of_scope',
        message: "The task itself must be inside the assignment's scope.",
      });
    const context: ScopeItem[] = [];
    for (const [i, pub] of input.context.entries()) {
      const item = await this.#find(tx, 'record', pub);
      if (!item || (await this.#levelOn(tx, p, item)) === null) {
        refusals.push({
          pointer: `/context/${i}`,
          code: 'not_available',
          message: 'This item is not available.',
        });
        continue;
      }
      if (!(await this.#within(tx, item, ceiling))) {
        refusals.push({
          pointer: `/context/${i}`,
          code: 'outside_assignment_scope',
          message: "This item is outside the assignment's scope.",
        });
        continue;
      }
      context.push(item);
    }
    return { grants, ceiling, keep, context, refusals, taskInScope, owner };
  }

  /**
   * Context items the viewer can open (others omitted). With a live ceiling, each says whether it
   * is still usable: a stored reference the assigner or owner can no longer reach is history, not
   * execution scope, even when this viewer can read it (review 01 R2).
   */
  async #contextView(
    tx: WorkspaceTransaction,
    p: Principal,
    ids: readonly string[],
    live?: Pick<Grants, ScopeKind>,
  ) {
    const out: Array<{ id: string; name: string; usable?: boolean }> = [];
    for (const id of ids) {
      const r = await this.#named(tx, p, 'record', id);
      if (!r) continue;
      if (!live) {
        out.push({ id: r.publicId, name: r.name });
        continue;
      }
      const [item] = await this.#itemsOf(tx, {
        brand: new Set(),
        project: new Set(),
        record: new Set([id]),
        integration: new Set(),
      });
      out.push({
        id: r.publicId,
        name: r.name,
        usable: !!item && (await this.#within(tx, item, live)),
      });
    }
    return out;
  }

  /**
   * The one assignment eligibility rule (review 01 R2), used by preview, save, edit, readiness,
   * and the 8C handoff: the task is active, and the person assigning holds `agent.assign` on it
   * now (task edit level; record shares never count). Throws the canonical refusal.
   */
  #requireAssignable(p: Principal, t: Awaited<ReturnType<AgentService['loadTask']>>) {
    this.requireTaskAction(p, 'agent.assign', t, { shares: false, excluded: 'forbidden' });
    this.requireTaskActive(t);
  }

  /**
   * The same rule for a stored assignment: the task is loaded as its original assigner now.
   * Readable is not assignable; an inactive (archived or trashed) task is ineligible.
   */
  async #assignerEligibility(
    tx: WorkspaceTransaction,
    assigner: Principal | null,
    taskId: string,
  ): Promise<Array<'task_ineligible' | 'assigner_unavailable' | 'assigner_authority'>> {
    const rec = await tx.db
      .selectFrom('core.record')
      .select(['public_id', 'lifecycle_state'])
      .where('id', '=', taskId)
      .executeTakeFirst();
    if (!rec || rec.lifecycle_state !== 'active') return ['task_ineligible'];
    if (!assigner) return ['assigner_unavailable'];
    try {
      const t = await this.loadTask(tx, assigner, rec.public_id);
      this.#requireAssignable(assigner, t);
      return [];
    } catch (err) {
      if (err instanceof TenancyError) return ['assigner_authority'];
      throw err;
    }
  }

  /** The structured preview an assigner sees before saving: what is included and what is not. */
  async previewAgentAssignment(caller: Caller, ws: unknown, tsk: unknown, body: unknown) {
    this.#assignScope(caller);
    const input = this.#assignmentInput(body);
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const t = await this.loadTask(tx, p, tsk);
      this.#requireAssignable(p, t);
      const profile = await this.#visible(tx, p, input.profile);
      const r = await this.#resolveAssignment(
        tx,
        p,
        { id: t.id, publicId: t.publicId },
        profile,
        input,
      );
      return {
        type: 'agent_assignment_preview' as const,
        profile: { id: profile.public_id, name: profile.name, kind: profile.kind },
        goal: input.goal,
        constraints: input.constraints,
        deliverable: input.deliverable,
        criteria: input.criteria,
        context: await this.#contextView(
          tx,
          p,
          r.context.map((c) => c.id),
        ),
        scope: await this.#scopeView(tx, p, r.ceiling),
        refusals: r.refusals,
        can_save:
          !r.refusals.some((x) => x.code === 'task_out_of_scope') && r.refusals.length === 0,
        readiness: await this.#readiness(tx, profile),
        execution: EXECUTION,
      };
    });
  }

  async #assignmentRows(
    tx: WorkspaceTransaction,
    taskId: string,
    opts: { profileId?: string; lock?: boolean } = {},
  ) {
    let q = tx.db.selectFrom('agents.agent_assignment').selectAll().where('task_id', '=', taskId);
    if (opts.profileId) q = q.where('profile_id', '=', opts.profileId);
    if (opts.lock) q = q.forUpdate();
    return q.orderBy('created_at').execute();
  }

  /**
   * One assignment as a reader of the task sees it now: the profile's name and kind (never its
   * instructions, grants, or connector), the brief, the context items this reader can open, and
   * a truthful state: assigned and ready for 8C, blocked (with reasons), or withdrawn.
   */
  async #assignmentView(
    tx: WorkspaceTransaction,
    p: Principal,
    a: {
      id: string;
      task_id: string;
      state: string;
      current_revision_id: string | null;
      profile_id: string;
      version: number | string;
      created_at: unknown;
      withdrawn_at: unknown;
    },
  ) {
    const profile = (await this.#rows(tx, { id: a.profile_id }))!;
    const task = (await this.publicOf(tx, a.task_id))!;
    const rev = await tx.db
      .selectFrom('agents.agent_assignment_revision')
      .selectAll()
      .where('id', '=', a.current_revision_id!)
      .executeTakeFirstOrThrow();
    const decision = a.state === 'assigned' ? await this.#decide(tx, a, rev) : null;
    // People who cannot configure agents learn only that the agent itself is not ready, never
    // which profile, model, connector, or owner fact made it so.
    const blocked = decision
      ? [
          ...new Set(
            this.#canConfigure(p)
              ? decision.reasons
              : decision.reasons.map((r) => (ASSIGNMENT_REASONS.has(r) ? r : 'agent_not_ready')),
          ),
        ]
      : [];
    return {
      id: `${task}:${profile.public_id}`,
      type: 'agent_assignment' as const,
      profile: { id: profile.public_id, name: profile.name, kind: profile.kind },
      state: a.state === 'withdrawn' ? 'withdrawn' : blocked.length ? 'blocked' : 'assigned',
      blocked_reasons: blocked,
      revision: rev.revision_number,
      goal: rev.goal,
      constraints: rev.constraints,
      deliverable: rev.deliverable,
      criteria: rev.criteria as unknown as string[],
      context: await this.#contextView(tx, p, rev.context_refs, decision?.live),
      // The stored ceiling (history, as confirmed) and the live ceiling an 8C run could use now;
      // both show only the items this viewer can open.
      effective_scope: decision ? await this.#scopeView(tx, p, decision.live) : { items: [] },
      scope: await this.#scopeView(tx, p, {
        brand: new Set(rev.scope_brand_ids),
        project: new Set(rev.scope_project_ids),
        record: new Set(rev.scope_record_ids),
        integration: new Set(rev.scope_integration_ids),
      }),
      assigned_by: await this.#member(tx, rev.assigner_membership_id),
      assigned_at: new Date(a.created_at as string).toISOString(),
      withdrawn_at: a.withdrawn_at ? new Date(a.withdrawn_at as string).toISOString() : null,
      execution: EXECUTION,
      version: Number(a.version),
    };
  }

  /**
   * The assignment decision (review 01 R2): profile readiness, the shared eligibility rule for the
   * original assigner, and the live ceiling = the stored ceiling ∩ the pinned and current profile
   * grants ∩ what the assigner and the owner can reach now. Tools are the pinned revision's tools
   * that the current revision still grants, at the stricter approval. It only narrows; nothing a
   * later grant adds is included. Blocked when anything fails or the task is no longer inside the
   * live ceiling.
   */
  async #decide(
    tx: WorkspaceTransaction,
    a: { profile_id: string; task_id: string },
    rev: {
      assigner_membership_id: string;
      scope_brand_ids: string[];
      scope_project_ids: string[];
      scope_record_ids: string[];
      scope_integration_ids: string[];
      profile_revision_id: string;
    },
  ) {
    const reasons = new Set<string>();
    const profile = (await this.#rows(tx, { id: a.profile_id }))!;
    const ready = await this.#readiness(tx, profile);
    for (const r of ready.reasons) reasons.add(r);
    const assigner = await this.#memberPrincipal(tx, rev.assigner_membership_id);
    const owner = await this.#memberPrincipal(tx, profile.owner_membership_id);
    for (const r of await this.#assignerEligibility(tx, assigner, a.task_id)) reasons.add(r);
    const current = profile.active_revision_id
      ? await this.#grants(tx, profile.active_revision_id)
      : null;
    const pinned = await this.#grants(tx, rev.profile_revision_id);
    const live: Pick<Grants, ScopeKind> = {
      brand: new Set(),
      project: new Set(),
      record: new Set(),
      integration: new Set(),
    };
    const items = await this.#itemsOf(tx, {
      brand: new Set(rev.scope_brand_ids),
      project: new Set(rev.scope_project_ids),
      record: new Set(rev.scope_record_ids),
      integration: new Set(rev.scope_integration_ids),
    });
    for (const item of items) {
      if (!(await this.#within(tx, item, pinned))) continue;
      if (!current || !(await this.#within(tx, item, current))) continue;
      if (!assigner || (await this.#levelOn(tx, assigner, item)) === null) continue;
      if (!owner || (await this.#levelOn(tx, owner, item)) === null) continue;
      live[item.kind].add(item.id);
    }
    const [taskItem] = await this.#itemsOf(tx, {
      brand: new Set(),
      project: new Set(),
      record: new Set([a.task_id]),
      integration: new Set(),
    });
    if (!taskItem || !(await this.#within(tx, taskItem, live))) reasons.add('scope_lost');
    const rank = (x: string) => APPROVAL_ORDER.indexOf(x as (typeof APPROVAL_ORDER)[number]);
    const tools = current
      ? pinned.tools.flatMap((t) => {
          const c = current.tools.find((x) => x.tool === t.tool && x.version === t.version);
          if (!c) return [];
          return [
            {
              ...t,
              approval_class:
                rank(c.approval_class) > rank(t.approval_class)
                  ? c.approval_class
                  : t.approval_class,
            },
          ];
        })
      : [];
    return { eligible: reasons.size === 0, reasons: [...reasons], live, tools };
  }

  /**
   * The 8C handoff (published, not executed here): the current decision for the active assignment
   * of one task and profile, by public identifiers. 8C must call this immediately before issuing
   * a run credential or dispatching and use only `ceiling` and `tools`; 8B never calls it to act.
   */
  protected async agentAssignmentEligibility(tx: WorkspaceTransaction, tsk: string, agt: string) {
    const t = await tx.db
      .selectFrom('core.record')
      .select('id')
      .where('public_id', '=', tsk)
      .where('record_type', '=', 'task')
      .executeTakeFirst();
    const profile = await this.#rows(tx, { publicId: agt });
    if (!t || !profile)
      return { eligible: false, reasons: ['not_found'], ceiling: null, tools: [] };
    const a = (await this.#assignmentRows(tx, t.id, { profileId: profile.id })).find(
      (x) => x.state === 'assigned',
    );
    if (!a) return { eligible: false, reasons: ['not_assigned'], ceiling: null, tools: [] };
    const rev = await tx.db
      .selectFrom('agents.agent_assignment_revision')
      .selectAll()
      .where('id', '=', a.current_revision_id!)
      .executeTakeFirstOrThrow();
    const d = await this.#decide(tx, a, rev);
    return {
      eligible: d.eligible,
      reasons: d.reasons,
      ceiling: {
        brand: [...d.live.brand],
        project: [...d.live.project],
        record: [...d.live.record],
        integration: [...d.live.integration],
      },
      tools: d.tools,
    };
  }

  async listTaskAgentAssignments(caller: Caller, ws: unknown, tsk: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const t = await this.loadTask(tx, p, tsk);
      const rows = await this.#assignmentRows(tx, t.id);
      const data = [];
      for (const a of rows) data.push(await this.#assignmentView(tx, p, a));
      let canAssign: boolean;
      try {
        this.requireTaskAction(p, 'agent.assign', t, { shares: false, excluded: 'forbidden' });
        canAssign = t.lifecycleState === 'active';
      } catch {
        canAssign = false;
      }
      return {
        type: 'agent_assignments' as const,
        task: t.publicId,
        data,
        capabilities: { assign: canAssign },
        execution: EXECUTION,
      };
    });
  }

  /** Assigns a task to an agent (a working assignment; nothing is sent and nothing is run). */
  async assignAgent(caller: Caller, ws: unknown, tsk: unknown, body: unknown, req: Mutation) {
    this.#assignScope(caller);
    const input = this.#assignmentInput(body);
    return this.mutate(
      caller,
      'agent.assign',
      ws,
      req,
      async (tx, p) => {
        const t = await this.loadTask(tx, p, tsk, { lock: true });
        this.#requireAssignable(p, t);
        const profile = await this.#visible(tx, p, input.profile);
        const active = await this.#assignmentRows(tx, t.id);
        const open = active.filter((a) => a.state === 'assigned');
        if (open.some((a) => a.profile_id === profile.id))
          throw new TenancyError('conflict', {
            issues: [
              issue('/profile', 'already_assigned', 'This agent is already assigned to this task.'),
            ],
          });
        if (open.length >= this.ws.agentAssignmentsPerTaskMax)
          throw new TenancyError('conflict', {
            issues: [
              issue(
                '/',
                'limit_reached',
                `A task has at most ${this.ws.agentAssignmentsPerTaskMax} agents.`,
              ),
            ],
          });
        const r = await this.#resolveAssignment(
          tx,
          p,
          { id: t.id, publicId: t.publicId },
          profile,
          input,
        );
        if (r.refusals.length)
          throw invalid(...r.refusals.map((x) => issue(x.pointer, x.code, x.message)));
        const id = newUuidV7();
        const revId = newUuidV7();
        await tx.db
          .insertInto('agents.agent_assignment')
          .values({
            id,
            workspace_id: tx.workspaceId,
            brand_id: t.brand.id,
            task_id: t.id,
            profile_id: profile.id,
            current_revision_id: revId,
            assigned_by_membership_id: p.membershipId,
          })
          .execute();
        await this.#insertRevision(
          tx,
          revId,
          id,
          1,
          profile.active_revision_id!,
          p.membershipId,
          input,
          r,
        );
        await this.workAudit(
          tx,
          caller,
          p,
          'agent.assigned',
          { recordId: t.id, type: 'task', publicId: t.publicId },
          [
            change.plain('agent', null, profile.public_id),
            change.plain('profile_revision', null, profile.active_revision_id),
          ],
          t.brand.id,
        );
        const row = (await this.#assignmentRows(tx, t.id, { profileId: profile.id })).find(
          (x) => x.id === id,
        )!;
        return {
          status: 201,
          ref: { id: `${t.publicId}:${profile.public_id}`, type: 'agent_assignment' },
          data: await this.#assignmentView(tx, p, row),
        };
      },
      async (tx, p, ref) => {
        this.#assignScope(caller);
        return this.#renderAssignment(tx, p, ref.id);
      },
    );
  }

  async #insertRevision(
    tx: WorkspaceTransaction,
    revId: string,
    assignmentId: string,
    number: number,
    profileRevisionId: string,
    assigner: string,
    input: AssignmentInput,
    r: { ceiling: Pick<Grants, ScopeKind>; context: ScopeItem[] },
  ) {
    await tx.db
      .insertInto('agents.agent_assignment_revision')
      .values({
        id: revId,
        workspace_id: tx.workspaceId,
        assignment_id: assignmentId,
        revision_number: number,
        profile_revision_id: profileRevisionId,
        assigner_membership_id: assigner,
        goal: input.goal,
        constraints: input.constraints,
        deliverable: input.deliverable,
        criteria: JSON.stringify(input.criteria),
        context_refs: r.context.map((c) => c.id),
        scope_brand_ids: [...r.ceiling.brand],
        scope_project_ids: [...r.ceiling.project],
        scope_record_ids: [...r.ceiling.record],
        scope_integration_ids: [...r.ceiling.integration],
      })
      .execute();
  }

  /** A completed key re-renders through the reader's current access (never a stored response). */
  async #renderAssignment(tx: WorkspaceTransaction, p: Principal, ref: string) {
    const [tsk, agt] = ref.split(':');
    const t = await this.loadTask(tx, p, tsk);
    this.requireTaskAction(p, 'agent.assign', t, { shares: false, excluded: 'not_found' });
    const profile = await this.#visible(tx, p, agt);
    const rows = await this.#assignmentRows(tx, t.id, { profileId: profile.id });
    const row = rows.at(-1);
    if (!row) throw new TenancyError('not_found');
    return this.#assignmentView(tx, p, row);
  }

  /** A new revision of an active assignment (If-Match), decided again against current authority. */
  async updateAgentAssignment(
    caller: Caller,
    ws: unknown,
    tsk: unknown,
    agt: unknown,
    body: unknown,
    req: Mutation,
  ) {
    this.#assignScope(caller);
    const input = this.#assignmentInput({ ...(isObj(body) ? body : {}), profile: agt });
    return this.mutate(
      caller,
      'agent.assign',
      ws,
      req,
      async (tx, p) => {
        const t = await this.loadTask(tx, p, tsk, { lock: true });
        this.#requireAssignable(p, t);
        const profile = await this.#visible(tx, p, agt);
        const a = (
          await this.#assignmentRows(tx, t.id, { profileId: profile.id, lock: true })
        ).find((x) => x.state === 'assigned');
        if (!a) throw new TenancyError('not_found');
        requireVersion(parseIfMatch(req.ifMatch), Number(a.version));
        const r = await this.#resolveAssignment(
          tx,
          p,
          { id: t.id, publicId: t.publicId },
          profile,
          input,
        );
        if (r.refusals.length)
          throw invalid(...r.refusals.map((x) => issue(x.pointer, x.code, x.message)));
        const last = await tx.db
          .selectFrom('agents.agent_assignment_revision')
          .select((eb) => eb.fn.max('revision_number').as('n'))
          .where('assignment_id', '=', a.id)
          .executeTakeFirst();
        const revId = newUuidV7();
        await this.#insertRevision(
          tx,
          revId,
          a.id,
          Number(last?.n ?? 0) + 1,
          profile.active_revision_id!,
          p.membershipId,
          input,
          r,
        );
        await tx.db
          .updateTable('agents.agent_assignment')
          .set({ current_revision_id: revId, updated_at: new Date(), version: sql`version + 1` })
          .where('id', '=', a.id)
          .execute();
        await this.workAudit(
          tx,
          caller,
          p,
          'agent.assignment_revised',
          { recordId: t.id, type: 'task', publicId: t.publicId },
          [change.plain('agent', profile.public_id, profile.public_id)],
          t.brand.id,
        );
        const row = (await this.#assignmentRows(tx, t.id, { profileId: profile.id })).find(
          (x) => x.id === a.id,
        )!;
        return {
          status: 200,
          ref: { id: `${t.publicId}:${profile.public_id}`, type: 'agent_assignment' },
          data: await this.#assignmentView(tx, p, row),
        };
      },
      async (tx, p, ref) => {
        this.#assignScope(caller);
        return this.#renderAssignment(tx, p, ref.id);
      },
    );
  }

  async withdrawAgentAssignment(
    caller: Caller,
    ws: unknown,
    tsk: unknown,
    agt: unknown,
    req: Mutation,
  ) {
    this.#assignScope(caller);
    return this.mutate(
      caller,
      'agent.withdraw',
      ws,
      req,
      async (tx, p) => {
        const t = await this.loadTask(tx, p, tsk, { lock: true });
        this.requireTaskAction(p, 'agent.assign', t, { shares: false, excluded: 'forbidden' });
        const profile = await this.#visible(tx, p, agt);
        const a = (
          await this.#assignmentRows(tx, t.id, { profileId: profile.id, lock: true })
        ).find((x) => x.state === 'assigned');
        if (!a) throw new TenancyError('not_found');
        if (req.ifMatch !== undefined) requireVersion(parseIfMatch(req.ifMatch), Number(a.version));
        await tx.db
          .updateTable('agents.agent_assignment')
          .set({
            state: 'withdrawn',
            withdrawn_at: new Date(),
            withdrawn_by_membership_id: p.membershipId,
            updated_at: new Date(),
            version: sql`version + 1`,
          })
          .where('id', '=', a.id)
          .execute();
        await this.workAudit(
          tx,
          caller,
          p,
          'agent.withdrawn',
          { recordId: t.id, type: 'task', publicId: t.publicId },
          [change.plain('agent', profile.public_id, null)],
          t.brand.id,
        );
        const row = (await this.#assignmentRows(tx, t.id, { profileId: profile.id })).find(
          (x) => x.id === a.id,
        )!;
        return {
          status: 200,
          ref: { id: `${t.publicId}:${profile.public_id}`, type: 'agent_assignment' },
          data: await this.#assignmentView(tx, p, row),
        };
      },
      async (tx, p, ref) => {
        this.#assignScope(caller);
        return this.#renderAssignment(tx, p, ref.id);
      },
    );
  }

  /** Agent execution does not exist yet (8C): the endpoint refuses truthfully and changes nothing. */
  async startAgentRun(caller: Caller, ws: unknown, tsk: unknown, agt: unknown) {
    this.#assignScope(caller);
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const t = await this.loadTask(tx, p, tsk);
      this.requireTaskAction(p, 'agent.assign', t, { shares: false, excluded: 'forbidden' });
      await this.#visible(tx, p, agt);
      throw new TenancyError('dependency_unavailable', {
        issues: [
          issue(
            '/',
            'execution_unavailable',
            'Agent runs arrive in Phase 8C. The assignment is saved; nothing was sent to the agent.',
          ),
        ],
      });
    });
  }
}

function createHashHex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
