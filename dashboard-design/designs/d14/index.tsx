'use client';

/* 14 Neo Brutal: thick outlines, hard offset shadows, flat accent / k2 / black fills, outlined pill rows, dark dock. */

import {
  ArrowDownLeft, ArrowUpRight, Bell, Bot, CalendarDays, ChevronDown, CircleAlert, FolderKanban, Home, Search, Target, Zap,
} from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { brands, USER, weeksLabels } from '@/lib/data';
import { BrandChip, LogoMark } from '@/components/brand';
import { Bars, CountUp, Spark } from '@/components/charts';
import s from './styles.module.css';

const dock = [
  { icon: Home, label: 'Home', on: true },
  { icon: FolderKanban, label: 'Projects' },
  { icon: Zap, label: 'Today' },
  { icon: Bot, label: 'Agents' },
  { icon: CalendarDays, label: 'Calendar' },
  { icon: Target, label: 'Goals' },
];
const healthLabel = { on: 'On track', risk: 'At risk', off: 'Off track' } as const;
const TODAY = 1;

export default function Design() {
  const { s: d, brand, setBrand } = useWorkspace();
  const tp = d.throughput;
  const cur = tp[tp.length - 1], prev = tp[tp.length - 2];
  const delta = prev ? Math.round(((cur - prev) / prev) * 100) : 0;
  const urgent = [...d.projects].sort((a, b) => (a.health === 'on' ? 1 : 0) - (b.health === 'on' ? 1 : 0) || a.dueDays - b.dueDays).slice(0, 4);
  const reviews = d.runs.filter((r) => r.state === 'review').slice(0, 3);
  const fixes: { id: string; brand: (typeof d.runs)[number]['brand']; text: string; tag: string; kind: 'decide' | 'fail' | 'block' }[] = [
    ...(d.release ? [{ id: 'rel', brand: d.release.brand, text: `${d.release.version} go / no-go`, tag: 'Decide', kind: 'decide' as const }] : []),
    ...d.runs.filter((r) => r.state === 'failed').map((r) => ({ id: r.id, brand: r.brand, text: r.task, tag: 'Failed', kind: 'fail' as const })),
    ...d.projects.filter((p) => p.blocked > 0).map((p) => ({ id: p.id, brand: p.brand, text: p.name, tag: `${p.blocked} blocked`, kind: 'block' as const })),
  ].slice(0, 3);

  return (
    <div className={s.root}>
      <div className={s.sheet}>
        {/* ---------- header ---------- */}
        <header className={s.head}>
          <div>
            <h1 className={s.title}>Overview</h1>
            <nav className={s.tabs}>
              <button className={brand === null ? s.tabOn : s.tab} onClick={() => setBrand(null)}>All brands</button>
              {brands.map((b) => (
                <button key={b.id} className={brand === b.id ? s.tabOn : s.tab} onClick={() => setBrand(b.id)}>
                  <BrandChip id={b.id} size={18} radius={5} /> {b.name}
                </button>
              ))}
            </nav>
          </div>
          <div className={s.headRight}>
            <label className={s.search}><Search size={17} /> <span>Search</span></label>
            <button className={s.round} aria-label="Calendar"><CalendarDays size={18} /></button>
            <button className={s.round} aria-label="Alerts"><Bell size={18} />{d.needsYou ? <i /> : null}</button>
            <span className={s.avatar}>{USER.initials}</span>
            <ChevronDown size={18} />
          </div>
        </header>

        <div className={s.body}>
          {/* ================= left ================= */}
          <section className={s.col}>
            <div className={s.secHead}>
              <h2>Today</h2>
              <div className={s.btns}><button className={s.oBtn}>Day <ChevronDown size={14} /></button><button className={s.oBtn}>Plan <ChevronDown size={14} /></button></div>
            </div>
            <div className={s.legend}>
              <span><i style={{ background: 'var(--k1)' }} />Committed</span>
              <span><i style={{ background: 'var(--k2)' }} />Free</span>
              <span><i style={{ background: '#000' }} />Over</span>
            </div>
            <div className={s.tiles}>
              <div className={`${s.tile} ${s.t1}`} style={{ animationDelay: '0ms' }}>
                <ArrowDownLeft size={22} strokeWidth={2.6} />
                <span>Committed</span>
                <b><CountUp value={d.committed} decimals={1} suffix="h" /></b>
              </div>
              <div className={`${s.tile} ${s.t2}`} style={{ animationDelay: '70ms' }}>
                <ArrowUpRight size={22} strokeWidth={2.6} />
                <span>Free</span>
                <b><CountUp value={d.available} decimals={d.available % 1 ? 1 : 0} suffix="h" /></b>
              </div>
              <div className={`${s.tile} ${s.t3}`} style={{ animationDelay: '140ms' }}>
                <CircleAlert size={22} strokeWidth={2.6} className={d.over > 0 ? 'anim-pulse' : undefined} />
                <span>{d.over > 0 ? 'Over' : 'Fits'}</span>
                <b className={d.over > 0 ? s.overNum : undefined}>{d.over > 0 ? '+' : ''}<CountUp value={d.over} decimals={1} suffix="h" /></b>
              </div>
            </div>
            <div className={s.days}>
              {d.week.map((x, i) => (
                <span key={x.d} className={i === TODAY ? s.dayOn : s.day}>
                  {x.d}{x.planned > x.avail ? <i title="Over capacity" /> : null}
                </span>
              ))}
            </div>

            <div className={s.secHead}><h2>Projects</h2><span className={s.count}>{d.active}</span></div>
            <div className={s.tHead}><span>Project</span><span>Done</span><span>Due</span><span /></div>
            <div className={s.rows}>
              {urgent.map((p, i) => (
                <div key={p.id} className={s.pRow} style={{ animationDelay: `${200 + i * 60}ms` }}>
                  <span className={s.pName}><BrandChip id={p.brand} size={24} radius={7} /> {p.name}</span>
                  <span className={s.pDone}><i><b style={{ width: `${p.progress}%` }} /></i>{p.progress}%</span>
                  <span className={s.pDue}>{p.due}</span>
                  <span className={`${s.hPill} ${s['h_' + p.health]}`}>{healthLabel[p.health]}</span>
                </div>
              ))}
            </div>
          </section>

          {/* ================= right ================= */}
          <section className={s.col}>
            <div className={s.secHead}>
              <h2>Shipped</h2>
              <div className={s.btns}><button className={s.oBtn}>Report <ChevronDown size={14} /></button><button className={s.oBtn}>12 weeks <ChevronDown size={14} /></button></div>
            </div>
            <div className={s.legend}>
              <span><i style={{ background: 'var(--k1)' }} />Done</span>
              <span><i style={{ background: 'var(--k2)' }} />Agents</span>
            </div>
            <div className={s.black}>
              <div className={s.bTop}>
                <div className={s.bHero}>
                  <span className={s.delta}>{delta >= 0 ? '+' : ''}{delta}%</span>
                  <b><CountUp value={cur} /></b>
                  <span>this week</span>
                </div>
                <div className={s.wave}>
                  <Spark values={tp} width={400} height={96} color="var(--k1)" strokeWidth={4} dotFill="#000" />
                </div>
              </div>
              <div className={s.bBottom}>
                <div className={s.mini}>
                  <Bars values={d.runs.map((r) => r.mins)} height={30} gap={3} radius={1} color="var(--k1)" barWidth={5} minBar={3} />
                  <b><CountUp value={d.running} /> <small>live</small></b>
                  <span>Agents</span>
                </div>
                <div className={s.mini}>
                  <Bars values={d.runs.map((r) => r.cost)} height={30} gap={3} radius={1} color="var(--k2)" barWidth={5} minBar={3} />
                  <b>$<CountUp value={d.ai.spent} decimals={1} /> <small>/ ${d.ai.cap}</small></b>
                  <span>AI spend</span>
                </div>
                <div className={s.weeks}>
                  {weeksLabels.filter((_, i) => i % 3 === 2).map((w) => <span key={w}>{w}</span>)}
                </div>
              </div>
            </div>

            <div className={s.secHead}><h2>Needs you</h2><span className={`${s.count} ${s.countHot}`}>{d.needsYou}</span></div>
            <div className={s.split}>
              <div>
                <p className={s.colLabel}>Review</p>
                <div className={s.rows}>
                  {reviews.length ? reviews.map((r, i) => (
                    <div key={r.id} className={s.nRow} style={{ animationDelay: `${260 + i * 60}ms` }}>
                      <BrandChip id={r.brand} size={22} radius={6} /><span className={s.nText}>{r.task}</span><span className={`${s.tag} ${s.tagReview}`}>Review</span>
                    </div>
                  )) : <div className={`${s.nRow} ${s.nEmpty}`}>Clear</div>}
                </div>
              </div>
              <div>
                <p className={s.colLabel}>Fix &amp; decide</p>
                <div className={s.rows}>
                  {fixes.length ? fixes.map((f, i) => (
                    <div key={f.id} className={`${s.nRow} ${f.kind === 'fail' ? s.nFail : ''}`} style={{ animationDelay: `${300 + i * 60}ms` }}>
                      <BrandChip id={f.brand} size={22} radius={6} /><span className={s.nText}>{f.text}</span><span className={`${s.tag} ${s['tag_' + f.kind]}`}>{f.tag}</span>
                    </div>
                  )) : <div className={`${s.nRow} ${s.nEmpty}`}>Clear</div>}
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* ---------- dock (bottom-left, clear of the review toolbar) ---------- */}
      <nav className={s.dock}>
        <LogoMark size={30} bg="var(--k1)" fg="var(--k1-ink)" />
        <span className={s.dockSep} />
        {dock.map((n) => (
          <a key={n.label} className={n.on ? s.dockOn : s.dockItem} aria-label={n.label} title={n.label}><n.icon size={19} /></a>
        ))}
      </nav>
    </div>
  );
}
