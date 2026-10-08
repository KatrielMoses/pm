/*
 * Real colour extraction for a dropped logo file: downsample on a canvas, bucket pixels, and
 * return the three most common distinct colours (primary, secondary, tertiary). deriveTheme then
 * turns them into readable accents, so a "one colour + white" logo still gets three accents.
 */

import { rgbToHex } from '@/lib/kits';
import type { Trio } from './samples';

export async function extractColors(url: string): Promise<Trio> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const n = 72;
  const canvas = document.createElement('canvas');
  canvas.width = n;
  canvas.height = n;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no canvas');
  ctx.drawImage(img, 0, 0, n, n);
  const d = ctx.getImageData(0, 0, n, n).data;
  const buckets = new Map<number, { r: number; g: number; b: number; c: number }>();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    const b = buckets.get(key) ?? { r: 0, g: 0, b: 0, c: 0 };
    b.r += d[i]; b.g += d[i + 1]; b.b += d[i + 2]; b.c += 1;
    buckets.set(key, b);
  }
  const ranked = [...buckets.values()].sort((a, b) => b.c - a.c).map((b) => ({ r: b.r / b.c, g: b.g / b.c, b: b.b / b.c }));
  const picked: { r: number; g: number; b: number }[] = [];
  for (const c of ranked) {
    if (picked.every((p) => Math.hypot(p.r - c.r, p.g - c.g, p.b - c.b) > 70)) picked.push(c);
    if (picked.length === 3) break;
  }
  const hex = picked.map((p) => rgbToHex(p).toUpperCase());
  while (hex.length < 3) hex.push('#FFFFFF');
  return [hex[0], hex[1], hex[2]];
}
