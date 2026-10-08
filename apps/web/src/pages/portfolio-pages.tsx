import { useMemo, useState } from 'react';
import { ApiError } from '../api.ts';
import {
  CATEGORY_LABEL,
  HEALTH_LABEL,
  portfolios,
  saveFile,
  type OverviewQuery,
  type ProjectCategory,
  type ProjectHealth,
} from '../goals/client.ts';
import { useMembers } from '../goals/hooks.ts';
import {
  DependenciesView,
  HealthTable,
  OrphansView,
  OverviewCoverage,
  SummaryTiles,
} from '../goals/portfolio.tsx';
import { PortfoliosManager } from '../goals/portfolio-manage.tsx';
import { AvailableView, explain, ProblemLine, type Explained } from '../goals/shared.tsx';
import { Link, useRouter } from '../router.tsx';
import { routeHref } from '../shell/registry.ts';
import { useWorkspaceShell } from '../shell/workspace.tsx';
import { useResource } from '../tenancy/resource.tsx';
import { SelectField } from '../ui/form.tsx';
import { Page } from '../ui/layout.tsx';

/**
 * Portfolio (5B, under Projects): health of the projects the viewer can read with the rules
 * behind it, dependencies between projects, projects without goals and goals without work, and
 * saved portfolios. Everything is computed for the viewer; the page never names or counts work
 * they cannot read, and every view says what it covers and when it was computed.
 */

const VIEWS = [
  { key: 'health', label: 'Health' },
  { key: 'dependencies', label: 'Dependencies' },
  { key: 'orphans', label: 'Goal coverage' },
  { key: 'portfolios', label: 'Saved portfolios' },
] as const;
type ViewKey = (typeof VIEWS)[number]['key'];
const STATUSES = Object.keys(CATEGORY_LABEL) as ProjectCategory[];
const HEALTHS = Object.keys(HEALTH_LABEL) as ProjectHealth[];

interface Filters {
  brand: string;
  owner: string;
  portfolio: string;
  status: string[];
  health: string[];
}
const NO_FILTERS: Filters = { brand: '', owner: '', portfolio: '', status: [], health: [] };

const toQuery = (f: Filters): OverviewQuery => ({
  ...(f.brand ? { brand: f.brand } : {}),
  ...(f.owner ? { owner: f.owner } : {}),
  ...(f.portfolio ? { portfolio: f.portfolio } : {}),
  ...(f.status.length ? { status: f.status.join(',') } : {}),
  ...(f.health.length ? { health: f.health.join(',') } : {}),
});

function CheckGroup({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: Array<{ value: string; label: string }>;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <fieldset className="plain gl-checkgroup">
      <legend>{legend}</legend>
      {options.map((o) => (
        <label key={o.value} className="choice">
          <input
            type="checkbox"
            checked={value.includes(o.value)}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, o.value] : value.filter((x) => x !== o.value))
            }
          />{' '}
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

export function PortfolioPage({ ws }: { ws: string }) {
  const shell = useWorkspaceShell();
  const { path, search, navigate } = useRouter();
  const { members } = useMembers(ws);
  const view: ViewKey = (VIEWS.find((v) => v.key === search.get('view'))?.key ??
    'health') as ViewKey;
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [limit, setLimit] = useState(100);
  const [said, setSaid] = useState('');
  const [exportProblem, setExportProblem] = useState<Explained | null>(null);
  const query = useMemo(() => toQuery(f), [f]);
  const brands = shell?.context?.brands ?? [];
  const savedList = useResource(() => portfolios.list(ws), `pf-pick:${ws}`);
  const saved = savedList.state.status === 'ready' ? savedList.state.data.data : [];

  const go = (v: ViewKey) => navigate(v === 'health' ? path : `${path}?view=${v}`);
  const overview = useResource(
    () => portfolios.overview(ws, { ...query, limit }),
    view === 'health' ? `pfo:${ws}:${JSON.stringify(query)}:${limit}` : 'wait',
  );
  const deps = useResource(
    () => portfolios.dependencies(ws, query),
    view === 'dependencies' ? `pfd:${ws}:${JSON.stringify(query)}` : 'wait',
  );
  const orphans = useResource(
    () => portfolios.orphans(ws, query),
    view === 'orphans' ? `pfx:${ws}:${JSON.stringify(query)}` : 'wait',
  );

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setF((cur) => ({ ...cur, [k]: v }));
  const filtered = f.brand || f.owner || f.portfolio || f.status.length || f.health.length;

  const download = async (format: 'csv' | 'json') => {
    setExportProblem(null);
    setSaid('');
    try {
      const file = await portfolios.exportFile(ws, format, query);
      saveFile(file);
      setSaid(`Exported ${file.filename}.`);
    } catch (err) {
      setExportProblem(
        err instanceof ApiError && err.code === 'validation_failed' && err.issues[0]
          ? { message: err.issues[0].message, kind: 'rejected', retryable: false }
          : explain(err, 'the export'),
      );
    }
  };

  return (
    <Page
      title="Portfolio"
      wide
      section="Projects"
      breadcrumbs={[
        { label: 'Projects', to: routeHref('projects', { ws }) },
        { label: 'Portfolio' },
      ]}
    >
      <p className="hint">
        Health, dependencies, and goal coverage across the projects you can read. Everything here is
        computed for you; work you cannot read changes no figure.
      </p>
      <nav aria-label="Portfolio views" className="section-nav gl-tabs">
        <ul className="tabs">
          {VIEWS.map((v) => (
            <li key={v.key}>
              <Link
                to={v.key === 'health' ? path : `${path}?view=${v.key}`}
                aria-current={view === v.key ? 'page' : undefined}
              >
                {v.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {view !== 'portfolios' ? (
        <section className="gl-filters" aria-labelledby="pf-filters-h">
          <h2 id="pf-filters-h" className="gl-h-small">
            Filters
          </h2>
          <div className="gl-filter-grid">
            <SelectField
              id="pf-f-brand"
              label="Brand"
              value={f.brand}
              onChange={(v) => set('brand', v)}
              options={[
                { value: '', label: 'All brands' },
                ...brands.map((b) => ({ value: b.id, label: b.name })),
              ]}
            />
            <SelectField
              id="pf-f-portfolio"
              label="Saved portfolio"
              value={f.portfolio}
              onChange={(v) => set('portfolio', v)}
              options={[
                { value: '', label: 'All projects you can read' },
                ...saved.map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
            <SelectField
              id="pf-f-owner"
              label="Owner"
              value={f.owner}
              onChange={(v) => set('owner', v)}
              options={[
                { value: '', label: 'Anyone' },
                { value: 'me', label: 'Me' },
                ...members.filter((m) => !m.you).map((m) => ({ value: m.id, label: m.name })),
              ]}
            />
            <CheckGroup
              legend="Project status"
              options={STATUSES.map((s) => ({ value: s, label: CATEGORY_LABEL[s] }))}
              value={f.status}
              onChange={(v) => set('status', v)}
            />
            {view === 'health' ? (
              <CheckGroup
                legend="Health"
                options={HEALTHS.map((h) => ({ value: h, label: HEALTH_LABEL[h] }))}
                value={f.health}
                onChange={(v) => set('health', v)}
              />
            ) : null}
          </div>
          {filtered ? (
            <p>
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setF(NO_FILTERS)}
              >
                Clear filters
              </button>
            </p>
          ) : null}
          <div className="actions-compact gl-export" role="group" aria-label="Export">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void download('csv')}
            >
              Export health as CSV
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void download('json')}
            >
              Export health as JSON
            </button>
          </div>
          <ProblemLine problem={exportProblem} />
          <p className="announce" role="status">
            {said}
          </p>
        </section>
      ) : null}

      {view === 'health' ? (
        <AvailableView resource={overview.state} onRetry={overview.retry} what="portfolio">
          {(o) => (
            <>
              {o.portfolio ? (
                <p className="hint">
                  Showing the portfolio <strong>{o.portfolio.name}</strong>:{' '}
                  {o.portfolio.projects_count} project{o.portfolio.projects_count === 1 ? '' : 's'}{' '}
                  you can read.
                </p>
              ) : null}
              <OverviewCoverage o={o} />
              <h2>Summary</h2>
              <SummaryTiles
                ws={ws}
                s={o.summary}
                notTracked={o.coverage.not_tracked}
                onOpenView={go}
              />
              <h2>Project health</h2>
              <HealthTable ws={ws} rows={o.data} />
              {o.page.has_more ? (
                <p className="actions">
                  <span className="hint">
                    Showing the first {o.data.length} of the projects that match.
                  </span>
                  {limit < 200 ? (
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => setLimit(200)}
                    >
                      Show more projects
                    </button>
                  ) : (
                    <span className="hint"> Narrow the filters or export to see the rest.</span>
                  )}
                </p>
              ) : null}
            </>
          )}
        </AvailableView>
      ) : null}
      {view === 'dependencies' ? (
        <AvailableView resource={deps.state} onRetry={deps.retry} what="dependencies">
          {(d) => <DependenciesView ws={ws} d={d} />}
        </AvailableView>
      ) : null}
      {view === 'orphans' ? (
        <AvailableView resource={orphans.state} onRetry={orphans.retry} what="goal coverage">
          {(o) => <OrphansView ws={ws} o={o} />}
        </AvailableView>
      ) : null}
      {view === 'portfolios' ? (
        <PortfoliosManager
          ws={ws}
          brands={brands.map((b) => ({ id: b.id, name: b.name }))}
          onOpen={(id) => {
            setF({ ...NO_FILTERS, portfolio: id });
            navigate(path);
          }}
        />
      ) : null}
    </Page>
  );
}
