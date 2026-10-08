'use client';

/*
 * "Plan my day" sheet (Sunsama-style): the AI proposes an ordered day, each item with a short
 * reason. Lock keeps an item; defer moves it off today. The capacity bar updates live and
 * Accept commits the plan to Home's Today list. Esc or Cancel closes without changes.
 */

import { useEffect, useState } from 'react';
import { ArrowDownToLine, Check, Lock, LockOpen, RotateCcw, Sparkles, X } from 'lucide-react';
import { fmtClock, fmtH } from '@/lib/data';
import { fmtMin, type WorkItem } from '@/lib/app-data';
import { BrandChip } from '@/components/brand';
import { Badge, Button, CapacityBar, IconButton } from '@/components/paper/ui';
import p from './plan-sheet.module.css';

export type PlanItem = { taskId: string; why: string; locked: boolean; start?: number; dur: number };
export type Deferred = { taskId: string; why: string };

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function PlanSheet({ items: initItems, deferred: initDeferred, byId, inBrand, available, doneMin, onAccept, onClose }: {
  items: PlanItem[]; deferred: Deferred[]; byId: Record<string, WorkItem>; inBrand: (t?: WorkItem) => boolean;
  available: number; doneMin: number; onAccept: (items: PlanItem[], deferred: Deferred[]) => void; onClose: () => void;
}) {
  const [items, setItems] = useState(initItems);
  const [deferred, setDeferred] = useState(initDeferred);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const shown = items.filter((i) => inBrand(byId[i.taskId])).sort((a, b) => (a.start ?? 9999) - (b.start ?? 9999));
  const shownDef = deferred.filter((i) => inBrand(byId[i.taskId]));
  const planned = doneMin + shown.reduce((a, i) => a + i.dur, 0);
  const over = Math.max(0, planned - available);

  const toggleLock = (id: string) => setItems((xs) => xs.map((x) => (x.taskId === id ? { ...x, locked: !x.locked } : x)));
  const defer = (id: string) => {
    setItems((xs) => xs.filter((x) => x.taskId !== id));
    setDeferred((xs) => [...xs, { taskId: id, why: 'You deferred it' }]);
  };
  const addBack = (id: string) => {
    setDeferred((xs) => xs.filter((x) => x.taskId !== id));
    setItems((xs) => [...xs, { taskId: id, why: 'You added it', locked: false, dur: byId[id]?.est ?? 30 }]);
  };

  return (
    <div className={p.scrim} onMouseDown={onClose}>
      <section className={p.sheet} role="dialog" aria-modal="true" aria-labelledby="plan-title" onMouseDown={(e) => e.stopPropagation()}>
        <header className={p.head}>
          <div className={p.headText}>
            <span className={p.eyebrow}><Sparkles size={13} /> AI proposal</span>
            <h2 id="plan-title" className={p.title}>Plan my day</h2>
            <p className={p.sub}>Review the order, lock what must stay, defer what doesn’t fit. Nothing changes until you accept.</p>
          </div>
          <IconButton label="Close" onClick={onClose}><X size={18} /></IconButton>
        </header>

        <div className={p.cap}>
          <div className={p.capRow}>
            <span className={p.capNum}>{fmtH(planned / 60)} <span className={p.capOf}>of {fmtH(available / 60)} free</span></span>
            {over > 0 ? <Badge tone="red" dot>{fmtMin(over)} over</Badge> : <Badge tone="green" dot>Fits</Badge>}
          </div>
          <CapacityBar planned={planned} available={available} height={12} />
          <span className={p.capNote}>{doneMin ? `Includes ${fmtMin(doneMin)} already done today.` : 'Nothing done yet today.'}</span>
        </div>

        <ol className={p.steps}>
          {shown.length === 0 ? <li className={p.empty}>No items in this plan. Add one back from the deferred list below.</li> : null}
          {shown.map((it, i) => {
            const t = byId[it.taskId];
            if (!t) return null;
            return (
              <li key={it.taskId} className={cx(p.step, it.locked && p.stepLocked)}>
                <span className={p.idx}>{i + 1}</span>
                <span className={p.time}>{it.start !== undefined ? fmtClock(it.start) : 'Anytime'}</span>
                <BrandChip id={t.brand} size={24} />
                <span className={p.main}>
                  <span className={p.stepTitle}>{t.title}</span>
                  <span className={p.why}><Sparkles size={12} />{it.why}</span>
                </span>
                <span className={p.dur}>{fmtMin(it.dur)}</span>
                <span className={p.acts}>
                  <Button size="sm" variant={it.locked ? 'dark' : 'light'} icon={it.locked ? <Lock size={13} /> : <LockOpen size={13} />} onClick={() => toggleLock(it.taskId)}>
                    {it.locked ? 'Locked' : 'Lock'}
                  </Button>
                  <Button size="sm" variant="light" icon={<ArrowDownToLine size={13} />} disabled={it.locked} title={it.locked ? 'Unlock to defer' : 'Move off today'} onClick={() => defer(it.taskId)}>
                    Defer
                  </Button>
                </span>
              </li>
            );
          })}
        </ol>

        <div className={p.defer}>
          <div className={p.deferHead}>Deferred to later <span className={p.count}>{shownDef.length}</span></div>
          {shownDef.length === 0 ? <div className={p.deferEmpty}>Nothing deferred.</div> : null}
          {shownDef.map((it) => {
            const t = byId[it.taskId];
            if (!t) return null;
            return (
              <div key={it.taskId} className={p.dRow}>
                <BrandChip id={t.brand} size={20} />
                <span className={p.dTitle}>{t.title}</span>
                <span className={p.dWhy}>{it.why}</span>
                <span className={p.dur}>{fmtMin(t.est)}</span>
                <Button size="sm" variant="light" icon={<RotateCcw size={13} />} onClick={() => addBack(it.taskId)}>Add back</Button>
              </div>
            );
          })}
        </div>

        <footer className={p.foot}>
          <span className={p.footNote}>{shown.length} in plan · {shownDef.length} deferred</span>
          <Button variant="light" onClick={onClose}>Cancel</Button>
          <Button variant="dark" icon={<Check size={15} />} onClick={() => onAccept(items, deferred)}>Accept plan</Button>
        </footer>
      </section>
    </div>
  );
}
