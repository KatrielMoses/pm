import { Issues } from '@pm/tenancy';
import { isObject } from '../validation.ts';
import {
  blockHash,
  parseContent,
  type Block,
  type ContentLimits,
  type DocContent,
} from './content.ts';

/**
 * Phase 4D live editing, the pure part (ADR-0027 C1 to C2). A document is an ordered list of
 * blocks with stable identifiers; an operation is one block-level command. The server is the only
 * sequencer: it applies operations one at a time in arrival order, and an operation that no longer
 * fits the current blocks is refused with the current block (never merged, never dropped), so
 * every client that replays the accepted log holds the same blocks. Nothing here consults the
 * database or authorization.
 */

export const OP_KINDS = ['insert', 'replace', 'delete', 'move'] as const;
export type OpKind = (typeof OP_KINDS)[number];

export type LiveOp =
  | { kind: 'insert'; opId: string; block: Block; after: string | null }
  | { kind: 'replace'; opId: string; blockId: string; baseHash: string; block: Block }
  | { kind: 'delete'; opId: string; blockId: string; baseHash: string }
  | { kind: 'move'; opId: string; blockId: string; after: string | null };

/** Why an operation was refused; each has one meaning and one recovery for the client. */
export const CONFLICT_CODES = [
  'block_changed', // the block changed since the client's copy: keep mine or take theirs
  'block_missing', // the block was deleted: restore it as a new insert, or drop the edit
  'block_exists', // an insert named a block that already exists
  'anchor_missing', // the block to insert or move after was deleted
] as const;
export type ConflictCode = (typeof CONFLICT_CODES)[number];

export type Applied =
  | { ok: true; content: DocContent; block: Block | null; hash: string | null }
  | { ok: false; code: ConflictCode; current: Block | null };

const HASH = /^sha256:[0-9a-f]{64}$/;
const OP_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BLOCK_ID_MAX = 64;

/** Applies one operation to `content` (pure). The result is a new content; `content` is unchanged. */
export function applyOp(content: DocContent, op: LiveOp): Applied {
  const blocks = content.blocks;
  const at = (id: string) => blocks.findIndex((b) => b.id === id);
  const done = (next: Block[], block: Block | null): Applied => ({
    ok: true,
    content: { v: 2, blocks: next },
    block,
    hash: block ? blockHash(block) : null,
  });
  switch (op.kind) {
    case 'insert': {
      if (at(op.block.id) >= 0) return { ok: false, code: 'block_exists', current: blocks[at(op.block.id)]! };
      const pos = op.after === null ? 0 : at(op.after) + 1;
      if (op.after !== null && pos === 0) return { ok: false, code: 'anchor_missing', current: null };
      return done([...blocks.slice(0, pos), op.block, ...blocks.slice(pos)], op.block);
    }
    case 'replace': {
      const i = at(op.blockId);
      if (i < 0) return { ok: false, code: 'block_missing', current: null };
      if (blockHash(blocks[i]!) !== op.baseHash)
        return { ok: false, code: 'block_changed', current: blocks[i]! };
      return done([...blocks.slice(0, i), op.block, ...blocks.slice(i + 1)], op.block);
    }
    case 'delete': {
      const i = at(op.blockId);
      if (i < 0) return { ok: false, code: 'block_missing', current: null };
      if (blockHash(blocks[i]!) !== op.baseHash)
        return { ok: false, code: 'block_changed', current: blocks[i]! };
      return done([...blocks.slice(0, i), ...blocks.slice(i + 1)], null);
    }
    case 'move': {
      const i = at(op.blockId);
      if (i < 0) return { ok: false, code: 'block_missing', current: null };
      if (op.after === op.blockId) return done(blocks, blocks[i]!);
      const rest = [...blocks.slice(0, i), ...blocks.slice(i + 1)];
      const pos = op.after === null ? 0 : rest.findIndex((b) => b.id === op.after) + 1;
      if (op.after !== null && pos === 0) return { ok: false, code: 'anchor_missing', current: null };
      return done([...rest.slice(0, pos), blocks[i]!, ...rest.slice(pos)], blocks[i]!);
    }
  }
}

export interface LiveRequest {
  session: string;
  after: number;
  ops: LiveOp[];
  caret: string | null | undefined;
}

const SESSION_KEY = /^[A-Za-z0-9_-]{16,64}$/;

export const parseSessionKey = (raw: unknown, issues: Issues, pointer = '/session'): string => {
  if (typeof raw !== 'string' || !SESSION_KEY.test(raw)) {
    issues.add(pointer, 'invalid_session', 'Start a live session first.');
    return '';
  }
  return raw;
};

const parseCaret = (raw: unknown, issues: Issues): string | null | undefined => {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > BLOCK_ID_MAX) {
    issues.add('/caret', 'invalid_block', 'Send a block identifier or null.');
    return undefined;
  }
  return raw;
};

const blockOf = (raw: unknown, pointer: string, limits: ContentLimits, issues: Issues): Block | null => {
  const parsed = parseContent({ v: 2, blocks: [raw] }, limits, issues, pointer);
  return parsed.content.blocks[0] ?? null;
};

/** Validates a batch of operations (bounded) without echoing input. */
export function parseLiveRequest(
  body: unknown,
  limits: ContentLimits,
  batchMax: number,
): LiveRequest {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send the operations.');
  for (const k of Object.keys(b))
    if (!['session', 'after', 'ops', 'caret'].includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  const session = parseSessionKey(b.session, issues);
  const after = parseSeq(b.after, '/after', issues);
  const ops: LiveOp[] = [];
  if (!Array.isArray(b.ops)) issues.add('/ops', 'invalid_type', 'Send a list of operations.');
  else if (b.ops.length < 1 || b.ops.length > batchMax)
    issues.add('/ops', 'too_many', `Send between 1 and ${batchMax} operations.`);
  else {
    const seen = new Set<string>();
    b.ops.forEach((raw, i) => {
      const op = parseOp(raw, `/ops/${i}`, limits, issues);
      if (!op) return;
      if (seen.has(op.opId)) issues.add(`/ops/${i}/op_id`, 'duplicate', 'Each operation needs its own identifier.');
      seen.add(op.opId);
      ops.push(op);
    });
  }
  const caret = parseCaret(b.caret, issues);
  issues.throwIfAny();
  return { session, after: after!, ops, caret };
}

export const parseSeq = (raw: unknown, pointer: string, issues: Issues): number | undefined => {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return raw;
  issues.add(pointer, 'invalid_number', 'Send the last sequence number you received.');
  return undefined;
};

function parseOp(raw: unknown, at: string, limits: ContentLimits, issues: Issues): LiveOp | null {
  if (!isObject(raw)) {
    issues.add(at, 'invalid_type', 'Send an operation object.');
    return null;
  }
  const allowed = ['op_id', 'kind', 'block', 'block_id', 'base_hash', 'after'];
  for (const k of Object.keys(raw))
    if (!allowed.includes(k)) issues.add(`${at}/${k}`, 'unsupported_field', 'This field is not supported.');
  const opId = typeof raw.op_id === 'string' && OP_ID.test(raw.op_id) ? raw.op_id : null;
  if (!opId) issues.add(`${at}/op_id`, 'invalid_option', 'Send a short identifier for this operation.');
  const kind = OP_KINDS.find((k) => k === raw.kind);
  if (!kind) {
    issues.add(`${at}/kind`, 'invalid_option', 'Use insert, replace, delete, or move.');
    return null;
  }
  const idOf = (key: 'block_id' | 'after', nullable: boolean): string | null | undefined => {
    const v = raw[key];
    if (v === null && nullable) return null;
    if (typeof v === 'string' && v.length >= 1 && v.length <= BLOCK_ID_MAX) return v;
    issues.add(`${at}/${key}`, nullable ? 'invalid_block' : 'required', 'Send a block identifier.');
    return undefined;
  };
  const hashOf = (): string | undefined => {
    if (typeof raw.base_hash === 'string' && HASH.test(raw.base_hash)) return raw.base_hash;
    issues.add(`${at}/base_hash`, 'invalid_hash', 'Send the hash of the block you changed.');
    return undefined;
  };
  if (!opId) return null;
  switch (kind) {
    case 'insert': {
      const after = idOf('after', true);
      const block = blockOf(raw.block, `${at}/block`, limits, issues);
      return block && after !== undefined ? { kind, opId, block, after } : null;
    }
    case 'replace': {
      const baseHash = hashOf();
      const block = blockOf(raw.block, `${at}/block`, limits, issues);
      if (!block || !baseHash) return null;
      return { kind, opId, blockId: block.id, baseHash, block };
    }
    case 'delete': {
      const blockId = idOf('block_id', false);
      const baseHash = hashOf();
      return blockId && baseHash ? { kind, opId, blockId, baseHash } : null;
    }
    case 'move': {
      const blockId = idOf('block_id', false);
      const after = idOf('after', true);
      return blockId && after !== undefined ? { kind, opId, blockId, after } : null;
    }
  }
}

/** The block an operation names (for the log and for events). */
export const opBlockId = (op: LiveOp): string => (op.kind === 'insert' ? op.block.id : op.kind === 'replace' ? op.block.id : op.blockId);
