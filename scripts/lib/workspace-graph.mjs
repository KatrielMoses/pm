// Workspace graph rules (pure; used by the CLI and by its regression tests).

export const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

/** Allowed runtime (`dependencies`) edges between workspace packages. */
export const ALLOWED_RUNTIME = {
  '@pm/contracts': [],
  '@pm/config': [],
  '@pm/observability': ['@pm/contracts'],
  '@pm/db': ['@pm/contracts', '@pm/config', '@pm/observability'],
  '@pm/platform': ['@pm/contracts', '@pm/config', '@pm/observability', '@pm/db'],
  '@pm/test-infra': [],
  '@pm/test-support': [
    '@pm/test-infra',
    '@pm/contracts',
    '@pm/config',
    '@pm/observability',
    '@pm/db',
  ],
  '@pm/api': ['@pm/contracts', '@pm/config', '@pm/observability', '@pm/db', '@pm/platform'],
  '@pm/worker': ['@pm/contracts', '@pm/config', '@pm/observability', '@pm/db', '@pm/platform'],
  '@pm/web': ['@pm/config'],
};

/** Test-only packages: never a runtime dependency of a shipped package. */
export const TEST_PACKAGES = ['@pm/test-infra', '@pm/test-support'];

/**
 * @param manifests Array of package.json objects for workspace packages.
 * @returns problems (empty when valid)
 */
export function checkWorkspaceGraph(manifests, allowedRuntime = ALLOWED_RUNTIME) {
  const problems = [];
  const names = new Set(manifests.map((m) => m.name));
  const all = new Map(); // full graph: every dependency field
  for (const m of manifests) {
    const edges = new Set();
    for (const field of DEPENDENCY_FIELDS) {
      for (const dep of Object.keys(m[field] ?? {})) if (names.has(dep)) edges.add(dep);
    }
    all.set(m.name, [...edges].sort());
    if (/util/i.test(m.name)) problems.push(`${m.name}: generic utils packages are not allowed`);
    if (!(m.name in allowedRuntime))
      problems.push(`${m.name}: not registered in the package graph`);
    for (const dep of Object.keys(m.dependencies ?? {}).filter((d) => names.has(d))) {
      if (!(allowedRuntime[m.name] ?? []).includes(dep))
        problems.push(`${m.name} -> ${dep}: runtime edge not allowed`);
    }
    if (!TEST_PACKAGES.includes(m.name)) {
      for (const dep of [
        ...Object.keys(m.dependencies ?? {}),
        ...Object.keys(m.optionalDependencies ?? {}),
      ]) {
        if (TEST_PACKAGES.includes(dep))
          problems.push(`${m.name} -> ${dep}: test package used outside devDependencies`);
      }
    }
  }
  // Cycle detection over the complete graph (runtime + dev + optional + peer).
  const state = new Map();
  const visit = (node, path) => {
    if (state.get(node) === 'done') return;
    if (state.get(node) === 'active') {
      problems.push(`cycle: ${[...path.slice(path.indexOf(node)), node].join(' -> ')}`);
      return;
    }
    state.set(node, 'active');
    for (const next of all.get(node) ?? []) visit(next, [...path, node]);
    state.set(node, 'done');
  };
  for (const node of [...all.keys()].sort()) visit(node, []);
  return { problems, graph: all };
}
