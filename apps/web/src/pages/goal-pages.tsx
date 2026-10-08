import { useMemo, useState } from 'react';
import { ApiError } from '../api.ts';
import { CreateGoalDialog } from '../goals/dialogs.tsx';
import {
  BASIS_LABEL,
  CONFIDENCE_LABEL,
  GOAL_STATUS_LABEL,
  goals,
  saveFile,
  type Goal,
  type GoalQuery,
} from '../goals/client.ts';
import { useMembers } from '../goals/hooks.ts';
import {
  changeMode,
  currentQuarter,
  rangeOf,
  selLabel,
  shiftSel,
  type PeriodMode,
  type PeriodSel,
} from '../goals/periods.ts';
import {
  AvailableView,
  Chip,
  ConfidenceChip,
  Coverage,
  explain,
  ProblemLine,
  ProgressView,
  ScopeLine,
  StatusChip,
  UpdateChip,
  type Explained,
} from '../goals/shared.tsx';
import { projects } from '../projects/client.ts';
import { Link, useRouter } from '../router.tsx';
import { useRegisterCommands } from '../shell/commands.tsx';
import { routeHref } from '../shell/registry.ts';
import { BrandMarker } from '../shell/brand-marker.tsx';
import { useWorkspaceShell } from '../shell/workspace.tsx';
import { useResource } from '../tenancy/resource.tsx';
import { Field, SelectField } from '../ui/form.tsx';
import { Page } from '../ui/layout.tsx';

/**
 * Goals (5B, IA "Goals"): a period selector, then workspace goals, then goals per brand with their
 * linked work and progress. Every row shows how its progress was produced, how fresh the update
 * is, and what linked work the viewer can see; nothing is shown about work the viewer cannot read.
 */

const PAGE = 25;

interface Filters {
  scope: string;
  project: string;
  status: string;
  owner: string;
  confidence: string;
  update: string;
  basis: string;
  q: string;
}
const NO_FILTERS: Filters = {
  scope: '',
  project: '',
  status: '',
  owner: '',
  confidence: '',
  update: '',
  basis: '',
  q: '',
};

function queryOf(sel: PeriodSel, f: Filters): GoalQuery {
  const range = rangeOf(sel);
  return {
    ...(range ? { from: range.from, to: range.to } : {}),
    ...(f.scope ? { brand: f.scope } : {}),
    ...(f.project ? { project: f.project } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.owner ? { owner: f.owner } : {}),
    ...(f.confidence ? { confidence: f.confidence } : {}),
    ...(f.update ? { update: f.update } : {}),
    ...(f.basis ? { basis: f.basis } : {}),
    ...(f.q.trim() ? { q: f.q.trim() } : {}),
  };
}

// ---- A goal row (also used inside a project) --------------------------------------------------

/** One goal: title, scope, owner, period, status, progress with its rule, freshness, linked work. */
export function GoalRow({ ws, goal, headingLevel = 3 }: { ws: string; goal: Goal; headingLevel?: 3 | 4 }) {
  const H = `h${headingLevel}` as 'h3' | 'h4';
  const open = goal.status === 'draft' || goal.status === 'active';
  const w = goal.work;
  return (
    <li className="gl-row">
      <div className="gl-row-head">
        <H className="gl-row-title">
          <Link to={routeHref('goal', { ws, goal: goal.id })}>{goal.title}</Link>
        </H>
        <StatusChip status={goal.status} />
      </div>
      <p className="gl-meta">
        <ScopeLine scope={goal.scope} />
        <span> · Owner: {goal.owner?.name ?? 'No owner'}</span>
        <span> · {goal.period.label}</span>
        {goal.period.state === 'ended' ? <span> (period ended)</span> : null}
        {goal.period.state === 'upcoming' ? <span> (starts later)</span> : null}
      </p>
      <ProgressView progress={goal.progress} label={`Progress of ${goal.title}`} />
      <p className="gl-chips">
        <ConfidenceChip value={goal.latest.confidence} />
        <UpdateChip fresh={goal.freshness} latest={goal.latest} />
        {open && goal.freshness.recalculation.state === 'failing' ? (
          <Chip tone="warn" glyph="△">
            Recalculation failing
          </Chip>
        ) : null}
      </p>
      <p className="gl-work">
        {w.visible_links === 0
          ? 'No linked work you can see.'
          : `${w.visible_links} linked project or task${w.visible_links === 1 ? '' : 's'} you can see, ${w.active_links} active.`}
        {open && w.active_links === 0 ? (
          <>
            {' '}
            <Chip tone="warn" glyph="△">
              No active work you can see
            </Chip>
          </>
        ) : null}
      </p>
    </li>
  );
}

// ---- Period selector --------------------------------------------------------------------------

function PeriodSelector({
  sel,
  onChange,
}: {
  sel: PeriodSel;
  onChange: (s: PeriodSel) => void;
}) {
  const sized = sel.mode === 'quarter' || sel.mode === 'half' || sel.mode === 'year';
  const unit = sel.mode === 'quarter' ? 'quarter' : sel.mode === 'half' ? 'half year' : 'year';
  return (
    <section className="gl-period-select" aria-labelledby="gl-period-h">
      <h2 id="gl-period-h" className="gl-h-small">
        Period
      </h2>
      <div className="gl-period-controls">
        <SelectField
          id="period-mode"
          label="Show goals for"
          value={sel.mode}
          onChange={(m) => onChange(changeMode(sel, m as PeriodMode))}
          options={[
            { value: 'quarter', label: 'A quarter' },
            { value: 'half', label: 'A half year' },
            { value: 'year', label: 'A year' },
            { value: 'custom', label: 'Custom dates' },
            { value: 'all', label: 'All periods' },
          ]}
        />
        {sized ? (
          <div className="gl-stepper" role="group" aria-label="Move the period">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => onChange(shiftSel(sel, -1))}
            >
              Previous {unit}
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => onChange(shiftSel(sel, 1))}
            >
              Next {unit}
            </button>
            <button
              type="button"
              className="button button-ghost"
              onClick={() => onChange(currentQuarter())}
            >
              Current quarter
            </button>
          </div>
        ) : null}
        {sel.mode === 'custom' ? (
          <div className="gl-custom">
            <Field
              id="period-from"
              label="From"
              type="date"
              value={sel.start}
              onChange={(e) => onChange({ ...sel, start: e.target.value })}
            />
            <Field
              id="period-to"
              label="To"
              type="date"
              value={sel.end}
              onChange={(e) => onChange({ ...sel, end: e.target.value })}
              error={
                sel.start && sel.end && sel.end < sel.start ? 'The last day is before the first.' : undefined
              }
            />
          </div>
        ) : null}
      </div>
      <p className="gl-showing" role="status">
        Showing goals whose period overlaps <strong>{selLabel(sel)}</strong>.
      </p>
    </section>
  );
}

// ---- Page -------------------------------------------------------------------------------------

interface Group {
  key: string;
  heading: string;
  marker: Goal['scope'] | null;
  items: Goal[];
}

/** Workspace goals first, then one group per brand (its brand and project goals). */
function grouped(items: Goal[]): Group[] {
  const out: Group[] = [];
  const workspace = items.filter((g) => g.scope.kind === 'workspace');
  if (workspace.length)
    out.push({ key: 'workspace', heading: 'Workspace goals', marker: null, items: workspace });
  const brands = new Map<string, Group>();
  for (const g of items) {
    if (g.scope.kind === 'workspace') continue;
    const b = g.scope.brand;
    const id = b.kind === 'brand' ? b.id : 'other';
    const cur = brands.get(id) ?? {
      key: id,
      heading: b.kind === 'brand' ? b.name : 'Other goals',
      marker: g.scope,
      items: [],
    };
    cur.items.push(g);
    brands.set(id, cur);
  }
  return [...out, ...[...brands.values()].sort((a, b) => a.heading.localeCompare(b.heading))];
}

export function GoalsPage({ ws }: { ws: string }) {
  const shell = useWorkspaceShell();
  const { navigate } = useRouter();
  const { members } = useMembers(ws);
  const [sel, setSel] = useState<PeriodSel>(() => currentQuarter());
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [creating, setCreating] = useState(false);
  const [said, setSaid] = useState('');
  const [exportProblem, setExportProblem] = useState<Explained | null>(null);
  const query = useMemo(() => queryOf(sel, f), [sel, f]);
  const customInvalid = sel.mode === 'custom' && !rangeOf(sel);
  const key = `goals:${ws}:${JSON.stringify(query)}`;
  const first = useResource(
    () => goals.list(ws, { ...query, limit: PAGE }),
    customInvalid || !shell?.context ? 'wait' : key,
  );
  const [more, setMore] = useState<{
    key: string;
    items: Goal[];
    cursor: string | null;
    hasMore: boolean;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreProblem, setMoreProblem] = useState<Explained | null>(null);
  const projectList = useResource(() => projects.list(ws, { state: 'active' }), `gl-projects:${ws}`);
  const brands = shell?.context?.brands ?? [];

  useRegisterCommands([
    {
      id: 'goal.create',
      label: 'Create a goal',
      group: 'Actions',
      keywords: 'new goal objective okr',
      run: () => setCreating(true),
    },
  ]);

  const set = (k: keyof Filters) => (v: string) => setF((cur) => ({ ...cur, [k]: v }));
  const filtered = Object.values(f).some(Boolean);

  const loadMore = async (cursor: string, base: Goal[]) => {
    setLoadingMore(true);
    setMoreProblem(null);
    try {
      const next = await goals.list(ws, { ...query, limit: PAGE, cursor });
      setMore({
        key,
        items: [...base, ...next.data],
        cursor: next.page.next_cursor ?? null,
        hasMore: next.page.has_more,
      });
    } catch (err) {
      setMoreProblem(explain(err, 'loading more goals'));
    } finally {
      setLoadingMore(false);
    }
  };

  const download = async (format: 'csv' | 'json') => {
    setExportProblem(null);
    setSaid('');
    try {
      const file = await goals.exportFile(ws, format, query);
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
      title="Goals"
      wide
      actions={
        <>
          <button type="button" className="button button-primary" onClick={() => setCreating(true)}>
            Create goal
          </button>
          <Link className="button button-secondary" to={routeHref('portfolio', { ws })}>
            Portfolio health
          </Link>
        </>
      }
    >
      <PeriodSelector sel={sel} onChange={setSel} />
      <section className="gl-filters" aria-labelledby="gl-filters-h">
        <h2 id="gl-filters-h" className="gl-h-small">
          Filters
        </h2>
        <div className="gl-filter-grid">
          <SelectField
            id="f-scope"
            label="Scope"
            value={f.scope}
            onChange={set('scope')}
            options={[
              { value: '', label: 'Everywhere' },
              { value: 'workspace', label: 'Workspace-wide only' },
              ...brands.map((b) => ({ value: b.id, label: `Brand: ${b.name}` })),
            ]}
          />
          <SelectField
            id="f-project"
            label="Project"
            value={f.project}
            onChange={set('project')}
            options={[
              { value: '', label: 'Any project' },
              ...(projectList.state.status === 'ready' ? projectList.state.data.data : []).map((p) => ({
                value: p.id,
                label: p.name,
              })),
            ]}
          />
          <SelectField
            id="f-status"
            label="Status"
            value={f.status}
            onChange={set('status')}
            options={[
              { value: '', label: 'Any status' },
              ...(Object.keys(GOAL_STATUS_LABEL) as Array<keyof typeof GOAL_STATUS_LABEL>).map((s) => ({
                value: s,
                label: GOAL_STATUS_LABEL[s],
              })),
            ]}
          />
          <SelectField
            id="f-owner"
            label="Owner"
            value={f.owner}
            onChange={set('owner')}
            options={[
              { value: '', label: 'Anyone' },
              { value: 'me', label: 'Me' },
              ...members.filter((m) => !m.you).map((m) => ({ value: m.id, label: m.name })),
            ]}
          />
          <SelectField
            id="f-confidence"
            label="Confidence"
            value={f.confidence}
            onChange={set('confidence')}
            options={[
              { value: '', label: 'Any confidence' },
              ...(Object.keys(CONFIDENCE_LABEL) as Array<keyof typeof CONFIDENCE_LABEL>).map((c) => ({
                value: c,
                label: CONFIDENCE_LABEL[c],
              })),
              { value: 'none', label: 'No confidence set' },
            ]}
          />
          <SelectField
            id="f-update"
            label="Update freshness"
            value={f.update}
            onChange={set('update')}
            options={[
              { value: '', label: 'Any' },
              { value: 'fresh', label: 'Recently updated' },
              { value: 'stale', label: 'Stale' },
              { value: 'never', label: 'Never updated' },
            ]}
          />
          <SelectField
            id="f-basis"
            label="Progress basis"
            value={f.basis}
            onChange={set('basis')}
            options={[
              { value: '', label: 'Any' },
              ...(Object.keys(BASIS_LABEL) as Array<keyof typeof BASIS_LABEL>).map((b) => ({
                value: b,
                label: BASIS_LABEL[b],
              })),
            ]}
          />
          <Field
            id="f-q"
            label="Search titles"
            type="search"
            value={f.q}
            onChange={(e) => set('q')(e.target.value)}
          />
        </div>
        {filtered ? (
          <p>
            <button type="button" className="button button-ghost" onClick={() => setF(NO_FILTERS)}>
              Clear filters
            </button>
          </p>
        ) : null}
      </section>
      <div className="actions-compact gl-export" role="group" aria-label="Export">
        <button type="button" className="button button-secondary" onClick={() => void download('csv')}>
          Export CSV
        </button>
        <button type="button" className="button button-secondary" onClick={() => void download('json')}>
          Export JSON
        </button>
      </div>
      <ProblemLine problem={exportProblem} />
      <p className="announce" role="status">
        {said}
      </p>
      {customInvalid ? (
        <p className="hint" role="status">
          Choose a first and last day to see goals for a custom period.
        </p>
      ) : (
        <AvailableView resource={first.state} onRetry={first.retry} what="goals">
          {(page) => {
            const extra = more && more.key === key ? more : null;
            const items = extra ? extra.items : page.data;
            const hasMore = extra ? extra.hasMore : page.page.has_more;
            const cursor = extra ? extra.cursor : (page.page.next_cursor ?? null);
            const groups = grouped(items);
            return (
              <>
                <Coverage note={page.scope_note} asOf={page.as_of} />
                {!items.length ? (
                  <div className="empty-state">
                    <p>
                      {filtered || sel.mode !== 'all'
                        ? `No goals match for ${selLabel(sel)}${filtered ? ' with these filters' : ''}.`
                        : 'No goals yet.'}
                    </p>
                    <button
                      type="button"
                      className="button button-primary"
                      onClick={() => setCreating(true)}
                    >
                      Create a goal
                    </button>
                  </div>
                ) : (
                  groups.map((g) => (
                    <section key={g.key} className="card gl-group" aria-labelledby={`gl-g-${g.key}`}>
                      <h2 id={`gl-g-${g.key}`} className="gl-group-title">
                        {g.marker && g.marker.kind !== 'workspace' ? (
                          <BrandMarker marker={g.marker.brand} size={20} />
                        ) : (
                          g.heading
                        )}
                        <span className="visually-hidden">
                          {g.marker && g.marker.kind !== 'workspace' ? ' goals' : ''}
                        </span>
                      </h2>
                      <ul className="gl-list">
                        {g.items.map((goal) => (
                          <GoalRow key={goal.id} ws={ws} goal={goal} />
                        ))}
                      </ul>
                    </section>
                  ))
                )}
                <ProblemLine problem={moreProblem} />
                {hasMore && cursor ? (
                  <p className="actions">
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={loadingMore}
                      onClick={() => void loadMore(cursor, items)}
                    >
                      {loadingMore ? 'Loading…' : 'Show more goals'}
                    </button>
                  </p>
                ) : null}
              </>
            );
          }}
        </AvailableView>
      )}
      {creating ? (
        <CreateGoalDialog
          ws={ws}
          onClose={() => setCreating(false)}
          onCreated={(g) => {
            setCreating(false);
            navigate(routeHref('goal', { ws, goal: g.id }));
          }}
        />
      ) : null}
    </Page>
  );
}
