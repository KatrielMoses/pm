'use client';

/* Project detail tabs: Overview, Tasks (List + Timeline; Board lives in board.tsx), Docs, Activity. */

import Link from 'next/link';
import { Fragment, useState, type CSSProperties } from 'react';
import {
  ArrowUpRight, Bot, Check, ChevronDown, CircleHelp, FileText, Flag, OctagonAlert, Plug, ShieldAlert, ShieldCheck, Sparkles, User, Workflow,
} from 'lucide-react';
import { useApp } from '@/lib/app-state';
import { docs as allDocs, personById, type Status, type WorkItem } from '@/lib/app-data';
import { brandName, type Project } from '@/lib/data';
import { Avatar, Badge, Button, Card, Empty, HealthBadge, Priority, Source, Stat, StatusBadge, u } from '@/components/paper/ui';
import { dayLabel, dueDay, isWeekend, NOW_DAY, projectActivity, taskSpan, weekday, type ProjectMeta } from '../_lib/meta';
import { SC, progressOf, statusLabel } from './board';
import { isLate, TaskChips, TaskDue, TaskTags } from './task-bits';
import s from './detail.module.css';

const levelTone = { high: 'red', med: 'amber', low: 'neutral' } as const;
const levelText = { high: 'High', med: 'Medium', low: 'Low' } as const;

/* ======================= Overview ======================= */

export function Overview({ p, m, tasks, goTasks }: { p: Project; m: ProjectMeta; tasks: WorkItem[]; goTasks: () => void }) {
  const { openTask, toast } = useApp();
  const [questions, setQuestions] = useState(m.questions);
  const [decided, setDecided] = useState(m.decisions);

  const due = dueDay(p);
  const next = m.milestones.find((ms) => ms.day + 1 > NOW_DAY);
  const over = p.hoursActual - p.hoursPlanned;
  const author = personById(m.update.by);
  const attention = tasks
    .filter((t) => t.status === 'blocked' || isLate(t))
    .sort((a, b) => (a.status === 'blocked' ? 0 : 1) - (b.status === 'blocked' ? 0 : 1) || a.priority - b.priority);

  const steps = [...m.milestones].sort((a, b) => a.day - b.day);
  if (!steps.some((x) => x.day === due)) steps.push({ id: 'due', label: 'Project due', day: due });
  const nextId = steps.find((x) => x.day + 1 > NOW_DAY)?.id;

  return (
    <>
      <section className={s.stats}>
        <Stat label="Progress" value={`${p.progress}%`} sub={next ? `Next: ${next.label} · ${dayLabel(next.day)}` : 'All milestones hit'} onClick={goTasks} />
        <Stat label="Due" value={`${weekday(due)} ${dayLabel(due)}`} sub={`${p.dueDays} days left`} tone={p.dueDays <= 3 ? 'amber' : undefined} />
        <Stat label="Open / blocked" value={<>{p.open}<span className={s.statOf}> / </span><span style={p.blocked ? { color: 'var(--redText)' } : undefined}>{p.blocked}</span></>}
          sub={p.overdue ? `${p.overdue} overdue · see tasks` : 'See tasks'} onClick={goTasks} />
        <Stat label="Hours" value={<>{p.hoursActual}<span className={s.statOf}> / {p.hoursPlanned}h</span></>}
          sub={over > 0 ? `${over}h over plan` : `${-over}h left in plan`} tone={over > 0 ? 'red' : undefined} />
      </section>

      <div className={s.ovGrid}>
        <div className={s.col2}>
          <Card title="Latest status update" actions={<HealthBadge health={p.health} />}>
            <p className={s.updText}>{m.update.text}</p>
            <div className={s.updFoot}>
              <Avatar id={m.update.by} size={24} />
              <span className={s.updBy}>{author?.name}</span>
              <span className={s.mute}>{m.update.when} ago</span>
              {m.update.verified
                ? <Badge tone="green"><ShieldCheck size={12} /> Verified</Badge>
                : <Badge tone="amber">Not verified</Badge>}
              {m.update.sources.length ? (
                <span className={s.updSrc}>
                  <span className={s.mute}>Sources</span>
                  {m.update.sources.map((x) => <Source key={x} onClick={() => toast(`Opening ${x}`)}>{x}</Source>)}
                </span>
              ) : <span className={s.updSrc}><span className={s.mute}>No sources linked</span></span>}
            </div>
          </Card>

          <Card title="Milestones" actions={<span className={s.cardCount}>{steps.length}</span>}>
            <ol className={s.msList}>
              {steps.map((st) => {
                const done = st.day + 1 <= NOW_DAY;
                const isNext = st.id === nextId;
                return (
                  <li key={st.id} className={s.msRow}>
                    <span className={done ? s.msDotDone : isNext ? s.msDotNext : s.msDot}>{done ? <Check size={12} strokeWidth={3} /> : null}</span>
                    <span className={s.msLabel}>{st.label}</span>
                    <span className={s.mute}>{weekday(st.day)} {dayLabel(st.day)}</span>
                    {done ? <Badge tone="green">Done</Badge> : isNext ? <Badge tone="accent" dot>Next</Badge> : <Badge tone="outline">Upcoming</Badge>}
                  </li>
                );
              })}
            </ol>
          </Card>
        </div>

        <div className={s.col2}>
          {attention.length ? (
            <section className={s.hero} aria-label="Needs attention">
              <div className={s.heroHead}><OctagonIcon /> Needs attention<span className={s.heroNum}>{attention.length}</span></div>
              <div className={s.heroList}>
                {attention.slice(0, 4).map((t) => (
                  <button key={t.id} className={s.heroItem} onClick={() => openTask(t.id)}>
                    <span className={t.status === 'blocked' ? s.heroBad : s.heroLate}>{t.status === 'blocked' ? 'Blocked' : 'Late'}</span>
                    <span className={s.heroText}>
                      <b>{t.title}</b>
                      <small>{t.key}{t.blockedBy ? ` · waiting on ${t.blockedBy}` : ''} · {personById(t.assignee)?.name}</small>
                    </span>
                    <ArrowUpRight size={15} />
                  </button>
                ))}
              </div>
              {attention.length > 4 ? <button className={s.heroMore} onClick={goTasks}>See all {attention.length} in Tasks</button> : null}
            </section>
          ) : (
            <Card title="Needs attention">
              <Empty icon={<Check size={18} />}>Nothing is blocked or late.{next ? ` Next up: ${next.label} on ${dayLabel(next.day)}.` : ''}</Empty>
            </Card>
          )}

          <Card title="Risks and open questions">
            <div className={s.subHead}><ShieldAlert size={14} /> Risks <span className={s.cardCount}>{m.risks.length}</span></div>
            {m.risks.length ? (
              <div className={s.rows}>
                {m.risks.map((r) => (
                  <div key={r.text} className={s.row}>
                    <Badge tone={levelTone[r.level]}>{levelText[r.level]}</Badge>
                    <span className={s.rowText}>{r.text}</span>
                    <Avatar id={r.owner} size={22} />
                  </div>
                ))}
              </div>
            ) : <p className={s.none}>No risks logged.</p>}

            <div className={s.subHead}><CircleHelp size={14} /> Open questions <span className={s.cardCount}>{questions.length}</span></div>
            {questions.length ? (
              <div className={s.rows}>
                {questions.map((q) => (
                  <div key={q.text} className={s.row}>
                    <span className={s.rowText}>{q.text}</span>
                    <Avatar id={q.owner} size={22} />
                    <Button size="sm" onClick={() => { setQuestions((o) => o.filter((x) => x !== q)); setDecided((d) => [{ text: q.text.replace('?', ''), when: 'Today' }, ...d]); toast('Decision logged'); }}>Mark decided</Button>
                  </div>
                ))}
              </div>
            ) : <p className={s.none}>No open questions.</p>}

            {decided.length ? (
              <p className={s.decided}><b>Last decision:</b> {decided[0].text} · {decided[0].when}</p>
            ) : null}
          </Card>
        </div>
      </div>
    </>
  );
}

function OctagonIcon() {
  return <span className={s.heroIcon}><OctagonAlert size={14} /></span>;
}

/* ======================= List ======================= */

const LIST_ORDER: Status[] = ['blocked', 'doing', 'review', 'todo', 'backlog', 'done'];

export function ListView({ tasks }: { tasks: WorkItem[] }) {
  const { openTask } = useApp();
  const [closed, setClosed] = useState<Record<string, boolean>>({ done: true });
  return (
    <Card flush>
      <table className={`${u.table} ${s.listTable}`}>
        <thead>
          <tr><th style={{ width: 92 }}>Key</th><th>Task</th><th>Status</th><th>Assignee</th><th>Due</th><th>Priority</th></tr>
        </thead>
        <tbody>
          {LIST_ORDER.map((st) => {
            const rows = tasks.filter((t) => t.status === st);
            if (!rows.length) return null;
            const isClosed = closed[st];
            return (
              <Fragment key={st}>
                <tr className={s.groupRow} onClick={() => setClosed((c) => ({ ...c, [st]: !c[st] }))} aria-expanded={!isClosed}>
                  <td colSpan={6}>
                    <span className={s.groupHead} style={{ ['--sc' as string]: SC[st] } as CSSProperties}>
                      <ChevronDown size={15} className={isClosed ? s.chevClosed : s.chev} />
                      <i />{statusLabel(st)}<em>{rows.length}</em>
                      {isClosed ? <span className={s.mute}>Show</span> : null}
                    </span>
                  </td>
                </tr>
                {!isClosed && rows.map((t) => (
                  <tr key={t.id} onClick={() => openTask(t.id)} onKeyDown={(e) => { if (e.key === 'Enter') openTask(t.id); }} tabIndex={0}>
                    <td className={s.mono}>{t.key}</td>
                    <td>
                      <span className={s.listTask}>
                        <span className={t.status === 'done' ? s.struck : s.listTitle}>{t.title}</span>
                        <TaskTags t={t} />
                        <TaskChips t={t} />
                      </span>
                    </td>
                    <td><StatusBadge status={t.status} /></td>
                    <td><span className={s.owner}><Avatar id={t.assignee} size={24} />{personById(t.assignee)?.name.split(' ')[0]}</span></td>
                    <td><TaskDue t={t} /></td>
                    <td><Priority p={t.priority} /></td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

/* ======================= Timeline (tasks) ======================= */

export function TaskTimeline({ p, m, tasks }: { p: Project; m: ProjectMeta; tasks: WorkItem[] }) {
  const { openTask } = useApp();
  const due = dueDay(p);
  const sched = tasks.filter((t) => t.due !== undefined).sort((a, b) => (a.due! - b.due!) || a.priority - b.priority);
  const unsched = tasks.filter((t) => t.due === undefined);
  const spans = sched.map((t) => taskSpan(t)!);
  const lo = Math.min(...spans.map((x) => x.start), Math.floor(NOW_DAY)) - 1;
  const hi = Math.max(...spans.map((x) => x.end), due + 1, ...m.milestones.map((x) => x.day + 1)) + 1;
  const from = Math.max(lo, hi - 28);
  const days = Array.from({ length: hi - from }, (_, i) => from + i);
  const pos = (d: number) => `${((Math.max(from, Math.min(hi, d)) - from) / (hi - from)) * 100}%`;

  return (
    <Card flush>
      <div className={s.ttScroll}>
        <div className={s.ttWrap}>
          <div className={s.ttHead}>
            <div className={s.ttLabelCol}><span className={s.mute}>Task</span></div>
            <div className={s.ttDays}>
              {days.map((d) => (
                <span key={d} className={`${s.ttDay} ${isWeekend(d) ? s.ttWeekend : ''} ${d === Math.floor(NOW_DAY) ? s.ttToday : ''}`}>
                  <em>{weekday(d)[0]}</em>{d > 31 ? d - 31 : d <= 0 ? 30 + d : d}
                </span>
              ))}
            </div>
          </div>
          <div className={s.ttBody}>
            <div className={s.ttGrid}>{days.map((d) => <span key={d} className={isWeekend(d) ? s.ttWeekend : undefined} />)}</div>
            <div className={s.ttOverlay}><div className={s.ttNow} style={{ left: pos(NOW_DAY) }} title="Now" /></div>
            <div className={s.ttRow}>
              <div className={s.ttLabelCol}><span className={s.ttMsLabel}><Flag size={13} /> Milestones</span></div>
              <div className={s.ttLane}>
                {m.milestones.map((ms) => (
                  <span key={ms.id} className={`${s.ttMs} ${ms.day + 1 <= NOW_DAY ? s.ttMsDone : ''}`} style={{ left: pos(ms.day + 0.5) }}><i />{ms.label}</span>
                ))}
                <span className={`${s.ttMs} ${s.ttMsDue}`} style={{ left: pos(due + 0.5) }}><i />Due</span>
              </div>
            </div>
            {sched.map((t, i) => {
              const sp = spans[i];
              return (
                <div key={t.id} className={s.ttRow}>
                  <div className={s.ttLabelCol}>
                    <button className={s.ttName} onClick={() => openTask(t.id)}><span className={s.mono}>{t.key}</span>{t.title}</button>
                  </div>
                  <div className={s.ttLane}>
                    <button
                      className={`${s.ttBar} ${t.status === 'blocked' ? s.ttBlocked : ''} anim-grow-x`}
                      style={{ left: pos(sp.start), width: `calc(${pos(sp.end)} - ${pos(sp.start)})`, ['--sc' as string]: SC[t.status], animationDelay: `${i * 30}ms` } as CSSProperties}
                      onClick={() => openTask(t.id)}
                      title={`${t.key} · ${statusLabel(t.status)} · ${progressOf(t)}%`}
                    >
                      <span className={s.ttFill} style={{ width: `${progressOf(t)}%` }} />
                      <Avatar id={t.assignee} size={20} />
                      <span className={s.ttBarTxt}>{statusLabel(t.status)}</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          {unsched.length ? (
            <div className={s.ttUnsched}>
              <span className={s.mute}>No due date</span>
              {unsched.map((t) => <button key={t.id} className={s.ttChip} onClick={() => openTask(t.id)}><Avatar id={t.assignee} size={18} />{t.title}</button>)}
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

/* ======================= Docs ======================= */

const docTone = { Current: 'green', Draft: 'neutral', Stale: 'amber', Archived: 'outline' } as const;

export function DocsTab({ p }: { p: Project }) {
  const { toast } = useApp();
  const linked = allDocs.filter((d) => d.projectId === p.id || (d.parent && allDocs.find((x) => x.id === d.parent)?.projectId === p.id));
  const context = allDocs.filter((d) => d.brand === p.brand && !linked.includes(d) && d.status !== 'Archived');

  const DocRows = ({ rows }: { rows: typeof allDocs }) => (
    <div className={s.rows}>
      {rows.map((d) => (
        <Link key={d.id} href="/app/docs" className={s.docRow}>
          <span className={s.docIcon}><FileText size={16} /></span>
          <span className={s.docTitle}>{d.title}</span>
          <span className={s.mute}>{d.type}</span>
          <Badge tone={docTone[d.status]} dot>{d.status}</Badge>
          <Avatar id={d.owner} size={22} />
          <span className={s.docWhen}>{d.updated} ago</span>
        </Link>
      ))}
    </div>
  );

  return (
    <div className={s.col2}>
      <Card title="Linked to this project" actions={<Button size="sm" onClick={() => toast('Doc drafted')}>New doc</Button>}>
        {linked.length ? <DocRows rows={linked} /> : (
          <Empty icon={<FileText size={18} />}>
            <span>No docs are linked to {p.name} yet. Linked docs give AI updates their sources.</span>
            <Button size="sm" variant="dark" onClick={() => toast('Doc drafted')}>New doc</Button>
          </Empty>
        )}
      </Card>
      {context.length ? (
        <Card title={`Other ${brandName(p.brand)} docs`}>
          <DocRows rows={context} />
        </Card>
      ) : null}
    </div>
  );
}

/* ======================= Activity ======================= */

const actorIcon = { human: User, ai: Sparkles, agent: Bot, automation: Workflow, integration: Plug } as const;

export function ActivityTab({ tasks }: { tasks: WorkItem[] }) {
  const feed = projectActivity(tasks);
  return (
    <Card title="Activity" actions={<span className={s.cardCount}>{feed.length}</span>}>
      {feed.length ? (
        <div className={s.rows}>
          {feed.map((a) => {
            const I = actorIcon[a.kind];
            return (
              <div key={a.id} className={s.fItem}>
                <span className={`${s.fIcon} ${s['f_' + a.kind]}`}><I size={14} /></span>
                <span className={s.fText}><b>{a.actor}</b> <span>{a.verb}</span> <b>{a.target}</b>{a.to ? <span> → {a.to}</span> : null}</span>
                <span className={s.mute}>{a.time}</span>
              </div>
            );
          })}
        </div>
      ) : <Empty>No activity yet. Changes to tasks, PRs and releases show up here.</Empty>}
    </Card>
  );
}
