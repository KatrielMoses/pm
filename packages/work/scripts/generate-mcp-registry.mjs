import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const sourcePath = resolve(root, 'docs/architecture/platform/contracts/mcp-registry.json');
const outputPath = resolve(root, 'packages/work/src/integrations/mcp/registry.ts');
const registry = JSON.parse(readFileSync(sourcePath, 'utf8'));
const body = `// GENERATED FILE - do not edit by hand.
// Source: docs/architecture/platform/contracts/mcp-registry.json
// Regenerate: pnpm mcp:contracts:generate
export const MCP_PROTOCOL_VERSION = ${JSON.stringify(registry.protocol_version)};
export const MCP_REGISTRY_VERSION = ${JSON.stringify(registry.registry_version)};

export interface McpToolDef {
  name: string;
  version: string;
  description: string;
  requiredScopes: readonly string[];
  mutating: boolean;
  destructive: boolean;
  inputSchema: Record<string, unknown>;
}

export interface McpResourceDef {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  requiredScopes: readonly string[];
}

function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeTree(child);
  }
  return value;
}

export const MCP_TOOLS: readonly McpToolDef[] = freezeTree(${JSON.stringify(registry.tools, null, 2)});
export const MCP_RESOURCES: readonly McpResourceDef[] = freezeTree(${JSON.stringify(registry.resources, null, 2)});

export function toolByName(name: string, version?: string): McpToolDef | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name && (!version || tool.version === version));
}

export function resourceByUri(uri: string): McpResourceDef | undefined {
  return MCP_RESOURCES.find((resource) => resource.uri === uri);
}

export function scopesAllowTool(held: readonly string[], tool: McpToolDef): boolean {
  return tool.requiredScopes.some((scope) => held.includes(scope));
}

export function scopesAllowResource(held: readonly string[], resource: McpResourceDef): boolean {
  return resource.requiredScopes.some((scope) => held.includes(scope));
}
`;
const prettierOptions = (await resolveConfig(outputPath)) ?? {};
const formatted = await format(body, { ...prettierOptions, filepath: outputPath });

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(outputPath, 'utf8');
  } catch {
    // Missing output is stale.
  }
  if (current !== formatted) {
    console.error('MCP registry output is stale. Run: pnpm mcp:contracts:generate');
    process.exit(1);
  }
  console.log('MCP registry: generated contract is up to date');
} else {
  writeFileSync(outputPath, formatted);
  console.log(`MCP registry: wrote ${outputPath}`);
}
