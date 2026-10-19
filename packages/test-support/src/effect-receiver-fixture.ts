import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A deterministic local receiving fixture for external-effect recovery tests (ADR-0045). It never
 * calls anything external. Tests control it in process: hold a request before or after it is
 * applied, drop the connection after applying, reject without applying, and deduplicate by the
 * provider idempotency key (`Idempotency-Key`) or by the event id (`Webhook-Id`). It counts what
 * was received and what was actually applied, per effect key.
 */
export type DedupMode = 'none' | 'provider' | 'receiver';

export interface ReceiverBarrier {
  /** Resolves when a request for the key reaches the barrier. */
  readonly reached: Promise<void>;
  /** Lets the held request continue. */
  release(): void;
}

export interface EffectReceiverFixture {
  readonly url: string;
  /** Requests received for a key (or all keys). */
  received(key?: string): number;
  /** Times a key was applied (the external effect actually happened). */
  applied(key?: string): number;
  /** The `Idempotency-Key` / `Webhook-Id` values seen for a key, in order. */
  dedupKeys(key: string): string[];
  holdBeforeApply(key: string): ReceiverBarrier;
  holdAfterApply(key: string): ReceiverBarrier;
  /** Apply, then destroy the connection without a response (once). */
  dropAfterApply(key: string): void;
  /** Answer 409 without applying (once): the receiver refused it. */
  rejectOnce(key: string): void;
  close(): Promise<void>;
}

function barrier(): ReceiverBarrier & { arrive(): void; wait: Promise<void> } {
  let arrive!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => (arrive = r));
  const wait = new Promise<void>((r) => (release = r));
  return { reached, release, arrive, wait };
}

export async function startEffectReceiverFixture(): Promise<EffectReceiverFixture> {
  const received = new Map<string, number>();
  const applied = new Map<string, number>();
  const seenDedup = new Map<string, string[]>();
  const results = new Map<string, string>();
  const before = new Map<string, ReturnType<typeof barrier>>();
  const after = new Map<string, ReturnType<typeof barrier>>();
  const drop = new Set<string>();
  const reject = new Set<string>();
  const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url ?? '/', 'http://fixture');
    const mode = (url.searchParams.get('dedup') ?? 'none') as DedupMode;
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { key?: string };
    const key = String(body.key ?? '');
    inc(received, key);
    const header =
      mode === 'provider'
        ? req.headers['idempotency-key']
        : mode === 'receiver'
          ? req.headers['webhook-id']
          : undefined;
    const dedup = typeof header === 'string' ? header : undefined;
    if (dedup) seenDedup.set(key, [...(seenDedup.get(key) ?? []), dedup]);
    const b = before.get(key);
    if (b) {
      before.delete(key);
      b.arrive();
      await b.wait;
    }
    if (reject.delete(key)) {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ applied: false }));
      return;
    }
    // A deduplicating destination answers a repeat with the original result, applying nothing.
    const prior = dedup ? results.get(`${mode}:${dedup}`) : undefined;
    let ref = prior;
    if (!prior) {
      inc(applied, key);
      ref = `ref-${key}-${applied.get(key)}`;
      if (dedup) results.set(`${mode}:${dedup}`, ref);
    }
    const a = after.get(key);
    if (a) {
      after.delete(key);
      a.arrive();
      await a.wait;
    }
    if (drop.delete(key)) {
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ applied: !prior, ref }));
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  return {
    url: `http://127.0.0.1:${port}/effects`,
    received: (key) => (key === undefined ? sum(received) : (received.get(key) ?? 0)),
    applied: (key) => (key === undefined ? sum(applied) : (applied.get(key) ?? 0)),
    dedupKeys: (key) => [...(seenDedup.get(key) ?? [])],
    holdBeforeApply: (key) => {
      const b = barrier();
      before.set(key, b);
      return b;
    },
    holdAfterApply: (key) => {
      const b = barrier();
      after.set(key, b);
      return b;
    },
    dropAfterApply: (key) => void drop.add(key),
    rejectOnce: (key) => void reject.add(key),
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
