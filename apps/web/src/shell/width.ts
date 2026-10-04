import { useEffect, useState } from 'react';

/**
 * Behavioral width classes (RS-01, DS-08 tokens). Layout switches on available CSS width only,
 * never on device or user-agent detection; zoom changes the class. The stylesheet uses the same
 * numbers (a unit test keeps them in step).
 */
export const BREAKPOINTS = { medium: 600, expanded: 1024, wide: 1440 } as const;
export type WidthClass = 'compact' | 'medium' | 'expanded' | 'wide';

export function widthClass(px: number): WidthClass {
  if (px >= BREAKPOINTS.wide) return 'wide';
  if (px >= BREAKPOINTS.expanded) return 'expanded';
  if (px >= BREAKPOINTS.medium) return 'medium';
  return 'compact';
}

const QUERIES = [BREAKPOINTS.medium, BREAKPOINTS.expanded, BREAKPOINTS.wide].map(
  (w) => `(min-width: ${w}px)`,
);

function current(): WidthClass {
  if (typeof window.matchMedia !== 'function') return widthClass(window.innerWidth);
  const [m, e, w] = QUERIES.map((q) => window.matchMedia(q).matches);
  return w ? 'wide' : e ? 'expanded' : m ? 'medium' : 'compact';
}

/** The current width class; re-renders only when the class changes. */
export function useWidthClass(): WidthClass {
  const [value, setValue] = useState<WidthClass>(current);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const lists = QUERIES.map((q) => window.matchMedia(q));
    const update = () => setValue(current());
    for (const l of lists) l.addEventListener('change', update);
    return () => {
      for (const l of lists) l.removeEventListener('change', update);
    };
  }, []);
  return value;
}

/** Whether the primary pointer is fine (UXD-04: single-key shortcuts default on for these). */
export function finePointer(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches;
}
