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
 * Phase 1F/1C confinement. Tenant lifecycle and audit services need a policy decision. Since 1C the
 * only issuer reachable from a request is the tenancy policy compiler (`@pm/tenancy`), which
 * imports the restricted `@pm/lifecycle/policy-issuer` subpath; nothing else may. The API reaches
 * lifecycle only through `@pm/tenancy`, and the only lifecycle actions exposed are brand archive
 * and restore (`…/brands/{br}:archive|:restore`). Trash, purge, retention, and tenant audit stay
 * unexposed.
 */
describe('tenant lifecycle and audit endpoints are reachable only through policy decisions', () => {
  const appFiles = ['apps/api/src', 'apps/worker/src', 'apps/web/src'].flatMap((d) =>
    sources(join(ROOT, d)),
  );
  const packageFiles = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => {
      const dir = join(ROOT, 'packages', e.name, 'src');
      try {
        return sources(dir);
      } catch {
        return [];
      }
    });

  it('application code never imports the test-only decision issuer', () => {
    const offenders = appFiles.filter((f) =>
      readFileSync(f, 'utf8').includes('@pm/lifecycle/testing'),
    );
    expect(offenders).toEqual([]);
  });

  it('only the tenancy policy compiler imports the restricted decision issuer', () => {
    const importers = [...appFiles, ...packageFiles]
      .filter((f) => readFileSync(f, 'utf8').includes("from '@pm/lifecycle/policy-issuer'"))
      .map((f) => f.slice(ROOT.length + 1));
    // Only the tenancy policy compiler (its service modules) issues lifecycle decisions.
    expect(importers.length).toBeGreaterThan(0);
    expect(importers.filter((f) => !f.startsWith('packages/tenancy/src/'))).toEqual([]);
  });

  it('the API process reaches lifecycle only through @pm/tenancy', () => {
    const api = sources(join(ROOT, 'apps/api/src')).filter((f) =>
      readFileSync(f, 'utf8').includes("from '@pm/lifecycle"),
    );
    expect(api).toEqual([]);
  });

  it('no API route path exposes trash, purge, retention, records, or tenant audit', () => {
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
    // 1D: the "shared with me" list is the only record surface (exact-record grants and the
    // visibility predicate; no trash, purge, or lifecycle verbs).
    expect(paths).toContain('/v1/workspaces/:ws/shared');
  });

  it('archive and restore verbs exist only as brand actions in the tenancy routes', () => {
    const verbs = sources(join(ROOT, 'apps/api/src')).filter((f) =>
      /verb === '(archive|restore)'/.test(readFileSync(f, 'utf8')),
    );
    expect(verbs.map((f) => f.slice(ROOT.length + 1))).toEqual(['apps/api/src/tenancy/routes.ts']);
    const routes = readFileSync(join(ROOT, 'apps/api/src/tenancy/routes.ts'), 'utf8');
    expect(routes).toContain("'/v1/workspaces/:ws/brands/:brand'");
  });
});
