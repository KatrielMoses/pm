import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConfigError, describeConfig, loadServerConfig, Secret } from '@pm/config';

const url = (role: string, db = 'pm_dev', extra = '') =>
  `postgres://${role}:pw_${role}@db.local:5432/${db}${extra}`;
const strong = (role: string, env: string) =>
  `postgres://${role}:Zq8vN3kL0pW2xR7t_${role}@db.internal:5432/pm_${env}?sslmode=verify-full`;

const local = {
  APP_ENV: 'local',
  DATABASE_APP_URL: url('app_rw'),
  DATABASE_WORKER_URL: url('app_worker'),
  DATABASE_DISPATCHER_URL: url('dispatcher'),
};
const deployed = (env: string, overrides: Record<string, string> = {}) => ({
  APP_ENV: env,
  BUILD_VERSION: '1.2.3',
  BUILD_ID: 'a1b2c3d',
  HTTP_HOST: '0.0.0.0',
  HTTP_PORT: '3000',
  HTTP_TRUST_PROXY: 'true',
  PUBLIC_BASE_URL: 'https://app.example.test',
  LOG_LEVEL: 'info',
  TRACE_SAMPLE_RATIO: '0.1',
  DATABASE_APP_URL: strong('app_rw', env),
  DATABASE_WORKER_URL: strong('app_worker', env),
  DATABASE_DISPATCHER_URL: strong('dispatcher', env),
  ...overrides,
});
const issues = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return [...e.issues];
    throw e;
  }
  return [];
};

describe('server configuration', () => {
  it('requires an explicit environment mode', () => {
    expect(issues(() => loadServerConfig({ service: 'api', env: {} }))[0]).toMatch(/^APP_ENV/);
  });

  it('applies conservative local defaults and loads only the identities a process needs', () => {
    const c = loadServerConfig({ service: 'api', env: local });
    expect(Object.keys(c.database.connections)).toEqual(['app']);
    expect(c.jobs.heartbeatIntervalMs * 3).toBeLessThan(c.jobs.leaseDurationMs);
    const w = loadServerConfig({ service: 'worker', env: local });
    expect(Object.keys(w.database.connections).sort()).toEqual(['dispatcher', 'worker']);
  });

  it('rejects missing secrets and wrong identities', () => {
    expect(issues(() => loadServerConfig({ service: 'api', env: { APP_ENV: 'local' } }))).toContain(
      'DATABASE_APP_URL: required for the api process',
    );
    expect(
      issues(() =>
        loadServerConfig({ service: 'api', env: { ...local, DATABASE_APP_URL: url('migrator') } }),
      ),
    ).toContain('DATABASE_APP_URL: must authenticate as role app_rw');
    expect(
      issues(() =>
        loadServerConfig({
          service: 'worker',
          env: { ...local, DATABASE_WORKER_URL: url('app_rw') },
        }),
      ),
    ).toContain('DATABASE_WORKER_URL: must authenticate as role app_worker');
  });

  it('accepts a complete production configuration', () => {
    const c = loadServerConfig({ service: 'worker', env: deployed('production') });
    expect(c.env).toBe('production');
  });

  it('rejects unsafe production defaults', () => {
    const found = issues(() =>
      loadServerConfig({
        service: 'api',
        env: deployed('production', {
          DATABASE_APP_URL: 'postgres://app_rw:dev@db.internal:5432/pm_production',
          PUBLIC_BASE_URL: 'http://app.example.test',
          LOG_LEVEL: 'debug',
          BUILD_ID: 'dev',
        }),
      }),
    );
    expect(found).toEqual(
      expect.arrayContaining([
        'DATABASE_APP_URL: TLS is required (sslmode=require or verify-full)',
        'DATABASE_APP_URL: credential is missing, too short, or a known development value',
        'PUBLIC_BASE_URL: must use https in deployed environments',
        'LOG_LEVEL: debug is not allowed in production',
        'BUILD_ID/BUILD_VERSION: development build identifiers are not allowed',
      ]),
    );
  });

  it('requires deployed environments to set values explicitly instead of inheriting local defaults', () => {
    const { HTTP_HOST: _h, PUBLIC_BASE_URL: _p, ...rest } = deployed('staging');
    expect(issues(() => loadServerConfig({ service: 'api', env: rest }))).toEqual(
      expect.arrayContaining([
        'HTTP_HOST: required in staging',
        'PUBLIC_BASE_URL: required in staging',
      ]),
    );
  });

  it('keeps preview, staging, and production database namespaces apart', () => {
    const crossed = issues(() =>
      loadServerConfig({
        service: 'api',
        env: deployed('staging', { DATABASE_APP_URL: strong('app_rw', 'production') }),
      }),
    );
    expect(crossed).toContain(
      'DATABASE_APP_URL: database name must belong to the staging namespace (pm_staging[_suffix])',
    );
    const split = issues(() =>
      loadServerConfig({
        service: 'worker',
        env: deployed('preview', {
          DATABASE_WORKER_URL: strong('app_worker', 'preview').replace(
            'pm_preview',
            'pm_preview_pr42',
          ),
        }),
      }),
    );
    expect(split).toContain(
      'database URLs: all identities of one process must target the same database',
    );
  });

  it('never hands operational identities to application processes in deployed environments', () => {
    expect(
      issues(() =>
        loadServerConfig({
          service: 'api',
          env: deployed('production', { DATABASE_MIGRATOR_URL: strong('migrator', 'production') }),
        }),
      ),
    ).toContain('DATABASE_MIGRATOR_URL: must not be provided to the api process');
  });

  it('rejects secret-store references until a provider is selected (DQ-28)', () => {
    expect(
      issues(() =>
        loadServerConfig({
          service: 'api',
          env: { ...local, DATABASE_APP_URL: 'secretref:pm/app' },
        }),
      )[0],
    ).toMatch(/secret-store provider/);
  });

  it('validates job parameters against 0D rules', () => {
    expect(
      issues(() =>
        loadServerConfig({
          service: 'worker',
          env: { ...local, JOB_LEASE_DURATION_MS: '3000', JOB_HEARTBEAT_INTERVAL_MS: '1500' },
        }),
      ),
    ).toContain(
      'JOB_HEARTBEAT_INTERVAL_MS: must be less than a third of JOB_LEASE_DURATION_MS (0D §7.3)',
    );
  });

  it('redacts secrets in dumps, JSON, string conversion, and inspection', () => {
    const c = loadServerConfig({ service: 'worker', env: local });
    const dump = JSON.stringify(describeConfig(c));
    expect(dump).not.toContain('pw_app_worker');
    expect(dump).toContain('[REDACTED]');
    const s = new Secret('hunter2');
    expect(`${s}`).toBe('[REDACTED]');
    expect(JSON.stringify({ s })).toBe('{"s":"[REDACTED]"}');
    expect(inspect({ s })).not.toContain('hunter2');
    expect(s.reveal()).toBe('hunter2');
  });

  it('error messages never echo values', () => {
    try {
      loadServerConfig({
        service: 'api',
        env: { ...local, DATABASE_APP_URL: 'postgres://migrator:SuperSecret@h/db' },
      });
    } catch (e) {
      expect(String(e)).not.toContain('SuperSecret');
    }
  });
});
