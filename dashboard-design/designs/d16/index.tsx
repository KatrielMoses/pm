'use client';

/* 16 Heat Ops: warm black ops console, two-line title, KPI trio, warning strip, heatmap, release stepper, compact table. */

import { useState } from 'react';
import {
  ArrowUpRight, Bell, Bot, CalendarClock, ChevronDown, ChevronLeft, ChevronRight, Clock3, Flag, Gauge, Layers,
  MoreHorizontal, Pause, Search, SlidersHorizontal, TriangleAlert, Workflow,
} from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { brandName, brands, fmtH, heat, NOW, pct, throughput, USER, weeksLabels, type Health } from '@/lib/data';
import { BrandChip, Logo } from '@/components/brand';
import { CountUp } from '@/components/charts';
import s from './styles.module.css';

const nav = ['Overview', 'Projects', 'Agents', 'Releases', 'Reports'];
const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const healthWord: Record<Health, string> = { on: 'On track', risk: 'At risk', off: 'Off track' };
const healthRank: Record<Health, number> = { off: 0, risk: 1, on: 2 };
const sum = (xs: number[]) => xs.reduce((a, c) => a + c, 0);
const allTp = sum([...throughput.op, ...throughput.ma, ...throughput.ax]);

export default function Design() {
  const { s: d, brand, setBrand } = useWorkspace();
  const [filter, setFilter] = useState<'all' | Health>('all');

  /* heat scaled to the selected brand's share of throughput */
  const share = sum(d.throughput) / allTp;
  const shiftBy = d.brand ? { op: 3, ma: 7, ax: 10 }[d.brand] : 0;
  const grid = heat.map((row) => row.map((_, c) => row[(c + shiftBy) % row.length] * share));
  const weekly = grid[0].map((_, c) => Math.round(sum(grid.map((r) => r[c]))));
  const hMin = Math.min(...weekly), hMax = Math.max(...weekly), hAvg = Math.round(sum(weekly) / weekly.length);
  const cellMax = Math.max(...grid.flat(), 0.01);
  const maxAt = (() => { let best = [0, 0]; grid.forEach((r, ri) => r.forEach((v, ci) => { if (v > grid[best[0]][best[1]]) best = [ri, ci]; })); return best; })();

  const tp = d.throughput;
  const tpNow = tp[tp.length - 1], tpPrev = tp[tp.length - 2];
  const tpDelta = Math.round(((tpNow - tpPrev) / tpPrev) * 100);

  const rows = [...d.projects]
    .filter((p) => filter === 'all' || p.health === filter)
    .sort((a, b) => healthRank[a.health] - healthRank[b.health] || a.dueDays - b.dueDays);
  const shown = rows.slice(0, 4);

  const rel = d.release;
  const passRate = rel ? (rel.passed / rel.tests) * 100 : 0;
  const firstOpen = rel ? rel.checks.findIndex((c) => !c.done) : -1;
  const milestones = [...d.projects].sort((a, b) => a.dueDays - b.dueDays).slice(0, 4);

  const weekMax = Math.max(...d.week.map((w) => Math.max(w.avail, w.planned)), 1);
  const todayIdx = days.indexOf(NOW.weekday);

  return (
    <div className={s.root}>
      <div className={s.frame}>
        {/* top bar */}
        <header className={s.top}>
          <Logo size={28} />
          <nav className={s.nav}>
            {nav.map((n, i) => (
              <a key={n} className={i === 0 ? s.navOn : s.navItem}>{i === 0 ? <i className={s.navDot} /> : null}{n}</a>
            ))}
          </nav>
          <div className={s.topRight}>
            <button className={s.round} aria-label="Search"><Search size={16} /></button>
            <button className={s.round} aria-label="Alerts"><Bell size={16} /><i className={s.bellDot} /></button>
            <div className={s.user}>
              <span className={s.avatar}>{USER.initials}</span>
              <span className={s.userText}><b>{USER.name}</b><small>Owner</small></span>
              <ChevronDown size={14} className={s.mute} />
            </div>
          </div>
        </header>

        {/* title + KPI trio */}
        <section className={s.titleRow}>
          <h1 className={s.title}>{d.brand ? brandName(d.brand) : 'Portfolio'}<br />Operations</h1>
          <div className={s.kpis}>
            <div className={`${s.kpi} anim-fade-up`} style={{ animationDelay: '40ms' }}>
              <span className={s.kpiIcon}><Clock3 size={22} /></span>
              <div>
                <span className={s.kpiLabel}>Committed today</span>
                <div className={s.kpiRow}>
                  <b className={s.kpiNum}><CountUp value={d.committed} decimals={1} suffix="h" /></b>
                  {d.over > 0 ? <span className={s.dBad}>+{fmtH(d.over)} over</span> : <span className={s.dGood}>Fits</span>}
                </div>
              </div>
            </div>
            <div className={`${s.kpi} anim-fade-up`} style={{ animationDelay: '90ms' }}>
              <span className={s.kpiIcon}><Flag size={22} /></span>
              <div>
                <span className={s.kpiLabel}>Needs you</span>
                <div className={s.kpiRow}>
                  <b className={s.kpiNum}><CountUp value={d.needsYou} /></b>
                  {d.failed > 0 ? <span className={s.dBad}>{d.failed} failed</span> : <span className={s.dWarn}>{d.review} review</span>}
                </div>
              </div>
            </div>
            <div className={`${s.kpi} anim-fade-up`} style={{ animationDelay: '140ms' }}>
              <span className={s.kpiIcon}><Layers size={22} /></span>
              <div>
                <span className={s.kpiLabel}>Shipped this week</span>
                <div className={s.kpiRow}>
                  <b className={s.kpiNum}><CountUp value={tpNow} /></b>
                  <span className={tpDelta >= 0 ? s.dGood : s.dBad}>{tpDelta >= 0 ? '+' : ''}{tpDelta}% ↗</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* warning strip */}
        <section className={`${s.strip} anim-fade-up`} style={{ animationDelay: '180ms' }}>
          <span className={s.stripIcon}><CalendarClock size={17} /></span>
          <div className={s.stripText}><b>Workspace</b><small>Today · {NOW.label}</small></div>
          <div className={s.brandSeg}>
            <button className={brand === null ? s.segOn : s.seg} onClick={() => setBrand(null)}>All</button>
            {brands.map((b) => (
              <button key={b.id} className={brand === b.id ? s.segOn : s.seg} onClick={() => setBrand(b.id)}>
                <BrandChip id={b.id} size={18} /> {b.short}
              </button>
            ))}
          </div>
          <div className={s.stripWarn}>
            <TriangleAlert size={16} />
            {d.over > 0 ? <span><b>{fmtH(d.over)}</b> over capacity</span> : <span>Capacity OK</span>}
            <i />
            <span><b>{d.blocked}</b> blocked</span>
          </div>
          <button className={s.round} aria-label="Filter"><SlidersHorizontal size={16} /></button>
          <button className={s.ghostBtn}>Rebalance</button>
          <button className={s.accentBtn}>Review {d.needsYou}</button>
        </section>

        {/* main grid */}
        <section className={s.grid}>
          <div className={`${s.card} ${s.heatCard} anim-fade-up`} style={{ animationDelay: '220ms' }}>
            <div className={s.cardHead}>
              <h3>Activity</h3>
              <div className={s.periods}>
                {['Day', 'Week', 'Month', 'Quarter'].map((p) => (
                  <span key={p} className={p === 'Week' ? s.periodOn : s.period}>{p === 'Week' ? <i /> : null}{p}</span>
                ))}
                <button className={s.roundSm} aria-label="Open"><ArrowUpRight size={15} /></button>
              </div>
            </div>
            <div className={s.heatStats}>
              <div><b><CountUp value={hMin} /><ArrowUpRight size={15} /></b><span>Min / week</span></div>
              <div><b><CountUp value={hAvg} /><ArrowUpRight size={15} /></b><span>Average</span></div>
              <div><b><CountUp value={hMax} /><ArrowUpRight size={15} /></b><span>Max / week</span></div>
            </div>
            <div className={s.heat}>
              {grid.map((row, r) => (
                <div key={r} className={s.heatRow}>
                  <span className={s.heatLabel}>{days[r]}</span>
                  {row.map((v, c) => {
                    const peak = r === maxAt[0] && c === maxAt[1];
                    return (
                      <span
                        key={c}
                        className={`${s.cell} ${peak ? s.cellPeak : ''} anim-fade`}
                        title={`${Math.round(v)} done`}
                        style={{
                          animationDelay: `${(r * 12 + c) * 9}ms`,
                          background: v === 0 ? 'rgba(255,240,225,.035)' : `color-mix(in srgb, var(--k1) ${Math.round(18 + (v / cellMax) * 82)}%, #2a2420)`,
                        }}
                      />
                    );
                  })}
                </div>
              ))}
              <div className={s.heatAxis}>
                <span />
                <span>{weeksLabels[0]}</span><span>{weeksLabels[5]}</span><span>{weeksLabels[11]}</span>
              </div>
            </div>
          </div>

          <div className={`${s.card} ${s.relCard} anim-fade-up`} style={{ animationDelay: '270ms' }}>
            <div className={s.cardHead}>
              <h3>{rel ? 'Release' : 'Milestones'}</h3>
              <button className={s.roundSm} aria-label="More"><MoreHorizontal size={15} /></button>
            </div>
            {rel ? (
              <>
                <div className={s.relId}>
                  <div><small>Release</small><b>{rel.name}</b></div>
                  <span className={rel.blockers > 0 ? s.pillBad : s.pillGood}>{rel.blockers > 0 ? 'No-go' : 'Go'}</span>
                </div>
                <ol className={s.stepper}>
                  {rel.checks.map((c, i) => (
                    <li key={c.label} className={c.done ? s.stepDone : i === firstOpen ? s.stepNow : s.step}>
                      <i>{i === firstOpen ? <em className="anim-ping" /> : null}</i>
                      <span>{c.label}</span>
                      <small>{c.done ? 'Done' : i === firstOpen ? `${rel.failed} failing` : 'Open'}</small>
                    </li>
                  ))}
                </ol>
                <div className={s.relFoot}>
                  <div><span className={s.footIcon}><Gauge size={15} /></span><div><small>Pass rate</small><b><CountUp value={passRate} decimals={1} suffix="%" /></b></div></div>
                  <div><span className={s.footIcon}><CalendarClock size={15} /></span><div><small>Go / no-go</small><b>{rel.decision}</b></div></div>
                </div>
              </>
            ) : (
              <>
                <div className={s.relId}>
                  <div><small>Next due</small><b>{milestones[0]?.name}</b></div>
                  <span className={s.pillWarn}>{milestones[0]?.dueDays}d</span>
                </div>
                <ol className={s.stepper}>
                  {milestones.map((p, i) => (
                    <li key={p.id} className={i === 0 ? s.stepNow : s.step}>
                      <i>{i === 0 ? <em className="anim-ping" /> : null}</i>
                      <span>{p.name}</span>
                      <small>{p.due}</small>
                    </li>
                  ))}
                </ol>
                <div className={s.relFoot}>
                  {d.goals.map((g) => (
                    <div key={g.label}><span className={s.footIcon}><Flag size={15} /></span><div><small>{g.label}</small><b>{g.unit}{g.current.toLocaleString()} <em className={s.mute}>/ {g.unit}{g.target.toLocaleString()}</em></b></div></div>
                  ))}
                  <div><span className={s.footIcon}><Gauge size={15} /></span><div><small>Avg progress</small><b>{pct(sum(d.projects.map((p) => p.progress)), d.projects.length * 100)}%</b></div></div>
                </div>
              </>
            )}
          </div>

          <div className={s.side}>
            <div className={`${s.card} ${s.weekCard} anim-fade-up`} style={{ animationDelay: '320ms' }}>
              <div className={s.cardHead}>
                <h3>Capacity</h3>
                <span className={s.weekNum}><b>{fmtH(sum(d.week.map((w) => w.planned)))}</b> / {fmtH(sum(d.week.map((w) => w.avail)))}</span>
              </div>
              <div className={s.weekBars}>
                {d.week.map((w, i) => {
                  const m = Math.max(w.avail, w.planned, 0.01);
                  const over = Math.max(0, w.planned - w.avail);
                  return (
                    <div key={w.d} className={`${s.wCol} ${i === todayIdx ? s.wToday : ''}`}>
                      <div className={s.wTrack} style={{ height: `calc(${(m / weekMax).toFixed(3)} * (100% - 18px))` }}>
                        <span className={s.wAvail} style={{ height: `${(w.avail / m) * 100}%` }} />
                        <span className={`${s.wPlan} anim-grow-y`} style={{ height: `${(Math.min(w.planned, w.avail) / m) * 100}%`, animationDelay: `${i * 50}ms` }} />
                        {over > 0 ? <span className={`${s.wOver} anim-grow-y`} style={{ bottom: `${(w.avail / m) * 100}%`, height: `${(over / m) * 100}%`, animationDelay: `${350 + i * 50}ms` }} /> : null}
                      </div>
                      <small>{w.d[0]}</small>
                    </div>
                  );
                })}
              </div>
              <div className={s.legend}><span><i className={s.lgPlan} />Planned</span><span><i className={s.lgAvail} />Free</span><span><i className={s.lgOver} />Over</span></div>
            </div>

            <div className={`${s.card} ${s.agentCard} anim-fade-up`} style={{ animationDelay: '370ms' }}>
              <span className={s.agentIcon}><Bot size={20} /><i className="anim-pulse" /></span>
              <div className={s.agentText}><small>Agents live</small><b><CountUp value={d.running} /> <em>/ {d.runs.length}</em></b></div>
              <button className={s.round} aria-label="Pause"><Pause size={15} /></button>
              <button className={s.round} aria-label="Runs"><Workflow size={15} /></button>
            </div>
          </div>
        </section>

        {/* compact table */}
        <section className={`${s.table} anim-fade-up`} style={{ animationDelay: '420ms' }}>
          <div className={s.tableHead}>
            <h3>Projects</h3>
            <div className={s.filters}>
              {(['all', 'off', 'risk', 'on'] as const).map((f) => {
                const n = f === 'all' ? d.active : d.health[f];
                return (
                  <button key={f} className={filter === f ? s.fOn : s.f} onClick={() => setFilter(f)}>
                    {filter === f ? <i /> : null}{f === 'all' ? 'All' : healthWord[f]} <em>{n}</em>
                  </button>
                );
              })}
            </div>
            <div className={s.pager}>
              <span><SlidersHorizontal size={14} /> Customize</span>
              <span className={s.mute}>{rows.length ? 1 : 0}–{shown.length} of {rows.length}</span>
              <button className={s.roundSm} aria-label="Prev"><ChevronLeft size={14} /></button>
              <button className={s.roundSm} aria-label="Next"><ChevronRight size={14} /></button>
            </div>
          </div>
          <table>
            <thead>
              <tr><th className={s.chk}><span className={s.box} /></th><th>Project</th><th>Brand</th><th>Due</th><th>Progress</th><th>Hours</th><th>Blocked</th><th className={s.right}>Status</th></tr>
            </thead>
            <tbody>
              {shown.map((p) => {
                const overH = p.hoursActual - p.hoursPlanned;
                return (
                  <tr key={p.id}>
                    <td className={s.chk}><span className={s.box} /></td>
                    <td className={s.pName}>{p.name}</td>
                    <td><span className={s.brandCell}><BrandChip id={p.brand} size={18} />{brandName(p.brand)}</span></td>
                    <td className={p.dueDays <= 3 ? s.hot : ''}>{p.due}</td>
                    <td>
                      <span className={s.prog}><span className={s.progTrack}><span className="anim-grow-x" style={{ width: `${p.progress}%` }} /></span>{p.progress}%</span>
                    </td>
                    <td className={overH > 0 ? s.hot : ''}>{p.hoursActual} / {p.hoursPlanned}h</td>
                    <td className={p.blocked ? s.hot : s.mute}>{p.blocked || '—'}</td>
                    <td className={s.right}><span className={s['h_' + p.health]}>{healthWord[p.health]}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
