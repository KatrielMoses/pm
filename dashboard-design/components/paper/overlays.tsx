'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowRight, AtSign, Bell, Bot, Calendar, Check, CheckCheck, CircleAlert, CircleDollarSign, Clock, CornerDownLeft, FileText, Flag,
  FolderKanban, GitPullRequest, Hash, Link2, Lock, Mic, Moon, Paperclip, Pause, Play, Plus, Repeat, Search, Send, Sparkles, Square, Timer, X, Zap,
} from 'lucide-react';
import { useApp } from '@/lib/app-state';
import { useWorkspace } from '@/lib/workspace';
import { brands, brandName, type BrandId } from '@/lib/data';
import {
  activity, docs, dueLabel, fmtMin, notifications, PRIORITY, projectById, projects, proposedChanges, STATUSES, type Status,
} from '@/lib/app-data';
import { BrandChip } from '@/components/brand';
import { FOOTER_NAV, NAV } from './Shell';
import { Avatar, Badge, Button, Checkbox, IconButton, Kbd, Priority, Segmented, Source, StatusBadge } from './ui';
import o from './overlays.module.css';

export function Overlays() {
  const { taskId, capture, palette, panel, toasts } = useApp();
  return (
    <>
      {palette ? <Palette /> : null}
      {capture ? <Capture /> : null}
      {taskId ? <TaskDrawer id={taskId} /> : null}
      {panel === 'notifications' ? <Notifications /> : null}
      {panel === 'ai' ? <AiPanel /> : null}
      <div className={o.toasts} aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`${o.toast} ${t.tone === 'bad' ? o.toastBad : ''}`}>{t.tone === 'bad' ? <CircleAlert size={15} /> : <Check size={15} />}{t.text}</div>)}
      </div>
    </>
  );
}

function useEsc(fn: () => void) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && fn();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [fn]);
}

/* ================= command palette ================= */

type Cmd = { id: string; group: string; label: string; hint?: string; icon: ReactNode; run: () => void };

function Palette() {
  const router = useRouter();
  const { setPalette, setCapture, openTask, setMode, mode, tasks, setPanel } = useApp();
  const { setBrand } = useWorkspace();
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const close = () => setPalette(false);
  useEsc(close);

  const all: Cmd[] = useMemo(() => [
    { id: 'a-cap', group: 'Actions', label: 'Capture task', hint: 'C', icon: <Plus size={16} />, run: () => setCapture(true) },
    { id: 'a-ai', group: 'Actions', label: 'Ask AI', icon: <Sparkles size={16} />, run: () => setPanel('ai') },
    { id: 'a-plan', group: 'Actions', label: 'Plan my day', icon: <Zap size={16} />, run: () => router.push('/app?plan=1') },
    { id: 'a-theme', group: 'Actions', label: mode === 'light' ? 'Dark mode' : 'Light mode', icon: <Moon size={16} />, run: () => setMode(mode === 'light' ? 'dark' : 'light') },
    { id: 'b-all', group: 'Brand', label: 'All brands', icon: <span className={o.dotAll} />, run: () => setBrand(null) },
    ...brands.map((b) => ({ id: 'b-' + b.id, group: 'Brand', label: b.name, icon: <BrandChip id={b.id} size={18} />, run: () => setBrand(b.id) })),
    ...[...NAV, ...FOOTER_NAV].map((n) => ({ id: 'n-' + n.href, group: 'Go to', label: n.label, hint: n.keys, icon: <n.icon size={16} />, run: () => router.push(n.href) })),
    ...projects.map((p) => ({ id: 'p-' + p.id, group: 'Projects', label: p.name, hint: brandName(p.brand), icon: <BrandChip id={p.brand} size={18} />, run: () => router.push(`/app/projects/${p.id}`) })),
    ...tasks.map((t) => ({ id: 't-' + t.id, group: 'Tasks', label: t.title, hint: t.key, icon: <BrandChip id={t.brand} size={18} />, run: () => openTask(t.id) })),
    ...docs.map((d) => ({ id: 'd-' + d.id, group: 'Docs', label: d.title, hint: d.type, icon: <FileText size={16} />, run: () => router.push('/app/docs') })),
  ], [router, setCapture, setPanel, mode, setMode, setBrand, tasks, openTask]);

  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    const r = t ? all.filter((c) => (c.label + ' ' + (c.hint ?? '') + ' ' + c.group).toLowerCase().includes(t)) : all.filter((c) => c.group !== 'Tasks' && c.group !== 'Docs' && c.group !== 'Projects').concat(all.filter((c) => c.group === 'Tasks').slice(0, 4));
    return r.slice(0, 40);
  }, [q, all]);

  const runAt = (k: number) => { const c = list[k]; if (c) { close(); c.run(); } };
  let lastGroup = '';

  return (
    <div className={o.scrim} onMouseDown={close}>
      <div className={o.palette} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <div className={o.palIn}>
          <Search size={18} />
          <input autoFocus value={q} placeholder="Search or jump to…" onChange={(e) => { setQ(e.target.value); setI(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setI((v) => Math.min(list.length - 1, v + 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setI((v) => Math.max(0, v - 1)); }
              if (e.key === 'Enter') runAt(i);
            }} />
          <Kbd>Esc</Kbd>
        </div>
        <div className={o.palList}>
          {list.length === 0 ? <div className={o.palEmpty}>No results</div> : null}
          {list.map((c, k) => {
            const head = c.group !== lastGroup ? (lastGroup = c.group) : null;
            return (
              <div key={c.id}>
                {head ? <div className={o.palGroup}>{head}</div> : null}
                <button className={k === i ? o.palOn : o.palItem} onMouseEnter={() => setI(k)} onClick={() => runAt(k)}>
                  <span className={o.palIcon}>{c.icon}</span>
                  <span className={o.palLabel}>{c.label}</span>
                  {c.hint ? <span className={o.palHint}>{c.hint}</span> : null}
                  {k === i ? <CornerDownLeft size={14} className={o.palEnter} /> : null}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ================= quick capture ================= */

type Parsed = { title: string; brand?: BrandId; project?: string; due?: string; priority?: 1 | 2 | 3 | 4; est?: string; recur?: string; owner?: string; labels: string[] };

function parse(line: string): Parsed {
  const l = line.toLowerCase();
  const p: Parsed = { title: line.trim(), labels: [] };
  if (/mailaccess|\bma\b/.test(l)) p.brand = 'ma';
  else if (/api ?access|\bax\b/.test(l)) p.brand = 'ax';
  else if (/optestra|\bop\b/.test(l)) p.brand = 'op';
  const proj = projects.find((x) => l.includes(x.name.toLowerCase()) || l.includes(x.name.toLowerCase().split(' ')[0]));
  if (proj) { p.project = proj.name; p.brand = p.brand ?? proj.brand; }
  const day = l.match(/\b(today|tomorrow|mon(day)?|tue(sday)?|wed(nesday)?|thu(rsday)?|fri(day)?|sat(urday)?|sun(day)?)\b/);
  if (day) p.due = day[1][0].toUpperCase() + day[1].slice(1, 3) + (day[1].length <= 3 || day[1] === 'today' ? '' : '');
  if (day && day[1] === 'today') p.due = 'Today';
  if (day && day[1] === 'tomorrow') p.due = 'Tomorrow';
  if (/urgent|asap|!!/.test(l)) p.priority = 1; else if (/\bhigh\b|important/.test(l)) p.priority = 2; else if (/\blow\b/.test(l)) p.priority = 4;
  const est = l.match(/\b(\d+)\s?(m|min|mins|h|hr|hrs|hours?)\b/);
  if (est) p.est = est[2].startsWith('h') ? `${est[1]}h` : `${est[1]}m`;
  const rec = l.match(/every (day|week|monday|tuesday|wednesday|thursday|friday|month)/);
  if (rec) p.recur = 'Every ' + rec[1];
  const at = line.match(/@(\w+)/);
  if (at) p.owner = at[1];
  p.labels = [...line.matchAll(/#(\w+)/g)].map((m) => m[1]);
  return p;
}

function Capture() {
  const { setCapture, toast } = useApp();
  const { brand } = useWorkspace();
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'task' | 'note'>('task');
  const [listening, setListening] = useState(false);
  const close = () => setCapture(false);
  useEsc(close);
  const lines = text.split('\n').map((x) => x.trim()).filter(Boolean);
  const parsed = lines.map(parse);
  const first = parsed[0];
  const ambiguous = !!first && !first.brand && !brand;

  const save = (inbox: boolean) => {
    if (!lines.length) return;
    close();
    toast(lines.length > 1 ? `${lines.length} ${mode}s ${inbox ? 'sent to Inbox' : 'created'}` : `${mode === 'task' ? 'Task' : 'Note'} ${inbox ? 'sent to Inbox' : 'created'}`);
  };

  return (
    <div className={o.scrim} onMouseDown={close}>
      <div className={o.capture} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Capture">
        <div className={o.capHead}>
          <Segmented sub size="sm" value={mode} onChange={setMode} options={[{ id: 'task', label: 'Task' }, { id: 'note', label: 'Note' }]} />
          <span className={o.capScope}>{brand ? <><BrandChip id={brand} size={18} /> {brandName(brand)}</> : <>Any brand</>}</span>
          <IconButton label="Close" small onClick={close}><X size={16} /></IconButton>
        </div>
        <textarea autoFocus className={o.capText} value={text} onChange={(e) => setText(e.target.value)} rows={3}
          placeholder="Fix rate limit on MailAccess v2 by Friday, urgent, 1h #api"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save(false); }} />
        {listening ? (
          <div className={o.wave} aria-label="Listening">{Array.from({ length: 28 }, (_, k) => <i key={k} style={{ animationDelay: `${k * 40}ms` }} />)}</div>
        ) : null}
        {first ? (
          <div className={o.chips}>
            {first.brand ? <span className={o.chip}><BrandChip id={first.brand} size={16} />{brandName(first.brand)}</span> : <span className={`${o.chip} ${o.chipAsk}`}><CircleAlert size={13} />Brand?</span>}
            {first.project ? <span className={o.chip}><FolderKanban size={13} />{first.project}</span> : null}
            {first.due ? <span className={o.chip}><Calendar size={13} />{first.due}</span> : null}
            {first.priority ? <span className={o.chip}><Priority p={first.priority} />{PRIORITY[first.priority]}</span> : null}
            {first.est ? <span className={o.chip}><Clock size={13} />{first.est}</span> : null}
            {first.recur ? <span className={o.chip}><Repeat size={13} />{first.recur}</span> : null}
            {first.owner ? <span className={o.chip}><AtSign size={13} />{first.owner}</span> : null}
            {first.labels.map((lb) => <span key={lb} className={o.chip}><Hash size={13} />{lb}</span>)}
            {lines.length > 1 ? <span className={`${o.chip} ${o.chipDark}`}>+{lines.length - 1} more</span> : null}
          </div>
        ) : null}
        <div className={o.capFoot}>
          <div className={o.row}>
            <IconButton label={listening ? 'Stop' : 'Voice'} onClick={() => setListening((v) => !v)} style={listening ? { background: 'var(--red)', color: '#fff' } : undefined}>{listening ? <Square size={14} /> : <Mic size={17} />}</IconButton>
            <IconButton label="Attach"><Paperclip size={17} /></IconButton>
            <IconButton label="Link"><Link2 size={17} /></IconButton>
          </div>
          <div className={o.row}>
            <Button variant="light" onClick={() => save(true)} icon={<Bell size={15} />}>Inbox</Button>
            <Button variant="dark" onClick={() => save(false)} disabled={ambiguous || !lines.length} title={ambiguous ? 'Pick a brand or send to Inbox' : undefined}>
              Create <Kbd>⌘↵</Kbd>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================= task drawer ================= */

function TaskDrawer({ id }: { id: string }) {
  const { tasks, updateTask, openTask, toast, timer, setTimer } = useApp();
  const t = tasks.find((x) => x.id === id);
  const [checks, setChecks] = useState<boolean[]>([]);
  const [comment, setComment] = useState('');
  const [tick, setTick] = useState(0);
  useEsc(() => openTask(null));
  useEffect(() => { if (t) setChecks((t.acceptance ?? []).map((_, k) => k < (t.status === 'done' ? 99 : 1))); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const running = timer?.taskId === id;
  useEffect(() => { if (!running) return; const iv = setInterval(() => setTick((v) => v + 1), 1000); return () => clearInterval(iv); }, [running]);
  if (!t) return null;
  const proj = projectById(t.projectId);
  const elapsed = running ? Math.floor((Date.now() - timer!.since) / 1000) + tick * 0 : 0;
  const logged = t.logged + Math.floor(elapsed / 60);
  const missing = [!t.due && 'due date', !t.acceptance?.length && 'acceptance', t.est === 0 && 'estimate'].filter(Boolean) as string[];

  return (
    <div className={o.drawerScrim} onMouseDown={() => openTask(null)}>
      <aside className={o.drawer} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={t.title}>
        <div className={o.dHead}>
          <BrandChip id={t.brand} size={26} />
          <span className={o.dKey}>{t.key}</span>
          <span className={o.dCrumb}>{proj?.name}</span>
          <span className={o.grow} />
          <IconButton label="Close" small onClick={() => openTask(null)}><X size={17} /></IconButton>
        </div>
        <h2 className={o.dTitle}>{t.title}</h2>

        <div className={o.statusRow}>
          {STATUSES.map((st) => (
            <button key={st.id} className={t.status === st.id ? o.stOn : o.st} onClick={() => { updateTask(t.id, { status: st.id as Status }); toast(`Moved to ${st.label}`); }}>{st.label}</button>
          ))}
        </div>

        {missing.length ? <div className={o.warn}><CircleAlert size={15} /> Missing {missing.join(', ')}</div> : null}
        {t.blockedBy ? <div className={o.warnRed}><Lock size={15} /> Blocked by {t.blockedBy}</div> : null}

        <div className={o.props}>
          <span>Assignee</span><span className={o.row}><Avatar id={t.assignee} size={22} />{t.assignee.startsWith('ag-') ? 'Agent' : ''}</span>
          <span>Due</span><span className={o.row}><Calendar size={14} />{dueLabel(t.due)}</span>
          <span>Priority</span><span className={o.row}><Priority p={t.priority} />{PRIORITY[t.priority]}</span>
          <span>Time</span>
          <span className={o.row}>
            <b className="tnum">{fmtMin(logged)}</b><span className={o.mute}>/ {fmtMin(t.est)}</span>
            <button className={running ? o.timerOn : o.timer} onClick={() => setTimer(running ? null : { taskId: id, since: Date.now() })}>
              {running ? <><Pause size={12} /> {String(Math.floor(elapsed / 60)).padStart(2, '0')}:{String(elapsed % 60).padStart(2, '0')}</> : <><Play size={12} /> Start</>}
            </button>
          </span>
          {t.milestone ? <><span>Milestone</span><span className={o.row}><Flag size={14} />{t.milestone}</span></> : null}
          <span>Source</span><span className={o.row}><Badge tone="outline">{t.source}</Badge></span>
          {t.labels.length ? <><span>Labels</span><span className={o.row}>{t.labels.map((l) => <Badge key={l} tone="neutral">#{l}</Badge>)}</span></> : null}
          {t.pr ? <><span>Code</span><span className={o.row}><GitPullRequest size={14} />{t.pr}{t.ci ? <Badge tone={t.ci === 'pass' ? 'green' : t.ci === 'fail' ? 'red' : 'amber'} dot>CI {t.ci}</Badge> : null}</span></> : null}
        </div>

        {t.acceptance?.length ? (
          <section className={o.sec}>
            <div className={o.secHead}>Acceptance <span className={o.mute}>{checks.filter(Boolean).length}/{t.acceptance.length}</span></div>
            {t.acceptance.map((a, k) => (
              <label key={a} className={o.check}>
                <Checkbox on={!!checks[k]} onChange={() => setChecks((c) => c.map((v, j) => (j === k ? !v : v)))} label={a} />
                <span className={checks[k] ? o.struck : undefined}>{a}</span>
              </label>
            ))}
          </section>
        ) : null}

        {t.deliverable ? (
          <section className={o.deliver}>
            <div className={o.row}>
              <span className={o.delIcon}><FileText size={16} /></span>
              <div className={o.grow}><b>Deliverable</b><div className={o.mute}>{t.pr ? `PR ${t.pr}` : 'Attachment'}</div></div>
              <Badge tone={t.deliverable === 'accepted' ? 'green' : t.deliverable === 'changes' ? 'amber' : t.deliverable === 'rejected' ? 'red' : 'blue'} dot>
                {{ draft: 'Draft', ready: 'Ready for review', changes: 'Changes asked', accepted: 'Accepted', rejected: 'Rejected' }[t.deliverable]}
              </Badge>
            </div>
            {t.deliverable === 'ready' ? (
              <div className={o.row}>
                <Button variant="dark" size="sm" icon={<Check size={14} />} onClick={() => { updateTask(t.id, { deliverable: 'accepted', status: 'done' }); toast('Accepted'); }}
                  disabled={checks.some((c) => !c)} title={checks.some((c) => !c) ? 'Check every criterion first' : undefined}>Accept</Button>
                <Button variant="light" size="sm" onClick={() => { updateTask(t.id, { deliverable: 'changes', status: 'doing' }); toast('Changes requested'); }}>Request changes</Button>
              </div>
            ) : null}
          </section>
        ) : null}

        <section className={o.sec}>
          <div className={o.secHead}>Subtasks <span className={o.mute}>{t.subtasks[0]}/{t.subtasks[1]}</span></div>
          <div className={o.subBar}>{Array.from({ length: t.subtasks[1] }, (_, k) => <i key={k} className={k < t.subtasks[0] ? o.subOn : undefined} />)}</div>
        </section>

        <div className={o.aiRow}>
          <span className={o.aiScope}><Sparkles size={13} /> <BrandChip id={t.brand} size={14} /> {t.key}</span>
          <button>Improve</button><button>Split</button><button>Estimate</button><button>Criteria</button>
        </div>

        <section className={o.sec}>
          <div className={o.secHead}>Activity</div>
          <div className={o.thread}>
            <div className={o.msg}><Avatar id="dp" size={26} /><div><b>Dev Patel</b> <span className={o.mute}>1h</span><p>Emulator image bump should unblock this.</p></div></div>
            <div className={o.sys}><Bot size={13} /> Dev agent linked {t.pr ?? 'a branch'} · 14m</div>
          </div>
          <div className={o.composer}>
            <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Comment, @mention" onKeyDown={(e) => { if (e.key === 'Enter' && comment) { setComment(''); toast('Comment added'); } }} />
            <IconButton label="Send" small onClick={() => { if (comment) { setComment(''); toast('Comment added'); } }}><Send size={15} /></IconButton>
          </div>
        </section>
      </aside>
    </div>
  );
}

/* ================= notifications ================= */

const noticeIcon = { mention: AtSign, review: CheckCheck, failure: CircleAlert, deadline: Clock, approval: Flag, spend: CircleDollarSign, assign: Plus } as const;

function Notifications() {
  const { setPanel } = useApp();
  const { brand } = useWorkspace();
  const [tab, setTab] = useState<'all' | 'unread'>('unread');
  const [read, setRead] = useState<string[]>([]);
  useEsc(() => setPanel(null));
  const list = notifications.filter((n) => (!brand || n.brand === brand || n.brand === null) && (tab === 'all' || (!n.read && !read.includes(n.id))));
  return (
    <div className={o.popScrim} onMouseDown={() => setPanel(null)}>
      <div className={o.pop} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Notifications">
        <div className={o.popHead}>
          <b>Notifications</b>
          <Segmented sub size="sm" value={tab} onChange={setTab} options={[{ id: 'unread', label: 'Unread' }, { id: 'all', label: 'All' }]} />
        </div>
        <div className={o.popList}>
          {list.length === 0 ? <div className={o.palEmpty}><CheckCheck size={18} /> All caught up</div> : null}
          {list.map((n) => {
            const I = noticeIcon[n.kind];
            const unread = !n.read && !read.includes(n.id);
            return (
              <button key={n.id} className={o.notice} onClick={() => setRead((r) => [...r, n.id])}>
                <span className={`${o.nIcon} ${n.kind === 'failure' ? o.nBad : ''}`}><I size={15} /></span>
                <span className={o.grow}><span className={o.nText}>{n.text}</span><span className={o.nMeta}>{n.brand ? <BrandChip id={n.brand} size={14} /> : null}{n.time}</span></span>
                {unread ? <i className={o.unreadDot} /> : null}
              </button>
            );
          })}
        </div>
        <div className={o.popFoot}><button onClick={() => setRead(notifications.map((n) => n.id))}>Mark all read</button></div>
      </div>
    </div>
  );
}

/* ================= AI panel ================= */

function AiPanel() {
  const { setPanel, toast } = useApp();
  const { brand, s } = useWorkspace();
  const [picked, setPicked] = useState<string[]>(proposedChanges.map((c) => c.id));
  const [q, setQ] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  useEsc(() => setPanel(null));
  const scope = brand ? brandName(brand) : 'All brands';

  return (
    <div className={o.drawerScrim} onMouseDown={() => setPanel(null)}>
      <aside className={o.drawer} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="AI assistant">
        <div className={o.dHead}>
          <span className={o.aiMark}><Sparkles size={16} /></span>
          <b className={o.grow}>Assistant</b>
          <span className={o.cost}>${(s.ai.cap - s.ai.spent).toFixed(2)} left</span>
          <IconButton label="Close" small onClick={() => setPanel(null)}><X size={17} /></IconButton>
        </div>
        <div className={o.scopeBar}>
          <span className={o.scopeChip}>{brand ? <BrandChip id={brand} size={16} /> : <span className={o.dotAll} />}{scope}</span>
          <span className={o.scopeChip}><FolderKanban size={13} /> {s.active} projects</span>
          <span className={o.scopeChip}><FileText size={13} /> 6 approved docs</span>
          <button className={o.scopeEdit}>Edit scope</button>
        </div>

        <div className={o.chat}>
          <div className={o.ask}>What should I postpone today?</div>
          <div className={o.answer}>
            <p><Badge tone="red">Fact</Badge> You have <b>{s.committed.toFixed(1)}h</b> committed and <b>{s.available}h</b> free. <Source>Calendar</Source> <Source>Today</Source></p>
            <p><Badge tone="blue">Calc</Badge> Over by <b>{s.over.toFixed(1)}h</b>.</p>
            <p><Badge tone="accent">Suggest</Badge> Move <b>Credits page copy</b> to Thu and <b>Portal auth spike</b> to Fri. Both are low priority and not blocking. <Source>OP-230</Source> <Source>AX-90</Source></p>
            <p><Badge tone="neutral">Unknown</Badge> Customer call length is not set.</p>
          </div>
          <div className={o.changes}>
            <div className={o.secHead}>Proposed changes <span className={o.mute}>{picked.length}/{proposedChanges.length}</span></div>
            {proposedChanges.map((c) => (
              <label key={c.id} className={o.change}>
                <Checkbox on={picked.includes(c.id)} onChange={() => setPicked((p) => (p.includes(c.id) ? p.filter((x) => x !== c.id) : [...p, c.id]))} label={c.label} />
                <Badge tone={c.kind === 'create' ? 'green' : c.kind === 'update' ? 'amber' : 'blue'}>{c.kind}</Badge>
                <span className={o.grow}><span className={o.cLabel}>{c.label}</span><span className={o.mute}>{c.target}</span></span>
              </label>
            ))}
            <div className={o.row}>
              <Button variant="dark" size="sm" icon={<Check size={14} />} disabled={!picked.length} onClick={() => { toast(`Applied ${picked.length} changes`); setPicked([]); }}>Apply {picked.length}</Button>
              <Button variant="light" size="sm" onClick={() => setPicked([])}>Reject all</Button>
            </div>
          </div>
          <div ref={endRef} />
        </div>

        <div className={o.prompts}>
          {['Brief me', 'What is blocked?', 'Draft v1.4 notes', 'Plan my week'].map((p) => <button key={p} onClick={() => setQ(p)}>{p}</button>)}
        </div>
        <div className={o.composer}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Ask about ${scope}`} />
          <span className={o.mute} style={{ fontSize: 11 }}>~$0.02</span>
          <IconButton label="Send" small onClick={() => { if (q) { setQ(''); toast('Asked'); } }}><ArrowRight size={15} /></IconButton>
        </div>
      </aside>
    </div>
  );
}

/* re-export for pages that want a recent-activity list */
export { activity };
