import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../../apps/web/src/shell/brand-marker.tsx';
import { BREAKPOINTS } from '../../apps/web/src/shell/width.ts';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const doc = read('docs/ux/05-design-system.md');
const css = read('apps/web/src/styles.css');

/**
 * The DS-21 contrast gate's 1E successor: the stylesheet's colour tokens must equal the DS-20
 * reference values, and every required pair must meet its minimum in both themes (light and dark).
 */

function docTokens() {
  const out = { light: new Map(), dark: new Map() };
  for (const m of doc.matchAll(
    /^\| `(color\.[a-z.-]+)` \|(?: [^|]* \|)? `(#[0-9A-Fa-f]{6})` \| `(#[0-9A-Fa-f]{6})` \|/gm,
  )) {
    out.light.set(m[1], m[2].toLowerCase());
    out.dark.set(m[1], m[3].toLowerCase());
  }
  return out;
}

function cssBlock(selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing ${selector}`);
  const body = css.slice(start, css.indexOf('}', start));
  const out = new Map();
  for (const m of body.matchAll(/--(color-[a-z-]+):\s*(#[0-9a-fA-F]{6});/g))
    out.set(
      m[1]
        .replace(/^color-/, 'color.')
        .replace(/-(?=(?:fg|bg)$)/, '.')
        .replace(/^color\.(bg|text|border|action|status|label)-/, 'color.$1.')
        .replace(/^color\.status\.(info|success|warning|danger|proposed)-/, 'color.status.$1.'),
      m[2].toLowerCase(),
    );
  return out;
}

const DOC = docTokens();
const CSS = {
  light: cssBlock(':root'),
  dark: cssBlock(":root[data-color-scheme='dark']"),
};

const PAIRS = [
  ...doc.matchAll(/^\| `(color\.[a-z.-]+)` \| `(color\.[a-z.-]+)` \| (\d(?:\.\d)?) \|/gm),
].map((m) => ({ fg: m[1], bg: m[2], min: Number(m[3]) }));

describe('stylesheet breakpoints (RS-01, DS-08)', () => {
  it('uses exactly the behavior breakpoints (600, 1024, 1440)', () => {
    for (const px of Object.values(BREAKPOINTS))
      expect(css, String(px)).toContain(`(min-width: ${px}px)`);
    for (const m of css.matchAll(/\(min-width: (\d+)px\)/g))
      expect(Object.values(BREAKPOINTS)).toContain(Number(m[1]));
  });
});

describe('design tokens and contrast (DS-20, DS-21)', () => {
  it('reads the reference tables and the required pairs from the design-system source', () => {
    expect(DOC.light.size).toBeGreaterThan(40);
    expect(PAIRS.length).toBeGreaterThan(40);
  });

  it('every colour token in the stylesheet equals its DS-20 value in both themes', () => {
    for (const theme of ['light', 'dark']) {
      expect(CSS[theme].size, theme).toBeGreaterThan(20);
      for (const [token, value] of CSS[theme])
        expect(value, `${theme} ${token}`).toBe(DOC[theme].get(token));
    }
  });

  it('every required pair meets its minimum in light and dark themes', () => {
    for (const theme of ['light', 'dark'])
      for (const p of PAIRS) {
        const fg = CSS[theme].get(p.fg) ?? DOC[theme].get(p.fg);
        const bg = CSS[theme].get(p.bg) ?? DOC[theme].get(p.bg);
        expect(fg && bg, `${theme} ${p.fg} on ${p.bg}`).toBeTruthy();
        expect(contrastRatio(fg, bg), `${theme} ${p.fg} on ${p.bg}`).toBeGreaterThanOrEqual(p.min);
      }
  });
});
