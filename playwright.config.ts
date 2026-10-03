import { defineConfig, devices } from '@playwright/test';

// Browser smoke against the real web/API + worker processes and a disposable PostgreSQL.
// Requires `pnpm build` first (serves apps/web/dist; PM_SMOKE_DIST=1 also runs the built servers).
const port = Number(process.env.PM_E2E_PORT ?? 4173);

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
