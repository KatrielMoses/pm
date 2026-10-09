import { useState } from 'react';
import { ApiError } from '../api.ts';
import { ConfirmDialog } from '../goals/dialogs.tsx';
import { AvailableView, Chip, ProblemLine, useExplain, type Explained } from '../goals/shared.tsx';
import { InsightView } from '../insights/view.tsx';
import {
  CreateDashboardDialog,
  CreateReportDialog,
  RecipientsDialog,
  RunsDialog,
  ScheduleDialog,
  ShareDialog,
} from '../insights/dialogs.tsx';
import { LayoutEditor } from '../insights/editor.tsx';
import {
  dashboards,
  insights,
  KIND_LABEL,
  reports,
  type Dashboard,
  type Report,
  type WidgetMeta,
} from '../insights/client.ts';
import type { WidgetApi } from '../insights/widget.tsx';
import { Link, useRouter } from '../router.tsx';
import { routeHref } from '../shell/registry.ts';
import { useStepUp } from '../stepup.tsx';
import { useResource } from '../tenancy/resource.tsx';
import { Page } from '../ui/layout.tsx';

/**
 * Reports (5D, IA "Reports"): dashboards, saved reports, and the trash. Every figure on every page
 * is computed for the person looking at it; opening a link someone else was sent shows what this
 * person may read, never what the sender saw.
 */

function apiOf(
  kind: 'dashboards' | 'reports',
  ws: string,
  id: string,
): (w: WidgetMeta) => WidgetApi {
  const a = kind === 'dashboards' ? dashboards : reports;
  return (w) => ({
    widget: (filters, signal) => a.widget(ws, id, w.id, filters, signal),
    records: (o) => a.records(ws, id, w.id, o),
  });
}

const brandName = (
  b: Dashboard['scope'] extends infer S ? (S extends { brand: infer B } ? B : never) : never,
) => ('name' in b ? b.name : 'Brand');

const scopeText = (s: Dashboard['scope']): string =>
  s.kind === 'workspace'
    ? 'Every brand you can read'
    : s.kind === 'personal'
      ? 'Only you'
      : s.kind === 'shared'
        ? 'Shared with you'
        : s.kind === 'brand'
          ? brandName(s.brand)
          : `${s.project?.name ?? 'Project'} · ${brandName(s.brand)}`;

export function ReportsPage({ ws }: { ws: string }) {
  const stepUp = useStepUp();
  const router = useRouter();
  const [nonce, setNonce] = useState(0);
  const dash = useResource(() => dashboards.list(ws), `dash:${ws}:${nonce}`);
  const reps = useResource(() => reports.list(ws), `rep:${ws}:${nonce}`);
  const [creating, setCreating] = useState<'dashboard' | 'report' | null>(null);
  return (
    <Page
      title="Reports"
      lead="Dashboards and saved reports. Every figure covers only what you can read, and says where it came from and how fresh it is."
    >
      <section className="card" aria-labelledby="ins-dash-h">
        <h2 id="ins-dash-h">Dashboards</h2>
        <p className="actions">
          <button
            type="button"
            className="button button-primary"
            onClick={() => setCreating('dashboard')}
          >
            New dashboard
          </button>
        </p>
        <AvailableView resource={dash.state} onRetry={dash.retry} what="dashboards">
          {(r) =>
            r.data.length ? (
              <ul className="gl-list" aria-label="Dashboards">
                {r.data.map((d) => (
                  <li key={d.id} className="gl-row">
                    <h3 className="gl-row-title">
                      <Link to={routeHref('dashboard', { ws, dash: d.id })}>{d.title}</Link>
                    </h3>
                    <p className="gl-meta">
                      <Chip tone="neutral" glyph="▥">
                        {KIND_LABEL[d.kind]}
                      </Chip>{' '}
                      {scopeText(d.scope)} · {d.widgets.length} widget
                      {d.widgets.length === 1 ? '' : 's'}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">No dashboards yet. Create one to see your work at a glance.</p>
            )
          }
        </AvailableView>
      </section>
      <section className="card" aria-labelledby="ins-rep-h">
        <h2 id="ins-rep-h">Saved reports</h2>
        <p className="actions">
          <button
            type="button"
            className="button button-primary"
            onClick={() => setCreating('report')}
          >
            New report
          </button>
        </p>
        <AvailableView resource={reps.state} onRetry={reps.retry} what="reports">
          {(r) =>
            r.data.length ? (
              <ul className="gl-list" aria-label="Saved reports">
                {r.data.map((d) => (
                  <li key={d.id} className="gl-row">
                    <h3 className="gl-row-title">
                      <Link to={routeHref('report', { ws, rpt: d.id })}>{d.title}</Link>
                    </h3>
                    <p className="gl-meta">
                      {scopeText(d.scope)}
                      {d.schedule ? ` · ${d.schedule.description}` : ''}
                      {d.schedule?.suspended ? ' · Paused' : ''}
                      {d.access === 'share' ? ' · Shared with you' : ''}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">No saved reports yet.</p>
            )
          }
        </AvailableView>
      </section>
      <TrashSection ws={ws} onRestored={() => setNonce((n) => n + 1)} />
      {creating === 'dashboard' ? (
        <CreateDashboardDialog
          ws={ws}
          onClose={() => setCreating(null)}
          onCreate={async (body, key) => {
            const d = await dashboards.create(ws, body, stepUp, { key });
            router.navigate(routeHref('dashboard', { ws, dash: d.id }));
            setNonce((n) => n + 1);
          }}
        />
      ) : null}
      {creating === 'report' ? (
        <CreateReportDialog
          ws={ws}
          onClose={() => setCreating(null)}
          onCreate={async (body, key) => {
            const r = await reports.create(ws, body, stepUp, { key });
            router.navigate(routeHref('report', { ws, rpt: r.id }));
            setNonce((n) => n + 1);
          }}
        />
      ) : null}
    </Page>
  );
}

function TrashSection({ ws, onRestored }: { ws: string; onRestored: () => void }) {
  const stepUp = useStepUp();
  const explainError = useExplain();
  const [items, setItems] = useState<Array<Dashboard | Report> | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const [said, setSaid] = useState('');
  const [purging, setPurging] = useState<(Dashboard | Report) | null>(null);
  const apiFor = (i: Dashboard | Report) => (i.type === 'dashboard' ? dashboards : reports);
  const act = async (fn: () => Promise<void>, what: string) => {
    setBusy(true);
    setProblem(null);
    setSaid('');
    try {
      await fn();
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled'))
        setProblem(explainError(err, what));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="ins-trash-h">
      <h2 id="ins-trash-h">Trash</h2>
      <p className="hint">Dashboards and reports you moved to trash that you can still restore.</p>
      {items === null ? (
        <button
          type="button"
          className="button button-secondary"
          disabled={busy}
          onClick={() =>
            void act(async () => setItems(await insights.trash(ws)), 'loading the trash')
          }
        >
          {busy ? 'Loading…' : 'Show trash'}
        </button>
      ) : !items.length ? (
        <p className="hint">The trash is empty.</p>
      ) : (
        <ul className="gl-list" aria-label="Trashed dashboards and reports">
          {items.map((i) => (
            <li key={i.id} className="gl-row">
              <h3 className="gl-row-title">{i.title}</h3>
              <div className="actions-compact" role="group" aria-label={`Actions for ${i.title}`}>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  aria-label={`Restore ${i.title}`}
                  onClick={() =>
                    void act(async () => {
                      await apiFor(i).verb(ws, i.id, 'restore', i.version, stepUp);
                      setItems((c) => c?.filter((x) => x.id !== i.id) ?? null);
                      setSaid(`Restored ${i.title}.`);
                      onRestored();
                    }, 'restoring')
                  }
                >
                  Restore
                </button>
                <button
                  type="button"
                  className="button button-danger"
                  disabled={busy}
                  aria-label={`Delete ${i.title} permanently`}
                  onClick={() => setPurging(i)}
                >
                  Delete permanently
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ProblemLine problem={purging ? null : problem} />
      <p className="announce" role="status">
        {said}
      </p>
      {purging ? (
        <ConfirmDialog
          title="Delete permanently?"
          confirm="Delete permanently"
          busy={busy}
          problem={problem}
          onClose={() => setPurging(null)}
          onConfirm={() =>
            void act(async () => {
              await apiFor(purging).verb(ws, purging.id, 'purge', purging.version, stepUp);
              setItems((c) => c?.filter((x) => x.id !== purging.id) ?? null);
              setPurging(null);
              setSaid(`Permanently deleted ${purging.title}.`);
            }, 'deleting')
          }
        >
          <p>“{purging.title}” will be removed for good. This cannot be undone.</p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

// ---- A dashboard ------------------------------------------------------------------------------

export function DashboardPage({ ws, dash }: { ws: string; dash: string }) {
  const r = useResource(() => dashboards.get(ws, dash), `d:${ws}:${dash}`);
  return (
    <AvailableView resource={r.state} onRetry={r.retry} what="dashboard">
      {(d) => <DashboardBody ws={ws} d={d} reload={r.reload} />}
    </AvailableView>
  );
}

function DashboardBody({ ws, d, reload }: { ws: string; d: Dashboard; reload: () => void }) {
  const stepUp = useStepUp();
  const router = useRouter();
  const explainError = useExplain();
  const [editing, setEditing] = useState(false);
  const [trashing, setTrashing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const fixed = {
    brand: d.scope.kind === 'brand' || d.scope.kind === 'project',
    project: d.scope.kind === 'project',
  };
  const trash = async () => {
    setBusy(true);
    try {
      await dashboards.verb(ws, d.id, 'trash', d.version, stepUp);
      router.navigate(routeHref('reports', { ws }));
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled'))
        setProblem(explainError(err, 'moving it to trash'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page
      title={d.title}
      record={{ title: d.title }}
      lead={`${KIND_LABEL[d.kind]} dashboard · ${scopeText(d.scope)}${d.description ? ` · ${d.description}` : ''}`}
    >
      <div className="actions-compact" role="group" aria-label="Dashboard actions">
        {d.capabilities.update ? (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setEditing(true)}
          >
            Edit widgets
          </button>
        ) : null}
        {d.capabilities.trash ? (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setTrashing(true)}
          >
            Move to trash
          </button>
        ) : null}
        <Link to={routeHref('reports', { ws })} className="button button-ghost">
          All dashboards and reports
        </Link>
      </div>
      <InsightView
        ws={ws}
        widgets={d.widgets}
        saved={d.filters}
        fixed={fixed}
        apiFor={apiOf('dashboards', ws, d.id)}
        exporter={(o) => dashboards.export(ws, d.id, o)}
        canExport={d.capabilities.export}
        emptyHint={
          d.capabilities.update
            ? 'Use Edit widgets to add the first one.'
            : 'Nothing has been added to this dashboard.'
        }
      />
      {editing ? (
        <LayoutEditor
          ws={ws}
          widgets={d.widgets}
          max={24}
          onClose={() => setEditing(false)}
          onSave={async (next) => {
            await dashboards.update(ws, d.id, d.version, { layout: { widgets: next } }, stepUp);
            reload();
          }}
        />
      ) : null}
      {trashing ? (
        <ConfirmDialog
          title="Move this dashboard to trash?"
          confirm="Move to trash"
          busy={busy}
          problem={problem}
          onClose={() => setTrashing(false)}
          onConfirm={() => void trash()}
        >
          <p>You can restore it from the trash on the Reports page.</p>
        </ConfirmDialog>
      ) : null}
    </Page>
  );
}

// ---- A report ---------------------------------------------------------------------------------

export function ReportPage({ ws, report }: { ws: string; report: string }) {
  const r = useResource(() => reports.get(ws, report), `r:${ws}:${report}`);
  return (
    <AvailableView resource={r.state} onRetry={r.retry} what="report">
      {(d) => <ReportBody ws={ws} d={d} reload={r.reload} />}
    </AvailableView>
  );
}

function ReportBody({ ws, d, reload }: { ws: string; d: Report; reload: () => void }) {
  const stepUp = useStepUp();
  const router = useRouter();
  const explainError = useExplain();
  const [dialog, setDialog] = useState<
    null | 'layout' | 'schedule' | 'recipients' | 'share' | 'runs' | 'trash'
  >(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const [said, setSaid] = useState('');
  const act = async (fn: () => Promise<void>, what: string) => {
    setBusy(true);
    setProblem(null);
    try {
      await fn();
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled'))
        setProblem(explainError(err, what));
    } finally {
      setBusy(false);
    }
  };
  const s = d.schedule;
  return (
    <Page
      title={d.title}
      record={{ title: d.title }}
      lead={`Report · ${scopeText(d.scope)}${d.description ? ` · ${d.description}` : ''}`}
    >
      {s?.suspended ? (
        <div role="alert" className="gl-problem">
          <p>
            <strong>This schedule is paused.</strong>{' '}
            {s.suspended.reason === 'owner_departed'
              ? 'The person accountable for it left the workspace.'
              : s.suspended.reason === 'owner_authority'
                ? 'The person accountable for it can no longer schedule this report.'
                : 'An administrator paused it.'}{' '}
            Nothing is being sent.
          </p>
          {d.capabilities.schedule ? (
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await reports.resume(ws, d.id, stepUp);
                  reload();
                  setSaid('Schedule resumed. You are now accountable for it.');
                }, 'resuming the schedule')
              }
            >
              Resume and take over
            </button>
          ) : null}
        </div>
      ) : null}
      {s ? (
        <p className="gl-meta">
          <Chip tone={s.suspended ? 'warn' : 'info'} glyph="✉">
            {s.suspended ? 'Paused' : 'Scheduled'}
          </Chip>{' '}
          {s.description}
          {s.next_run_at && !s.suspended
            ? ` · Next: ${new Date(s.next_run_at).toLocaleString()}`
            : ''}
          {d.recipients_count !== null
            ? ` · ${d.recipients_count} recipient${d.recipients_count === 1 ? '' : 's'}`
            : ''}
        </p>
      ) : null}
      <div className="actions-compact" role="group" aria-label="Report actions">
        {d.capabilities.update ? (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setDialog('layout')}
          >
            Edit widgets
          </button>
        ) : null}
        {d.capabilities.schedule ? (
          <>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setDialog('schedule')}
            >
              Schedule
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setDialog('recipients')}
            >
              Recipients
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setDialog('runs')}
            >
              Delivery history
            </button>
          </>
        ) : null}
        {d.capabilities.share ? (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setDialog('share')}
          >
            Share{d.shares_count ? ` (${d.shares_count})` : ''}
          </button>
        ) : null}
        {d.subscribed ? (
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await reports.leave(ws, d.id, stepUp);
                reload();
                setSaid('You will no longer receive this report by email.');
              }, 'stopping the emails')
            }
          >
            Stop emailing me this report
          </button>
        ) : null}
        {d.capabilities.trash ? (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setDialog('trash')}
          >
            Move to trash
          </button>
        ) : null}
        <Link to={routeHref('reports', { ws })} className="button button-ghost">
          All dashboards and reports
        </Link>
      </div>
      <ProblemLine problem={dialog ? null : problem} />
      <p className="announce" role="status">
        {said}
      </p>
      <InsightView
        ws={ws}
        widgets={d.widgets}
        saved={d.filters}
        fixed={{
          brand: d.scope.kind === 'brand' || d.scope.kind === 'project',
          project: d.scope.kind === 'project',
        }}
        apiFor={apiOf('reports', ws, d.id)}
        exporter={(o) => reports.export(ws, d.id, o)}
        canExport={d.capabilities.export}
        emptyHint="Use Edit widgets to add the first one."
      />
      {dialog === 'layout' ? (
        <LayoutEditor
          ws={ws}
          widgets={d.widgets}
          max={24}
          onClose={() => setDialog(null)}
          onSave={async (next) => {
            await reports.update(ws, d.id, d.version, { layout: { widgets: next } }, stepUp);
            reload();
          }}
        />
      ) : null}
      {dialog === 'schedule' ? (
        <ScheduleDialog
          ws={ws}
          report={d}
          onSaved={() => reload()}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'recipients' ? (
        <RecipientsDialog
          ws={ws}
          report={d}
          onSaved={() => reload()}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'share' ? (
        <ShareDialog ws={ws} report={d} onChanged={reload} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'runs' ? <RunsDialog ws={ws} report={d} onClose={() => setDialog(null)} /> : null}
      {dialog === 'trash' ? (
        <ConfirmDialog
          title="Move this report to trash?"
          confirm="Move to trash"
          busy={busy}
          problem={problem}
          onClose={() => setDialog(null)}
          onConfirm={() =>
            void act(async () => {
              await reports.verb(ws, d.id, 'trash', d.version, stepUp);
              router.navigate(routeHref('reports', { ws }));
            }, 'moving it to trash')
          }
        >
          <p>It stops sending. You can restore it from the trash on the Reports page.</p>
        </ConfirmDialog>
      ) : null}
    </Page>
  );
}
