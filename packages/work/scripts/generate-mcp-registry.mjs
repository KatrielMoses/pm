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
// 8B (0D PL-54): the agent tool registry, generated from its contract next to the MCP registry.
const agentSourcePath = resolve(root, 'docs/architecture/platform/contracts/agent-tools.json');
const agentOutputPath = resolve(root, 'packages/work/src/agents/tool-registry.ts');
const agentRegistry = JSON.parse(readFileSync(agentSourcePath, 'utf8'));
const agentBody = `// GENERATED FILE - do not edit by hand.
// Source: docs/architecture/platform/contracts/agent-tools.json
// Regenerate: pnpm mcp:contracts:generate
export const AGENT_PROTOCOL = ${JSON.stringify(agentRegistry.protocol)};
export const AGENT_TOOL_REGISTRY_VERSION = ${JSON.stringify(agentRegistry.registry_version)};

export type AgentToolClass =
  | 'read_records'
  | 'draft_content'
  | 'create_subtasks'
  | 'attach_artifacts'
  | 'update_records'
  | 'run_tests'
  | 'code_change'
  | 'external_message'
  | 'publish'
  | 'spend'
  | 'access_change'
  | 'destructive'
  | 'production_change'
  | 'scope_expansion';

export interface AgentToolDef {
  name: string;
  version: string;
  tool_class: AgentToolClass;
  status: 'available' | 'unavailable';
  owner?: string;
  operation: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function freezeAll<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeAll(child);
  }
  return value;
}

export const AGENT_TOOLS: readonly AgentToolDef[] = freezeAll(${JSON.stringify(agentRegistry.tools, null, 2)});

/** A registered tool at an exact version (never a model- or connector-supplied name). */
export function agentTool(name: unknown, version: unknown): AgentToolDef | undefined {
  return AGENT_TOOLS.find((tool) => tool.name === name && tool.version === version);
}
`;

async function emit(path, text, label, command) {
  const options = (await resolveConfig(path)) ?? {};
  const formatted = await format(text, { ...options, filepath: path });
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      // Missing output is stale.
    }
    if (current !== formatted) {
      process.stderr.write(`${label} output is stale. Run: ${command}\n`);
      process.exit(1);
    }
    process.stdout.write(`${label}: generated contract is up to date\n`);
  } else {
    writeFileSync(path, formatted);
    process.stdout.write(`${label}: wrote ${path}\n`);
  }
}

await emit(outputPath, body, 'MCP registry', 'pnpm mcp:contracts:generate');
await emit(agentOutputPath, agentBody, 'Agent tool registry', 'pnpm mcp:contracts:generate');
