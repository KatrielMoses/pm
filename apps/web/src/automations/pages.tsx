import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, newIdempotencyKey } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { Link, useRouter } from '../router.tsx';
import { useStepUp } from '../stepup.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Announce, Banner } from '../ui/feedback.tsx';
import { Page } from '../ui/layout.tsx';
import {
  ambiguous,
  automationProblem,
  automationsClient,
  type Automation,
  type AutomationPreview,
  type AutomationRun,
  type AutomationTemplate,
  type AutomationUsage,
} from './client.ts';
import { readAutomationDraft, writeAutomationDraft } from './drafts.ts';

/**
 * Phase 8A automations (UXD-32): the list with starter templates and usage, the versioned
 * builder (trigger, AND/OR conditions, ordered steps with branches, delays, and fallbacks),
 * preview, activation (with the standing outbound approval named in words), and run history with
 * retry and reconciliation. Everything is a form a keyboard can drive; nothing is drag-only.
 */

type Def = Record<string, unknown>;
/** Typed reads of the untyped definition JSON the builder edits structurally. */
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const obj = (v: unknown): Def =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Def) : {};
const defs = (v: unknown): Def[] => (Array.isArray(v) ? v.map(obj) : []);
type Option = { value: string; label: string; disabled?: boolean };

function useDraftAccount(): string | null {
  try {
    const me = useAuth().me;
    return me ? me.id : null;
  } catch {
    return 'device';
  }
}

const TRIGGERS: Option[] = [
  { value: 'record.created', label: 'A record is created' },
  { value: 'record.field_changed', label: 'A field changes' },
  { value: 'record.status_changed', label: 'The status changes' },
  { value: 'comment.created', label: 'A comment is added' },
  { value: 'approval.decided', label: 'A review is decided' },
  { value: 'integration.record_created', label: 'An integration creates a task' },
  { value: 'schedule', label: 'On a schedule' },
  { value: 'date', label: 'On a due or start date' },
  { value: 'manual', label: 'Only when run by hand' },
  {
    value: 'test.result',
    label: 'A test result arrives (not available yet: phase 9B)',
    disabled: true,
  },
  {
    value: 'agent.result',
    label: 'An agent returns a result (not available yet: phase 8C)',
    disabled: true,
  },
];
const RECORD_TRIGGERS: Record<string, string[]> = {
  'record.created': ['task', 'project'],
  'record.field_changed': ['task', 'project'],
  'record.status_changed': ['task', 'project'],
  'comment.created': ['task', 'project'],
  'approval.decided': ['task', 'project'],
  'integration.record_created': ['task'],
  date: ['task'],
  manual: ['task', 'project'],
  schedule: [],
};
const WATCH: Record<string, Option[]> = {
  task: ['title', 'priority', 'start_date', 'due_date', 'status'].map((v) => ({
    value: v,
    label: v.replace('_', ' '),
  })),
  project: ['name', 'priority', 'start_date', 'target_date', 'status'].map((v) => ({
    value: v,
    label: v.replace('_', ' '),
  })),
};
const CATEGORIES: Option[] = ['planned', 'active', 'paused', 'done', 'cancelled'].map((v) => ({
  value: v,
  label: v,
}));
const PRIORITIES: Option[] = ['none', 'low', 'medium', 'high', 'urgent'].map((v) => ({
  value: v,
  label: v,
}));
const RULES: Option[] = [
  { value: 'FREQ=DAILY', label: 'Every day' },
  { value: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', label: 'Every weekday' },
  { value: 'FREQ=WEEKLY;BYDAY=MO', label: 'Every Monday' },
  { value: 'FREQ=MONTHLY;BYMONTHDAY=1', label: 'On the 1st of each month' },
];
const FIELDS: Record<string, Array<{ value: string; label: string; type: string }>> = {
  task: [
    { value: 'status_category', label: 'Status category', type: 'category' },
    { value: 'status', label: 'Status', type: 'status' },
    { value: 'priority', label: 'Priority', type: 'priority' },
    { value: 'due_date', label: 'Due date', type: 'date' },
    { value: 'start_date', label: 'Start date', type: 'date' },
    { value: 'assignee', label: 'Assignee', type: 'member' },
    { value: 'label', label: 'Label', type: 'label' },
    { value: 'project', label: 'Project', type: 'project' },
    { value: 'title', label: 'Title', type: 'text' },
  ],
  project: [
    { value: 'status_category', label: 'Status category', type: 'category' },
    { value: 'status', label: 'Status', type: 'status' },
    { value: 'priority', label: 'Priority', type: 'priority' },
    { value: 'start_date', label: 'Start date', type: 'date' },
    { value: 'target_date', label: 'Target date', type: 'date' },
    { value: 'title', label: 'Name', type: 'text' },
  ],
};
const OPS: Record<string, Option[]> = {
  category: [
    { value: 'eq', label: 'is' },
    { value: 'neq', label: 'is not' },
  ],
  status: [
    { value: 'eq', label: 'is' },
    { value: 'neq', label: 'is not' },
  ],
  priority: [
    { value: 'eq', label: 'is' },
    { value: 'neq', label: 'is not' },
    { value: 'is_set', label: 'is set' },
    { value: 'is_not_set', label: 'is not set' },
  ],
  date: [
    { value: 'before', label: 'is before' },
    { value: 'on', label: 'is on' },
    { value: 'after', label: 'is after' },
    { value: 'is_set', label: 'is set' },
    { value: 'is_not_set', label: 'is not set' },
  ],
  member: [
    { value: 'includes', label: 'includes' },
    { value: 'excludes', label: 'excludes' },
    { value: 'is_set', label: 'has any' },
    { value: 'is_not_set', label: 'has none' },
  ],
  label: [
    { value: 'includes', label: 'includes' },
    { value: 'excludes', label: 'excludes' },
    { value: 'is_set', label: 'has any' },
    { value: 'is_not_set', label: 'has none' },
  ],
  project: [
    { value: 'eq', label: 'is' },
    { value: 'neq', label: 'is not' },
    { value: 'is_set', label: 'is set' },
    { value: 'is_not_set', label: 'is not set' },
  ],
  text: [
    { value: 'contains', label: 'contains' },
    { value: 'not_contains', label: 'does not contain' },
  ],
};
const ACTIONS: Record<string, Option[]> = {
  task: [
    { value: 'task.update', label: 'Update the task' },
    { value: 'task.assign', label: 'Assign people' },
    { value: 'task.label', label: 'Add or remove a label' },
    { value: 'task.schedule', label: 'Set start or due date' },
    { value: 'task.move', label: 'Move to a project' },
    { value: 'task.relate', label: 'Relate to another task' },
    { value: 'task.create', label: 'Create a task' },
    { value: 'task.notify', label: 'Notify people' },
    { value: 'task.archive', label: 'Archive the task' },
    { value: 'ai.draft', label: 'Request an AI draft for review' },
    { value: 'webhook.send', label: 'Send a webhook' },
    {
      value: 'agent.invoke',
      label: 'Run an agent workflow (not available yet: phase 8C)',
      disabled: true,
    },
  ],
  project: [
    { value: 'project.update', label: 'Update the project' },
    { value: 'project.schedule', label: 'Set start or target date' },
    { value: 'project.notify', label: 'Notify people' },
    { value: 'project.archive', label: 'Archive the project' },
    { value: 'task.create', label: 'Create a task in it' },
    { value: 'ai.draft', label: 'Request an AI draft for review' },
    { value: 'webhook.send', label: 'Send a webhook' },
    {
      value: 'agent.invoke',
      label: 'Run an agent workflow (not available yet: phase 8C)',
      disabled: true,
    },
  ],
  none: [{ value: 'task.create', label: 'Create a task' }],
};
const FAILURES: Option[] = [
  { value: 'policy_rejected', label: 'Not permitted' },
  { value: 'validation_failed', label: 'Not valid' },
  { value: 'conflict', label: 'Changed meanwhile' },
  { value: 'not_found', label: 'Not found' },
  { value: 'unavailable', label: 'Not available' },
];
const STATUS: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting',
  succeeded: 'Succeeded',
  partial: 'Partly done',
  failed: 'Failed',
  policy_rejected: 'Refused',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
};

function Select(props: {
  id: string;
  label: string;
  value: string;
  options: Option[];
  onChange: (v: string) => void;
  hint?: string;
  hideLabel?: boolean;
}) {
  return (
    <div className="field au-field">
      <label htmlFor={props.id} className={props.hideLabel ? 'visually-hidden' : undefined}>
        {props.label}
      </label>
      <select
        id={props.id}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        aria-describedby={props.hint ? `${props.id}-hint` : undefined}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      {props.hint ? (
        <p id={`${props.id}-hint`} className="hint">
          {props.hint}
        </p>
      ) : null}
    </div>
  );
}
function Input(props: {
  id: string;
  label: string;
  value: string | number;
  onChange: (v: string) => void;
  type?: string;
  hint?: string;
  hideLabel?: boolean;
  maxLength?: number;
}) {
  return (
    <div className="field au-field">
      <label htmlFor={props.id} className={props.hideLabel ? 'visually-hidden' : undefined}>
        {props.label}
      </label>
      <input
        id={props.id}
        type={props.type ?? 'text'}
        value={props.value}
        maxLength={props.maxLength}
        onChange={(e) => props.onChange(e.target.value)}
        aria-describedby={props.hint ? `${props.id}-hint` : undefined}
      />
      {props.hint ? (
        <p id={`${props.id}-hint`} className="hint">
          {props.hint}
        </p>
      ) : null}
    </div>
  );
}

/** Lookup lists for the builder's pickers (each falls back to an empty list on failure). */
interface Refs {
  projects: Option[];
  labels: Option[];
  members: Option[];
  webhooks: Array<Option & { url: string }>;
  brands: Option[];
}
function useRefs(ws: string, brandIds: string[]): Refs {
  const [refs, setRefs] = useState<Refs>({
    projects: [],
    labels: [],
    members: [],
    webhooks: [],
    brands: [],
  });
  const key = brandIds.join(',');
  useEffect(() => {
    let live = true;
    const base = `/v1/workspaces/${encodeURIComponent(ws)}`;
    const safe = async <T,>(p: Promise<T>, d: T) => p.catch(() => d);
    void (async () => {
      const brands = await safe(
        api<{ data: Array<{ id: string; name: string }> }>('GET', `${base}/brands`).then(
          (r) => r.body.data,
        ),
        [],
      );
      const projects = await safe(
        api<{ data: Array<{ id: string; name: string }> }>(
          'GET',
          `${base}/projects${key ? `?brands=${encodeURIComponent(key)}` : ''}`,
        ).then((r) => r.body.data),
        [],
      );
      const members = await safe(
        api<{ data: Array<{ id: string; display_name?: string; name?: string; kind?: string }> }>(
          'GET',
          `${base}/people`,
        ).then((r) => r.body.data),
        [],
      );
      const labels: Option[] = [];
      for (const b of brandIds) {
        const list = await safe(
          api<{ data: Array<{ id: string; name: string }> }>(
            'GET',
            `${base}/brands/${encodeURIComponent(b)}/labels`,
          ).then((r) => r.body.data),
          [],
        );
        labels.push(...list.map((l) => ({ value: l.id, label: l.name })));
      }
      const hooks = await safe(
        api<{
          data: { subscriptions: Array<{ id: string; destination_url: string; state: string }> };
        }>('GET', `${base}/webhook-subscriptions`).then((r) => r.body.data.subscriptions),
        [],
      );
      if (!live) return;
      setRefs({
        brands: brands.map((b) => ({ value: b.id, label: b.name })),
        projects: projects.map((p) => ({ value: p.id, label: p.name })),
        members: members
          .filter((m) => m.kind !== 'guest')
          .map((m) => ({ value: m.id, label: m.display_name ?? m.name ?? m.id })),
        labels,
        webhooks: hooks
          .filter((h) => h.state === 'active')
          .map((h) => ({ value: h.id, label: h.destination_url, url: h.destination_url })),
      });
    })();
    return () => {
      live = false;
    };
  }, [ws, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return refs;
}

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

export function AutomationsPage({ ws }: { ws: string }) {
  const { navigate } = useRouter();
  const [list, setList] = useState<Awaited<ReturnType<typeof automationsClient.list>> | null>(null);
  const [templates, setTemplates] = useState<AutomationTemplate[]>([]);
  const [usage, setUsage] = useState<AutomationUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refs = useRefs(ws, []);
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [template, setTemplate] = useState('');
  const [values, setValues] = useState<Record<string, string>>({
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const [busy, setBusy] = useState(false);
  const key = useRef<string | null>(null);
  const load = useCallback(() => {
    automationsClient
      .list(ws)
      .then(setList)
      .catch((err) => setError(automationProblem(err, 'Automations could not be loaded.')));
    automationsClient
      .templates(ws)
      .then(setTemplates)
      .catch(() => undefined);
    automationsClient
      .usage(ws)
      .then(setUsage)
      .catch(() => undefined);
  }, [ws]);
  useEffect(load, [load]);
  const chosen = templates.find((t) => t.key === template);
  // The first brand the person can see is the default choice until they pick one.
  const brandValue = brand || refs.brands[0]?.value || '';
  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    key.current ??= newIdempotencyKey();
    try {
      const a = await automationsClient.create(
        ws,
        {
          name: name.trim(),
          scope: { kind: 'brand', brand: brandValue },
          ...(template
            ? { template, template_values: values }
            : {
                definition: {
                  schema_version: 1,
                  trigger: { kind: 'record.created', record: 'task' },
                  conditions: null,
                  steps: [],
                },
              }),
        },
        key.current,
      );
      key.current = null;
      navigate(`/workspaces/${ws}/automations/${a.id}`);
    } catch (err) {
      if (!ambiguous(err)) key.current = null;
      setError(automationProblem(err, 'The automation could not be created.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page
      title="Automations"
      lead="Rules that act on tasks and projects for you. Each runs as its owner, only within the brands it names, and keeps a history of what it did."
    >
      {error ? (
        <Banner tone="danger" title="Something went wrong">
          {error}
        </Banner>
      ) : null}
      {!list && !error ? <p role="status">Loading automations…</p> : null}
      {list ? (
        <section className="card au-section" aria-labelledby="au-list-h">
          <h2 id="au-list-h">Your automations</h2>
          {list.data.length ? (
            <ul className="au-list" aria-label="Automations">
              {list.data.map((a) => (
                <li key={a.id} className="au-list-item">
                  <Link to={`/workspaces/${ws}/automations/${a.id}`}>{a.name}</Link>
                  <span className={`au-chip au-chip-${a.state}`}>{STATE_LABEL[a.state]}</span>
                  <span className="hint">
                    {a.scope.kind === 'brand' ? a.scope.brand.name : 'Workspace'}
                    {a.last_run
                      ? ` · last run ${STATUS[a.last_run.status] ?? a.last_run.status}`
                      : ' · never run'}
                    {a.failures_in_a_row ? ` · ${a.failures_in_a_row} failures in a row` : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-state">No automations yet.</p>
          )}
          {list.data.length ? (
            <p className="hint">
              <a href={automationsClient.exportUrl(ws)}>Export run history (CSV)</a>: every run you
              can see now, as its run page shows it.
            </p>
          ) : null}
        </section>
      ) : null}
      {list?.capabilities.create ? (
        <section className="card au-section" aria-labelledby="au-new-h">
          <h2 id="au-new-h">New automation</h2>
          <form
            aria-label="New automation"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <Input id="au-name" label="Name" value={name} onChange={setName} maxLength={120} />
            <Select
              id="au-brand"
              label="Brand"
              value={brandValue}
              options={refs.brands}
              onChange={setBrand}
              hint="It acts only in this brand."
            />
            <Select
              id="au-template"
              label="Start from"
              value={template}
              options={[
                { value: '', label: 'A blank automation' },
                ...templates.map((t) => ({ value: t.key, label: t.name })),
              ]}
              onChange={setTemplate}
              hint={chosen?.description}
            />
            {chosen?.needs.map((n) =>
              n === 'timezone' ? (
                <Input
                  key={n}
                  id={`au-need-${n}`}
                  label="Time zone"
                  value={values.timezone ?? ''}
                  onChange={(x) => setValues({ ...values, timezone: x })}
                  hint="An IANA time zone, for example Europe/London."
                />
              ) : (
                <Select
                  key={n}
                  id={`au-need-${n}`}
                  label={n === 'project' ? 'Project' : n === 'member' ? 'Person' : 'Label'}
                  value={values[n] ?? ''}
                  options={[
                    { value: '', label: 'Choose…' },
                    ...(n === 'project'
                      ? refs.projects
                      : n === 'member'
                        ? refs.members
                        : refs.labels),
                  ]}
                  onChange={(x) => setValues({ ...values, [n]: x })}
                />
              ),
            )}
            <div className="actions">
              <button
                type="submit"
                className="button button-primary"
                disabled={busy || !name.trim() || !brandValue}
              >
                Create draft
              </button>
            </div>
          </form>
        </section>
      ) : null}
      {usage ? <UsagePanel usage={usage} /> : null}
    </Page>
  );
}

const STATE_LABEL: Record<Automation['state'], string> = {
  active: 'Active',
  disabled: 'Off',
  suspended: 'Suspended',
  archived: 'Archived',
};

function UsagePanel({ usage }: { usage: AutomationUsage }) {
  const limits = usage.technical_limits;
  return (
    <section className="card au-section" aria-labelledby="au-usage-h">
      <h2 id="au-usage-h">Usage this month</h2>
      <dl className="au-facts">
        <div>
          <dt>Runs</dt>
          <dd>
            {usage.measured.runs} of {limits.runs_per_month}
          </dd>
        </div>
        <div>
          <dt>Steps</dt>
          <dd>{usage.measured.steps}</dd>
        </div>
        <div>
          <dt>Runs at once, per automation</dt>
          <dd>{limits.active_runs_per_automation}</dd>
        </div>
        <div>
          <dt>Plan limit</dt>
          <dd>Not available yet</dd>
        </div>
      </dl>
      <p className="hint">{usage.plan_entitlement.note}</p>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------------------------

type SaveState = 'idle' | 'saving' | 'saved' | 'conflict' | 'offline' | 'failed';

export function AutomationPage({ ws, id }: { ws: string; id: string }) {
  const account = useDraftAccount();
  const { navigate } = useRouter();
  const stepUp = useStepUp();
  const [a, setA] = useState<Automation | null>(null);
  const [def, setDef] = useState<Def | null>(null);
  const [name, setName] = useState('');
  const [projects, setProjects] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [restored, setRestored] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [save, setSave] = useState<SaveState>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [preview, setPreview] = useState<AutomationPreview | null>(null);
  const [record, setRecord] = useState('');
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [approved, setApproved] = useState(false);
  const keys = useRef<Record<string, string>>({});
  const inFlight = useRef(false);
  const keyFor = (k: string) => (keys.current[k] ??= newIdempotencyKey());
  const settle = (k: string, err?: unknown) => {
    if (!err || !ambiguous(err)) delete keys.current[k];
  };
  const brandIds = a ? (a.scope.kind === 'brand' ? [a.scope.brand.id] : a.draft.scope.brands) : [];
  const refs = useRefs(ws, brandIds);

  const show = useCallback(
    (x: Automation, keepEdits = false) => {
      setA(x);
      const draft = account ? readAutomationDraft(account, ws, id) : null;
      if (draft && !keepEdits) {
        setDef(draft.definition);
        setName(draft.name);
        setProjects(draft.projects);
        setDirty(true);
        setRestored(true);
        if (draft.version !== x.version) setConflict(true);
      } else if (!keepEdits) {
        setDef(x.draft.definition);
        setName(x.name);
        setProjects(x.draft.scope.projects ?? []);
        setDirty(false);
      }
    },
    [account, ws, id],
  );
  const loadRuns = useCallback(() => {
    automationsClient
      .runs(ws, id)
      .then(setRuns)
      .catch(() => undefined);
  }, [ws, id]);
  const loadFailed = useCallback((err: unknown) => {
    if (err instanceof ApiError && (err.code === 'not_found' || err.code === 'forbidden'))
      setNotFound(true);
    else setProblem(automationProblem(err, 'This automation could not be loaded.'));
  }, []);
  const refresh = useCallback(
    async (keepEdits = false) => {
      try {
        show(await automationsClient.get(ws, id), keepEdits);
        loadRuns();
      } catch (err) {
        loadFailed(err);
      }
    },
    [ws, id, show, loadRuns, loadFailed],
  );
  useEffect(() => {
    // Wait for the account before reading any stored draft.
    if (account === null) return;
    let gone = false;
    automationsClient.get(ws, id).then(
      (x) => {
        if (gone) return;
        show(x);
        loadRuns();
      },
      (err) => {
        if (!gone) loadFailed(err);
      },
    );
    return () => {
      gone = true;
    };
  }, [account, ws, id, show, loadRuns, loadFailed]);

  const edit = (next: Def | null, n = name, p = projects) => {
    setDef(next);
    setName(n);
    setProjects(p);
    setDirty(true);
    setSave('idle');
    if (account && a && next)
      writeAutomationDraft(account, ws, id, {
        version: a.version,
        name: n,
        definition: next,
        projects: p,
      });
  };

  const run = async (k: string, fn: () => Promise<unknown>, done: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setProblem(null);
    try {
      await fn();
      settle(k);
      setSaid(done);
    } catch (err) {
      settle(k, err);
      if (!(err instanceof ApiError && err.code === 'cancelled'))
        setProblem(automationProblem(err, 'That did not work.'));
      if (err instanceof ApiError && err.code === 'conflict' && !err.issues.length)
        setConflict(true);
    } finally {
      inFlight.current = false;
    }
  };

  const saveDraft = () =>
    run(
      'save',
      async () => {
        if (!a || !def) return;
        setSave('saving');
        try {
          const next = await automationsClient.save(
            ws,
            id,
            { name: name.trim(), definition: def, scope: { projects } },
            a.version,
            keyFor('save'),
          );
          if (account) writeAutomationDraft(account, ws, id, null);
          setRestored(false);
          setConflict(false);
          show(next);
          setSave('saved');
        } catch (err) {
          setSave(
            err instanceof ApiError && err.offline
              ? 'offline'
              : err instanceof ApiError && err.code === 'conflict'
                ? 'conflict'
                : 'failed',
          );
          throw err;
        }
      },
      'Draft saved.',
    );

  const activate = () =>
    run(
      'activate',
      async () => {
        if (!a) return;
        const approvals = a.draft_status.outbound.map((o) => ({
          node: o.node,
          webhook: o.webhook,
          fields: o.fields,
        }));
        const next = await automationsClient.activate(
          ws,
          id,
          approvals.length ? { approvals } : {},
          a.version,
          stepUp,
          keyFor('activate'),
        );
        setConfirming(false);
        setApproved(false);
        show(next, true);
        loadRuns();
      },
      'Automation is on.',
    );

  const command = (verb: 'disable' | 'duplicate' | 'archive' | 'unarchive') =>
    run(
      verb,
      async () => {
        const next = await automationsClient.command(ws, id, verb, {}, keyFor(verb));
        if (verb === 'duplicate') navigate(`/workspaces/${ws}/automations/${next.id}`);
        else await refresh(true);
      },
      verb === 'disable'
        ? 'Automation is off. Runs in progress stop before their next step.'
        : verb === 'duplicate'
          ? 'Copied as a new, inactive draft.'
          : 'Done.',
    );

  const doPreview = () =>
    run(
      'preview',
      async () => {
        setPreview(
          await automationsClient.preview(
            ws,
            id,
            record.trim() ? { record: extractId(record) } : {},
          ),
        );
      },
      'Preview ready. Nothing was changed.',
    );

  const runNow = () =>
    run(
      'run',
      async () => {
        await automationsClient.run(
          ws,
          id,
          record.trim() ? { record: extractId(record) } : {},
          keyFor('run'),
        );
        loadRuns();
      },
      'Run queued.',
    );

  if (notFound)
    return (
      <Page title="This page isn't available" section="Not available">
        <p>It may have been removed, or you may not have access.</p>
      </Page>
    );
  if (!a || !def)
    return (
      <Page title="Automation">
        {problem ? (
          <Banner tone="danger" title="Something went wrong">
            {problem}
          </Banner>
        ) : (
          <p role="status">Loading…</p>
        )}
      </Page>
    );
  const canEdit = a.capabilities.configure;
  const recordKind: string | null = str(obj(def.trigger).record) || null;
  const outbound = a.draft_status.outbound;
  return (
    <Page
      title={a.name}
      lead={`${STATE_LABEL[a.state]}${a.active_revision ? ` · version ${a.active_revision} in use` : ' · never activated'}${a.owner ? ` · owner ${a.owner.name}` : ''}`}
    >
      <p>
        <Link to={`/workspaces/${ws}/automations`}>All automations</Link>
      </p>
      {a.suspended_reason ? (
        <Banner tone="warning" title="Suspended">
          {a.suspended_reason === 'owner_departed'
            ? 'Its owner left the workspace. Assign a new owner and turn it on again.'
            : 'Its owner no longer has access to its scope. Turn it on again once access is restored, or assign a new owner.'}
        </Banner>
      ) : null}
      {problem ? (
        <Banner tone="danger" title="That did not work">
          {problem}
        </Banner>
      ) : null}
      {restored ? (
        <Banner tone="info" title="Unsaved edits restored">
          Your unsaved edits on this device were restored.
        </Banner>
      ) : null}
      {conflict ? (
        <Banner
          tone="warning"
          title="This automation changed"
          action={
            <span className="actions-compact">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => void refresh(true).then(() => setConflict(false))}
              >
                Reload and keep my edits
              </button>
              <button
                type="button"
                className="button button-ghost"
                onClick={() => {
                  if (account) writeAutomationDraft(account, ws, id, null);
                  setRestored(false);
                  setConflict(false);
                  void refresh();
                }}
              >
                Discard my edits
              </button>
            </span>
          }
        >
          Someone saved a newer version. Your unsaved edits are kept on this device.
        </Banner>
      ) : null}

      <section
        className="card au-section"
        aria-labelledby="au-control-h"
        aria-busy={save === 'saving'}
      >
        <h2 id="au-control-h">Status</h2>
        <div className="actions au-actions">
          {canEdit && (a.capabilities.activate || !a.draft_status.matches_active) ? (
            <button
              type="button"
              className="button button-primary"
              disabled={dirty || !a.draft_status.valid || a.draft_status.unavailable.length > 0}
              onClick={() => (outbound.length ? setConfirming(true) : void activate())}
            >
              {a.enabled ? 'Activate this draft' : 'Turn on'}
            </button>
          ) : null}
          {canEdit && a.enabled ? (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void command('disable')}
            >
              Turn off
            </button>
          ) : null}
          {canEdit ? (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void command('duplicate')}
            >
              Duplicate
            </button>
          ) : null}
          {canEdit ? (
            <button
              type="button"
              className="button button-ghost"
              onClick={() => void command(a.state === 'archived' ? 'unarchive' : 'archive')}
            >
              {a.state === 'archived' ? 'Restore' : 'Archive'}
            </button>
          ) : null}
        </div>
        {dirty ? <p className="hint">Save the draft before turning it on.</p> : null}
        {a.draft_status.unavailable.length ? (
          <p className="hint">
            This draft uses something that is not available yet, so it cannot be turned on.
          </p>
        ) : null}
        {!a.draft_status.valid ? (
          <ul className="au-issues" aria-label="Problems in this draft">
            {a.draft_status.issues.map((i) => (
              <li key={`${i.pointer}-${i.code}`}>
                {i.message} <span className="hint">({i.pointer})</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {canEdit ? (
        <form
          className="card au-section"
          aria-label="Edit draft"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void saveDraft();
          }}
        >
          <h2>Draft</h2>
          <p className="hint">
            Edits change only the draft. The version in use keeps running until you turn this draft
            on.
          </p>
          <Input
            id="au-edit-name"
            label="Name"
            value={name}
            onChange={(v) => edit(def, v)}
            maxLength={120}
          />
          <TriggerEditor
            value={obj(def.trigger)}
            onChange={(t) => edit({ ...def, trigger: t, conditions: def.conditions ?? null })}
          />
          <fieldset className="au-group">
            <legend>Conditions</legend>
            {recordKind ? (
              def.conditions ? (
                <>
                  <ConditionGroup
                    path="c"
                    value={obj(def.conditions)}
                    kind={recordKind}
                    refs={refs}
                    onChange={(c) => edit({ ...def, conditions: c })}
                    depth={0}
                  />
                  <button
                    type="button"
                    className="button button-ghost"
                    onClick={() => edit({ ...def, conditions: null })}
                  >
                    Remove all conditions
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() =>
                    edit({
                      ...def,
                      conditions: { all: [{ field: 'priority', op: 'eq', value: 'high' }] },
                    })
                  }
                >
                  Add a condition
                </button>
              )
            ) : (
              <p className="hint">A scheduled automation has no record to check.</p>
            )}
          </fieldset>
          <StepsEditor
            steps={defs(def.steps)}
            kind={recordKind}
            refs={refs}
            onChange={(s) => edit({ ...def, steps: s })}
          />
          <div className="actions">
            <button
              type="submit"
              className="button button-primary"
              disabled={!dirty || save === 'saving'}
            >
              {save === 'saving' ? 'Saving…' : 'Save draft'}
            </button>
            <span className="hint" aria-live="polite">
              {save === 'saved'
                ? 'Saved.'
                : save === 'offline'
                  ? 'Offline: kept on this device.'
                  : save === 'conflict'
                    ? 'Changed elsewhere.'
                    : save === 'failed'
                      ? 'Not saved.'
                      : dirty
                        ? 'Unsaved changes.'
                        : ''}
            </span>
          </div>
        </form>
      ) : null}

      <section className="card au-section" aria-labelledby="au-preview-h">
        <h2 id="au-preview-h">Preview and run</h2>
        <Input
          id="au-record"
          label="Record to try it with"
          value={record}
          onChange={setRecord}
          hint="Paste a task or project link or ID. A preview changes nothing and is not a promise about later runs."
        />
        <div className="actions">
          {canEdit ? (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void doPreview()}
            >
              Preview
            </button>
          ) : null}
          {a.capabilities.run ? (
            <button type="button" className="button button-secondary" onClick={() => void runNow()}>
              Run now
            </button>
          ) : null}
        </div>
        {preview ? <PreviewView p={preview} /> : null}
      </section>

      <section className="card au-section" aria-labelledby="au-runs-h">
        <h2 id="au-runs-h">Run history</h2>
        {runs.length ? (
          <ul className="au-list" aria-label="Runs">
            {runs.map((r) => (
              <li key={r.id} className="au-list-item">
                <Link to={`/workspaces/${ws}/automations/${id}/runs/${r.id}`}>
                  {new Date(r.created_at).toLocaleString()}
                </Link>
                <span className={`au-chip au-chip-${r.status}`}>
                  {STATUS[r.status] ?? r.status}
                </span>
                <span className="hint">{r.explanation}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">No runs yet.</p>
        )}
      </section>

      {confirming ? (
        <Dialog title="Approve what this automation sends" onClose={() => setConfirming(false)}>
          <p>Each time it runs, this version will send, without asking again:</p>
          <ul>
            {outbound.map((o) => (
              <li key={o.node}>
                {o.fields.join(', ')} of the triggering record to{' '}
                {refs.webhooks.find((h) => h.value === o.webhook)?.url ?? o.webhook}
              </li>
            ))}
          </ul>
          <p>
            This approval covers only this version, these destinations, these fields, and this
            scope. If a send&apos;s outcome is unknown, it is not sent again automatically: an owner
            or administrator must confirm what happened before the run continues.
          </p>
          <div className="choice">
            <input
              id="au-approve"
              type="checkbox"
              checked={approved}
              onChange={(e) => setApproved(e.target.checked)}
            />
            <label htmlFor="au-approve">I approve this standing disclosure</label>
          </div>
          <div className="actions">
            <button
              type="button"
              className="button button-secondary"
              data-cancel
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={!approved}
              onClick={() => void activate()}
            >
              Approve and turn on
            </button>
          </div>
        </Dialog>
      ) : null}
      <Announce>{said}</Announce>
    </Page>
  );
}

const extractId = (raw: string) => /(tsk|prj)_[0-9A-HJKMNP-TV-Z]{26}/.exec(raw)?.[0] ?? raw.trim();

function PreviewView({ p }: { p: AutomationPreview }) {
  return (
    <div className="au-preview" role="region" aria-label="Preview result">
      {p.conditions ? (
        <p>
          Conditions:{' '}
          {p.conditions.refused
            ? 'cannot be checked with your current access'
            : p.conditions.result
              ? 'met'
              : 'not met, so nothing would run'}
        </p>
      ) : null}
      <ol>
        {p.steps.map((s) => (
          <li key={s.node}>
            <strong>{s.node}</strong> — {OUTCOME[s.outcome] ?? s.outcome}
            {s.action ? ` (${s.action})` : ''}
            {s.code ? <span className="hint"> · {s.code}</span> : null}
            {s.targets?.length ? (
              <span className="hint"> · {s.targets.length} record(s)</span>
            ) : null}
            {s.discloses ? (
              <span className="hint"> · would send {s.discloses.fields.join(', ')}</span>
            ) : null}
            {s.note ? <span className="hint"> · {s.note}</span> : null}
          </li>
        ))}
      </ol>
      <p className="hint">{p.bounds.note}</p>
    </div>
  );
}
const OUTCOME: Record<string, string> = {
  would_run: 'would run',
  would_refuse: 'would be refused',
  would_wait: 'would wait',
  then: 'conditions met',
  else: 'conditions not met',
  unavailable: 'not available yet',
};

function TriggerEditor({ value, onChange }: { value: Def; onChange: (v: Def) => void }) {
  const kind = str(value.kind, 'record.created');
  const records = RECORD_TRIGGERS[kind] ?? [];
  const record = str(value.record, records[0] ?? 'task');
  const set = (patch: Def) => onChange({ ...value, ...patch });
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const switchKind = (k: string) => {
    const rec = RECORD_TRIGGERS[k]?.[0];
    if (k === 'schedule')
      onChange({
        kind: k,
        rule: 'FREQ=DAILY',
        start: `${new Date().toISOString().slice(0, 10)}T09:00`,
        timezone: zone,
      });
    else if (k === 'date')
      onChange({
        kind: k,
        record: 'task',
        field: 'due_date',
        offset_days: 0,
        at: '09:00',
        timezone: zone,
      });
    else if (k === 'record.field_changed') onChange({ kind: k, record: rec, fields: ['priority'] });
    else onChange({ kind: k, ...(rec ? { record: rec } : {}) });
  };
  const watched = strs(value.fields);
  return (
    <fieldset className="au-group">
      <legend>When</legend>
      <Select
        id="au-trigger"
        label="Trigger"
        value={kind}
        options={TRIGGERS}
        onChange={switchKind}
      />
      {records.length > 1 ? (
        <Select
          id="au-trigger-record"
          label="Record"
          value={record}
          options={records.map((r) => ({ value: r, label: r }))}
          onChange={(r) =>
            set({
              record: r,
              ...(kind === 'record.field_changed' ? { fields: [WATCH[r]![1]!.value] } : {}),
            })
          }
        />
      ) : null}
      {kind === 'record.field_changed' ? (
        <fieldset className="au-group">
          <legend>Fields to watch</legend>
          {(WATCH[record] ?? WATCH.task!).map((f) => (
            <div key={f.value} className="choice">
              <input
                id={`au-watch-${f.value}`}
                type="checkbox"
                checked={watched.includes(f.value)}
                onChange={(e) =>
                  set({
                    fields: e.target.checked
                      ? [...watched, f.value]
                      : watched.filter((x) => x !== f.value),
                  })
                }
              />
              <label htmlFor={`au-watch-${f.value}`}>{f.label}</label>
            </div>
          ))}
        </fieldset>
      ) : null}
      {kind === 'record.status_changed' ? (
        <Select
          id="au-trigger-cat"
          label="To status category"
          value={str(value.to_category)}
          options={[{ value: '', label: 'Any' }, ...CATEGORIES]}
          onChange={(c) => set({ to_category: c || null })}
        />
      ) : null}
      {kind === 'approval.decided' ? (
        <Select
          id="au-trigger-decision"
          label="Decision"
          value={str(value.decision)}
          options={[
            { value: '', label: 'Any' },
            { value: 'approved', label: 'Approved' },
            { value: 'changes_requested', label: 'Changes requested' },
            { value: 'rejected', label: 'Rejected' },
          ]}
          onChange={(d) => set({ decision: d || null })}
        />
      ) : null}
      {kind === 'schedule' ? (
        <>
          <Select
            id="au-rule"
            label="Repeats"
            value={str(value.rule, 'FREQ=DAILY')}
            options={RULES}
            onChange={(r) => set({ rule: r })}
          />
          <Input
            id="au-start"
            label="Starting at (local time)"
            type="datetime-local"
            value={str(value.start)}
            onChange={(x) => set({ start: x.slice(0, 16) })}
          />
          <Input
            id="au-tz"
            label="Time zone"
            value={str(value.timezone)}
            onChange={(x) => set({ timezone: x })}
            hint="Times stay the same local time across daylight-saving changes."
          />
        </>
      ) : null}
      {kind === 'date' ? (
        <>
          <Select
            id="au-date-field"
            label="Date"
            value={str(value.field, 'due_date')}
            options={[
              { value: 'due_date', label: 'Due date' },
              { value: 'start_date', label: 'Start date' },
            ]}
            onChange={(f) => set({ field: f })}
          />
          <Input
            id="au-date-offset"
            label="Days from the date (negative is before)"
            type="number"
            value={num(value.offset_days)}
            onChange={(x) => set({ offset_days: Number(x) })}
          />
          <Input
            id="au-date-at"
            label="At (local time)"
            type="time"
            value={str(value.at, '09:00')}
            onChange={(x) => set({ at: x })}
          />
          <Input
            id="au-date-tz"
            label="Time zone"
            value={str(value.timezone)}
            onChange={(x) => set({ timezone: x })}
          />
        </>
      ) : null}
    </fieldset>
  );
}

function ConditionGroup({
  path,
  value,
  kind,
  refs,
  onChange,
  depth,
}: {
  path: string;
  value: Def;
  kind: string;
  refs: Refs;
  onChange: (v: Def | null) => void;
  depth: number;
}) {
  const mode: 'all' | 'any' = 'any' in value ? 'any' : 'all';
  const items = defs(value[mode]);
  const setItems = (next: Def[]) => (next.length ? onChange({ [mode]: next }) : onChange(null));
  return (
    <fieldset className="au-group au-condition-group">
      <legend>{depth ? 'Group' : 'Match'}</legend>
      <Select
        id={`${path}-mode`}
        label="Match"
        value={mode}
        options={[
          { value: 'all', label: 'All of these (AND)' },
          { value: 'any', label: 'Any of these (OR)' },
        ]}
        onChange={(m) => onChange({ [m]: items })}
      />
      <ul className="au-conditions">
        {items.map((c, i) => (
          <li key={i}>
            {'all' in c || 'any' in c ? (
              <ConditionGroup
                path={`${path}-${i}`}
                value={c}
                kind={kind}
                refs={refs}
                depth={depth + 1}
                onChange={(n) =>
                  setItems(
                    n ? items.map((x, j) => (j === i ? n : x)) : items.filter((_, j) => j !== i),
                  )
                }
              />
            ) : (
              <ConditionRow
                path={`${path}-${i}`}
                value={c}
                kind={kind}
                refs={refs}
                onChange={(n) => setItems(items.map((x, j) => (j === i ? n : x)))}
                onRemove={() => setItems(items.filter((_, j) => j !== i))}
              />
            )}
          </li>
        ))}
      </ul>
      <div className="actions-compact">
        <button
          type="button"
          className="button button-ghost"
          onClick={() => setItems([...items, { field: 'priority', op: 'eq', value: 'high' }])}
        >
          Add condition
        </button>
        {depth < 2 ? (
          <button
            type="button"
            className="button button-ghost"
            onClick={() =>
              setItems([...items, { any: [{ field: 'priority', op: 'eq', value: 'urgent' }] }])
            }
          >
            Add group
          </button>
        ) : null}
      </div>
    </fieldset>
  );
}

function ConditionRow({
  path,
  value,
  kind,
  refs,
  onChange,
  onRemove,
}: {
  path: string;
  value: Def;
  kind: string;
  refs: Refs;
  onChange: (v: Def) => void;
  onRemove: () => void;
}) {
  const fields = FIELDS[kind] ?? FIELDS.task!;
  const def = fields.find((f) => f.value === value.field) ?? fields[0]!;
  const ops = OPS[def.type] ?? [];
  const op = str(value.op, ops[0]?.value ?? '');
  const noValue = op === 'is_set' || op === 'is_not_set';
  const setField = (f: string) => {
    const t = fields.find((x) => x.value === f)!.type;
    onChange({
      field: f,
      op: OPS[t]![0]!.value,
      value:
        t === 'date'
          ? { relative_days: 0 }
          : t === 'priority'
            ? 'high'
            : t === 'category'
              ? 'planned'
              : '',
    });
  };
  const id = `${path}-value`;
  const set = (v: unknown) => onChange({ ...value, value: v });
  const pick = (label: string, options: Option[]) => (
    <Select
      id={id}
      label={label}
      hideLabel
      value={str(value.value)}
      options={[{ value: '', label: 'Choose…' }, ...options]}
      onChange={set}
    />
  );
  const valueInput = (): ReactNode => {
    if (noValue) return null;
    switch (def.type) {
      case 'priority':
        return (
          <Select
            id={id}
            label="Value"
            hideLabel
            value={str(value.value)}
            options={PRIORITIES}
            onChange={set}
          />
        );
      case 'category':
        return (
          <Select
            id={id}
            label="Value"
            hideLabel
            value={str(value.value)}
            options={CATEGORIES}
            onChange={set}
          />
        );
      case 'date':
        return (
          <Input
            id={id}
            label="Days from the run day"
            type="number"
            value={num(obj(value.value).relative_days)}
            onChange={(v) => set({ relative_days: Number(v) })}
          />
        );
      case 'member':
        return pick('Person', refs.members);
      case 'label':
        return pick('Label', refs.labels);
      case 'project':
        return pick('Project', refs.projects);
      default:
        return (
          <Input
            id={id}
            label="Value"
            hideLabel
            value={str(value.value)}
            onChange={set}
            maxLength={200}
          />
        );
    }
  };
  return (
    <div className="au-row" role="group" aria-label={`Condition on ${def.label}`}>
      <Select
        id={`${path}-field`}
        label="Field"
        hideLabel
        value={def.value}
        options={fields}
        onChange={setField}
      />
      <Select
        id={`${path}-op`}
        label="Comparison"
        hideLabel
        value={op}
        options={ops}
        onChange={(o) =>
          onChange({
            ...value,
            op: o,
            ...(o === 'is_set' || o === 'is_not_set' ? { value: undefined } : {}),
          })
        }
      />
      {valueInput()}
      <button type="button" className="button button-ghost" onClick={onRemove}>
        Remove<span className="visually-hidden"> condition on {def.label}</span>
      </button>
    </div>
  );
}

function StepsEditor({
  steps,
  kind,
  refs,
  onChange,
}: {
  steps: Def[];
  kind: string | null;
  refs: Refs;
  onChange: (s: Def[]) => void;
}) {
  const ids = steps.map((s) => str(s.id));
  const edgeOptions = (self: string): Option[] => [
    { value: '', label: 'The next step' },
    { value: '__end', label: 'Stop' },
    ...ids.filter((x) => x !== self).map((x) => ({ value: x, label: `Step "${x}"` })),
  ];
  const fromEdge = (v: string) => (v === '' ? undefined : v === '__end' ? null : v);
  const toEdge = (v: unknown) => (v === undefined ? '' : v === null ? '__end' : str(v));
  const setStep = (i: number, s: Def) => onChange(steps.map((x, j) => (j === i ? s : x)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...steps];
    const [s] = next.splice(i, 1);
    next.splice(i + d, 0, s!);
    onChange(next);
  };
  const nextId = () => {
    let n = steps.length + 1;
    while (ids.includes(`step${n}`)) n++;
    return `step${n}`;
  };
  const actionOptions = ACTIONS[kind ?? 'none'] ?? ACTIONS.none!;
  return (
    <fieldset className="au-group">
      <legend>Then</legend>
      {!steps.length ? <p className="hint">Add at least one step.</p> : null}
      <ol className="au-steps">
        {steps.map((s, i) => {
          const sid = str(s.id);
          const type = str(s.type, 'action');
          const fb = s.fallback ? obj(s.fallback) : null;
          const on = strs(fb?.on);
          const when = obj(s.when);
          return (
            <li key={sid}>
              <fieldset className="au-step">
                <legend>
                  Step {i + 1}: {sid}
                </legend>
                <Select
                  id={`st-${sid}-type`}
                  label="Kind"
                  value={type}
                  options={[
                    { value: 'action', label: 'Do something' },
                    { value: 'branch', label: 'Branch on a condition' },
                    { value: 'delay', label: 'Wait' },
                  ]}
                  onChange={(t) =>
                    setStep(
                      i,
                      t === 'action'
                        ? { id: sid, type: 'action', action: actionOptions[0]!.value, params: {} }
                        : t === 'branch'
                          ? {
                              id: sid,
                              type: 'branch',
                              when: { all: [{ field: 'priority', op: 'eq', value: 'high' }] },
                              then: null,
                              else: null,
                            }
                          : { id: sid, type: 'delay', minutes: 60 },
                    )
                  }
                />
                {type === 'action' ? (
                  <>
                    <Select
                      id={`st-${sid}-action`}
                      label="Action"
                      value={str(s.action)}
                      options={actionOptions}
                      onChange={(act) => setStep(i, { ...s, action: act, params: {} })}
                    />
                    <ActionParams
                      id={sid}
                      action={str(s.action)}
                      params={obj(s.params)}
                      refs={refs}
                      onChange={(p) => setStep(i, { ...s, params: p })}
                    />
                    <Select
                      id={`st-${sid}-next`}
                      label="Afterwards"
                      value={toEdge(s.next)}
                      options={edgeOptions(sid)}
                      onChange={(v) => setStep(i, { ...s, next: fromEdge(v) })}
                    />
                    <fieldset className="au-group">
                      <legend>If it fails</legend>
                      {FAILURES.map((f) => (
                        <div key={f.value} className="choice">
                          <input
                            id={`st-${sid}-fb-${f.value}`}
                            type="checkbox"
                            checked={on.includes(f.value)}
                            onChange={(e) => {
                              const next = e.target.checked
                                ? [...on, f.value]
                                : on.filter((x) => x !== f.value);
                              setStep(i, {
                                ...s,
                                fallback: next.length ? { on: next, next: fb?.next ?? null } : null,
                              });
                            }}
                          />
                          <label htmlFor={`st-${sid}-fb-${f.value}`}>{f.label}</label>
                        </div>
                      ))}
                      {fb ? (
                        <Select
                          id={`st-${sid}-fbnext`}
                          label="Then go to"
                          value={toEdge(fb.next)}
                          options={edgeOptions(sid).filter((o) => o.value !== '')}
                          onChange={(v) =>
                            setStep(i, { ...s, fallback: { ...fb, next: fromEdge(v) ?? null } })
                          }
                        />
                      ) : (
                        <p className="hint">
                          Without a fallback, a failed step ends the run as failed.
                        </p>
                      )}
                    </fieldset>
                  </>
                ) : null}
                {type === 'branch' && kind ? (
                  <>
                    <ConditionGroup
                      path={`st-${sid}-when`}
                      value={'all' in when || 'any' in when ? when : { all: [when] }}
                      kind={kind}
                      refs={refs}
                      depth={1}
                      onChange={(c) =>
                        setStep(i, {
                          ...s,
                          when: c ?? { all: [{ field: 'priority', op: 'eq', value: 'high' }] },
                        })
                      }
                    />
                    <Select
                      id={`st-${sid}-then`}
                      label="If met, go to"
                      value={toEdge(s.then)}
                      options={edgeOptions(sid).filter((o) => o.value !== '')}
                      onChange={(v) => setStep(i, { ...s, then: fromEdge(v) ?? null })}
                    />
                    <Select
                      id={`st-${sid}-else`}
                      label="Otherwise, go to"
                      value={toEdge(s.else)}
                      options={edgeOptions(sid).filter((o) => o.value !== '')}
                      onChange={(v) => setStep(i, { ...s, else: fromEdge(v) ?? null })}
                    />
                  </>
                ) : null}
                {type === 'delay' ? (
                  <>
                    <Input
                      id={`st-${sid}-minutes`}
                      label="Minutes to wait"
                      type="number"
                      value={num(s.minutes, 60)}
                      onChange={(v) => setStep(i, { ...s, minutes: Number(v) })}
                      hint="The run waits without holding anything; everything is checked again when it continues."
                    />
                    <Select
                      id={`st-${sid}-next`}
                      label="Afterwards"
                      value={toEdge(s.next)}
                      options={edgeOptions(sid)}
                      onChange={(v) => setStep(i, { ...s, next: fromEdge(v) })}
                    />
                  </>
                ) : null}
                <div className="actions-compact">
                  <button
                    type="button"
                    className="button button-ghost"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    Move up<span className="visually-hidden"> step {sid}</span>
                  </button>
                  <button
                    type="button"
                    className="button button-ghost"
                    disabled={i === steps.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    Move down<span className="visually-hidden"> step {sid}</span>
                  </button>
                  <button
                    type="button"
                    className="button button-ghost"
                    onClick={() => onChange(steps.filter((_, j) => j !== i))}
                  >
                    Remove<span className="visually-hidden"> step {sid}</span>
                  </button>
                </div>
              </fieldset>
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        className="button button-secondary"
        onClick={() =>
          onChange([
            ...steps,
            {
              id: nextId(),
              type: 'action',
              action: actionOptions[0]!.value,
              params:
                actionOptions[0]!.value === 'task.update' ? { fields: { priority: 'high' } } : {},
            },
          ])
        }
      >
        Add step
      </button>
    </fieldset>
  );
}

function ActionParams({
  id: sid,
  action,
  params: p,
  refs,
  onChange,
}: {
  id: string;
  action: string;
  params: Def;
  refs: Refs;
  onChange: (p: Def) => void;
}) {
  const id = (k: string) => `st-${sid}-${k}`;
  const set = (patch: Def) => onChange({ ...p, ...patch });
  const fields = obj(p.fields);
  const field = (k: string, v: string | null) => {
    const next = { ...fields };
    if (v === null || v === '') delete next[k];
    else next[k] = v;
    set({ fields: next });
  };
  const days = (k: string, label: string): ReactNode => (
    <Input
      id={id(k)}
      label={label}
      type="number"
      value={p[k] === undefined ? '' : num(obj(p[k]).days)}
      onChange={(v) => set({ [k]: v === '' ? undefined : { days: Number(v) } })}
      hint="Days from the day it runs."
    />
  );
  const named = action === 'task.update' ? 'title' : 'name';
  const sel = (
    k: string,
    label: string,
    options: Option[],
    v = str(p[k]),
    fn = (x: string) => set({ [k]: x }),
  ) => (
    <Select
      id={id(k)}
      label={label}
      value={v}
      options={[{ value: '', label: 'Choose…' }, ...options]}
      onChange={fn}
    />
  );
  const checks = (k: string, list: string[]) => {
    const chosen = strs(p[k]);
    return list.map((f) => (
      <div key={f} className="choice">
        <input
          id={id(`f-${f}`)}
          type="checkbox"
          checked={chosen.includes(f)}
          onChange={(e) =>
            set({ [k]: e.target.checked ? [...chosen, f] : chosen.filter((x) => x !== f) })
          }
        />
        <label htmlFor={id(`f-${f}`)}>{f.replace('_', ' ')}</label>
      </div>
    ));
  };
  switch (action) {
    case 'task.update':
    case 'project.update':
      return (
        <>
          <Select
            id={id('priority')}
            label="Priority"
            value={str(fields.priority)}
            options={[{ value: '', label: 'Leave as is' }, ...PRIORITIES]}
            onChange={(v) => field('priority', v)}
          />
          <Input
            id={id('status')}
            label="Status (key)"
            value={str(fields.status)}
            onChange={(v) => field('status', v)}
            hint="A status this record's workflow offers; leave empty to keep it."
          />
          <Input
            id={id('title')}
            label={action === 'task.update' ? 'New title' : 'New name'}
            value={str(fields[named])}
            onChange={(v) => field(named, v)}
            maxLength={200}
          />
        </>
      );
    case 'task.assign':
      return (
        <>
          <Select
            id={id('mode')}
            label="How"
            value={str(p.mode, 'add')}
            options={[
              { value: 'add', label: 'Add' },
              { value: 'replace', label: 'Replace everyone' },
            ]}
            onChange={(v) => set({ mode: v })}
          />
          {sel('who', 'Person', refs.members, strs(p.assignees)[0] ?? '', (v) =>
            set({ mode: str(p.mode, 'add'), assignees: v ? [v] : [] }),
          )}
        </>
      );
    case 'task.label':
      return (
        <>
          <Select
            id={id('mode')}
            label="How"
            value={str(p.mode, 'add')}
            options={[
              { value: 'add', label: 'Add' },
              { value: 'remove', label: 'Remove' },
            ]}
            onChange={(v) => set({ mode: v })}
          />
          {sel('label', 'Label', refs.labels, str(p.label), (v) =>
            set({ mode: str(p.mode, 'add'), label: v }),
          )}
        </>
      );
    case 'task.schedule':
      return (
        <>
          {days('start', 'Start date')}
          {days('due', 'Due date')}
        </>
      );
    case 'project.schedule':
      return (
        <>
          {days('start', 'Start date')}
          {days('target', 'Target date')}
        </>
      );
    case 'task.move':
      return sel('project', 'Project', refs.projects);
    case 'task.relate':
      return (
        <>
          <Select
            id={id('kind')}
            label="Relationship"
            value={str(p.kind, 'related')}
            options={[
              { value: 'related', label: 'Related to' },
              { value: 'blocks', label: 'Blocks' },
            ]}
            onChange={(v) => set({ kind: v })}
          />
          <Input
            id={id('to')}
            label="Task (link or ID)"
            value={str(p.to)}
            onChange={(v) => set({ kind: str(p.kind, 'related'), to: extractId(v) })}
          />
        </>
      );
    case 'task.create':
      return (
        <>
          <Input
            id={id('title')}
            label="Title"
            value={str(p.title)}
            onChange={(v) => set({ title: v })}
            maxLength={200}
          />
          {sel(
            'where',
            'Where',
            [
              { value: 'trigger.project', label: "The trigger record's project" },
              { value: '__parent', label: 'Under the trigger task' },
              ...refs.projects,
            ],
            p.parent === 'trigger' ? '__parent' : str(p.project),
            (v) => {
              const rest = { ...p };
              delete rest.project;
              delete rest.parent;
              onChange(v === '__parent' ? { ...rest, parent: 'trigger' } : { ...rest, project: v });
            },
          )}
          {days('due', 'Due date')}
        </>
      );
    case 'task.notify':
    case 'project.notify':
      return (
        <>
          {sel(
            'to',
            'Who',
            [
              ...(action === 'task.notify' ? [{ value: 'assignees', label: 'The assignees' }] : []),
              { value: 'owner', label: 'The owner' },
              ...refs.members,
            ],
            strs(p.recipients)[0] ?? '',
            (v) => set({ recipients: v ? [v] : [] }),
          )}
          <Input
            id={id('message')}
            label="Message"
            value={str(p.message)}
            onChange={(v) => set({ message: v })}
            maxLength={280}
            hint="Only people who can read the record are told."
          />
        </>
      );
    case 'ai.draft':
      return (
        <>
          {sel('action', 'AI action', [
            { value: 'summarize.v1', label: 'Summarize' },
            { value: 'draft_tasks.v1', label: 'Draft tasks' },
            { value: 'draft_status_update.v1', label: 'Draft a status update' },
            { value: 'categorize.v1', label: 'Suggest labels' },
            { value: 'recommend_next.v1', label: 'Recommend next steps' },
          ])}
          <Input
            id={id('instruction')}
            label="Instruction (optional)"
            value={str(p.instruction)}
            onChange={(v) => set({ instruction: v || undefined })}
            maxLength={1000}
            hint="Drafts wait for the owner's review; nothing is applied automatically."
          />
        </>
      );
    case 'webhook.send':
      return (
        <>
          {sel('subscription', 'Webhook', refs.webhooks, str(p.subscription), (v) =>
            set({ subscription: v, fields: strs(p.fields).length ? strs(p.fields) : ['status'] }),
          )}
          <fieldset className="au-group">
            <legend>Fields it may send</legend>
            {checks('fields', [
              'status',
              'status_category',
              'priority',
              'due_date',
              'start_date',
              'project',
            ])}
          </fieldset>
        </>
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------------------------

export function AutomationRunPage({ ws, aut, run }: { ws: string; aut: string; run: string }) {
  const stepUp = useStepUp();
  const { navigate } = useRouter();
  const [r, setR] = useState<AutomationRun | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [said, setSaid] = useState('');
  const keys = useRef<Record<string, string>>({});
  const load = useCallback(() => {
    automationsClient
      .runDetail(ws, run)
      .then(setR)
      .catch((err) =>
        err instanceof ApiError && err.code === 'not_found'
          ? setNotFound(true)
          : setProblem(automationProblem(err, 'This run could not be loaded.')),
      );
  }, [ws, run]);
  useEffect(load, [load]);
  const act = async (verb: 'retry' | 'cancel') => {
    keys.current[verb] ??= newIdempotencyKey();
    try {
      const next = await automationsClient.runCommand(ws, run, verb, keys.current[verb]!);
      delete keys.current[verb];
      setSaid(
        verb === 'retry' ? 'Retry queued. It continues from the failed step.' : 'Run cancelled.',
      );
      if (next.id !== run) navigate(`/workspaces/${ws}/automations/${aut}/runs/${next.id}`);
      else setR(next);
    } catch (err) {
      if (!ambiguous(err)) delete keys.current[verb];
      setProblem(automationProblem(err, 'That did not work.'));
    }
  };
  const reconcile = async (
    key: string,
    version: number,
    decision: 'sent' | 'retry' | 'abandon',
  ) => {
    try {
      await automationsClient.reconcile(
        ws,
        run,
        key,
        { decision, version },
        stepUp,
        newIdempotencyKey(),
      );
      setSaid('Recorded.');
      load();
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled'))
        setProblem(automationProblem(err, 'That could not be recorded.'));
    }
  };
  const status = useMemo(() => (r ? (STATUS[r.status] ?? r.status) : ''), [r]);
  if (notFound)
    return (
      <Page title="This page isn't available" section="Not available">
        <p>It may have been removed, or you may not have access.</p>
      </Page>
    );
  return (
    <Page
      title={r ? `Run of ${r.automation.name}` : 'Run'}
      lead={r ? `${status} · version ${r.revision}` : undefined}
    >
      <p>
        <Link to={`/workspaces/${ws}/automations/${aut}`}>Back to the automation</Link>
      </p>
      {problem ? (
        <Banner tone="danger" title="That did not work">
          {problem}
        </Banner>
      ) : null}
      {!r ? <p role="status">Loading…</p> : null}
      {r ? (
        <>
          <section className="card au-section" aria-labelledby="au-run-h">
            <h2 id="au-run-h">What happened</h2>
            <p>
              <span className={`au-chip au-chip-${r.status}`}>{status}</span> {r.explanation}
            </p>
            <dl className="au-facts">
              <div>
                <dt>Trigger</dt>
                <dd>{r.trigger.kind}</dd>
              </div>
              <div>
                <dt>Started</dt>
                <dd>{r.started_at ? new Date(r.started_at).toLocaleString() : 'Not yet'}</dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>
                  {r.duration_ms !== null ? `${Math.round(r.duration_ms / 100) / 10} s` : '—'}
                </dd>
              </div>
              <div>
                <dt>Steps run</dt>
                <dd>{r.steps_executed}</dd>
              </div>
            </dl>
            {r.wake_at ? <p>Continues after {new Date(r.wake_at).toLocaleString()}.</p> : null}
            <div className="actions">
              {r.capabilities.retry ? (
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => void act('retry')}
                >
                  Retry from the failed step
                </button>
              ) : null}
              {r.capabilities.cancel ? (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => void act('cancel')}
                >
                  Cancel run
                </button>
              ) : null}
            </div>
          </section>
          {r.reconciliation_required ? (
            <section className="card au-section" aria-labelledby="au-rec-h">
              <h2 id="au-rec-h">A send needs confirming</h2>
              <p>
                A webhook may have been sent, but its outcome is unknown. It will not be sent again
                automatically.
              </p>
              {r.capabilities.reconcile ? (
                r.effects.map((e) => (
                  <div key={e.key} className="actions">
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => void reconcile(e.key, e.version, 'sent')}
                    >
                      It was received
                    </button>
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => void reconcile(e.key, e.version, 'retry')}
                    >
                      Send it again
                    </button>
                    <button
                      type="button"
                      className="button button-ghost"
                      onClick={() => void reconcile(e.key, e.version, 'abandon')}
                    >
                      Stop this run
                    </button>
                  </div>
                ))
              ) : (
                <p className="hint">An owner or administrator must confirm what happened.</p>
              )}
            </section>
          ) : null}
          <section className="card au-section" aria-labelledby="au-steps-h">
            <h2 id="au-steps-h">Steps</h2>
            <div className="au-table-wrap" role="region" aria-label="Steps table" tabIndex={0}>
              <table className="au-table">
                <caption className="visually-hidden">Steps of this run</caption>
                <thead>
                  <tr>
                    <th scope="col">Step</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {r.steps.map((s) => (
                    <tr key={`${s.node}-${s.attempt}`}>
                      <td data-label="Step">
                        {s.node === '_conditions' ? 'Conditions' : s.node}
                        {s.action ? <span className="hint"> ({s.action})</span> : null}
                        {s.attempt > 1 ? (
                          <span className="hint"> · attempt {s.attempt}</span>
                        ) : null}
                      </td>
                      <td data-label="Outcome">{s.state}</td>
                      <td data-label="Details">
                        {s.code ? `${s.code}. ` : ''}
                        {s.decision && 'result' in s.decision
                          ? `Result: ${String(s.decision.result)}. `
                          : ''}
                        {s.targets.length ? `${s.targets.length} record(s). ` : ''}
                        {s.ai_run ? 'AI draft requested; it waits for review. ' : ''}
                        {s.webhook ? `Sent ${s.webhook.fields.join(', ')}. ` : ''}
                        {s.duration_ms !== null ? `${s.duration_ms} ms` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
      <Announce>{said}</Announce>
    </Page>
  );
}
