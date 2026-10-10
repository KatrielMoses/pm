import { describe, expect, it } from 'vitest';
import type { Block } from '../src/docs/client.ts';
import {
  applyEventToMirror,
  applyRemoteEvent,
  mirrorFromSnapshot,
  reconcileSnapshot,
  resolveConflict,
} from '../src/docs/live-apply.ts';
import type { LiveEvent, LiveSnapshot } from '../src/docs/live-client.ts';
import {
  blockKey,
  diffToOps,
  editKey,
  ensureIds,
  mirrorBlock,
  type MirrorBlock,
} from '../src/docs/live-diff.ts';
import { toEdit, type EditBlock } from '../src/docs/model.ts';

const para = (id: string, text: string): Block => ({ id, type: 'paragraph', runs: [{ text }] });
const mirror = (...bs: Block[]): MirrorBlock[] =>
  bs.map((b) => mirrorBlock(b, `sha256:${b.id}:${blockKey(b)}`));
const local = (...bs: Block[]): EditBlock[] => bs.map((b) => toEdit(b));
let n = 0;
const opId = () => `op${++n}`;
const none = new Set<string>();

const ev = (over: Partial<LiveEvent> & Pick<LiveEvent, 'kind' | 'block_id'>): LiveEvent => ({
  seq: 1,
  op_id: 'remote',
  peer: 'p1',
  block: null,
  block_hash: 'sha256:new',
  after: null,
  ...over,
});

describe('diffToOps', () => {
  const a = para('blk_a', 'one');
  const b = para('blk_b', 'two');
  const c = para('blk_c', 'three');

  it('sends nothing when nothing changed', () => {
    expect(diffToOps(local(a, b), mirror(a, b), none, 50, opId).ops).toEqual([]);
  });

  it('replaces a changed block with the hash the server last said', () => {
    const m = mirror(a, b);
    const edited = local(a, para('blk_b', 'two!'));
    const { ops } = diffToOps(edited, m, none, 50, opId);
    expect(ops).toEqual([
      {
        op_id: expect.any(String),
        kind: 'replace',
        base_hash: m[1]!.hash,
        block: para('blk_b', 'two!'),
      },
    ]);
  });

  it('inserts new blocks after the block before them, and first when there is none', () => {
    const fresh = ensureIds([
      { key: 'k1', type: 'paragraph', text: 'top' },
      ...local(a),
      { key: 'k2', type: 'paragraph', text: 'end' },
    ]);
    const { ops } = diffToOps(fresh, mirror(a), none, 50, opId);
    expect(ops.map((o) => [o.kind, 'after' in o ? o.after : undefined])).toEqual([
      ['insert', null],
      ['insert', 'blk_a'],
    ]);
    const first = ops[0] as Extract<(typeof ops)[number], { kind: 'insert' }>;
    expect(first.block.id).toMatch(/^b_[A-Za-z0-9]{12}$/);
    expect(first.block.id).toBe(fresh[0]!.id);
  });

  it('deletes removed blocks with their base hash, before anything else', () => {
    const m = mirror(a, b, c);
    const { ops } = diffToOps(local(a, para('blk_c', 'three!')), m, none, 50, opId);
    expect(ops.map((o) => o.kind)).toEqual(['delete', 'replace']);
    expect(ops[0]).toMatchObject({ block_id: 'blk_b', base_hash: m[1]!.hash });
  });

  it('moves a reordered block after the one before it', () => {
    const { ops } = diffToOps(local(b, a), mirror(a, b), none, 50, opId);
    expect(ops).toEqual([
      { op_id: expect.any(String), kind: 'move', block_id: 'blk_b', after: null },
    ]);
    const { ops: back } = diffToOps(local(a, c, b), mirror(a, b, c), none, 50, opId);
    expect(back).toEqual([
      { op_id: expect.any(String), kind: 'move', block_id: 'blk_c', after: 'blk_a' },
    ]);
  });

  it('leaves frozen blocks alone and keeps the rest valid', () => {
    const m = mirror(a, b, c);
    const edited = local(para('blk_a', 'mine'), para('blk_b', 'mine too'), c);
    const { ops } = diffToOps(edited, m, new Set(['blk_b']), 50, opId);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'replace', block: { id: 'blk_a' } });
    // a frozen block the person deleted is not deleted behind their back either
    expect(diffToOps(local(a, c), m, new Set(['blk_b']), 50, opId).ops).toEqual([]);
  });

  it('caps a batch, and what is left is computed again after the answer', () => {
    const many = Array.from({ length: 10 }, (_v, i) => para(`blk_${i}x`, `t${i}`));
    const edited = many.map((x, i) => para(x.id!, `t${i}!`));
    const { ops } = diffToOps(local(...edited), mirror(...many), none, 4, opId);
    expect(ops).toHaveLength(4);
  });

  it('gives each operation its own identifier', () => {
    const edited = local(para('blk_a', 'x'), para('blk_b', 'y'));
    const { ops, meta } = diffToOps(edited, mirror(a, b), none, 50, opId);
    expect(new Set(ops.map((o) => o.op_id)).size).toBe(2);
    expect(meta.get(ops[0]!.op_id)).toMatchObject({ kind: 'replace', blockId: 'blk_a' });
  });
});

describe('applyEventToMirror', () => {
  const a = para('blk_a', 'one');
  const b = para('blk_b', 'two');
  it('inserts, replaces, moves and deletes in order', () => {
    let m = mirror(a, b);
    m = applyEventToMirror(
      m,
      ev({ kind: 'insert', block_id: 'blk_c', block: para('blk_c', 'new'), after: null }),
    );
    expect(m.map((x) => x.id)).toEqual(['blk_c', 'blk_a', 'blk_b']);
    m = applyEventToMirror(m, ev({ kind: 'move', block_id: 'blk_c', after: 'blk_b' }));
    expect(m.map((x) => x.id)).toEqual(['blk_a', 'blk_b', 'blk_c']);
    m = applyEventToMirror(
      m,
      ev({
        kind: 'replace',
        block_id: 'blk_a',
        block: para('blk_a', 'ONE'),
        block_hash: 'sha256:h2',
      }),
    );
    expect(m[0]).toMatchObject({ hash: 'sha256:h2', key: blockKey(para('blk_a', 'ONE')) });
    m = applyEventToMirror(m, ev({ kind: 'delete', block_id: 'blk_b' }));
    expect(m.map((x) => x.id)).toEqual(['blk_a', 'blk_c']);
  });
});

describe('applyRemoteEvent: unsent text is never overwritten', () => {
  const a = para('blk_a', 'one');
  const b = para('blk_b', 'two');
  const refs = {};
  const step = (loc: EditBlock[], m: MirrorBlock[], e: LiveEvent, conflicts = [] as never[]) => {
    const next = applyEventToMirror(m, e);
    return { next, ...applyRemoteEvent(loc, conflicts, m, next, e, refs, 'Sam') };
  };

  it('takes a remote replace into a block nobody here changed, keeping its key', () => {
    const loc = local(a, b);
    const r = step(
      loc,
      mirror(a, b),
      ev({ kind: 'replace', block_id: 'blk_b', block: para('blk_b', 'two by Sam') }),
    );
    expect(r.conflicts).toEqual([]);
    expect((r.local[1] as { text: string }).text).toBe('two by Sam');
    expect(r.local[1]!.key).toBe(loc[1]!.key);
  });

  it('keeps my text and flags the block when it differs from theirs', () => {
    const loc = local(a, para('blk_b', 'two, typed by me'));
    const r = step(
      loc,
      mirror(a, b),
      ev({ kind: 'replace', block_id: 'blk_b', block: para('blk_b', 'two by Sam') }),
    );
    expect((r.local[1] as { text: string }).text).toBe('two, typed by me');
    expect(r.conflicts).toEqual([
      expect.objectContaining({
        id: 'blk_b',
        kind: 'changed',
        by: 'Sam',
        theirs: para('blk_b', 'two by Sam'),
      }),
    ]);
    expect(r.flagged).toEqual(['blk_b']);
  });

  it('is no conflict when both sides typed the same thing', () => {
    const loc = local(a, para('blk_b', 'same'));
    const r = step(
      loc,
      mirror(a, b),
      ev({ kind: 'replace', block_id: 'blk_b', block: para('blk_b', 'same') }),
    );
    expect(r.conflicts).toEqual([]);
  });

  it('a remote delete of a block I changed waits for a choice; of an untouched block it applies', () => {
    const mine = local(a, para('blk_b', 'edited'));
    const r = step(mine, mirror(a, b), ev({ kind: 'delete', block_id: 'blk_b' }));
    expect(r.local).toHaveLength(2);
    expect(r.conflicts[0]).toMatchObject({ id: 'blk_b', kind: 'deleted_by_them', theirs: null });
    const clean = step(local(a, b), mirror(a, b), ev({ kind: 'delete', block_id: 'blk_b' }));
    expect(clean.local).toHaveLength(1);
    expect(clean.conflicts).toEqual([]);
  });

  it('a remote change to a block I deleted (not sent) waits for a choice', () => {
    const r = step(
      local(a),
      mirror(a, b),
      ev({ kind: 'replace', block_id: 'blk_b', block: para('blk_b', 'two by Sam') }),
    );
    expect(r.local).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({ id: 'blk_b', kind: 'deleted_by_me' });
  });

  it('places remote inserts and moves where the server put them', () => {
    const ins = step(
      local(a, b),
      mirror(a, b),
      ev({ kind: 'insert', block_id: 'blk_n', block: para('blk_n', 'new'), after: 'blk_a' }),
    );
    expect(ins.local.map((x) => x.id)).toEqual(['blk_a', 'blk_n', 'blk_b']);
    const mv = step(
      local(a, b),
      mirror(a, b),
      ev({ kind: 'move', block_id: 'blk_b', after: null }),
    );
    expect(mv.local.map((x) => x.id)).toEqual(['blk_b', 'blk_a']);
  });
});

describe('reconcileSnapshot and resolveConflict', () => {
  const a = para('blk_a', 'one');
  const b = para('blk_b', 'two');
  const snapOf = (...bs: Block[]): LiveSnapshot => ({
    seq: 9,
    base_version: 3,
    dirty: false,
    content: { v: 2, blocks: bs },
    hashes: Object.fromEntries(bs.map((x) => [x.id!, `sha256:${x.id}`])),
    references: {},
  });
  const keys = (...bs: Block[]) => new Map(bs.map((x) => [x.id!, blockKey(x)]));

  it('takes the server version of untouched blocks, adds theirs, drops what they deleted', () => {
    const c = para('blk_c', 'three');
    const r = reconcileSnapshot(
      local(a, b),
      [],
      keys(a, b),
      mirrorFromSnapshot(snapOf(para('blk_a', 'ONE'), c)),
      {},
    );
    expect(r.local.map((x) => x.id)).toEqual(['blk_a', 'blk_c']);
    expect((r.local[0] as { text: string }).text).toBe('ONE');
    expect(r.conflicts).toEqual([]);
  });

  it('never drops typed text: changed blocks stay and wait for a choice', () => {
    const mine = local(para('blk_a', 'my one'), para('blk_b', 'my two'));
    const r = reconcileSnapshot(
      mine,
      [],
      keys(a, b),
      mirrorFromSnapshot(snapOf(para('blk_a', 'their one'))),
      {},
    );
    expect(r.local.map((x) => (x as { text: string }).text)).toEqual(['my one', 'my two']);
    expect(r.conflicts.map((c) => [c.id, c.kind])).toEqual([
      ['blk_a', 'changed'],
      ['blk_b', 'deleted_by_them'],
    ]);
  });

  it('keeps my new blocks, and my change where the server did not change the block', () => {
    const fresh = ensureIds([{ key: 'kn', type: 'paragraph', text: 'brand new' }]);
    const mine = [...local(para('blk_a', 'my one')), ...fresh];
    const r = reconcileSnapshot(mine, [], keys(a), mirrorFromSnapshot(snapOf(a)), {});
    expect(r.local).toHaveLength(2);
    expect(r.conflicts).toEqual([]);
    expect(editKey(r.local[0]!)).toBe(blockKey(para('x', 'my one')));
  });

  it('with no known base, a differing block is a conflict, never an overwrite', () => {
    const r = reconcileSnapshot(
      local(para('blk_a', 'mine')),
      [],
      null,
      mirrorFromSnapshot(snapOf(a)),
      {},
    );
    expect(r.conflicts[0]).toMatchObject({ id: 'blk_a', kind: 'changed' });
    expect((r.local[0] as { text: string }).text).toBe('mine');
  });

  it('a block that was waiting for a choice is offered again after a reload, never overwritten', () => {
    const mine = local(para('blk_a', 'mine'));
    const base = new Map([['blk_a', '!conflict']]);
    const r = reconcileSnapshot(
      mine,
      [],
      base,
      mirrorFromSnapshot(snapOf(para('blk_a', 'theirs'))),
      {},
    );
    expect(r.conflicts).toEqual([expect.objectContaining({ id: 'blk_a', kind: 'changed' })]);
    expect((r.local[0] as { text: string }).text).toBe('mine');
    // they deleted it: still offered
    const gone = reconcileSnapshot(mine, [], base, mirrorFromSnapshot(snapOf(b)), {});
    expect(gone.conflicts[0]).toMatchObject({ id: 'blk_a', kind: 'deleted_by_them' });
    expect(gone.local.map((x) => x.id)).toContain('blk_a');
  });

  it('keep mine changes nothing locally; take theirs replaces, restores or removes', () => {
    const m = mirror(a, b);
    const changed = {
      id: 'blk_b',
      kind: 'changed' as const,
      by: 'Sam',
      theirs: para('blk_b', 'sam'),
      mine: local(para('blk_b', 'me'))[0]!,
    };
    const loc = [...local(a), changed.mine];
    expect(
      resolveConflict(loc, m, changed, 'mine', {}).map((x) => (x as { text: string }).text),
    ).toEqual(['one', 'me']);
    expect(
      resolveConflict(loc, m, changed, 'theirs', {}).map((x) => (x as { text: string }).text),
    ).toEqual(['one', 'sam']);
    const gone = {
      id: 'blk_b',
      kind: 'deleted_by_them' as const,
      by: null,
      theirs: null,
      mine: changed.mine,
    };
    expect(resolveConflict(loc, m, gone, 'theirs', {})).toHaveLength(1);
    const mineDeleted = {
      id: 'blk_b',
      kind: 'deleted_by_me' as const,
      by: 'Sam',
      theirs: para('blk_b', 'sam'),
      mine: null,
    };
    expect(resolveConflict(local(a), m, mineDeleted, 'theirs', {}).map((x) => x.id)).toEqual([
      'blk_a',
      'blk_b',
    ]);
  });
});
