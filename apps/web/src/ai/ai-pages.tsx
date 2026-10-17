import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, newIdempotencyKey } from '../api.ts';
import { Link } from '../router.tsx';
import { useWorkspaceShell } from '../shell/workspace.tsx';
import { useStepUp } from '../stepup.tsx';
import { Announce, Banner } from '../ui/feedback.tsx';
import { Field, SelectField, SubmitButton, TextAreaField } from '../ui/form.tsx';
import { Page } from '../ui/layout.tsx';
import {
  aiClient,
  aiProblem,
  TERMINAL,
  type AiEstimate,
  type AiOverview,
  type AiRun,
  type AiSettings,
  type AiUsage,
  type AiUsageAdmin,
  type BrandAiProfile,
} from './client.ts';

const POLL_MS = 1000;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

function UsageSummary({ usage, heading = 'This month' }: { usage: AiUsage; heading?: string }) {
  return (
    <section aria-labelledby="ai-usage-heading" className="ai-panel">
      <h2 id="ai-usage-heading">{heading}</h2>
      <dl className="ai-facts">
        <div>
          <dt>Used</dt>
          <dd>{usage.consumed.display}</dd>
        </div>
        <div>
          <dt>Reserved for running or unknown work</dt>
          <dd>{usage.reserved.display}</dd>
        </div>
        <div>
          <dt>Remaining allowance</dt>
          <dd>{usage.remaining_allowance.display}</dd>
        </div>
        <div>
          <dt>Hard limit</dt>
          <dd>{usage.hard_limit.display}</dd>
        </div>
      </dl>
      <p className="hint">
        Period {usage.period.start} to {usage.period.end} (workspace time zone). Runs that could
        exceed the hard limit do not start.
      </p>
    </section>
  );
}

function Availability({ overview }: { overview: AiOverview }) {
  if (overview.availability === 'ready')
    return overview.synthetic ? (
      <Banner tone="info" title="Synthetic test model">
        <p>
          Runs go to a local protocol fixture, not to an AI provider. Answers and costs are
          synthetic and labelled so.
        </p>
      </Banner>
    ) : null;
  return (
    <Banner
      tone={overview.availability === 'unconfigured' ? 'info' : 'warning'}
      title="AI is not available"
    >
      <p>{overview.reason}</p>
      <p>{overview.manual_fallback}</p>
    </Banner>
  );
}

/** A run's outcome: status, cost, and, for its initiator, the content they may still see. */
function RunDetail({ run }: { run: AiRun }) {
  const label = run.synthetic ? 'Synthetic output' : 'Output';
  return (
    <div className="ai-run-detail">
      <p>
        <strong>{run.status}</strong>
        {run.synthetic ? <span className="ai-tag"> Synthetic</span> : null}
      </p>
      <dl className="ai-facts">
        <div>
          <dt>Model</dt>
          <dd>{run.model.label}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>{run.cost.settled.display}</dd>
        </div>
        <div>
          <dt>Estimated maximum</dt>
          <dd>{run.estimate.max_cost.display}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{when(run.created_at)}</dd>
        </div>
      </dl>
      {run.refusal ? <p role="status">{run.refusal.message}</p> : null}
      {run.cost.note ? <p className="hint">{run.cost.note}</p> : null}
      {run.content?.state === 'present' && run.content.output ? (
        <section aria-label={label} className="ai-output">
          <h3>
            {label}
            {run.content.output.completeness !== 'complete' ? ' (incomplete)' : ''}
          </h3>
          <p className="ai-output-text">{run.content.output.text}</p>
        </section>
      ) : null}
      {run.content && run.content.state !== 'present' ? <p>{run.content.note}</p> : null}
      {run.attempts.length ? (
        <table className="ai-attempts">
          <caption>Attempts</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Result</th>
              <th scope="col">Tokens in / out</th>
              <th scope="col">Cost</th>
            </tr>
          </thead>
          <tbody>
            {run.attempts.map((a) => (
              <tr key={a.number}>
                <td>{a.number}</td>
                <td>{a.state}</td>
                <td>
                  {a.input_tokens ?? '?'} / {a.output_tokens ?? '?'}
                </td>
                <td>{a.settled ? a.settled.display : `Unknown (up to ${a.reserved.display})`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

/**
 * The AI test-run page (7A): availability and privacy, usage and limits, a synthetic or approved
 * non-mutating test run with an estimate before it starts, running, cancel, partial, and error
 * states, and the person's own history. Nothing here changes a record.
 */
export function AiPage({ ws }: { ws: string }) {
  const shell = useWorkspaceShell();
  const brands = (shell?.context?.brands ?? []).filter((b) => !b.is_sensitive);
  const [overview, setOverview] = useState<AiOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [brand, setBrand] = useState('');
  const [context, setContext] = useState('');
  const [estimate, setEstimate] = useState<AiEstimate | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [current, setCurrent] = useState<AiRun | null>(null);
  const [history, setHistory] = useState<AiRun[]>([]);
  const [open, setOpen] = useState<AiRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const startKey = useRef<string | null>(null);

  const [nonce, setNonce] = useState(0);
  const load = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    let gone = false;
    Promise.all([aiClient.overview(ws), aiClient.runs(ws)])
      .then(([o, h]) => {
        if (gone) return;
        setOverview(o);
        setHistory(h);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!gone) setLoadError(aiProblem(err, 'AI status could not be loaded.'));
      });
    return () => {
      gone = true;
    };
  }, [ws, nonce]);

  // Poll the running run until it is terminal or parked for reconciliation.
  useEffect(() => {
    if (
      !current ||
      TERMINAL.has(current.state) ||
      current.waiting_reason === 'reconciliation_required'
    )
      return;
    const t = setTimeout(() => {
      aiClient
        .run(ws, current.id)
        .then((r) => {
          setCurrent(r);
          if (TERMINAL.has(r.state)) {
            setSaid(`Test run finished: ${r.status}.`);
            load();
          }
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [current, ws, load]);

  const body = () => ({
    prompt,
    ...(brand ? { brand } : {}),
    ...(context.trim()
      ? {
          context: context
            .split(/[\s,]+/)
            .filter(Boolean)
            .map((id) => ({ id })),
        }
      : {}),
  });

  const doEstimate = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setEstimate(null);
    setConfirmed(false);
    try {
      setEstimate(await aiClient.estimate(ws, body()));
      startKey.current = newIdempotencyKey();
    } catch (err) {
      setError(aiProblem(err, 'The estimate could not be made.'));
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!estimate) return;
    setBusy(true);
    setError(null);
    try {
      const run = await aiClient.start(
        ws,
        { ...body(), confirm_cost: confirmed },
        startKey.current ?? newIdempotencyKey(),
      );
      setCurrent(run);
      setSaid('Test run queued.');
      setEstimate(null);
    } catch (err) {
      // An offline or dropped request keeps its key, so retrying never starts a second run.
      setError(aiProblem(err, 'The test run did not start.'));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (run: AiRun) => {
    setBusy(true);
    setError(null);
    try {
      const r = await aiClient.cancel(ws, run.id);
      setCurrent(r);
      setSaid(r.status);
    } catch (err) {
      setError(aiProblem(err, 'The run could not be cancelled.'));
    } finally {
      setBusy(false);
    }
  };

  // A retry is a new run at today's price: above the threshold it waits for explicit confirmation.
  const [retryConfirm, setRetryConfirm] = useState<{ run: AiRun; message: string } | null>(null);
  const retry = async (run: AiRun, confirm = false) => {
    setBusy(true);
    setError(null);
    try {
      const r = await aiClient.retry(ws, run.id, confirm);
      setCurrent(r);
      setOpen(null);
      setRetryConfirm(null);
      setSaid('Retry queued as a new run.');
    } catch (err) {
      if (err instanceof ApiError && err.issues[0]?.code === 'confirmation_required')
        setRetryConfirm({ run, message: err.issues[0].message });
      else setError(aiProblem(err, 'The run could not be retried.'));
    } finally {
      setBusy(false);
    }
  };

  const view = async (run: AiRun) => {
    try {
      setOpen(await aiClient.run(ws, run.id));
    } catch (err) {
      setError(aiProblem(err, 'That run could not be opened.'));
    }
  };

  const ready = overview?.availability === 'ready' && overview.can_execute;
  return (
    <Page title="AI test runs" wide>
      <p>
        A non-mutating test of the AI gateway: it can answer, but it cannot change records, complete
        work, or approve anything. <Link to={`/workspaces/${ws}/settings/ai`}>AI settings</Link>
      </p>
      <p>
        <Link to={`/workspaces/${ws}/ai/ask`}>Ask with sources</Link>: read-only answers that cite
        records you can read, with the context shown first.
      </p>
      {loadError ? (
        <Banner
          tone="danger"
          title="Something went wrong"
          action={
            <button type="button" onClick={() => load()}>
              Try again
            </button>
          }
        >
          {loadError}
        </Banner>
      ) : null}
      {overview ? <Availability overview={overview} /> : null}
      {error ? (
        <Banner tone="danger" title="That did not work">
          {error}
        </Banner>
      ) : null}
      {overview?.usage ? <UsageSummary usage={overview.usage} /> : null}
      {ready ? (
        <section
          aria-labelledby="ai-run-heading"
          aria-busy={busy ? 'true' : 'false'}
          className="ai-panel"
        >
          <h2 id="ai-run-heading">New test run</h2>
          <form onSubmit={doEstimate} className="portability-controls">
            <TextAreaField
              id="ai-prompt"
              label="Request"
              value={prompt}
              onChange={setPrompt}
              maxLength={8000}
              hint="Credentials are removed before anything is stored or sent."
            />
            <SelectField
              id="ai-brand"
              label="Scope"
              value={brand}
              onChange={setBrand}
              options={[
                { value: '', label: 'Whole workspace' },
                ...brands.map((b) => ({ value: b.id, label: b.name })),
              ]}
            />
            <Field
              id="ai-context"
              label="Context records (optional)"
              hint="Task or project identifiers you can read, separated by spaces."
              value={context}
              onChange={(e) => setContext(e.target.value)}
            />
            <SubmitButton busy={busy}>Estimate cost</SubmitButton>
          </form>
          {estimate ? (
            <div className="ai-estimate" role="region" aria-labelledby="ai-estimate-heading">
              <h3 id="ai-estimate-heading">Estimate</h3>
              <p>
                Up to <strong>{estimate.max_cost.display}</strong>
                {estimate.synthetic ? ' (synthetic price)' : ''}. {estimate.basis}
              </p>
              {estimate.redactions ? (
                <p>{estimate.redactions} credential(s) will be removed before sending.</p>
              ) : null}
              {estimate.context.some((c) => !c.included) ? (
                <p>
                  Excluded by policy:{' '}
                  {estimate.context
                    .filter((c) => !c.included)
                    .map((c) => `${c.id} (${c.exclusion_reason})`)
                    .join(', ')}
                </p>
              ) : null}
              {estimate.within_limits ? (
                <>
                  {estimate.confirm_required ? (
                    <label className="ai-confirm">
                      <input
                        type="checkbox"
                        checked={confirmed}
                        onChange={(e) => setConfirmed(e.target.checked)}
                      />{' '}
                      I confirm this run may cost up to {estimate.max_cost.display}
                    </label>
                  ) : null}
                  <button
                    type="button"
                    className="button"
                    disabled={busy || (estimate.confirm_required && !confirmed)}
                    onClick={() => void start()}
                  >
                    Start test run
                  </button>
                </>
              ) : (
                <Banner tone="warning" title="This run cannot start">
                  {estimate.blocked_reason}
                </Banner>
              )}
            </div>
          ) : null}
        </section>
      ) : null}
      {retryConfirm ? (
        <Banner
          tone="warning"
          title="Confirm the retry"
          action={
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => void retry(retryConfirm.run, true)}
            >
              Confirm retry
            </button>
          }
        >
          {retryConfirm.message}
        </Banner>
      ) : null}
      {current ? (
        <section aria-labelledby="ai-current-heading" className="ai-panel" aria-live="polite">
          <h2 id="ai-current-heading">Current run</h2>
          <RunDetail run={current} />
          {current.can_cancel ? (
            <>
              <button
                type="button"
                className="button button-ghost"
                disabled={busy}
                onClick={() => void cancel(current)}
              >
                Cancel run
              </button>
              <p className="hint">{current.cancellation_note}</p>
            </>
          ) : null}
        </section>
      ) : null}
      <section aria-labelledby="ai-history-heading" className="ai-panel">
        <h2 id="ai-history-heading">Your AI history</h2>
        <p className="hint">
          Only you can see your prompts and outputs. If a source is no longer available to you, its
          content is withheld. <a href={aiClient.exportUrl(ws)}>Export your AI history (CSV)</a>
        </p>
        {history.length === 0 ? <p>No AI runs yet.</p> : null}
        <ul aria-label="AI runs" className="today-list">
          {history.map((r) => (
            <li key={r.id} className="today-item">
              <span className="today-item-main">
                {r.status} · {r.cost.settled.display} · {when(r.created_at)}
                {r.synthetic ? ' · Synthetic' : ''}
              </span>
              <button type="button" className="button button-ghost" onClick={() => void view(r)}>
                View<span className="visually-hidden"> run from {when(r.created_at)}</span>
              </button>
              {r.can_retry ? (
                <button
                  type="button"
                  className="button button-ghost"
                  disabled={busy}
                  onClick={() => void retry(r)}
                >
                  Retry<span className="visually-hidden"> run from {when(r.created_at)}</span>
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {open ? (
          <div className="ai-panel" role="region" aria-label="Run details">
            <RunDetail run={open} />
            {open.content?.state === 'present' && open.content.prompt ? (
              <p>
                <strong>Request:</strong> {open.content.prompt}
              </p>
            ) : null}
            <button type="button" className="button button-ghost" onClick={() => setOpen(null)}>
              Close details
            </button>
          </div>
        ) : null}
      </section>
      <Announce>{said}</Announce>
    </Page>
  );
}

const usdToMicros = (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? (n * 1_000_000).toFixed(6) : null;
};
const microsToUsd = (v: string) => (Number(v) / 1_000_000).toFixed(2);

/**
 * AI settings (7A): provider and model with their privacy status, the data class the workspace
 * allows, the confirm-above amount, monthly allowance and hard limits, workspace keys (off until
 * approved), brand AI profiles, and usage with cost reconciliation. Changes need step-up.
 */
export function AiSettingsPage({ ws }: { ws: string }) {
  const stepUp = useStepUp();
  const shell = useWorkspaceShell();
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [usage, setUsage] = useState<AiUsageAdmin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [model, setModel] = useState('');
  const [dataClass, setDataClass] = useState('C2');
  const [confirmAbove, setConfirmAbove] = useState('0.00');
  const [allowance, setAllowance] = useState('');
  const [hard, setHard] = useState('');

  const apply = (s: AiSettings) => {
    setSettings(s);
    setEnabled(s.enabled);
    setModel(s.model_key ?? s.models[0]?.key ?? '');
    setDataClass(s.max_data_class);
    setConfirmAbove(microsToUsd(s.confirm_above.micros));
    const cost = s.limits.find((l) => l.meter === 'ai.cost');
    if (cost) {
      setAllowance(microsToUsd(cost.monthly_allowance));
      setHard(microsToUsd(cost.hard_limit));
    }
  };
  useEffect(() => {
    let gone = false;
    aiClient
      .settings(ws)
      .then(async (loaded) => {
        const u = await aiClient.usage(ws).catch(() => null);
        if (gone) return;
        apply(loaded);
        setUsage(u);
      })
      .catch((err: unknown) => {
        if (gone) return;
        if (err instanceof ApiError && (err.code === 'forbidden' || err.code === 'not_found'))
          setForbidden(true);
        else setError(aiProblem(err, 'AI settings could not be loaded.'));
      });
    return () => {
      gone = true;
    };
  }, [ws]);

  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setSaid('');
    try {
      setSaid(await fn());
    } catch (err) {
      setError(aiProblem(err, 'The change was not saved.'));
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = (e: FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    const above = usdToMicros(confirmAbove);
    void act(async () => {
      apply(
        await aiClient.saveSettings(
          ws,
          {
            enabled,
            model_key: model || null,
            max_data_class: dataClass,
            ...(above ? { confirm_above_micros: above } : {}),
          },
          settings.version,
          stepUp,
        ),
      );
      return 'AI settings saved.';
    });
  };
  const saveLimits = (e: FormEvent) => {
    e.preventDefault();
    const a = usdToMicros(allowance);
    const h = usdToMicros(hard);
    if (!a || !h) {
      setError('Use amounts in US dollars, for example 5.00.');
      return;
    }
    void act(async () => {
      apply(
        await aiClient.saveLimits(
          ws,
          [{ meter: 'ai.cost', monthly_allowance: a, hard_limit: h }],
          stepUp,
        ),
      );
      return 'Limits saved. New runs use them at once; usage already incurred is kept.';
    });
  };
  const reconcile = (run: string, attempt: number, basis: string) =>
    void act(async () => {
      await aiClient.reconcile(ws, run, attempt, { basis }, stepUp);
      setUsage(await aiClient.usage(ws));
      return 'Cost reconciled.';
    });

  if (forbidden)
    return (
      <Page title="AI settings">
        <p>Only workspace owners and administrators manage AI.</p>
        <p>
          <Link to={`/workspaces/${ws}/ai`}>AI test runs</Link>
        </p>
      </Page>
    );
  return (
    <Page title="AI settings" wide>
      <p>
        AI is optional; every workflow works without it.{' '}
        <Link to={`/workspaces/${ws}/ai`}>AI test runs</Link>
      </p>
      {error ? (
        <Banner tone="danger" title="That did not work">
          {error}
        </Banner>
      ) : null}
      {settings ? (
        <>
          <Banner
            tone={settings.availability === 'ready' ? 'success' : 'info'}
            title={settings.availability === 'ready' ? 'AI is available' : 'AI is not available'}
          >
            <p>{settings.reason}</p>
          </Banner>
          {settings.suspended ? (
            <Banner
              tone="warning"
              title="AI is paused for review"
              action={
                settings.can_manage_providers ? (
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        apply(
                          await aiClient.saveSettings(
                            ws,
                            { resume_after_review: true },
                            settings.version,
                            stepUp,
                          ),
                        );
                        return 'AI resumed after review.';
                      })
                    }
                  >
                    Resume AI after review
                  </button>
                ) : null
              }
            >
              {settings.suspended.note}
            </Banner>
          ) : null}
          <section
            aria-labelledby="ai-provider-heading"
            aria-busy={busy ? 'true' : 'false'}
            className="ai-panel"
          >
            <h2 id="ai-provider-heading">Provider and privacy</h2>
            {settings.models.length === 0 ? (
              <p>No AI provider is configured for this deployment.</p>
            ) : null}
            <form onSubmit={saveSettings} className="portability-controls">
              <label className="ai-confirm">
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={!settings.can_manage_providers}
                  onChange={(e) => setEnabled(e.target.checked)}
                />{' '}
                Turn on AI for this workspace
              </label>
              {settings.models.length ? (
                <SelectField
                  id="ai-model"
                  label="Model"
                  value={model}
                  onChange={setModel}
                  disabled={!settings.can_manage_providers}
                  options={settings.models.map((m) => ({ value: m.key, label: m.label }))}
                />
              ) : null}
              {settings.models
                .filter((m) => m.key === model)
                .map((m) => (
                  <div key={m.key} className="hint">
                    <p>{m.privacy.statement}</p>
                    <p>
                      Price {m.price.version}
                      {m.price.synthetic ? ' (synthetic)' : ''}: {m.price.input_per_million_tokens}{' '}
                      input and {m.price.output_per_million_tokens} output per million tokens.
                    </p>
                    {m.gates && m.gates.monetary_dispatch !== 'synthetic' ? (
                      <ul aria-label="Gates for real spending">
                        <li>
                          Price: {m.gates.price.state}
                          {m.gates.price.checked_on ? ` (checked ${m.gates.price.checked_on})` : ''}
                        </li>
                        <li>
                          Upper bound on what a request can cost: {m.gates.input_bound.state}
                          {m.gates.input_bound.reason ? `. ${m.gates.input_bound.reason}` : ''}
                        </li>
                        <li>
                          Error responses may be charged:{' '}
                          {m.gates.error_responses_chargeable === false ? 'no' : 'unknown'}
                        </li>
                      </ul>
                    ) : null}
                  </div>
                ))}
              <SelectField
                id="ai-data-class"
                label="Most sensitive data AI may receive"
                value={dataClass}
                onChange={setDataClass}
                disabled={!settings.can_manage_providers}
                options={[
                  { value: 'C2', label: 'Internal work content (C2)' },
                  { value: 'C1', label: 'Low-sensitivity metadata only (C1)' },
                  { value: 'C0', label: 'Public information only (C0)' },
                ]}
              />
              <Field
                id="ai-confirm-above"
                label="Ask for confirmation above (USD)"
                inputMode="decimal"
                value={confirmAbove}
                disabled={!settings.can_manage_providers}
                onChange={(e) => setConfirmAbove(e.target.value)}
              />
              <p className="hint">
                Training on workspace content stays excluded. Restricted and secret data are never
                sent.
              </p>
              {settings.can_manage_providers ? (
                <SubmitButton busy={busy}>Save AI settings</SubmitButton>
              ) : null}
            </form>
            <h3>Workspace-provided keys</h3>
            <p>{settings.workspace_key.note}</p>
          </section>
          <section aria-labelledby="ai-limits-heading" className="ai-panel">
            <h2 id="ai-limits-heading">Allowance and hard limit</h2>
            <form onSubmit={saveLimits} className="portability-controls">
              <Field
                id="ai-allowance"
                label="Monthly allowance (USD)"
                inputMode="decimal"
                value={allowance}
                disabled={!settings.can_configure_limits}
                onChange={(e) => setAllowance(e.target.value)}
              />
              <Field
                id="ai-hard-limit"
                label="Hard monthly limit (USD)"
                inputMode="decimal"
                value={hard}
                disabled={!settings.can_configure_limits}
                onChange={(e) => setHard(e.target.value)}
              />
              <p className="hint">
                {settings.limits.find((l) => l.meter === 'ai.cost')?.configured
                  ? 'Configured for this workspace.'
                  : 'Using the deployment default (finite).'}{' '}
                Owners and administrators are notified at{' '}
                {settings.warning_thresholds_bp.map((b) => `${b / 100}%`).join(' and ')} of the hard
                limit.
              </p>
              {settings.can_configure_limits ? (
                <SubmitButton busy={busy}>Save limits</SubmitButton>
              ) : null}
            </form>
          </section>
          <BrandProfiles
            ws={ws}
            brands={(shell?.context?.brands ?? []).map((b) => ({ id: b.id, name: b.name }))}
          />
        </>
      ) : null}
      {usage ? (
        <section aria-labelledby="ai-usage-admin-heading" className="ai-panel">
          <h2 id="ai-usage-admin-heading">Usage</h2>
          <UsageSummary usage={usage.usage} heading="Workspace usage this month" />
          <p className="hint">
            Usage shows cost and status only; nobody's prompts or outputs appear here.
          </p>
          {usage.awaiting_reconciliation.length ? (
            <>
              <h3>Unknown outcomes awaiting reconciliation</h3>
              <ul className="today-list" aria-label="Unknown outcomes">
                {usage.awaiting_reconciliation.map((u) => (
                  <li key={`${u.run}-${u.attempt}`} className="today-item">
                    <span className="today-item-main">
                      Attempt {u.attempt}: up to {u.reserved.display} reserved
                      {u.provider_request_id ? ` (provider request ${u.provider_request_id})` : ''}
                    </span>
                    {usage.can_reconcile ? (
                      <>
                        <button
                          type="button"
                          className="button button-ghost"
                          disabled={busy}
                          onClick={() => reconcile(u.run, u.attempt, 'reserved_bound')}
                        >
                          Charge the reserved amount
                        </button>
                        <button
                          type="button"
                          className="button button-ghost"
                          disabled={busy}
                          onClick={() => reconcile(u.run, u.attempt, 'not_charged')}
                        >
                          Provider did not charge
                        </button>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <ul className="today-list" aria-label="Recent AI runs">
            {usage.runs.slice(0, 20).map((r) => (
              <li key={r.id} className="today-item">
                <span className="today-item-main">
                  {r.status} · {r.cost.settled.display} · {r.model.label} · {when(r.created_at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Announce>{said}</Announce>
    </Page>
  );
}

/** Brand AI profiles (WSB-012): instructions, terminology, audience, voice, approved sources. */
function BrandProfiles({
  ws,
  brands,
}: {
  ws: string;
  brands: Array<{ id: string; name: string }>;
}) {
  const [brand, setBrand] = useState('');
  const [profile, setProfile] = useState<BrandAiProfile | null>(null);
  const [draft, setDraft] = useState({
    instructions: '',
    terminology: '',
    audience: '',
    voice: '',
  });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!brand) return;
    let gone = false;
    aiClient
      .brandProfile(ws, brand)
      .then((p) => {
        if (gone) return;
        setProfile(p);
        setDraft({
          instructions: p.instructions,
          terminology: p.terminology,
          audience: p.audience,
          voice: p.voice,
        });
      })
      .catch((err: unknown) => {
        if (!gone) setError(aiProblem(err, 'The brand profile could not be loaded.'));
      });
    return () => {
      gone = true;
    };
  }, [ws, brand]);
  // The loaded profile belongs to the chosen brand only (a cleared choice shows nothing).
  const shown = brand && profile?.id === brand ? profile : null;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!shown) return;
    setError('');
    try {
      const p = await aiClient.saveBrandProfile(ws, brand, draft, shown.version);
      setProfile(p);
      setMessage('Brand AI profile saved.');
    } catch (err) {
      setError(aiProblem(err, 'The brand profile was not saved.'));
    }
  };
  return (
    <section aria-labelledby="ai-brand-heading" className="ai-panel">
      <h2 id="ai-brand-heading">Brand AI profiles</h2>
      <div className="portability-controls">
        <SelectField
          id="ai-profile-brand"
          label="Brand"
          value={brand}
          onChange={setBrand}
          options={[
            { value: '', label: 'Choose a brand' },
            ...brands.map((b) => ({ value: b.id, label: b.name })),
          ]}
        />
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {shown ? (
        <form onSubmit={save} className="portability-controls">
          {(['instructions', 'terminology', 'audience', 'voice'] as const).map((k) => (
            <TextAreaField
              key={k}
              id={`ai-profile-${k}`}
              label={k[0]!.toUpperCase() + k.slice(1)}
              value={draft[k]}
              maxLength={k === 'instructions' ? 4000 : k === 'terminology' ? 2000 : 1000}
              onChange={(v) => setDraft((d) => ({ ...d, [k]: v }))}
            />
          ))}
          {shown.can_configure ? (
            <SubmitButton busy={false}>Save brand profile</SubmitButton>
          ) : (
            <p>You can read this profile but not change it.</p>
          )}
        </form>
      ) : null}
      <Announce>{message}</Announce>
    </section>
  );
}
