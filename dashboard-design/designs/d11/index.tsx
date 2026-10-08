'use client';

/* 11 Day Planner: dark icon rail, greeting, KPI tiles with bars, full-height day timeline on the right. */

import type { CSSProperties } from 'react';
import {
  Bell, Bot, CalendarDays, Check, ChevronRight, FolderKanban, Home, Inbox, Lock, Plus, Target,
} from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { brands, fmtClock, fmtH, NOW, pct, USER, type BrandId } from '@/lib/data';
import { BrandChip, brandColor, LogoMark } from '@/components/brand';
import { CountUp, Meter } from '@/components/charts';
import s from './styles.module.css';

/* Day timeline 09:00 → 18:00. */
const T0 = 9 * 60;
const T1 = 18 * 60;
const HOUR = 62;
const y = (m: number) => ((m - T0) / 60) * HOUR;

const railIcons = [Home, CalendarDays, FolderKanban, Inbox, Bot, Target];
const healthWord = { on: 'on track', risk: 'at risk', off: 'off track' } as const;

type Block = {
  id: string; start: number; end: number; title: string; sub: string; brand: BrandId | null; color: string | null;
  done?: boolean; doing?: boolean; overdue?: boolean; locked?: boolean; agent?: boolean; event?: boolean;
};

export default function Design() {
  const { s: d, brand, setBrand } = useWorkspace();
  const rel = d.release;
  const remaining = d.today.length - d.todayDone;
  const donePct = pct(d.todayDone, d.today.length);
  const loadPct = pct(d.committed, d.available);
  const wkMax = Math.max(...d.week.map((w) => Math.max(w.avail, w.planned)), 1);
  const wkPlanned = d.week.reduce((a, w) => a + w.planned, 0);
  const wkAvail = d.week.reduce((a, w) => a + w.avail, 0);
  const health = [
    { k: 'on' as const, v: d.health.on, c: 'color-mix(in srgb, var(--k1) 35%, #fff)' },
    { k: 'risk' as const, v: d.health.risk, c: '#f5a524' },
    { k: 'off' as const, v: d.health.off, c: '#ef4444' },
  ].filter((h) => h.v > 0);

  const blocks: Block[] = [
    ...d.today.filter((t) => t.start !== undefined).map((t) => ({
      id: t.id, start: t.start!, end: t.start! + t.est, title: t.title, sub: t.project, brand: t.brand, color: brandColor(t.brand),
      done: t.status === 'done', doing: t.status === 'doing', overdue: t.overdue, locked: t.locked, agent: t.agent,
    })),
    ...d.events.map((e) => ({ id: e.id, start: e.start, end: e.end, title: e.title, sub: 'Event', brand: e.brand, color: e.brand ? brandColor(e.brand) : null, event: true })),
  ].sort((a, b) => a.start - b.start);
  const unscheduled = d.today.filter((t) => t.start === undefined);

  /* Week strip: Mon 5 .. Sun 11. */
  const strip = d.week.map((w, i) => ({ ...w, date: NOW.day - 1 + i }));

  return (
    <div className={s.root}>
      {/* ---- dark icon rail ---- */}
      <aside className={s.rail}>
        <LogoMark size={40} bg="rgba(255,255,255,.1)" fg="#fff" radius={12} />
        <nav className={s.railNav}>
          {railIcons.map((I, i) => (
            <button key={i} className={i === 0 ? s.railOn : s.railBtn} aria-label="Nav"><I size={18} /></button>
          ))}
        </nav>
        <button className={s.railBtn} aria-label="Notifications"><Bell size={18} /><i className={s.railDot} /></button>
        <span className={s.avatar}>{USER.initials}</span>
      </aside>

      {/* ---- centre ---- */}
      <main className={s.main}>
        <header className={s.head}>
          <h1>Good morning, <b>{USER.name}</b></h1>
          <span className={s.shift}>Now <b>{NOW.time}</b></span>
        </header>

        <div className={s.switch}>
          <button className={brand === null ? s.swOn : s.sw} onClick={() => setBrand(null)}>All brands</button>
          {brands.map((b) => (
            <button key={b.id} className={brand === b.id ? s.swOn : s.sw} onClick={() => setBrand(b.id)}>
              <BrandChip id={b.id} size={18} radius={6} />{b.name}
            </button>
          ))}
        </div>

        <section className={s.kpis}>
          <article className={`${s.tile} ${s.tileHero}`}>
            <div className={s.tileHead}><span>Tasks today</span><button aria-label="Open"><ChevronRight size={15} /></button></div>
            <div className={s.tileRow}><b><CountUp value={d.todayDone} /></b><span>/ {d.today.length} today</span><em>{donePct}%</em></div>
            <Meter value={d.todayDone} max={Math.max(d.today.length, 1)} color="#fff" track="rgba(255,255,255,.22)" height={8} />
          </article>
          <article className={`${s.tile} ${d.over > 0 ? s.tileOver : ''}`} style={{ animationDelay: '70ms' }}>
            <div className={s.tileHead}><span>Hours</span>{d.over > 0 ? <em className={s.overPill}>+{fmtH(d.over)} over</em> : <em className={s.okPill}>Fits</em>}</div>
            <div className={s.tileRow}><b className={s.kNum}><CountUp value={d.committed} decimals={1} suffix="h" /></b><span>/ {fmtH(d.available)} free</span><em className={d.over > 0 ? s.bad : ''}>{loadPct}%</em></div>
            <Meter value={Math.min(d.committed, d.available)} max={d.available} over={d.over} color="var(--k1)" overColor="#ef4444" track="#e8eaf6" height={8} />
          </article>
          <article className={s.tile} style={{ animationDelay: '140ms' }}>
            <div className={s.tileHead}><span>Needs you</span><button aria-label="Open"><ChevronRight size={15} /></button></div>
            <div className={s.tileRow}><b className={s.kNum}><CountUp value={d.needsYou} /></b><span>{d.review} review · {d.failed} failed</span></div>
            <div className={s.segBar}>
              {Array.from({ length: d.review }, (_, i) => <i key={'r' + i} style={{ background: 'var(--k1)' }} />)}
              {Array.from({ length: d.failed }, (_, i) => <i key={'f' + i} style={{ background: '#ef4444' }} />)}
              {rel ? <i style={{ background: 'var(--k2)' }} /> : null}
            </div>
          </article>
        </section>

        <section className={s.card} style={{ animationDelay: '200ms' }}>
          <div className={s.cardHead}>
            <h2>Week capacity</h2>
            <span className={s.wkSum}>
              <span className={s.legend}><i className={s.lgPlan} />Planned<i className={s.lgFree} />Free</span>
              <b className={wkPlanned > wkAvail ? s.bad : ''}>{fmtH(wkPlanned)}</b><small>/ {fmtH(wkAvail)}</small>
            </span>
          </div>
          <div className={s.week}>
            <div className={s.wkAxis}>{[1, 0.5, 0].map((k) => <span key={k}>{fmtH(Math.round(wkMax * k * 2) / 2)}</span>)}</div>
            {d.week.map((w, i) => {
              const today = w.d === NOW.weekday;
              const over = Math.max(0, w.planned - w.avail);
              const fit = Math.min(w.planned, w.avail);
              return (
                <div key={w.d} className={`${s.day} ${today ? s.dayOn : ''}`}>
                  <div className={s.dayPlot}>
                    {today ? <span className={s.dayTip}>{fmtH(w.planned)}{over > 0 ? <em>+{fmtH(over)}</em> : null}</span> : null}
                    <span className={s.avail} style={{ height: `${(w.avail / wkMax) * 100}%` }} />
                    <span className={s.plan} style={{ height: `${(w.planned / wkMax) * 100}%`, animationDelay: `${i * 60}ms` } as CSSProperties}>
                      {over > 0 ? <i className={s.planOver} style={{ height: `${(over / w.planned) * 100}%` }} /> : null}
                      {w.done > 0 ? <i className={s.planDone} style={{ height: `${(Math.min(w.done, fit) / Math.max(w.planned, 0.1)) * 100}%` }} /> : null}
                    </span>
                  </div>
                  <small>{w.d}</small>
                </div>
              );
            })}
          </div>
        </section>

        <section className={s.bottom}>
          <article className={s.card} style={{ animationDelay: '260ms' }}>
            <div className={s.cardHead}><h2>Projects</h2><span className={s.cardNum}>{d.active}</span></div>
            <div className={s.phases}>
              {health.map((h) => (
                <div key={h.k} className={s.phase} style={{ flex: `${h.v} 1 0` }}>
                  <span className={`${s.phaseTag} ${s['ph_' + h.k]}`}>{h.v} {healthWord[h.k]}</span>
                  <i style={{ background: h.c }} />
                </div>
              ))}
            </div>
            <div className={s.projFoot}>
              <span><b className={d.blocked ? s.bad : ''}>{d.blocked}</b> blocked</span>
              <span><b className={d.overdue ? s.bad : ''}>{d.overdue}</b> overdue</span>
              <span><b>{d.dueSoon}</b> due ≤ 7d</span>
              <span><b>{d.open}</b> open</span>
            </div>
          </article>

          <article className={s.card} style={{ animationDelay: '320ms' }}>
            {rel ? (
              <>
                <div className={s.cardHead}><h2><BrandChip id={rel.brand} size={20} radius={6} />{rel.version}</h2><span className={s.cardNum}>{((rel.passed / rel.tests) * 100).toFixed(1)}%</span></div>
                <div className={s.steps}>
                  {rel.checks.map((c, i) => (
                    <div key={c.label} className={c.done ? s.stepDone : i === rel.checks.findIndex((x) => !x.done) ? s.stepNow : s.step}>
                      <span>{c.done ? <Check size={12} strokeWidth={3} /> : i + 1}</span>
                      <small>{c.label}</small>
                    </div>
                  ))}
                </div>
                <div className={s.projFoot}>
                  <span><b className={s.bad}>{rel.blockers}</b> blockers</span>
                  <span className={s.decide}>Go / no-go {rel.decision.split(' ')[0]}</span>
                </div>
              </>
            ) : (
              <>
                <div className={s.cardHead}><h2>Goals</h2></div>
                {d.goals.map((g) => (
                  <div key={g.label} className={s.goal}>
                    <span className={s.goalLabel}><BrandChip id={g.brand} size={18} radius={5} />{g.label}</span>
                    <b>{g.unit}{g.current.toLocaleString('en-US')}<small> / {g.unit}{g.target.toLocaleString('en-US')}</small></b>
                    <Meter value={g.current} max={g.target} color="var(--k1)" track="#e8eaf6" height={7} />
                  </div>
                ))}
              </>
            )}
          </article>
        </section>
      </main>

      {/* ---- day timeline ---- */}
      <aside className={s.day0}>
        <div className={s.dHead}>
          <h2>Today</h2>
          <span className={s.left}>{remaining} left</span>
          <button className={s.add}><Plus size={15} />Add</button>
        </div>
        <div className={s.strip}>
          {strip.map((w) => (
            <button key={w.d} className={w.d === NOW.weekday ? s.chipOn : s.chip}>
              <b>{w.date}</b><span>{w.d}</span>
              {w.planned > w.avail ? <i className={s.chipOver} /> : null}
            </button>
          ))}
        </div>

        <div className={s.tl} style={{ height: y(T1) + 10 }}>
          {Array.from({ length: (T1 - T0) / 60 + 1 }, (_, i) => T0 + i * 60).map((m) => (
            <div key={m} className={s.hr} style={{ top: y(m) }}><span>{fmtClock(m)}</span></div>
          ))}
          <div className={s.pastShade} style={{ height: y(NOW.minutes) }} />
          {blocks.map((b, i) => {
            const h = Math.max(24, y(b.end) - y(b.start) - 4);
            const compact = h < 44;
            return (
              <div key={b.id}
                className={`${s.blk} ${b.event ? s.blkEvt : ''} ${b.done ? s.blkDone : ''} ${b.doing ? s.blkDoing : ''} ${compact ? s.blkCompact : ''}`}
                style={{ top: y(b.start) + 2, height: h, ['--c' as string]: b.color ?? '#9aa0b8', animationDelay: `${150 + i * 60}ms` } as CSSProperties}>
                <div className={s.blkMain}>
                  <span className={s.blkTitle}>
                    {b.brand && !b.event ? <BrandChip id={b.brand} size={16} radius={5} /> : null}
                    {b.title}
                  </span>
                  {!compact ? <span className={s.blkSub}>{b.sub}</span> : null}
                </div>
                <span className={s.blkTime}>
                  {b.locked ? <Lock size={11} /> : null}
                  {b.agent ? <Bot size={12} /> : null}
                  {b.overdue ? <em className={s.blkBad}>Overdue</em> : null}
                  {b.doing && !b.overdue ? <em className={s.blkNow}>Now</em> : null}
                  {b.done ? <em className={s.blkOk}>Done</em> : null}
                  {fmtClock(b.start)}–{fmtClock(b.end)}
                </span>
              </div>
            );
          })}
          <div className={s.now} style={{ top: y(NOW.minutes) }}><span>{NOW.time}</span></div>
        </div>

        {unscheduled.length > 0 ? (
          <div className={s.unsch}>
            <div className={s.unschHead}>Unscheduled<b>{unscheduled.length}</b></div>
            <div className={s.unschList}>
              {unscheduled.map((t) => (
                <span key={t.id} className={s.unschItem}><BrandChip id={t.brand} size={16} radius={5} />{t.title}<small>{t.est}m</small></span>
              ))}
            </div>
          </div>
        ) : null}
      </aside>
    </div>
  );
}
