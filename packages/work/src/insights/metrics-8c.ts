import { sql } from '@pm/db';
import { decideBrand, decideWorkspace } from '@pm/tenancy';
import { addDays } from '../time/semantics.ts';
import type { MetricColumn, MetricProvider } from './metrics.ts';
import { resolveRange } from './semantics.ts';

/**
 * Phase 8C agent run outcomes through the 5D metric port (RPT-013; kept apart from automation
 * rates). The figure is the share of agent runs that ended in the range ready for review, in the
 * workspace or one brand, for people who may view health there (`health.view`). Ready for review
 * is draft output for a person, never acceptance; failed, partial, and cancelled runs are never
 * successes; runs waiting for a dispatch to be reconciled are open and never counted. Counts only:
 * no names, records, costs, or people.
 */
const columns: MetricColumn[] = [
  { key: 'outcome', label: 'Outcome' },
  { key: 'runs', label: 'Runs' },
];
const OUTCOMES = ['ready_for_review', 'failed', 'cancelled'] as const;
const LABEL: Record<(typeof OUTCOMES)[number], string> = {
  ready_for_review: 'Ready for review',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
const OP_OUTCOME: Record<string, (typeof OUTCOMES)[number]> = {
  succeeded: 'ready_for_review',
  partial: 'failed',
  failed: 'failed',
  skipped: 'failed',
  cancelled: 'cancelled',
};

export const agentRunsMetric: MetricProvider = {
  key: 'agent.rates',
  version: 1,
  label: 'Agent run outcomes',
  description:
    'Agent runs that ended in the chosen range by outcome; the rate is runs ready for review out of all that ended. Ready for review is not acceptance.',
  unit: 'percent',
  category: 'agents',
  source: { kind: 'agent_runs', label: 'Agent run history' },
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
        notes: ['Agent run outcomes are shown to people who can view health here.'],
      };
    let q = ctx.tx.db
      .selectFrom('agents.agent_run as run')
      .innerJoin('exec.operation as op', 'op.id', 'run.current_operation_id')
      .select(['op.execution_state', sql<number>`count(*)::int`.as('n')])
      .where('run.ended_at', '>=', new Date(`${r.from}T00:00:00Z`))
      .where('run.ended_at', '<', new Date(`${addDays(r.to, 1)}T00:00:00Z`))
      .groupBy('op.execution_state');
    if (brand) q = q.where('run.brand_id', '=', brand.id);
    const counts = new Map<string, number>();
    for (const x of await q.execute()) {
      const o = OP_OUTCOME[x.execution_state];
      if (o) counts.set(o, (counts.get(o) ?? 0) + Number(x.n));
    }
    let w = ctx.tx.db
      .selectFrom('agents.agent_run as run')
      .innerJoin('exec.operation as op', 'op.id', 'run.current_operation_id')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('run.ended_at', 'is', null)
      .where('op.waiting_reason', '=', 'reconciliation_required');
    if (brand) w = w.where('run.brand_id', '=', brand.id);
    const uncertain = Number((await w.executeTakeFirstOrThrow()).n);
    const ended = OUTCOMES.reduce((s, o) => s + (counts.get(o) ?? 0), 0);
    const ready = counts.get('ready_for_review') ?? 0;
    return {
      ...base,
      value: ended ? Math.round((ready * 1000) / ended) / 10 : null,
      rows: OUTCOMES.map((o) => ({
        cells: { outcome: LABEL[o], runs: counts.get(o) ?? 0 },
        link: null,
      })),
      incomplete: uncertain > 0 ? ['no_measurement'] : [],
      notes: [
        'Rate = runs ready for review / runs that ended. Ready for review is draft output for a person, not acceptance. Automation runs are not included.',
        ...(uncertain > 0
          ? [
              `${uncertain} run(s) wait for an owner to confirm what a dispatch did; they are not counted until they end.`,
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
