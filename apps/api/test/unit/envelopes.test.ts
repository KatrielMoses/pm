import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');

describe('non-resource envelope stays confined (ADR-0007 D6, ADR-0008 B3)', () => {
  it('is used only by /v1/status, authentication responses, tenancy computed views, and the 2A project overview', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(join(dir, e.name))
          : /\.tsx?$/.test(e.name)
            ? [join(dir, e.name)]
            : [],
      );
    const uses = ['apps', 'packages']
      .flatMap((d) =>
        walk(join(ROOT, d)).filter(
          (f) => !f.includes('node_modules') && !f.includes('/dist/') && !f.includes('/test/'),
        ),
      )
      .flatMap((f) =>
        (readFileSync(f, 'utf8').match(/nonResourceEnvelope\(/g) ?? []).map(() =>
          f.replace(`${ROOT}/`, ''),
        ),
      );
    // /v1/status, the 1B authentication results, the 1C–1E tenancy computed views, and the 2A
    // project overview composite (closed non-resource list, ADR-0008 B3, ADR-0010, ADR-0013 P17),
    // the 2D task interaction views (ADR-0016), the 3A view catalog, field options, and default
    // resolution (ADR-0018), the 3D time views (ADR-0019), the 3B layout reads (ADR-0020), the 3C Today views
    // (ADR-0021), the 3E capacity reads (ADR-0022), the 4A collaboration summary (ADR-0023), the 4B notification views (ADR-0024), the 4C document exports (ADR-0025), the 5A search reads (ADR-0028), the 5B portfolio overview, dependency, and orphan reads (ADR-0029), the 5C metric reads (ADR-0030), the 5D widget, record, catalog, run, recipient, and share reads (ADR-0031), and the 6B token and webhook lists (ADR-0032).
    expect([...new Set(uses.filter((f) => !f.endsWith('envelopes.ts')))].sort()).toEqual([
      'apps/api/src/app.ts',
      'apps/api/src/auth/routes.ts',
      'apps/api/src/mcp/routes.ts',
      'apps/api/src/public/routes.ts',
      'apps/api/src/tenancy/routes.ts',
      'apps/api/src/work/capacity-routes.ts',
      'apps/api/src/work/capture-routes.ts',
      'apps/api/src/work/collab-routes.ts',
      'apps/api/src/work/document-routes.ts',
      'apps/api/src/work/files-routes.ts',
      'apps/api/src/work/goal-routes.ts',
      'apps/api/src/work/insight-routes.ts',
      'apps/api/src/work/integration-routes.ts',
      'apps/api/src/work/interaction-routes.ts',
      'apps/api/src/work/layout-routes.ts',
      'apps/api/src/work/metric-routes.ts',
      'apps/api/src/work/notify-routes.ts',
      'apps/api/src/work/planning-routes.ts',
      'apps/api/src/work/portability-routes.ts',
      'apps/api/src/work/routes.ts',
      'apps/api/src/work/search-routes.ts',
      'apps/api/src/work/task-routes.ts',
      'apps/api/src/work/time-routes.ts',
      'apps/api/src/work/view-routes.ts',
      'apps/api/src/work/workflow-routes.ts',
    ]);
  });
});

describe('project_overview is the only non-resource type 2A adds (ADR-0013 P17)', () => {
  const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
  const typesBuiltIn = (rel: string) =>
    [...read(rel).matchAll(/nonResourceEnvelope\(\s*'([a-z_]+)'/g)].map((m) => m[1]);

  it('only the work routes construct it, through the shared envelope builder, and they construct nothing else', () => {
    expect(typesBuiltIn('apps/api/src/work/routes.ts')).toEqual(['project_overview']);
    for (const rel of [
      'apps/api/src/app.ts',
      'apps/api/src/auth/routes.ts',
      'apps/api/src/tenancy/routes.ts',
    ])
      expect(typesBuiltIn(rel), rel).not.toContain('project_overview');
    // No hand-built envelope bypasses the builder anywhere in the API.
    const api = readdirSync(join(ROOT, 'apps/api/src'), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && /\.ts$/.test(e.name))
      .map((e) => join(e.parentPath, e.name));
    for (const f of api)
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/type:\s*'project_overview'/);
  });

  it('the builder refuses types outside the closed registry and registered resource types', async () => {
    const { nonResourceEnvelope } = await import('@pm/contracts');
    const ctx = { requestId: 'r', traceId: 't' } as never;
    expect(() => nonResourceEnvelope('project_summary' as never, {}, ctx)).toThrow();
    expect(() => nonResourceEnvelope('project' as never, {}, ctx)).toThrow();
  });
});
