import type { Block } from './client.ts';
import { toBlock, toEdit } from './model.ts';

/**
 * Reviewing your changes against a newer version (the save found someone else's save first). Blocks
 * are matched by identifier, compared with the version you started from, and each difference gets
 * a choice: keep yours or use the latest. Nothing is chosen for you where both sides changed.
 */

export type Side = 'mine' | 'theirs';
export type RowKind =
  | 'mine_changed'
  | 'theirs_changed'
  | 'both_changed'
  | 'differs'
  | 'added_by_me'
  | 'added_by_them'
  | 'removed_by_me'
  | 'removed_by_them';

export interface ReviewRow {
  /** The block's identifier, or `new:N` for a block you added. */
  id: string;
  kind: RowKind;
  mine: Block | null;
  latest: Block | null;
  /** The choice made for you where only one side changed; null where you must choose. */
  preset: Side | null;
}

const sig = (b: Block): string => JSON.stringify(toBlock(toEdit(b), false));
const same = (a: Block | null | undefined, b: Block | null | undefined) =>
  !!a && !!b && sig(a) === sig(b);

export function buildReview(
  base: readonly Block[] | null,
  mine: readonly Block[],
  latest: readonly Block[],
): ReviewRow[] {
  const baseById = new Map((base ?? []).map((b) => [b.id, b]));
  const mineById = new Map(mine.flatMap((b) => (b.id ? [[b.id, b] as const] : [])));
  const latestById = new Map(latest.flatMap((b) => (b.id ? [[b.id, b] as const] : [])));
  const rows: ReviewRow[] = [];
  for (const l of latest) {
    const m = l.id ? mineById.get(l.id) : undefined;
    const b = l.id ? baseById.get(l.id) : undefined;
    if (m) {
      if (same(m, l)) continue;
      if (!base) rows.push({ id: l.id!, kind: 'differs', mine: m, latest: l, preset: null });
      else if (same(b, m))
        rows.push({ id: l.id!, kind: 'theirs_changed', mine: m, latest: l, preset: 'theirs' });
      else if (same(b, l))
        rows.push({ id: l.id!, kind: 'mine_changed', mine: m, latest: l, preset: 'mine' });
      else rows.push({ id: l.id!, kind: 'both_changed', mine: m, latest: l, preset: null });
    } else if (b) {
      // You removed it. Fine if nobody touched it since; a choice if they did.
      rows.push({
        id: l.id!,
        kind: 'removed_by_me',
        mine: null,
        latest: l,
        preset: same(b, l) ? 'mine' : null,
      });
    } else {
      // Not in what you started from: someone else added it (or there is no starting point).
      rows.push({ id: l.id!, kind: 'added_by_them', mine: null, latest: l, preset: base ? 'theirs' : null });
    }
  }
  let n = 0;
  for (const m of mine) {
    if (m.id && latestById.has(m.id)) continue;
    if (!m.id) rows.push({ id: `new:${++n}`, kind: 'added_by_me', mine: m, latest: null, preset: 'mine' });
    else {
      const b = baseById.get(m.id);
      // They removed it. If you left it as it was there is nothing to keep.
      if (b && same(b, m)) continue;
      rows.push({ id: m.id, kind: 'removed_by_them', mine: m, latest: null, preset: null });
    }
  }
  return rows;
}

/** The merged blocks for the choices made: the latest document with your chosen blocks put in. */
export function applyReview(
  mine: readonly Block[],
  latest: readonly Block[],
  rows: readonly ReviewRow[],
  choice: (row: ReviewRow) => Side,
): Block[] {
  const by = new Map(rows.map((r) => [r.id, r]));
  const out: Block[] = [];
  for (const l of latest) {
    const r = l.id ? by.get(l.id) : undefined;
    if (!r) out.push(l);
    else if (choice(r) === 'mine') {
      if (r.mine) out.push({ ...r.mine, id: l.id! });
      // else: you removed it, and chose to keep it removed
    } else out.push(l);
  }
  // Blocks that exist only on your side, in the place they were: after the block before them.
  const placed = new Set(out.map((b) => b.id));
  let nNew = 0;
  mine.forEach((m, i) => {
    const key = m.id ?? `new:${++nNew}`;
    if (m.id && latest.some((l) => l.id === m.id)) return;
    const r = by.get(key);
    if (!r || choice(r) !== 'mine' || !r.mine) return;
    const prev = mine.slice(0, i).reverse().find((x) => x.id && placed.has(x.id));
    const at = prev ? out.findIndex((x) => x.id === prev.id) + 1 : 0;
    out.splice(at, 0, r.mine);
    if (r.mine.id) placed.add(r.mine.id);
  });
  return out;
}
