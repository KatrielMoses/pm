'use client';

/*
 * Plan › Calendar: week grid (default) with Day / Month ranges, kind filter pills, now line,
 * conflicts, and an unscheduled tray whose tasks drag onto the grid (task blocks can be dragged
 * to move). Primary action: Auto-place. One ink callout, only when something conflicts.
 */

import Link from 'next/link';
import { useMemo, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import { Check, ChevronLeft, ChevronRight, CircleAlert, Diamond, Flag, GripVertical, Inbox, Lock, Target, Users, Wand2 } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { useApp } from '@/lib/app-state';
import { fmtClock, NOW } from '@/lib/data';
import { calendar, fmtMin, TODAY_INDEX, WEEK_DAYS, type CalBlock, type WorkItem } from '@/lib/app-data';
import { BrandChip, brandColor } from '@/components/brand';
import { Button, Empty, IconButton, PageHeader, Segmented, ViewBar } from '@/components/paper/ui';
import { Callout, Count, cx, FilterPill } from './shared';
import p from './plan.module.css';
import s from './calendar.module.css';

type Range = 'day' | 'week' | 'month';
type Kind = 'task' | 'meeting' | 'focus' | 'deadline';
const KINDS: { id: Kind; label: string }[] = [
  { id: 'task', label: 'Tasks' }, { id: 'meeting', label: 'Meetings' }, { id: 'focus', label: 'Focus' }, { id: 'deadline', label: 'Deadlines' },
];
const kindOf = (b: CalBlock): Kind => (b.kind === 'milestone' ? 'deadline' : b.kind);

const H0 = 8;
const H1 = 19;
const WORK0 = 9 * 60;
const WORK1 = 18 * 60;
const PX = 1; // px per minute (60px per hour)
const snap = (m: number) => Math.round(m / 15) * 15;
const durOf = (t: WorkItem) => Math.min(120, Math.max(30, t.est));

/* overlap lanes per day: each block gets lane + lane count of its cluster */
function lanes(blocks: CalBlock[]) {
  const sorted = [...blocks].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Record<string, { lane: number; of: number }> = {};
  let cluster: CalBlock[] = [];
  let ends: number[] = [];
  let clusterEnd = -1;
  const flush = () => { const n = ends.length; cluster.forEach((b) => { out[b.id].of = n; }); cluster = []; ends = []; };
  for (const b of sorted) {
    if (b.start >= clusterEnd) { flush(); clusterEnd = -1; }
    let lane = ends.findIndex((e) => e <= b.start);
    if (lane === -1) { lane = ends.length; ends.push(b.end); } else ends[lane] = b.end;
    out[b.id] = { lane, of: 1 };
    cluster.push(b);
    clusterEnd = Math.max(clusterEnd, b.end);
  }
  flush();
  return out;
}

const KIND_ICON: Partial<Record<CalBlock['kind'], ReactNode>> = {
  meeting: <Users size={12} />, deadline: <Flag size={12} />, milestone: <Diamond size={12} />, focus: <Target size={12} />,
};

export function CalendarView({ switcher }: { switcher: ReactNode }) {
  const { brand } = useWorkspace();
  const { tasks, openTask, updateTask, toast } = useApp();
  const [range, setRange] = useState<Range>('week');
  const [day, setDay] = useState(TODAY_INDEX);
  const [kinds, setKinds] = useState<Set<Kind>>(new Set(KINDS.map((k) => k.id)));
  const [placed, setPlaced] = useState<CalBlock[]>([]);
  const [moved, setMoved] = useState<Record<string, { day: number; start: number; end: number }>>({});
  const [ghost, setGhost] = useState<{ day: number; start: number; dur: number } | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);

  const byId = useMemo(() => Object.fromEntries(tasks.map((t) => [t.id, t])), [tasks]);
  const inB = (b: string | null | undefined) => !brand || b === brand || b === null;

  /* all blocks (seed + placed, with moves applied), brand filtered */
  const all = useMemo(() => [...calendar, ...placed].map((b) => (moved[b.id] ? { ...b, ...moved[b.id], conflict: false } : b)).filter((b) => !brand || b.brand === brand || b.brand === null),
    [placed, moved, brand]);
  /* conflicts: seeded flags + anything placed/moved that overlaps a hard block */
  const blocks = useMemo(() => {
    const touched = new Set([...placed.map((x) => x.id), ...Object.keys(moved)]);
    const hard = (b: CalBlock) => b.kind === 'task' || b.kind === 'meeting';
    return all.map((b) => {
      if (b.conflict || !touched.has(b.id) || !hard(b)) return b;
      const hit = all.some((o) => o.id !== b.id && o.day === b.day && hard(o) && o.start < b.end && o.end > b.start);
      return hit ? { ...b, conflict: true } : b;
    });
  }, [all, placed, moved]);
  const shown = blocks.filter((b) => kinds.has(kindOf(b)));
  const done = (b: CalBlock) => !!b.done || (b.taskId ? byId[b.taskId]?.status === 'done' : false);

  const scheduledIds = new Set(blocks.map((b) => b.taskId).filter(Boolean));
  const unscheduled = tasks.filter((t) => t.assignee === 'km' && t.status !== 'done' && t.status !== 'backlog' && !scheduledIds.has(t.id) && inB(t.brand));
  const conflicts = blocks.filter((b) => b.conflict).sort((a, b) => a.day - b.day || a.start - b.start);
  const counts = Object.fromEntries(KINDS.map((k) => [k.id, blocks.filter((b) => kindOf(b) === k.id).length])) as Record<Kind, number>;
  const inRange = range === 'day' ? shown.filter((b) => b.day === day) : shown;

  /* ---- actions ---- */
  const toggleKind = (k: Kind) => setKinds((x) => { const n = new Set(x); if (n.has(k)) { if (n.size > 1) n.delete(k); } else n.add(k); return n; });
  const place = (t: WorkItem, d: number, start: number) => {
    const dur = durOf(t);
    const st = Math.max(H0 * 60, Math.min(H1 * 60 - dur, start));
    setPlaced((x) => [...x.filter((y) => y.taskId !== t.id), { id: `n-${t.id}`, day: d, start: st, end: st + dur, title: t.title, brand: t.brand, kind: 'task', taskId: t.id }]);
    toast(`${t.key} → ${WEEK_DAYS[d].d} ${fmtClock(st)}`);
  };
  const autoPlace = () => {
    if (!unscheduled.length) { toast('Nothing to place'); return; }
    const busy = blocks.filter((b) => b.kind !== 'deadline' && b.kind !== 'milestone').map((b) => ({ day: b.day, start: b.start, end: b.end }));
    const out: CalBlock[] = [];
    for (const t of unscheduled) {
      const dur = durOf(t);
      let found: { day: number; start: number } | null = null;
      for (let d = TODAY_INDEX; d <= 4 && !found; d++) {
        for (let m = d === TODAY_INDEX ? snap(NOW.minutes + 14) : WORK0; m + dur <= WORK1; m += 15) {
          if (!busy.some((b) => b.day === d && b.start < m + dur && b.end > m)) { found = { day: d, start: m }; break; }
        }
      }
      if (found) {
        busy.push({ day: found.day, start: found.start, end: found.start + dur });
        out.push({ id: `n-${t.id}`, day: found.day, start: found.start, end: found.start + dur, title: t.title, brand: t.brand, kind: 'task', taskId: t.id });
      }
    }
    setPlaced((x) => [...x, ...out]);
    toast(`${out.length} placed in free slots`);
  };

  /* drag: "task:<id>" from the tray, "block:<id>" to move a scheduled task */
  const minuteAt = (e: DragEvent<HTMLDivElement>) => snap(H0 * 60 + (e.clientY - e.currentTarget.getBoundingClientRect().top) / PX);
  const dragDur = (key: string | null) => {
    if (!key) return 60;
    const [kind, id] = key.split(':');
    if (kind === 'task') return byId[id] ? durOf(byId[id]) : 60;
    const b = blocks.find((x) => x.id === id);
    return b ? b.end - b.start : 60;
  };
  const onOver = (e: DragEvent<HTMLDivElement>, d: number) => {
    if (!dragKey) return;
    e.preventDefault();
    const dur = dragDur(dragKey);
    const start = Math.max(H0 * 60, Math.min(H1 * 60 - dur, minuteAt(e) - 15));
    if (!ghost || ghost.day !== d || ghost.start !== start) setGhost({ day: d, start, dur });
  };
  const onDrop = (e: DragEvent<HTMLDivElement>, d: number) => {
    e.preventDefault();
    const key = e.dataTransfer.getData('text/plain') || dragKey;
    const g = ghost;
    setGhost(null); setDragKey(null);
    if (!key || !g) return;
    const [kind, id] = key.split(':');
    if (kind === 'task') { const t = byId[id]; if (t) place(t, d, g.start); return; }
    const b = blocks.find((x) => x.id === id);
    if (!b) return;
    if (b.id.startsWith('n-')) setPlaced((x) => x.map((y) => (y.id === b.id ? { ...y, day: d, start: g.start, end: g.start + g.dur } : y)));
    else setMoved((m) => ({ ...m, [b.id]: { day: d, start: g.start, end: g.start + g.dur } }));
    toast(`${b.title} → ${WEEK_DAYS[d].d} ${fmtClock(g.start)}`);
  };
  const startDrag = (e: DragEvent, key: string) => { e.dataTransfer.setData('text/plain', key); e.dataTransfer.effectAllowed = 'move'; setDragKey(key); };
  const endDrag = () => { setDragKey(null); setGhost(null); };

  const onBlock = (b: CalBlock) => (b.taskId ? openTask(b.taskId) : toast(`${b.title} · ${fmtClock(b.start)}–${fmtClock(b.end)}`));
  const showDay = (i: number) => { setDay(i); setRange('day'); };
  const gridDays = range === 'day' ? [WEEK_DAYS[day]] : WEEK_DAYS;
  const rangeLabel = range === 'day' ? `${WEEK_DAYS[day].d} ${WEEK_DAYS[day].n} Oct` : range === 'month' ? 'October 2026' : '5–11 Oct';

  return (
    <>
      <PageHeader crumbs={[{ label: 'Plan', href: '/app/plan' }, { label: rangeLabel }]} title="Plan"
        actions={<Button variant="dark" icon={<Wand2 size={15} />} onClick={autoPlace} disabled={!unscheduled.length} title="Place unscheduled tasks into free slots">Auto-place{unscheduled.length ? ` ${unscheduled.length}` : ''}</Button>} />

      <ViewBar left={switcher} right={
        <>
          {range === 'day' ? (
            <span className={p.navDay}>
              <IconButton small label="Previous day" onClick={() => setDay((d) => Math.max(0, d - 1))}><ChevronLeft size={16} /></IconButton>
              <span className={p.navLabel}>{WEEK_DAYS[day].d} {WEEK_DAYS[day].n}</span>
              <IconButton small label="Next day" onClick={() => setDay((d) => Math.min(6, d + 1))}><ChevronRight size={16} /></IconButton>
            </span>
          ) : null}
          <Segmented<Range> value={range} onChange={setRange} options={[{ id: 'day', label: 'Day' }, { id: 'week', label: 'Week' }, { id: 'month', label: 'Month' }]} />
          <span className={p.divider} />
          {KINDS.map((k) => (
            <FilterPill key={k.id} on={kinds.has(k.id)} onClick={() => toggleKind(k.id)} count={counts[k.id]} swatch={<i className={cx(p.sw, p['sw_' + k.id])} />}>{k.label}</FilterPill>
          ))}
          <Count>{inRange.length} {inRange.length === 1 ? 'event' : 'events'}</Count>
        </>
      } />

      {conflicts.length ? (
        <Callout icon={<CircleAlert size={16} />} title={`${conflicts.length} ${conflicts.length === 1 ? 'conflict' : 'conflicts'}`}>
          {conflicts.map((b) => (
            <button key={b.id} className={p.cChip} onClick={() => showDay(b.day)} title="Show this day">
              <em>{WEEK_DAYS[b.day].d} {fmtClock(b.start)}</em>{b.title}
            </button>
          ))}
        </Callout>
      ) : null}

      <div className={s.layout}>
        {/* ---------- unscheduled tray ---------- */}
        <aside className={cx(p.card, s.side)}>
          <header className={p.cardHead}>
            <span className={p.cardTitle}>Unscheduled <Count>{unscheduled.length}</Count></span>
          </header>
          {unscheduled.length ? <span className={p.hint}>Drag a task onto a day, or Auto-place.</span> : null}
          {unscheduled.length === 0 ? (
            <Empty icon={<Check size={18} />}>
              <span>Every open task of yours has a time slot.</span>
              <Link href="/app/inbox" className={s.emptyLink}><Inbox size={14} />Triage Inbox</Link>
            </Empty>
          ) : null}
          <div className={s.tray}>
            {unscheduled.map((t) => (
              <div key={t.id} className={cx(s.chip, dragKey === `task:${t.id}` && s.chipDrag)} draggable
                onDragStart={(e) => startDrag(e, `task:${t.id}`)} onDragEnd={endDrag} onClick={() => openTask(t.id)}
                role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') openTask(t.id); }} title="Drag onto the calendar, or click to open">
                <GripVertical size={14} className={s.grip} />
                <BrandChip id={t.brand} size={20} />
                <span className={s.chipTitle}>{t.title}</span>
                <span className={s.chipEst}>{fmtMin(t.est)}</span>
              </div>
            ))}
          </div>
        </aside>

        {/* ---------- main ---------- */}
        <section className={cx(p.card, s.main)}>
          {range !== 'month' ? (
            <div className={s.grid} style={{ ['--cols' as string]: gridDays.length }}>
              <div className={s.gHead}>
                <span className={s.tz}>GMT+1</span>
                {gridDays.map((w) => (
                  <button key={w.i} className={cx(s.dHead, w.i === TODAY_INDEX && s.dToday)} onClick={() => (range === 'day' ? setRange('week') : showDay(w.i))}
                    title={range === 'day' ? 'Back to week' : `Show ${w.d} ${w.n}`}>
                    <b>{w.n}</b><span>{w.d}</span>
                  </button>
                ))}
              </div>
              <div className={s.gBody}>
                <div className={s.gutter} style={{ height: (H1 - H0) * 60 * PX }}>
                  {Array.from({ length: H1 - H0 }, (_, i) => <span key={i} style={{ top: i * 60 * PX }}>{String(H0 + i).padStart(2, '0')}:00</span>)}
                  {gridDays.some((w) => w.i === TODAY_INDEX) ? <em className={s.nowPill} style={{ top: (NOW.minutes - H0 * 60) * PX }}>{NOW.time}</em> : null}
                </div>
                {gridDays.map((w) => {
                  const dayBlocks = shown.filter((b) => b.day === w.i);
                  const lay = lanes(dayBlocks);
                  return (
                    <div key={w.i} className={cx(s.col, w.i >= 5 && s.weekend, ghost?.day === w.i && s.colDrop)} style={{ height: (H1 - H0) * 60 * PX }}
                      onDragOver={(e) => onOver(e, w.i)} onDragLeave={(e) => { if (e.currentTarget === e.target) setGhost(null); }} onDrop={(e) => onDrop(e, w.i)}>
                      <div className={s.off} style={{ top: 0, height: (WORK0 - H0 * 60) * PX }} />
                      <div className={s.off} style={{ top: (WORK1 - H0 * 60) * PX, bottom: 0 }} />
                      {Array.from({ length: H1 - H0 - 1 }, (_, i) => <i key={i} className={s.hLine} style={{ top: (i + 1) * 60 * PX }} />)}
                      {dayBlocks.map((b) => {
                        const L = lay[b.id];
                        const h = Math.max(22, (b.end - b.start) * PX - 2);
                        const isDone = done(b);
                        const tall = h >= 40;
                        const style: CSSProperties = {
                          top: (b.start - H0 * 60) * PX + 1, height: h,
                          left: `calc(${(L.lane / L.of) * 100}% + 3px)`, width: `calc(${100 / L.of}% - 6px)`,
                          zIndex: 2 + L.lane,
                        };
                        if (b.kind === 'task' && b.brand) {
                          style.background = `color-mix(in srgb, ${brandColor(b.brand)} 14%, var(--card))`;
                          style.borderLeftColor = brandColor(b.brand);
                        }
                        const time = `${fmtClock(b.start)}–${fmtClock(b.end)}`;
                        return (
                          <div key={b.id} className={cx(s.ev, s['ev_' + b.kind], isDone && s.evDone, b.conflict && s.evConflict, dragKey === `block:${b.id}` && s.evDrag, !tall && s.evShort)}
                            style={style} draggable={b.kind === 'task' && !b.locked}
                            onDragStart={(e) => startDrag(e, `block:${b.id}`)} onDragEnd={endDrag}
                            onClick={() => onBlock(b)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onBlock(b); }}
                            title={`${time} · ${b.title}${b.conflict ? ' · Conflict' : ''}${b.locked ? ' · Locked' : ''}`}>
                            <span className={s.evTitle}>
                              {b.conflict ? <CircleAlert size={12} className={s.evAlert} /> : KIND_ICON[b.kind] ?? null}
                              {!tall ? <span className={s.evTimeInline}>{fmtClock(b.start)}</span> : null}
                              <span className={s.evText}>{b.title}</span>
                              {b.locked ? <Lock size={11} className={s.evLock} /> : null}
                              {isDone ? <Check size={12} className={s.evLock} /> : null}
                            </span>
                            {tall ? <span className={s.evTime}>{time}</span> : null}
                          </div>
                        );
                      })}
                      {ghost?.day === w.i ? (
                        <div className={s.ghost} style={{ top: (ghost.start - H0 * 60) * PX + 1, height: ghost.dur * PX - 2 }}>
                          {fmtClock(ghost.start)}–{fmtClock(ghost.start + ghost.dur)}
                        </div>
                      ) : null}
                      {w.i === TODAY_INDEX ? <div className={s.now} style={{ top: (NOW.minutes - H0 * 60) * PX }} /> : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <Month blocks={shown} tasks={tasks.filter((t) => inB(t.brand))} onDay={showDay} openTask={openTask} />
          )}

          {inRange.length === 0 && range !== 'month' ? (
            <Empty>
              <span>Nothing matches these filters{range === 'day' ? ` on ${WEEK_DAYS[day].d}` : ''}.</span>
              <Button size="sm" variant="light" onClick={() => setKinds(new Set(KINDS.map((k) => k.id)))}>Show all kinds</Button>
            </Empty>
          ) : null}
        </section>
      </div>
    </>
  );
}

/* ---------- month ---------- */
function Month({ blocks, tasks, onDay, openTask }: { blocks: CalBlock[]; tasks: WorkItem[]; onDay: (i: number) => void; openTask: (id: string) => void }) {
  // Mon 28 Sep → Sun 1 Nov 2026 (5 weeks)
  const cells = Array.from({ length: 35 }, (_, i) => {
    const month = i < 3 ? 'sep' : i > 33 ? 'nov' : 'oct';
    const date = month === 'sep' ? 28 + i : month === 'nov' ? 1 : i - 2;
    return { i, date, month };
  });
  return (
    <div className={s.month}>
      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <span key={d} className={s.mDow}>{d}</span>)}
      {cells.map((c) => {
        const inWeek = c.month === 'oct' && c.date >= 5 && c.date <= 11;
        const wi = c.date - 5;
        const items = inWeek ? blocks.filter((b) => b.day === wi).sort((a, b) => a.start - b.start) : [];
        const dues = c.month === 'oct' && !inWeek ? tasks.filter((t) => t.due === c.date && t.status !== 'done') : [];
        const isToday = c.month === 'oct' && c.date === NOW.day;
        return (
          <div key={c.i} className={cx(s.mCell, c.month !== 'oct' && s.mOut, isToday && s.mToday, inWeek && s.mClick)}
            onClick={() => inWeek && onDay(wi)} role={inWeek ? 'button' : undefined} tabIndex={inWeek ? 0 : undefined}>
            <span className={s.mNum}>{c.date}</span>
            {items.slice(0, 3).map((b) => (
              <span key={b.id} className={cx(s.mChip, s['m_' + kindOf(b)])}>
                <i style={b.brand ? { background: brandColor(b.brand) } : undefined} />{b.title}
              </span>
            ))}
            {items.length > 3 ? <span className={s.mMore}>+{items.length - 3} more</span> : null}
            {dues.slice(0, 2).map((t) => (
              <button key={t.id} className={cx(s.mChip, s.m_deadline)} onClick={(e) => { e.stopPropagation(); openTask(t.id); }} title={t.title}>
                <i style={{ background: brandColor(t.brand) }} />{t.key} due
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}
