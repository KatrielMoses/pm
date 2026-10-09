import { useMemo, useState } from 'react';
import { ApiError } from '../api.ts';
import { ProblemLine, useExplain, type Explained } from '../goals/shared.tsx';
import { Banner } from '../ui/feedback.tsx';
import { FilterBar } from './filters.tsx';
import { NO_FILTERS, saveBlob, type Filters, type WidgetMeta } from './client.ts';
import { WidgetCard, type WidgetApi } from './widget.tsx';

/**
 * The widget grid with its filters and exports, shared by dashboards and reports. A narrow screen
 * stacks the widgets in the saved order; each widget loads and fails on its own.
 */
export function InsightView({
  ws,
  widgets,
  saved,
  fixed,
  apiFor,
  exporter,
  canExport,
  emptyHint,
}: {
  ws: string;
  widgets: WidgetMeta[];
  saved: Filters;
  fixed?: { brand?: boolean; project?: boolean };
  apiFor: (w: WidgetMeta) => WidgetApi;
  exporter: (o: { format: 'csv' | 'pdf'; widget?: string; filters: Filters | null }) => Promise<{
    blob: Blob;
    filename: string;
  }>;
  canExport: boolean;
  emptyHint: string;
}) {
  const explainError = useExplain();
  const [filters, setFilters] = useState<Filters>(saved);
  const [nonce, setNonce] = useState(0);
  const [problem, setProblem] = useState<Explained | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const changed = useMemo(
    () => JSON.stringify(filters) !== JSON.stringify(saved),
    [filters, saved],
  );
  const sent = changed ? filters : null;
  const doExport = async (format: 'csv' | 'pdf', widget?: string) => {
    setBusy(true);
    setProblem(null);
    try {
      saveBlob(await exporter({ format, ...(widget ? { widget } : {}), filters: sent }));
      setSaid(`Exported ${format.toUpperCase()}.`);
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled'))
        setProblem(explainError(err, 'exporting'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <details className="ins-filter-disclosure" open={changed || undefined}>
        <summary>Filters{changed ? ' (changed)' : ''}</summary>
        <FilterBar ws={ws} value={filters} onChange={setFilters} {...(fixed ? { fixed } : {})} />
        {changed ? (
          <p className="hint">
            These filters are for this view only.{' '}
            <button type="button" className="button button-ghost" onClick={() => setFilters(saved)}>
              Back to the saved filters
            </button>
          </p>
        ) : null}
      </details>
      <div className="actions-compact" role="group" aria-label="Page actions">
        <button
          type="button"
          className="button button-secondary"
          onClick={() => setNonce((n) => n + 1)}
        >
          Refresh
        </button>
        {canExport && widgets.length ? (
          <>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => void doExport('csv')}
            >
              Export all as CSV
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => void doExport('pdf')}
            >
              Export all as PDF
            </button>
          </>
        ) : null}
      </div>
      <ProblemLine problem={problem} busy={busy} />
      <p className="announce" role="status">
        {said}
      </p>
      {widgets.length ? (
        <div className="ins-grid">
          {widgets.map((m) => (
            <WidgetCard
              key={m.id}
              ws={ws}
              meta={m}
              api={apiFor(m)}
              filters={sent}
              reloadKey={nonce}
              {...(canExport
                ? { onExport: (id: string, f: 'csv' | 'pdf') => void doExport(f, id) }
                : {})}
            />
          ))}
        </div>
      ) : (
        <Banner tone="info" title="No widgets yet">
          {emptyHint}
        </Banner>
      )}
    </>
  );
}

export { NO_FILTERS };
