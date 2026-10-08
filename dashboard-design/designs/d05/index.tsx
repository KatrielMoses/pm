'use client';

/* 05 Command Deck: centred segmented nav, full-width dark throughput band with overlay stats, light cards below. */

import { useMemo, useState, type MouseEvent } from 'react';
import { Bell, ChartCandlestick, ChartLine, ChevronRight, CircleAlert, Menu, Plus, Search } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { brands, fmtH, heat, pct, summary, USER, weeksLabels, type BrandId } from '@/lib/data';
import { BrandChip, brandColor, Logo } from '@/components/brand';
import { CountUp, Spark } from '@/components/charts';
import s from './styles.module.css';

const nav = ['Home', 'Today', 'Projects', 'Agents', 'Reports'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TODAY_DOW = 1; // Tue: the current week only has Mon + Tue so far
const ranges = [4, 8, 12] as const;
const stateLabel = { running: 'Running', review: 'Review', failed: 'Failed', queued: 'Queued', waiting: 'Waiting', accepted: 'Accepted' } as const;

export default function Design() {
  const { s: d, brand, setBrand } = useWorkspace();
  const [range, setRange] = useState<(typeof ranges)[number]>(12);
  const [hover, setHover] = useState<number | null>(null);
  const [tab, setTab] = useState<'needs' | 'active'>('needs');

  /* Daily completions: each week's throughput spread over its days by the activity heatmap's shape. */
  const { daily, meta } = useMemo(() => {
    const out: number[] = [];
    const m: { w: number; d: number }[] = [];
    d.throughput.forEach((total, w) => {
      const last = w === d.throughput.length - 1;
      const days = last ? TODAY_DOW + 1 : 7;
      const col = Array.from({ length: days }, (_, k) => heat[k][w] + 1);
      const sum = col.reduce((a, c) => a + c, 0);
      col.forEach((c, k) => { out.push((total * c) / sum); m.push({ w, d: k }); });
    });
    return { daily: out, meta: m };
  }, [d.throughput]);
  const roll = useMemo(() => daily.map((_, i) => {
    const win = daily.slice(Math.max(0, i - 6), i + 1);
    return (win.reduce((a, c) => a + c, 0) / win.length) * 7;
  }), [daily]);

  const start = Math.max(0, daily.length - ((range - 1) * 7 + TODAY_DOW + 1));
  const vis = roll.slice(start);
  const vol = daily.slice(start);
  const n = vis.length;
  const lo = Math.min(...vis), hi = Math.max(...vis);
  const padY = (hi - lo) * 0.18 || 2;
  const yMin = Math.max(0, Math.floor(lo - padY)), yMax = Math.ceil(hi + padY);
  const yOf = (v: number) => 1 - (v - yMin) / (yMax - yMin || 1);
  const pts = vis.map((v, i) => [(i / (n - 1)) * 1000, yOf(v) * 200] as const);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const hi_ = hover ?? n - 1;
  const hm = meta[start + hi_];
  const curWeek = d.throughput.length - 1;
  const tipLeft = Math.min(90, Math.max(10, (hi_ / (n - 1)) * 100));
  const yTicks = Array.from({ length: 4 }, (_, i) => Math.round(yMax - ((yMax - yMin) * i) / 3));
  const lineH = 162;

  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))));
  };

  /* Brand carousel: All + three brands, active one centred. */
  const items = useMemo(() => [{ id: null as BrandId | null, name: 'All brands', short: 'ALL' }, ...brands].map((b) => ({ ...b, x: summary(b.id) })), []);
  const active = brand === null ? 0 : items.findIndex((it) => it.id === brand);

  /* Today's hours as 15-minute ticks, coloured by brand; ticks past free capacity are over. */
  const slots: { c: string; kind: 'task' | 'over' | 'free' }[] = [];
  const freeSlots = Math.round(d.available * 4);
  d.today.forEach((t) => {
    for (let k = 0; k < Math.round(t.est / 15); k++) slots.push({ c: brandColor(t.brand), kind: slots.length < freeSlots ? 'task' : 'over' });
  });
  while (slots.length < freeSlots) slots.push({ c: '', kind: 'free' });
  const byBrand = brands.map((b) => ({ ...b, h: d.today.filter((t) => t.brand === b.id).reduce((a, t) => a + t.est, 0) / 60 })).filter((b) => b.h > 0);

  const needs = d.runs.filter((r) => r.state === 'review' || r.state === 'failed');
  const activeRuns = d.runs.filter((r) => r.state === 'running' || r.state === 'queued');
  const list = tab === 'needs' ? needs : activeRuns;
  const passRate = d.release ? (d.release.passed / d.release.tests) * 100 : 0;
  const goal = d.goals[0];

  return (
    <div className={s.root}>
      <div className={s.frame}>
        <header className={s.top}>
          <Logo size={32} color="#eef1f6" />
          <nav className={s.seg}>{nav.map((x, i) => <a key={x} className={i === 0 ? s.segOn : s.segItem}>{x}</a>)}</nav>
          <div className={s.topRight}>
            <button className={s.sq} aria-label="Search"><Search size={17} /></button>
            <button className={s.sq} aria-label="Notifications"><Bell size={17} /><i /></button>
            <span className={s.avatar}>{USER.initials}</span>
          </div>
        </header>

        <div className={s.selRow}>
          <div className={s.brandSeg}>
            <span className={s.menu}><Menu size={16} /></span>
            <button className={brand === null ? s.bsOn : s.bs} onClick={() => setBrand(null)}>All brands</button>
            {brands.map((b) => (
              <button key={b.id} className={brand === b.id ? s.bsOn : s.bs} onClick={() => setBrand(b.id)}>
                <BrandChip id={b.id} size={22} /> {b.name}
              </button>
            ))}
          </div>
          <div className={s.selRight}>
            <div className={s.rangeSeg}>
              {ranges.map((r) => <button key={r} className={r === range ? s.rgOn : s.rg} onClick={() => { setRange(r); setHover(null); }}>{r}W</button>)}
            </div>
            <div className={s.rangeSeg}>
              <button className={`${s.rgOn} ${s.rgIcon}`} aria-label="Line"><ChartLine size={15} /></button>
              <button className={`${s.rg} ${s.rgIcon}`} aria-label="Candles"><ChartCandlestick size={15} /></button>
            </div>
          </div>
        </div>

        <section className={s.band}>
          <div className={s.stats}>
            <div className={s.stat}>Active projects <b>{d.active}</b></div>
            <div className={s.stat}>Open tasks <b>{d.open}</b></div>
            <div className={s.stat}>Blocked <b className={d.blocked ? s.bad : undefined}>{d.blocked}</b></div>
            <div className={s.stat}>Overdue <b className={d.overdue ? s.bad : undefined}>{d.overdue}</b></div>
            <div className={s.stat}>Due ≤ 7d <b>{d.dueSoon}</b></div>
            <div className={s.stat}>Hours logged <b>{d.hoursActual} / {d.hoursPlanned}h</b></div>
            <div className={s.stat}>AI spend <b>${d.ai.spent.toFixed(2)}</b></div>
          </div>

          <div className={s.yAxis}>{yTicks.map((t) => <span key={t}>{t}</span>)}</div>
          <span className={s.curTag} style={{ top: 10 + yOf(vis[n - 1]) * lineH }}>{Math.round(vis[n - 1])}</span>

          <div className={s.plot} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
            <svg className={s.line} viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden>
              <defs>
                <linearGradient id="d05area" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" style={{ stopColor: 'var(--k1)', stopOpacity: 0.28 }} />
                  <stop offset="1" style={{ stopColor: 'var(--k1)', stopOpacity: 0 }} />
                </linearGradient>
              </defs>
              <path d={`${line} L1000,200 L0,200 Z`} fill="url(#d05area)" className="anim-fade" />
              <path key={range} d={line} fill="none" stroke="#fff" strokeWidth={1.8} strokeLinejoin="round" vectorEffect="non-scaling-stroke" pathLength={1} className="anim-draw" />
            </svg>
            <div className={s.cross} style={{ left: `${(hi_ / (n - 1)) * 100}%` }} />
            <span className={s.knob} style={{ left: `${(hi_ / (n - 1)) * 100}%`, top: yOf(vis[hi_]) * lineH }} />
            <div className={s.tip} style={{ left: `${tipLeft}%` }}>
              <span className={s.tipDate}>{DAYS[hm.d]} · wk {weeksLabels[hm.w]}</span>
              <span className={s.tipRow}><i style={{ background: 'var(--k1)' }} />7-day <b>{Math.round(vis[hi_])}</b></span>
              <span className={s.tipRow}><i style={{ background: 'var(--k2)' }} />Day <b>{vol[hi_].toFixed(1)}</b></span>
            </div>
            <div className={s.vol}>
              {vol.map((v, i) => {
                const m = meta[start + i];
                const cls = i === n - 1 ? s.volCur : m.w === curWeek ? s.volOn : undefined;
                return <i key={`${range}-${i}`} className={cls} style={{ height: `${Math.max(6, (v / Math.max(...vol)) * 100)}%`, animationDelay: `${i * 6}ms` }} />;
              })}
            </div>
          </div>
          <div className={s.xAxis}>
            {meta.slice(start).map((m, i) => (m.d === 0 && (range < 12 || m.w % 2 === 0 || m.w === curWeek)
              ? <span key={i} className={m.w === curWeek ? s.xOn : undefined} style={{ left: `${(i / (n - 1)) * 100}%` }}>{weeksLabels[m.w]}</span>
              : null))}
          </div>
        </section>

        <section className={s.cards}>
          {/* brand carousel */}
          <div className={s.card} style={{ animationDelay: '60ms' }}>
            <div className={s.head}><span className={s.h}>Brands</span><a className={s.viewAll}>View all <span><ChevronRight size={12} /></span></a></div>
            <div className={s.carousel}>
              {items.map((it, i) => {
                const off = ((i - active + items.length + 1) % items.length) - 1;
                const risk = it.x.health.risk + it.x.health.off;
                const c = it.id ? brandColor(it.id) : 'var(--k1)';
                return (
                  <button key={it.short} className={s.slide} onClick={() => setBrand(it.id)} aria-label={it.name}
                    style={{
                      ['--c' as string]: c, left: '50%',
                      transform: `translate(calc(-50% + ${off * 168}px), -50%) scale(${off === 0 ? 1 : 0.86})`,
                      opacity: off === 2 ? 0 : off === 0 ? 1 : 0.5, filter: off === 0 ? 'none' : 'saturate(.5)', zIndex: off === 0 ? 2 : 1,
                    }}>
                    <span className={s.glow} />
                    <span className={s.slideTop}>
                      {it.id ? <BrandChip id={it.id} size={26} /> : <span className={s.slideAll}>{brands.map((b) => <i key={b.id} style={{ background: brandColor(b.id) }} />)}<i style={{ background: '#fff' }} /></span>}
                      <span>{it.short}<small>{it.name}</small></span>
                    </span>
                    <span className={s.slideSpark}><Spark values={it.x.throughput} width={152} height={40} color="rgba(255,255,255,.85)" strokeWidth={1.6} dot={false} /></span>
                    <span className={s.slideNum}>{it.x.open}<span>open</span></span>
                    <span className={`${s.slideSub} ${risk ? s.warn : ''}`}>{risk ? `${risk} at risk` : 'All on track'}</span>
                  </button>
                );
              })}
            </div>
            <div className={s.dots}>
              {items.map((it, i) => <button key={it.short} className={i === active ? s.dotOn : undefined} onClick={() => setBrand(it.id)} aria-label={it.name} />)}
            </div>
            <div className={s.mini}>
              <div className={`${s.miniBox} ${d.needsYou ? s.alert : ''}`}><b>{d.needsYou}</b><span>Needs you</span></div>
              <div className={s.miniBox}><b>{d.dueSoon}</b><span>Due this week</span></div>
              <div className={s.miniBox}><b>{d.todayDone}/{d.today.length}</b><span>Done today</span></div>
              <div className={s.miniBox}><b>{d.throughput[d.throughput.length - 1]}</b><span>Shipped this wk</span></div>
            </div>
          </div>

          {/* hours allocation */}
          <div className={s.card} style={{ animationDelay: '120ms' }}>
            <div className={s.head}><span className={s.h}>Today</span><button className={s.btnDark}><Plus size={14} /> Plan day</button></div>
            <div className={s.hoursTop}>
              <div className={s.hoursMain}>
                <div className={s.bigH}><CountUp value={d.committed} decimals={1} suffix="h" /><small>/ {fmtH(d.available)}</small></div>
                <div className={s.pills}>
                  {d.over > 0 ? <span className={s.overPill}><CircleAlert size={12} /> {fmtH(d.over)} over</span> : <span className={s.okPill}>Fits</span>}
                  <span className={s.muteTxt}>{pct(d.committed, d.available)}% booked</span>
                </div>
              </div>
              <div className={s.legendBox}>
                {byBrand.map((b) => (
                  <div key={b.id} className={s.lg}><BrandChip id={b.id} size={20} /><span>{b.short}<small>{pct(b.h, d.committed)}%</small></span><b>{fmtH(b.h)}</b></div>
                ))}
              </div>
            </div>
            <div className={s.alloc}>
              {slots.map((t, i) => (
                <i key={i} className={t.kind === 'over' ? s.tOver : t.kind === 'free' ? s.tFree : undefined}
                  style={{ background: t.kind === 'task' ? t.c : undefined, animationDelay: `${i * 14}ms` }} />
              ))}
            </div>
            <div className={s.allocFoot}><span>15-min slots</span><span>{freeSlots} free · {Math.max(0, slots.length - freeSlots)} over</span></div>
            <div className={s.tiles2}>
              {d.release ? (
                <div className={s.t2}>
                  <div className={s.t2Lab}>{d.release.version} pass <span className={s.t2Tag}>{d.release.blockers} blockers</span></div>
                  <div className={s.t2Val}><CountUp value={passRate} decimals={1} suffix="%" /><small>{d.release.decision.split(' ')[0]}</small></div>
                  <div className={s.meter}><i style={{ width: `${passRate}%` }} /></div>
                </div>
              ) : goal ? (
                <div className={s.t2}>
                  <div className={s.t2Lab}>{goal.label} <span className={`${s.t2Tag} ${s.neutral}`}>No release</span></div>
                  <div className={s.t2Val}>{goal.unit}{goal.current.toLocaleString()}<small>/ {goal.unit}{goal.target.toLocaleString()}</small></div>
                  <div className={s.meter}><i style={{ width: `${pct(goal.current, goal.target)}%` }} /></div>
                </div>
              ) : null}
              <div className={s.t2}>
                <div className={s.t2Lab}>AI spend <span className={`${s.t2Tag} ${s.neutral}`}>{pct(d.ai.spent, d.ai.cap)}%</span></div>
                <div className={s.t2Val}><CountUp value={d.ai.spent} decimals={2} prefix="$" /><small>/ ${d.ai.cap}</small></div>
                <div className={s.meter}><i style={{ width: `${pct(d.ai.spent, d.ai.cap)}%` }} /></div>
              </div>
            </div>
          </div>

          {/* agents */}
          <div className={s.card} style={{ animationDelay: '180ms' }}>
            <div className={s.head}><span className={s.h}>Agents</span><a className={s.viewAll}>{d.running} live <span><ChevronRight size={12} /></span></a></div>
            <div className={s.toggle}>
              <button className={tab === 'needs' ? s.tgOn : s.tg} onClick={() => setTab('needs')}>Needs you <span className={s.tgCount}>{needs.length}</span></button>
              <button className={tab === 'active' ? s.tgOn : s.tg} onClick={() => setTab('active')}>Active <span className={`${s.tgCount} ${s.calm}`}>{activeRuns.length}</span></button>
            </div>
            {list.length ? (
              <ul className={s.runList}>
                {list.slice(0, 4).map((r, i) => (
                  <li key={r.id} className={s.run} style={{ animationDelay: `${i * 50}ms` }}>
                    <BrandChip id={r.brand} size={34} radius={10} />
                    <span className={s.runTxt}><b>{r.task}</b><span>{r.agent}</span></span>
                    <span className={s.runRight}>
                      <span className={`${s.pill} ${s['p_' + r.state]}`}>{r.state === 'running' ? <i className="anim-pulse" /> : null}{stateLabel[r.state]}</span>
                      <small>${r.cost.toFixed(2)} · {r.mins ? `${r.mins}m` : '—'}</small>
                    </span>
                  </li>
                ))}
              </ul>
            ) : <div className={s.empty}>All clear</div>}
          </div>
        </section>
      </div>
    </div>
  );
}
