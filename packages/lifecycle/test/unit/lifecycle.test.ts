import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newUuidV7 } from '@pm/contracts';
import {
  createPurgeLedger,
  LedgerUnavailableError,
  LifecycleRegistry,
  LocalFilePurgeLedger,
  RetentionPolicy,
  systemDecision,
  validateLedgerEntry,
  type PurgeLedgerEntry,
} from '@pm/lifecycle';
import { testDecision } from '@pm/lifecycle/testing';

const entry = (): PurgeLedgerEntry => {
  const batchId = newUuidV7();
  return {
    entryId: `purge:${batchId}`,
    workspaceId: newUuidV7(),
    batchId,
    rootRecordId: newUuidV7(),
    operationId: newUuidV7(),
    records: [{ id: newUuidV7(), recordType: 'task' }],
    trashedAt: '2026-10-01T10:00:00.000Z',
    purgedAt: '2026-10-03T10:00:00.000Z',
  };
};

describe('purge ledger (0B §8.11)', () => {
  it('accepts identifiers, types, and times only; anything else is dropped or refused', () => {
    const e = entry();
    const withContent = {
      ...e,
      title: 'Quarterly plan',
      records: [{ ...e.records[0]!, title: 'x' }],
    } as never;
    const clean = validateLedgerEntry(withContent);
    expect(JSON.stringify(clean).includes('Quarterly')).toBe(false);
    expect(Object.keys(clean).sort()).toEqual(Object.keys(e).sort());
    expect(() => validateLedgerEntry({ ...e, workspaceId: 'ws_1' })).toThrow();
    expect(() => validateLedgerEntry({ ...e, records: [] })).toThrow();
    expect(() => validateLedgerEntry({ ...e, purgedAt: 'yesterday' })).toThrow();
    expect(() =>
      validateLedgerEntry({ ...e, records: [{ id: newUuidV7(), recordType: 'Task Title' }] }),
    ).toThrow();
  });

  it('appends durably and idempotently by entry id; replay order is by purge time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-ledger-'));
    const ledger = new LocalFilePurgeLedger(dir);
    const a = entry();
    const b = { ...entry(), purgedAt: '2026-10-02T10:00:00.000Z' };
    const ackA = await ledger.append(a);
    const again = await ledger.append(a);
    expect(again.acknowledgedAt.getTime()).toBe(ackA.acknowledgedAt.getTime());
    await Promise.all([ledger.append(b), ledger.append(b)]);
    const lines = readFileSync(join(dir, 'purge-ledger.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const after = await ledger.entriesAfter(new Date('2026-10-01T00:00:00.000Z'));
    expect(after.map((x) => x.entryId)).toEqual([b.entryId, a.entryId]);
    expect(await ledger.entriesAfter(new Date('2026-10-02T12:00:00.000Z'))).toHaveLength(1);
  });

  it('without a configured ledger, appends are refused (purge cannot complete)', async () => {
    const none = createPurgeLedger({ purgeLedger: 'none', purgeLedgerDir: undefined });
    expect(none.available).toBe(false);
    await expect(none.append(entry())).rejects.toBeInstanceOf(LedgerUnavailableError);
  });
});

describe('retention values (ADR-11): unset means undecided', () => {
  it('has no default duration for any class', () => {
    const r = new RetentionPolicy({ retentionPeriodsMs: {} });
    for (const cls of ['R-LIVE', 'R-AUDIT', 'R-EXEC', 'R-PERSONAL'] as const)
      expect(r.platformPeriodMs(cls)).toBeNull();
    expect(
      new RetentionPolicy({ retentionPeriodsMs: { 'R-LIVE': 3_600_000 } }).platformPeriodMs(
        'R-LIVE',
      ),
    ).toBe(3_600_000);
  });
});

describe('policy decisions and the registry', () => {
  it('system decisions cover purge only; test decisions come from the testing subpath', () => {
    const ws = newUuidV7();
    const sys = systemDecision('record.purge', ws, newUuidV7());
    expect(sys.principal.type).toBe('system_job');
    expect(sys.covers(newUuidV7())).toBe(true);
    const narrow = testDecision('record.trash', ws, { principalId: newUuidV7(), recordIds: ['a'] });
    expect(narrow.covers('a')).toBe(true);
    expect(narrow.covers('b')).toBe(false);
    expect(Object.isFrozen(narrow)).toBe(true);
  });

  it('reports record types without purge hooks and refuses duplicate registration', () => {
    const r = new LifecycleRegistry()
      .register({ recordType: 'task', purge: { deleteContent: () => Promise.resolve() } })
      .register({ recordType: 'project' });
    expect(r.missingPurgeHooks(['task', 'project', 'document'])).toEqual(['document', 'project']);
    expect(() => r.register({ recordType: 'task' })).toThrow(/already registered/);
  });
});
