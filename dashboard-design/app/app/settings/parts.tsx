'use client';

/* Building blocks every Settings section uses: the page header with crumbs, grouped cards, setting rows, fields and meters. */

import type { ReactNode } from 'react';
import { PageHeader } from '@/components/paper/ui';
import x from './sections.module.css';

export { x };
export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/** Settings / Section › title › one primary action. */
export function SectionHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return <PageHeader crumbs={[{ label: 'Settings', href: '/app/settings' }, { label: title }]} title={title} actions={actions} />;
}

/** A titled white card. `desc` says what the group is for in one line. */
export function Group({ title, desc, actions, children, flush }: { title: ReactNode; desc?: ReactNode; actions?: ReactNode; children?: ReactNode; flush?: boolean }) {
  return (
    <section className={x.group}>
      <header className={x.groupHead}>
        <span className={x.groupText}><h2>{title}</h2>{desc ? <p>{desc}</p> : null}</span>
        {actions ? <span className={x.inline}>{actions}</span> : null}
      </header>
      <div className={flush ? x.groupFlush : x.groupBody}>{children}</div>
    </section>
  );
}

/** Label on the left, control on the right. */
export function Row({ icon, title, sub, children }: { icon?: ReactNode; title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className={x.row}>
      {icon ? <span className={x.rowIcon}>{icon}</span> : null}
      <span className={x.rowText}><b>{title}</b>{sub ? <span>{sub}</span> : null}</span>
      <span className={x.rowEnd}>{children}</span>
    </div>
  );
}

/** `group` renders a div (for several buttons) so clicking the label text cannot press the first one. */
export function Field({ label, children, wide, group }: { label: string; children: ReactNode; wide?: boolean; group?: boolean }) {
  if (group) return <div role="group" aria-label={label} className={cx(x.field, wide && x.fieldWide)}><span>{label}</span>{children}</div>;
  return <label className={cx(x.field, wide && x.fieldWide)}><span>{label}</span>{children}</label>;
}

/** Used vs limit as a plain bar; an optional projection draws hatched behind it. */
export function Meter({ label, used, cap, projected, fmt = (v) => String(v), warnAt = 0.8 }: {
  label: ReactNode; used: number; cap: number; projected?: number; fmt?: (v: number) => string; warnAt?: number;
}) {
  const p = Math.min(100, (used / (cap || 1)) * 100);
  const pp = projected !== undefined ? Math.min(100, (projected / (cap || 1)) * 100) : 0;
  const hot = (projected ?? used) / (cap || 1) > warnAt;
  return (
    <div className={x.meter}>
      <div className={x.meterTop}>
        <span className={x.meterLabel}>{label}</span>
        <span className={x.meterNum}>{fmt(used)} <em>/ {fmt(cap)}</em></span>
      </div>
      <div className={x.meterBar} role="meter" aria-valuenow={used} aria-valuemin={0} aria-valuemax={cap} aria-label={typeof label === 'string' ? label : undefined}>
        {projected !== undefined ? <i className={x.meterProj} style={{ width: `${pp}%` }} /> : null}
        <i className={cx(hot ? x.meterHot : x.meterUsed, 'anim-grow-x')} style={{ width: `${p}%` }} />
      </div>
      <div className={x.meterFoot}>
        <span>{Math.round(p)}% used</span>
        {projected !== undefined ? <span className={hot ? x.warnText : undefined}>Projected {fmt(projected)} by month end</span> : null}
      </div>
    </div>
  );
}
