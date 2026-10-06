import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { change } from '@pm/audit';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import { sql, type RawBuilder, type WorkspaceTransaction } from '@pm/db';
import { writeOutboxEvent } from '@pm/platform';
import {
  brandLevel,
  compileVisibility,
  decideBrand,
  decidePersonal,
  decideProject,
  decideWorkspace,
  findBrand,
  invalid,
  issueSavedViewLifecycleDecision,
  issue,
  levelRank,
  parseIfMatch,
  requireVersion,
  TenancyError,
  type BrandFacts,
  type Caller,
  type Mutation,
  type Principal,
} from '@pm/tenancy';
import { CaptureService } from '../capture-service.ts';
import type { WorkDeps } from '../service.ts';
import { isPublic } from '../validation.ts';
import {
  platformStatus,
  platformStatuses,
  primeStatuses,
  statusRef,
  statusView,
} from '../workflow/statuses.ts';
import {
  after,
  Compiler,
  orderBy,
  orderKeys,
  type CursorKey,
  type OrderKey,
  type Resolved,
  type UsableField,
} from './compile.ts';
import {
  CATALOG,
  conditions,
  customFields,
  customKind,
  DEFAULT_COLUMNS,
  fieldSpec,
  isCustom,
  isGroup,
  parsePresentation,
  parseQuery,
  REF_PREFIX,
  serializeQuery,
  typeCustomCondition,
  type Condition,
  type Entity,
  type Group,
  type Presentation,
  type Query,
  type QueryBounds,
  type RefKind,
} from './query.ts';

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const NIL = '00000000-0000-7000-8000-000000000000';
const hash = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
/** People fields need the member directory; guests never see assignees or owners (0C AZ-06). */
const PEOPLE = new Set(['owner', 'assignee', 'assigned_by']);

export type ShareScope = 'workspace' | 'brand' | 'project';

interface ViewRow {
  id: string;
  public_id: string;
  entity: Entity;
  name: string;
  description: string;
  owner_membership_id: string;
  owner_public_id: string;
  visibility: 'personal' | 'shared';
  share_scope: ShareScope | null;
  share_brand_id: string | null;
  share_project_id: string | null;
  query: Record<string, unknown>;
  presentation: Record<string, unknown>;
  layout: string;
  created_at: Date;
  updated_at: Date;
  version: string | number;
}

interface LoadedView {
  row: ViewRow;
  /** The caller may read (run, favorite, pin) the view. */
  read: boolean;
  /** The caller may change the definition, share, unshare, or delete it. */
  manage: boolean;
  scopeBrand: (BrandFacts & { publicId: string; name: string }) | null;
  scopeProject: { id: string; publicId: string; name: string } | null;
}

export interface QueryResult {
  data: Record<string, unknown>[];
  page: {
    limit: number;
    has_more: boolean;
    next_cursor?: string;
    total?: { value: number; capped: boolean; estimated: false };
  };
  groups?: Array<{ key: string | null; label: string; count: number }>;
  groups_truncated?: boolean;
  columns: Array<{ field: string; label: string }>;
  /** Labels of the filter values the viewer can read (unreadable and unknown are both absent). */
  refs: Record<string, string>;
}

/**
 * Phase 3A reusable query and saved-view engine (ADR-0018; 0B ADR-26; 0C AZ-26; 0D PL-28). One
 * canonical query AST and compiler serve every list, export, saved view, default, and pin. The
 * viewer's own visibility predicate is always added by the engine: views and shares never widen
 * record access, and hidden records never change counts, groups, cursors, exports, or metadata.
 */
export class ViewService extends CaptureService {
  readonly #cursorKey: Buffer;

  constructor(deps: WorkDeps) {
    super(deps);
    this.#cursorKey = createHmac('sha256', deps.signingKey).update('cursor:views.query').digest();
  }

  protected get queryBounds(): QueryBounds {
    return {
      conditionsMax: this.ws.queryConditionsMax,
      depthMax: this.ws.queryDepthMax,
      sortsMax: this.ws.querySortsMax,
      valuesMax: this.ws.queryValuesMax,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Resolution: values and custom fields, among what the viewer can read only
  // ---------------------------------------------------------------------------------------------

  /**
   * Resolves every reference value in the query. One statement per referenced kind, chosen from
   * the query's structure only: a hidden value and an unknown one run the same statements and both
   * resolve to nothing (AT-026; constant shape).
   */
  protected async resolveRefs(
    tx: WorkspaceTransaction,
    p: Principal,
    q: Query,
    fields: Map<string, UsableField>,
    vis: Awaited<ReturnType<typeof compileVisibility>>,
    extraBrands: string[],
  ): Promise<{ refs: Map<string, string>; labels: Map<string, string> }> {
    const want = new Map<RefKind | 'option', Set<string>>();
    const add = (k: RefKind | 'option', v: string) => {
      if (!want.has(k)) want.set(k, new Set());
      want.get(k)!.add(v);
    };
    for (const c of conditions(q)) {
      if (!c.values.length || typeof c.values[0] !== 'string') continue;
      const kind: RefKind | 'option' | null = isCustom(c.field)
        ? (({ select: 'option', person: 'member', label: 'label' } as const)[
            fields.get(c.field)!.type as 'select'
          ] ?? null)
        : (fieldSpec(q.entity, c.field)?.ref ?? null);
      if (!kind) continue;
      for (const v of c.values as string[]) add(kind, v);
    }
    for (const b of extraBrands) add('brand', b);
    const refs = new Map<string, string>();
    const labels = new Map<string, string>();
    const put = (rows: Array<{ k: string; id: string; label: string }>) =>
      rows.forEach((r) => {
        refs.set(r.k, r.id);
        labels.set(r.k, r.label);
      });
    if (want.has('member')) {
      const vals = [...want.get('member')!];
      if (vals.includes('me')) {
        refs.set('me', p.membershipId);
        labels.set('me', 'Me');
      }
      put(
        (
          await sql<{ k: string; id: string; label: string }>`SELECT m.public_id AS k, m.id,
            acc.display_name AS label FROM tenancy.membership m JOIN identity.account acc ON acc.id = m.account_id
            WHERE m.workspace_id = ${tx.workspaceId} AND m.public_id = ANY(${vals}::text[])`.execute(
            tx.db,
          )
        ).rows,
      );
    }
    if (want.has('brand'))
      put(
        (
          await sql<{
            k: string;
            id: string;
            label: string;
          }>`SELECT r.public_id AS k, b.id, b.name AS label
            FROM core.record r JOIN tenancy.brand b ON b.workspace_id = r.workspace_id AND b.id = r.id
            WHERE r.workspace_id = ${tx.workspaceId} AND r.record_type = 'brand'
              AND r.public_id = ANY(${[...want.get('brand')!]}::text[])
              AND b.id = ANY(${vis.ctx.brandIds.length ? vis.ctx.brandIds : [NIL]}::uuid[])`.execute(
            tx.db,
          )
        ).rows,
      );
    if (want.has('project'))
      put(
        (
          await sql<{
            k: string;
            id: string;
            label: string;
          }>`SELECT pr.public_id AS k, w.id, w.name AS label
            FROM core.record pr JOIN work.project w ON w.workspace_id = pr.workspace_id AND w.id = pr.id
            WHERE pr.workspace_id = ${tx.workspaceId} AND pr.record_type = 'project'
              AND pr.public_id = ANY(${[...want.get('project')!]}::text[])
              AND ${vis.where('pr', { project: sql`w.id` })}`.execute(tx.db)
        ).rows,
      );
    if (want.has('label'))
      put(
        (
          await sql<{
            k: string;
            id: string;
            label: string;
          }>`SELECT l.public_id AS k, l.id, l.name AS label
            FROM work.label l WHERE l.workspace_id = ${tx.workspaceId}
              AND l.public_id = ANY(${[...want.get('label')!]}::text[])
              AND l.brand_id = ANY(${vis.ctx.brandIds.length ? vis.ctx.brandIds : [NIL]}::uuid[])`.execute(
            tx.db,
          )
        ).rows,
      );
    if (want.has('milestone'))
      put(
        (
          await sql<{
            k: string;
            id: string;
            label: string;
          }>`SELECT mr.public_id AS k, m.id, m.name AS label
            FROM core.record mr JOIN work.milestone m ON m.workspace_id = mr.workspace_id AND m.id = mr.id
            WHERE mr.workspace_id = ${tx.workspaceId} AND mr.record_type = 'milestone'
              AND mr.public_id = ANY(${[...want.get('milestone')!]}::text[])
              AND ${vis.where('mr', { project: sql`m.project_id` })}`.execute(tx.db)
        ).rows,
      );
    if (want.has('status')) {
      const vals = [...want.get('status')!];
      for (const v of vals) {
        const s = platformStatus(q.entity, v);
        if (s) {
          refs.set(v, s.id);
          labels.set(v, s.name);
        }
      }
      const custom = vals.filter((v) => v.startsWith('sts_'));
      put(
        (
          await sql<{
            k: string;
            id: string;
            label: string;
          }>`SELECT s.public_id AS k, s.id, s.name AS label
            FROM workflow.workflow_status s JOIN workflow.workflow wf ON wf.workspace_id = s.workspace_id AND wf.id = s.workflow_id
            WHERE s.workspace_id = ${tx.workspaceId} AND s.public_id = ANY(${custom}::text[])
              AND wf.record_kind = ${q.entity}
              AND (wf.brand_id IS NULL OR wf.brand_id = ANY(${vis.ctx.brandIds.length ? vis.ctx.brandIds : [NIL]}::uuid[]))
              AND (wf.project_id IS NULL OR EXISTS (SELECT 1 FROM core.record pr WHERE pr.workspace_id = wf.workspace_id
                AND pr.id = wf.project_id AND ${vis.where('pr', { project: sql`pr.id` })}))`.execute(
            tx.db,
          )
        ).rows,
      );
    }
    if (want.has('option')) {
      const defs = [...fields.values()].filter((f) => f.type === 'select').map((f) => f.id);
      put(
        (
          await sql<{ k: string; id: string; label: string }>`SELECT o.public_id AS k, o.id, o.label
            FROM workflow.field_option o WHERE o.workspace_id = ${tx.workspaceId}
              AND o.public_id = ANY(${[...want.get('option')!]}::text[])
              AND o.definition_id = ANY(${defs.length ? defs : [NIL]}::uuid[])`.execute(tx.db)
        ).rows,
      );
    }
    // Agents (7A) do not exist yet: agent values never resolve and the filter is exact.
    return { refs, labels };
  }

  /**
   * The custom fields the query names, usable by this viewer: active, applicable to the entity,
   * defined in a scope the viewer can read, `all_readers` (and guest-visible for guests) through
   * every formula input. Anything else is `unsupported_field`, exactly like an unknown field
   * (ADR-0018 Q5; one statement whatever the definitions are).
   */
  protected async usableFields(
    tx: WorkspaceTransaction,
    p: Principal,
    entity: Entity,
    names: string[],
    vis: Awaited<ReturnType<typeof compileVisibility>>,
  ): Promise<Map<string, UsableField>> {
    const out = new Map<string, UsableField>();
    if (!names.length) return out;
    const pubs = names.map((n) => n.slice('field:'.length));
    const rows = (
      await sql<{
        id: string;
        public_id: string;
        name: string;
        field_type: string;
        result_type: string | null;
        open: boolean;
        guest_ok: boolean;
      }>`WITH RECURSIVE closure(root, id) AS (
          SELECT d.id, d.id FROM workflow.field_definition d
          WHERE d.workspace_id = ${tx.workspaceId} AND d.public_id = ANY(${pubs}::text[])
          UNION
          SELECT c.root, fd.depends_on_definition_id FROM closure c
          JOIN workflow.formula_dependency fd ON fd.workspace_id = ${tx.workspaceId} AND fd.definition_id = c.id
        ), policy AS (
          SELECT c.root, bool_and(coalesce(fp.read_rule, 'all_readers') = 'all_readers') AS open,
            bool_and(coalesce(fp.guest_visible, false)) AS guest_ok
          FROM closure c LEFT JOIN access.field_policy fp ON fp.workspace_id = ${tx.workspaceId} AND fp.definition_id = c.id
          GROUP BY c.root
        )
        SELECT d.id, d.public_id, d.name, d.field_type, d.result_type, pol.open, pol.guest_ok
        FROM workflow.field_definition d JOIN policy pol ON pol.root = d.id
        WHERE d.state = 'active'
          AND (${entity === 'task' ? sql`d.applies_to_task` : sql`d.applies_to_project`})
          AND (d.brand_id IS NULL OR d.brand_id = ANY(${vis.ctx.brandIds.length ? vis.ctx.brandIds : [NIL]}::uuid[]))
          AND (d.project_id IS NULL OR EXISTS (SELECT 1 FROM core.record pr WHERE pr.workspace_id = d.workspace_id
            AND pr.id = d.project_id AND ${vis.where('pr', { project: sql`pr.id` })}))`.execute(
        tx.db,
      )
    ).rows;
    for (const r of rows) {
      if (!r.open || (p.kind === 'guest' && !r.guest_ok)) continue;
      const type = r.field_type === 'formula' ? (r.result_type ?? '') : r.field_type;
      const kind = customKind(type);
      if (!kind) continue;
      out.set(`field:${r.public_id}`, {
        id: r.id,
        publicId: r.public_id,
        name: r.name,
        type,
        kind,
      });
    }
    return out;
  }

  /** Fails closed on fields the viewer may not use (unknown and unreadable are identical). */
  protected checkFields(
    p: Principal,
    q: Query,
    pres: Presentation,
    fields: Map<string, UsableField>,
  ): Query {
    const issues: ReturnType<typeof issue>[] = [];
    const usable = (f: string) =>
      isCustom(f) ? fields.has(f) : !(p.kind === 'guest' && PEOPLE.has(f));
    const walk = (g: Group, path: string): Group => ({
      op: g.op,
      items: g.items.map((n, i) => {
        const at = `${path}/items/${i}`;
        if (isGroup(n)) return walk(n, at);
        if (!usable(n.field)) {
          issues.push(issue(`${at}/field`, 'unsupported_field', 'This field is not available.'));
          return n;
        }
        if (isCustom(n.field)) {
          const fd = fields.get(n.field)!;
          const c = typeCustomCondition(n, fd.kind, at, this.queryBounds);
          // Reference values must carry the field's own kind of ID.
          if (fd.kind === 'ref') {
            const prefix =
              fd.type === 'select' ? 'fop' : fd.type === 'person' ? 'mem' : REF_PREFIX.label;
            (c.values as string[]).forEach((v, j) => {
              if (!(v.startsWith(`${prefix}_`) || (fd.type === 'person' && v === 'me')))
                issues.push(issue(`${at}/value/${j}`, 'invalid', 'This value is not valid.'));
            });
          }
          return c;
        }
        return n;
      }),
    });
    const filter = q.filter ? walk(q.filter, '/query/filter') : null;
    q.sort.forEach((s, i) => {
      if (!usable(s.field))
        issues.push(
          issue(`/query/sort/${i}/field`, 'unsupported_field', 'This field is not available.'),
        );
      else if (
        isCustom(s.field) &&
        fields.get(s.field)!.kind === 'ref' &&
        fields.get(s.field)!.type !== 'select'
      )
        issues.push(
          issue(`/query/sort/${i}/field`, 'unsupported_field', 'This field cannot be sorted.'),
        );
    });
    if (q.group && !usable(q.group.field))
      issues.push(issue('/query/group/field', 'unsupported_field', 'This field is not available.'));
    pres.columns.forEach((c, i) => {
      if (!usable(c))
        issues.push(
          issue(`/presentation/columns/${i}`, 'unsupported_field', 'This column is not available.'),
        );
    });
    if (issues.length) throw invalid(...issues);
    return { ...q, filter };
  }

  // ---------------------------------------------------------------------------------------------
  // Cursors (0D §2.5): opaque, MAC-bound to workspace, principal, and query fingerprint
  // ---------------------------------------------------------------------------------------------

  protected fingerprint(q: Query, scope: string[]): string {
    return createHash('sha256')
      .update(JSON.stringify([q.entity, q.filter, q.sort, q.group, [...scope].sort()]))
      .digest('base64url');
  }

  protected mac(p: Principal, fp: string, payload: string): Buffer {
    return createHmac('sha256', this.#cursorKey)
      .update(`${p.workspaceId}|${p.membershipId}|${fp}|${payload}`)
      .digest()
      .subarray(0, 16);
  }

  protected encodeCursor(p: Principal, fp: string, keys: CursorKey[], id: string): string {
    const payload = JSON.stringify({ k: keys, i: id });
    const m = this.mac(p, fp, payload).toString('base64url');
    return Buffer.from(JSON.stringify({ p: payload, m })).toString('base64url');
  }

  protected decodeCursor(
    p: Principal,
    fp: string,
    raw: unknown,
    keys: OrderKey[],
  ): { k: CursorKey[]; i: string } {
    try {
      if (typeof raw !== 'string' || raw.length > 4096) throw new Error();
      const outer = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
        p: string;
        m: string;
      };
      const want = this.mac(p, fp, outer.p);
      const got = Buffer.from(outer.m, 'base64url');
      if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error();
      const c = JSON.parse(outer.p) as { k: CursorKey[]; i: string };
      if (!Array.isArray(c.k) || c.k.length !== keys.length || !/^[0-9a-f-]{36}$/.test(c.i))
        throw new Error();
      return c;
    } catch {
      throw new TenancyError('cursor_invalid');
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Running a query
  // ---------------------------------------------------------------------------------------------

  protected todayOf(raw: unknown): string {
    return this.today(typeof raw === 'string' && ISO_DAY.test(raw) ? raw : undefined);
  }

  /** The authorized FROM/WHERE for an entity (rows active and readable; joins for readable refs). */
  protected from(
    entity: Entity,
    vis: Awaited<ReturnType<typeof compileVisibility>>,
    refVis: Awaited<ReturnType<typeof compileVisibility>>,
  ): RawBuilder<unknown> {
    return entity === 'task'
      ? sql`FROM core.record r
          JOIN work.task t ON t.workspace_id = r.workspace_id AND t.id = r.id
          JOIN tenancy.brand b ON b.workspace_id = t.workspace_id AND b.id = t.brand_id
          JOIN core.record br ON br.workspace_id = b.workspace_id AND br.id = b.id
          LEFT JOIN LATERAL (SELECT pr.id, pr.public_id FROM core.record pr
            WHERE pr.workspace_id = t.workspace_id AND pr.id = t.project_id
              AND ${refVis.where('pr', { project: sql`pr.id` })}) rp ON true
          LEFT JOIN work.project pw ON pw.workspace_id = t.workspace_id AND pw.id = rp.id
          WHERE r.record_type = 'task' AND r.lifecycle_state = 'active'
            AND ${vis.where('r', { project: sql`t.project_id` })}`
      : sql`FROM core.record r
          JOIN work.project w ON w.workspace_id = r.workspace_id AND w.id = r.id
          JOIN tenancy.brand b ON b.workspace_id = w.workspace_id AND b.id = w.brand_id
          JOIN core.record br ON br.workspace_id = b.workspace_id AND br.id = b.id
          LEFT JOIN LATERAL (SELECT pr.id, pr.public_id FROM core.record pr
            WHERE pr.workspace_id = w.workspace_id AND pr.id = w.parent_project_id
              AND ${refVis.where('pr', { project: sql`pr.id` })}) pp ON true
          WHERE r.record_type = 'project' AND r.lifecycle_state = 'active'
            AND ${vis.where('r', { project: sql`w.id` })}`;
  }

  /**
   * Runs a query for one viewer: validation, resolution, totals, groups, one keyset page, and
   * row hydration. Statements depend only on the query's structure and the visible rows.
   */
  protected async runQuery(
    tx: WorkspaceTransaction,
    p: Principal,
    raw: { query: unknown; presentation?: unknown; scope?: unknown; today?: unknown },
    opts: {
      entity?: Entity;
      limit: number;
      cursor?: unknown;
      includeTotal: boolean;
      groups: boolean;
      /** Diagnostics only (never routed): return the plan of the rows statement instead. */
      explain?: boolean;
    },
  ): Promise<QueryResult & { plan?: unknown }> {
    let q = parseQuery(raw.query, this.queryBounds, opts.entity);
    const pres = this.presentationFor(p, raw.presentation, q.entity);
    const scope = this.parseScope(raw.scope);
    const vis = await compileVisibility(tx, p, {
      need: 'view',
      includeArchived: false,
      arrayMax: this.c.settings.principalContextArrayMax,
    });
    const refVis = await compileVisibility(tx, p, {
      need: 'view',
      includeArchived: true,
      arrayMax: this.c.settings.principalContextArrayMax,
      brands: [...vis.ctx.brands],
    });
    const named = new Set(customFields(q));
    pres.columns.filter(isCustom).forEach((c) => named.add(c));
    const fields = await this.usableFields(tx, p, q.entity, [...named].sort(), refVis);
    q = this.checkFields(p, q, pres, fields);
    const { refs, labels } = await this.resolveRefs(tx, p, q, fields, refVis, scope);
    const resolved: Resolved = { refs, fields, me: p.membershipId, today: this.todayOf(raw.today) };
    const c = new Compiler(q.entity, resolved, p.kind === 'member', (alias, project) =>
      refVis.where(alias, { project }),
    );
    const e = q.entity === 'task' ? sql.raw('t') : sql.raw('w');
    // Brand scope (WSB-019): narrowed to readable brands, never broadened.
    const scopeIds = scope.map((s) => refs.get(s)).filter((x): x is string => !!x);
    const scoped = scope.length
      ? sql<boolean>`${e}.brand_id = ANY(${scopeIds.length ? scopeIds : [NIL]}::uuid[])`
      : sql<boolean>`true`;
    const where = sql`${this.from(q.entity, vis, refVis)} AND ${scoped} AND ${c.filter(q.filter)}`;
    const keys = orderKeys(c, q);
    const groupValue = q.group ? c.groupValue(q.group.field, q.group.granularity) : null;
    const fp = this.fingerprint(q, scope);
    const cur = opts.cursor ? this.decodeCursor(p, fp, opts.cursor, keys) : null;

    let total: QueryResult['page']['total'];
    if (opts.includeTotal) {
      const cap = this.ws.totalCountCap;
      const n = Number(
        (
          await sql<{
            n: string;
          }>`SELECT count(*) AS n FROM (SELECT 1 ${where} LIMIT ${cap + 1}) x`.execute(tx.db)
        ).rows[0]!.n,
      );
      total = { value: Math.min(n, cap), capped: n > cap, estimated: false };
    }

    let groups: QueryResult['groups'];
    let groupsTruncated = false;
    if (q.group && opts.groups && !cur) {
      const g = keys[0]!;
      const max = this.ws.queryGroupsMax;
      const rows = (
        await sql<{
          v: unknown;
          n: string;
          label: string | null;
        }>`SELECT x.v, count(*) AS n, min(x.label) AS label
          FROM (SELECT ${groupValue} AS v, ${g.expr} AS k, ${this.groupLabel(c, q)} AS label ${where}) x
          GROUP BY x.v, x.k ORDER BY (x.k IS NULL), x.k, x.v LIMIT ${max + 1}`.execute(tx.db)
      ).rows;
      groupsTruncated = rows.length > max;
      groups = rows.slice(0, max).map((r) => ({
        key: r.v === null ? null : this.keyString(r.v),
        label: r.v === null ? this.emptyLabel(q.group!.field) : (r.label ?? this.keyString(r.v)),
        count: Number(r.n),
      }));
    }

    const keySelect = keys.map((k, i) => sql`${k.expr} AS ${sql.ref(`k${i}`)}`);
    const statement = sql<Record<string, unknown>>`SELECT r.id, r.public_id, ${sql.join(keySelect)},
          ${groupValue ?? sql`NULL`} AS g, ${this.rowColumns(q.entity)}
        ${where} ${cur ? sql`AND ${after(keys, cur.k, cur.i)}` : sql``}
        ORDER BY ${orderBy(keys)} LIMIT ${opts.limit + 1}`;
    if (opts.explain) {
      const plan = (
        await sql<{ 'QUERY PLAN': unknown }>`EXPLAIN (FORMAT JSON) ${statement}`.execute(tx.db)
      ).rows[0]!['QUERY PLAN'];
      return {
        data: [],
        page: { limit: opts.limit, has_more: false },
        columns: [],
        refs: {},
        plan,
      };
    }
    const rows = (await statement.execute(tx.db)).rows;
    const page = rows.slice(0, opts.limit);
    const hasMore = rows.length > opts.limit;
    let next: string | undefined;
    if (hasMore) {
      const last = page[page.length - 1]!;
      next = this.encodeCursor(
        p,
        fp,
        keys.map((_, i) => this.cursorValue(last[`k${i}`])),
        last.id as string,
      );
    }
    const data = await this.hydrate(tx, p, q, pres, fields, page);
    const refsOut: Record<string, string> = {};
    for (const [k, v] of labels) refsOut[k] = v;
    return {
      data,
      page: {
        limit: opts.limit,
        has_more: hasMore,
        ...(next ? { next_cursor: next } : {}),
        ...(total ? { total } : {}),
      },
      ...(groups ? { groups, ...(groupsTruncated ? { groups_truncated: true } : {}) } : {}),
      columns: pres.columns.map((f) => ({
        field: f,
        label: this.columnLabel(q.entity, f, fields),
      })),
      refs: refsOut,
    };
  }

  /** Default columns leave out people fields for guests; chosen columns are checked as given. */
  protected presentationFor(p: Principal, raw: unknown, entity: Entity): Presentation {
    const pres = parsePresentation(raw, entity, this.ws.viewColumnsMax);
    const chosen = isObj(raw) && raw.columns !== undefined;
    return p.kind === 'guest' && !chosen
      ? { ...pres, columns: pres.columns.filter((c) => !PEOPLE.has(c)) }
      : pres;
  }

  protected parseScope(raw: unknown): string[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > 50 || raw.some((b) => !isPublic(b, 'br')))
      throw invalid(issue('/scope', 'invalid', 'Choose up to 50 brands.'));
    return [...new Set(raw as string[])];
  }

  protected keyString(v: unknown): string {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v);
  }

  protected cursorValue(v: unknown): CursorKey {
    if (v === null || v === undefined) return [true, null];
    if (v instanceof Date) return [false, v.toISOString()];
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return [false, v];
    return [false, String(v)];
  }

  protected emptyLabel(field: string): string {
    switch (field) {
      case 'project':
        return 'No project';
      case 'owner':
      case 'assignee':
        return 'No owner';
      case 'milestone':
        return 'No milestone';
      case 'health':
        return 'No health';
      default:
        return 'None';
    }
  }

  /** A per-row label for the group value (resolved in the group statement itself). */
  protected groupLabel(c: Compiler, q: Query): RawBuilder<unknown> {
    const f = q.group!.field;
    const v = c.groupValue(f, q.group!.granularity);
    switch (f) {
      case 'brand':
        return sql`b.name`;
      case 'project':
        return q.entity === 'task' ? sql`pw.name` : sql`NULL`;
      case 'owner':
      case 'assignee':
        return sql`(SELECT acc.display_name FROM tenancy.membership m JOIN identity.account acc ON acc.id = m.account_id WHERE m.id = ${v})`;
      case 'milestone':
        return sql`(SELECT m.name FROM work.milestone m WHERE m.id = ${v})`;
      case 'status':
        return sql`coalesce((SELECT s.name FROM workflow.platform_status s WHERE s.id = ${v}),
          (SELECT s.name FROM workflow.workflow_status s WHERE s.id = ${v}))`;
      case 'priority':
        return sql`initcap(${v}::text)`;
      case 'health':
        return sql`replace(initcap(${v}::text), '_', ' ')`;
      case 'status_category':
        return sql`initcap(${v}::text)`;
    }
    if (isCustom(f)) {
      const fd = c.r.fields.get(f)!;
      if (fd.type === 'select')
        return sql`(SELECT o.label FROM workflow.field_option o WHERE o.id = ${v})`;
      if (fd.type === 'person')
        return sql`(SELECT acc.display_name FROM tenancy.membership m JOIN identity.account acc ON acc.id = m.account_id WHERE m.id = ${v})`;
      if (fd.type === 'label') return sql`(SELECT l.name FROM work.label l WHERE l.id = ${v})`;
      if (fd.kind === 'bool') return sql`CASE WHEN ${v} THEN 'Yes' ELSE 'No' END`;
    }
    return sql`(${v})::text`;
  }

  protected columnLabel(entity: Entity, f: string, fields: Map<string, UsableField>): string {
    return isCustom(f) ? fields.get(f)!.name : (CATALOG[entity][f]?.label ?? f);
  }

  protected rowColumns(entity: Entity): RawBuilder<unknown> {
    return entity === 'task'
      ? sql`t.title AS title, t.status_id, t.priority, t.start_date, t.due_date, t.deadline_date,
          t.estimate_minutes, t.created_at, t.updated_at, t.completed_at, t.version, t.brand_id,
          br.public_id AS brand_public_id, b.name AS brand_name, b.short_name AS brand_short_name,
          b.color AS brand_color, b.icon AS brand_icon, b.lifecycle_state AS brand_state,
          rp.public_id AS project_public_id, pw.name AS project_name, pw.health AS health,
          rp.id AS readable_project_id`
      : sql`w.name AS title, w.status_id, w.priority, w.start_date, w.target_date, w.deadline_date,
          w.created_at, w.updated_at, w.completed_at, w.version, w.brand_id, w.health,
          w.owner_membership_id, br.public_id AS brand_public_id, b.name AS brand_name,
          b.short_name AS brand_short_name, b.color AS brand_color, b.icon AS brand_icon,
          b.lifecycle_state AS brand_state, pp.public_id AS parent_public_id, w.id AS readable_project_id`;
  }

  /** Row views: core facts plus the requested columns (people for members only; usable fields). */
  protected async hydrate(
    tx: WorkspaceTransaction,
    p: Principal,
    q: Query,
    pres: Presentation,
    fields: Map<string, UsableField>,
    rows: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id as string);
    const cols = new Set(pres.columns);
    await primeStatuses(
      tx,
      rows.map((r) => r.status_id as string),
    );
    const people = p.kind === 'member';
    const assignees = new Map<string, Array<{ id: string; name: string; primary: boolean }>>();
    if (q.entity === 'task' && people && (cols.has('owner') || cols.has('assignee')))
      for (const a of (
        await sql<{
          task_id: string;
          public_id: string;
          display_name: string;
          is_primary: boolean;
        }>`SELECT
            a.task_id, m.public_id, acc.display_name, a.is_primary FROM work.task_assignee a
            JOIN tenancy.membership m ON m.id = a.membership_id JOIN identity.account acc ON acc.id = m.account_id
            WHERE a.workspace_id = ${tx.workspaceId} AND a.task_id = ANY(${ids}::uuid[])
            ORDER BY a.task_id, a.is_primary DESC, a.rank COLLATE "C"`.execute(tx.db)
      ).rows)
        assignees.set(a.task_id, [
          ...(assignees.get(a.task_id) ?? []),
          { id: a.public_id, name: a.display_name, primary: a.is_primary },
        ]);
    const owners = new Map<string, { id: string; name: string }>();
    if (q.entity === 'project' && people && cols.has('owner'))
      for (const o of (
        await sql<{
          id: string;
          public_id: string;
          display_name: string;
        }>`SELECT m.id, m.public_id, acc.display_name
          FROM tenancy.membership m JOIN identity.account acc ON acc.id = m.account_id
          WHERE m.workspace_id = ${tx.workspaceId}
            AND m.id = ANY(${rows.map((r) => r.owner_membership_id as string)}::uuid[])`.execute(
          tx.db,
        )
      ).rows)
        owners.set(o.id, { id: o.public_id, name: o.display_name });
    const labels = new Map<string, Array<{ id: string; name: string; color: string }>>();
    if (q.entity === 'task' && cols.has('label'))
      for (const l of (
        await sql<{
          task_id: string;
          public_id: string;
          name: string;
          color: string;
        }>`SELECT tl.task_id,
            l.public_id, l.name, l.color FROM work.task_label tl JOIN work.label l ON l.id = tl.label_id
            WHERE tl.workspace_id = ${tx.workspaceId} AND tl.task_id = ANY(${ids}::uuid[]) AND l.state = 'active'
            ORDER BY tl.task_id, l.rank COLLATE "C"`.execute(tx.db)
      ).rows)
        labels.set(l.task_id, [
          ...(labels.get(l.task_id) ?? []),
          { id: l.public_id, name: l.name, color: l.color },
        ]);
    const milestones = new Map<string, { id: string; name: string; due_date: string | null }>();
    if (cols.has('milestone')) {
      const pids = [
        ...new Set(rows.map((r) => r.readable_project_id as string | null).filter(Boolean)),
      ] as string[];
      for (const m of (
        await sql<{
          project_id: string;
          public_id: string;
          name: string;
          due_date: string | null;
        }>`SELECT
            DISTINCT ON (m.project_id) m.project_id, mr.public_id, m.name, m.due_date::text AS due_date
            FROM work.milestone m JOIN core.record mr ON mr.workspace_id = m.workspace_id AND mr.id = m.id
            WHERE m.workspace_id = ${tx.workspaceId} AND m.project_id = ANY(${pids.length ? pids : [NIL]}::uuid[])
              AND m.lifecycle_state = 'active' AND m.status = 'planned'
            ORDER BY m.project_id, m.due_date NULLS LAST, m.rank COLLATE "C", m.id`.execute(tx.db)
      ).rows)
        milestones.set(m.project_id, { id: m.public_id, name: m.name, due_date: m.due_date });
    }
    const custom = pres.columns.filter(isCustom).map((c) => fields.get(c)!);
    const values = new Map<string, Map<string, unknown>>();
    if (custom.length)
      for (const v of (
        await sql<{
          record_id: string;
          definition_id: string;
          value: unknown;
          label: string | null;
        }>`SELECT
            fv.record_id, fv.definition_id, fv.value,
            coalesce(o.label, l.name, acc.display_name) AS label
          FROM workflow.field_value fv
          LEFT JOIN workflow.field_option o ON o.id = fv.value_ref AND o.definition_id = fv.definition_id
          LEFT JOIN work.label l ON l.id = fv.value_ref AND l.brand_id = fv.brand_id
          LEFT JOIN tenancy.membership m ON m.id = fv.value_ref
          LEFT JOIN identity.account acc ON acc.id = m.account_id
          WHERE fv.workspace_id = ${tx.workspaceId} AND fv.record_id = ANY(${ids}::uuid[])
            AND fv.definition_id = ANY(${custom.map((f) => f.id)}::uuid[])`.execute(tx.db)
      ).rows) {
        if (!values.has(v.record_id)) values.set(v.record_id, new Map());
        values.get(v.record_id)!.set(v.definition_id, v.label ?? v.value);
      }
    const day = (d: unknown) =>
      d === null || d === undefined ? null : d instanceof Date ? d.toISOString() : String(d);
    const date = (d: unknown) =>
      d === null || d === undefined
        ? null
        : d instanceof Date
          ? d.toISOString().slice(0, 10)
          : String(d).slice(0, 10);
    return rows.map((r) => {
      const status = statusView(statusRef(tx, r.status_id as string));
      const out: Record<string, unknown> = {
        id: r.public_id,
        type: q.entity,
        title: r.title,
        status,
        priority: r.priority,
        brand: {
          kind: 'brand',
          id: r.brand_public_id,
          name: r.brand_name,
          short_name: r.brand_short_name,
          color: r.brand_color,
          icon: r.brand_icon,
          archived: r.brand_state === 'archived',
        },
        version: Number(r.version),
        ...(r.g !== null && r.g !== undefined ? { group: this.keyString(r.g) } : {}),
      };
      for (const col of pres.columns) {
        switch (col) {
          case 'title':
          case 'name':
          case 'status':
          case 'priority':
          case 'brand':
            break;
          case 'status_category':
            out.status_category = status.category;
            break;
          case 'project':
            if (r.project_public_id)
              out.project = { id: r.project_public_id, type: 'project', name: r.project_name };
            break;
          case 'health':
            out.health = r.health ?? null;
            break;
          case 'owner':
            if (!people) break;
            if (q.entity === 'task') {
              const o = (assignees.get(r.id as string) ?? []).find((a) => a.primary);
              out.owner = o ? { id: o.id, name: o.name } : null;
            } else out.owner = owners.get(r.owner_membership_id as string) ?? null;
            break;
          case 'assignee':
            if (people)
              out.assignees = (assignees.get(r.id as string) ?? []).map((a) => ({
                id: a.id,
                name: a.name,
              }));
            break;
          case 'label':
            out.labels = labels.get(r.id as string) ?? [];
            break;
          case 'milestone':
            out.milestone = r.readable_project_id
              ? (milestones.get(r.readable_project_id as string) ?? null)
              : null;
            break;
          case 'agent':
            out.agents = [];
            break;
          case 'start_date':
          case 'due_date':
          case 'deadline_date':
          case 'target_date':
            out[col] = date(r[col]);
            break;
          case 'created_at':
          case 'updated_at':
          case 'completed_at':
            out[col] = day(r[col]);
            break;
          case 'estimate_minutes':
            out.estimate_minutes = r.estimate_minutes ?? null;
            break;
          default:
            if (isCustom(col)) {
              const fd = fields.get(col)!;
              out.fields = {
                ...((out.fields as Record<string, unknown> | undefined) ?? {}),
                [fd.publicId]: values.get(r.id as string)?.get(fd.id) ?? null,
              };
            }
        }
      }
      return out;
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Public query and export commands
  // ---------------------------------------------------------------------------------------------

  protected pageLimit(raw: unknown): number {
    if (raw === undefined || raw === null) return this.ws.pageLimitDefault;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1)
      throw invalid(issue('/limit', 'invalid_number', 'Choose a page size of at least 1.'));
    return Math.min(n, this.ws.pageLimitMax);
  }

  /** `POST /tasks:query` and `POST /projects:query` (0D §2.4; ad hoc or a saved view's AST). */
  async query(caller: Caller, ws: unknown, entity: Entity, body: unknown): Promise<QueryResult> {
    const b = isObj(body) ? body : {};
    const limit = this.pageLimit(b.limit);
    const started = performance.now();
    try {
      const out = await this.inWorkspace(caller, ws, { readOnly: true }, (tx, p) =>
        this.runQuery(
          tx,
          p,
          { query: b.query, presentation: b.presentation, scope: b.scope, today: b.today },
          {
            entity,
            limit,
            cursor: b.cursor,
            includeTotal: b.include_total === true,
            groups: true,
          },
        ),
      );
      this.d.metrics.count('views.queries', 1, { entity, outcome: 'ok' });
      return out;
    } catch (err) {
      this.d.metrics.count('views.queries', 1, {
        entity,
        outcome: err instanceof TenancyError ? err.code : 'error',
      });
      throw err;
    } finally {
      this.d.metrics.record('views.query_duration', performance.now() - started, { entity });
    }
  }

  /** Diagnostics for tests and operators (not routed): the plan of a query's rows statement. */
  protected async explainQuery(caller: Caller, ws: unknown, entity: Entity, body: unknown) {
    const b = isObj(body) ? body : {};
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      if (b.no_seqscan === true) await sql`SET LOCAL enable_seqscan = off`.execute(tx.db);
      return (
        await this.runQuery(
          tx,
          p,
          { query: b.query, presentation: b.presentation, scope: b.scope, today: b.today },
          {
            entity,
            limit: this.pageLimit(b.limit),
            includeTotal: false,
            groups: false,
            explain: true,
          },
        )
      ).plan;
    });
  }

  /**
   * Exports the current filtered view (VIEW-022) directly, bounded by `EXPORT_ROWS_MAX`. Rows and
   * fields are exactly what the requester can read now; nothing is stored, so no artifact can
   * outlive a revocation (ADR-0018 Q8). Audited, with an `export` security event.
   */
  async exportView(
    caller: Caller,
    ws: unknown,
    entity: Entity,
    body: unknown,
  ): Promise<{ filename: string; contentType: string; body: string; rows: number }> {
    const b = isObj(body) ? body : {};
    const format = b.format ?? 'csv';
    if (format !== 'csv' && format !== 'json')
      throw invalid(issue('/format', 'invalid', 'Export as CSV or JSON.'));
    const max = this.ws.exportRowsMax;
    return this.inWorkspace(caller, ws, {}, async (tx, p) => {
      const r = await this.runQuery(
        tx,
        p,
        { query: b.query, presentation: b.presentation, scope: b.scope, today: b.today },
        { entity, limit: max, includeTotal: false, groups: false },
      );
      if (r.page.has_more)
        throw invalid(
          issue(
            '/query',
            'too_many',
            `This view has more than ${max} rows. Narrow it with a filter, then export again.`,
          ),
        );
      const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : `${entity}s`;
      const slug =
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 60) || 'view';
      const file = `${slug}.${format}`;
      const content =
        format === 'json'
          ? JSON.stringify({ columns: r.columns, data: r.data }, null, 2)
          : this.toCsv(r.columns, r.data);
      await this.workWriter.write(tx, this.cmd(caller, p), {
        action: 'views.exported',
        target: { type: 'workspace', recordId: tx.workspaceId, publicId: String(ws) },
        changes: [
          change.plain('entity', null, entity),
          change.plain('format', null, format as string),
          change.plain('rows', null, String(r.data.length)),
          change.content('query', { hash: hash(JSON.stringify(b.query ?? null)) }),
        ],
      });
      await this.d.security.record(tx, {
        category: 'export',
        action: 'views.export',
        outcome: 'success',
        actor: { type: 'human', id: p.membershipId },
        subject: { type: 'workspace', id: tx.workspaceId },
        correlationId: caller.meta.correlationId,
      });
      this.d.metrics.count('views.exports', 1, { entity, format: format as string });
      return {
        filename: file,
        contentType: format === 'json' ? 'application/json' : 'text/csv',
        body: content,
        rows: r.data.length,
      };
    });
  }

  /** RFC 4180 CSV with formula-injection neutralization (cells starting =,+,-,@ are prefixed). */
  protected toCsv(
    columns: Array<{ field: string; label: string }>,
    data: Record<string, unknown>[],
  ): string {
    const cell = (v: unknown): string => {
      let s =
        v === null || v === undefined
          ? ''
          : Array.isArray(v)
            ? v.map((x) => (isObj(x) ? (x.name ?? x.id) : x)).join('; ')
            : isObj(v)
              ? String(v.name ?? v.id ?? '')
              : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const value = (row: Record<string, unknown>, f: string) => {
      if (isCustom(f)) {
        const fields = row.fields as Record<string, unknown> | undefined;
        return fields?.[f.slice('field:'.length)];
      }
      if (f === 'assignee') return row.assignees;
      if (f === 'label') return row.labels;
      if (f === 'agent') return row.agents;
      if (f === 'name') return row.title;
      return row[f];
    };
    const lines = [['ID', ...columns.map((c) => c.label)].map(cell).join(',')];
    for (const r of data)
      lines.push([r.id, ...columns.map((c) => value(r, c.field))].map(cell).join(','));
    return `${lines.join('\r\n')}\r\n`;
  }

  /** The catalog for the view builder (fields the viewer may use, with their operators). */
  async catalog(caller: Caller, ws: unknown, entity: Entity) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const vis = await compileVisibility(tx, p, {
        need: 'view',
        includeArchived: true,
        arrayMax: this.c.settings.principalContextArrayMax,
      });
      const defs = (
        await sql<{ public_id: string }>`SELECT d.public_id FROM workflow.field_definition d
          WHERE d.workspace_id = ${tx.workspaceId} AND d.state = 'active'
            AND (${entity === 'task' ? sql`d.applies_to_task` : sql`d.applies_to_project`})
          ORDER BY d.rank COLLATE "C", d.id LIMIT 200`.execute(tx.db)
      ).rows;
      const fields = await this.usableFields(
        tx,
        p,
        entity,
        defs.map((d) => `field:${d.public_id}`),
        vis,
      );
      const builtin = Object.entries(CATALOG[entity])
        .filter(([k]) => !(p.kind === 'guest' && PEOPLE.has(k)))
        .map(([k, s]) => ({
          field: k,
          label: s.label,
          kind: s.kind,
          ...(s.values ? { values: s.values } : {}),
          ...(s.ref ? { ref: s.ref } : {}),
          sortable: s.sortable,
          groupable: s.groupable,
          column: s.column,
          filterable: s.filterable,
        }));
      const custom = [...fields.entries()].map(([k, f]) => ({
        field: k,
        label: f.name,
        kind: f.kind,
        custom: true,
        type: f.type,
        sortable: f.kind !== 'ref' || f.type === 'select',
        groupable: f.kind !== 'text' && f.kind !== 'number',
        column: true,
        filterable: true,
      }));
      return {
        entity,
        fields: [...builtin, ...custom],
        default_columns: DEFAULT_COLUMNS[entity],
        bounds: {
          conditions: this.ws.queryConditionsMax,
          depth: this.ws.queryDepthMax,
          sorts: this.ws.querySortsMax,
          columns: this.ws.viewColumnsMax,
          export_rows: this.ws.exportRowsMax,
        },
      };
    });
  }

  /**
   * Choices for a reference field in the builder: only values the caller can read, searched by
   * label, at most 50 (the same readable sets the engine resolves values against).
   */
  async fieldOptions(
    caller: Caller,
    ws: unknown,
    entity: Entity,
    field: unknown,
    query: Record<string, unknown>,
  ): Promise<{ field: string; options: Array<{ value: string; label: string }> }> {
    if (typeof field !== 'string') throw new TenancyError('not_found');
    const term = typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '';
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const vis = await compileVisibility(tx, p, {
        need: 'view',
        includeArchived: true,
        arrayMax: this.c.settings.principalContextArrayMax,
      });
      const brands = vis.ctx.brandIds.length ? vis.ctx.brandIds : [NIL];
      const custom = isCustom(field)
        ? (await this.usableFields(tx, p, entity, [field], vis)).get(field)
        : undefined;
      const spec = isCustom(field) ? null : fieldSpec(entity, field);
      const kind = custom
        ? ({ select: 'option', person: 'member', label: 'label' } as Record<string, string>)[
            custom.type
          ]
        : spec?.ref;
      if (
        (!custom && !spec) ||
        !kind ||
        (p.kind === 'guest' && (kind === 'member' || PEOPLE.has(field)))
      )
        throw new TenancyError('not_found');
      type Opt = { value: string; label: string };
      let rows: Opt[];
      switch (kind) {
        case 'brand':
          rows = (
            await sql<Opt>`SELECT r.public_id AS value, b.name AS label FROM tenancy.brand b
              JOIN core.record r ON r.workspace_id = b.workspace_id AND r.id = b.id
              WHERE b.workspace_id = ${tx.workspaceId} AND b.id = ANY(${brands}::uuid[]) AND b.name ILIKE ${like}
              ORDER BY lower(b.name), b.id LIMIT 50`.execute(tx.db)
          ).rows;
          break;
        case 'project':
          rows = (
            await sql<Opt>`SELECT pr.public_id AS value, w.name AS label FROM core.record pr
              JOIN work.project w ON w.workspace_id = pr.workspace_id AND w.id = pr.id
              WHERE pr.workspace_id = ${tx.workspaceId} AND pr.record_type = 'project'
                AND ${vis.where('pr', { project: sql`w.id` })} AND w.name ILIKE ${like}
              ORDER BY lower(w.name), w.id LIMIT 50`.execute(tx.db)
          ).rows;
          break;
        case 'member':
          rows = [
            ...('me'.includes(term.toLowerCase()) ? [{ value: 'me', label: 'Me' }] : []),
            ...(
              await sql<Opt>`SELECT m.public_id AS value, acc.display_name AS label FROM tenancy.membership m
                JOIN identity.account acc ON acc.id = m.account_id
                WHERE m.workspace_id = ${tx.workspaceId} AND m.kind = 'member' AND m.state = 'active'
                  AND acc.display_name ILIKE ${like}
                ORDER BY lower(acc.display_name), m.id LIMIT 50`.execute(tx.db)
            ).rows,
          ];
          break;
        case 'label':
          rows = (
            await sql<Opt>`SELECT l.public_id AS value, l.name AS label FROM work.label l
              WHERE l.workspace_id = ${tx.workspaceId} AND l.brand_id = ANY(${brands}::uuid[])
                AND l.state = 'active' AND l.name ILIKE ${like}
              ORDER BY lower(l.name), l.id LIMIT 50`.execute(tx.db)
          ).rows;
          break;
        case 'milestone':
          rows = (
            await sql<Opt>`SELECT mr.public_id AS value, m.name || ' · ' || w.name AS label FROM core.record mr
              JOIN work.milestone m ON m.workspace_id = mr.workspace_id AND m.id = mr.id
              JOIN work.project w ON w.id = m.project_id
              WHERE mr.workspace_id = ${tx.workspaceId} AND mr.record_type = 'milestone'
                AND m.lifecycle_state = 'active' AND ${vis.where('mr', { project: sql`m.project_id` })}
                AND m.name ILIKE ${like}
              ORDER BY m.due_date NULLS LAST, lower(m.name), m.id LIMIT 50`.execute(tx.db)
          ).rows;
          break;
        case 'status': {
          rows = [
            ...platformStatuses(entity)
              .filter((x) => x.name.toLowerCase().includes(term.toLowerCase()))
              .map((x) => ({ value: x.key, label: x.name })),
            ...(
              await sql<Opt>`SELECT s.public_id AS value, s.name || ' · ' || wf.name AS label
                FROM workflow.workflow_status s JOIN workflow.workflow wf ON wf.id = s.workflow_id
                WHERE s.workspace_id = ${tx.workspaceId} AND wf.record_kind = ${entity} AND s.state = 'active'
                  AND (wf.brand_id IS NULL OR wf.brand_id = ANY(${brands}::uuid[]))
                  AND (wf.project_id IS NULL OR EXISTS (SELECT 1 FROM core.record pr WHERE pr.workspace_id = wf.workspace_id
                    AND pr.id = wf.project_id AND ${vis.where('pr', { project: sql`pr.id` })}))
                  AND s.name ILIKE ${like}
                ORDER BY lower(wf.name), s.rank COLLATE "C", s.id LIMIT 50`.execute(tx.db)
            ).rows,
          ];
          break;
        }
        case 'option':
          rows = (
            await sql<Opt>`SELECT o.public_id AS value, o.label FROM workflow.field_option o
              WHERE o.workspace_id = ${tx.workspaceId} AND o.definition_id = ${custom!.id}::uuid
                AND o.state = 'active' AND o.label ILIKE ${like}
              ORDER BY o.rank COLLATE "C", o.id LIMIT 50`.execute(tx.db)
          ).rows;
          break;
        default:
          // Agents (7A) do not exist yet.
          rows = [];
      }
      return { field, options: rows.slice(0, 50) };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Saved views: authorization (a view grants nothing; reading it is reading a definition)
  // ---------------------------------------------------------------------------------------------

  protected async loadView(
    tx: WorkspaceTransaction,
    p: Principal,
    publicId: unknown,
    opts: { lock?: boolean; allowHidden?: boolean } = {},
  ): Promise<LoadedView> {
    if (!isPublic(publicId, 'view')) throw new TenancyError('not_found');
    const row = (
      await sql<ViewRow>`SELECT v.id, r.public_id, v.entity, v.name, v.description, v.owner_membership_id,
          om.public_id AS owner_public_id, v.visibility, v.share_scope, v.share_brand_id, v.share_project_id,
          v.query, v.presentation, v.layout, v.created_at, v.updated_at, v.version
        FROM core.record r JOIN views.saved_view v ON v.workspace_id = r.workspace_id AND v.id = r.id
        JOIN tenancy.membership om ON om.id = v.owner_membership_id
        WHERE r.workspace_id = ${tx.workspaceId} AND r.public_id = ${publicId}
          AND r.record_type = 'saved_view' AND r.lifecycle_state = 'active'
        ${opts.lock ? sql`FOR UPDATE OF v` : sql``}`.execute(tx.db)
    ).rows[0];
    // Every statement below runs whatever the row is (absent, personal, or shared) so hidden and
    // unknown views take the same path (0C AT-026).
    const brandRow = (
      await sql<{
        id: string;
        is_sensitive: boolean;
        lifecycle_state: BrandFacts['lifecycleState'];
        public_id: string;
        name: string;
      }>`
        SELECT b.id, b.is_sensitive, b.lifecycle_state, br.public_id, b.name FROM tenancy.brand b
        JOIN core.record br ON br.workspace_id = b.workspace_id AND br.id = b.id
        WHERE b.workspace_id = ${tx.workspaceId} AND b.id = ${row?.share_brand_id ?? NIL}::uuid`.execute(
        tx.db,
      )
    ).rows[0];
    const scopeBrand = brandRow
      ? {
          id: brandRow.id,
          isSensitive: brandRow.is_sensitive,
          lifecycleState: brandRow.lifecycle_state,
          publicId: brandRow.public_id,
          name: brandRow.name,
        }
      : null;
    let scopeProject: LoadedView['scopeProject'] = null;
    let projectLevel: string | null = null;
    let projectManage = false;
    if (row?.share_scope === 'project') {
      try {
        const pr = (
          await sql<{ public_id: string }>`SELECT public_id FROM core.record
            WHERE workspace_id = ${tx.workspaceId} AND id = ${row.share_project_id}::uuid`.execute(
            tx.db,
          )
        ).rows[0];
        const lp = await this.loadProject(tx, p, pr?.public_id);
        scopeProject = { id: lp.id, publicId: lp.publicId, name: lp.row.name };
        projectLevel = lp.ownLevel;
        projectManage = decideProject(p, 'view.share', lp).allowed;
      } catch (err) {
        if (!(err instanceof TenancyError)) throw err;
      }
    }
    if (!row) throw new TenancyError('not_found');
    const own = row.owner_membership_id === p.membershipId;
    let read: boolean;
    let manage: boolean;
    if (row.visibility === 'personal') {
      read = own;
      manage = own;
    } else if (row.share_scope === 'workspace') {
      read = p.kind === 'member';
      manage = read && decideWorkspace(p, 'view.share').allowed;
    } else if (row.share_scope === 'brand') {
      read =
        !!scopeBrand &&
        brandLevel(p, scopeBrand) !== null &&
        scopeBrand.lifecycleState !== 'trashed';
      manage = read && decideBrand(p, 'view.share', scopeBrand!).allowed;
    } else {
      read = projectLevel !== null && levelRank(projectLevel as never) >= levelRank('view');
      manage = read && projectManage;
    }
    if (!read && !opts.allowHidden) throw new TenancyError('not_found');
    return { row, read, manage, scopeBrand, scopeProject };
  }

  protected viewOut(v: LoadedView, p: Principal) {
    const r = v.row;
    return {
      id: r.public_id,
      type: 'saved_view',
      entity: r.entity,
      name: r.name,
      description: r.description,
      visibility: r.visibility,
      share:
        r.visibility === 'shared'
          ? {
              scope: r.share_scope,
              ...(v.scopeBrand
                ? {
                    brand: { id: v.scopeBrand.publicId, type: 'brand', name: v.scopeBrand.name },
                  }
                : {}),
              ...(v.scopeProject
                ? {
                    project: {
                      id: v.scopeProject.publicId,
                      type: 'project',
                      name: v.scopeProject.name,
                    },
                  }
                : {}),
            }
          : null,
      owned: r.owner_membership_id === p.membershipId,
      ...(p.kind === 'member' ? { owner: { id: r.owner_public_id, type: 'membership' } } : {}),
      can_manage: v.manage,
      query: r.query,
      presentation: r.presentation,
      layout: r.layout,
      created_at: r.created_at,
      updated_at: r.updated_at,
      version: Number(r.version),
    };
  }

  /** Saved views the caller can read: their own personal views and views shared to them. */
  async listViews(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    const entity = query.entity;
    if (entity !== undefined && entity !== 'task' && entity !== 'project')
      throw invalid(issue('/entity', 'invalid', 'Choose tasks or projects.'));
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const vis = await compileVisibility(tx, p, {
        need: 'view',
        includeArchived: true,
        arrayMax: this.c.settings.principalContextArrayMax,
      });
      const rows = (
        await sql<{ public_id: string }>`SELECT r.public_id FROM views.saved_view v
          JOIN core.record r ON r.workspace_id = v.workspace_id AND r.id = v.id
          WHERE v.workspace_id = ${tx.workspaceId} AND v.lifecycle_state = 'active'
            ${entity ? sql`AND v.entity = ${entity}` : sql``}
            AND (v.owner_membership_id = ${p.membershipId} AND v.visibility = 'personal'
              OR v.visibility = 'shared' AND (
                (v.share_scope = 'workspace' AND ${p.kind === 'member'})
                OR (v.share_scope = 'brand' AND v.share_brand_id = ANY(${vis.ctx.brandIds.length ? vis.ctx.brandIds : [NIL]}::uuid[]))
                OR (v.share_scope = 'project' AND EXISTS (SELECT 1 FROM core.record pr
                  WHERE pr.workspace_id = v.workspace_id AND pr.id = v.share_project_id
                    AND ${vis.where('pr', { project: sql`pr.id` })}))))
          ORDER BY (v.visibility = 'shared'), lower(v.name), v.id
          LIMIT 201`.execute(tx.db)
      ).rows;
      const out = [];
      for (const r of rows) {
        const v = await this.loadView(tx, p, r.public_id, { allowHidden: true });
        if (v.read) out.push(this.viewOut(v, p));
      }
      return { data: out.slice(0, 200), hasMore: rows.length > 200 };
    });
  }

  async getView(caller: Caller, ws: unknown, view: unknown) {
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) =>
      this.viewOut(await this.loadView(tx, p, view), p),
    );
  }

  /** Validates a definition against the caller's own catalog (a definition grants nothing). */
  protected async validateDefinition(
    tx: WorkspaceTransaction,
    p: Principal,
    b: Record<string, unknown>,
    entity: Entity,
  ): Promise<{ query: Query; presentation: Presentation }> {
    const q = parseQuery(b.query, this.queryBounds, entity);
    const pres = this.presentationFor(p, b.presentation, entity);
    const vis = await compileVisibility(tx, p, {
      need: 'view',
      includeArchived: true,
      arrayMax: this.c.settings.principalContextArrayMax,
    });
    const named = new Set(customFields(q));
    pres.columns.filter(isCustom).forEach((c) => named.add(c));
    const fields = await this.usableFields(tx, p, entity, [...named].sort(), vis);
    return { query: this.checkFields(p, q, pres, fields), presentation: pres };
  }

  protected parseName(b: Record<string, unknown>, required: boolean) {
    if (b.name === undefined && !required) return;
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 120)
      throw invalid(issue('/name', 'required', 'Give the view a name of up to 120 characters.'));
    if (
      b.description !== undefined &&
      (typeof b.description !== 'string' || b.description.length > 1000)
    )
      throw invalid(
        issue('/description', 'too_long', 'Keep the description under 1000 characters.'),
      );
  }

  /** The stored AST: the canonical serialization (custom-field values in their given form). */
  protected storedQuery(raw: unknown, entity: Entity): Record<string, unknown> {
    return serializeQuery(parseQuery(raw, this.queryBounds, entity));
  }

  async createView(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    this.parseName(b, true);
    const entity = (isObj(b.query) ? b.query.entity : undefined) ?? b.entity;
    if (entity !== 'task' && entity !== 'project')
      throw invalid(issue('/query/entity', 'invalid', 'Choose tasks or projects.'));
    return this.mutate(
      caller,
      'views.view_create',
      ws,
      req,
      async (tx, p) => {
        const o = decidePersonal(p, 'personal.manage_own');
        this.decision('personal.manage_own', o);
        if (!o.allowed) throw new TenancyError(o.code);
        const { presentation } = await this.validateDefinition(tx, p, b, entity);
        const n = await tx.db
          .selectFrom('views.saved_view')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('owner_membership_id', '=', p.membershipId)
          .where('lifecycle_state', '=', 'active')
          .executeTakeFirstOrThrow();
        if (Number(n.n) >= this.ws.savedViewsMax)
          throw invalid(
            issue('/', 'too_many', `You can keep at most ${this.ws.savedViewsMax} saved views.`),
          );
        const id = newUuidV7();
        const publicId = newPublicId('view');
        const cmd = this.cmd(caller, p);
        await tx.db
          .insertInto('core.record')
          .values({
            id,
            public_id: publicId,
            record_type: 'saved_view',
            workspace_id: tx.workspaceId,
            brand_id: null,
            source_kind: 'ui',
            source_ref: null,
            created_by_actor_type: cmd.actor.type,
            created_by_actor_id: cmd.actor.id,
          })
          .execute();
        await tx.db
          .insertInto('views.saved_view')
          .values({
            id,
            workspace_id: tx.workspaceId,
            scope_key: tx.workspaceId,
            entity,
            name: (b.name as string).trim(),
            description: typeof b.description === 'string' ? b.description : '',
            owner_membership_id: p.membershipId,
            query: JSON.stringify(this.storedQuery(b.query, entity)),
            presentation: JSON.stringify(presentation),
            updated_by_membership_id: p.membershipId,
          })
          .execute();
        await this.workWriter.write(tx, cmd, {
          action: 'views.view_created',
          target: { recordId: id, type: 'saved_view', publicId },
          changes: [
            change.content('name', { hash: hash(b.name as string) }),
            change.plain('entity', null, entity),
          ],
        });
        await writeOutboxEvent(tx, {
          type: 'views.saved_view.created',
          aggregate: { type: 'views.saved_view', id, sequence: 0 },
          data: { entity, visibility: 'personal' },
          actor: { type: 'human', id: p.membershipId },
          context: this.exec(caller, p),
          brandId: undefined,
        });
        const v = await this.loadView(tx, p, publicId);
        return { status: 201, ref: { id: publicId, type: 'saved_view' }, data: this.viewOut(v, p) };
      },
      async (tx, p, ref) => this.viewOut(await this.loadView(tx, p, ref.id), p),
    );
  }

  protected expected(req: Mutation, b: Record<string, unknown>): number {
    const expected =
      req.ifMatch !== undefined ? parseIfMatch(req.ifMatch) : (b.version as number | undefined);
    if (expected === undefined) throw new TenancyError('precondition_required');
    return expected;
  }

  /** Changes a definition (name, description, query, presentation) under If-Match. */
  async updateView(caller: Caller, ws: unknown, view: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    this.parseName(b, false);
    for (const k of Object.keys(b))
      if (!['name', 'description', 'query', 'presentation', 'version'].includes(k))
        throw invalid(issue(`/${k}`, 'unknown_key', 'This key is not allowed.'));
    return this.mutate(
      caller,
      'views.view_update',
      ws,
      req,
      async (tx, p) => {
        const v = await this.loadView(tx, p, view, { lock: true });
        if (!v.manage) throw new TenancyError('forbidden');
        requireVersion(this.expected(req, b), Number(v.row.version));
        const def =
          b.query !== undefined || b.presentation !== undefined
            ? await this.validateDefinition(
                tx,
                p,
                {
                  query: b.query ?? v.row.query,
                  presentation: b.presentation ?? v.row.presentation,
                },
                v.row.entity,
              )
            : null;
        await tx.db
          .updateTable('views.saved_view')
          .set({
            ...(b.name !== undefined ? { name: (b.name as string).trim() } : {}),
            ...(b.description !== undefined ? { description: b.description as string } : {}),
            ...(b.query !== undefined
              ? { query: JSON.stringify(this.storedQuery(b.query, v.row.entity)) }
              : {}),
            ...(def && b.presentation !== undefined
              ? { presentation: JSON.stringify(def.presentation) }
              : {}),
            updated_at: new Date(),
            updated_by_membership_id: p.membershipId,
            version: Number(v.row.version) + 1,
          })
          .where('id', '=', v.row.id)
          .execute();
        await this.workWriter.write(tx, this.cmd(caller, p), {
          action: 'views.view_updated',
          target: { recordId: v.row.id, type: 'saved_view', publicId: v.row.public_id },
          changes: Object.keys(b)
            .filter((k) => k !== 'version')
            .map((k) => change.content(k, { hash: hash(JSON.stringify(b[k])) })),
        });
        await writeOutboxEvent(tx, {
          type: 'views.saved_view.updated',
          aggregate: {
            type: 'views.saved_view',
            id: v.row.id,
            sequence: Number(v.row.version) + 1,
          },
          data: { entity: v.row.entity, visibility: v.row.visibility },
          actor: { type: 'human', id: p.membershipId },
          context: this.exec(caller, p),
          brandId: v.row.share_brand_id ?? undefined,
        });
        return {
          status: 200,
          ref: { id: v.row.public_id, type: 'saved_view' },
          data: this.viewOut(await this.loadView(tx, p, v.row.public_id), p),
        };
      },
      async (tx, p, ref) => this.viewOut(await this.loadView(tx, p, ref.id), p),
    );
  }

  /** Resolves a share scope and decides `view.share` there (0C; never satisfied by shares). */
  protected async shareTarget(
    tx: WorkspaceTransaction,
    p: Principal,
    b: Record<string, unknown>,
  ): Promise<{ scope: ShareScope; brandId: string | null; projectId: string | null }> {
    const scope = b.scope;
    if (scope === 'workspace') {
      const o = decideWorkspace(p, 'view.share');
      this.decision('view.share', o);
      if (!o.allowed) throw new TenancyError(o.code);
      return { scope, brandId: null, projectId: null };
    }
    if (scope === 'brand') {
      const brand = await this.brandForScope(tx, p, b.brand);
      const o = decideBrand(p, 'view.share', brand);
      this.decision('view.share', o);
      if (!o.allowed) throw new TenancyError(o.code);
      return { scope, brandId: brand.id, projectId: null };
    }
    if (scope === 'project') {
      const project = await this.loadProject(tx, p, b.project);
      if (project.ownLevel === null) throw new TenancyError('not_found');
      const o = decideProject(p, 'view.share', project);
      this.decision('view.share', o);
      if (!o.allowed) throw new TenancyError(o.code);
      return { scope, brandId: project.brand.id, projectId: project.id };
    }
    throw invalid(issue('/scope', 'invalid', 'Share with the workspace, a brand, or a project.'));
  }

  protected async brandForScope(tx: WorkspaceTransaction, p: Principal, raw: unknown) {
    const row = await findBrand(tx, p, raw, { states: 'active' });
    return {
      id: row.id,
      isSensitive: row.is_sensitive,
      lifecycleState: row.lifecycle_state as BrandFacts['lifecycleState'],
    };
  }

  /**
   * Shares a view with exactly one scope (VIEW-017). Re-sharing moves the view to the new scope;
   * pins and brand/project defaults of the old scope are removed. Personal state never moves.
   */
  async shareView(caller: Caller, ws: unknown, view: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    return this.mutate(
      caller,
      'views.view_share',
      ws,
      req,
      async (tx, p) => {
        const v = await this.loadView(tx, p, view, { lock: true });
        if (!v.manage) throw new TenancyError('forbidden');
        requireVersion(this.expected(req, b), Number(v.row.version));
        const t = await this.shareTarget(tx, p, b);
        await this.detachScope(tx, v.row.id);
        await tx.db
          .updateTable('views.saved_view')
          .set({
            visibility: 'shared',
            share_scope: t.scope,
            share_brand_id: t.brandId,
            share_project_id: t.projectId,
            shared_at: new Date(),
            shared_by_membership_id: p.membershipId,
            updated_at: new Date(),
            updated_by_membership_id: p.membershipId,
            version: Number(v.row.version) + 1,
          })
          .where('id', '=', v.row.id)
          .execute();
        await this.workWriter.write(tx, this.cmd(caller, p, t.brandId), {
          action: 'views.view_shared',
          target: { recordId: v.row.id, type: 'saved_view', publicId: v.row.public_id },
          changes: [change.plain('share_scope', v.row.share_scope, t.scope)],
        });
        await this.d.security.record(tx, {
          category: 'sharing',
          action: 'views.share',
          outcome: 'success',
          actor: { type: 'human', id: p.membershipId },
          subject: { type: 'saved_view', id: v.row.id },
          correlationId: caller.meta.correlationId,
        });
        await writeOutboxEvent(tx, {
          type: 'views.saved_view.shared',
          aggregate: {
            type: 'views.saved_view',
            id: v.row.id,
            sequence: Number(v.row.version) + 1,
          },
          data: { entity: v.row.entity, scope: t.scope },
          actor: { type: 'human', id: p.membershipId },
          context: this.exec(caller, p),
          brandId: t.brandId ?? undefined,
        });
        return {
          status: 200,
          ref: { id: v.row.public_id, type: 'saved_view' },
          data: this.viewOut(await this.loadView(tx, p, v.row.public_id), p),
        };
      },
      async (tx, p, ref) => this.viewOut(await this.loadView(tx, p, ref.id), p),
    );
  }

  /** Pins and scope defaults belong to the share; members' own defaults outside it are cleared. */
  protected async detachScope(tx: WorkspaceTransaction, viewId: string) {
    await tx.db.deleteFrom('views.view_pin').where('saved_view_id', '=', viewId).execute();
    await tx.db
      .deleteFrom('views.view_default')
      .where('saved_view_id', '=', viewId)
      .where('target_kind', '<>', 'member')
      .execute();
  }

  /** Revokes a share (back to the owner's personal view); others' defaults on it are removed. */
  async unshareView(caller: Caller, ws: unknown, view: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    return this.mutate(
      caller,
      'views.view_unshare',
      ws,
      req,
      async (tx, p) => {
        const v = await this.loadView(tx, p, view, { lock: true });
        if (!v.manage) throw new TenancyError('forbidden');
        requireVersion(this.expected(req, b), Number(v.row.version));
        if (v.row.visibility !== 'shared')
          throw new TenancyError('conflict', {
            issues: [issue('/', 'not_shared', 'This view is not shared.')],
          });
        await this.detachScope(tx, v.row.id);
        await tx.db
          .deleteFrom('views.view_default')
          .where('saved_view_id', '=', v.row.id)
          .where('member_id', '<>', v.row.owner_membership_id)
          .execute();
        await tx.db
          .updateTable('views.saved_view')
          .set({
            visibility: 'personal',
            share_scope: null,
            share_brand_id: null,
            share_project_id: null,
            shared_at: null,
            shared_by_membership_id: null,
            updated_at: new Date(),
            updated_by_membership_id: p.membershipId,
            version: Number(v.row.version) + 1,
          })
          .where('id', '=', v.row.id)
          .execute();
        await this.workWriter.write(tx, this.cmd(caller, p, v.row.share_brand_id), {
          action: 'views.view_unshared',
          target: { recordId: v.row.id, type: 'saved_view', publicId: v.row.public_id },
          changes: [change.plain('share_scope', v.row.share_scope, null)],
        });
        await this.d.security.record(tx, {
          category: 'sharing',
          action: 'views.unshare',
          outcome: 'success',
          actor: { type: 'human', id: p.membershipId },
          subject: { type: 'saved_view', id: v.row.id },
          correlationId: caller.meta.correlationId,
        });
        await writeOutboxEvent(tx, {
          type: 'views.saved_view.unshared',
          aggregate: {
            type: 'views.saved_view',
            id: v.row.id,
            sequence: Number(v.row.version) + 1,
          },
          data: { entity: v.row.entity },
          actor: { type: 'human', id: p.membershipId },
          context: this.exec(caller, p),
          brandId: v.row.share_brand_id ?? undefined,
        });
        // The owner keeps the view; whoever unshared it sees it only if they own it.
        const after = await this.loadView(tx, p, v.row.public_id, { allowHidden: true });
        return {
          status: 200,
          ref: { id: v.row.public_id, type: 'saved_view' },
          data: after.read ? this.viewOut(after, p) : { id: v.row.public_id, type: 'saved_view' },
        };
      },
      async (tx, p, ref) => {
        const after = await this.loadView(tx, p, ref.id, { allowHidden: true });
        return after.read ? this.viewOut(after, p) : { id: ref.id, type: 'saved_view' };
      },
    );
  }

  /** Deletes a view (trash through the lifecycle service; pins and defaults go at once). */
  async deleteView(caller: Caller, ws: unknown, view: unknown, req: Mutation) {
    return this.mutate(
      caller,
      'views.view_delete',
      ws,
      req,
      async (tx, p) => {
        const v = await this.loadView(tx, p, view, { lock: true });
        if (!v.manage) throw new TenancyError('forbidden');
        if (req.ifMatch !== undefined)
          requireVersion(parseIfMatch(req.ifMatch), Number(v.row.version));
        await this.detachScope(tx, v.row.id);
        await tx.db
          .deleteFrom('views.view_default')
          .where('saved_view_id', '=', v.row.id)
          .execute();
        await this.d.lifecycle.trash(
          tx,
          await this.issueViewLifecycle(tx, p, v),
          { exec: this.exec(caller, p), source: { kind: 'ui' as const } },
          v.row.id,
        );
        await writeOutboxEvent(tx, {
          type: 'views.saved_view.deleted',
          aggregate: {
            type: 'views.saved_view',
            id: v.row.id,
            sequence: Number(v.row.version) + 1,
          },
          data: { entity: v.row.entity },
          actor: { type: 'human', id: p.membershipId },
          context: this.exec(caller, p),
          brandId: v.row.share_brand_id ?? undefined,
        });
        return {
          status: 200,
          ref: { id: v.row.public_id, type: 'saved_view' },
          data: { id: v.row.public_id, type: 'saved_view', deleted: true },
        };
      },
      async (_tx, _p, ref) => ({ id: ref.id, type: 'saved_view', deleted: true }),
    );
  }

  protected async issueViewLifecycle(tx: WorkspaceTransaction, p: Principal, v: LoadedView) {
    const r = v.row;
    const scope =
      r.visibility === 'personal'
        ? ({ kind: 'personal' } as const)
        : r.share_scope === 'workspace'
          ? ({ kind: 'workspace' } as const)
          : r.share_scope === 'brand'
            ? ({ kind: 'brand', brand: v.scopeBrand! } as const)
            : ({
                kind: 'project',
                project: await this.loadProject(tx, p, v.scopeProject!.publicId),
              } as const);
    try {
      const d = issueSavedViewLifecycleDecision(tx, p, {
        id: r.id,
        ownerMembershipId: r.owner_membership_id,
        scope,
      });
      this.decision('record.trash', { allowed: true });
      return d;
    } catch (err) {
      if (err instanceof TenancyError)
        this.decision('record.trash', { allowed: false, code: err.code });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Defaults (VIEW-018) and navigation pins (VIEW-019)
  // ---------------------------------------------------------------------------------------------

  /**
   * The effective default for a context: the person's own default first, then the project's, then
   * the brand's. Unreadable candidates are skipped silently (they are never disclosed).
   */
  async defaultView(caller: Caller, ws: unknown, query: Record<string, unknown>) {
    const entity = query.entity;
    if (entity !== 'task' && entity !== 'project')
      throw invalid(issue('/entity', 'invalid', 'Choose tasks or projects.'));
    return this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
      const brandId =
        query.brand !== undefined ? (await this.brandForScope(tx, p, query.brand)).id : null;
      let projectId: string | null = null;
      if (query.project !== undefined) {
        const lp = await this.loadProject(tx, p, query.project);
        if (lp.ownLevel === null) throw new TenancyError('not_found');
        projectId = lp.id;
      }
      const rows = (
        await sql<{ target_kind: string; public_id: string }>`SELECT d.target_kind, r.public_id
          FROM views.view_default d JOIN core.record r ON r.workspace_id = d.workspace_id AND r.id = d.saved_view_id
          WHERE d.workspace_id = ${tx.workspaceId} AND d.entity = ${entity} AND r.lifecycle_state = 'active'
            AND ((d.target_kind = 'member' AND d.member_id = ${p.membershipId})
              OR (d.target_kind = 'project' AND d.project_id = ${projectId ?? NIL}::uuid)
              OR (d.target_kind = 'brand' AND d.brand_id = ${brandId ?? NIL}::uuid))`.execute(tx.db)
      ).rows;
      const order = ['member', 'project', 'brand'];
      rows.sort((a, b) => order.indexOf(a.target_kind) - order.indexOf(b.target_kind));
      const out: Record<string, unknown> = {
        effective: null,
        member: null,
        project: null,
        brand: null,
      };
      for (const r of rows) {
        const v = await this.loadView(tx, p, r.public_id, { allowHidden: true });
        if (!v.read) continue;
        const ref = { id: v.row.public_id, type: 'saved_view', name: v.row.name };
        out[r.target_kind] = ref;
        out.effective ??= { ...ref, source: r.target_kind };
      }
      return out;
    });
  }

  /**
   * Sets or clears a default. A person's own default may be any view they can read; a brand or
   * project default needs `views.configure` there and a view shared with that brand or project
   * (or the workspace), so everyone it applies to can read it.
   */
  async setDefault(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    const entity = b.entity;
    if (entity !== 'task' && entity !== 'project')
      throw invalid(issue('/entity', 'invalid', 'Choose tasks or projects.'));
    const target = b.target;
    if (target !== 'me' && target !== 'brand' && target !== 'project')
      throw invalid(issue('/target', 'invalid', 'Set it for yourself, a brand, or a project.'));
    return this.mutate(
      caller,
      'views.default_set',
      ws,
      req,
      async (tx, p) => {
        let kind: 'member' | 'brand' | 'project' = 'member';
        let key = p.membershipId;
        let brandId: string | null = null;
        let projectId: string | null = null;
        if (target === 'brand') {
          const brand = await this.brandForScope(tx, p, b.brand);
          const o = decideBrand(p, 'views.configure', brand);
          this.decision('views.configure', o);
          if (!o.allowed) throw new TenancyError(o.code);
          kind = 'brand';
          key = brandId = brand.id;
        } else if (target === 'project') {
          const lp = await this.loadProject(tx, p, b.project);
          if (lp.ownLevel === null) throw new TenancyError('not_found');
          const o = decideProject(p, 'views.configure', lp);
          this.decision('views.configure', o);
          if (!o.allowed) throw new TenancyError(o.code);
          kind = 'project';
          key = projectId = lp.id;
          brandId = lp.brand.id;
        }
        let viewId: string | null = null;
        let viewPublic: string | null = null;
        if (b.view !== null) {
          const v = await this.loadView(tx, p, b.view);
          if (v.row.entity !== entity)
            throw invalid(issue('/view', 'invalid', 'This view lists a different kind of record.'));
          if (kind !== 'member') {
            const fits =
              v.row.visibility === 'shared' &&
              (v.row.share_scope === 'workspace' ||
                (v.row.share_scope === 'brand' && v.row.share_brand_id === brandId) ||
                (kind === 'project' &&
                  v.row.share_scope === 'project' &&
                  v.row.share_project_id === projectId));
            if (!fits)
              throw invalid(
                issue(
                  '/view',
                  'not_shared_here',
                  'Share this view with the workspace or this brand or project first.',
                ),
              );
          }
          viewId = v.row.id;
          viewPublic = v.row.public_id;
        }
        const existing = await tx.db
          .selectFrom('views.view_default')
          .select(['saved_view_id', 'version'])
          .where('target_kind', '=', kind)
          .where('target_key', '=', key)
          .where('entity', '=', entity)
          .forUpdate()
          .executeTakeFirst();
        if (b.version !== undefined || req.ifMatch !== undefined)
          requireVersion(this.expected(req, b), existing ? Number(existing.version) : 0);
        if (viewId === null) {
          if (existing)
            await tx.db
              .deleteFrom('views.view_default')
              .where('target_kind', '=', kind)
              .where('target_key', '=', key)
              .where('entity', '=', entity)
              .execute();
        } else if (existing)
          await tx.db
            .updateTable('views.view_default')
            .set({
              saved_view_id: viewId,
              set_by_membership_id: p.membershipId,
              updated_at: new Date(),
              version: Number(existing.version) + 1,
            })
            .where('target_kind', '=', kind)
            .where('target_key', '=', key)
            .where('entity', '=', entity)
            .execute();
        else
          await tx.db
            .insertInto('views.view_default')
            .values({
              workspace_id: tx.workspaceId,
              target_kind: kind,
              target_key: key,
              entity,
              member_id: kind === 'member' ? p.membershipId : null,
              brand_id: brandId,
              project_id: projectId,
              saved_view_id: viewId,
              set_by_membership_id: p.membershipId,
            })
            .execute();
        if (kind !== 'member')
          await this.workWriter.write(tx, this.cmd(caller, p, brandId), {
            action: 'views.default_set',
            target: viewId
              ? { recordId: viewId, type: 'saved_view', publicId: viewPublic! }
              : { recordId: key, type: kind, publicId: String(b[kind]) },
            changes: [change.plain('default', null, viewPublic)],
          });
        await writeOutboxEvent(tx, {
          type: 'views.default.changed',
          aggregate: { type: 'views.view_default', id: key, sequence: 0 },
          data: { target: kind, entity, cleared: viewId === null },
          actor: { type: 'human', id: p.membershipId },
          context: this.exec(caller, p),
          brandId: brandId ?? undefined,
        });
        const data = {
          id: `${kind}:${entity}`,
          type: 'view_default',
          target: kind,
          entity,
          view: viewPublic ? { id: viewPublic, type: 'saved_view' } : null,
        };
        return { status: 200, ref: { id: data.id, type: 'view_default' }, data };
      },
      async (_tx, _p, ref) => ({ id: ref.id, type: 'view_default' }) as never,
    );
  }

  /** Pins a view into workspace or brand navigation (`views.configure`; shared there first). */
  async pinView(caller: Caller, ws: unknown, view: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    return this.mutate(
      caller,
      'views.pin',
      ws,
      req,
      async (tx, p) => {
        const v = await this.loadView(tx, p, view, { lock: true });
        let brandId: string | null = null;
        if (b.scope === 'brand') {
          const brand = await this.brandForScope(tx, p, b.brand);
          const o = decideBrand(p, 'views.configure', brand);
          this.decision('views.configure', o);
          if (!o.allowed) throw new TenancyError(o.code);
          brandId = brand.id;
        } else if (b.scope === 'workspace') {
          const o = decideWorkspace(p, 'views.configure');
          this.decision('views.configure', o);
          if (!o.allowed) throw new TenancyError(o.code);
        } else throw invalid(issue('/scope', 'invalid', 'Pin to the workspace or a brand.'));
        const fits =
          v.row.visibility === 'shared' &&
          ((brandId === null && v.row.share_scope === 'workspace') ||
            (brandId !== null &&
              v.row.share_scope === 'brand' &&
              v.row.share_brand_id === brandId));
        if (!fits)
          throw invalid(
            issue('/view', 'not_shared_here', 'Share this view with that scope before pinning it.'),
          );
        const scopeKey = brandId ?? tx.workspaceId;
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`views.pin:${scopeKey}`}, 0))`.execute(
          tx.db,
        );
        const pins = await tx.db
          .selectFrom('views.view_pin')
          .select(['saved_view_id', 'rank'])
          .where('scope_key', '=', scopeKey)
          .orderBy(sql`rank COLLATE "C"`)
          .execute();
        if (!pins.some((x) => x.saved_view_id === v.row.id)) {
          if (pins.length >= this.ws.viewPinsMax)
            throw invalid(issue('/', 'too_many', `Pin at most ${this.ws.viewPinsMax} views here.`));
          const last = pins[pins.length - 1]?.rank ?? '0';
          await tx.db
            .insertInto('views.view_pin')
            .values({
              workspace_id: tx.workspaceId,
              scope_key: scopeKey,
              brand_id: brandId,
              saved_view_id: v.row.id,
              rank: nextRank(last),
              pinned_by_membership_id: p.membershipId,
            })
            .execute();
          await this.workWriter.write(tx, this.cmd(caller, p, brandId), {
            action: 'views.view_pinned',
            target: { recordId: v.row.id, type: 'saved_view', publicId: v.row.public_id },
            changes: [change.plain('pinned', null, brandId ? 'brand' : 'workspace')],
          });
          await writeOutboxEvent(tx, {
            type: 'views.pin.changed',
            aggregate: { type: 'views.view_pin', id: v.row.id, sequence: 0 },
            data: { scope: brandId ? 'brand' : 'workspace', pinned: true },
            actor: { type: 'human', id: p.membershipId },
            context: this.exec(caller, p),
            brandId: brandId ?? undefined,
          });
        }
        return {
          status: 200,
          ref: { id: v.row.public_id, type: 'saved_view' },
          data: this.viewOut(v, p),
        };
      },
      async (tx, p, ref) => this.viewOut(await this.loadView(tx, p, ref.id), p),
    );
  }

  async unpinView(caller: Caller, ws: unknown, view: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    return this.mutate(
      caller,
      'views.unpin',
      ws,
      req,
      async (tx, p) => {
        const v = await this.loadView(tx, p, view, { lock: true });
        let brandId: string | null = null;
        if (b.scope === 'brand') {
          const brand = await this.brandForScope(tx, p, b.brand);
          const o = decideBrand(p, 'views.configure', brand);
          this.decision('views.configure', o);
          if (!o.allowed) throw new TenancyError(o.code);
          brandId = brand.id;
        } else if (b.scope === 'workspace') {
          const o = decideWorkspace(p, 'views.configure');
          this.decision('views.configure', o);
          if (!o.allowed) throw new TenancyError(o.code);
        } else throw invalid(issue('/scope', 'invalid', 'Unpin from the workspace or a brand.'));
        const gone = await tx.db
          .deleteFrom('views.view_pin')
          .where('scope_key', '=', brandId ?? tx.workspaceId)
          .where('saved_view_id', '=', v.row.id)
          .executeTakeFirst();
        if (Number(gone.numDeletedRows)) {
          await this.workWriter.write(tx, this.cmd(caller, p, brandId), {
            action: 'views.view_unpinned',
            target: { recordId: v.row.id, type: 'saved_view', publicId: v.row.public_id },
            changes: [change.plain('pinned', brandId ? 'brand' : 'workspace', null)],
          });
          await writeOutboxEvent(tx, {
            type: 'views.pin.changed',
            aggregate: { type: 'views.view_pin', id: v.row.id, sequence: 0 },
            data: { scope: brandId ? 'brand' : 'workspace', pinned: false },
            actor: { type: 'human', id: p.membershipId },
            context: this.exec(caller, p),
            brandId: brandId ?? undefined,
          });
        }
        return {
          status: 200,
          ref: { id: v.row.public_id, type: 'saved_view' },
          data: this.viewOut(v, p),
        };
      },
      async (tx, p, ref) => this.viewOut(await this.loadView(tx, p, ref.id), p),
    );
  }
}

/** A rank strictly after `last` (fractional, base-62, same format as favorites). */
function nextRank(last: string): string {
  const digits = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const chars = last.split('');
  for (let i = chars.length - 1; i >= 0; i--) {
    const k = digits.indexOf(chars[i]!);
    if (k < digits.length - 1) {
      chars[i] = digits[k + 1]!;
      return chars.slice(0, i + 1).join('');
    }
  }
  return `${last}1`;
}

export { type Condition };
