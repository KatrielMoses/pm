import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FORBIDDEN_METRIC_LABELS, TELEMETRY_SIGNALS } from '@pm/contracts';
import { ALL_SIGNALS } from '../../src/metrics.ts';

const ROOT = resolve(import.meta.dirname, '../../../..');
const TYPE_OF = { count: 'counter', record: 'histogram', gauge: 'gauge' } as const;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name === 'node_modules' || e.name === 'dist' || e.name === 'test'
      ? []
      : e.isDirectory()
        ? sources(join(dir, e.name))
        : /\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')
          ? [join(dir, e.name)]
          : [],
  );
}

/** Every literal metric emission in runtime sources: name, method, and literal label keys. */
function emissions() {
  const files = ['packages', 'apps'].flatMap((top) =>
    readdirSync(join(ROOT, top), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .flatMap((e) => {
        try {
          return sources(join(ROOT, top, e.name, 'src'));
        } catch {
          return [];
        }
      }),
  );
  const rx =
    /\b(metrics|this|#metrics)\??\.(count|record|gauge)\(\s*'([a-z_]+(?:\.[a-z_]+)+)'(?:\s*,\s*[^,{)]+)?(?:\s*,\s*\{([^}]*)\})?/g;
  const out: Array<{
    file: string;
    method: keyof typeof TYPE_OF;
    name: string;
    keys: string[] | null;
  }> = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(rx)) {
      // `this.count(...)` is a metric emission only inside the metrics facade itself; elsewhere
      // `this` is a service's own helper (which forwards to a literal emission checked here).
      if (m[1] === 'this' && !file.includes('/packages/observability/src/')) continue;
      const body = m[4];
      const keys =
        body === undefined || body.includes('...')
          ? null
          : body
              .split(',')
              .map((p) => p.trim())
              .filter(Boolean)
              .map((p) => p.split(':')[0]!.trim());
      out.push({
        file: file.slice(ROOT.length + 1),
        method: m[2] as keyof typeof TYPE_OF,
        name: m[3]!,
        keys,
      });
    }
  }
  return out;
}

/** 0D PL-19: runtime metric emissions cannot silently diverge from the registry. */
describe('runtime metrics match the 0D telemetry registry', () => {
  const found = emissions();
  const byName = new Map(ALL_SIGNALS.map((s) => [s.name, s]));

  it('finds the emissions it checks (including every registered tenancy signal)', () => {
    expect(found.length).toBeGreaterThan(40);
    const tenancy = TELEMETRY_SIGNALS.filter((s) => s.name.startsWith('tenancy.')).map(
      (s) => s.name,
    );
    expect(tenancy.length).toBeGreaterThanOrEqual(10);
    for (const name of tenancy)
      expect(
        found.some((f) => f.name === name),
        name,
      ).toBe(true);
  });

  it('every emitted name is registered with the matching type and declared labels', () => {
    const problems: string[] = [];
    for (const f of found) {
      const signal = byName.get(f.name);
      if (!signal) {
        problems.push(`${f.file}: ${f.name} is not registered`);
        continue;
      }
      if (signal.type !== TYPE_OF[f.method])
        problems.push(`${f.file}: ${f.name} emitted as ${f.method}, registered ${signal.type}`);
      for (const key of f.keys ?? [])
        if (!(signal.labels as readonly string[]).includes(key))
          problems.push(`${f.file}: ${f.name} label ${key} undeclared`);
    }
    expect(problems).toEqual([]);
  });

  it('forbids tenant, person, name, time zone, and content labels everywhere', () => {
    for (const l of [
      'workspace_id',
      'brand_id',
      'public_id',
      'name',
      'workspace',
      'brand',
      'membership',
      'membership_id',
      'account',
      'account_id',
      'timezone',
      'content',
    ])
      expect(FORBIDDEN_METRIC_LABELS as readonly string[]).toContain(l);
    for (const s of ALL_SIGNALS)
      for (const l of s.labels)
        expect(FORBIDDEN_METRIC_LABELS as readonly string[], `${s.name}.${l}`).not.toContain(l);
  });
});
