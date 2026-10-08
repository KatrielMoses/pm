import { useId, useState, type ReactNode } from 'react';
import { Link } from '../router.tsx';
import { BrandMarker } from '../shell/brand-marker.tsx';
import { routeHref } from '../shell/registry.ts';
import {
  CATEGORY_LABEL,
  HEALTH_LABEL,
  type DependencyPair,
  type DependencyState,
  type PortfolioDependencies,
  type PortfolioOrphans,
  type PortfolioOverview,
  type PortfolioProject,
  type PortfolioSummary,
  type ProjectCategory,
  type ProjectHealth,
} from './client.ts';
import {
  Chip,
  Coverage,
  declaredHealthLabel,
  HEALTH_INCOMPLETE_TEXT,
  HealthChip,
  minutesText,
  ProgressBar,
} from './shared.tsx';

/**
 * Portfolio views (5B GOAL-007..013). Every figure is the server's, computed for the viewer from
 * the projects, tasks, goals, and time they may read. Health is always accompanied by the rules
 * that produced it and by what could not be evaluated; the project's own declared health is shown
 * beside it when the two differ.
 */

const HEALTH_ORDER: ProjectHealth[] = ['off_track', 'at_risk', 'on_track', 'complete', 'unknown'];
const CATEGORY_ORDER: ProjectCategory[] = ['planned', 'active', 'paused', 'done', 'cancelled'];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---- Coverage ---------------------------------------------------------------------------------

export function OverviewCoverage({ o }: { o: PortfolioOverview }) {
  return (
    <Coverage note={o.coverage.note} asOf={o.as_of}>
      <p>
        {plural(o.coverage.evaluated_projects, 'project')} evaluated
        {o.coverage.scope === 'portfolio' ? ' in this portfolio' : ' from the projects you can read'}
        . Computed live for you.
      </p>
      {o.coverage.truncated ? (
        <p className="gl-warn">
          <span aria-hidden="true">△ </span>
          Incomplete: more projects match than could be evaluated, so these figures leave some out.
          Narrow the filters to see a complete picture.
        </p>
      ) : null}
    </Coverage>
  );
}

// ---- Summary ----------------------------------------------------------------------------------

function Tile({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="gl-tile" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="gl-stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function SummaryTiles({
  ws,
  s,
  notTracked,
  onOpenView,
}: {
  ws: string;
  s: PortfolioSummary;
  notTracked: string[];
  onOpenView: (v: 'dependencies' | 'orphans') => void;
}) {
  const noSpend = notTracked.includes('money_spend');
  const noAi = notTracked.includes('ai_usage');
  return (
    <div className="gl-tiles">
      <Tile title="Projects by status">
        <p className="gl-big">{s.projects}</p>
        <dl className="gl-stats">
          {CATEGORY_ORDER.map((c) => (
            <Stat key={c} label={CATEGORY_LABEL[c]} value={s.by_status[c] ?? 0} />
          ))}
        </dl>
      </Tile>
      <Tile title="Projects by health">
        <ul className="gl-plain">
          {HEALTH_ORDER.map((h) => (
            <li key={h}>
              <HealthChip value={h} /> <strong>{s.by_health[h] ?? 0}</strong>
            </li>
          ))}
        </ul>
      </Tile>
      <Tile title="Schedule">
        <dl className="gl-stats">
          <Stat label="Overdue" value={s.schedule.overdue_projects} />
          <Stat label="Due in 30 days" value={s.schedule.due_in_30_days} />
        </dl>
        {s.schedule.upcoming.length ? (
          <ul className="gl-plain">
            {s.schedule.upcoming.map((u) => (
              <li key={`${u.id}:${u.kind}`}>
                <Link to={routeHref('project', { ws, prj: u.id })}>{u.name}</Link>{' '}
                <span className="hint">
                  {u.kind === 'deadline' ? 'deadline' : 'target'} {u.date}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">Nothing due in the next 30 days.</p>
        )}
      </Tile>
      <Tile title="Effort">
        <dl className="gl-stats">
          <Stat label="Open estimate" value={minutesText(s.effort.open_estimate_minutes)} />
          <Stat label="Open tasks without an estimate" value={s.effort.unestimated_open_tasks} />
          <Stat label="Time logged" value={minutesText(s.effort.logged_minutes)} />
        </dl>
      </Tile>
      <Tile title="Budgets">
        {s.budgets.money.by_currency.length ? (
          <ul className="gl-plain">
            {s.budgets.money.by_currency.map((m) => (
              <li key={m.currency}>
                Budgeted: {new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(m.budgeted)}{' '}
                {m.currency} across {plural(m.projects, 'project')}
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">No money budgets are set.</p>
        )}
        <p>
          Time: {minutesText(s.budgets.time.budgeted_minutes)} budgeted, {minutesText(s.budgets.time.logged_minutes)}{' '}
          logged across {plural(s.budgets.time.projects, 'project')}
          {s.budgets.time.over_budget_projects
            ? `; ${plural(s.budgets.time.over_budget_projects, 'project')} over budget`
            : ''}
          .
        </p>
        {s.budgets.ai.projects ? (
          <p>AI budgets are set on {plural(s.budgets.ai.projects, 'project')}.</p>
        ) : null}
        <p className="gl-warn">
          <span aria-hidden="true">△ </span>
          {noSpend && noAi
            ? 'Money spend and AI usage are not tracked yet, so budgets show what was set, not what was used.'
            : noSpend
              ? 'Money spend is not tracked yet.'
              : noAi
                ? 'AI usage is not tracked yet.'
                : 'Spend and usage figures are shown where tracked.'}
        </p>
      </Tile>
      <Tile title="Goals coverage">
        <p className="gl-big">{s.goals.projects_without_goals}</p>
        <p>
          {s.goals.projects_without_goals === 1 ? 'project has' : 'projects have'} no goal you can see.
        </p>
        <button type="button" className="link-button" onClick={() => onOpenView('orphans')}>
          Show projects without goals
        </button>
      </Tile>
      <Tile title="Dependencies">
        <dl className="gl-stats">
          <Stat label="Open" value={s.dependencies.open} />
          <Stat label="Overdue blockers" value={s.dependencies.overdue} />
          <Stat label="Blockers due too late" value={s.dependencies.late} />
        </dl>
        <button type="button" className="link-button" onClick={() => onOpenView('dependencies')}>
          Show dependencies
        </button>
      </Tile>
    </div>
  );
}

// ---- Health table -----------------------------------------------------------------------------

function ProjectDetails({ p, ws, id }: { p: PortfolioProject; ws: string; id: string }) {
  const h = p.health;
  const b = p.budget;
  return (
    <div id={id} className="gl-details">
      <h4>Why {HEALTH_LABEL[h.value].toLowerCase()}</h4>
      {h.reasons.length ? (
        <ul className="gl-plain">
          {h.reasons.map((r) => (
            <li key={r.code}>
              <Chip tone={r.severity === 'off_track' ? 'bad' : 'warn'} glyph={r.severity === 'off_track' ? '✖' : '▲'}>
                {r.severity === 'off_track' ? 'Off track' : 'At risk'}
              </Chip>{' '}
              {r.message}
            </li>
          ))}
        </ul>
      ) : (
        <p>No health rule flagged this project.</p>
      )}
      {h.incomplete.length ? (
        <p className="gl-warn">
          <span aria-hidden="true">△ </span>
          Not fully evaluated: {h.incomplete.map((i) => HEALTH_INCOMPLETE_TEXT[i]).join('; ')}.
        </p>
      ) : null}
      {p.declared_health ? (
        <p>
          Declared by the project: <strong>{declaredHealthLabel(p.declared_health.value)}</strong>
          {h.differs_from_declared ? ' (differs from the computed health above).' : ' (matches).'}
        </p>
      ) : (
        <p className="hint">The project has not declared its own health.</p>
      )}
      <h4>Tasks and effort</h4>
      <p>
        {p.progress.done} of {p.progress.total} tasks you can read are done. {p.tasks.open} open,{' '}
        {p.tasks.overdue} overdue, {p.tasks.blocked} blocked.
      </p>
      <p>
        Open estimate {minutesText(p.effort.open_estimate_minutes)}; {p.effort.unestimated_open_tasks} open
        tasks have no estimate; {minutesText(p.effort.logged_minutes)} logged.
      </p>
      <h4>Budget</h4>
      <ul className="gl-plain">
        <li>
          Money:{' '}
          {b.money && b.money.amount !== null
            ? `${b.money.amount} ${b.money.currency ?? ''} budgeted. Spend is not tracked yet.`
            : 'no money budget.'}
        </li>
        <li>
          Time:{' '}
          {b.time
            ? `${minutesText(b.time.minutes)} budgeted, ${minutesText(b.time.logged_minutes)} logged.`
            : 'no time budget.'}
        </li>
        <li>{b.ai ? 'AI budget set. AI usage is not tracked yet.' : 'No AI budget.'}</li>
      </ul>
      <h4>Goals and dependencies</h4>
      <p>
        {p.goals.linked
          ? `Linked to ${plural(p.goals.direct, 'goal')} directly and ${plural(p.goals.inherited, 'goal')} through tasks or its brand, among those you can see.`
          : 'No goal you can see is linked to this project.'}
      </p>
      <p>
        Blocking {plural(p.dependencies.blocking, 'open dependency', 'open dependencies')}; blocked by{' '}
        {plural(p.dependencies.blocked_by, 'open dependency', 'open dependencies')}.
      </p>
      <p>
        <Link to={routeHref('project', { ws, prj: p.id })}>Open {p.name}</Link>
      </p>
    </div>
  );
}

/** A table on wide screens and stacked cards on narrow ones (CSS), with a details row per project. */
export function HealthTable({ ws, rows }: { ws: string; rows: PortfolioProject[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const base = useId();
  const toggle = (id: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  if (!rows.length)
    return <p className="empty-state">No projects match. Change the filters to see more.</p>;
  return (
    <div className="gl-table-scroll table-scroll" role="region" aria-label="Project health" tabIndex={0}>
      <table className="gl-table">
        <caption className="visually-hidden">
          Project health, worst first. Each row can be expanded to show the rules behind it.
        </caption>
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col">Health</th>
            <th scope="col">Status</th>
            <th scope="col">Progress</th>
            <th scope="col">Next date</th>
            <th scope="col">Owner</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const id = `${base}-${p.id}`;
            const expanded = open.has(p.id);
            return (
              <FragmentRows key={p.id}>
                <tr>
                  <th scope="row" data-label="Project">
                    <Link to={routeHref('project', { ws, prj: p.id })}>{p.name}</Link>
                    <br />
                    <BrandMarker marker={p.brand} size={16} />
                  </th>
                  <td data-label="Health">
                    <HealthChip value={p.health.value} />
                    {p.health.differs_from_declared && p.declared_health ? (
                      <span className="hint gl-declared">
                        {' '}
                        Declared: {declaredHealthLabel(p.declared_health.value)}
                      </span>
                    ) : null}
                    <br />
                    <button
                      type="button"
                      className="link-button"
                      aria-expanded={expanded}
                      aria-controls={id}
                      onClick={() => toggle(p.id)}
                    >
                      {expanded ? 'Hide details' : 'Why and details'}
                      <span className="visually-hidden"> for {p.name}</span>
                    </button>
                  </td>
                  <td data-label="Status">{p.status.label}</td>
                  <td data-label="Progress">
                    <ProgressBar percent={p.progress.percent} label={`Task completion of ${p.name}`} />
                    <span className="hint">
                      {p.progress.done} of {p.progress.total} tasks you can read
                    </span>
                  </td>
                  <td data-label="Next date">{p.dates.next_deadline ?? 'None set'}</td>
                  <td data-label="Owner">{p.owner?.name ?? 'No owner'}</td>
                </tr>
                {expanded ? (
                  <tr className="gl-detail-row">
                    <td colSpan={6}>
                      <ProjectDetails p={p} ws={ws} id={id} />
                    </td>
                  </tr>
                ) : null}
              </FragmentRows>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FragmentRows({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

// ---- Dependencies -----------------------------------------------------------------------------

const STATE_TEXT: Record<DependencyState, string> = {
  resolved: 'Resolved',
  open: 'Open',
  overdue: 'Blocker overdue',
  late: 'Blocker due too late',
};
const STATE_STYLE: Record<DependencyState, { tone: 'good' | 'warn' | 'bad' | 'neutral'; glyph: string }> = {
  resolved: { tone: 'good', glyph: '✓' },
  open: { tone: 'neutral', glyph: '○' },
  overdue: { tone: 'bad', glyph: '✖' },
  late: { tone: 'warn', glyph: '▲' },
};

function PairCard({ ws, pair }: { ws: string; pair: DependencyPair }) {
  const total = Object.values(pair.counts).reduce((n, c) => n + c, 0);
  return (
    <li className="card gl-pair">
      <h3 className="gl-row-title">
        <Link to={routeHref('project', { ws, prj: pair.blocker_project.id })}>{pair.blocker_project.name}</Link>
        <span aria-hidden="true"> → </span>
        <span className="visually-hidden"> blocks </span>
        <Link to={routeHref('project', { ws, prj: pair.blocked_project.id })}>{pair.blocked_project.name}</Link>
      </h3>
      <p className="gl-chips">
        {(Object.keys(STATE_TEXT) as DependencyState[])
          .filter((s) => pair.counts[s] > 0)
          .map((s) => (
            <Chip key={s} tone={STATE_STYLE[s].tone} glyph={STATE_STYLE[s].glyph}>
              {STATE_TEXT[s]}: {pair.counts[s]}
            </Chip>
          ))}
      </p>
      <details className="gl-explain">
        <summary>
          Show the task dependencies
          <span className="visually-hidden">
            {' '}
            between {pair.blocker_project.name} and {pair.blocked_project.name}
          </span>
        </summary>
        <ul className="gl-plain">
          {pair.edges.map((e) => (
            <li key={`${e.blocker.id}>${e.blocked.id}`}>
              <Link to={routeHref('task', { ws, tsk: e.blocker.id })}>{e.blocker.title}</Link>
              <span className="hint"> ({e.blocker.status_category}{e.blocker.due ? `, due ${e.blocker.due}` : ''})</span>
              <span aria-hidden="true"> → </span>
              <span className="visually-hidden"> blocks </span>
              <Link to={routeHref('task', { ws, tsk: e.blocked.id })}>{e.blocked.title}</Link>
              <span className="hint"> ({e.blocked.status_category}{e.blocked.due ? `, due ${e.blocked.due}` : ''})</span>{' '}
              <Chip tone={STATE_STYLE[e.state].tone} glyph={STATE_STYLE[e.state].glyph}>
                {STATE_TEXT[e.state]}
              </Chip>
            </li>
          ))}
        </ul>
        {total > pair.edges.length ? (
          <p className="hint">Showing the first {pair.edges.length} of {total}.</p>
        ) : null}
      </details>
    </li>
  );
}

export function DependenciesView({ ws, d }: { ws: string; d: PortfolioDependencies }) {
  return (
    <>
      <Coverage note={d.coverage.note} asOf={d.as_of}>
        <p>
          {plural(d.coverage.evaluated_projects, 'project')} evaluated. Open {d.summary.open}, blocker
          overdue {d.summary.overdue}, blocker due too late {d.summary.late}, resolved {d.summary.resolved}.
        </p>
        {d.coverage.truncated ? (
          <p className="gl-warn">
            <span aria-hidden="true">△ </span>
            Incomplete: more projects match than could be evaluated. Narrow the filters.
          </p>
        ) : null}
      </Coverage>
      {d.data.length ? (
        <ul className="gl-list">
          {d.data.map((pair) => (
            <PairCard key={`${pair.blocker_project.id}>${pair.blocked_project.id}`} ws={ws} pair={pair} />
          ))}
        </ul>
      ) : (
        <p className="empty-state">No dependencies between projects you can read.</p>
      )}
    </>
  );
}

// ---- Orphans ----------------------------------------------------------------------------------

const ORPHAN_GOAL_TEXT = {
  no_visible_work: 'No linked work you can see',
  no_active_work: 'No active work you can see',
} as const;

export function OrphansView({ ws, o }: { ws: string; o: PortfolioOrphans }) {
  return (
    <>
      <Coverage note={o.coverage.note} asOf={o.as_of}>
        <p className="gl-warn">
          <span aria-hidden="true">△ </span>
          These findings are relative to you ({o.coverage.relative_to}): a project or goal that looks
          unlinked here may be linked to something you cannot read.
        </p>
      </Coverage>
      <section className="card" aria-labelledby="orph-projects">
        <h2 id="orph-projects">Projects without a goal you can see</h2>
        {o.projects.truncated ? (
          <p className="gl-warn">
            <span aria-hidden="true">△ </span>
            Incomplete: more projects match than could be evaluated. Narrow the filters.
          </p>
        ) : null}
        {o.projects.data.length ? (
          <ul className="gl-list">
            {o.projects.data.map((p) => (
              <li key={p.id} className="gl-row">
                <Link to={routeHref('project', { ws, prj: p.id })}>{p.name}</Link>{' '}
                <BrandMarker marker={p.brand} size={16} />
                <span className="hint">
                  {' '}
                  · {p.status.label} · Owner: {p.owner?.name ?? 'No owner'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">Every planned, active, or paused project you can read has a goal you can see.</p>
        )}
      </section>
      <section className="card" aria-labelledby="orph-goals">
        <h2 id="orph-goals">Active goals without active work you can see</h2>
        {o.goals.truncated ? (
          <p className="gl-warn">
            <span aria-hidden="true">△ </span>
            Incomplete: more goals match than could be evaluated.
          </p>
        ) : null}
        {o.goals.data.length ? (
          <ul className="gl-list">
            {o.goals.data.map((g) => (
              <li key={g.id} className="gl-row">
                <Link to={routeHref('goal', { ws, goal: g.id })}>{g.title}</Link>{' '}
                {g.brand ? <BrandMarker marker={g.brand} size={16} /> : <span>Workspace goal</span>}
                <span className="hint">
                  {' '}
                  · Owner: {g.owner?.name ?? 'No owner'} · Ends {g.period_end}
                </span>
                <br />
                <Chip tone="warn" glyph="△">
                  {ORPHAN_GOAL_TEXT[g.reason]}
                </Chip>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">Every active goal you can read has active work you can see.</p>
        )}
      </section>
    </>
  );
}
