import { describe, expect, it } from 'vitest';
import {
  decodeViewState,
  evenRanks,
  formatScopeToken,
  ID_PREFIXES,
  newPublicId,
  parseScopeToken,
  pickStore,
  rankBetween,
  RANK_MAX_LENGTH,
  SHELL_COMMAND_IDS,
  SHELL_ID_PREFIXES,
  VIEW_STATE_SCHEMAS,
  viewStateFromSearch,
  viewStateToSearch,
} from '@pm/contracts';

const br = () => newPublicId('br');

describe('shell contracts (1E)', () => {
  it('shell ID prefixes match the generated 0D registry', () => {
    const reg = new Map<string, string>(ID_PREFIXES.map((p) => [p.resource, p.prefix]));
    for (const [resource, prefix] of Object.entries(SHELL_ID_PREFIXES))
      expect(reg.get(resource), resource).toBe(prefix);
    for (const schema of Object.values(VIEW_STATE_SCHEMAS))
      for (const def of Object.values(schema.fields) as Array<{
        spec: { kind: string; prefixes?: string[] };
      }>)
        for (const p of def.spec.prefixes ?? [])
          expect(
            ID_PREFIXES.some((x) => x.prefix === p),
            p,
          ).toBe(true);
  });

  it('command identifiers are unique, bounded, and label-safe', () => {
    expect(new Set(SHELL_COMMAND_IDS).size).toBe(SHELL_COMMAND_IDS.length);
    for (const id of SHELL_COMMAND_IDS) expect(id).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });

  it('parses and normalizes scope tokens; rejects anything malformed', () => {
    const a = br();
    const b = br();
    expect(parseScopeToken('all')).toEqual({ kind: 'all' });
    expect(parseScopeToken(`brand:${a}`)).toEqual({ kind: 'brand', brand: a });
    const multi = parseScopeToken(`brands:${b},${a},${b}`);
    expect(multi).toEqual({ kind: 'brands', brands: [a, b].sort() });
    expect(formatScopeToken(multi!)).toBe(`brands:${[a, b].sort().join(',')}`);
    // A one-brand list collapses to the single-brand form.
    expect(parseScopeToken(`brands:${a}`)).toEqual({ kind: 'brand', brand: a });
    for (const bad of [
      '',
      'ALL',
      'brand:',
      `brand:${a.toLowerCase()}`,
      `brand:${newPublicId('team')}`,
      `brands:${a},`,
      `brands:${Array.from({ length: 51 }, br).join(',')}`,
      `workspace:${a}`,
      42,
      null,
      { kind: 'all' },
    ])
      expect(parseScopeToken(bad), String(bad)).toBeNull();
  });

  it('decodes view state from allow-listed fields only (no prototype or key injection)', () => {
    const hostile = JSON.parse(
      `{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}},"state":"active","sort":"name","anchor":"${newPublicId('mem')}","q":"secret search","extra":"x"}`,
    );
    const out = decodeViewState('people.list', hostile, { store: 'device' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(Object.keys(out.state).sort()).toEqual(['anchor', 'sort', 'state']);
    // Free-text search is URL-only and never stored per device.
    expect(out.state).not.toHaveProperty('q');
    expect(out.dropped).toBe(4);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out.state)).toBe(Object.prototype);
  });

  it('rejects unknown views, wrong versions, oversized and non-object documents; drops bad values', () => {
    expect(decodeViewState('nope.view', {}, { store: 'device' })).toEqual({
      ok: false,
      reason: 'unknown_view',
    });
    expect(decodeViewState('__proto__', {}, { store: 'device' })).toEqual({
      ok: false,
      reason: 'unknown_view',
    });
    expect(decodeViewState('people.list', {}, { store: 'device', version: 2 })).toEqual({
      ok: false,
      reason: 'version',
    });
    expect(decodeViewState('people.list', [], { store: 'device' })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(
      decodeViewState(
        'people.list',
        { sort: 'x'.repeat(5000) },
        { store: 'device', maxBytes: 1024 },
      ),
    ).toEqual({ ok: false, reason: 'too_large' });
    const out = decodeViewState(
      'people.list',
      { state: 'deleted', sort: 'name', anchor: 'mem_bad' },
      { store: 'device' },
    );
    expect(out).toEqual({ ok: true, state: { sort: 'name' }, dropped: 2 });
  });

  it('URL round trip keeps only URL-owned fields and unrelated parameters', () => {
    const base = new URLSearchParams('scope=all&utm=1&state=active');
    const url = viewStateToSearch(
      'people.list',
      { state: 'suspended', q: 'ada', anchor: newPublicId('mem') },
      base,
    );
    expect(url.get('scope')).toBe('all');
    expect(url.get('utm')).toBe('1');
    // Device/session fields (the scroll anchor) never enter the URL.
    expect(url.has('anchor')).toBe(false);
    expect(url.getAll('state')).toEqual(['suspended']);
    const back = viewStateFromSearch('people.list', url);
    expect(back).toEqual({ ok: true, state: { state: 'suspended', q: 'ada' }, dropped: 0 });
    expect(pickStore('people.list', { state: 'active', q: 'x', anchor: 'a' }, 'device')).toEqual({
      state: 'active',
      anchor: 'a',
    });
  });

  it('fractional ranks are strictly ordered, bounded, and rebalance evenly', () => {
    let keys: string[] = [];
    let prev: string | null = null;
    for (let i = 0; i < 200; i++) {
      const k: string = rankBetween(prev, null)!;
      expect(k > (prev ?? '')).toBe(true);
      keys.push(k);
      prev = k;
    }
    // Repeated insertion at the front stays ordered until the length bound, then asks to rebalance.
    let first: string | null = keys[0]!;
    let n = 0;
    for (;;) {
      const k = rankBetween(null, first);
      if (k === null) break;
      expect(k < first!).toBe(true);
      expect(k.length).toBeLessThanOrEqual(RANK_MAX_LENGTH);
      first = k;
      n++;
    }
    expect(n).toBeGreaterThan(50);
    expect(rankBetween('b', 'a')).toBeNull();
    expect(rankBetween('a', 'a')).toBeNull();
    keys = evenRanks(200);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(200);
    for (const k of keys) expect(k).toMatch(/^[0-9A-Za-z]{1,64}$/);
    for (let i = 1; i < keys.length; i++)
      expect(rankBetween(keys[i - 1]!, keys[i]!)).not.toBeNull();
  });
});
