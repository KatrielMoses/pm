import { defineConfig, devices } from '@playwright/test';

// Browser smoke against the real web/API + worker processes and a disposable PostgreSQL.
// Requires `pnpm build` first (serves apps/web/dist; PM_SMOKE_DIST=1 also runs the built servers).
const port = Number(process.env.PM_E2E_PORT ?? 4173);

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 2,
  timeout: 60_000,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // No HTML report in CI: failure attachments (page snapshots) can contain synthetic credentials.
  reporter: 'list',
  // Traces capture request bodies and DOM (passwords, one-time tokens, recovery codes). CI uploads
  // the report, so traces stay local-only there; failures report via the list output.
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: process.env.CI ? 'off' : 'retain-on-failure',
    screenshot: 'off',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // 1E: Medium width class (rail + overlay panels) with touch, at tablet portrait.
    {
      name: 'tablet',
      use: { ...devices['Galaxy Tab S4'] },
      testMatch:
        /(navigation|exit-journey|projects|tasks|task-interaction|workflows|capture|phase2-exit-journey|views|time|today|capacity|core-views|phase3-exit-journey|comments)\.spec\.ts/,
      grepInvert: /@desktop-only|@no-tablet/,
    },
    // Width-class and appearance journeys drive viewports themselves (desktop project only).
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grepInvert: /@desktop-only/ },
  ],
});
