'use client';

import { useEffect, useRef, useState } from 'react';

/** Live, scaled-down render of a mockup at 1440×900, sized to its container. */
export function Thumb({ id, title, className }: { id: number; title: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.25);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setScale(e.contentRect.width / 1440));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className={className}>
      <iframe src={`/mockups/${id}?embed=1`} loading="lazy" tabIndex={-1} aria-hidden title={title} style={{ transform: `scale(${scale})` }} />
    </div>
  );
}
