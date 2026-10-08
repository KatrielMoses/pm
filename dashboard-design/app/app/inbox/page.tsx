'use client';

/*
 * Inbox (UX-PLAN.md): everything that needs a person, in one list. Captured items to triage, agent
 * work to review, and mentions & alerts. List on the left (j / k to move), the selected item on the
 * right with one ink action area. Agent setup lives in Settings › Agents.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  AtSign, Ban, Bot, CalendarClock, Check, CheckCheck, CircleAlert, ClipboardList, FileDiff, FileText, Flag, FolderPlus, GitMerge,
  GitPullRequest, Hourglass, Inbox as InboxIcon, Keyboard, ListChecks, ListTodo, Mail, MessageSquare, Mic, OctagonX, Play, Plug, Plus,
  RotateCcw, Send, Settings, Square, Trash2, Undo2, UserPlus, Wallet, X,
} from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { useApp } from '@/lib/app-state';
import { brandName, brands, NOW, type BrandId } from '@/lib/data';
import { fmtMin, inbox, notifications, personById, PRIORITY, projectById, projects, type InboxItem, type Notice, type Source, type WorkItem } from '@/lib/app-data';
import { BrandChip } from '@/components/brand';
import { Avatar, Badge, Button, Empty, IconButton, Kbd, PageHeader, Priority, Segmented, Toggle, ViewBar } from '@/components/paper/ui';
import { seedRuns, STATE_META, type AgentRun, type RunState, type Step } from './runs';
import { agoMin, fmtAgo, INBOX_RUN_STATES, isRunEcho, NOTICE_CTX, runMinutesAgo, tabOf, type Row, type Tab } from './items';
import s from './inbox.module.css';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
const money = (n: number) => `$${n.toFixed(2)}`;
const kTok = (n: number) => (n === 0 ? '0' : `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`);
const cap = (x: string) => x[0].toUpperCase() + x.slice(1);

const srcIcon: Record<Source, typeof Mic> = { voice: Mic, email: Mail, form: ClipboardList, github: GitPullRequest, typed: Keyboard, agent: Bot, api: Plug };
const srcLabel: Record<Source, string> = { voice: 'Voice', email: 'Email', form: 'Form', github: 'GitHub', typed: 'Typed', agent: 'Agent', api: 'API' };
const noticeIcon: Record<Notice['kind'], typeof AtSign> = { mention: AtSign, deadline: CalendarClock, spend: Wallet, failure: CircleAlert, approval: Flag, assign: UserPlus, review: Bot };
const noticeLabel: Record<Notice['kind'], string> = { mention: 'Mention', deadline: 'Deadline', spend: 'Spend alert', failure: 'Failure', approval: 'Approval', assign: 'Assigned', review: 'Review' };

type Fix = { brand?: BrandId; projectId?: string };
type Undo = { id: string; text: string; revert: () => void };

/* what a low-confidence capture still needs before it can become a task */
function needs(det: InboxItem['detected']): 'brand' | 'project' | null {
  if (!det.brand) return 'brand';
  if (det.type === 'task' && !det.projectId) return 'project';
  return null;
}

export default function InboxPage() {
  const router = useRouter();
  const { brand } = useWorkspace();
  const { tasks, openTask, updateTask, toast, setCapture } = useApp();

  const [tab, setTab] = useState<Tab>('all');
  const [runs, setRuns] = useState<AgentRun[]>(seedRuns);
  const [done, setDone] = useState<Record<string, true>>({});
  const [read, setRead] = useState<Record<string, boolean>>({});
  const [fix, setFix] = useState<Record<string, Fix>>({});
  const [keepBoth, setKeepBoth] = useState<Record<string, boolean>>({});
  const [selId, setSelId] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [pauseQueue, setPauseQueue] = useState(true);
  const [halted, setHalted] = useState<string | null>(null);
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  /* ---------- captured items with the user's answers merged in ---------- */
  const captured = useMemo(() => inbox.map((it) => {
    const f = fix[it.id] ?? {};
    const det = { ...it.detected, ...(f.brand ? { brand: f.brand } : {}), ...(f.projectId ? { projectId: f.projectId } : {}) };
    const ask = needs(det);
    return { ...it, detected: det, low: it.confidence === 'low' && ask !== null, ask, dup: !!it.duplicateOf && !keepBoth[it.id] };
  }), [fix, keepBoth]);

  const alerts = useMemo(() => notifications.filter((n) => !isRunEcho(n)), []);

  /* ---------- one list ---------- */
  const rows = useMemo<Row[]>(() => {
    const inBrand = (b: BrandId | null | undefined) => !brand || !b || b === brand;
    const out: Row[] = [];
    for (const it of captured) {
      const id = `c:${it.id}`;
      if (done[id] || !inBrand(it.detected.brand)) continue;
      const min = agoMin(it.time);
      out.push({
        id, kind: 'captured', ref: it.id, brand: it.detected.brand ?? null, title: it.raw, meta: srcLabel[it.source], min, unread: read[id] === undefined ? min < 60 : !read[id],
        badge: it.dup ? { tone: 'amber', label: 'Duplicate?' } : it.low ? { tone: 'amber', label: 'Needs info' } : undefined,
      });
    }
    for (const r of runs) {
      const id = `r:${r.id}`;
      if (!INBOX_RUN_STATES.includes(r.state) || (brand && r.brand !== brand)) continue;
      out.push({
        id, kind: 'review', ref: r.id, brand: r.brand, title: r.task, meta: r.agent, min: runMinutesAgo(r), unread: read[id] === undefined ? r.state !== 'running' : !read[id],
        badge: r.state === 'review' ? { tone: 'blue', label: 'Review' } : r.state === 'failed' ? { tone: 'red', label: 'Failed' } : r.state === 'waiting' ? { tone: 'amber', label: 'Approve' } : { tone: 'accent', label: 'Running' },
      });
    }
    for (const n of alerts) {
      const id = `n:${n.id}`;
      if (done[id] || !inBrand(n.brand)) continue;
      out.push({ id, kind: 'alert', ref: n.id, brand: n.brand, title: n.text, meta: noticeLabel[n.kind], min: agoMin(n.time), unread: read[id] === undefined ? !n.read : !read[id] });
    }
    return out.sort((a, b) => a.min - b.min);
  }, [captured, runs, alerts, done, read, brand]);

  const counts = { all: rows.length, captured: 0, reviews: 0, alerts: 0 } as Record<Tab, number>;
  const unreadIn = { all: 0, captured: 0, reviews: 0, alerts: 0 } as Record<Tab, number>;
  for (const r of rows) { counts[tabOf[r.kind]]++; if (r.unread) { unreadIn.all++; unreadIn[tabOf[r.kind]]++; } }

  const shown = tab === 'all' ? rows : rows.filter((r) => tabOf[r.kind] === tab);
  const sel = shown.find((r) => r.id === selId) ?? shown[0] ?? null;
  const running = runs.filter((r) => r.state === 'running');

  /* selecting an item marks it read */
  useEffect(() => {
    if (sel && sel.unread) setRead((x) => ({ ...x, [sel.id]: true }));
  }, [sel]);

  const select = useCallback((id: string) => { setSelId(id); rowRefs.current[id]?.scrollIntoView({ block: 'nearest' }); }, []);

  /* j / k (and arrows) move through the list */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey || confirmStop) return;
      if (!shown.length) return;
      const i = sel ? shown.findIndex((r) => r.id === sel.id) : -1;
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); select(shown[Math.min(shown.length - 1, i + 1)].id); }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); select(shown[Math.max(0, i - 1)].id); }
      else if (e.key === 'Enter' && sel && t === document.body) { e.preventDefault(); select(sel.id); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, sel, select, confirmStop]);

  /* after resolving the selected item, move to the next one */
  const nextAfter = (id: string) => {
    const i = shown.findIndex((r) => r.id === id);
    const next = shown[i + 1] ?? shown[i - 1];
    setSelId(next && next.id !== id ? next.id : null);
  };

  /* ---------- actions ---------- */
  const resolve = (id: string, text: string, tone: 'ok' | 'bad' = 'ok') => {
    nextAfter(id);
    setDone((d) => ({ ...d, [id]: true }));
    setUndo({ id, text, revert: () => setDone((d) => { const n = { ...d }; delete n[id]; return n; }) });
    toast(text, tone);
  };

  const setRunState = (id: string, state: RunState, extraStep?: Step) =>
    setRuns((rs) => rs.map((r) => (r.id === id ? { ...r, state, steps: extraStep ? [...r.steps, extraStep] : r.steps } : r)));

  const decide = (r: AgentRun, state: RunState, text: string, patch: Partial<WorkItem>, tone: 'ok' | 'bad' = 'ok') => {
    const id = `r:${r.id}`;
    const task = tasks.find((t) => t.id === r.taskId);
    const prev = { state: r.state, deliverable: task?.deliverable, status: task?.status };
    if (INBOX_RUN_STATES.includes(state)) { setRunState(r.id, state); toast(text, tone); return; }
    nextAfter(id);
    setRunState(r.id, state);
    if (Object.keys(patch).length) updateTask(r.taskId, patch);
    setUndo({
      id, text,
      revert: () => { setRunState(r.id, prev.state); if (Object.keys(patch).length && prev.status) updateTask(r.taskId, { deliverable: prev.deliverable, status: prev.status }); },
    });
    toast(text, tone);
  };

  const markAllRead = () => {
    setRead((x) => ({ ...x, ...Object.fromEntries(shown.map((r) => [r.id, true])) }));
    toast(`${unreadIn[tab]} marked read`);
  };

  const stopAll = () => {
    const n = running.length;
    setRuns((rs) => rs.map((r) => (r.state === 'running'
      ? { ...r, state: 'stopped', steps: [...r.steps.map((st) => (st.kind === 'run' ? { ...st, kind: 'fail' as const } : st)), { t: NOW.time, label: 'Emergency stop', kind: 'fail' as const }] }
      : r)));
    if (pauseQueue) setHalted(NOW.time);
    setConfirmStop(false);
    toast(`${n} run${n === 1 ? '' : 's'} stopped${pauseQueue ? ' · queue paused' : ''}`, 'bad');
  };

  useEffect(() => {
    if (!confirmStop) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setConfirmStop(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmStop]);

  /* ---------- render ---------- */
  const tabs: { id: Tab; label: string }[] = [
    { id: 'all', label: 'All' }, { id: 'captured', label: 'Captured' }, { id: 'reviews', label: 'Reviews' }, { id: 'alerts', label: 'Mentions & alerts' },
  ];

  return (
    <>
      <PageHeader title="Inbox" count={rows.length}
        actions={<Button variant="dark" icon={<CheckCheck size={15} />} disabled={!unreadIn[tab]} onClick={markAllRead}>Mark all read</Button>} />

      <ViewBar
        left={<Segmented<Tab> value={tab} onChange={(v) => { setTab(v); setSelId(null); }} options={tabs.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] }))} />}
        right={
          <>
            {tab === 'reviews' ? (
              halted ? (
                <>
                  <Badge tone="red" dot>Agents halted {halted}</Badge>
                  <Button size="sm" variant="light" icon={<Play size={14} />} onClick={() => { setHalted(null); toast('Agent queue resumed'); }}>Resume</Button>
                </>
              ) : (
                <Button size="sm" variant="danger" icon={<OctagonX size={14} />} disabled={!running.length}
                  title={running.length ? 'Stop every running agent' : 'Nothing running'} onClick={() => setConfirmStop(true)}>Emergency stop</Button>
              )
            ) : null}
            <span className={s.keys}><Kbd>J</Kbd><Kbd>K</Kbd> to move</span>
          </>
        }
      />

      <div className={s.split}>
        {/* ---------- list ---------- */}
        <section className={s.list} aria-label="Inbox items">
          {undo ? (
            <div className={s.undo}>
              <Check size={14} /><span>{undo.text}</span>
              <button onClick={() => { undo.revert(); setSelId(undo.id); setUndo(null); }}><Undo2 size={13} />Undo</button>
              <button className={s.undoX} aria-label="Dismiss" onClick={() => setUndo(null)}><X size={13} /></button>
            </div>
          ) : null}
          {shown.length === 0 ? <TabEmpty tab={tab} onCapture={() => setCapture(true)} onSettings={(h) => router.push(`/app/settings#${h}`)} /> : (
            <div role="listbox" aria-label="Items">
              {shown.map((r) => (
                <button key={r.id} ref={(el) => { rowRefs.current[r.id] = el; }} role="option" aria-selected={sel?.id === r.id}
                  className={cx(s.row, sel?.id === r.id && s.rowOn, r.unread && s.rowUnread)} onClick={() => select(r.id)}>
                  <span className={s.dot} aria-label={r.unread ? 'Unread' : undefined}>{r.unread ? <i /> : null}</span>
                  <RowIcon row={r} captured={captured} alerts={alerts} />
                  {r.brand ? <BrandChip id={r.brand} size={18} /> : <span className={s.noBrand} title="All brands" />}
                  <span className={s.rowTitle}>{r.title}{r.meta ? <em>{r.meta}</em> : null}</span>
                  {r.badge ? <Badge tone={r.badge.tone}>{r.badge.label}</Badge> : null}
                  <span className={s.time}>{fmtAgo(r.min)}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* ---------- detail ---------- */}
        <section className={s.detail} aria-label="Selected item">
          {!sel ? (
            <div className={s.detailEmpty}><InboxIcon size={22} /><span>Select an item to see what it needs</span></div>
          ) : sel.kind === 'captured' ? (
            <CapturedDetail key={sel.id} it={captured.find((c) => c.id === sel.ref)!} min={sel.min}
              onFix={(f) => setFix((x) => ({ ...x, [sel.ref]: { ...x[sel.ref], ...f } }))}
              onKeep={() => { setKeepBoth((k) => ({ ...k, [sel.ref]: true })); toast('Kept as a separate item'); }}
              onOpenDup={(key) => { const t = tasks.find((x) => x.key === key); if (t) openTask(t.id); }}
              onResolve={(text, tone) => resolve(sel.id, text, tone)} />
          ) : sel.kind === 'review' ? (
            <ReviewDetail key={sel.id} r={runs.find((x) => x.id === sel.ref)!} min={sel.min} halted={!!halted}
              task={tasks.find((t) => t.id === runs.find((x) => x.id === sel.ref)?.taskId)}
              onOpenTask={(id) => openTask(id)} onDecide={decide} />
          ) : (
            <AlertDetail key={sel.id} n={alerts.find((n) => n.id === sel.ref)!} min={sel.min}
              onOpen={(c) => { if (c.taskKey) { const t = tasks.find((x) => x.key === c.taskKey); if (t) openTask(t.id); } else if (c.href) router.push(c.href); }}
              onDone={() => resolve(sel.id, 'Marked done')} />
          )}
        </section>
      </div>

      {/* ---------- emergency stop confirm ---------- */}
      {confirmStop ? (
        <div className={s.scrim} onClick={() => setConfirmStop(false)}>
          <div className={s.modal} role="alertdialog" aria-modal="true" aria-labelledby="stop-title" onClick={(e) => e.stopPropagation()}>
            <div className={s.mHead}>
              <span className={s.mIcon}><OctagonX size={22} /></span>
              <IconButton small label="Close" onClick={() => setConfirmStop(false)}><X size={15} /></IconButton>
            </div>
            <h3 id="stop-title" className={s.mTitle}>Stop {running.length} running {running.length === 1 ? 'agent run' : 'agent runs'}?</h3>
            <p className={s.mText}>Work in progress is kept as a draft. Stopped runs can be retried later.</p>
            <div className={s.mList}>
              {running.map((r) => (
                <div key={r.id} className={s.mRow}>
                  <BrandChip id={r.brand} size={20} />
                  <span className={s.mTask}>{r.task}</span>
                  <span className={s.mMute}>{r.agent}</span>
                  <b className={s.num}>{money(r.cost)}</b>
                </div>
              ))}
            </div>
            <label className={s.mOpt}>
              <span>Also pause the queue</span>
              <Toggle on={pauseQueue} label="Pause queue" onChange={() => setPauseQueue((v) => !v)} />
            </label>
            <div className={s.mBtns}>
              <Button variant="light" size="lg" onClick={() => setConfirmStop(false)}>Cancel</Button>
              <Button variant="danger" size="lg" icon={<Square size={13} fill="currentColor" />} onClick={stopAll}>Stop all</Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ---------- list bits ---------- */

type Cap = InboxItem & { low: boolean; ask: 'brand' | 'project' | null; dup: boolean };

function RowIcon({ row, captured, alerts }: { row: Row; captured: Cap[]; alerts: Notice[] }) {
  if (row.kind === 'captured') {
    const it = captured.find((c) => c.id === row.ref);
    const I = it ? srcIcon[it.source] : InboxIcon;
    return <span className={s.icon} title={`Captured · ${row.meta}`}><I size={15} /></span>;
  }
  if (row.kind === 'review') return <span className={cx(s.icon, s.iconAgent)} title="Agent review"><Bot size={15} /></span>;
  const n = alerts.find((x) => x.id === row.ref);
  const I = n ? noticeIcon[n.kind] : AtSign;
  return <span className={cx(s.icon, n?.kind === 'failure' && s.iconBad)} title={row.meta}><I size={15} /></span>;
}

function TabEmpty({ tab, onCapture, onSettings }: { tab: Tab; onCapture: () => void; onSettings: (hash: string) => void }) {
  const copy: Record<Tab, { title: string; why: string; action: ReactNode }> = {
    all: { title: 'Inbox zero', why: 'Nothing is waiting on you. New captures, agent work and mentions land here.', action: <Button variant="dark" icon={<Plus size={15} />} onClick={onCapture}>Capture something</Button> },
    captured: { title: 'Nothing to triage', why: 'Voice notes, emails, forms and GitHub issues you capture arrive here to be filed.', action: <Button variant="dark" icon={<Plus size={15} />} onClick={onCapture}>Capture something</Button> },
    reviews: { title: 'No agent work to review', why: 'When an agent finishes, fails or needs approval, it shows up here.', action: <Button variant="light" icon={<Settings size={15} />} onClick={() => onSettings('agents')}>Agent settings</Button> },
    alerts: { title: 'You are all caught up', why: 'Mentions, deadlines, spend and integration alerts appear here.', action: <Button variant="light" icon={<Settings size={15} />} onClick={() => onSettings('notifications')}>Notification settings</Button> },
  };
  const c = copy[tab];
  return (
    <div className={s.empty}>
      <span className={s.emptyIcon}><Check size={20} /></span>
      <b>{c.title}</b>
      <span>{c.why}</span>
      {c.action}
    </div>
  );
}

function DetailHead({ icon, kind, brand, min, title, extra }: { icon: ReactNode; kind: string; brand: BrandId | null; min: number; title: ReactNode; extra?: ReactNode }) {
  return (
    <header className={s.dHead}>
      <div className={s.dMeta}>
        <span className={s.icon}>{icon}</span>
        <span>{kind}</span>
        <span className={s.dSep}>·</span>
        {brand ? <span className={s.dBrand}><BrandChip id={brand} size={16} />{brandName(brand)}</span> : <span>All brands</span>}
        <span className={s.dSep}>·</span>
        <span>{fmtAgo(min)} ago</span>
        {extra ? <span className={s.dExtra}>{extra}</span> : null}
      </div>
      <h2 className={s.dTitle}>{title}</h2>
    </header>
  );
}

/* ---------- captured ---------- */

function CapturedDetail({ it, min, onFix, onKeep, onOpenDup, onResolve }: {
  it: Cap; min: number; onFix: (f: Fix) => void; onKeep: () => void; onOpenDup: (key: string) => void; onResolve: (text: string, tone?: 'ok' | 'bad') => void;
}) {
  const Icon = srcIcon[it.source];
  const det = it.detected;
  const pr = det.projectId ? projectById(det.projectId) : undefined;
  const fields: { k: string; v: ReactNode; miss?: boolean }[] = [
    { k: 'Type', v: cap(det.type) },
    { k: 'Brand', v: det.brand ? <><BrandChip id={det.brand} size={16} />{brandName(det.brand)}</> : 'Unknown', miss: !det.brand },
    { k: 'Project', v: pr?.name ?? (det.type === 'task' ? 'Unknown' : '—'), miss: !pr && det.type === 'task' },
    { k: 'Due', v: det.due ?? '—' },
    { k: 'Priority', v: det.priority ? <><Priority p={det.priority} />{PRIORITY[det.priority]}</> : '—' },
    { k: 'Estimate', v: det.est ? fmtMin(det.est) : '—' },
    { k: 'Owner', v: det.owner ? <><Avatar id={det.owner} size={18} />{personById(det.owner)?.name}</> : '—' },
  ];
  const isProject = det.type === 'project';

  return (
    <div className={s.dIn}>
      <DetailHead icon={<Icon size={15} />} kind={`Captured · ${srcLabel[it.source]}`} brand={det.brand ?? null} min={min} title={<>&ldquo;{it.raw}&rdquo;</>}
        extra={it.attachments ? <Badge tone="neutral">{it.attachments} files</Badge> : null} />

      {/* the one ink area: what we detected and what to do with it */}
      <div className={s.hero}>
        <span className={s.heroCap}>Detected {it.confidence === 'high' ? <Badge tone="green">Sure</Badge> : <Badge tone="amber">Check</Badge>}</span>
        <dl className={s.fields}>
          {fields.map((f) => (
            <div key={f.k} className={s.fieldRow}><dt>{f.k}</dt><dd className={f.miss ? s.miss : undefined}>{f.v}</dd></div>
          ))}
        </dl>

        {it.low ? (
          <div className={s.ask}>
            <span className={s.askQ}>{it.ask === 'brand' ? 'Which brand is this for?' : 'Which project?'}</span>
            <div className={s.pills}>
              {it.ask === 'brand'
                ? brands.map((b) => <button key={b.id} onClick={() => onFix({ brand: b.id })}><BrandChip id={b.id} size={16} />{b.name}</button>)
                : projects.filter((p) => p.brand === det.brand).map((p) => <button key={p.id} onClick={() => onFix({ projectId: p.id })}>{p.name}</button>)}
            </div>
          </div>
        ) : null}

        {it.dup ? (
          <div className={s.ask}>
            <span className={s.askQ}><GitMerge size={14} />Looks like <button className={s.link} onClick={() => onOpenDup(it.duplicateOf!)}>{it.duplicateOf}</button></span>
            <div className={s.pills}>
              <button className={s.pillAccent} onClick={() => onResolve(`Merged into ${it.duplicateOf}`)}><GitMerge size={14} />Merge into {it.duplicateOf}</button>
              <button onClick={onKeep}>Keep both</button>
            </div>
          </div>
        ) : null}

        <div className={s.heroActs}>
          {isProject ? (
            <button className={s.hAccent} disabled={!det.brand} title={!det.brand ? 'Pick a brand first' : undefined} onClick={() => onResolve('Project created')}><FolderPlus size={15} />Create project</button>
          ) : (
            <button className={s.hAccent} disabled={it.low} title={it.low ? 'Answer the question above first' : undefined} onClick={() => onResolve(`Task created${pr ? ` in ${pr.name}` : ''}`)}><ListTodo size={15} />Create task</button>
          )}
          <button className={s.hBtn} onClick={() => onResolve('Saved as a note')}><FileText size={15} />Note</button>
          <button className={cx(s.hBtn, s.hDanger)} onClick={() => onResolve('Discarded', 'bad')}><Trash2 size={15} />Discard</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- agent review ---------- */

function StepIcon({ kind }: { kind: Step['kind'] }) {
  if (kind === 'ok') return <span className={cx(s.sDot, s.sOk)}><Check size={11} strokeWidth={3} /></span>;
  if (kind === 'fail') return <span className={cx(s.sDot, s.sFail)}><X size={11} strokeWidth={3} /></span>;
  if (kind === 'wait') return <span className={cx(s.sDot, s.sWait)}><Hourglass size={11} strokeWidth={2.6} /></span>;
  return <span className={cx(s.sDot, s.sRun)}><i className="anim-ping" /><i /></span>;
}

function ReviewDetail({ r, task, min, halted, onOpenTask, onDecide }: {
  r: AgentRun; task?: WorkItem; min: number; halted: boolean; onOpenTask: (id: string) => void;
  onDecide: (r: AgentRun, state: RunState, text: string, patch: Partial<WorkItem>, tone?: 'ok' | 'bad') => void;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const checksPass = r.deliverable?.ci === 'pass';
  const acceptance = task?.acceptance ?? [];
  const m = STATE_META[r.state];

  return (
    <div className={s.dIn}>
      <DetailHead icon={<Bot size={15} />} kind={`Agent · ${r.agent}`} brand={r.brand} min={min} title={r.task} extra={<Badge tone={m.tone} dot>{m.label}</Badge>} />

      <div className={s.facts}>
        <span><em>Cost</em><b>{money(r.cost)}</b></span>
        <span><em>Time</em><b>{r.mins}m</b></span>
        <span><em>Tokens</em><b>{kTok(r.tokens)}</b></span>
        <span><em>Model</em><b>{r.model}</b></span>
      </div>

      {/* the one ink area: the decision */}
      <div className={s.hero}>
        {r.state === 'review' ? (
          <>
            <span className={s.heroCap}>Your review</span>
            {acceptance.length ? (
              <div className={s.checks}>
                <span className={s.checksHead}>Acceptance checks · {checksPass ? acceptance.length : 0} of {acceptance.length} pass</span>
                {acceptance.map((a) => (
                  <span key={a} className={checksPass ? s.checkOk : s.checkPend}>{checksPass ? <Check size={12} strokeWidth={3} /> : <i />}{a}</span>
                ))}
              </div>
            ) : <span className={s.heroText}>No acceptance checks on this task. Review the deliverable below.</span>}
            {r.changes.length ? (
              <div className={s.applies}>
                <span className={s.checksHead}>Accepting also applies</span>
                {r.changes.map((c) => <span key={c.id} className={s.apply}><b>{c.kind}</b>{c.label}<em>{c.target}</em></span>)}
              </div>
            ) : null}
            {noteOpen ? (
              <form className={s.noteRow} onSubmit={(e) => { e.preventDefault(); if (note.trim()) onDecide(r, 'changes', `Changes requested · ${r.agent}`, { deliverable: 'changes', status: 'doing' }); }}>
                <input autoFocus className={s.noteIn} placeholder="What should change?" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Requested changes" />
                <button type="submit" className={s.hAccent} disabled={!note.trim()}><Send size={14} />Send</button>
                <button type="button" className={s.hBtn} onClick={() => setNoteOpen(false)}>Cancel</button>
              </form>
            ) : (
              <div className={s.heroActs}>
                <button className={s.hAccent} onClick={() => onDecide(r, 'accepted', `${r.task} accepted`, { deliverable: 'accepted', status: 'done' })}><Check size={16} strokeWidth={2.6} />Accept</button>
                <button className={s.hBtn} onClick={() => setNoteOpen(true)}><MessageSquare size={15} />Request changes</button>
                <button className={cx(s.hBtn, s.hDanger)} onClick={() => onDecide(r, 'rejected', `${r.task} rejected`, { deliverable: 'rejected' }, 'bad')}><Ban size={15} />Reject</button>
              </div>
            )}
          </>
        ) : r.state === 'failed' ? (
          <>
            <span className={s.heroCap}>Run failed</span>
            <span className={s.heroErr}><CircleAlert size={15} />{r.error ?? 'The run stopped with an error.'}</span>
            <div className={s.heroActs}>
              <button className={s.hAccent} disabled={halted} title={halted ? 'Agents are halted' : undefined} onClick={() => onDecide(r, 'queued', `${r.task} re-queued`, {})}><RotateCcw size={15} />Retry</button>
              <button className={s.hBtn} onClick={() => onOpenTask(r.taskId)}>Open task</button>
              <button className={s.hBtn} onClick={() => onDecide(r, 'stopped', 'Dismissed', {})}>Dismiss</button>
            </div>
          </>
        ) : r.state === 'waiting' ? (
          <>
            <span className={s.heroCap}>Needs your approval</span>
            <span className={s.heroText}>{r.changes[0]?.label ?? 'The agent wants to act outside its sandbox.'}{r.changes[0] ? <em> · {r.changes[0].target}</em> : null}</span>
            <div className={s.heroActs}>
              <button className={s.hAccent} onClick={() => onDecide(r, 'review', 'Approved · now ready for review', {})}><Check size={16} strokeWidth={2.6} />Approve</button>
              <button className={cx(s.hBtn, s.hDanger)} onClick={() => onDecide(r, 'stopped', 'Approval denied', {}, 'bad')}><X size={15} />Deny</button>
            </div>
          </>
        ) : (
          <>
            <span className={s.heroCap}>Running · {Math.round(r.progress * 100)}%</span>
            <div className={s.prog}><div className="anim-grow-x" style={{ width: `${r.progress * 100}%` }} /></div>
            <span className={s.heroText}>You will get a review here when it finishes.</span>
            <div className={s.heroActs}>
              <button className={cx(s.hBtn, s.hDanger)} onClick={() => onDecide(r, 'stopped', `${r.task} stopped`, {}, 'bad')}><Square size={12} fill="currentColor" />Stop run</button>
            </div>
          </>
        )}
      </div>

      {r.deliverable ? (
        <div className={s.panel}>
          <div className={s.panelHead}>
            <span>{r.deliverable.kind === 'PR' ? <GitPullRequest size={15} /> : <FileDiff size={15} />}Deliverable</span>
            {r.deliverable.ci ? <Badge tone={r.deliverable.ci === 'pass' ? 'green' : r.deliverable.ci === 'fail' ? 'red' : 'accent'} dot>CI {r.deliverable.ci === 'pass' ? 'pass' : r.deliverable.ci === 'fail' ? 'fail' : 'running'}</Badge> : null}
          </div>
          <div className={s.deliv}>
            <b>{r.deliverable.kind === 'PR' ? `PR ${r.deliverable.ref}` : r.deliverable.ref}</b>
            {r.deliverable.plus !== undefined ? <span className={s.diffStat}><em className={s.plus}>+{r.deliverable.plus}</em><em className={s.minus}>−{r.deliverable.minus}</em>{r.deliverable.files} files</span> : null}
            {task ? <Button size="sm" variant="light" onClick={() => onOpenTask(task.id)}>Open {task.key}</Button> : null}
          </div>
          {r.diff ? (
            <div className={s.diff}>
              <div className={s.diffHead}>{r.diff.file}</div>
              {r.diff.lines.map((l, i) => (
                <div key={i} className={l.sign === '+' ? s.dAdd : l.sign === '-' ? s.dDel : s.dCtx}>
                  <span className={s.dN}>{l.n}</span><span>{l.sign}</span><code>{l.code}</code>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className={s.panel}>
        <div className={s.panelHead}><span><ListChecks size={15} />Step log</span><span className={s.mute}>{r.steps.length} steps · started {r.started}</span></div>
        <ol className={s.steps}>
          {r.steps.map((st, i) => (
            <li key={i}>
              <span className={s.stepT}>{st.t}</span>
              <StepIcon kind={st.kind} />
              <span className={st.kind === 'fail' ? s.stepBad : undefined}>{st.label}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/* ---------- mention / alert ---------- */

function AlertDetail({ n, min, onOpen, onDone }: { n: Notice; min: number; onOpen: (c: (typeof NOTICE_CTX)[string]['open']) => void; onDone: () => void }) {
  const I = noticeIcon[n.kind];
  const ctx = NOTICE_CTX[n.id] ?? { body: n.text, open: { label: 'Open' } };
  return (
    <div className={s.dIn}>
      <DetailHead icon={<I size={15} />} kind={noticeLabel[n.kind]} brand={n.brand} min={min} title={n.text} />
      <div className={s.hero}>
        <span className={s.heroCap}>{n.kind === 'mention' ? 'Mentioned you' : 'What happened'}</span>
        {ctx.quote && ctx.who ? (
          <div className={s.quote}>
            <Avatar id={ctx.who} size={28} />
            <span><b>{personById(ctx.who)?.name}</b><span>{ctx.quote}</span></span>
          </div>
        ) : null}
        <span className={s.heroText}>{ctx.body}</span>
        <div className={s.heroActs}>
          {ctx.open.taskKey || ctx.open.href ? <button className={s.hAccent} onClick={() => onOpen(ctx.open)}>{ctx.open.label}</button> : null}
          <button className={s.hBtn} onClick={onDone}><Check size={15} />Mark done</button>
        </div>
      </div>
    </div>
  );
}

