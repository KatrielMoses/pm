import { createHash } from 'node:crypto';
import { newUuidV7 } from '@pm/contracts';
import { sql, type RawBuilder, type WorkspaceTransaction } from '@pm/db';
import {
  brandMarker,
  compileVisibility,
  governingProject,
  invalid,
  issue,
  readableBrandsByIds,
  TenancyError,
  type Caller,
  type Principal,
} from '@pm/tenancy';
import { FileService } from '../files/file-service.ts';
import { isPublic } from '../validation.ts';
import {
  indexState,
  makeSnippet,
  parseSearchQuery,
  SEARCH_STATES,
  SEARCH_WINDOWS,
  tsqueryText,
  WINDOW_DAYS,
  type ParsedQuery,
  type QueryTerm,
  type SearchState,
  type SearchWindow,
  type Snippet,
} from './semantics.ts';
import { defaultSearchSources, type SearchSource, type SearchSourceRegistry } from './sources.ts';

const iso = (d: Date | string) => new Date(d).toISOString();
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const NIL = '00000000-0000-7000-8000-000000000000';
/** The characters of a body read for a snippet (the match may lie deeper; then the start is shown). */
const SNIPPET_SCAN_CHARS = 20_000;

export interface SearchFilters {
  kinds: string[];
  /** Public identifiers of brands (checked against the brands the person can see). */
  brands: string[];
  project: string | null;
  state: SearchState;
  updated: SearchWindow | null;
  mine: boolean;
  mentioningMe: boolean;
}

interface Parsed {
  q: string;
  parsed: ParsedQuery;
  filters: SearchFilters;
  limit: number;
  offset: number;
}

/** The knobs of one search, resolved against the person's access (never trusted as identifiers). */
interface Resolved {
  brandIds: string[];
  projectId: string | null;
}

interface Hit {
  source_kind: string;
  source_id: string;
  auth_record_id: string;
  context_record_id: string | null;
  title: string;
  body: string;
  source_updated_at: Date;
  brand_id: string | null;
  lifecycle_state: 'active' | 'archived';
  rank: number;
  task_state: 'pending' | 'failed' | null;
}

export type SearchResultIndexState = 'current' | 'updating' | 'failed';

/**
 * Phase 5A permission-aware search (ADR-0028). One canonical authority: every query joins an index
 * entry to the record whose access governs it and applies the compiled visibility predicate (0C
 * 4.5) *before* anything is matched, ranked, counted, faceted, or excerpted, so a hidden record
 * contributes to nothing a person can see, and a hidden record and an unknown one are the same
 * absence. The entry is a derived copy and grants nothing: the visibility, the lifecycle, and the
 * live state of the source are all read at the time of the request, and opening a result checks
 * them again. The index may lag the sources; the response says so (per result and for the
 * workspace) instead of presenting an incomplete index as complete.
 */
export class SearchService extends FileService {
  readonly #sources: SearchSourceRegistry;

  constructor(
    deps: ConstructorParameters<typeof FileService>[0] & {
      search?: { sources?: SearchSourceRegistry };
    },
  ) {
    super(deps);
    this.#sources = deps.search?.sources ?? defaultSearchSources();
  }

  get searchSources(): SearchSourceRegistry {
    return this.#sources;
  }

  // ---------------------------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------------------------

  protected async trackSearch<T>(op: string, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const out = await fn();
      this.d.metrics.count('search.requests', 1, { op, outcome: 'ok' });
      if (op === 'query')
        this.d.metrics.record('search.query.duration', (Date.now() - started) / 1000, {
          outcome: 'ok',
        });
      return out;
    } catch (err) {
      const outcome = err instanceof TenancyError ? err.code : 'error';
      this.d.metrics.count('search.requests', 1, { op, outcome });
      if (op === 'query')
        this.d.metrics.record('search.query.duration', (Date.now() - started) / 1000, { outcome });
      throw err;
    }
  }

  protected async searchLimit(p: Principal): Promise<void> {
    const r = await this.c.limiter.consume('search.member' as never, p.membershipId);
    if (!r.allowed)
      throw new TenancyError('rate_limited', { retryAfterSeconds: r.retryAfterSeconds });
  }

  // ---------------------------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------------------------

  /** A query-string value as a list (repeated or comma separated), each entry trimmed. */
  #list(v: unknown): string[] {
    const raw = Array.isArray(v) ? v : v === undefined ? [] : [v];
    return raw
      .flatMap((x) => (typeof x === 'string' ? x.split(',') : []))
      .map((x) => x.trim())
      .filter(Boolean);
  }

  #flag(v: unknown, pointer: string): boolean {
    if (v === undefined) return false;
    if (v === true || v === 'true' || v === '1') return true;
    if (v === false || v === 'false' || v === '0') return false;
    throw invalid(issue(pointer, 'invalid_option', 'Use true or false.'));
  }

  #filters(input: Record<string, unknown>): SearchFilters {
    const kinds = [...new Set(this.#list(input.kind))];
    for (const k of kinds)
      if (!this.#sources.get(k))
        throw invalid(issue('/kind', 'invalid_option', 'Choose a kind of result from the list.'));
    const brands = [...new Set(this.#list(input.brand))];
    if (brands.length > 20) throw invalid(issue('/brand', 'too_many', 'Choose at most 20 brands.'));
    for (const b of brands)
      if (!isPublic(b, 'br'))
        throw invalid(issue('/brand', 'invalid_option', 'Choose a brand from the list.'));
    const projects = this.#list(input.project);
    if (projects.length > 1) throw invalid(issue('/project', 'too_many', 'Choose one project.'));
    if (projects[0] !== undefined && !isPublic(projects[0], 'prj'))
      throw invalid(issue('/project', 'invalid_option', 'Choose a project from the list.'));
    const state = input.state === undefined ? 'active' : input.state;
    if (typeof state !== 'string' || !(SEARCH_STATES as readonly string[]).includes(state))
      throw invalid(issue('/state', 'invalid_option', 'Choose active, archived, or any.'));
    const updated = input.updated === undefined ? null : input.updated;
    if (
      updated !== null &&
      (typeof updated !== 'string' || !(SEARCH_WINDOWS as readonly string[]).includes(updated))
    )
      throw invalid(issue('/updated', 'invalid_option', 'Choose day, week, month, or year.'));
    return {
      kinds,
      brands,
      project: projects[0] ?? null,
      state: state as SearchState,
      updated: updated as SearchWindow | null,
      mine: this.#flag(input.mine, '/mine'),
      mentioningMe: this.#flag(input.mentioning_me, '/mentioning_me'),
    };
  }

  #parse(input: Record<string, unknown>, withPage: boolean): Parsed {
    if (typeof input.q !== 'string')
      throw invalid(issue('/q', 'required', 'Type something to search for.'));
    const parsed = parseSearchQuery(input.q, {
      maxChars: this.ws.searchQueryMaxChars,
      maxTerms: this.ws.searchTermsMax,
    });
    if (!parsed.ok) {
      const messages = {
        empty: 'Type something to search for.',
        no_terms: 'Add at least one word to search for (not only words to leave out).',
        too_long: `Use at most ${this.ws.searchQueryMaxChars} characters.`,
        too_many_terms: `Use at most ${this.ws.searchTermsMax} words or phrases.`,
      } as const;
      throw invalid(issue('/q', parsed.issue, messages[parsed.issue]));
    }
    let limit = Math.min(20, this.ws.searchPageSizeMax);
    let offset = 0;
    if (withPage) {
      if (input.limit !== undefined) {
        const n = Number(input.limit);
        if (!Number.isInteger(n) || n < 1 || n > this.ws.searchPageSizeMax)
          throw invalid(
            issue(
              '/limit',
              'invalid_option',
              `Use a page size from 1 to ${this.ws.searchPageSizeMax}.`,
            ),
          );
        limit = n;
      }
      if (input.offset !== undefined) {
        const n = Number(input.offset);
        if (!Number.isInteger(n) || n < 0 || n >= this.ws.searchResultsMax)
          throw invalid(
            issue(
              '/offset',
              'invalid_option',
              `Results go only to the first ${this.ws.searchResultsMax}; narrow the search instead.`,
            ),
          );
        offset = n;
      }
    }
    return {
      q: input.q.normalize('NFC').trim(),
      parsed: parsed.query,
      filters: this.#filters(input),
      limit,
      offset,
    };
  }

  /**
   * The brands and project a search names, resolved against what the person can see now. A brand
   * or project that is hidden is refused exactly as one that does not exist.
   */
  async #resolve(
    tx: WorkspaceTransaction,
    p: Principal,
    filters: SearchFilters,
    vis: Awaited<ReturnType<typeof compileVisibility>>,
  ): Promise<Resolved> {
    const unavailable = (pointer: string, what: string) =>
      invalid(issue(pointer, 'unavailable', `That ${what} is not available.`));
    let brandIds: string[] = [];
    if (filters.brands.length) {
      const rows = await tx.db
        .selectFrom('core.record')
        .select(['id', 'public_id'])
        .where('record_type', '=', 'brand')
        .where('public_id', 'in', filters.brands)
        .execute();
      const readable = await readableBrandsByIds(
        tx,
        p,
        rows.map((r) => r.id),
      );
      if (readable.length !== filters.brands.length) throw unavailable('/brand', 'brand');
      brandIds = readable.map((b) => b.id);
    }
    let projectId: string | null = null;
    if (filters.project) {
      const r = await sql<{ id: string }>`
        SELECT r.id FROM core.record r
         WHERE r.workspace_id = ${tx.workspaceId} AND r.public_id = ${filters.project}
           AND r.record_type = 'project' AND ${vis.where('r', { project: sql`r.id` })}`.execute(
        tx.db,
      );
      if (!r.rows[0]) throw unavailable('/project', 'project');
      projectId = r.rows[0].id;
    }
    return { brandIds, projectId };
  }

  // ---------------------------------------------------------------------------------------------
  // The one authority: candidate rows are authorized before anything is matched or counted
  // ---------------------------------------------------------------------------------------------

  #tsquery(terms: readonly QueryTerm[]): RawBuilder<unknown> {
    const parts = terms.map((t) => {
      const text = tsqueryText(t);
      const positive =
        text.english === null
          ? sql`to_tsquery('simple', ${text.simple})`
          : sql`(to_tsquery('simple', ${text.simple}) || to_tsquery('english', ${text.english}))`;
      return t.negate ? sql`(!! ${positive})` : sql`(${positive})`;
    });
    return sql`(${sql.join(parts, sql` && `)})`;
  }

  /**
   * The conditions every read of the index shares. `skip` leaves one filter out (a facet counts
   * what choosing another value would give). The entry's own live state is part of it, because the
   * index may lag a deletion.
   */
  #where(
    workspaceId: string,
    p: Principal,
    f: SearchFilters,
    r: Resolved,
    vis: Awaited<ReturnType<typeof compileVisibility>>,
    tsq: RawBuilder<unknown>,
    skip?: 'kind' | 'brand',
  ): RawBuilder<boolean> {
    const states = f.state === 'active' ? ['active'] : ['active', 'archived'];
    const parts: RawBuilder<unknown>[] = [
      sql`e.workspace_id = ${workspaceId}`,
      sql`e.source_kind = ANY(${this.#sources.kinds()}::text[])`,
      sql`e.tsv @@ ${tsq}`,
      vis.where('r'),
    ];
    if (f.state === 'archived') parts.push(sql`r.lifecycle_state = 'archived'`);
    for (const s of this.#sources.all()) {
      const live = s.live?.('e', states);
      if (live) parts.push(sql`(e.source_kind <> ${s.kind} OR ${live})`);
    }
    if (f.kinds.length && skip !== 'kind') parts.push(sql`e.source_kind = ANY(${f.kinds}::text[])`);
    if (r.brandIds.length && skip !== 'brand')
      parts.push(sql`r.brand_id = ANY(${r.brandIds}::uuid[])`);
    if (r.projectId) parts.push(sql`${governingProject('r')} = ${r.projectId}`);
    if (f.updated)
      parts.push(
        sql`e.source_updated_at >= ${new Date(Date.now() - WINDOW_DAYS[f.updated] * 86_400_000)}`,
      );
    if (f.mine) parts.push(sql`e.owner_membership_id = ${p.membershipId}`);
    if (f.mentioningMe)
      parts.push(
        sql`(e.source_kind = 'comment' AND EXISTS (SELECT 1 FROM relations.mention m
              WHERE m.workspace_id = e.workspace_id AND m.source_kind = 'comment'
                AND m.source_id = e.source_id AND m.target_kind = 'member'
                AND m.target_membership_id = ${p.membershipId}))`,
      );
    return sql<boolean>`${sql.join(parts, sql` AND `)}`;
  }

  async #visibility(tx: WorkspaceTransaction, p: Principal, f: SearchFilters) {
    return compileVisibility(tx, p, {
      need: 'view',
      includeArchived: f.state !== 'active',
      arrayMax: this.c.settings.principalContextArrayMax,
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------------------------

  async search(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    const input = this.#parse(query, true);
    return this.trackSearch('query', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        await this.searchLimit(p);
        const { filters: f } = input;
        const vis = await this.#visibility(tx, p, f);
        const resolved = await this.#resolve(tx, p, f, vis);
        const tsq = this.#tsquery(input.parsed.terms);
        const where = (skip?: 'kind' | 'brand') =>
          this.#where(tx.workspaceId, p, f, resolved, vis, tsq, skip);
        const cap = this.ws.searchCountMax;
        const reach = Math.max(this.ws.searchResultsMax - input.offset, 0);
        const limit = Math.min(input.limit, reach);

        const hits = (
          await sql<Hit>`
            SELECT e.source_kind, e.source_id, e.auth_record_id, e.context_record_id, e.title,
                   left(e.body, ${SNIPPET_SCAN_CHARS}) AS body, e.source_updated_at, r.brand_id,
                   r.lifecycle_state, ts_rank_cd(e.tsv, ${tsq}, 32)::float8 AS rank,
                   t.state AS task_state
              FROM search.entry e
              JOIN core.record r ON r.workspace_id = e.workspace_id AND r.id = e.auth_record_id
              LEFT JOIN search.index_task t ON t.workspace_id = e.workspace_id
                   AND t.source_kind = e.source_kind AND t.source_id = e.source_id
             WHERE ${where()}
             ORDER BY rank DESC, e.source_updated_at DESC, e.source_id
             LIMIT ${limit} OFFSET ${input.offset}`.execute(tx.db)
        ).rows;

        const counted = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM (
            SELECT 1 FROM search.entry e
              JOIN core.record r ON r.workspace_id = e.workspace_id AND r.id = e.auth_record_id
             WHERE ${where()} LIMIT ${cap + 1}) c`.execute(tx.db);
        const n = counted.rows[0]?.n ?? 0;

        const byKind = (
          await sql<{ k: string; n: number }>`
            SELECT c.k, count(*)::int AS n FROM (
              SELECT e.source_kind AS k FROM search.entry e
                JOIN core.record r ON r.workspace_id = e.workspace_id AND r.id = e.auth_record_id
               WHERE ${where('kind')} LIMIT ${cap}) c
             GROUP BY c.k`.execute(tx.db)
        ).rows;
        const byBrand = (
          await sql<{ b: string | null; n: number }>`
            SELECT c.b, count(*)::int AS n FROM (
              SELECT r.brand_id AS b FROM search.entry e
                JOIN core.record r ON r.workspace_id = e.workspace_id AND r.id = e.auth_record_id
               WHERE ${where('brand')} LIMIT ${cap}) c
             GROUP BY c.b`.execute(tx.db)
        ).rows;

        const results = await this.#present(tx, p, vis, hits, input);
        const brandRows = await readableBrandsByIds(
          tx,
          p,
          byBrand.flatMap((b) => (b.b ? [b.b] : [])),
        );
        const brandsById = new Map(brandRows.map((b) => [b.id, b]));
        const index = await this.#indexStatus(tx, vis);
        const total = Math.min(n, cap);
        return {
          query: {
            q: input.q,
            kind: f.kinds,
            brand: f.brands,
            project: f.project,
            state: f.state,
            updated: f.updated,
            mine: f.mine,
            mentioning_me: f.mentioningMe,
          },
          results,
          total,
          total_is_lower_bound: n > cap,
          facets: {
            kinds: this.#sources.all().flatMap((s) => {
              const c = byKind.find((k) => k.k === s.kind)?.n ?? 0;
              return c > 0 || f.kinds.includes(s.kind)
                ? [{ kind: s.kind, label: s.label, count: c }]
                : [];
            }),
            brands: byBrand
              .flatMap((b) => {
                if (!b.b) return [{ brand: { kind: 'workspace' as const }, count: b.n }];
                const row = brandsById.get(b.b);
                return row ? [{ brand: brandMarker(row), count: b.n }] : [];
              })
              .sort((a, b) => b.count - a.count),
          },
          page: {
            limit,
            offset: input.offset,
            has_more: input.offset + hits.length < Math.min(n, this.ws.searchResultsMax),
          },
          limits: { results_max: this.ws.searchResultsMax, count_max: cap },
          index,
        };
      }),
    );
  }

  /** Public identifiers, excerpts, brand markers, and (only where visible) the opening context. */
  async #present(
    tx: WorkspaceTransaction,
    p: Principal,
    vis: Awaited<ReturnType<typeof compileVisibility>>,
    hits: readonly Hit[],
    input: Parsed,
  ) {
    if (!hits.length) return [];
    const publicIds = new Map<string, Map<string, string>>();
    for (const s of this.#sources.all()) {
      const ids = hits.filter((h) => h.source_kind === s.kind).map((h) => h.source_id);
      if (ids.length) publicIds.set(s.kind, await s.publicIds(tx, ids));
    }
    const contextIds = [
      ...new Set(hits.flatMap((h) => (h.context_record_id ? [h.context_record_id] : []))),
    ];
    const hosts = new Map<
      string,
      { public_id: string; record_type: string; title: string | null }
    >();
    if (contextIds.length) {
      const rows = await sql<{ id: string; public_id: string; record_type: string }>`
        SELECT r.id, r.public_id, r.record_type FROM core.record r
         WHERE r.workspace_id = ${tx.workspaceId} AND r.id = ANY(${contextIds}::uuid[])
           AND ${vis.where('r')}`.execute(tx.db);
      const titles = await sql<{ source_kind: string; source_id: string; title: string }>`
        SELECT source_kind, source_id, title FROM search.entry
         WHERE workspace_id = ${tx.workspaceId} AND source_id = ANY(${contextIds}::uuid[])`.execute(
        tx.db,
      );
      const brandNames = await sql<{ id: string; name: string }>`
        SELECT id, name FROM tenancy.brand WHERE id = ANY(${contextIds}::uuid[])`.execute(tx.db);
      for (const r of rows.rows)
        hosts.set(r.id, {
          public_id: r.public_id,
          record_type: r.record_type,
          title:
            titles.rows.find((t) => t.source_id === r.id && t.source_kind === r.record_type)
              ?.title ??
            brandNames.rows.find((b) => b.id === r.id)?.name ??
            null,
        });
    }
    const brandIds = [...new Set(hits.flatMap((h) => (h.brand_id ? [h.brand_id] : [])))];
    const brands = new Map((await readableBrandsByIds(tx, p, brandIds)).map((b) => [b.id, b]));
    const out = [];
    for (const h of hits) {
      const id = publicIds.get(h.source_kind)?.get(h.source_id);
      if (!id) continue; // the row left while the page was read; never invent an identifier
      const host = h.context_record_id ? hosts.get(h.context_record_id) : undefined;
      const b = h.brand_id ? brands.get(h.brand_id) : undefined;
      const title: Snippet | null = makeSnippet(h.title, input.parsed.marks, 200);
      out.push({
        type: h.source_kind,
        id,
        title: h.title,
        title_parts: title?.parts ?? [{ text: h.title }],
        snippet: h.body
          ? makeSnippet(h.body, input.parsed.marks, this.ws.searchSnippetChars)
          : null,
        brand: b ? brandMarker(b) : ({ kind: h.brand_id ? 'unbranded' : 'workspace' } as const),
        host: host ? { type: host.record_type, id: host.public_id, title: host.title } : null,
        lifecycle_state: h.lifecycle_state,
        updated_at: iso(h.source_updated_at),
        index: (h.task_state === 'failed'
          ? 'failed'
          : h.task_state === 'pending'
            ? 'updating'
            : 'current') as SearchResultIndexState,
      });
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Index state: only what concerns records this person can see
  // ---------------------------------------------------------------------------------------------

  /**
   * How current the index is *for this person*: queued and failed keys of records they can read.
   * Counting only visible records means the figures cannot reveal that something hidden changed.
   */
  async #indexStatus(tx: WorkspaceTransaction, vis: Awaited<ReturnType<typeof compileVisibility>>) {
    const rows = (
      await sql<{ state: 'pending' | 'failed'; n: number; oldest: Date | null }>`
        SELECT t.state, count(*)::int AS n, min(t.requested_at) AS oldest
          FROM search.index_task t
          JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.auth_record_id
         WHERE t.workspace_id = ${tx.workspaceId} AND t.source_kind = ANY(${this.#sources.kinds()}::text[])
           AND ${vis.where('r')}
         GROUP BY t.state`.execute(tx.db)
    ).rows;
    const pending = rows.find((r) => r.state === 'pending');
    const failed = rows.find((r) => r.state === 'failed');
    const oldest = [pending?.oldest, failed?.oldest]
      .filter((d): d is Date => !!d)
      .map((d) => new Date(d).getTime())
      .sort((a, b) => a - b)[0];
    return {
      state: indexState(pending?.n ?? 0, failed?.n ?? 0),
      pending: pending?.n ?? 0,
      failed: failed?.n ?? 0,
      oldest_pending_seconds:
        oldest === undefined ? null : Math.max(Math.round((Date.now() - oldest) / 1000), 0),
    };
  }

  async searchStatus(caller: Caller, ws: unknown) {
    return this.trackSearch('status', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const vis = await compileVisibility(tx, p, {
          need: 'view',
          includeArchived: true,
          arrayMax: this.c.settings.principalContextArrayMax,
        });
        return {
          index: await this.#indexStatus(tx, vis),
          sources: this.#sources.all().map((s) => ({ kind: s.kind, label: s.label })),
          limits: {
            query_max_chars: this.ws.searchQueryMaxChars,
            page_size_max: this.ws.searchPageSizeMax,
            results_max: this.ws.searchResultsMax,
            count_max: this.ws.searchCountMax,
          },
        };
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Opening a result: the access is checked again, here, and never widened
  // ---------------------------------------------------------------------------------------------

  /**
   * Resolves a result to what opens it, after the same predicate as search, with the source's own
   * live state. A record that is hidden, deleted, purged, or unknown is one `not_found` produced by
   * the same statements, so opening cannot tell the cases apart.
   */
  async openResult(caller: Caller, ws: unknown, body: unknown) {
    const b = isObj(body) ? body : {};
    const source: SearchSource | undefined =
      typeof b.type === 'string' ? this.#sources.get(b.type) : undefined;
    return this.trackSearch('open', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        await this.searchLimit(p);
        const vis = await compileVisibility(tx, p, {
          need: 'view',
          includeArchived: true,
          arrayMax: this.c.settings.principalContextArrayMax,
        });
        const found = source && typeof b.id === 'string' ? await source.resolve(tx, b.id) : null;
        const live = source?.live?.('e', ['active', 'archived']);
        const row = (
          await sql<{
            id: string;
            public_id: string;
            record_type: string;
            brand_id: string | null;
            lifecycle_state: 'active' | 'archived';
          }>`
            SELECT r.id, r.public_id, r.record_type, r.brand_id, r.lifecycle_state
              FROM core.record r
             WHERE r.workspace_id = ${tx.workspaceId} AND r.id = ${found?.authRecordId ?? NIL}
               AND ${vis.where('r')}
               ${
                 live && found
                   ? sql`AND EXISTS (SELECT 1 FROM (SELECT ${tx.workspaceId}::uuid AS workspace_id,
                           ${found.id}::uuid AS source_id) e WHERE ${live})`
                   : sql``
               }`.execute(tx.db)
        ).rows[0];
        if (!row || !found || !source) throw new TenancyError('not_found');
        const context =
          found.contextRecordId && found.contextRecordId !== row.id
            ? (
                await sql<{ public_id: string; record_type: string }>`
                  SELECT r.public_id, r.record_type FROM core.record r
                   WHERE r.workspace_id = ${tx.workspaceId} AND r.id = ${found.contextRecordId}
                     AND ${vis.where('r')}`.execute(tx.db)
              ).rows[0]
            : undefined;
        const host =
          found.contextRecordId === row.id
            ? { type: row.record_type, id: row.public_id }
            : context
              ? { type: context.record_type, id: context.public_id }
              : null;
        return {
          result: { type: source.kind, id: b.id as string },
          host,
          lifecycle_state: row.lifecycle_state,
        };
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Recent searches: the person's own typed queries, bounded and erasable
  // ---------------------------------------------------------------------------------------------

  #handle(key: string): string {
    return createHash('sha256').update(key).digest('base64url').slice(0, 22);
  }

  #canonical(f: SearchFilters) {
    const out: Record<string, unknown> = {};
    if (f.kinds.length) out.kind = [...f.kinds].sort();
    if (f.brands.length) out.brand = [...f.brands].sort();
    if (f.project) out.project = f.project;
    if (f.state !== 'active') out.state = f.state;
    if (f.updated) out.updated = f.updated;
    if (f.mine) out.mine = true;
    if (f.mentioningMe) out.mentioning_me = true;
    return out;
  }

  /**
   * Remembers a submitted search for the person (typing never does). The query must be a valid
   * one and its filters must name places the person can see now; what is stored is the person's
   * own words, never results.
   */
  async recordRecentSearch(caller: Caller, ws: unknown, body: unknown) {
    const b = isObj(body) ? body : {};
    const input = this.#parse({ ...(isObj(b.filters) ? b.filters : {}), q: b.q }, false);
    return this.trackSearch('recent_add', () =>
      this.inWorkspace(caller, ws, {}, async (tx, p) => {
        await this.searchLimit(p);
        const vis = await this.#visibility(tx, p, input.filters);
        await this.#resolve(tx, p, input.filters, vis);
        const filters = this.#canonical(input.filters);
        const key = `${input.q.toLowerCase()}|${JSON.stringify(filters)}`;
        if (key.length > 300)
          throw invalid(issue('/q', 'too_long', 'That search is too long to remember.'));
        await sql`INSERT INTO search.recent_query (id, workspace_id, owner_membership_id, query, filters, query_key)
            VALUES (${newUuidV7()}, ${tx.workspaceId}, ${p.membershipId}, ${input.q},
                    ${JSON.stringify(filters)}::jsonb, ${key})
            ON CONFLICT (workspace_id, owner_membership_id, query_key) DO UPDATE
              SET search_count = search.recent_query.search_count + 1, searched_at = now(),
                  query = EXCLUDED.query`.execute(tx.db);
        // Keep the newest SEARCH_RECENT_MAX; the rest leave with this write.
        await sql`DELETE FROM search.recent_query WHERE id IN (
            SELECT id FROM search.recent_query
             WHERE workspace_id = ${tx.workspaceId} AND owner_membership_id = ${p.membershipId}
             ORDER BY searched_at DESC, id DESC OFFSET ${this.ws.searchRecentMax})`.execute(tx.db);
        return { remembered: true };
      }),
    );
  }

  /**
   * The person's recent searches, newest first. Each filter that names a brand or project is
   * checked again: a search that points at a place the person can no longer see is left out, so a
   * recent search never reveals what access has since removed.
   */
  async listRecentSearches(caller: Caller, ws: unknown) {
    return this.trackSearch('recent_list', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const rows = (
          await sql<{
            query: string;
            filters: Record<string, unknown>;
            query_key: string;
            search_count: number;
            searched_at: Date;
          }>`SELECT query, filters, query_key, search_count, searched_at FROM search.recent_query
              WHERE workspace_id = ${tx.workspaceId} AND owner_membership_id = ${p.membershipId}
              ORDER BY searched_at DESC, id DESC LIMIT ${this.ws.searchRecentMax}`.execute(tx.db)
        ).rows;
        const vis = await compileVisibility(tx, p, {
          need: 'view',
          includeArchived: true,
          arrayMax: this.c.settings.principalContextArrayMax,
        });
        const out = [];
        for (const r of rows) {
          const f = this.#filters(r.filters);
          try {
            await this.#resolve(tx, p, f, vis);
          } catch (err) {
            if (err instanceof TenancyError) continue;
            throw err;
          }
          out.push({
            handle: this.#handle(r.query_key),
            q: r.query,
            filters: r.filters,
            count: r.search_count,
            searched_at: iso(r.searched_at),
          });
        }
        return out;
      }),
    );
  }

  /** Forgets one recent search (by its handle) or, with none, all of the person's. */
  async clearRecentSearches(caller: Caller, ws: unknown, handle?: string) {
    return this.trackSearch('recent_clear', () =>
      this.inWorkspace(caller, ws, {}, async (tx, p) => {
        const mine = await sql<{ id: string; query_key: string }>`
          SELECT id, query_key FROM search.recent_query
           WHERE workspace_id = ${tx.workspaceId} AND owner_membership_id = ${p.membershipId}`.execute(
          tx.db,
        );
        const ids =
          handle === undefined
            ? mine.rows.map((r) => r.id)
            : mine.rows.filter((r) => this.#handle(r.query_key) === handle).map((r) => r.id);
        if (handle !== undefined && !ids.length) throw new TenancyError('not_found');
        if (ids.length)
          await sql`DELETE FROM search.recent_query WHERE workspace_id = ${tx.workspaceId}
              AND owner_membership_id = ${p.membershipId} AND id = ANY(${ids}::uuid[])`.execute(
            tx.db,
          );
        return { cleared: ids.length };
      }),
    );
  }
}
