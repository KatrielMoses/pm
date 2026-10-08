'use client';

/*
 * Shared bits for the Plan views: view id, filter pill, slim ink callout, and the project
 * timeline metadata (copied from the Projects route so Plan does not depend on it).
 * Days are "day of October 2026" (0 = 30 Sep, 32 = 1 Nov). Deterministic.
 */

import type { ReactNode } from 'react';
import { NOW, type Project } from '@/lib/data';
import s from './plan.module.css';

export type PlanView = 'calendar' | 'timeline' | 'workload';
export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/** Toggle filter: bordered pill with a check state and a count (clickable, never a status). */
export function FilterPill({ on, onClick, swatch, children, count }: { on: boolean; onClick: () => void; swatch?: ReactNode; children: ReactNode; count?: number }) {
  return (
    <button type="button" className={on ? s.fOn : s.fOff} onClick={onClick} aria-pressed={on}>
      {swatch}{children}{count !== undefined ? <span className={s.fCount}>{count}</span> : null}
    </button>
  );
}

/** The single ink hero on a Plan view: one line that names what needs action. */
export function Callout({ icon, title, children, action }: { icon: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <section className={s.callout} role="status">
      <span className={s.cIcon}>{icon}</span>
      <b className={s.cTitle}>{title}</b>
      <span className={s.cBody}>{children}</span>
      {action ? <span className={s.cAction}>{action}</span> : null}
    </section>
  );
}

export const Count = ({ children }: { children: ReactNode }) => <span className={s.count}>{children}</span>;

/* ---------- project timeline metadata ---------- */

export type Milestone = { id: string; label: string; day: number };
export const META: Record<string, { owner: string; start: number; milestones: Milestone[] }> = {
  p1: { owner: 'km', start: -16, milestones: [{ id: 'm1', label: 'Scope freeze', day: 1 }, { id: 'm2', label: 'RC1', day: 7 }, { id: 'm3', label: 'GA', day: 8 }] },
  p2: { owner: 'dp', start: -9, milestones: [{ id: 'm1', label: 'Pool PoC', day: 9 }, { id: 'm2', label: 'Beta', day: 16 }, { id: 'm3', label: 'Launch', day: 23 }] },
  p3: { owner: 'km', start: 1, milestones: [{ id: 'm1', label: 'Copy final', day: 12 }, { id: 'm2', label: 'Dodo live', day: 22 }, { id: 'm3', label: 'Launch', day: 30 }] },
  p4: { owner: 'ag-docs', start: -12, milestones: [{ id: 'm1', label: 'Search', day: 5 }, { id: 'm2', label: 'MCP guide', day: 10 }, { id: 'm3', label: 'Live', day: 12 }] },
  p5: { owner: 'km', start: -20, milestones: [{ id: 'm1', label: 'Beta', day: 2 }, { id: 'm2', label: 'v2.0', day: 9 }] },
  p6: { owner: 'km', start: -3, milestones: [{ id: 'm1', label: 'Webhooks', day: 9 }, { id: 'm2', label: 'Launch', day: 19 }] },
  p7: { owner: 'km', start: 0, milestones: [{ id: 'm1', label: 'Report', day: 12 }, { id: 'm2', label: 'Done', day: 15 }] },
  p8: { owner: 'ln', start: -6, milestones: [{ id: 'm1', label: 'Pack QA', day: 6 }, { id: 'm2', label: 'r3.3', day: 16 }] },
  p9: { owner: 'km', start: 5, milestones: [{ id: 'm1', label: 'Auth spike', day: 9 }, { id: 'm2', label: 'Pilot', day: 26 }, { id: 'm3', label: 'Live', day: 37 }] },
};
export const metaFor = (id: string) => META[id] ?? { owner: 'km', start: NOW.day, milestones: [] };
export const dueDay = (p: Project) => NOW.day + p.dueDays;
export const NOW_DAY = NOW.day + NOW.minutes / 1440;

export function dayLabel(d: number) {
  if (d <= 0) return `${30 + d} Sep`;
  if (d > 61) return `${d - 61} Dec`;
  if (d > 31) return `${d - 31} Nov`;
  return `${d} Oct`;
}
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** Oct 5 2026 is a Monday. */
export const weekday = (d: number) => WD[(((d - 5) % 7) + 7) % 7];
export const isWeekend = (d: number) => (((d - 5) % 7) + 7) % 7 >= 5;
