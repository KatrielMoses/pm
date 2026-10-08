'use client';

/* 07 Schedule Rail: black schedule pill across the top, huge wordmark, cut-corner cards. */

import { useState } from 'react';
import {
  ArrowLeft, ArrowUpRight, Bell, Bot, CalendarDays, Clock, LayoutGrid, ListChecks, Lock, MessageCircle, Plus, Search,
  SlidersHorizontal,
} from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { brands, brandName, fmtClock, fmtH, NOW, pct, USER, type Project, type Task } from '@/lib/data';
import { BrandChip, LogoMark } from '@/components/brand';
import { CountUp } from '@/components/charts';
import s from './styles.module.css';

/* Schedule rail spans 08:00 to 19:00. */
const D0 = 8 * 60;
const D1 = 19 * 60;
const at = (m: number) => ((m - D0) / (D1 - D0)) * 100;

const statusWord = (t: Task) => (t.status === 'done' ? 'Done' : t.status === 'doing' ? (t.overdue ? 'Overdue' : 'In progress') : t.status === 'blocked' ? 'Blocked' : 'To do');
const statusCls = (t: Task) => (t.status === 'done' ? s.stDone : t.overdue ? s.stBad : t.status === 'doing' ? s.stDoing : s.stTodo);
const healthWord = { on: 'On track', risk: 'At risk', off: 'Off track' } as const;
const healthRank = { off: 0, risk: 1, on: 2 } as const;

type PFilter = 'all' | 'risk' | 'soon';

function Wordmark({ text }: { text: string }) {
  const i = text.indexOf('O');
  if (i < 0) return <h1 className={s.word}>{text}<span className={s.wordDot} /></h1>;
  return (
    <h1 className={s.word}>
      {text.slice(0, i)}
      <span className={s.oRing}><i /></span>
      {text.slice(i + 1)}
    </h1>
  );
}

export default function Design() {
  const { s: d, brand, setBrand } = useWorkspace();
  const [pf, setPf] = useState<PFilter>('all');

  const scheduled = d.today.filter((t) => t.start !== undefined);
  const ordered = [
    ...d.today.filter((t) => t.status === 'doing'),
    ...d.today.filter((t) => t.status === 'todo' || t.status === 'blocked').sort((a, b) => (a.start ?? 9999) - (b.start ?? 9999)),
    ...d.today.filter((t) => t.status === 'done'),
  ].slice(0, 5);

  const atRisk = d.health.risk + d.health.off;
  const sorted = [...d.projects].sort((a, b) => healthRank[a.health] - healthRank[b.health] || a.dueDays - b.dueDays);
  const shown: Project[] = sorted.filter((p) => (pf === 'risk' ? p.health !== 'on' : pf === 'soon' ? p.dueDays <= 7 : true)).slice(0, 4);
  const rel = d.release;
  const passRate = rel ? (rel.passed / rel.tests) * 100 : 0;
  const goal = d.goals[0];

  return (
    <div className={s.root}>
      <aside className={s.rail}>
        <LogoMark size={44} radius={999} bg="#0d0d0d" fg="var(--k1)" />
        <nav className={s.railNav}>
          <button className={s.railOn} aria-label="Home"><LayoutGrid size={18} /></button>
          <button className={s.railBtn} aria-label="Tasks"><ListChecks size={18} /></button>
          <button className={s.railBtn} aria-label="Agents"><Bot size={18} /><i className={s.railBadge}>{d.review}</i></button>
          <button className={s.railBtn} aria-label="Messages"><MessageCircle size={18} /></button>
          <button className={s.railBtn} aria-label="Calendar"><CalendarDays size={18} /></button>
        </nav>
        <span className={s.avatar}>{USER.initials}</span>
      </aside>

      <main className={s.main}>
        {/* ---- schedule pill ---- */}
        <header className={s.top}>
          <div className={s.sched}>
            <span className={s.schedLabel}>Your schedule</span>
            <span className={s.dateChip}><span className={s.dateIcon}><CalendarDays size={14} /></span>{NOW.day} {NOW.month}</span>
            <div className={s.track}>
              <div className={s.past} style={{ width: `${at(NOW.minutes)}%` }} />
              {[9, 11, 13, 15, 17].map((h) => (
                <span key={h} className={s.hour} style={{ left: `${at(h * 60)}%` }} />
              ))}
              {d.events.map((e) => (
                <div key={e.id} className={s.evt} title={`${fmtClock(e.start)} ${e.title}`}
                  style={{ left: `${at(e.start)}%`, width: `calc(${at(e.end) - at(e.start)}% - 3px)` }}>
                  {e.end - e.start >= 45 ? e.title : null}
                </div>
              ))}
              {scheduled.map((t, i) => (
                <div key={t.id} className={`${s.blk} ${t.status === 'done' ? s.blkDone : ''} ${t.status === 'doing' ? s.blkNow : ''}`}
                  title={`${fmtClock(t.start!)} ${t.title}`}
                  style={{ left: `${at(t.start!)}%`, width: `calc(${at(t.start! + t.est) - at(t.start!)}% - 3px)`, animationDelay: `${200 + i * 70}ms` }}>
                  <BrandChip id={t.brand} size={20} radius={7} />
                  {t.est >= 60 ? <span className={s.blkText}>{t.title}</span> : null}
                </div>
              ))}
              <div className={s.now} style={{ left: `${at(NOW.minutes)}%` }}>
                <span className={s.nowTag}>{NOW.time}</span>
              </div>
              <span className={s.edgeL}>08</span>
              <span className={s.edgeR}>19</span>
            </div>
            <div className={s.load}>
              <b><CountUp value={d.committed} decimals={1} suffix="h" /></b>
              <span>/ {fmtH(d.available)}</span>
              {d.over > 0 ? <em className={s.overPill}>+{fmtH(d.over)} over</em> : <em className={s.fitPill}>Fits</em>}
            </div>
            <button className={s.schedBtn} aria-label="Open schedule"><ArrowUpRight size={20} /></button>
          </div>
          <button className={s.circle} aria-label="Notifications"><Bell size={18} /><i className={s.bellDot} /></button>
        </header>

        {/* ---- wordmark + counters ---- */}
        <section className={s.titleRow}>
          <button className={s.circle} aria-label="Back"><ArrowLeft size={18} /></button>
          <Wordmark text={brand ? brandName(brand).toUpperCase() : 'PORTFOLIO'} />
          <button className={s.newTask}><span><Plus size={16} /></span>New task</button>
          <div className={s.counters}>
            <div className={s.counter}>
              <b><CountUp value={d.needsYou} /></b>
              <span>Needs you</span>
              {d.failed > 0 ? <em className={s.badgeBad}>{d.failed} failed</em> : <em className={s.badgeAcc}>{d.review} review</em>}
            </div>
            <div className={s.counter}>
              <b><CountUp value={d.active} /></b>
              <span>Projects</span>
              {atRisk > 0 ? <em className={s.badgeWarn}>{atRisk} at risk</em> : <em className={s.badgeAcc}>All on</em>}
            </div>
            <div className={s.counter}>
              <b><CountUp value={d.running} /></b>
              <span>Agents</span>
              <em className={s.badgeLive}><i className="anim-pulse" />live</em>
            </div>
          </div>
        </section>

        {/* ---- today ---- */}
        <section className={s.secHead}>
          <h2>Today<span className={s.count}><b>{d.todayDone}/{d.today.length}</b> done</span></h2>
          <div className={s.filters}>
            <button className={s.fCircle} aria-label="Search"><Search size={16} /></button>
            <button className={s.fCircle} aria-label="Filter"><SlidersHorizontal size={16} /></button>
            <button className={brand === null ? s.pillOn : s.pill} onClick={() => setBrand(null)}>All</button>
            {brands.map((b) => (
              <button key={b.id} className={brand === b.id ? s.pillOn : s.pill} onClick={() => setBrand(b.id)}>
                <BrandChip id={b.id} size={18} radius={6} />{b.name}
              </button>
            ))}
          </div>
        </section>

        <section className={s.grid}>
          {ordered.map((t, i) => (
            <article key={t.id} className={`${s.card} ${i === 0 ? s.hero : ''} ${t.status === 'done' ? s.cardDone : ''}`} style={{ animationDelay: `${i * 70}ms` }}>
              <span className={s.notch}><button className={s.notchBtn} aria-label="Open task"><ArrowUpRight size={18} /></button></span>
              <div className={s.cardTop}>
                <BrandChip id={t.brand} size={36} radius={11} />
                <span className={s.proj}>{t.project}</span>
              </div>
              <h3 className={s.taskTitle}>{t.title}</h3>
              <div className={s.meta}>
                <span><Clock size={13} />{t.start !== undefined ? fmtClock(t.start) : 'Flexible'}</span>
                <span>{t.est}m</span>
                {t.agent ? <span><Bot size={13} />Agent</span> : null}
                {t.locked ? <span><Lock size={13} />Fixed</span> : null}
              </div>
              <div className={s.cardFoot}>
                <span className={`${s.st} ${statusCls(t)}`}>{statusWord(t)}</span>
                <span className={s.prio} aria-label={`Priority ${t.priority}`}>
                  {[1, 2, 3].map((p) => <i key={p} className={p >= t.priority ? s.prioOn : ''} />)}
                </span>
              </div>
            </article>
          ))}
          {ordered.length < 5 ? (
            <button className={s.ghost} style={{ animationDelay: `${ordered.length * 70}ms` }}><Plus size={22} />Plan</button>
          ) : null}
        </section>

        {/* ---- projects ---- */}
        <section className={s.secHead}>
          <h2>Projects<span className={s.count}><b>{d.active}</b> active</span></h2>
          <div className={s.filters}>
            {(['all', 'risk', 'soon'] as PFilter[]).map((f) => (
              <button key={f} className={pf === f ? s.pillOn : s.pill} onClick={() => setPf(f)}>
                {f === 'all' ? 'All' : f === 'risk' ? `At risk ${atRisk}` : `Due ≤ 7d ${d.dueSoon}`}
              </button>
            ))}
          </div>
        </section>

        <section className={s.grid}>
          <article className={`${s.card} ${s.dark}`} style={{ animationDelay: '380ms' }}>
            <span className={s.notch}><button className={s.notchBtn} aria-label="Open"><ArrowUpRight size={18} /></button></span>
            {rel ? (
              <>
                <div className={s.cardTop}><BrandChip id={rel.brand} size={36} radius={11} /><span className={s.proj}>{rel.version} release</span></div>
                <div className={s.relNum}><CountUp value={passRate} decimals={1} suffix="%" /></div>
                <div className={s.checks}>
                  {rel.checks.map((c) => <i key={c.label} title={c.label} className={c.done ? s.chkOn : ''} />)}
                </div>
                <div className={s.cardFoot}>
                  <span className={`${s.st} ${s.stBad}`}>{rel.blockers} blockers</span>
                  <span className={s.darkMute}>Go / no-go {rel.decision.split(' ')[0]}</span>
                </div>
              </>
            ) : goal ? (
              <>
                <div className={s.cardTop}><BrandChip id={goal.brand} size={36} radius={11} /><span className={s.proj}>{goal.label}</span></div>
                <div className={s.relNum}>{goal.unit}<CountUp value={goal.current} /></div>
                <div className={s.goalBar}><i style={{ width: `${pct(goal.current, goal.target)}%` }} /></div>
                <div className={s.cardFoot}>
                  <span className={`${s.st} ${s.stDoing}`}>{pct(goal.current, goal.target)}%</span>
                  <span className={s.darkMute}>of {goal.unit}{goal.target.toLocaleString('en-US')}</span>
                </div>
              </>
            ) : null}
          </article>

          {shown.map((p, i) => (
            <article key={p.id} className={s.card} style={{ animationDelay: `${450 + i * 70}ms` }}>
              <span className={s.notch}><button className={s.notchBtn} aria-label="Open project"><ArrowUpRight size={18} /></button></span>
              <div className={s.cardTop}>
                <BrandChip id={p.brand} size={36} radius={11} />
                <span className={s.proj}>{p.due}</span>
              </div>
              <h3 className={s.projName}>{p.name}</h3>
              <div className={s.progRow}>
                <b>{p.progress}%</b>
                <span className={`${s.rating} ${s['h_' + p.health]}`}>
                  {Array.from({ length: 10 }, (_, k) => <i key={k} className={k < Math.round(p.progress / 10) ? s.rOn : ''} style={{ animationDelay: `${500 + k * 30}ms` }} />)}
                </span>
              </div>
              <div className={s.cardFoot}>
                <span className={`${s.st} ${p.health === 'on' ? s.stOk : p.health === 'risk' ? s.stWarn : s.stBad}`}>{healthWord[p.health]}</span>
                {p.blocked > 0 ? <span className={`${s.st} ${s.stBad}`}>{p.blocked} blocked</span> : <span className={s.mute}>{p.open} open</span>}
              </div>
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}
