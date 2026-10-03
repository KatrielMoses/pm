import type { ServerConfig } from '@pm/config';
import type { PlatformHealth } from '@pm/db';
import { errorFields, type Logger, type Metrics } from '@pm/observability';

export type CheckResult = 'ok' | 'fail' | 'not_configured';
export interface Readiness {
  ready: boolean;
  checks: Record<
    | 'database'
    | 'migrations'
    | 'dispatcher'
    | 'object_storage'
    | 'recovery_gate'
    | 'tenant_isolation',
    CheckResult
  >;
}

export interface ReadinessDeps {
  health: PlatformHealth;
  expectedMigrationVersion: number;
  config: ServerConfig['readiness'];
  logger: Logger;
  metrics: Metrics;
  isDraining: () => boolean;
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('readiness check timed out')), ms),
    ),
  ]);

/**
 * Readiness (0D §17.4): database reachable, migrations at (or beyond, during expand/contract
 * rollouts) the version bundled in this artifact, dispatcher alive, object storage reachable
 * (not part of 1A), the post-restore recovery gate open (1F), and the tenant-isolation policy
 * state intact (1C). Reasons are logged internally; responses carry only check names and states.
 */
export async function checkReadiness(deps: ReadinessDeps): Promise<Readiness> {
  const checks: Readiness['checks'] = {
    database: 'fail',
    migrations: 'fail',
    dispatcher: 'fail',
    object_storage: 'not_configured',
    recovery_gate: 'fail',
    tenant_isolation: 'fail',
  };
  const fail = (check: string, reason: string, err?: unknown) =>
    deps.logger.warn('readiness.check_failed', { check, reason, ...(err ? errorFields(err) : {}) });

  try {
    await withTimeout(deps.health.ping(), 2_000);
    checks.database = 'ok';
  } catch (err) {
    fail('database', 'unreachable', err);
  }
  if (checks.database === 'ok') {
    try {
      const applied = await withTimeout(deps.health.appliedMigrationVersion(), 2_000);
      if (applied >= deps.expectedMigrationVersion) checks.migrations = 'ok';
      else
        fail(
          'migrations',
          `applied version ${applied} is behind artifact version ${deps.expectedMigrationVersion}`,
        );
    } catch (err) {
      fail('migrations', 'unreadable', err);
    }
    // A restored environment stays closed until purge-ledger replay completes (0B §8.11).
    try {
      if (await withTimeout(deps.health.recoveryGateOpen(), 2_000)) checks.recovery_gate = 'ok';
      else fail('recovery_gate', 'purge-ledger replay required');
    } catch (err) {
      fail('recovery_gate', 'unreadable', err);
    }
    // Required tenant RLS and directory ownership (1C); names and states only, never counts.
    try {
      if (await withTimeout(deps.health.tenantIsolationIntact(), 2_000))
        checks.tenant_isolation = 'ok';
      else fail('tenant_isolation', 'tenant isolation policy state is incomplete');
    } catch (err) {
      fail('tenant_isolation', 'unreadable', err);
    }
    if (!deps.config.requireDispatcher) {
      checks.dispatcher = 'not_configured';
    } else {
      try {
        const age = await withTimeout(deps.health.freshestWorkerHeartbeatAgeMs(), 2_000);
        if (age !== null && age <= deps.config.dispatcherStaleMs) checks.dispatcher = 'ok';
        else fail('dispatcher', age === null ? 'no running worker' : 'worker heartbeat stale');
      } catch (err) {
        fail('dispatcher', 'unreadable', err);
      }
    }
  }
  for (const [check, result] of Object.entries(checks)) {
    deps.metrics.count('readiness.checks', 1, { check, outcome: result });
  }
  const ready = !deps.isDraining() && Object.values(checks).every((c) => c !== 'fail');
  return { ready, checks };
}
