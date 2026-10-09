import { DeliverablesSummary } from '../files/deliverables.tsx';
import { FilesPanel } from '../files/files-panel.tsx';
import { ScopeDefaultsEditor } from '../notify/defaults.tsx';
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  DECISION_STATES,
  PROJECT_HEALTH,
  PROJECT_PRIORITIES,
  PROJECT_SECTIONS,
  SCOPE_ITEM_KINDS,
  type ProjectSectionKey,
} from '@pm/contracts/shell';
import { canonicalJson, plainFromRichText, richTextFromPlain } from '@pm/contracts/rich-text';
import { ApiError } from '../api.ts';
import { CollaborationSections } from '../collab/collaboration.tsx';
import {
  RecordFieldsSection,
  TransitionControl,
  useStatusChoices,
} from '../workflow/record-workflow.tsx';
import { ProjectTasksSection } from './task-pages.tsx';
import {
  projects,
  type Overview,
  type Project,
  type ProjectSummary,
  type Series,
} from '../projects/client.ts';
import { Link, useRouter } from '../router.tsx';
import { BrandMarker } from '../shell/brand-marker.tsx';
import { useRegisterCommands } from '../shell/commands.tsx';
import { routeHref } from '../shell/registry.ts';
import { useRecordVisit, useWorkspaceShell } from '../shell/workspace.tsx';
import { ProjectGoalsCard } from '../goals/project-goals.tsx';
import { useStepUp } from '../stepup.tsx';
import { collab, tenancy, type Member } from '../tenancy/client.ts';
import { ResourceView, useResource } from '../tenancy/resource.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Announce, Banner, ProblemBanner } from '../ui/feedback.tsx';
import {
  ErrorSummary,
  Field,
  fieldErrorsFrom,
  SelectField,
  SubmitButton,
  TextAreaField,
} from '../ui/form.tsx';
import { Page } from '../ui/layout.tsx';
import { MentionedInDocuments } from '../docs/panels.tsx';
import { DocumentsSection } from '../docs/sections.tsx';
import { ProjectReports } from '../insights/overview.tsx';
import { WorkTimePanel } from './time-pages.tsx';
import { ReviewedChange } from './people-pages.tsx';
import { OtherIssues, SaveProblem, splitIssues } from './workspace-pages.tsx';
import { FavoriteToggle } from './shell-pages.tsx';

/**
 * Phase 2A projects (0E IA §4–§6): the list (grouped by brand in multi-brand scope, by status in
 * single-brand scope), the keyboard hierarchy tree with non-drag Move/Indent/Outdent, and the
 * record page with the fixed section order. Later sections are honest unavailable states; Tests
 * and Releases are addressable but their tabs stay absent until enabled (UXD-14).
 */

const STATUS_ICON: Record<string, string> = {
  planned: '○',
  active: '◐',
  paused: '⏸',
  done: '✔',
  cancelled: '⊘',
};
const HEALTH_LABEL: Record<string, string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  off_track: 'Off track',
};
const HEALTH_ICON: Record<string, string> = { on_track: '✓', at_risk: '△', off_track: '⬣' };
const PRIORITY_LABEL: Record<string, string> = {
  none: 'No priority',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};
const SCOPE_LABEL: Record<string, string> = {
  scope: 'In scope',
  exclusion: 'Exclusions',
  risk: 'Risks',
  assumption: 'Assumptions',
  constraint: 'Constraints',
};
const LEVEL_OPTIONS = [
  { value: 'view', label: 'Can view' },
  { value: 'comment', label: 'Can comment' },
  { value: 'edit', label: 'Can edit' },
  { value: 'manage', label: 'Can manage' },
];

export function StatusBadge({ status }: { status: { name: string; category: string } }) {
  return (
    <span className={`badge status-${status.category}`}>
      <span aria-hidden="true">{STATUS_ICON[status.category]} </span>
      {status.name}
    </span>
  );
}

function HealthBadge({ value }: { value: string | null }) {
  if (!value)
    return (
      <span className="badge">
        <span aria-hidden="true">◌ </span>No health set
      </span>
    );
  return (
    <span className={`badge health-${value}`}>
      <span aria-hidden="true">{HEALTH_ICON[value]} </span>
      {HEALTH_LABEL[value]}
    </span>
  );
}

/** Runs one command with the shared busy/error/announcement pattern. */
export function useCommand(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [said, setSaid] = useState('');
  const run = async (action: () => Promise<unknown>, message: string) => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      await action();
      setSaid(message);
      onDone();
      return true;
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled')) setError(err);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, said, run, setError };
}

// -----------------------------------------------------------------------------------------------
// Projects list and tree
// -----------------------------------------------------------------------------------------------

export function ProjectsPage({ ws }: { ws: string }) {
  const shellState = useWorkspaceShell();
  const ctx = shellState?.context;
  const scope = ctx?.scope;
  const brandIds =
    scope?.kind === 'brand' ? [scope.brand_id] : scope?.kind === 'brands' ? scope.brand_ids : [];
  const single = scope?.kind === 'brand';
  const [archived, setArchived] = useState(false);
  const [view, setView] = useState<'list' | 'tree'>('list');
  const [creating, setCreating] = useState(false);
  const data = useResource(
    () => projects.list(ws, { brands: brandIds, state: archived ? 'archived' : 'active' }),
    ctx ? `projects:${ws}:${brandIds.join(',')}:${archived}` : 'wait',
  );
  // Creation is offered only in brands where the same `record.create` decision would allow it.
  const member = shellState?.access?.principal === 'member';
  const brandList = useResource(
    () => tenancy.listBrands(ws, 'active'),
    member ? `brands:${ws}:creatable` : 'wait',
  );
  const creatable =
    brandList.state.status === 'ready'
      ? brandList.state.data.data.filter((b) => b.capabilities.create_records)
      : [];
  const canCreate =
    member && (single ? creatable.some((b) => b.id === brandIds[0]) : creatable.length > 0);
  useRegisterCommands(
    canCreate
      ? [
          {
            id: 'project.create',
            label: 'Create a project',
            group: 'Actions',
            keywords: 'new project',
            run: () => setCreating(true),
          },
        ]
      : [],
  );
  return (
    <Page
      title="Projects"
      wide
      actions={
        <>
          {member ? (
            <Link className="button button-secondary" to={routeHref('portfolio', { ws })}>
              Portfolio health
            </Link>
          ) : null}
          {canCreate ? (
            <button
              type="button"
              className="button button-primary"
              onClick={() => setCreating(true)}
            >
              Create project
            </button>
          ) : null}
        </>
      }
    >
      <div className="toolbar" role="group" aria-label="Project view">
        <button
          type="button"
          className="button button-secondary"
          aria-pressed={view === 'list'}
          onClick={() => setView('list')}
        >
          List
        </button>
        <button
          type="button"
          className="button button-secondary"
          aria-pressed={view === 'tree'}
          onClick={() => setView('tree')}
        >
          Hierarchy
        </button>
        <label className="choice">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />{' '}
          Show archived projects
        </label>
      </div>
      <ResourceView resource={data.state} onRetry={data.retry} what="projects">
        {(d) =>
          !d.data.length ? (
            <div className="empty-state">
              <p>{archived ? 'No archived projects.' : 'No projects yet.'}</p>
              {canCreate && !archived ? (
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => setCreating(true)}
                >
                  Create a project
                </button>
              ) : null}
            </div>
          ) : (
            <>
              <p className="hint">
                {d.total?.capped
                  ? 'Showing the first 200 projects'
                  : `${d.data.length} project${d.data.length === 1 ? '' : 's'}`}
                {single ? '' : ' you can access'}
              </p>
              {view === 'tree' ? (
                <ProjectTree ws={ws} items={d.data} onMoved={data.reload} />
              ) : (
                <GroupedList ws={ws} items={d.data} byStatus={single} />
              )}
            </>
          )
        }
      </ResourceView>
      {creating ? (
        <CreateProjectDialog
          ws={ws}
          brands={creatable.map((b) => ({ id: b.id, name: b.name }))}
          fixedBrand={single && scope?.kind === 'brand' ? scope.brand_id : null}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </Page>
  );
}

function GroupedList({
  ws,
  items,
  byStatus,
}: {
  ws: string;
  items: ProjectSummary[];
  byStatus: boolean;
}) {
  const groups = useMemo(() => {
    const out = new Map<
      string,
      { label: string; marker?: ProjectSummary['brand']; rows: ProjectSummary[] }
    >();
    for (const p of items) {
      const key = byStatus ? p.status.key : p.brand.kind === 'brand' ? p.brand.id : 'workspace';
      const g = out.get(key) ?? {
        label: byStatus ? p.status.name : p.brand.kind === 'brand' ? p.brand.name : 'Workspace',
        ...(byStatus ? {} : { marker: p.brand }),
        rows: [],
      };
      g.rows.push(p);
      out.set(key, g);
    }
    if (byStatus) {
      // Group order follows status categories (custom statuses included), then name.
      const order = ['planned', 'active', 'paused', 'done', 'cancelled'];
      const cat = (g: { rows: ProjectSummary[] }) => order.indexOf(g.rows[0]!.status.category);
      return [...out.entries()]
        .sort((a, b) => cat(a[1]) - cat(b[1]) || a[1].label.localeCompare(b[1].label))
        .map(([, g]) => g);
    }
    return [...out.values()];
  }, [items, byStatus]);
  return (
    <>
      {groups.map((g) => (
        <section key={g.label} className="card" aria-label={`${g.label} (${g.rows.length})`}>
          <h2>
            {g.marker ? <BrandMarker marker={g.marker} size={16} /> : null} {g.label} (
            {g.rows.length})
          </h2>
          <ul className="plain-list record-list">
            {g.rows.map((p) => (
              <li key={p.id} className="record-row">
                {!byStatus ? null : <BrandMarker marker={p.brand} size={16} />}
                <Link to={routeHref('project', { ws, prj: p.id })}>{p.name}</Link>
                <StatusBadge status={p.status} />
                {p.health ? <HealthBadge value={p.health} /> : null}
                {p.target_date ? <span className="hint">Target {p.target_date}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

interface TreeNode {
  p: ProjectSummary;
  children: TreeNode[];
  level: number;
}

/**
 * APG tree (A11Y-PA-08, A11Y-KB-05): one tab stop with roving focus; arrows move and expand or
 * collapse; Home/End; type-ahead; Enter opens. Reordering and nesting use visible actions for the
 * focused project (Move up, Move down, Indent, Outdent, Move to…), never drag only.
 */
export function ProjectTree({
  ws,
  items,
  onMoved,
}: {
  ws: string;
  items: ProjectSummary[];
  onMoved: () => void;
}) {
  const { navigate } = useRouter();
  const stepUp = useStepUp();
  const roots = useMemo(() => {
    const byId = new Map(items.map((p) => [p.id, { p, children: [] as TreeNode[], level: 1 }]));
    const top: TreeNode[] = [];
    for (const n of byId.values()) {
      const parent = n.p.parent ? byId.get(n.p.parent) : undefined;
      if (parent) parent.children.push(n);
      else top.push(n);
    }
    const setLevel = (ns: TreeNode[], l: number) =>
      ns.forEach((n) => ((n.level = l), setLevel(n.children, l + 1)));
    setLevel(top, 1);
    return top;
  }, [items]);
  // Collapsed ids, not expanded ones: a project that gains children (Indent, Move to…) shows them.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const isOpen = (id: string) => !collapsed.has(id);
  const [focused, setFocused] = useState<string | null>(roots[0]?.p.id ?? null);
  const [moveTo, setMoveTo] = useState(false);
  const typed = useRef({ text: '', at: 0 });
  const visible: TreeNode[] = [];
  const walk = (ns: TreeNode[]) =>
    ns.forEach((n) => {
      visible.push(n);
      if (isOpen(n.p.id)) walk(n.children);
    });
  walk(roots);
  const current = visible.find((n) => n.p.id === focused) ?? visible[0];
  const refs = useRef(new Map<string, HTMLLIElement>());
  useEffect(() => {
    if (focused && document.activeElement?.closest('[role="tree"]'))
      refs.current.get(focused)?.focus();
  }, [focused]);
  const parentOf = (n: TreeNode) => visible.find((x) => x.children.includes(n)) ?? null;
  const siblings = (n: TreeNode) => parentOf(n)?.children ?? roots;
  const cmd = useCommand(onMoved);
  const move = (
    n: TreeNode,
    body: { parent: string | null; after?: string | null },
    message: string,
  ) =>
    void cmd.run(
      () =>
        projects.verb(
          ws,
          n.p.id,
          'move',
          { parent: body.parent, after: body.after ?? null },
          stepUp,
        ),
      message,
    );
  const onKey = (e: KeyboardEvent) => {
    if (!current) return;
    const i = visible.indexOf(current);
    const go = (n: TreeNode | undefined) => {
      if (n) {
        e.preventDefault();
        setFocused(n.p.id);
      }
    };
    if (e.key === 'ArrowDown') go(visible[i + 1]);
    else if (e.key === 'ArrowUp') go(visible[i - 1]);
    else if (e.key === 'Home') go(visible[0]);
    else if (e.key === 'End') go(visible.at(-1));
    else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (current.children.length && !isOpen(current.p.id))
        setCollapsed(new Set([...collapsed].filter((x) => x !== current.p.id)));
      else go(current.children[0]);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (current.children.length && isOpen(current.p.id))
        setCollapsed(new Set([...collapsed, current.p.id]));
      else go(parentOf(current) ?? undefined);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      navigate(routeHref('project', { ws, prj: current.p.id }));
    } else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = e.timeStamp;
      typed.current.text =
        now - typed.current.at < 700
          ? typed.current.text + e.key.toLowerCase()
          : e.key.toLowerCase();
      typed.current.at = now;
      const order = [...visible.slice(i + 1), ...visible.slice(0, i + 1)];
      go(order.find((n) => n.p.name.toLowerCase().startsWith(typed.current.text)));
    }
  };
  const sib = current ? siblings(current) : [];
  const idx = current ? sib.indexOf(current) : -1;
  const parent = current ? parentOf(current) : null;
  return (
    <>
      <ul role="tree" aria-label="Project hierarchy" className="tree" onKeyDown={onKey}>
        {(() => {
          const render = (ns: TreeNode[]): React.ReactNode =>
            ns.map((n) => (
              <li
                key={n.p.id}
                role="treeitem"
                aria-level={n.level}
                aria-expanded={n.children.length ? isOpen(n.p.id) : undefined}
                aria-selected={n === current}
                tabIndex={n === current ? 0 : -1}
                ref={(el) => {
                  if (el) refs.current.set(n.p.id, el);
                }}
                onFocus={(e) => {
                  if (e.target === e.currentTarget) setFocused(n.p.id);
                }}
                className="tree-item"
              >
                <span className="tree-label">
                  <span aria-hidden="true">
                    {n.children.length ? (isOpen(n.p.id) ? '▾ ' : '▸ ') : '  '}
                  </span>
                  {n.p.name} <StatusBadge status={n.p.status} />
                </span>
                {n.children.length && isOpen(n.p.id) ? (
                  <ul role="group">{render(n.children)}</ul>
                ) : null}
              </li>
            ));
          return render(roots);
        })()}
      </ul>
      {current ? (
        <div className="toolbar" role="group" aria-label={`Actions for ${current.p.name}`}>
          <Link
            to={routeHref('project', { ws, prj: current.p.id })}
            className="button button-secondary"
          >
            Open {current.p.name}
          </Link>
          <button
            type="button"
            className="button button-secondary"
            disabled={idx <= 0 || cmd.busy}
            onClick={() =>
              move(
                current,
                { parent: parent?.p.id ?? null, after: idx >= 2 ? sib[idx - 2]!.p.id : null },
                `${current.p.name} moved up.`,
              )
            }
          >
            Move up
          </button>
          <button
            type="button"
            className="button button-secondary"
            disabled={idx < 0 || idx >= sib.length - 1 || cmd.busy}
            onClick={() =>
              move(
                current,
                { parent: parent?.p.id ?? null, after: sib[idx + 1]!.p.id },
                `${current.p.name} moved down.`,
              )
            }
          >
            Move down
          </button>
          <button
            type="button"
            className="button button-secondary"
            disabled={idx <= 0 || cmd.busy}
            onClick={() =>
              move(
                current,
                { parent: sib[idx - 1]!.p.id },
                `${current.p.name} indented under ${sib[idx - 1]!.p.name}.`,
              )
            }
          >
            Indent
          </button>
          <button
            type="button"
            className="button button-secondary"
            disabled={!parent || cmd.busy}
            onClick={() =>
              move(
                current,
                { parent: parentOf(parent!)?.p.id ?? null, after: parent!.p.id },
                `${current.p.name} outdented.`,
              )
            }
          >
            Outdent
          </button>
          <button type="button" className="button button-secondary" onClick={() => setMoveTo(true)}>
            Move to…
          </button>
        </div>
      ) : null}
      {cmd.error ? <ProblemBanner error={cmd.error} /> : null}
      <Announce>{cmd.said}</Announce>
      {moveTo && current ? (
        <MoveToDialog
          items={items.filter(
            (i) =>
              i.id !== current.p.id &&
              i.brand.kind === current.p.brand.kind &&
              (i.brand as { id?: string }).id === (current.p.brand as { id?: string }).id,
          )}
          name={current.p.name}
          onClose={() => setMoveTo(false)}
          onPick={(target) => {
            setMoveTo(false);
            move(
              current,
              { parent: target },
              target ? `${current.p.name} moved.` : `${current.p.name} moved to the top level.`,
            );
          }}
        />
      ) : null}
    </>
  );
}

function MoveToDialog({
  items,
  name,
  onClose,
  onPick,
}: {
  items: ProjectSummary[];
  name: string;
  onClose: () => void;
  onPick: (id: string | null) => void;
}) {
  const [target, setTarget] = useState('');
  return (
    <Dialog title={`Move ${name}`} onClose={onClose}>
      <SelectField
        id="move-target"
        label="New parent"
        value={target}
        onChange={setTarget}
        options={[
          { value: '', label: 'Top level of the brand' },
          ...items.map((i) => ({ value: i.id, label: i.name })),
        ]}
      />
      <p className="actions">
        <button
          type="button"
          className="button button-primary"
          onClick={() => onPick(target || null)}
        >
          Move
        </button>
        <button type="button" className="button button-secondary" onClick={onClose}>
          Cancel
        </button>
      </p>
    </Dialog>
  );
}

function CreateProjectDialog({
  ws,
  brands,
  fixedBrand,
  onClose,
}: {
  ws: string;
  /** Brands where the person may create records (explicit choice in aggregate scope). */
  brands: Array<{ id: string; name: string }>;
  fixedBrand: string | null;
  onClose: () => void;
}) {
  const { navigate } = useRouter();
  const stepUp = useStepUp();
  const templates = useResource(() => projects.templates(ws), `templates:${ws}`);
  const [name, setName] = useState('');
  const [brand, setBrand] = useState(fixedBrand ?? '');
  const [template, setTemplate] = useState('');
  const [start, setStart] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const fields = fieldErrorsFrom(error, {
    '/name': 'project-name',
    '/brand': 'project-brand',
    '/template': 'project-template',
    '/start_date': 'project-start',
  });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setAttempt((a) => a + 1);
    setError(null);
    try {
      const p = await projects.create(
        ws,
        {
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(brand ? { brand } : {}),
          ...(template ? { template } : {}),
          ...(start ? { start_date: start } : {}),
        },
        stepUp,
      );
      onClose();
      navigate(routeHref('project', { ws, prj: p.id }));
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled')) setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Create project" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <ErrorSummary
          errors={fields}
          labels={{
            'project-name': 'Project name',
            'project-brand': 'Brand',
            'project-template': 'Template',
            'project-start': 'Start date',
          }}
          focusKey={attempt}
        />
        <Field
          id="project-name"
          label="Project name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={fields['project-name']}
          maxLength={200}
        />
        {fixedBrand ? null : (
          <SelectField
            id="project-brand"
            label="Brand"
            hint="Choose which brand owns this project."
            required
            value={brand}
            onChange={setBrand}
            error={fields['project-brand']}
            options={[
              { value: '', label: 'Choose a brand' },
              ...brands.map((b) => ({ value: b.id, label: b.name })),
            ]}
          />
        )}
        {templates.state.status === 'ready' && templates.state.data.length ? (
          <SelectField
            id="project-template"
            label="Start from a template"
            value={template}
            onChange={setTemplate}
            error={fields['project-template']}
            options={[
              { value: '', label: 'No template' },
              ...templates.state.data.map((t) => ({ value: t.id, label: t.name })),
            ]}
          />
        ) : null}
        <Field
          id="project-start"
          label="Start date"
          type="date"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          error={fields['project-start']}
        />
        {error && !Object.keys(fields).length ? <ProblemBanner error={error} /> : null}
        <p className="actions">
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create project'}
          </button>
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
        </p>
      </form>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------------------------
// The project record page
// -----------------------------------------------------------------------------------------------

const SECTION_BY_KEY = new Map(PROJECT_SECTIONS.map((s) => [s.key, s]));

export function ProjectPage({
  ws,
  prj,
  section = 'overview',
}: {
  ws: string;
  prj: string;
  section?: string;
}) {
  const shellState = useWorkspaceShell();
  const data = useResource(() => projects.overview(ws, prj), `project:${ws}:${prj}`);
  const loaded = data.state.status === 'ready' ? data.state.data.project : null;
  useRecordVisit(loaded && loaded.lifecycle_state === 'active' ? loaded.id : null);
  const enter = shellState?.enterRecordBrand;
  useEffect(() => {
    if (loaded && loaded.brand.kind === 'brand') enter?.(loaded.brand.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded?.id, shellState?.context !== null]);
  const def = SECTION_BY_KEY.get(section as ProjectSectionKey);
  const sectionLabel = def?.label ?? 'Overview';
  return (
    <Page
      title={loaded ? loaded.name : 'Project'}
      wide
      section="Projects"
      record={loaded ? { title: loaded.name } : null}
      breadcrumbs={
        loaded
          ? [
              { label: 'Projects', to: routeHref('projects', { ws }) },
              ...loaded.ancestors.map((a) => ({
                label: a.name,
                to: routeHref('project', { ws, prj: a.id }),
              })),
              { label: loaded.name, ...(loaded.brand.kind === 'brand' ? {} : {}) },
              ...(section !== 'overview' ? [{ label: sectionLabel }] : []),
            ]
          : undefined
      }
      actions={
        loaded && loaded.lifecycle_state === 'active' ? (
          <FavoriteToggle target={loaded.id} label={loaded.name} />
        ) : null
      }
    >
      <ResourceView resource={data.state} onRetry={data.retry} what="project">
        {(o) => (
          <>
            <ProjectHeader project={o.project} />
            <SectionNav ws={ws} prj={prj} current={section} />
            {!def ? (
              <SectionUnavailable label="This section" phase={null} />
            ) : section === 'documents' ? (
              <>
                <DocumentsSection
                  ws={ws}
                  project={o.project.id}
                  noun="project"
                  canCreate={o.project.lifecycle_state === 'active'}
                  headingId="project-docs-h"
                />
                <MentionedInDocuments ws={ws} rec={o.project.id} headingId="project-mentioned-h" />
              </>
            ) : section === 'reports' ? (
              <ProjectReports
                ws={ws}
                project={o.project.id}
                canCreate={o.project.lifecycle_state === 'active'}
              />
            ) : def.phase !== null ? (
              <SectionUnavailable label={def.label} phase={def.phase} />
            ) : section === 'overview' ? (
              <OverviewSection ws={ws} o={o} reload={data.reload} />
            ) : section === 'timeline' ? (
              <TimelineSection ws={ws} o={o} reload={data.reload} />
            ) : section === 'files' ? (
              <>
                <DeliverablesSummary ws={ws} prj={prj} />
                <FilesPanel ws={ws} host={o.project.id} noun="on this project" />
              </>
            ) : section === 'tasks' ? (
              <ProjectTasksSection ws={ws} project={o.project} />
            ) : section === 'time' ? (
              <WorkTimePanel
                ws={ws}
                target={o.project.id}
                canLog={!!o.project.capabilities.log_time}
                version={o.project.version}
              />
            ) : (
              <SettingsSection ws={ws} o={o} reload={data.reload} />
            )}
          </>
        )}
      </ResourceView>
    </Page>
  );
}

function ProjectHeader({ project }: { project: Project }) {
  return (
    <div className="record-header">
      <p className="record-meta">
        <BrandMarker marker={project.brand} size={20} /> <StatusBadge status={project.status} />{' '}
        <HealthBadge value={project.health?.value ?? null} />
        {project.access_mode === 'restricted' ? <span className="badge">Restricted</span> : null}
      </p>
      {project.lifecycle_state === 'archived' ? (
        <Banner tone="info" title="This project is archived">
          It is read-only. Restore it from Settings to make changes.
        </Banner>
      ) : null}
    </div>
  );
}

/** Section navigation: links with aria-current (A11Y-PA-03), fixed order, conditional tabs absent. */
export function SectionNav({ ws, prj, current }: { ws: string; prj: string; current: string }) {
  return (
    <nav aria-label="Project sections" className="section-nav">
      <ul className="tabs">
        {PROJECT_SECTIONS.filter((s) => !s.conditional).map((s) => (
          <li key={s.key}>
            <Link
              to={
                s.key === 'overview'
                  ? routeHref('project', { ws, prj })
                  : routeHref('project_section', { ws, prj, section: s.key })
              }
              aria-current={current === s.key ? 'page' : undefined}
            >
              {s.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function SectionUnavailable({ label, phase }: { label: string; phase: string | null }) {
  return (
    <section className="card" aria-labelledby="section-unavailable">
      <h2 id="section-unavailable">{label} isn't available yet</h2>
      <p>
        {label} arrives in a later release{phase ? '' : ''}. Nothing is missing from this project —
        there is simply nothing to show here yet.
      </p>
    </section>
  );
}

function OverviewSection({ ws, o, reload }: { ws: string; o: Overview; reload: () => void }) {
  const p = o.project;
  const stepUp = useStepUp();
  // 5B: goals are for members; a guest's project page has no Goals card.
  const isMember = useWorkspaceShell()?.access?.principal === 'member';
  const cmd = useCommand(reload);
  // Criteria and scope entries are intrinsic facts (a share may edit them); updates and decisions
  // need the caller's own authority (ADR-0013 P5).
  const editable = p.capabilities.edit;
  const structural = p.capabilities.edit_structure;
  const [criterion, setCriterion] = useState('');
  const [scopeText, setScopeText] = useState('');
  const [scopeKind, setScopeKind] = useState<string>('scope');
  const [update, setUpdate] = useState('');
  const [statement, setStatement] = useState('');
  const [kind, setKind] = useState<'decision' | 'open_question'>('decision');
  return (
    <>
      {p.capabilities.edit ? (
        <TransitionControl ws={ws} rec={p.id} version={p.version} onChanged={reload} />
      ) : null}
      <section className="card" aria-labelledby="ov-summary">
        <h2 id="ov-summary">Summary</h2>
        <dl className="facts">
          <dt>Status</dt>
          <dd>
            <StatusBadge status={p.status} />
          </dd>
          <dt>Priority</dt>
          <dd>{PRIORITY_LABEL[p.priority] ?? p.priority}</dd>
          <dt>Owner</dt>
          <dd>{p.owner ? p.owner.name : 'Not shown'}</dd>
          <dt>Dates</dt>
          <dd>
            {p.start_date ?? 'No start date'} → {p.target_date ?? 'no target date'}
            {p.deadline_date ? ` (deadline ${p.deadline_date})` : ''}
          </dd>
          <dt>Completion</dt>
          <dd>
            {p.completion.percent}%{' '}
            <span className="hint">
              {p.completion.basis === 'leaf_tasks'
                ? 'Of the tasks you can see'
                : 'Status-based until tasks are added'}
            </span>
          </dd>
          {p.budget ? (
            <>
              <dt>Budget</dt>
              <dd>
                {p.budget.amount} {p.budget.currency}
              </dd>
            </>
          ) : null}
        </dl>
        {p.description ? (
          <div className="description">
            {plainFromRichText(p.description)
              .split('\n')
              .map((line, i) => (
                <p key={i}>{line}</p>
              ))}
          </div>
        ) : null}
        {o.task_facts.available ? (
          <p aria-label="Task facts">
            {o.task_facts.total} {o.task_facts.total === 1 ? 'task' : 'tasks'} ·{' '}
            {o.task_facts.overdue} overdue · {o.task_facts.blocked} blocked ·{' '}
            {o.task_facts.unassigned} unassigned
          </p>
        ) : (
          <p className="hint">Task facts aren't shown for projects shared with you.</p>
        )}
      </section>

      <section className="card" aria-labelledby="ov-update">
        <h2 id="ov-update">Latest verified update</h2>
        {o.latest_verified_update ? (
          <blockquote>
            <p>{o.latest_verified_update.body}</p>
            {o.latest_verified_update.verified_at ? (
              <footer className="hint">
                Verified {new Date(o.latest_verified_update.verified_at).toLocaleDateString()}
              </footer>
            ) : null}
          </blockquote>
        ) : (
          <p>No update has been verified yet.</p>
        )}
        {o.updates.length ? (
          <ul aria-label="Recent updates" className="plain-list">
            {o.updates.map((u) => (
              <li key={u.id}>
                {u.body} <span className="hint">{u.verified ? 'Verified' : 'Not verified'}</span>
                {!u.verified && p.capabilities.verify_update ? (
                  <button
                    type="button"
                    className="button button-ghost"
                    disabled={cmd.busy}
                    onClick={() =>
                      void cmd.run(
                        () => projects.childVerb(ws, p.id, 'updates', u.id, 'verify', {}, stepUp),
                        'Update verified.',
                      )
                    }
                  >
                    Verify<span className="visually-hidden"> this update</span>
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {structural ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void cmd
                .run(
                  () => projects.child(ws, p.id, 'updates', { body: update }, stepUp),
                  'Update posted.',
                )
                .then((ok) => ok && setUpdate(''));
            }}
          >
            <TextAreaField
              id="new-update"
              label="Post an update"
              value={update}
              onChange={setUpdate}
              maxLength={10000}
            />
            <button
              type="submit"
              className="button button-secondary"
              disabled={!update.trim() || cmd.busy}
            >
              Post update
            </button>
          </form>
        ) : null}
      </section>

      <section className="card" aria-labelledby="ov-criteria">
        <h2 id="ov-criteria">Success criteria and definition of done</h2>
        {o.criteria.length ? (
          <ul className="plain-list">
            {o.criteria.map((c) => (
              <li key={c.id}>
                <label className="choice">
                  <input
                    type="checkbox"
                    checked={c.met}
                    disabled={!editable || cmd.busy}
                    onChange={(e) =>
                      void cmd.run(
                        () =>
                          projects.patchChild(
                            ws,
                            p.id,
                            'criteria',
                            c.id,
                            { met: e.target.checked },
                            stepUp,
                            c.version,
                          ),
                        e.target.checked ? 'Marked as met.' : 'Marked as not met.',
                      )
                    }
                  />
                  {c.text}{' '}
                  <span className="hint">
                    {c.kind === 'success' ? 'Success criterion' : 'Definition of done'}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p>No criteria yet.</p>
        )}
        {editable ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void cmd
                .run(
                  () =>
                    projects.child(
                      ws,
                      p.id,
                      'criteria',
                      { kind: 'success', text: criterion },
                      stepUp,
                    ),
                  'Criterion added.',
                )
                .then((ok) => ok && setCriterion(''));
            }}
          >
            <Field
              id="new-criterion"
              label="Add a success criterion"
              value={criterion}
              onChange={(e) => setCriterion(e.target.value)}
              maxLength={500}
            />
            <button
              type="submit"
              className="button button-secondary"
              disabled={!criterion.trim() || cmd.busy}
            >
              Add criterion
            </button>
          </form>
        ) : null}
      </section>

      <section className="card" aria-labelledby="ov-scope">
        <h2 id="ov-scope">Scope, risks, assumptions, and constraints</h2>
        {SCOPE_ITEM_KINDS.map((k) => {
          const rows = o.scope_items.filter((s) => s.kind === k);
          return rows.length ? (
            <div key={k}>
              <h3>{SCOPE_LABEL[k]}</h3>
              <ul>
                {rows.map((s) => (
                  <li key={s.id}>{s.text}</li>
                ))}
              </ul>
            </div>
          ) : null;
        })}
        {!o.scope_items.length ? <p>Nothing recorded yet.</p> : null}
        {editable ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void cmd
                .run(
                  () =>
                    projects.child(
                      ws,
                      p.id,
                      'scope-items',
                      { kind: scopeKind, text: scopeText },
                      stepUp,
                    ),
                  'Entry added.',
                )
                .then((ok) => ok && setScopeText(''));
            }}
          >
            <SelectField
              id="new-scope-kind"
              label="Kind"
              value={scopeKind}
              onChange={setScopeKind}
              options={SCOPE_ITEM_KINDS.map((k) => ({ value: k, label: SCOPE_LABEL[k]! }))}
            />
            <Field
              id="new-scope-text"
              label="Entry"
              value={scopeText}
              onChange={(e) => setScopeText(e.target.value)}
              maxLength={1000}
            />
            <button
              type="submit"
              className="button button-secondary"
              disabled={!scopeText.trim() || cmd.busy}
            >
              Add entry
            </button>
          </form>
        ) : null}
      </section>

      <section className="card" aria-labelledby="ov-decisions">
        <h2 id="ov-decisions">Decisions and open questions</h2>
        {o.decisions.length ? (
          <ul className="plain-list">
            {o.decisions.map((d) => (
              <li key={d.id}>
                <strong>{d.kind === 'decision' ? 'Decision' : 'Question'}:</strong> {d.statement}{' '}
                <span className="badge">{d.state}</span>
                {d.outcome ? <p className="hint">{d.outcome}</p> : null}
                {structural &&
                ((d.kind === 'decision' && d.state === 'proposed') ||
                  (d.kind === 'open_question' && d.state === 'open')) ? (
                  <ResolveDecision ws={ws} prj={p.id} d={d} onDone={reload} />
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p>No decisions or open questions yet.</p>
        )}
        {structural ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void cmd
                .run(
                  () => projects.child(ws, p.id, 'decisions', { kind, statement }, stepUp),
                  'Added.',
                )
                .then((ok) => ok && setStatement(''));
            }}
          >
            <SelectField
              id="new-decision-kind"
              label="Type"
              value={kind}
              onChange={(v) => setKind(v as 'decision' | 'open_question')}
              options={[
                { value: 'decision', label: 'Decision' },
                { value: 'open_question', label: 'Open question' },
              ]}
            />
            <Field
              id="new-decision"
              label="Statement"
              value={statement}
              onChange={(e) => setStatement(e.target.value)}
              maxLength={2000}
            />
            <button
              type="submit"
              className="button button-secondary"
              disabled={!statement.trim() || cmd.busy}
            >
              Add
            </button>
          </form>
        ) : null}
      </section>

      <DeliverablesSummary ws={ws} prj={p.id} />
      <section className="card" aria-labelledby="ov-deps">
        <h2 id="ov-deps">Dependencies</h2>
        <DependencyList o={o} ws={ws} />
      </section>

      {isMember && p.lifecycle_state !== 'trashed' ? (
        <ProjectGoalsCard
          ws={ws}
          project={{ id: p.id, name: p.name, brand: p.brand }}
          canEdit={p.capabilities.edit && p.lifecycle_state === 'active'}
        />
      ) : null}

      {o.children.length ? (
        <section className="card" aria-labelledby="ov-children">
          <h2 id="ov-children">Sub-projects</h2>
          <ul>
            {o.children.map((c) => (
              <li key={c.id}>
                <Link to={routeHref('project', { ws, prj: c.id })}>{c.name}</Link>{' '}
                <StatusBadge status={c.status} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {p.lifecycle_state !== 'trashed' ? (
        <CollaborationSections
          ws={ws}
          rec={p.id}
          kind="project"
          version={p.version}
          archived={p.lifecycle_state === 'archived'}
          sharedOnly={!o.task_facts.available}
          onRecordChanged={reload}
        />
      ) : null}
      {cmd.error ? <ProblemBanner error={cmd.error} /> : null}
      <Announce>{cmd.said}</Announce>
    </>
  );
}

function ResolveDecision({
  ws,
  prj,
  d,
  onDone,
}: {
  ws: string;
  prj: string;
  d: Overview['decisions'][number];
  onDone: () => void;
}) {
  const stepUp = useStepUp();
  const [outcome, setOutcome] = useState('');
  const cmd = useCommand(onDone);
  const next = d.kind === 'decision' ? 'decided' : 'resolved';
  void DECISION_STATES;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void cmd.run(
          () =>
            projects.patchChild(
              ws,
              prj,
              'decisions',
              d.id,
              { state: next, outcome },
              stepUp,
              d.version,
            ),
          d.kind === 'decision' ? 'Decision recorded.' : 'Question resolved.',
        );
      }}
    >
      <Field
        id={`outcome-${d.id}`}
        label={d.kind === 'decision' ? 'Decision' : 'Answer'}
        value={outcome}
        onChange={(e) => setOutcome(e.target.value)}
        maxLength={4000}
      />
      <button
        type="submit"
        className="button button-secondary"
        disabled={!outcome.trim() || cmd.busy}
      >
        {d.kind === 'decision' ? 'Record decision' : 'Resolve'}
      </button>
      {cmd.error ? <ProblemBanner error={cmd.error} /> : null}
    </form>
  );
}

function DependencyList({ o, ws }: { o: Overview; ws: string }) {
  const none = !o.dependencies.blocked_by.length && !o.dependencies.blocks.length;
  if (none) return <p>No dependencies you can see.</p>;
  const row = (d: Overview['dependencies']['blocks'][number]) => (
    <li key={d.id}>
      <BrandMarker marker={d.brand} size={16} />{' '}
      <Link to={routeHref('project', { ws, prj: d.id })}>{d.name}</Link>{' '}
      <StatusBadge status={d.status} />
    </li>
  );
  return (
    <>
      {o.dependencies.blocked_by.length ? (
        <>
          <h3>Waiting on</h3>
          <ul className="plain-list">{o.dependencies.blocked_by.map(row)}</ul>
        </>
      ) : null}
      {o.dependencies.blocks.length ? (
        <>
          <h3>Blocks</h3>
          <ul className="plain-list">{o.dependencies.blocks.map(row)}</ul>
        </>
      ) : null}
    </>
  );
}

function TimelineSection({ ws, o, reload }: { ws: string; o: Overview; reload: () => void }) {
  const p = o.project;
  const stepUp = useStepUp();
  const cmd = useCommand(reload);
  const editable = p.capabilities.edit_structure;
  const [phase, setPhase] = useState('');
  const [milestone, setMilestone] = useState('');
  const [due, setDue] = useState('');
  const [target, setTarget] = useState('');
  const candidates = useResource(
    () => projects.list(ws),
    editable && p.capabilities.relate ? `projects:${ws}:deps` : 'wait',
  );
  const phases = o.phases.filter((x) => x.lifecycle_state === 'active');
  const archivedPhases = o.phases.filter((x) => x.lifecycle_state === 'archived');
  return (
    <>
      <section className="card" aria-labelledby="tl-phases">
        <h2 id="tl-phases">Phases</h2>
        {phases.length ? (
          <ol>
            {phases.map((ph, i) => (
              <li key={ph.id}>
                {ph.name}{' '}
                <span className="hint">
                  {ph.start_date ?? ''}
                  {ph.end_date ? ` → ${ph.end_date}` : ''} · {ph.status}
                </span>
                {editable ? (
                  <span className="actions-compact">
                    <button
                      type="button"
                      className="button button-ghost"
                      disabled={i === 0 || cmd.busy}
                      onClick={() =>
                        void cmd.run(
                          () =>
                            projects.childVerb(
                              ws,
                              p.id,
                              'phases',
                              ph.id,
                              'move',
                              { after: i >= 2 ? phases[i - 2]!.id : null },
                              stepUp,
                            ),
                          `${ph.name} moved up.`,
                        )
                      }
                    >
                      Move up<span className="visually-hidden"> {ph.name}</span>
                    </button>
                    <button
                      type="button"
                      className="button button-ghost"
                      disabled={i === phases.length - 1 || cmd.busy}
                      onClick={() =>
                        void cmd.run(
                          () =>
                            projects.childVerb(
                              ws,
                              p.id,
                              'phases',
                              ph.id,
                              'move',
                              { after: phases[i + 1]!.id },
                              stepUp,
                            ),
                          `${ph.name} moved down.`,
                        )
                      }
                    >
                      Move down<span className="visually-hidden"> {ph.name}</span>
                    </button>
                    <button
                      type="button"
                      className="button button-ghost"
                      disabled={cmd.busy}
                      onClick={() =>
                        void cmd.run(
                          () =>
                            projects.childVerb(ws, p.id, 'phases', ph.id, 'archive', {}, stepUp),
                          `${ph.name} archived.`,
                        )
                      }
                    >
                      Archive<span className="visually-hidden"> {ph.name}</span>
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p>No phases yet.</p>
        )}
        {archivedPhases.length ? (
          <>
            <h3>Archived phases</h3>
            <ul>
              {archivedPhases.map((ph) => (
                <li key={ph.id}>
                  {ph.name}{' '}
                  {editable ? (
                    <button
                      type="button"
                      className="button button-ghost"
                      disabled={cmd.busy}
                      onClick={() =>
                        void cmd.run(
                          () =>
                            projects.childVerb(ws, p.id, 'phases', ph.id, 'unarchive', {}, stepUp),
                          `${ph.name} restored.`,
                        )
                      }
                    >
                      Restore<span className="visually-hidden"> {ph.name}</span>
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {editable ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void cmd
                .run(
                  () => projects.child(ws, p.id, 'phases', { name: phase }, stepUp),
                  'Phase added.',
                )
                .then((ok) => ok && setPhase(''));
            }}
          >
            <Field
              id="new-phase"
              label="Add a phase"
              value={phase}
              onChange={(e) => setPhase(e.target.value)}
              maxLength={120}
            />
            <button
              type="submit"
              className="button button-secondary"
              disabled={!phase.trim() || cmd.busy}
            >
              Add phase
            </button>
          </form>
        ) : null}
      </section>
      <section className="card" aria-labelledby="tl-milestones">
        <h2 id="tl-milestones">Milestones</h2>
        {o.milestones.filter((m) => m.lifecycle_state === 'active').length ? (
          <ul>
            {o.milestones
              .filter((m) => m.lifecycle_state === 'active')
              .map((m) => (
                <li key={m.id}>
                  {m.name}{' '}
                  <span className="hint">
                    {m.due_date ? `Due ${m.due_date}` : 'No due date'} · {m.status}
                  </span>
                  {editable && m.status === 'planned' ? (
                    <button
                      type="button"
                      className="button button-ghost"
                      disabled={cmd.busy}
                      onClick={() =>
                        void cmd.run(
                          () =>
                            projects.patchChild(
                              ws,
                              p.id,
                              'milestones',
                              m.id,
                              { status: 'reached' },
                              stepUp,
                              m.version,
                            ),
                          `${m.name} reached.`,
                        )
                      }
                    >
                      Mark reached<span className="visually-hidden"> {m.name}</span>
                    </button>
                  ) : null}
                </li>
              ))}
          </ul>
        ) : (
          <p>No milestones yet.</p>
        )}
        {editable ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void cmd
                .run(
                  () =>
                    projects.child(
                      ws,
                      p.id,
                      'milestones',
                      { name: milestone, ...(due ? { due_date: due } : {}) },
                      stepUp,
                    ),
                  'Milestone added.',
                )
                .then((ok) => ok && (setMilestone(''), setDue('')));
            }}
          >
            <Field
              id="new-milestone"
              label="Add a milestone"
              value={milestone}
              onChange={(e) => setMilestone(e.target.value)}
              maxLength={120}
            />
            <Field
              id="new-milestone-due"
              label="Due date"
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
            <button
              type="submit"
              className="button button-secondary"
              disabled={!milestone.trim() || cmd.busy}
            >
              Add milestone
            </button>
          </form>
        ) : null}
      </section>
      <section className="card" aria-labelledby="tl-deps">
        <h2 id="tl-deps">Dependencies</h2>
        <DependencyList o={o} ws={ws} />
        {editable && p.capabilities.relate && candidates.state.status === 'ready' ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void cmd
                .run(
                  () => projects.child(ws, p.id, 'dependencies', { target }, stepUp),
                  'Dependency added.',
                )
                .then((ok) => ok && setTarget(''));
            }}
          >
            <SelectField
              id="new-dependency"
              label="This project waits on"
              value={target}
              onChange={setTarget}
              options={[
                { value: '', label: 'Choose a project' },
                ...candidates.state.data.data
                  .filter((x) => x.id !== p.id)
                  .map((x) => ({ value: x.id, label: x.name })),
              ]}
            />
            <button
              type="submit"
              className="button button-secondary"
              disabled={!target || cmd.busy}
            >
              Add dependency
            </button>
          </form>
        ) : null}
        {editable && p.capabilities.relate && o.dependencies.blocked_by.length ? (
          <ul aria-label="Remove dependencies" className="plain-list">
            {o.dependencies.blocked_by.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  className="button button-ghost"
                  disabled={cmd.busy}
                  onClick={() =>
                    void cmd.run(
                      () => projects.deleteChild(ws, p.id, 'dependencies', d.id, stepUp),
                      'Dependency removed.',
                    )
                  }
                >
                  Stop waiting on {d.name}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      {cmd.error ? <ProblemBanner error={cmd.error} /> : null}
      <Announce>{cmd.said}</Announce>
    </>
  );
}

function SettingsSection({ ws, o, reload }: { ws: string; o: Overview; reload: () => void }) {
  const p = o.project;
  const stepUp = useStepUp();
  const { navigate } = useRouter();
  const cmd = useCommand(reload);
  const people = useResource(
    () => collab.people(ws).catch(() => [] as Member[]),
    p.capabilities.manage_access || p.capabilities.share ? `people:${ws}` : 'wait',
  );
  const [grant, setGrant] = useState({ principal: '', level: 'view' });
  const [share, setShare] = useState({ grantee: '', level: 'view' });
  const [owner, setOwner] = useState('');
  const [templateName, setTemplateName] = useState(`${p.name} template`);
  const [review, setReview] = useState<null | 'grant' | 'share'>(null);
  const [confirm, setConfirm] = useState<null | 'trash' | 'restrict'>(null);
  const internal = (people.state.status === 'ready' ? people.state.data : []).filter(
    (m) => m.state === 'active',
  );
  return (
    <>
      {p.capabilities.edit ? <ProjectIdentityForm ws={ws} project={p} onSaved={reload} /> : null}
      {p.capabilities.edit ? <RecordFieldsSection ws={ws} rec={p.id} onSaved={reload} /> : null}
      <ScopeDefaultsEditor ws={ws} kind="projects" id={p.id} name={p.name} />
      <section className="card" aria-labelledby="st-config">
        <h2 id="st-config">Workflows and fields for this project</h2>
        <p>
          <Link
            to={`${routeHref('workflows', { ws })}?scope=${encodeURIComponent(`project:${p.id}`)}`}
          >
            Workflows
          </Link>
          {' · '}
          <Link
            to={`${routeHref('fields', { ws })}?scope=${encodeURIComponent(`project:${p.id}`)}`}
          >
            Custom fields
          </Link>
          {' · '}
          <Link
            to={`${routeHref('field_sets', { ws })}?scope=${encodeURIComponent(`project:${p.id}`)}`}
          >
            Field sets
          </Link>
        </p>
      </section>

      {p.capabilities.manage_access ? (
        <section className="card" aria-labelledby="st-access">
          <h2 id="st-access">Access</h2>
          <p>
            {p.access_mode === 'restricted'
              ? 'Restricted: only people with explicit project access can see it.'
              : 'Everyone with access to the brand can see this project.'}
          </p>
          {p.capabilities.restrict ? (
            <p className="actions">
              {p.access_mode === 'restricted' ? (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={cmd.busy}
                  onClick={() =>
                    void cmd.run(
                      () =>
                        projects.verb(
                          ws,
                          p.id,
                          'access',
                          { access_mode: 'inherit' },
                          stepUp,
                          p.version,
                        ),
                      'Project opened to its brand.',
                    )
                  }
                >
                  Open to the brand
                </button>
              ) : (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setConfirm('restrict')}
                >
                  Restrict…
                </button>
              )}
              {p.access_mode === 'restricted' ? (
                <label className="choice">
                  <input
                    type="checkbox"
                    checked={p.allow_record_shares}
                    disabled={cmd.busy}
                    onChange={(e) =>
                      void cmd.run(
                        () =>
                          projects.verb(
                            ws,
                            p.id,
                            'access',
                            { allow_record_shares: e.target.checked },
                            stepUp,
                            p.version,
                          ),
                        'Sharing setting saved.',
                      )
                    }
                  />
                  Allow sharing this project with individual people
                </label>
              ) : null}
            </p>
          ) : null}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (grant.principal) setReview('grant');
            }}
          >
            <SelectField
              id="st-grant-person"
              label="Give project access to"
              value={grant.principal}
              onChange={(v) => setGrant({ ...grant, principal: v })}
              options={[
                { value: '', label: 'Choose a person' },
                ...internal
                  .filter((m) => m.kind === 'member')
                  .map((m) => ({ value: m.id, label: m.display_name })),
              ]}
            />
            <SelectField
              id="st-grant-level"
              label="Access level"
              value={grant.level}
              onChange={(v) => setGrant({ ...grant, level: v })}
              options={LEVEL_OPTIONS}
            />
            <button type="submit" className="button button-secondary" disabled={!grant.principal}>
              Review access…
            </button>
          </form>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (owner)
                void cmd.run(
                  () => projects.verb(ws, p.id, 'owner', { owner }, stepUp, p.version),
                  'Owner changed.',
                );
            }}
          >
            <SelectField
              id="st-owner"
              label="Accountable owner"
              value={owner}
              onChange={setOwner}
              options={[
                { value: '', label: p.owner ? `Keep ${p.owner.name}` : 'Choose a person' },
                ...internal
                  .filter((m) => m.kind === 'member')
                  .map((m) => ({ value: m.id, label: m.display_name })),
              ]}
            />
            <button type="submit" className="button button-secondary" disabled={!owner || cmd.busy}>
              Change owner
            </button>
          </form>
        </section>
      ) : null}

      {p.capabilities.share ? (
        <section className="card" aria-labelledby="st-share">
          <h2 id="st-share">Share this project</h2>
          <p className="hint">
            Sharing gives one person this project only. Its phases, milestones, sub-projects, and
            dependencies are never included.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (share.grantee) setReview('share');
            }}
          >
            <SelectField
              id="st-share-person"
              label="Share with"
              value={share.grantee}
              onChange={(v) => setShare({ ...share, grantee: v })}
              options={[
                { value: '', label: 'Choose a person' },
                ...internal.map((m) => ({ value: m.id, label: m.display_name })),
              ]}
            />
            <SelectField
              id="st-share-level"
              label="They can"
              value={share.level}
              onChange={(v) => setShare({ ...share, level: v })}
              options={[
                { value: 'view', label: 'View' },
                { value: 'comment', label: 'Comment' },
                { value: 'edit', label: 'Edit' },
              ]}
            />
            <button type="submit" className="button button-secondary" disabled={!share.grantee}>
              Review sharing…
            </button>
          </form>
        </section>
      ) : null}

      {p.capabilities.save_template || p.capabilities.create_child ? (
        <section className="card" aria-labelledby="st-templates">
          <h2 id="st-templates">Templates and copies</h2>
          <p className="hint">
            Templates and copies keep phases, milestones, criteria, and scope entries. People,
            sharing, updates, decisions, dependencies, and history are never copied.
          </p>
          {p.capabilities.save_template ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void cmd.run(
                  () => projects.verb(ws, p.id, 'template', { name: templateName }, stepUp),
                  'Template saved.',
                );
              }}
            >
              <Field
                id="st-template-name"
                label="Template name"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                maxLength={200}
              />
              <button
                type="submit"
                className="button button-secondary"
                disabled={!templateName.trim() || cmd.busy}
              >
                Save as template
              </button>
            </form>
          ) : null}
          <button
            type="button"
            className="button button-secondary"
            disabled={cmd.busy}
            onClick={() =>
              void cmd.run(async () => {
                const d = await projects.verb<{ project: { id: string } }>(
                  ws,
                  p.id,
                  'duplicate',
                  {},
                  stepUp,
                );
                navigate(routeHref('project', { ws, prj: d.project.id }));
              }, 'Project duplicated.')
            }
          >
            Duplicate project
          </button>
        </section>
      ) : null}

      {p.capabilities.manage_recurrence ? <RecurrenceSection ws={ws} project={p} /> : null}

      <section className="card" aria-labelledby="st-lifecycle">
        <h2 id="st-lifecycle">Archive and delete</h2>
        <p className="actions">
          {p.capabilities.archive ? (
            <button
              type="button"
              className="button button-secondary"
              disabled={cmd.busy}
              onClick={() =>
                void cmd.run(
                  () => projects.verb(ws, p.id, 'archive', {}, stepUp, p.version),
                  'Project archived.',
                )
              }
            >
              Archive project
            </button>
          ) : null}
          {p.capabilities.restore ? (
            <button
              type="button"
              className="button button-secondary"
              disabled={cmd.busy}
              onClick={() =>
                void cmd.run(
                  () => projects.verb(ws, p.id, 'unarchive', {}, stepUp, p.version),
                  'Project restored.',
                )
              }
            >
              Restore project
            </button>
          ) : null}
          {p.capabilities.trash ? (
            <button
              type="button"
              className="button button-danger"
              onClick={() => setConfirm('trash')}
            >
              Move to trash…
            </button>
          ) : null}
        </p>
        <p className="hint">Archiving or deleting this project never changes its sub-projects.</p>
      </section>

      {review === 'grant' ? (
        <ReviewedChange
          ws={ws}
          change={{
            kind: 'project_grant',
            project: p.id,
            principal: grant.principal,
            level: grant.level,
          }}
          title="Give project access?"
          confirmLabel="Give access"
          onCancel={() => setReview(null)}
          onDone={() => {
            setReview(null);
            reload();
          }}
        />
      ) : null}
      {review === 'share' ? (
        <ReviewedChange
          ws={ws}
          change={{
            kind: 'record_share',
            record: p.id,
            grantee: share.grantee,
            level: share.level,
            expires_at: null,
          }}
          title={`Share ${p.name}?`}
          confirmLabel="Share"
          onCancel={() => setReview(null)}
          onDone={() => {
            setReview(null);
            reload();
          }}
        />
      ) : null}
      {confirm === 'trash' ? (
        <Dialog title={`Move ${p.name} to trash?`} onClose={() => setConfirm(null)} destructive>
          <p>
            It can be restored from the trash during the recovery period. Its sub-projects stay
            where they are.
          </p>
          <p className="actions">
            <button
              type="button"
              className="button button-secondary"
              autoFocus
              onClick={() => setConfirm(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-danger"
              onClick={() =>
                void cmd
                  .run(
                    () => projects.verb(ws, p.id, 'trash', {}, stepUp),
                    'Project moved to trash.',
                  )
                  .then((ok) => ok && navigate(routeHref('projects', { ws })))
              }
            >
              Move to trash
            </button>
          </p>
        </Dialog>
      ) : null}
      {confirm === 'restrict' ? (
        <Dialog title={`Restrict ${p.name}?`} onClose={() => setConfirm(null)} destructive>
          <p>
            Only people with explicit project access will see it and its sub-projects. Brand access,
            including administrators', stops applying. You and the owner keep manage access.
          </p>
          <p className="actions">
            <button
              type="button"
              className="button button-secondary"
              autoFocus
              onClick={() => setConfirm(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-danger"
              onClick={() =>
                void cmd
                  .run(
                    () =>
                      projects.verb(
                        ws,
                        p.id,
                        'access',
                        { access_mode: 'restricted' },
                        stepUp,
                        p.version,
                      ),
                    'Project restricted.',
                  )
                  .then(() => setConfirm(null))
              }
            >
              Restrict
            </button>
          </p>
        </Dialog>
      ) : null}
      {cmd.error ? <ProblemBanner error={cmd.error} /> : null}
      <Announce>{cmd.said}</Announce>
    </>
  );
}

/** `sha256:` over the RFC 8785 form, exactly as the server hashes rich-text base values. */
export async function richTextHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value ?? null));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `sha256:${[...digest].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

type IdentityDraft = Record<
  'name' | 'description' | 'status' | 'priority' | 'start_date' | 'target_date' | 'health',
  string
>;
const identityOf = (p: Project): IdentityDraft => ({
  name: p.name,
  description: plainFromRichText(p.description),
  status: p.status.key,
  priority: p.priority,
  start_date: p.start_date ?? '',
  target_date: p.target_date ?? '',
  health: p.health?.value ?? '',
});
const IDENTITY_POINTERS: Record<string, string> = {
  '/changes/name': 'st-name',
  '/changes/description': 'st-description',
  '/changes/status': 'st-status',
  '/changes/priority': 'st-priority',
  '/changes/health': 'st-health',
  '/changes/start_date': 'st-start',
  '/changes/target_date': 'st-target',
};

/**
 * Identity and planning fields by field merge (0D): only changed fields are sent with the base the
 * form loaded. A conflict keeps the person's input and offers Keep my changes (re-base on the
 * latest version) or Use the latest version; offline and other failures keep the input too.
 */
function ProjectIdentityForm({
  ws,
  project,
  onSaved,
}: {
  ws: string;
  project: Project;
  onSaved: () => void;
}) {
  const stepUp = useStepUp();
  const [base, setBase] = useState(project);
  const [draft, setDraft] = useState(() => identityOf(project));
  const statusChoices = useStatusChoices(ws, base.id, base.status, base.version, 'project');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const set = (k: keyof IdentityDraft) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const current = identityOf(base);
    const changes: Record<
      string,
      { base: unknown; value: unknown } | { base_hash: string; value: unknown }
    > = {};
    for (const k of Object.keys(draft) as Array<keyof IdentityDraft>) {
      if (draft[k] === current[k]) continue;
      // Rich text is sent as a version 1 document with the hash of the base it replaces (0D §4.2).
      if (k === 'description')
        changes.description = {
          base_hash: await richTextHash(base.description),
          value: richTextFromPlain(draft.description),
        };
      else changes[k] = { base: current[k] || null, value: draft[k] || null };
    }
    if (!Object.keys(changes).length) return;
    setBusy(true);
    setError(null);
    setAttempt((a) => a + 1);
    try {
      const next = await projects.update(ws, base.id, base.version, changes, stepUp);
      setBase(next);
      setDraft(identityOf(next));
      setSaved((n) => n + 1);
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  // Re-reading the latest version keeps the form busy, so a save cannot go out against the
  // version that just conflicted.
  const refresh = async (keepMine: boolean) => {
    setError(null);
    setBusy(true);
    try {
      const latest = await projects.get(ws, base.id);
      setBase(latest);
      if (!keepMine) setDraft(identityOf(latest));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const { fields, other } = splitIssues(error, IDENTITY_POINTERS);
  return (
    <section className="card" aria-labelledby="st-identity">
      <h2 id="st-identity">Identity and planning</h2>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <ErrorSummary
          errors={fields}
          labels={{
            'st-name': 'Name',
            'st-description': 'Description',
            'st-status': 'Status',
            'st-priority': 'Priority',
            'st-health': 'Health',
            'st-start': 'Start date',
            'st-target': 'Target date',
          }}
          focusKey={attempt}
        />
        <Field
          id="st-name"
          label="Name"
          required
          value={draft.name}
          onChange={(e) => set('name')(e.target.value)}
          error={fields['st-name']}
          maxLength={200}
        />
        <TextAreaField
          id="st-description"
          label="Description"
          value={draft.description}
          onChange={set('description')}
          error={fields['st-description']}
          maxLength={20000}
        />
        <SelectField
          id="st-status"
          label="Status"
          value={draft.status}
          onChange={set('status')}
          error={fields['st-status']}
          options={statusChoices}
        />
        <SelectField
          id="st-priority"
          label="Priority"
          value={draft.priority}
          onChange={set('priority')}
          error={fields['st-priority']}
          options={PROJECT_PRIORITIES.map((x) => ({ value: x, label: PRIORITY_LABEL[x]! }))}
        />
        <SelectField
          id="st-health"
          label="Health"
          value={draft.health}
          onChange={set('health')}
          error={fields['st-health']}
          options={[
            { value: '', label: 'No health set' },
            ...PROJECT_HEALTH.map((h) => ({ value: h, label: HEALTH_LABEL[h]! })),
          ]}
        />
        <Field
          id="st-start"
          label="Start date"
          type="date"
          value={draft.start_date}
          onChange={(e) => set('start_date')(e.target.value)}
          error={fields['st-start']}
        />
        <Field
          id="st-target"
          label="Target date"
          type="date"
          value={draft.target_date}
          onChange={(e) => set('target_date')(e.target.value)}
          error={fields['st-target']}
        />
        <OtherIssues issues={other} />
        <SaveProblem
          error={error}
          onKeepMine={() => void refresh(true)}
          onUseLatest={() => void refresh(false)}
        />
        {saved && !error ? <Announce key={saved}>Project saved.</Announce> : null}
        <div className="actions">
          <SubmitButton busy={busy}>Save project</SubmitButton>
        </div>
      </form>
    </section>
  );
}

// -----------------------------------------------------------------------------------------------
// Recurrence (PRJ-013, OD-14)
// -----------------------------------------------------------------------------------------------

const FREQUENCY_OPTIONS = [
  { value: 'daily', label: 'Daily', unit: ['day', 'days'] },
  { value: 'weekly', label: 'Weekly', unit: ['week', 'weeks'] },
  { value: 'monthly', label: 'Monthly', unit: ['month', 'months'] },
  { value: 'yearly', label: 'Yearly', unit: ['year', 'years'] },
] as const;
const WEEKDAY_OPTIONS = [
  ['MO', 'Monday'],
  ['TU', 'Tuesday'],
  ['WE', 'Wednesday'],
  ['TH', 'Thursday'],
  ['FR', 'Friday'],
  ['SA', 'Saturday'],
  ['SU', 'Sunday'],
] as const;
const RECURRENCE_POINTERS: Record<string, string> = {
  '/frequency': 'rc-frequency',
  '/interval': 'rc-interval',
  '/weekdays': 'rc-weekdays',
  '/month_days': 'rc-monthday',
  '/start': 'rc-start',
  '/anchor_tz': 'rc-tz',
  '/ends': 'rc-ends',
  '/ends/count': 'rc-count',
  '/ends/date': 'rc-until',
};
const RECURRENCE_LABELS: Record<string, string> = {
  'rc-frequency': 'Repeats',
  'rc-interval': 'Every',
  'rc-weekdays': 'On these days',
  'rc-monthday': 'Day of the month',
  'rc-start': 'First occurrence',
  'rc-tz': 'Time zone',
  'rc-ends': 'Ends',
  'rc-count': 'Number of occurrences',
  'rc-until': 'Last date',
};
const STATUS_TEXT: Record<Series['status'], string> = {
  active: 'Active',
  paused: 'Paused',
  ended: 'Ended: no more occurrences',
  catching_up: 'Catching up: occurrences that were due are being created, a few at a time',
};

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const zones = (): string[] => {
  const all = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
    'timeZone',
  );
  return all?.length ? all : [browserZone(), 'UTC'];
};

/** "Every 2 weeks on Monday and Wednesday at 09:00 (Europe/Lisbon), 10 times" */
export function describeSeries(s: Pick<Series, 'rule' | 'start' | 'anchor_tz'>): string {
  const f = FREQUENCY_OPTIONS.find((o) => o.value === s.rule.frequency)!;
  const every = s.rule.interval === 1 ? f.label : `Every ${s.rule.interval} ${f.unit[1]}`;
  const days = s.rule.weekdays?.length
    ? ` on ${s.rule.weekdays.map((d) => WEEKDAY_OPTIONS.find(([k]) => k === d)![1]).join(', ')}`
    : '';
  const monthDays = s.rule.month_days?.length ? ` on day ${s.rule.month_days.join(', ')}` : '';
  const ends =
    s.rule.ends.type === 'after'
      ? `, ${s.rule.ends.count} ${s.rule.ends.count === 1 ? 'time' : 'times'}`
      : s.rule.ends.type === 'on'
        ? `, until ${s.rule.ends.date}`
        : '';
  return `${every}${days}${monthDays} at ${s.start.slice(11)} (${s.anchor_tz}), from ${s.start.slice(0, 10)}${ends}`;
}

/** The local intent and, when it differs, the same moment in the viewer's own time zone. */
function NextOccurrence({ s }: { s: Series }) {
  if (!s.next_occurrence) return null;
  const local = s.next_occurrence.replace('T', ' ');
  const instant = s.next_due_at
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(s.next_due_at),
      )
    : null;
  return (
    <p className="hint">
      Next: {local} ({s.anchor_tz})
      {instant && s.anchor_tz !== browserZone() ? ` · your time ${instant}` : ''}
    </p>
  );
}

/**
 * Recurring projects (PRJ-013): every frequency, interval, weekdays (weekly), day of month
 * (monthly), anchor local date-time and IANA zone, and an end condition. The server validates the
 * same rule subset; unsupported combinations come back as field errors and are never normalized.
 * Occurrences keep their local time in the anchor zone across daylight-saving changes.
 */
function RecurrenceSection({ ws, project }: { ws: string; project: Project }) {
  const stepUp = useStepUp();
  return (
    <RecurrenceEditor
      noun="project"
      cacheKey={`rcs:${ws}:${project.id}`}
      load={() => projects.recurrences(ws, project.id)}
      define={(body) => projects.child(ws, project.id, 'recurrences', body, stepUp)}
      verb={(id, v) => projects.childVerb(ws, project.id, 'recurrences', id, v, {}, stepUp)}
    />
  );
}

/**
 * The recurring-schedule editor shared by projects (PRJ-013) and tasks (TSK-027, 2D): the same
 * rule subset, anchor zone, and end conditions; the record kind only changes the wording and the
 * endpoints.
 */
export function RecurrenceEditor({
  noun,
  cacheKey,
  load,
  define,
  verb,
}: {
  noun: 'project' | 'task';
  cacheKey: string;
  load: () => Promise<Series[]>;
  define: (body: Record<string, unknown>) => Promise<unknown>;
  verb: (id: string, verb: 'pause' | 'resume' | 'generate') => Promise<unknown>;
}) {
  const list = useResource(load, cacheKey);
  const cmd = useCommand(list.reload);
  const [form, setForm] = useState({
    frequency: 'weekly' as Series['rule']['frequency'],
    interval: '1',
    weekdays: [] as string[],
    monthDay: '',
    start: '',
    tz: browserZone(),
    ends: 'never' as 'never' | 'after' | 'on',
    count: '10',
    until: '',
  });
  const [local, setLocal] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [said, setSaid] = useState('');
  const unit = FREQUENCY_OPTIONS.find((o) => o.value === form.frequency)!.unit;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setAttempt((a) => a + 1);
    setError(null);
    // Only what the form can know before sending; the server decides everything else.
    const mine: Record<string, string> = {};
    if (form.frequency === 'weekly' && !form.weekdays.length)
      mine['rc-weekdays'] = 'Choose at least one day.';
    if (!form.start) mine['rc-start'] = 'Choose the first date and time.';
    setLocal(mine);
    if (Object.keys(mine).length) return;
    const interval = Number(form.interval);
    const body: Record<string, unknown> = {
      frequency: form.frequency,
      interval: Number.isFinite(interval) && form.interval.trim() !== '' ? interval : form.interval,
      start: form.start,
      anchor_tz: form.tz,
      ends:
        form.ends === 'after'
          ? { type: 'after', count: Number(form.count) }
          : form.ends === 'on'
            ? { type: 'on', date: form.until }
            : { type: 'never' },
    };
    if (form.frequency === 'weekly') body.weekdays = form.weekdays;
    if (form.frequency === 'monthly' && form.monthDay) body.month_days = [Number(form.monthDay)];
    setBusy(true);
    try {
      await define(body);
      setSaid('Recurrence set up.');
      list.reload();
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled')) setError(err);
    } finally {
      setBusy(false);
    }
  };
  const { fields: server, other } = splitIssues(error, RECURRENCE_POINTERS);
  const fields = { ...server, ...local };
  return (
    <section className="card" aria-labelledby="st-recurrence">
      <h2 id="st-recurrence">Recurrence</h2>
      <ResourceView resource={list.state} onRetry={list.retry} what="recurrence">
        {(rows) =>
          rows.length ? (
            <ul className="plain-list" aria-label="Recurring schedules">
              {rows.map((s) => (
                <li key={s.id} className="series">
                  <p>
                    <strong>{describeSeries(s)}</strong>
                  </p>
                  <p>
                    <span className="badge">{STATUS_TEXT[s.status]}</span>
                    {s.generated_through ? (
                      <span className="hint">
                        {' '}
                        · created through {s.generated_through.replace('T', ' ')}
                      </span>
                    ) : null}
                  </p>
                  <NextOccurrence s={s} />
                  <span className="actions-compact">
                    {s.status !== 'ended' ? (
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={cmd.busy}
                        onClick={() =>
                          void cmd.run(
                            () => verb(s.id, s.state === 'active' ? 'pause' : 'resume'),
                            s.state === 'active' ? 'Recurrence paused.' : 'Recurrence resumed.',
                          )
                        }
                      >
                        {s.state === 'active' ? 'Pause' : 'Resume'}
                        <span className="visually-hidden"> {describeSeries(s)}</span>
                      </button>
                    ) : null}
                    {s.status !== 'ended' ? (
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={cmd.busy}
                        onClick={() =>
                          void cmd.run(() => verb(s.id, 'generate'), 'Next occurrence created.')
                        }
                      >
                        Create next occurrence now
                        <span className="visually-hidden"> for {describeSeries(s)}</span>
                      </button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p>This {noun} does not repeat.</p>
          )
        }
      </ResourceView>
      <SaveProblem error={cmd.error} />
      <Announce>{cmd.said || said}</Announce>
      <form onSubmit={(e) => void submit(e)} noValidate aria-labelledby="rc-heading">
        <h3 id="rc-heading">Set up a recurring schedule</h3>
        <ErrorSummary errors={fields} labels={RECURRENCE_LABELS} focusKey={attempt} />
        <SelectField
          id="rc-frequency"
          label="Repeats"
          value={form.frequency}
          onChange={(v) => setForm({ ...form, frequency: v as Series['rule']['frequency'] })}
          error={fields['rc-frequency']}
          options={FREQUENCY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        />
        <Field
          id="rc-interval"
          label={`Every how many ${unit[1]}`}
          type="number"
          inputMode="numeric"
          min={1}
          max={366}
          value={form.interval}
          onChange={(e) => setForm({ ...form, interval: e.target.value })}
          error={fields['rc-interval']}
        />
        {form.frequency === 'weekly' ? (
          <fieldset aria-describedby={fields['rc-weekdays'] ? 'rc-weekdays-error' : undefined}>
            <legend id="rc-weekdays">On these days</legend>
            {fields['rc-weekdays'] ? (
              <p className="field-error" id="rc-weekdays-error">
                {fields['rc-weekdays']}
              </p>
            ) : null}
            {WEEKDAY_OPTIONS.map(([key, name]) => (
              <label key={key} className="choice">
                <input
                  type="checkbox"
                  checked={form.weekdays.includes(key)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      weekdays: e.target.checked
                        ? [...form.weekdays, key]
                        : form.weekdays.filter((d) => d !== key),
                    })
                  }
                />{' '}
                {name}
              </label>
            ))}
          </fieldset>
        ) : null}
        {form.frequency === 'monthly' ? (
          <SelectField
            id="rc-monthday"
            label="Day of the month"
            hint="Months without this day are skipped, never moved to another day."
            value={form.monthDay}
            onChange={(v) => setForm({ ...form, monthDay: v })}
            error={fields['rc-monthday']}
            options={[
              { value: '', label: 'Same day as the first occurrence' },
              ...Array.from({ length: 31 }, (_, i) => ({
                value: String(i + 1),
                label: String(i + 1),
              })),
            ]}
          />
        ) : null}
        <Field
          id="rc-start"
          label="First occurrence"
          hint="Each occurrence keeps this local time in the chosen time zone, also across daylight-saving changes."
          type="datetime-local"
          value={form.start}
          onChange={(e) => setForm({ ...form, start: e.target.value })}
          error={fields['rc-start']}
        />
        <SelectField
          id="rc-tz"
          label="Time zone"
          value={form.tz}
          onChange={(v) => setForm({ ...form, tz: v })}
          error={fields['rc-tz']}
          options={zones().map((z) => ({ value: z, label: z }))}
        />
        <fieldset>
          <legend id="rc-ends">Ends</legend>
          {fields['rc-ends'] ? <p className="field-error">{fields['rc-ends']}</p> : null}
          {(
            [
              ['never', 'Never'],
              ['after', 'After a number of occurrences'],
              ['on', 'On a date'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="choice">
              <input
                type="radio"
                name="rc-ends"
                value={value}
                checked={form.ends === value}
                onChange={() => setForm({ ...form, ends: value })}
              />{' '}
              {label}
            </label>
          ))}
          {form.ends === 'after' ? (
            <Field
              id="rc-count"
              label="Number of occurrences"
              type="number"
              inputMode="numeric"
              min={1}
              max={999}
              value={form.count}
              onChange={(e) => setForm({ ...form, count: e.target.value })}
              error={fields['rc-count']}
            />
          ) : null}
          {form.ends === 'on' ? (
            <Field
              id="rc-until"
              label="Last date"
              type="date"
              value={form.until}
              onChange={(e) => setForm({ ...form, until: e.target.value })}
              error={fields['rc-until']}
            />
          ) : null}
        </fieldset>
        <OtherIssues issues={other} />
        {!Object.keys(server).length && !other.length ? <SaveProblem error={error} /> : null}
        <div className="actions">
          <SubmitButton busy={busy}>Set up recurrence</SubmitButton>
        </div>
      </form>
    </section>
  );
}
