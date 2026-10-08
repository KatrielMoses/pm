'use client';

/* 13 Two-Tone: dark rounded band (pill nav, accent hero with tick-wave, stacked capsule week) over cream. */

import {
  ArrowRight, ArrowUpRight, Bell, Bot, CalendarDays, ChevronDown, CircleAlert, FolderKanban, Home, Plus, Rocket, Target, ChartColumn,
} from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { brandName, brandHours, brands, fmtH, USER, type BrandId } from '@/lib/data';
import { BrandChip, brandColor, Logo } from '@/components/brand';
import { CountUp, Meter, Ticks } from '@/components/charts';
import s from './styles.module.css';

const nav = [
  { icon: Home, label: 'Home', on: true },
  { icon: FolderKanban, label: 'Projects' },
  { icon: Bot, label: 'Agents' },
  { icon: CalendarDays, label: 'Calendar' },
  { icon: Target, label: 'Goals' },
  { icon: ChartColumn, label: 'Reports' },
];
const stateLabel = { running: 'Running', review: 'Review', failed: 'Failed', queued: 'Queued', waiting: 'Waiting', accepted: 'Accepted' } as const;
const TODAY = 1; // Tue

/* Tick-wave: today's-week planned load, interpolated across 70 ticks with a soft ripple. */
function wave(planned: number[], n = 70) {
  return Array.from({ length: n }, (_, i) => {
    const x = (i / (n - 1)) * (planned.length - 1);
    const a = Math.floor(x), b = Math.min(planned.length - 1, a + 1);
    const v = planned[a] + (planned[b] - planned[a]) * (x - a);
    return Math.round(Math.max(0.3, v) * (0.62 + 0.38 * Math.abs(Math.sin(i * 0.55))) * 1000) / 1000;
  });
}

export default function Design() {
  const { s: d, brand, setBrand } = useWorkspace();
  const w = d.week;
  const ticks = wave(w.map((x) => x.planned));
  const perDay = ticks.length / w.length;
  const maxH = Math.max(...w.map((x) => Math.max(x.avail, x.planned)), 1);
  const chartH = 178;
  const passRate = d.release ? (d.release.passed / d.release.tests) * 100 : 0;
  const goal = d.goals[0];

  /* bubbles: all brands = hours per brand; one brand = its top three projects */
  const bubbleSrc: { label: string; v: number; color: string; ink: string; brand?: BrandId }[] = brand === null
    ? (Object.keys(brandHours) as BrandId[]).map((b) => ({ label: brandName(b), v: brandHours[b], color: brandColor(b), ink: '#fff', brand: b }))
    : [...d.projects].sort((a, b) => b.hoursPlanned - a.hoursPlanned).slice(0, 3)
        .map((p, i) => ({ label: p.name, v: p.hoursPlanned, color: ['var(--k1)', 'var(--k2)', '#2A2C31'][i], ink: ['var(--k1-ink)', 'var(--k2-ink)', '#fff'][i] }));
  const bubbles = [...bubbleSrc].sort((a, b) => b.v - a.v);
  const bTotal = bubbles.reduce((a, b) => a + b.v, 0) || 1;
  const bMax = bubbles[0]?.v || 1;
  const pos = [{ x: 92, y: 118 }, { x: 196, y: 74 }, { x: 200, y: 166 }];
  const maxR = [80, 80, 80];

  return (
    <div className={s.root}>
      {/* ================= dark band ================= */}
      <section className={s.band}>
        <header className={s.top}>
          <Logo size={30} bg="var(--k1)" fg="var(--k1-ink)" color="#fff" />
          <nav className={s.nav}>
            {nav.map((n) => (
              <a key={n.label} className={n.on ? s.navOn : s.navItem}><n.icon size={15} /> {n.label}</a>
            ))}
          </nav>
          <div className={s.topRight}>
            <div className={s.switch}>
              <button className={brand === null ? s.swOn : s.sw} onClick={() => setBrand(null)}>All</button>
              {brands.map((b) => (
                <button key={b.id} className={brand === b.id ? s.swOn : s.sw} onClick={() => setBrand(b.id)} aria-label={b.name}>
                  <BrandChip id={b.id} size={22} radius={7} />
                </button>
              ))}
            </div>
            <button className={s.bell} aria-label="Alerts"><Bell size={16} />{d.needsYou ? <i /> : null}</button>
            <span className={s.user}>{USER.name}<span className={s.avatar}>{USER.initials}</span></span>
          </div>
        </header>

        <div className={s.bandGrid}>
          {/* hero */}
          <div className={`${s.tile} ${s.hero}`}>
            <div className={s.tileHead}>
              <span>Today</span>
              {d.over > 0
                ? <span className={s.heroPill}><CircleAlert size={12} /> +{fmtH(d.over)} over</span>
                : <span className={s.heroPill}>Fits</span>}
            </div>
            <div className={s.heroNum}><CountUp value={d.committed} decimals={1} suffix="h" /><small>/ {fmtH(d.available)} free</small></div>
            <Ticks values={ticks} height={92} gap={2} color="var(--k1-ink)" dim="color-mix(in srgb, var(--k1-ink) 28%, transparent)"
              highlightFrom={Math.floor(perDay * TODAY)} highlightTo={Math.floor(perDay * (TODAY + 1)) - 1} />
            <div className={s.heroFoot}>
              <span className={s.heroPill}><ArrowUpRight size={12} /> {d.todayDone}/{d.today.length}</span>
              <span>done today</span>
            </div>
          </div>

          {/* middle stack */}
          <div className={s.mid}>
            {d.release ? (
              <div className={`${s.tile} ${s.cream}`} style={{ animationDelay: '60ms' }}>
                <div className={s.tileHead}><span>{d.release.version} pass</span><Rocket size={15} /></div>
                <div className={s.creamRow}>
                  <b><CountUp value={passRate} decimals={1} suffix="%" /></b>
                  <div className={s.capsule}><i style={{ width: `${passRate}%` }} /></div>
                </div>
              </div>
            ) : goal ? (
              <div className={`${s.tile} ${s.cream}`} style={{ animationDelay: '60ms' }}>
                <div className={s.tileHead}><span>{goal.label}</span><Target size={15} /></div>
                <div className={s.creamRow}>
                  <b><CountUp value={(goal.current / goal.target) * 100} suffix="%" /></b>
                  <div className={s.capsule}><i style={{ width: `${(goal.current / goal.target) * 100}%` }} /></div>
                </div>
              </div>
            ) : null}
            <div className={`${s.tile} ${s.darkTile}`} style={{ animationDelay: '120ms' }}>
              <div className={s.darkRow}>
                <b className={s.good}><CountUp value={d.needsYou} /></b>
                <span className={s.outPill}>{d.review} review</span>
              </div>
              <span className={s.label}>Needs you</span>
            </div>
            <div className={`${s.tile} ${s.darkTile}`} style={{ animationDelay: '180ms' }}>
              <div className={s.darkRow}>
                <b className={s.red}><CountUp value={d.blocked} /></b>
                <span className={`${s.outPill} ${s.outBad}`}>{d.failed} failed</span>
              </div>
              <span className={s.label}>Blocked</span>
            </div>
          </div>

          {/* week capsules */}
          <div className={`${s.tile} ${s.weekCard}`} style={{ animationDelay: '120ms' }}>
            <div className={s.weekHead}>
              <span className={s.weekTitle}>Week <small>{fmtH(w.reduce((a, x) => a + x.planned, 0))} planned</small></span>
              <span className={s.select}>This week <ChevronDown size={13} /></span>
            </div>
            <div className={s.chart}>
              <div className={s.axis}>
                {[6, 4, 2, 0].map((v) => <span key={v} style={{ bottom: (v / maxH) * chartH }}>{v}h</span>)}
              </div>
              <div className={s.grid}>
                {[6, 4, 2, 0].map((v) => <i key={v} style={{ bottom: (v / maxH) * chartH }} />)}
              </div>
              <div className={s.cols} style={{ height: chartH }}>
                {w.map((x, i) => {
                  const inCap = Math.min(x.planned, x.avail);
                  const over = Math.max(0, x.planned - x.avail);
                  const free = Math.max(0, x.avail - x.planned);
                  const done = Math.min(x.done, inCap);
                  const segs = [
                    { k: 'done', v: done },
                    { k: 'plan', v: inCap - done },
                    { k: 'over', v: over },
                    { k: 'free', v: free },
                  ].filter((g) => g.v > 0);
                  return (
                    <div key={x.d} className={s.col}>
                      {i === TODAY ? (
                        <span className={s.tip} style={{ bottom: (Math.max(x.avail, x.planned) / maxH) * chartH + 10 }}>
                          {fmtH(x.planned)}<i />
                        </span>
                      ) : null}
                      <div className={`${s.stack} anim-grow-y`} style={{ animationDelay: `${i * 60}ms` }}>
                        {segs.length ? segs.slice().reverse().map((g) => (
                          <span key={g.k} className={s['seg_' + g.k]} style={{ height: Math.max(8, (g.v / maxH) * chartH - 3) }} />
                        )) : <span className={s.seg_empty} />}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className={s.days}>
              {w.map((x, i) => <span key={x.d} className={i === TODAY ? s.dayOn : undefined}>{x.d}</span>)}
            </div>
            <div className={s.legend}>
              <span><i className={s.seg_done} />Done</span>
              <span><i className={s.seg_plan} />Planned</span>
              <span><i className={s.seg_over} />Over</span>
              <span><i className={s.seg_free} />Free</span>
            </div>
          </div>
        </div>
      </section>

      {/* ================= cream half ================= */}
      <section className={s.lower}>
        <div className={s.card} style={{ animationDelay: '200ms' }}>
          <div className={s.cardHead}>
            <h2>Agents <span className={s.live}><i className="anim-ping" /><i />{d.running} live</span></h2>
            <button className={s.blackPill}>View all <ArrowRight size={13} /></button>
          </div>
          <ul className={s.runs}>
            {d.runs.slice(0, 5).map((r) => (
              <li key={r.id}>
                <span className={s.runChip} style={{ background: `color-mix(in srgb, ${brandColor(r.brand)} 16%, #fff)` }}><BrandChip id={r.brand} size={22} radius={7} /></span>
                <span className={s.runText}><b>{r.task}</b><small>{r.agent} · {r.mins}m</small></span>
                <span className={`${s.state} ${s['st_' + r.state]}`}>{stateLabel[r.state]}</span>
                <span className={s.cost}>${r.cost.toFixed(2)}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className={`${s.card} ${s.relCard}`} style={{ animationDelay: '260ms' }}>
          <div className={s.deck}>
            <div className={s.backCard}>
              <span>AI spend</span>
              <b>${d.ai.spent.toFixed(2)} <small>/ ${d.ai.cap}</small></b>
            </div>
            {d.release ? (
              <div className={s.frontCard}>
                <div className={s.fcTop}><span>{d.release.name}</span><span className={s.chipIcon}><Rocket size={15} /></span></div>
                <div className={s.fcNum}><CountUp value={d.release.passed} /><small>/{d.release.tests}</small></div>
                <div className={s.fcFoot}>
                  <span className={s.fcBad}><CircleAlert size={12} /> {d.release.blockers} blockers</span>
                  <span>{d.release.flaky} flaky</span>
                  <b>{d.release.decision.split(' ').slice(1).join(' ')}</b>
                </div>
              </div>
            ) : goal ? (
              <div className={s.frontCard}>
                <div className={s.fcTop}><span>{goal.label}</span><span className={s.chipIcon}><Target size={15} /></span></div>
                <div className={s.fcNum}>{goal.unit}<CountUp value={goal.current} /><small>/{goal.unit}{goal.target.toLocaleString()}</small></div>
                <Meter value={goal.current} max={goal.target} height={6} color="var(--k1-ink)" track="color-mix(in srgb, var(--k1-ink) 18%, transparent)" />
              </div>
            ) : null}
          </div>
          <button className={s.bigBtn}>
            {d.release ? <><Rocket size={15} /> Go / no-go · {d.release.decision.split(' ')[0]}</> : <><Plus size={15} /> New release</>}
          </button>
        </div>

        <div className={s.card} style={{ animationDelay: '320ms' }}>
          <div className={s.cardHead}>
            <h2>Hours</h2>
            <button className={s.blackPill}>Week <ChevronDown size={13} /></button>
          </div>
          <div className={s.bubbleWrap}>
            <svg viewBox="0 0 290 236" className={s.bubbles}>
              {bubbles.map((b, i) => {
                const r = Math.max(30, maxR[i] * Math.sqrt(b.v / bMax));
                return (
                  <g key={b.label} className={s.bubble} style={{ animationDelay: `${300 + i * 120}ms` }}>
                    <circle cx={pos[i].x} cy={pos[i].y} r={r} fill={b.color} stroke="#FBFAF5" strokeWidth={4} />
                    <text x={pos[i].x} y={pos[i].y - 2} textAnchor="middle" fill={b.ink} className={s.bPct} style={{ fontSize: r > 50 ? 22 : 15 }}>{Math.round((b.v / bTotal) * 100)}%</text>
                    <text x={pos[i].x} y={pos[i].y + 15} textAnchor="middle" fill={b.ink} className={s.bLbl}>{b.label.length > 12 ? b.label.split(' ')[0] : b.label}</text>
                  </g>
                );
              })}
            </svg>
            <div className={s.bLegend}>
              {bubbles.map((b) => (
                <span key={b.label} className={s.bPill}><i style={{ background: b.color }} />{fmtH(b.v)}</span>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
