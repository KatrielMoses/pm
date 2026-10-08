'use client';

/*
 * Sample logos for the simulated "Upload logo" flow on Settings → Brands & kits. Hex values here
 * are logo data (what an uploaded file would contain), never page styling.
 */

import type { CSSProperties } from 'react';

export type Trio = [string, string, string];
export type Sample = { name: string; colors: Trio; bg: string; fg: string; detail: string; mark: 'wave' | 'flame' | 'bloom' | 'leaf' };

export const SAMPLE_LOGOS: Sample[] = [
  // one colour + white: the theme has to derive its 2nd and 3rd accents
  { name: 'fjord.svg', colors: ['#1D4ED8', '#FFFFFF', '#FFFFFF'], bg: '#FFFFFF', fg: '#1D4ED8', detail: '#1D4ED8', mark: 'wave' },
  { name: 'ember.png', colors: ['#F97316', '#111111', '#FFFFFF'], bg: '#111111', fg: '#F97316', detail: '#FFFFFF', mark: 'flame' },
  { name: 'bloom.svg', colors: ['#DB2777', '#7C3AED', '#FDE68A'], bg: '#FDE68A', fg: '#DB2777', detail: '#7C3AED', mark: 'bloom' },
  { name: 'moss.png', colors: ['#15803D', '#FFFFFF', '#0F172A'], bg: '#FFFFFF', fg: '#15803D', detail: '#0F172A', mark: 'leaf' },
];

export function SampleLogo({ sample, size = 64, radius, style }: { sample: Sample; size?: number; radius?: number; style?: CSSProperties }) {
  const { bg, fg, detail, mark } = sample;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-label={sample.name} role="img"
      style={{ borderRadius: radius ?? size * 0.28, flex: 'none', display: 'block', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.06)', ...style }}>
      <rect width="64" height="64" fill={bg} />
      {mark === 'wave' ? (
        <>
          <path d="M10 38 C18 26 26 26 32 36 S46 46 54 30" fill="none" stroke={fg} strokeWidth="7" strokeLinecap="round" />
          <circle cx="47" cy="19" r="5" fill={detail} />
        </>
      ) : mark === 'flame' ? (
        <>
          <path d="M32 9 C40 21 48 27 48 39 A16 16 0 0 1 16 39 C16 30 22 26 25 19 C27 26 30 28 32 9 Z" fill={fg} />
          <path d="M32 31 C36 36 39 39 39 43 A7 7 0 0 1 25 43 C25 39 29 36 32 31 Z" fill={detail} />
        </>
      ) : mark === 'bloom' ? (
        <>
          {[0, 72, 144, 216, 288].map((a) => (
            <ellipse key={a} cx="32" cy="20" rx="8" ry="12" fill={a % 144 === 0 ? fg : detail} transform={`rotate(${a} 32 32)`} opacity=".92" />
          ))}
          <circle cx="32" cy="32" r="6" fill={bg} />
        </>
      ) : (
        <>
          <path d="M14 48 C14 26 30 14 50 14 C50 36 38 50 18 50 Z" fill={fg} />
          <path d="M18 46 L38 26" stroke={detail} strokeWidth="3.5" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}
