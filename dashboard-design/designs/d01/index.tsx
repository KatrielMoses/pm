'use client';

/* 01 Obsidian: charcoal cards, one accent-lit hero, glowing highlighted bar. */

import { Bell, Bot, CalendarDays, ChevronDown, Command, Flag, Gauge, Home, Inbox, Layers, Library, Plus, Search, Target, Zap } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { brands, fmtClock, fmtH, NOW, USER, weeksLabels } from '@/lib/data';
import { BrandChip, Logo } from '@/components/brand';
import { Bars, CountUp, Meter, Ring, Stack } from '@/components/charts';
import s from './styles.module.css';

const nav = [
  { icon: Home, label: 'Home', active: true },
  { icon: Zap, label: 'Today' },
  { icon: Inbox, label: 'Inbox', badge: 6 },
  { icon: Layers, label: 'Projects' },
  { icon: CalendarDays, label: 'Calendar' },
  { icon: Library, label: 'Knowledge' },
  { icon: Target, label: 'Goals' },
  { icon: Gauge, label: 'Reports' },
];

const stateLabel = { running: 'Running', review: 'Review', failed: 'Failed', queued: 'Queued', waiting: 'Waiting', accepted: 'Accepted' } as const;

export default function Design() {
  const { s: d, brand, setBrand } = useWorkspace();
  const tp = d.throughput;
  const passRate = d.release ? (d.release.passed / d.release.tests) * 100 : 0;

  return (
    <div className={s.root}>
      <aside className={s.side}>
        <div className={s.logoRow}><Logo size={30} /></div>
        <button className={s.search}><Search size={15} /> Search <span className={s.kbd}><Command size={11} />K</span></button>
        <nav className={s.nav}>
          {nav.map((n) => (
            <a key={n.label} className={n.active ? s.navOn : s.navItem}>
              <n.icon size={17} /> {n.label}
              {n.badge ? <span className={s.badge}>{n.badge}</span> : null}
            </a>
          ))}
        </nav>
        <p className={s.sideLabel}>Brands</p>
        <div className={s.brandList}>
          <button className={brand === null ? s.brandOn : s.brandItem} onClick={() => setBrand(null)}>
            <span className={s.allMark}>∗</span> All brands
          </button>
          {brands.map((b) => (
            <button key={b.id} className={brand === b.id ? s.brandOn : s.brandItem} onClick={() => setBrand(b.id)}>
              <BrandChip id={b.id} size={20} /> {b.name}
            </button>
          ))}
        </div>
        <div className={s.usage}>
          <div className={s.usageTop}><Bot size={15} /> AI spend</div>
          <div className={s.usageNum}><CountUp value={d.ai.spent} decimals={2} prefix="$" /><span> / ${d.ai.cap}</span></div>
          <Meter value={d.ai.spent} max={d.ai.cap} color="var(--k1)" track="rgba(255,255,255,.08)" height={6} />
        </div>
      </aside>

      <main className={s.main}>
        <header className={s.top}>
          <h1 className={s.hello}>Morning, {USER.name}</h1>
          <div className={s.topRight}>
            <span className={s.date}><CalendarDays size={15} /> {NOW.label}</span>
            <button className={s.iconBtn} aria-label="Notifications"><Bell size={17} /><i className={s.dot} /></button>
            <button className={s.capture}><Plus size={16} /> Capture</button>
            <span className={s.avatar}>{USER.initials}</span>
          </div>
        </header>

        <section className={s.row1}>
          <div className={`${s.card} ${s.hero}`}>
            <div className={s.cardHead}><span className={s.heroIcon}><Zap size={16} /></span> Today <ChevronDown size={14} className={s.muted} /></div>
            <div className={s.heroNum}><CountUp value={d.committed} decimals={1} suffix="h" /><span className={s.heroOf}>/ {fmtH(d.available)} free</span></div>
            <Meter value={d.available} max={d.available} over={d.over} color="var(--k1-ink)" overColor="var(--k1-ink)" track="rgba(0,0,0,.15)" height={8} />
            <div className={s.heroFoot}>
              {d.over > 0 ? <span className={s.warnPill}>+{fmtH(d.over)} over</span> : <span className={s.okPill}>Fits</span>}
              <span>{d.todayDone}/{d.today.length} done</span>
            </div>
          </div>

          <div className={s.card}>
            <div className={s.cardHead}><span className={s.icon}><Flag size={15} /></span> Needs you</div>
            <div className={s.bigNum}><CountUp value={d.needsYou} /></div>
            <div className={s.tags}>
              <span className={s.tag}><b>{d.review}</b> review</span>
              <span className={`${s.tag} ${s.tagBad}`}><b>{d.failed}</b> failed</span>
              {d.release ? <span className={s.tag}><b>1</b> decision</span> : null}
            </div>
          </div>

          <div className={s.card}>
            <div className={s.cardHead}><span className={s.icon}><Layers size={15} /></span> Projects</div>
            <div className={s.bigNum}><CountUp value={d.active} /></div>
            <Stack height={8} parts={[
              { value: d.health.on, color: 'var(--k1)', label: 'On track' },
              { value: d.health.risk, color: '#F5B83D', label: 'At risk' },
              { value: d.health.off, color: '#F05252', label: 'Off track' },
            ].filter((p) => p.value > 0)} />
            <div className={s.legend}>
              <span><i style={{ background: 'var(--k1)' }} />{d.health.on} on</span>
              <span><i style={{ background: '#F5B83D' }} />{d.health.risk} risk</span>
              <span><i style={{ background: '#F05252' }} />{d.health.off} off</span>
            </div>
          </div>
        </section>

        <section className={s.row2}>
          <div className={`${s.card} ${s.chartCard}`}>
            <div className={s.cardHeadRow}>
              <div className={s.cardHead}><span className={s.icon}><Gauge size={15} /></span> Shipped / week</div>
              <span className={s.select}>12 weeks <ChevronDown size={13} /></span>
            </div>
            <Bars
              values={tp} max={Math.max(...tp) * 1.3} highlight={tp.length - 1} height={170} gap={10} radius={8}
              color="rgba(255,255,255,.07)" highlightColor="linear-gradient(180deg, var(--k1), color-mix(in srgb, var(--k1) 20%, transparent))"
              labels={weeksLabels.map((w) => w.split(' ')[1])} labelColor="#8b8e98"
              showValue={(v) => <span className={s.tip}><i />{v} done</span>}
            />
          </div>

          <div className={s.card}>
            <div className={s.cardHeadRow}>
              <div className={s.cardHead}><span className={s.icon}><Bot size={15} /></span> Agents</div>
              <span className={s.liveDot}><i className="anim-ping" />{d.running} live</span>
            </div>
            <ul className={s.runs}>
              {d.runs.slice(0, 5).map((r) => (
                <li key={r.id}>
                  <BrandChip id={r.brand} size={22} />
                  <span className={s.runTask}>{r.task}</span>
                  <span className={`${s.state} ${s['st_' + r.state]}`}>{stateLabel[r.state]}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className={s.row3}>
          <div className={s.card}>
            <div className={s.cardHeadRow}>
              <div className={s.cardHead}><span className={s.icon}><Zap size={15} /></span> Today</div>
              <span className={s.select}>All <ChevronDown size={13} /></span>
            </div>
            <table className={s.table}>
              <tbody>
                {d.today.slice(0, 5).map((t) => (
                  <tr key={t.id}>
                    <td className={s.time}>{t.start ? fmtClock(t.start) : '—'}</td>
                    <td><span className={s.taskCell}><BrandChip id={t.brand} size={20} />{t.title}</span></td>
                    <td className={s.est}>{t.est}m</td>
                    <td className={s.right}>
                      <span className={`${s.status} ${s['ts_' + t.status]}`}>{t.status === 'doing' ? 'In progress' : t.status === 'done' ? 'Done' : t.overdue ? 'Overdue' : 'To do'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {d.release ? (
            <div className={`${s.card} ${s.release}`}>
              <div className={s.cardHead}><span className={s.icon}><Flag size={15} /></span> {d.release.name}</div>
              <div className={s.releaseBody}>
                <Ring value={passRate / 100} size={112} stroke={10} color="var(--k1)" track="rgba(255,255,255,.07)">
                  <div><div className={s.ringNum}><CountUp value={passRate} decimals={1} suffix="%" /></div><div className={s.muted}>pass</div></div>
                </Ring>
                <div className={s.relStats}>
                  <div><b className={s.bad}>{d.release.blockers}</b><span>blockers</span></div>
                  <div><b>{d.release.flaky}</b><span>flaky</span></div>
                  <div><b>{d.release.decision.split(' ')[0]}</b><span>go / no-go</span></div>
                </div>
              </div>
            </div>
          ) : (
            <div className={`${s.card} ${s.release}`}>
              <div className={s.cardHead}><span className={s.icon}><Target size={15} /></span> Goal</div>
              {d.goals.map((g) => (
                <div key={g.label} className={s.goal}>
                  <div className={s.ringNum}>{g.unit}{g.current.toLocaleString()}<span className={s.muted}> / {g.unit}{g.target.toLocaleString()}</span></div>
                  <Meter value={g.current} max={g.target} color="var(--k1)" track="rgba(255,255,255,.07)" />
                  <span className={s.muted}>{g.label}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
