import { describe, expect, it } from 'vitest';
import {
  APPROVAL_ORDER,
  compileConfig,
  ConfigError,
  missingConfiguration,
  TOOL_CLASSES,
  type ConfigLimits,
} from '../../src/agents/config.ts';
import { checkEndpoint, isOwnCredential, parseManifest } from '../../src/agents/connectors.ts';
import { AGENT_TEMPLATES } from '../../src/agents/templates.ts';
import { AGENT_TOOLS } from '../../src/agents/tool-registry.ts';

const LIMITS: ConfigLimits = {
  instructionsMaxChars: 8000,
  scopeGrantsMax: 50,
  toolGrantsMax: 20,
  configBytesMax: 32768,
};
const BR = 'br_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const base = (over: Record<string, unknown> = {}) => ({
  schema_version: 1,
  kind: 'internal',
  instructions: 'Do the task.',
  model_key: null,
  tools: [{ name: 'pm.tasks.get', version: '1' }],
  scope: { brands: [BR] },
  ...over,
});
const codes = (raw: unknown, limits = LIMITS) => {
  try {
    compileConfig(raw, limits);
    return [];
  } catch (err) {
    if (err instanceof ConfigError) return err.issues.map((i) => `${i.pointer}:${i.code}`);
    throw err;
  }
};

describe('agent configuration (8B compiler)', () => {
  it('AT-620 compiles a typed configuration canonically and refuses anything unsupported, unregistered, weaker, or unbounded', () => {
    const c = compileConfig(base({ approval_policy: { read_records: 'review_required' } }), LIMITS);
    expect(c.tools).toEqual([
      {
        name: 'pm.tasks.get',
        version: '1',
        tool_class: 'read_records',
        approval_class: 'review_required',
      },
    ]);
    expect(c.limits).toEqual({ max_runtime_minutes: 60, max_tool_calls: 100, max_artifacts: 10 });
    expect(c.scope).toEqual({ brand: [BR], project: [], record: [], integration: [] });
    // Key order does not change the canonical form (the revision hash).
    expect(compileConfig({ ...base(), schema_version: 1 }, LIMITS).canonical).toBe(
      compileConfig(base(), LIMITS).canonical,
    );
    expect(codes(base({ tools: [{ name: 'shell.exec', version: '1' }] }))).toEqual([
      '/tools/0:unregistered_tool',
    ]);
    expect(
      codes(base({ tools: [{ name: 'pm.tasks.get', version: '1', approval: 'none' }] })),
    ).toEqual(['/tools/0:invalid_type']);
    expect(
      codes(
        base({
          tools: [
            { name: 'pm.tasks.get', version: '1' },
            { name: 'pm.tasks.get', version: '1' },
          ],
        }),
      ),
    ).toEqual(['/tools/1:duplicate']);
    expect(codes(base({ approval_policy: { update_records: 'none' } }))).toEqual([
      '/approval_policy/update_records:weaker_than_policy',
    ]);
    expect(codes(base({ approval_policy: { publish: 'review_required' } }))).toEqual([
      '/approval_policy/publish:weaker_than_policy',
    ]);
    expect(codes(base({ approval_policy: { teleport: 'none' } }))).toEqual([
      '/approval_policy/teleport:invalid_option',
    ]);
    expect(codes(base({ limits: { max_runtime_minutes: 0 } }))).toEqual([
      '/limits/max_runtime_minutes:out_of_range',
    ]);
    expect(codes(base({ instructions: 'x'.repeat(8001) }))).toEqual([
      '/instructions:invalid_length',
    ]);
    expect(codes(base({ instructions: 'bell\u0007' }))).toEqual(['/instructions:invalid_format']);
    expect(codes(base({ scope: { brands: ['brand-one'] } }))).toEqual([
      '/scope/brands/0:invalid_reference',
    ]);
    expect(codes(base({ scope: { everything: true } }))).toEqual([
      '/scope/everything:unknown_field',
    ]);
    expect(codes(base({ kind: 'external', model_key: 'x' }))).toEqual([
      '/model_key:not_applicable',
    ]);
    expect(codes(base({ model_key: 'unknown/model' }))).toEqual(['/model_key:invalid_option']);
    expect(codes(base({ run: 'rm -rf /' }))).toEqual(['/run:unknown_field']);
    expect(
      codes(
        base({ tools: AGENT_TOOLS.slice(0, 3).map((t) => ({ name: t.name, version: t.version })) }),
        { ...LIMITS, toolGrantsMax: 2 },
      ),
    ).toEqual(['/tools:too_many']);
    // Empty scope compiles (it means nothing) and is named as missing configuration.
    const empty = compileConfig(base({ scope: {} }), LIMITS);
    expect(missingConfiguration(empty, null)).toEqual(['scope', 'model']);
  });

  it('AT-621 the policy floor follows the accepted 0C classes: R3/R4 always need a human approval, never weaker', () => {
    for (const [cls, def] of Object.entries(TOOL_CLASSES)) {
      if (def.risk === 'R3' || def.risk === 'R4')
        expect([cls, def.minimum]).toEqual([cls, 'human_approval']);
      expect(APPROVAL_ORDER).toContain(def.minimum);
    }
    // Every registered tool names an accepted class; unavailable ones name their phase.
    for (const t of AGENT_TOOLS) {
      expect(TOOL_CLASSES[t.tool_class]).toBeDefined();
      if (t.status === 'unavailable') expect(t.owner).toMatch(/^\d+[A-F]$/);
    }
    expect(
      compileConfig(base({ tools: [{ name: 'pm.tests.run', version: '1' }] }), LIMITS).unavailable,
    ).toEqual([{ pointer: '/tools/0', tool: 'pm.tests.run', owner: '9B' }]);
  });

  it('AT-622 every starter template compiles with conservative tools and names what is missing', () => {
    expect(AGENT_TEMPLATES.map((t) => t.key)).toEqual([
      'development',
      'research',
      'growth',
      'documentation',
      'testing',
    ]);
    for (const t of AGENT_TEMPLATES) {
      const c = compileConfig(t.draft(), LIMITS);
      expect(c.unavailable).toEqual([]);
      for (const tool of c.tools)
        expect(['R0', 'R1']).toContain(TOOL_CLASSES[tool.tool_class].risk);
      expect(missingConfiguration(c, null)).toEqual(
        t.kind === 'internal' ? ['scope', 'model'] : ['scope', 'connector'],
      );
    }
  });

  it('AT-623 a handshake manifest is accepted only at a known protocol and version, with the nonce echoed and a bounded shape', () => {
    const ok = {
      protocol: 'pm-agent/1',
      version: '1',
      nonce: 'n1',
      agent: { name: 'A', version: '1' },
      tools: [{ name: 'pm.tasks.get', version: '1' }],
    };
    expect(parseManifest(ok, 'n1')).toMatchObject({ ok: true });
    expect(parseManifest({ ...ok, protocol: 'other/1' }, 'n1')).toEqual({
      ok: false,
      code: 'protocol_unsupported',
    });
    expect(parseManifest({ ...ok, version: '2' }, 'n1')).toEqual({
      ok: false,
      code: 'version_unsupported',
    });
    expect(parseManifest({ ...ok, nonce: 'n2' }, 'n1')).toEqual({
      ok: false,
      code: 'nonce_mismatch',
    });
    expect(parseManifest({ ...ok, tools: 'all' }, 'n1')).toEqual({
      ok: false,
      code: 'malformed_response',
    });
    expect(
      parseManifest(
        { ...ok, tools: Array.from({ length: 101 }, () => ({ name: 'x', version: '1' })) },
        'n1',
      ),
    ).toEqual({ ok: false, code: 'malformed_response' });
    expect(parseManifest([ok], 'n1')).toEqual({ ok: false, code: 'malformed_response' });
  });

  it('AT-624 the endpoint guard: https only, never private ranges, loopback only for the local fixture, never the product itself', async () => {
    const opts = { allowLoopback: false, productOrigin: 'https://pm.example.test' };
    expect(await checkEndpoint('https://93.184.215.14/agent', opts)).toMatchObject({ ok: true });
    for (const [url, code] of [
      ['http://93.184.215.14/agent', 'invalid_url'],
      ['https://10.1.2.3/', 'private_address'],
      ['https://192.168.0.5/', 'private_address'],
      ['https://169.254.169.254/', 'private_address'],
      ['https://[::1]/', 'private_address'],
      ['https://127.0.0.1/', 'private_address'],
      ['https://localhost/', 'private_address'],
      ['https://u:p@93.184.215.14/', 'invalid_url'],
      ['https://93.184.215.14:8443/', 'invalid_url'],
      ['https://pm.example.test/v1/mcp', 'own_endpoint'],
      ['ftp://93.184.215.14/', 'invalid_url'],
      ['not a url', 'invalid_url'],
    ] as const)
      expect({ url, ...(await checkEndpoint(url, opts)) }).toMatchObject({ url, ok: false, code });
    // The local fixture: loopback over http only when allowed; other private ranges still never.
    const local = { allowLoopback: true, productOrigin: null };
    expect(await checkEndpoint('http://127.0.0.1:4100/peer/x', local)).toMatchObject({ ok: true });
    expect(await checkEndpoint('http://10.0.0.1/peer/x', local)).toMatchObject({
      ok: false,
      code: 'private_address',
    });
    expect(isOwnCredential('pm_abc')).toBe(true);
    expect(isOwnCredential('oac_abc')).toBe(true);
    expect(isOwnCredential('sk-live-abc')).toBe(false);
  });
});
