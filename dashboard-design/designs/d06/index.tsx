'use client';

/* 06 One Number: grey canvas, icon nav, one giant centred figure over a barcode density band, hairline-split panels. */

import { useMemo, useState } from 'react';
import {
  ArrowUpRight, Bot, CalendarDays, ChartLine, FolderKanban, House, Inbox, LayoutGrid, Maximize2, Mic, Search, SlidersHorizontal,
  Sparkles, Target, X, Zap,
} from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { brandName, brands, fmtH, heat, pct, USER, weeksLabels, type AgentState } from '@/lib/data';
import { BrandChip, Logo } from '@/components/brand';
import { CountUp } from '@/components/charts';
import s from './styles.module.css';

const TODAY_DOW = 1; // Tue
const ranges = [{ k: 'Week', w: 1 }, { k: 'Month', w: 4 }, { k: 'Quarter', w: 12 }] as const;
const stateLabel: Record<AgentState, string> = { running: 'Running', review: 'Review', failed: 'Failed', queued: 'Queued', waiting: 'Waiting', accepted: 'Accepted' };
const dotCls: Partial<Record<AgentState, string>> = { running: s.dRun, review: s.dReview, failed: s.dFailed, queued: s.dQueued };

function smooth(pts: [number, number][]) {
  let p = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const cx = (x0 + x1) / 2;
    p += ` C${cx.toFixed(1)},${y0.toFixed(1)} ${cx.toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return p;
}

export default function Design() {
  const { s: d, brand, setBrand } = useWorkspace();
  const [range, setRange] = useState<(typeof ranges)[number]>(ranges[1]);
  const tp = d.throughput;
  const W = tp.length;

  /* Daily completions: each week's throughput spread over its days by the activity heatmap's shape. */
  const { daily, weekOf, centers } = useMemo(() => {
    const out: number[] = [], wk: number[] = [], ctr: number[] = [];
    tp.forEach((total, w) => {
      const days = w === tp.length - 1 ? TODAY_DOW + 1 : 7;
      const col = Array.from({ length: days }, (_, k) => heat[k][w] + 1);
      const sum = col.reduce((a, c) => a + c, 0);
      ctr.push(out.length + (days - 1) / 2);
      col.forEach((c) => { out.push((total * c) / sum); wk.push(w); });
    });
    return { daily: out, weekOf: wk, centers: ctr };
  }, [tp]);
  const L = daily.length;
  const maxDay = Math.max(...daily, 1);
  const firstWeek = W - range.w;
  const startIdx = weekOf.indexOf(firstWeek);

  const inRange = tp.slice(firstWeek).reduce((a, c) => a + c, 0);
  const prevRange = firstWeek - range.w >= 0 ? tp.slice(firstWeek - range.w, firstWeek).reduce((a, c) => a + c, 0) : null;
  const delta = prevRange ? Math.round(((inRange - prevRange) / prevRange) * 100) : null;

  const tMin = Math.min(...tp), tMax = Math.max(...tp);
  const trendPts = tp.map((v, w) => [((centers[w] + 0.5) / L) * 1000, 10 + (1 - (v - tMin) / (tMax - tMin || 1)) * 46] as [number, number]);
  const last = trendPts[trendPts.length - 1];
  const wkDelta = tp[W - 2] ? Math.round(((tp[W - 1] - tp[W - 2]) / tp[W - 2]) * 100) : 0;

  const months: { label: string; at: number }[] = [];
  weeksLabels.forEach((l, w) => {
    const m = l.split(' ')[0];
    if (!months.length || months[months.length - 1].label !== m) months.push({ label: m, at: (weekOf.indexOf(w) / L) * 100 });
  });

  /* today: cumulative minutes past free capacity are flagged */
  const freeMin = d.available * 60;
  let acc = 0;
  const bars = d.today.map((t) => { acc += t.est; return { ...t, over: acc > freeMin && t.status !== 'done' }; });
  const maxEst = Math.max(...d.today.map((t) => t.est), 1);

  const decision = d.release ? 1 : 0;
  const needParts = [
    { k: 'Review', v: d.review, cls: s.nReview, hot: false },
    { k: 'Failed', v: d.failed, cls: s.nFailed, hot: d.failed > 0 },
    { k: 'Decision', v: decision, cls: s.nDecision, hot: false },
  ];
  const needSum = needParts.reduce((a, p) => a + p.v, 0);
  const passRate = d.release ? d.release.passed / d.release.tests : 0;
  const goal = d.goals[0];
  const arcVal = d.release ? passRate : goal ? goal.current / goal.target : 0;
  const order: AgentState[] = ['failed', 'review', 'running', 'queued', 'waiting', 'accepted'];
  const runsSorted = [...d.runs].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));

  const R = 74, CX = 90, CY = 84;
  const arcPath = `M${CX - R},${CY} A${R},${R} 0 0 1 ${CX + R},${CY}`;

  return (
    <div className={s.root}>
      <header className={s.top}>
        <Logo size={30} bg="#111" fg="#fff" />
        <nav className={s.icons}>
          <button className={s.ibOn} aria-label="Home"><House size={17} /></button>
          <button className={s.ib} aria-label="Today"><Zap size={17} /></button>
          <button className={s.ib} aria-label="Projects"><FolderKanban size={17} /></button>
          <button className={s.ib} aria-label="Inbox"><Inbox size={17} />{d.needsYou ? <span className={s.ibBadge}>{d.needsYou}</span> : null}</button>
          <button className={s.ib} aria-label="Agents"><Bot size={17} /></button>
          <button className={s.ib} aria-label="Calendar"><CalendarDays size={17} /></button>
          <button className={s.ib} aria-label="Goals"><Target size={17} /></button>
          <button className={s.ib} aria-label="Reports"><ChartLine size={17} /></button>
        </nav>
        <div className={s.topRight}>
          <span className={s.search}><Search size={15} /> Search <kbd>⌘K</kbd></span>
          <span className={s.user}><span className={s.avatar}>{USER.initials}</span><span className={s.userTxt}><b>{USER.name}</b><span>Owner</span></span></span>
        </div>
      </header>

      <div className={s.titleRow}>
        <h1 className={s.title}>Home</h1>
        <span className={s.crumbs}><span><LayoutGrid size={11} /> Workspace</span>/<span>{brand ? brandName(brand) : 'All brands'}</span></span>
        <div className={s.switch}>
          <button className={brand === null ? s.swOn : s.sw} onClick={() => setBrand(null)}>All</button>
          {brands.map((b) => (
            <button key={b.id} className={brand === b.id ? s.swOn : s.sw} onClick={() => setBrand(b.id)}>
              <BrandChip id={b.id} size={20} /> {b.short}
            </button>
          ))}
        </div>
      </div>

      <section className={s.hero}>
        <div className={s.heroBar}>
          <div>
            <div className={s.heroLab}>Throughput · 12 weeks</div>
            <div className={s.legend}>
              <span><i className={s.lgSolid} />In range</span>
              <span><i className={s.lgRing} />Weekly trend</span>
              <span><i className={s.lgDim} />Earlier</span>
            </div>
          </div>
          <div className={s.ranges}>
            {ranges.map((r) => <button key={r.k} className={r.k === range.k ? s.rgOn : s.rg} onClick={() => setRange(r)}>{r.k}</button>)}
          </div>
        </div>

        <div className={s.giant}>
          <div className={s.giantNum}><CountUp value={inRange} /></div>
          <div className={s.giantLab}>
            Tasks shipped
            {delta === null ? <span className={s.deltaFlat}>{range.w} wk</span>
              : <span className={delta >= 0 ? s.delta : s.deltaDown}>{delta >= 0 ? '+' : ''}{delta}%</span>}
          </div>
        </div>

        <div className={s.band}>
          <div className={s.ticks}>
            {daily.map((v, i) => (
              <i key={i} className={i === L - 1 ? s.tNow : i >= startIdx ? s.tOn : undefined}
                style={{ height: `${Math.max(5, (v / maxDay) * 62)}%`, animationDelay: `${i * 7}ms` }} />
            ))}
          </div>
          <svg className={s.trend} viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden>
            <path d={smooth(trendPts)} fill="none" stroke="#111" strokeWidth={2} vectorEffect="non-scaling-stroke" pathLength={1} className="anim-draw" />
            <path d={smooth(trendPts)} fill="none" stroke="#111" strokeOpacity=".12" strokeWidth={8} vectorEffect="non-scaling-stroke" />
          </svg>
          <span className={s.tip} style={{ left: `calc(${(last[0] / 10).toFixed(2)}% - 44px * ${(last[0] / 1000).toFixed(3)})`, top: `${last[1]}%` }}>
            {tp[W - 1]} <small>this wk</small>
            <span className={wkDelta >= 0 ? s.delta : s.deltaDown}>{wkDelta >= 0 ? '+' : ''}{wkDelta}%</span>
            <X size={12} className={s.tipClose} />
          </span>
          <div className={s.yAxis}><span>{Math.round(maxDay / 0.62)}</span><span>{Math.round(maxDay / 0.62 / 2)}</span><span>0</span></div>
        </div>
        <div className={s.scrub}>
          <div className={s.win} style={{ left: `${(startIdx / L) * 100}%`, width: `${((L - startIdx) / L) * 100}%` }} />
        </div>
        <div className={s.months}>{months.map((m) => <span key={m.label} style={{ left: `${m.at}%` }}>{m.label}</span>)}</div>
      </section>

      <div className={s.askWrap}>
        <div className={s.chips}>
          <button className={s.chip}>Why over today? <span><ArrowUpRight size={11} /></span></button>
          <button className={s.chip}>Plan Thursday <span><ArrowUpRight size={11} /></span></button>
        </div>
        <div className={s.ask}>
          <button className={s.askGo} aria-label="Ask"><Sparkles size={18} /></button>
          <span className={s.askTxt}>Ask or capture</span>
          <button className={s.askBtn} aria-label="Voice"><Mic size={16} /></button>
          <button className={s.askBtn} aria-label="Apps"><LayoutGrid size={16} /></button>
        </div>
      </div>

      <section className={s.panels}>
        <div className={s.panel} style={{ animationDelay: '80ms' }}>
          <div className={s.pHead}><span className={s.pLab}>Today</span><span className={s.pIcons}><SlidersHorizontal size={14} /><Maximize2 size={14} /></span></div>
          <div className={s.pNum}><CountUp value={d.committed} decimals={1} suffix="h" /><small>/ {fmtH(d.available)} free</small></div>
          <div className={s.pSub}>
            {d.over > 0 ? <span className={s.redPill}>{fmtH(d.over)} over</span> : <span className={s.greenPill}>Fits</span>}
            <span>{d.todayDone}/{d.today.length} done</span>
          </div>
          <div className={s.dayBars}>
            {bars.map((t, i) => (
              <div key={t.id} className={s.dayBar} title={t.title}>
                <i className={t.status === 'done' ? undefined : t.over ? s.bOver : t.status === 'doing' ? s.bDoing : s.bTodo}
                  style={{ height: `${(t.est / maxEst) * 56}px`, animationDelay: `${i * 60}ms` }} />
                <span>{t.est}</span>
              </div>
            ))}
          </div>
        </div>

        <div className={s.panel} style={{ animationDelay: '140ms' }}>
          <div className={s.pHead}><span className={s.pLab}>Needs you</span><span className={s.pIcons}><SlidersHorizontal size={14} /><Maximize2 size={14} /></span></div>
          <div className={s.pNum}><CountUp value={d.needsYou} /><small>items</small></div>
          {needSum ? (
            <>
              <div className={s.needList}>
                {needParts.map((p) => (
                  <div key={p.k} className={`${s.needRow} ${p.hot ? s.hot : ''}`}><i className={p.cls} /><span>{p.k}</span><b>{p.v}</b></div>
                ))}
              </div>
              <div className={s.needStack}>
                {needParts.filter((p) => p.v > 0).map((p, i) => <i key={p.k} className={p.cls} style={{ flex: p.v, animationDelay: `${i * 90}ms` }} />)}
              </div>
            </>
          ) : <div className={s.clear}>All clear</div>}
        </div>

        <div className={s.panel} style={{ animationDelay: '200ms' }}>
          <div className={s.pHead}>
            <span className={s.pLab}>{d.release ? `Release ${d.release.version}` : goal ? `Goal · ${goal.label}` : 'Release'}</span>
            {d.release ? <span className={s.redPill}>{d.release.blockers} blockers</span> : <span className={s.greyPill}>No release</span>}
          </div>
          <div className={s.arcWrap}>
            <svg width={180} height={96} viewBox="0 0 180 96" aria-hidden>
              <path d={arcPath} fill="none" stroke="#e2e2de" strokeWidth={18} />
              <path d={arcPath} fill="none" stroke="#111" strokeWidth={18} pathLength={1} strokeDasharray={`${arcVal.toFixed(4)} 1`} className={s.arcFg} />
            </svg>
            <div className={s.arcCenter}>
              <div className={s.pNum}>{d.release ? <CountUp value={passRate * 100} decimals={1} suffix="%" /> : <CountUp value={pct(goal?.current ?? 0, goal?.target ?? 1)} suffix="%" />}</div>
            </div>
            <div className={s.arcVals}>
              {d.release ? (
                <>
                  <div><b>{d.release.passed}</b><span>Passed</span></div>
                  <div style={{ textAlign: 'right' }}><b style={{ color: 'var(--red)' }}>{d.release.failed + d.release.flaky}</b><span>Failing</span></div>
                </>
              ) : goal ? (
                <>
                  <div><b>{goal.unit}{goal.current.toLocaleString()}</b><span>Now</span></div>
                  <div style={{ textAlign: 'right' }}><b>{goal.unit}{goal.target.toLocaleString()}</b><span>Target</span></div>
                </>
              ) : null}
            </div>
          </div>
          {d.release ? <div className={s.pSub}><span>Go / no-go {d.release.decision}</span></div> : null}
        </div>

        <div className={s.panel} style={{ animationDelay: '260ms' }}>
          <div className={s.pHead}><span className={s.pLab}>Agents</span><span className={s.pIcons}><SlidersHorizontal size={14} /><Maximize2 size={14} /></span></div>
          <div className={s.pNum}><CountUp value={d.running} /><small><span className={s.liveDot}><i className="anim-ping" /><i /></span> live</small></div>
          <div className={s.runDots}>{d.runs.map((r, i) => <i key={r.id} className={dotCls[r.state]} title={stateLabel[r.state]} style={{ animationDelay: `${i * 50}ms` }} />)}</div>
          <div className={s.runRows}>
            {runsSorted.slice(0, 3).map((r) => (
              <div key={r.id} className={s.runRow}><BrandChip id={r.brand} size={18} /><span>{r.task}</span><span className={`${s.st} ${s['st_' + r.state]}`}>{stateLabel[r.state]}</span></div>
            ))}
          </div>
          <div className={s.spend}>
            <div className={s.spendTop}><span>AI spend</span><span><b>${d.ai.spent.toFixed(2)}</b> / ${d.ai.cap}</span></div>
            <div className={s.spendBar}><i style={{ width: `${pct(d.ai.spent, d.ai.cap)}%` }} /></div>
          </div>
        </div>
      </section>
    </div>
  );
}
