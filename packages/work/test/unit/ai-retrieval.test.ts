import { describe, expect, it } from 'vitest';
import { TenancyError } from '@pm/tenancy';
import { groundedFixtureReply } from '@pm/test-support';
import {
  discoverManifest,
  MANIFEST_LIST_MAX,
  pinnedManifest,
  RetrievalRefusal,
  type ManifestLimits,
} from '../../src/ai/retrieval/manifest.ts';
import {
  figuresOf,
  groundedUserMessage,
  parseAnswer,
  validateAnswer,
} from '../../src/ai/retrieval/grounding.ts';
import { calculations, serverFacts } from '../../src/ai/retrieval/facts.ts';
import type {
  PinnedRef,
  RetrievalReaders,
  SourceKind,
  SourceRecord,
} from '../../src/ai/retrieval/types.ts';

/**
 * Phase 7B retrieval and grounding units (ADR-0039): the manifest engine against fake canonical
 * readers (which stand in for the module loaders only; authorization is proven in integration),
 * and the answer validator against deliberately valid and invalid responses.
 */

const id = (prefix: string, n: number) => `${prefix}_${String(n).padStart(26, '0')}`;
const BRAND_A = { id: 'b-a', publicId: id('br', 1), name: 'Alpha', sensitive: false };
const BRAND_B = { id: 'b-b', publicId: id('br', 2), name: 'Beta', sensitive: false };
const BRAND_S = { id: 'b-s', publicId: id('br', 3), name: 'Secret', sensitive: true };

function task(n: number, over: Partial<SourceRecord> = {}): SourceRecord {
  return {
    kind: 'task',
    publicId: id('tsk', n),
    recordId: `t${n}`,
    brandId: BRAND_A.id,
    brandSensitive: false,
    projectId: 'p1',
    taskId: `t${n}`,
    title: `Task ${n}`,
    link: { type: 'task', id: id('tsk', n), anchor: null },
    version: 1,
    versionLabel: 'v1',
    fields: [
      { name: 'title', dataClass: 'C2', text: `Task ${n}` },
      { name: 'description', dataClass: 'C2', text: `Launch plan ${n}. Ship by Friday.` },
      { name: 'status', dataClass: 'C1', text: 'In progress' },
    ],
    facts: { status: { name: 'In progress', category: 'active' }, dueDate: '2026-10-01' },
    flags: [],
    ...over,
  };
}

function readers(
  records: SourceRecord[],
  opts: { hits?: Array<{ kind: SourceKind; id: string }>; brandOnly?: boolean } = {},
): RetrievalReaders & { searches: number } {
  const byKey = new Map(records.map((r) => [`${r.kind}:${r.publicId}`, r]));
  const r = {
    searches: 0,
    source: async (kind: SourceKind, pid: string) => {
      const found = byKey.get(`${kind}:${pid}`);
      if (!found) throw new TenancyError('not_found');
      return found;
    },
    search: async () => {
      r.searches += 1;
      return {
        hits: opts.hits ?? [],
        index: { state: 'complete' as const, pending: 0, failed: 0 },
      };
    },
    brands: async (ids: readonly string[]) =>
      [BRAND_A, BRAND_B, BRAND_S].filter((b) => ids.includes(b.publicId)),
    brandOnly: async () => opts.brandOnly ?? false,
  };
  return r;
}

const LIMITS: ManifestLimits = { sourcesMax: 3, sourceChars: 40, candidates: 20 };
const policy = { maxDataClass: 'C2' as const, limits: LIMITS };
const none = { brands: [], project: null, task: null };
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof RetrievalRefusal) return e.code;
    throw e;
  }
  throw new Error('expected a refusal');
};

describe('7B context manifest', () => {
  it('lists explicit includes, then the scope, then search, deduplicated, with server handles', async () => {
    const r = readers([task(1), task(2), task(3)], {
      hits: [
        { kind: 'task', id: id('tsk', 2) },
        { kind: 'task', id: id('tsk', 3) },
      ],
    });
    const m = await discoverManifest(
      r,
      { scope: none, query: 'launch', include: [{ kind: 'task', id: id('tsk', 2) }], exclude: [] },
      policy,
    );
    expect(m.entries.map((e) => [e.publicId, e.selection, e.handle])).toEqual([
      [id('tsk', 2), 'explicit', 'S1'],
      [id('tsk', 3), 'search', 'S2'],
    ]);
    // Deterministic: the same inputs give the same digest; any change gives another.
    const again = await discoverManifest(
      r,
      { scope: none, query: 'launch', include: [{ kind: 'task', id: id('tsk', 2) }], exclude: [] },
      policy,
    );
    expect(again.digest).toBe(m.digest);
    const other = await discoverManifest(
      r,
      { scope: none, query: 'launch', include: [], exclude: [] },
      policy,
    );
    expect(other.digest).not.toBe(m.digest);
  });

  it('refuses an unreadable explicit include identically, and drops stale search pointers silently', async () => {
    const r = readers([task(1)], { hits: [{ kind: 'task', id: id('tsk', 9) }] });
    expect(
      await refusal(
        discoverManifest(
          r,
          {
            scope: none,
            query: null,
            include: [{ kind: 'document', id: id('doc', 7) }],
            exclude: [],
          },
          policy,
        ),
      ),
    ).toBe('context_unavailable');
    const m = await discoverManifest(
      r,
      { scope: none, query: 'x', include: [], exclude: [] },
      policy,
    );
    // The hidden search hit leaves no entry, no count, and no omitted figure.
    expect(m.entries).toEqual([]);
    expect(m.omitted).toBe(0);
    // Excluding a hidden or unknown source has no effect and reveals nothing.
    const quiet = await discoverManifest(
      r,
      { scope: none, query: null, include: [], exclude: [{ kind: 'task', id: id('tsk', 99) }] },
      policy,
    );
    expect(quiet.entries).toEqual([]);
  });

  it('never widens scope: unknown, conflicting, and restricted scopes refuse', async () => {
    const t = task(1, { brandId: BRAND_B.id });
    const r = readers([t]);
    expect(
      await refusal(
        discoverManifest(
          r,
          { scope: { ...none, brands: [id('br', 9)] }, query: null, include: [], exclude: [] },
          policy,
        ),
      ),
    ).toBe('scope_unavailable');
    expect(
      await refusal(
        discoverManifest(
          r,
          {
            scope: { brands: [BRAND_A.publicId], project: null, task: t.publicId },
            query: null,
            include: [],
            exclude: [],
          },
          policy,
        ),
      ),
    ).toBe('scope_conflict');
    expect(
      await refusal(
        discoverManifest(
          r,
          { scope: { ...none, brands: [BRAND_S.publicId] }, query: null, include: [], exclude: [] },
          policy,
        ),
      ),
    ).toBe('ai_sensitive_brand');
  });

  it('records why a readable source is not sent: scope, exclusion, sensitivity, brand-only policy, suitability, limits', async () => {
    const outside = task(1, { brandId: BRAND_B.id });
    const sensitive = task(2, { brandSensitive: true });
    const workspaceDoc: SourceRecord = {
      ...task(3),
      kind: 'document',
      publicId: id('doc', 3),
      brandId: null,
      flags: ['unapproved'],
    };
    const stale: SourceRecord = {
      ...task(4),
      kind: 'document',
      publicId: id('doc', 4),
      flags: ['stale'],
    };
    const r = readers(
      [outside, sensitive, workspaceDoc, stale, task(5), task(6), task(7), task(8)],
      {
        hits: [
          { kind: 'document', id: id('doc', 4) },
          { kind: 'task', id: id('tsk', 6) },
          { kind: 'task', id: id('tsk', 7) },
          { kind: 'task', id: id('tsk', 8) },
        ],
      },
    );
    const m = await discoverManifest(
      r,
      {
        scope: { ...none, brands: [BRAND_A.publicId] },
        query: 'plan',
        include: [
          { kind: 'task', id: outside.publicId },
          { kind: 'task', id: sensitive.publicId },
          { kind: 'task', id: id('tsk', 5) },
        ],
        exclude: [{ kind: 'task', id: id('tsk', 6) }],
      },
      policy,
    );
    expect(m.entries.map((e) => [e.publicId, e.included, e.exclusion])).toEqual([
      [outside.publicId, false, 'out_of_scope'],
      [sensitive.publicId, false, 'sensitive_brand'],
      [id('tsk', 5), true, null],
      // An excluded source stays listed (as the person's explicit choice) so it can be re-included.
      [id('tsk', 6), false, 'user_excluded'],
      [id('doc', 4), false, 'needs_explicit_choice'],
      [id('tsk', 7), true, null],
      [id('tsk', 8), true, null],
    ]);
    // A fourth includable source exceeds AI_CONTEXT_SOURCES_MAX (3 here).
    const more = await discoverManifest(
      readers([task(5), task(6), task(7), task(8)], {
        hits: [5, 6, 7, 8].map((n) => ({ kind: 'task' as const, id: id('tsk', n) })),
      }),
      { scope: none, query: 'plan', include: [], exclude: [] },
      policy,
    );
    expect(more.entries.map((e) => e.exclusion)).toEqual([null, null, null, 'over_limit']);
    // An explicitly chosen unsuitable source is included, and keeps its warning flag.
    const chosen = await discoverManifest(
      r,
      { scope: none, query: null, include: [{ kind: 'document', id: id('doc', 4) }], exclude: [] },
      policy,
    );
    expect(chosen.entries[0]).toMatchObject({ included: true, flags: ['stale', 'truncated'] });
    // Brand-only policy: a workspace-level source is excluded for a single-brand scope.
    const only = await discoverManifest(
      readers([workspaceDoc, task(5)], { brandOnly: true }),
      {
        scope: { ...none, brands: [BRAND_A.publicId] },
        query: null,
        include: [
          { kind: 'document', id: workspaceDoc.publicId },
          { kind: 'task', id: id('tsk', 5) },
        ],
        exclude: [],
      },
      policy,
    );
    expect(only.entries.map((e) => e.exclusion)).toEqual(['out_of_scope', null]);
  });

  it('bounds each source, redacts credentials, and caps the listing with an honest readable-only count', async () => {
    const secret = task(1, {
      fields: [
        { name: 'title', dataClass: 'C2', text: 'Keys' },
        {
          name: 'description',
          dataClass: 'C2',
          text: 'token sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX1234 end',
        }, // gitleaks:allow
      ],
    });
    const m = await discoverManifest(
      readers([secret]),
      { scope: none, query: null, include: [{ kind: 'task', id: secret.publicId }], exclude: [] },
      { ...policy, limits: { ...LIMITS, sourceChars: 200 } },
    );
    expect(m.entries[0]!.payload!.description).not.toContain('sk-ant-api03');
    const short = await discoverManifest(
      readers([task(1)]),
      { scope: none, query: null, include: [{ kind: 'task', id: id('tsk', 1) }], exclude: [] },
      { ...policy, limits: { ...LIMITS, sourceChars: 10 } },
    );
    expect(short.entries[0]!.flags).toContain('truncated');
    expect(Object.values(short.entries[0]!.payload!).join('').length).toBe(10);
    // The data class drops fields above it; a source with no eligible field is excluded.
    const c1 = await discoverManifest(
      readers([task(1)]),
      { scope: none, query: null, include: [{ kind: 'task', id: id('tsk', 1) }], exclude: [] },
      { ...policy, maxDataClass: 'C1' },
    );
    expect(c1.entries[0]!.fieldNames).toEqual(['status']);
    const c0 = await discoverManifest(
      readers([task(1)]),
      { scope: none, query: null, include: [{ kind: 'task', id: id('tsk', 1) }], exclude: [] },
      { ...policy, maxDataClass: 'C0' },
    );
    expect(c0.entries[0]!.exclusion).toBe('data_class');
    const many = Array.from({ length: MANIFEST_LIST_MAX + 3 }, (_, i) => task(i + 1));
    const big = await discoverManifest(
      readers(many, { hits: many.map((t) => ({ kind: 'task' as const, id: t.publicId })) }),
      { scope: none, query: 'all', include: [], exclude: [] },
      policy,
    );
    expect(big.entries).toHaveLength(MANIFEST_LIST_MAX);
    expect(big.omitted).toBe(3);
  });

  it('re-resolves a recorded manifest: unchanged keeps its digest; changed or hidden sources refuse', async () => {
    const t = task(1);
    const m = await discoverManifest(
      readers([t]),
      { scope: none, query: null, include: [{ kind: 'task', id: t.publicId }], exclude: [] },
      policy,
    );
    const pinned: PinnedRef[] = m.entries.map((e) => ({
      kind: e.kind,
      id: e.publicId,
      selection: e.selection,
      included: e.included,
      exclusion: e.exclusion,
      handle: e.handle,
      contentHash: e.contentHash,
      flags: e.flags,
      version: e.version,
      versionLabel: e.versionLabel,
      fields: e.fieldNames,
    }));
    const same = await pinnedManifest(readers([t]), none, null, pinned, policy);
    expect(same.digest).toBe(m.digest);
    const edited = task(1, {
      version: 2,
      fields: [{ name: 'title', dataClass: 'C2', text: 'Renamed' }],
    });
    expect(await refusal(pinnedManifest(readers([edited]), none, null, pinned, policy))).toBe(
      'manifest_changed',
    );
    expect(await refusal(pinnedManifest(readers([]), none, null, pinned, policy))).toBe(
      'context_unavailable',
    );
    const nowSensitive = task(1, { brandSensitive: true });
    expect(await refusal(pinnedManifest(readers([nowSensitive]), none, null, pinned, policy))).toBe(
      'manifest_changed',
    );
  });
});

async function manifestOf(records: SourceRecord[]) {
  return discoverManifest(
    readers(records),
    {
      scope: none,
      query: null,
      include: records.map((r) => ({ kind: r.kind, id: r.publicId })),
      exclude: [],
    },
    { maxDataClass: 'C2', limits: { sourcesMax: 8, sourceChars: 500, candidates: 20 } },
  );
}

describe('7B grounded answer validation', () => {
  const statement = (
    kind: string,
    text: string,
    citations: Array<{ source: string; quote?: string | null }> = [],
  ) => ({ kind, text, citations });
  const answer = (...s: unknown[]) => JSON.stringify({ statements: s });

  it('separates server facts and calculations, exact excerpts, unverified claims, suggestions, and unknowns', async () => {
    const m = await manifestOf([
      task(1),
      task(2, { facts: { status: { name: 'Done', category: 'done' } } }),
    ]);
    const g = validateAnswer({
      text: answer(
        statement('fact', 'Ship by Friday.', [{ source: 'S1' }]),
        statement('fact', 'The plan ships by Friday.', [
          { source: 'S1', quote: 'Ship by Friday.' },
        ]),
        statement('fact', 'There is a second task.', [{ source: 'S2' }]),
        statement('suggestion', 'Confirm the date with the owner.'),
        statement('unknown', 'The sources do not name an owner.'),
      ),
      completeness: 'complete',
      entries: m.entries,
      today: '2026-10-17',
    });
    expect(g.status).toBe('checked');
    expect(g.statements.map((s) => s.kind)).toEqual([
      'excerpt',
      'unverified',
      'unverified',
      'suggestion',
      'unknown',
    ]);
    // The excerpt shows the source's own text; a cited quotation is provenance for its claim.
    expect(g.statements[0]!.citations).toEqual([
      { handle: 'S1', quote: 'Ship by Friday.', excerpt: 'Ship by Friday.' },
    ]);
    expect(g.statements[1]!.citations).toEqual([
      { handle: 'S1', quote: 'Ship by Friday.', excerpt: 'Ship by Friday.' },
    ]);
    // Facts and calculations come from the records, not from the model.
    expect(g.facts).toContainEqual({ handle: 'S1', label: 'Status', value: 'In progress' });
    expect(g.calculations.find((c) => c.key === 'tasks_done')!.value).toBe('1 of 2');
    expect(g.calculations.find((c) => c.key === 'tasks_overdue')!.value).toBe('1');
  });

  it('drops forged or misquoted citations, and never promotes an uncited or contradicted claim', async () => {
    const m = await manifestOf([task(1)]);
    const g = validateAnswer({
      text: answer(
        statement('fact', 'Approved in tsk_00000000000000000000000000.', [{ source: 'S99' }]),
        statement('fact', 'The source promises a launch.', [
          { source: 'S1', quote: 'never written' },
        ]),
        statement('fact', 'This task is completed and cost $48,000 by 2020-01-01.', [
          { source: 'S1' },
        ]),
        statement('fact', 'See https://evil.example/x and javascript:alert(1)', [{ source: 'S1' }]),
      ),
      completeness: 'complete',
      entries: m.entries,
      today: '2026-10-17',
    });
    expect(g.status).toBe('downgraded');
    expect(g.dropped_citations).toBe(2);
    expect(g.statements.map((s) => [s.kind, s.issues.sort()])).toEqual([
      ['unverified', ['citation_invalid', 'no_valid_citation', 'untrusted_reference'].sort()],
      ['unverified', ['no_valid_citation', 'quote_mismatch'].sort()],
      ['unverified', ['contradicts_record', 'unsupported_figure'].sort()],
      ['unverified', ['untrusted_link']],
    ]);
    // No forged handle survives as a citation.
    expect(g.statements.flatMap((s) => s.citations.map((c) => c.handle))).toEqual(['S1', 'S1']);
  });

  it('a figure that appears in a source is still not an established claim (notes are informational)', async () => {
    const m = await manifestOf([task(1)]);
    const g = validateAnswer({
      text: answer(statement('fact', 'It was due 2026-10-01.', [{ source: 'S1' }])),
      completeness: 'complete',
      entries: m.entries,
      today: '2026-10-17',
    });
    expect(g.statements[0]).toMatchObject({ kind: 'unverified', issues: [] });
    expect(figuresOf('Costs $1,200 or 15% by March 3, 2026 (2026-03-03).')).toEqual([
      '$1,200',
      '15%',
      '2026-03-03',
      'march 3, 2026',
    ]);
  });

  it('rejects malformed, truncated, and empty answers with a visible reason (never patched)', async () => {
    const m = await manifestOf([task(1)]);
    const v = (text: string, completeness: 'complete' | 'truncated' = 'complete') =>
      validateAnswer({ text, completeness, entries: m.entries, today: '2026-10-17' });
    expect(v('Sure, here you go!')).toMatchObject({
      status: 'rejected',
      reason: 'malformed_response',
      statements: [],
    });
    expect(v('{"statements":[{"kind":"unknown","text":"n/a"}]}', 'truncated')).toMatchObject({
      status: 'rejected',
      reason: 'truncated_response',
      statements: [],
    });
    expect(v('{"statements":[{"kind":"fa', 'truncated')).toMatchObject({
      status: 'rejected',
      reason: 'truncated_response',
    });
    expect(v('{"statements":[]}')).toMatchObject({ status: 'rejected', reason: 'empty_answer' });
    expect(v('{"statements":[{"kind":"verdict","text":"x"}]}').status).toBe('rejected');
    expect(
      parseAnswer('```json\n{"statements":[{"kind":"unknown","text":"n/a"}]}\n```'),
    ).toHaveLength(1);
  });

  it('server facts and calculations count only included tasks', async () => {
    const m = await manifestOf([task(1), task(2, { brandSensitive: true })]);
    expect(serverFacts(m.entries).map((f) => f.handle)).toEqual(['S1', 'S1']);
    expect(calculations(m.entries, '2026-10-17')[0]!.basis).toMatch(/from 1 task in this context/);
  });

  it('the deterministic provider fixture answers only from the sources it was sent (fixture contract)', async () => {
    const m = await manifestOf([task(1), task(2)]);
    const user = groundedUserMessage('What is planned? #fixture:ok', m.entries);
    const ok = validateAnswer({
      text: groundedFixtureReply(user, 'ok'),
      completeness: 'complete',
      entries: m.entries,
      today: '2026-10-17',
    });
    expect(ok.status).toBe('checked');
    expect(ok.statements.map((s) => s.kind)).toEqual([
      'excerpt',
      'unverified',
      'unverified',
      'unverified',
      'suggestion',
      'unknown',
    ]);
    for (const scenario of ['cite_forged', 'cite_misquote'] as const) {
      const g = validateAnswer({
        text: groundedFixtureReply(user, scenario),
        completeness: 'complete',
        entries: m.entries,
        today: '2026-10-17',
      });
      expect(g.status, scenario).toBe('downgraded');
    }
    for (const scenario of ['claim_status', 'inject'] as const) {
      const g = validateAnswer({
        text: groundedFixtureReply(user, scenario),
        completeness: 'complete',
        entries: m.entries,
        today: '2026-10-17',
      });
      expect(g.statements[0]!.kind, scenario).toBe('unverified');
    }
    expect(
      validateAnswer({
        text: groundedFixtureReply(user, 'malformed'),
        completeness: 'complete',
        entries: m.entries,
        today: '2026-10-17',
      }).status,
    ).toBe('rejected');
  });
});
