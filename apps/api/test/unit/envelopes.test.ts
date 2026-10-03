import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');

describe('non-resource envelope stays confined (ADR-0007 D6, ADR-0008 B3)', () => {
  it('is used only by /v1/status, authentication responses, and the 1C workspace context', () => {
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
    // /v1/status, the 1B authentication results, and the 1C server-derived workspace context
    // (closed non-resource list, ADR-0008 B3, ADR-0010).
    expect([...new Set(uses.filter((f) => !f.endsWith('envelopes.ts')))].sort()).toEqual([
      'apps/api/src/app.ts',
      'apps/api/src/auth/routes.ts',
      'apps/api/src/tenancy/routes.ts',
    ]);
  });
});
