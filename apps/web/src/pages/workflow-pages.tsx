import { useState, type FormEvent } from 'react';
import { ApiError } from '../api.ts';
import { projects } from '../projects/client.ts';
import { Link, useRouter } from '../router.tsx';
import { routeHref } from '../shell/registry.ts';
import { useStepUp } from '../stepup.tsx';
import { collab, tenancy, type Member } from '../tenancy/client.ts';
import { ResourceView, useResource } from '../tenancy/resource.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Announce, Banner } from '../ui/feedback.tsx';
import { Field, SelectField, TextAreaField } from '../ui/form.tsx';
import { Page } from '../ui/layout.tsx';
import {
  approvals,
  FIELD_TYPE_LABEL,
  fields,
  fieldSets,
  workflows,
  type Category,
  type FieldDefinition,
  type FieldType,
  type Workflow,
} from '../workflow/client.ts';
import { RecordLink } from '../workflow/record-workflow.tsx';

/**
 * Workflow and field administration (0E Phase 2C note): one page per concern at a scope chosen
 * with `?scope=` (workspace, `brand:br_…`, `project:prj_…`). Every reorder and connection is a
 * button or a form; there are no drag-only builders.
 */

const CATEGORIES: Array<{ value: Category; label: string }> = [
  { value: 'planned', label: 'Planned' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
];
const BUILTINS: Record<'task' | 'project', Array<{ key: string; label: string }>> = {
  task: [
    { key: 'description', label: 'Description' },
    { key: 'priority', label: 'Priority' },
    { key: 'start_date', label: 'Start date' },
    { key: 'due_date', label: 'Due date' },
    { key: 'deadline', label: 'Deadline' },
    { key: 'estimate_minutes', label: 'Estimate' },
    { key: 'remaining_estimate_minutes', label: 'Remaining estimate' },
    { key: 'assignees', label: 'Assignees' },
    { key: 'labels', label: 'Labels' },
    { key: 'expected_deliverable_type', label: 'Expected deliverable' },
  ],
  project: [
    { key: 'description', label: 'Description' },
    { key: 'priority', label: 'Priority' },
    { key: 'start_date', label: 'Start date' },
    { key: 'target_date', label: 'Target date' },
    { key: 'owner', label: 'Owner' },
    { key: 'health', label: 'Health' },
    { key: 'budget', label: 'Budget' },
  ],
};

const message = (e: unknown) =>
  e instanceof ApiError
    ? e.issues.map((i) => i.message).join(' ') ||
      (e.code === 'forbidden'
        ? 'You do not manage this scope.'
        : e.code === 'conflict'
          ? 'This changed since you loaded it. Reload and try again.'
          : 'Something went wrong.')
    : "You're offline or the server is unavailable. Try again.";

function useScope(): [string, (s: string) => void] {
  const { path, search, navigate } = useRouter();
  const scope = search.get('scope') ?? 'workspace';
  return [scope, (s) => navigate(`${path}?scope=${encodeURIComponent(s)}`)];
}

function ScopePicker({
  ws,
  scope,
  onChange,
}: {
  ws: string;
  scope: string;
  onChange: (s: string) => void;
}) {
  const b = useResource(() => tenancy.listBrands(ws, 'active'), `brands:${ws}`);
  const p = useResource(() => projects.list(ws, { limit: '200' } as never), `scope-projects:${ws}`);
  const options = [
    { value: 'workspace', label: 'Whole workspace' },
    ...(b.state.status === 'ready'
      ? b.state.data.data.map((x) => ({ value: `brand:${x.id}`, label: `Brand: ${x.name}` }))
      : []),
    ...(p.state.status === 'ready'
      ? p.state.data.data.map((x) => ({ value: `project:${x.id}`, label: `Project: ${x.name}` }))
      : []),
  ];
  if (!options.some((o) => o.value === scope)) options.push({ value: scope, label: 'This scope' });
  return (
    <SelectField
      id="scope"
      label="Scope"
      hint="More specific scopes override broader ones: project, then brand, then workspace."
      value={scope}
      onChange={onChange}
      options={options}
    />
  );
}

function useRunner(reload: () => void) {
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      await fn();
      setSaid(done);
      reload();
      return true;
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'cancelled')) setError(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { error, said, busy, run };
}

// -----------------------------------------------------------------------------------------------
// Workflows
// -----------------------------------------------------------------------------------------------

export function WorkflowsPage({ ws }: { ws: string }) {
  const [scope, setScope] = useScope();
  const data = useResource(() => workflows.list(ws, scope, true), `workflows:${ws}:${scope}`);
  return (
    <Page title="Workflows" wide>
      <p>
        <Link to={routeHref('approvals', { ws })}>Pending approvals</Link>
      </p>
      <ScopePicker ws={ws} scope={scope} onChange={setScope} />
      <ResourceView resource={data.state} onRetry={data.retry} what="workflows">
        {(d) => (
          <>
            {(['task', 'project'] as const).map((kind) => {
              const here = d.data.filter((x) => x.record_kind === kind);
              const applies = d.applies[kind];
              return (
                <section key={kind} className="card" aria-labelledby={`wf-${kind}`}>
                  <h2 id={`wf-${kind}`}>
                    {kind === 'task' ? 'Task workflow' : 'Project workflow'}
                  </h2>
                  {!here.some((x) => x.state === 'active') ? (
                    <p>
                      {applies
                        ? `The ${applies.name} workflow (${applies.scope_kind}) applies here.`
                        : 'The default workflow applies here.'}
                    </p>
                  ) : null}
                  {here.map((wf) => (
                    <WorkflowEditor key={wf.id} ws={ws} wf={wf} reload={data.reload} />
                  ))}
                  {!here.some((x) => x.state === 'active') ? (
                    <NewWorkflow ws={ws} scope={scope} kind={kind} reload={data.reload} />
                  ) : null}
                </section>
              );
            })}
          </>
        )}
      </ResourceView>
    </Page>
  );
}

function NewWorkflow({
  ws,
  scope,
  kind,
  reload,
}: {
  ws: string;
  scope: string;
  kind: 'task' | 'project';
  reload: () => void;
}) {
  const stepUp = useStepUp();
  const r = useRunner(reload);
  const starter =
    kind === 'task'
      ? [
          { name: 'To do', category: 'planned' as Category },
          { name: 'In progress', category: 'active' as Category },
          { name: 'Done', category: 'done' as Category },
        ]
      : [
          { name: 'Planned', category: 'planned' as Category },
          { name: 'Active', category: 'active' as Category },
          { name: 'Completed', category: 'done' as Category },
        ];
  const [name, setName] = useState('');
  const [rows, setRows] = useState(starter);
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button type="button" className="button button-secondary" onClick={() => setOpen(true)}>
        Create a {kind} workflow here
      </button>
    );
  const move = (i: number, d: -1 | 1) =>
    setRows((x) => {
      const n = [...x];
      [n[i], n[i + d]] = [n[i + d]!, n[i]!];
      return n;
    });
  return (
    <form
      aria-label={`New ${kind} workflow`}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void r.run(
          () => workflows.create(ws, { scope, record_kind: kind, name, statuses: rows }, stepUp),
          'Workflow created.',
        );
      }}
      noValidate
    >
      <Field
        id={`nw-${kind}-name`}
        label="Workflow name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={80}
        required
      />
      <fieldset>
        <legend>Statuses (in order)</legend>
        {rows.map((s, i) => (
          <div key={i} className="inline-form">
            <Field
              id={`nw-${kind}-s${i}`}
              label={`Status ${i + 1} name`}
              value={s.name}
              onChange={(e) =>
                setRows((x) => x.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))
              }
              maxLength={60}
            />
            <SelectField
              id={`nw-${kind}-c${i}`}
              label={`Status ${i + 1} category`}
              value={s.category}
              onChange={(v) =>
                setRows((x) => x.map((y, j) => (j === i ? { ...y, category: v as Category } : y)))
              }
              options={CATEGORIES}
            />
            <button
              type="button"
              className="button button-ghost"
              disabled={i === 0}
              onClick={() => move(i, -1)}
            >
              Move up<span className="visually-hidden"> status {i + 1}</span>
            </button>
            <button
              type="button"
              className="button button-ghost"
              disabled={i === rows.length - 1}
              onClick={() => move(i, 1)}
            >
              Move down<span className="visually-hidden"> status {i + 1}</span>
            </button>
            <button
              type="button"
              className="button button-ghost"
              disabled={rows.length <= 2}
              onClick={() => setRows((x) => x.filter((_, j) => j !== i))}
            >
              Remove<span className="visually-hidden"> status {i + 1}</span>
            </button>
          </div>
        ))}
        <button
          type="button"
          className="button button-secondary"
          onClick={() => setRows((x) => [...x, { name: '', category: 'active' }])}
        >
          Add a status
        </button>
      </fieldset>
      {r.error ? (
        <Banner tone="danger" title="Not created">
          {r.error}
        </Banner>
      ) : null}
      <p className="actions">
        <button type="button" className="button button-secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={r.busy}>
          Create workflow
        </button>
      </p>
      <Announce>{r.said}</Announce>
    </form>
  );
}

function WorkflowEditor({ ws, wf, reload }: { ws: string; wf: Workflow; reload: () => void }) {
  const stepUp = useStepUp();
  const r = useRunner(reload);
  const [newStatus, setNewStatus] = useState({ name: '', category: 'active' as Category });
  const [rename, setRename] = useState<null | { id: string; name: string; color: string }>(null);
  const [migrate, setMigrate] = useState<null | { id: string; to: string }>(null);
  const nameOf = (key: string) => wf.statuses.find((s) => s.id === key)?.name ?? key;
  const active = wf.statuses.filter((s) => s.state === 'active');
  return (
    <div className="card" aria-label={`${wf.name} workflow`}>
      <h3>
        {wf.name} {wf.state === 'archived' ? <span className="badge">Archived</span> : null}
      </h3>
      <h4>Statuses</h4>
      <ol className="plain-list">
        {wf.statuses.map((s, i) => (
          <li key={s.id}>
            <span className="badge" style={{ borderColor: s.color ?? undefined }}>
              {s.name}
            </span>{' '}
            <span className="hint">
              {CATEGORIES.find((c) => c.value === s.category)!.label}
              {s.state === 'archived' ? ' · archived' : ''}
              {s.in_use ? ' · in use' : ''}
            </span>
            <span className="actions-compact">
              <button
                type="button"
                className="button button-ghost"
                disabled={i === 0 || r.busy}
                onClick={() =>
                  void r.run(
                    () =>
                      workflows.post(
                        ws,
                        `${wf.id}/statuses/${s.id}:move`,
                        wf.version,
                        { after: i >= 2 ? wf.statuses[i - 2]!.id : null },
                        stepUp,
                      ),
                    'Status moved.',
                  )
                }
              >
                Move up<span className="visually-hidden"> {s.name}</span>
              </button>
              <button
                type="button"
                className="button button-ghost"
                disabled={i === wf.statuses.length - 1 || r.busy}
                onClick={() =>
                  void r.run(
                    () =>
                      workflows.post(
                        ws,
                        `${wf.id}/statuses/${s.id}:move`,
                        wf.version,
                        { after: wf.statuses[i + 1]!.id },
                        stepUp,
                      ),
                    'Status moved.',
                  )
                }
              >
                Move down<span className="visually-hidden"> {s.name}</span>
              </button>
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setRename({ id: s.id, name: s.name, color: s.color ?? '#6b7280' })}
              >
                Edit<span className="visually-hidden"> {s.name}</span>
              </button>
              <button
                type="button"
                className="button button-ghost"
                disabled={r.busy}
                onClick={() =>
                  void r.run(
                    () =>
                      workflows.post(
                        ws,
                        `${wf.id}/statuses/${s.id}:${s.state === 'active' ? 'archive' : 'unarchive'}`,
                        wf.version,
                        {},
                        stepUp,
                      ),
                    s.state === 'active' ? 'Status archived.' : 'Status restored.',
                  )
                }
              >
                {s.state === 'active' ? 'Archive' : 'Unarchive'}
                <span className="visually-hidden"> {s.name}</span>
              </button>
              {s.in_use ? (
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => setMigrate({ id: s.id, to: '' })}
                >
                  Move records…<span className="visually-hidden"> from {s.name}</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="button button-ghost"
                  disabled={r.busy}
                  onClick={() =>
                    void r.run(
                      () => workflows.remove(ws, `${wf.id}/statuses/${s.id}`, wf.version, stepUp),
                      'Status deleted.',
                    )
                  }
                >
                  Delete<span className="visually-hidden"> {s.name}</span>
                </button>
              )}
            </span>
          </li>
        ))}
      </ol>
      <form
        className="inline-form"
        aria-label={`Add a status to ${wf.name}`}
        onSubmit={(e) => {
          e.preventDefault();
          void r
            .run(
              () =>
                workflows.post(ws, `${wf.id}/statuses`, wf.version, { status: newStatus }, stepUp),
              'Status added.',
            )
            .then((ok) => ok && setNewStatus({ name: '', category: 'active' }));
        }}
      >
        <Field
          id={`ns-${wf.id}`}
          label="New status"
          value={newStatus.name}
          onChange={(e) => setNewStatus({ ...newStatus, name: e.target.value })}
          maxLength={60}
        />
        <SelectField
          id={`nsc-${wf.id}`}
          label="Category"
          value={newStatus.category}
          onChange={(v) => setNewStatus({ ...newStatus, category: v as Category })}
          options={CATEGORIES}
        />
        <button type="submit" className="button button-secondary" disabled={!newStatus.name.trim()}>
          Add status
        </button>
      </form>
      <h4>Transitions</h4>
      <p className="hint">
        {wf.transitions.length
          ? 'Only these changes are allowed.'
          : 'No transitions yet: any open status can move to another, and Complete, Cancel, and Reopen work as usual.'}
      </p>
      <ul className="plain-list">
        {wf.transitions.map((t) => (
          <li key={t.id}>
            {nameOf(t.from)} → {nameOf(t.to)}
            <span className="hint">
              {t.requirements.length
                ? ` · requires ${t.requirements.map((q) => (q.kind === 'builtin' ? (BUILTINS[wf.record_kind].find((b) => b.key === q.key)?.label ?? q.key) : 'a custom field')).join(', ')}`
                : ''}
              {t.confirmation !== 'none'
                ? ` · ${t.confirmation === 'step_up' ? 'step-up' : 'confirmation'}`
                : ''}
              {t.approval_policy !== 'none'
                ? ` · approval: ${t.approval_policy === 'one_manager' ? 'one manager' : 'named approvers'}`
                : ''}
            </span>
            <button
              type="button"
              className="button button-ghost"
              disabled={r.busy}
              onClick={() =>
                void r.run(
                  () =>
                    workflows.post(
                      ws,
                      `${wf.id}/transitions/${t.id}:archive`,
                      wf.version,
                      {},
                      stepUp,
                    ),
                  'Transition removed.',
                )
              }
            >
              Remove
              <span className="visually-hidden">
                {' '}
                {nameOf(t.from)} to {nameOf(t.to)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {wf.state === 'active' && active.length >= 2 ? (
        <NewTransition ws={ws} wf={wf} reload={reload} />
      ) : null}
      <p className="actions">
        <button
          type="button"
          className="button button-secondary"
          disabled={r.busy}
          onClick={() =>
            void r.run(
              () =>
                workflows.post(
                  ws,
                  `${wf.id}:${wf.state === 'active' ? 'archive' : 'unarchive'}`,
                  wf.version,
                  {},
                  stepUp,
                ),
              wf.state === 'active' ? 'Workflow archived.' : 'Workflow restored.',
            )
          }
        >
          {wf.state === 'active' ? 'Archive workflow' : 'Unarchive workflow'}
        </button>
      </p>
      {r.error ? (
        <Banner tone="danger" title="Not saved">
          {r.error}
        </Banner>
      ) : null}
      <Announce>{r.said}</Announce>
      {rename ? (
        <Dialog title="Edit status" onClose={() => setRename(null)}>
          <Field
            id="rs-name"
            label="Name"
            value={rename.name}
            onChange={(e) => setRename({ ...rename, name: e.target.value })}
            maxLength={60}
          />
          <Field
            id="rs-color"
            label="Color"
            type="color"
            value={rename.color}
            onChange={(e) => setRename({ ...rename, color: e.target.value })}
          />
          <p className="actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setRename(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-primary"
              onClick={() =>
                void r
                  .run(
                    () =>
                      workflows.patch(
                        ws,
                        `${wf.id}/statuses/${rename.id}`,
                        wf.version,
                        { status: { name: rename.name, color: rename.color } },
                        stepUp,
                      ),
                    'Status saved.',
                  )
                  .then((ok) => ok && setRename(null))
              }
            >
              Save status
            </button>
          </p>
        </Dialog>
      ) : null}
      {migrate ? (
        <Dialog title={`Move records from ${nameOf(migrate.id)}`} onClose={() => setMigrate(null)}>
          <p>
            Records move to another status of the same category, in batches. Repeat until none
            remain.
          </p>
          <SelectField
            id="mg-to"
            label="Move to"
            value={migrate.to}
            onChange={(v) => setMigrate({ ...migrate, to: v })}
            options={[
              { value: '', label: 'Choose a status' },
              ...active
                .filter(
                  (s) =>
                    s.id !== migrate.id &&
                    s.category === wf.statuses.find((x) => x.id === migrate.id)!.category,
                )
                .map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
          <p className="actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setMigrate(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={!migrate.to}
              onClick={() =>
                void r
                  .run(
                    () =>
                      workflows.post(
                        ws,
                        `${wf.id}/statuses/${migrate.id}:migrate`,
                        undefined,
                        { to: migrate.to },
                        stepUp,
                      ),
                    'Records moved.',
                  )
                  .then((ok) => ok && setMigrate(null))
              }
            >
              Move records
            </button>
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}

function NewTransition({ ws, wf, reload }: { ws: string; wf: Workflow; reload: () => void }) {
  const stepUp = useStepUp();
  const r = useRunner(reload);
  const active = wf.statuses.filter((s) => s.state === 'active');
  const [from, setFrom] = useState(active[0]!.id);
  const [to, setTo] = useState(active[1]!.id);
  const [confirmation, setConfirmation] = useState('none');
  const [approval, setApproval] = useState('none');
  const [approvers, setApprovers] = useState<string[]>([]);
  const [allowSelf, setAllowSelf] = useState(false);
  const [required, setRequired] = useState<string[]>([]);
  const people = useResource(
    () => collab.people(ws).catch(() => [] as Member[]),
    approval === 'all_named_approvers' ? `people:${ws}` : 'wait',
  );
  const scope =
    wf.scope.kind === 'workspace'
      ? 'workspace'
      : wf.scope.kind === 'brand'
        ? `brand:${wf.scope.brand}`
        : `project:${wf.scope.project}`;
  const custom = useResource(() => fields.list(ws, scope), `wf-fields:${ws}:${scope}`);
  const toggle = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  return (
    <form
      aria-label="Add a transition"
      onSubmit={(e) => {
        e.preventDefault();
        void r.run(
          () =>
            workflows.post(
              ws,
              `${wf.id}/transitions`,
              wf.version,
              {
                transition: {
                  from,
                  to,
                  confirmation,
                  approval_policy: approval,
                  approvers: approval === 'all_named_approvers' ? approvers : [],
                  allow_self_approval: approval !== 'none' && allowSelf,
                  requirements: required.map((x) =>
                    x.startsWith('fld_') ? { field: x } : { builtin: x },
                  ),
                },
              },
              stepUp,
            ),
          'Transition added.',
        );
      }}
    >
      <fieldset>
        <legend>Add a transition</legend>
        <SelectField
          id={`nt-from-${wf.id}`}
          label="From"
          value={from}
          onChange={setFrom}
          options={active.map((s) => ({ value: s.id, label: s.name }))}
        />
        <SelectField
          id={`nt-to-${wf.id}`}
          label="To"
          value={to}
          onChange={setTo}
          options={active.map((s) => ({ value: s.id, label: s.name }))}
        />
        <SelectField
          id={`nt-conf-${wf.id}`}
          label="Confirmation"
          value={confirmation}
          onChange={setConfirmation}
          options={[
            { value: 'none', label: 'None' },
            { value: 'confirm', label: 'Confirm in a dialog' },
            { value: 'step_up', label: 'Confirm with step-up' },
          ]}
        />
        <SelectField
          id={`nt-appr-${wf.id}`}
          label="Approval"
          value={approval}
          onChange={setApproval}
          options={[
            { value: 'none', label: 'None' },
            { value: 'one_manager', label: 'One manager' },
            { value: 'all_named_approvers', label: 'Every named approver' },
          ]}
        />
        {approval !== 'none' ? (
          <label className="choice">
            <input
              type="checkbox"
              checked={allowSelf}
              onChange={(e) => setAllowSelf(e.target.checked)}
            />{' '}
            Let the requester approve their own change when the workspace's self-approval setting
            allows it
          </label>
        ) : null}
        {approval === 'all_named_approvers' && people.state.status === 'ready' ? (
          <fieldset>
            <legend>Approvers</legend>
            {people.state.data
              .filter((m) => m.kind === 'member' && m.state === 'active')
              .map((m) => (
                <label key={m.id} className="choice">
                  <input
                    type="checkbox"
                    checked={approvers.includes(m.id)}
                    onChange={() => setApprovers((a) => toggle(a, m.id))}
                  />{' '}
                  {m.display_name}
                </label>
              ))}
          </fieldset>
        ) : null}
        <fieldset>
          <legend>Required fields</legend>
          {BUILTINS[wf.record_kind].map((b) => (
            <label key={b.key} className="choice">
              <input
                type="checkbox"
                checked={required.includes(b.key)}
                onChange={() => setRequired((x) => toggle(x, b.key))}
              />{' '}
              {b.label}
            </label>
          ))}
          {custom.state.status === 'ready'
            ? custom.state.data.data
                .filter(
                  (f) =>
                    f.state === 'active' &&
                    f.field_type !== 'formula' &&
                    f.applies_to.includes(wf.record_kind),
                )
                .map((f) => (
                  <label key={f.id} className="choice">
                    <input
                      type="checkbox"
                      checked={required.includes(f.id)}
                      onChange={() => setRequired((x) => toggle(x, f.id))}
                    />{' '}
                    {f.name}
                  </label>
                ))
            : null}
        </fieldset>
        <button type="submit" className="button button-secondary" disabled={from === to || r.busy}>
          Add transition
        </button>
      </fieldset>
      {r.error ? (
        <Banner tone="danger" title="Not added">
          {r.error}
        </Banner>
      ) : null}
      <Announce>{r.said}</Announce>
    </form>
  );
}

// -----------------------------------------------------------------------------------------------
// Custom fields
// -----------------------------------------------------------------------------------------------

export function FieldsPage({ ws }: { ws: string }) {
  const [scope, setScope] = useScope();
  const data = useResource(() => fields.list(ws, scope, true), `fields:${ws}:${scope}`);
  return (
    <Page title="Custom fields" wide>
      <p>
        <Link to={`${routeHref('field_sets', { ws })}?scope=${encodeURIComponent(scope)}`}>
          Field sets at this scope
        </Link>
      </p>
      <ScopePicker ws={ws} scope={scope} onChange={setScope} />
      <ResourceView resource={data.state} onRetry={data.retry} what="fields">
        {(d) => (
          <>
            {d.inherited.length ? (
              <p className="hint">
                Also applying here from broader scopes: {d.inherited.map((f) => f.name).join(', ')}.
              </p>
            ) : null}
            <section className="card" aria-labelledby="fl-heading">
              <h2 id="fl-heading">Fields at this scope</h2>
              {!d.data.length ? <p>No custom fields here yet.</p> : null}
              <ul className="plain-list">
                {d.data.map((f, i) => (
                  <FieldRow
                    key={f.id}
                    ws={ws}
                    f={f}
                    prev={d.data[i - 1]?.id ?? null}
                    next={d.data[i + 1]?.id ?? null}
                    all={d.data}
                    reload={data.reload}
                  />
                ))}
              </ul>
            </section>
            <NewField ws={ws} scope={scope} existing={d.data} reload={data.reload} />
          </>
        )}
      </ResourceView>
    </Page>
  );
}

function FieldRow({
  ws,
  f,
  prev,
  next,
  all,
  reload,
}: {
  ws: string;
  f: FieldDefinition;
  prev: string | null;
  next: string | null;
  all: FieldDefinition[];
  reload: () => void;
}) {
  const stepUp = useStepUp();
  const r = useRunner(reload);
  const [option, setOption] = useState('');
  const [remove, setRemove] = useState<null | { id: string; label: string; replace: string }>(null);
  const before = all.findIndex((x) => x.id === prev);
  return (
    <li>
      <strong>{f.name}</strong>{' '}
      <span className="hint">
        {FIELD_TYPE_LABEL[f.field_type]} · {f.applies_to.join(' and ')} ·{' '}
        {f.presentation === 'advanced' ? 'under More fields' : 'primary'}
        {f.visibility.read === 'min_level'
          ? ` · visible at ${f.visibility.read_min_level} and above`
          : ''}
        {f.state === 'archived' ? ' · archived' : ''}
      </span>
      <span className="actions-compact">
        <button
          type="button"
          className="button button-ghost"
          disabled={!prev || r.busy}
          onClick={() =>
            void r.run(
              () =>
                fields.post(
                  ws,
                  `${f.id}:move`,
                  f.version,
                  { after: before >= 1 ? all[before - 1]!.id : null },
                  stepUp,
                ),
              'Field moved.',
            )
          }
        >
          Move up<span className="visually-hidden"> {f.name}</span>
        </button>
        <button
          type="button"
          className="button button-ghost"
          disabled={!next || r.busy}
          onClick={() =>
            void r.run(
              () => fields.post(ws, `${f.id}:move`, f.version, { after: next }, stepUp),
              'Field moved.',
            )
          }
        >
          Move down<span className="visually-hidden"> {f.name}</span>
        </button>
        <button
          type="button"
          className="button button-ghost"
          disabled={r.busy}
          onClick={() =>
            void r.run(
              () =>
                fields.patch(
                  ws,
                  f.id,
                  f.version,
                  { presentation: f.presentation === 'primary' ? 'advanced' : 'primary' },
                  stepUp,
                ),
              'Field updated.',
            )
          }
        >
          {f.presentation === 'primary' ? 'Move under More fields' : 'Show as primary'}
          <span className="visually-hidden"> {f.name}</span>
        </button>
        <button
          type="button"
          className="button button-ghost"
          disabled={r.busy}
          onClick={() =>
            void r.run(
              () =>
                fields.post(
                  ws,
                  `${f.id}:${f.state === 'active' ? 'archive' : 'unarchive'}`,
                  f.version,
                  {},
                  stepUp,
                ),
              f.state === 'active' ? 'Field archived.' : 'Field restored.',
            )
          }
        >
          {f.state === 'active' ? 'Archive' : 'Unarchive'}
          <span className="visually-hidden"> {f.name}</span>
        </button>
      </span>
      {f.field_type === 'select' ? (
        <div>
          <ul className="plain-list">
            {f.options.map((o) => (
              <li key={o.id}>
                {o.label}
                {o.state === 'archived' ? <span className="hint"> · archived</span> : null}
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => setRemove({ id: o.id, label: o.label, replace: '' })}
                >
                  Remove<span className="visually-hidden"> option {o.label}</span>
                </button>
              </li>
            ))}
          </ul>
          <form
            className="inline-form"
            aria-label={`Add an option to ${f.name}`}
            onSubmit={(e) => {
              e.preventDefault();
              void r
                .run(
                  () => fields.post(ws, `${f.id}/options`, f.version, { label: option }, stepUp),
                  'Option added.',
                )
                .then((ok) => ok && setOption(''));
            }}
          >
            <Field
              id={`op-${f.id}`}
              label={`New option for ${f.name}`}
              value={option}
              onChange={(e) => setOption(e.target.value)}
              maxLength={80}
            />
            <button type="submit" className="button button-secondary" disabled={!option.trim()}>
              Add option
            </button>
          </form>
        </div>
      ) : null}
      {r.error ? <p className="field-error">{r.error}</p> : null}
      <Announce>{r.said}</Announce>
      {remove ? (
        <Dialog title={`Remove ${remove.label}?`} onClose={() => setRemove(null)} destructive>
          <p>If records use this option, choose a replacement; their values move to it.</p>
          <SelectField
            id="rm-replace"
            label="Replace with"
            value={remove.replace}
            onChange={(v) => setRemove({ ...remove, replace: v })}
            options={[
              { value: '', label: 'No replacement' },
              ...f.options
                .filter((o) => o.id !== remove.id && o.state !== 'archived')
                .map((o) => ({ value: o.id, label: o.label })),
            ]}
          />
          <p className="actions">
            <button
              type="button"
              className="button button-secondary"
              autoFocus
              onClick={() => setRemove(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-danger"
              onClick={() =>
                void r
                  .run(
                    () =>
                      fields.remove(
                        ws,
                        `${f.id}/options/${remove.id}`,
                        f.version,
                        remove.replace ? { replace_with: remove.replace } : {},
                        stepUp,
                      ),
                    'Option removed.',
                  )
                  .then((ok) => ok && setRemove(null))
              }
            >
              Remove option
            </button>
          </p>
        </Dialog>
      ) : null}
    </li>
  );
}

function NewField({
  ws,
  scope,
  existing,
  reload,
}: {
  ws: string;
  scope: string;
  existing: FieldDefinition[];
  reload: () => void;
}) {
  const stepUp = useStepUp();
  const r = useRunner(reload);
  const [name, setName] = useState('');
  const [type, setType] = useState<FieldType>('text');
  const [appliesTo, setAppliesTo] = useState('task');
  const [presentation, setPresentation] = useState('primary');
  const [applicability, setApplicability] = useState('always');
  const [visibility, setVisibility] = useState('all_readers');
  const [currency, setCurrency] = useState('USD');
  const [source, setSource] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const config = (): Record<string, unknown> =>
    type === 'currency' ? { currency } : type === 'formula' ? { source } : {};
  return (
    <section className="card" aria-labelledby="nf-heading">
      <h2 id="nf-heading">Add a field</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void r
            .run(
              () =>
                fields.create(
                  ws,
                  {
                    scope,
                    name,
                    field_type: type,
                    applies_to: appliesTo === 'both' ? ['project', 'task'] : [appliesTo],
                    presentation,
                    applicability,
                    config: config(),
                    visibility:
                      visibility === 'all_readers'
                        ? { read: 'all_readers' }
                        : { read: 'min_level', read_min_level: visibility },
                  },
                  stepUp,
                ),
              'Field added.',
            )
            .then(
              (ok) =>
                ok &&
                (setName(''),
                setSource(''),
                setPreview(null),
                setPresentation('primary'),
                setApplicability('always'),
                setVisibility('all_readers')),
            );
        }}
        noValidate
      >
        <Field
          id="nf-name"
          label="Field name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          required
        />
        <SelectField
          id="nf-type"
          label="Type"
          value={type}
          onChange={(v) => setType(v as FieldType)}
          options={Object.entries(FIELD_TYPE_LABEL).map(([value, label]) => ({ value, label }))}
        />
        <SelectField
          id="nf-applies"
          label="Applies to"
          value={appliesTo}
          onChange={setAppliesTo}
          options={[
            { value: 'task', label: 'Tasks' },
            { value: 'project', label: 'Projects' },
            { value: 'both', label: 'Tasks and projects' },
          ]}
        />
        <SelectField
          id="nf-presentation"
          label="Show"
          value={presentation}
          onChange={setPresentation}
          options={[
            { value: 'primary', label: 'With the main fields' },
            { value: 'advanced', label: 'Under More fields' },
          ]}
        />
        <SelectField
          id="nf-applicability"
          label="Where"
          value={applicability}
          onChange={setApplicability}
          options={[
            { value: 'always', label: 'Every record in this scope' },
            { value: 'via_set', label: 'Only records with a field set that includes it' },
          ]}
        />
        <SelectField
          id="nf-visibility"
          label="Who can see it"
          value={visibility}
          onChange={setVisibility}
          options={[
            { value: 'all_readers', label: 'Everyone who can read the record' },
            { value: 'comment', label: 'Comment access and above' },
            { value: 'edit', label: 'Edit access and above' },
            { value: 'manage', label: 'Managers only' },
          ]}
        />
        {type === 'currency' ? (
          <Field
            id="nf-currency"
            label="Currency (ISO 4217)"
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            maxLength={3}
          />
        ) : null}
        {type === 'formula' ? (
          <>
            <TextAreaField
              id="nf-source"
              label="Formula"
              hint={`Reference fields as {field id}. Fields here: ${
                existing
                  .filter((x) => x.field_type !== 'person' && x.field_type !== 'label')
                  .map((x) => `${x.name} = {${x.id}}`)
                  .join('; ') || 'none yet'
              }. Functions: if, coalesce, is_empty, round, floor, ceil, abs, min, max, concat, len, lower, upper, days_between, add_days, year, month.`}
              value={source}
              onChange={setSource}
              maxLength={2000}
            />
            <button
              type="button"
              className="button button-secondary"
              onClick={() =>
                void fields.previewFormula(ws, { scope, source }).then(
                  (p) =>
                    setPreview(
                      `Result type: ${p.result_type}. Uses: ${p.depends_on.map((d) => d.name).join(', ') || 'no fields'}.`,
                    ),
                  (e) => setPreview(message(e)),
                )
              }
            >
              Check formula
            </button>
            {preview ? <p role="status">{preview}</p> : null}
          </>
        ) : null}
        {r.error ? (
          <Banner tone="danger" title="Not added">
            {r.error}
          </Banner>
        ) : null}
        <p className="actions">
          <button type="submit" className="button button-primary" disabled={r.busy}>
            Add field
          </button>
        </p>
      </form>
      <Announce>{r.said}</Announce>
    </section>
  );
}

// -----------------------------------------------------------------------------------------------
// Field sets
// -----------------------------------------------------------------------------------------------

export function FieldSetsPage({ ws }: { ws: string }) {
  const [scope, setScope] = useScope();
  const sets = useResource(() => fieldSets.list(ws, scope), `field-sets:${ws}:${scope}`);
  const defs = useResource(() => fields.list(ws, scope), `fields:${ws}:${scope}:sets`);
  const stepUp = useStepUp();
  const r = useRunner(sets.reload);
  const [name, setName] = useState('');
  const [items, setItems] = useState<string[]>([]);
  const [editing, setEditing] = useState<null | { id: string; version: number; items: string[] }>(
    null,
  );
  const available =
    defs.state.status === 'ready' ? defs.state.data.data.filter((f) => f.state === 'active') : [];
  const picker = (value: string[], set: (v: string[]) => void, idp: string) => (
    <fieldset>
      <legend>Fields in the set (in order)</legend>
      {available.map((f) => (
        <label key={f.id} className="choice">
          <input
            id={`${idp}-${f.id}`}
            type="checkbox"
            checked={value.includes(f.id)}
            onChange={() =>
              set(value.includes(f.id) ? value.filter((x) => x !== f.id) : [...value, f.id])
            }
          />{' '}
          {f.name}
        </label>
      ))}
    </fieldset>
  );
  return (
    <Page title="Field sets" wide>
      <ScopePicker ws={ws} scope={scope} onChange={setScope} />
      <ResourceView resource={sets.state} onRetry={sets.retry} what="field sets">
        {(list) => (
          <section className="card" aria-labelledby="fs-heading">
            <h2 id="fs-heading">Field sets at this scope</h2>
            {!list.length ? <p>No field sets here yet.</p> : null}
            <ul className="plain-list">
              {list.map((s) => (
                <li key={s.id}>
                  <strong>{s.name}</strong>{' '}
                  <span className="hint">
                    version {s.current_version} · {s.attached_records} records
                  </span>
                  <button
                    type="button"
                    className="button button-ghost"
                    onClick={() =>
                      setEditing({
                        id: s.id,
                        version: s.version,
                        items: s.versions.at(-1)!.items.map((i) => i.field),
                      })
                    }
                  >
                    New version<span className="visually-hidden"> of {s.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </ResourceView>
      <section className="card" aria-labelledby="nfs-heading">
        <h2 id="nfs-heading">Create a field set</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void r
              .run(
                () =>
                  fieldSets.create(
                    ws,
                    { scope, name, applies_to: ['task'], items: items.map((field) => ({ field })) },
                    stepUp,
                  ),
                'Field set created.',
              )
              .then((ok) => ok && (setName(''), setItems([])));
          }}
        >
          <Field
            id="nfs-name"
            label="Field set name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
          />
          {picker(items, setItems, 'nfs')}
          <button
            type="submit"
            className="button button-primary"
            disabled={!name.trim() || !items.length || r.busy}
          >
            Create field set
          </button>
        </form>
        {r.error ? (
          <Banner tone="danger" title="Not saved">
            {r.error}
          </Banner>
        ) : null}
        <Announce>{r.said}</Announce>
      </section>
      {editing ? (
        <Dialog title="New field set version" onClose={() => setEditing(null)}>
          <p>Records keep their current version until a manager upgrades them.</p>
          {picker(editing.items, (v) => setEditing({ ...editing, items: v }), 'efs')}
          <p className="actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setEditing(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={!editing.items.length}
              onClick={() =>
                void r
                  .run(
                    () =>
                      fieldSets.patch(
                        ws,
                        editing.id,
                        {
                          version: editing.version,
                          items: editing.items.map((field) => ({ field })),
                        },
                        stepUp,
                      ),
                    'New version saved.',
                  )
                  .then((ok) => ok && setEditing(null))
              }
            >
              Save version
            </button>
          </p>
        </Dialog>
      ) : null}
    </Page>
  );
}

// -----------------------------------------------------------------------------------------------
// Approvals
// -----------------------------------------------------------------------------------------------

const STATE_LABEL: Record<string, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  stale: 'Out of date',
  expired: 'Expired',
  applied: 'Applied',
  withdrawn: 'Withdrawn',
};

export function ApprovalsPage({ ws }: { ws: string }) {
  const stepUp = useStepUp();
  const data = useResource(() => approvals.list(ws), `approvals:${ws}`);
  const r = useRunner(data.reload);
  const [note, setNote] = useState<Record<string, string>>({});
  return (
    <Page title="Approvals" wide>
      <ResourceView resource={data.state} onRetry={data.retry} what="approvals">
        {(list) =>
          !list.length ? (
            <p className="empty-state">Nothing is waiting for your approval.</p>
          ) : (
            <ul className="plain-list">
              {list.map((a) => (
                <li key={a.id} className="card">
                  <p>
                    <RecordLink ws={ws} rec={a.record}>
                      {a.record.type === 'task' ? 'Task' : 'Project'}: {a.from.name} → {a.to.name}
                    </RecordLink>{' '}
                    <span className="badge">{STATE_LABEL[a.state]}</span>
                    {a.self_requested ? <span className="badge">Requested by you</span> : null}
                  </p>
                  <p className="hint">Expires {new Date(a.expires_at).toLocaleString()}</p>
                  {a.can_decide ? (
                    <>
                      <TextAreaField
                        id={`note-${a.id}`}
                        label="Note (optional)"
                        value={note[a.id] ?? ''}
                        onChange={(v) => setNote({ ...note, [a.id]: v })}
                        maxLength={1000}
                      />
                      <p className="actions">
                        <button
                          type="button"
                          className="button button-primary"
                          disabled={r.busy}
                          onClick={() =>
                            void r.run(
                              () => approvals.decide(ws, a.id, 'approve', note[a.id] ?? '', stepUp),
                              'Approved.',
                            )
                          }
                        >
                          Approve
                          <span className="visually-hidden">
                            {' '}
                            {a.from.name} to {a.to.name}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="button button-danger"
                          disabled={r.busy}
                          onClick={() =>
                            void r.run(
                              () => approvals.decide(ws, a.id, 'reject', note[a.id] ?? '', stepUp),
                              'Rejected.',
                            )
                          }
                        >
                          Reject
                          <span className="visually-hidden">
                            {' '}
                            {a.from.name} to {a.to.name}
                          </span>
                        </button>
                      </p>
                    </>
                  ) : null}
                  {a.can_withdraw ? (
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={r.busy}
                      onClick={() =>
                        void r.run(() => approvals.withdraw(ws, a.id, stepUp), 'Request withdrawn.')
                      }
                    >
                      Withdraw request
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        }
      </ResourceView>
      {r.error ? (
        <Banner tone="danger" title="Not saved">
          {r.error}
        </Banner>
      ) : null}
      <Announce>{r.said}</Announce>
    </Page>
  );
}
