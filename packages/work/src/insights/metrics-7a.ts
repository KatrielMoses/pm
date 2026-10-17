import { sql } from '@pm/db';
import { decideBrand, decideWorkspace } from '@pm/tenancy';
import { amountOf } from '../ai/budget.ts';
import { ceilMicros, usdDisplay } from '../ai/money.ts';
import { addDays } from '../time/semantics.ts';
import type { MetricColumn, MetricProvider } from './metrics.ts';
import { resolveRange } from './semantics.ts';

/**
 * Phase 7A AI usage through the 5D metric port (RPT-012, GOAL-011 contributions). The figure is
 * the measured, reported, or charged-at-bound AI cost from attempt-level usage events, in the
 * workspace or one brand, for people who may view usage there (`usage.view`: owners and
 * administrators, brand managers for their brands). It carries no prompts, outputs, people, or
 * runs. Cost still reserved for an unknown outcome is not counted until it is reconciled, and
 * the figure says so.
 */
const columns: MetricColumn[] = [
  { key: 'brand', label: 'Brand' },
  { key: 'cost', label: 'AI cost (USD)' },
  { key: 'input_tokens', label: 'Input tokens' },
  { key: 'output_tokens', label: 'Output tokens' },
];

export const aiUsageMetric: MetricProvider = {
  key: 'ai.usage',
  version: 1,
  label: 'AI usage and cost',
  description:
    'AI cost and tokens by brand in the chosen range, from settled usage (unknown outcomes are excluded until reconciled).',
  unit: 'none',
  category: 'ai',
  source: { kind: 'ai_usage', label: 'AI usage ledger' },
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
          .select(['b.id', 'b.name', 'b.is_sensitive', 'b.lifecycle_state'])
          .where('rec.public_id', '=', brandPublic)
          .executeTakeFirst()
      : undefined;
    const allowed = brand
      ? decideBrand(ctx.p, 'usage.view', {
          id: brand.id,
          isSensitive: brand.is_sensitive,
          lifecycleState: brand.lifecycle_state,
        }).allowed
      : !brandPublic && decideWorkspace(ctx.p, 'usage.view').allowed;
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
        notes: ['AI usage is shown to people who can view usage for this scope.'],
      };
    let q = ctx.tx.db
      .selectFrom('metering.usage_event as e')
      .leftJoin('tenancy.brand as b', 'b.id', 'e.brand_id')
      .select([
        'b.name as brand',
        sql<string>`coalesce(sum(e.quantity) FILTER (WHERE e.meter = 'ai.cost'), 0)`.as('cost'),
        sql<string>`coalesce(sum(e.quantity) FILTER (WHERE e.meter = 'ai.input_tokens'), 0)`.as(
          'input',
        ),
        sql<string>`coalesce(sum(e.quantity) FILTER (WHERE e.meter = 'ai.output_tokens'), 0)`.as(
          'output',
        ),
      ])
      .where('e.occurred_at', '>=', new Date(`${r.from}T00:00:00Z`))
      .where('e.occurred_at', '<', new Date(`${addDays(r.to, 1)}T00:00:00Z`))
      .groupBy('b.name')
      .orderBy('b.name');
    if (brand) q = q.where('e.brand_id', '=', brand.id);
    const rows = await q.execute();
    const unknown = await ctx.tx.db
      .selectFrom('metering.usage_reservation')
      .select(sql<number>`count(DISTINCT dispatch_id)::int`.as('n'))
      .where('state', '=', 'unknown')
      .executeTakeFirstOrThrow();
    let total = 0n;
    const out = rows.map((row) => {
      const cost = amountOf(row.cost);
      total += cost;
      return {
        cells: {
          brand: row.brand ?? 'Workspace',
          cost: usdDisplay(cost),
          input_tokens: Number(amountOf(row.input) / 1_000_000n),
          output_tokens: Number(amountOf(row.output) / 1_000_000n),
        },
        link: null,
      };
    });
    return {
      ...base,
      value: Number(ceilMicros(total)),
      rows: out,
      incomplete: unknown.n > 0 ? ['no_measurement'] : [],
      notes: [
        `Total ${usdDisplay(total)} (value in micro-dollars, rounded up). Customer billing is separate and not shown here.`,
        ...(unknown.n > 0
          ? [
              'Some AI attempts have an unknown outcome; their reserved cost is excluded until an owner reconciles it.',
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
