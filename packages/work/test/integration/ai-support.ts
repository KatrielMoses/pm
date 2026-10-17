import { Secret, type AiConfig } from '@pm/config';
import { WorkerRuntime } from '@pm/platform';
import { LogErrorReporter } from '@pm/observability';
import { FIXTURE_MODEL_KEY, type AiProviderFixture } from '@pm/test-support';
import type { TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import { aiDispatchHandler, MessagesProvider, type AiGatewayDeps, type ModelEntry } from '@pm/work';
import { mutation, type WorkEnv } from './fixture.ts';

/** The AI gateway against the deterministic protocol fixture (synthetic prices, no provider). */
export function fixtureAi(
  fx: AiProviderFixture,
  overrides: Partial<AiConfig> = {},
  models?: readonly ModelEntry[],
): AiGatewayDeps {
  const config: AiConfig = {
    provider: {
      provider: 'fixture',
      baseUrl: fx.baseUrl,
      apiKey: new Secret(fx.apiKey),
      timeoutMs: 3000,
    },
    approvedModels: [],
    byokEnabled: false,
    defaults: {
      monthlyAllowanceMicros: '1000000',
      hardLimitMicros: '1000000',
      inputTokenLimit: 2_000_000,
      outputTokenLimit: 500_000,
    },
    maxOutputTokens: 256,
    maxAttempts: 3,
    warningThresholdsBp: [8000, 10_000],
    historyRetentionDays: null,
    stream: { outputMaxChars: 40_000, eventMaxBytes: 65_536, maxBytes: 4_194_304 },
    retrieval: { sourcesMax: 8, sourceChars: 1500 },
    proposals: { approvalHours: 24, changesMax: 25 },
    ...overrides,
  };
  return {
    config,
    provider: new MessagesProvider({
      baseUrl: fx.baseUrl,
      timeoutMs: config.provider.provider === 'none' ? 1000 : config.provider.timeoutMs,
      maxTextChars: config.stream.outputMaxChars,
      maxEventBytes: config.stream.eventMaxBytes,
      maxWireBytes: config.stream.maxBytes,
    }),
    ...(models ? { models } : {}),
    entitlements: { aiAllowed: async () => true },
  };
}

export const stepUp = (ifMatch?: number) =>
  mutation({ stepUpToken: 't', ...(ifMatch !== undefined ? { ifMatch: `"${ifMatch}"` } : {}) });

export async function stepped<T>(env: WorkEnv, fn: () => Promise<T>): Promise<T> {
  env.stepUp.allow = true;
  try {
    return await fn();
  } finally {
    env.stepUp.allow = false;
  }
}

/** Turns AI on with the synthetic fixture model (owner or administrator, step-up). */
export async function enableAi(
  env: WorkEnv,
  who: Caller,
  ws: string,
  extra: Record<string, unknown> = {},
) {
  const current = await env.svc.getAiSettings(who, ws);
  return stepped(env, () =>
    env.svc.updateAiSettings(
      who,
      ws,
      { enabled: true, model_key: FIXTURE_MODEL_KEY, ...extra },
      stepUp(current.version),
    ),
  );
}

/** An in-process worker with only the AI dispatch handler, driven cycle by cycle. */
export async function aiWorker(env: WorkEnv, maxAttempts = 3) {
  const h = env.h;
  const j = h.config.jobs;
  const worker = new WorkerRuntime({
    db: h.worker,
    discovery: h.discovery,
    handlers: [
      aiDispatchHandler({
        tenant: h.worker,
        discovery: h.discovery,
        service: env.svc,
        metrics: h.telemetry.metrics,
        logger: h.logger,
        maxAttempts,
        timeoutMs: 20_000,
      }),
    ],
    consumers: [],
    params: {
      leaseDurationMs: j.leaseDurationMs,
      heartbeatIntervalMs: j.heartbeatIntervalMs,
      backoffBaseMs: 10,
      backoffCapMs: 20,
      maxAttempts,
      timeoutMs: 20_000,
      workspaceConcurrencyCap: 8,
      pollIntervalMs: 50,
      claimBatchSize: 10,
      shutdownGraceMs: 200,
      outboxReplayWindowMs: h.config.retention.outboxReplayWindowMs,
      maintenanceIntervalMs: 3_600_000,
      statsIntervalMs: 3_600_000,
    },
    buildId: 'test',
    logger: h.logger,
    metrics: h.telemetry.metrics,
    tracer: h.telemetry.tracer,
    errors: new LogErrorReporter(h.logger),
    random: () => 0,
  });
  await worker.start({ loop: false });
  return worker;
}

/**
 * Runs worker cycles until the operation is terminal or parked, pulling retry delays forward so a
 * provider Retry-After does not slow the suite (the delay itself is asserted where it matters).
 */
export async function drain(
  db: TestDatabase,
  worker: WorkerRuntime,
  runPublicId: string,
  max = 12,
) {
  for (let i = 0; i < max; i++) {
    await worker.runCycle({ wait: true });
    const r = await db.admin(
      `SELECT o.execution_state, o.waiting_reason FROM exec.operation o WHERE o.public_id = $1`,
      [runPublicId],
    );
    const s = r.rows[0] as { execution_state: string; waiting_reason: string | null };
    if (['succeeded', 'partial', 'failed', 'cancelled'].includes(s.execution_state)) return s;
    if (s.execution_state === 'waiting' && s.waiting_reason === 'reconciliation_required') return s;
    await db.admin(
      `UPDATE exec.job SET run_at = now() WHERE operation_id = (SELECT id FROM exec.operation WHERE public_id = $1)
         AND state = 'retry_scheduled'`,
      [runPublicId],
    );
  }
  throw new Error(`run ${runPublicId} did not settle`);
}

/** Ledger conservation for one workspace: balances agree with reservations and usage events. */
export async function ledger(db: TestDatabase, workspaceId: string) {
  const balances = (
    await db.admin(
      `SELECT meter, period_start::text AS period, consumed::text, reserved::text, allowance_consumed::text
         FROM metering.usage_balance WHERE workspace_id = $1 ORDER BY meter, period_start`,
      [workspaceId],
    )
  ).rows as Array<{
    meter: string;
    period: string;
    consumed: string;
    reserved: string;
    allowance_consumed: string;
  }>;
  const open = (
    await db.admin(
      `SELECT meter, period_start::text AS period, coalesce(sum(amount), 0)::text AS amount
         FROM metering.usage_reservation WHERE workspace_id = $1 AND state IN ('held', 'unknown')
        GROUP BY meter, period_start`,
      [workspaceId],
    )
  ).rows as Array<{ meter: string; period: string; amount: string }>;
  const events = (
    await db.admin(
      `SELECT meter, period_start::text AS period, coalesce(sum(quantity), 0)::text AS amount
         FROM metering.usage_event WHERE workspace_id = $1 GROUP BY meter, period_start`,
      [workspaceId],
    )
  ).rows as Array<{ meter: string; period: string; amount: string }>;
  const settled = (
    await db.admin(
      `SELECT coalesce(sum(settled_amount), 0)::text AS amount FROM metering.usage_reservation
        WHERE workspace_id = $1 AND state = 'settled' AND meter = 'ai.cost'`,
      [workspaceId],
    )
  ).rows[0] as { amount: string };
  const num = (v: string | undefined) => Number(v ?? 0);
  for (const b of balances) {
    const o = open.find((x) => x.meter === b.meter && x.period === b.period);
    const e = events.find((x) => x.meter === b.meter && x.period === b.period);
    if (num(o?.amount) !== num(b.reserved))
      throw new Error(
        `reserved ${b.reserved} != open reservations ${o?.amount ?? 0} (${b.meter} ${b.period})`,
      );
    if (num(e?.amount) !== num(b.consumed))
      throw new Error(
        `consumed ${b.consumed} != usage events ${e?.amount ?? 0} (${b.meter} ${b.period})`,
      );
  }
  const cost = balances.filter((b) => b.meter === 'ai.cost');
  return {
    consumed: cost.reduce((n, b) => n + num(b.consumed), 0),
    reserved: cost.reduce((n, b) => n + num(b.reserved), 0),
    settledReservations: num(settled.amount),
    balances,
  };
}
