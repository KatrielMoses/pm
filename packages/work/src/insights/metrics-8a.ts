import { sql } from '@pm/db';
import { decideBrand, decideWorkspace } from '@pm/tenancy';
import { addDays } from '../time/semantics.ts';
import type { MetricColumn, MetricProvider } from './metrics.ts';
import { resolveRange } from './semantics.ts';

/**
 * Phase 8A automation outcomes through the 5D metric port (RPT-013 contribution; agents are 8C
 * and never averaged in). The figure is the success rate of automation runs that ended in the
 * range, in the workspace or one brand, for people who may view automation health there
 * (`health.view`): succeeded / every terminal outcome except skipped (0B §5). Partial, failed,
 * refused, and cancelled runs are not successes; runs waiting for a reconciliation are open and
 * never counted as success, and the figure says so. Counts only: no names, records, or people.
 */
const columns: MetricColumn[] = [
  { key: 'outcome', label: 'Outcome' },
  { key: 'runs', label: 'Runs' },
];
const OUTCOMES = [
  'succeeded',
  'partial',
  'failed',
  'policy_rejected',
  'cancelled',
  'skipped',
] as const;
const LABEL: Record<(typeof OUTCOMES)[number], string> = {
  succeeded: 'Succeeded',
  partial: 'Partly done',
  failed: 'Failed',
  policy_rejected: 'Refused by access',
  cancelled: 'Cancelled',
  skipped: 'Skipped (conditions not met)',
};

export const automationRunsMetric: MetricProvider = {
  key: 'automation.rates',
  version: 1,
  label: 'Automation success rate',
  description:
    'Automation runs that ended in the chosen range by outcome; success rate excludes skipped runs and never counts partial, refused, or uncertain runs.',
  unit: 'percent',
  category: 'automation',
  source: { kind: 'automation_runs', label: 'Automation run history' },
  guestSafe: false,
  applies: { range: true, brands: true, projects: false, people: false, statuses: false },
  parse: (raw, pointer, issues) => {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length) {
      issues.add(pointer, 'unsupported_field', 'This metric has no options.');
      return null;
    }
    return {};
  },
  async compute(ctx) {
    const r = resolveRange(ctx.filters.range, ctx.today, ctx.weekStart) ?? {
      from: addDays(ctx.today, -29),
      to: ctx.today,
      label: 'Last 30 days',
    };
    const brandPublic = ctx.scope.brand?.id ?? ctx.filters.brands[0] ?? null;
    const brand = brandPublic
      ? await ctx.tx.db
          .selectFrom('core.record as rec')
          .innerJoin('tenancy.brand as b', 'b.id', 'rec.id')
          .select(['b.id', 'b.is_sensitive', 'b.lifecycle_state'])
          .where('rec.public_id', '=', brandPublic)
          .executeTakeFirst()
      : undefined;
    const allowed =
      ctx.p.kind === 'member' &&
      (brand
        ? decideBrand(ctx.p, 'health.view', {
            id: brand.id,
            isSensitive: brand.is_sensitive,
            lifecycleState: brand.lifecycle_state,
          }).allowed
        : !brandPublic && decideWorkspace(ctx.p, 'health.view').allowed);
    const base = {
      breakdown: [],
      columns,
      estimated: false,
      range: { from: r.from, to: r.to, label: r.label },
      applied: {
        range: ctx.filters.range !== null,
        brands: ctx.filters.brands.length > 0,
        projects: false,
        people: false,
        statuses: false,
      },
    };
    if (!allowed)
      return {
        ...base,
        value: null,
        rows: [],
        incomplete: ['no_measurement'],
        notes: ['Automation outcomes are shown to people who can view automation health here.'],
      };
    let q = ctx.tx.db
      .selectFrom('automation.automation_run as run')
      .innerJoin('automation.automation as a', 'a.id', 'run.automation_id')
      .select(['run.status', sql<number>`count(*)::int`.as('n')])
      .where('run.ended_at', '>=', new Date(`${r.from}T00:00:00Z`))
      .where('run.ended_at', '<', new Date(`${addDays(r.to, 1)}T00:00:00Z`))
      .groupBy('run.status');
    // A brand figure counts that brand's automations; the workspace figure counts them all.
    if (brand) q = q.where('a.brand_id', '=', brand.id);
    const counts = new Map((await q.execute()).map((x) => [x.status, Number(x.n)]));
    let w = ctx.tx.db
      .selectFrom('automation.automation_run as run')
      .innerJoin('automation.automation as a', 'a.id', 'run.automation_id')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('run.status', '=', 'waiting')
      .where('run.reason', '=', 'reconciliation_required');
    if (brand) w = w.where('a.brand_id', '=', brand.id);
    const uncertain = Number((await w.executeTakeFirstOrThrow()).n);
    const counted = OUTCOMES.filter((o) => o !== 'skipped').reduce(
      (s, o) => s + (counts.get(o) ?? 0),
      0,
    );
    const succeeded = counts.get('succeeded') ?? 0;
    return {
      ...base,
      value: counted ? Math.round((succeeded * 1000) / counted) / 10 : null,
      rows: OUTCOMES.map((o) => ({
        cells: { outcome: LABEL[o], runs: counts.get(o) ?? 0 },
        link: null,
      })),
      incomplete: uncertain > 0 ? ['no_measurement'] : [],
      notes: [
        'Success rate = succeeded / runs that ended (skipped runs excluded). Agent runs are not included.',
        ...(uncertain > 0
          ? [
              `${uncertain} run(s) wait for an owner to confirm what a webhook did; they are not counted until they end.`,
            ]
          : []),
      ],
    };
  },
  async drill(ctx, params, page) {
    const c = await this.compute(ctx, params);
    return {
      columns: c.columns,
      rows: c.rows.slice(0, page.limit),
      page: { limit: page.limit, has_more: false },
    };
  },
};
