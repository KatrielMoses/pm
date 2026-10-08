'use client';

/*
 * Sliding selection pill: measures the active child of a pill group and glides an ink pill
 * behind it (brand switcher, every Segmented tab bar). Falls back to the static active style
 * until measured, so there's no flash and it works without JS.
 */

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

export function useSlider<T extends HTMLElement>(activeIndex: number) {
  const ref = useRef<T>(null);
  const [box, setBox] = useState<{ x: number; w: number; h: number; y: number } | null>(null);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const items = el.querySelectorAll<HTMLElement>('[data-slide]');
      const a = items[activeIndex];
      if (!a) { setBox(null); return; }
      setBox({ x: a.offsetLeft, y: a.offsetTop, w: a.offsetWidth, h: a.offsetHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // enable the transition only after the first placement
    const id = requestAnimationFrame(() => setReady(true));
    return () => { ro.disconnect(); cancelAnimationFrame(id); };
  }, [activeIndex]);

  const style: CSSProperties | undefined = box
    ? {
        position: 'absolute', left: 0, top: 0, width: box.w, height: box.h, borderRadius: 999, background: 'var(--ink)',
        transform: `translate(${box.x}px, ${box.y}px)`, pointerEvents: 'none', zIndex: 0,
        transition: ready ? 'transform .42s cubic-bezier(.2,.9,.2,1.05), width .42s cubic-bezier(.2,.9,.2,1.05)' : 'none',
        boxShadow: '0 8px 18px -10px rgba(0,0,0,.45)',
      }
    : undefined;

  return { ref, style, measured: !!box };
}
