/**
 * Runtime probe for the Phase 8B validator (phase8b.py): runs the real agent configuration
 * compiler, the endpoint guard, and the manifest parser, not a text search. It compiles every
 * starter template, reports the tool registry and the approval floor per class, and checks that
 * unsupported configuration, unsafe endpoints, and bad manifests are refused. Prints one JSON
 * document; no database, network, or clock.
 *
 *   node --conditions=@pm/source docs/engineering/tools/phase8b-probe.ts
 */
import {
  compileConfig,
  ConfigError,
  missingConfiguration,
  TOOL_CLASSES,
  type ConfigLimits,
} from '../../../packages/work/src/agents/config.ts';
import { checkEndpoint, isOwnCredential, parseManifest } from '../../../packages/work/src/agents/connectors.ts';
import { AGENT_TEMPLATES } from '../../../packages/work/src/agents/templates.ts';
import { AGENT_PROTOCOL, AGENT_TOOLS } from '../../../packages/work/src/agents/tool-registry.ts';

const LIMITS: ConfigLimits = {
  instructionsMaxChars: 8000,
  scopeGrantsMax: 50,
  toolGrantsMax: 20,
  configBytesMax: 32768,
};
const BR = 'br_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const compile = (raw: unknown) => {
  try {
    const c = compileConfig(raw, LIMITS);
    return {
      ok: true,
      unavailable: c.unavailable.map((u) => u.owner),
      tools: c.tools.map((t) => [t.name, t.tool_class, t.approval_class]),
      missing: missingConfiguration(c, null),
      scope: c.scope,
    };
  } catch (err) {
    if (err instanceof ConfigError) return { ok: false, codes: err.issues.map((i) => `${i.pointer}:${i.code}`) };
    throw err;
  }
};
const base = (over: Record<string, unknown> = {}) => ({
  schema_version: 1,
  kind: 'internal',
  instructions: 'Read the task.',
  model_key: null,
  tools: [{ name: 'pm.tasks.get', version: '1' }],
  scope: { brands: [BR] },
  ...over,
});

const templates: Record<string, unknown> = {};
for (const t of AGENT_TEMPLATES) templates[t.key] = { kind: t.kind, ...compile(t.draft()) };
const classes = Object.fromEntries(Object.entries(TOOL_CLASSES).map(([k, v]) => [k, v]));
const tools = AGENT_TOOLS.map((t) => ({ name: t.name, version: t.version, class: t.tool_class, status: t.status, owner: t.owner ?? null }));
const probes = {
  empty_scope: compile(base({ scope: {} })),
  unregistered_tool: compile(base({ tools: [{ name: 'shell.exec', version: '1' }] })),
  wrong_version: compile(base({ tools: [{ name: 'pm.tasks.get', version: '9' }] })),
  weaker_approval: compile(base({ approval_policy: { update_records: 'none' } })),
  r3_weaker: compile(base({ approval_policy: { publish: 'review_required' } })),
  unknown_field: compile(base({ run: 'rm -rf /' })),
  everything_scope: compile(base({ scope: { everything: true } })),
  unavailable_tool: compile(base({ tools: [{ name: 'pm.tests.run', version: '1' }] })),
};
const guard = { allowLoopback: false, productOrigin: 'https://pm.example.test' };
const endpoints: Record<string, unknown> = {};
for (const [k, url] of Object.entries({
  public_https: 'https://93.184.215.14/agent',
  plain_http: 'http://93.184.215.14/agent',
  private: 'https://10.1.2.3/',
  metadata: 'https://169.254.169.254/',
  loopback: 'https://127.0.0.1/',
  credentials: 'https://u:p@93.184.215.14/',
  own: 'https://pm.example.test/v1/mcp',
}))
  endpoints[k] = await checkEndpoint(url, guard);
const ok = { protocol: AGENT_PROTOCOL, version: '1', nonce: 'n', agent: { name: 'A', version: '1' }, tools: [] };
const manifests = {
  ok: parseManifest(ok, 'n').ok,
  wrong_protocol: parseManifest({ ...ok, protocol: 'other/1' }, 'n'),
  wrong_version: parseManifest({ ...ok, version: '2' }, 'n'),
  wrong_nonce: parseManifest({ ...ok, nonce: 'x' }, 'n'),
};
const credentials = { pm: isOwnCredential('pm_x'), oac: isOwnCredential('oac_x'), other: isOwnCredential('sk-x') };
console.log(JSON.stringify({ protocol: AGENT_PROTOCOL, templates, classes, tools, probes, endpoints, manifests, credentials }));
