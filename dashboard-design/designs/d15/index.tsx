'use client';

/* 15 Editorial: airy white cards, serif display numbers, tall k1 to k2 tile with white bars, thin-tick meters, brand donut. */

import {
  Bell, Bot, ChevronRight, CircleAlert, FolderKanban, Home, Layers, Plus, Rocket, Search, Target, TrendingUp, Zap,
} from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { brandHours, brandName, brands, fmtH, NOW, USER, weeksLabels, type BrandId } from '@/lib/data';
import { BrandChip, brandColor, Logo } from '@/components/brand';
import { CountUp, Ring } from '@/components/charts';
import s from './styles.module.css';

const RED = '#E5484D';
const TODAY = 1;

/* thin vertical-tick meter: parts fill ticks left to right, the rest stays grey */
function TickMeter({ parts, total, n = 64, height = 26, empty = '#E4E7EC' }: { parts: { value: number; color: string }[]; total: number; n?: number; height?: number; empty?: string }) {
  const t = total || 1;
  const bounds: { end: number; color: string }[] = [];
  let acc = 0;
  for (const p of parts) { acc += p.value; bounds.push({ end: Math.round((acc / t) * n), color: p.color }); }
  return (
    <div className={s.ticks} style={{ height }}>
      {Array.from({ length: n }, (_, i) => {
        const b = bounds.find((x) => i < x.end);
        return <i key={i} className="anim-grow-y" style={{ background: b ? b.color : empty, animationDelay: `${i * 9}ms` }} />;
      })}
    </div>
  );
}

const greeting = NOW.minutes < 12 * 60 ? 'Good morning' : NOW.minutes < 18 * 60 ? 'Good afternoon' : 'Good evening';

export default function Design() {
  const { s: d, brand, setBrand } = useWorkspace();
  const tp = d.throughput;
  const cur = tp[tp.length - 1], prev = tp[tp.length - 2];
  const delta = prev ? Math.round(((cur - prev) / prev) * 100) : 0;
  const avg = tp.reduce((a, v) => a + v, 0) / tp.length;
  const tpMax = Math.max(...tp) * 1.15;
  const w = d.week;
  const wPlanned = w.reduce((a, x) => a + x.planned, 0);
  const wAvail = w.reduce((a, x) => a + x.avail, 0);
  const wMax = Math.max(...w.map((x) => Math.max(x.avail, x.planned)), 1);
  const decision = d.release ? 1 : 0;

  /* donut: hours by brand, or by project inside one brand */
  const shades = ['var(--k1)', 'var(--k2)', 'color-mix(in srgb, var(--k1) 45%, #fff)', '#CBD2DC'];
  const donut: { label: string; v: number; color: string; id?: BrandId }[] = brand === null
    ? (Object.keys(brandHours) as BrandId[]).map((b) => ({ label: brandName(b), v: brandHours[b], color: brandColor(b), id: b }))
    : [...d.projects].sort((a, b) => b.hoursPlanned - a.hoursPlanned).slice(0, 4).map((p, i) => ({ label: p.name, v: p.hoursPlanned, color: shades[i] }));
  const dTotal = donut.reduce((a, x) => a + x.v, 0) || 1;

  const nav = [
    { icon: Home, label: 'Home', on: true },
    { icon: FolderKanban, label: 'Projects' },
    { icon: Zap, label: 'Today' },
    { icon: Bot, label: 'Agents' },
    { icon: Target, label: 'Goals' },
  ];

  return (
    <div className={s.root}>
      {/* ---------- sidebar ---------- */}
      <aside className={s.side}>
        <div className={s.logo}><Logo size={28} weight={600} /></div>
        <button className={s.create}><Plus size={15} /> New project</button>
        <p className={s.sideLabel}>General</p>
        <nav className={s.nav}>
          {nav.map((n) => (
            <a key={n.label} className={n.on ? s.navOn : s.navItem}><n.icon size={16} strokeWidth={1.7} /> {n.label}{n.on ? <ChevronRight size={14} className={s.chev} /> : null}</a>
          ))}
        </nav>
        <p className={s.sideLabel}>Brands</p>
        <div className={s.brandList}>
          <button className={brand === null ? s.bOn : s.bItem} onClick={() => setBrand(null)}><span className={s.allDot} /> All brands</button>
          {brands.map((b) => (
            <button key={b.id} className={brand === b.id ? s.bOn : s.bItem} onClick={() => setBrand(b.id)}>
              <BrandChip id={b.id} size={18} radius={5} /> {b.name}
            </button>
          ))}
        </div>
        <div className={s.sideFoot}>
          <span className={s.avatar}>{USER.initials}</span>
          <div><b>{USER.name}</b><small>Owner</small></div>
        </div>
      </aside>

      {/* ---------- main ---------- */}
      <main className={s.main}>
        <header className={s.top}>
          <div className={s.kpis}>
            <div className={s.kpi}><span className={s.kIcon}><Layers size={17} /></span><div><b><CountUp value={d.active} /></b><small>Projects</small></div></div>
            <div className={s.kpi}><span className={s.kIcon}><TrendingUp size={17} /></span><div><b><CountUp value={d.open} /></b><small>Open tasks</small></div></div>
          </div>
          <label className={s.search}><Search size={15} /> <span>Search</span></label>
          <div className={s.topRight}>
            <button className={s.iconBtn} aria-label="Alerts"><Bell size={17} />{d.needsYou ? <i /> : null}</button>
            <span className={s.date}>{NOW.label}</span>
          </div>
        </header>

        <div className={s.greetRow}>
          <h1 className={s.greet}>{greeting}, <em>{USER.name}</em></h1>
          <div className={s.health}>
            <span className={s.hIcon}><Target size={16} /></span>
            <div><small>On track</small><b>{d.health.on}</b></div>
            <div><small>At risk</small><b className={s.amber}>{d.health.risk}</b></div>
            <div><small>Off track</small><b className={d.health.off ? s.red : undefined}>{d.health.off}</b></div>
          </div>
        </div>

        <section className={s.grid}>
          {/* today */}
          <div className={`${s.card} ${s.cToday}`} style={{ animationDelay: '0ms' }}>
            <div className={s.cHead}><span>Today</span>{d.over > 0 ? <span className={s.badPill}><CircleAlert size={12} /> +{fmtH(d.over)} over</span> : <span className={s.okPill}>Fits</span>}</div>
            <div className={s.numRow}>
              <span className={s.serifNum}><CountUp value={d.committed} decimals={1} />h</span>
              <span className={s.of}>of {fmtH(d.available)} free</span>
              <span className={s.side2}>{d.todayDone}/{d.today.length} done</span>
            </div>
            <TickMeter total={Math.max(d.committed, d.available)} parts={[
              { value: Math.min(d.committed, d.available), color: 'var(--k1)' },
              { value: d.over, color: RED },
            ]} />
          </div>

          {/* needs you */}
          <div className={`${s.card} ${s.cNeeds}`} style={{ animationDelay: '60ms' }}>
            <div className={s.cHead}><span>Needs you</span><span className={s.dotLive}><i className="anim-ping" /><i /></span></div>
            <div className={s.numRow}>
              <span className={s.serifNum}><CountUp value={d.needsYou} /></span>
              <span className={s.chips}>
                <span className={s.chip}><i style={{ background: 'var(--k1)' }} />{d.review} review</span>
                <span className={`${s.chip} ${s.chipBad}`}><i style={{ background: RED }} />{d.failed} failed</span>
                {decision ? <span className={s.chip}><i style={{ background: '#111' }} />1 decision</span> : null}
              </span>
            </div>
            <TickMeter total={d.needsYou} n={48} parts={[
              { value: d.review, color: 'var(--k1)' }, { value: d.failed, color: RED }, { value: decision, color: '#111' },
            ]} />
          </div>

          {/* tall gradient tile: week */}
          <div className={s.tall} style={{ animationDelay: '120ms' }}>
            <div className={s.cHead}><span>This week</span><span className={s.glassPill}>{fmtH(wAvail)} free</span></div>
            <div className={s.tallNum}><CountUp value={wPlanned} decimals={wPlanned % 1 ? 1 : 0} />h</div>
            <span className={s.tallSub}>{wPlanned > wAvail ? `+${fmtH(wPlanned - wAvail)} over` : `${fmtH(wAvail - wPlanned)} slack`} · {w.filter((x) => x.planned > x.avail).length} days over</span>
            <div className={s.wBars}>
              {w.map((x, i) => (
                <div key={x.d} className={s.wCol}>
                  <div className={s.wTrack}>
                    {x.planned > x.avail ? <i className={s.wOver} style={{ bottom: `${(x.planned / wMax) * 100}%` }} /> : null}
                    <div className={`${s.wBar} ${i === TODAY ? s.wToday : ''} anim-grow-y`} style={{ height: `${Math.max(4, (x.planned / wMax) * 100)}%`, animationDelay: `${200 + i * 60}ms` }} />
                  </div>
                  <span className={i === TODAY ? s.wLblOn : undefined}>{x.d[0]}</span>
                </div>
              ))}
            </div>
          </div>

          {/* donut */}
          <div className={`${s.card} ${s.cDonut}`} style={{ animationDelay: '120ms' }}>
            <div className={s.cHead}><span>Hours by {brand === null ? 'brand' : 'project'}</span><span className={s.soft}>Week</span></div>
            <div className={s.donutRow}>
              <Ring value={1} size={132} stroke={16} track="#EEF1F5" segments={donut.map((x) => ({ value: x.v / dTotal, color: x.color }))}>
                <div><div className={s.ringNum}>{fmtH(Math.round(dTotal * 10) / 10)}</div><small className={s.soft}>planned</small></div>
              </Ring>
              <ul className={s.dLegend}>
                {donut.map((x) => (
                  <li key={x.label}>
                    <i style={{ background: x.color }} />
                    <span className={s.dName}>{x.label}</span>
                    <b>{fmtH(x.v)}</b>
                    <span className={s.dPct}>{Math.round((x.v / dTotal) * 100)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* release or goals */}
          {d.release ? (
            <div className={`${s.card} ${s.cRel}`} style={{ animationDelay: '180ms' }}>
              <div className={s.cHead}><span><Rocket size={14} /> {d.release.name}</span><span className={s.badPill}>{d.release.blockers} blockers</span></div>
              <div className={s.numRow}>
                <span className={s.serifNum}><CountUp value={(d.release.passed / d.release.tests) * 100} decimals={1} />%</span>
                <span className={s.of}>pass</span>
              </div>
              <TickMeter total={d.release.tests} n={72} parts={[
                { value: d.release.passed, color: 'var(--k1)' }, { value: d.release.failed, color: RED },
                { value: d.release.flaky, color: '#F5A524' }, { value: d.release.skipped, color: '#9AA3AF' },
              ]} />
              <div className={s.relFoot}>
                <span><b>{d.release.failed}</b> failed</span>
                <span><b>{d.release.flaky}</b> flaky</span>
                <span className={s.goNo}>Go / no-go <b>{d.release.decision}</b></span>
              </div>
            </div>
          ) : (
            <div className={`${s.card} ${s.cRel}`} style={{ animationDelay: '180ms' }}>
              <div className={s.cHead}><span><Target size={14} /> Goals</span><span className={s.soft}>{d.goals.length}</span></div>
              {d.goals.map((g) => (
                <div key={g.label} className={s.goal}>
                  <div className={s.numRow}>
                    <span className={s.serifNum}>{g.unit}<CountUp value={g.current} /></span>
                    <span className={s.of}>/ {g.unit}{g.target.toLocaleString()} {g.label}</span>
                  </div>
                  <TickMeter total={g.target} n={72} parts={[{ value: g.current, color: 'var(--k1)' }]} />
                </div>
              ))}
            </div>
          )}

          {/* throughput, wide */}
          <div className={`${s.card} ${s.cThru}`} style={{ animationDelay: '240ms' }}>
            <div className={s.cHead}>
              <span>Shipped / week</span>
              <span className={s.legendInline}><i className={s.lgBar} />done<i className={s.lgAvg} />avg {Math.round(avg)}</span>
            </div>
            <div className={s.tChart}>
              <i className={s.avgLine} style={{ bottom: `calc((100% - 22px) * ${(avg / tpMax).toFixed(3)} + 22px)` }} />
              {tp.map((v, i) => {
                const last = i === tp.length - 1;
                return (
                  <div key={i} className={s.tCol}>
                    <div className={s.tTrack}>
                      {last ? (
                        <span className={s.tip} style={{ bottom: `${(v / tpMax) * 100}%` }}>
                          <b>{v} done</b>
                          <small>{delta >= 0 ? '+' : ''}{delta}% vs last</small>
                        </span>
                      ) : null}
                      <div className={`${last ? s.tBarOn : s.tBar} anim-grow-y`} style={{ height: `${(v / tpMax) * 100}%`, animationDelay: `${i * 40}ms` }} />
                    </div>
                    <span className={last ? s.tLblOn : s.tLbl}>{weeksLabels[i].split(' ')[1]}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* dark: AI + agents */}
          <div className={s.dark} style={{ animationDelay: '300ms' }}>
            <div className={s.cHead}><span>AI spend</span><span className={s.darkPill}><i className="anim-pulse" />{d.running} live</span></div>
            <div className={s.darkNum}>$<CountUp value={d.ai.spent} decimals={2} /><small> / ${d.ai.cap}</small></div>
            <div className={s.darkTicks}>
              <TickMeter total={d.ai.cap} n={44} height={34} empty="#34373E" parts={[{ value: d.ai.spent, color: '#fff' }]} />
            </div>
            <div className={s.darkFoot}>
              <span><b>{d.review}</b> review</span>
              <span><b className={d.failed ? s.redLight : undefined}>{d.failed}</b> failed</span>
              <span><b>{d.queued}</b> queued</span>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
