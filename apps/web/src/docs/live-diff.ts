import type { Block } from './client.ts';
import type { LiveOp } from './live-client.ts';
import { toBlock, toEdit, type EditBlock } from './model.ts';

/**
 * Live editing, the pure part of the client (ADR-0027 C2, C7). The server holds the blocks and
 * their hashes; the client holds a mirror of that and a local list being edited. This module turns
 * the difference between the two into the smallest ordered list of block operations. It never
 * computes a server hash: `replace` and `delete` echo the hash the server last told the client.
 */

/** One block as the server last said it was. `key` is a short fingerprint of its content. */
export interface MirrorBlock {
  id: string;
  block: Block;
  /** The server's hash of this block (echoed back as `base_hash`). */
  hash: string;
  key: string;
}

/** A 53-bit string hash (cyrb53): a compact content fingerprint, not a security boundary. */
export function fingerprint(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const editKeys = new WeakMap<object, string>();

/** The content fingerprint of a block being edited (identifier excluded). */
export function editKey(b: EditBlock): string {
  const hit = editKeys.get(b);
  if (hit !== undefined) return hit;
  const k = fingerprint(JSON.stringify(toBlock(b, false)));
  editKeys.set(b, k);
  return k;
}

/** The content fingerprint of a server block, in the same terms as `editKey`. */
export const blockKey = (b: Block): string =>
  fingerprint(JSON.stringify(toBlock(toEdit(b), false)));

export const mirrorBlock = (block: Block, hash: string): MirrorBlock => ({
  id: block.id!,
  block,
  hash,
  key: blockKey(block),
});

export function randomId(prefix: string, length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = prefix;
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** A new block identifier in the server's own shape (`b_` and twelve characters). */
export const newBlockId = () => randomId('b_', 12);

/** Gives every block an identifier (returns the same array when none was missing). */
export function ensureIds(blocks: EditBlock[]): EditBlock[] {
  if (blocks.every((b) => b.id)) return blocks;
  const taken = new Set(blocks.flatMap((b) => (b.id ? [b.id] : [])));
  return blocks.map((b) => {
    if (b.id) return b;
    let id = newBlockId();
    while (taken.has(id)) id = newBlockId();
    taken.add(id);
    return { ...b, id } as EditBlock;
  });
}

export interface DiffOps {
  ops: LiveOp[];
  /** What each operation was about, by `op_id`. */
  meta: Map<string, { kind: LiveOp['kind']; blockId: string; block: Block | null }>;
}

/**
 * The operations that bring the server's blocks (`mirror`) to the local list. Deletes first, then
 * for every local block in order: insert it, move it to follow the block before it, replace it
 * when its content differs. Blocks in `frozen` (waiting for a person's choice, or refused as
 * invalid) are left alone in both lists. At most `max` operations are returned; any prefix of the
 * list is valid by itself, so the rest is simply computed again after the answer.
 */
export function diffToOps(
  local: readonly EditBlock[],
  mirror: readonly MirrorBlock[],
  frozen: ReadonlySet<string>,
  max: number,
  newOpId: () => string,
): DiffOps {
  const ops: LiveOp[] = [];
  const meta: DiffOps['meta'] = new Map();
  const add = (op: LiveOp, blockId: string, block: Block | null) => {
    ops.push(op);
    meta.set(op.op_id, { kind: op.kind, blockId, block });
  };
  const localIds = new Set(local.flatMap((b) => (b.id ? [b.id] : [])));
  const byId = new Map(mirror.map((m) => [m.id, m]));
  const sim = mirror.map((m) => m.id);
  for (const m of mirror) {
    if (localIds.has(m.id) || frozen.has(m.id)) continue;
    add({ op_id: newOpId(), kind: 'delete', block_id: m.id, base_hash: m.hash }, m.id, null);
    sim.splice(sim.indexOf(m.id), 1);
  }
  const wanted = local.filter((b) => b.id && !frozen.has(b.id));
  const wantedIds = new Set(wanted.map((b) => b.id!));
  const inSim = new Set(sim);
  let pos = 0; // sim index just after the previous wanted block
  for (let i = 0; i < wanted.length && ops.length < max; i++) {
    const b = wanted[i]!;
    const id = b.id!;
    const prev = i > 0 ? wanted[i - 1]!.id! : null;
    if (!inSim.has(id)) {
      const block = toBlock(b);
      add({ op_id: newOpId(), kind: 'insert', after: prev, block }, id, block);
      sim.splice(pos, 0, id);
      inSim.add(id);
      pos += 1;
      continue;
    }
    // The next wanted block at or after `pos` (frozen blocks may sit in between) must be this one.
    let j = pos;
    while (j < sim.length && !wantedIds.has(sim[j]!)) j++;
    if (sim[j] !== id) {
      add({ op_id: newOpId(), kind: 'move', block_id: id, after: prev }, id, null);
      sim.splice(sim.indexOf(id), 1);
      sim.splice(pos, 0, id);
      pos += 1;
    } else pos = j + 1;
    const m = byId.get(id)!;
    if (ops.length < max && editKey(b) !== m.key) {
      const block = toBlock(b);
      add({ op_id: newOpId(), kind: 'replace', base_hash: m.hash, block }, id, block);
    }
  }
  return { ops: ops.slice(0, max), meta };
}
