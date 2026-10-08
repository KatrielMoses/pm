'use client';

/* 03 Terminal Bento: all-mono, top ticker of per-brand stats (doubles as the brand switcher), flat square tiles. */

import { useMemo, useState } from 'react';
import { ArrowUpRight, EllipsisVertical, Grip } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { brands, NOW, summary, USER, weeksLabels, type BrandId } from '@/lib/data';
import { contrast, inkOn } from '@/lib/kits';
import { BrandChip } from '@/components/brand';
import { CountUp, Ring } from '@/components/charts';
import s from './styles.module.css';

const stateWord = { running: 'RUN', review: 'REVIEW', failed: 'FAILED', queued: 'QUEUED', waiting: 'WAIT', accepted: 'OK' } as const;
const kindWord = { done: 'DONE', risk: 'RISK', decision: 'DECIDE' } as const;
const ranges = [4, 8, 12] as const;
const one = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export default function Design() {
  const { s: d, brand, setBrand, theme } = useWorkspace();
  const [range, setRange] = useState<(typeof ranges)[number]>(8);
  const all = useMemo(() => summary(null), []);
  const per = useMemo(() => brands.map((b) => ({ ...b, x: summary(b.id) })), []);

  const tp = d.throughput.slice(-range);
  const labels = weeksLabels.slice(-range);
  const tpMax = Math.max(...tp, 1);
  const cur = tp[tp.length - 1];
  const prev = tp[tp.length - 2] ?? cur;
  const delta = prev ? Math.round(((cur - prev) / prev) * 100) : 0;

  // Second filled tile uses a raw logo colour (not the accent) that still reads on the dark canvas.
  const rawIdx = theme.raw.findIndex((c) => c.toLowerCase() !== theme.accent.toLowerCase() && contrast(c, '#1a1a1d') >= 3);
  const rawBg = rawIdx >= 0 ? `var(--kraw${rawIdx + 1})` : 'var(--k2)';
  const rawInk = rawIdx >= 0 ? inkOn(theme.raw[rawIdx]) : 'var(--k2-ink)';

  const passRate = d.release ? (d.release.passed / d.release.tests) * 100 : 0;
  const goal = d.goals[0];
  const healthSegs = [
    { value: d.health.on / Math.max(1, d.active), color: 'var(--k1)' },
    { value: d.health.risk / Math.max(1, d.active), color: '#e8b04a' },
    { value: d.health.off / Math.max(1, d.active), color: '#ef5a4c' },
  ].filter((x) => x.value > 0);

  const pick = (id: BrandId | null) => setBrand(id);

  return (
    <div className={s.root}>
      <header className={s.ticker}>
        <span className={s.gridIcon}><Grip size={20} /></span>
        <span className={s.sep} />
        <button className={brand === null ? s.tickOn : s.tick} onClick={() => pick(null)}>
          <span className={s.tickName}>ALL</span>
          <span className={s.tickCell}><i>TODAY</i><b>{one(all.committed)} / {one(all.available)}H</b></span>
          <span className={s.tickCell}><i>NEEDS</i><b>{all.needsYou}</b></span>
          <span className={s.tickCell}><i>LIVE</i><b>{all.running}</b></span>
        </button>
        <span className={s.sep} />
        {per.map((b) => (
          <button key={b.id} className={brand === b.id ? s.tickOn : s.tick} onClick={() => pick(b.id)}>
            <span className={s.tickName}><BrandChip id={b.id} size={14} radius={3} style={{ fontSize: 0 }} />{b.short}</span>
            <span className={s.tickCell}><i>PROJ</i><b>{b.x.active}</b></span>
            <span className={s.tickCell}><i>RISK</i><b className={b.x.health.risk + b.x.health.off ? s.warnTxt : undefined}>{b.x.health.risk + b.x.health.off}</b></span>
            <span className={s.tickCell}><i>7D</i><b>{b.x.throughput[b.x.throughput.length - 1]}</b></span>
          </button>
        ))}
        <span className={s.user}>
          <span className={s.time}>{NOW.weekday.toUpperCase()} {NOW.day} {NOW.month.toUpperCase()} · {NOW.time}</span>
          <span className={s.avatar}>{USER.initials}</span>
          <span className={s.userTxt}><b>{USER.name.toUpperCase()}</b><i>#OWNER</i></span>
        </span>
      </header>

      <main className={s.bento}>
        <section className={`${s.tile} ${s.load}`} style={{ animationDelay: '0ms' }}>
          <div className={s.lab}>TODAY&apos;S LOAD <EllipsisVertical size={14} /></div>
          {d.over > 0 ? <span className={s.overTag}>+{one(d.over)}H OVER</span> : <span className={s.fitTag}>FITS</span>}
          <div className={s.frac}><span className={s.num}><CountUp value={d.committed} decimals={1} /></span><span className={s.of}>/ {one(d.available)}H</span></div>
        </section>

        <section className={`${s.tile} ${s.done}`} style={{ animationDelay: '50ms' }}>
          <div className={s.lab}>DONE TODAY <EllipsisVertical size={14} /></div>
          <div className={s.frac}><span className={s.num}><CountUp value={d.todayDone} /></span><span className={s.of}>/ {d.today.length}</span></div>
        </section>

        <section className={`${s.tile} ${s.needs}`} style={{ animationDelay: '100ms' }}>
          <div className={s.lab}>NEEDS YOU <EllipsisVertical size={14} /></div>
          <div className={s.frac}><span className={s.numXL}><CountUp value={d.needsYou} /></span><span className={s.of}>{d.needsYou ? 'OPEN' : 'CLEAR'}</span></div>
          <div className={s.rows}>
            <div><span>REVIEW</span><b>{d.review}</b></div>
            <div className={d.failed ? s.rowBad : undefined}><span>FAILED</span><b>{d.failed}</b></div>
            <div><span>DECISION</span><b>{d.release ? 1 : 0}</b></div>
          </div>
        </section>

        <section className={`${s.tile} ${s.thru}`} style={{ animationDelay: '150ms' }}>
          <div className={s.labRow}>
            <span className={s.lab}>SHIPPED / WEEK</span>
            <span className={s.ranges}>
              {ranges.map((r) => <button key={r} className={r === range ? s.rangeOn : s.range} onClick={() => setRange(r)}>{r}W</button>)}
            </span>
          </div>
          <div className={s.thruBody}>
            <div className={s.thruNum}>
              <span className={s.numXL}><CountUp value={cur} /></span>
              <span className={delta >= 0 ? s.up : s.down}>{delta >= 0 ? '+' : ''}{delta}% WOW</span>
            </div>
            <div className={s.bars}>
              {tp.map((v, i) => {
                const last = i === tp.length - 1;
                return (
                  <div key={i} className={s.barCol}>
                    <div className={`${last ? s.barOn : s.bar} anim-grow-y`} style={{ height: `${(v / tpMax) * 82}%`, animationDelay: `${i * 45}ms` }}>
                      {last ? <span className={s.barTip}><b>{v}</b><i>{labels[i].toUpperCase()}</i></span> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section className={`${s.tile} ${s.agents}`} style={{ animationDelay: '200ms' }}>
          <div className={s.labRow}><span className={s.lab}>AGENTS</span><button className={s.arrow} aria-label="Open"><ArrowUpRight size={16} /></button></div>
          <div className={s.frac}>
            <span className={s.num}><CountUp value={d.running} /></span>
            <span className={s.of}><i className={s.liveDot}><i className="anim-ping" /></i>LIVE / {d.runs.length}</span>
          </div>
          <div className={s.rule} />
          <div className={s.lab2}>LATEST RUNS</div>
          <ul className={s.runs}>
            {d.runs.slice(0, 5).map((r) => (
              <li key={r.id}>
                <BrandChip id={r.brand} size={18} radius={3} />
                <span className={s.runTask}>{r.task.toUpperCase()}</span>
                <span className={`${s.st} ${s['st_' + r.state]}`}>{stateWord[r.state]}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className={`${s.tile} ${s.raw}`} style={{ background: rawBg, color: rawInk, animationDelay: '250ms' }}>
          <svg className={s.art} viewBox="0 0 260 180" fill="none" aria-hidden>
            <circle cx="160" cy="40" r="110" stroke="currentColor" strokeOpacity=".35" />
            <path d="M160 -70 V40 L60 140 M160 40 L250 -20" stroke="currentColor" strokeOpacity=".35" />
            <path d="M160 40 L60 140" stroke="currentColor" strokeWidth="2" pathLength={1} className="anim-draw" />
          </svg>
          {d.release ? (
            <>
              <div className={s.rawTitle}>{d.release.version.toUpperCase()}<br />GO / NO-GO<br />{d.release.decision.split(' ')[0].toUpperCase()}</div>
              <div className={s.rawStats}>
                <span>PASS <b>{passRate.toFixed(1)}%</b></span>
                <span>BLOCKERS <b className={s.rawBad}>{d.release.blockers}</b></span>
                <span>FLAKY <b>{d.release.flaky}</b></span>
              </div>
              <div className={s.pager}>
                {d.release.checks.map((c) => <i key={c.label} title={c.label} className={c.done ? s.pgOn : s.pg} />)}
                <span>{d.release.checks.filter((c) => c.done).length}/{d.release.checks.length} CHECKS</span>
              </div>
            </>
          ) : goal ? (
            <>
              <div className={s.rawTitle}>{goal.label.toUpperCase()}<br />{goal.unit}{goal.current.toLocaleString()}<br />/ {goal.unit}{goal.target.toLocaleString()}</div>
              <div className={s.rawStats}><span>NO RELEASE <b>—</b></span><span>GOAL <b>{Math.round((goal.current / goal.target) * 100)}%</b></span></div>
              <div className={s.pager}>
                {Array.from({ length: 10 }, (_, i) => <i key={i} className={i < Math.round((goal.current / goal.target) * 10) ? s.pgOn : s.pg} />)}
              </div>
            </>
          ) : null}
        </section>

        <section className={`${s.tile} ${s.ai}`} style={{ animationDelay: '300ms' }}>
          <div className={s.lab}>AI SPEND <EllipsisVertical size={14} /></div>
          <div className={s.frac}><span className={s.num}><CountUp value={d.ai.spent} decimals={2} /></span><span className={s.of}>/ ${d.ai.cap.toFixed(2)}</span></div>
          <div className={s.flatMeter}><div className="anim-grow-x" style={{ width: `${Math.min(100, (d.ai.spent / d.ai.cap) * 100)}%` }} /></div>
        </section>

        <section className={`${s.tile} ${s.ring}`} style={{ animationDelay: '350ms' }}>
          <Ring value={0} size={196} stroke={5} track="#2c2c31" segments={healthSegs} round={false}>
            <div>
              <div className={s.ringNum}>{d.health.on}<span>/{d.active}</span></div>
              <div className={s.ringLab}>ON TRACK</div>
              <div className={s.ringSub}>
                {d.health.risk ? <span className={s.amber}>RISK {d.health.risk}</span> : null}
                {d.health.off ? <span className={s.red}>OFF {d.health.off}</span> : null}
              </div>
            </div>
          </Ring>
        </section>

        <section className={`${s.tile} ${s.brief}`} style={{ animationDelay: '400ms' }}>
          <div className={s.labRow}><span className={s.lab}>BRIEFING · {NOW.time}</span><button className={s.arrowDark} aria-label="Open"><ArrowUpRight size={16} /></button></div>
          <ul className={s.briefList}>
            {d.briefing.map((b) => (
              <li key={b.id}>
                <span className={`${s.kind} ${s['k_' + b.kind]}`}>{kindWord[b.kind]}</span>
                <span className={s.briefTxt}>{b.text.toUpperCase()}</span>
                <span className={s.leader} />
                <span className={s.src}>{b.source.toUpperCase()}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
