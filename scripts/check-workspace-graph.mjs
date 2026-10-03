// Enforces the workspace package graph:
//   1. the complete graph (dependencies, devDependencies, optionalDependencies, peerDependencies)
//      is acyclic, matching pnpm's own cyclic-workspace check;
//   2. runtime edges follow the layered allow-list; test packages are dev-only; no utils package.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { checkWorkspaceGraph } from './lib/workspace-graph.mjs';

const manifests = [];
for (const base of ['apps', 'packages']) {
  for (const name of readdirSync(base)) {
    const file = `${base}/${name}/package.json`;
    if (existsSync(file)) manifests.push(JSON.parse(readFileSync(file, 'utf8')));
  }
}
const { problems, graph } = checkWorkspaceGraph(manifests);
if (problems.length) {
  console.error(`Workspace graph check failed:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
const edges = [...graph.values()].reduce((n, e) => n + e.length, 0);
console.log(
  `Workspace graph check passed (${graph.size} packages, ${edges} edges incl. dev/optional/peer, acyclic; runtime layering valid)`,
);
if (process.argv.includes('--print'))
  for (const [k, v] of graph) console.log(`  ${k} -> ${v.join(', ') || '(none)'}`);
