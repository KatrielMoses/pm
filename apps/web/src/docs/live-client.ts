import { api } from '../api.ts';
import type { Block, DocContent, References } from './client.ts';

/**
 * Typed client for the 4D live editing API (ADR-0027). Every call is same-origin with the session
 * cookie and the CSRF header (see api.ts). There is no Idempotency-Key: operations carry their own
 * `op_id`, so a retried batch returns the original result.
 */

export type LiveMode = 'edit' | 'view';

export interface PresenceEntry {
  peer: string;
  you: boolean;
  name: string | null;
  mode: LiveMode;
  /** 0 to 7: an index into the eight accessible colour tokens. */
  color: number;
  caret_block: string | null;
}

export interface LiveSnapshot {
  seq: number;
  base_version: number;
  dirty: boolean;
  content: DocContent;
  /** The server's hash of each block; the client never computes hashes, it echoes these. */
  hashes: Record<string, string>;
  references: References;
}

export interface LiveSession extends LiveSnapshot {
  session: string;
  peer: string;
  mode: LiveMode;
  expires_at: string;
  ttl_seconds: number;
  poll_wait_seconds: number;
  ops_batch_max: number;
  presence: PresenceEntry[];
  presence_tag: string;
  document: { id: string; title: string; content_version: number };
}

export type LiveOp =
  | { op_id: string; kind: 'insert'; after: string | null; block: Block }
  | { op_id: string; kind: 'replace'; base_hash: string; block: Block }
  | { op_id: string; kind: 'delete'; block_id: string; base_hash: string }
  | { op_id: string; kind: 'move'; block_id: string; after: string | null };

export type RejectCode = 'block_changed' | 'block_missing' | 'block_exists' | 'anchor_missing';

export interface LiveEvent {
  seq: number;
  op_id: string;
  peer: string | null;
  kind: 'insert' | 'replace' | 'delete' | 'move';
  block_id: string;
  block: Block | null;
  block_hash: string | null;
  after: string | null;
}

export interface LiveUpdate {
  seq: number;
  base_version?: number;
  dirty?: boolean;
  applied?: Array<{ op_id: string; seq: number; block_hash: string | null }>;
  rejected?: Array<{
    op_id: string;
    code: RejectCode;
    current: Block | null;
    current_hash: string | null;
  }>;
  events: LiveEvent[];
  references?: References;
  presence: PresenceEntry[];
  presence_tag: string;
  resync?: LiveSnapshot;
}

export interface LiveCheckpoint {
  saved: boolean;
  content_version: number;
  seq: number;
  dirty: boolean;
}

const base = (ws: string, doc: string) => `/v1/workspaces/${ws}/documents/${doc}/live`;

export const liveApi = {
  async join(ws: string, doc: string, mode?: LiveMode): Promise<LiveSession> {
    return (
      await api<{ data: LiveSession }>('POST', `${base(ws, doc)}/session`, {
        body: mode ? { mode } : {},
      })
    ).body.data;
  },
  async operations(
    ws: string,
    doc: string,
    body: { session: string; after: number; ops: LiveOp[] },
  ): Promise<LiveUpdate> {
    return (await api<{ data: LiveUpdate }>('POST', `${base(ws, doc)}/operations`, { body })).body
      .data;
  },
  async events(
    ws: string,
    doc: string,
    q: { session: string; after: number; wait: number; presenceTag: string },
    signal?: AbortSignal,
  ): Promise<LiveUpdate> {
    const qs =
      `session=${encodeURIComponent(q.session)}&after=${q.after}&wait=${q.wait}` +
      `&presence_tag=${encodeURIComponent(q.presenceTag)}`;
    return (
      await api<{ data: LiveUpdate }>('GET', `${base(ws, doc)}/events?${qs}`, {
        ...(signal ? { signal } : {}),
      })
    ).body.data;
  },
  async heartbeat(
    ws: string,
    doc: string,
    body: { session: string; caret?: string | null },
  ): Promise<{ expires_at: string; presence: PresenceEntry[]; presence_tag: string }> {
    return (await api<{ data: never }>('POST', `${base(ws, doc)}/heartbeat`, { body })).body.data;
  },
  async checkpoint(ws: string, doc: string, session: string): Promise<LiveCheckpoint> {
    return (
      await api<{ data: LiveCheckpoint }>('POST', `${base(ws, doc)}/checkpoint`, {
        body: { session },
      })
    ).body.data;
  },
  async leave(
    ws: string,
    doc: string,
    session: string,
    keepalive = false,
  ): Promise<{ left: boolean; saved: boolean }> {
    return (
      await api<{ data: { left: boolean; saved: boolean } }>('POST', `${base(ws, doc)}/leave`, {
        body: { session },
        ...(keepalive ? { keepalive: true } : {}),
      })
    ).body.data;
  },
};
