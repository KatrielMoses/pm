'use client';

/* 08 Portfolio Map: navy-black Gantt of every project across October, brand team cards, alerts column. */

import type { ReactNode } from 'react';
import {
  Bell, Bot, CalendarDays, Clock, FileText, Flag, FolderKanban, LayoutGrid, ListChecks, Map as MapIcon, Menu,
  MessageSquare, OctagonAlert, Plus, Search, Settings, Timer, Zap,
} from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { brands, brandName, fmtH, NOW, summary, USER, type BrandId, type Project } from '@/lib/data';
import { BrandChip, brandColor, Logo } from '@/components/brand';
import { CountUp, Meter, Spark } from '@/components/charts';
import s from './styles.module.css';

/* Timeline: 1 Oct (day 1) to 7 Nov (day 38). */
const RANGE = 38;
const xp = (day: number) => ((day - 1) / RANGE) * 100;
const ROW = 40;
const BRAND_ORDER: BrandId[] = ['op', 'ma', 'ax'];
/* Dependencies (finish → start) drawn as curves. */
const DEPS: [string, string][] = [['p1', 'p3'], ['p5', 'p6'], ['p8', 'p9']];
const healthWord = { on: 'On', risk: 'Risk', off: 'Off' } as const;

const nav = [
  { icon: MapIcon, label: 'Map', on: true },
  { icon: LayoutGrid, label: 'Board' },
  { icon: FolderKanban, label: 'Projects' },
  { icon: Bot, label: 'Agents' },
  { icon: CalendarDays, label: 'Calendar' },
  { icon: FileText, label: 'Files' },
  { icon: MessageSquare, label: 'Chat' },
];

function span(p: Project) {
  const due = NOW.day + p.dueDays;
  const dur = Math.min(20, Math.max(8, Math.round(p.hoursPlanned / 2.5)));
  const start = Math.max(1, due - dur);
  return { start, end: due + 1, clipped: due - dur < 1 };
}

const weekend = (day: number) => ((day - 5) % 7 + 7) % 7 >= 5;
const ticks = [1, 5, 12, 19, 26, 33];
const tickLabel = (day: number) => (day > 31 ? `${day - 31} Nov` : `${day} Oct`);

type Alert = { id: string; brand: BrandId; icon: ReactNode; title: string; meta: string; pill: string; tone: 'bad' | 'acc' | 'warn' };

export default function Design() {
  const { s: d, brand, setBrand } = useWorkspace();
  const rows = [...d.projects].sort((a, b) => BRAND_ORDER.indexOf(a.brand) - BRAND_ORDER.indexOf(b.brand) || a.dueDays - b.dueDays);
  const idx = new Map(rows.map((p, i) => [p.id, i]));
  const nowX = xp(NOW.day + NOW.minutes / 1440);

  const alerts: Alert[] = [
    ...d.runs.filter((r) => r.state === 'failed').map((r) => ({ id: r.id, brand: r.brand, icon: <OctagonAlert size={14} />, title: r.task, meta: r.agent, pill: 'Failed', tone: 'bad' as const })),
    ...(d.release ? [{ id: 'rel', brand: d.release.brand, icon: <Flag size={14} />, title: `${d.release.version} go / no-go`, meta: d.release.decision, pill: 'Decide', tone: 'acc' as const }] : []),
    ...d.projects.filter((p) => p.blocked > 0).map((p) => ({ id: 'b' + p.id, brand: p.brand, icon: <OctagonAlert size={14} />, title: p.name, meta: `${p.blocked} blocked`, pill: 'Blocked', tone: 'bad' as const })),
    ...d.runs.filter((r) => r.state === 'review').map((r) => ({ id: r.id, brand: r.brand, icon: <Bot size={14} />, title: r.task, meta: r.agent, pill: 'Review', tone: 'acc' as const })),
  ];

  const brandCards: BrandId[] = brand ? [brand] : BRAND_ORDER;

  return (
    <div className={s.root}>
      {/* ---- sidebar ---- */}
      <aside className={s.side}>
        <div className={s.sideTop}><Menu size={20} /><Logo size={26} /></div>
        <nav className={s.nav}>
          {nav.map((n) => (
            <a key={n.label} className={n.on ? s.navOn : s.navItem}><n.icon size={16} />{n.label}</a>
          ))}
          <a className={s.navAdd}><Plus size={16} />Add section</a>
        </nav>
        <div className={s.sideFoot}>
          <span className={s.avatar}>{USER.initials}</span>
          <span className={s.sideUser}>{USER.name}</span>
          <Settings size={16} className={s.dim} />
        </div>
      </aside>

      {/* ---- main ---- */}
      <main className={s.main}>
        <header className={s.head}>
          <h1>Portfolio map</h1>
          <label className={s.search}><Search size={15} /><input placeholder="Search" /></label>
        </header>

        <div className={s.toolbar}>
          <span className={s.date}><CalendarDays size={15} />{NOW.label}</span>
          <span className={s.rule} />
          <div className={s.seg}>
            <button className={brand === null ? s.segOn : s.segBtn} onClick={() => setBrand(null)}>All</button>
            {brands.map((b) => (
              <button key={b.id} className={brand === b.id ? s.segOn : s.segBtn} onClick={() => setBrand(b.id)}>
                <BrandChip id={b.id} size={16} radius={5} />{b.short}
              </button>
            ))}
          </div>
          <div className={s.zoom}><span>Week</span><span className={s.zoomOn}>Month</span><span>Quarter</span></div>
        </div>

        {/* ---- Gantt (hero) ---- */}
        <section className={s.gantt}>
          <div className={s.months}>
            <span style={{ left: 0 }}>October</span>
            <span style={{ left: `${xp(32)}%` }}>November</span>
          </div>
          <div className={s.plot} style={{ height: rows.length * ROW + 8 }}>
            {Array.from({ length: RANGE }, (_, i) => i + 1).map((day) => (
              <span key={day} className={`${s.col} ${weekend(day) ? s.colWe : ''} ${(day - 5) % 7 === 0 ? s.colMon : ''}`} style={{ left: `${xp(day)}%`, width: `${100 / RANGE}%` }} />
            ))}
            <span className={s.past} style={{ width: `${nowX}%` }} />

            <svg className={s.deps} viewBox={`0 0 100 ${rows.length * ROW}`} preserveAspectRatio="none" style={{ height: rows.length * ROW }}>
              {DEPS.filter(([a, b]) => idx.has(a) && idx.has(b)).map(([a, b]) => {
                const pa = rows[idx.get(a)!], pb = rows[idx.get(b)!];
                const x1 = xp(span(pa).end), x2 = xp(span(pb).start);
                const y1 = idx.get(a)! * ROW + ROW / 2 + 4, y2 = idx.get(b)! * ROW + ROW / 2 + 4;
                return (
                  <path key={a + b} d={`M${x1},${y1} C${x1 + 4},${y1} ${x2 - 4},${y2} ${x2},${y2}`} fill="none" stroke="rgba(255,255,255,.35)"
                    strokeWidth={1.4} vectorEffect="non-scaling-stroke" className="anim-draw" style={{ animationDelay: '700ms' }} />
                );
              })}
            </svg>
            {DEPS.filter(([a, b]) => idx.has(a) && idx.has(b)).flatMap(([a, b]) => [
              <i key={a + b + '1'} className={s.depDot} style={{ left: `${xp(span(rows[idx.get(a)!]).end)}%`, top: idx.get(a)! * ROW + ROW / 2 + 4 }} />,
              <i key={a + b + '2'} className={s.depDot} style={{ left: `${xp(span(rows[idx.get(b)!]).start)}%`, top: idx.get(b)! * ROW + ROW / 2 + 4 }} />,
            ])}

            {rows.map((p, i) => {
              const sp = span(p);
              const c = brandColor(p.brand);
              return (
                <div key={p.id} className={`${s.bar} ${sp.clipped ? s.barClip : ''} ${s['h_' + p.health]}`}
                  style={{
                    top: i * ROW + 8, left: `${xp(sp.start)}%`, width: `${xp(sp.end) - xp(sp.start)}%`, ['--b' as string]: c,
                    background: `linear-gradient(90deg, color-mix(in srgb, ${c} 30%, #23273a) ${p.progress}%, #23273a ${p.progress}%)`,
                    animationDelay: `${120 + i * 55}ms`,
                  }}>
                  <span className={s.barName}>{p.name}</span>
                  <span className={s.barPct}>{p.progress}%</span>
                  <span className={s.hp}><i />{healthWord[p.health]}</span>
                </div>
              );
            })}

            <div className={s.now} style={{ left: `${nowX}%` }}><span>Today</span></div>
          </div>
          <div className={s.axis}>
            {ticks.map((t) => (
              <span key={t} style={{ left: `${xp(t)}%` }}>{tickLabel(t)}</span>
            ))}
          </div>
        </section>

        {/* ---- brand team cards ---- */}
        <section className={`${s.cards} ${brand ? s.cardsOne : ''}`}>
          {brandCards.map((b, i) => {
            const bs = summary(b);
            const live = bs.running;
            return (
              <article key={b} className={s.card} style={{ animationDelay: `${300 + i * 80}ms` }}>
                <div className={s.cardHead}>
                  <BrandChip id={b} size={26} radius={8} />
                  <span className={s.cardTitle}>{brandName(b)}</span>
                  {live > 0 ? <span className={s.live}><i className="anim-ping" />{live} live</span> : <span className={s.idle}>Idle</span>}
                </div>
                <div className={s.teamBody}>
                  <ul className={s.counts}>
                    <li><b className={s.cOff}>{bs.health.off}</b>Off</li>
                    <li><b className={s.cRisk}>{bs.health.risk}</b>Risk</li>
                    <li><b className={s.cOn}>{bs.health.on}</b>On</li>
                  </ul>
                  <div className={s.teamSpark}>
                    <Spark values={bs.throughput} height={62} color={brandColor(b)} fill={brandColor(b)} strokeWidth={2} />
                  </div>
                </div>
                <div className={s.cardFoot}>
                  <span><Clock size={13} />{bs.hoursActual}/{bs.hoursPlanned}h</span>
                  <span><ListChecks size={13} />{bs.open}</span>
                  <span className={bs.review + bs.failed > 0 ? s.footHot : ''}><Bot size={13} />{bs.review + bs.failed}</span>
                </div>
              </article>
            );
          })}

          {brand ? (
            <article className={`${s.card} ${s.weekCard}`} style={{ animationDelay: '380ms' }}>
              <div className={s.cardHead}><span className={s.cardIcon}><Timer size={14} /></span><span className={s.cardTitle}>This week</span></div>
              <div className={s.week}>
                {d.week.map((w) => {
                  const max = Math.max(...d.week.map((x) => Math.max(x.avail, x.planned)), 1);
                  const over = w.planned > w.avail;
                  return (
                    <div key={w.d} className={s.wd}>
                      <div className={s.wdBar}>
                        <span className={s.wdAvail} style={{ height: `${(w.avail / max) * 100}%` }} />
                        <span className={`${s.wdPlan} ${over ? s.wdOver : ''} ${w.d === NOW.weekday ? s.wdToday : ''}`} style={{ height: `${(w.planned / max) * 100}%` }} />
                      </div>
                      <small className={w.d === NOW.weekday ? s.wdLabelOn : ''}>{w.d[0]}</small>
                    </div>
                  );
                })}
              </div>
            </article>
          ) : null}

          <article className={`${s.card} ${s.capCard}`} style={{ animationDelay: '460ms' }}>
            <div className={s.cardHead}><span className={s.cardIcon}><Clock size={14} /></span><span className={s.cardTitle}>Today</span>
              {d.over > 0 ? <span className={s.overPill}>+{fmtH(d.over)} over</span> : <span className={s.okPill}>Fits</span>}
            </div>
            <div className={s.capNum}><CountUp value={d.committed} decimals={1} suffix="h" /><span>/ {fmtH(d.available)}</span></div>
            <Meter value={Math.min(d.committed, d.available)} max={d.available} over={d.over} color="var(--k1)" overColor="#ff4d6a" track="rgba(255,255,255,.07)" height={10} />
            <div className={s.capFoot}><span>{d.todayDone}/{d.today.length} done</span><span>{d.events.length} events</span></div>
          </article>
        </section>
      </main>

      {/* ---- alerts ---- */}
      <aside className={s.alerts}>
        <div className={s.alertHead}><Bell size={16} /><span>Alerts</span><b className={s.alertCount}>{alerts.length}</b></div>
        <div className={s.needs}>
          <b><CountUp value={d.needsYou} /></b><span>Needs you</span>
        </div>
        <ul className={s.alertList}>
          {alerts.slice(0, 7).map((a, i) => (
            <li key={a.id} className={a.tone === 'bad' ? s.alertBad : ''} style={{ animationDelay: `${200 + i * 60}ms` }}>
              <BrandChip id={a.brand} size={32} radius={9} />
              <div className={s.alertText}>
                <span>{a.title}</span>
                <small>{a.icon}{a.meta}</small>
              </div>
              <em className={s['t_' + a.tone]}>{a.pill}</em>
            </li>
          ))}
        </ul>
        <div className={s.spend}>
          <div className={s.spendTop}><Zap size={14} /><span>AI spend</span><b>${d.ai.spent.toFixed(2)}</b></div>
          <Meter value={d.ai.spent} max={d.ai.cap} color="var(--k1)" track="rgba(255,255,255,.07)" height={6} />
          <div className={s.spendFoot}><span>{Math.round((d.ai.spent / d.ai.cap) * 100)}% of ${d.ai.cap}</span><span><i className="anim-pulse" />{d.running} running</span></div>
        </div>
      </aside>
    </div>
  );
}
