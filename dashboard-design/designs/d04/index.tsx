'use client';

/* 04 Lime Pulse: pitch black + neon accent, capsule bars with striped free space and one lit capsule, KPI column of micro charts. */

import { useMemo, useState } from 'react';
import {
  Bell, Bot, ChevronDown, CircleGauge, Flag, FolderKanban, House, Inbox, ListChecks, Search, SlidersHorizontal, Sparkles, Zap,
} from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { brands, fmtH, NOW, pct, summary, USER, type AgentState } from '@/lib/data';
import { BrandChip, brandColor, Logo } from '@/components/brand';
import { CountUp, Spark } from '@/components/charts';
import s from './styles.module.css';

const nav = [
  { icon: House, label: 'Dashboard', on: true }, { icon: Zap, label: 'Today' }, { icon: FolderKanban, label: 'Projects' },
  { icon: Bot, label: 'Agents' }, { icon: Inbox, label: 'Inbox' },
];
const stateLabel: Record<AgentState, string> = { running: 'Running', review: 'Review', failed: 'Failed', queued: 'Queued', waiting: 'Waiting', accepted: 'Accepted' };
const filters = ['All', 'Live', 'Review', 'Failed'] as const;

/* Tiny semicircle of ticks (used for AI spend). */
function Arc({ value, ticks = 15, size = 112 }: { value: number; ticks?: number; size?: number }) {
  const r = size / 2 - 3;
  const lit = Math.round(Math.min(1, value) * ticks);
  return (
    <svg width={size} height={size / 2 + 6} viewBox={`0 0 ${size} ${size / 2 + 6}`} aria-hidden>
      {Array.from({ length: ticks }, (_, i) => {
        const a = Math.PI + (i / (ticks - 1)) * Math.PI;
        const c = +Math.cos(a).toFixed(4), sn = +Math.sin(a).toFixed(4);
        const len = i % 3 === 0 ? 14 : 9;
        return (
          <line key={i} x1={size / 2 + c * r} y1={size / 2 + sn * r + 3} x2={size / 2 + c * (r - len)} y2={size / 2 + sn * (r - len) + 3}
            stroke={i < lit ? 'var(--k1)' : '#3a3b40'} strokeWidth={2.5} strokeLinecap="round" className="anim-fade" style={{ animationDelay: `${i * 30}ms` }} />
        );
      })}
    </svg>
  );
}

export default function Design() {
  const { s: d, brand, setBrand } = useWorkspace();
  const [filter, setFilter] = useState<(typeof filters)[number]>('All');
  const per = useMemo(() => brands.map((b) => ({ ...b, x: summary(b.id) })), []);

  const loadPct = pct(d.committed, d.available);
  const maxH = Math.max(...d.week.map((w) => Math.max(w.avail, w.planned)), 1);
  const todayIdx = d.week.findIndex((w) => w.d === NOW.weekday);
  const today = d.week[todayIdx];
  const todayTop = today ? Math.max(today.avail, today.planned) / maxH : 0;
  const tp = d.throughput;
  const wk = tp[tp.length - 1];
  const wkPrev = tp[tp.length - 2] ?? wk;
  const wkDelta = wkPrev ? Math.round(((wk - wkPrev) / wkPrev) * 100) : 0;
  const passRate = d.release ? (d.release.passed / d.release.tests) * 100 : 0;
  const goal = d.goals[0];

  const rows = d.runs.filter((r) =>
    filter === 'All' ? true : filter === 'Live' ? r.state === 'running' : filter === 'Review' ? r.state === 'review' : r.state === 'failed');

  return (
    <div className={s.root}>
      <header className={s.top}>
        <Logo size={30} />
        <nav className={s.nav}>
          {nav.map((n) => (
            <a key={n.label} className={n.on ? s.navOn : s.navItem}>
              <span className={s.navIcon}><n.icon size={14} /></span>{n.label}
            </a>
          ))}
        </nav>
        <div className={s.topRight}>
          <span className={s.search}><Search size={15} /> Search</span>
          <button className={s.circle} aria-label="Notifications"><Bell size={16} /><i /></button>
          <span className={s.avatar}>{USER.initials}</span>
        </div>
      </header>

      <main className={s.main}>
        <section className={s.row1}>
          {/* hero: capsule capacity */}
          <div className={`${s.card} ${s.hero}`}>
            <div className={s.heroHead}>
              <div className={s.title}><span className={s.titleIcon}><CircleGauge size={17} /></span>Capacity</div>
              <div className={s.switcher}>
                <button className={brand === null ? s.swOn : s.sw} onClick={() => setBrand(null)}>All</button>
                {brands.map((b) => (
                  <button key={b.id} className={brand === b.id ? s.swOn : s.sw} onClick={() => setBrand(b.id)} aria-label={b.name}>
                    <BrandChip id={b.id} size={22} />
                  </button>
                ))}
              </div>
              <span className={s.select}>This week <ChevronDown size={14} /></span>
            </div>

            <div className={s.heroBody}>
              <div className={s.heroStat}>
                <div className={s.loadNum}><CountUp value={loadPct} /><span>%</span></div>
                <div className={s.loadLab}>Today load</div>
                {d.over > 0
                  ? <span className={s.overPill}><i className="anim-pulse" />{fmtH(d.over)} over</span>
                  : <span className={s.fitPill}>Fits</span>}
                <div className={s.miniStats}>
                  <div><b>{fmtH(d.committed)}</b><span>Booked</span></div>
                  <div><b>{fmtH(d.available)}</b><span>Free</span></div>
                  <div><b>{d.todayDone}/{d.today.length}</b><span>Done</span></div>
                </div>
              </div>

              <div className={s.capsules}>
                {today ? (
                  <div className={s.level} style={{ bottom: `calc(30px + ${todayTop.toFixed(4)} * var(--cap-h))`, right: `${((1 - (todayIdx + 0.5) / d.week.length) * 100).toFixed(2)}%` }}>
                    <span className={s.levelBubble}>{fmtH(today.planned)}</span>
                    <span className={s.levelLine} />
                  </div>
                ) : null}
                {d.week.map((w, i) => {
                  const on = i === todayIdx;
                  const top = Math.max(w.avail, w.planned);
                  const inCap = Math.min(w.planned, w.avail);
                  const over = Math.max(0, w.planned - w.avail);
                  const p = w.avail ? pct(w.planned, w.avail) : 0;
                  return (
                    <div key={w.d} className={s.capCol}>
                      <div className={s.capArea}>
                        {top > 0 ? (
                          <div className={`${s.capsule} anim-grow-y`} style={{ height: `${(top / maxH) * 100}%`, animationDelay: `${i * 60}ms` }}>
                            {over > 0 ? <span className={s.overBubble}>+{fmtH(over)}</span> : null}
                            {on ? <i className={s.knob} /> : null}
                            <div className={`${s.capInner} ${on ? s.capInnerOn : ''}`}>
                              {over > 0 ? <div className={on ? s.overOn : s.overSeg} style={{ height: `${(over / top) * 100}%` }} /> : null}
                              <div className={s.freeSeg} />
                              <div className={on ? s.fillOn : s.fill} style={{ height: `${(inCap / top) * 100}%` }}>
                                <span>{p}%</span>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className={s.capsuleOff}>Off</div>
                        )}
                      </div>
                      <span className={on ? s.dayOn : s.day}>{w.d}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* KPI column */}
          <div className={`${s.card} ${s.kpis}`}>
            <div className={s.kpi} style={{ animationDelay: '80ms' }}>
              <span className={`${s.kIcon} ${d.needsYou ? s.kIconHot : ''}`}><Inbox size={16} /></span>
              <div className={s.kText}>
                <div className={s.kVal}><CountUp value={d.needsYou} /></div>
                <div className={s.kLab}>Needs you</div>
              </div>
              <div className={s.needBars}>
                {Array.from({ length: d.review }, (_, i) => <i key={`r${i}`} className={s.nbReview} title="Review" />)}
                {Array.from({ length: d.failed }, (_, i) => <i key={`f${i}`} className={s.nbFailed} title="Failed" />)}
                {d.release ? <i className={s.nbDecision} title="Decision" /> : null}
                {d.needsYou === 0 ? <span className={s.clear}>Clear</span> : null}
                <span className={s.nbLegend}>
                  <span>{d.review} review</span>
                  {d.failed ? <span className={s.redTxt}>{d.failed} failed</span> : null}
                </span>
              </div>
            </div>

            <div className={s.kpi} style={{ animationDelay: '140ms' }}>
              <span className={s.kIcon}><ListChecks size={16} /></span>
              <div className={s.kText}>
                <div className={s.kVal}><CountUp value={wk} /><span className={wkDelta >= 0 ? s.up : s.down}>{wkDelta >= 0 ? '+' : ''}{wkDelta}%</span></div>
                <div className={s.kLab}>Shipped / wk</div>
              </div>
              <div className={s.kChart}><Spark values={tp} width={150} height={52} color="var(--k1)" strokeWidth={2.5} /></div>
            </div>

            <div className={s.kpi} style={{ animationDelay: '200ms' }}>
              <span className={s.kIcon}><FolderKanban size={16} /></span>
              <div className={s.kText}>
                <div className={s.kVal}><CountUp value={d.active} />{d.health.risk + d.health.off ? <span className={s.down}>{d.health.risk + d.health.off} risk</span> : null}</div>
                <div className={s.kLab}>Projects</div>
              </div>
              <div className={s.barcode}>
                {d.projects.map((p, i) => (
                  <i key={p.id} title={`${p.name} · ${p.health}`} className={`anim-grow-y ${p.health === 'on' ? s.bcOn : p.health === 'risk' ? s.bcRisk : s.bcOff}`}
                    style={{ height: `${Math.max(14, p.progress)}%`, animationDelay: `${i * 40}ms` }} />
                ))}
              </div>
            </div>

            <div className={s.kpi} style={{ animationDelay: '260ms' }}>
              <span className={s.kIcon}><Sparkles size={16} /></span>
              <div className={s.kText}>
                <div className={s.kVal}><CountUp value={d.ai.spent} decimals={2} prefix="$" /></div>
                <div className={s.kLab}>AI of ${d.ai.cap}</div>
              </div>
              <div className={s.kArc}>
                <Arc value={d.ai.spent / d.ai.cap} />
                <span>{pct(d.ai.spent, d.ai.cap)}%</span>
              </div>
            </div>
          </div>
        </section>

        <section className={s.row2}>
          <div className={`${s.card} ${s.brands}`} style={{ animationDelay: '120ms' }}>
            <div className={s.cardHead}><span>Brands</span><span className={s.chip}>12 wk</span></div>
            <ul className={s.brandList}>
              {per.map((b) => (
                <li key={b.id}>
                  <button className={brand === b.id ? s.brandOn : s.brandRow} onClick={() => setBrand(brand === b.id ? null : b.id)}>
                    <BrandChip id={b.id} size={26} />
                    <span className={s.bName}>{b.name}</span>
                    <span className={s.bVal}>{b.x.open}<i>open</i></span>
                    <span className={s.bSpark}><Spark values={b.x.throughput} width={84} height={26} color={brandColor(b.id)} strokeWidth={1.6} dot={false} /></span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className={`${s.card} ${s.runs}`} style={{ animationDelay: '180ms' }}>
            <div className={s.cardHead}>
              <span className={s.cardTitle}>Agent runs</span>
              <div className={s.filters}>
                {filters.map((f) => <button key={f} className={f === filter ? s.fOn : s.f} onClick={() => setFilter(f)}>{f}</button>)}
                <span className={s.circleSm}><SlidersHorizontal size={14} /></span>
              </div>
            </div>
            <table className={s.table}>
              <thead><tr><th>#</th><th>Agent</th><th>Task</th><th>Cost</th><th>Time</th><th className={s.r}>Status</th></tr></thead>
              <tbody>
                {rows.slice(0, 5).map((r, i) => (
                  <tr key={r.id} className={r.state === 'failed' ? s.trBad : undefined}>
                    <td className={s.idx}>{String(i + 1).padStart(2, '0')}</td>
                    <td><span className={s.agentCell}><BrandChip id={r.brand} size={20} />{r.agent}</span></td>
                    <td className={s.task}>{r.task}</td>
                    <td className={s.numCell}>${r.cost.toFixed(2)}</td>
                    <td className={s.numCell}>{r.mins ? `${r.mins}m` : '—'}</td>
                    <td className={s.r}><span className={`${s.pill} ${s['p_' + r.state]}`}>{r.state === 'running' ? <i className="anim-pulse" /> : null}{stateLabel[r.state]}</span></td>
                  </tr>
                ))}
                {rows.length === 0 ? <tr><td colSpan={6} className={s.empty}>None</td></tr> : null}
              </tbody>
            </table>
          </div>

          <div className={`${s.card} ${s.release}`} style={{ animationDelay: '240ms' }}>
            {d.release ? (
              <>
                <div className={s.cardHead}><span className={s.headIcon}><Flag size={15} />{d.release.version}</span><span className={s.decide}>{d.release.decision.split(' ')[0]}</span></div>
                <div className={s.relNum}><CountUp value={passRate} decimals={1} /><span>%</span></div>
                <div className={s.relBar}>
                  <i className={s.rbPass} style={{ flex: d.release.passed }} />
                  <i className={s.rbFail} style={{ flex: Math.max(d.release.failed * 6, 1) }} />
                  <i className={s.rbFlaky} style={{ flex: Math.max(d.release.flaky * 6, 1) }} />
                </div>
                <div className={s.relFoot}>
                  <span className={s.blockPill}>{d.release.blockers} blockers</span>
                  <span className={s.relMute}>{d.release.failed} failed · {d.release.flaky} flaky</span>
                </div>
              </>
            ) : goal ? (
              <>
                <div className={s.cardHead}><span className={s.headIcon}><Flag size={15} />{goal.label}</span><span className={s.chip}>No release</span></div>
                <div className={s.relNum}><CountUp value={pct(goal.current, goal.target)} /><span>%</span></div>
                <div className={s.relBar}>
                  <i className={s.rbPass} style={{ flex: goal.current }} />
                  <i className={s.rbEmpty} style={{ flex: goal.target - goal.current }} />
                </div>
                <div className={s.relFoot}><span className={s.relMute}>{goal.unit}{goal.current.toLocaleString()} / {goal.unit}{goal.target.toLocaleString()}</span></div>
              </>
            ) : null}
          </div>
        </section>
      </main>
    </div>
  );
}
