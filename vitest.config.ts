import { defineConfig } from 'vitest/config';

import { fileURLToPath } from 'node:url';

// Tests always run against workspace TypeScript sources, never against (possibly stale) build
// output. Each entry mirrors a package.json `exports` entry's `@pm/source` condition.
const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const ENTRIES: Record<string, string> = {
  '@pm/contracts': 'packages/contracts/src/index.ts',
  '@pm/config/public': 'packages/config/src/public.ts',
  '@pm/config': 'packages/config/src/index.ts',
  '@pm/observability': 'packages/observability/src/index.ts',
  '@pm/db': 'packages/db/src/index.ts',
  '@pm/platform': 'packages/platform/src/index.ts',
  '@pm/identity': 'packages/identity/src/index.ts',
  '@pm/test-support/vitest': 'packages/test-support/src/test-database.ts',
  '@pm/test-support/global-setup': 'packages/test-support/src/vitest-global-setup.ts',
  '@pm/test-support': 'packages/test-support/src/index.ts',
  '@pm/test-infra': 'packages/test-infra/src/index.ts',
};
const resolve = {
  alias: Object.entries(ENTRIES).map(([name, path]) => ({
    find: new RegExp(`^${name.replace('/', '\\/')}$`),
    replacement: src(path),
  })),
};

export default defineConfig({
  resolve,
  test: {
    projects: [
      {
        resolve,
        test: {
          name: 'unit',
          include: [
            'scripts/test/**/*.test.mjs',
            'packages/*/test/unit/**/*.test.ts',
            'apps/api/test/unit/**/*.test.ts',
            'apps/worker/test/unit/**/*.test.ts',
          ],
          environment: 'node',
        },
      },
      {
        resolve,
        test: {
          name: 'integration',
          include: [
            'packages/*/test/integration/**/*.test.ts',
            'apps/api/test/integration/**/*.test.ts',
            'apps/worker/test/integration/**/*.test.ts',
          ],
          environment: 'node',
          globalSetup: ['packages/test-support/src/vitest-global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        resolve,
        test: {
          name: 'web',
          include: ['apps/web/test/**/*.test.tsx'],
          environment: 'jsdom',
        },
      },
    ],
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'reports/junit.xml' },
  },
});
