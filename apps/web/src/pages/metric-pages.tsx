import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { ApiError } from '../api.ts';
import {
  EMPTY_METRIC_QUERY,
  metricsApi,
  type FreshnessState,
  type MetricCatalog,
  type MetricDefinitionInfo,
  type MetricQuery,
  type MetricRecord,
  type MetricRecords,
  type MetricResult,
  type MetricState,
} from '../metrics/client.ts';
import { Link, useRouter } from '../router.tsx';
import { BrandMarker } from '../shell/brand-marker.tsx';
import { useWorkspaceShell } from '../shell/workspace.tsx';
import { Announce, Banner, ProblemBanner } from '../ui/feedback.tsx';
import { Page } from '../ui/layout.tsx';

/**
 * Metrics (5C, ADR-0030; 0E UXD-30). One figure at a time, with the rule that produced it: what is
 * counted, in whose time zone, how fresh, what is missing, and the records behind it. The whole
 * state is in the URL, so a link is a figure. Everything shown was computed for this person by the
 * server at the time of the request; the page never counts, filters, or rounds on its own, and it
 * never states a state it was not given (an unavailable source is shown as unavailable, not as zero).
 */

const number = new Intl.NumberFormat();
const STATE_LABEL: Record<MetricState, string> = {
  complete: 'Complete',
  partial: 'Partial: some data is missing',
  estimated: 'Estimated',
  empty: 'Nothing to measure yet',
  unavailable: 'Not available yet',
};
const FRESH_LABEL: Record<FreshnessState, string> = {
  current: 'Up to date',
  catching_up: 'Catching up',
  degraded: 'Some data could not be brought up to date',
};
const ROLE_PATH = { task: 'tasks', project: 'projects', deliverable: 'tasks' } as const;
const FIELDS = ['metric', 'version', 'brand', 'project', 'from', 'to', 'member'] as const;

function parseQuery(search: URLSearchParams): MetricQuery {
  const q = { ...EMPTY_METRIC_QUERY };
  for (const f of FIELDS) q[f] = search.get(f) ?? '';
  return q;
}
function toParams(q: MetricQuery): URLSearchParams {
  const p = new URLSearchParams();
  for (const f of FIELDS) if (q[f]) p.set(f, q[f]);
  return p;
}

const label = (k: string) => k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Seconds as the largest sensible unit, so a long cycle time reads as days, not as a number of seconds. */
export function duration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 172_800) return `${Math.round((s / 3600) * 10) / 10} h`;
  return `${Math.round((s / 86_400) * 10) / 10} days`;
}

function show(key: string, v: unknown): string {
  if (v === null || v === undefined) return 'Not available';
  if (typeof v === 'number')
    return key.endsWith('_seconds') || key === 'seconds'
      ? duration(v)
      : key.endsWith('percent') || key === 'percent'
        ? `${number.format(v)}%`
        : key.endsWith('minutes')
          ? `${number.format(v)} min`
          : number.format(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

type Row = { path: string; key: string; value: unknown };
/** The scalar facts of a figure, flattened with readable names; lists are shown separately. */
function rows(prefix: string, v: Record<string, unknown>, out: Row[] = []): Row[] {
  for (const [k, x] of Object.entries(v)) {
    const path = prefix ? `${prefix} · ${label(k).toLowerCase()}` : label(k);
    if (Array.isArray(x)) continue;
    if (x !== null && typeof x === 'object') rows(path, x as Record<string, unknown>, out);
    else out.push({ path, key: k, value: x });
  }
  return out;
}

function FreshnessNotice({
  r,
  ws,
  canRepair,
  onRepair,
}: {
  r: MetricResult;
  ws: string;
  canRepair: boolean;
  onRepair: () => void;
}) {
  const f = r.freshness;
  if (f.state === 'current' && !f.ledger?.tasks_with_repaired_history) return null;
  const ledger = f.ledger;
  return (
    <Banner
      tone={f.state === 'degraded' ? 'warning' : 'info'}
      title={FRESH_LABEL[f.state]}
      action={
        canRepair && f.state !== 'current' ? (
          <button type="button" className="button button-secondary" onClick={onRepair}>
            Check status history now
          </button>
        ) : undefined
      }
    >
      {ledger
        ? `The task status history is ${ledger.reconciliation.replace(/_/g, ' ')}${
            ledger.last_success_at
              ? `; it was last checked ${new Date(ledger.last_success_at).toLocaleString()}`
              : '; it has not been checked yet'
          }. `
        : null}
      {ledger?.tasks_with_repaired_history
        ? `${number.format(ledger.tasks_with_repaired_history)} task${ledger.tasks_with_repaired_history === 1 ? '' : 's'} had history rebuilt from a check, not recorded as it happened. `
        : null}
      Figures may lag the records until it catches up.
      <span className="visually-hidden"> Workspace {ws}.</span>
    </Banner>
  );
}

function Definition({ def, r }: { def: MetricDefinitionInfo | undefined; r: MetricResult }) {
  return (
    <details className="metric-definition">
      <summary>How this is counted</summary>
      <dl>
        <dt>Version</dt>
        <dd>
          {r.definition.name}, version {r.definition.version}
        </dd>
        {def ? (
          <>
            <dt>Counted</dt>
            <dd>{def.numerator}</dd>
            {def.denominator ? (
              <>
                <dt>Out of</dt>
                <dd>{def.denominator}</dd>
              </>
            ) : null}
            <dt>Rolled up</dt>
            <dd>{def.rollup.note}</dd>
            <dt>Time zone</dt>
            <dd>
              {def.timezone === 'workspace'
                ? `The workspace's (${r.timezone ?? 'workspace'})`
                : 'Not time-zone dependent'}
            </dd>
            <dt>Computed from</dt>
            <dd>{def.sources.join(', ') || 'No source yet'}</dd>
          </>
        ) : null}
        <dt>Who sees it</dt>
        <dd>{r.limits[1]}</dd>
        <dt>It does not claim</dt>
        <dd>{r.limits[0]}</dd>
        <dt>Reproduce</dt>
        <dd>
          As of {new Date(r.reproducibility.as_of).toLocaleString()}; figure code{' '}
          <code>{r.reproducibility.result_digest.slice(0, 12)}</code>
        </dd>
      </dl>
    </details>
  );
}

function GroupTable({ r }: { r: MetricResult }) {
  const list = r.groups as Array<Record<string, unknown>>;
  const series = (r.value?.series ?? null) as Array<Record<string, unknown>> | null;
  const bands = (r.value?.bands ?? r.value?.categories ?? null) as Array<
    Record<string, unknown>
  > | null;
  const sources = (r.value?.sources ?? null) as Array<Record<string, unknown>> | null;
  const table = (caption: string, data: Array<Record<string, unknown>>) => {
    const cols = [...new Set(data.flatMap((d) => Object.keys(d)))].filter(
      (c) => typeof data[0]?.[c] !== 'object' || data[0]?.[c] === null,
    );
    // A person or project is an object with a name; show the name.
    const named = [...new Set(data.flatMap((d) => Object.keys(d)))].filter(
      (c) => data[0]?.[c] && typeof data[0]?.[c] === 'object' && 'name' in (data[0][c] as object),
    );
    return (
      <div className="table-scroll" role="region" aria-label={caption} tabIndex={0}>
        <table className="access-table metric-table">
          <caption>{caption}</caption>
          <thead>
            <tr>
              {[...named, ...cols].map((c) => (
                <th key={c} scope="col">
                  {label(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((d, i) => (
              <tr key={i}>
                {[...named, ...cols].map((c) => (
                  <td key={c} data-label={label(c)}>
                    {named.includes(c)
                      ? String((d[c] as { name?: string })?.name ?? '')
                      : show(c, d[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };
  return (
    <>
      {list.length ? table('Breakdown', list) : null}
      {series?.length ? table('Per day', series) : null}
      {bands?.length ? table('Distribution', bands) : null}
      {sources?.length
        ? table(
            'Sources',
            sources.map(({ detail: _detail, ...s }) => s),
          )
        : null}
    </>
  );
}

function recordHref(ws: string, r: MetricRecord): string {
  const target = r.record.type === 'deliverable' && r.host ? r.host : r.record;
  return `/workspaces/${ws}/${ROLE_PATH[target.type as keyof typeof ROLE_PATH]}/${target.id}`;
}

function Records({
  ws,
  q,
  role,
  label: roleLabel,
}: {
  ws: string;
  q: MetricQuery;
  role: string;
  label: string;
}) {
  const [pages, setPages] = useState<MetricRecords[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const key = JSON.stringify([ws, q]);
  const [syncedKey, setSyncedKey] = useState(key);
  if (syncedKey !== key) {
    setSyncedKey(key);
    setPages([]);
    setError(null);
    setLoading(true);
  }
  const more = useCallback(
    (cursor: string) => {
      setLoading(true);
      metricsApi.records(ws, { ...q, member: role }, cursor).then(
        (p) => {
          setPages((prev) => [...prev, p]);
          setError(null);
          setLoading(false);
        },
        (err: unknown) => {
          setError(err);
          setLoading(false);
        },
      );
    },
    [ws, q, role],
  );
  useEffect(() => {
    const t = setTimeout(() => more(''), 0);
    return () => clearTimeout(t);
    // `key` stands for the workspace and the whole query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const items = pages.flatMap((p) => p.items);
  const last = pages.at(-1);
  return (
    <section aria-labelledby="metric-records-title" className="metric-records">
      <h3 id="metric-records-title">
        {roleLabel}
        {last ? ` (${number.format(last.total)})` : ''}
      </h3>
      {error ? <ProblemBanner error={error} /> : null}
      {items.length ? (
        <ul className="metric-record-list">
          {items.map((r) => (
            <li key={`${r.record.type}:${r.record.id}`}>
              <Link to={recordHref(ws, r)}>{r.title}</Link>
              <span className="metric-record-meta">
                {r.brand ? <BrandMarker marker={r.brand} decorative /> : null}
                {r.project ? ` ${r.project.name}` : ''}
                {r.status.category ? ` · ${label(r.status.category)}` : ''}
                {r.status.state ? ` · ${label(r.status.state)}` : ''}
                {r.due ? ` · due ${r.due}` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : loading ? (
        <p role="status">Loading the records…</p>
      ) : error ? null : (
        <p>No records.</p>
      )}
      {last?.page.next_cursor ? (
        <button
          type="button"
          className="button button-secondary"
          disabled={loading}
          onClick={() => more(last.page.next_cursor!)}
        >
          Show more
        </button>
      ) : null}
      {last?.page.truncated ? (
        <p className="muted">The list stops here; narrow the scope to see the rest.</p>
      ) : null}
    </section>
  );
}

export function MetricsPage({ ws }: { ws: string }) {
  const { search, navigate } = useRouter();
  const shell = useWorkspaceShell();
  const q = useMemo(() => parseQuery(search), [search]);
  const [catalog, setCatalog] = useState<MetricCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<unknown>(null);
  const [settled, setSettled] = useState<{
    key: string;
    data: MetricResult | null;
    error: unknown;
  } | null>(null);
  const [said, setSaid] = useState('');
  const brands = shell?.context?.brands ?? [];
  const canRepair = Boolean(shell?.context?.workspace.capabilities.configure);

  useEffect(() => {
    let live = true;
    metricsApi.catalog(ws).then(
      (c) => live && setCatalog(c),
      (e: unknown) => live && setCatalogError(e),
    );
    return () => {
      live = false;
    };
  }, [ws]);

  const metricId = q.metric || catalog?.data.find((d) => d.current)?.id || '';
  const defs = useMemo(
    () => catalog?.data.filter((d) => d.id === metricId) ?? [],
    [catalog, metricId],
  );
  const def =
    defs.find((d) => (q.version ? String(d.version) === q.version : d.current)) ?? defs[0];
  const effective = useMemo<MetricQuery>(() => ({ ...q, metric: metricId }), [q, metricId]);
  const requestKey = JSON.stringify(effective);

  useEffect(() => {
    if (!metricId) return;
    const controller = new AbortController();
    const asked = requestKey;
    metricsApi.get(ws, { ...effective, member: '' }, controller.signal).then(
      (data) => !controller.signal.aborted && setSettled({ key: asked, data, error: null }),
      (error: unknown) => {
        if (!controller.signal.aborted) setSettled({ key: asked, data: null, error });
      },
    );
    return () => controller.abort();
    // `requestKey` stands for the workspace and the whole query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, requestKey]);
  const answered = settled?.key === requestKey;
  const loading = Boolean(metricId) && !answered;
  const result = answered ? settled.data : null;
  const error = answered ? settled.error : null;

  const go = (next: Partial<MetricQuery>, replace = false) => {
    const merged = { ...q, metric: metricId, ...next };
    navigate(`/workspaces/${ws}/metrics?${toParams(merged).toString()}`, { replace });
  };
  const pick =
    (name: keyof MetricQuery) => (e: ChangeEvent<HTMLSelectElement | HTMLInputElement>) =>
      go(
        name === 'metric'
          ? { metric: e.target.value, version: '', member: '', from: '', to: '' }
          : { [name]: e.target.value, member: '' },
      );

  const repair = async () => {
    try {
      await metricsApi.reconcile(ws);
      setSaid('A check of the status history is scheduled. Reload the figure in a minute.');
    } catch (err) {
      setSaid(err instanceof ApiError ? err.message : 'That could not be requested.');
    }
  };

  const drillRole =
    q.member && result?.drill.members.some((m) => m.role === q.member) ? q.member : '';
  const drillLabel = result?.drill.members.find((m) => m.role === drillRole)?.label ?? '';
  // The headline already shows the percentage, so it is not repeated in the facts.
  const facts = result?.value ? rows('', result.value).filter((f) => f.path !== 'Percent') : [];
  const headline =
    result?.value && typeof result.value.percent === 'number'
      ? `${number.format(result.value.percent)}%`
      : result?.parts?.numerator !== null &&
          result?.parts?.numerator !== undefined &&
          result?.parts?.denominator
        ? `${number.format(result.parts.numerator)} of ${number.format(result.parts.denominator)}`
        : null;

  return (
    <Page title="Metrics" wide>
      <p className="muted">
        Every figure shows the rule behind it and the records it is made of, for what you can read.
      </p>
      {catalogError ? <ProblemBanner error={catalogError} /> : null}
      <form
        className="metric-controls"
        onSubmit={(e) => e.preventDefault()}
        aria-label="Choose a metric"
      >
        <div className="field">
          <label htmlFor="metric-id">Metric</label>
          <select id="metric-id" value={metricId} onChange={pick('metric')} disabled={!catalog}>
            {[...new Map((catalog?.data ?? []).map((d) => [d.id, d])).values()].map((d) => (
              <option key={d.id} value={d.id}>
                {d.name.replace(/ \(.*\)$/, '')}
                {d.availability.state === 'source_unavailable' ? ' (not available yet)' : ''}
              </option>
            ))}
          </select>
        </div>
        {defs.length > 1 ? (
          <div className="field">
            <label htmlFor="metric-version">Version</label>
            <select
              id="metric-version"
              value={String(def?.version ?? '')}
              onChange={pick('version')}
            >
              {defs.map((d) => (
                <option key={d.version} value={d.version}>
                  {d.name}
                  {d.current ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {def?.scopes.includes('brand') ? (
          <div className="field">
            <label htmlFor="metric-brand">Brand</label>
            <select id="metric-brand" value={q.brand} onChange={pick('brand')}>
              <option value="">All brands I can see</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {def?.window === 'window' ? (
          <>
            <div className="field">
              <label htmlFor="metric-from">From</label>
              <input id="metric-from" type="date" value={q.from} onChange={pick('from')} />
            </div>
            <div className="field">
              <label htmlFor="metric-to">To</label>
              <input id="metric-to" type="date" value={q.to} onChange={pick('to')} />
            </div>
          </>
        ) : null}
      </form>
      {q.project && result?.scope.project ? (
        <p>
          Scoped to the project <strong>{result.scope.project.name}</strong>{' '}
          <Link to={`/workspaces/${ws}/metrics?${toParams({ ...q, project: '' }).toString()}`}>
            Show the whole workspace
          </Link>
        </p>
      ) : null}
      <Announce>{said}</Announce>
      {error ? <ProblemBanner error={error} /> : null}
      {loading ? <p role="status">Loading the figure…</p> : null}
      {result ? (
        <section aria-labelledby="metric-result-title" className="metric-result">
          <h2 id="metric-result-title">
            {result.definition.name}{' '}
            <span className="muted">version {result.definition.version}</span>
          </h2>
          <p className={`metric-state metric-state-${result.state}`}>
            <strong>{STATE_LABEL[result.state]}</strong>
            {result.window
              ? ` · ${result.window.from} to ${result.window.to} (${result.window.days} days${result.timezone ? `, ${result.timezone}` : ''})`
              : ''}
          </p>
          {result.unavailable ? (
            <Banner tone="info" title={`Not available until phase ${result.unavailable.phase}`}>
              {result.unavailable.reason}
            </Banner>
          ) : null}
          <FreshnessNotice
            r={result}
            ws={ws}
            canRepair={canRepair}
            onRepair={() => void repair()}
          />
          {headline ? <p className="metric-headline">{headline}</p> : null}
          {result.incomplete.length ? (
            <ul className="metric-incomplete" aria-label="What is missing">
              {result.incomplete.map((i) => (
                <li key={i.code}>
                  {i.count !== null ? `${number.format(i.count)}: ` : ''}
                  {i.message}
                </li>
              ))}
            </ul>
          ) : null}
          {facts.length ? (
            <dl className="metric-facts">
              {facts.map((f) => (
                <div key={f.path}>
                  <dt>{f.path}</dt>
                  <dd>{show(f.key, f.value)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <GroupTable r={result} />
          {result.drill.members.length ? (
            <nav aria-label="Records behind this figure" className="metric-drill">
              <h3>Records behind this figure</h3>
              <ul>
                {result.drill.members.map((m) => (
                  <li key={m.role}>
                    <button
                      type="button"
                      className="button button-secondary"
                      aria-pressed={drillRole === m.role}
                      onClick={() => go({ member: drillRole === m.role ? '' : m.role }, true)}
                    >
                      {m.label} ({number.format(m.count)})
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
          {drillRole ? (
            <Records
              ws={ws}
              q={{ ...effective, member: drillRole }}
              role={drillRole}
              label={drillLabel}
            />
          ) : null}
          <Definition def={def} r={result} />
          {result.state !== 'unavailable' ? (
            <p>
              <a
                className="button button-secondary"
                href={metricsApi.exportHref(ws, effective)}
                download
              >
                Download as CSV
              </a>
            </p>
          ) : null}
        </section>
      ) : null}
    </Page>
  );
}
