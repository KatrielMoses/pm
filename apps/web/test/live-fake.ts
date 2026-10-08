import { vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import type { Block } from '../src/docs/client.ts';
import {
  liveApi,
  type LiveEvent,
  type LiveOp,
  type LiveSession,
  type LiveSnapshot,
  type LiveUpdate,
  type PresenceEntry,
} from '../src/docs/live-client.ts';
import { blockKey } from '../src/docs/live-diff.ts';

/**
 * A small stand-in for the 4D server, faithful to the rules the client relies on (ADR-0027 C2,
 * C6, C7): one total order, block hashes, rejections that carry the current block, idempotent
 * operation identifiers, and an ordered long poll that parks until there is news or `wait` ends.
 * The client under test never computes a hash; the fake does, like the server.
 */

export const hashOf = (b: Block) => `sha256:${blockKey(b)}`;
export const apiErr = (
  code: string,
  status: number,
  issue?: string,
  issues: Array<{ pointer?: string; code: string; message: string }> = [],
) =>
  new ApiError({
    code,
    status,
    message: code,
    issues: issue ? [{ code: issue, message: issue }] : issues,
  });

type External = {
  [K in LiveOp['kind']]: Omit<Extract<LiveOp, { kind: K }>, 'op_id'> & { op_id?: string };
}[LiveOp['kind']];

export class FakeLive {
  seq = 0;
  blocks: Block[];
  log: LiveEvent[] = [];
  version = 5;
  dirty = false;
  mode: 'edit' | 'view' = 'edit';
  presence: PresenceEntry[] = [
    { peer: 'me00', you: true, name: 'Ada Owner', mode: 'edit', color: 0, caret_block: null },
  ];
  sessions = 0;
  session = '';
  sent: Array<{ after: number; ops: LiveOp[] }> = [];
  eventCalls: Array<{ after: number; wait: number; session: string }> = [];
  joinModes: Array<string | undefined> = [];
  applied = new Map<string, { seq: number; hash: string | null }>();
  private parked: Array<{ done: () => void }> = [];
  failOps: Array<unknown> = [];
  failEvents: Array<unknown> = [];
  failJoin: unknown[] = [];
  holdEvents = false;
  /** Another person's operations are applied without waking the poll (it has not heard yet). */
  quiet = false;

  constructor(blocks: Block[]) {
    this.blocks = blocks;
  }

  hashes() {
    return Object.fromEntries(this.blocks.map((b) => [b.id!, hashOf(b)]));
  }
  tag() {
    return JSON.stringify(this.presence);
  }
  snapshot(): LiveSnapshot {
    return {
      seq: this.seq,
      base_version: this.version,
      dirty: this.dirty,
      content: { v: 2, blocks: structuredClone(this.blocks) },
      hashes: this.hashes(),
      references: {},
    };
  }
  join = async (_ws: string, _doc: string, mode?: string): Promise<LiveSession> => {
    this.joinModes.push(mode);
    const failure = this.failJoin.shift();
    if (failure) throw failure;
    this.sessions += 1;
    this.session = `session_${'x'.repeat(14)}${this.sessions}`;
    return {
      ...this.snapshot(),
      session: this.session,
      peer: 'me00',
      mode: (mode as 'edit' | 'view') ?? this.mode,
      expires_at: new Date(Date.now() + 90_000).toISOString(),
      ttl_seconds: 90,
      poll_wait_seconds: 20,
      ops_batch_max: 50,
      presence: structuredClone(this.presence),
      presence_tag: this.tag(),
      document: { id: 'doc_1', title: 'Launch plan', content_version: this.version },
    };
  };

  private at(id: string) {
    return this.blocks.findIndex((b) => b.id === id);
  }

  /** The server applying one operation (the order is arrival order; refusals carry the current block). */
  apply(op: LiveOp, peer: string | null) {
    const done = (
      kind: LiveEvent['kind'],
      id: string,
      block: Block | null,
      after: string | null,
    ) => {
      this.seq += 1;
      this.dirty = true;
      const hash = block ? hashOf(block) : null;
      this.log.push({
        seq: this.seq,
        op_id: op.op_id,
        peer,
        kind,
        block_id: id,
        block,
        block_hash: hash,
        after,
      });
      this.applied.set(op.op_id, { seq: this.seq, hash });
      return { ok: true as const, hash };
    };
    const refuse = (code: string, current: Block | null) => ({
      ok: false as const,
      code,
      current,
      current_hash: current ? hashOf(current) : null,
    });
    switch (op.kind) {
      case 'insert': {
        if (this.at(op.block.id!) >= 0)
          return refuse('block_exists', this.blocks[this.at(op.block.id!)]!);
        const pos = op.after === null ? 0 : this.at(op.after) + 1;
        if (op.after !== null && pos === 0) return refuse('anchor_missing', null);
        this.blocks.splice(pos, 0, structuredClone(op.block));
        return done('insert', op.block.id!, op.block, op.after);
      }
      case 'replace': {
        const i = this.at(op.block.id!);
        if (i < 0) return refuse('block_missing', null);
        if (hashOf(this.blocks[i]!) !== op.base_hash)
          return refuse('block_changed', this.blocks[i]!);
        this.blocks[i] = structuredClone(op.block);
        return done('replace', op.block.id!, op.block, null);
      }
      case 'delete': {
        const i = this.at(op.block_id);
        if (i < 0) return refuse('block_missing', null);
        if (hashOf(this.blocks[i]!) !== op.base_hash)
          return refuse('block_changed', this.blocks[i]!);
        this.blocks.splice(i, 1);
        return done('delete', op.block_id, null, null);
      }
      case 'move': {
        const i = this.at(op.block_id);
        if (i < 0) return refuse('block_missing', null);
        const [b] = this.blocks.splice(i, 1);
        const pos = op.after === null ? 0 : this.at(op.after) + 1;
        if (op.after !== null && pos === 0) {
          this.blocks.splice(i, 0, b!);
          return refuse('anchor_missing', null);
        }
        this.blocks.splice(pos, 0, b!);
        return done('move', op.block_id, null, op.after);
      }
    }
  }

  /** Another person's accepted operation. */
  external(op: External, peer = 'peerB') {
    const full = { op_id: `ext${this.seq + 1}`, ...op } as LiveOp;
    const r = this.apply(full, peer);
    if (!this.quiet) this.wake();
    return r;
  }
  /** Replaces a block's text from outside, with the right base hash. */
  externalText(id: string, text: string, peer = 'peerB') {
    const cur = this.blocks[this.at(id)]!;
    return this.external(
      {
        kind: 'replace',
        base_hash: hashOf(cur),
        block: { id, type: 'paragraph', runs: [{ text }] },
      },
      peer,
    );
  }
  setPresence(list: PresenceEntry[]) {
    this.presence = list;
    this.wake();
  }
  wake() {
    for (const p of this.parked.splice(0)) p.done();
  }

  private since(after: number) {
    return this.log.filter((e) => e.seq > after);
  }

  operations = async (
    _ws: string,
    _doc: string,
    body: { session: string; after: number; ops: LiveOp[] },
  ): Promise<LiveUpdate> => {
    this.sent.push({ after: body.after, ops: structuredClone(body.ops) });
    const failure = this.failOps.shift();
    if (failure) throw failure;
    const applied: NonNullable<LiveUpdate['applied']> = [];
    const rejected: NonNullable<LiveUpdate['rejected']> = [];
    for (const op of body.ops) {
      const prior = this.applied.get(op.op_id);
      if (prior) {
        applied.push({ op_id: op.op_id, seq: prior.seq, block_hash: prior.hash });
        continue;
      }
      const r = this.apply(op, 'me00');
      if (r.ok) applied.push({ op_id: op.op_id, seq: this.seq, block_hash: r.hash });
      else
        rejected.push({
          op_id: op.op_id,
          code: r.code as never,
          current: r.current,
          current_hash: r.current_hash,
        });
    }
    this.wake();
    return {
      applied,
      rejected,
      seq: this.seq,
      events: structuredClone(this.since(body.after)),
      presence: structuredClone(this.presence),
      presence_tag: this.tag(),
    };
  };

  events = (
    _ws: string,
    _doc: string,
    q: { session: string; after: number; wait: number; presenceTag: string },
    signal?: AbortSignal,
  ): Promise<LiveUpdate> => {
    this.eventCalls.push({ after: q.after, wait: q.wait, session: q.session });
    const failure = this.failEvents.shift();
    if (failure) return Promise.reject(failure);
    const answer = (): LiveUpdate => ({
      seq: this.seq,
      base_version: this.version,
      dirty: this.dirty,
      events: structuredClone(this.since(q.after)),
      presence: structuredClone(this.presence),
      presence_tag: this.tag(),
    });
    const news = () => this.since(q.after).length > 0 || this.tag() !== q.presenceTag;
    if (!this.holdEvents && (news() || q.wait === 0)) return Promise.resolve(answer());
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(answer());
      };
      const onAbort = () => {
        clearTimeout(timer);
        this.parked = this.parked.filter((p) => p.done !== finish);
        reject(apiErr('aborted', 0));
      };
      const timer = setTimeout(finish, q.wait * 1000);
      this.parked.push({ done: this.holdEvents ? () => undefined : finish });
      signal?.addEventListener('abort', onAbort);
    });
  };

  heartbeat = vi.fn(
    async (_ws: string, _doc: string, body: { session: string; caret?: string | null }) => {
      const me = this.presence.find((p) => p.you);
      if (me && body.caret !== undefined && me.caret_block !== body.caret)
        me.caret_block = body.caret;
      return {
        expires_at: new Date(Date.now() + 90_000).toISOString(),
        presence: structuredClone(this.presence),
        presence_tag: this.tag(),
      };
    },
  );
  checkpoint = vi.fn(async () => {
    const saved = this.dirty;
    if (saved) this.version += 1;
    this.dirty = false;
    return { saved, content_version: this.version, seq: this.seq, dirty: false };
  });
  leave = vi.fn(async () => ({ left: true, saved: false }));

  install() {
    vi.spyOn(liveApi, 'join').mockImplementation(this.join);
    vi.spyOn(liveApi, 'operations').mockImplementation(this.operations);
    vi.spyOn(liveApi, 'events').mockImplementation(this.events);
    vi.spyOn(liveApi, 'heartbeat').mockImplementation(this.heartbeat);
    vi.spyOn(liveApi, 'checkpoint').mockImplementation(this.checkpoint);
    vi.spyOn(liveApi, 'leave').mockImplementation(this.leave);
    return this;
  }
}
