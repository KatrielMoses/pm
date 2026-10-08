'use client';

/*
 * Home = old Home + Today + My work. One summary strip (4 stats), ONE list (Today · Upcoming ·
 * Assigned) and ONE ink hero ("Your day": capacity, next up with timer, agenda). "Plan my day"
 * opens the planning sheet; accepting it reorders and re-times the Today list.
 * Everything respects the sidebar brand filter.
 */

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CalendarClock, ChevronDown, Inbox, Play, Plus, Sparkles, Square, Users, Zap } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { useApp } from '@/lib/app-state';
import { brandName, fmtClock, fmtH, NOW, USER } from '@/lib/data';
import { calendar, dueLabel, fmtMin, plan, projectById, TODAY_INDEX, type WorkItem } from '@/lib/app-data';
import { BrandChip } from '@/components/brand';
import { CountUp } from '@/components/charts';
import { Avatar, Badge, Button, Checkbox, PageHeader, Segmented, Stat, StatusBadge, ViewBar } from '@/components/paper/ui';
import { PlanSheet, type Deferred, type PlanItem } from './_home/plan-sheet';
import s from './home.module.css';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Tab = 'today' | 'upcoming' | 'assigned';
type Row = { t: WorkItem; when: ReactNode };
type Group = { id: string; label: string; rows: Row[]; collapsible?: boolean; tone?: 'red' };

/* prototype relationships */
const DONE_EARLIER: Record<string, number> = { w2: 9 * 60 }; // finished this morning, kept in "Done today"
const ASSIGNED_BY_ME = ['w3', 'w4', 'w5', 'w7', 'w9', 'w14', 'w16', 'w20', 'w25', 'w29', 'w30', 'w32'];

const late = (t: WorkItem) => t.due !== undefined && t.due < NOW.day && t.status !== 'done';
const greeting = NOW.minutes < 12 * 60 ? 'Good morning' : NOW.minutes < 18 * 60 ? 'Good afternoon' : 'Good evening';
const clock = (ms: number) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
};

export default function Home() {
  const { brand, s: d } = useWorkspace();
  const { tasks, openTask, updateTask, toast, timer, setTimer, setPanel, setCapture } = useApp();
  const byId = useMemo(() => Object.fromEntries(tasks.map((t) => [t.id, t])), [tasks]);
  const inB = useCallback((t?: WorkItem) => !!t && (!brand || t.brand === brand), [brand]);

  const [tab, setTab] = useState<Tab>('today');
  const [items, setItems] = useState<PlanItem[]>(plan.proposed);
  const [deferred, setDeferred] = useState<Deferred[]>(plan.deferred);
  const [accepted, setAccepted] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [openDone, setOpenDone] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  /* /app?plan=1 opens the sheet (target for the old /app/today redirect and "Plan my day" commands) */
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('plan') === '1') setPlanning(true);
  }, []);
  useEffect(() => {
    if (!timer) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timer]);

  /* ---------- today's set: done earlier + planned + (deferred until the plan is accepted) ---------- */
  const times: Record<string, number> = { ...DONE_EARLIER };
  items.forEach((i) => { if (i.start !== undefined) times[i.taskId] = i.start; });
  const todayIds = useMemo(() => {
    const ids = [...Object.keys(DONE_EARLIER), ...items.map((i) => i.taskId), ...(accepted ? [] : deferred.map((i) => i.taskId))];
    // anything of mine that is due today or late and not yet listed
    tasks.forEach((t) => { if (t.assignee === 'km' && t.due !== undefined && t.due <= NOW.day && t.status !== 'done' && !ids.includes(t.id)) ids.push(t.id); });
    return ids;
  }, [items, deferred, accepted, tasks]);
  const today = todayIds.map((id) => byId[id]).filter((t): t is WorkItem => inB(t));

  const available = brand ? Math.round(d.available * 60) : plan.available;
  const planned = today.reduce((a, t) => a + t.est, 0);
  const over = Math.max(0, planned - available);
  const doneMin = Object.keys(DONE_EARLIER).map((id) => byId[id]).filter(inB).reduce((a, t) => a + t.est, 0);

  /* ---------- groups ---------- */
  const tLate = today.filter(late);
  const tSched = today.filter((t) => t.status !== 'done' && !late(t) && times[t.id] !== undefined).sort((a, b) => times[a.id] - times[b.id]);
  const tAny = today.filter((t) => t.status !== 'done' && !late(t) && times[t.id] === undefined);
  const tDone = today.filter((t) => t.status === 'done');
  const timeCell = (t: WorkItem) => (times[t.id] !== undefined ? <span className={s.mono}>{fmtClock(times[t.id])}</span> : <span className={s.soft}>Anytime</span>);

  const mine = tasks.filter((t) => t.assignee === 'km' && inB(t));
  const upcoming = mine.filter((t) => t.status !== 'done' && !todayIds.includes(t.id));
  const dueCell = (t: WorkItem) => (late(t) ? <Badge tone="red">{dueLabel(t.due)}</Badge> : <span className={s.mono}>{dueLabel(t.due)}</span>);
  const assigned = ASSIGNED_BY_ME.map((id) => byId[id]).filter(inB);

  const groups: Record<Tab, Group[]> = {
    today: [
      { id: 'late', label: 'Overdue', tone: 'red', rows: tLate.map((t) => ({ t, when: <Badge tone="red">{dueLabel(t.due)}</Badge> })) },
      { id: 'sched', label: 'Scheduled', rows: tSched.map((t) => ({ t, when: timeCell(t) })) },
      { id: 'any', label: 'Anytime', rows: tAny.map((t) => ({ t, when: timeCell(t) })) },
      { id: 'done', label: 'Done today', collapsible: true, rows: tDone.map((t) => ({ t, when: timeCell(t) })) },
    ],
    upcoming: [
      { id: 'tom', label: 'Tomorrow', rows: upcoming.filter((t) => t.due === NOW.day + 1) },
      { id: 'week', label: 'Later this week', rows: upcoming.filter((t) => t.due !== undefined && t.due > NOW.day + 1 && t.due <= 11) },
      { id: 'later', label: 'Later', rows: upcoming.filter((t) => t.due !== undefined && t.due > 11) },
      { id: 'none', label: 'No date', rows: upcoming.filter((t) => t.due === undefined) },
    ].map((g) => ({ ...g, rows: g.rows.sort((a, b) => (a.due ?? 99) - (b.due ?? 99) || a.priority - b.priority).map((t) => ({ t, when: dueCell(t) })) })),
    assigned: [
      { id: 'review', label: 'Waiting on your review', rows: assigned.filter((t) => t.status === 'review') },
      { id: 'blocked', label: 'Blocked', tone: 'red' as const, rows: assigned.filter((t) => t.status === 'blocked') },
      { id: 'doing', label: 'In progress', rows: assigned.filter((t) => t.status === 'doing') },
      { id: 'todo', label: 'Not started', rows: assigned.filter((t) => t.status === 'todo' || t.status === 'backlog') },
      { id: 'done', label: 'Done', collapsible: true, rows: assigned.filter((t) => t.status === 'done') },
    ].map((g) => ({ ...g, rows: g.rows.map((t) => ({ t, when: dueCell(t) })) })),
  };
  const lists: Record<Tab, WorkItem[]> = { today: today.filter((t) => t.status !== 'done'), upcoming, assigned: assigned.filter((t) => t.status !== 'done') };
  const shown = lists[tab];

  /* ---------- summary numbers ---------- */
  const weekDue = mine.filter((t) => t.status !== 'done' && t.due !== undefined && t.due >= NOW.day && t.due <= 11);
  const lateCount = mine.filter(late).length;
  const atRisk = d.projects.filter((p) => p.health !== 'on');

  /* ---------- next up + agenda ---------- */
  const open = [...tLate, ...tSched, ...tAny].filter((t) => t.status !== 'blocked');
  const next = (timer && open.find((t) => t.id === timer.taskId)) || open.find((t) => t.status === 'doing') || open[0];
  const tracking = !!next && timer?.taskId === next.id;

  const agenda = [
    ...calendar.filter((b) => b.day === TODAY_INDEX && b.kind !== 'task' && (!brand || b.brand === brand || b.brand === null))
      .map((b) => ({ id: b.id, start: b.start, end: b.end, title: b.title, taskId: undefined as string | undefined, kind: b.kind, done: false, conflict: !!b.conflict })),
    ...today.filter((t) => times[t.id] !== undefined)
      .map((t) => ({ id: t.id, start: times[t.id], end: times[t.id] + t.est, title: t.title, taskId: t.id as string | undefined, kind: 'task' as const, done: t.status === 'done', conflict: false })),
  ].sort((a, b) => a.start - b.start);
  const nowIdx = agenda.findIndex((b) => b.start > NOW.minutes);

  /* ---------- actions ---------- */
  const toggleDone = (t: WorkItem) => {
    const done = t.status === 'done';
    updateTask(t.id, { status: done ? 'todo' : 'done' });
    if (!done && timer?.taskId === t.id) setTimer(null);
    toast(done ? `${t.key} reopened` : `${t.key} done`);
  };
  const toggleTimer = () => {
    if (!next) return;
    if (tracking) { setTimer(null); toast(`Stopped · ${clock(now - (timer?.since ?? now))} on ${next.key}`); }
    else { setTimer({ taskId: next.id, since: Date.now() }); setNow(Date.now()); toast(`Tracking ${next.key}`); }
  };
  const acceptPlan = (nextItems: PlanItem[], nextDeferred: Deferred[]) => {
    setItems(nextItems);
    setDeferred(nextDeferred);
    setAccepted(true);
    setPlanning(false);
    setTab('today');
    const n = nextItems.filter((i) => inB(byId[i.taskId])).length;
    const m = nextDeferred.filter((i) => inB(byId[i.taskId])).length;
    toast(`Plan accepted · ${n} on today${m ? ` · ${m} moved to Upcoming` : ''}`);
  };

  const scope = brand ? brandName(brand) : 'all brands';

  return (
    <>
      <PageHeader
        crumbs={[{ label: `${NOW.weekday === 'Tue' ? 'Tuesday' : NOW.weekday} ${NOW.day} October · ${NOW.time}` }]}
        title={`${greeting}, ${USER.name}`}
        actions={<>
          <Button variant="light" icon={<Sparkles size={15} />} onClick={() => setPanel('ai')}>Ask AI</Button>
          <Button variant="dark" icon={<Zap size={15} />} onClick={() => setPlanning(true)}>{accepted ? 'Re-plan my day' : 'Plan my day'}</Button>
        </>}
      />

      {/* ---------- summary strip: 4 labelled, clickable numbers ---------- */}
      <section className={s.strip} aria-label="Summary">
        <Stat label="Today" tone={over > 0 ? 'red' : undefined}
          value={<><CountUp value={planned / 60} decimals={1} suffix="h" /> <span className={s.statOf}>of {fmtH(available / 60)}</span></>}
          sub={over > 0 ? `${fmtMin(over)} over · plan your day` : `${fmtMin(available - planned)} free`}
          onClick={() => setPlanning(true)} />
        <Stat label="Needs you" value={<CountUp value={d.needsYou} />} sub="Reviews and failures in Inbox" href="/app/inbox" />
        <Stat label="Due this week" value={<CountUp value={weekDue.length} />} tone={lateCount ? 'amber' : undefined}
          sub={lateCount ? `Plus ${lateCount} overdue` : 'None overdue'} onClick={() => setTab('upcoming')} />
        <Stat label="Projects at risk" value={<CountUp value={atRisk.length} />} tone={atRisk.some((p) => p.health === 'off') ? 'red' : atRisk.length ? 'amber' : 'green'}
          sub={atRisk.length ? atRisk.map((p) => p.name).join(', ') : 'All on track'} href="/app/projects" />
      </section>

      <div className={s.layout}>
        {/* ---------- the one list ---------- */}
        <section className={s.listCard} aria-label="Tasks">
          <ViewBar
            left={<Segmented sub value={tab} onChange={setTab} options={[
              { id: 'today', label: 'Today', count: lists.today.length },
              { id: 'upcoming', label: 'Upcoming', count: lists.upcoming.length },
              { id: 'assigned', label: 'Assigned', count: lists.assigned.length },
            ]} />}
            right={<span className={s.count}>
              {tab === 'today' ? `${lists.today.length} open · ${fmtMin(lists.today.reduce((a, t) => a + t.est, 0))}`
                : tab === 'upcoming' ? `${shown.length} after today`
                  : `${shown.length} open, assigned by you`}
            </span>}
          />

          <div className={s.head} aria-hidden>
            <span /><span>Task</span><span>Project</span><span>{tab === 'today' ? 'Time' : 'Due'}</span><span className={s.right}>Est.</span><span>Owner</span>
          </div>

          {shown.length === 0 ? (
            <EmptyState tab={tab} scope={scope} allDone={tab === 'today' && tDone.length > 0}
              onUpcoming={() => setTab('upcoming')} onCapture={() => setCapture(true)} />
          ) : null}

          <div key={tab} className={s.groups}>
            {(() => { let n = 0; return groups[tab].map((g) => {
              if (!g.rows.length) return null;
              if (shown.length === 0 && !g.collapsible) return null;
              const closed = g.collapsible && !openDone;
              return (
                <div key={g.id} className={s.group}>
                  {g.collapsible ? (
                    <button type="button" className={s.gHead} onClick={() => setOpenDone((v) => !v)} aria-expanded={!closed}>
                      <ChevronDown size={15} className={cx(s.chev, closed && s.chevClosed)} />
                      <span className={s.gLabel}>{g.label}</span><span className={s.gCount}>{g.rows.length}</span>
                    </button>
                  ) : (
                    <div className={s.gHead}>
                      <span className={cx(s.gLabel, g.tone === 'red' && s.gRed)}>{g.label}</span><span className={s.gCount}>{g.rows.length}</span>
                      <span className={s.gEst}>{fmtMin(g.rows.reduce((a, r) => a + r.t.est, 0))}</span>
                    </div>
                  )}
                  {!closed ? g.rows.map(({ t, when }) => (
                    <TaskRow key={t.id} i={n++} t={t} when={when} tracking={timer?.taskId === t.id} onOpen={() => openTask(t.id)} onDone={() => toggleDone(t)} />
                  )) : null}
                </div>
              );
            }); })()}
          </div>
        </section>

        {/* ---------- the one ink hero ---------- */}
        <aside className={s.hero} aria-label="Your day">
          <div className={s.heroHead}>
            <span className={s.heroLabel}>Your day</span>
            <span className={s.heroMute}>{brand ? brandName(brand) : 'All brands'}</span>
          </div>

          <div className={s.capNum}>
            <b><CountUp value={planned / 60} decimals={1} suffix="h" /></b><span>planned of {fmtH(available / 60)} free</span>
          </div>
          <div className={s.bar} role="img" aria-label={`${fmtH(planned / 60)} planned, ${fmtH(available / 60)} available`}>
            {(() => {
              const total = Math.max(planned, available) || 1;
              return (<>
                <i className={cx(s.barIn, 'anim-grow-x')} style={{ width: `${(Math.min(planned, available) / total) * 100}%` }} />
                {over > 0 ? <i className={cx(s.barOver, 'anim-grow-x')} style={{ width: `${(over / total) * 100}%` }} /> : <i className={s.barFree} />}
              </>);
            })()}
          </div>
          <div className={s.capNote}>
            {over > 0 ? <span className={s.heroBad}>{fmtMin(over)} over capacity</span> : <span>{fmtMin(available - planned)} still free</span>}
            {over > 0 ? <button type="button" className={s.heroLink} onClick={() => setPlanning(true)}>Fix with Plan my day</button> : null}
          </div>

          <div className={cx(s.next, tracking && s.nextLive)}>
            <span className={s.heroCap}>Next up</span>
            {next ? (<>
              <button type="button" className={s.nextTask} onClick={() => openTask(next.id)}>
                <BrandChip id={next.brand} size={26} />
                <b>{next.title}</b>
              </button>
              <span className={s.nextMeta}>
                {next.key} · {times[next.id] !== undefined ? fmtClock(times[next.id]) : 'Anytime'} · {fmtMin(Math.max(0, next.est - next.logged))} left
                {late(next) ? <em className={s.heroBad}> · {dueLabel(next.due)}</em> : null}
              </span>
              <div className={s.nextActs}>
                <Button variant="accent" icon={tracking ? <Square size={14} /> : <Play size={14} />} onClick={toggleTimer}>
                  {tracking ? <><i className={s.recDot} />Stop {clock(now - (timer?.since ?? now))}</> : 'Start timer'}
                </Button>
                <Button variant="light" onClick={() => toggleDone(next)}>Mark done</Button>
              </div>
            </>) : (
              <span className={s.nextClear}>Nothing left for today.</span>
            )}
          </div>

          <div className={s.agenda}>
            <span className={s.heroCap}><CalendarClock size={13} /> Agenda</span>
            {agenda.length === 0 ? <span className={s.heroMute}>No calendar blocks today.</span> : null}
            <ol className={s.agList}>
              {agenda.map((b, i) => {
                const past = b.end <= NOW.minutes || b.done;
                const current = b.start <= NOW.minutes && b.end > NOW.minutes;
                const body = (<>
                  <span className={s.agTime}>{fmtClock(b.start)}</span>
                  <span className={s.agTitle}>{b.kind === 'meeting' ? <Users size={12} /> : null}{b.title}</span>
                  {b.conflict ? <span className={s.heroBad}>Clash</span> : null}
                </>);
                return (
                  <li key={b.id} className={s.agIn} style={{ animationDelay: `${220 + i * 45}ms` }}>
                    {i === nowIdx ? <div className={s.now}><span>{NOW.time}</span></div> : null}
                    {b.taskId ? (
                      <button type="button" className={cx(s.agRow, s.agClick, past && s.agPast, current && s.agNow)} onClick={() => openTask(b.taskId!)}>{body}</button>
                    ) : (
                      <div className={cx(s.agRow, past && s.agPast, current && s.agNow)}>{body}</div>
                    )}
                  </li>
                );
              })}
              {nowIdx === -1 && agenda.length ? <li><div className={s.now}><span>{NOW.time}</span></div></li> : null}
            </ol>
          </div>
        </aside>
      </div>

      {planning ? (
        <PlanSheet
          items={items} deferred={deferred} byId={byId} inBrand={inB}
          available={available} doneMin={doneMin}
          onAccept={acceptPlan} onClose={() => setPlanning(false)}
        />
      ) : null}
    </>
  );
}

function TaskRow({ i, t, when, tracking, onOpen, onDone }: { i: number; t: WorkItem; when: ReactNode; tracking: boolean; onOpen: () => void; onDone: () => void }) {
  const done = t.status === 'done';
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } };
  return (
    <div className={cx(s.row, done && s.rowDone, tracking && s.rowTracking)} style={{ animationDelay: `${60 + i * 35}ms` }} role="button" tabIndex={0} onClick={onOpen} onKeyDown={onKey}>
      <Checkbox on={done} onChange={onDone} label={done ? `Reopen ${t.title}` : `Mark ${t.title} done`} />
      <span className={s.title}>
        <span className={cx(s.titleText, done && s.struck)}>{t.title}</span>
        {tracking ? <Badge tone="accent" dot>Tracking</Badge> : !done && (t.status === 'doing' || t.status === 'review' || t.status === 'blocked') ? <StatusBadge status={t.status} /> : null}
      </span>
      <span className={s.project}><BrandChip id={t.brand} size={20} /><span className={s.ellipsis}>{projectById(t.projectId)?.name}</span></span>
      <span className={s.when}>{when}</span>
      <span className={cx(s.mono, s.right)}>{fmtMin(t.est)}</span>
      <span><Avatar id={t.assignee} size={24} /></span>
    </div>
  );
}

function EmptyState({ tab, scope, allDone, onUpcoming, onCapture }: { tab: Tab; scope: string; allDone: boolean; onUpcoming: () => void; onCapture: () => void }) {
  const copy = tab === 'today'
    ? allDone
      ? { title: 'All done for today', why: `Everything planned for ${scope} is finished.`, action: <Button variant="light" onClick={onUpcoming}>Pull from Upcoming</Button> }
      : { title: `Nothing on today for ${scope}`, why: 'No task here is due today, overdue or scheduled.', action: <Button variant="light" onClick={onUpcoming}>Pull from Upcoming</Button> }
    : tab === 'upcoming'
      ? { title: 'Nothing coming up', why: `You have no open tasks after today in ${scope}.`, action: <Button variant="light" icon={<Plus size={14} />} onClick={onCapture}>Capture a task</Button> }
      : { title: 'Nothing assigned by you', why: `You haven’t handed any open work in ${scope} to people or agents.`, action: <Button variant="light" icon={<Inbox size={14} />} onClick={onCapture}>Capture and assign</Button> };
  return (
    <div className={s.empty}>
      <b>{copy.title}</b>
      <span>{copy.why}</span>
      {copy.action}
    </div>
  );
}
