'use client';

/* 19 Swiss: pure white, strict 12-column grid, hairlines only, oversized numerals, accent used twice. */

import { useWorkspace } from '@/lib/workspace';
import { brands, brandShort, fmtH, NOW, pct, USER, weeksLabels, type Health } from '@/lib/data';
import { BrandDot, LogoMark } from '@/components/brand';
import { CountUp } from '@/components/charts';
import s from './styles.module.css';

const nav = ['Home', 'Today', 'Projects', 'Agents', 'Releases', 'Goals'];
const healthWord: Record<Health, string> = { on: 'On track', risk: 'At risk', off: 'Off track' };
const healthRank: Record<Health, number> = { off: 0, risk: 1, on: 2 };
const two = (n: number) => String(n).padStart(2, '0');

export default function Design() {
  const { s: d, brand, setBrand } = useWorkspace();
  const [whole, frac] = d.committed.toFixed(1).split('.');
  const tp = d.throughput;
  const tpMax = Math.max(...tp);
  const rel = d.release;
  const rows = [...d.projects].sort((a, b) => healthRank[a.health] - healthRank[b.health] || a.dueDays - b.dueDays);
  const rulerMax = Math.max(8, Math.ceil(d.committed));

  return (
    <div className={s.root}>
      <header className={s.head}>
        <div className={s.c3}><span className={s.logo}><LogoMark size={22} bg="#111" fg="#fff" radius={4} /> Untitled</span></div>
        <nav className={`${s.c5} ${s.nav}`}>
          {nav.map((n, i) => <a key={n} className={i === 0 ? s.navOn : ''}>{n}</a>)}
        </nav>
        <div className={`${s.c4} ${s.headRight}`}>
          <span className="tnum">{two(NOW.day)}.10.{NOW.year}</span>
          <span className="tnum">{NOW.time}</span>
          <span className={s.user}>{USER.initials}</span>
        </div>
      </header>

      <div className={s.brandRow}>
        <span className={s.lab}>Brand</span>
        <div className={s.brands}>
          <button className={brand === null ? s.bOn : s.b} onClick={() => setBrand(null)}><span className={s.allSq} />All</button>
          {brands.map((b) => (
            <button key={b.id} className={brand === b.id ? s.bOn : s.b} onClick={() => setBrand(b.id)}><BrandDot id={b.id} size={10} />{b.name}</button>
          ))}
        </div>
      </div>

      {/* hero row */}
      <section className={s.row}>
        <div className={`${s.c6} ${s.hero}`}>
          <span className={s.lab}>Committed today</span>
          <div className={s.giant}>
            <CountUp value={Number(whole)} /><span className={s.giantFrac}>.{frac}</span><span className={s.giantUnit}>h</span>
          </div>
          <div className={s.ruler}>
            <div className={s.rulerTrack}>
              <span className={`${s.rFill} anim-grow-x`} style={{ width: `${(Math.min(d.committed, d.available) / rulerMax) * 100}%` }} />
              {d.over > 0 ? <span className={`${s.rOver} anim-grow-x`} style={{ left: `${(d.available / rulerMax) * 100}%`, width: `${(d.over / rulerMax) * 100}%` }} /> : null}
              <span className={s.rCap} style={{ left: `${(d.available / rulerMax) * 100}%` }} />
            </div>
            <div className={s.rulerTicks}>
              {Array.from({ length: rulerMax + 1 }, (_, i) => <span key={i} style={{ left: `${(i / rulerMax) * 100}%` }}>{i}</span>)}
            </div>
          </div>
          <div className={s.heroFoot}>
            <span><b className="tnum">{fmtH(d.available)}</b> free</span>
            {d.over > 0 ? <span className={s.accentTxt}>+{fmtH(d.over)} over</span> : <span>Fits</span>}
            <span><b className="tnum">{d.todayDone}/{d.today.length}</b> done</span>
          </div>
        </div>

        <div className={`${s.c6} ${s.quad}`}>
          <div className={s.stat}>
            <span className={s.lab}>Needs you</span>
            <b className={s.big}><CountUp value={d.needsYou} /></b>
            <dl className={s.dl}>
              <dt>Review</dt><dd>{d.review}</dd>
              <dt>Failed</dt><dd className={d.failed ? s.strong : ''}>{d.failed}</dd>
              <dt>Decision</dt><dd>{rel ? 1 : 0}</dd>
            </dl>
          </div>
          <div className={s.stat}>
            <span className={s.lab}>Projects</span>
            <b className={s.big}><CountUp value={d.active} /></b>
            <dl className={s.dl}>
              <dt>On</dt><dd>{d.health.on}</dd>
              <dt>Risk</dt><dd>{d.health.risk}</dd>
              <dt>Off</dt><dd className={d.health.off ? s.strong : ''}>{d.health.off}</dd>
            </dl>
          </div>
          <div className={s.stat}>
            <span className={s.lab}>Agents live</span>
            <b className={s.big}><CountUp value={d.running} /><i className={`${s.live} anim-pulse`} /></b>
            <dl className={s.dl}>
              <dt>Queued</dt><dd>{d.queued}</dd>
              <dt>Runs</dt><dd>{d.runs.length}</dd>
            </dl>
          </div>
          <div className={s.stat}>
            <span className={s.lab}>AI spend</span>
            <b className={s.big}><CountUp value={d.ai.spent} decimals={1} prefix="$" /></b>
            <div className={s.hair}><span className="anim-grow-x" style={{ width: `${pct(d.ai.spent, d.ai.cap)}%` }} /></div>
            <dl className={s.dl}><dt>Cap</dt><dd>${d.ai.cap}</dd><dt>Used</dt><dd>{pct(d.ai.spent, d.ai.cap)}%</dd></dl>
          </div>
        </div>
      </section>

      {/* row 2 */}
      <section className={s.row}>
        <div className={`${s.c6} ${s.block}`}>
          <div className={s.blockHead}><span className={s.lab}>Shipped / week</span><b className={s.mid}><CountUp value={tp[tp.length - 1]} /></b></div>
          <div className={s.bars}>
            {tp.map((v, i) => (
              <div key={i} className={s.barCol}>
                <span className={s.barVal}>{v}</span>
                <span className={`${s.bar} ${i === tp.length - 1 ? s.barNow : ''} anim-grow-y`} style={{ height: `${(v / tpMax) * 100}%`, animationDelay: `${i * 35}ms` }} />
                <span className={s.barLab}>{weeksLabels[i].split(' ')[1]}</span>
              </div>
            ))}
          </div>
        </div>

        <div className={`${s.c3} ${s.block}`}>
          <div className={s.blockHead}><span className={s.lab}>Week</span><span className="tnum">{fmtH(d.week.reduce((a, w) => a + w.planned, 0))} / {fmtH(d.week.reduce((a, w) => a + w.avail, 0))}</span></div>
          <ul className={s.week}>
            {d.week.map((w) => {
              const over = w.planned > w.avail;
              const m = Math.max(...d.week.map((x) => Math.max(x.avail, x.planned)), 1);
              return (
                <li key={w.d} className={w.d === NOW.weekday ? s.wNow : ''}>
                  <span>{w.d}</span>
                  <span className={s.wBar}>
                    <span className={s.wAvail} style={{ width: `${(w.avail / m) * 100}%` }} />
                    <span className={`${over ? s.wPlanOver : s.wPlan} anim-grow-x`} style={{ width: `${(w.planned / m) * 100}%` }} />
                  </span>
                  <span className="tnum">{w.planned}</span>
                  <span className={s.wFlag}>{over ? 'Over' : ''}</span>
                </li>
              );
            })}
          </ul>
        </div>

        <div className={`${s.c3} ${s.block}`}>
          {rel ? (
            <>
              <div className={s.blockHead}><span className={s.lab}>{rel.name}</span><span className={rel.blockers ? s.pillBlack : s.pill}>{rel.blockers ? 'No-go' : 'Go'}</span></div>
              <b className={s.mid2}><CountUp value={(rel.passed / rel.tests) * 100} decimals={1} /><small>%</small></b>
              <dl className={s.dlWide}>
                <dt>Blockers</dt><dd className={s.strong}>{rel.blockers}</dd>
                <dt>Failed</dt><dd>{rel.failed}</dd>
                <dt>Flaky</dt><dd>{rel.flaky}</dd>
                <dt>Decision</dt><dd>{rel.decision}</dd>
              </dl>
              <div className={s.checks}>
                {rel.checks.map((c) => <span key={c.label}><i className={c.done ? s.sqOn : s.sq} />{c.label}</span>)}
              </div>
            </>
          ) : (
            <>
              <div className={s.blockHead}><span className={s.lab}>Goal</span><span className={s.pill}>No release</span></div>
              {d.goals.map((g) => (
                <div key={g.label}>
                  <b className={s.mid2}>{pct(g.current, g.target)}<small>%</small></b>
                  <dl className={s.dlWide}>
                    <dt>{g.label}</dt><dd>{g.unit}{g.current.toLocaleString()}</dd>
                    <dt>Target</dt><dd>{g.unit}{g.target.toLocaleString()}</dd>
                    <dt>Due soon</dt><dd>{d.dueSoon}</dd>
                    <dt>Open</dt><dd>{d.open}</dd>
                  </dl>
                </div>
              ))}
            </>
          )}
        </div>
      </section>

      {/* row 3 */}
      <section className={`${s.row} ${s.last}`}>
        <div className={`${s.c8} ${s.block}`}>
          <table className={s.table}>
            <thead>
              <tr><th>No.</th><th>Project</th><th>Brand</th><th>Due</th><th>Progress</th><th className={s.num}>Hours</th><th className={s.num}>Open</th><th className={s.num}>Blocked</th><th className={s.num}>Status</th></tr>
            </thead>
            <tbody>
              {rows.map((p, i) => (
                <tr key={p.id} className="anim-fade" style={{ animationDelay: `${i * 30}ms` }}>
                  <td className={s.idx}>{two(i + 1)}</td>
                  <td className={s.pName}>{p.name}</td>
                  <td><span className={s.brandCell}><BrandDot id={p.brand} size={10} />{brandShort(p.brand)}</span></td>
                  <td className={p.dueDays <= 3 ? s.strong : ''}>{p.due}</td>
                  <td><span className={s.prog}><span className={s.progLine}><span className="anim-grow-x" style={{ width: `${p.progress}%` }} /></span><span className="tnum">{p.progress}</span></span></td>
                  <td className={`${s.num} ${p.hoursActual > p.hoursPlanned ? s.strong : ''}`}>{p.hoursActual}/{p.hoursPlanned}</td>
                  <td className={s.num}>{p.open}</td>
                  <td className={`${s.num} ${p.blocked ? s.strong : s.dim}`}>{p.blocked || '–'}</td>
                  <td className={s.num}><span className={p.health === 'off' ? s.pillBlack : p.health === 'risk' ? s.pillDash : s.pill}>{healthWord[p.health]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className={`${s.c4} ${s.block}`}>
          <div className={s.blockHead}><span className={s.lab}>Briefing</span><span className="tnum">{two(d.briefing.length)}</span></div>
          <ol className={s.brief}>
            {d.briefing.map((b, i) => (
              <li key={b.id}>
                <span className={s.idx}>{two(i + 1)}</span>
                <span className={s.briefText}><b>{b.text}</b><small><BrandDot id={b.brand} size={8} /> {b.source}</small></span>
                <span className={b.kind === 'risk' ? s.pillBlack : b.kind === 'decision' ? s.pillDash : s.pill}>{b.kind === 'done' ? 'Done' : b.kind === 'risk' ? 'Risk' : 'Decide'}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </div>
  );
}
