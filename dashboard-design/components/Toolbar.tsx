'use client';

/*
 * Review toolbar, outside the design itself: navigate mockups, switch brand (which swaps the
 * identity kit), or paste three logo colours to see any kit applied live.
 * Keys: ← → mockups · B cycle brand · H hide toolbar · G gallery.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, LayoutGrid, Palette, X } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { brands, type BrandId } from '@/lib/data';
import { brandColor } from './brand';
import { designs, type DesignMeta } from '@/designs/meta';

const order: (BrandId | null)[] = [null, 'ma', 'ax', 'op'];

export function Toolbar({ meta }: { meta: DesignMeta }) {
  const router = useRouter();
  const { brand, setBrand, customKit, setCustomKit, theme, houseKit } = useWorkspace();
  const [hidden, setHidden] = useState(false);
  const [picker, setPicker] = useState(false);
  const [draft, setDraft] = useState<[string, string, string]>(['#1D5BD6', '#FFFFFF', '#0B0B0F']);
  const prev = meta.id === 1 ? designs.length : meta.id - 1;
  const next = meta.id === designs.length ? 1 : meta.id + 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowLeft') router.push(`/mockups/${prev}`);
      else if (e.key === 'ArrowRight') router.push(`/mockups/${next}`);
      else if (e.key === 'h' || e.key === 'H') setHidden((v) => !v);
      else if (e.key === 'g' || e.key === 'G') router.push('/mockups');
      else if (e.key === 'b' || e.key === 'B') setBrand(order[(order.indexOf(brand) + 1) % order.length]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router, prev, next, brand, setBrand]);

  if (hidden) {
    return (
      <button onClick={() => setHidden(false)} aria-label="Show toolbar" style={{ ...shell, padding: 0, width: 36, height: 36, justifyContent: 'center', right: 16, left: 'auto', transform: 'none' }}>
        <Palette size={16} />
      </button>
    );
  }

  return (
    <div style={shell} role="toolbar" aria-label="Mockup review">
      <Link href="/mockups" aria-label="All mockups" style={btn}><LayoutGrid size={15} /></Link>
      <span style={sep} />
      <Link href={`/mockups/${prev}`} aria-label="Previous" style={btn}><ChevronLeft size={16} /></Link>
      <span style={{ minWidth: 150, textAlign: 'center', fontSize: 12.5, lineHeight: 1.1 }}>
        <span style={{ opacity: 0.5, fontVariantNumeric: 'tabular-nums' }}>{String(meta.id).padStart(2, '0')}/{designs.length}</span>{' '}
        <b style={{ fontWeight: 600 }}>{meta.name}</b>
      </span>
      <Link href={`/mockups/${next}`} aria-label="Next" style={btn}><ChevronRight size={16} /></Link>
      <span style={sep} />
      {order.map((b) => {
        const active = !customKit && brand === b;
        const c = b ? brandColor(b) : houseKit.colors[0];
        return (
          <button key={b ?? 'all'} onClick={() => { setCustomKit(null); setBrand(b); }} title={b ? brands.find((x) => x.id === b)!.name : `All brands · ${houseKit.name} palette`}
            style={{ ...chip, background: active ? 'rgba(255,255,255,.14)' : 'transparent' }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: c }} />
            {b ? b.toUpperCase() : 'All'}
          </button>
        );
      })}
      <span style={sep} />
      <button onClick={() => setPicker((v) => !v)} style={{ ...chip, background: customKit ? 'rgba(255,255,255,.14)' : 'transparent' }} title="Load logo colours">
        <span style={{ display: 'flex' }}>
          {theme.raw.map((c, i) => <span key={i} style={{ width: 10, height: 10, borderRadius: 3, background: c, marginLeft: i ? -3 : 0, border: '1px solid rgba(0,0,0,.25)' }} />)}
        </span>
        Kit
      </button>
      {picker ? (
        <div style={{ position: 'absolute', bottom: 48, right: 0, background: '#16171b', border: '1px solid rgba(255,255,255,.1)', borderRadius: 14, padding: 14, display: 'grid', gap: 10, width: 260, boxShadow: '0 20px 50px rgba(0,0,0,.5)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, opacity: 0.8 }}>
            Logo colours (primary, secondary, tertiary)
            <button onClick={() => setPicker(false)} style={{ ...btn, width: 22, height: 22 }} aria-label="Close"><X size={13} /></button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {draft.map((c, i) => (
              <label key={i} style={{ flex: 1, display: 'grid', gap: 4, fontSize: 11, opacity: 0.9 }}>
                <input type="color" value={c} onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? e.target.value : x)) as [string, string, string])}
                  style={{ width: '100%', height: 34, border: 'none', borderRadius: 8, background: 'none', padding: 0 }} />
                <input value={c} onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? e.target.value : x)) as [string, string, string])}
                  style={{ width: '100%', background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.1)', borderRadius: 6, color: '#fff', fontSize: 11, padding: '4px 6px', fontFamily: 'var(--f-geist-mono)' }} />
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setCustomKit({ name: 'Custom', colors: draft })} style={{ flex: 1, padding: '8px 0', borderRadius: 8, border: 'none', background: '#fff', color: '#000', fontSize: 12, fontWeight: 600 }}>Apply</button>
            <button onClick={() => setCustomKit(null)} style={{ flex: 1, padding: '8px 0', borderRadius: 8, border: '1px solid rgba(255,255,255,.15)', background: 'transparent', fontSize: 12 }}>Reset</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const shell: React.CSSProperties = {
  position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 1000, display: 'flex', alignItems: 'center', gap: 4,
  padding: '5px 6px', borderRadius: 999, background: 'rgba(14,15,18,.86)', color: '#fff', border: '1px solid rgba(255,255,255,.1)',
  backdropFilter: 'blur(14px)', boxShadow: '0 10px 40px rgba(0,0,0,.35)', fontFamily: 'var(--f-geist), system-ui', fontSize: 12,
};
const btn: React.CSSProperties = { width: 28, height: 28, display: 'grid', placeItems: 'center', borderRadius: 999, border: 'none', background: 'transparent', color: '#fff' };
const chip: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 10px', borderRadius: 999, border: 'none', color: '#fff', fontSize: 12, fontWeight: 500 };
const sep: React.CSSProperties = { width: 1, height: 16, background: 'rgba(255,255,255,.14)', margin: '0 4px' };
