import { useMemo, useState } from 'react';
import { Link } from '../router.tsx';
import { routeHref } from '../shell/registry.ts';
import { useStepUp } from '../stepup.tsx';
import { useResource } from '../tenancy/resource.tsx';
import { CreateDashboardDialog, CreateReportDialog } from './dialogs.tsx';
import {
  dashboards,
  insights,
  NO_FILTERS,
  reports,
  type AdhocQuery,
  type Filters,
  type WidgetMeta,
} from './client.ts';
import { WidgetCard, type WidgetApi } from './widget.tsx';
import { useRouter } from '../router.tsx';

/** Widgets that are not part of a saved dashboard: the Home overview and a project's Reports section. */

const adhocApi =
  (ws: string, scope: { brand?: string; project?: string }) =>
  (m: WidgetMeta): WidgetApi => {
    const q: AdhocQuery = { metric: m.metric, params: m.params, ...scope };
    return {
      widget: (filters, signal) => insights.widget(ws, q, filters, signal),
      records: (o) => insights.records(ws, q, o),
    };
  };

const w = (
  id: string,
  metric: string,
  title: string,
  params: Record<string, unknown> = {},
): WidgetMeta => ({
  id,
  metric,
  title,
  size: 'medium',
  params,
  available: true,
});

/**
 * The situation overview on Home (WSB-016, NAV-002, NAV-003): every figure covers what the person
 * can read, narrowed to the brands in the shell's scope. Each widget loads on its own, and those
 * below the fold load only when they come near the screen.
 */
export function HomeOverview({
  ws,
  brandIds,
  single,
}: {
  ws: string;
  /** Public brand identifiers in the shell scope; empty means every brand the person can read. */
  brandIds: string[];
  single: boolean;
}) {
  const filters: Filters = useMemo(() => ({ ...NO_FILTERS, brands: brandIds }), [brandIds]);
  const api = useMemo(() => adhocApi(ws, {}), [ws]);
  const widgets = useMemo<WidgetMeta[]>(
    () => [
      w('open', 'tasks.open', 'Open tasks', { group_by: single ? 'project' : 'brand' }),
      w('overdue', 'tasks.overdue', 'Overdue tasks'),
      w('due', 'tasks.due_soon', 'Due in the next 7 days'),
      w('goals', 'goals.progress', 'Goal progress'),
      w('projects', 'projects.active', 'Active projects and health', { group_by: 'health' }),
    ],
    [single],
  );
  return (
    <section aria-labelledby="home-overview-h" className="ins-home">
      <div className="section-head">
        <h2 id="home-overview-h">{single ? 'This brand at a glance' : 'Across your brands'}</h2>
        <Link to={routeHref('reports', { ws })} className="button button-secondary">
          Dashboards and reports
        </Link>
      </div>
      <div className="ins-grid">
        {widgets.map((m, i) => (
          <WidgetCard
            key={m.id}
            ws={ws}
            meta={m}
            api={api(m)}
            filters={filters}
            reloadKey={0}
            lazy={i >= 2}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * A project's Reports section (PRJ-019): the project's own figures and the dashboards and saved
 * reports that belong to it.
 */
export function ProjectReports({
  ws,
  project,
  canCreate,
}: {
  ws: string;
  project: string;
  canCreate: boolean;
}) {
  const stepUp = useStepUp();
  const router = useRouter();
  const [nonce, setNonce] = useState(0);
  const [creating, setCreating] = useState<null | 'dashboard' | 'report'>(null);
  const api = useMemo(() => adhocApi(ws, { project }), [ws, project]);
  const dash = useResource(() => dashboards.list(ws, { project }), `pd:${ws}:${project}:${nonce}`);
  const reps = useResource(() => reports.list(ws, { project }), `pr:${ws}:${project}:${nonce}`);
  const widgets: WidgetMeta[] = useMemo(
    () => [
      w('open', 'tasks.open', 'Open tasks'),
      w('overdue', 'tasks.overdue', 'Overdue tasks'),
      w('unassigned', 'tasks.unassigned', 'Unassigned tasks'),
      w('milestones', 'milestones.upcoming', 'Upcoming milestones'),
      w('time', 'time.planned_vs_actual', 'Planned versus actual time'),
      w('deliverables', 'deliverables.status', 'Deliverables by state'),
    ],
    [],
  );
  return (
    <>
      <section aria-labelledby="proj-rep-h" className="card">
        <h2 id="proj-rep-h">This project at a glance</h2>
        <p className="hint">Each figure covers what you can read in this project.</p>
        <div className="ins-grid">
          {widgets.map((m, i) => (
            <WidgetCard
              key={m.id}
              ws={ws}
              meta={m}
              api={api(m)}
              filters={null}
              reloadKey={0}
              lazy={i >= 2}
            />
          ))}
        </div>
      </section>
      <section aria-labelledby="proj-saved-h" className="card">
        <h2 id="proj-saved-h">Dashboards and reports for this project</h2>
        {canCreate ? (
          <p className="actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setCreating('dashboard')}
            >
              New project dashboard
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setCreating('report')}
            >
              New project report
            </button>
          </p>
        ) : null}
        <ul className="gl-list" aria-label="Dashboards and reports for this project">
          {dash.state.status === 'ready'
            ? dash.state.data.data.map((d) => (
                <li key={d.id} className="gl-row">
                  <Link to={routeHref('dashboard', { ws, dash: d.id })}>{d.title}</Link>{' '}
                  <span className="hint">Dashboard</span>
                </li>
              ))
            : null}
          {reps.state.status === 'ready'
            ? reps.state.data.data.map((d) => (
                <li key={d.id} className="gl-row">
                  <Link to={routeHref('report', { ws, rpt: d.id })}>{d.title}</Link>{' '}
                  <span className="hint">Report</span>
                </li>
              ))
            : null}
        </ul>
        {dash.state.status === 'ready' &&
        reps.state.status === 'ready' &&
        !dash.state.data.data.length &&
        !reps.state.data.data.length ? (
          <p className="hint">Nothing saved for this project yet.</p>
        ) : null}
      </section>
      {creating === 'dashboard' ? (
        <CreateDashboardDialog
          ws={ws}
          preset={{ kind: 'project', project }}
          onClose={() => setCreating(null)}
          onCreate={async (body, key) => {
            const d = await dashboards.create(ws, body, stepUp, { key });
            setNonce((n) => n + 1);
            router.navigate(routeHref('dashboard', { ws, dash: d.id }));
          }}
        />
      ) : null}
      {creating === 'report' ? (
        <CreateReportDialog
          ws={ws}
          preset={{ project }}
          onClose={() => setCreating(null)}
          onCreate={async (body, key) => {
            const r = await reports.create(ws, body, stepUp, { key });
            setNonce((n) => n + 1);
            router.navigate(routeHref('report', { ws, rpt: r.id }));
          }}
        />
      ) : null}
    </>
  );
}
