'use client';

/* 17 Gauges: pure black, tick-segment gauges, counter tiles with arrow buttons, slanted ribbon, burn badges. */

import { useState, type ReactNode } from 'react';
import {
  ArrowUpRight, Bell, Bot, CalendarDays, Clock3, FolderKanban, Gauge as GaugeIcon, Home, Inbox, Layers, MoreVertical,
  Rocket, Search, Settings, Sparkles, Target,
} from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { brandName, brands, fmtH, pct, USER, type BrandId, type Health } from '@/lib/data';
import { BrandChip, brandColor, Logo, LogoMark } from '@/components/brand';
import { CountUp, Ring, Stack } from '@/components/charts';
import s from './styles.module.css';

const BAD = '#FF4D3D';

/* Tick arc that sweeps 220 degrees. Ticks past `split` turn red (over capacity). */
function TickArc({ size, ticks, lit, split = 1, marker, tickLen, tickW, children }: {
  size: number; ticks: number; lit: number; split?: number; marker?: number; tickLen: number; tickW: number; children?: ReactNode;
}) {
  const cx = size / 2, r = size / 2 - tickW;
  const h = Math.ceil(size / 2 + Math.sin((20 * Math.PI) / 180) * r + tickW + 4);
  const on = Math.round(lit * ticks);
  const splitAt = Math.round(split * ticks);
  const ang = (f: number) => ((160 + f * 220) * Math.PI) / 180;
  const mk = marker !== undefined ? ang(marker) : null;
  return (
    <div className={s.arc} style={{ width: size, height: h }}>
      <svg width={size} height={h} viewBox={`0 0 ${size} ${h}`}>
        {Array.from({ length: ticks }, (_, i) => {
          const a = ang(i / (ticks - 1));
          const r2 = (v: number) => Math.round(v * 100) / 100;
          const x1 = r2(cx + Math.cos(a) * r), y1 = r2(cx + Math.sin(a) * r);
          const x2 = r2(cx + Math.cos(a) * (r - tickLen)), y2 = r2(cx + Math.sin(a) * (r - tickLen));
          const isOn = i < on;
          const over = i >= splitAt;
          const k = Math.round((i / Math.max(1, splitAt - 1)) * 55);
          const stroke = !isOn ? '#232325' : over ? BAD : `color-mix(in srgb, var(--k1) ${100 - k}%, var(--k2))`;
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeWidth={tickW} strokeLinecap="round" className="anim-fade" style={{ animationDelay: `${i * 22}ms` }} />;
        })}
        {mk !== null ? (() => {
          const tipR = r - tickLen - 5, baseR = r - tickLen - 15, da = 0.07;
          const pt = (rr: number, a: number) => `${(cx + Math.cos(a) * rr).toFixed(1)},${(cx + Math.sin(a) * rr).toFixed(1)}`;
          return <polygon points={`${pt(tipR, mk)} ${pt(baseR, mk - da)} ${pt(baseR, mk + da)}`} fill="#fff" className="anim-fade" style={{ animationDelay: '600ms' }} />;
        })() : null}
      </svg>
      <div className={s.arcIn}>{children}</div>
    </div>
  );
}

const nav = [
  { icon: Home, label: 'Dashboard', on: true },
  { icon: Clock3, label: 'Today' },
  { icon: Inbox, label: 'Inbox' },
  { icon: FolderKanban, label: 'Projects' },
  { icon: Bot, label: 'Agents' },
];
const nav2 = [
  { icon: Rocket, label: 'Releases' },
  { icon: Target, label: 'Goals' },
  { icon: CalendarDays, label: 'Calendar' },
];
const healthWord: Record<Health, string> = { on: 'On', risk: 'Risk', off: 'Off' };

export default function Design() {
  const { s: d, brand, setBrand } = useWorkspace();
  const [tab, setTab] = useState<'all' | Health>('all');

  const scale = Math.max(d.available * 1.6, d.committed * 1.12, 1);
  const capPct = pct(d.committed, d.available);
  const aiFrac = d.ai.spent / d.ai.cap;

  const rows = [...d.projects]
    .filter((p) => tab === 'all' || p.health === tab)
    .sort((a, b) => b.hoursActual / b.hoursPlanned - a.hoursActual / a.hoursPlanned)
    .slice(0, 4);

  /* hours split: by brand in the all view, by project inside one brand */
  const split: { key: string; label: string; value: number; color: string; brand: BrandId }[] = d.brand
    ? [...d.projects].sort((a, b) => b.hoursPlanned - a.hoursPlanned).slice(0, 3).map((p, i) => ({
        key: p.id, label: p.name, value: p.hoursPlanned, brand: p.brand,
        color: ['var(--k1)', 'var(--k2)', '#5d5d62'][i],
      }))
    : brands.map((b) => ({
        key: b.id, label: b.name, brand: b.id, color: brandColor(b.id),
        value: d.projects.filter((p) => p.brand === b.id).reduce((a, p) => a + p.hoursPlanned, 0),
      }));
  const splitTotal = split.reduce((a, p) => a + p.value, 0) || 1;
  const goal = d.goals[0];

  return (
    <div className={s.root}>
      <aside className={s.side}>
        <div className={s.logo}><Logo size={34} bg="#1c1c1f" fg="#fff" /></div>
        <button className={s.newBtn}><Sparkles size={16} /> Capture</button>
        <p className={s.sLabel}>Workspace</p>
        <nav className={s.nav}>
          {nav.map((n) => (
            <a key={n.label} className={n.on ? s.navOn : s.navItem}>
              <n.icon size={17} /> {n.label}
              {n.label === 'Inbox' ? <em className={s.navBadge}>{d.needsYou}</em> : null}
            </a>
          ))}
        </nav>
        <p className={s.sLabel}>Plan</p>
        <nav className={s.nav}>
          {nav2.map((n) => <a key={n.label} className={s.navItem}><n.icon size={17} /> {n.label}</a>)}
        </nav>
        <div className={s.plan}>
          <div className={s.planTop}><span><GaugeIcon size={15} /> AI spend</span><button className={s.planBtn}>Limits</button></div>
          <TickArc size={168} ticks={22} lit={aiFrac} marker={0.8} tickLen={12} tickW={5}>
            <b className={s.planNum}><CountUp value={pct(d.ai.spent, d.ai.cap)} suffix="%" /></b>
          </TickArc>
          <div className={s.planFoot}><b>${d.ai.spent.toFixed(2)}</b> of ${d.ai.cap}</div>
        </div>
      </aside>

      <main className={s.main}>
        <header className={s.top}>
          <label className={s.search}><Search size={16} /><input placeholder="Search work, runs, docs" /></label>
          <div className={s.topRight}>
            <div className={s.toggle}>
              <button className={brand === null ? s.tgOn : s.tg} onClick={() => setBrand(null)} aria-label="All brands"><Layers size={16} /></button>
              {brands.map((b) => (
                <button key={b.id} className={brand === b.id ? s.tgOn : s.tg} onClick={() => setBrand(b.id)} aria-label={b.name}>
                  <BrandChip id={b.id} size={22} radius={7} />
                </button>
              ))}
            </div>
            <button className={s.circle} aria-label="Alerts"><Bell size={17} /><i /></button>
            <button className={s.circle} aria-label="Settings"><Settings size={17} /></button>
            <span className={s.avatar}>{USER.initials}</span>
          </div>
        </header>

        <div className={s.grid}>
          <div className={s.left}>
            <section className={`${s.card} anim-fade-up`}>
              <h1 className={s.hello}>Hello {USER.name},</h1>
              <div className={s.tiles}>
                {[
                  { label: 'Needs you', v: d.needsYou, tag: d.failed ? `${d.failed} failed` : null },
                  { label: 'Live agents', v: d.running, tag: d.queued ? `${d.queued} queued` : null, live: true },
                  { label: 'Projects', v: d.active, tag: d.health.off ? `${d.health.off} off track` : null },
                ].map((t, i) => (
                  <div key={t.label} className={`${s.tile} anim-fade-up`} style={{ animationDelay: `${80 + i * 60}ms` }}>
                    <div className={s.tileTop}>
                      <span>{t.label}</span>
                      <button className={s.arrow} aria-label="Open"><ArrowUpRight size={17} /></button>
                    </div>
                    <div className={s.tileBottom}>
                      <b className={s.tileNum}><CountUp value={t.v} /></b>
                      {t.tag ? <span className={s.tagBad}>{t.tag}</span> : t.live ? <span className={s.tagLive}><i className="anim-pulse" />Live</span> : null}
                    </div>
                  </div>
                ))}
              </div>
              <div className={s.bannerRow}>
                <div className={s.banner}>
                  {d.release ? (
                    <>
                      <span className={s.notch}><LogoMark size={18} radius={5} /> {d.release.blockers} blockers</span>
                      <b>{d.release.name}<br />Go / no-go {d.release.decision}</b>
                    </>
                  ) : goal ? (
                    <>
                      <span className={s.notch}><BrandChip id={goal.brand} size={18} radius={5} /> {pct(goal.current, goal.target)}%</span>
                      <b>{goal.label} {goal.unit}{goal.current.toLocaleString()}<br />of {goal.unit}{goal.target.toLocaleString()}</b>
                    </>
                  ) : null}
                </div>
                <button className={s.bannerArrow} aria-label="Open"><ArrowUpRight size={24} /></button>
              </div>
            </section>

            <section className={`${s.card} ${s.listCard} anim-fade-up`} style={{ animationDelay: '200ms' }}>
              <div className={s.listHead}>
                <h2>Projects <em>{d.active}</em></h2>
                <div className={s.seg}>
                  {(['all', 'on', 'risk', 'off'] as const).map((t) => (
                    <button key={t} className={tab === t ? s.segOn : s.segBtn} onClick={() => setTab(t)}>{t === 'all' ? 'All' : healthWord[t]}</button>
                  ))}
                </div>
              </div>
              <div className={s.cols}><span>Project</span><span>Burn</span><span>Estimate</span><span>Actual</span></div>
              <ul className={s.rows}>
                {rows.map((p) => {
                  const burn = p.hoursActual / p.hoursPlanned;
                  const over = burn > 1;
                  const ahead = burn * 100 > p.progress + 15;
                  return (
                    <li key={p.id}>
                      <span className={s.pCell}>
                        <BrandChip id={p.brand} size={40} radius={12} />
                        <span><b>{p.name}</b><small>{brandName(p.brand)} · {p.due}</small></span>
                      </span>
                      <span>
                        <span className={over ? s.burnBad : ahead ? s.burnWarn : s.burn}>
                          {Math.round(burn * 100)}% {over ? 'over' : 'used'}
                          <Ring value={Math.min(1, burn)} size={15} stroke={2.4} color="currentColor" track="rgba(255,255,255,.12)" />
                        </span>
                      </span>
                      <span className={s.hNum}><b>{p.hoursPlanned}</b><small>hours</small></span>
                      <span className={s.hNum}><b className={over ? s.red : ''}>{p.hoursActual}</b><small>hours</small></span>
                    </li>
                  );
                })}
              </ul>
            </section>
          </div>

          <div className={s.right}>
            <div className={`${s.ribbonWrap} anim-fade-up`} style={{ animationDelay: '60ms' }}>
              <div className={s.ribbon}>
                <span className={s.ribbonMark}><LogoMark size={26} bg="var(--k1-ink)" fg="var(--k1)" radius={7} /></span>
                <b><CountUp value={d.throughput[d.throughput.length - 1]} /></b><span>Shipped</span>
              </div>
              <div className={s.under}><Clock3 size={17} /><b>{d.todayDone}/{d.today.length}</b><span>Done today</span></div>
            </div>

            <section className={`${s.card} ${s.gaugeCard} anim-fade-up`} style={{ animationDelay: '140ms' }}>
              <div className={s.cardTop}><h3>Capacity</h3><MoreVertical size={16} className={s.mute} /></div>
              <TickArc size={286} ticks={34} lit={d.committed / scale} split={d.available / scale} marker={d.available / scale} tickLen={30} tickW={8}>
                <b className={`${s.gNum} ${d.over > 0 ? s.red : ''}`}><CountUp value={capPct} suffix="%" /></b>
                <span className={s.gSub}>{fmtH(d.committed)} of {fmtH(d.available)}</span>
              </TickArc>
              <div className={s.gFoot}>
                {d.over > 0 ? <span className={s.overPill}>+{fmtH(d.over)} over</span> : <span className={s.okPill}>Fits</span>}
                <button className={s.outlineBtn}>Rebalance</button>
              </div>
            </section>

            <section className={`${s.card} anim-fade-up`} style={{ animationDelay: '220ms' }}>
              <div className={s.cardTop}><h3>Hours</h3><span className={s.mute}>{fmtH(splitTotal)}</span></div>
              <Stack height={6} gap={4} parts={split.map((p) => ({ value: p.value, color: p.color, label: p.label }))} />
              <ul className={s.split}>
                {split.map((p) => (
                  <li key={p.key}>
                    <BrandChip id={p.brand} size={30} radius={9} />
                    <i style={{ background: p.color }} />
                    <span>{p.label}</span>
                    <em>{pct(p.value, splitTotal)}%</em>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
