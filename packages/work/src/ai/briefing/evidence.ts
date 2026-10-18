import { newUuidV7 } from '@pm/contracts';
import { sql, type WorkspaceTransaction } from '@pm/db';
import { compileVisibility, decideBrand, type Principal } from '@pm/tenancy';
import { readableRecords } from '../../notify/access.ts';

/**
 * Phase 7E corrective review 01 (R1, R2; ADR-0042 D11): the authorization basis of saved briefing
 * content. A statement's basis is every record, brand, and exact-brand permission that contributed
 * to it, including the items a list did not show and previous-window contributors, not only its
 * displayed sample. The same decision guards briefing display and replay, notification rendering,
 * and every correction surface: any lost contributor or permission withholds the content whole.
 * Readability is decided by the canonical compiled visibility (`readableRecords`, the visibility
 * context's brands) and the canonical brand decision; there is no second evaluator.
 */

/** The most records one statement's basis may hold; a larger basis cannot be kept verifiable. */
export const BASIS_MAX = 1000;

export type EvidencePermission = 'timesheet.approve';

/** A statement's basis, by public id (resolved to internal references when stored). */
export interface Basis {
  records: string[];
  brands: string[];
  perms: Array<{ perm: EvidencePermission; brand: string }>;
  /** True when the basis exceeded BASIS_MAX; the statement then keeps no total. */
  overflow?: boolean;
}

export interface EvidenceRow {
  kind: 'record' | 'brand' | 'permission';
  record_id: string | null;
  brand_id: string | null;
  permission: EvidencePermission | null;
}

export const emptyBasis = (): Basis => ({ records: [], brands: [], perms: [] });

/** Resolves public ids to internal references. Unknown ids resolve to nothing (never widen). */
export async function resolveBasis(
  tx: WorkspaceTransaction,
  basis: Basis,
): Promise<{ rows: EvidenceRow[]; missing: boolean }> {
  const publics = [
    ...new Set([...basis.records, ...basis.brands, ...basis.perms.map((p) => p.brand)]),
  ];
  const ids = new Map<string, string>();
  for (let i = 0; i < publics.length; i += 1000) {
    const chunk = publics.slice(i, i + 1000);
    const rows = await tx.db
      .selectFrom('core.record')
      .select(['id', 'public_id'])
      .where('public_id', 'in', chunk)
      .execute();
    for (const r of rows) ids.set(r.public_id, r.id);
  }
  const out: EvidenceRow[] = [];
  let missing = false;
  const seen = new Set<string>();
  const push = (row: EvidenceRow) => {
    const k = `${row.kind}:${row.record_id}:${row.brand_id}:${row.permission}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(row);
    }
  };
  for (const r of basis.records) {
    const id = ids.get(r);
    if (!id) missing = true;
    else push({ kind: 'record', record_id: id, brand_id: null, permission: null });
  }
  for (const b of basis.brands) {
    const id = ids.get(b);
    if (!id) missing = true;
    else push({ kind: 'brand', record_id: null, brand_id: id, permission: null });
  }
  for (const p of basis.perms) {
    const id = ids.get(p.brand);
    if (!id) missing = true;
    else push({ kind: 'permission', record_id: null, brand_id: id, permission: p.perm });
  }
  return { rows: out, missing };
}

/** Stores evidence rows for a statement (by position) or a correction. */
export async function storeEvidence(
  tx: WorkspaceTransaction,
  owner: { briefingId: string; position: number } | { correctionId: string } | { proposalId: string },
  rows: readonly EvidenceRow[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += 500)
    await tx.db
      .insertInto('ai.briefing_evidence')
      .values(
        rows.slice(i, i + 500).map((r) => ({
          id: newUuidV7(),
          workspace_id: tx.workspaceId,
          briefing_id: 'briefingId' in owner ? owner.briefingId : null,
          correction_id: 'correctionId' in owner ? owner.correctionId : null,
          proposal_id: 'proposalId' in owner ? owner.proposalId : null,
          position: 'briefingId' in owner ? owner.position : null,
          kind: r.kind,
          record_id: r.record_id,
          brand_id: r.brand_id,
          permission: r.permission,
        })),
      )
      .execute();
}

export async function evidenceOf(
  tx: WorkspaceTransaction,
  owner:
    | { briefingId: string; position?: number }
    | { correctionId: string }
    | { proposalId: string },
): Promise<EvidenceRow[]> {
  let q = tx.db
    .selectFrom('ai.briefing_evidence')
    .select(['kind', 'record_id', 'brand_id', 'permission'])
    .distinct();
  q =
    'correctionId' in owner
      ? q.where('correction_id', '=', owner.correctionId)
      : 'proposalId' in owner
        ? q.where('proposal_id', '=', owner.proposalId)
        : q.where('briefing_id', '=', owner.briefingId);
  if ('briefingId' in owner && owner.position !== undefined)
    q = q.where('position', '=', owner.position);
  return (await q.execute()) as EvidenceRow[];
}

/**
 * Whether `p` may still read everything the evidence rests on: every record (compiled visibility,
 * archived included), every brand (the visibility context's readable brands), and every permission
 * on its exact brand (the canonical brand decision). Purged records and brands are not readable.
 */
export async function evidenceReadable(
  tx: WorkspaceTransaction,
  p: Principal,
  rows: readonly EvidenceRow[],
  arrayMax: number,
): Promise<boolean> {
  const records = [...new Set(rows.flatMap((r) => (r.kind === 'record' ? [r.record_id!] : [])))];
  for (let i = 0; i < records.length; i += 2000) {
    const chunk = records.slice(i, i + 2000);
    const ok = await readableRecords(tx, p, chunk, arrayMax);
    if (ok.size !== chunk.length) return false;
  }
  const brands = [...new Set(rows.flatMap((r) => (r.kind === 'brand' ? [r.brand_id!] : [])))];
  if (brands.length) {
    const vis = await compileVisibility(tx, p, { need: 'view', includeArchived: true, arrayMax });
    const readable = new Set(vis.ctx.brandIds);
    if (brands.some((b) => !readable.has(b))) return false;
  }
  const perms = rows.filter((r) => r.kind === 'permission');
  if (perms.length) {
    const facts = await sql<{ id: string; is_sensitive: boolean; lifecycle_state: string }>`
      SELECT id, is_sensitive, lifecycle_state FROM tenancy.brand
       WHERE id = ANY(${[...new Set(perms.map((r) => r.brand_id!))]}::uuid[])`.execute(tx.db);
    const by = new Map(facts.rows.map((b) => [b.id, b]));
    for (const r of perms) {
      const b = by.get(r.brand_id!);
      if (
        !b ||
        !decideBrand(p, r.permission!, {
          id: b.id,
          isSensitive: b.is_sensitive,
          lifecycleState: b.lifecycle_state as 'active',
        }).allowed
      )
        return false;
    }
  }
  return true;
}

/**
 * The one availability decision for a saved briefing (display, replay, notification rendering):
 * the recipient's own, published, content present, and its whole evidence basis readable now.
 */
export async function briefingAvailable(
  tx: WorkspaceTransaction,
  p: Principal,
  briefing: { id: string; state: string; content_state: string; recipient_membership_id: string },
  arrayMax: number,
): Promise<boolean> {
  if (
    briefing.recipient_membership_id !== p.membershipId ||
    briefing.state !== 'published' ||
    briefing.content_state !== 'present'
  )
    return false;
  return evidenceReadable(tx, p, await evidenceOf(tx, { briefingId: briefing.id }), arrayMax);
}
