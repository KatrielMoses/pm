'use client';

/*
 * App shell: Paper top bar (logo · brand switcher centred · search, capture, AI, inbox, theme,
 * user) and the floating pill rail. The rail carries the six destinations from UX-PLAN.md plus
 * Settings and Help; every icon shows its label and shortcut on hover.
 */

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import {
  Bell, CalendarRange, ChevronDown, CircleHelp, FileText, FolderKanban, House, Inbox, Moon, Plus, Search, Settings, Sparkles, Sun, Target,
} from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { useApp } from '@/lib/app-state';
import { brands, USER } from '@/lib/data';
import { initialUnread } from '@/app/app/inbox/items';
import { BrandChip, Logo } from '@/components/brand';
import { Kbd } from './ui';
import { useSlider } from './slider';
import { Overlays } from './overlays';
import s from './shell.module.css';

type NavItem = { href: string; label: string; icon: typeof House; keys: string };

export const NAV: NavItem[] = [
  { href: '/app', label: 'Home', icon: House, keys: 'G H' },
  { href: '/app/inbox', label: 'Inbox', icon: Inbox, keys: 'G I' },
  { href: '/app/projects', label: 'Projects', icon: FolderKanban, keys: 'G P' },
  { href: '/app/plan', label: 'Plan', icon: CalendarRange, keys: 'G L' },
  { href: '/app/goals', label: 'Goals', icon: Target, keys: 'G G' },
  { href: '/app/docs', label: 'Docs', icon: FileText, keys: 'G D' },
];
export const FOOTER_NAV: NavItem[] = [{ href: '/app/settings', label: 'Settings', icon: Settings, keys: 'G S' }];

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { brand, setBrand } = useWorkspace();
  const { mode, setMode, density, setCapture, setPalette, panel, setPanel } = useApp();
  const unread = initialUnread(brand);
  const order = [null, ...brands.map((b) => b.id)];
  const slide = useSlider<HTMLDivElement>(order.indexOf(brand));
  const glide = (on: boolean) => (on ? (slide.measured ? `${s.swOn} ${s.swGlide}` : s.swOn) : s.sw);

  useEffect(() => {
    let g = false;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true); return; }
      if (t.closest('input, textarea, [contenteditable], select') || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (g) {
        g = false;
        const to = { h: '/app', i: '/app/inbox', p: '/app/projects', l: '/app/plan', g: '/app/goals', d: '/app/docs', s: '/app/settings' }[k];
        if (to) router.push(to);
        return;
      }
      if (k === 'g') { g = true; setTimeout(() => (g = false), 900); }
      else if (k === 'c') { e.preventDefault(); setCapture(true); }
      else if (k === '/') { e.preventDefault(); setPalette(true); }
      else if (k === 'b') { const order = [null, 'ma', 'ax', 'op'] as const; setBrand(order[(order.indexOf(brand as never) + 1) % order.length]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router, setCapture, setPalette, setBrand, brand]);

  const isOn = (href: string) => (href === '/app' ? path === '/app' : path.startsWith(href));
  const railLink = (n: NavItem) => (
    <Link key={n.href} href={n.href} className={isOn(n.href) ? s.railOn : s.railItem} aria-label={n.label} aria-current={isOn(n.href) ? 'page' : undefined}>
      <n.icon size={18} />
      {n.href === '/app/inbox' && unread ? <i className={s.railBadge}>{unread}</i> : null}
      <span className={s.tip}>{n.label}<em>{n.keys}</em></span>
    </Link>
  );

  return (
    <div className={`paper ${s.root}`} data-mode={mode} data-density={density}>
      <div className={s.frame}>
        <header className={s.top}>
          <Link href="/app" className={s.pill} aria-label="Home"><Logo size={30} /></Link>

          <div ref={slide.ref} className={s.switcher} role="radiogroup" aria-label="Brand">
            {slide.measured ? <span aria-hidden style={slide.style} /> : null}
            <button role="radio" aria-checked={brand === null} data-slide className={glide(brand === null)} onClick={() => setBrand(null)}>
              <span className={s.allMark}>{brands.map((b) => <BrandChip key={b.id} id={b.id} size={9} radius={2.5} style={{ fontSize: 0 }} />)}</span>
              All
            </button>
            {brands.map((b) => (
              <button key={b.id} role="radio" aria-checked={brand === b.id} data-slide className={glide(brand === b.id)} onClick={() => setBrand(b.id)}>
                <BrandChip id={b.id} size={22} /> {b.name}
              </button>
            ))}
          </div>

          <div className={s.topRight}>
            <button className={s.searchPill} onClick={() => setPalette(true)}>
              <Search size={16} /> <span>Search</span> <Kbd>⌘K</Kbd>
            </button>
            <button className={s.capture} onClick={() => setCapture(true)} aria-label="Capture" title="Capture (C)"><Plus size={18} strokeWidth={2.4} /></button>
            <div className={s.iconGroup}>
              <button aria-label="Ask AI" title="Ask AI" className={panel === 'ai' ? s.iconOn : undefined} onClick={() => setPanel(panel === 'ai' ? null : 'ai')}><Sparkles size={18} /></button>
              <Link href="/app/inbox" aria-label="Inbox" title="Inbox" className={s.iconLink}>
                <Bell size={18} />{unread ? <i className={s.bellDot}>{unread}</i> : null}
              </Link>
              <button aria-label={mode === 'light' ? 'Dark mode' : 'Light mode'} title="Theme" onClick={() => setMode(mode === 'light' ? 'dark' : 'light')}>
                {mode === 'light' ? <Moon size={18} /> : <Sun size={18} />}
              </button>
            </div>
            <Link href="/app/settings" className={s.user}>
              <span className={s.avatar}>{USER.initials}</span>
              <span className={s.userName}>{USER.name}</span>
              <ChevronDown size={15} />
            </Link>
          </div>
        </header>

        <div className={s.body}>
          <nav className={s.rail} aria-label="Main">
            <div className={s.railGroup}>{NAV.map(railLink)}</div>
            <div className={`${s.railGroup} ${s.railEnd}`}>
              {FOOTER_NAV.map(railLink)}
              <button className={s.railItem} aria-label="Help"><CircleHelp size={18} /><span className={s.tip}>Help<em>?</em></span></button>
            </div>
          </nav>
          <main key={path} className={s.main}>{children}</main>
        </div>
      </div>
      <Overlays />
    </div>
  );
}
