import { mkdirSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LifecycleConfig } from '@pm/config';
import { isUuidV7 } from '@pm/contracts';

/**
 * Purge ledger (0B §8.11): an append-only log held OUTSIDE the database backup set. After a
 * restore, entries newer than the backup point are re-applied before the environment reopens, so
 * purged data cannot reappear. Entries carry identifiers, record types, scopes, and times only —
 * never titles, values, or other customer content.
 *
 * Provider-neutral: the deployed adapter (write-once object storage or similar) is a later deployment decision.
 * `LocalFilePurgeLedger` is a development/test adapter and is refused in deployed modes by
 * configuration. With no ledger, purge refuses to start (`ledger_unavailable`).
 */

export interface PurgeLedgerEntry {
  /** Stable per batch: re-appending the same purge is idempotent. */
  entryId: string;
  workspaceId: string;
  batchId: string;
  rootRecordId: string;
  operationId: string;
  records: Array<{ id: string; recordType: string }>;
  trashedAt: string;
  purgedAt: string;
}

export interface LedgerAck {
  entryId: string;
  acknowledgedAt: Date;
}

export interface PurgeLedger {
  readonly kind: 'local' | 'none';
  readonly available: boolean;
  /** Durably appends (fsync) and acknowledges; idempotent by entryId. */
  append(entry: PurgeLedgerEntry): Promise<LedgerAck>;
  /** Entries purged strictly after `point`, oldest first, deduplicated by entryId. */
  entriesAfter(point: Date): Promise<Array<PurgeLedgerEntry & { acknowledgedAt: string }>>;
}

export class LedgerUnavailableError extends Error {
  constructor() {
    super('purge ledger unavailable');
    this.name = 'LedgerUnavailableError';
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const TYPE = /^[a-z][a-z_]{1,40}$/;

/** Shape check: identifiers, types, and times only. */
export function validateLedgerEntry(e: PurgeLedgerEntry): PurgeLedgerEntry {
  const ok =
    /^purge:[0-9a-f-]{36}$/.test(e.entryId) &&
    [e.workspaceId, e.batchId, e.rootRecordId, e.operationId].every(isUuidV7) &&
    e.records.length >= 1 &&
    e.records.every((r) => isUuidV7(r.id) && TYPE.test(r.recordType)) &&
    ISO.test(e.trashedAt) &&
    ISO.test(e.purgedAt);
  if (!ok) throw new Error('invalid purge ledger entry');
  // Rebuild from the allowed keys so nothing else can ride along.
  return {
    entryId: e.entryId,
    workspaceId: e.workspaceId,
    batchId: e.batchId,
    rootRecordId: e.rootRecordId,
    operationId: e.operationId,
    records: e.records.map((r) => ({ id: r.id, recordType: r.recordType })),
    trashedAt: e.trashedAt,
    purgedAt: e.purgedAt,
  };
}

export class LocalFilePurgeLedger implements PurgeLedger {
  readonly kind = 'local' as const;
  readonly available = true;
  readonly #file: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.#file = join(dir, 'purge-ledger.jsonl');
  }

  async #read(): Promise<Array<PurgeLedgerEntry & { acknowledgedAt: string }>> {
    let text = '';
    try {
      text = await readFile(this.#file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as PurgeLedgerEntry & { acknowledgedAt: string });
  }

  append(entry: PurgeLedgerEntry): Promise<LedgerAck> {
    const clean = validateLedgerEntry(entry);
    // Serialize appends within the process; a duplicate across processes is deduplicated on read.
    const run = this.#queue.then(async () => {
      const existing = (await this.#read()).find((e) => e.entryId === clean.entryId);
      if (existing)
        return { entryId: clean.entryId, acknowledgedAt: new Date(existing.acknowledgedAt) };
      const acknowledgedAt = new Date();
      const fh = await open(this.#file, 'a', 0o600);
      try {
        await fh.write(
          `${JSON.stringify({ ...clean, acknowledgedAt: acknowledgedAt.toISOString() })}\n`,
        );
        await fh.sync();
      } finally {
        await fh.close();
      }
      return { entryId: clean.entryId, acknowledgedAt };
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async entriesAfter(point: Date): Promise<Array<PurgeLedgerEntry & { acknowledgedAt: string }>> {
    const seen = new Set<string>();
    return (await this.#read())
      .filter((e) => new Date(e.purgedAt) > point)
      .filter((e) => (seen.has(e.entryId) ? false : (seen.add(e.entryId), true)))
      .sort((a, b) => (a.purgedAt < b.purgedAt ? -1 : a.purgedAt > b.purgedAt ? 1 : 0));
  }
}

export class UnavailablePurgeLedger implements PurgeLedger {
  readonly kind = 'none' as const;
  readonly available = false;
  append(): Promise<LedgerAck> {
    return Promise.reject(new LedgerUnavailableError());
  }
  entriesAfter(): Promise<Array<PurgeLedgerEntry & { acknowledgedAt: string }>> {
    return Promise.reject(new LedgerUnavailableError());
  }
}

export function createPurgeLedger(
  config: Pick<LifecycleConfig, 'purgeLedger' | 'purgeLedgerDir'>,
): PurgeLedger {
  if (config.purgeLedger === 'local' && config.purgeLedgerDir)
    return new LocalFilePurgeLedger(config.purgeLedgerDir);
  return new UnavailablePurgeLedger();
}
