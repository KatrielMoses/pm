import { PROJECT_STATUSES, TASK_STATUSES } from '@pm/contracts/shell';
import { sql, type WorkspaceTransaction } from '@pm/db';
import { invalid, issue } from '@pm/tenancy';

/**
 * The one status catalog (ADR-0015 W1–W4): the immutable platform statuses seeded in 2A/2B plus
 * workflow statuses. A status is addressed by its platform key (`todo`, `completed`, …) or, for a
 * workflow status, by its public ID (`sts_…`). Views are synchronous after `primeStatuses` loads
 * the workflow statuses a transaction needs.
 */

export type RecordKind = 'project' | 'task';
export type Category = 'planned' | 'active' | 'paused' | 'done' | 'cancelled';
export const TERMINAL: ReadonlySet<string> = new Set(['done', 'cancelled']);

export interface StatusRef {
  id: string;
  key: string;
  name: string;
  category: Category;
  color: string | null;
  icon: string | null;
  rank: string;
  kind: RecordKind;
  custom: boolean;
  workflowId: string | null;
  state: 'active' | 'archived';
}

/** Platform status IDs (seeded by 0021 and 0023; never copied). */
export const PROJECT_STATUS_ID = {
  planned: '01920000-0000-7000-8000-000000000001',
  active: '01920000-0000-7000-8000-000000000002',
  on_hold: '01920000-0000-7000-8000-000000000003',
  completed: '01920000-0000-7000-8000-000000000004',
  cancelled: '01920000-0000-7000-8000-000000000005',
} as const;
export const TASK_STATUS_ID = {
  backlog: '01920000-0000-7000-8000-000000000006',
  todo: '01920000-0000-7000-8000-000000000007',
  in_progress: '01920000-0000-7000-8000-000000000008',
  blocked: '01920000-0000-7000-8000-000000000009',
  done: '01920000-0000-7000-8000-00000000000a',
  cancelled: '01920000-0000-7000-8000-00000000000b',
} as const;

const PLATFORM = new Map<string, StatusRef>();
const PLATFORM_BY_KEY = {
  project: new Map<string, StatusRef>(),
  task: new Map<string, StatusRef>(),
};
for (const [kind, list, ids] of [
  ['project', PROJECT_STATUSES, PROJECT_STATUS_ID],
  ['task', TASK_STATUSES, TASK_STATUS_ID],
] as const) {
  list.forEach((s, i) => {
    const ref: StatusRef = {
      id: (ids as Record<string, string>)[s.key]!,
      key: s.key,
      name: s.name,
      category: s.category as Category,
      color: null,
      icon: null,
      rank: String(i).padStart(2, '0'),
      kind,
      custom: false,
      workflowId: null,
      state: 'active',
    };
    PLATFORM.set(ref.id, ref);
    PLATFORM_BY_KEY[kind].set(ref.key, ref);
  });
}
export const platformStatus = (kind: RecordKind, key: string) =>
  PLATFORM_BY_KEY[kind].get(key) ?? null;
export const platformStatuses = (kind: RecordKind) => [...PLATFORM_BY_KEY[kind].values()];

const CACHE = new WeakMap<object, Map<string, StatusRef>>();
const cacheOf = (tx: WorkspaceTransaction) => {
  let m = CACHE.get(tx);
  if (!m) {
    m = new Map();
    CACHE.set(tx, m);
  }
  return m;
};

interface StatusRow {
  id: string;
  public_id: string;
  name: string;
  category: string;
  color: string;
  icon: string | null;
  rank: string;
  state: string;
  workflow_id: string;
  record_kind: string;
}
const fromRow = (r: StatusRow): StatusRef => ({
  id: r.id,
  key: r.public_id,
  name: r.name,
  category: r.category as Category,
  color: r.color,
  icon: r.icon,
  rank: r.rank,
  kind: r.record_kind as RecordKind,
  custom: true,
  workflowId: r.workflow_id,
  state: r.state as StatusRef['state'],
});
const statusQuery = (tx: WorkspaceTransaction) =>
  tx.db
    .selectFrom('workflow.workflow_status as s')
    .innerJoin('workflow.workflow as w', (j) =>
      j.onRef('w.workspace_id', '=', 's.workspace_id').onRef('w.id', '=', 's.workflow_id'),
    )
    .select([
      's.id',
      's.public_id',
      's.name',
      's.category',
      's.color',
      's.icon',
      's.rank',
      's.state',
      's.workflow_id',
      'w.record_kind',
    ]);

/** Loads the workflow statuses among `ids` into this transaction's cache. */
export async function primeStatuses(
  tx: WorkspaceTransaction,
  ids: Iterable<string | null | undefined>,
) {
  const cache = cacheOf(tx);
  const need = [
    ...new Set([...ids].filter((x): x is string => !!x && !PLATFORM.has(x) && !cache.has(x))),
  ];
  if (!need.length) return;
  for (const r of await statusQuery(tx).where('s.id', 'in', need).execute())
    cache.set(r.id, fromRow(r));
}

/** A status by id (platform or primed). Unknown ids are an internal error, never a guess. */
export function statusRef(tx: WorkspaceTransaction, id: string): StatusRef {
  const s = PLATFORM.get(id) ?? CACHE.get(tx)?.get(id);
  if (!s) throw new Error('status not primed');
  return s;
}

export function statusView(s: StatusRef) {
  return {
    key: s.key,
    name: s.name,
    category: s.category,
    ...(s.custom
      ? { color: s.color, custom: true as const, archived: s.state === 'archived' }
      : {}),
  };
}

// -----------------------------------------------------------------------------------------------
// Workflow resolution (project → brand → workspace → platform default)
// -----------------------------------------------------------------------------------------------

export interface TransitionRef {
  id: string;
  publicId: string;
  from: string;
  to: string;
  rank: string;
  description: string | null;
  confirmation: 'none' | 'confirm' | 'step_up';
  approval: 'none' | 'one_manager' | 'all_named_approvers';
  allowSelf: boolean;
  version: number;
  requirements: Array<{
    kind: 'builtin' | 'custom';
    key: string;
    definitionId: string | null;
    allowOverride: boolean;
  }>;
  approvers: string[];
}
export interface WorkflowRef {
  id: string;
  publicId: string;
  name: string;
  scopeKind: 'workspace' | 'brand' | 'project';
  version: number;
  statuses: StatusRef[];
  transitions: TransitionRef[];
}
export interface ScopeFacts {
  workspaceId: string;
  brandId: string;
  /** The project scope: the task's project, or the project itself for a project record. */
  projectId: string | null;
}

/** The workflow that applies (null = platform default), with active statuses and transitions. */
export async function resolveWorkflow(
  tx: WorkspaceTransaction,
  kind: RecordKind,
  s: ScopeFacts,
  opts: { includeArchivedStatuses?: boolean } = {},
): Promise<WorkflowRef | null> {
  const w = await tx.db
    .selectFrom('workflow.workflow')
    .select(['id', 'public_id', 'name', 'scope_kind', 'version'])
    .where('record_kind', '=', kind)
    .where('state', '=', 'active')
    .where((eb) =>
      eb.or([
        eb('scope_kind', '=', 'workspace'),
        eb.and([eb('scope_kind', '=', 'brand'), eb('brand_id', '=', s.brandId)]),
        ...(s.projectId
          ? [eb.and([eb('scope_kind', '=', 'project'), eb('project_id', '=', s.projectId)])]
          : []),
      ]),
    )
    .orderBy(sql`CASE scope_kind WHEN 'project' THEN 0 WHEN 'brand' THEN 1 ELSE 2 END`)
    .limit(1)
    .executeTakeFirst();
  if (!w) return null;
  return loadWorkflow(tx, w, opts);
}

export async function loadWorkflow(
  tx: WorkspaceTransaction,
  w: { id: string; public_id: string; name: string; scope_kind: string; version: number | string },
  opts: { includeArchivedStatuses?: boolean } = {},
): Promise<WorkflowRef> {
  let sq = statusQuery(tx).where('s.workflow_id', '=', w.id);
  if (!opts.includeArchivedStatuses) sq = sq.where('s.state', '=', 'active');
  const statuses = (await sq.orderBy('s.rank').orderBy('s.id').execute()).map(fromRow);
  const cache = cacheOf(tx);
  for (const st of statuses) cache.set(st.id, st);
  const trs = await tx.db
    .selectFrom('workflow.transition')
    .select([
      'id',
      'public_id',
      'from_status_id',
      'to_status_id',
      'rank',
      'description',
      'confirmation_tier',
      'approval_policy',
      'allow_self_approval',
      'version',
    ])
    .where('workflow_id', '=', w.id)
    .where('state', '=', 'active')
    .orderBy('rank')
    .orderBy('id')
    .execute();
  const ids = trs.map((t) => t.id);
  const reqs = ids.length
    ? await tx.db
        .selectFrom('workflow.transition_requirement')
        .select([
          'transition_id',
          'field_kind',
          'builtin_key',
          'definition_id',
          'allow_manager_override',
        ])
        .where('transition_id', 'in', ids)
        .orderBy('rank')
        .execute()
    : [];
  const appr = ids.length
    ? await tx.db
        .selectFrom('workflow.transition_approver')
        .select(['transition_id', 'membership_id'])
        .where('transition_id', 'in', ids)
        .orderBy('rank')
        .execute()
    : [];
  return {
    id: w.id,
    publicId: w.public_id,
    name: w.name,
    scopeKind: w.scope_kind as WorkflowRef['scopeKind'],
    version: Number(w.version),
    statuses,
    transitions: trs.map((t) => ({
      id: t.id,
      publicId: t.public_id,
      from: t.from_status_id,
      to: t.to_status_id,
      rank: t.rank,
      description: t.description,
      confirmation: t.confirmation_tier as TransitionRef['confirmation'],
      approval: t.approval_policy as TransitionRef['approval'],
      allowSelf: t.allow_self_approval,
      version: Number(t.version),
      requirements: reqs
        .filter((r) => r.transition_id === t.id)
        .map((r) => ({
          kind: r.field_kind as 'builtin' | 'custom',
          key: r.builtin_key ?? r.definition_id!,
          definitionId: r.definition_id,
          allowOverride: r.allow_manager_override,
        })),
      approvers: appr.filter((a) => a.transition_id === t.id).map((a) => a.membership_id),
    })),
  };
}

/** The statuses a record may newly choose: the workflow's active statuses or the platform's. */
export const offered = (kind: RecordKind, wf: WorkflowRef | null) =>
  wf ? wf.statuses : platformStatuses(kind);

/** The first offered status of a category (rank order), or null. */
export const firstOfCategory = (kind: RecordKind, wf: WorkflowRef | null, category: Category) =>
  offered(kind, wf).find((s) => s.category === category) ?? null;

/** The default status of a new record: the first planned status, else the first non-terminal. */
export function initialStatus(kind: RecordKind, wf: WorkflowRef | null): StatusRef {
  if (!wf) return platformStatus(kind, kind === 'task' ? 'todo' : 'planned')!;
  const s =
    firstOfCategory(kind, wf, 'planned') ?? wf.statuses.find((x) => !TERMINAL.has(x.category));
  if (!s)
    throw invalid(issue('/status', 'workflow_incomplete', 'This workflow has no starting status.'));
  return s;
}

/** Resolves a status key for a new choice; refuses statuses the applicable workflow does not offer. */
export function statusFromKey(
  kind: RecordKind,
  wf: WorkflowRef | null,
  key: unknown,
  pointer: string,
): StatusRef {
  const s = offered(kind, wf).find((x) => x.key === key);
  if (!s)
    throw invalid(issue(pointer, 'invalid_status', 'Choose a status offered by this workflow.'));
  return s;
}
