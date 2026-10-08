'use client';

/* 09 Pastel Columns: soft gradient canvas, one column per brand (or status columns for one brand), tinted cards. */

import type { CSSProperties } from 'react';
import {
  Bell, Bot, Check, ChevronRight, Clock, Command, HelpCircle, ListChecks, MoreHorizontal, OctagonAlert, Plus, Search,
  SlidersHorizontal,
} from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { brands, brandName, fmtClock, fmtH, NOW, pct, USER, type BrandId, type Project, type Run, type Task } from '@/lib/data';
import { BrandChip, brandColor, Logo } from '@/components/brand';
import { Bars, CountUp, Ring } from '@/components/charts';
import s from './styles.module.css';

const ORDER: BrandId[] = ['op', 'ma', 'ax'];
const tabs = ['Board', 'Today', 'Projects', 'Agents', 'Goals'];
const healthWord = { on: 'On track', risk: 'At risk', off: 'Off track' } as const;
const healthRank = { off: 0, risk: 1, on: 2 } as const;
const runWord = { running: 'Running', queued: 'Queued', waiting: 'Waiting', review: 'Review', failed: 'Failed', accepted: 'Accepted' } as const;

const tint = (c: string, p = 15) => `color-mix(in srgb, ${c} ${p}%, #ffffff)`;
const deep = (c: string) => `color-mix(in srgb, ${c} 68%, #1b1530)`;

function ProjectCard({ p, i }: { p: Project; i: number }) {
  const c = brandColor(p.brand);
  const dots = 14;
  const on = Math.round((p.progress / 100) * dots);
  const overHours = p.hoursActual > p.hoursPlanned;
  return (
    <article className={s.card} style={{ background: tint(c), ['--c' as string]: c, animationDelay: `${120 + i * 70}ms` } as CSSProperties}>
      <div className={s.tags}>
        <span className={`${s.hp} ${s['h_' + p.health]}`}><i />{healthWord[p.health]}</span>
        <span className={s.tag}>{p.due}</span>
        <button className={s.more} aria-label="More"><MoreHorizontal size={14} /></button>
      </div>
      <h3 className={s.title} style={{ color: deep(c) }}>{p.name}</h3>
      <div className={s.prog}>
        <div className={s.dots}>
          {Array.from({ length: dots }, (_, k) => (
            <i key={k} className="anim-pop" style={{ background: k < on ? c : tint(c, 28), animationDelay: `${200 + i * 70 + k * 18}ms` }} />
          ))}
        </div>
        <b style={{ color: deep(c) }}>{p.progress}%</b>
      </div>
      <div className={s.foot}>
        <span className={s.mini}><ListChecks size={12} />{p.open}</span>
        <span className={`${s.mini} ${overHours ? s.miniBad : ''}`}><Clock size={12} />{p.hoursActual}/{p.hoursPlanned}h</span>
        {p.blocked > 0 ? <span className={`${s.mini} ${s.miniBlock}`}><OctagonAlert size={12} />{p.blocked} blocked</span> : null}
      </div>
    </article>
  );
}

function TaskCard({ t, i, bg }: { t: Task; i: number; bg: string }) {
  const done = t.status === 'done';
  return (
    <article className={`${s.card} ${done ? s.cardDone : ''}`} style={{ background: bg, animationDelay: `${120 + i * 70}ms` }}>
      <div className={s.tags}>
        <span className={s.tag}>{t.project}</span>
        <span className={s.tag}>{t.est}m</span>
        <button className={s.more} aria-label="More"><MoreHorizontal size={14} /></button>
      </div>
      <h3 className={s.title}>{done ? <Check size={15} className={s.check} /> : null}{t.title}</h3>
      <div className={s.foot}>
        <span className={s.mini}><Clock size={12} />{t.start !== undefined ? fmtClock(t.start) : 'Flexible'}</span>
        <span className={s.mini}>P{t.priority}</span>
        {t.overdue ? <span className={`${s.mini} ${s.miniBlock}`}>Overdue</span> : null}
        {t.agent ? <span className={s.mini}><Bot size={12} />Agent</span> : null}
      </div>
    </article>
  );
}

function RunCard({ r, i, bg }: { r: Run; i: number; bg: string }) {
  const failed = r.state === 'failed';
  return (
    <article className={`${s.card} ${failed ? s.cardFail : ''}`} style={{ background: failed ? undefined : bg, animationDelay: `${120 + i * 70}ms` }}>
      <div className={s.tags}>
        <span className={`${s.hp} ${failed ? s.h_off : r.state === 'running' ? s.h_on : s.h_review}`}>
          <i className={r.state === 'running' ? 'anim-pulse' : undefined} />{runWord[r.state]}
        </span>
        <span className={s.tag}>{r.agent}</span>
        <button className={s.more} aria-label="More"><MoreHorizontal size={14} /></button>
      </div>
      <h3 className={s.title}><Bot size={15} className={s.check} />{r.task}</h3>
      <div className={s.foot}>
        <span className={s.mini}><Clock size={12} />{r.mins}m</span>
        <span className={s.mini}>${r.cost.toFixed(2)}</span>
      </div>
    </article>
  );
}

export default function Design() {
  const { s: d, brand, setBrand } = useWorkspace();
  const rel = d.release;
  const passRate = rel ? (rel.passed / rel.tests) * 100 : 0;
  const todayIdx = d.week.findIndex((w) => w.d === NOW.weekday);

  /* Single brand: status columns of that brand's work. */
  const statusCols = brand
    ? [
        { key: 'todo', label: 'To do', dot: 'var(--k1)', bg: tint('var(--k1)', 13), items: [...d.today.filter((t) => t.status === 'todo' || t.status === 'blocked').map((t) => ({ t })), ...d.runs.filter((r) => r.state === 'queued').map((r) => ({ r }))] },
        { key: 'doing', label: 'In progress', dot: 'var(--k2)', bg: tint('var(--k2)', 18), items: [...d.today.filter((t) => t.status === 'doing').map((t) => ({ t })), ...d.runs.filter((r) => r.state === 'running').map((r) => ({ r }))] },
        { key: 'review', label: 'In review', dot: 'var(--k3)', bg: tint('var(--k3)', 18), items: d.runs.filter((r) => r.state === 'review' || r.state === 'failed').map((r) => ({ r })) },
        { key: 'done', label: 'Done', dot: '#9aa3af', bg: '#eef1f4', items: d.today.filter((t) => t.status === 'done').map((t) => ({ t })) },
      ]
    : [];

  return (
    <div className={s.root}>
      <header className={s.nav}>
        <Logo size={30} />
        <nav className={s.tabs}>
          {tabs.map((t, i) => <a key={t} className={i === 0 ? s.tabOn : s.tab}>{t}{t === 'Agents' ? <em>{d.review}</em> : null}</a>)}
        </nav>
        <div className={s.navRight}>
          <span className={s.find}><Search size={15} /><Command size={11} />K</span>
          <button className={s.iconBtn} aria-label="Help"><HelpCircle size={17} /></button>
          <button className={s.iconBtn} aria-label="Notifications"><Bell size={17} /><i /></button>
          <span className={s.avatar}>{USER.initials}</span>
        </div>
      </header>

      <section className={s.strip}>
        <div className={s.when}><b>{NOW.month}</b><span>{NOW.weekday} {NOW.day}</span></div>
        <span className={s.vr} />
        <div className={s.boardName}>Board<ChevronRight size={15} /><span>{brand ? brandName(brand) : 'All brands'}</span></div>
        <div className={s.switch}>
          <button className={brand === null ? s.swOn : s.sw} onClick={() => setBrand(null)}>
            <span className={s.stackChip}>{ORDER.map((b) => <BrandChip key={b} id={b} size={16} radius={5} />)}</span>All
          </button>
          {brands.map((b) => (
            <button key={b.id} className={brand === b.id ? s.swOn : s.sw} onClick={() => setBrand(b.id)}>
              <BrandChip id={b.id} size={18} radius={6} />{b.name}
            </button>
          ))}
        </div>
        <div className={s.stripRight}>
          {d.over > 0 ? <span className={s.overChip}>+{fmtH(d.over)} over</span> : null}
          <button className={s.filter}><SlidersHorizontal size={15} />Filters</button>
          <button className={s.create}><Plus size={16} />Create task</button>
        </div>
      </section>

      <div className={`${s.body} ${brand ? s.body4 : s.body3}`}>
        {brand === null
          ? ORDER.map((b, ci) => {
              const ps = [...d.projects.filter((p) => p.brand === b)].sort((x, y) => healthRank[x.health] - healthRank[y.health] || x.dueDays - y.dueDays);
              const c = brandColor(b);
              const on = ps.filter((p) => p.health === 'on').length;
              return (
                <section key={b} className={s.col} style={{ animationDelay: `${ci * 80}ms`, background: `linear-gradient(180deg, ${tint(c, 9)}, rgba(255,255,255,.55) 40%)` }}>
                  <div className={s.colHead}>
                    <BrandChip id={b} size={24} radius={7} />
                    <span className={s.colName}>{brandName(b)}</span>
                    <span className={s.colCount}>{ps.length}</span>
                    <span className={s.colHealth}>{on}/{ps.length} on</span>
                    <button className={s.more} aria-label="Add"><Plus size={14} /></button>
                  </div>
                  <div className={s.colBody}>
                    {ps.map((p, i) => <ProjectCard key={p.id} p={p} i={i + ci} />)}
                  </div>
                </section>
              );
            })
          : statusCols.map((col, ci) => (
              <section key={col.key} className={s.col} style={{ animationDelay: `${ci * 80}ms` }}>
                <div className={s.colHead}>
                  <span className={s.colDot} style={{ background: col.dot }} />
                  <span className={s.colName}>{col.label}</span>
                  <span className={s.colCount}>{col.items.length}</span>
                  <button className={s.more} aria-label="Add"><Plus size={14} /></button>
                </div>
                <div className={s.colBody}>
                  {col.items.length === 0 ? <div className={s.empty}>Clear</div> : null}
                  {col.items.map((it, i) =>
                    'r' in it ? <RunCard key={it.r.id} r={it.r} i={i + ci} bg={col.bg} /> : <TaskCard key={it.t.id} t={it.t} i={i + ci} bg={col.bg} />,
                  )}
                </div>
              </section>
            ))}

        {/* ---- right rail ---- */}
        <aside className={s.rail}>
          <div className={s.hero}>
            <div className={s.heroTop}><span>Needs you</span><em><i className="anim-ping" /></em></div>
            <div className={s.heroNum}><CountUp value={d.needsYou} /></div>
            <div className={s.heroRows}>
              <span><b>{d.review}</b>Review</span>
              <span className={d.failed ? s.heroBad : ''}><b>{d.failed}</b>Failed</span>
              <span><b>{rel ? 1 : 0}</b>Decide</span>
            </div>
          </div>

          <div className={s.panel} style={{ animationDelay: '160ms' }}>
            <div className={s.panelHead}><span>Today</span>{d.over > 0 ? <em className={s.pillBad}>Over</em> : <em className={s.pillOk}>Fits</em>}</div>
            <div className={s.capRow}>
              <Ring value={Math.min(1, d.committed / Math.max(d.available, 0.1))} size={96} stroke={10} color={d.over > 0 ? '#f43f5e' : 'var(--k1)'} track={tint('var(--k1)', 18)}>
                <div className={s.ringIn}><b>{pct(d.committed, d.available)}%</b></div>
              </Ring>
              <div className={s.capNums}>
                <b><CountUp value={d.committed} decimals={1} suffix="h" /></b>
                <span>of {fmtH(d.available)} free</span>
                <span className={s.capDone}>{d.todayDone}/{d.today.length} done</span>
              </div>
            </div>
            <Bars values={d.week.map((w) => w.planned)} highlight={todayIdx} height={44} gap={6} radius={6} color={tint('var(--k1)', 30)}
              highlightColor="var(--k1)" labels={d.week.map((w) => w.d[0])} labelColor="#7a7891" />
          </div>

          {rel ? (
            <div className={s.panel} style={{ animationDelay: '240ms' }}>
              <div className={s.panelHead}><BrandChip id={rel.brand} size={20} radius={6} /><span>{rel.version}</span><em className={s.pillBad}>{rel.blockers} blockers</em></div>
              <div className={s.relNum}><CountUp value={passRate} decimals={1} suffix="%" /><span>pass</span></div>
              <div className={s.relBar}>
                <i style={{ flex: rel.passed, background: 'var(--k1)' }} />
                <i style={{ flex: rel.flaky, background: '#f5b83d' }} />
                <i style={{ flex: rel.failed, background: '#f43f5e' }} />
              </div>
              <div className={s.relFoot}><span>{rel.flaky} flaky</span><span>{rel.failed} failed</span><span>{rel.decision}</span></div>
            </div>
          ) : (
            <div className={s.panel} style={{ animationDelay: '240ms' }}>
              {d.goals.map((g) => (
                <div key={g.label} className={s.goal}>
                  <div className={s.panelHead}><BrandChip id={g.brand} size={20} radius={6} /><span>{g.label}</span><em className={s.pillOk}>{pct(g.current, g.target)}%</em></div>
                  <div className={s.relNum}>{g.unit}<CountUp value={g.current} /><span>/ {g.unit}{g.target.toLocaleString('en-US')}</span></div>
                  <div className={s.relBar}><i style={{ flex: g.current, background: 'var(--k1)' }} /><i style={{ flex: g.target - g.current, background: tint('var(--k1)', 20) }} /></div>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
