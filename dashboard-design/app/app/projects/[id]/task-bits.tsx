'use client';

/* Shared task row/card pieces so List, Board and Timeline show the same facts the same way. */

import { CircleCheck, GitPullRequest, OctagonAlert } from 'lucide-react';
import { dueLabel, type WorkItem } from '@/lib/app-data';
import s from './detail.module.css';

export const isLate = (t: WorkItem) => t.due !== undefined && t.due < 6 && t.status !== 'done';

/** At most two labels. */
export function TaskTags({ t }: { t: WorkItem }) {
  if (!t.labels.length) return null;
  return <>{t.labels.slice(0, 2).map((l) => <span key={l} className={s.tag}>{l}</span>)}</>;
}

/** Blocked and PR chips, only when they matter (not on done tasks). */
export function TaskChips({ t }: { t: WorkItem }) {
  const blocked = t.status === 'blocked' || !!t.blockedBy;
  const pr = t.pr && t.status !== 'done';
  if (!blocked && !pr) return null;
  return (
    <span className={s.chips}>
      {blocked ? <span className={s.chipBad}><OctagonAlert size={12} />{t.blockedBy ? `Blocked by ${t.blockedBy}` : 'Blocked'}</span> : null}
      {pr ? (
        <span className={t.ci === 'fail' ? s.chipBad : s.chip} title={t.ci ? `CI ${t.ci}` : undefined}>
          <GitPullRequest size={12} />PR {t.pr}{t.ci === 'fail' ? ' · CI failing' : t.ci === 'running' ? ' · CI running' : ''}
        </span>
      ) : null}
    </span>
  );
}

export function TaskDue({ t }: { t: WorkItem }) {
  if (t.status === 'done') return <span className={s.due}><CircleCheck size={12} /> Done</span>;
  return <span className={isLate(t) ? s.dueLate : s.due}>{dueLabel(t.due)}</span>;
}
