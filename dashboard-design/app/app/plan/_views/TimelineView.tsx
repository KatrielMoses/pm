'use client';

/*
 * Plan › Timeline: portfolio Gantt grouped by brand. Labels live in the left column (name, health,
 * next milestone, due) so bars stay clean: progress fill, hatched slip, milestone diamonds and a
 * now line. Legend sits above the chart. One ink callout: the next milestone.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowRight, CalendarPlus, Flag, FolderKanban } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { brandName, type BrandId, type Health, type Project } from '@/lib/data';
import { BrandChip, brandColor } from '@/components/brand';
import { Button, Empty, HealthBadge, PageHeader, Segmented, ViewBar } from '@/components/paper/ui';
import { Callout, Count, cx, dayLabel, dueDay, FilterPill, isWeekend, metaFor, NOW_DAY, weekday } from './shared';
import p from './plan.module.css';
import s from './timeline.module.css';

type Zoom = 'week' | 'month' | 'quarter';
const RANGE: Record<Zoom, [number, number]> = { week: [5, 19], month: [-2, 40], quarter: [1, 93] };
const ROW = 58;
const GROUP = 40;
const SLIP: Record<Health, number> = { on: 0, risk: 2, off: 4 };
const ORDER: BrandId[] = ['op', 'ma', 'ax'];
const HEALTHS: { id: Health; label: string }[] = [{ id: 'off', label: 'Off track' }, { id: 'risk', label: 'At risk' }, { id: 'on', label: 'On track' }];
const r2 = (v: number) => Math.round(v * 100) / 100;

export function TimelineView({ switcher }: { switcher: ReactNode }) {
  const { s: d } = useWorkspace();
  const router = useRouter();
  const [zoom, setZoom] = useState<Zoom>('month');
  const [healths, setHealths] = useState<Set<Health>>(new Set(['on', 'risk', 'off']));
  const [from, to] = RANGE[zoom];
  const span = to - from;
  const pct = (day: number) => r2(((Math.max(from, Math.min(to, day)) - from) / span) * 100);
  const days = Array.from({ length: span }, (_, i) => from + i);

  const counts = Object.fromEntries(HEALTHS.map((h) => [h.id, d.projects.filter((x) => x.health === h.id).length])) as Record<Health, number>;
  const list = d.projects.filter((x) => healths.has(x.health));
  const toggle = (h: Health) => setHealths((x) => { const n = new Set(x); if (n.has(h)) { if (n.size > 1) n.delete(h); } else n.add(h); return n; });

  /* rows grouped by brand */
  type Row = { kind: 'group'; brand: BrandId; n: number; y: number } | { kind: 'project'; p: Project; y: number };
  const rows: Row[] = [];
  let y = 0;
  for (const b of ORDER) {
    const ps = list.filter((x) => x.brand === b).sort((a, c) => metaFor(a.id).start - metaFor(c.id).start);
    if (!ps.length) continue;
    rows.push({ kind: 'group', brand: b, n: ps.length, y }); y += GROUP;
    for (const x of ps) { rows.push({ kind: 'project', p: x, y }); y += ROW; }
  }
  const height = y;

  const nextOf = (x: Project) => metaFor(x.id).milestones.find((ms) => ms.day + 1 > NOW_DAY);
  const upcoming = list.flatMap((x) => metaFor(x.id).milestones.map((ms) => ({ ...ms, p: x }))).filter((ms) => ms.day + 1 > NOW_DAY).sort((a, b) => a.day - b.day);
  const next = upcoming[0];
  const inDays = (day: number) => (day - 6 <= 0 ? 'today' : day - 6 === 1 ? 'tomorrow' : `in ${day - 6} days`);

  const ticks = zoom === 'week'
    ? days.map((dd) => ({ day: dd, label: `${weekday(dd).slice(0, 2)} ${dayLabel(dd).split(' ')[0]}` }))
    : days.filter((dd) => weekday(dd) === 'Mon' && (zoom === 'month' || (dd - 5) % 14 === 0)).map((dd) => ({ day: dd, label: dayLabel(dd) }));
  const months = [{ label: 'September', s: -29, e: 1 }, { label: 'October', s: 1, e: 32 }, { label: 'November', s: 32, e: 62 }, { label: 'December', s: 62, e: 93 }]
    .map((m) => ({ ...m, a: Math.max(from, m.s), b: Math.min(to, m.e) }))
    .filter((m) => m.b - m.a > 0);
  const nowIn = NOW_DAY >= from && NOW_DAY < to;

  return (
    <>
      <PageHeader crumbs={[{ label: 'Plan', href: '/app/plan' }, { label: `${dayLabel(from)} – ${dayLabel(to - 1)}` }]} title="Plan"
        actions={<Button variant="dark" icon={<CalendarPlus size={15} />} onClick={() => router.replace('/app/plan', { scroll: false })} title="Open the calendar to schedule work">Schedule task</Button>} />

      <ViewBar left={switcher} right={
        <>
          <Segmented<Zoom> value={zoom} onChange={setZoom} options={[{ id: 'week', label: 'Week' }, { id: 'month', label: 'Month' }, { id: 'quarter', label: 'Quarter' }]} />
          <span className={p.divider} />
          {HEALTHS.map((h) => (
            <FilterPill key={h.id} on={healths.has(h.id)} onClick={() => toggle(h.id)} count={counts[h.id]} swatch={<i className={cx(p.sw, s['hl_' + h.id])} />}>{h.label}</FilterPill>
          ))}
          <Count>{list.length} {list.length === 1 ? 'project' : 'projects'}</Count>
        </>
      } />

      {next ? (
        <Callout icon={<Flag size={15} />} title={`Next milestone ${inDays(next.day)}`}
          action={<Link href={`/app/projects/${next.p.id}`} className={p.cChip}><BrandChip id={next.p.brand} size={18} />{next.p.name}<ArrowRight size={14} /></Link>}>
          <span><b className={s.cStrong}>{next.label}</b> · {weekday(next.day)} {dayLabel(next.day)}</span>
          {next.p.health !== 'on' ? <span>· project is {next.p.health === 'off' ? 'off track' : 'at risk'}</span> : null}
        </Callout>
      ) : null}

      {!list.length ? (
        <Empty icon={<FolderKanban size={18} />}>
          <span>No projects in this brand match the health filter.</span>
          <Button size="sm" variant="light" onClick={() => setHealths(new Set(['on', 'risk', 'off']))}>Show all projects</Button>
        </Empty>
      ) : (
        <section className={s.gantt}>
          <div className={s.legendRow}>
            <div className={p.legend}>
              <span><i className={s.lgDone} />Done</span>
              <span><i className={s.lgLeft} />Remaining</span>
              <span><i className={s.lgSlip} />Expected slip</span>
              <span><i className={s.lgMs} />Milestone</span>
              <span><i className={s.lgMsDone} />Milestone passed</span>
              <span><i className={s.lgNow} />Now</span>
            </div>
          </div>

          <div className={s.gHead}>
            <div className={s.gLeftHead}>Project</div>
            <div className={s.gScale}>
              <div className={s.gMonths}>
                {months.map((m) => <span key={m.label} style={{ left: `${pct(m.a)}%`, width: `${r2(((m.b - m.a) / span) * 100)}%` }}>{m.label}</span>)}
              </div>
              <div className={s.gTicks}>
                {ticks.map((t) => (
                  <span key={t.day} className={cx(s.gTick, Math.floor(NOW_DAY) === t.day && s.gTickNow)} style={{ left: `${pct(t.day)}%` }}>{t.label}</span>
                ))}
              </div>
              {nowIn ? <span className={s.nowPill} style={{ left: `${pct(NOW_DAY)}%` }}>Today</span> : null}
            </div>
          </div>

          <div className={s.gBody} style={{ height }}>
            {/* left column: every label lives here */}
            <div className={s.gLeft}>
              {rows.map((r) => {
                if (r.kind === 'group') {
                  return <div key={'g' + r.brand} className={s.gGroup} style={{ top: r.y, height: GROUP }}><BrandChip id={r.brand} size={20} />{brandName(r.brand)}<em>{r.n}</em></div>;
                }
                const nx = nextOf(r.p);
                return (
                  <Link key={r.p.id} href={`/app/projects/${r.p.id}`} className={s.gName} style={{ top: r.y, height: ROW }} title={`Open ${r.p.name}`}>
                    <span className={s.gNameMain}>
                      <b>{r.p.name}</b>
                      <span>{nx ? <>Next: {nx.label} · {weekday(nx.day)} {dayLabel(nx.day).split(' ')[0]}</> : <>Due {r.p.due}</>} · {r.p.progress}%</span>
                    </span>
                    <HealthBadge health={r.p.health} />
                  </Link>
                );
              })}
            </div>

            {/* chart: bars only */}
            <div className={s.gChart}>
              <div className={s.gGrid}>
                {days.map((dd) => (
                  <span key={dd} className={cx(zoom !== 'quarter' && isWeekend(dd) && s.gWeekend, weekday(dd) === 'Mon' && s.gMon)} style={{ left: `${pct(dd)}%`, width: `${r2(100 / span)}%` }} />
                ))}
              </div>
              {rows.filter((r) => r.kind === 'group').map((r) => <div key={'gb' + r.y} className={s.gGroupBand} style={{ top: r.y, height: GROUP }} />)}

              {rows.map((r) => {
                if (r.kind !== 'project') return null;
                const x = r.p;
                const m = metaFor(x.id);
                const end = dueDay(x) + 1;
                const visible = end > from && m.start < to;
                const slip = SLIP[x.health];
                const top = r.y + ROW / 2 - 9;
                const style = { ['--b' as string]: brandColor(x.brand), top, left: `${pct(m.start)}%`, width: `${r2(pct(end) - pct(m.start))}%` } as CSSProperties;
                return (
                  <div key={x.id}>
                    {visible ? (
                      <Link href={`/app/projects/${x.id}`} className={cx(s.bar, m.start < from && s.barClipL, end > to && s.barClipR)} style={style}
                        title={`${x.name} · ${dayLabel(m.start)} → ${x.due} · ${x.progress}% done`} aria-label={`${x.name}, ${x.progress}% done, due ${x.due}`}>
                        <span className={cx(s.barFill, 'anim-grow-x')} style={{ width: `${x.progress}%` }} />
                      </Link>
                    ) : null}
                    {slip && end < to ? (
                      <span className={cx(s.slip, x.health === 'off' ? s.slipOff : s.slipRisk)} style={{ top, left: `${pct(end)}%`, width: `${r2(pct(end + slip) - pct(end))}%` }} title={`Expected slip +${slip} days`} />
                    ) : null}
                    {m.milestones.map((ms) => {
                      if (ms.day < from || ms.day >= to) return null;
                      const passed = ms.day + 1 <= NOW_DAY;
                      const isNext = next && next.p.id === x.id && next.id === ms.id;
                      return (
                        <span key={ms.id} className={cx(s.ms, passed && s.msDone, isNext && s.msNext)} style={{ top: r.y + ROW / 2, left: `${pct(ms.day + 0.5)}%` }}
                          title={`${ms.label} · ${weekday(ms.day)} ${dayLabel(ms.day)}`}><i /></span>
                      );
                    })}
                  </div>
                );
              })}

              {nowIn ? <div className={s.now} style={{ left: `${pct(NOW_DAY)}%` }} /> : null}
            </div>
          </div>
        </section>
      )}
    </>
  );
}
