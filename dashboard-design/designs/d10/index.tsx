'use client';

/* 10 Violet Glass: plum gradient, glass cards, AI assistant first, smooth dual line with hatched area. */

import { useEffect, useRef, useState } from 'react';
import {
  Bell, Bot, CalendarDays, ChevronDown, ChevronLeft, CircleHelp, Clock, Download, FolderKanban, Home, Layers,
  LifeBuoy, MessageCircle, Search, SendHorizontal, Settings, SlidersHorizontal, Sparkles, Target, Flag,
} from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { brandHours, brands, brandName, fmtH, NOW, pct, USER, weeksLabels } from '@/lib/data';
import { BrandChip, Logo } from '@/components/brand';
import { CountUp, Ring } from '@/components/charts';
import s from './styles.module.css';

const runWord = { running: 'Running', queued: 'Queued', waiting: 'Waiting', review: 'Review', failed: 'Failed', accepted: 'Accepted' } as const;

function useWidth<T extends HTMLElement>(initial: number) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function smooth(pts: [number, number][]) {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const cx = (x0 + x1) / 2;
    d += ` C${cx.toFixed(1)},${y0.toFixed(1)} ${cx.toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}

function DualLine({ a, b }: { a: number[]; b: number[] }) {
  const [ref, w] = useWidth<HTMLDivElement>(760);
  const h = 176;
  const max = Math.ceil((Math.max(...a, ...b) * 1.2) / 5) * 5;
  const X = (i: number) => (i / (a.length - 1)) * w;
  const Y = (v: number) => h - (v / max) * (h - 8) - 4;
  const pa = a.map((v, i) => [X(i), Y(v)] as [number, number]);
  const pb = b.map((v, i) => [X(i), Y(v)] as [number, number]);
  const sel = a.length - 1;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((k) => Math.round(max * k));
  return (
    <div className={s.dual}>
      <div className={s.yAxis}>{[...grid].reverse().map((g) => <span key={g}>{g}</span>)}</div>
      <div className={s.plot} ref={ref}>
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={s.svg}>
          <defs>
            <pattern id="d10hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="7" stroke="var(--k1)" strokeOpacity=".32" strokeWidth="2.4" />
            </pattern>
            <linearGradient id="d10fade" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--k1)" stopOpacity=".28" />
              <stop offset="1" stopColor="var(--k1)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {grid.map((g) => <line key={g} x1={0} x2={w} y1={Y(g)} y2={Y(g)} stroke="rgba(255,255,255,.05)" />)}
          <path d={`${smooth(pb)} L${w},${h} L0,${h} Z`} fill="url(#d10fade)" className="anim-fade" />
          <path d={`${smooth(pb)} L${w},${h} L0,${h} Z`} fill="url(#d10hatch)" className="anim-fade" />
          <path d={smooth(pb)} fill="none" stroke="var(--k1)" strokeWidth={2.4} pathLength={1} className="anim-draw" />
          <path d={smooth(pa)} fill="none" stroke="var(--k2)" strokeWidth={2.4} pathLength={1} className="anim-draw" style={{ animationDelay: '150ms' }} />
          <line x1={X(sel)} x2={X(sel)} y1={0} y2={h} stroke="rgba(255,255,255,.5)" strokeWidth={1.2} />
          <circle cx={X(sel)} cy={0} r={3} fill="#fff" />
          <circle cx={X(sel)} cy={Y(a[sel])} r={5} fill="var(--k2)" stroke="#1a1626" strokeWidth={2.5} className="anim-pop" />
          <circle cx={X(sel)} cy={Y(b[sel])} r={5} fill="var(--k1)" stroke="#1a1626" strokeWidth={2.5} className="anim-pop" />
        </svg>
        <div className={s.tip} style={{ right: 18, top: Math.min(Y(a[sel]), Y(b[sel])) + 4 }}>
          <span className={s.tipHead}>{weeksLabels[sel]}</span>
          <span><i style={{ background: 'var(--k2)' }} />{a[sel]} done</span>
          <span><i style={{ background: 'var(--k1)' }} />{b[sel]} avg</span>
        </div>
      </div>
      <div className={s.xAxis}>
        {weeksLabels.map((l, i) => <span key={l} className={i === sel ? s.xOn : ''}>{i % 2 === 1 || i === sel ? l.split(' ')[1] + ' ' + l.split(' ')[0] : ''}</span>)}
      </div>
    </div>
  );
}

export default function Design() {
  const { s: d, brand, setBrand } = useWorkspace();
  const rel = d.release;
  const passRate = rel ? (rel.passed / rel.tests) * 100 : 0;
  const avg = d.throughput.map((_, i) => {
    const w = d.throughput.slice(Math.max(0, i - 3), i + 1);
    return Math.round((w.reduce((x, y) => x + y, 0) / w.length) * 10) / 10;
  });
  const atRisk = d.health.risk + d.health.off;
  const spendPct = pct(d.ai.spent, d.ai.cap);
  const runCost = d.runs.reduce((x, r) => x + r.cost, 0);

  const chips = [
    d.review > 0 ? `Review ${d.review} runs` : null,
    d.failed > 0 ? `Retry ${d.failed} failed` : null,
    rel ? `${rel.version} go / no-go` : null,
    d.over > 0 ? `Trim ${fmtH(d.over)}` : null,
  ].filter(Boolean) as string[];

  /* Hours split: per brand (all) or per project (one brand). */
  const split = brand
    ? [...d.projects].sort((x, y) => y.hoursPlanned - x.hoursPlanned).slice(0, 3).map((p) => ({ key: p.id, label: p.name, v: p.hoursPlanned }))
    : brands.map((b) => ({ key: b.id, label: b.name, v: brandHours[b.id] })).sort((x, y) => y.v - x.v);
  const splitTotal = split.reduce((x, y) => x + y.v, 0) || 1;

  const wkMax = Math.max(...d.week.map((w) => Math.max(w.planned, w.avail)), 1);
  const wkPlanned = d.week.reduce((x, w) => x + w.planned, 0);
  const wkAvail = d.week.reduce((x, w) => x + w.avail, 0);

  return (
    <div className={s.root}>
      {/* ---- sidebar ---- */}
      <aside className={s.side}>
        <div className={s.sideTop}><Logo size={30} /><button className={s.collapse} aria-label="Collapse"><ChevronLeft size={14} /></button></div>
        <nav className={s.nav}>
          <a className={s.navOn}><span className={s.navIcon}><Home size={16} /></span>Home</a>
          <a className={s.navItem}><span className={s.navIcon}><Layers size={16} /></span>Brands</a>
          <div className={s.tree}>
            <button className={brand === null ? s.leafOn : s.leaf} onClick={() => setBrand(null)}>All brands</button>
            {brands.map((b) => (
              <button key={b.id} className={brand === b.id ? s.leafOn : s.leaf} onClick={() => setBrand(b.id)}>
                <BrandChip id={b.id} size={16} radius={5} />{b.name}
              </button>
            ))}
          </div>
          <a className={s.navItem}><span className={s.navIcon}><FolderKanban size={16} /></span>Projects</a>
          <a className={s.navItem}><span className={s.navIcon}><Bot size={16} /></span>Agents<em>{d.review + d.failed}</em></a>
          <a className={s.navItem}><span className={s.navIcon}><Target size={16} /></span>Goals</a>
          <span className={s.sep} />
          <a className={s.navItem}><span className={s.navIcon}><Settings size={16} /></span>Settings</a>
          <a className={s.navItem}><span className={s.navIcon}><LifeBuoy size={16} /></span>Help</a>
        </nav>

        <div className={s.credits}>
          <div className={s.credTop}>
            <Ring value={d.ai.spent / d.ai.cap} size={52} stroke={6} color="var(--k2)" track="rgba(255,255,255,.1)">
              <b className={s.credPct}>{spendPct}%</b>
            </Ring>
            <div className={s.credText}><b>${d.ai.spent.toFixed(2)}</b><span>of ${d.ai.cap} AI</span></div>
          </div>
          <button className={s.topUp}>Top up</button>
        </div>
        <div className={s.user}>
          <span className={s.avatar}>{USER.initials}</span>
          <div><b>{USER.name}</b><span>Owner</span></div>
          <Settings size={15} className={s.mute} />
        </div>
      </aside>

      {/* ---- main ---- */}
      <main className={s.main}>
        <header className={s.top}>
          <label className={s.search}><span><Search size={15} /></span><input placeholder="Search" /></label>
          <div className={s.topRight}>
            <span className={s.sync}><Clock size={14} />{NOW.time}</span>
            <button className={s.round} aria-label="Messages"><MessageCircle size={17} /></button>
            <button className={s.round} aria-label="Notifications"><Bell size={17} /><i /></button>
          </div>
        </header>

        <div className={s.hello}>
          <h1>Hello, {USER.name}!</h1>
          <div className={s.helloRight}>
            <span className={s.ctl}><CalendarDays size={15} />{NOW.label}<span className={s.ctlSep} />Week<ChevronDown size={14} /></span>
            <span className={s.ctl}><SlidersHorizontal size={15} />Filter</span>
            <span className={s.ctl}><Download size={15} />Export</span>
          </div>
        </div>

        <div className={s.grid}>
          <div className={s.left}>
            {/* AI assistant — first */}
            <section className={`${s.glass} ${s.ai}`}>
              <div className={s.cardHead}><span className={s.hIcon}><Sparkles size={14} /></span>AI assistant<CircleHelp size={15} className={s.headEnd} /></div>
              <div className={s.aiBody}>
                <div className={s.aiNum}><CountUp value={d.needsYou} /></div>
                <div className={s.aiLabel}>need you</div>
                <div className={s.chips}>{chips.map((c) => <button key={c} className={s.chip}>{c}</button>)}</div>
              </div>
              <label className={s.ask}><input placeholder="Ask anything…" /><button aria-label="Send"><SendHorizontal size={15} /></button></label>
            </section>

            <section className={`${s.glass} ${s.agents}`} style={{ animationDelay: '120ms' }}>
              <div className={s.cardHead}><span className={s.hIcon}><Bot size={14} /></span>Agents<span className={s.liveTag}><i className="anim-ping" />{d.running} live</span></div>
              <div className={s.agentBox}>
                <div><b>${runCost.toFixed(2)}</b><span>run cost</span></div>
                <div className={s.agentSplit}>
                  <span><b>{d.review}</b>review</span>
                  <span className={d.failed ? s.bad : ''}><b>{d.failed}</b>failed</span>
                  <span><b>{d.queued}</b>queued</span>
                </div>
              </div>
              <ul className={s.runs}>
                {d.runs.slice(0, 4).map((r) => (
                  <li key={r.id}>
                    <BrandChip id={r.brand} size={24} radius={7} />
                    <span className={s.runTask}>{r.task}</span>
                    <em className={s['r_' + r.state]}>{runWord[r.state]}</em>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <div className={s.right}>
            <div className={s.kpis}>
              <section className={s.glass} style={{ animationDelay: '60ms' }}>
                <div className={s.cardHead}><span className={s.hIcon}><Clock size={14} /></span>Committed</div>
                <div className={s.kpiRow}>
                  <b className={s.kpiNum}><CountUp value={d.committed} decimals={1} suffix="h" /></b>
                  {d.over > 0 ? <em className={s.dBad}>+{fmtH(d.over)} over</em> : <em className={s.dOk}>Fits</em>}
                </div>
                <span className={s.kpiSub}>of {fmtH(d.available)} free</span>
              </section>
              <section className={s.glass} style={{ animationDelay: '120ms' }}>
                <div className={s.cardHead}><span className={s.hIcon}><FolderKanban size={14} /></span>Projects</div>
                <div className={s.kpiRow}>
                  <b className={s.kpiNum}><CountUp value={d.active} /></b>
                  {atRisk > 0 ? <em className={s.dWarn}>{atRisk} at risk</em> : <em className={s.dOk}>All on</em>}
                </div>
                <span className={s.kpiSub}>{d.blocked} blocked · {d.dueSoon} due ≤ 7d</span>
              </section>
              {rel ? (
                <section className={s.glass} style={{ animationDelay: '180ms' }}>
                  <div className={s.cardHead}><span className={s.hIcon}><Flag size={14} /></span>{rel.version} release</div>
                  <div className={s.kpiRow}>
                    <b className={s.kpiNum}><CountUp value={passRate} decimals={1} suffix="%" /></b>
                    <em className={s.dBad}>{rel.blockers} blockers</em>
                  </div>
                  <span className={s.kpiSub}>Go / no-go {rel.decision}</span>
                </section>
              ) : (
                <section className={s.glass} style={{ animationDelay: '180ms' }}>
                  <div className={s.cardHead}><span className={s.hIcon}><Target size={14} /></span>{d.goals[0]?.label ?? 'Goal'}</div>
                  {d.goals[0] ? (
                    <>
                      <div className={s.kpiRow}>
                        <b className={s.kpiNum}>{d.goals[0].unit}<CountUp value={d.goals[0].current} /></b>
                        <em className={s.dOk}>{pct(d.goals[0].current, d.goals[0].target)}%</em>
                      </div>
                      <span className={s.kpiSub}>of {d.goals[0].unit}{d.goals[0].target.toLocaleString('en-US')}</span>
                    </>
                  ) : null}
                </section>
              )}
            </div>

            <section className={`${s.glass} ${s.chart}`} style={{ animationDelay: '220ms' }}>
              <div className={s.cardHead}>
                <span className={s.hIcon}><Layers size={14} /></span>Throughput
                <span className={s.legend}><span><i style={{ background: 'var(--k2)' }} />Done</span><span><i style={{ background: 'var(--k1)' }} />4-wk avg</span></span>
              </div>
              <DualLine a={d.throughput} b={avg} />
            </section>

            <div className={s.bottom}>
              <section className={s.glass} style={{ animationDelay: '280ms' }}>
                <div className={s.cardHead}><span className={s.hIcon}><Layers size={14} /></span>{brand ? brandName(brand) : 'Hours by brand'}</div>
                <div className={s.split}>
                  {split.map((p, i) => (
                    <div key={p.key} className={s.splitCol} style={{ flex: `${Math.max(0.6, p.v / splitTotal)} 1 0` }}>
                      <div className={s.pin} style={{ height: 34 + (2 - Math.min(i, 2)) * 22 }}><span>{fmtH(p.v)}</span></div>
                      <div className={`${s.capsule} ${i === 0 ? s.capsuleOn : ''}`} style={{ animationDelay: `${300 + i * 90}ms` }} />
                      <small>{p.label}</small>
                    </div>
                  ))}
                </div>
              </section>

              <section className={s.glass} style={{ animationDelay: '340ms' }}>
                <div className={s.cardHead}><span className={s.hIcon}><CalendarDays size={14} /></span>This week</div>
                <div className={s.weekTop}>
                  <b><CountUp value={wkPlanned} decimals={1} suffix="h" /></b>
                  <em className={wkPlanned > wkAvail ? s.dBad : s.dOk}>{fmtH(wkAvail)} free</em>
                </div>
                <div className={s.week}>
                  {d.week.map((w) => {
                    const today = w.d === NOW.weekday;
                    const over = w.planned > w.avail;
                    return (
                      <div key={w.d} className={s.wd}>
                        <div className={s.wdTrack}>
                          <span className={`${s.wdBar} ${today ? s.wdOn : ''}`} style={{ height: `${Math.max(6, (w.planned / wkMax) * 72)}%` }}>
                            {over ? <i className={s.wdOver} /> : null}
                            {today ? <span className={s.wdTip}>{fmtH(w.planned)} / {fmtH(w.avail)}</span> : null}
                          </span>
                        </div>
                        <small className={today ? s.xOn : ''}>{w.d}</small>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
