'use client';

/* 20 Orbit: light canvas, mixed dark + white tiles, gradient barcode chart, orbit hero tile, dot matrices, pill rows. */

import { Bell, Bot, Check, CircleAlert, Hourglass, Menu, MoreHorizontal, Plus, Minus, Search, Sparkles, Play, Clock3, ArrowUpRight } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { brands, brandShort, fmtH, NOW, pct, throughput, weeksLabels, type BrandId, type Run } from '@/lib/data';
import { BrandChip, brandColor, LogoMark } from '@/components/brand';
import { CountUp, Ring, series } from '@/components/charts';
import s from './styles.module.css';

const BAD = '#F04438';
const WARN = '#F5A524';
const stateWord: Record<Run['state'], string> = { running: 'Running', review: 'Review', failed: 'Failed', queued: 'Queued', waiting: 'Waiting', accepted: 'Accepted' };
const stateRank: Record<Run['state'], number> = { failed: 0, review: 1, running: 2, waiting: 3, queued: 4, accepted: 5 };
const ORBIT_R = [70, 120, 170];
const ORBIT_A = [12, -22, -38];
const days = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/* Columns of dots; each value is a column height. */
function DotMatrix({ values, max = 5, color, size = 6, gap = 3, dim = 'rgba(127,127,127,.16)' }: { values: number[]; max?: number; color: string; size?: number; gap?: number; dim?: string }) {
  return (
    <span className={s.matrix} style={{ gap }}>
      {values.map((v, c) => (
        <span key={c} className={s.mCol} style={{ gap }}>
          {Array.from({ length: max }, (_, r) => {
            const on = max - r <= v;
            return <i key={r} className="anim-pop" style={{ width: size, height: size, background: on ? color : dim, animationDelay: `${(c * max + r) * 10}ms` }} />;
          })}
        </span>
      ))}
    </span>
  );
}

const scaleTo = (xs: number[], n: number) => { const m = Math.max(...xs, 1); return xs.map((x) => Math.max(1, Math.round((x / m) * n))); };

export default function Design() {
  const { s: d, brand, setBrand } = useWorkspace();
  const tp = d.throughput;
  const tpNow = tp[tp.length - 1];
  const tpDelta = Math.round(((tpNow - tp[tp.length - 2]) / tp[tp.length - 2]) * 100);
  const seed = brand ? { ma: 3, ax: 5, op: 7 }[brand] : 1;
  const barcode = series(132, seed, 40, 50);

  /* chart geometry (percent units) */
  const lo = Math.min(...tp) * 0.8, hi = Math.max(...tp) * 1.1;
  const pts = tp.map((v, i) => [(i / (tp.length - 1)) * 100, 100 - ((v - lo) / (hi - lo)) * 100] as const);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
  const last = pts[pts.length - 1];
  const peaks = pts.map((p, i) => ({ p, i })).filter(({ i }) => i > 0 && i < tp.length - 1 && tp[i] > tp[i - 1] && tp[i] >= tp[i + 1]);

  const groups: { id: string; label: string; color: string; values: number[] }[] = d.brand
    ? [{ id: d.brand, label: brandShort(d.brand), color: brandColor(d.brand), values: scaleTo(tp, 5) }]
    : brands.map((b) => ({ id: b.id, label: b.short, color: brandColor(b.id), values: scaleTo(throughput[b.id].slice(-6), 5) }));

  const agentRows = [...d.runs].sort((a, b) => stateRank[a.state] - stateRank[b.state]).slice(0, 4);
  const rel = d.release;
  const passRate = rel ? (rel.passed / rel.tests) * 100 : 0;
  const firstOpen = rel ? rel.checks.findIndex((c) => !c.done) : -1;
  const todayIdx = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(NOW.weekday);
  const orbitBrands: BrandId[] = d.brand ? [d.brand] : brands.map((b) => b.id);

  return (
    <div className={s.root}>
      <div className={s.shell}>
        <header className={s.top}>
          <span className={s.logo}>
            <span className={s.logoDots}><i /><i /><i /><i /><i /></span>
            Untitled
          </span>
          <div className={s.switch}>
            <button className={brand === null ? s.swOn : s.sw} onClick={() => setBrand(null)} aria-label="All brands"><LogoMark size={40} bg="#111" fg="#fff" radius={13} /></button>
            {brands.map((b) => (
              <button key={b.id} className={brand === b.id ? s.swOn : s.sw} onClick={() => setBrand(b.id)} aria-label={b.name}><BrandChip id={b.id} size={40} radius={13} /></button>
            ))}
            <span className={s.day}>{NOW.weekday}</span>
          </div>
          <div className={s.topRight}>
            <label className={s.search}><Search size={16} /><input placeholder="Search projects, runs" /></label>
            <button className={s.circle} aria-label="Alerts"><Bell size={17} /><i /></button>
            <button className={s.circleLg} aria-label="Menu"><Menu size={18} /></button>
          </div>
        </header>

        {/* row 1 */}
        <section className={s.row1}>
          <div className={`${s.dark} ${s.chartTile} anim-fade-up`}>
            <div className={s.tileHead}>
              <h3><i className={s.sq} />Throughput</h3>
              <div className={s.tags}>
                <span className={s.tagAccent}>{tpDelta >= 0 ? '↗' : '↘'} {Math.abs(tpDelta)}%</span>
                <span className={s.tagLight}>12w</span>
              </div>
            </div>
            <div className={s.plot}>
              <div className={s.colLabels}>
                {[0, 4, 8, 11].map((i) => <span key={i} style={{ left: `${(i / 11) * 100}%` }}>{weeksLabels[i]}</span>)}
              </div>
              <div className={s.yLabels}><span>{Math.round(hi)}</span><span>{Math.round((hi + lo) / 2)}</span><span>{Math.round(lo)}</span></div>
              <div className={s.area}>
                {[0, 4, 8, 11].map((i) => <span key={i} className={s.vline} style={{ left: `${(i / 11) * 100}%` }} />)}
                <div className={s.barcode}>
                  {barcode.map((v, i) => (
                    <i key={i} className="anim-grow-y" style={{
                      height: `${30 + (v / 90) * 70}%`, animationDelay: `${i * 4}ms`,
                      background: `color-mix(in srgb, ${i < 66 ? 'var(--k2)' : 'var(--k3)'} ${Math.round(Math.abs(66 - i) / 66 * 100)}%, var(--k1))`,
                      opacity: i % 3 === 0 ? 0.5 : 0.9,
                    }} />
                  ))}
                </div>
                <svg className={s.lineSvg} viewBox="0 0 100 100" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="orbitLine" x1="0" x2="1" y1="0" y2="0">
                      <stop offset="0" stopColor="#fff" stopOpacity=".7" />
                      <stop offset=".55" style={{ stopColor: 'var(--k1)' }} />
                      <stop offset="1" stopColor="#fff" />
                    </linearGradient>
                  </defs>
                  {peaks.map(({ p, i }) => (
                    <path key={i} d={`M${p[0] - 3},${p[1] + 9} L${p[0]},${p[1]} L${p[0] + 3},${p[1] + 9} Z`} fill="var(--k1)" className="anim-fade" style={{ animationDelay: `${600 + i * 40}ms` }} />
                  ))}
                  <path d={line} fill="none" stroke="url(#orbitLine)" strokeWidth={1.6} vectorEffect="non-scaling-stroke" pathLength={1} className="anim-draw" />
                </svg>
                <span className={s.endDot} style={{ left: `${last[0]}%`, top: `${last[1]}%` }}><i className="anim-ping" /></span>
                <span className={s.endTip} style={{ top: `${last[1]}%` }}><b>{tpNow}</b> done</span>
              </div>
            </div>
          </div>

          <div className={`${s.orbitTile} anim-fade-up`} style={{ animationDelay: '80ms' }}>
            <div className={s.orbitArt}>
              <span className={s.glowA} /><span className={s.glowB} />
              {ORBIT_R.map((r, i) => <span key={r} className={s.ring} style={{ width: r * 2, height: r * 2, marginLeft: -r, marginTop: -r, animationDuration: `${40 + i * 20}s` }} />)}
              {orbitBrands.map((b, i) => (
                <span key={b} className={s.planetArm} style={{ width: ORBIT_R[i] * 2, height: ORBIT_R[i] * 2, marginLeft: -ORBIT_R[i], marginTop: -ORBIT_R[i], transform: `rotate(${ORBIT_A[i]}deg)` }}>
                  <span className={s.planet} style={{ transform: `rotate(${-ORBIT_A[i]}deg)` }}><BrandChip id={b} size={26} radius={8} /></span>
                </span>
              ))}
              <span className={s.core}><LogoMark size={34} bg="#fff" fg="#111" radius={11} /></span>
            </div>
            <div className={s.glass}>
              <h2>{NOW.month} <span>Focus</span></h2>
              <div className={s.dayTicks}>{days.map((x, i) => <span key={i} className={i === todayIdx ? s.dayOn : ''}>{x}</span>)}</div>
              <ul className={s.links}>
                <li><span className={s.node} /><span className={s.linkPill}>Needs you <b>{d.needsYou}</b></span></li>
                <li><span className={s.node} /><span className={s.linkPill}>Live <b>{d.running}</b></span></li>
                <li><span className={s.node} /><span className={`${s.linkPill} ${d.over > 0 ? s.linkHot : ''}`}>{d.over > 0 ? <>Over <b>+{fmtH(d.over)}</b></> : <>Fits <b>{fmtH(d.committed)}</b></>}</span></li>
              </ul>
            </div>
          </div>
        </section>

        {/* row 2 */}
        <section className={s.row2}>
          <div className={`${s.white} ${s.capTile} anim-fade-up`} style={{ animationDelay: '140ms' }}>
            <div className={s.capTop}>
              <div className={s.tileHead}>
                <h3><i className={s.sq} />Capacity</h3>
                <span className={s.dotsMenu}><i /><i className={s.dotOn} /><i /></span>
              </div>
              <div className={s.bigRow}>
                <b className={s.bigNum}><CountUp value={d.committed} decimals={1} /><small>/{fmtH(d.available)}</small></b>
                {d.over > 0 ? <span className={s.pillBad}>+{fmtH(d.over)} over</span> : <span className={s.pillOk}>Fits</span>}
              </div>
              <span className={s.cap}>Committed today</span>
              <div className={s.capNav}>
                <span className={s.cap}>Shipped / week</span>
                <span className={s.navBtns}><button aria-label="Prev"><Minus size={14} /></button><button className={s.navDark} aria-label="Next"><Plus size={14} /></button></span>
              </div>
              <div className={s.groups}>
                {groups.map((g) => (
                  <span key={g.id} className={s.group}>
                    <DotMatrix values={g.values} color={g.color} />
                    <small>{g.label}</small>
                  </span>
                ))}
              </div>
            </div>
            <div className={s.capSplit}>
              <div>
                <b className={s.midNum}><CountUp value={d.active} /></b>
                <span className={s.cap}>Projects</span>
                <div className={s.health}>
                  <span><i style={{ background: 'var(--k1)' }} />{d.health.on} on</span>
                  <span><i style={{ background: WARN }} />{d.health.risk} risk</span>
                  <span><i style={{ background: BAD }} />{d.health.off} off</span>
                </div>
              </div>
              <div>
                <div className={s.splitTop}><b className={s.midNum}><CountUp value={d.todayDone} /><small>/{d.today.length}</small></b><span className={s.tagMini}>{pct(d.todayDone, d.today.length)}%</span></div>
                <span className={s.cap}>Done today</span>
                <div className={s.todayBar}>{d.today.map((t) => <i key={t.id} className={t.status === 'done' ? s.tbDone : t.status === 'doing' ? s.tbDoing : ''} />)}</div>
              </div>
            </div>
          </div>

          <div className={s.midCol}>
            <div className={`${s.agentTile} anim-fade-up`} style={{ animationDelay: '200ms' }}>
              <div className={s.tileHead}>
                <h3><i className={s.sq} />Agents</h3>
                <span className={s.hg}><Hourglass size={15} /></span>
              </div>
              <ul className={s.pills}>
                {agentRows.map((r, i) => (
                  <li key={r.id} className={r.state === 'failed' ? s.pillRowBad : ''}>
                    <span className={s.prText}><b>{r.task}</b><small><BrandChip id={r.brand} size={12} radius={3} /> {r.agent}</small></span>
                    <DotMatrix values={scaleTo(series(5, i + seed, 3, 4), 4)} max={4} size={4} gap={2} color={r.state === 'failed' ? BAD : 'var(--k1)'} dim="rgba(0,0,0,.1)" />
                    <span className={`${s.prState} ${s['st_' + r.state]}`}>{stateWord[r.state]}</span>
                    <span className={s.prIcon}>{r.state === 'failed' ? <CircleAlert size={15} /> : r.state === 'running' ? <Play size={14} /> : r.state === 'review' ? <Check size={15} /> : <Clock3 size={14} />}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className={`${s.spendTile} anim-fade-up`} style={{ animationDelay: '260ms' }}>
              <div>
                <span className={s.capLight}>AI spend</span>
                <b className={s.spendNum}><CountUp value={d.ai.spent} decimals={2} prefix="$" /><small>/${d.ai.cap}</small></b>
              </div>
              <DotMatrix values={scaleTo(series(8, seed + 2, 4, 5), 5)} max={5} size={4} gap={3} color="var(--k2)" dim="rgba(255,255,255,.1)" />
              <Ring value={d.ai.spent / d.ai.cap} size={74} stroke={7} color="var(--k1)" track="rgba(255,255,255,.1)">
                <span className={s.ringTxt}>{pct(d.ai.spent, d.ai.cap)}%</span>
              </Ring>
            </div>
          </div>

          <div className={`${s.white} ${s.relTile} anim-fade-up`} style={{ animationDelay: '320ms' }}>
            <div className={s.tileHead}>
              <h3><i className={s.sq} />{rel ? rel.name : 'Goals'}</h3>
              <span className={s.more}><MoreHorizontal size={16} /></span>
            </div>
            {rel ? (
              <>
                <div className={s.relMain}>
                  <div>
                    <span className={s.cap}>Pass rate</span>
                    <div className={s.bigRow}>
                      <b className={s.bigNum}><CountUp value={passRate} decimals={1} /><small>%</small></b>
                      <span className={s.pillBad}>{rel.blockers} blockers</span>
                    </div>
                    <div className={s.relDots}>
                      <DotMatrix values={Array.from({ length: 8 }, (_, c) => Math.max(0, Math.min(5, Math.round((rel.passed / rel.tests) * 40) - c * 5)))} color="var(--k1)" size={5} gap={3} />
                      <DotMatrix values={[rel.failed]} max={5} color={BAD} size={5} gap={3} />
                      <DotMatrix values={[rel.flaky]} max={5} color={WARN} size={5} gap={3} />
                    </div>
                    <div className={s.relLegend}><span>{rel.passed} pass</span><span>{rel.failed} fail</span><span>{rel.flaky} flaky</span></div>
                  </div>
                  <span className={s.shield}><Sparkles size={22} /></span>
                </div>
                <ul className={s.checkRows}>
                  {rel.checks.map((c, i) => (
                    <li key={c.label}>
                      <span className={c.done ? s.ckDone : i === firstOpen ? s.ckNow : s.ckOpen}>{c.done ? 'Done' : 'Open'}</span>
                      <span>{c.label}</span>
                      {c.done ? <Check size={14} className={s.ckIcon} /> : null}
                    </li>
                  ))}
                  <li className={s.decision}>
                    <span className={s.ckDark}>Decide</span>
                    <span>Go / no-go {rel.decision}</span>
                    <span className={s.decIcon}><ArrowUpRight size={15} /></span>
                  </li>
                </ul>
              </>
            ) : (
              <>
                {d.goals.map((g) => (
                  <div key={g.label} className={s.relMain}>
                    <div>
                      <span className={s.cap}>{g.label}</span>
                      <div className={s.bigRow}>
                        <b className={s.bigNum}>{g.unit}<CountUp value={g.current} /><small>/{g.unit}{g.target.toLocaleString()}</small></b>
                      </div>
                      <div className={s.relDots}>
                        <DotMatrix values={Array.from({ length: 10 }, (_, i) => (i < Math.round((g.current / g.target) * 10) ? 5 : 0))} color="var(--k1)" size={5} gap={3} />
                      </div>
                      <div className={s.relLegend}><span>{pct(g.current, g.target)}% of target</span></div>
                    </div>
                    <span className={s.shield}><Sparkles size={22} /></span>
                  </div>
                ))}
                <ul className={s.checkRows}>
                  {[...d.projects].sort((a, b) => a.dueDays - b.dueDays).slice(0, 3).map((p) => (
                    <li key={p.id}>
                      <span className={p.health === 'on' ? s.ckDone : p.health === 'risk' ? s.ckNow : s.ckBad}>{p.health === 'on' ? 'On' : p.health === 'risk' ? 'Risk' : 'Off'}</span>
                      <span>{p.name}</span>
                      <small className={s.due}>{p.due}</small>
                    </li>
                  ))}
                  <li className={s.decision}>
                    <span className={s.ckDark}>Next</span>
                    <span>{d.dueSoon} due this week</span>
                    <span className={s.decIcon}><Bot size={15} /></span>
                  </li>
                </ul>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
