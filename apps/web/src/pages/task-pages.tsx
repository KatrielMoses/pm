import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { DELIVERABLE_TYPES, LABEL_COLORS, PROJECT_PRIORITIES } from '@pm/contracts/shell';
import { plainFromRichText, richTextFromPlain } from '@pm/contracts/rich-text';
import { ApiError } from '../api.ts';
import {
  RecordFieldsSection,
  TransitionControl,
  useStatusChoices,
} from '../workflow/record-workflow.tsx';
import { CollaborationSections } from '../collab/collaboration.tsx';
import { DeliverablesPanel } from '../files/deliverables.tsx';
import { FilesPanel } from '../files/files-panel.tsx';
import { Link, useRouter } from '../router.tsx';
import { BrandMarker } from '../shell/brand-marker.tsx';
import { routeHref } from '../shell/registry.ts';
import { useRecordVisit, useWorkspaceShell } from '../shell/workspace.tsx';
import { useStepUp } from '../stepup.tsx';
import {
  tasks,
  type Task,
  type TaskDetail,
  type TaskSignals,
  type TaskSummary,
  type UndoHandle,
} from '../tasks/client.ts';
import {
  BulkBar,
  DuplicateHint,
  InlineEditor,
  RemindersSection,
  RescheduleDialog,
  SignalBadges,
  TaskSignalsPanel,
  UndoToast,
} from '../tasks/interaction.tsx';
import { collab, tenancy, type Member } from '../tenancy/client.ts';
import { ResourceView, useResource } from '../tenancy/resource.tsx';
import { Dialog, isModalOpen } from '../ui/dialog.tsx';
import { Announce, Banner } from '../ui/feedback.tsx';
import { ErrorSummary, Field, SelectField, SubmitButton, TextAreaField } from '../ui/form.tsx';
import { Page } from '../ui/layout.tsx';
import { WorkTimePanel } from './time-pages.tsx';
import { DocumentsSection } from '../docs/sections.tsx';
import { MentionedInDocuments } from '../docs/panels.tsx';
import { TaskPlanPanel } from './today-pages.tsx';
import { ReviewedChange } from './people-pages.tsx';
import { RecurrenceEditor, richTextHash, StatusBadge, useCommand } from './project-pages.tsx';
import { FavoriteToggle } from './shell-pages.tsx';
import { OtherIssues, SaveProblem, splitIssues } from './workspace-pages.tsx';

// 8B: the task Agent section loads with the agent pages, on first use.
const TaskAgentSection = lazy(() =>
  import('../agents/pages.tsx').then((m) => ({ default: m.TaskAgentSection })),
);

/**
 * Phase 2B tasks (0E Phase 2B note): the project Tasks section (paged list and keyboard hierarchy
 * with visible Move up, Move down, Indent, Outdent), the projectless task list, and the canonical
 * task page. Phase 2D (ADR-0016) adds ordering commands (top, bottom, to a position; drag is a
 * pointer shortcut over the same command), inline edits with save states, signal badges, bulk
 * changes with a preview, undo, duplicate hints, templates, reminders, snooze, reschedule, and
 * recurring tasks. Saved views arrive in 3A.
 */

const PRIORITY_LABEL: Record<string, string> = {
  none: 'No priority',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};
const DELIVERABLE_LABEL: Record<string, string> = {
  document: 'Document',
  file: 'File',
  url: 'Web link',
  pull_request: 'Pull request',
  test_report: 'Test report',
  other: 'Other',
};
const UNAVAILABLE: Record<string, string> = {
  files: 'Files (4E)',
  external_records: 'External records (6A)',
  agents: 'Agents (8B)',
};

const fmtMinutes = (m: number | null) =>
  m === null
    ? '—'
    : m >= 60
      ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`
      : `${m} min`;
const deadlineText = (d: Task['deadline']) =>
  !d ? 'No deadline' : 'date' in d ? d.date : `${new Date(d.at).toLocaleString()} (${d.tz})`;

function Assignees({ list }: { list: TaskSummary['assignees'] }) {
  if (!list.length) return <span className="hint">Unassigned</span>;
  return (
    <span>
      {list.map((a, i) => (
        <span key={a.id}>
          {i ? ', ' : ''}
          {a.name}
          {a.primary ? <span className="hint"> (primary)</span> : null}
        </span>
      ))}
    </span>
  );
}

// -----------------------------------------------------------------------------------------------
// Task hierarchy (project Tasks section and projectless list)
// -----------------------------------------------------------------------------------------------

interface Node {
  t: TaskSummary;
  parent: Node | null;
  children: Node[] | null; // null = not loaded
}

/**
 * APG tree (A11Y-PA-08): one tab stop with roving focus; arrows move, expand, and collapse
 * (children load on demand); Home/End; type-ahead; Enter opens. Visible actions for the focused
 * task move it without dragging: Move up, Move down, Indent (under the previous sibling), Outdent.
 */
export function TaskTree({
  ws,
  roots,
  onChanged,
  initialFocus = null,
  signals = {},
  onUndo,
}: {
  ws: string;
  roots: TaskSummary[];
  /** Called after a move with its announcement and the moved task (the parent reloads). */
  onChanged: (said: string, moved: string) => void;
  /** The task to focus on mount: the moved task survives the reload that remounts the tree. */
  initialFocus?: string | null;
  /** 2D: signals of the loaded tasks (readable ones only). */
  signals?: Record<string, TaskSignals>;
  /** 2D: the undo handle of the latest reversible change made here. */
  onUndo?: (handle: UndoHandle | null, what: string) => void;
}) {
  const { navigate } = useRouter();
  const stepUp = useStepUp();
  const [tree] = useState<Node[]>(() => roots.map((t) => ({ t, parent: null, children: null })));
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [focused, setFocused] = useState<string | null>(
    initialFocus && roots.some((r) => r.id === initialFocus)
      ? initialFocus
      : (roots[0]?.id ?? null),
  );
  const [, force] = useState(0);
  const typed = useRef({ text: '', at: 0 });
  const refs = useRef(new Map<string, HTMLLIElement>());
  const cmd = useCommand(() => undefined);
  const visible: Node[] = [];
  const walk = (ns: Node[]) =>
    ns.forEach((n) => {
      visible.push(n);
      if (open.has(n.t.id) && n.children) walk(n.children);
    });
  walk(tree);
  const current = visible.find((n) => n.t.id === focused) ?? visible[0];
  useEffect(() => {
    if (focused && document.activeElement?.closest('[role="tree"]'))
      refs.current.get(focused)?.focus();
  }, [focused]);
  useEffect(() => {
    // The remount after a move puts focus back on the moved task only when focus was lost with the
    // old tree (it is on the body) or is still in a tree. A background refresh never takes focus
    // the person has moved elsewhere (the Capture button, an open modal, a field).
    const active = document.activeElement;
    const lost = !active || active === document.body || !!active.closest('[role="tree"]');
    if (initialFocus && lost && !isModalOpen()) refs.current.get(initialFocus)?.focus();
  }, [initialFocus]);
  const expand = async (n: Node) => {
    if (!n.children) {
      const r = await tasks.list(ws, { parent: n.t.id, limit: '200' });
      n.children = r.data.map((t) => ({ t, parent: n, children: null }));
    }
    setOpen(new Set([...open, n.t.id]));
    force((x) => x + 1);
  };
  const siblings = (n: Node) => (n.parent ? n.parent.children! : tree);
  const move = (n: Node, body: Record<string, unknown>, message: string) =>
    void cmd.run(async () => {
      await tasks.verb(ws, n.t.id, 'move', body, stepUp);
      onChanged(message, n.t.id);
    }, message);
  // 2D ordering commands (D9): the same command for buttons, keys, and drag.
  const reorder = (
    n: Node,
    body: { position: 'up' | 'down' | 'top' | 'bottom' | 'to'; index?: number },
  ) =>
    void cmd.run(async () => {
      const r = await tasks.reorder(ws, n.t.id, body, n.t.version, stepUp);
      onUndo?.(r.undo, `${n.t.title} moved`);
      onChanged(`${n.t.title}: ${r.announcement}`, n.t.id);
    }, '');
  const [positionText, setPositionText] = useState('');
  const [editing, setEditing] = useState(false);
  const dragged = useRef<Node | null>(null);
  const onKey = (e: KeyboardEvent) => {
    if (!current) return;
    const i = visible.indexOf(current);
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const k = { ArrowUp: 'up', ArrowDown: 'down', Home: 'top', End: 'bottom' }[e.key] as
        'up' | 'down' | 'top' | 'bottom' | undefined;
      if (k) {
        e.preventDefault();
        reorder(current, { position: k });
        return;
      }
    }
    const go = (n: Node | undefined) => {
      if (n) {
        e.preventDefault();
        setFocused(n.t.id);
      }
    };
    if (e.key === 'ArrowDown') go(visible[i + 1]);
    else if (e.key === 'ArrowUp') go(visible[i - 1]);
    else if (e.key === 'Home') go(visible[0]);
    else if (e.key === 'End') go(visible.at(-1));
    else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (current.t.children > 0 && !open.has(current.t.id)) void expand(current);
      else go(current.children?.[0]);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (open.has(current.t.id)) setOpen(new Set([...open].filter((x) => x !== current.t.id)));
      else go(current.parent ?? undefined);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      navigate(routeHref('task', { ws, tsk: current.t.id }));
    } else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = e.timeStamp;
      typed.current.text =
        now - typed.current.at < 700
          ? typed.current.text + e.key.toLowerCase()
          : e.key.toLowerCase();
      typed.current.at = now;
      const order = [...visible.slice(i + 1), ...visible.slice(0, i + 1)];
      go(order.find((n) => n.t.title.toLowerCase().startsWith(typed.current.text)));
    }
  };
  const render = (ns: Node[], level: number): React.ReactNode =>
    ns.map((n) => (
      <li
        key={n.t.id}
        role="treeitem"
        aria-level={level}
        aria-expanded={n.t.children > 0 ? open.has(n.t.id) : undefined}
        aria-selected={n === current}
        tabIndex={n === current ? 0 : -1}
        ref={(el) => {
          if (el) refs.current.set(n.t.id, el);
        }}
        onFocus={(e) => {
          if (e.target === e.currentTarget) setFocused(n.t.id);
        }}
        className="tree-item"
        // Pointer shortcut only: dropping on a sibling runs the same "move to position" command.
        draggable
        onDragStart={(e) => {
          e.stopPropagation();
          dragged.current = n;
        }}
        onDragOver={(e) => {
          if (dragged.current && dragged.current.parent === n.parent) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const d = dragged.current;
          dragged.current = null;
          if (!d || d === n || d.parent !== n.parent) return;
          reorder(d, { position: 'to', index: siblings(n).indexOf(n) + 1 });
        }}
      >
        <span className="tree-label">
          <span aria-hidden="true">
            {n.t.children > 0 ? (open.has(n.t.id) ? '▾ ' : '▸ ') : '  '}
          </span>
          {n.t.title} <StatusBadge status={n.t.status} />{' '}
          <span className="hint">
            {PRIORITY_LABEL[n.t.priority]} · <Assignees list={n.t.assignees} />
            {n.t.due_date ? ` · due ${n.t.due_date}` : ''}
            {n.t.estimate_minutes !== null ? ` · ${fmtMinutes(n.t.estimate_minutes)}` : ''}
          </span>
          {signals[n.t.id] ? <SignalBadges signals={signals[n.t.id]!} /> : null}
        </span>
        {open.has(n.t.id) && n.children?.length ? (
          <ul role="group">{render(n.children, level + 1)}</ul>
        ) : null}
      </li>
    ));
  const sib = current ? siblings(current) : [];
  const idx = current ? sib.indexOf(current) : -1;
  return (
    <>
      <ul role="tree" aria-label="Task hierarchy" className="tree" onKeyDown={onKey}>
        {render(tree, 1)}
      </ul>
      {current ? (
        <div className="toolbar" role="group" aria-label={`Actions for ${current.t.title}`}>
          <Link
            to={routeHref('task', { ws, tsk: current.t.id })}
            className="button button-secondary"
          >
            Open {current.t.title}
          </Link>
          <button
            type="button"
            className="button button-secondary"
            disabled={idx <= 0 || cmd.busy}
            onClick={() =>
              move(
                current,
                {
                  parent: current.parent?.t.id ?? null,
                  after: idx >= 2 ? sib[idx - 2]!.t.id : null,
                },
                `${current.t.title} moved up.`,
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
                { parent: current.parent?.t.id ?? null, after: sib[idx + 1]!.t.id },
                `${current.t.title} moved down.`,
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
                { parent: sib[idx - 1]!.t.id },
                `${current.t.title} indented under ${sib[idx - 1]!.t.title}.`,
              )
            }
          >
            Indent
          </button>
          <button
            type="button"
            className="button button-secondary"
            disabled={!current.parent || cmd.busy}
            onClick={() =>
              move(
                current,
                { parent: current.parent!.parent?.t.id ?? null, after: current.parent!.t.id },
                `${current.t.title} outdented.`,
              )
            }
          >
            Outdent
          </button>
          <button
            type="button"
            className="button button-secondary"
            disabled={idx <= 0 || cmd.busy}
            aria-keyshortcuts="Alt+Home"
            onClick={() => reorder(current, { position: 'top' })}
          >
            Move to top
          </button>
          <button
            type="button"
            className="button button-secondary"
            disabled={idx < 0 || idx >= sib.length - 1 || cmd.busy}
            aria-keyshortcuts="Alt+End"
            onClick={() => reorder(current, { position: 'bottom' })}
          >
            Move to bottom
          </button>
          <form
            className="inline-form"
            aria-label={`Move ${current.t.title} to a position`}
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(positionText);
              if (Number.isInteger(n) && n >= 1) reorder(current, { position: 'to', index: n });
            }}
          >
            <Field
              id="move-to-position"
              label={`Position (1–${sib.length})`}
              type="number"
              inputMode="numeric"
              min={1}
              max={sib.length}
              value={positionText}
              onChange={(e) => setPositionText(e.target.value)}
            />
            <button type="submit" className="button button-secondary" disabled={cmd.busy}>
              Move to position
            </button>
          </form>
          <button
            type="button"
            className="button button-secondary"
            aria-expanded={editing}
            onClick={() => setEditing(!editing)}
          >
            {editing ? 'Done editing' : 'Edit in place'}
          </button>
        </div>
      ) : null}
      {current && editing ? (
        <div className="inline-editors" role="group" aria-label={`Edit ${current.t.title}`}>
          {(
            [
              ['title', 'Title', current.t.title],
              ['priority', 'Priority', current.t.priority],
              ['due_date', 'Due date', current.t.due_date],
            ] as const
          ).map(([field, label, value]) => (
            <InlineEditor
              key={`${current.t.id}:${field}:${value ?? ''}`}
              ws={ws}
              taskId={current.t.id}
              version={current.t.version}
              field={field}
              label={label}
              value={value}
              onSaved={(t, message) => {
                current.t = {
                  ...current.t,
                  title: t.title,
                  priority: t.priority,
                  due_date: t.due_date,
                  version: t.version,
                };
                force((x) => x + 1);
                onUndo?.(t.undo ?? null, `${label} changed`);
                onChanged(message, current.t.id);
              }}
            />
          ))}
        </div>
      ) : null}
      <SaveProblem error={cmd.error} />
    </>
  );
}

function TaskCollection({
  ws,
  query,
  createWith,
  emptyText,
  brand,
}: {
  ws: string;
  query: Record<string, string>;
  createWith: (title: string) => Record<string, unknown> | null;
  emptyText: string;
  /** 2D: the brand new tasks belong to (duplicate hints, templates, bulk labels). */
  brand: string | null;
}) {
  const stepUp = useStepUp();
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [pages, setPages] = useState<TaskSummary[]>([]);
  const key = JSON.stringify(query);
  const data = useResource(
    () => tasks.list(ws, { ...query, parent: 'root', ...(cursor ? { cursor } : {}) }),
    `tasks:${ws}:${key}:${cursor ?? ''}`,
  );
  // Each loaded page is folded in once, during render (no effect): the first page replaces the
  // list, later pages append; `generation` remounts the tree so its expansion state starts fresh.
  const [seen, setSeen] = useState<unknown>(null);
  const [generation, setGeneration] = useState(0);
  if (data.state.status === 'ready' && data.state.data !== seen) {
    const page = data.state.data.data;
    setSeen(data.state.data);
    setPages((prev) => (cursor ? [...prev, ...page] : page));
    setGeneration((g) => g + 1);
  }
  const [title, setTitle] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [said, setSaid] = useState('');
  const [movedId, setMovedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<{ handle: UndoHandle | null; what: string }>({
    handle: null,
    what: '',
  });
  const [bulk, setBulk] = useState(false);
  const [signals, setSignals] = useState<Record<string, TaskSignals>>({});
  const ids = pages.map((p) => p.id).join(',');
  useEffect(() => {
    let live = true;
    const list = ids ? ids.split(',').slice(0, 200) : [];
    void tasks
      .signalsFor(ws, list)
      .then((items) => {
        if (live) setSignals(Object.fromEntries(items.map((i) => [i.task, i.signals])));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [ws, ids]);
  const labels = useResource(
    () => (brand ? tasks.labels(ws, brand) : Promise.resolve([])),
    `labels:${ws}:${brand ?? ''}`,
  );
  const templates = useResource(() => tasks.templates(ws), `task-templates:${ws}`);
  const [template, setTemplate] = useState('');
  const fromTemplate = async () => {
    const body = createWith(title || 'x');
    if (!template || !brand || !body) return;
    setBusy(true);
    setError(null);
    try {
      const r = await tasks.applyTemplate(
        ws,
        template,
        {
          brand,
          ...(body.project ? { project: body.project } : {}),
          ...(title.trim() ? { title: title.trim() } : {}),
        },
        stepUp,
      );
      const left = (r.omitted ?? []).filter(
        (o) => o === 'unavailable_fields' || o === 'unavailable_labels' || o === 'hidden_fields',
      );
      setSaid(
        `Task created from template.${left.length ? ' Some content was left out because it isn’t available here.' : ''}`,
      );
      setTitle('');
      setCursor(undefined);
      data.reload();
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled')) setError(err);
    } finally {
      setBusy(false);
    }
  };
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const body = createWith(title);
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await tasks.create(ws, body, stepUp);
      setTitle('');
      setSaid('Task created.');
      setCursor(undefined);
      data.reload();
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled')) setError(err);
    } finally {
      setBusy(false);
    }
  };
  const { fields, other } = splitIssues(error, {
    '/title': 'new-task-title',
    '/brand': 'new-task-title',
  });
  return (
    <>
      <form
        onSubmit={(e) => void create(e)}
        noValidate
        className="inline-form"
        aria-label="Add a task"
      >
        <Field
          id="new-task-title"
          label="New task"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          error={fields['new-task-title']}
          maxLength={300}
        />
        <DuplicateHint ws={ws} brand={brand} project={query.project ?? null} title={title} />
        <SubmitButton busy={busy}>Add task</SubmitButton>
        {templates.state.status === 'ready' && templates.state.data.length && brand ? (
          <span className="inline-form">
            <SelectField
              id="new-task-template"
              label="Or start from a template"
              value={template}
              onChange={setTemplate}
              options={[
                { value: '', label: 'Choose a template' },
                ...templates.state.data.map((t) => ({ value: t.id, label: t.name })),
              ]}
            />
            <button
              type="button"
              className="button button-secondary"
              disabled={!template || busy}
              onClick={() => void fromTemplate()}
            >
              Create from template
            </button>
          </span>
        ) : null}
        <OtherIssues issues={other} />
        {!Object.keys(fields).length && !other.length ? <SaveProblem error={error} /> : null}
        <Announce>{said}</Announce>
      </form>
      <ResourceView resource={data.state} onRetry={data.retry} what="tasks">
        {(d) =>
          !pages.length ? (
            <p className="empty-state">{emptyText}</p>
          ) : (
            <>
              <p className="hint">
                {d.page.total
                  ? `${d.page.total.value} top-level ${d.page.total.value === 1 ? 'task' : 'tasks'}`
                  : ''}
              </p>
              <TaskTree
                key={generation}
                ws={ws}
                roots={pages}
                initialFocus={movedId}
                signals={signals}
                onUndo={(handle, what) => setUndo({ handle, what })}
                onChanged={(message, id) => {
                  setSaid(message);
                  setMovedId(id);
                  setCursor(undefined);
                  data.reload();
                }}
              />
              <UndoToast
                ws={ws}
                handle={undo.handle}
                what={undo.what}
                onDone={(message) => {
                  setUndo({ handle: null, what: '' });
                  setSaid(message);
                  setCursor(undefined);
                  data.reload();
                }}
              />
              <button
                type="button"
                className="button button-secondary"
                aria-expanded={bulk}
                onClick={() => setBulk(!bulk)}
              >
                {bulk ? 'Hide bulk changes' : 'Change several tasks'}
              </button>
              {bulk ? (
                <BulkBar
                  ws={ws}
                  choices={pages.map((p) => ({ id: p.id, title: p.title }))}
                  labels={
                    labels.state.status === 'ready'
                      ? labels.state.data.map((l) => ({ value: l.id, label: l.name }))
                      : []
                  }
                  onApplied={(message, handle) => {
                    setSaid(message);
                    setUndo({ handle, what: message.replace(/\.$/, '') });
                    setCursor(undefined);
                    data.reload();
                  }}
                />
              ) : null}
              {d.page.has_more ? (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setCursor(d.page.next_cursor)}
                >
                  Show more tasks
                </button>
              ) : null}
            </>
          )
        }
      </ResourceView>
    </>
  );
}

/** The project Tasks section: the project's brand is fixed (read-only) for new tasks. */
export function ProjectTasksSection({
  ws,
  project,
}: {
  ws: string;
  project: { id: string; capabilities: { edit: boolean }; brand?: { kind: string; id?: string } };
}) {
  return (
    <section className="card" aria-labelledby="tasks-heading">
      <h2 id="tasks-heading">Tasks</h2>
      <TaskCollection
        ws={ws}
        query={{ project: project.id }}
        createWith={(title) => (title.trim() ? { project: project.id, title: title.trim() } : null)}
        emptyText="No tasks in this project yet."
        brand={project.brand?.kind === 'brand' ? (project.brand.id ?? null) : null}
      />
    </section>
  );
}

/** Tasks without a project in the current scope (an entry path, not a saved view). */
export function ProjectlessTasksPage({ ws }: { ws: string }) {
  const shellState = useWorkspaceShell();
  const scope = shellState?.context?.scope;
  const brandIds =
    scope?.kind === 'brand' ? [scope.brand_id] : scope?.kind === 'brands' ? scope.brand_ids : [];
  const brands = useResource(() => tenancy.listBrands(ws, 'active'), `brands:${ws}`);
  const [brand, setBrand] = useState('');
  const single = scope?.kind === 'brand' ? scope.brand_id : null;
  return (
    <Page title="Tasks without a project" wide>
      {!single && brands.state.status === 'ready' ? (
        <SelectField
          id="new-task-brand"
          label="Brand for new tasks"
          hint="In this scope, choose which brand owns each new task."
          value={brand}
          onChange={setBrand}
          options={[
            { value: '', label: 'Choose a brand' },
            ...brands.state.data.data.map((b) => ({ value: b.id, label: b.name })),
          ]}
        />
      ) : null}
      <TaskCollection
        ws={ws}
        query={{ projectless: 'true', ...(brandIds.length ? { brands: brandIds.join(',') } : {}) }}
        createWith={(title) => {
          const b = single ?? brand;
          return title.trim() ? { title: title.trim(), ...(b ? { brand: b } : {}) } : null;
        }}
        emptyText="No tasks without a project."
        brand={single ?? (brand || null)}
      />
    </Page>
  );
}

// -----------------------------------------------------------------------------------------------
// The task page
// -----------------------------------------------------------------------------------------------

export function TaskPage({ ws, tsk }: { ws: string; tsk: string }) {
  const shellState = useWorkspaceShell();
  const data = useResource(() => tasks.get(ws, tsk), `task:${ws}:${tsk}`, {
    keepOnRefreshError: true,
  });
  const t = data.state.status === 'ready' ? data.state.data : null;
  useRecordVisit(t && t.lifecycle_state === 'active' ? t.id : null);
  const enter = shellState?.enterRecordBrand;
  useEffect(() => {
    if (t && t.brand.kind === 'brand') enter?.(t.brand.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t?.id, shellState?.context !== null]);
  return (
    <Page
      title={t ? t.title : 'Task'}
      wide
      section="Tasks"
      record={t ? { title: t.title } : null}
      breadcrumbs={
        t
          ? [
              ...(t.project
                ? [
                    {
                      label: t.project.name,
                      to: routeHref('project_section', { ws, prj: t.project.id, section: 'tasks' }),
                    },
                  ]
                : []),
              ...t.ancestors.map((a) => ({
                label: a.title,
                to: routeHref('task', { ws, tsk: a.id }),
              })),
              { label: t.title },
            ]
          : undefined
      }
      actions={
        t && t.lifecycle_state === 'active' ? (
          <>
            <FavoriteToggle target={t.id} label={t.title} />{' '}
            {/* 7C: AI assistance scoped to this task (preview works with AI off). */}
            <Link to={`/workspaces/${ws}/ai/assist?task=${t.id}`}>AI assist</Link>
          </>
        ) : null
      }
    >
      <ResourceView resource={data.state} onRetry={data.retry} what="task">
        {(task) => <TaskBody ws={ws} task={task} detail={task.detail} reload={data.reload} />}
      </ResourceView>
    </Page>
  );
}

function TaskBody({
  ws,
  task,
  detail,
  reload,
}: {
  ws: string;
  task: Task;
  detail: TaskDetail;
  reload: () => void;
}) {
  const caps = task.capabilities;
  return (
    <>
      <div className="record-header">
        <p className="record-meta">
          <BrandMarker marker={task.brand} size={20} /> <StatusBadge status={task.status} />{' '}
          <span className="badge">{PRIORITY_LABEL[task.priority]}</span>
          {task.shared_only ? <span className="badge">Shared with you</span> : null}
        </p>
        {task.lifecycle_state === 'archived' ? (
          <Banner tone="info" title="This task is archived">
            It is read-only. Restore it below to make changes.
          </Banner>
        ) : null}
        {task.completion_override ? (
          <Banner tone="warning" title="Completed with an override">
            {task.completion_override.reason}
          </Banner>
        ) : null}
      </div>
      <CompletionControls ws={ws} task={task} detail={detail} reload={reload} />
      <TaskInteractionSections ws={ws} task={task} reload={reload} />
      {caps.edit && !task.shared_only ? (
        <TransitionControl ws={ws} rec={task.id} version={task.version} onChanged={reload} />
      ) : null}
      {caps.edit ? (
        <TaskFieldsForm ws={ws} task={task} onSaved={reload} />
      ) : (
        <TaskFacts task={task} />
      )}
      {!task.shared_only ? <RecordFieldsSection ws={ws} rec={task.id} onSaved={reload} /> : null}
      <CriteriaSection ws={ws} task={task} detail={detail} reload={reload} />
      <ChecklistSection ws={ws} task={task} detail={detail} reload={reload} />
      {!task.shared_only ? (
        <SubtasksSection ws={ws} task={task} detail={detail} reload={reload} />
      ) : null}
      {!task.shared_only ? <PeopleAndLabels ws={ws} task={task} reload={reload} /> : null}
      {!task.shared_only ? (
        <Suspense fallback={null}>
          <TaskAgentSection ws={ws} task={task.id} />
        </Suspense>
      ) : null}
      {!task.shared_only ? (
        <LinksSection ws={ws} task={task} detail={detail} reload={reload} />
      ) : null}
      {!task.shared_only ? (
        <RelationshipsSection ws={ws} task={task} detail={detail} reload={reload} />
      ) : null}
      {task.lifecycle_state === 'active' && !task.shared_only ? (
        <TaskPlanPanel
          ws={ws}
          task={task.id}
          estimate={task.remaining_estimate_minutes ?? task.estimate_minutes}
        />
      ) : null}
      {task.lifecycle_state !== 'trashed' ? (
        <WorkTimePanel ws={ws} target={task.id} canLog={!!caps.log_time} version={task.version} />
      ) : null}
      {task.lifecycle_state !== 'trashed' && !task.shared_only ? (
        <>
          <DocumentsSection
            ws={ws}
            task={task.id}
            noun="task"
            canCreate={task.lifecycle_state === 'active'}
            headingId="task-docs-h"
          />
          <MentionedInDocuments ws={ws} rec={task.id} headingId="task-mentioned-h" />
        </>
      ) : null}
      {task.lifecycle_state !== 'trashed' ? <TaskFiles ws={ws} task={task} /> : null}
      {task.lifecycle_state !== 'trashed' ? (
        <CollaborationSections
          ws={ws}
          rec={task.id}
          kind="task"
          version={task.version}
          archived={task.lifecycle_state === 'archived'}
          sharedOnly={task.shared_only}
          onRecordChanged={reload}
        />
      ) : null}
      {detail.unavailable.some((u) => u !== 'documents') ? (
        <section className="card" aria-labelledby="later-heading">
          <h2 id="later-heading">Not available yet</h2>
          <ul>
            {detail.unavailable
              .filter((u) => u !== 'documents')
              .map((u) => (
                <li key={u}>{UNAVAILABLE[u] ?? u} isn't available yet.</li>
              ))}
          </ul>
        </section>
      ) : null}
      {caps.history ? <HistorySection ws={ws} task={task} /> : null}
      {!task.shared_only ? <TaskManageSection ws={ws} task={task} reload={reload} /> : null}
    </>
  );
}

/** 4E: the task's files and its deliverables (the submit dialog lists this task's ready files). */
function TaskFiles({ ws, task }: { ws: string; task: Task }) {
  const [nonce, setNonce] = useState(0);
  return (
    <>
      <FilesPanel
        ws={ws}
        host={task.id}
        noun="on this task"
        onChanged={() => setNonce((n) => n + 1)}
      />
      <DeliverablesPanel
        ws={ws}
        tsk={task.id}
        canCreate={!!task.capabilities.edit && task.lifecycle_state === 'active'}
        filesNonce={nonce}
      />
    </>
  );
}

/**
 * 2D on the task page: signals and the missing-information panel, the caller's own reminders and
 * snooze, Reschedule (an explicit due-date or deadline choice), Repeat, and Save as template.
 */
function TaskInteractionSections({
  ws,
  task,
  reload,
}: {
  ws: string;
  task: Task;
  reload: () => void;
}) {
  const stepUp = useStepUp();
  const info = useResource(
    () => tasks.signals(ws, task.id),
    `signals:${ws}:${task.id}:${task.version}`,
  );
  const [resched, setResched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [said, setSaid] = useState('');
  const again = () => {
    info.reload();
    reload();
  };
  return (
    <>
      <ResourceView resource={info.state} onRetry={info.retry} what="signals">
        {(i) => (
          <>
            <TaskSignalsPanel ws={ws} task={task} info={i} reload={again} />
            {task.lifecycle_state === 'active' ? (
              <RemindersSection ws={ws} task={task} info={i} reload={info.reload} />
            ) : null}
          </>
        )}
      </ResourceView>
      {task.capabilities.edit && task.lifecycle_state === 'active' ? (
        <section className="card" aria-labelledby="resched-h">
          <h2 id="resched-h">Reschedule</h2>
          <p className="hint">
            Change the due date or, separately, the deadline. Snoozing never changes either.
          </p>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setResched(true)}
          >
            Reschedule…
          </button>
          {resched ? (
            <RescheduleDialog
              ws={ws}
              task={task}
              onClose={() => setResched(false)}
              onDone={() => {
                setResched(false);
                setSaid('Rescheduled.');
                again();
              }}
            />
          ) : null}
        </section>
      ) : null}
      {task.capabilities.manage_recurrence ? (
        <section className="card" aria-labelledby="repeat-h">
          <h2 id="repeat-h">Repeat</h2>
          <p className="hint">
            Each occurrence is a new task from today’s content: never its assignees, shares,
            history, comments, or relationships.
          </p>
          <RecurrenceEditor
            noun="task"
            cacheKey={`task-rcs:${ws}:${task.id}`}
            load={() => tasks.recurrences(ws, task.id)}
            define={(body) => tasks.child(ws, task.id, 'recurrences', body, stepUp)}
            verb={(id, v) => tasks.childVerb(ws, task.id, 'recurrences', id, v, {}, stepUp)}
          />
        </section>
      ) : null}
      {task.capabilities.save_template ? (
        <section className="card" aria-labelledby="tpl-h">
          <h2 id="tpl-h">Template</h2>
          <form
            aria-label="Save as template"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              const name = (new FormData(e.currentTarget).get('name') as string).trim();
              if (!name || saving) return;
              setSaving(true);
              void tasks
                .verb(ws, task.id, 'save_as_template', { name }, stepUp)
                .then(() =>
                  setSaid(
                    'Saved as a template. Assignees, shares, and history are never included.',
                  ),
                )
                .catch((err) => {
                  if (!(err instanceof ApiError && err.code === 'cancelled'))
                    setSaid("Couldn't save the template.");
                })
                .finally(() => setSaving(false));
            }}
          >
            <Field
              id="tpl-name"
              name="name"
              label="Template name"
              maxLength={200}
              defaultValue={task.title}
            />
            <SubmitButton busy={saving}>Save as template</SubmitButton>
          </form>
        </section>
      ) : null}
      <Announce>{said}</Announce>
    </>
  );
}

function TaskFacts({ task }: { task: Task }) {
  return (
    <section className="card" aria-labelledby="facts-heading">
      <h2 id="facts-heading">Details</h2>
      {task.description ? (
        <div className="description">
          {plainFromRichText(task.description)
            .split('\n')
            .map((l, i) => (
              <p key={i}>{l}</p>
            ))}
        </div>
      ) : null}
      <dl className="facts">
        <dt>Start</dt>
        <dd>{task.start_date ?? '—'}</dd>
        <dt>Due</dt>
        <dd>{task.due_date ?? '—'}</dd>
        <dt>Deadline</dt>
        <dd>{deadlineText(task.deadline)}</dd>
        <dt>Estimate</dt>
        <dd>
          {fmtMinutes(task.estimate_minutes)} (remaining{' '}
          {fmtMinutes(task.remaining_estimate_minutes)})
        </dd>
        <dt>Expected deliverable</dt>
        <dd>
          {task.expected_deliverable
            ? `${DELIVERABLE_LABEL[task.expected_deliverable.type]}${task.expected_deliverable.detail ? ` — ${task.expected_deliverable.detail}` : ''}${task.expected_deliverable.requires_acceptance ? ' (needs acceptance)' : ''}`
            : 'None'}
        </dd>
      </dl>
    </section>
  );
}

type Draft = Record<
  | 'title'
  | 'description'
  | 'status'
  | 'priority'
  | 'start_date'
  | 'due_date'
  | 'deadline_kind'
  | 'deadline_date'
  | 'deadline_at'
  | 'deadline_tz'
  | 'estimate_minutes'
  | 'remaining_estimate_minutes'
  | 'expected_deliverable_type'
  | 'expected_deliverable_detail'
  | 'requires_acceptance',
  string
>;
const draftOf = (t: Task): Draft => ({
  title: t.title,
  description: plainFromRichText(t.description),
  status: t.status.key,
  priority: t.priority,
  start_date: t.start_date ?? '',
  due_date: t.due_date ?? '',
  deadline_kind: !t.deadline ? 'none' : 'date' in t.deadline ? 'date' : 'instant',
  deadline_date: t.deadline && 'date' in t.deadline ? t.deadline.date : '',
  deadline_at: t.deadline && 'at' in t.deadline ? t.deadline.at.slice(0, 16) : '',
  deadline_tz:
    t.deadline && 'at' in t.deadline
      ? t.deadline.tz
      : Intl.DateTimeFormat().resolvedOptions().timeZone,
  estimate_minutes: t.estimate_minutes === null ? '' : String(t.estimate_minutes),
  remaining_estimate_minutes:
    t.remaining_estimate_minutes === null ? '' : String(t.remaining_estimate_minutes),
  expected_deliverable_type: t.expected_deliverable?.type ?? '',
  expected_deliverable_detail: t.expected_deliverable?.detail ?? '',
  requires_acceptance: t.requires_acceptance ? 'yes' : 'no',
});
const POINTERS: Record<string, string> = {
  '/changes/title': 'tf-title',
  '/changes/description': 'tf-description',
  '/changes/status': 'tf-status',
  '/changes/priority': 'tf-priority',
  '/changes/start_date': 'tf-start',
  '/changes/due_date': 'tf-due',
  '/changes/deadline': 'tf-deadline',
  '/changes/estimate_minutes': 'tf-estimate',
  '/changes/remaining_estimate_minutes': 'tf-remaining',
  '/changes/expected_deliverable_type': 'tf-deliverable',
  '/changes/expected_deliverable_detail': 'tf-deliverable-detail',
};

/** Field merge (0D §4.2): only changed fields go, with the base this form loaded. */
function TaskFieldsForm({ ws, task, onSaved }: { ws: string; task: Task; onSaved: () => void }) {
  const stepUp = useStepUp();
  const [base, setBase] = useState(task);
  const [draft, setDraft] = useState(() => draftOf(task));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const set = (k: keyof Draft) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const terminal = base.status.category === 'done' || base.status.category === 'cancelled';
  // The applicable workflow's statuses that a plain edit may choose (ADR-0015 W5).
  const statusChoices = useStatusChoices(ws, base.id, base.status, base.version, 'task');
  const valueOf = (d: Draft): Record<string, unknown> => ({
    title: d.title,
    description: richTextFromPlain(d.description),
    status: d.status,
    priority: d.priority,
    start_date: d.start_date || null,
    due_date: d.due_date || null,
    deadline:
      d.deadline_kind === 'date' && d.deadline_date
        ? { date: d.deadline_date }
        : d.deadline_kind === 'instant' && d.deadline_at
          ? { at: new Date(d.deadline_at).toISOString(), tz: d.deadline_tz }
          : null,
    estimate_minutes: d.estimate_minutes === '' ? null : Number(d.estimate_minutes),
    remaining_estimate_minutes:
      d.remaining_estimate_minutes === '' ? null : Number(d.remaining_estimate_minutes),
    expected_deliverable_type: d.expected_deliverable_type || null,
    expected_deliverable_detail: d.expected_deliverable_detail || null,
    requires_acceptance: d.requires_acceptance === 'yes',
  });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const was = valueOf(draftOf(base));
    const now = valueOf(draft);
    const changes: Record<
      string,
      { base: unknown; value: unknown } | { base_hash: string; value: unknown }
    > = {};
    for (const k of Object.keys(now)) {
      if (JSON.stringify(now[k]) === JSON.stringify(was[k])) continue;
      if (k === 'description')
        changes.description = { base_hash: await richTextHash(base.description), value: now[k] };
      else if (k === 'deadline') changes.deadline = { base: base.deadline, value: now[k] };
      else changes[k] = { base: was[k], value: now[k] };
    }
    if (!Object.keys(changes).length) return;
    setBusy(true);
    setError(null);
    setAttempt((a) => a + 1);
    try {
      const next = await tasks.update(ws, base.id, base.version, changes, stepUp);
      setBase(next);
      setDraft(draftOf(next));
      setSaved((n) => n + 1);
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const refresh = async (keepMine: boolean) => {
    setError(null);
    setBusy(true);
    try {
      const latest = await tasks.get(ws, base.id);
      setBase(latest);
      if (!keepMine) setDraft(draftOf(latest));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const { fields, other } = splitIssues(error, POINTERS);
  return (
    <section className="card" aria-labelledby="tf-heading">
      <h2 id="tf-heading">Details</h2>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <ErrorSummary
          errors={fields}
          labels={{
            'tf-title': 'Title',
            'tf-description': 'Description',
            'tf-status': 'Status',
            'tf-priority': 'Priority',
            'tf-start': 'Start date',
            'tf-due': 'Due date',
            'tf-deadline': 'Deadline',
            'tf-estimate': 'Estimate',
            'tf-remaining': 'Remaining estimate',
            'tf-deliverable': 'Expected deliverable',
            'tf-deliverable-detail': 'Deliverable detail',
          }}
          focusKey={attempt}
        />
        <Field
          id="tf-title"
          label="Title"
          required
          value={draft.title}
          onChange={(e) => set('title')(e.target.value)}
          error={fields['tf-title']}
          maxLength={300}
        />
        <TextAreaField
          id="tf-description"
          label="Description"
          value={draft.description}
          onChange={set('description')}
          error={fields['tf-description']}
          maxLength={20000}
        />
        <SelectField
          id="tf-status"
          label="Status"
          hint={
            terminal ? 'Reopen the task to change its status.' : 'Use Complete to finish the task.'
          }
          value={draft.status}
          onChange={set('status')}
          error={fields['tf-status']}
          options={terminal ? [{ value: base.status.key, label: base.status.name }] : statusChoices}
        />
        <SelectField
          id="tf-priority"
          label="Priority"
          value={draft.priority}
          onChange={set('priority')}
          error={fields['tf-priority']}
          options={PROJECT_PRIORITIES.map((x) => ({ value: x, label: PRIORITY_LABEL[x]! }))}
        />
        <Field
          id="tf-start"
          label="Start date"
          hint="The earliest planned start."
          type="date"
          value={draft.start_date}
          onChange={(e) => set('start_date')(e.target.value)}
          error={fields['tf-start']}
        />
        <Field
          id="tf-due"
          label="Due date"
          hint="When you want it done (internal)."
          type="date"
          value={draft.due_date}
          onChange={(e) => set('due_date')(e.target.value)}
          error={fields['tf-due']}
        />
        <fieldset aria-describedby="tf-deadline-hint">
          <legend id="tf-deadline">Deadline</legend>
          <p className="hint" id="tf-deadline-hint">
            An external or hard commitment. It only changes when you edit it here.
          </p>
          {fields['tf-deadline'] ? <p className="field-error">{fields['tf-deadline']}</p> : null}
          {(
            [
              ['none', 'No deadline'],
              ['date', 'A date'],
              ['instant', 'A date and time'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="choice">
              <input
                type="radio"
                name="tf-deadline-kind"
                value={value}
                checked={draft.deadline_kind === value}
                onChange={() => set('deadline_kind')(value)}
              />{' '}
              {label}
            </label>
          ))}
          {draft.deadline_kind === 'date' ? (
            <Field
              id="tf-deadline-date"
              label="Deadline date"
              type="date"
              value={draft.deadline_date}
              onChange={(e) => set('deadline_date')(e.target.value)}
            />
          ) : null}
          {draft.deadline_kind === 'instant' ? (
            <>
              <Field
                id="tf-deadline-at"
                label="Deadline date and time"
                type="datetime-local"
                value={draft.deadline_at}
                onChange={(e) => set('deadline_at')(e.target.value)}
              />
              <Field
                id="tf-deadline-tz"
                label="Deadline time zone"
                value={draft.deadline_tz}
                onChange={(e) => set('deadline_tz')(e.target.value)}
              />
            </>
          ) : null}
        </fieldset>
        <Field
          id="tf-estimate"
          label="Estimate (minutes)"
          type="number"
          inputMode="numeric"
          min={0}
          value={draft.estimate_minutes}
          onChange={(e) => set('estimate_minutes')(e.target.value)}
          error={fields['tf-estimate']}
        />
        <Field
          id="tf-remaining"
          label="Remaining estimate (minutes)"
          type="number"
          inputMode="numeric"
          min={0}
          value={draft.remaining_estimate_minutes}
          onChange={(e) => set('remaining_estimate_minutes')(e.target.value)}
          error={fields['tf-remaining']}
        />
        <SelectField
          id="tf-deliverable"
          label="Expected deliverable"
          value={draft.expected_deliverable_type}
          onChange={set('expected_deliverable_type')}
          error={fields['tf-deliverable']}
          options={[
            { value: '', label: 'None' },
            ...DELIVERABLE_TYPES.map((d) => ({ value: d, label: DELIVERABLE_LABEL[d]! })),
          ]}
        />
        {draft.expected_deliverable_type ? (
          <>
            <Field
              id="tf-deliverable-detail"
              label="Deliverable detail"
              value={draft.expected_deliverable_detail}
              onChange={(e) => set('expected_deliverable_detail')(e.target.value)}
              error={fields['tf-deliverable-detail']}
              maxLength={500}
            />
            <SelectField
              id="tf-acceptance"
              label="Needs acceptance"
              value={draft.requires_acceptance}
              onChange={set('requires_acceptance')}
              options={[
                { value: 'no', label: 'No' },
                { value: 'yes', label: 'Yes' },
              ]}
            />
          </>
        ) : null}
        <OtherIssues issues={other} />
        <SaveProblem
          error={error}
          onKeepMine={() => void refresh(true)}
          onUseLatest={() => void refresh(false)}
        />
        {saved && !error ? <Announce key={saved}>Task saved.</Announce> : null}
        <div className="actions">
          <SubmitButton busy={busy}>Save task</SubmitButton>
        </div>
      </form>
    </section>
  );
}

function CompletionControls({
  ws,
  task,
  detail,
  reload,
}: {
  ws: string;
  task: Task;
  detail: TaskDetail;
  reload: () => void;
}) {
  const stepUp = useStepUp();
  const cmd = useCommand(reload);
  const [override, setOverride] = useState<null | { reason: string; subtasks: boolean }>(null);
  const caps = task.capabilities;
  const done = task.status.category === 'done' || task.status.category === 'cancelled';
  const unmet =
    detail.criteria.filter((c) => c.required && !c.met).length +
    detail.inherited_criteria.filter((c) => c.state === 'open').length;
  const complete = (body: Record<string, unknown>) =>
    cmd
      .run(() => tasks.verb(ws, task.id, 'complete', body, stepUp), 'Task completed.')
      .then((ok) => ok && setOverride(null));
  if (!caps.complete) return null;
  const blocked =
    cmd.error instanceof ApiError
      ? cmd.error.issues.find(
          (i) => i.code === 'incomplete_subtasks' || i.code === 'criteria_incomplete',
        )
      : undefined;
  return (
    <section className="card" aria-labelledby="done-heading">
      <h2 id="done-heading">Progress</h2>
      {task.progress && task.progress.total ? (
        <p>
          {task.progress.done} of {task.progress.total} subtasks done.
        </p>
      ) : null}
      {unmet && !done ? (
        <p className="hint">
          {unmet} required {unmet === 1 ? 'item is' : 'items are'} not met.
        </p>
      ) : null}
      <p className="actions">
        {done ? (
          <button
            type="button"
            className="button button-secondary"
            disabled={cmd.busy}
            onClick={() =>
              void cmd.run(() => tasks.verb(ws, task.id, 'reopen', {}, stepUp), 'Task reopened.')
            }
          >
            Reopen
          </button>
        ) : (
          <button
            type="button"
            className="button button-primary"
            disabled={cmd.busy}
            onClick={() => void complete({})}
          >
            Complete
          </button>
        )}
        {!done && caps.override_completion && (unmet || blocked) ? (
          <button
            type="button"
            className="button button-secondary"
            onClick={() =>
              setOverride({ reason: '', subtasks: blocked?.code === 'incomplete_subtasks' })
            }
          >
            Complete anyway…
          </button>
        ) : null}
      </p>
      <SaveProblem error={cmd.error} />
      {blocked ? <p className="field-error">{blocked.message}</p> : null}
      <Announce>{cmd.said}</Announce>
      {override ? (
        <Dialog title="Complete with an override?" onClose={() => setOverride(null)} destructive>
          <p>
            The reason and the number of unmet items you can see are kept in the task's history.
          </p>
          <TextAreaField
            id="override-reason"
            label="Reason"
            value={override.reason}
            onChange={(v) => setOverride({ ...override, reason: v })}
            maxLength={500}
          />
          <p className="actions">
            <button
              type="button"
              className="button button-secondary"
              autoFocus
              onClick={() => setOverride(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-danger"
              disabled={!override.reason.trim() || cmd.busy}
              onClick={() =>
                void complete({
                  override_reason: override.reason.trim(),
                  ...(override.subtasks ? { confirm_incomplete_subtasks: true } : {}),
                })
              }
            >
              Complete anyway
            </button>
          </p>
        </Dialog>
      ) : null}
    </section>
  );
}

function CriteriaSection({
  ws,
  task,
  detail,
  reload,
}: {
  ws: string;
  task: Task;
  detail: TaskDetail;
  reload: () => void;
}) {
  const stepUp = useStepUp();
  const cmd = useCommand(reload);
  const [text, setText] = useState('');
  const [kind, setKind] = useState<'acceptance' | 'definition_of_done'>('acceptance');
  const editable = task.capabilities.edit;
  return (
    <section className="card" aria-labelledby="crit-heading">
      <h2 id="crit-heading">Acceptance criteria and definition of done</h2>
      {detail.criteria.length ? (
        <ul className="plain-list">
          {detail.criteria.map((c) => (
            <li key={c.id}>
              <label className="choice">
                <input
                  type="checkbox"
                  checked={c.met}
                  disabled={!editable || cmd.busy}
                  onChange={(e) =>
                    void cmd.run(
                      () =>
                        tasks.patchChild(
                          ws,
                          task.id,
                          'criteria',
                          c.id,
                          { met: e.target.checked },
                          stepUp,
                          c.version,
                        ),
                      e.target.checked ? 'Marked as met.' : 'Marked as not met.',
                    )
                  }
                />{' '}
                {c.text}{' '}
                <span className="hint">
                  {c.kind === 'acceptance' ? 'Acceptance' : 'Definition of done'}
                  {c.required ? '' : ' · optional'}
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p>No criteria on this task.</p>
      )}
      {detail.inherited_criteria.length ? (
        <>
          <h3>From the project's definition of done</h3>
          <ul className="plain-list">
            {detail.inherited_criteria.map((c) => (
              <li key={c.id}>
                {c.text}{' '}
                <span className="badge">
                  {c.state === 'open'
                    ? 'Not met'
                    : c.state === 'met'
                      ? 'Met'
                      : 'Dismissed for this task'}
                </span>
                {task.capabilities.edit_context ? (
                  <span className="actions-compact">
                    {(['met', 'dismissed', 'open'] as const)
                      .filter((s) => s !== c.state)
                      .map((s) => (
                        <button
                          key={s}
                          type="button"
                          className="button button-ghost"
                          disabled={cmd.busy}
                          onClick={() =>
                            void cmd.run(
                              () =>
                                tasks.child(
                                  ws,
                                  task.id,
                                  `inherited-criteria/${c.id}`,
                                  { state: s },
                                  stepUp,
                                ),
                              'Saved.',
                            )
                          }
                        >
                          {s === 'met'
                            ? 'Mark met'
                            : s === 'dismissed'
                              ? 'Dismiss for this task'
                              : 'Reopen'}
                          <span className="visually-hidden"> {c.text}</span>
                        </button>
                      ))}
                  </span>
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
                () => tasks.child(ws, task.id, 'criteria', { kind, text }, stepUp),
                'Criterion added.',
              )
              .then((ok) => ok && setText(''));
          }}
        >
          <SelectField
            id="new-crit-kind"
            label="Kind"
            value={kind}
            onChange={(v) => setKind(v as typeof kind)}
            options={[
              { value: 'acceptance', label: 'Acceptance criterion' },
              { value: 'definition_of_done', label: 'Definition of done' },
            ]}
          />
          <Field
            id="new-crit"
            label="Criterion"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={500}
          />
          <button
            type="submit"
            className="button button-secondary"
            disabled={!text.trim() || cmd.busy}
          >
            Add criterion
          </button>
        </form>
      ) : null}
      <SaveProblem error={cmd.error} />
      <Announce>{cmd.said}</Announce>
    </section>
  );
}

function ChecklistSection({
  ws,
  task,
  detail,
  reload,
}: {
  ws: string;
  task: Task;
  detail: TaskDetail;
  reload: () => void;
}) {
  const stepUp = useStepUp();
  const cmd = useCommand(reload);
  const [text, setText] = useState('');
  const editable = task.capabilities.edit;
  const items = detail.checklist;
  return (
    <section className="card" aria-labelledby="chk-heading">
      <h2 id="chk-heading">
        Checklist{' '}
        {items.length ? (
          <span className="hint">
            ({items.filter((i) => i.done).length} of {items.length})
          </span>
        ) : null}
      </h2>
      {items.length ? (
        <ul className="plain-list">
          {items.map((c, i) => (
            <li key={c.id}>
              <label className="choice">
                <input
                  type="checkbox"
                  checked={c.done}
                  disabled={!editable || cmd.busy}
                  onChange={(e) =>
                    void cmd.run(
                      () =>
                        tasks.patchChild(
                          ws,
                          task.id,
                          'checklist',
                          c.id,
                          { done: e.target.checked },
                          stepUp,
                          c.version,
                        ),
                      e.target.checked ? 'Item done.' : 'Item not done.',
                    )
                  }
                />{' '}
                {c.text}
              </label>
              {editable ? (
                <span className="actions-compact">
                  <button
                    type="button"
                    className="button button-ghost"
                    disabled={i === 0 || cmd.busy}
                    onClick={() =>
                      void cmd.run(
                        () =>
                          tasks.childVerb(
                            ws,
                            task.id,
                            'checklist',
                            c.id,
                            'move',
                            { after: i >= 2 ? items[i - 2]!.id : null },
                            stepUp,
                          ),
                        'Moved up.',
                      )
                    }
                  >
                    Move up<span className="visually-hidden"> {c.text}</span>
                  </button>
                  <button
                    type="button"
                    className="button button-ghost"
                    disabled={i === items.length - 1 || cmd.busy}
                    onClick={() =>
                      void cmd.run(
                        () =>
                          tasks.childVerb(
                            ws,
                            task.id,
                            'checklist',
                            c.id,
                            'move',
                            { after: items[i + 1]!.id },
                            stepUp,
                          ),
                        'Moved down.',
                      )
                    }
                  >
                    Move down<span className="visually-hidden"> {c.text}</span>
                  </button>
                  <button
                    type="button"
                    className="button button-ghost"
                    disabled={cmd.busy}
                    onClick={() =>
                      void cmd.run(
                        () => tasks.deleteChild(ws, task.id, 'checklist', c.id, stepUp),
                        'Item removed.',
                      )
                    }
                  >
                    Remove<span className="visually-hidden"> {c.text}</span>
                  </button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p>No checklist items.</p>
      )}
      {editable ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void cmd
              .run(() => tasks.child(ws, task.id, 'checklist', { text }, stepUp), 'Item added.')
              .then((ok) => ok && setText(''));
          }}
        >
          <Field
            id="new-chk"
            label="Add a checklist item"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={500}
          />
          <button
            type="submit"
            className="button button-secondary"
            disabled={!text.trim() || cmd.busy}
          >
            Add item
          </button>
        </form>
      ) : null}
      <SaveProblem error={cmd.error} />
      <Announce>{cmd.said}</Announce>
    </section>
  );
}

function SubtasksSection({
  ws,
  task,
  detail,
  reload,
}: {
  ws: string;
  task: Task;
  detail: TaskDetail;
  reload: () => void;
}) {
  const stepUp = useStepUp();
  const cmd = useCommand(reload);
  const [title, setTitle] = useState('');
  return (
    <section className="card" aria-labelledby="sub-heading">
      <h2 id="sub-heading">Subtasks</h2>
      {detail.subtasks.length ? (
        <ul>
          {detail.subtasks.map((s) => (
            <li key={s.id}>
              <Link to={routeHref('task', { ws, tsk: s.id })}>{s.title}</Link>{' '}
              <StatusBadge status={s.status} />
            </li>
          ))}
        </ul>
      ) : (
        <p>No subtasks.</p>
      )}
      {task.capabilities.create_subtask ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void cmd
              .run(() => tasks.create(ws, { parent: task.id, title }, stepUp), 'Subtask added.')
              .then((ok) => ok && setTitle(''));
          }}
        >
          <Field
            id="new-sub"
            label="Add a subtask"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={300}
          />
          <button
            type="submit"
            className="button button-secondary"
            disabled={!title.trim() || cmd.busy}
          >
            Add subtask
          </button>
        </form>
      ) : null}
      <SaveProblem error={cmd.error} />
      <Announce>{cmd.said}</Announce>
    </section>
  );
}

function PeopleAndLabels({ ws, task, reload }: { ws: string; task: Task; reload: () => void }) {
  const stepUp = useStepUp();
  const cmd = useCommand(reload);
  const editable = task.capabilities.edit_context;
  const people = useResource(
    () => collab.people(ws).catch(() => [] as Member[]),
    editable ? `people:${ws}` : 'wait',
  );
  const labels = useResource(
    () => tasks.labels(ws, task.brand.kind === 'brand' ? task.brand.id : ''),
    editable && task.brand.kind === 'brand'
      ? `labels:${ws}:${task.brand.kind === 'brand' ? task.brand.id : ''}`
      : 'wait',
  );
  const [assignee, setAssignee] = useState('');
  const [label, setLabel] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const current = task.assignees.map((a) => a.id);
  const primary = task.assignees.find((a) => a.primary)?.id ?? null;
  const assign = (list: string[], p: string | null, message: string) =>
    void cmd.run(
      () =>
        tasks.verb(
          ws,
          task.id,
          'assign',
          { assignees: list, primary: p && list.includes(p) ? p : null, version: task.version },
          stepUp,
        ),
      message,
    );
  const members = (people.state.status === 'ready' ? people.state.data : []).filter(
    (m) => m.kind === 'member' && m.state === 'active',
  );
  return (
    <section className="card" aria-labelledby="people-heading">
      <h2 id="people-heading">People and labels</h2>
      <p className="hint">Assigning someone makes them responsible. It never gives them access.</p>
      {task.assignees.length ? (
        <ul className="plain-list">
          {task.assignees.map((a) => (
            <li key={a.id}>
              {a.name} {a.primary ? <span className="badge">Primary</span> : null}
              {editable ? (
                <span className="actions-compact">
                  {!a.primary ? (
                    <button
                      type="button"
                      className="button button-ghost"
                      disabled={cmd.busy}
                      onClick={() => assign(current, a.id, `${a.name} is the primary assignee.`)}
                    >
                      Make primary<span className="visually-hidden"> {a.name}</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="button button-ghost"
                    disabled={cmd.busy}
                    onClick={() =>
                      assign(
                        current.filter((x) => x !== a.id),
                        primary === a.id ? null : primary,
                        `${a.name} unassigned.`,
                      )
                    }
                  >
                    Unassign<span className="visually-hidden"> {a.name}</span>
                  </button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p>Unassigned.</p>
      )}
      {editable ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (assignee)
              assign(
                [...current, assignee],
                primary ?? (current.length ? null : assignee),
                'Assigned.',
              );
          }}
        >
          <SelectField
            id="new-assignee"
            label="Assign someone"
            value={assignee}
            onChange={setAssignee}
            options={[
              { value: '', label: 'Choose a person' },
              ...members
                .filter((m) => !current.includes(m.id))
                .map((m) => ({ value: m.id, label: m.display_name })),
            ]}
          />
          <button
            type="submit"
            className="button button-secondary"
            disabled={!assignee || cmd.busy}
          >
            Assign
          </button>
        </form>
      ) : null}
      <h3>Labels</h3>
      {task.labels.length ? (
        <ul className="plain-list">
          {task.labels.map((l) => (
            <li key={l.id ?? l.name}>
              <span className="badge" style={{ borderColor: l.color }}>
                {l.name}
                {l.archived ? ' (archived)' : ''}
              </span>
              {editable && l.id ? (
                <button
                  type="button"
                  className="button button-ghost"
                  disabled={cmd.busy}
                  onClick={() =>
                    void cmd.run(
                      () => tasks.deleteChild(ws, task.id, 'labels', l.id!, stepUp),
                      'Label removed.',
                    )
                  }
                >
                  Remove<span className="visually-hidden"> label {l.name}</span>
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p>No labels.</p>
      )}
      {editable && labels.state.status === 'ready' ? (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (label)
                void cmd
                  .run(() => tasks.child(ws, task.id, 'labels', { label }, stepUp), 'Label added.')
                  .then((ok) => ok && setLabel(''));
            }}
          >
            <SelectField
              id="new-label"
              label="Add a label"
              value={label}
              onChange={setLabel}
              options={[
                { value: '', label: 'Choose a label' },
                ...labels.state.data
                  .filter((l) => !task.labels.some((x) => x.id === l.id))
                  .map((l) => ({ value: l.id, label: l.name })),
              ]}
            />
            <button type="submit" className="button button-secondary" disabled={!label || cmd.busy}>
              Add label
            </button>
          </form>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (task.brand.kind !== 'brand') return;
              const brand = task.brand.id;
              void cmd
                .run(async () => {
                  const l = await tasks.createLabel(
                    ws,
                    brand,
                    {
                      name: newLabel,
                      color: LABEL_COLORS[task.labels.length % LABEL_COLORS.length],
                    },
                    stepUp,
                  );
                  await tasks.child(ws, task.id, 'labels', { label: l.id }, stepUp);
                  labels.reload();
                }, 'Label created and added.')
                .then((ok) => ok && setNewLabel(''));
            }}
          >
            <Field
              id="create-label"
              label="Create a label for this brand"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              maxLength={60}
            />
            <button
              type="submit"
              className="button button-secondary"
              disabled={!newLabel.trim() || cmd.busy}
            >
              Create label
            </button>
          </form>
        </>
      ) : null}
      <SaveProblem error={cmd.error} />
      <Announce>{cmd.said}</Announce>
    </section>
  );
}

function LinksSection({
  ws,
  task,
  detail,
  reload,
}: {
  ws: string;
  task: Task;
  detail: TaskDetail;
  reload: () => void;
}) {
  const stepUp = useStepUp();
  const cmd = useCommand(reload);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const { fields } = splitIssues(cmd.error, { '/url': 'new-link-url' });
  return (
    <section className="card" aria-labelledby="links-heading">
      <h2 id="links-heading">Links</h2>
      {detail.links.length ? (
        <ul className="plain-list">
          {detail.links.map((l) => (
            <li key={l.id}>
              {l.kind === 'url' ? (
                <a href={l.url} rel="noopener noreferrer nofollow" target="_blank">
                  {l.title ?? l.url}
                  <span className="visually-hidden"> (opens in a new tab)</span>
                </a>
              ) : (
                <span>{l.title ?? l.record.id}</span>
              )}
              {task.capabilities.edit_context ? (
                <button
                  type="button"
                  className="button button-ghost"
                  disabled={cmd.busy}
                  onClick={() =>
                    void cmd.run(
                      () => tasks.deleteChild(ws, task.id, 'links', l.id, stepUp),
                      'Link removed.',
                    )
                  }
                >
                  Remove<span className="visually-hidden"> link {l.title ?? ''}</span>
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p>No links.</p>
      )}
      {task.capabilities.edit_context ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void cmd
              .run(
                () =>
                  tasks.child(
                    ws,
                    task.id,
                    'links',
                    { url, ...(title.trim() ? { title: title.trim() } : {}) },
                    stepUp,
                  ),
                'Link added.',
              )
              .then((ok) => ok && (setUrl(''), setTitle('')));
          }}
          noValidate
        >
          <Field
            id="new-link-url"
            label="Web address"
            hint="https:// links only."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            error={fields['new-link-url']}
            maxLength={2048}
          />
          <Field
            id="new-link-title"
            label="Title (optional)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
          />
          <button
            type="submit"
            className="button button-secondary"
            disabled={!url.trim() || cmd.busy}
          >
            Add link
          </button>
        </form>
      ) : null}
      {!Object.keys(fields).length ? <SaveProblem error={cmd.error} /> : null}
      <Announce>{cmd.said}</Announce>
    </section>
  );
}

function RelationshipsSection({
  ws,
  task,
  detail,
  reload,
}: {
  ws: string;
  task: Task;
  detail: TaskDetail;
  reload: () => void;
}) {
  const stepUp = useStepUp();
  const cmd = useCommand(reload);
  const [kind, setKind] = useState<'blocks' | 'blocked_by' | 'related'>('blocked_by');
  const [target, setTarget] = useState('');
  const candidates = useResource(
    () =>
      tasks.list(ws, {
        ...(task.project ? { project: task.project.id } : { projectless: 'true' }),
        limit: '200',
      }),
    task.capabilities.relate ? `rel:${ws}:${task.id}` : 'wait',
  );
  const groups = [
    ['blocked_by', 'Waiting on'],
    ['blocks', 'Blocks'],
    ['related', 'Related'],
  ] as const;
  return (
    <section className="card" aria-labelledby="rel-heading">
      <h2 id="rel-heading">Dependencies and related tasks</h2>
      {groups.every(([k]) => !detail.relationships[k].length) ? (
        <p>No dependencies or related tasks you can see.</p>
      ) : null}
      {groups.map(([k, label]) =>
        detail.relationships[k].length ? (
          <div key={k}>
            <h3>{label}</h3>
            <ul className="plain-list">
              {detail.relationships[k].map((r) => (
                <li key={r.id}>
                  <BrandMarker marker={r.brand} size={16} />{' '}
                  <Link to={routeHref('task', { ws, tsk: r.id })}>{r.title}</Link>{' '}
                  <StatusBadge status={r.status} />
                  {task.capabilities.relate ? (
                    <button
                      type="button"
                      className="button button-ghost"
                      disabled={cmd.busy}
                      onClick={() =>
                        void cmd.run(
                          () => tasks.deleteChild(ws, task.id, `relationships/${k}`, r.id, stepUp),
                          'Removed.',
                        )
                      }
                    >
                      Remove<span className="visually-hidden"> {r.title}</span>
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
      {task.capabilities.relate && candidates.state.status === 'ready' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (target)
              void cmd
                .run(
                  () => tasks.child(ws, task.id, 'relationships', { kind, target }, stepUp),
                  'Added.',
                )
                .then((ok) => ok && setTarget(''));
          }}
        >
          <SelectField
            id="new-rel-kind"
            label="Relationship"
            value={kind}
            onChange={(v) => setKind(v as typeof kind)}
            options={[
              { value: 'blocked_by', label: 'This task waits on' },
              { value: 'blocks', label: 'This task blocks' },
              { value: 'related', label: 'Related to' },
            ]}
          />
          <SelectField
            id="new-rel-target"
            label="Task"
            value={target}
            onChange={setTarget}
            options={[
              { value: '', label: 'Choose a task' },
              ...candidates.state.data.data
                .filter((x) => x.id !== task.id)
                .map((x) => ({ value: x.id, label: x.title })),
            ]}
          />
          <button type="submit" className="button button-secondary" disabled={!target || cmd.busy}>
            Add
          </button>
        </form>
      ) : null}
      <SaveProblem error={cmd.error} />
      <Announce>{cmd.said}</Announce>
    </section>
  );
}

function HistorySection({ ws, task }: { ws: string; task: Task }) {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const data = useResource(
    () => tasks.history(ws, task.id, cursor),
    `history:${ws}:${task.id}:${task.version}:${cursor ?? ''}`,
  );
  return (
    <section className="card" aria-labelledby="hist-heading">
      <h2 id="hist-heading">History</h2>
      <ResourceView resource={data.state} onRetry={data.retry} what="history">
        {(h) => (
          <>
            <ol className="plain-list history-list">
              {h.data.map((e) => (
                <li key={e.key}>
                  <strong>{e.action.replace('.', ' ').replace(/_/g, ' ')}</strong>{' '}
                  <span className="hint">
                    {new Date(e.at).toLocaleString()}
                    {e.actor.name ? ` · ${e.actor.name}` : ''}
                  </span>
                  {e.changes.length ? (
                    <ul>
                      {e.changes.map((c, i) => (
                        <li key={i}>
                          {c.field.replace(/_/g, ' ')}
                          {c.changed
                            ? ' changed'
                            : `: ${c.before === null || c.before === undefined ? '—' : String(c.before)} → ${c.after === null || c.after === undefined ? '—' : String(c.after)}`}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ol>
            {h.page.has_more ? (
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setCursor(h.page.next_cursor)}
              >
                Older history
              </button>
            ) : null}
          </>
        )}
      </ResourceView>
    </section>
  );
}

function TaskManageSection({ ws, task, reload }: { ws: string; task: Task; reload: () => void }) {
  const stepUp = useStepUp();
  const { navigate } = useRouter();
  const cmd = useCommand(reload);
  const caps = task.capabilities;
  const [confirm, setConfirm] = useState<null | 'trash' | 'move_brand' | 'share'>(null);
  const [subtree, setSubtree] = useState(false);
  const people = useResource(
    () => collab.people(ws).catch(() => [] as Member[]),
    caps.share ? `people:${ws}` : 'wait',
  );
  const [share, setShare] = useState({ grantee: '', level: 'view' });
  const life = (verb: string, message: string) =>
    cmd.run(
      () => tasks.verb(ws, task.id, verb, { include_subtasks: subtree }, stepUp, task.version),
      message,
    );
  return (
    <section className="card" aria-labelledby="manage-heading">
      <h2 id="manage-heading">Move, share, and delete</h2>
      {caps.trash || caps.archive ? (
        <label className="choice">
          <input type="checkbox" checked={subtree} onChange={(e) => setSubtree(e.target.checked)} />{' '}
          Include its subtasks
        </label>
      ) : null}
      <p className="actions">
        {caps.archive ? (
          <button
            type="button"
            className="button button-secondary"
            disabled={cmd.busy}
            onClick={() => void life('archive', 'Task archived.')}
          >
            Archive task
          </button>
        ) : null}
        {caps.restore ? (
          <button
            type="button"
            className="button button-secondary"
            disabled={cmd.busy}
            onClick={() => void life('unarchive', 'Task restored.')}
          >
            Restore task
          </button>
        ) : null}
        <button
          type="button"
          className="button button-secondary"
          disabled={cmd.busy}
          onClick={() =>
            void cmd.run(async () => {
              const d = await tasks.verb<{ id: string }>(
                ws,
                task.id,
                'duplicate',
                { include_subtasks: subtree },
                stepUp,
              );
              navigate(routeHref('task', { ws, tsk: d.id }));
            }, 'Task duplicated.')
          }
        >
          Duplicate
        </button>
        {caps.move_brand ? (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setConfirm('move_brand')}
          >
            Move to another brand…
          </button>
        ) : null}
        {caps.share ? (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setConfirm('share')}
          >
            Share this task…
          </button>
        ) : null}
        {caps.trash ? (
          <button
            type="button"
            className="button button-danger"
            onClick={() => setConfirm('trash')}
          >
            Move to trash…
          </button>
        ) : null}
      </p>
      <p className="hint">
        Sharing gives one person this task, its checklist, and its criteria. Its subtasks, project,
        dependencies, and history are never included.
      </p>
      <SaveProblem error={cmd.error} />
      <Announce>{cmd.said}</Announce>
      {confirm === 'trash' ? (
        <Dialog title={`Move ${task.title} to trash?`} onClose={() => setConfirm(null)} destructive>
          <p>
            {subtree ? 'Its subtasks move to the trash too.' : 'Its subtasks stay where they are.'}{' '}
            You can restore it from the trash during the recovery period.
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
                void life('trash', 'Task moved to trash.').then(
                  (ok) =>
                    ok &&
                    navigate(
                      task.project
                        ? routeHref('project_section', {
                            ws,
                            prj: task.project.id,
                            section: 'tasks',
                          })
                        : routeHref('tasks', { ws }),
                    ),
                )
              }
            >
              Move to trash
            </button>
          </p>
        </Dialog>
      ) : null}
      {confirm === 'move_brand' ? (
        <BrandMoveDialog
          ws={ws}
          task={task}
          onClose={() => setConfirm(null)}
          onDone={() => {
            setConfirm(null);
            reload();
          }}
        />
      ) : null}
      {confirm === 'share' ? (
        share.grantee ? (
          <ReviewedChange
            ws={ws}
            change={{
              kind: 'record_share',
              record: task.id,
              grantee: share.grantee,
              level: share.level,
              expires_at: null,
            }}
            title={`Share ${task.title}?`}
            confirmLabel="Share"
            onCancel={() => {
              setConfirm(null);
              setShare({ grantee: '', level: 'view' });
            }}
            onDone={() => {
              setConfirm(null);
              setShare({ grantee: '', level: 'view' });
              reload();
            }}
          />
        ) : (
          <Dialog title={`Share ${task.title}`} onClose={() => setConfirm(null)}>
            <SelectField
              id="share-person"
              label="Share with"
              value={share.grantee}
              onChange={(v) => setShare({ ...share, grantee: v })}
              options={[
                { value: '', label: 'Choose a person' },
                ...(people.state.status === 'ready' ? people.state.data : [])
                  .filter((m) => m.state === 'active')
                  .map((m) => ({ value: m.id, label: m.display_name })),
              ]}
            />
            <SelectField
              id="share-level"
              label="They can"
              value={share.level}
              onChange={(v) => setShare({ ...share, level: v })}
              options={[
                { value: 'view', label: 'View' },
                { value: 'comment', label: 'Comment' },
                { value: 'edit', label: 'Edit' },
              ]}
            />
            <p className="actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setConfirm(null)}
              >
                Cancel
              </button>
            </p>
          </Dialog>
        )
      ) : null}
    </section>
  );
}

/** Cross-brand move (OD-02): choose, preview the exposure, confirm; a stale preview is refused. */
function BrandMoveDialog({
  ws,
  task,
  onClose,
  onDone,
}: {
  ws: string;
  task: Task;
  onClose: () => void;
  onDone: () => void;
}) {
  const stepUp = useStepUp();
  const brands = useResource(() => tenancy.listBrands(ws, 'active'), `brands:${ws}`);
  const [brand, setBrand] = useState('');
  const [project, setProject] = useState('');
  const projects = useResource(
    async () => (await import('../projects/client.ts')).projects.list(ws, { brands: [brand] }),
    brand ? `prj:${ws}:${brand}` : 'wait',
  );
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof tasks.preview>> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const body = useMemo(() => ({ brand, ...(project ? { project } : {}) }), [brand, project]);
  const review = async () => {
    setError(null);
    try {
      setPreview(await tasks.preview(ws, task.id, body));
    } catch (err) {
      setError(err);
    }
  };
  const apply = async () => {
    if (!preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      await tasks.verb(
        ws,
        task.id,
        'move_brand',
        { ...body, preview_token: preview.preview_token },
        stepUp,
      );
      onDone();
    } catch (err) {
      setPreview(null);
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const { other } = splitIssues(error, {});
  return (
    <Dialog title={`Move ${task.title} to another brand`} onClose={onClose} destructive>
      {brands.state.status === 'ready' ? (
        <SelectField
          id="move-brand"
          label="Destination brand"
          value={brand}
          onChange={(v) => {
            setBrand(v);
            setProject('');
            setPreview(null);
          }}
          options={[
            { value: '', label: 'Choose a brand' },
            ...brands.state.data.data
              .filter((b) => task.brand.kind !== 'brand' || b.id !== task.brand.id)
              .map((b) => ({ value: b.id, label: b.name })),
          ]}
        />
      ) : null}
      {brand && projects.state.status === 'ready' ? (
        <SelectField
          id="move-project"
          label={task.project ? 'Destination project (required)' : 'Destination project (optional)'}
          value={project}
          onChange={(v) => {
            setProject(v);
            setPreview(null);
          }}
          options={[
            { value: '', label: 'No project' },
            ...projects.state.data.data.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
      ) : null}
      {preview ? (
        <Banner tone="warning" title="Review what changes">
          <ul>
            <li>
              {preview.tasks} {preview.tasks === 1 ? 'task moves' : 'tasks move'} (with its
              subtasks).
            </li>
            <li>
              {preview.members_gaining} people gain access; {preview.members_losing} lose access.
            </li>
            {preview.assignees_losing_access ? (
              <li>{preview.assignees_losing_access} assignees will no longer be able to see it.</li>
            ) : null}
            {preview.omitted.labels ? (
              <li>{preview.omitted.labels} labels are removed (labels belong to one brand).</li>
            ) : null}
          </ul>
        </Banner>
      ) : null}
      <OtherIssues issues={other} />
      <SaveProblem error={error} />
      <p className="actions">
        <button type="button" className="button button-secondary" autoFocus onClick={onClose}>
          Cancel
        </button>
        {preview ? (
          <button
            type="button"
            className="button button-danger"
            disabled={busy}
            onClick={() => void apply()}
          >
            Move to this brand
          </button>
        ) : (
          <button
            type="button"
            className="button button-secondary"
            disabled={!brand}
            onClick={() => void review()}
          >
            Review move
          </button>
        )}
      </p>
    </Dialog>
  );
}
