import { rmSync } from 'node:fs';
for (const p of [
  'apps/api/dist',
  'apps/worker/dist',
  'apps/web/dist',
  ...['config', 'contracts', 'db', 'observability', 'platform', 'test-support'].map(
    (n) => `packages/${n}/dist`,
  ),
  'reports',
  'test-results',
  'playwright-report',
]) {
  rmSync(p, { recursive: true, force: true });
}
console.log('cleaned build outputs');
