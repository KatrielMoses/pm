import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Browser-gate command selection in scripts/verify.sh (Phase 7B tooling follow-up). A full local
 * run once invoked `playwright test --project=all`, a project that does not exist; each CI shard
 * must keep running exactly its own project.
 */
const root = new URL('../../', import.meta.url);
const argsFor = (shard) =>
  execFileSync('bash', ['scripts/verify.sh'], {
    cwd: root,
    env: { ...process.env, PM_VERIFY_SHARD: shard, PM_VERIFY_PRINT_E2E: '1', CI: '' },
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);

/** Project names declared in playwright.config.ts. */
function configuredProjects() {
  const text = readFileSync(new URL('playwright.config.ts', root), 'utf8');
  const block = text.slice(text.indexOf('projects:'));
  return [...block.matchAll(/name:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);
}

describe('verify.sh browser-gate selection', () => {
  it('a full local run names every configured project and never an aggregate one', () => {
    const projects = configuredProjects();
    expect(projects.length).toBeGreaterThan(0);
    const args = argsFor('all');
    expect(args).toEqual(projects.map((p) => `--project=${p}`));
    expect(args).not.toContain('--project=all');
  });

  it('each CI shard keeps exactly its own project, and core runs no browser gate', () => {
    for (const p of configuredProjects()) expect(argsFor(`e2e-${p}`)).toEqual([`--project=${p}`]);
    expect(argsFor('core')).toEqual([]);
  });

  it('refuses an unknown shard instead of guessing', () => {
    expect(() => argsFor('e2e-everything')).toThrow();
  });
});
