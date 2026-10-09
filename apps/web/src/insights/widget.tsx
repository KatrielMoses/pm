import { useEffect, useId, useState } from 'react';
import { ApiError } from '../api.ts';
import { Chip } from '../goals/shared.tsx';
import { Link } from '../router.tsx';
import { routeHref } from '../shell/registry.ts';
import { Dialog } from '../ui/dialog.tsx';
import {
  type Filters,
  type MetricValue,
  type Row,
  type RecordLink,
  type WidgetMeta,
  type WidgetOutcome,
  type WidgetRecords,
} from './client.ts';
import { FILTER_NAME, formatValue, freshnessText, INCOMPLETE_TEXT } from './format.ts';

/**
 * One widget (RPT-017, ST-47): it loads and fails on its own, shows its figure with the scope it
 * covers, where it came from, how fresh it is, and what is estimated or incomplete, offers the same
 * data as a table ("View data"), and drills into the records behind it. Colour is never the only
 * signal; every label is text.
 */

export interface WidgetApi {
  widget(
    filters: Filters | null,
    signal?: AbortSignal,
  ): Promise<{ widget: WidgetMeta; outcome: WidgetOutcome }>;
  records(o: { filters: Filters | null; cursor?: string; limit?: number }): Promise<WidgetRecords>;
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; outcome: WidgetOutcome }
  | { status: 'failed'; error: unknown };
type Keyed = { key: string; state: Exclude<State, { status: 'loading' }> };

function linkOf(ws: string, l: RecordLink): string | null {
  switch (l.type) {
    case 'task':
      return routeHref('task', { ws, tsk: l.id });
    case 'project':
      return routeHref('project', { ws, prj: l.id });
    case 'goal':
      return routeHref('goal', { ws, goal: l.id });
    default:
      return null;
  }
}

export function RecordTable({
  ws,
  caption,
  columns,
  rows,
}: {
  ws: string;
  caption: string;
  columns: Array<{ key: string; label: string }>;
  rows: Row[];
}) {
  if (!rows.length) return <p className="hint">No records for this period.</p>;
  return (
    <div className="ins-table-wrap" tabIndex={0} role="region" aria-label={caption}>
      <table className="ins-table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const href = r.link ? linkOf(ws, r.link) : null;
            return (
              <tr key={`${r.link?.id ?? 'row'}-${i}`}>
                {columns.map((c, ci) => {
                  const v = r.cells[c.key];
                  const text = v === null || v === undefined ? '—' : String(v);
                  return (
                    <td key={c.key} data-label={c.label}>
                      {ci === 0 && href ? <Link to={href}>{text}</Link> : text}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RecordsDialog({
  ws,
  meta,
  api,
  filters,
  onClose,
}: {
  ws: string;
  meta: WidgetMeta;
  api: WidgetApi;
  filters: Filters | null;
  onClose: () => void;
}) {
  const [pages, setPages] = useState<WidgetRecords[]>([]);
  const [busy, setBusy] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  // The page being asked for: a cursor (none for the first) and a counter so a retry asks again.
  const [ask, setAsk] = useState<{ cursor: string | undefined; n: number }>({
    cursor: undefined,
    n: 0,
  });
  useEffect(() => {
    let active = true;
    api
      .records({ filters, ...(ask.cursor ? { cursor: ask.cursor } : {}) })
      .then(
        (r) => {
          if (!active) return;
          setPages((p) => [...p, r]);
          setProblem(null);
        },
        (err: unknown) => {
          if (!active) return;
          setProblem(
            err instanceof ApiError && err.code === 'offline'
              ? "You're offline. Try again when you're back online."
              : "Couldn't load the records.",
          );
        },
      )
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask]);
  const first = pages[0];
  const last = pages[pages.length - 1];
  const nextCursor = last?.page.has_more ? last.page.next_cursor : undefined;
  const rows = pages.flatMap((p) => p.rows);
  const request = (cursor: string | undefined) => {
    setBusy(true);
    setAsk((a) => ({ cursor, n: a.n + 1 }));
  };
  return (
    <Dialog title={`Records behind “${meta.title}”`} onClose={onClose}>
      {first ? <p className="hint">{first.covers}. Only records you can read are listed.</p> : null}
      {first ? (
        <RecordTable
          ws={ws}
          caption={`Records behind ${meta.title}`}
          columns={first.columns}
          rows={rows}
        />
      ) : null}
      {problem ? (
        <p role="alert" className="gl-problem">
          {problem}{' '}
          <button
            type="button"
            className="button button-secondary"
            onClick={() => request(ask.cursor)}
          >
            Retry
          </button>
        </p>
      ) : null}
      {nextCursor ? (
        <p>
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() => request(nextCursor)}
          >
            {busy ? 'Loading…' : 'Load more'}
          </button>
        </p>
      ) : busy && !first ? (
        <p role="status">Loading…</p>
      ) : null}
      <p className="actions">
        <button type="button" className="button button-primary" data-initial onClick={onClose}>
          Close
        </button>
      </p>
    </Dialog>
  );
}

export function WidgetCard({
  ws,
  meta,
  api,
  filters,
  reloadKey,
  onExport,
}: {
  ws: string;
  meta: WidgetMeta;
  api: WidgetApi;
  filters: Filters | null;
  /** Changing it (a Refresh, a saved edit) loads the widget again. */
  reloadKey: number;
  onExport?: ((widget: string, format: 'csv' | 'pdf') => void) | undefined;
}) {
  const [entry, setEntry] = useState<Keyed | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [drill, setDrill] = useState(false);
  const titleId = useId();
  const filterKey = JSON.stringify(filters);
  const key = `${meta.id}|${meta.metric}|${filterKey}|${reloadKey}|${attempt}`;
  useEffect(() => {
    const ctl = new AbortController();
    api.widget(filters, ctl.signal).then(
      (r) => {
        if (!ctl.signal.aborted) setEntry({ key, state: { status: 'ready', outcome: r.outcome } });
      },
      (error: unknown) => {
        if (!ctl.signal.aborted) setEntry({ key, state: { status: 'failed', error } });
      },
    );
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const state: State = entry && entry.key === key ? entry.state : { status: 'loading' };

  // A widget the person cannot see at all is absent, not an empty box (ST widget table).
  if (
    state.status === 'ready' &&
    state.outcome.state === 'unavailable' &&
    state.outcome.reason !== 'not_available'
  )
    return null;
  if (
    state.status === 'failed' &&
    state.error instanceof ApiError &&
    state.error.code === 'not_found'
  )
    return null;

  return (
    <section
      className={`ins-widget ins-${meta.size}`}
      aria-labelledby={titleId}
      aria-busy={state.status === 'loading'}
    >
      <h3 id={titleId} className="ins-widget-title">
        {meta.title}
      </h3>
      {state.status === 'loading' ? (
        <div className="ins-skeleton" role="status">
          <span className="visually-hidden">Loading {meta.title}…</span>
        </div>
      ) : state.status === 'failed' || state.outcome.state === 'error' ? (
        <div className="gl-problem" role="alert">
          <p>
            Couldn&apos;t load {meta.title}.{' '}
            {state.status === 'failed' &&
            state.error instanceof ApiError &&
            state.error.code === 'offline'
              ? "You're offline."
              : ''}
          </p>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Retry
          </button>
        </div>
      ) : state.outcome.state === 'unavailable' ? (
        <p className="hint">{state.outcome.message}</p>
      ) : (
        <WidgetBody
          ws={ws}
          meta={meta}
          v={state.outcome}
          onDrill={() => setDrill(true)}
          {...(onExport ? { onExport: (f: 'csv' | 'pdf') => onExport(meta.id, f) } : {})}
        />
      )}
      {drill ? (
        <RecordsDialog
          ws={ws}
          meta={meta}
          api={api}
          filters={filters}
          onClose={() => setDrill(false)}
        />
      ) : null}
    </section>
  );
}

function WidgetBody({
  ws,
  meta,
  v,
  onDrill,
  onExport,
}: {
  ws: string;
  meta: WidgetMeta;
  v: MetricValue;
  onDrill: () => void;
  onExport?: (format: 'csv' | 'pdf') => void;
}) {
  const f = formatValue(v.unit, v.value);
  const max = Math.max(1, ...v.breakdown.map((b) => b.value));
  const notApplying = (Object.keys(v.applied) as Array<keyof typeof v.applied>).filter(
    (k) => !v.applied[k],
  );
  return (
    <>
      <p className="ins-value" title={f.exact} aria-label={`${meta.title}: ${f.exact}`}>
        <span className="display">{f.short}</span>
        {v.value === null ? <span className="hint"> No data for this period</span> : null}
      </p>
      {v.breakdown.length ? (
        <ul className="ins-breakdown" aria-label={`${meta.title} by group`}>
          {v.breakdown.map((b) => (
            <li key={b.key ?? b.label}>
              <span className="ins-b-label">{b.label}</span>
              <span className="ins-b-bar" aria-hidden="true">
                <span
                  className={`ins-b-fill${v.estimated ? ' ins-estimated' : ''}`}
                  style={{ width: `${Math.max(2, Math.round((b.value / max) * 100))}%` }}
                />
              </span>
              <span className="ins-b-value">{formatValue(v.unit, b.value).short}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="gl-chips">
        {v.estimated ? (
          <Chip tone="info" glyph="≈" title="Built from estimates, not measurements">
            Estimated
          </Chip>
        ) : null}
        {v.incomplete.length ? (
          <Chip tone="warn" glyph="▲">
            Incomplete
          </Chip>
        ) : null}
        {v.freshness.stale ? (
          <Chip tone="warn" glyph="⏱">
            Out of date
          </Chip>
        ) : null}
      </p>
      {v.incomplete.length || v.notes.length ? (
        <ul className="ins-notes">
          {v.incomplete.map((c) => (
            <li key={c}>{INCOMPLETE_TEXT[c]}</li>
          ))}
          {v.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      <p className="gl-meta">
        {v.covers}
        {v.range ? ` · ${v.range.label}` : ''}
        <br />
        {freshnessText(v.freshness)} · Source: {v.source.label}
      </p>
      {notApplying.length ? (
        <p className="hint ins-na">
          Not applied here: {notApplying.map((k) => FILTER_NAME[k]).join(', ')}.
        </p>
      ) : null}
      <details className="ins-data">
        <summary>View data</summary>
        <RecordTable ws={ws} caption={`${meta.title}: data`} columns={v.columns} rows={v.rows} />
      </details>
      <div className="actions-compact" role="group" aria-label={`Actions for ${meta.title}`}>
        {v.drill ? (
          <button type="button" className="button button-secondary" onClick={onDrill}>
            Show records
          </button>
        ) : null}
        {onExport ? (
          <>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => onExport('csv')}
            >
              Export CSV
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => onExport('pdf')}
            >
              Export PDF
            </button>
          </>
        ) : null}
      </div>
    </>
  );
}
