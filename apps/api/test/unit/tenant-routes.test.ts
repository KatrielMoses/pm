import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : /\.tsx?$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );
}

/**
 * Phase 1F: tenant lifecycle and audit services need a policy decision from 1D. Until then no
 * public route may reach them, and no application code may use the test-only decision issuer.
 */
describe('no tenant lifecycle or audit endpoint before 1D policy decisions', () => {
  const appFiles = ['apps/api/src', 'apps/worker/src', 'apps/web/src'].flatMap((d) =>
    sources(join(ROOT, d)),
  );

  it('application code never imports the test-only decision issuer', () => {
    const offenders = appFiles.filter((f) =>
      readFileSync(f, 'utf8').includes('@pm/lifecycle/testing'),
    );
    expect(offenders).toEqual([]);
  });

  it('the API process does not wire lifecycle services at all', () => {
    const api = sources(join(ROOT, 'apps/api/src')).filter((f) =>
      readFileSync(f, 'utf8').includes("from '@pm/lifecycle'"),
    );
    expect(api).toEqual([]);
  });

  it('no API route path exposes trash, archive, restore, purge, retention, or tenant audit', () => {
    const paths = sources(join(ROOT, 'apps/api/src')).flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/['`](\/v1\/[^'`\s]*)['`]/g)].map((m) => m[1]!),
    );
    expect(paths.length).toBeGreaterThan(10);
    const tenant = paths.filter((p) =>
      /(trash|archive|restore|purge|retention|audit|records?\b|lifecycle)/.test(p),
    );
    expect(tenant).toEqual([]);
    // The only audit-derived surface is the account's own security activity.
    expect(paths).toContain('/v1/auth/security-activity');
  });
});
