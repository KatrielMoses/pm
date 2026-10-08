'use client';

/*
 * Paper UI kit. Every /app page composes these; page-specific styling goes in the page's own
 * CSS module and uses only tokens from app/app/paper.css plus --k1/--k2/--k3 kit accents.
 */

import type { CSSProperties, ReactNode } from 'react';
import { Check, Search } from 'lucide-react';
import { personById, type Status } from '@/lib/app-data';
import type { Health } from '@/lib/data';
import { useSlider } from './slider';
import u from './ui.module.css';

export { u };
const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/* ---------- containers ---------- */

export function Card({ title, icon, actions, children, className, style, flush, delay = 0 }: {
  title?: ReactNode; icon?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; style?: CSSProperties; flush?: boolean; delay?: number;
}) {
  return (
    <section className={cx(u.card, flush && u.cardFlush, className)} style={{ animationDelay: `${delay}ms`, ...style }}>
      {title || actions ? (
        <header className={u.cardHead} style={flush ? { padding: '16px 20px 0' } : undefined}>
          <span className={u.cardTitle}>{icon ? <span className={u.iconDot}>{icon}</span> : null}{title}</span>
          {actions ? <span className={u.cardActions}>{actions}</span> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Tile({ children, className, style, hero }: { children: ReactNode; className?: string; style?: CSSProperties; hero?: boolean }) {
  return <div className={cx(hero ? u.hero : u.tile, className)} style={style}>{children}</div>;
}

export function PageHead({ title, count, children }: { title: ReactNode; count?: ReactNode; children?: ReactNode }) {
  return (
    <div className={u.pageHead}>
      <h1 className={u.pageTitle}>{title}{count !== undefined ? <span className={u.pageCount}>{count}</span> : null}</h1>
      {children ? <div className={u.pageRight}>{children}</div> : null}
    </div>
  );
}

/* ---------- badges ---------- */

export type Tone = 'red' | 'green' | 'amber' | 'blue' | 'neutral' | 'accent' | 'ink' | 'solidRed' | 'outline';
export function Badge({ tone = 'neutral', dot, children, style }: { tone?: Tone; dot?: boolean; children: ReactNode; style?: CSSProperties }) {
  return <span className={cx(u.badge, u['t_' + tone])} style={style}>{dot ? <i /> : null}{children}</span>;
}

const statusTone: Record<Status, Tone> = { backlog: 'outline', todo: 'neutral', doing: 'accent', review: 'blue', blocked: 'red', done: 'green' };
const statusText: Record<Status, string> = { backlog: 'Backlog', todo: 'To do', doing: 'In progress', review: 'Review', blocked: 'Blocked', done: 'Done' };
export const StatusBadge = ({ status }: { status: Status }) => <Badge tone={statusTone[status]} dot>{statusText[status]}</Badge>;

const healthTone: Record<Health, Tone> = { on: 'green', risk: 'amber', off: 'red' };
const healthText: Record<Health, string> = { on: 'On track', risk: 'At risk', off: 'Off track' };
export const HealthBadge = ({ health }: { health: Health }) => <Badge tone={healthTone[health]} dot>{healthText[health]}</Badge>;

/** Priority as 1–4 rising bars (urgent is red). Always paired with a title for screen readers. */
export function Priority({ p }: { p: 1 | 2 | 3 | 4 }) {
  const lvl = 5 - p;
  const label = ['Urgent', 'High', 'Medium', 'Low'][p - 1];
  return (
    <span title={label} aria-label={label} style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 2, height: 14 }}>
      {[0, 1, 2, 3].map((i) => (
        <i key={i} style={{ width: 3, height: 5 + i * 3, borderRadius: 2, background: i < lvl ? (p === 1 ? 'var(--red)' : 'var(--text)') : 'var(--line2)' }} />
      ))}
    </span>
  );
}

/* ---------- buttons ---------- */

export function Button({ variant = 'light', size = 'md', icon, children, onClick, style, title, type = 'button', disabled }: {
  variant?: 'dark' | 'light' | 'ghost' | 'accent' | 'danger' | 'text'; size?: 'sm' | 'md' | 'lg'; icon?: ReactNode; children?: ReactNode;
  onClick?: () => void; style?: CSSProperties; title?: string; type?: 'button' | 'submit'; disabled?: boolean;
}) {
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick} className={cx(u.btn, u['s_' + size], u['v_' + variant])} style={{ opacity: disabled ? 0.5 : 1, ...style }}>
      {icon}{children}
    </button>
  );
}

export function IconButton({ label, children, onClick, small, style, badge }: { label: string; children: ReactNode; onClick?: () => void; small?: boolean; style?: CSSProperties; badge?: boolean }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={cx(u.iconBtn, small && u.iconBtnSm)} style={style}>
      {children}
      {badge ? <i style={{ position: 'absolute', top: 8, right: 9, width: 7, height: 7, borderRadius: 9, background: 'var(--k1)', boxShadow: '0 0 0 2px var(--card)' }} /> : null}
    </button>
  );
}

/* ---------- segmented ---------- */

export function Segmented<T extends string>({ options, value, onChange, sub, size }: {
  options: { id: T; label: ReactNode; icon?: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void; sub?: boolean; size?: 'sm';
}) {
  const { ref, style, measured } = useSlider<HTMLDivElement>(options.findIndex((o) => o.id === value));
  return (
    <div ref={ref} className={cx(u.seg, sub && u.segSub)} role="tablist" style={{ position: 'relative' }}>
      {measured ? <span aria-hidden style={style} /> : null}
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button key={o.id} data-slide role="tab" aria-selected={on} className={cx(on ? u.segOn : u.segBtn, on && measured && u.segGlide)} onClick={() => onChange(o.id)}
            style={size === 'sm' ? { height: 28, padding: '0 11px', fontSize: 12 } : undefined}>
            {o.icon}{o.label}{o.count !== undefined ? <span className={u.segCount}>{o.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/* ---------- inputs ---------- */

export function SearchField({ placeholder = 'Search', value, onChange, width }: { placeholder?: string; value?: string; onChange?: (v: string) => void; width?: number }) {
  return (
    <label className={u.search} style={width ? { width } : undefined}>
      <Search size={15} />
      <input placeholder={placeholder} value={value} onChange={(e) => onChange?.(e.target.value)} aria-label={placeholder} />
    </label>
  );
}

export function Checkbox({ on, onChange, label }: { on: boolean; onChange?: () => void; label?: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} aria-label={label ?? 'Select'} className={on ? u.cbOn : u.cb} onClick={(e) => { e.stopPropagation(); onChange?.(); }}>
      {on ? <Check size={12} strokeWidth={3} /> : null}
    </button>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange?: () => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={cx(u.toggle, on && u.toggleOn)} onClick={onChange} />;
}

export const Kbd = ({ children }: { children: ReactNode }) => <span className={u.kbd}>{children}</span>;

/* ---------- avatars ---------- */

export function Avatar({ id, size = 28 }: { id: string; size?: number }) {
  const p = personById(id);
  if (!p) return null;
  if (p.kind === 'agent') {
    return (
      <span className={cx(u.avatar, u.avatarAgent)} title={p.name} style={{ width: size, height: size, fontSize: size * 0.36 }}>
        <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
          <rect x="4" y="7" width="16" height="12" rx="4" /><path d="M12 7V4" /><circle cx="9.5" cy="13" r="1" fill="currentColor" /><circle cx="14.5" cy="13" r="1" fill="currentColor" />
        </svg>
      </span>
    );
  }
  const bg = id === 'km' ? 'var(--ink)' : `oklch(0.62 0.11 ${p.hue})`;
  return <span className={u.avatar} title={p.name} style={{ width: size, height: size, fontSize: size * 0.36, background: bg, color: id === 'km' ? 'var(--ink-text)' : '#fff' }}>{p.initials}</span>;
}

export function AvatarStack({ ids, size = 24 }: { ids: string[]; size?: number }) {
  return <span className={u.stackAv}>{ids.map((id) => <Avatar key={id} id={id} size={size} />)}</span>;
}

/* ---------- meters ---------- */

/** Planned vs available: solid ink inside capacity, hatched red over it, hatched grey free. */
export function CapacityBar({ planned, available, height = 14, accent }: { planned: number; available: number; height?: number; accent?: boolean }) {
  const total = Math.max(planned, available) || 1;
  const inCap = Math.min(planned, available);
  const over = Math.max(0, planned - available);
  return (
    <div className={u.meter} style={{ height }}>
      <div className={cx(accent ? u.mAccent : u.mIn, 'anim-grow-x')} style={{ width: `${(inCap / total) * 100}%` }} />
      {over > 0 ? <div className={cx(u.mOver, 'anim-grow-x')} style={{ width: `${(over / total) * 100}%`, animationDelay: '250ms' }} /> : <div className={u.mFree} />}
    </div>
  );
}

export function Thin({ value, max = 100, color, height = 6 }: { value: number; max?: number; color?: string; height?: number }) {
  return (
    <div className={u.thin} style={{ height }}>
      <div className="anim-grow-x" style={{ width: `${Math.min(100, (value / (max || 1)) * 100)}%`, background: color }} />
    </div>
  );
}

export const Live = () => <span className={u.live}><i className="anim-ping" /><i /></span>;

export function Source({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return <span className={u.src} onClick={onClick} role="link" tabIndex={0}>{children}</span>;
}

export function Empty({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return <div className={u.empty}>{icon}{children}</div>;
}

/* ---------- standard page template (UX-PLAN.md) ---------- */

export type Crumb = { label: ReactNode; href?: string };

/** Breadcrumb › title (+count) › one primary action. Every page starts with this. */
export function PageHeader({ crumbs, title, count, actions }: { crumbs?: Crumb[]; title: ReactNode; count?: ReactNode; actions?: ReactNode }) {
  return (
    <header className={u.ph}>
      <div className={u.phLeft}>
        {crumbs?.length ? (
          <nav className={u.crumbs} aria-label="Breadcrumb">
            {crumbs.map((c, i) => (
              <span key={i} className={u.crumb}>
                {c.href ? <a href={c.href}>{c.label}</a> : <span>{c.label}</span>}
                <span className={u.crumbSep} aria-hidden>/</span>
              </span>
            ))}
          </nav>
        ) : null}
        <h1 className={u.phTitle}>{title}{count !== undefined ? <span className={u.pageCount}>{count}</span> : null}</h1>
      </div>
      {actions ? <div className={u.phRight}>{actions}</div> : null}
    </header>
  );
}

/** Tabs / saved views on the left; layout switcher, filters and a count on the right. */
export function ViewBar({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <div className={u.vb}>
      <div className={u.vbSide}>{left}</div>
      <div className={u.vbSide}>{right}</div>
    </div>
  );
}

/** A labelled summary number with an optional comparison and link. Max 4 per page. */
export function Stat({ label, value, sub, tone, href, onClick }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: 'red' | 'green' | 'amber'; href?: string; onClick?: () => void }) {
  const body = (
    <>
      <span className={u.statLabel}>{label}</span>
      <span className={u.statValue} style={tone ? { color: `var(--${tone}Text)` } : undefined}>{value}</span>
      {sub ? <span className={u.statSub}>{sub}</span> : null}
    </>
  );
  if (href) return <a href={href} className={u.stat}>{body}</a>;
  if (onClick) return <button type="button" onClick={onClick} className={u.stat}>{body}</button>;
  return <div className={u.stat} style={{ cursor: 'default' }}>{body}</div>;
}
