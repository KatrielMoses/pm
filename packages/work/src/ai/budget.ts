import { newUuidV7, type ExecutionContext } from '@pm/contracts';
import { sql, type WorkspaceTransaction, type AiMeter, type AiFunding } from '@pm/db';
import { writeOutboxEvent } from '@pm/platform';
import { microsString, parseMicros } from './money.ts';

/**
 * Hard spending reservations (ADR-0038 A6, A7; 0B §9.3, 09 "hard spend caps"). Every amount is a
 * scaled integer: picodollars for `ai.cost` (micro-dollars with six fractional digits in SQL) and
 * millionths of a token for the token meters, so one decimal column type serves every meter.
 *
 * Invariants, enforced inside one transaction that locks the balance rows FOR UPDATE:
 *  - a reservation is taken only if consumed + reserved + open earlier-period reservations +
 *    amount <= hard limit, for every meter at once (all or nothing);
 *  - `reserved` equals the sum of this period's `held` and `unknown` reservations;
 *  - a reservation leaves `held`/`unknown` exactly once, to `settled` (actual usage, possibly zero)
 *    or `released`; a repeated settlement finds nothing open and changes nothing;
 *  - consumed usage is never reduced, so lowering a limit blocks new spend without erasing usage.
 */

export const AI_METERS: readonly AiMeter[] = ['ai.cost', 'ai.input_tokens', 'ai.output_tokens'];
const SCALE = 1_000_000n;

export type MeterAmounts = Record<AiMeter, bigint>;

export interface MeterLimit {
  allowance: bigint;
  hard: bigint;
  configured: boolean;
}

export interface LimitDefaults {
  monthlyAllowanceMicros: string;
  hardLimitMicros: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
}

export const tokens = (n: number | bigint): bigint => BigInt(n) * SCALE;

export function amountString(v: bigint): string {
  return microsString(v);
}

export function amountOf(v: string | number): bigint {
  return parseMicros(typeof v === 'number' ? String(v) : v);
}

/** The billing period: the calendar month containing `now` in the workspace timezone. */
export function periodFor(timezone: string, now: Date): { start: string; end: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === 'year')!.value);
  const month = Number(parts.find((p) => p.type === 'month')!.value);
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  const pad = (n: number) => String(n).padStart(2, '0');
  return { start: `${year}-${pad(month)}-01`, end: `${next.y}-${pad(next.m)}-01` };
}

export async function workspacePeriod(tx: WorkspaceTransaction, now: Date) {
  const ws = await tx.db
    .selectFrom('tenancy.workspace')
    .select(['timezone'])
    .where('id', '=', tx.workspaceId)
    .executeTakeFirstOrThrow();
  return { ...periodFor(ws.timezone, now), timezone: ws.timezone };
}

/** The authoritative current limits: configured rows, otherwise the finite deployment defaults. */
export async function effectiveLimits(
  tx: WorkspaceTransaction,
  defaults: LimitDefaults,
): Promise<Record<AiMeter, MeterLimit>> {
  const rows = await tx.db
    .selectFrom('metering.spend_limit')
    .select(['meter', 'monthly_allowance', 'hard_limit'])
    .where('scope_key', '=', tx.workspaceId)
    .execute();
  const byMeter = new Map(rows.map((r) => [r.meter, r]));
  const fallback: Record<AiMeter, { allowance: bigint; hard: bigint }> = {
    'ai.cost': {
      allowance: amountOf(defaults.monthlyAllowanceMicros),
      hard: amountOf(defaults.hardLimitMicros),
    },
    'ai.input_tokens': {
      allowance: tokens(defaults.inputTokenLimit),
      hard: tokens(defaults.inputTokenLimit),
    },
    'ai.output_tokens': {
      allowance: tokens(defaults.outputTokenLimit),
      hard: tokens(defaults.outputTokenLimit),
    },
  };
  const out = {} as Record<AiMeter, MeterLimit>;
  for (const meter of AI_METERS) {
    const r = byMeter.get(meter);
    out[meter] = r
      ? { allowance: amountOf(r.monthly_allowance), hard: amountOf(r.hard_limit), configured: true }
      : { ...fallback[meter], configured: false };
  }
  return out;
}

async function ensureBalances(tx: WorkspaceTransaction, period: { start: string; end: string }) {
  await tx.db
    .insertInto('metering.usage_balance')
    .values(
      AI_METERS.map((meter) => ({
        id: newUuidV7(),
        workspace_id: tx.workspaceId,
        scope_key: tx.workspaceId,
        meter,
        period_start: period.start,
        period_end: period.end,
      })),
    )
    .onConflict((oc) =>
      oc.columns(['workspace_id', 'scope_key', 'meter', 'period_start']).doNothing(),
    )
    .execute();
}

export interface BalanceView {
  meter: AiMeter;
  consumed: bigint;
  allowanceConsumed: bigint;
  reserved: bigint;
  /** Held or unknown reservations from earlier periods that will settle into this one. */
  carriedReserved: bigint;
  limit: MeterLimit;
  available: bigint;
}

/**
 * Reads (and with `lock`, locks) the current period's balances. Locking takes every balance row of
 * the meter up to and including the current period in period order, so a concurrent reservation or
 * settlement in an adjacent period serializes behind it.
 */
export async function balances(
  tx: WorkspaceTransaction,
  period: { start: string; end: string },
  limits: Record<AiMeter, MeterLimit>,
  opts: { lock: boolean },
): Promise<Record<AiMeter, BalanceView>> {
  if (opts.lock) await ensureBalances(tx, period);
  let q = tx.db
    .selectFrom('metering.usage_balance')
    .select(['meter', 'period_start', 'consumed', 'allowance_consumed', 'reserved'])
    .where('scope_key', '=', tx.workspaceId)
    .where('period_start', '<=', period.start)
    .orderBy('meter')
    .orderBy('period_start');
  if (opts.lock) q = q.forUpdate();
  const rows = await q.execute();
  const carried = await tx.db
    .selectFrom('metering.usage_reservation')
    .select(['meter', sql<string>`coalesce(sum(amount), 0)`.as('amount')])
    .where('state', 'in', ['held', 'unknown'])
    .where('period_start', '<', period.start)
    .groupBy('meter')
    .execute();
  const carriedBy = new Map(carried.map((r) => [r.meter, amountOf(r.amount)]));
  const out = {} as Record<AiMeter, BalanceView>;
  for (const meter of AI_METERS) {
    const row = rows.find(
      (r) => r.meter === meter && String(r.period_start).slice(0, 10) === period.start,
    );
    const consumed = row ? amountOf(row.consumed) : 0n;
    const reserved = row ? amountOf(row.reserved) : 0n;
    const carriedReserved = carriedBy.get(meter) ?? 0n;
    const limit = limits[meter];
    const used = consumed + reserved + carriedReserved;
    out[meter] = {
      meter,
      consumed,
      allowanceConsumed: row ? amountOf(row.allowance_consumed) : 0n,
      reserved,
      carriedReserved,
      limit,
      available: limit.hard > used ? limit.hard - used : 0n,
    };
  }
  return out;
}

export type ReserveOutcome =
  { reserved: true } | { reserved: false; meter: AiMeter; available: bigint; needed: bigint };

/**
 * Atomically reserves every meter's amount for one dispatch, or nothing. Must run in the same
 * transaction that records the dispatch row (the dispatch commits only with its reservation).
 */
export async function reserve(
  tx: WorkspaceTransaction,
  input: {
    operationId: string;
    dispatchId: string;
    period: { start: string; end: string };
    amounts: MeterAmounts;
    limits: Record<AiMeter, MeterLimit>;
  },
): Promise<ReserveOutcome> {
  const view = await balances(tx, input.period, input.limits, { lock: true });
  for (const meter of AI_METERS) {
    const needed = input.amounts[meter];
    if (needed > view[meter].available)
      return { reserved: false, meter, available: view[meter].available, needed };
  }
  for (const meter of AI_METERS) {
    const amount = input.amounts[meter];
    await tx.db
      .insertInto('metering.usage_reservation')
      .values({
        id: newUuidV7(),
        workspace_id: tx.workspaceId,
        operation_id: input.operationId,
        dispatch_id: input.dispatchId,
        meter,
        period_start: input.period.start,
        amount: amountString(amount),
      })
      .execute();
    await tx.db
      .updateTable('metering.usage_balance')
      .set({
        reserved: sql`reserved + ${amountString(amount)}::numeric`,
        updated_at: new Date(),
        version: sql`version + 1`,
      })
      .where('scope_key', '=', tx.workspaceId)
      .where('meter', '=', meter)
      .where('period_start', '=', input.period.start)
      .execute();
  }
  return { reserved: true };
}

export type Settlement =
  | { kind: 'actual'; amounts: MeterAmounts; basis: 'measured' | 'estimated' | 'reported' }
  | { kind: 'unknown' };

export interface SettleResult {
  /** Reservations this call moved out of `held` (or `unknown`). Zero for a repeated call. */
  settled: number;
  markedUnknown: number;
}

/**
 * Settles a dispatch's open reservations exactly once. Known usage moves from reserved to
 * consumed (in the current period when the reservation's period has closed, as a correction);
 * an unknown outcome keeps the full reservation counted as `unknown` until reconciled.
 */
export async function settle(
  tx: WorkspaceTransaction,
  input: {
    operationId: string;
    dispatchId: string;
    settlement: Settlement;
    funding: AiFunding;
    brandId: string | null;
    now: Date;
    currentPeriod: { start: string; end: string };
  },
): Promise<SettleResult> {
  const open = await tx.db
    .selectFrom('metering.usage_reservation')
    .select(['id', 'meter', 'period_start', 'amount', 'state'])
    .where('dispatch_id', '=', input.dispatchId)
    .where('state', 'in', input.settlement.kind === 'unknown' ? ['held'] : ['held', 'unknown'])
    .orderBy('meter')
    .forUpdate()
    .execute();
  if (!open.length) return { settled: 0, markedUnknown: 0 };
  if (input.settlement.kind === 'unknown') {
    await tx.db
      .updateTable('metering.usage_reservation')
      .set({ state: 'unknown', updated_at: input.now })
      .where(
        'id',
        'in',
        open.map((r) => r.id),
      )
      .execute();
    return { settled: 0, markedUnknown: open.length };
  }
  await ensureBalances(tx, input.currentPeriod);
  // Lock every balance this settlement touches in a fixed order (meter, then period).
  const periods = [
    ...new Set([
      ...open.map((r) => String(r.period_start).slice(0, 10)),
      input.currentPeriod.start,
    ]),
  ];
  await tx.db
    .selectFrom('metering.usage_balance')
    .select('id')
    .where('scope_key', '=', tx.workspaceId)
    .where('period_start', 'in', periods)
    .orderBy('meter')
    .orderBy('period_start')
    .forUpdate()
    .execute();
  const { amounts, basis } = input.settlement;
  let sequence = 0;
  for (const r of open) {
    const period = String(r.period_start).slice(0, 10);
    const amount = amounts[r.meter];
    const target = period < input.currentPeriod.start ? input.currentPeriod.start : period;
    await tx.db
      .updateTable('metering.usage_balance')
      .set({
        reserved: sql`reserved - ${r.amount}::numeric`,
        updated_at: input.now,
        version: sql`version + 1`,
      })
      .where('scope_key', '=', tx.workspaceId)
      .where('meter', '=', r.meter)
      .where('period_start', '=', period)
      .execute();
    const allowance = input.funding === 'workspace_key' ? '0' : amountString(amount);
    await tx.db
      .updateTable('metering.usage_balance')
      .set({
        consumed: sql`consumed + ${amountString(amount)}::numeric`,
        allowance_consumed: sql`allowance_consumed + ${allowance}::numeric`,
        updated_at: input.now,
        version: sql`version + 1`,
      })
      .where('scope_key', '=', tx.workspaceId)
      .where('meter', '=', r.meter)
      .where('period_start', '=', target)
      .execute();
    await tx.db
      .updateTable('metering.usage_reservation')
      .set({ state: 'settled', settled_amount: amountString(amount), updated_at: input.now })
      .where('id', '=', r.id)
      .execute();
    sequence += 1;
    const quantity = amountString(amount);
    await tx.db
      .insertInto('metering.usage_event')
      .values({
        id: newUuidV7(),
        workspace_id: tx.workspaceId,
        meter: r.meter,
        quantity,
        unit: r.meter === 'ai.cost' ? 'usd_micros' : 'tokens',
        cost_micros: r.meter === 'ai.cost' ? quantity : null,
        cost_basis: basis,
        funding: input.funding,
        brand_id: input.brandId,
        actor_type: 'ai',
        operation_id: input.operationId,
        dispatch_id: input.dispatchId,
        occurred_at: input.now,
        period_start: target,
        sequence,
      })
      .execute();
  }
  return { settled: open.length, markedUnknown: 0 };
}

/**
 * Emits `metering.usage.threshold_reached` once per crossed threshold (basis points of the hard
 * limit, counting consumed and reserved spend) and remembers the highest one for the period.
 */
export async function noteThresholds(
  tx: WorkspaceTransaction,
  input: {
    period: { start: string; end: string };
    limits: Record<AiMeter, MeterLimit>;
    thresholdsBp: readonly number[];
    context: ExecutionContext;
  },
): Promise<number[]> {
  const row = await tx.db
    .selectFrom('metering.usage_balance')
    .select(['id', 'consumed', 'reserved', 'last_threshold_bp'])
    .where('scope_key', '=', tx.workspaceId)
    .where('meter', '=', 'ai.cost')
    .where('period_start', '=', input.period.start)
    .forUpdate()
    .executeTakeFirst();
  const hard = input.limits['ai.cost'].hard;
  if (!row || hard === 0n) return [];
  const used = amountOf(row.consumed) + amountOf(row.reserved);
  const bp = Number((used * 10_000n) / hard);
  const crossed = input.thresholdsBp.filter((t) => t > row.last_threshold_bp && bp >= t);
  if (!crossed.length) return [];
  const top = crossed[crossed.length - 1]!;
  await tx.db
    .updateTable('metering.usage_balance')
    .set({ last_threshold_bp: top, updated_at: new Date(), version: sql`version + 1` })
    .where('id', '=', row.id)
    .execute();
  for (const t of crossed)
    await writeOutboxEvent(tx, {
      type: 'metering.usage.threshold_reached',
      aggregate: { type: 'metering.usage_balance', id: row.id, sequence: t },
      data: { meter: 'ai.cost', threshold_bp: t },
      actor: { type: 'system' },
      context: input.context,
    });
  return crossed;
}

export async function noteLimitReached(
  tx: WorkspaceTransaction,
  period: { start: string; end: string },
  meter: AiMeter,
  context: ExecutionContext,
): Promise<void> {
  await ensureBalances(tx, period);
  const row = await tx.db
    .selectFrom('metering.usage_balance')
    .select(['id', 'version'])
    .where('scope_key', '=', tx.workspaceId)
    .where('meter', '=', meter)
    .where('period_start', '=', period.start)
    .executeTakeFirstOrThrow();
  await writeOutboxEvent(tx, {
    type: 'metering.usage.limit_reached',
    aggregate: { type: 'metering.usage_balance', id: row.id, sequence: Number(row.version) },
    data: { meter },
    actor: { type: 'system' },
    context,
  });
}
