import { describe, expect, it } from 'vitest';
import { checkWorkspaceGraph } from '../lib/workspace-graph.mjs';

const allowed = { '@x/a': [], '@x/b': ['@x/a'], '@pm/test-support': ['@x/a'] };

describe('workspace graph checker', () => {
  it('accepts an acyclic graph', () => {
    const { problems } = checkWorkspaceGraph(
      [{ name: '@x/a' }, { name: '@x/b', dependencies: { '@x/a': 'workspace:*' } }],
      allowed,
    );
    expect(problems).toEqual([]);
  });

  it('catches a cycle formed only through devDependencies (the 1A review regression)', () => {
    const { problems } = checkWorkspaceGraph(
      [
        { name: '@x/a', devDependencies: { '@pm/test-support': 'workspace:*' } },
        { name: '@pm/test-support', dependencies: { '@x/a': 'workspace:*' } },
      ],
      allowed,
    );
    expect(problems).toContain('cycle: @pm/test-support -> @x/a -> @pm/test-support');
  });

  it('catches cycles through optional and peer dependencies', () => {
    const opt = checkWorkspaceGraph(
      [
        { name: '@x/a', optionalDependencies: { '@x/b': '*' } },
        { name: '@x/b', dependencies: { '@x/a': '*' } },
      ],
      allowed,
    );
    expect(opt.problems.some((p) => p.startsWith('cycle:'))).toBe(true);
    const peer = checkWorkspaceGraph(
      [
        { name: '@x/a', peerDependencies: { '@x/b': '*' } },
        { name: '@x/b', dependencies: { '@x/a': '*' } },
      ],
      allowed,
    );
    expect(peer.problems.some((p) => p.startsWith('cycle:'))).toBe(true);
  });

  it('rejects disallowed runtime edges and runtime use of test packages', () => {
    const { problems } = checkWorkspaceGraph(
      [
        { name: '@x/a', dependencies: { '@x/b': '*', '@pm/test-support': '*' } },
        { name: '@x/b' },
        { name: '@pm/test-support' },
      ],
      allowed,
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        '@x/a -> @x/b: runtime edge not allowed',
        '@x/a -> @pm/test-support: test package used outside devDependencies',
      ]),
    );
  });
});
