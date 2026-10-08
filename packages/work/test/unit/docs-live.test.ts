import { describe, expect, it } from 'vitest';
import {
  blockHash,
  DEFAULT_CONTENT_LIMITS,
  parseContent,
  type Block,
  type DocContent,
} from '../../src/docs/content.ts';
import { applyOp, parseLiveRequest, type LiveOp } from '../../src/docs/live.ts';

const p = (id: string, text: string): Block => ({ id, type: 'paragraph', runs: [{ text }] });
const doc = (...blocks: Block[]): DocContent => ({ v: 2, blocks });
const ids = (c: DocContent) => c.blocks.map((b) => b.id);
const apply = (c: DocContent, op: LiveOp) => {
  const r = applyOp(c, op);
  if (!r.ok) throw new Error(r.code);
  return r.content;
};
const LIMITS = DEFAULT_CONTENT_LIMITS;

describe('live block operations (4D)', () => {
  const base = doc(p('blk_a', 'A'), p('blk_b', 'B'), p('blk_c', 'C'));

  it('inserts after an anchor or first, and moves, without touching other blocks', () => {
    expect(
      ids(apply(base, { kind: 'insert', opId: 'o1', after: null, block: p('blk_n', 'N') })),
    ).toEqual(['blk_n', 'blk_a', 'blk_b', 'blk_c']);
    expect(
      ids(apply(base, { kind: 'insert', opId: 'o1', after: 'blk_b', block: p('blk_n', 'N') })),
    ).toEqual(['blk_a', 'blk_b', 'blk_n', 'blk_c']);
    expect(
      ids(apply(base, { kind: 'move', opId: 'o1', blockId: 'blk_a', after: 'blk_c' })),
    ).toEqual(['blk_b', 'blk_c', 'blk_a']);
    expect(ids(apply(base, { kind: 'move', opId: 'o1', blockId: 'blk_c', after: null }))).toEqual([
      'blk_c',
      'blk_a',
      'blk_b',
    ]);
    expect(apply(base, { kind: 'move', opId: 'o1', blockId: 'blk_b', after: 'blk_b' })).toEqual(
      base,
    );
  });

  it('replaces and deletes only a block that still has the hash the client saw', () => {
    const h = blockHash(base.blocks[1]!);
    const next = apply(base, {
      kind: 'replace',
      opId: 'o1',
      blockId: 'blk_b',
      baseHash: h,
      block: p('blk_b', 'B2'),
    });
    expect(next.blocks[1]).toEqual(p('blk_b', 'B2'));
    expect(
      applyOp(next, {
        kind: 'replace',
        opId: 'o2',
        blockId: 'blk_b',
        baseHash: h,
        block: p('blk_b', 'B3'),
      }),
    ).toEqual({
      ok: false,
      code: 'block_changed',
      current: p('blk_b', 'B2'),
    });
    expect(
      applyOp(next, { kind: 'delete', opId: 'o3', blockId: 'blk_b', baseHash: h }),
    ).toMatchObject({ ok: false, code: 'block_changed' });
    expect(
      ids(
        apply(next, {
          kind: 'delete',
          opId: 'o4',
          blockId: 'blk_b',
          baseHash: blockHash(p('blk_b', 'B2')),
        }),
      ),
    ).toEqual(['blk_a', 'blk_c']);
  });

  it('refuses what no longer fits and says why', () => {
    expect(
      applyOp(base, {
        kind: 'delete',
        opId: 'o',
        blockId: 'blk_x',
        baseHash: blockHash(p('blk_x', '')),
      }),
    ).toEqual({ ok: false, code: 'block_missing', current: null });
    expect(
      applyOp(base, { kind: 'insert', opId: 'o', after: 'blk_x', block: p('blk_n', 'N') }),
    ).toMatchObject({ ok: false, code: 'anchor_missing' });
    expect(
      applyOp(base, { kind: 'insert', opId: 'o', after: null, block: p('blk_a', 'dup') }),
    ).toMatchObject({ ok: false, code: 'block_exists' });
    expect(
      applyOp(base, { kind: 'move', opId: 'o', blockId: 'blk_a', after: 'blk_x' }),
    ).toMatchObject({ ok: false, code: 'anchor_missing' });
    expect(applyOp(base, { kind: 'move', opId: 'o', blockId: 'blk_x', after: null })).toMatchObject(
      { ok: false, code: 'block_missing' },
    );
  });

  it('never changes its input, and the same log always gives the same blocks', () => {
    const before = JSON.stringify(base);
    const ha = blockHash(base.blocks[0]!);
    const log: LiveOp[] = [
      { kind: 'insert', opId: '1', after: 'blk_c', block: p('blk_d', 'D') },
      { kind: 'replace', opId: '2', blockId: 'blk_a', baseHash: ha, block: p('blk_a', 'A2') },
      { kind: 'move', opId: '3', blockId: 'blk_d', after: null },
      { kind: 'delete', opId: '4', blockId: 'blk_b', baseHash: blockHash(base.blocks[1]!) },
    ];
    const run = () =>
      log.reduce((c, op) => {
        const r = applyOp(c, op);
        return r.ok ? r.content : c;
      }, base);
    expect(run()).toEqual(run());
    expect(ids(run())).toEqual(['blk_d', 'blk_a', 'blk_c']);
    expect(JSON.stringify(base)).toBe(before);
  });

  it('converges: any order of independent edits to different blocks gives one result', () => {
    const ops: LiveOp[] = ['blk_a', 'blk_b', 'blk_c'].map((id, i) => ({
      kind: 'replace' as const,
      opId: `r${i}`,
      blockId: id,
      baseHash: blockHash(base.blocks[i]!),
      block: p(id, `${id}!`),
    }));
    const orders = [
      [0, 1, 2],
      [2, 1, 0],
      [1, 0, 2],
    ];
    const results = orders.map((o) => JSON.stringify(o.reduce((c, i) => apply(c, ops[i]!), base)));
    expect(new Set(results).size).toBe(1);
  });
});

describe('live requests (4D)', () => {
  const session = 'A'.repeat(24);
  const ok = {
    session,
    after: 0,
    ops: [
      {
        op_id: 'op_1',
        kind: 'insert',
        after: null,
        block: { id: 'blk_n', type: 'paragraph', runs: [{ text: 'x' }] },
      },
    ],
  };

  it('validates, normalizes blocks, and keeps restricted tokens for the server to restore', () => {
    const r = parseLiveRequest(ok, LIMITS, 50);
    expect(r).toMatchObject({ session, after: 0, caret: undefined });
    expect(r.ops[0]).toMatchObject({ kind: 'insert', opId: 'op_1', after: null });
    const tok = parseLiveRequest(
      {
        ...ok,
        ops: [
          {
            ...ok.ops[0],
            block: {
              id: 'blk_n',
              type: 'paragraph',
              runs: [{ ref: { kind: 'restricted', id: 'rst_0123456789abcdef' } }],
            },
          },
        ],
      },
      LIMITS,
      50,
    );
    expect(tok.ops).toHaveLength(1);
  });

  it('bounds the batch and refuses unknown fields, bad handles, duplicates, and bad hashes without echoing input', () => {
    const issues = (body: unknown, max = 50) => {
      try {
        parseLiveRequest(body, LIMITS, max);
      } catch (e: any) {
        return e.issues as Array<{ pointer: string; code: string; message: string }>;
      }
      return [];
    };
    expect(issues({ ...ok, ops: [] })).toContainEqual(
      expect.objectContaining({ pointer: '/ops', code: 'too_many' }),
    );
    expect(issues({ ...ok, ops: [ok.ops[0], { ...ok.ops[0], op_id: 'op_2' }] }, 1)).toContainEqual(
      expect.objectContaining({ code: 'too_many' }),
    );
    expect(issues({ ...ok, ops: [ok.ops[0], ok.ops[0]] })).toContainEqual(
      expect.objectContaining({ code: 'duplicate' }),
    );
    expect(issues({ ...ok, extra: 1 })).toContainEqual(
      expect.objectContaining({ pointer: '/extra', code: 'unsupported_field' }),
    );
    expect(issues({ ...ok, session: 'sEcReT' })).toContainEqual(
      expect.objectContaining({ pointer: '/session', code: 'invalid_session' }),
    );
    expect(JSON.stringify(issues({ ...ok, session: 'sEcReT' }))).not.toContain('sEcReT');
    expect(issues({ ...ok, after: -1 })).toContainEqual(
      expect.objectContaining({ pointer: '/after' }),
    );
    expect(
      issues({
        ...ok,
        ops: [{ op_id: 'op_1', kind: 'delete', block_id: 'blk_a', base_hash: 'nope' }],
      }),
    ).toContainEqual(expect.objectContaining({ code: 'invalid_hash' }));
    expect(issues({ ...ok, ops: [{ op_id: 'op_1', kind: 'rotate' }] })).toContainEqual(
      expect.objectContaining({ pointer: '/ops/0/kind' }),
    );
    expect(parseContent({ v: 2, blocks: [] }, LIMITS).hash).toMatch(/^sha256:/);
  });
});
