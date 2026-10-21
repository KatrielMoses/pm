import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, newIdempotencyKey } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { Link, useRouter } from '../router.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Announce, Banner } from '../ui/feedback.tsx';
import { Page } from '../ui/layout.tsx';
import {
  agentProblem,
  agentsClient,
  ambiguous,
  reasonText,
  type AgentModel,
  type AgentProfile,
  type AgentTemplate,
  type AgentTool,
  type Assignment,
  type AssignmentPreview,
  type ConnectorTest,
  type Readiness,
  type ScopeView,
} from './client.ts';
import { readAgentDraft, writeAgentDraft } from './drafts.ts';
import { AgentHealthCard, TaskAgentRuns } from './runs.tsx';

/**
 * Phase 8B agents (UXD-33): the profile list with starter templates, the profile editor (typed
 * configuration: instructions, model, limits, registered tools with approvals no weaker than the
 * floor, and an explicit scope), activation, the connector (configure, a confirmed synthetic
 * test, disconnect), lifecycle, and the task Agent section (structured preview, assign, edit,
 * withdraw). Every control is a labelled field or button. Phase 8C adds runs to the task Agent
 * section and agent health with the emergency stop to the list (./runs.tsx).
 */

type Def = Record<string, unknown>;
type Option = { value: string; label: string; disabled?: boolean };
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const obj = (v: unknown): Def =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Def) : {};

const APPROVALS: Option[] = [
  { value: 'none', label: 'No approval' },
  { value: 'low_impact_policy', label: 'Low-impact policy' },
  { value: 'review_required', label: 'Review before it counts' },
  { value: 'human_approval', label: 'A person approves first' },
];
const APPROVAL_RANK = APPROVALS.map((a) => a.value);
const CLASS_LABEL: Record<string, string> = {
  read_records: 'Read records',
  draft_content: 'Draft content',
  create_subtasks: 'Create subtasks',
  attach_artifacts: 'Attach draft deliverables',
  update_records: 'Update records',
  run_tests: 'Run tests',
  code_change: 'Change code',
};
const STATE_LABEL: Record<string, string> = {
  draft: 'Draft',
  active: 'On',
  disabled: 'Off',
  suspended: 'Suspended',
  archived: 'Archived',
  trashed: 'In trash',
};
const CONNECTOR_STATE: Record<string, string> = {
  configured: 'Configured, not tested',
  verified: 'Verified',
  stale: 'Settings changed since the last test',
  revoked: 'Disconnected',
  unavailable: 'Unavailable',
};
const TEST_CODE: Record<string, string> = {
  bad_signature: 'The response signature did not match.',
  version_unsupported: 'The agent speaks an unsupported protocol version.',
  protocol_unsupported: 'The agent speaks an unsupported protocol.',
  nonce_mismatch: 'The agent did not answer this test.',
  too_large: 'The response was too large.',
  redirect_refused: 'The agent redirected the test; redirects are not followed.',
  malformed_response: 'The response was not a valid handshake.',
  upstream_error: 'The agent answered with an error.',
  timeout: 'The agent did not answer in time.',
  transport_unavailable: 'Connection tests are not available in this environment.',
  stale: 'The settings changed while the test ran.',
};
const LIMIT_FIELDS: Array<{ key: string; label: string; min: number; max: number }> = [
  { key: 'max_runtime_minutes', label: 'Longest run (minutes)', min: 1, max: 1440 },
  { key: 'max_tool_calls', label: 'Most tool calls per run', min: 1, max: 1000 },
  { key: 'max_artifacts', label: 'Most deliverables per run', min: 0, max: 100 },
];

function useDraftAccount(): string | null {
  try {
    const me = useAuth().me;
    return me ? me.id : null;
  } catch {
    return 'device';
  }
}

function Select(props: {
  id: string;
  label: string;
  value: string;
  options: Option[];
  onChange: (v: string) => void;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className="field au-field">
      <label htmlFor={props.id}>{props.label}</label>
      <select
        id={props.id}
        value={props.value}
        disabled={props.disabled}
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
  hint?: ReactNode;
  maxLength?: number;
  autoComplete?: string;
}) {
  return (
    <div className="field au-field">
      <label htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        type={props.type ?? 'text'}
        value={props.value}
        maxLength={props.maxLength}
        autoComplete={props.autoComplete}
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

function TextArea(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: ReactNode;
  maxLength?: number;
  rows?: number;
}) {
  return (
    <div className="field au-field">
      <label htmlFor={props.id}>{props.label}</label>
      <textarea
        id={props.id}
        rows={props.rows ?? 4}
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

function Checks(props: {
  legend: string;
  options: Option[];
  value: string[];
  onChange: (v: string[]) => void;
  hint?: ReactNode;
  empty?: string;
}) {
  return (
    <fieldset className="au-group">
      <legend>{props.legend}</legend>
      {props.hint ? <p className="hint">{props.hint}</p> : null}
      {props.options.length ? (
        props.options.map((o) => (
          <label key={o.value} className="ag-check">
            <input
              type="checkbox"
              checked={props.value.includes(o.value)}
              disabled={o.disabled}
              onChange={(e) =>
                props.onChange(
                  e.target.checked
                    ? [...props.value, o.value]
                    : props.value.filter((v) => v !== o.value),
                )
              }
            />{' '}
            {o.label}
          </label>
        ))
      ) : (
        <p className="empty-state">{props.empty ?? 'Nothing to choose from.'}</p>
      )}
    </fieldset>
  );
}

/** Brands, projects, integrations, and people the person can see (each falls back to empty). */
interface Refs {
  brands: Option[];
  projects: Option[];
  integrations: Option[];
  members: Option[];
}
function useRefs(ws: string, enabled = true): Refs {
  const [refs, setRefs] = useState<Refs>({
    brands: [],
    projects: [],
    integrations: [],
    members: [],
  });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const base = `/v1/workspaces/${encodeURIComponent(ws)}`;
    const safe = async <T,>(p: Promise<T>, d: T) => p.catch(() => d);
    void (async () => {
      const [brands, projects, conns, members] = await Promise.all([
        safe(
          api<{ data: Array<{ id: string; name: string }> }>('GET', `${base}/brands`).then(
            (r) => r.body.data,
          ),
          [],
        ),
        safe(
          api<{ data: Array<{ id: string; name: string }> }>('GET', `${base}/projects`).then(
            (r) => r.body.data,
          ),
          [],
        ),
        safe(
          api<{ data: Array<{ id: string; display_name?: string; provider?: string }> }>(
            'GET',
            `${base}/integrations/connections`,
          ).then((r) => (Array.isArray(r.body.data) ? r.body.data : [])),
          [],
        ),
        safe(
          api<{ data: Array<{ id: string; display_name?: string; name?: string; kind?: string }> }>(
            'GET',
            `${base}/people`,
          ).then((r) => r.body.data),
          [],
        ),
      ]);
      if (!live) return;
      setRefs({
        brands: brands.map((b) => ({ value: b.id, label: b.name })),
        projects: projects.map((p) => ({ value: p.id, label: p.name })),
        integrations: conns.map((c) => ({
          value: c.id,
          label: c.display_name ?? c.provider ?? c.id,
        })),
        members: members
          .filter((m) => m.kind !== 'guest')
          .map((m) => ({ value: m.id, label: m.display_name ?? m.name ?? m.id })),
      });
    })();
    return () => {
      live = false;
    };
  }, [ws, enabled]);
  return refs;
}

function ReadinessView({ r, kind }: { r: Readiness; kind: string }) {
  return (
    <div className="ag-readiness" aria-label="Readiness">
      <p>
        <span className={`au-chip au-chip-${r.state === 'ready' ? 'active' : 'suspended'}`}>
          {r.state === 'ready' ? 'Ready' : 'Not ready'}
        </span>
        {r.synthetic ? (
          <span className="hint">
            {' '}
            Verified against a local test {kind === 'external' ? 'agent' : 'model'} only; nothing
            real is connected.
          </span>
        ) : null}
      </p>
      {r.reasons.length ? (
        <ul className="au-issues">
          {r.reasons.map((x) => (
            <li key={x}>{reasonText(x)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Scope items the viewer can open. Items they cannot open are omitted by the server; nothing here
 * counts, flags, or hints at them (review 01 R1).
 */
function ScopeList({ scope, label }: { scope: ScopeView; label: string }) {
  return (
    <div aria-label={label}>
      {scope.items.length ? (
        <ul className="ag-scope">
          {scope.items.map((i) => (
            <li key={`${i.kind}:${i.id}`}>
              <span className="hint">{i.kind}:</span> {i.name}
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-state">No items you can open.</p>
      )}
    </div>
  );
}

const ExecutionNote = () => (
  <p className="hint ag-execution">
    Runs start from a task this agent is assigned to. Its output is a draft for a person to review.
  </p>
);

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

export function AgentsPage({ ws }: { ws: string }) {
  const { navigate } = useRouter();
  const [list, setList] = useState<Awaited<ReturnType<typeof agentsClient.list>> | null>(null);
  const [archived, setArchived] = useState(false);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('');
  const [kind, setKind] = useState('internal');
  const [busy, setBusy] = useState(false);
  const key = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    agentsClient
      .list(ws, archived)
      .then((l) => live && setList(l))
      .catch((err) => live && setError(agentProblem(err, 'Agents could not be loaded.')));
    agentsClient
      .templates(ws)
      .then((t) => live && setTemplates(t))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [ws, archived]);
  const chosen = templates.find((t) => t.key === template);
  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    key.current ??= newIdempotencyKey();
    try {
      const a = await agentsClient.create(
        ws,
        {
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(template ? { template } : { kind }),
        },
        key.current,
      );
      key.current = null;
      navigate(`/workspaces/${ws}/agents/${a.id}`);
    } catch (err) {
      if (!ambiguous(err)) key.current = null;
      setError(agentProblem(err, 'The agent could not be created.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page
      title="Agents"
      lead="Agent profiles say what an agent may read and draft, where, and with which approvals. An agent only ever works inside the scope you grant, and never with more access than you or its owner have."
    >
      {error ? (
        <Banner tone="danger" title="Something went wrong">
          {error}
        </Banner>
      ) : null}
      {!list && !error ? <p role="status">Loading agents…</p> : null}
      {list ? (
        <section className="card au-section" aria-labelledby="ag-list-h">
          <h2 id="ag-list-h">{archived ? 'Archived agents' : 'Your agents'}</h2>
          <p>
            <button
              type="button"
              className="button button-ghost"
              aria-pressed={archived}
              onClick={() => setArchived((v) => !v)}
            >
              {archived ? 'Show current agents' : 'Show archived agents'}
            </button>
          </p>
          {list.data.length ? (
            <ul className="au-list" aria-label="Agents">
              {list.data.map((a) => (
                <li key={a.id} className="au-list-item">
                  <Link to={`/workspaces/${ws}/agents/${a.id}`}>{a.name}</Link>
                  <span className={`au-chip au-chip-${a.state === 'active' ? 'active' : a.state}`}>
                    {STATE_LABEL[a.state] ?? a.state}
                  </span>
                  <span className="hint">
                    {a.kind === 'internal' ? 'Internal (workspace AI)' : 'External (connected)'}
                    {a.owner ? ` · owner ${a.owner.name}` : ''}
                    {` · ${a.readiness.state === 'ready' ? 'ready' : 'not ready'}`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-state">{archived ? 'No archived agents.' : 'No agents yet.'}</p>
          )}
        </section>
      ) : null}
      {!archived ? <AgentHealthCard ws={ws} /> : null}
      {list?.capabilities.create && !archived ? (
        <section className="card au-section" aria-labelledby="ag-new-h">
          <h2 id="ag-new-h">New agent</h2>
          <form
            aria-label="New agent"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <Select
              id="ag-template"
              label="Start from"
              value={template}
              options={[
                { value: '', label: 'A blank agent' },
                ...templates.map((t) => ({ value: t.key, label: t.name })),
              ]}
              onChange={setTemplate}
              hint={
                chosen
                  ? `${chosen.purpose} Starts turned off with no scope; you choose ${chosen.needs
                      .map((n) =>
                        n === 'scope'
                          ? 'what it may use'
                          : n === 'model'
                            ? 'a model'
                            : 'a connection',
                      )
                      .join(' and ')}.`
                  : 'A blank agent starts turned off with no tools and no scope.'
              }
            />
            {!template ? (
              <Select
                id="ag-kind"
                label="Kind"
                value={kind}
                options={[
                  { value: 'internal', label: 'Internal: uses this workspace’s AI' },
                  { value: 'external', label: 'External: an agent you connect' },
                ]}
                onChange={setKind}
              />
            ) : null}
            <Input
              id="ag-name"
              label="Name"
              value={name}
              onChange={setName}
              maxLength={120}
              hint={chosen ? `Leave empty to use “${chosen.name}”.` : undefined}
            />
            <button
              type="submit"
              className="button button-primary"
              disabled={busy || (!template && !name.trim())}
            >
              {busy ? 'Creating…' : 'Create agent'}
            </button>
          </form>
        </section>
      ) : null}
    </Page>
  );
}

// ---------------------------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------------------------

type SaveState = 'idle' | 'saving' | 'saved' | 'conflict' | 'offline' | 'failed';

export function AgentPage({ ws, id }: { ws: string; id: string }) {
  const account = useDraftAccount();
  const { navigate } = useRouter();
  const [a, setA] = useState<AgentProfile | null>(null);
  const [draft, setDraft] = useState<Def | null>(null);
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [dirty, setDirty] = useState(false);
  const [restored, setRestored] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [save, setSave] = useState<SaveState>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [tools, setTools] = useState<AgentTool[]>([]);
  const [models, setModels] = useState<AgentModel[]>([]);
  const [confirm, setConfirm] = useState<null | 'trash' | 'disconnect' | 'test'>(null);
  const [owner, setOwner] = useState('');
  const keys = useRef<Record<string, string>>({});
  const inFlight = useRef(false);
  const keyFor = (k: string) => (keys.current[k] ??= newIdempotencyKey());
  const settle = (k: string, err?: unknown) => {
    if (!err || !ambiguous(err)) delete keys.current[k];
  };
  const configure = a?.capabilities.configure === true;
  const refs = useRefs(ws, configure);

  const show = useCallback(
    (x: AgentProfile, keepEdits = false) => {
      setA(x);
      if (!x.draft) return;
      const stored = account ? readAgentDraft(account, ws, id) : null;
      if (stored && !keepEdits) {
        setDraft(stored.draft);
        setName(stored.name);
        setPurpose(stored.purpose);
        setDirty(true);
        setRestored(true);
        if (stored.version !== x.version) setConflict(true);
      } else if (!keepEdits) {
        setDraft(x.draft);
        setName(x.name);
        setPurpose(x.purpose ?? '');
        setDirty(false);
      }
    },
    [account, ws, id],
  );
  const loadFailed = useCallback((err: unknown) => {
    if (err instanceof ApiError && (err.code === 'not_found' || err.code === 'forbidden'))
      setNotFound(true);
    else setProblem(agentProblem(err, 'This agent could not be loaded.'));
  }, []);
  const refresh = useCallback(
    async (keepEdits = false) => {
      try {
        show(await agentsClient.get(ws, id), keepEdits);
      } catch (err) {
        loadFailed(err);
      }
    },
    [ws, id, show, loadFailed],
  );
  useEffect(() => {
    if (account === null) return;
    let gone = false;
    agentsClient.get(ws, id).then(
      (x) => !gone && show(x),
      (err) => !gone && loadFailed(err),
    );
    agentsClient.tools(ws).then(
      (t) => {
        if (gone) return;
        setTools(t.data);
        setModels(t.models);
      },
      () => undefined,
    );
    return () => {
      gone = true;
    };
  }, [account, ws, id, show, loadFailed]);

  const edit = (next: Def, n = name, p = purpose) => {
    setDraft(next);
    setName(n);
    setPurpose(p);
    setDirty(true);
    setSave('idle');
    if (account && a)
      writeAgentDraft(account, ws, id, { version: a.version, name: n, purpose: p, draft: next });
  };
  const discard = () => {
    if (account) writeAgentDraft(account, ws, id, null);
    setRestored(false);
    setConflict(false);
    void refresh();
  };

  const run = async (
    k: string,
    fn: () => Promise<AgentProfile | void>,
    ok: string,
    fallback: string,
  ) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setProblem(null);
    try {
      const x = await fn();
      settle(k);
      if (x) show(x, true);
      setSaid(ok);
    } catch (err) {
      settle(k, err);
      setProblem(agentProblem(err, fallback));
    } finally {
      inFlight.current = false;
    }
  };

  const saveDraft = async () => {
    if (!a || !draft || inFlight.current) return;
    inFlight.current = true;
    setSave('saving');
    setProblem(null);
    try {
      const x = await agentsClient.save(
        ws,
        id,
        { name: name.trim(), purpose: purpose.trim() || null, draft },
        a.version,
        keyFor('save'),
      );
      settle('save');
      if (account) writeAgentDraft(account, ws, id, null);
      setRestored(false);
      setConflict(false);
      setDirty(false);
      show(x);
      setSave('saved');
      setSaid('Saved.');
    } catch (err) {
      settle('save', err);
      if (err instanceof ApiError && err.offline) setSave('offline');
      else if (err instanceof ApiError && err.code === 'conflict' && err.status === 412) {
        setSave('conflict');
        setConflict(true);
      } else setSave('failed');
      setProblem(agentProblem(err, 'The agent could not be saved.'));
    } finally {
      inFlight.current = false;
    }
  };

  if (notFound)
    return (
      <Page title="This page isn't available" section="Not available">
        <p>It may have been removed, or you may not have access.</p>
      </Page>
    );
  if (!a)
    return (
      <Page title="Agent">
        {problem ? (
          <Banner tone="danger" title="Something went wrong">
            {problem}
          </Banner>
        ) : (
          <p role="status">Loading the agent…</p>
        )}
      </Page>
    );

  const live = a.state !== 'archived' && a.state !== 'trashed';
  const st = a.draft_status;
  return (
    <Page
      title={a.name}
      record={{ title: a.name }}
      lead={`${a.kind === 'internal' ? 'Internal agent' : 'External agent'} · ${STATE_LABEL[a.state] ?? a.state}`}
    >
      <p>
        <Link to={`/workspaces/${ws}/agents`}>All agents</Link>
      </p>
      {problem ? (
        <Banner tone="danger" title="Something went wrong">
          {problem}
        </Banner>
      ) : null}
      {restored ? (
        <Banner
          tone={conflict ? 'warning' : 'info'}
          title={
            conflict ? 'This agent changed since your unsaved edits' : 'Unsaved edits restored'
          }
          action={
            <button type="button" className="button button-ghost" onClick={discard}>
              Discard my edits
            </button>
          }
        >
          {conflict
            ? 'Someone saved this agent after you started. Your edits are kept here; review them and save again, or discard them to see the latest version.'
            : 'These edits were kept on this device and are not saved yet.'}
        </Banner>
      ) : null}

      <section className="card au-section" aria-labelledby="ag-status-h">
        <h2 id="ag-status-h">Status</h2>
        <dl className="au-facts">
          <div>
            <dt>State</dt>
            <dd>
              {STATE_LABEL[a.state] ?? a.state}
              {a.suspended_reason ? ` (${reasonText(a.suspended_reason)})` : ''}
            </dd>
          </div>
          <div>
            <dt>Owner</dt>
            <dd>
              {a.owner ? a.owner.name : 'No owner'}
              {a.owner && !a.owner.active ? ' (no longer a member)' : ''}
            </dd>
          </div>
          <div>
            <dt>Kind</dt>
            <dd>
              {a.kind === 'internal' ? 'Internal: workspace AI' : 'External: connected agent'}
            </dd>
          </div>
          {a.active_revision ? (
            <div>
              <dt>Active version</dt>
              <dd>{a.active_revision.revision}</dd>
            </div>
          ) : null}
        </dl>
        <ReadinessView r={a.readiness} kind={a.kind} />
        <ExecutionNote />
      </section>

      {configure && live && draft ? (
        <ProfileEditor
          ws={ws}
          a={a}
          draft={draft}
          name={name}
          purpose={purpose}
          tools={tools}
          models={models}
          refs={refs}
          onEdit={edit}
        />
      ) : null}
      {configure && live && st ? (
        <section className="card au-section" aria-labelledby="ag-check-h">
          <h2 id="ag-check-h">Before it can be turned on</h2>
          {!st.valid ? (
            <ul className="au-issues" aria-label="Configuration problems">
              {st.issues.map((i) => (
                <li key={`${i.pointer}:${i.code}`}>{i.message}</li>
              ))}
            </ul>
          ) : null}
          {st.unavailable.length ? (
            <ul className="au-issues" aria-label="Unavailable tools">
              {st.unavailable.map((u) => (
                <li key={u.pointer}>
                  {u.tool} is not available yet (phase {u.owner}).
                </li>
              ))}
            </ul>
          ) : null}
          {st.missing.length ? (
            <ul className="au-issues" aria-label="Missing configuration">
              {st.missing.map((m) => (
                <li key={m}>
                  {m === 'scope'
                    ? 'Choose at least one brand, project, record, or integration it may use.'
                    : m === 'model'
                      ? 'Choose a model.'
                      : m === 'connector'
                        ? 'Configure and test a connection.'
                        : m === 'unavailable_tools'
                          ? 'Remove the tools that are not available yet.'
                          : m.replace(/_/g, ' ')}
                </li>
              ))}
            </ul>
          ) : null}
          {st.valid && !st.unavailable.length && !st.missing.length ? (
            <p>
              {st.matches_active
                ? 'The saved configuration is the active version.'
                : 'The saved configuration is complete.'}
            </p>
          ) : null}
          {dirty ? <p className="hint">Save your edits to check them.</p> : null}
        </section>
      ) : null}

      {configure && live ? (
        <section className="card au-section au-actions" aria-labelledby="ag-actions-h">
          <h2 id="ag-actions-h">Actions</h2>
          <p className="ag-buttons">
            <button
              type="button"
              className="button button-primary"
              disabled={!dirty || save === 'saving'}
              onClick={() => void saveDraft()}
            >
              {save === 'saving' ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={dirty || !st?.valid || !!st?.unavailable.length || !!st?.missing.length}
              onClick={() =>
                void run(
                  'activate',
                  () => agentsClient.command(ws, id, 'activate', {}, keyFor('activate'), a.version),
                  'The agent is on.',
                  'The agent could not be turned on.',
                )
              }
            >
              {a.state === 'active' ? 'Activate saved changes' : 'Turn on'}
            </button>
            {a.state === 'active' || a.state === 'suspended' ? (
              <button
                type="button"
                className="button button-secondary"
                onClick={() =>
                  void run(
                    'disable',
                    () => agentsClient.command(ws, id, 'disable', {}, keyFor('disable'), a.version),
                    'The agent is off.',
                    'The agent could not be turned off.',
                  )
                }
              >
                Turn off
              </button>
            ) : null}
            <button
              type="button"
              className="button button-ghost"
              onClick={() =>
                void run(
                  'duplicate',
                  async () => {
                    const x = await agentsClient.command(
                      ws,
                      id,
                      'duplicate',
                      {},
                      keyFor('duplicate'),
                    );
                    navigate(`/workspaces/${ws}/agents/${x.id}`);
                  },
                  'Duplicated as a draft.',
                  'The agent could not be duplicated.',
                )
              }
            >
              Duplicate
            </button>
            <button
              type="button"
              className="button button-ghost"
              onClick={() =>
                void run(
                  'archive',
                  () => agentsClient.command(ws, id, 'archive', {}, keyFor('archive')),
                  'Archived. Its connection was disconnected.',
                  'The agent could not be archived.',
                )
              }
            >
              Archive
            </button>
            <button
              type="button"
              className="button button-ghost"
              onClick={() => setConfirm('trash')}
            >
              Move to trash
            </button>
          </p>
          {save === 'offline' ? (
            <p className="hint" role="status">
              You are offline. Your edits are kept on this device.
            </p>
          ) : null}
          <form
            className="au-row"
            aria-label="Change owner"
            onSubmit={(e) => {
              e.preventDefault();
              if (!owner) return;
              void run(
                'reassign',
                () =>
                  agentsClient.command(
                    ws,
                    id,
                    'reassign',
                    { owner },
                    keyFor('reassign'),
                    a.version,
                  ),
                'The owner changed.',
                'The owner could not be changed.',
              );
            }}
          >
            <Select
              id="ag-owner"
              label="Owner"
              value={owner}
              options={[{ value: '', label: 'Choose a person' }, ...refs.members]}
              onChange={setOwner}
              hint="An agent never has more access than its owner. The new owner must be able to grant its scope."
            />
            <button type="submit" className="button button-secondary" disabled={!owner}>
              Change owner
            </button>
          </form>
        </section>
      ) : null}

      {configure && !live ? (
        <section className="card au-section au-actions" aria-labelledby="ag-life-h">
          <h2 id="ag-life-h">{a.state === 'archived' ? 'Archived' : 'In trash'}</h2>
          <p>It comes back turned off; turn it on again after checking its scope and connection.</p>
          <button
            type="button"
            className="button button-primary"
            onClick={() =>
              void run(
                a.state === 'archived' ? 'unarchive' : 'restore',
                () =>
                  agentsClient.command(
                    ws,
                    id,
                    a.state === 'archived' ? 'unarchive' : 'restore',
                    {},
                    keyFor(a.state === 'archived' ? 'unarchive' : 'restore'),
                  ),
                'Restored, turned off.',
                'The agent could not be restored.',
              )
            }
          >
            {a.state === 'archived' ? 'Unarchive' : 'Restore'}
          </button>
        </section>
      ) : null}

      {configure && live && a.kind === 'external' ? (
        <ConnectorPanel
          ws={ws}
          a={a}
          onChange={(x) => show(x, true)}
          onProblem={setProblem}
          onSaid={setSaid}
          confirm={confirm}
          setConfirm={setConfirm}
        />
      ) : null}

      {a.active_revision ? (
        <section className="card au-section" aria-labelledby="ag-active-h">
          <h2 id="ag-active-h">Active version {a.active_revision.revision}</h2>
          <h3>Tools</h3>
          {a.active_revision.tools.length ? (
            <ul className="ag-scope">
              {a.active_revision.tools.map((t) => (
                <li key={t.tool}>
                  {t.tool} · {CLASS_LABEL[t.tool_class] ?? t.tool_class} ·{' '}
                  {APPROVALS.find((x) => x.value === t.approval_class)?.label ?? t.approval_class}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-state">No tools.</p>
          )}
          <h3>Scope</h3>
          <ScopeList scope={a.active_revision.scope} label="Active scope" />
        </section>
      ) : null}

      {confirm === 'trash' ? (
        <Dialog
          title="Move this agent to trash?"
          description="Its connection is disconnected and its stored secret destroyed. Task assignments stay as history and show as blocked."
          destructive
          onClose={() => setConfirm(null)}
        >
          <p className="actions">
            <button
              type="button"
              className="button button-secondary"
              data-cancel
              onClick={() => setConfirm(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-danger"
              onClick={() => {
                setConfirm(null);
                void run(
                  'trash',
                  () => agentsClient.command(ws, id, 'trash', {}, keyFor('trash')),
                  'Moved to trash.',
                  'The agent could not be moved to trash.',
                );
              }}
            >
              Move to trash
            </button>
          </p>
        </Dialog>
      ) : null}
      <Announce>{said}</Announce>
    </Page>
  );
}

function ProfileEditor(props: {
  ws: string;
  a: AgentProfile;
  draft: Def;
  name: string;
  purpose: string;
  tools: AgentTool[];
  models: AgentModel[];
  refs: Refs;
  onEdit: (d: Def, name?: string, purpose?: string) => void;
}) {
  const { a, draft, tools, models, refs, onEdit } = props;
  const set = (k: string, v: unknown) => onEdit({ ...draft, [k]: v });
  const limits = obj(draft.limits);
  const policy = obj(draft.approval_policy) as Record<string, string>;
  const granted = (Array.isArray(draft.tools) ? draft.tools : []).map((t) => str(obj(t).name));
  const scope = obj(draft.scope);
  const classes = [
    ...new Set(tools.filter((t) => granted.includes(t.name)).map((t) => t.tool_class)),
  ];
  return (
    <section className="card au-section" aria-labelledby="ag-edit-h">
      <h2 id="ag-edit-h">Configuration</h2>
      <p className="hint">
        Edits are a draft until you save; saved changes take effect when you turn the agent on (each
        assignment keeps the version it was given).
      </p>
      <Input
        id="ag-e-name"
        label="Name"
        value={props.name}
        maxLength={120}
        onChange={(v) => onEdit(draft, v, props.purpose)}
      />
      <TextArea
        id="ag-e-purpose"
        label="Purpose"
        value={props.purpose}
        maxLength={1000}
        rows={2}
        onChange={(v) => onEdit(draft, props.name, v)}
      />
      <TextArea
        id="ag-e-instructions"
        label="Instructions"
        value={str(draft.instructions)}
        maxLength={8000}
        rows={6}
        onChange={(v) => set('instructions', v)}
        hint="Plain text for the agent. Instructions never grant access; tools and scope below do."
      />
      {a.kind === 'internal' ? (
        <Select
          id="ag-e-model"
          label="Model"
          value={str(draft.model_key)}
          options={[
            { value: '', label: 'Choose a model' },
            ...models.map((m) => ({ value: m.key, label: m.label })),
          ]}
          onChange={(v) => set('model_key', v || null)}
          hint="Whether it can run is decided by this workspace’s AI settings (shown under Readiness)."
        />
      ) : null}
      <fieldset className="au-group">
        <legend>Limits</legend>
        <div className="au-row">
          {LIMIT_FIELDS.map((f) => (
            <Input
              key={f.key}
              id={`ag-e-${f.key}`}
              label={f.label}
              type="number"
              value={typeof limits[f.key] === 'number' ? (limits[f.key] as number) : ''}
              hint={`${f.min}–${f.max}`}
              onChange={(v) =>
                set('limits', { ...limits, [f.key]: v === '' ? undefined : Number(v) })
              }
            />
          ))}
        </div>
      </fieldset>
      <Checks
        legend="Tools"
        hint="Only registered tools can be granted. Tools that arrive in later phases are listed but cannot be chosen."
        options={tools.map((t) => ({
          value: t.name,
          label: `${t.name} — ${t.description}${t.status === 'unavailable' ? ` (not available yet: phase ${t.owner})` : ''}`,
          disabled: t.status === 'unavailable' && !granted.includes(t.name),
        }))}
        value={granted}
        onChange={(v) =>
          set(
            'tools',
            v.map((name) => ({
              name,
              version: tools.find((t) => t.name === name)?.version ?? '1',
            })),
          )
        }
      />
      {classes.length ? (
        <fieldset className="au-group">
          <legend>Approvals</legend>
          <p className="hint">
            You can require more than the minimum, never less. Changes to other people’s records
            always need review; anything that sends, publishes, or spends needs a person.
          </p>
          {classes.map((c) => {
            const min = tools.find((t) => t.tool_class === c)!.minimum_approval;
            return (
              <Select
                key={c}
                id={`ag-e-approval-${c}`}
                label={CLASS_LABEL[c] ?? c}
                value={policy[c] ?? min}
                options={APPROVALS.map((o) => ({
                  ...o,
                  disabled: APPROVAL_RANK.indexOf(o.value) < APPROVAL_RANK.indexOf(min),
                }))}
                onChange={(v) => set('approval_policy', { ...policy, [c]: v })}
              />
            );
          })}
        </fieldset>
      ) : null}
      <fieldset className="au-group">
        <legend>Scope</legend>
        <p className="hint">
          Choose exactly what it may use. Nothing chosen means nothing: there is no “everything”.
          You (and its owner) must be able to grant each item at the level its tools need.
        </p>
        <Checks
          legend="Brands"
          options={refs.brands}
          value={strs(scope.brands)}
          onChange={(v) => set('scope', { ...scope, brands: v })}
          empty="No brands you can see."
        />
        <Checks
          legend="Projects"
          options={refs.projects}
          value={strs(scope.projects)}
          onChange={(v) => set('scope', { ...scope, projects: v })}
          empty="No projects you can see."
        />
        {refs.integrations.length ? (
          <Checks
            legend="Integrations"
            options={refs.integrations}
            value={strs(scope.integrations)}
            onChange={(v) => set('scope', { ...scope, integrations: v })}
          />
        ) : null}
        {strs(scope.records).length ? (
          <p className="hint">
            {strs(scope.records).length} individual{' '}
            {strs(scope.records).length === 1 ? 'record' : 'records'} also in scope.
          </p>
        ) : null}
      </fieldset>
    </section>
  );
}

function ConnectorPanel(props: {
  ws: string;
  a: AgentProfile;
  onChange: (a: AgentProfile) => void;
  onProblem: (p: string | null) => void;
  onSaid: (s: string) => void;
  confirm: null | 'trash' | 'disconnect' | 'test';
  setConfirm: (c: null | 'trash' | 'disconnect' | 'test') => void;
}) {
  const { ws, a, onChange, onProblem, onSaid, confirm, setConfirm } = props;
  const c = a.connector && a.connector.state !== 'revoked' ? a.connector : null;
  const [kind, setKind] = useState<string>(c?.kind ?? 'api');
  const [url, setUrl] = useState(c?.endpoint_url ?? '');
  const [secret, setSecret] = useState('');
  const [shown, setShown] = useState<string | null>(null);
  const [test, setTest] = useState<ConnectorTest | null>(null);
  const [busy, setBusy] = useState(false);
  const keys = useRef<Record<string, string>>({});
  const keyFor = (k: string) => (keys.current[k] ??= newIdempotencyKey());
  const settle = (k: string, err?: unknown) => {
    if (!err || !ambiguous(err)) delete keys.current[k];
  };
  // A queued test is followed until it ends (the result names the settings version it tested).
  useEffect(() => {
    if (!test || (test.state !== 'queued' && test.state !== 'running')) return;
    const t = setTimeout(() => {
      agentsClient
        .testResult(ws, a.id, test.id)
        .then(async (r) => {
          setTest(r);
          if (r.state !== 'queued' && r.state !== 'running') {
            onChange(await agentsClient.get(ws, a.id));
            onSaid(
              r.state === 'passed'
                ? 'The connection test passed.'
                : 'The connection test did not pass.',
            );
          }
        })
        .catch(() => undefined);
    }, 1000);
    return () => clearTimeout(t);
  }, [test, ws, a.id, onChange, onSaid]);

  const act = async (k: string, fn: () => Promise<void>, fallback: string) => {
    if (busy) return;
    setBusy(true);
    onProblem(null);
    try {
      await fn();
      settle(k);
    } catch (err) {
      settle(k, err);
      onProblem(agentProblem(err, fallback));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card au-section" aria-labelledby="ag-conn-h">
      <h2 id="ag-conn-h">Connection</h2>
      <Banner tone="info" title="Test connections only">
        {c?.production_note ??
          'Live agent connectors need an approved secret store and credentials (DQ-28); only the synthetic local fixture can be tested here.'}
      </Banner>
      {c ? (
        <dl className="au-facts">
          <div>
            <dt>State</dt>
            <dd>{CONNECTOR_STATE[c.state] ?? c.state}</dd>
          </div>
          <div>
            <dt>Endpoint</dt>
            <dd>{c.endpoint_url}</dd>
          </div>
          <div>
            <dt>Settings version</dt>
            <dd>{c.config_version}</dd>
          </div>
          <div>
            <dt>Last test</dt>
            <dd>
              {c.last_tested_at ? new Date(c.last_tested_at).toLocaleString() : 'Never'}
              {c.last_code ? ` · ${TEST_CODE[c.last_code] ?? c.last_code}` : ''}
              {c.verified && c.synthetic ? ' · synthetic (local test agent)' : ''}
            </dd>
          </div>
          {c.capabilities?.effective?.length ? (
            <div>
              <dt>Tools it offers that this profile grants</dt>
              <dd>{c.capabilities.effective.map((t) => t.name).join(', ')}</dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className="empty-state">No connection yet.</p>
      )}
      {shown ? (
        <Banner tone="warning" title="Copy the signing secret now">
          <p>It is shown once. Configure your webhook agent to sign its answers with it.</p>
          <p>
            <code className="ag-secret">{shown}</code>
          </p>
        </Banner>
      ) : null}
      <form
        aria-label="Connection settings"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void act(
            'configure',
            async () => {
              const x = await agentsClient.configureConnector(
                ws,
                a.id,
                {
                  kind,
                  endpoint_url: url.trim(),
                  ...(kind !== 'webhook' && secret ? { secret } : {}),
                },
                keyFor('configure'),
              );
              setSecret('');
              setShown(x.signing_secret ?? null);
              onChange(x);
              onSaid('Connection saved. Test it before turning the agent on.');
            },
            'The connection could not be saved.',
          );
        }}
      >
        <Select
          id="ag-c-kind"
          label="Connection type"
          value={kind}
          options={[
            { value: 'api', label: 'API (signed request and answer)' },
            { value: 'webhook', label: 'Webhook (signed both ways)' },
            { value: 'mcp', label: 'MCP server' },
          ]}
          onChange={setKind}
        />
        <Input
          id="ag-c-url"
          label="Endpoint URL"
          value={url}
          maxLength={2048}
          onChange={setUrl}
          hint="https only; private addresses and this product’s own endpoints are refused."
        />
        {kind !== 'webhook' ? (
          <Input
            id="ag-c-secret"
            label={
              c?.secret_set ? 'Replace the shared secret (optional)' : 'Shared secret (optional)'
            }
            type="password"
            autoComplete="off"
            value={secret}
            maxLength={512}
            onChange={setSecret}
            hint="Stored in the secret store, never shown again. Never paste a token for this product."
          />
        ) : null}
        <p className="ag-buttons">
          <button type="submit" className="button button-primary" disabled={busy || !url.trim()}>
            Save connection
          </button>
          {c ? (
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => setConfirm('test')}
            >
              Test connection
            </button>
          ) : null}
          {c ? (
            <button
              type="button"
              className="button button-ghost"
              disabled={busy}
              onClick={() => setConfirm('disconnect')}
            >
              Disconnect
            </button>
          ) : null}
        </p>
      </form>
      {test ? (
        <div role="status" aria-label="Connection test">
          <p>
            Test: {test.state === 'queued' || test.state === 'running' ? 'running…' : test.state}
            {test.code ? ` · ${TEST_CODE[test.code] ?? test.code}` : ''}
            {test.synthetic ? ' · synthetic (local test agent)' : ''}
            {!test.current ? ' · the settings changed since this test' : ''}
          </p>
          <p className="hint">{test.note}</p>
        </div>
      ) : null}
      {confirm === 'test' ? (
        <Dialog
          title="Test this connection?"
          description="A signed handshake is sent to the endpoint. No task, record, or credential is sent; it only checks the protocol and the tools it offers."
          onClose={() => setConfirm(null)}
        >
          <p className="actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setConfirm(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-primary"
              data-initial
              onClick={() => {
                setConfirm(null);
                void act(
                  'test',
                  async () => setTest(await agentsClient.test(ws, a.id, keyFor('test'))),
                  'The connection could not be tested.',
                );
              }}
            >
              Send test
            </button>
          </p>
        </Dialog>
      ) : null}
      {confirm === 'disconnect' ? (
        <Dialog
          title="Disconnect this agent?"
          description="Its stored secret is destroyed and it stops being ready. Assignments show as blocked until it is connected and tested again."
          destructive
          onClose={() => setConfirm(null)}
        >
          <p className="actions">
            <button
              type="button"
              className="button button-secondary"
              data-cancel
              onClick={() => setConfirm(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-danger"
              onClick={() => {
                setConfirm(null);
                void act(
                  'disconnect',
                  async () => {
                    onChange(await agentsClient.disconnect(ws, a.id, keyFor('disconnect')));
                    setShown(null);
                    setTest(null);
                    onSaid('Disconnected.');
                  },
                  'The agent could not be disconnected.',
                );
              }}
            >
              Disconnect
            </button>
          </p>
        </Dialog>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Task Agent section
// ---------------------------------------------------------------------------------------------

interface Brief {
  profile: string;
  goal: string;
  constraints: string;
  deliverable: string;
  criteria: string;
}
const EMPTY_BRIEF: Brief = {
  profile: '',
  goal: '',
  constraints: '',
  deliverable: '',
  criteria: '',
};
const briefBody = (b: Brief, withProfile = true) => ({
  ...(withProfile ? { profile: b.profile } : {}),
  goal: b.goal.trim(),
  ...(b.constraints.trim() ? { constraints: b.constraints.trim() } : {}),
  ...(b.deliverable.trim() ? { deliverable: b.deliverable.trim() } : {}),
  criteria: b.criteria
    .split('\n')
    .map((c) => c.trim())
    .filter(Boolean),
});

/**
 * The task's Agent section: who (which agent profiles) is assigned, separate from human assignees,
 * with a structured preview before saving and truthful readiness. Readers see the brief and the
 * scope items they can open; only people who may assign agents here see the form.
 */
export function TaskAgentSection({ ws, task }: { ws: string; task: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof agentsClient.assignments>> | null>(
    null,
  );
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [brief, setBrief] = useState<Brief>(EMPTY_BRIEF);
  const [editing, setEditing] = useState<string | null>(null);
  const [preview, setPreview] = useState<AssignmentPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState<Assignment | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const keys = useRef<Record<string, string>>({});
  const keyFor = (k: string) => (keys.current[k] ??= newIdempotencyKey());
  const settle = (k: string, err?: unknown) => {
    if (!err || !ambiguous(err)) delete keys.current[k];
  };
  const load = useCallback(() => {
    agentsClient
      .assignments(ws, task)
      .then((d) => {
        setData(d);
        if (d.capabilities.assign)
          agentsClient
            .list(ws)
            .then((l) => setProfiles(l.data.filter((p) => p.capabilities.assign)))
            .catch(() => setProfiles([]));
      })
      .catch((err) => {
        if (err instanceof ApiError && (err.code === 'not_found' || err.code === 'forbidden'))
          setUnavailable(true);
        else setProblem(agentProblem(err, 'Agents on this task could not be loaded.'));
      });
  }, [ws, task]);
  useEffect(load, [load]);
  if (unavailable) return null;
  const field = (k: keyof Brief) => (v: string) => {
    setBrief((b) => ({ ...b, [k]: v }));
    setPreview(null);
  };
  const doPreview = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      setPreview(
        await agentsClient.preview(
          ws,
          task,
          briefBody({ ...brief, profile: editing ?? brief.profile }),
        ),
      );
    } catch (err) {
      setProblem(agentProblem(err, 'The preview could not be made.'));
    } finally {
      setBusy(false);
    }
  };
  const doSave = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const k = editing ? `revise:${editing}` : 'assign';
    try {
      if (editing) {
        const cur = data?.items.find((x) => x.profile.id === editing);
        await agentsClient.revise(
          ws,
          task,
          editing,
          briefBody(brief, false),
          cur?.version ?? 0,
          keyFor(k),
        );
        setSaid('The assignment was updated.');
      } else {
        await agentsClient.assign(ws, task, briefBody(brief), keyFor(k));
        setSaid('The agent was assigned. Start a run when you are ready.');
      }
      settle(k);
      setBrief(EMPTY_BRIEF);
      setEditing(null);
      setPreview(null);
      load();
    } catch (err) {
      settle(k, err);
      setProblem(agentProblem(err, 'The assignment could not be saved.'));
    } finally {
      setBusy(false);
    }
  };
  const items = data?.items ?? [];
  const current = items.filter((x) => x.state !== 'withdrawn');
  const past = items.filter((x) => x.state === 'withdrawn');
  return (
    <section className="task-section ag-task" aria-labelledby="ag-task-h">
      <h2 id="ag-task-h">Agents</h2>
      <p className="hint">Agents are separate from the people assigned to this task.</p>
      {problem ? (
        <Banner tone="danger" title="Something went wrong">
          {problem}
        </Banner>
      ) : null}
      {!data && !problem ? <p role="status">Loading agents…</p> : null}
      {data ? (
        current.length ? (
          <ul className="au-list" aria-label="Assigned agents">
            {current.map((x) => (
              <li key={x.id} className="ag-assignment">
                <p>
                  <strong>{x.profile.name}</strong>{' '}
                  <span
                    className={`au-chip au-chip-${x.state === 'assigned' ? 'active' : 'suspended'}`}
                  >
                    {x.state === 'assigned' ? 'Assigned' : 'Blocked'}
                  </span>{' '}
                  <span className="hint">version {x.revision}</span>
                </p>
                {x.blocked_reasons.length ? (
                  <ul className="au-issues" aria-label="Why it is blocked">
                    {x.blocked_reasons.map((r) => (
                      <li key={r}>{reasonText(r)}</li>
                    ))}
                  </ul>
                ) : null}
                <dl className="au-facts">
                  <div>
                    <dt>Goal</dt>
                    <dd>{x.goal}</dd>
                  </div>
                  {x.constraints ? (
                    <div>
                      <dt>Constraints</dt>
                      <dd>{x.constraints}</dd>
                    </div>
                  ) : null}
                  {x.deliverable ? (
                    <div>
                      <dt>Deliverable</dt>
                      <dd>{x.deliverable}</dd>
                    </div>
                  ) : null}
                  {x.criteria.length ? (
                    <div>
                      <dt>Acceptance criteria</dt>
                      <dd>
                        <ul>
                          {x.criteria.map((c, i) => (
                            <li key={i}>{c}</li>
                          ))}
                        </ul>
                      </dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>Assigned by</dt>
                    <dd>{x.assigned_by?.name ?? 'Someone no longer here'}</dd>
                  </div>
                  {x.context.length ? (
                    <div>
                      <dt>Context</dt>
                      <dd>
                        <ul>
                          {x.context.map((c) => (
                            <li key={c.id}>
                              {c.name}
                              {c.usable === false ? ' (history only: no longer usable)' : ''}
                            </li>
                          ))}
                        </ul>
                      </dd>
                    </div>
                  ) : null}
                </dl>
                {x.state !== 'withdrawn' && x.effective_scope ? (
                  <details>
                    <summary>Scope it can use now</summary>
                    <ScopeList
                      scope={x.effective_scope}
                      label={`Usable scope for ${x.profile.name}`}
                    />
                  </details>
                ) : null}
                <details>
                  <summary>Scope as assigned</summary>
                  <ScopeList scope={x.scope} label={`Assigned scope for ${x.profile.name}`} />
                </details>
                {data.capabilities.assign ? (
                  <p className="ag-buttons">
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => {
                        setEditing(x.profile.id);
                        setPreview(null);
                        setBrief({
                          profile: x.profile.id,
                          goal: x.goal,
                          constraints: x.constraints ?? '',
                          deliverable: x.deliverable ?? '',
                          criteria: x.criteria.join('\n'),
                        });
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="button button-ghost"
                      onClick={() => setWithdrawing(x)}
                    >
                      Withdraw
                    </button>
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">No agents assigned.</p>
        )
      ) : null}
      {data && current.length ? (
        <TaskAgentRuns
          ws={ws}
          task={task}
          startable={
            data.capabilities.assign && data.execution.available
              ? current
                  .filter((x) => x.state === 'assigned')
                  .map((x) => ({ id: x.profile.id, name: x.profile.name }))
              : []
          }
        />
      ) : null}
      {past.length ? (
        <details>
          <summary>Withdrawn ({past.length})</summary>
          <ul>
            {past.map((x) => (
              <li key={x.id}>
                {x.profile.name} · {x.goal}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {data?.capabilities.assign ? (
        <form
          className="au-group"
          aria-label={editing ? 'Edit the agent assignment' : 'Assign an agent'}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void (preview?.can_save ? doSave() : doPreview());
          }}
        >
          <h3>{editing ? 'Edit the assignment' : 'Assign an agent'}</h3>
          {!editing ? (
            <Select
              id="ag-t-profile"
              label="Agent"
              value={brief.profile}
              options={[
                {
                  value: '',
                  label: profiles.length ? 'Choose an agent' : 'No agents are turned on',
                },
                ...profiles.map((p) => ({ value: p.id, label: p.name })),
              ]}
              onChange={field('profile')}
            />
          ) : null}
          <TextArea
            id="ag-t-goal"
            label="Goal"
            value={brief.goal}
            onChange={field('goal')}
            rows={2}
            maxLength={4000}
          />
          <TextArea
            id="ag-t-constraints"
            label="Constraints (optional)"
            value={brief.constraints}
            onChange={field('constraints')}
            rows={2}
            maxLength={4000}
          />
          <TextArea
            id="ag-t-deliverable"
            label="Deliverable (optional)"
            value={brief.deliverable}
            onChange={field('deliverable')}
            rows={2}
            maxLength={4000}
          />
          <TextArea
            id="ag-t-criteria"
            label="Acceptance criteria (one per line, optional)"
            value={brief.criteria}
            onChange={field('criteria')}
            rows={3}
          />
          {preview ? <PreviewView p={preview} /> : null}
          <p className="ag-buttons">
            <button
              type="button"
              className="button button-secondary"
              disabled={busy || !(editing ?? brief.profile) || !brief.goal.trim()}
              onClick={() => void doPreview()}
            >
              Preview
            </button>
            <button
              type="submit"
              className="button button-primary"
              disabled={busy || !preview?.can_save}
            >
              {editing ? 'Save changes' : 'Assign'}
            </button>
            {editing ? (
              <button
                type="button"
                className="button button-ghost"
                onClick={() => {
                  setEditing(null);
                  setBrief(EMPTY_BRIEF);
                  setPreview(null);
                }}
              >
                Cancel
              </button>
            ) : null}
          </p>
          {!preview ? (
            <p className="hint">Preview first: it shows exactly what the agent may use.</p>
          ) : null}
        </form>
      ) : null}
      {withdrawing ? (
        <Dialog
          title={`Withdraw ${withdrawing.profile.name}?`}
          description="The assignment stays in this task’s history. Nothing was sent to the agent."
          destructive
          onClose={() => setWithdrawing(null)}
        >
          <p className="actions">
            <button
              type="button"
              className="button button-secondary"
              data-cancel
              onClick={() => setWithdrawing(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-danger"
              onClick={() => {
                const x = withdrawing;
                setWithdrawing(null);
                const k = `withdraw:${x.profile.id}`;
                void agentsClient
                  .withdraw(ws, task, x.profile.id, keyFor(k))
                  .then(() => {
                    settle(k);
                    setSaid('Withdrawn.');
                    load();
                  })
                  .catch((err) => {
                    settle(k, err);
                    setProblem(agentProblem(err, 'The assignment could not be withdrawn.'));
                  });
              }}
            >
              Withdraw
            </button>
          </p>
        </Dialog>
      ) : null}
      <Announce>{said}</Announce>
    </section>
  );
}

function PreviewView({ p }: { p: AssignmentPreview }) {
  return (
    <div className="au-preview ag-preview" role="region" aria-label="Assignment preview">
      <h4>What {p.profile.name} may use</h4>
      <ScopeList scope={p.scope} label="Preview scope" />
      {p.context.length ? (
        <>
          <h4>Context</h4>
          <ul>
            {p.context.map((c) => (
              <li key={c.id}>{c.name}</li>
            ))}
          </ul>
        </>
      ) : null}
      {p.refusals.length ? (
        <>
          <h4>Not included</h4>
          <ul className="au-issues" aria-label="Refused">
            {p.refusals.map((r) => (
              <li key={`${r.pointer}:${r.code}`}>{r.message}</li>
            ))}
          </ul>
        </>
      ) : null}
      <h4>Readiness</h4>
      <ReadinessView r={p.readiness} kind={p.profile.kind} />
      {!p.can_save ? <p>This assignment cannot be saved as it is.</p> : null}
    </div>
  );
}
