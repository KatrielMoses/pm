'use client';

/* 02 Paper: warm off-white, floating pill rail, black hero tile, hatched over-capacity bars, checkbox table. */

import {
  Bell, Bot, CalendarDays, Check, ChevronDown, CircleAlert, CircleHelp, Ellipsis, FolderKanban, Funnel,
  House, Inbox, Lock, LogOut, Moon, Plus, Search, Sun, Target, Wallet, Zap,
} from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { brands, fmtClock, fmtH, NOW, USER, pct } from '@/lib/data';
import { BrandChip, Logo } from '@/components/brand';
import { CountUp } from '@/components/charts';
import s from './styles.module.css';

const tabs = ['Overview', 'Today', 'Projects', 'Agents', 'Reports'];
const rail = [
  { icon: House, on: true }, { icon: Zap }, { icon: Inbox }, { icon: FolderKanban }, { icon: CalendarDays }, { icon: Bot }, { icon: Target },
];

const taskStatus = (t: { status: string; overdue?: boolean }) =>
  t.status === 'done' ? { label: 'Done', cls: s.stDone }
    : t.status === 'doing' ? (t.overdue ? { label: 'Overdue', cls: s.stBad } : { label: 'In progress', cls: s.stDoing })
      : t.status === 'blocked' ? { label: 'Blocked', cls: s.stBad }
        : t.overdue ? { label: 'Overdue', cls: s.stBad } : { label: 'To do', cls: s.stTodo };

export default function Design() {
  const { s: d, brand, setBrand } = useWorkspace();
  const fill = Math.max(d.committed, d.available) || 1;
  const maxWeek = Math.max(...d.week.map((w) => Math.max(w.avail, w.planned)), 1);
  const gridTop = Math.ceil(maxWeek / 2) * 2 || 2;
  const gridLines = Array.from({ length: gridTop / 2 + 1 }, (_, i) => gridTop - i * 2);
  const todayIdx = d.week.findIndex((w) => w.d === NOW.weekday);
  const passRate = d.release ? (d.release.passed / d.release.tests) * 100 : 0;
  const goal = d.goals[0];

  return (
    <div className={s.root}>
      <div className={s.frame}>
        <header className={s.top}>
          <div className={s.pill}><Logo size={30} /></div>
          <nav className={`${s.pill} ${s.tabs}`}>
            {tabs.map((t, i) => <a key={t} className={i === 0 ? s.tabOn : s.tab}>{t}</a>)}
          </nav>
          <div className={s.topRight}>
            <div className={`${s.pill} ${s.iconGroup}`}>
              <button aria-label="Search"><Search size={18} /></button>
              <button aria-label="Notifications" className={s.belled}><Bell size={18} /><i /></button>
              <button aria-label="Alerts"><CircleAlert size={18} /></button>
            </div>
            <div className={`${s.pill} ${s.user}`}>
              <span className={s.avatar}>{USER.initials}</span>
              <span className={s.userName}>{USER.name}</span>
              <ChevronDown size={15} />
            </div>
          </div>
        </header>

        <div className={s.body}>
          <aside className={s.rail}>
            <div className={s.railGroup}>
              <button className={s.railOnSoft} aria-label="Light"><Sun size={18} /></button>
              <button aria-label="Dark"><Moon size={18} /></button>
            </div>
            <div className={s.railGroup}>
              {rail.map((r, i) => <button key={i} className={r.on ? s.railOn : undefined} aria-label="nav"><r.icon size={18} /></button>)}
            </div>
            <div className={`${s.railGroup} ${s.railEnd}`}>
              <button aria-label="Help"><CircleHelp size={18} /></button>
              <button aria-label="Log out"><LogOut size={18} /></button>
            </div>
          </aside>

          <main className={s.main}>
            <div className={s.greetRow}>
              <h1 className={s.greet}>Good morning, {USER.name}</h1>
              <div className={s.switcher}>
                <button className={brand === null ? s.swOn : s.sw} onClick={() => setBrand(null)}>
                  <span className={s.allMark}>{brands.map((b) => <BrandChip key={b.id} id={b.id} size={9} radius={2.5} style={{ fontSize: 0 }} />)}</span>
                  All
                </button>
                {brands.map((b) => (
                  <button key={b.id} className={brand === b.id ? s.swOn : s.sw} onClick={() => setBrand(b.id)}>
                    <BrandChip id={b.id} size={22} /> {b.name}
                  </button>
                ))}
              </div>
            </div>

            <section className={s.row1}>
              {/* capacity */}
              <div className={`${s.card} ${s.cap}`} style={{ animationDelay: '0ms' }}>
                <div className={s.cardHead}>
                  <span>Today</span>
                  <span className={s.select}><CalendarDays size={14} /> {NOW.label}</span>
                </div>
                <div className={s.capNum}>
                  <CountUp value={d.committed} decimals={1} suffix="h" />
                  <span className={s.capOf}>/ {fmtH(d.available)} free</span>
                </div>
                {d.over > 0
                  ? <span className={s.overPill}><CircleAlert size={13} /> {fmtH(d.over)} over</span>
                  : <span className={s.okPill}><Check size={13} /> Fits</span>}
                <div className={s.capBar}>
                  <div className={`${s.capIn} anim-grow-x`} style={{ width: `${(Math.min(d.committed, d.available) / fill) * 100}%` }} />
                  {d.over > 0
                    ? <div className={`${s.capOver} anim-grow-x`} style={{ width: `${(d.over / fill) * 100}%`, animationDelay: '250ms' }} />
                    : <div className={s.capFree} style={{ width: `${((d.available - d.committed) / fill) * 100}%` }} />}
                </div>
                <div className={s.capLegend}>
                  <span><i className={s.lgIn} />Planned</span>
                  <span><i className={d.over > 0 ? s.lgOver : s.lgFree} />{d.over > 0 ? 'Over' : 'Free'}</span>
                  <span className={s.capDone}>{d.todayDone}/{d.today.length} done</span>
                </div>
                <div className={s.btnRow}>
                  <button className={s.btnDark}><Zap size={15} /> Rebalance</button>
                  <button className={s.btnLight}><CalendarDays size={15} /> Defer</button>
                </div>
              </div>

              {/* 2x2 tiles */}
              <div className={s.tiles}>
                <div className={`${s.tile} ${s.hero}`} style={{ animationDelay: '60ms' }}>
                  <div className={s.tileHead}><span>Needs you</span><span className={s.heroIcon}><Inbox size={15} /></span></div>
                  <div className={s.tileNum}><CountUp value={d.needsYou} /></div>
                  <div className={s.tileFoot}>
                    <span className={s.heroTag}>{d.review} review</span>
                    {d.failed > 0 ? <span className={`${s.heroTag} ${s.heroBad}`}>{d.failed} failed</span> : null}
                    {d.release ? <span className={s.heroTag}>1 decision</span> : null}
                  </div>
                </div>
                <div className={s.tile} style={{ animationDelay: '120ms' }}>
                  <div className={s.tileHead}><span>Projects</span><span className={s.tileIcon}><FolderKanban size={15} /></span></div>
                  <div className={s.tileNum}><CountUp value={d.active} /></div>
                  <div className={s.tileFoot}>
                    {d.health.risk + d.health.off > 0
                      ? <span className={s.badTag}>{d.health.risk + d.health.off} at risk</span>
                      : <span className={s.goodTag}>All on track</span>}
                    <span className={s.footMute}>{d.health.on} on</span>
                  </div>
                </div>
                <div className={s.tile} style={{ animationDelay: '180ms' }}>
                  <div className={s.tileHead}><span>Agents</span><span className={s.tileIcon}><Bot size={15} /></span></div>
                  <div className={s.tileNum}><CountUp value={d.running} /><span className={s.live}><i className="anim-ping" /><i /></span></div>
                  <div className={s.tileFoot}>
                    <span className={s.goodTag}>Live</span>
                    <span className={s.footMute}>{d.queued} queued</span>
                  </div>
                </div>
                {d.release ? (
                  <div className={s.tile} style={{ animationDelay: '240ms' }}>
                    <div className={s.tileHead}><span>{d.release.version}</span><span className={s.tileIcon}><Target size={15} /></span></div>
                    <div className={s.tileNum}><CountUp value={passRate} decimals={1} suffix="%" /></div>
                    <div className={s.tileFoot}>
                      <span className={s.badTag}>{d.release.blockers} blockers</span>
                      <span className={s.footMute}>{d.release.decision.split(' ')[0]}</span>
                    </div>
                  </div>
                ) : goal ? (
                  <div className={s.tile} style={{ animationDelay: '240ms' }}>
                    <div className={s.tileHead}><span>{goal.label}</span><span className={s.tileIcon}><Target size={15} /></span></div>
                    <div className={s.tileNum}><CountUp value={pct(goal.current, goal.target)} suffix="%" /></div>
                    <div className={s.tileFoot}>
                      <span className={s.neutralTag}>No release</span>
                      <span className={s.footMute}>{goal.current}/{goal.target}</span>
                    </div>
                  </div>
                ) : null}
              </div>

              {/* week chart */}
              <div className={`${s.card} ${s.week}`} style={{ animationDelay: '120ms' }}>
                <div className={s.cardHead}>
                  <span>Week load</span>
                  <span className={s.legend}>
                    <span><i className={s.lgIn} />Planned</span>
                    <span><i className={s.lgOver} />Over</span>
                  </span>
                </div>
                <div className={s.chart}>
                  <div className={s.grid}>
                    {gridLines.map((g) => <div key={g} className={s.gridLine}><span>{g}h</span></div>)}
                  </div>
                  <div className={s.cols}>
                    {d.week.map((w, i) => {
                      const inCap = Math.min(w.planned, w.avail);
                      const over = Math.max(0, w.planned - w.avail);
                      const free = Math.max(0, w.avail - w.planned);
                      const isToday = i === todayIdx;
                      return (
                        <div key={w.d} className={s.col}>
                          <div className={`${s.stack} anim-grow-y`} style={{ animationDelay: `${i * 50}ms` }}>
                            {isToday ? <span className={s.bubble}>{fmtH(w.planned)}</span> : null}
                            {over > 0 ? <div className={s.segOver} style={{ height: `${(over / gridTop) * 100}%` }} /> : null}
                            {free > 0 ? <div className={s.segFree} style={{ height: `${(free / gridTop) * 100}%` }} /> : null}
                            {inCap > 0
                              ? <div className={isToday ? s.segToday : s.segIn} style={{ height: `${(inCap / gridTop) * 100}%` }} />
                              : <div className={s.segNone} />}
                          </div>
                          <span className={isToday ? s.dayOn : s.day}>{w.d}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </section>

            <section className={s.row2}>
              <div className={s.leftCol}>
                <div className={`${s.card} ${s.spend}`} style={{ animationDelay: '200ms' }}>
                  <div className={s.cardHead}>
                    <span>AI spend</span>
                    <span className={s.pctPill}>{pct(d.ai.spent, d.ai.cap)}%</span>
                  </div>
                  <div className={s.spendBar}>
                    <div className="anim-grow-x" style={{ width: `${Math.min(100, (d.ai.spent / d.ai.cap) * 100)}%` }} />
                  </div>
                  <div className={s.spendFoot}>
                    <b><CountUp value={d.ai.spent} decimals={2} prefix="$" /></b>
                    <span>${d.ai.cap.toFixed(2)}</span>
                  </div>
                </div>

                <div className={`${s.card} ${s.goals}`} style={{ animationDelay: '260ms' }}>
                  <div className={s.cardHead}>
                    <span className={s.headIcon}><span className={s.tileIcon}><Wallet size={15} /></span> Goals</span>
                    <button className={s.ghostBtn}><Plus size={13} /> Add</button>
                  </div>
                  <div className={s.goalRow}>
                    {d.goals.map((g, i) => (
                      <div key={g.label} className={`${s.goalCard} ${i === 0 ? s.goalDark : i === 1 ? s.goalAccent : s.goalLight}`}>
                        <div className={s.goalTop}><BrandChip id={g.brand} size={20} /><span className={s.goalTag}>{pct(g.current, g.target)}%</span></div>
                        <div className={s.goalVal}>{g.unit}{g.current.toLocaleString()}</div>
                        <div className={s.goalMeter}><div className="anim-grow-x" style={{ width: `${pct(g.current, g.target)}%` }} /></div>
                        <div className={s.goalFoot}><span>{g.label}</span><span>{g.unit}{g.target.toLocaleString()}</span></div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className={`${s.card} ${s.activity}`} style={{ animationDelay: '220ms' }}>
                <div className={s.cardHead}>
                  <span className={s.tableTitle}>Today&apos;s work</span>
                  <div className={s.tableTools}>
                    <span className={s.searchBox}><Search size={15} /> Search</span>
                    <button className={s.filterBtn}>Filter <Funnel size={14} /></button>
                  </div>
                </div>
                <div className={s.tableWrap}>
                  <table className={s.table}>
                    <thead>
                      <tr><th className={s.cbCell}><span className={s.cb} /></th><th>Time</th><th>Task</th><th>Project</th><th>Est</th><th>Status</th><th /></tr>
                    </thead>
                    <tbody>
                      {d.today.slice(0, 6).map((t) => {
                        const st = taskStatus(t);
                        const done = t.status === 'done';
                        return (
                          <tr key={t.id} className={t.status === 'doing' ? s.rowOn : undefined}>
                            <td className={s.cbCell}><span className={done ? s.cbOn : s.cb}>{done ? <Check size={12} strokeWidth={3} /> : null}</span></td>
                            <td className={s.mono}>{t.start ? fmtClock(t.start) : '—'}</td>
                            <td>
                              <span className={s.taskCell}>
                                <BrandChip id={t.brand} size={22} />
                                <span className={done ? s.struck : undefined}>{t.title}</span>
                                {t.locked ? <Lock size={13} className={s.lock} /> : null}
                                {t.agent ? <Bot size={13} className={s.lock} /> : null}
                              </span>
                            </td>
                            <td className={s.muted}>{t.project}</td>
                            <td className={s.mono}>{t.est}m</td>
                            <td><span className={`${s.status} ${st.cls}`}><i />{st.label}</span></td>
                            <td className={s.more}><Ellipsis size={16} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          </main>
        </div>
      </div>
    </div>
  );
}
