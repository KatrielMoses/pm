'use client';

import type { CSSProperties } from 'react';
import { BRAND_KITS, deriveTheme } from '@/lib/kits';
import { brandShort, PRODUCT, type BrandId } from '@/lib/data';

/** Each brand's own accent, independent of the active theme (so brands stay recognisable in the all-brands view). */
export const brandColor = (id: BrandId) => deriveTheme(BRAND_KITS[id]).accent;
export const brandInk = (id: BrandId) => deriveTheme(BRAND_KITS[id]).accentInk;

/** Brand marker: always a rounded square (status badges are pills), so a brand never reads as a status. */
export function BrandChip({ id, size = 20, radius, style }: { id: BrandId; size?: number; radius?: number; style?: CSSProperties }) {
  return (
    <span
      aria-label={id}
      style={{
        width: size, height: size, borderRadius: radius ?? Math.max(4, size * 0.28), background: brandColor(id), color: brandInk(id),
        display: 'inline-grid', placeItems: 'center', fontSize: size * 0.42, fontWeight: 700, letterSpacing: '-.02em', flex: 'none', ...style,
      }}
    >
      {brandShort(id)}
    </span>
  );
}

export function BrandDot({ id, size = 8 }: { id: BrandId; size?: number }) {
  return <span style={{ width: size, height: size, borderRadius: 2, background: brandColor(id), display: 'inline-block', flex: 'none' }} />;
}

/** Placeholder product logo until the name and mark are decided. */
export function LogoMark({ size = 32, bg = 'var(--k1)', fg = 'var(--k1-ink)', radius }: { size?: number; bg?: string; fg?: string; radius?: number }) {
  return (
    <span style={{ width: size, height: size, borderRadius: radius ?? size * 0.3, background: bg, color: fg, display: 'inline-grid', placeItems: 'center', flex: 'none' }}>
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M4 18 L12 4 L20 18 Z" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
        <circle cx="12" cy="13.5" r="2.2" fill="currentColor" />
      </svg>
    </span>
  );
}

export function Logo({ size = 28, color, bg, fg, gap = 10, weight = 650 }: { size?: number; color?: string; bg?: string; fg?: string; gap?: number; weight?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap, fontWeight: weight, fontSize: size * 0.6, letterSpacing: '-.02em', color }}>
      <LogoMark size={size} bg={bg} fg={fg} />
      {PRODUCT.name}
    </span>
  );
}
