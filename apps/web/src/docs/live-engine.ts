import { ApiError, type ApiIssue } from '../api.ts';
import type { Block, References } from './client.ts';
import {
  applyEventToMirror,
  applyRemoteEvent,
  mirrorFromSnapshot,
  reconcileSnapshot,
  resolveConflict,
  setMirrorBlock,
  type LiveConflict,
} from './live-apply.ts';
import {
  liveApi,
  type LiveEvent,
  type LiveMode,
  type LiveSession,
  type LiveSnapshot,
  type LiveUpdate,
  type PresenceEntry,
} from './live-client.ts';
import {
  blockKey,
  diffToOps,
  editKey,
  ensureIds,
  newBlockId,
  randomId,
  type DiffOps,
  type MirrorBlock,
} from './live-diff.ts';
import type { EditBlock } from './model.ts';

/**
 * The live editing client (ADR-0027). One engine per open document. It joins a session, keeps a
 * mirror of the server's blocks, sends the local list's differences as block operations (one batch
 * in flight), applies other people's operations without touching a block that has unsent changes,
 * long-polls for events, keeps presence, and survives a dropped connection, an expired session,
 * and a hidden tab. It never decides anything the server decides: access, order, and hashes all
 * come from the server on every answer. The React side only renders `getState()`.
 *
 * States: `off` -> `joining` -> `live` <-> `reconnecting` / `offline`; ends in `fallback` (the
 * plain 4C editor takes over, with a reason) or `locked` (access gone: keep the text, stop).
 */

export type LivePhase =
  | 'off'
  | 'joining'
  | 'live'
  | 'reconnecting'
  | 'offline'
  | 'fallback'
  | 'locked';
export type LockKind = 'archived' | 'permission' | 'gone';

export interface LiveState {
  phase: LivePhase;
  /** Why the plain editor is in use (fallback only). */
  reason: string | null;
  locked: LockKind | null;
  mode: LiveMode | null;
  /** A session exists and the live editor is in charge (Save means checkpoint). */
  active: boolean;
  paused: boolean;
  blocks: EditBlock[];
  /** Read-only live view: the server's blocks. */
  viewBlocks: Block[];
  references: References;
  conflicts: LiveConflict[];
  presence: PresenceEntry[];
  /** Local changes the server has not accepted yet (or choices still to make). */
  unsent: boolean;
  /** The shared draft has changes that are not in a saved version yet. */
  serverDirty: boolean;
  savedAt: number | null;
  contentVersion: number | null;
  /** Server messages about blocks it refused as invalid, by block id. */
  issues: Map<string, ApiIssue[]>;
  /** A short sentence for a polite announcement, with a counter so repeats are heard. */
  notice: { text: string; n: number } | null;
  /** Who is in which block (names the server sent), by block id. */
  here: Map<string, string[]>;
}

export interface LiveOptions {
  ws: string;
  doc: string;
  mode: LiveMode;
  getBlocks: () => EditBlock[];
  /** Another person's change was applied to the local list. */
  onBlocks: (blocks: EditBlock[]) => void;
  /** Fingerprints of the blocks as the local list last matched the server (null: unknown). */
  loadBase?: () => Promise<Map<string, string> | null> | Map<string, string> | null;
  savedAt?: number | null;
  contentVersion?: number | null;
  initialView?: Block[];
  initialRefs?: References;
  /** Test hooks. */
  debounceMs?: number;
}

const FLUSH_DEBOUNCE = 400;
const HIDDEN_PAUSE_MS = 60_000;
const CARET_DEBOUNCE = 500;
const FAILURES_BEFORE_FALLBACK = 6;
const RETRY_JOIN_MS = 60_000;
const EVENT_PAGE = 500;
const CONFLICT_BASE = '!conflict';

export const REASONS: Record<string, string> = {
  live_disabled: 'live editing is turned off here',
  live_capacity: 'too many people are editing live right now',
  document_archived: 'this document is archived',
  workspace_read_only: 'this workspace is read-only',
  session_read_only: 'your session can only watch',
  failing: 'the live connection keeps failing',
  unavailable: "live editing couldn't connect",
  rate_limited: "you're doing that too quickly",
  invalid_reference: 'a link in this document changed, so reload to continue live',
  default: "live editing isn't available right now",
};

type Triage =
  | { act: 'retry'; delay?: number }
  | { act: 'rejoin' }
  | { act: 'invalid' }
  | { act: 'ended' };

const issueCode = (e: ApiError) => e.issues[0]?.code;

export class LiveEngine {
  private readonly o: LiveOptions;
  private listeners = new Set<() => void>();
  private state: LiveState;

  private gen = 0;
  private loop = 0;
  private disposed = false;
  private session: LiveSession | null = null;
  private phase: LivePhase = 'off';
  private reason: string | null = null;
  private locked: LockKind | null = null;
  private paused = false;
  private blocks: EditBlock[] = [];
  private mirror: MirrorBlock[] = [];
  private refs: References = {};
  private conflicts: LiveConflict[] = [];
  private invalid = new Map<string, { key: string; issues: ApiIssue[] }>();
  private presence: PresenceEntry[] = [];
  private presenceTag = '';
  private lastSeq = 0;
  private serverDirty = false;
  private savedAt: number | null;
  private contentVersion: number | null;
  private notice: LiveState['notice'] = null;
  private noticeAt = 0;
  private own = new Map<string, { kind: string; blockId: string; block: Block | null }>();
  private actors = new Map<string, string | null>();
  private inflight: DiffOps | null = null;
  private opCounter = 0;
  private failures = 0;
  private anchorMisses = 0;
  private caret: string | null = null;
  private sentCaret: string | null = null;

  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private hbTimer: ReturnType<typeof setTimeout> | null = null;
  private caretTimer: ReturnType<typeof setTimeout> | null = null;
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private pollAbort: AbortController | null = null;
  private wakers = new Set<() => void>();
  private flushP: Promise<void> | null = null;
  private flushAgain = false;
  private rejoining: Promise<void> | null = null;
  private left = false;
  private attached = false;

  constructor(options: LiveOptions) {
    this.o = options;
    this.savedAt = options.savedAt ?? null;
    this.contentVersion = options.contentVersion ?? null;
    this.refs = options.initialRefs ?? {};
    this.state = this.build();
  }

  // ---- State for the screen ------------------------------------------------------------------

  getState = (): LiveState => this.state;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private pendingDiff(max = Number.POSITIVE_INFINITY, real = false): DiffOps {
    const frozen = new Set<string>([...this.conflicts.map((c) => c.id), ...this.invalid.keys()]);
    return diffToOps(
      this.blocks,
      this.mirror,
      frozen,
      Math.min(max, this.session?.ops_batch_max ?? 100),
      real ? () => this.nextOpId() : () => 'dry',
    );
  }

  private build(): LiveState {
    const edit = this.o.mode === 'edit';
    const here = new Map<string, string[]>();
    for (const p of this.presence)
      if (!p.you && p.name && p.caret_block) here.set(p.caret_block, [...(here.get(p.caret_block) ?? []), p.name]);
    const active =
      !!this.session && (this.phase === 'live' || this.phase === 'reconnecting' || this.phase === 'offline');
    const unsent =
      edit &&
      active &&
      (this.inflight !== null ||
        this.conflicts.length > 0 ||
        this.invalid.size > 0 ||
        this.pendingDiffSize() > 0);
    return {
      phase: this.phase,
      reason: this.reason,
      locked: this.locked,
      mode: this.session?.mode ?? null,
      active,
      paused: this.paused,
      blocks: this.blocks,
      viewBlocks: edit ? [] : this.attached ? this.mirror.map((m) => m.block) : (this.o.initialView ?? []),
      references: this.refs,
      conflicts: this.conflicts,
      presence: this.presence,
      unsent,
      serverDirty: this.serverDirty,
      savedAt: this.savedAt,
      contentVersion: this.contentVersion,
      issues: new Map([...this.invalid].map(([k, v]) => [k, v.issues])),
      notice: this.notice,
      here,
    };
  }

  private pendingDiffSize(): number {
    return this.session ? this.pendingDiff().ops.length : 0;
  }

  private emit(): void {
    this.state = this.build();
    for (const l of [...this.listeners]) l();
  }

  private setPhase(p: LivePhase): void {
    if (this.phase === p) return;
    this.phase = p;
    this.emit();
  }

  private say(text: string, always = false): void {
    const now = Date.now();
    if (!always && now - this.noticeAt < 2000) return;
    this.noticeAt = now;
    this.notice = { text, n: (this.notice?.n ?? 0) + 1 };
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.notice = null;
      this.emit();
    }, 10_000);
  }

  private nameOf(peer: string | null): string | null {
    if (!peer) return null;
    return this.presence.find((p) => p.peer === peer)?.name ?? null;
  }

  private nextOpId(): string {
    this.opCounter += 1;
    return `o${this.opCounter.toString(36)}_${randomId('', 8)}`;
  }

  // ---- Timers and waiting --------------------------------------------------------------------

  /** Sleeps; ends early when `wake()` is called (back online, tab visible) or the session ends. */
  private sleep(ms: number, gen: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.wakers.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.wakers.add(done);
      if (gen !== this.gen) done();
    });
  }
  private wake(): void {
    for (const w of [...this.wakers]) w();
  }
  private backoff(n: number): number {
    return Math.min(15_000, 1000 * 2 ** n) * (0.75 + Math.random() * 0.5);
  }

  // ---- Starting, joining, leaving ------------------------------------------------------------

  /** Joins a session. Safe to call again after a fallback. */
  async start(): Promise<void> {
    if (this.disposed) return;
    if (this.session && (this.phase === 'live' || this.phase === 'reconnecting')) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const gen = ++this.gen;
    this.reason = null;
    if (!navigator.onLine) {
      this.setPhase('offline');
      this.emit();
      return;
    }
    this.setPhase('joining');
    let s: LiveSession;
    try {
      s = await liveApi.join(this.o.ws, this.o.doc, this.o.mode);
    } catch (err) {
      if (gen !== this.gen) return;
      this.joinFailed(err);
      return;
    }
    if (gen !== this.gen) {
      void liveApi.leave(this.o.ws, this.o.doc, s.session, true).catch(() => undefined);
      return;
    }
    let base: Map<string, string> | null;
    try {
      base = (await this.o.loadBase?.()) ?? null;
    } catch {
      base = null;
    }
    if (gen !== this.gen) {
      void liveApi.leave(this.o.ws, this.o.doc, s.session, true).catch(() => undefined);
      return;
    }
    this.left = false;
    this.attach(s, base, gen);
  }

  private joinFailed(err: unknown): void {
    if (!(err instanceof ApiError)) return this.fallback(REASONS.default!, true);
    if (err.code === 'not_found') return this.lock('gone');
    if (err.code === 'forbidden') return this.lock('permission');
    const code = issueCode(err);
    if (err.code === 'conflict' && code && REASONS[code]) {
      this.fallback(REASONS[code]!, code === 'live_capacity');
      return;
    }
    if (err.code === 'workspace_read_only') return this.fallback(REASONS.workspace_read_only!, false);
    if (err.code === 'rate_limited') return this.fallback(REASONS.rate_limited!, true, (err.retryAfterSeconds ?? 5) * 1000);
    if (err.code === 'offline' || (err.code === 'network' && !navigator.onLine)) {
      this.setPhase('offline');
      return;
    }
    this.fallback(err.code === 'network' || err.status >= 500 ? REASONS.unavailable! : REASONS.default!, true);
  }

  /** The plain editor takes over. What was typed stays; a retry is offered (and tried quietly when it may help). */
  private fallback(reason: string, retry: boolean, retryIn = RETRY_JOIN_MS): void {
    this.endSession(true);
    this.reason = reason;
    this.phase = 'fallback';
    this.emit();
    if (retry && !this.disposed) {
      this.retryTimer = setTimeout(() => void this.start(), Math.max(1000, retryIn));
    }
  }

  private lock(kind: LockKind): void {
    this.endSession(kind !== 'gone');
    this.locked = kind;
    this.phase = 'locked';
    this.emit();
  }

  /** Stops every loop and timer. Optionally tells the server the session is over (best effort). */
  private endSession(leave: boolean): void {
    this.gen++;
    this.loop++;
    this.pollAbort?.abort();
    for (const t of [this.flushTimer, this.hbTimer, this.caretTimer, this.hiddenTimer]) if (t) clearTimeout(t);
    this.flushTimer = this.hbTimer = this.caretTimer = this.hiddenTimer = null;
    this.wake();
    if (leave) this.sendLeave();
    this.session = null;
    this.inflight = null;
    this.paused = false;
  }

  private sendLeave(): void {
    const s = this.session;
    if (!s || this.left) return;
    this.left = true;
    void liveApi.leave(this.o.ws, this.o.doc, s.session, true).catch(() => undefined);
  }

  /** Leaves the session (unmount, navigation, page hide). Unsent text stays in the browser draft. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.endSession(true);
    this.listeners.clear();
  }

  /** The page is being hidden for good (or put in the back-forward cache): leave now. */
  pageHide(): void {
    if (this.disposed || !this.session) return;
    this.sendLeave();
    this.loop++;
    this.pollAbort?.abort();
    for (const t of [this.hbTimer, this.flushTimer]) if (t) clearTimeout(t);
    this.hbTimer = this.flushTimer = null;
  }

  /** The page came back from the back-forward cache. */
  pageShow(): void {
    if (this.disposed || this.phase === 'locked') return;
    if (this.left) {
      this.session = null;
      this.phase = 'off';
      void this.start();
    }
  }

  private attach(s: LiveSession, base: Map<string, string> | null, gen: number): void {
    this.session = s;
    this.refs = { ...this.refs, ...s.references };
    const snap = mirrorFromSnapshot(s);
    if (this.o.mode === 'edit' && s.mode === 'edit') {
      const local = ensureIds(this.o.getBlocks());
      const r = reconcileSnapshot(local, this.conflicts, base, snap, this.refs);
      this.setBlocks(r.local, true);
      this.conflicts = r.conflicts;
      if (r.flagged.length)
        this.say('Some blocks were changed by others while you were away. They are marked to review.', true);
    }
    this.mirror = snap;
    this.attached = true;
    this.lastSeq = s.seq;
    this.serverDirty = s.dirty;
    this.presence = s.presence;
    this.presenceTag = s.presence_tag;
    this.contentVersion = s.document.content_version;
    this.own.clear();
    this.inflight = null;
    this.failures = 0;
    this.anchorMisses = 0;
    this.sentCaret = null;
    this.reason = null;
    this.phase = 'live';
    this.emit();
    this.startLoops(gen);
    this.scheduleFlush(0);
  }

  private startLoops(gen: number): void {
    const loop = ++this.loop;
    this.armHeartbeat(gen);
    void this.pollLoop(gen, loop);
  }

  // ---- Local changes --------------------------------------------------------------------------

  /** The person changed the blocks. Returns them with identifiers (new blocks get one here). */
  local(next: EditBlock[]): EditBlock[] {
    const withIds = ensureIds(next);
    this.blocks = withIds;
    for (const [id, bad] of this.invalid) {
      const b = withIds.find((x) => x.id === id);
      if (!b || editKey(b) !== bad.key) this.invalid.delete(id);
    }
    this.emit();
    this.scheduleFlush();
    return withIds;
  }

  private setBlocks(next: EditBlock[], notify: boolean): void {
    this.blocks = next;
    if (notify) this.o.onBlocks(next);
  }

  private scheduleFlush(ms = this.o.debounceMs ?? FLUSH_DEBOUNCE): void {
    if (this.o.mode !== 'edit' || !this.session) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, ms);
  }

  /** Sends what is pending now (a block lost focus, Save, leaving). */
  flushNow(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    return this.flush();
  }

  private flush(): Promise<void> {
    if (this.flushP) {
      this.flushAgain = true;
      return this.flushP;
    }
    const gen = this.gen;
    this.flushP = (async () => {
      try {
        do {
          this.flushAgain = false;
          for (let n = 0; n < 50 && (await this.sendBatch(gen)); n++) {
            /* send the next batch */
          }
        } while (this.flushAgain && gen === this.gen);
      } finally {
        this.flushP = null;
      }
    })();
    return this.flushP;
  }

  /** One batch. True when it was accepted and there may be more to send. */
  private async sendBatch(gen: number): Promise<boolean> {
    if (gen !== this.gen || !this.session || this.session.mode !== 'edit' || this.o.mode !== 'edit') return false;
    if (this.phase !== 'live' && this.phase !== 'reconnecting' && this.phase !== 'offline') return false;
    const diff = this.pendingDiff(Number.POSITIVE_INFINITY, true);
    if (!diff.ops.length) return false;
    for (const [id, m] of diff.meta) this.own.set(id, m);
    this.inflight = diff;
    this.emit();
    let n = 0;
    for (;;) {
      if (gen !== this.gen || !this.session) return false;
      if (!navigator.onLine) {
        this.setPhase('offline');
        await this.sleep(30_000, gen);
        continue;
      }
      try {
        const res = await liveApi.operations(this.o.ws, this.o.doc, {
          session: this.session.session,
          after: this.lastSeq,
          ops: diff.ops,
        });
        if (gen !== this.gen) return false;
        this.inflight = null;
        this.connected();
        this.handleUpdate(res, diff);
        if (this.lastSeq < res.seq) void this.catchUp(gen);
        return true;
      } catch (err) {
        if (gen !== this.gen) return false;
        const t = this.triage(err);
        if (t.act === 'retry') {
          this.setPhase(navigator.onLine ? 'reconnecting' : 'offline');
          await this.sleep(t.delay ?? this.backoff(n++), gen);
          continue;
        }
        this.inflight = null;
        for (const id of diff.meta.keys()) this.own.delete(id);
        if (t.act === 'rejoin') await this.rejoin();
        else if (t.act === 'invalid') this.markInvalid(err as ApiError, diff);
        else this.emit();
        return t.act === 'rejoin';
      }
    }
  }

  private markInvalid(err: ApiError, diff: DiffOps): void {
    const byBlock = new Map<string, ApiIssue[]>();
    const metas = diff.ops.map((op) => diff.meta.get(op.op_id)!);
    for (const issue of err.issues) {
      const m = /^\/ops\/(\d+)(?:\/block)?(\/.*)?$/.exec(issue.pointer ?? '');
      const target = m ? metas[Number(m[1])] : undefined;
      for (const t of target ? [target] : metas)
        byBlock.set(t.blockId, [
          ...(byBlock.get(t.blockId) ?? []),
          { ...issue, pointer: `${issue.pointer ?? ''}` },
        ]);
    }
    if (!byBlock.size) for (const t of metas) byBlock.set(t.blockId, []);
    for (const [id, issues] of byBlock) {
      const b = this.blocks.find((x) => x.id === id);
      this.invalid.set(id, { key: b ? editKey(b) : '', issues });
    }
    this.emit();
  }

  private connected(): void {
    this.failures = 0;
    if (this.phase === 'reconnecting' || this.phase === 'offline') this.phase = 'live';
  }

  // ---- Applying answers ---------------------------------------------------------------------

  private handleUpdate(res: LiveUpdate, diff?: DiffOps): void {
    if (res.references) this.refs = { ...this.refs, ...res.references };
    if (res.resync) this.applyResync(res.resync);
    else this.applyEvents(res.events ?? []);
    if (res.dirty !== undefined) this.serverDirty = res.dirty;
    this.setPresence(res.presence, res.presence_tag);
    if (diff && !res.resync) this.handleRejections(res, diff);
    if (res.events?.length === EVENT_PAGE && this.lastSeq < res.seq) this.wake();
    this.pruneOwn();
    this.emit();
  }

  private setPresence(list: PresenceEntry[] | undefined, tag: string | undefined): void {
    if (!list) return;
    const before = this.presence.filter((p) => !p.you && p.name).length;
    this.presence = list;
    if (tag !== undefined) this.presenceTag = tag;
    const after = list.filter((p) => !p.you && p.name).length;
    if (before !== after) this.say(after > before ? 'Someone joined this document.' : 'Someone left this document.');
  }

  private pruneOwn(): void {
    while (this.own.size > 500) this.own.delete(this.own.keys().next().value!);
  }

  private applyEvents(events: LiveEvent[]): void {
    if (!events.length) return;
    let mirror = this.mirror;
    let local = this.blocks;
    let conflicts = this.conflicts;
    let touched = 0;
    const flagged: Array<{ id: string; by: string | null }> = [];
    for (const ev of [...events].sort((a, b) => a.seq - b.seq)) {
      if (ev.seq <= this.lastSeq) continue;
      const own = this.own.get(ev.op_id);
      const prev = mirror;
      mirror = applyEventToMirror(mirror, ev, own?.block ?? null);
      if (!own) {
        const by = this.nameOf(ev.peer);
        this.actors.set(ev.block_id, by);
        if (this.o.mode === 'edit') {
          const r = applyRemoteEvent(local, conflicts, prev, mirror, ev, this.refs, by);
          local = r.local;
          conflicts = r.conflicts;
          touched += r.touched;
          for (const id of r.flagged) flagged.push({ id, by });
        } else touched += 1;
      }
      this.lastSeq = ev.seq;
    }
    this.mirror = mirror;
    this.conflicts = conflicts;
    if (this.o.mode === 'edit' && local !== this.blocks) this.setBlocks(local, true);
    if (flagged.length) {
      const n = local.findIndex((b) => b.id === flagged[0]!.id) + 1;
      const who = flagged[0]!.by ?? 'Another editor';
      this.say(
        `${who} changed ${flagged.length === 1 ? (n > 0 ? `block ${n}` : 'a block') : `${flagged.length} blocks`} you are editing. Review ${flagged.length === 1 ? 'it' : 'them'}: keep yours or take theirs.`,
        true,
      );
    } else if (touched) this.say(`${touched} ${touched === 1 ? 'block was' : 'blocks were'} updated by others.`);
  }

  private applyResync(snap: LiveSnapshot): void {
    if (snap.seq < this.lastSeq) return;
    this.refs = { ...this.refs, ...snap.references };
    const next = mirrorFromSnapshot(snap);
    if (this.o.mode === 'edit') {
      const base = new Map(this.mirror.map((m) => [m.id, m.key] as const));
      const r = reconcileSnapshot(this.blocks, this.conflicts, base, next, this.refs);
      this.conflicts = r.conflicts;
      this.setBlocks(r.local, true);
      this.say(
        r.flagged.length
          ? 'The document was reloaded. Some of your blocks differ from the latest and are marked to review.'
          : 'The document was reloaded with the latest changes.',
        true,
      );
    }
    this.mirror = next;
    this.lastSeq = snap.seq;
    this.serverDirty = snap.dirty;
    this.contentVersion = snap.base_version;
  }

  private handleRejections(res: LiveUpdate, diff: DiffOps): void {
    let conflicts = this.conflicts;
    let blocks = this.blocks;
    const add = (c: LiveConflict) => {
      conflicts = [...conflicts.filter((x) => x.id !== c.id), c];
      this.say(
        `${c.by ?? 'Another editor'} changed a block you were editing. Review it: keep yours or take theirs.`,
        true,
      );
    };
    for (const r of res.rejected ?? []) {
      const m = diff.meta.get(r.op_id);
      if (!m) continue;
      this.own.delete(r.op_id);
      const id = m.blockId;
      const mine = blocks.find((b) => b.id === id) ?? null;
      const by = this.actors.get(id) ?? null;
      switch (r.code) {
        case 'block_changed':
          this.mirror = setMirrorBlock(this.mirror, id, r.current, r.current_hash);
          if (m.kind === 'delete') add({ id, kind: 'deleted_by_me', by, theirs: r.current, mine: null });
          else if (mine && r.current && editKey(mine) !== blockKey(r.current))
            add({ id, kind: 'changed', by, theirs: r.current, mine });
          break;
        case 'block_missing':
          this.mirror = setMirrorBlock(this.mirror, id, null, null);
          if (m.kind !== 'delete' && mine) add({ id, kind: 'deleted_by_them', by, theirs: null, mine });
          break;
        case 'block_exists':
          if (r.current) this.mirror = setMirrorBlock(this.mirror, id, r.current, r.current_hash);
          if (mine && r.current && editKey(mine) !== blockKey(r.current)) {
            blocks = blocks.map((b) => (b.id === id ? ({ ...b, id: newBlockId() } as EditBlock) : b));
          }
          break;
        case 'anchor_missing':
          this.anchorMisses += 1;
          break;
      }
    }
    this.conflicts = conflicts;
    if (blocks !== this.blocks) this.setBlocks(blocks, true);
    if (this.anchorMisses >= 5) this.fallback("a block couldn't be placed", true);
  }

  /** Fetches events until the mirror has reached the sequence the server reported. */
  private async catchUp(gen: number): Promise<void> {
    for (let n = 0; n < 20 && gen === this.gen && this.session; n++) {
      try {
        const u = await liveApi.events(this.o.ws, this.o.doc, {
          session: this.session.session,
          after: this.lastSeq,
          wait: 0,
          presenceTag: this.presenceTag,
        });
        if (gen !== this.gen) return;
        const before = this.lastSeq;
        this.handleUpdate(u);
        if (this.lastSeq >= u.seq || this.lastSeq === before) return;
      } catch {
        return; // the poll loop reports and recovers
      }
    }
  }

  // ---- The long poll --------------------------------------------------------------------------

  private async pollLoop(gen: number, loop: number): Promise<void> {
    const alive = () => gen === this.gen && loop === this.loop && !this.disposed && !!this.session;
    let attempt = 0;
    while (alive()) {
      if (this.paused) return;
      if (!navigator.onLine) {
        this.setPhase('offline');
        await this.sleep(30_000, gen);
        continue;
      }
      const ac = new AbortController();
      this.pollAbort = ac;
      const started = Date.now();
      try {
        const u = await liveApi.events(
          this.o.ws,
          this.o.doc,
          {
            session: this.session!.session,
            after: this.lastSeq,
            // The first call after trouble is a quick probe, so "Reconnecting…" ends as soon as the
            // server answers rather than when the long poll finally times out.
            wait: this.phase === 'live' ? Math.max(1, this.session!.poll_wait_seconds) : 0,
            presenceTag: this.presenceTag,
          },
          ac.signal,
        );
        if (!alive()) return;
        attempt = 0;
        this.connected();
        this.handleUpdate(u);
        if (!u.events.length && !u.resync && Date.now() - started < 300) await this.sleep(500, gen);
      } catch (err) {
        if (!alive()) return;
        if (err instanceof ApiError && err.code === 'aborted') continue;
        const t = this.triage(err);
        if (t.act === 'rejoin') {
          await this.rejoin();
          return;
        }
        if (t.act !== 'retry') return;
        this.setPhase(navigator.onLine ? 'reconnecting' : 'offline');
        await this.sleep(t.delay ?? this.backoff(attempt++), gen);
      }
    }
  }

  // ---- Heartbeat and presence -----------------------------------------------------------------

  private armHeartbeat(gen: number): void {
    if (this.hbTimer) clearTimeout(this.hbTimer);
    const s = this.session;
    if (!s || this.paused) return;
    const every = Math.max(5000, (s.ttl_seconds * 1000) / 3);
    this.hbTimer = setTimeout(() => {
      void this.beat(gen).finally(() => {
        if (gen === this.gen) this.armHeartbeat(gen);
      });
    }, every);
  }

  private async beat(gen: number): Promise<void> {
    const s = this.session;
    if (!s || this.paused || !navigator.onLine || gen !== this.gen) return;
    try {
      const caret = this.o.mode === 'edit' ? this.caret : null;
      const r = await liveApi.heartbeat(this.o.ws, this.o.doc, { session: s.session, caret });
      if (gen !== this.gen) return;
      this.sentCaret = caret;
      this.setPresence(r.presence, r.presence_tag);
      this.emit();
    } catch (err) {
      if (gen !== this.gen) return;
      const t = this.triage(err, true);
      if (t.act === 'rejoin') void this.rejoin();
    }
  }

  /** Which block the person is in (debounced; sent with the next heartbeat). */
  setCaret(blockId: string | null): void {
    if (blockId === this.caret) return;
    this.caret = blockId;
    if (!this.session || this.o.mode !== 'edit') return;
    if (this.caretTimer) clearTimeout(this.caretTimer);
    const gen = this.gen;
    this.caretTimer = setTimeout(() => {
      this.caretTimer = null;
      if (this.caret !== this.sentCaret) void this.beat(gen);
    }, CARET_DEBOUNCE);
  }

  // ---- Rejoining, pausing, going online/offline -----------------------------------------------

  private rejoin(): Promise<void> {
    if (this.rejoining) return this.rejoining;
    this.rejoining = this.doRejoin().finally(() => {
      this.rejoining = null;
    });
    return this.rejoining;
  }

  private async doRejoin(): Promise<void> {
    const gen = this.gen;
    this.loop++;
    this.pollAbort?.abort();
    if (this.hbTimer) clearTimeout(this.hbTimer);
    this.setPhase('reconnecting');
    for (let n = 0; ; n++) {
      if (gen !== this.gen || this.disposed) return;
      if (!navigator.onLine) {
        this.setPhase('offline');
        await this.sleep(30_000, gen);
        continue;
      }
      try {
        const s = await liveApi.join(this.o.ws, this.o.doc, this.o.mode);
        if (gen !== this.gen) {
          void liveApi.leave(this.o.ws, this.o.doc, s.session, true).catch(() => undefined);
          return;
        }
        const base = new Map(this.mirror.map((m) => [m.id, m.key] as const));
        this.left = false;
        this.attach(s, base, gen);
        return;
      } catch (err) {
        if (gen !== this.gen) return;
        const t = this.triage(err);
        if (t.act !== 'retry') {
          if (t.act === 'rejoin' && n < 3) continue;
          if (this.phase === 'reconnecting') this.fallback(REASONS.unavailable!, true);
          return;
        }
        await this.sleep(t.delay ?? this.backoff(n), gen);
      }
    }
  }

  /** Which way to go after a failed call; ends the session itself when access is gone. */
  private triage(err: unknown, quiet = false): Triage {
    if (!(err instanceof ApiError)) {
      this.failures += 1;
      return this.tooMany() ?? { act: 'retry' };
    }
    if (err.code === 'aborted') return { act: 'ended' };
    if (err.code === 'not_found') {
      this.lock('gone');
      return { act: 'ended' };
    }
    if (err.code === 'forbidden') {
      this.lock('permission');
      return { act: 'ended' };
    }
    const code = issueCode(err);
    if (err.code === 'conflict') {
      if (code === 'session_expired') return { act: 'rejoin' };
      if (code === 'document_archived') {
        this.lock('archived');
        return { act: 'ended' };
      }
      this.fallback(REASONS[code ?? ''] ?? REASONS.default!, code === 'live_capacity');
      return { act: 'ended' };
    }
    if (err.code === 'workspace_read_only') {
      this.fallback(REASONS.workspace_read_only!, false);
      return { act: 'ended' };
    }
    if (err.code === 'rate_limited')
      return { act: 'retry', delay: Math.max(1000, (err.retryAfterSeconds ?? 2) * 1000) };
    if (err.code === 'validation_failed') {
      if (code === 'invalid_reference' || err.issues.some((i) => i.code === 'invalid_reference')) {
        this.fallback(REASONS.invalid_reference!, false);
        return { act: 'ended' };
      }
      return quiet ? { act: 'ended' } : { act: 'invalid' };
    }
    if (err.code === 'offline' || err.code === 'network') {
      if (err.code === 'network' && navigator.onLine) this.failures += 1;
      return this.tooMany() ?? { act: 'retry' };
    }
    this.failures += 1;
    return this.tooMany() ?? { act: 'retry' };
  }

  private tooMany(): Triage | null {
    if (this.failures < FAILURES_BEFORE_FALLBACK) return null;
    this.fallback(REASONS.failing!, true);
    return { act: 'ended' };
  }

  /** Called by the page's online/offline/visibility events. */
  setOnline(online: boolean): void {
    if (this.disposed) return;
    if (!online) {
      if (this.session) this.setPhase('offline');
      return;
    }
    this.failures = 0;
    if (!this.session && (this.phase === 'offline' || this.phase === 'off')) {
      void this.start();
      return;
    }
    if (this.phase === 'offline') this.phase = 'reconnecting';
    this.emit();
    this.wake();
    this.scheduleFlush(0);
  }

  setVisible(visible: boolean): void {
    if (this.disposed || !this.session) return;
    if (!visible) {
      if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
      this.hiddenTimer = setTimeout(() => {
        this.hiddenTimer = null;
        this.paused = true;
        this.loop++;
        this.pollAbort?.abort();
        if (this.hbTimer) clearTimeout(this.hbTimer);
        this.emit();
      }, HIDDEN_PAUSE_MS);
      return;
    }
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    this.hiddenTimer = null;
    if (!this.paused) return;
    this.paused = false;
    this.failures = 0;
    this.emit();
    this.startLoops(this.gen);
    void this.beat(this.gen);
  }

  /** Try live editing again after a fallback (the person asked). */
  retry(): void {
    if (this.phase === 'fallback' || this.phase === 'off' || this.phase === 'offline') void this.start();
  }

  // ---- Choices --------------------------------------------------------------------------------

  resolve(id: string, side: 'mine' | 'theirs'): void {
    const c = this.conflicts.find((x) => x.id === id);
    if (!c) return;
    const next = resolveConflict(this.blocks, this.mirror, c, side, this.refs);
    this.conflicts = this.conflicts.filter((x) => x.id !== id);
    this.invalid.delete(id);
    this.setBlocks(next, true);
    this.emit();
    this.say(side === 'mine' ? 'Kept your version.' : 'Took their version.', true);
    this.scheduleFlush(0);
  }

  // ---- Saving a version -----------------------------------------------------------------------

  /** The explicit Save while live: send everything, then ask the server for a version. */
  async checkpoint(): Promise<
    { ok: true; saved: boolean; version: number } | { ok: false; reason: string }
  > {
    if (!this.session || this.session.mode !== 'edit' || !this.state.active)
      return { ok: false, reason: "Live editing isn't connected, so there is nothing to save to a version yet." };
    if (this.conflicts.length)
      return { ok: false, reason: 'Choose what to keep for the blocks marked "review" first, then save.' };
    if (this.invalid.size)
      return { ok: false, reason: 'Some blocks need attention before they can be saved. They are marked.' };
    for (let n = 0; n < 3; n++) {
      await this.flushNow();
      if (!this.inflight && this.pendingDiff().ops.length === 0) break;
    }
    if (this.inflight || this.pendingDiff().ops.length > 0 || this.conflicts.length)
      return {
        ok: false,
        reason: navigator.onLine
          ? "Your latest changes haven't reached the shared document yet. Try again in a moment."
          : "You're offline. Your changes are kept on this device and will be sent when you reconnect.",
      };
    for (let n = 0; n < 2; n++) {
      const gen = this.gen;
      const s = this.session;
      if (!s) break;
      try {
        const r = await liveApi.checkpoint(this.o.ws, this.o.doc, s.session);
        if (gen !== this.gen) break;
        this.contentVersion = r.content_version;
        this.serverDirty = r.dirty;
        if (r.saved || !r.dirty) this.savedAt = Date.now();
        this.emit();
        return { ok: true, saved: r.saved, version: r.content_version };
      } catch (err) {
        const t = this.triage(err);
        if (t.act === 'rejoin') {
          await this.rejoin();
          await this.flushNow();
          continue;
        }
        if (t.act === 'ended')
          return { ok: false, reason: 'Live editing ended, so the version was not saved. Your text is kept.' };
        return {
          ok: false,
          reason: navigator.onLine
            ? "Couldn't save a version. Your changes are in the shared document; try again in a moment."
            : "You're offline. Save a version when you reconnect.",
        };
      }
    }
    return { ok: false, reason: "Couldn't save a version. Try again." };
  }

  /** Fingerprints of the blocks the server holds (kept with a browser draft to reconcile later). */
  baseKeys(): Record<string, string> {
    const keys: Record<string, string> = Object.fromEntries(this.mirror.map((m) => [m.id, m.key]));
    // A block waiting for a choice was never in step with the server's newer block: a marker that
    // matches no content makes the next join offer the choice again instead of overwriting.
    for (const c of this.conflicts) keys[c.id] = CONFLICT_BASE;
    return keys;
  }
}
