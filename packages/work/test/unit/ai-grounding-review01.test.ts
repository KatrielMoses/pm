import { describe, expect, it } from 'vitest';
import { discoverManifest } from '../../src/ai/retrieval/manifest.ts';
import { findExcerpt, validateAnswer } from '../../src/ai/retrieval/grounding.ts';
import type { RetrievalReaders, SourceRecord } from '../../src/ai/retrieval/types.ts';
import { TenancyError } from '@pm/tenancy';

/**
 * Phase 7B corrective review 01, R2 and R3: transport completeness is checked independently of
 * parsing, and a valid quotation is provenance, never verification of an unrelated claim.
 */
const ID = `tsk_${'1'.padStart(26, '0')}`;
const source: SourceRecord = {
  kind: 'task',
  publicId: ID,
  recordId: 't1',
  brandId: 'b1',
  brandSensitive: false,
  projectId: null,
  taskId: 't1',
  title: 'Launch',
  link: { type: 'task', id: ID, anchor: null },
  version: 1,
  versionLabel: 'v1',
  fields: [
    { name: 'title', dataClass: 'C2', text: 'Launch' },
    {
      name: 'description',
      dataClass: 'C2',
      text: 'Ship by Friday. Budget was set on 2026-03-01 at $5,000.',
    },
    { name: 'status', dataClass: 'C1', text: 'In progress' },
  ],
  facts: { status: { name: 'In progress', category: 'active' } },
  flags: [],
};
const readers: RetrievalReaders = {
  source: async (kind, id) => {
    if (kind === 'task' && id === ID) return source;
    throw new TenancyError('not_found');
  },
  search: async () => ({ hits: [], index: { state: 'complete', pending: 0, failed: 0 } }),
  brands: async () => [],
  brandOnly: async () => false,
};
const entries = async () =>
  (
    await discoverManifest(
      readers,
      {
        scope: { brands: [], project: null, task: null },
        query: null,
        include: [{ kind: 'task', id: ID }],
        exclude: [],
      },
      { maxDataClass: 'C2', limits: { sourcesMax: 8, sourceChars: 2000, candidates: 20 } },
    )
  ).entries;
const answer = (...statements: unknown[]) => JSON.stringify({ statements });
const fact = (text: string, quote: string | null = null) => ({
  kind: 'fact',
  text,
  citations: [{ source: 'S1', quote }],
});

describe('7B review 01: completeness and trust', () => {
  it('R2: well-formed JSON from a truncated or partial transport is never a validated answer', async () => {
    const e = await entries();
    const text = answer(fact('Ship by Friday.', 'Ship by Friday.'));
    for (const completeness of ['truncated', 'partial'] as const) {
      const g = validateAnswer({ text, completeness, entries: e, today: '2026-10-17' });
      expect(g.status, completeness).toBe('rejected');
      expect(g.reason, completeness).toBe(
        completeness === 'truncated' ? 'truncated_response' : 'partial_response',
      );
      expect(g.statements, completeness).toEqual([]);
      // Facts from the records keep their own, independent validity.
      expect(g.facts.length, completeness).toBeGreaterThan(0);
    }
  });

  it('R3: a real quotation does not establish an unrelated claim, a spelled-out amount, or a negated status', async () => {
    const e = await entries();
    const g = validateAnswer({
      text: answer(
        fact('The launch generated twelve million dollars in profit.', 'Ship by Friday.'),
        fact('The launch is not in progress.', null),
        fact('The budget was approved on 2026-03-01.', null),
      ),
      completeness: 'complete',
      entries: e,
      today: '2026-10-17',
    });
    for (const s of g.statements) {
      expect(s.kind, s.text).toBe('unverified');
      expect(s.kind, s.text).not.toBe('sourced');
    }
    expect(g.status).not.toBe('validated');
  });

  it("R3: an excerpt is the source's own text, matched verbatim; case folding is not verbatim", async () => {
    const e = await entries();
    const g = validateAnswer({
      text: answer(
        fact('Ship by Friday.'),
        fact('ship by friday.'),
        fact('The budget is fine.', 'ship by friday.'),
        {
          kind: 'fact',
          text: 'Budget was set on 2026-03-01',
          citations: [{ source: 'S1', quote: null }],
        },
      ),
      completeness: 'complete',
      entries: e,
      today: '2026-10-17',
    });
    expect(g.statements.map((x) => x.kind)).toEqual([
      'excerpt',
      'unverified',
      'unverified',
      'excerpt',
    ]);
    expect(g.statements[0]!.citations[0]!.excerpt).toBe('Ship by Friday.');
    // A case-folded quotation is a mismatch, removed and counted (never silently verbatim).
    expect(g.statements[2]!.issues).toContain('quote_mismatch');
    expect(g.status).toBe('downgraded');
    // Whitespace runs are one space, and the excerpt keeps the source's own spacing.
    expect(findExcerpt('Ship   by\n Friday.', 'Ship by Friday.')).toBe('Ship   by\n Friday.');
    expect(findExcerpt('Ship by Friday.', 'SHIP BY FRIDAY.')).toBeNull();
  });

  it('R3: an unrelated real date or amount, a contradicted status, and server facts that cannot be overridden', async () => {
    const e = await entries();
    const g = validateAnswer({
      text: answer(
        fact('The launch earned $5,000 in revenue on 2026-03-01.'),
        fact('The launch is complete.'),
        fact('The launch is in progress.'),
      ),
      completeness: 'complete',
      entries: e,
      today: '2026-10-17',
    });
    // The date and amount appear in the source, but not as this claim: unverified all the same.
    expect(g.statements[0]).toMatchObject({ kind: 'unverified', issues: [] });
    expect(g.statements[1]).toMatchObject({ kind: 'unverified', issues: ['contradicts_record'] });
    // Even a claim matching the record's status is generated text, not an established fact.
    expect(g.statements[2]).toMatchObject({ kind: 'unverified' });
    // The established status is the server's, whatever the model said.
    expect(g.facts).toContainEqual({ handle: 'S1', label: 'Status', value: 'In progress' });
  });

  it('R2: complete output is checked; malformed truncation keeps its own reason', async () => {
    const e = await entries();
    expect(
      validateAnswer({
        text: answer(fact('Ship by Friday.')),
        completeness: 'complete',
        entries: e,
        today: '2026-10-17',
      }).status,
    ).toBe('checked');
    expect(
      validateAnswer({
        text: '{"statements":[{"kind":',
        completeness: 'truncated',
        entries: e,
        today: '2026-10-17',
      }),
    ).toMatchObject({ status: 'rejected', reason: 'truncated_response', statements: [] });
  });
});
