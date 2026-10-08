'use client';

/*
 * Plan › Workload: person × day grid. Each cell shows planned / available hours and a bar;
 * over-capacity cells are hatched red. One action: Rebalance (with Undo). ≤4 stats, one ink
 * callout naming who is over.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { CalendarOff, CircleAlert, RotateCcw, Sparkles, Users } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { useApp } from '@/lib/app-state';
import { personById, workload, WEEK_DAYS, TODAY_INDEX } from '@/lib/app-data';
import type { BrandId } from '@/lib/data';
import { BrandChip } from '@/components/brand';
import { Avatar, Badge, Button, CapacityBar, Empty, PageHeader, Stat, ViewBar } from '@/components/paper/ui';
import { Callout, Count, cx, FilterPill } from './shared';
import p from './plan.module.css';
import s from './workload.module.css';

type Load = { person: string; days: number[]; avail: number[]; brands: Record<BrandId, number> };
const TIME_OFF = [
  { id: 'to1', person: 'ar', day: 4, label: 'Day off' },
  { id: 'to2', person: 'ln', day: 2, label: 'Conference' },
];
const sum = (xs: number[]) => xs.reduce((a, c) => a + c, 0);
const r1 = (n: number) => Math.round(n * 10) / 10;
const fh = (n: number) => (Number.isInteger(n) ? `${n}` : n.toFixed(1));
const offOn = (person: string, day: number) => TIME_OFF.find((t) => t.person === person && t.day === day);

/** Time off zeroes availability on that day. */
function seedLoad(): Load[] {
  return workload.map((w) => ({ ...w, days: [...w.days], avail: w.avail.map((a, i) => (offOn(w.person, i) ? 0 : a)) }));
}

/** Move hours off over-capacity days (today onward) onto the freest weekdays of the same person. */
function rebalance(rows: Load[]) {
  let moved = 0;
  const next = rows.map((w) => {
    const days = [...w.days];
    for (let i = TODAY_INDEX; i < 7; i++) {
      let excess = r1(days[i] - w.avail[i]);
      while (excess > 0) {
        let best = -1;
        let bestFree = 0;
        for (let j = TODAY_INDEX; j < 5; j++) {
          const free = r1(w.avail[j] - days[j]);
          if (j !== i && free > bestFree) { best = j; bestFree = free; }
        }
        if (best < 0) break;
        const step = Math.min(excess, bestFree);
        days[i] = r1(days[i] - step); days[best] = r1(days[best] + step);
        excess = r1(excess - step); moved = r1(moved + step);
      }
    }
    return { ...w, days };
  });
  return { next, moved };
}

function Cell({ planned, avail, today, off }: { planned: number; avail: number; today: boolean; off?: string }) {
  const over = r1(planned - avail);
  const empty = planned === 0 && avail === 0;
  const max = Math.max(planned, avail) || 1;
  return (
    <div className={cx(s.cell, over > 0 && s.cellOver, empty && s.cellEmpty, today && s.cellToday)}
      title={empty ? (off ?? 'Not working') : `${fh(planned)}h planned of ${fh(avail)}h available${over > 0 ? ` · ${fh(over)}h over` : ''}`}>
      {empty ? <span className={s.offTxt}>{off ?? 'Off'}</span> : (
        <>
          <span className={s.cellNum}>
            <b>{fh(planned)}</b><span>/ {fh(avail)}h</span>
            {over > 0 ? <em className={s.overTag}>+{fh(over)}</em> : null}
          </span>
          <span className={s.cellBar}>
            <i className={cx(s.cbIn, today && s.cbToday)} style={{ width: `${(Math.min(planned, avail) / max) * 100}%` }} />
            {over > 0 ? <i className={s.cbOver} style={{ width: `${(over / max) * 100}%` }} /> : null}
          </span>
          {off ? <span className={s.offNote}><CalendarOff size={12} />{off}</span> : null}
        </>
      )}
    </div>
  );
}

export function WorkloadView({ switcher }: { switcher: ReactNode }) {
  const { brand } = useWorkspace();
  const { toast } = useApp();
  const [load, setLoad] = useState<Load[]>(seedLoad);
  const [prev, setPrev] = useState<Load[] | null>(null);
  const [overOnly, setOverOnly] = useState(false);

  const team = useMemo(() => load.filter((w) => !brand || personById(w.person)?.brands.includes(brand)), [load, brand]);
  const isOver = (w: Load) => w.days.some((d, i) => d > w.avail[i]);
  const rows = overOnly ? team.filter(isOver) : team;

  const tPlanned = r1(sum(team.map((w) => sum(w.days))));
  const tAvail = r1(sum(team.map((w) => sum(w.avail))));
  const overHours = r1(team.reduce((a, w) => a + sum(w.days.map((d, i) => Math.max(0, d - w.avail[i]))), 0));
  const freeHours = r1(team.reduce((a, w) => a + sum(w.days.map((d, i) => Math.max(0, w.avail[i] - d))), 0));
  const overPeople = team.filter(isOver);
  const offDays = TIME_OFF.filter((t) => team.some((w) => w.person === t.person));

  const doRebalance = () => {
    const { next, moved } = rebalance(load);
    if (moved === 0) { toast('Nothing to move: no free hours left this week', 'bad'); return; }
    setPrev(load); setLoad(next);
    toast(`${fh(moved)}h moved to free days`);
  };

  return (
    <>
      <PageHeader crumbs={[{ label: 'Plan', href: '/app/plan' }, { label: '5–11 Oct' }]} title="Plan"
        actions={
          <>
            {prev ? <Button variant="light" icon={<RotateCcw size={14} />} onClick={() => { setLoad(prev); setPrev(null); toast('Rebalance undone'); }}>Undo</Button> : null}
            <Button variant="dark" icon={<Sparkles size={15} />} onClick={doRebalance} title="Move over-capacity hours to free days">Rebalance</Button>
          </>
        } />

      <ViewBar left={switcher} right={
        <>
          <FilterPill on={!overOnly} onClick={() => setOverOnly(false)} count={team.length}>Everyone</FilterPill>
          <FilterPill on={overOnly} onClick={() => setOverOnly(true)} count={overPeople.length} swatch={<i className={cx(p.sw, s.swOver)} />}>Over capacity</FilterPill>
          <Count>{rows.length} {rows.length === 1 ? 'person' : 'people'}</Count>
        </>
      } />

      {overPeople.length ? (
        <Callout icon={<CircleAlert size={16} />} title={`${fh(overHours)}h over capacity`}>
          {overPeople.map((w) => {
            const n = w.days.filter((d, i) => d > w.avail[i]).length;
            return (
              <button key={w.person} type="button" className={p.cChip} onClick={() => setOverOnly(true)} title="Show only people over capacity">
                <Avatar id={w.person} size={20} />{personById(w.person)?.name}<em>{n} {n === 1 ? 'day' : 'days'}</em>
              </button>
            );
          })}
          <span>· Rebalance moves the extra hours to free days.</span>
        </Callout>
      ) : null}

      <section className={p.stats}>
        <Stat label="Planned this week" value={`${fh(tPlanned)}h`} sub={`of ${fh(tAvail)}h available`} />
        <Stat label="Over capacity" value={`${fh(overHours)}h`} tone={overHours > 0 ? 'red' : 'green'} sub={overHours > 0 ? `${overPeople.length} ${overPeople.length === 1 ? 'person' : 'people'} · show them` : 'Everyone fits'}
          onClick={overHours > 0 ? () => setOverOnly(true) : undefined} />
        <Stat label="Free hours" value={`${fh(freeHours)}h`} sub="Unbooked time left" />
        <Stat label="Time off" value={offDays.length} sub={offDays.length ? offDays.map((t) => `${personById(t.person)?.name.split(' ')[0]} ${WEEK_DAYS[t.day].d}`).join(' · ') : 'None this week'} />
      </section>

      <section className={s.card}>
        <div className={s.cardHead}>
          <span className={s.cardTitle}>Capacity · 5–11 Oct</span>
          <div className={p.legend}>
            <span><i className={s.lgIn} />Planned</span>
            <span><i className={s.lgToday} />Today</span>
            <span><i className={s.lgOver} />Over capacity</span>
            <span><i className={s.lgOff} />Off</span>
          </div>
        </div>

        {rows.length === 0 ? (
          <Empty icon={<Users size={18} />}>
            <span>{overOnly ? 'Nobody is over capacity this week.' : 'No people work on this brand.'}</span>
            {overOnly ? <Button size="sm" variant="light" onClick={() => setOverOnly(false)}>Show everyone</Button> : null}
          </Empty>
        ) : (
          <div className={s.grid}>
            <div className={s.gHead}>
              <span>Person</span>
              {WEEK_DAYS.map((d) => <span key={d.i} className={d.i === TODAY_INDEX ? s.gToday : undefined}>{d.d} {d.n}</span>)}
              <span>Week</span>
            </div>
            {rows.map((w) => {
              const person = personById(w.person)!;
              const planned = r1(sum(w.days));
              const avail = r1(sum(w.avail));
              const util = avail ? Math.round((planned / avail) * 100) : 0;
              return (
                <div key={w.person} className={s.gRow}>
                  <div className={s.person}>
                    <Avatar id={person.id} size={34} />
                    <span className={s.pName}>
                      <b>{person.name}</b>
                      <span className={s.pBrands}>{person.brands.map((b) => <BrandChip key={b} id={b} size={16} />)}<small>{person.role}</small></span>
                    </span>
                  </div>
                  {w.days.map((d, i) => <Cell key={i} planned={d} avail={w.avail[i]} today={i === TODAY_INDEX} off={offOn(w.person, i)?.label} />)}
                  <div className={s.weekCell}>
                    <div className={s.weekNum}>
                      <b>{fh(planned)}<span>/ {fh(avail)}h</span></b>
                      <Badge tone={util > 100 ? 'red' : util < 80 ? 'neutral' : 'green'}>{util}%</Badge>
                    </div>
                    <CapacityBar planned={planned} available={avail} height={8} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
