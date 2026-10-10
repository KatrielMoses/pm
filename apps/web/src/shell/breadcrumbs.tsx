import { useEffect, useId, useRef, useState } from 'react';
import { Link } from '../router.tsx';
import { BrandMarker } from './brand-marker.tsx';
import type { BrandMarkerData } from './client.ts';
import { useWidthClass } from './width.ts';

/**
 * Containment breadcrumbs (IA-13, RS-40). The trail starts at the brand (or Workspace) marker and
 * contains only ancestors the viewer can access; pages pass only those. Expanded shows the full
 * trail, Medium folds middle crumbs into an overflow menu, Compact shows "‹ Parent" with the
 * brand marker and an overflow that reveals the full trail.
 */
export interface Crumb {
  label: string;
  to?: string;
  marker?: BrandMarkerData;
}

function CrumbContent({ c }: { c: Crumb }) {
  return c.marker ? <BrandMarker marker={c.marker} size={16} /> : <>{c.label}</>;
}

export function Breadcrumbs({ trail }: { trail: Crumb[] }) {
  const width = useWidthClass();
  const [open, setOpen] = useState(false);
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  if (trail.length < 2) return null;
  const last = trail[trail.length - 1]!;
  const item = (c: Crumb, current: boolean) =>
    current || !c.to ? (
      <span aria-current={current ? 'page' : undefined}>
        <CrumbContent c={c} />
      </span>
    ) : (
      <Link to={c.to}>
        <CrumbContent c={c} />
      </Link>
    );
  const overflow = (hidden: Crumb[]) => (
    <li className="crumb-overflow">
      <button
        type="button"
        className="button button-ghost"
        aria-expanded={open}
        aria-controls={`${id}-more`}
        aria-label="Show full path"
        onClick={() => setOpen((o) => !o)}
      >
        …
      </button>
      {open ? (
        <div id={`${id}-more`} ref={menu} className="crumb-menu">
          <ol>
            {hidden.map((c, i) => (
              <li key={i}>{item(c, false)}</li>
            ))}
          </ol>
        </div>
      ) : null}
    </li>
  );
  if (width === 'compact') {
    const parent = trail[trail.length - 2]!;
    const root = trail[0]!;
    return (
      <nav aria-label="Breadcrumb" className="breadcrumbs breadcrumbs-compact">
        <ol>
          <li>
            {parent.to ? (
              <Link to={parent.to}>
                <span aria-hidden="true">‹ </span>
                {parent.marker ? <BrandMarker marker={parent.marker} size={16} /> : parent.label}
              </Link>
            ) : (
              <span>{parent.label}</span>
            )}
          </li>
          {root.marker && root !== parent ? (
            <li className="crumb-marker">
              <BrandMarker marker={root.marker} variant="tile" size={16} />
            </li>
          ) : null}
          {overflow(trail)}
        </ol>
      </nav>
    );
  }
  const middle = trail.slice(1, -1);
  const collapse = width === 'medium' && middle.length > 1;
  return (
    <nav aria-label="Breadcrumb" className="breadcrumbs">
      <ol>
        <li>{item(trail[0]!, false)}</li>
        {collapse ? overflow(middle) : middle.map((c, i) => <li key={i}>{item(c, false)}</li>)}
        <li>{item(last, true)}</li>
      </ol>
    </nav>
  );
}
