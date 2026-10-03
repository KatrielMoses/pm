import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');

describe('platform-singleton envelope stays confined (ADR-0007 D6)', () => {
  it('is used only by the /v1/status route', () => {
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
        (readFileSync(f, 'utf8').match(/platformSingletonEnvelope\(/g) ?? []).map(() =>
          f.replace(`${ROOT}/`, ''),
        ),
      );
    expect(uses.filter((f) => !f.endsWith('envelopes.ts'))).toEqual(['apps/api/src/app.ts']);
  });
});
