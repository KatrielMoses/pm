import { sql, type WorkspaceTransaction } from '@pm/db';
import {
  compilePrincipal,
  compileVisibility,
  decideBrand,
  decideWorkspace,
  type Principal,
} from '@pm/tenancy';
import { recordJoins, recordProject } from '../collab/record-sql.ts';

/** An active person a notification may be about. */
export interface Person {
  id: string;
  account_id: string;
  kind: 'member' | 'guest';
}

/** The person as the platform knows them, if still active in this workspace. */
export async function activePerson(
  tx: WorkspaceTransaction,
  membershipId: string,
): Promise<Person | null> {
  const m = await tx.db
    .selectFrom('tenancy.membership')
    .select(['id', 'account_id', 'kind'])
    .where('id', '=', membershipId)
    .where('state', '=', 'active')
    .executeTakeFirst();
  return m ? { id: m.id, account_id: m.account_id, kind: m.kind as 'member' | 'guest' } : null;
}

/** The compiled principal of a person (the same compiler every read uses). */
export function principalOf(tx: WorkspaceTransaction, p: Person): Promise<Principal> {
  return compilePrincipal(tx, p.id, p.account_id, p.kind);
}

/**
 * The records among `ids` that `principal` can read right now (view level, archived included),
 * decided by the one compiled visibility predicate that lists use. Tasks and projects are the
 * record types notifications name until later phases register more.
 */
export async function readableRecords(
  tx: WorkspaceTransaction,
  principal: Principal,
  ids: readonly string[],
  arrayMax: number,
): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const vis = await compileVisibility(tx, principal, {
    need: 'view',
    includeArchived: true,
    arrayMax,
  });
  const rows = await sql<{ id: string }>`
    SELECT r.id FROM core.record r
      ${recordJoins}
     WHERE r.id = ANY(${[...ids]}::uuid[]) AND r.record_type IN ('task', 'project', 'document', 'connection')
       AND ${vis.where('r', { project: recordProject })}`.execute(tx.db);
  const out = new Set(rows.rows.map((r) => r.id));
  for (const id of await readableAutomations(tx, principal, ids)) out.add(id);
  return out;
}

/**
 * 8A: automations a person may hear about now: they configure automations, or view their health,
 * in the automation's scope (its brand, or the workspace). Guests never do.
 */
export async function readableAutomations(
  tx: WorkspaceTransaction,
  principal: Principal,
  ids: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!ids.length || principal.kind !== 'member') return out;
  const rows = await tx.db
    .selectFrom('automation.automation as a')
    .leftJoin('tenancy.brand as b', 'b.id', 'a.brand_id')
    .select(['a.id', 'a.brand_id', 'a.lifecycle_state', 'b.is_sensitive', 'b.lifecycle_state as brand_state'])
    .where('a.id', 'in', [...ids])
    .execute();
  for (const r of rows) {
    if (r.lifecycle_state === 'trashed' || r.lifecycle_state === 'purged') continue;
    const ok = (action: 'automations.configure' | 'health.view') =>
      r.brand_id
        ? decideBrand(principal, action, {
            id: r.brand_id,
            isSensitive: !!r.is_sensitive,
            lifecycleState: (r.brand_state ?? 'trashed') as 'active',
          }).allowed
        : decideWorkspace(principal, action).allowed;
    if (ok('automations.configure') || ok('health.view')) out.add(r.id);
  }
  return out;
}

export interface Placement {
  record: string;
  brand: string | null;
  project: string | null;
}

/** Where a record sits, for preference scopes: itself, its project, and its brand. */
export async function placementOf(
  tx: WorkspaceTransaction,
  recordId: string,
): Promise<Placement | null> {
  const r = await sql<{ id: string; brand_id: string | null; project_id: string | null }>`
    SELECT r.id, r.brand_id, ${recordProject} AS project_id
      FROM core.record r
      ${recordJoins}
     WHERE r.id = ${recordId}`.execute(tx.db);
  const row = r.rows[0];
  return row ? { record: row.id, brand: row.brand_id, project: row.project_id } : null;
}
