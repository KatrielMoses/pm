'use client';

/*
 * Goals (absorbs Reports). Tabs: Goals · Reports. ?tab=reports deep-links (old /app/reports URL).
 * Goals: list of goals with health (pace) and confidence, current → target bar, linked projects;
 * the selected goal's detail on the right.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Building2, Download, Link2, Plus, Target } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { useApp } from '@/lib/app-state';
import { byBrand, goalsFull, personById, projectById, type Goal } from '@/lib/app-data';
import { brandName, weeksLabels, type Health } from '@/lib/data';
import { BrandChip } from '@/components/brand';
import { Avatar, Badge, Button, Card, Empty, HealthBadge, PageHeader, Segmented, Thin, ViewBar } from '@/components/paper/ui';
import { Legend, LineChart } from './charts';
import { Reports, ReportsBar, type Fresh, type Range } from './reports';
import s from './goals.module.css';

type Tab = 'goals' | 'reports';
type Period = 'all' | 'Q4 2026' | 'Oct 2026';
type Conf = Goal['confidence'];
const confTone = { high: 'green', medium: 'amber', low: 'red' } as const;
const confText = { high: 'High', medium: 'Medium', low: 'Low' } as const;
const HORIZON = 13; // weeks in the goal period

const fmt = (v: number, unit: string) => {
  const n = Math.round(v * 10) / 10;
  return unit === '$' ? `$${n.toLocaleString('en-US')}` : `${n.toLocaleString('en-US')}${unit}`;
};
const start = (g: Goal) => g.trend[0];
const paceAt = (g: Goal, i: number) => start(g) + ((g.target - start(g)) * (i + 1)) / HORIZON;
const paceNow = (g: Goal) => paceAt(g, g.trend.length - 1);
/** Health from pace: share of the expected-by-now gain actually achieved. */
const healthOf = (g: Goal): Health => {
  const r = (g.current - start(g)) / (paceNow(g) - start(g) || 1);
  return r >= 0.9 ? 'on' : r >= 0.6 ? 'risk' : 'off';
};
const pctOf = (g: Goal) => Math.max(0, Math.min(100, Math.round(((g.current - start(g)) / (g.target - start(g) || 1)) * 100)));

export default function GoalsPage() {
  const { brand, s: d } = useWorkspace();
  const { toast } = useApp();
  const [tab, setTabState] = useState<Tab>('goals');
  const [period, setPeriod] = useState<Period>('all');
  const [range, setRange] = useState<Range>('12w');
  const [fresh, setFresh] = useState<Fresh>({ at: '10:38', ago: '2 min ago' });
  const [sel, setSel] = useState<string | null>(null);
  const [conf, setConf] = useState<Record<string, Conf>>({});
  const [extra, setExtra] = useState<Record<string, string>>({}); // projectId -> goalId

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tab') === 'reports') setTabState('reports');
  }, []);
  const setTab = (t: Tab) => {
    setTabState(t);
    window.history.replaceState(null, '', t === 'reports' ? `${window.location.pathname}?tab=reports` : window.location.pathname);
  };

  const linkedOf = (g: Goal) => [...g.projects, ...Object.entries(extra).filter(([, gid]) => gid === g.id).map(([pid]) => pid)];
  const confOf = (g: Goal) => conf[g.id] ?? g.confidence;
  const all = byBrand(goalsFull, brand);
  const goals = all.filter((g) => period === 'all' || g.period === period);
  const g = goals.find((x) => x.id === sel) ?? goals[0];
  const goalProjects = new Set(goalsFull.flatMap((x) => linkedOf(x)));
  const orphans = d.projects.filter((p) => !goalProjects.has(p.id));

  return (
    <>
      <PageHeader
        title="Goals"
        count={tab === 'goals' ? goals.length : undefined}
        actions={tab === 'goals'
          ? <Button variant="dark" size="lg" icon={<Plus size={16} />} onClick={() => toast('Goal drafted')}>New goal</Button>
          : <Button variant="dark" size="lg" icon={<Download size={16} />} onClick={() => toast(`Report exported · CSV · ${range}`)}>Export CSV</Button>}
      />

      <ViewBar
        left={<Segmented<Tab> value={tab} onChange={setTab} options={[{ id: 'goals', label: 'Goals', count: all.length }, { id: 'reports', label: 'Reports' }]} />}
        right={tab === 'goals'
          ? <Segmented<Period> sub size="sm" value={period} onChange={setPeriod} options={[{ id: 'all', label: 'All periods' }, { id: 'Q4 2026', label: 'Q4 2026' }, { id: 'Oct 2026', label: 'October' }]} />
          : <ReportsBar range={range} setRange={setRange} fresh={fresh} setFresh={setFresh} />}
      />

      {tab === 'reports' ? <Reports range={range} fresh={fresh} /> : !goals.length ? (
        <Empty icon={<Target size={20} />}>
          <span>{period !== 'all' ? 'No goals in this period.' : brand ? `${brandName(brand)} has no goals yet.` : 'No goals yet.'} Goals tie projects to an outcome you can measure.</span>
          {period !== 'all' ? <Button size="sm" onClick={() => setPeriod('all')}>Show all periods</Button> : <Button size="sm" variant="dark" icon={<Plus size={14} />} onClick={() => toast('Goal drafted')}>New goal</Button>}
        </Empty>
      ) : (
        <div className={s.layout}>
          <div className={s.leftCol}>
            <div className={s.list} role="listbox" aria-label="Goals">
              {goals.map((x) => (
                <button key={x.id} role="option" aria-selected={x.id === g?.id} className={x.id === g?.id ? s.goalOn : s.goal} onClick={() => setSel(x.id)}>
                  <span className={s.goalTop}>
                    {x.brand ? <BrandChip id={x.brand} size={26} /> : <span className={s.ws}><Building2 size={14} /></span>}
                    <span className={s.goalTitle}>{x.title}<small>{x.period} · {linkedOf(x).length ? `${linkedOf(x).length} project${linkedOf(x).length === 1 ? '' : 's'}` : 'No projects'}</small></span>
                    <HealthBadge health={healthOf(x)} />
                  </span>
                  <span className={s.goalBar}><Thin value={pctOf(x)} height={6} /></span>
                  <span className={s.goalNums}>
                    <b>{fmt(x.current, x.unit)}</b><span>→ {fmt(x.target, x.unit)}</span>
                    <span className={s.push}>Confidence <Badge tone={confTone[confOf(x)]}>{confText[confOf(x)]}</Badge></span>
                  </span>
                </button>
              ))}
            </div>

            {orphans.length && g ? (
              <Card title="Projects without a goal" actions={<span className={s.count}>{orphans.length}</span>}>
                <div className={s.rows}>
                  {orphans.map((p) => (
                    <div key={p.id} className={s.row}>
                      <BrandChip id={p.brand} size={22} />
                      <Link href={`/app/projects/${p.id}`} className={s.rowLink}>{p.name}</Link>
                      <Button size="sm" icon={<Link2 size={13} />} onClick={() => { setExtra((e) => ({ ...e, [p.id]: g.id })); toast(`${p.name} linked to ${g.title}`); }}>Link to {g.title}</Button>
                    </div>
                  ))}
                </div>
              </Card>
            ) : null}
          </div>

          {g ? <Detail key={g.id} g={g} conf={confOf(g)} linked={linkedOf(g)} setConf={(v) => { setConf((c) => ({ ...c, [g.id]: v })); toast(`Confidence · ${confText[v]}`); }} /> : null}
        </div>
      )}
    </>
  );
}

function Detail({ g, conf, setConf, linked }: { g: Goal; conf: Conf; setConf: (c: Conf) => void; linked: string[] }) {
  const owner = personById(g.owner);
  const pace = paceNow(g);
  const labels = weeksLabels.slice(-g.trend.length);
  const pacePct = Math.min(100, ((pace - start(g)) / (g.target - start(g) || 1)) * 100);

  return (
    <Card className={s.detail}>
      <div className={s.dHead}>
        {g.brand ? <BrandChip id={g.brand} size={40} /> : <span className={s.ws} style={{ width: 40, height: 40 }}><Building2 size={18} /></span>}
        <div className={s.dTitle}>
          <h2>{g.title}</h2>
          <span className={s.dMeta}><Avatar id={g.owner} size={20} />{owner?.name} · {g.period} · {g.brand ? brandName(g.brand) : 'Workspace'} · updated {g.update === 'today' ? 'today' : `${g.update} ago`}</span>
        </div>
        <HealthBadge health={healthOf(g)} />
      </div>

      <div className={s.progress}>
        <div className={s.progNums}>
          <span><small>Start</small><b>{fmt(start(g), g.unit)}</b></span>
          <span><small>Now</small><b className={s.now}>{fmt(g.current, g.unit)}</b></span>
          <span><small>Expected by now</small><b>{fmt(Math.round(pace), g.unit)}</b></span>
          <span className={s.push}><small>Target</small><b>{fmt(g.target, g.unit)}</b></span>
        </div>
        <div className={s.track}>
          <i className="anim-grow-x" style={{ width: `${pctOf(g)}%` }} />
          <span className={s.paceMark} style={{ left: `${pacePct}%` }} title={`Expected by now: ${fmt(Math.round(pace), g.unit)}`} />
        </div>
      </div>

      <div className={s.sec}>
        <div className={s.secHead}><h3>Weekly progress</h3><Legend series={[{ label: 'Actual', color: 'var(--ink)' }, { label: 'Needed pace', color: 'var(--mute)', dashed: true }]} /></div>
        <LineChart height={150} labels={labels} fmt={(v) => fmt(Math.round(v), g.unit)}
          series={[{ label: 'Actual', values: g.trend, color: 'var(--ink)' }, { label: 'Needed pace', values: g.trend.map((_, i) => paceAt(g, i)), color: 'var(--mute)', dashed: true }]} />
      </div>

      <div className={s.sec}>
        <div className={s.secHead}>
          <h3>Confidence</h3>
          <Segmented<Conf> sub size="sm" value={conf} onChange={setConf} options={[{ id: 'high', label: 'High' }, { id: 'medium', label: 'Medium' }, { id: 'low', label: 'Low' }]} />
        </div>
      </div>

      <div className={s.sec}>
        <div className={s.secHead}><h3>Key results</h3><span className={s.count}>{g.keyResults.length}</span></div>
        <div className={s.rows}>
          {g.keyResults.map((kr) => {
            const lower = /churn/i.test(kr.title);
            const r = lower ? Math.min(1, kr.target / kr.current) : Math.min(1, kr.current / kr.target);
            const tone = r >= 0.8 ? 'green' : r >= 0.5 ? 'amber' : 'red';
            return (
              <div key={kr.title} className={s.kr}>
                <span className={s.krTitle}>{kr.title}{lower ? <small> (lower is better)</small> : null}</span>
                <span className={s.krBar}><Thin value={r * 100} height={6} color={tone === 'red' ? 'var(--red)' : undefined} /></span>
                <span className={s.krNum}>{kr.current}{kr.unit} <small>/ {kr.target}{kr.unit}</small></span>
                <Badge tone={tone}>{tone === 'green' ? 'On pace' : tone === 'amber' ? 'Watch' : 'Behind'}</Badge>
              </div>
            );
          })}
        </div>
      </div>

      <div className={s.sec}>
        <div className={s.secHead}><h3>Linked projects</h3><span className={s.count}>{linked.length}</span></div>
        {linked.length ? (
          <div className={s.rows}>
            {linked.map((pid) => {
              const p = projectById(pid);
              if (!p) return null;
              return (
                <Link key={pid} href={`/app/projects/${pid}`} className={s.projRow}>
                  <BrandChip id={p.brand} size={24} />
                  <span className={s.rowLink}>{p.name}</span>
                  <span className={s.projBar}><Thin value={p.progress} height={5} /></span>
                  <span className={s.count}>{p.progress}%</span>
                  <HealthBadge health={p.health} />
                </Link>
              );
            })}
          </div>
        ) : <Empty>No projects drive this goal yet. Link one from “Projects without a goal”.</Empty>}
      </div>
    </Card>
  );
}
