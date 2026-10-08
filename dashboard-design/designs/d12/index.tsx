'use client';

/* 12 Split Focus: white urgency-grouped project list, selected row lit in accent, dark detail panel. */

import { useState } from 'react';
import {
  ArrowUpRight, Bot, CalendarDays, Check, CircleAlert, Clock, FolderKanban, Home, Inbox, ListTodo, Plus, Settings, Target, Timer, X, Zap,
} from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { brandName, brands, fmtH, NOW, USER, type Health, type Project } from '@/lib/data';
import { BrandChip, Logo } from '@/components/brand';
import { CountUp, Meter, Spark, Stack } from '@/components/charts';
import s from './styles.module.css';

const groups: { label: string; test: (p: Project) => boolean }[] = [
  { label: 'This week', test: (p) => p.dueDays <= 7 },
  { label: 'Next 3 weeks', test: (p) => p.dueDays > 7 && p.dueDays <= 24 },
  { label: 'Later', test: (p) => p.dueDays > 24 },
];

const healthLabel: Record<Health, string> = { on: 'On track', risk: 'At risk', off: 'Off track' };
const phases = ['Plan', 'Build', 'Test', 'Ship'];
const phaseOf = (p: number) => (p < 25 ? 0 : p < 60 ? 1 : p < 90 ? 2 : 3);
const taskLabel = { todo: 'To do', doing: 'Doing', done: 'Done', blocked: 'Blocked' } as const;

export default function Design() {
  const { s: d, brand, setBrand } = useWorkspace();
  const [selId, setSelId] = useState('p1');

  const sorted = [...d.projects].sort((a, b) => a.dueDays - b.dueDays);
  const sel = sorted.find((p) => p.id === selId) ?? sorted[0];
  const phase = phaseOf(sel.progress);
  const rel = d.release && sel.name === `${d.release.version} release` ? d.release : null;
  const selTasks = d.today.filter((t) => t.project === sel.name);
  const hoursOver = sel.hoursActual > sel.hoursPlanned;
  const tp = d.throughput;
  const nav = [
    { icon: Home, label: 'Home' },
    { icon: FolderKanban, label: 'Projects', on: true, badge: d.active },
    { icon: Zap, label: 'Today' },
    { icon: Bot, label: 'Agents', badge: d.review + d.failed },
    { icon: Inbox, label: 'Inbox' },
    { icon: Target, label: 'Goals' },
  ];

  return (
    <div className={s.root}>
      {/* ---------- sidebar ---------- */}
      <aside className={s.side}>
        <div className={s.logo}><Logo size={26} weight={700} /></div>
        <nav className={s.nav}>
          {nav.map((n) => (
            <a key={n.label} className={n.on ? s.navOn : s.navItem}>
              <n.icon size={16} strokeWidth={1.9} /> {n.label}
              {n.badge ? <span className={s.navBadge}>{n.badge}</span> : null}
            </a>
          ))}
        </nav>
        <p className={s.sideLabel}>Brands</p>
        <div className={s.brands}>
          <button className={brand === null ? s.brandOn : s.brandItem} onClick={() => setBrand(null)}>
            <span className={s.allChip}>All</span> All brands
          </button>
          {brands.map((b) => (
            <button key={b.id} className={brand === b.id ? s.brandOn : s.brandItem} onClick={() => setBrand(b.id)}>
              <BrandChip id={b.id} size={22} /> {b.name}
            </button>
          ))}
        </div>
        <div className={s.shipped}>
          <div className={s.shippedTop}><span>Shipped</span><b><CountUp value={tp[tp.length - 1]} /></b></div>
          <Spark values={tp} width={168} height={34} color="var(--k1)" fill="var(--k1)" strokeWidth={2} />
        </div>
        <div className={s.sideFoot}>
          <div className={s.user}><span className={s.avatar}>{USER.initials}</span> {USER.name}</div>
          <a className={s.navItem}><Settings size={16} /> Settings</a>
        </div>
      </aside>

      {/* ---------- list ---------- */}
      <main className={s.main}>
        <header className={s.head}>
          <h1 className={s.title}>Projects <sup>{d.active}</sup></h1>
          <div className={s.headRight}>
            <span className={s.date}><CalendarDays size={15} /> {NOW.label}</span>
            <button className={s.newBtn}><Plus size={15} /> New project</button>
          </div>
        </header>

        <section className={s.band}>
          <div className={`${s.tile} ${s.hero}`} style={{ animationDelay: '0ms' }}>
            <div className={s.heroTop}><span><Clock size={14} /> Today</span><span>{d.todayDone}/{d.today.length}</span></div>
            <div className={s.heroBottom}>
              <div className={s.heroNum}><CountUp value={d.committed} decimals={1} suffix="h" /><small>/ {fmtH(d.available)}</small></div>
              {d.over > 0 ? <span className={s.overPill}><CircleAlert size={12} /> +{fmtH(d.over)} over</span> : <span className={s.fitPill}>Fits</span>}
            </div>
          </div>
          <div className={s.tile} style={{ animationDelay: '60ms' }}>
            <div className={s.tileTop}><span>Needs you</span><i className={s.alertDot} /></div>
            <div className={s.tileNum}><CountUp value={d.needsYou} /></div>
            <div className={s.mini}>
              <span><b>{d.review}</b> review</span>
              <span className={s.miniBad}><b>{d.failed}</b> failed</span>
              {d.release ? <span><b>1</b> go/no-go</span> : null}
            </div>
          </div>
          <div className={s.tile} style={{ animationDelay: '120ms' }}>
            <div className={s.tileTop}><span>Health</span><span className={s.muted}>{d.active}</span></div>
            <Stack height={8} gap={3} parts={[
              { value: d.health.on, color: 'var(--k1)', label: 'On track' },
              { value: d.health.risk, color: '#F2A93B', label: 'At risk' },
              { value: d.health.off, color: '#EF4444', label: 'Off track' },
            ].filter((p) => p.value > 0)} />
            <div className={s.mini}>
              <span><b>{d.health.on}</b> on</span>
              <span><b>{d.health.risk}</b> risk</span>
              <span className={d.health.off ? s.miniBad : undefined}><b>{d.health.off}</b> off</span>
            </div>
          </div>
          <div className={s.tile} style={{ animationDelay: '180ms' }}>
            <div className={s.tileTop}><span>AI spend</span><span className={s.live}><i className="anim-ping" /><i />{d.running} live</span></div>
            <div className={s.tileNum}>$<CountUp value={d.ai.spent} decimals={1} /><small> / ${d.ai.cap}</small></div>
            <Meter value={d.ai.spent} max={d.ai.cap} color="var(--k1)" track="#E3E6EC" height={6} />
          </div>
        </section>

        <section className={s.list}>
          {groups.map((g, gi) => {
            const rows = sorted.filter(g.test);
            if (!rows.length) return null;
            return (
              <div key={g.label} className={s.group} style={{ animationDelay: `${200 + gi * 80}ms` }}>
                <h2 className={s.groupTitle}>{g.label} <span>{rows.length}</span></h2>
                {rows.map((p) => {
                  const on = p.id === sel.id;
                  return (
                    <button key={p.id} className={on ? s.rowOn : s.row} onClick={() => setSelId(p.id)}>
                      <span className={s.due}>{p.dueDays <= 7 ? `${p.dueDays}d` : p.due}</span>
                      <span className={s.chipWrap}><BrandChip id={p.brand} size={24} /></span>
                      <span className={s.name}>
                        <b>{p.name}</b>
                        <small>{brandName(p.brand)}</small>
                      </span>
                      <span className={s.prog}>
                        <Meter value={p.progress} max={100} height={5} color={on ? 'var(--k1-ink)' : '#16161A'} track={on ? 'color-mix(in srgb, var(--k1-ink) 22%, transparent)' : '#E9EBF0'} />
                        <span>{p.progress}%</span>
                      </span>
                      <span className={`${s.pill} ${s['h_' + p.health]}`}>{healthLabel[p.health]}</span>
                      <span className={s.amount}>
                        <b>{p.open}</b>
                        <small>{p.blocked ? <em>{p.blocked} blocked</em> : 'open'}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </section>
      </main>

      {/* ---------- dark detail ---------- */}
      <aside className={s.panel} key={sel.id}>
        <button className={s.close} aria-label="Close"><X size={18} /></button>
        <div className={s.pHead}>
          <span className={s.pChip}>
            <BrandChip id={sel.brand} size={52} radius={16} />
            <i className={s['dot_' + sel.health]} />
          </span>
          <div>
            <h3 className={s.pName}>{sel.name}</h3>
            <span className={s.pSub}>{brandName(sel.brand)} · {sel.due}</span>
          </div>
        </div>

        <div className={s.pBlock}>
          <span className={s.pLabel}>Progress</span>
          <div className={s.pBig}>
            <CountUp value={sel.progress} suffix="%" />
            <span className={s.daysPill}><Timer size={12} /> {sel.dueDays}d left</span>
          </div>
          <Meter value={sel.progress} max={100} height={6} color="var(--k1)" track="rgba(255,255,255,.08)" />
        </div>

        <div className={s.facts}>
          <div className={s.fact}>
            <span className={s.factIcon}><ListTodo size={16} /></span>
            <div><span className={s.pLabel}>Open</span><b>{sel.open} tasks</b></div>
          </div>
          <div className={s.fact}>
            <span className={s.factIcon}><Clock size={16} /></span>
            <div><span className={s.pLabel}>Hours</span><b className={hoursOver ? s.bad : undefined}>{sel.hoursActual} / {sel.hoursPlanned}h{hoursOver ? ` · +${sel.hoursActual - sel.hoursPlanned}h` : ''}</b></div>
          </div>
          <div className={s.fact}>
            <span className={`${s.factIcon} ${sel.blocked || sel.overdue ? s.factBad : ''}`}><CircleAlert size={16} /></span>
            <div><span className={s.pLabel}>Blocked · Overdue</span><b className={sel.blocked || sel.overdue ? s.bad : undefined}>{sel.blocked} · {sel.overdue}</b></div>
          </div>
        </div>

        <button className={s.action}>
          {sel.blocked ? `Clear ${sel.blocked} blocker${sel.blocked > 1 ? 's' : ''}` : 'Open project'} <ArrowUpRight size={16} />
        </button>

        {rel ? (
          <div className={s.pBlock}>
            <span className={s.pLabel}>Release</span>
            <div className={s.relRow}>
              <div><b><CountUp value={(rel.passed / rel.tests) * 100} decimals={1} suffix="%" /></b><span>pass</span></div>
              <div><b className={s.bad}>{rel.blockers}</b><span>blockers</span></div>
              <div><b>{rel.decision.split(' ')[0]}</b><span>go / no-go</span></div>
            </div>
          </div>
        ) : null}

        <div className={s.pBlock}>
          <span className={s.pLabel}>Today</span>
          {selTasks.length ? (
            <ul className={s.tasks}>
              {selTasks.slice(0, rel ? 2 : 3).map((t) => (
                <li key={t.id} className={t.status === 'done' ? s.taskDone : undefined}>
                  <span className={s.tick}>{t.status === 'done' ? <Check size={12} /> : null}</span>
                  <span className={s.taskTitle}>{t.title}</span>
                  <span className={`${s.tPill} ${s['t_' + t.status]} ${t.overdue ? s.t_over : ''}`}>{t.overdue ? 'Overdue' : taskLabel[t.status]}</span>
                </li>
              ))}
            </ul>
          ) : <span className={s.none}>Nothing scheduled</span>}
        </div>

        <div className={s.stepper}>
          <div className={s.stepLine}><i style={{ width: `${(phase / (phases.length - 1)) * 100}%` }} /></div>
          {phases.map((ph, i) => (
            <div key={ph} className={i < phase ? s.stepDone : i === phase ? s.stepNow : s.step}>
              <span className={s.stepDot}>
                {i === phase ? <i className="anim-ping" /> : null}
                {i === phase ? <b /> : null}
              </span>
              <span className={s.stepLabel}>{ph}</span>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
