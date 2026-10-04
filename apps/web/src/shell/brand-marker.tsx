import { ICON_GLYPH } from '../tenancy/client.ts';
import type { BrandMarkerData } from './client.ts';

/**
 * The single brand-marker component (DS-40, WSB-015). Brand colour fills only the rounded-square
 * tile; the glyph is black or white, whichever contrasts more (DS-41 rule 2), and a tile whose
 * colour is weak against the surface gets an outline (rule 3, in CSS). Names are rendered as text,
 * never markup. Workspace and "No brand yet" markers are neutral and never look like a brand.
 */
export type MarkerVariant = 'marker' | 'tile';

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0.5;
  const v = [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16) / 255);
  const lin = v.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

/** Black or white glyph, whichever has the higher contrast ratio against the tile colour. */
export function glyphColor(hex: string): '#000000' | '#ffffff' {
  const l = luminance(hex);
  const black = (l + 0.05) / 0.05;
  const white = 1.05 / (l + 0.05);
  return black >= white ? '#000000' : '#ffffff';
}

export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

export function BrandMarker({
  marker,
  variant = 'marker',
  size = 20,
  decorative = false,
}: {
  marker: BrandMarkerData;
  variant?: MarkerVariant;
  size?: 16 | 20 | 24;
  /** Tile only and hidden from assistive technology (the adjacent text already names it). */
  decorative?: boolean;
}) {
  if (decorative && marker.kind === 'brand')
    return (
      <span className={`marker marker-${size}`} aria-hidden="true">
        <span
          className="marker-tile"
          style={{ backgroundColor: marker.color, color: glyphColor(marker.color) }}
        >
          {ICON_GLYPH[marker.icon] ?? '●'}
        </span>
      </span>
    );
  if (marker.kind === 'workspace')
    return (
      <span className={`marker marker-${size} marker-neutral`}>
        <span className="marker-tile marker-tile-workspace" aria-hidden="true">
          ◇
        </span>
        {variant === 'marker' ? (
          <span className="marker-name">Workspace</span>
        ) : (
          <span className="visually-hidden">Workspace</span>
        )}
      </span>
    );
  if (marker.kind === 'unbranded')
    return (
      <span className={`marker marker-${size} marker-neutral`}>
        <span className="marker-tile marker-tile-empty" aria-hidden="true" />
        {variant === 'marker' ? (
          <span className="marker-name">No brand yet</span>
        ) : (
          <span className="visually-hidden">No brand yet</span>
        )}
      </span>
    );
  const name = marker.short_name && variant === 'tile' ? marker.short_name : marker.name;
  return (
    <span className={`marker marker-${size}`} title={marker.name}>
      <span
        className={`marker-tile${contrastRatio(marker.color, '#ffffff') < 3 || contrastRatio(marker.color, '#181b21') < 3 ? ' marker-tile-outline' : ''}`}
        style={{ backgroundColor: marker.color, color: glyphColor(marker.color) }}
        aria-hidden="true"
      >
        {ICON_GLYPH[marker.icon] ?? '●'}
      </span>
      {variant === 'marker' ? (
        <span className="marker-name">{name}</span>
      ) : (
        <span className="visually-hidden">{marker.name}</span>
      )}
      {marker.archived ? <span className="badge badge-warning marker-badge">Archived</span> : null}
    </span>
  );
}

/** Stacked tiles (up to three) and a count of accessible brands only (DS-40 `marker-stack`). */
export function MarkerStack({ markers, label }: { markers: BrandMarkerData[]; label: string }) {
  const shown = markers.slice(0, 3);
  return (
    <span className="marker-stack">
      <span className="marker-stack-tiles" aria-hidden="true">
        {shown.map((m, i) =>
          m.kind === 'brand' ? (
            <span
              key={m.id}
              className="marker-tile"
              style={{ backgroundColor: m.color, color: glyphColor(m.color), zIndex: 3 - i }}
            >
              {ICON_GLYPH[m.icon] ?? '●'}
            </span>
          ) : null,
        )}
      </span>
      <span className="marker-name">{label}</span>
    </span>
  );
}

/** A 1C brand summary as marker data (active brands from the server context). */
export function summaryMarker(
  b: {
    id: string;
    name: string;
    short_name: string | null;
    color: string;
    icon: string;
  },
  archived = false,
): BrandMarkerData {
  return {
    kind: 'brand',
    id: b.id,
    name: b.name,
    short_name: b.short_name,
    color: b.color,
    icon: b.icon,
    archived,
  };
}
