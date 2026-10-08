/*
 * Identity kits. A kit is the three colours taken from a logo, in the order the brand gives them
 * (primary, secondary, tertiary). Logos are often "one colour + white/black", so the dashboard
 * never uses the raw colours blindly: `deriveTheme` picks the most saturated colour as the accent,
 * fills missing accents from that hue, and computes readable ink for each.
 */

export type Kit = { name: string; colors: [string, string, string] };

type RGB = { r: number; g: number; b: number };
type HSL = { h: number; s: number; l: number };

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

export function hexToRgb(hex: string): RGB {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }: RGB) {
  return '#' + [r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
}

function rgbToHsl({ r, g, b }: RGB): HSL {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h * 60, s, l };
}

function hslToRgb({ h, s, l }: HSL): RGB {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 };
}

export function luminance(hex: string) {
  const { r, g, b } = hexToRgb(hex);
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/** Readable text colour on top of `bg`. */
export function inkOn(bg: string) {
  return contrast(bg, '#0B0B0F') >= contrast(bg, '#FFFFFF') ? '#0B0B0F' : '#FFFFFF';
}

/** "How colourful" a colour is; near-white, near-black and greys score ~0. */
function vividness(hex: string) {
  const { s, l } = rgbToHsl(hexToRgb(hex));
  return s * (1 - Math.abs(2 * l - 1));
}

function shift(hex: string, dh: number, dl: number, ds = 0) {
  const hsl = rgbToHsl(hexToRgb(hex));
  return rgbToHex(hslToRgb({ h: (hsl.h + dh + 360) % 360, s: clamp(hsl.s + ds), l: clamp(hsl.l + dl) }));
}

export type Theme = {
  accent: string; accentInk: string;
  accent2: string; accent2Ink: string;
  accent3: string; accent3Ink: string;
  raw: [string, string, string];
};

export function deriveTheme(kit: Kit): Theme {
  const ranked = [...kit.colors].sort((a, b) => vividness(b) - vividness(a));
  const vivid = ranked.filter((c) => vividness(c) > 0.18);
  const accent = vivid[0] ?? kit.colors[0];
  const { l } = rgbToHsl(hexToRgb(accent));
  // Second and third accents come from the logo when it has them, otherwise from the accent's hue.
  const accent2 = vivid[1] ?? shift(accent, 0, l > 0.55 ? -0.22 : 0.2, -0.05);
  const accent3 = vivid[2] ?? shift(accent, 28, l > 0.5 ? -0.08 : 0.12, -0.15);
  return {
    accent, accentInk: inkOn(accent),
    accent2, accent2Ink: inkOn(accent2),
    accent3, accent3Ink: inkOn(accent3),
    raw: kit.colors,
  };
}

/** CSS custom properties every design reads: --k1/--k2/--k3 and their -ink pairs. */
export function themeVars(t: Theme): Record<string, string> {
  return {
    '--k1': t.accent, '--k1-ink': t.accentInk,
    '--k2': t.accent2, '--k2-ink': t.accent2Ink,
    '--k3': t.accent3, '--k3-ink': t.accent3Ink,
    '--kraw1': t.raw[0], '--kraw2': t.raw[1], '--kraw3': t.raw[2],
  };
}

/* Placeholder brand kits until the real logo colours are loaded. */
export const BRAND_KITS: Record<string, Kit> = {
  ma: { name: 'MailAccess', colors: ['#FF5B35', '#FFFFFF', '#15161B'] },
  ax: { name: 'API Access', colors: ['#0EA5A4', '#F5B83D', '#0B1F24'] },
  op: { name: 'Optestra', colors: ['#6B4EFF', '#3DDC97', '#FFFFFF'] },
};
