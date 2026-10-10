import type { Block, References } from './client.ts';
import type { LiveEvent, LiveSnapshot } from './live-client.ts';
import { blockKey, editKey, mirrorBlock, type MirrorBlock } from './live-diff.ts';
import { toEdit, type EditBlock } from './model.ts';

/**
 * Live editing, applying what other people did (ADR-0027 C2). Events arrive in `seq` order and
 * change the mirror of the server's blocks. The local list follows the mirror except where the
 * person has unsent changes: those blocks are never overwritten. They become a conflict with
 * two honest choices, keep mine or take theirs. Nothing here touches the network or React.
 */

export interface LiveConflict {
  /** The block's identifier. */
  id: string;
  /**
   * changed: you and someone else changed it. deleted_by_them: you changed it, they deleted it.
   * deleted_by_me: you deleted it, they changed it.
   */
  kind: 'changed' | 'deleted_by_them' | 'deleted_by_me';
  /** Who made the other change, when the server said (never guessed). */
  by: string | null;
  /** The server's block now (null when it is gone). */
  theirs: Block | null;
  /** Your version (null when you deleted it). */
  mine: EditBlock | null;
}

export const mirrorFromSnapshot = (s: LiveSnapshot): MirrorBlock[] =>
  s.content.blocks.map((b) => mirrorBlock(b, s.hashes[b.id!] ?? ''));

/** The mirror after one event. `own` is the block this client sent (used for its own operations). */
export function applyEventToMirror(
  blocks: readonly MirrorBlock[],
  ev: LiveEvent,
  own?: Block | null,
): MirrorBlock[] {
  const rest = blocks.filter((m) => m.id !== ev.block_id);
  const at = (after: string | null): number => {
    if (after === null) return 0;
    const i = rest.findIndex((m) => m.id === after);
    return i < 0 ? rest.length : i + 1;
  };
  switch (ev.kind) {
    case 'delete':
      return rest;
    case 'move': {
      const cur = blocks.find((m) => m.id === ev.block_id);
      if (!cur) return rest;
      const i = at(ev.after);
      return [...rest.slice(0, i), cur, ...rest.slice(i)];
    }
    case 'insert': {
      const block = own ?? ev.block;
      if (!block) return rest;
      const i = at(ev.after);
      return [...rest.slice(0, i), mirrorBlock(block, ev.block_hash ?? ''), ...rest.slice(i)];
    }
    case 'replace': {
      const block = own ?? ev.block;
      if (!block) return [...blocks];
      const next = mirrorBlock(block, ev.block_hash ?? '');
      const i = blocks.findIndex((m) => m.id === ev.block_id);
      if (i < 0) return [...blocks, next];
      return blocks.map((m, n) => (n === i ? next : m));
    }
  }
}

/** The mirror after the server refused an operation and said what the block is now. */
export function setMirrorBlock(
  blocks: readonly MirrorBlock[],
  id: string,
  current: Block | null,
  hash: string | null,
): MirrorBlock[] {
  if (!current) return blocks.filter((m) => m.id !== id);
  const next = mirrorBlock(current, hash ?? '');
  return blocks.some((m) => m.id === id)
    ? blocks.map((m) => (m.id === id ? next : m))
    : [...blocks, next];
}

const withConflict = (list: readonly LiveConflict[], c: LiveConflict): LiveConflict[] => [
  ...list.filter((x) => x.id !== c.id),
  c,
];

/** Where a block belongs in the local list: after the nearest earlier mirror block that is there. */
function placeAfter(local: readonly EditBlock[], mirror: readonly MirrorBlock[], id: string): number {
  const at = mirror.findIndex((m) => m.id === id);
  for (let i = at - 1; i >= 0; i--) {
    const j = local.findIndex((b) => b.id === mirror[i]!.id);
    if (j >= 0) return j + 1;
  }
  return 0;
}

export interface RemoteResult {
  local: EditBlock[];
  conflicts: LiveConflict[];
  /** Blocks other people changed in the local list (for a polite note). */
  touched: number;
  /** Blocks that now wait for a choice, newly (for a polite note). */
  flagged: string[];
}

/**
 * One event from someone else, applied to the local list. `prev` and `next` are the mirror before
 * and after it; `frozen` holds blocks already waiting for a choice.
 */
export function applyRemoteEvent(
  local: readonly EditBlock[],
  conflicts: readonly LiveConflict[],
  prev: readonly MirrorBlock[],
  next: readonly MirrorBlock[],
  ev: LiveEvent,
  refs: References,
  by: string | null,
): RemoteResult {
  const id = ev.block_id;
  const idx = local.findIndex((b) => b.id === id);
  const mine = idx >= 0 ? local[idx]! : null;
  const before = prev.find((m) => m.id === id);
  const waiting = conflicts.find((c) => c.id === id);
  const done = (l: EditBlock[], c: LiveConflict[], touched = 0, flagged: string[] = []) => ({
    local: l,
    conflicts: c,
    touched,
    flagged,
  });
  const remove = (list: LiveConflict[]) => list.filter((c) => c.id !== id);
  switch (ev.kind) {
    case 'insert': {
      if (idx >= 0 || !ev.block) return done([...local], [...conflicts]);
      const at = placeAfter(local, next, id);
      const added = [...local];
      added.splice(at, 0, toEdit(ev.block, refs));
      return done(added, [...conflicts], 1);
    }
    case 'move': {
      if (idx < 0) return done([...local], [...conflicts]);
      const without = local.filter((b) => b.id !== id);
      const at = placeAfter(without, next, id);
      const moved = [...without];
      moved.splice(at, 0, mine!);
      return done(moved, [...conflicts], 1);
    }
    case 'replace': {
      if (!ev.block) return done([...local], [...conflicts]);
      const theirsKey = blockKey(ev.block);
      if (idx < 0) {
        // You deleted it (not sent yet) and they changed it: your deletion waits for a choice.
        if (before)
          return done(
            [...local],
            withConflict([...conflicts], { id, kind: 'deleted_by_me', by, theirs: ev.block, mine: null }),
            0,
            [id],
          );
        const at = placeAfter(local, next, id);
        const added = [...local];
        added.splice(at, 0, toEdit(ev.block, refs));
        return done(added, remove([...conflicts]), 1);
      }
      if (waiting) {
        // Already waiting for a choice: keep your text, show their newest.
        return done(
          [...local],
          withConflict([...conflicts], { ...waiting, by: by ?? waiting.by, theirs: ev.block }),
        );
      }
      const clean = !!before && editKey(mine!) === before.key;
      if (editKey(mine!) === theirsKey) return done([...local], [...conflicts]);
      if (clean) {
        const swapped = [...local];
        swapped[idx] = { ...toEdit(ev.block, refs), key: mine!.key } as EditBlock;
        return done(swapped, [...conflicts], 1);
      }
      return done(
        [...local],
        withConflict([...conflicts], { id, kind: 'changed', by, theirs: ev.block, mine: mine! }),
        0,
        [id],
      );
    }
    case 'delete': {
      if (idx < 0) return done([...local], remove([...conflicts]));
      const clean = !!before && editKey(mine!) === before.key && !waiting;
      if (clean) return done(
        local.filter((b) => b.id !== id),
        [...conflicts],
        1,
      );
      return done(
        [...local],
        withConflict([...conflicts], { id, kind: 'deleted_by_them', by, theirs: null, mine: mine! }),
        0,
        [id],
      );
    }
  }
}

export interface SnapshotResult {
  local: EditBlock[];
  conflicts: LiveConflict[];
  flagged: string[];
}

/**
 * A whole new picture of the document (joining, joining again, or a resync). `base` holds the
 * fingerprint of each block as it was when the local list last matched the server (null when
 * unknown). Blocks the person has not changed take the server's version; blocks they have changed
 * stay as typed and wait for a choice when the server's block differs; blocks only they have
 * (new or waiting) are kept. Nothing typed is dropped.
 */
export function reconcileSnapshot(
  local: readonly EditBlock[],
  conflicts: readonly LiveConflict[],
  base: ReadonlyMap<string, string> | null,
  snap: readonly MirrorBlock[],
  refs: References,
  by: string | null = null,
): SnapshotResult {
  const mineById = new Map(local.flatMap((b) => (b.id ? [[b.id, b] as const] : [])));
  const snapIds = new Set(snap.map((m) => m.id));
  let waiting: LiveConflict[] = [...conflicts];
  const flagged: string[] = [];
  const flag = (c: LiveConflict) => {
    waiting = withConflict(waiting, c);
    if (!conflicts.some((x) => x.id === c.id && x.kind === c.kind)) flagged.push(c.id);
  };
  const out: EditBlock[] = [];
  for (const s of snap) {
    const l = mineById.get(s.id);
    const baseKey = base?.get(s.id);
    const was = waiting.find((c) => c.id === s.id);
    if (l) {
      const lk = editKey(l);
      if (lk === s.key) {
        waiting = waiting.filter((c) => c.id !== s.id);
        out.push(l);
      } else if (was && was.kind !== 'deleted_by_me') {
        waiting = withConflict(waiting, { ...was, kind: 'changed', theirs: s.block });
        out.push(l);
      } else if (baseKey !== undefined && lk === baseKey) {
        out.push({ ...toEdit(s.block, refs), key: l.key } as EditBlock);
      } else if (baseKey !== undefined && s.key === baseKey) {
        out.push(l); // only you changed it: it is sent as a replace
      } else {
        flag({ id: s.id, kind: 'changed', by, theirs: s.block, mine: l });
        out.push(l);
      }
    } else if (was?.kind === 'deleted_by_me') {
      waiting = withConflict(waiting, { ...was, theirs: s.block });
    } else if (baseKey !== undefined) {
      // You had it and deleted it (not sent yet).
      if (s.key !== baseKey) flag({ id: s.id, kind: 'deleted_by_me', by, theirs: s.block, mine: null });
    } else {
      out.push(toEdit(s.block, refs)); // someone added it
    }
  }
  // What only you have: new blocks, or blocks they deleted. Placed after the block before them.
  let head = 0;
  local.forEach((l, i) => {
    if (!l.id || snapIds.has(l.id)) return;
    const baseKey = base?.get(l.id);
    const was = waiting.find((c) => c.id === l.id);
    if (baseKey !== undefined || was?.kind === 'deleted_by_them') {
      if (editKey(l) === baseKey && !was) return; // they deleted it and you never changed it
      flag({ id: l.id, kind: 'deleted_by_them', by, theirs: null, mine: l });
    }
    let at = -1;
    for (let j = i - 1; j >= 0 && at < 0; j--) {
      const k = out.findIndex((b) => b.id === local[j]!.id);
      if (k >= 0) at = k;
    }
    if (at < 0) out.splice(head++, 0, l);
    else out.splice(at + 1, 0, l);
  });
  // Blocks that have no identifier yet stay where they were (the engine gives them one first).
  const ids = new Set(out.map((b) => b.id));
  waiting = waiting.filter((c) => ids.has(c.id) || snapIds.has(c.id));
  return { local: out, conflicts: waiting, flagged };
}

/** Resolves one conflict. Returns the new local list and whether the block was already in it. */
export function resolveConflict(
  local: readonly EditBlock[],
  mirror: readonly MirrorBlock[],
  c: LiveConflict,
  side: 'mine' | 'theirs',
  refs: References,
): EditBlock[] {
  const idx = local.findIndex((b) => b.id === c.id);
  if (side === 'mine') return [...local];
  // Take theirs: your text for this block is dropped on purpose.
  if (c.theirs === null) return local.filter((b) => b.id !== c.id);
  const theirs = toEdit(c.theirs, refs);
  if (idx >= 0) {
    const next = [...local];
    next[idx] = { ...theirs, key: local[idx]!.key } as EditBlock;
    return next;
  }
  const next = [...local];
  next.splice(placeAfter(local, mirror, c.id), 0, theirs);
  return next;
}
