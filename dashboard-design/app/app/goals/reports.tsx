'use client';

/*
 * Reports tab (absorbs the old Reports page): 4 Stats + 4 bar/line charts, each with a plain
 * title, the question it answers, data freshness and a click-through to the records behind it.
 * Records open in one list below; tasks open the shared task drawer.
 */

import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
import { ChevronRight, RefreshCw, X } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { useApp } from '@/lib/app-state';
import { byBrand, projects, reports, type WorkItem } from '@/lib/app-data';
import { brands, NOW, throughput, weeksLabels, type BrandId } from '@/lib/data';
import { BrandChip } from '@/components/brand';
import { Button, Card, Empty, IconButton, Segmented, Stat, StatusBadge } from '@/components/paper/ui';
import { ChartCard, ColumnChart, Legend, LineChart } from './charts';
import s from './goals.module.css';

export type Range = '4w' | '8w' | '12w';
type Drill = 'completed' | 'flow' | 'cycle' | 'planned';

const sum = (xs: number[]) => xs.reduce((a, c) => a + c, 0);
const allTp = sum([...throughput.op, ...throughput.ma, ...throughput.ax]);
const cycleShift: Record<BrandId, number> = { op: -0.2, ma: 0.4, ax: 0.1 };

export type Fresh = { at: string; ago: string };

/** Freshness + refresh + range, shown on the right of the ViewBar. */
export function ReportsBar({ range, setRange, fresh, setFresh }: { range: Range; setRange: (r: Range) => void; fresh: Fresh; setFresh: (f: Fresh) => void }) {
  const { toast } = useApp();
  const [spin, setSpin] = useState(false);
  const refresh = () => {
    setSpin(true);
    setTimeout(() => { setSpin(false); setFresh({ at: NOW.time, ago: 'just now' }); toast('Data refreshed'); }, 600);
  };
  return (
    <>
      <span className={s.fresh}>Data updated {fresh.at} · {fresh.ago}</span>
      <IconButton small label="Refresh data" onClick={refresh}><RefreshCw size={14} className={spin ? 'anim-spin' : undefined} /></IconButton>
      <Segmented<Range> sub size="sm" value={range} onChange={setRange} options={[{ id: '4w', label: '4 weeks' }, { id: '8w', label: '8 weeks' }, { id: '12w', label: '12 weeks' }]} />
    </>
  );
}

export function Reports({ range, fresh }: { range: Range; fresh: Fresh }) {
  const { brand, s: d } = useWorkspace();
  const { tasks, openTask } = useApp();
  const [drill, setDrill] = useState<Drill | null>(null);
  const recordsRef = useRef<HTMLDivElement>(null);

  const n = range === '4w' ? 4 : range === '8w' ? 8 : 12;
  const from = 12 - n;
  const share = brand ? sum(throughput[brand]) / allTp : 1;

  const m = useMemo(() => {
    const completedW = d.throughput.slice(from);
    const createdW = reports.created.map((v) => Math.round(v * share)).slice(from);
    const cycleW = reports.cycleTime.map((v) => Math.round((v + (brand ? cycleShift[brand] : 0)) * 10) / 10).slice(from);
    const half = Math.floor(n / 2);
    const prev = sum(completedW.slice(0, half));
    const last = sum(completedW.slice(half));
    const ps = byBrand(projects, brand);
    const pva = brands.filter((b) => !brand || b.id === brand).map((b) => {
      const rows = ps.filter((p) => p.brand === b.id);
      return { brand: b.id, name: b.name, planned: sum(rows.map((p) => p.hoursPlanned)), actual: sum(rows.map((p) => p.hoursActual)) };
    });
    return {
      completedW, createdW, cycleW, pva, ps,
      completed: sum(completedW), created: sum(createdW),
      delta: prev ? Math.round(((last - prev) / prev) * 100) : 0,
      cycleNow: cycleW[cycleW.length - 1],
      cycleDelta: Math.round(((cycleW[cycleW.length - 1] - cycleW[0]) / cycleW[0]) * 100),
      planned: sum(ps.map((p) => p.hoursPlanned)), actual: sum(ps.map((p) => p.hoursActual)),
    };
  }, [d.throughput, share, brand, from, n]);

  const labels = weeksLabels.slice(from);
  const freshTxt = `Updated ${fresh.at} · from task history`;
  const scoped = tasks.filter((t) => !brand || t.brand === brand);
  const net = m.completed - m.created;
  const pvaMax = Math.max(...m.pva.flatMap((r) => [r.planned, r.actual]), 1);

  const open = (k: Drill) => {
    setDrill(k);
    requestAnimationFrame(() => recordsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  return (
    <>
      <section className={s.stats}>
        <Stat label={`Tasks completed · ${n} weeks`} value={m.completed} sub={`${m.delta >= 0 ? '+' : ''}${m.delta}% vs the ${n / 2} weeks before`} tone={m.delta >= 0 ? 'green' : 'amber'} onClick={() => open('completed')} />
        <Stat label="Finished minus new" value={`${net > 0 ? '+' : ''}${net}`} sub={`${m.created} new · ${m.completed} finished`} tone={net < 0 ? 'amber' : 'green'} onClick={() => open('flow')} />
        <Stat label="Cycle time, latest week" value={`${m.cycleNow} days`} sub={`${m.cycleDelta <= 0 ? 'Down' : 'Up'} ${Math.abs(m.cycleDelta)}% over ${n} weeks`} tone={m.cycleDelta <= 0 ? 'green' : 'amber'} onClick={() => open('cycle')} />
        <Stat label="Hours, actual / planned" value={`${m.actual} / ${m.planned}h`} sub={m.actual > m.planned ? `${m.actual - m.planned}h over plan` : `${m.planned - m.actual}h left in plan`} tone={m.actual > m.planned ? 'red' : undefined} onClick={() => open('planned')} />
      </section>

      <div className={s.charts}>
        <ChartCard title="Tasks finished each week" question="Are we shipping more or less than before?" fresh={freshTxt}
          action={<Button size="sm" onClick={() => open('completed')}>See finished tasks <ChevronRight size={14} /></Button>}>
          <ColumnChart labels={labels} series={[{ label: 'Finished', values: m.completedW, color: 'var(--ink)' }]} onBar={() => open('completed')} />
        </ChartCard>

        <ChartCard title="New work vs finished work" question="Is the backlog growing? Grey taller than black means yes." fresh={freshTxt}
          legend={<Legend series={[{ label: 'New', color: 'var(--line2)' }, { label: 'Finished', color: 'var(--ink)' }]} />}
          action={<Button size="sm" onClick={() => open('flow')}>See open work <ChevronRight size={14} /></Button>}>
          <ColumnChart labels={labels} series={[{ label: 'New', values: m.createdW, color: 'var(--line2)' }, { label: 'Finished', values: m.completedW, color: 'var(--ink)' }]} onBar={() => open('flow')} />
        </ChartCard>

        <ChartCard title="Days from start to done" question="Cycle time per week. Lower is faster." fresh={freshTxt}
          action={<Button size="sm" onClick={() => open('cycle')}>See recent tasks <ChevronRight size={14} /></Button>}>
          <LineChart labels={labels} fmt={(v) => `${Math.round(v * 10) / 10}d`} series={[{ label: 'Cycle time', values: m.cycleW, color: 'var(--k1)' }]} />
        </ChartCard>

        <ChartCard title="Planned vs actual hours by brand" question="Where is time going over plan?" fresh={`Updated ${fresh.at} · from time logs`}
          legend={<Legend series={[{ label: 'Planned', color: 'var(--line2)' }, { label: 'Actual', color: 'var(--ink)' }, { label: 'Over plan', color: 'var(--red)' }]} />}
          action={<Button size="sm" onClick={() => open('planned')}>See projects <ChevronRight size={14} /></Button>}>
          <div className={s.hbars}>
            {m.pva.map((r) => {
              const over = r.actual > r.planned;
              return (
                <button key={r.brand} type="button" className={s.hbarRow} onClick={() => open('planned')}>
                  <span className={s.hbarName}><BrandChip id={r.brand} size={20} />{r.name}</span>
                  <span className={s.hbarTracks}>
                    <span className={s.hbar}><i className="anim-grow-x" style={{ width: `${(r.planned / pvaMax) * 100}%`, background: 'var(--line2)' }} /></span>
                    <span className={s.hbar}><i className="anim-grow-x" style={{ width: `${(r.actual / pvaMax) * 100}%`, background: over ? 'var(--red)' : 'var(--ink)' }} /></span>
                  </span>
                  <span className={over ? s.hbarBad : s.hbarNum}>{r.actual} / {r.planned}h</span>
                </button>
              );
            })}
          </div>
        </ChartCard>
      </div>

      <div ref={recordsRef}>
        {drill ? <Records drill={drill} close={() => setDrill(null)} tasks={scoped} ps={m.ps} openTask={openTask} /> : null}
      </div>
    </>
  );
}

const drillTitle: Record<Drill, string> = {
  completed: 'Finished tasks', flow: 'Open work (new and in progress)', cycle: 'Recently finished or in review', planned: 'Projects by hours used',
};

function Records({ drill, close, tasks, ps, openTask }: { drill: Drill; close: () => void; tasks: WorkItem[]; ps: typeof projects; openTask: (id: string) => void }) {
  const rows: WorkItem[] =
    drill === 'completed' ? tasks.filter((t) => t.status === 'done')
      : drill === 'flow' ? tasks.filter((t) => t.status !== 'done')
        : drill === 'cycle' ? tasks.filter((t) => t.status === 'done' || t.status === 'review') : [];
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name;

  return (
    <Card title={`Records · ${drillTitle[drill]}`} actions={<IconButton small label="Close records" onClick={close}><X size={15} /></IconButton>}>
      {drill === 'planned' ? (
        <div className={s.rows}>
          {[...ps].sort((a, b) => (b.hoursActual - b.hoursPlanned) - (a.hoursActual - a.hoursPlanned)).map((p) => (
            <Link key={p.id} href={`/app/projects/${p.id}`} className={s.recRow}>
              <BrandChip id={p.brand} size={22} />
              <span className={s.rowLink}>{p.name}</span>
              <span className={p.hoursActual > p.hoursPlanned ? s.hbarBad : s.hbarNum}>{p.hoursActual} / {p.hoursPlanned}h</span>
              <ChevronRight size={15} />
            </Link>
          ))}
        </div>
      ) : rows.length ? (
        <div className={s.rows}>
          {rows.map((t) => (
            <button key={t.id} type="button" className={s.recRow} onClick={() => openTask(t.id)}>
              <BrandChip id={t.brand} size={22} />
              <span className={s.rowLink}>{t.title}<small>{t.key} · {projectName(t.projectId)}</small></span>
              <StatusBadge status={t.status} />
              <ChevronRight size={15} />
            </button>
          ))}
        </div>
      ) : <Empty>No records for this brand in this range.</Empty>}
    </Card>
  );
}
