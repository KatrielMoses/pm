import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  generatePasswords,
  provisionDatabase,
  startAgentConnectorFixture,
  startAiProviderFixture,
  startGoogleCalendarFixture,
  startPostgres,
  testEnv,
} from '@pm/test-support';

const ROOT = resolve(import.meta.dirname, '..');

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(join(ROOT, 'apps/web/dist/index.html')))
    throw new Error('Run `pnpm build` before the browser smoke test.');
  const port = process.env.PM_E2E_PORT ?? '4173';
  const scratch = mkdtempSync(join(tmpdir(), 'pm-e2e-'));
  const mailbox = join(scratch, 'mailbox');
  const server = await startPostgres();
  const urls = await provisionDatabase(server, 'pm_e2e', generatePasswords());
  // 6C: the deterministic Google OAuth + Calendar v3 contract fixture (never Google itself). The
  // real adapter in the API and worker talks to it over HTTP; browser tests drive it through its
  // token-protected control endpoint, one namespace per test workspace.
  const calendar = await startGoogleCalendarFixture();
  // 7A: the deterministic Anthropic Messages protocol fixture (never a real provider, no money
  // spent). The real Messages adapter in the API and worker talks to it; workspaces still start
  // with AI off, so every other journey runs exactly as before.
  const ai = await startAiProviderFixture();
  // 8B: deterministic local agent connector peers (synthetic; never a real agent). Connector tests
  // in the API and worker reach them over loopback only because the fixture transport is on.
  const agents = await startAgentConnectorFixture();
  const env = {
    PATH: process.env.PATH ?? '',
    ...testEnv(urls),
    LOG_LEVEL: 'warn',
    HTTP_PORT: port,
    BUILD_VERSION: '0.1.0',
    BUILD_ID: 'e2e',
    WEB_DIST_DIR: join(ROOT, 'apps/web/dist'),
    WORKER_HEALTH_FILE: join(scratch, 'health'),
    // Identity: links and the CSRF origin check use the browser-visible origin.
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    MAIL_CAPTURE_DIR: mailbox,
    WORKER_POLL_INTERVAL_MS: '100',
    // 1F: the local/test component harness and a scratch purge ledger (development adapters).
    COMPONENT_HARNESS: 'true',
    PURGE_LEDGER: 'local',
    PURGE_LEDGER_DIR: join(scratch, 'purge-ledger'),
    // 4E: the local object store (signed same-origin URLs) and the test-signature scanner, for
    // both the API (uploads, downloads) and the worker (the `files.scan` job).
    OBJECT_STORAGE: 'local',
    OBJECT_STORAGE_LOCAL_DIR: join(scratch, 'objects'),
    OBJECT_STORAGE_LOCAL_SECRET: randomBytes(32).toString('base64url'),
    OBJECT_STORAGE_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    MALWARE_SCANNER: 'test-signature',
    ...calendar.env(`http://127.0.0.1:${port}/v1/integrations/oauth/google_calendar/callback`),
    ...ai.env(),
    // A call held open by the fixture outlives the browser's cancel click comfortably.
    AI_PROVIDER_TIMEOUT_MS: '15000',
    // 7F: synthetic transcription through the same deterministic fixture (refused when deployed).
    TRANSCRIPTION_PROVIDER: 'fixture',
    TRANSCRIPTION_BASE_URL: ai.baseUrl,
    TRANSCRIPTION_API_KEY: ai.apiKey,
    // 8B: the synthetic agent connector transport (refused when deployed).
    AGENT_CONNECTOR_TRANSPORT: 'fixture',
    RATE_LIMIT_POLICIES: JSON.stringify({
      'sign_in.source': { limit: 10000, windowMs: 60000 },
      'sign_in.email': { limit: 10000, windowMs: 60000 },
      'register.source': { limit: 10000, windowMs: 60000 },
      'token.source': { limit: 10000, windowMs: 60000 },
      'recovery.source': { limit: 10000, windowMs: 60000 },
      'resend.source': { limit: 10000, windowMs: 60000 },
      'oauth.source': { limit: 10000, windowMs: 60000 },
    }),
  };
  // Captured mail (one-time links) stays in a private temp directory, never in reports.
  process.env.PM_E2E_MAILBOX = mailbox;
  // Phase 1 exit journey: seeds one test-only fixture record and inspects state past RLS. These
  // URLs carry generated per-run passwords and live only in this process tree's environment.
  process.env.PM_E2E_ADMIN_URL = server.adminUrl('pm_e2e');
  process.env.PM_E2E_APP_URL = urls.app;
  process.env.PM_E2E_WORKER_URL = urls.worker;
  process.env.PM_E2E_GCAL_URL = calendar.baseUrl;
  process.env.PM_E2E_GCAL_TOKEN = calendar.controlToken;
  process.env.PM_E2E_AI_URL = ai.baseUrl;
  process.env.PM_E2E_AI_TOKEN = ai.controlToken;
  process.env.PM_E2E_AGENT_URL = agents.baseUrl;
  process.env.PM_E2E_AGENT_TOKEN = agents.controlToken;
  const dist = process.env.PM_SMOKE_DIST === '1';
  const start = (app: string): ChildProcess =>
    spawn(
      process.execPath,
      dist
        ? [join(ROOT, `apps/${app}/dist/main.js`)]
        : ['--conditions=@pm/source', join(ROOT, `apps/${app}/src/main.ts`)],
      { env, stdio: 'inherit', cwd: ROOT },
    );
  const procs = [start('worker'), start('api')];
  const until = Date.now() + 30_000;
  for (;;) {
    const ok = await fetch(`http://127.0.0.1:${port}/readyz`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) break;
    if (Date.now() > until) throw new Error('web/API process did not become ready');
    await new Promise((r) => setTimeout(r, 200));
  }
  return async () => {
    for (const p of procs) p.kill('SIGTERM');
    await Promise.all(
      procs.map((p) => new Promise((r) => (p.exitCode !== null ? r(null) : p.on('exit', r)))),
    );
    await calendar.close();
    await ai.close();
    await agents.close();
    await server.stop();
  };
}
