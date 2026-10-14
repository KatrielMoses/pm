import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeferredAuditSink, startOperation } from '@pm/platform';
import {
  createHarness,
  executionContext,
  seedTwoWorkspaces,
  testEnv,
  type Harness,
  type TenantFixture,
} from '@pm/test-support';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';

// Runs the real entrypoints. PM_SMOKE_DIST=1 uses the built artifact (CI after `pnpm build`).
const ROOT = resolve(import.meta.dirname, '../../../..');
const DIST = process.env.PM_SMOKE_DIST === '1';
const entry = (app: 'api' | 'worker', file: string) =>
  DIST
    ? [join(ROOT, `apps/${app}/dist/${file}.js`)]
    : ['--conditions=@pm/source', join(ROOT, `apps/${app}/src/${file}.ts`)];

interface Proc {
  child: ChildProcess;
  out: string[];
  exited: Promise<number | null>;
}

function run(app: 'api' | 'worker', env: Record<string, string>): Proc {
  const child = spawn(process.execPath, entry(app, 'main'), {
    env: { PATH: process.env.PATH ?? '', ...env },
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out: string[] = [];
  child.stdout!.on('data', (d: Buffer) => out.push(...d.toString().split('\n').filter(Boolean)));
  child.stderr!.on('data', (d: Buffer) => out.push(...d.toString().split('\n').filter(Boolean)));
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return { child, out, exited };
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch {
      // not ready yet
    }
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => r(port));
    });
  });

describe('process smoke: web/API and worker entrypoints', () => {
  let db: TestDatabase;
  let h: Harness;
  let f: TenantFixture;
  let env: Record<string, string>;
  let api: Proc;
  let worker: Proc;
  let base: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    h = createHarness(db);
    f = await seedTwoWorkspaces(h.app);
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    env = {
      ...testEnv(db),
      LOG_LEVEL: 'info',
      HTTP_PORT: String(port),
      BUILD_VERSION: '0.1.0',
      BUILD_ID: 'smoke',
      WORKER_HEALTH_FILE: join(mkdtempSync(join(tmpdir(), 'pm-smoke-')), 'health'),
      WORKER_SHUTDOWN_GRACE_MS: '1000',
    };
  }, 120_000);
  afterAll(async () => {
    for (const p of [api, worker]) if (p && p.child.exitCode === null) p.child.kill('SIGKILL');
    await h.close();
    await db.drop();
  });

  it('starts the worker, which registers liveness and dispatches outbox events', async () => {
    worker = run('worker', env);
    await waitFor(async () =>
      (await db.admin('SELECT count(*)::int AS n FROM ops.worker_heartbeat')).rows[0].n > 0
        ? true
        : undefined,
    );
    const ctx = executionContext(f.alpha.id, f.principals.alphaMember);
    const op = await h.app.withWorkspace(f.alpha.id, { module: 'test' }, (tx) =>
      startOperation(
        tx,
        {
          kind: 'report_run',
          context: ctx,
          initiatedBy: { type: 'human', id: f.principals.alphaMember.id },
          queue: 'unhandled',
          jobKind: 'test.none',
          maxAttempts: 1,
          timeoutSeconds: 5,
          auditActionKey: 'report.run',
        },
        new DeferredAuditSink(),
      ),
    );
    await waitFor(async () =>
      (
        await db.admin('SELECT dispatched_at FROM exec.outbox_event WHERE operation_id = $1', [
          op.id,
        ])
      ).rows[0]?.dispatched_at
        ? true
        : undefined,
    );
    const hc = spawnSync(process.execPath, entry('worker', 'healthcheck'), {
      env: { ...env },
      cwd: ROOT,
    });
    expect(hc.status).toBe(0);
  });

  it('starts the worker without a signing key, which only the web/API process needs', async () => {
    const { AUTH_SIGNING_KEY: _omitted, ...rest } = env;
    const bare = {
      ...rest,
      WORKER_HEALTH_FILE: join(mkdtempSync(join(tmpdir(), 'pm-smoke-nokey-')), 'health'),
    };
    const p = run('worker', bare);
    try {
      // Healthy means the runtime started: the report service is built at startup, so a missing
      // key must not stop it (the image runs the worker without one).
      await waitFor(async () =>
        spawnSync(process.execPath, entry('worker', 'healthcheck'), { env: bare, cwd: ROOT })
          .status === 0
          ? true
          : undefined,
      );
      expect(p.out.some((l) => l.includes('worker.start_failed'))).toBe(false);
      expect(p.child.exitCode).toBeNull();
    } finally {
      p.child.kill('SIGTERM');
      await p.exited;
    }
  });

  it('starts the web/API process and becomes ready once the dispatcher is alive', async () => {
    api = run('api', env);
    const live = await waitFor(async () => {
      const r = await fetch(`${base}/healthz`);
      return r.ok ? r : undefined;
    });
    expect(await live.json()).toEqual({ status: 'ok' });
    const ready = await waitFor(async () => {
      const r = await fetch(`${base}/readyz`);
      return r.status === 200 ? r : undefined;
    });
    expect(((await ready.json()) as { checks: unknown }).checks).toEqual({
      database: 'ok',
      migrations: 'ok',
      dispatcher: 'ok',
      object_storage: 'not_configured',
      email_delivery: 'ok',
      recovery_gate: 'ok',
      tenant_isolation: 'ok',
      mcp_access: 'ok',
    });
    const status = (await (await fetch(`${base}/v1/status`)).json()) as { data: unknown };
    expect(status.data).toMatchObject({
      status: 'available',
      build: { version: '0.1.0', build: 'smoke' },
    });
    const hc = spawnSync(process.execPath, entry('api', 'healthcheck'), {
      env: { ...env },
      cwd: ROOT,
    });
    expect(hc.status).toBe(0);
  });

  it('shuts both processes down gracefully on SIGTERM', async () => {
    worker.child.kill('SIGTERM');
    api.child.kill('SIGTERM');
    expect(await worker.exited).toBe(0);
    expect(await api.exited).toBe(0);
    const live = await db.admin('SELECT count(*)::int AS n FROM ops.worker_heartbeat');
    expect(live.rows[0].n).toBe(0);
    const events = [...worker.out, ...api.out]
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .map((r) => r.event);
    expect(events).toEqual(
      expect.arrayContaining(['worker.started', 'worker.stopped', 'api.started', 'api.stopped']),
    );
  });

  it('emits only JSON logs without credentials or connection strings', () => {
    const password = new URL(db.app).password;
    for (const line of [...worker.out, ...api.out]) {
      expect(() => JSON.parse(line), line).not.toThrow();
      expect(line).not.toContain(password);
      expect(line).not.toContain('postgres://');
    }
  });

  it('refuses to start with an operational identity or a missing secret', async () => {
    const wrongRole = run('api', { ...env, DATABASE_APP_URL: db.migrator });
    expect(await wrongRole.exited).toBe(1);
    expect(wrongRole.out.join('\n')).toContain('must authenticate as role app_rw');
    expect(wrongRole.out.join('\n')).not.toContain(new URL(db.migrator).password);
    const { DATABASE_APP_URL: _omit, ...missing } = env;
    const noSecret = run('api', missing);
    expect(await noSecret.exited).toBe(1);
    expect(noSecret.out.join('\n')).toContain('DATABASE_APP_URL: required');
  });
});
