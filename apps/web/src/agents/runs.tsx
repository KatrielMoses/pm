import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, newIdempotencyKey } from '../api.ts';
import { Dialog } from '../ui/dialog.tsx';
import { Announce, Banner } from '../ui/feedback.tsx';
import {
  agentProblem,
  agentsClient,
  ambiguous,
  reasonText,
  type AgentHealth,
  type AgentRun,
  type ArtifactVersions,
  type RunEvent,
  type RunPreview,
  type RunState,
} from './client.ts';

/**
 * Phase 8C agent runs (UXD-34): start a run from its preview (scope, tools, limits, and costs),
 * follow progress by bounded long poll with reconnect, read the tool timeline and draft
 * artifacts, and pause, resume, cancel, or retry. A finished run is ready for a person's review;
 * it is never styled as success and nothing here accepts it (8D). Health and the emergency stop
 * live on the Agents page for owners and administrators.
 */

const STATE_TEXT: Record<RunState, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting',
  failed: 'Failed',
  cancelled: 'Cancelled',
  ready_for_review: 'Ready for review',
};
const CHIP: Record<RunState, string> = {
  queued: 'queued',
  running: 'running',
  waiting: 'waiting',
  failed: 'failed',
  cancelled: 'failed',
  // A neutral chip: output to review is not a completed task.
  ready_for_review: 'review',
};
const WAITING_TEXT: Record<string, string> = {
  paused: 'Paused. Nothing new is sent to the agent until someone resumes it.',
  authorization_changed:
    'Stopped because what the agent may use changed. Resuming checks its authority again.',
  approval: 'Waiting for an approval that is not available yet.',
  reconciliation_required:
    'Unclear whether the agent received the work. Nothing is sent again automatically; a workspace owner must confirm what happened before the run can continue or be cancelled.',
  rate_limit: 'Waiting for a rate limit to clear.',
  dependency_unavailable: 'Waiting for a service that is not available.',
  delay: 'Waiting before trying again.',
  input: 'Waiting for input.',
};
const FAILURE_TEXT: Record<string, string> = {
  cost_confirmation_required: 'The AI usage was not confirmed.',
  model_unavailable: 'The model was not available.',
  deadline_exceeded: 'The run took longer than its limit.',
  timeout: 'The run took longer than its limit.',
  limit_reached: 'The run reached one of its limits.',
  agent_failed: 'The agent reported that it failed.',
  connector_changed: 'The connection changed while the run was open.',
  dispatch_refused: 'The agent refused the work.',
  emergency_stop: 'Agent work was stopped for the workspace.',
  limit_exceeded: 'The run took longer than its limit.',
  agent_reported_failure: 'The agent reported that it failed.',
  assignment_withdrawn: 'The agent was withdrawn from this task.',
  user_cancelled: '',
};
const DECISION_TEXT: Record<string, string> = {
  executed: 'ran',
  approval_required: 'needs approval (not run)',
  refused: 'refused',
  unavailable: 'unavailable',
  limit_reached: 'limit reached',
};
const TOOL_CODE_TEXT: Record<string, string> = {
  approval_required: 'Changes need a person’s approval, which is not available yet.',
  not_available: 'Not available to this agent.',
  authorization_changed: 'What the agent may use changed.',
  emergency_stop: 'Agent work is stopped.',
  paused: 'The run is paused.',
  tool_unavailable: 'The tool is not available here.',
  limit_reached: 'The run reached its tool call limit.',
};
const LIMIT_TEXT: Record<string, string> = {
  max_runtime_minutes: 'Longest run (minutes)',
  max_tool_calls: 'Most tool calls',
  max_artifacts: 'Most deliverables',
};

const micros = (n: number, currency = 'USD') =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 4,
  }).format(n / 1_000_000);
const when = (iso: string) => new Date(iso).toLocaleString();
const ENDED: RunState[] = ['failed', 'cancelled', 'ready_for_review'];

export function RunStateChip({ run }: { run: Pick<AgentRun, 'state'> }) {
  return <span className={`au-chip au-chip-${CHIP[run.state]}`}>{STATE_TEXT[run.state]}</span>;
}

// ---------------------------------------------------------------------------------------------
// Task runs: start, history, and one run's detail
// ---------------------------------------------------------------------------------------------

export function TaskAgentRuns(props: {
  ws: string;
  task: string;
  /** Assigned agents a run may be started for (already filtered to what the viewer may run). */
  startable: Array<{ id: string; name: string }>;
}) {
  const { ws, task, startable } = props;
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState<{ id: string; name: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const load = useCallback(() => {
    agentsClient
      .runs(ws, task)
      .then(setRuns)
      .catch((err) => setProblem(agentProblem(err, 'Agent runs could not be loaded.')));
  }, [ws, task]);
  useEffect(load, [load]);
  const busyAgents = new Set((runs ?? []).filter((r) => !r.ended_at).map((r) => r.profile.id));
  return (
    <div className="ag-runs" role="region" aria-labelledby="ag-runs-h">
      <h3 id="ag-runs-h">Runs</h3>
      <p className="hint">
        An agent run reads only what the agent may use and returns draft output for a person to
        review. It never changes this task’s status.
      </p>
      {problem ? (
        <Banner tone="danger" title="Something went wrong">
          {problem}
        </Banner>
      ) : null}
      {startable.length ? (
        <p className="ag-buttons">
          {startable.map((a) => (
            <button
              key={a.id}
              type="button"
              className="button button-secondary"
              disabled={busyAgents.has(a.id)}
              onClick={() => setStarting(a)}
            >
              {busyAgents.has(a.id) ? `${a.name} is running` : `Run ${a.name}`}
            </button>
          ))}
        </p>
      ) : null}
      {!runs && !problem ? <p role="status">Loading runs…</p> : null}
      {runs ? (
        runs.length ? (
          <ul className="au-list" aria-label="Agent runs">
            {runs.map((r) => (
              <li key={r.id} className="ag-run">
                <p>
                  <strong>{r.profile.name}</strong> <RunStateChip run={r} />{' '}
                  <span className="hint">
                    started {when(r.created_at)}
                    {r.attempt > 1 ? ` · attempt ${r.attempt}` : ''}
                  </span>{' '}
                  <button
                    type="button"
                    className="button button-ghost"
                    aria-expanded={open === r.id}
                    onClick={() => setOpen((v) => (v === r.id ? null : r.id))}
                  >
                    {open === r.id ? 'Hide details' : 'Details'}
                  </button>
                </p>
                {open === r.id ? (
                  <RunDetail
                    ws={ws}
                    initial={r}
                    onChanged={(next, message) => {
                      setRuns((list) => (list ?? []).map((x) => (x.id === r.id ? next : x)));
                      if (message) setSaid(message);
                      if (next.id !== r.id) load();
                    }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">No runs yet.</p>
        )
      ) : null}
      {starting ? (
        <StartRunDialog
          ws={ws}
          task={task}
          agent={starting}
          onClose={() => setStarting(null)}
          onStarted={(run) => {
            setStarting(null);
            setSaid(`${run.profile.name} was started. Its output will be a draft for review.`);
            setOpen(run.id);
            load();
          }}
        />
      ) : null}
      <Announce>{said}</Announce>
    </div>
  );
}

function StartRunDialog(props: {
  ws: string;
  task: string;
  agent: { id: string; name: string };
  onClose: () => void;
  onStarted: (run: AgentRun) => void;
}) {
  const { ws, task, agent, onClose, onStarted } = props;
  const [p, setP] = useState<RunPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    agentsClient
      .runPreview(ws, task, agent.id)
      .then((x) => live && setP(x))
      .catch((err) => live && setProblem(agentProblem(err, 'The run preview could not be made.')));
    return () => {
      live = false;
    };
  }, [ws, task, agent.id]);
  const internal = p?.profile.kind === 'internal';
  const start = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    key.current ??= newIdempotencyKey();
    try {
      const run = await agentsClient.startRun(
        ws,
        task,
        agent.id,
        internal && confirmed,
        key.current,
      );
      key.current = null;
      onStarted(run);
    } catch (err) {
      if (!ambiguous(err)) key.current = null;
      setProblem(agentProblem(err, 'The run could not be started.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Run ${agent.name}?`}
      description="This is exactly what the agent may use for this run. It is fixed when the run starts."
      onClose={onClose}
    >
      {problem ? (
        <Banner tone="danger" title="The run cannot start">
          {problem}
        </Banner>
      ) : null}
      {!p && !problem ? <p role="status">Preparing the preview…</p> : null}
      {p ? (
        <div className="ag-preview" role="region" aria-label="Run preview">
          <h4>What it may read</h4>
          {p.scope.items.length ? (
            <ul className="ag-scope" aria-label="Run scope">
              {p.scope.items.map((i) => (
                <li key={`${i.kind}:${i.id}`}>
                  {i.name} <span className="hint">({i.kind})</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>Nothing you can open.</p>
          )}
          <h4>Tools</h4>
          {p.tools.length ? (
            <ul aria-label="Run tools">
              {p.tools.map((t) => (
                <li key={`${t.name}@${t.version}`}>
                  {t.name}{' '}
                  <span className="hint">
                    {t.mode === 'runs'
                      ? '· runs (read only)'
                      : '· will ask for approval, which is not available yet; nothing changes'}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p>No tools.</p>
          )}
          {Object.keys(p.limits).length ? (
            <>
              <h4>Limits</h4>
              <dl className="au-facts">
                {Object.entries(p.limits).map(([k, v]) => (
                  <div key={k}>
                    <dt>{LIMIT_TEXT[k] ?? k.replace(/_/g, ' ')}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </>
          ) : null}
          <h4>Cost</h4>
          <p>{p.costs.measured ?? p.costs.reported}</p>
          {p.refusals.length ? (
            <>
              <h4>Why it cannot start</h4>
              <ul className="au-issues" aria-label="Why it cannot start">
                {p.refusals.map((r) => (
                  <li key={`${r.pointer}:${r.code}`}>{r.message}</li>
                ))}
              </ul>
            </>
          ) : null}
          {internal && p.can_start ? (
            <label className="ag-check">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>I confirm this run may use this workspace’s AI within its budget.</span>
            </label>
          ) : null}
        </div>
      ) : null}
      <p className="actions">
        <button type="button" className="button button-secondary" data-cancel onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button button-primary"
          disabled={busy || !p?.can_start || (internal && !confirmed)}
          onClick={() => void start()}
        >
          {busy ? 'Starting…' : 'Start run'}
        </button>
      </p>
    </Dialog>
  );
}

/** Long-poll progress with reconnect; the run view is reloaded whenever its state moves. */
function useRunEvents(ws: string, run: AgentRun, onState: () => void) {
  const open = !run.ended_at;
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [reconnecting, setReconnecting] = useState(false);
  const [gone, setGone] = useState(false);
  const stateRef = useRef(`${run.state}:${run.waiting ?? ''}`);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  useEffect(() => {
    let live = true;
    let cursor = 0;
    let failures = 0;
    const loop = async () => {
      for (;;) {
        if (!live) return;
        try {
          const r = await agentsClient.runEvents(ws, run.id, cursor, cursor === 0 ? 0 : 20);
          if (!live) return;
          failures = 0;
          setReconnecting(false);
          // A restarted follow (resume or retry) reads from the start: keep each event once.
          if (r.events.length)
            setEvents((e) => {
              const seen = new Set(e.map((x) => x.seq));
              return [...e, ...r.events.filter((x) => !seen.has(x.seq))].slice(-200);
            });
          cursor = r.cursor;
          const s = `${r.state}:${r.waiting ?? ''}`;
          if (s !== stateRef.current) {
            stateRef.current = s;
            onStateRef.current();
          }
          if (r.ended && !r.events.length) return;
        } catch (err) {
          if (!live) return;
          if (err instanceof ApiError && (err.code === 'not_found' || err.code === 'forbidden')) {
            setGone(true);
            return;
          }
          failures += 1;
          setReconnecting(true);
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(30_000, 1000 * 2 ** failures)),
          );
        }
      }
    };
    void loop();
    return () => {
      live = false;
    };
    // A run that opens again (resume or retry) is followed again.
  }, [ws, run.id, open]);
  return { events, reconnecting, gone };
}

function RunDetail(props: {
  ws: string;
  initial: AgentRun;
  onChanged: (run: AgentRun, message?: string) => void;
}) {
  const { ws, initial, onChanged } = props;
  const [run, setRun] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [artifact, setArtifact] = useState<ArtifactVersions | null>(null);
  const keys = useRef<Record<string, string>>({});
  const refresh = useCallback(() => {
    agentsClient
      .run(ws, run.id)
      .then((r) => {
        setRun(r);
        onChanged(r);
      })
      .catch(() => undefined);
  }, [ws, run.id, onChanged]);
  const { events, reconnecting, gone } = useRunEvents(ws, run, refresh);
  const control = async (verb: 'pause' | 'resume' | 'cancel' | 'retry') => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    keys.current[verb] ??= newIdempotencyKey();
    try {
      const r = await agentsClient.control(ws, run.id, verb, keys.current[verb]!);
      delete keys.current[verb];
      setRun(r);
      onChanged(
        r,
        verb === 'pause'
          ? 'The run was paused.'
          : verb === 'resume'
            ? 'The run was resumed.'
            : verb === 'cancel'
              ? 'The run was cancelled.'
              : 'The run was retried.',
      );
    } catch (err) {
      if (!ambiguous(err)) delete keys.current[verb];
      setProblem(agentProblem(err, 'That did not work. The run is unchanged.'));
      refresh();
    } finally {
      setBusy(false);
    }
  };
  const openArtifact = (key: string) => {
    agentsClient
      .artifact(ws, run.id, key)
      .then(setArtifact)
      .catch((err) => setProblem(agentProblem(err, 'The draft could not be opened.')));
  };
  if (gone) return <p>This run is no longer available to you.</p>;
  const ended = ENDED.includes(run.state);
  return (
    <div className="ag-run-detail" role="region" aria-label={`Run of ${run.profile.name}`}>
      {problem ? (
        <Banner tone="danger" title="Something went wrong">
          {problem}
        </Banner>
      ) : null}
      {run.state === 'waiting' && run.waiting ? (
        <div className="ag-run-why">
          <p>
            {run.waiting === 'paused' && run.paused_by === 'emergency_stop'
              ? 'Paused by the workspace emergency stop. Each run is resumed on its own.'
              : (WAITING_TEXT[run.waiting] ?? run.waiting)}
          </p>
          {run.waiting_reasons.length ? (
            <ul className="au-issues" aria-label="What changed">
              {run.waiting_reasons.map((r) => (
                <li key={r}>{reasonText(r)}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {run.state === 'ready_for_review' ? (
        <p className="ag-run-why">
          The agent returned draft output. A person reviews it before it counts; review is not
          available yet, and this task is unchanged.
        </p>
      ) : null}
      {run.failure ? (
        <p className="ag-run-why">
          {run.state === 'cancelled' ? 'Cancelled.' : 'The run failed.'}{' '}
          {run.failure.code ? (FAILURE_TEXT[run.failure.code] ?? reasonText(run.failure.code)) : ''}
          {run.failure.liability
            ? ' Some work may already have reached the agent; it was not undone.'
            : ''}
        </p>
      ) : null}
      {run.result ? (
        <dl className="au-facts">
          <div>
            <dt>Agent’s summary (not verified)</dt>
            <dd>{run.result.summary}</dd>
          </div>
        </dl>
      ) : null}
      <dl className="au-facts">
        <div>
          <dt>Tool calls</dt>
          <dd>
            {run.usage.tool_calls}
            {typeof run.limits.max_tool_calls === 'number'
              ? ` of ${run.limits.max_tool_calls}`
              : ''}
          </dd>
        </div>
        <div>
          <dt>Drafts</dt>
          <dd>{run.usage.artifacts}</dd>
        </div>
        {run.usage.deadline_at && !ended ? (
          <div>
            <dt>Ends by</dt>
            <dd>{when(run.usage.deadline_at)}</dd>
          </div>
        ) : null}
        {run.costs.measured ? (
          <div>
            <dt>AI usage (measured)</dt>
            <dd>{micros(run.costs.measured.micros)}</dd>
          </div>
        ) : null}
        {run.costs.reported ? (
          <div>
            <dt>Cost ({run.costs.reported.label}, not measured)</dt>
            <dd>{micros(run.costs.reported.micros, run.costs.reported.currency)}</dd>
          </div>
        ) : null}
      </dl>
      {run.artifacts.length ? (
        <>
          <h4>Draft output</h4>
          <ul aria-label="Draft output">
            {run.artifacts.map((a) => (
              <li key={a.key}>
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => openArtifact(a.key)}
                >
                  {a.title}
                </button>{' '}
                <span className="hint">
                  draft · version {a.version} · {a.media_type}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h4>Progress</h4>
      {reconnecting ? <p role="status">Reconnecting to progress…</p> : null}
      {events.length ? (
        <ol className="ag-timeline" aria-label="Run progress">
          {events.map((e) => (
            <li key={e.seq}>
              <span className="hint">{new Date(e.at).toLocaleTimeString()}</span>{' '}
              {e.source === 'agent' ? <span className="hint">(agent’s note) </span> : null}
              {e.text ?? e.kind.replace(/_/g, ' ')}
            </li>
          ))}
        </ol>
      ) : (
        <p className="hint">No progress yet.</p>
      )}
      {run.tool_calls.length ? (
        <details>
          <summary>Tool calls ({run.tool_calls.length})</summary>
          <ol className="ag-timeline" aria-label="Tool calls">
            {[...run.tool_calls].reverse().map((c) => (
              <li key={c.sequence}>
                {c.tool} {DECISION_TEXT[c.decision] ?? c.decision}
                {c.code && c.decision !== 'executed' ? (
                  <span className="hint"> · {TOOL_CODE_TEXT[c.code] ?? c.code}</span>
                ) : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      <p className="ag-buttons">
        {run.capabilities.pause ? (
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() => void control('pause')}
          >
            Pause
          </button>
        ) : null}
        {run.capabilities.resume ? (
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() => void control('resume')}
          >
            Resume
          </button>
        ) : null}
        {run.capabilities.retry ? (
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() => void control('retry')}
          >
            Retry
          </button>
        ) : null}
        {run.capabilities.cancel ? (
          <button
            type="button"
            className="button button-ghost"
            disabled={busy}
            onClick={() => setConfirmCancel(true)}
          >
            Cancel run
          </button>
        ) : null}
      </p>
      {confirmCancel ? (
        <Dialog
          title="Cancel this run?"
          description="The agent is told to stop and its access ends. Anything it already sent stays as a draft."
          destructive
          onClose={() => setConfirmCancel(false)}
        >
          <p className="actions">
            <button
              type="button"
              className="button button-secondary"
              data-cancel
              onClick={() => setConfirmCancel(false)}
            >
              Keep running
            </button>
            <button
              type="button"
              className="button button-danger"
              onClick={() => {
                setConfirmCancel(false);
                void control('cancel');
              }}
            >
              Cancel run
            </button>
          </p>
        </Dialog>
      ) : null}
      {artifact ? (
        <Dialog
          title={artifact.versions[0]?.title ?? 'Draft'}
          description="Draft output from the agent, for review. It has not been accepted."
          onClose={() => setArtifact(null)}
        >
          <pre className="ag-artifact" tabIndex={0} aria-label="Draft content">
            {artifact.versions[0]?.content}
          </pre>
          <p className="hint">
            Version {artifact.versions[0]?.version} · sha256 {artifact.versions[0]?.sha256}
          </p>
          <p className="actions">
            <button
              type="button"
              className="button button-secondary"
              data-cancel
              onClick={() => setArtifact(null)}
            >
              Close
            </button>
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Health and the emergency stop (owners and administrators)
// ---------------------------------------------------------------------------------------------

export function AgentHealthCard({ ws }: { ws: string }) {
  const [h, setH] = useState<AgentHealth | null>(null);
  const [hidden, setHidden] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const key = useRef<string | null>(null);
  const load = useCallback(() => {
    agentsClient
      .health(ws)
      .then(setH)
      .catch((err) => {
        if (err instanceof ApiError && (err.code === 'not_found' || err.code === 'forbidden'))
          setHidden(true);
        else setProblem(agentProblem(err, 'Agent health could not be loaded.'));
      });
  }, [ws]);
  useEffect(load, [load]);
  if (hidden) return null;
  const act = async (stop: boolean) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    key.current ??= newIdempotencyKey();
    try {
      const r = stop
        ? await agentsClient.emergencyStop(ws, reason, key.current)
        : await agentsClient.restart(ws, key.current);
      key.current = null;
      setSaid(
        stop
          ? `Agent work is stopped.${
              r.report
                ? ` ${r.report.paused} run(s) paused; ${r.report.already} already paused; ${r.report.finishing} finishing.`
                : ''
            }`
          : 'Agents may run again. Paused runs stay paused until each is resumed.',
      );
      setReason('');
      load();
    } catch (err) {
      if (!ambiguous(err)) key.current = null;
      setProblem(agentProblem(err, 'That did not work.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card au-section" aria-labelledby="ag-health-h">
      <h2 id="ag-health-h">Agent runs and emergency stop</h2>
      {problem ? (
        <Banner tone="danger" title="Something went wrong">
          {problem}
        </Banner>
      ) : null}
      {!h && !problem ? <p role="status">Loading agent health…</p> : null}
      {h ? (
        <>
          {h.emergency_stop.stopped ? (
            <Banner tone="warning" title="Agent work is stopped">
              No agent run starts or continues in this workspace
              {h.emergency_stop.since ? ` since ${when(h.emergency_stop.since)}` : ''}.
            </Banner>
          ) : (
            <p>Agents may run in this workspace.</p>
          )}
          <dl className="au-facts" aria-label={`Runs in the last ${h.window_days} days`}>
            {(Object.keys(STATE_TEXT) as RunState[]).map((s) => (
              <div key={s}>
                <dt>{STATE_TEXT[s]}</dt>
                <dd>{h.runs[s] ?? 0}</dd>
              </div>
            ))}
          </dl>
          <p className="hint">Runs open now or ended in the last {h.window_days} days.</p>
          {h.emergency_stop.can_trigger ? (
            <p className="ag-buttons">
              {h.emergency_stop.stopped ? (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => void act(false)}
                >
                  Allow agents to run again
                </button>
              ) : (
                <button
                  type="button"
                  className="button button-danger"
                  disabled={busy}
                  onClick={() => setConfirming(true)}
                >
                  Stop all agent work
                </button>
              )}
            </p>
          ) : null}
        </>
      ) : null}
      {confirming ? (
        <Dialog
          title="Stop all agent work?"
          description="Every open run pauses at once and every agent’s run access ends. Work an agent already sent stays as a draft. Runs stay paused after you allow agents again, until each is resumed."
          destructive
          onClose={() => setConfirming(false)}
        >
          <div className="field au-field">
            <label htmlFor="ag-stop-reason">Reason (optional)</label>
            <input
              id="ag-stop-reason"
              type="text"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <p className="actions">
            <button
              type="button"
              className="button button-secondary"
              data-cancel
              onClick={() => setConfirming(false)}
            >
              Keep running
            </button>
            <button
              type="button"
              className="button button-danger"
              onClick={() => {
                setConfirming(false);
                void act(true);
              }}
            >
              Stop all agent work
            </button>
          </p>
        </Dialog>
      ) : null}
      <Announce>{said}</Announce>
    </section>
  );
}
