import { useEffect, useRef, useState, type FormEvent } from 'react';
import { newIdempotencyKey } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { Link, useRouter } from '../router.tsx';
import { useWorkspaceShell } from '../shell/workspace.tsx';
import { Announce, Banner } from '../ui/feedback.tsx';
import { Field, SelectField, SubmitButton, TextAreaField } from '../ui/form.tsx';
import { Page } from '../ui/layout.tsx';
import { readAssistDraft, writeAssistDraft, type AssistDraft } from './assist-drafts.ts';
import {
  aiClient,
  aiProblem,
  TERMINAL,
  type AiActionView,
  type AiAnalysis,
  type AiAnalysisSource,
  type AiEstimate,
  type AiManifest,
  type AiRun,
} from './client.ts';

/**
 * Phase 7C: one surface for every registered AI action (ADR-0041). Choose an action and its
 * context (workspace, brands, a project, or a task, preselected from where you came), preview the
 * sources (works with AI off), estimate and confirm, then read a typed result. Analysis results
 * label record facts, rule findings, and generated suggestions separately; drafts of records are
 * 7D proposals you review and apply yourself. Unsaved input is kept per account and workspace.
 */

const POLL_MS = 1000;
const ID_RE = /^(tsk|prj|doc|cmt|goal|cev)_[0-9A-HJKMNP-TV-Z]{26}$/;
const KIND_TEXT: Record<string, string> = {
  summary: 'Summary',
  decision: 'Decision (candidate)',
  action_item: 'Action item (candidate)',
  risk: 'Risk',
  blocker: 'Blocker',
  assumption: 'Assumption',
  open_question: 'Open question',
  duplicate: 'Possible duplicate',
  stale: 'Stale or overdue',
  ambiguous: 'Ambiguous',
  conflict: 'Conflict',
  recommendation: 'Recommendation',
  highlight: 'Highlight',
  change: 'Change',
};
const RULE_TEXT: Record<string, string> = {
  overdue: 'Rule: past its due date and not done',
  duplicate_title: 'Rule: identical titles',
  no_due_date: 'Rule: open without a due date',
  overdue_first: 'Rule: overdue work first',
  due_within_7_days: 'Rule: due within 7 days',
};
const ISSUE_TEXT: Record<string, string> = {
  quote_mismatch: 'its quotation did not match the source',
  untrusted_link: 'it contains a link, shown as text and never opened',
  contradicts_record: 'it contradicts the record (the records are right)',
  citation_dropped: 'a citation outside the context was removed',
};
const TYPE_PREFIX: Record<string, string> = {
  tsk_: 'task',
  prj_: 'project',
  doc_: 'document',
  cmt_: 'comment',
  goal_: 'goal',
  cev_: 'meeting',
};
const hrefOf = (ws: string, s: { type: string; id: string }) =>
  s.type === 'project'
    ? `/workspaces/${ws}/projects/${s.id}`
    : s.type === 'document'
      ? `/workspaces/${ws}/documents/${s.id}`
      : s.type === 'goal'
        ? `/workspaces/${ws}/goals/${s.id}`
        : s.type === 'meeting'
          ? `/workspaces/${ws}/calendar`
          : `/workspaces/${ws}/tasks/${s.id}`;

function useDraftAccount(): string | null {
  try {
    const me = useAuth().me;
    return me ? me.id : null;
  } catch {
    return 'device';
  }
}

function Cite({ ws, s }: { ws: string; s: AiAnalysisSource | null }) {
  if (!s) return <span className="hint">(source no longer available)</span>;
  return (
    <Link to={hrefOf(ws, s.link)}>
      {s.handle}: {s.title}
    </Link>
  );
}

function AnalysisView({ ws, a }: { ws: string; a: AiAnalysis }) {
  const rules = a.items.filter((i) => i.basis === 'rule');
  const generated = a.items.filter((i) => i.basis === 'generated');
  return (
    <div className="ai-answer">
      {a.note ? (
        <Banner
          tone={
            a.status === 'downgraded' ? 'warning' : a.status === 'needs_input' ? 'info' : 'danger'
          }
          title={
            a.status === 'needs_input'
              ? 'More information needed'
              : a.status === 'downgraded'
                ? 'Some items were removed'
                : 'Not shown as a result'
          }
        >
          {a.note}
        </Banner>
      ) : null}
      <p className="hint">{a.trust_note}</p>
      {rules.length ? (
        <section aria-label="Rule findings from the records">
          <h3>Rule findings from the records</h3>
          <ul>
            {rules.map((i, n) => (
              <li key={n}>
                <span className="ai-tag">{RULE_TEXT[i.rule ?? ''] ?? i.rule}</span> {i.text} —{' '}
                {i.sources.map((s, k) => (
                  <Cite key={k} ws={ws} s={s} />
                ))}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {a.draft ? (
        <section aria-label="Draft text (generated)">
          <h3>Draft text (generated)</h3>
          <p className="hint">Copy and edit it yourself; nothing is posted or published.</p>
          <pre className="ai-output-text">{a.draft}</pre>
        </section>
      ) : null}
      {generated.length ? (
        <section aria-label="Generated suggestions">
          <h3>Generated suggestions</h3>
          <ul>
            {generated.map((i, n) => (
              <li key={n}>
                <span className="ai-tag">{KIND_TEXT[i.kind] ?? i.kind}</span>{' '}
                {/* Generated text is rendered as text only: no HTML, links, or lookups. */}
                <span>{i.text}</span>
                {i.excerpt ? <span className="hint"> (the source says: “{i.excerpt}”)</span> : null}
                {i.reasoning ? <p className="hint">Why: {i.reasoning}</p> : null}
                <p className="hint">
                  Based on{' '}
                  {i.sources.map((s, k) => (
                    <span key={k}>
                      {k ? ', ' : ''}
                      <Cite ws={ws} s={s} />
                    </span>
                  ))}
                  {i.issues.length
                    ? `. Note: ${i.issues.map((x) => ISSUE_TEXT[x] ?? x).join('; ')}.`
                    : ''}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {a.facts.length ? (
        <section aria-label="Facts from the records">
          <h3>Facts from the records</h3>
          <ul>
            {a.facts.map((f, n) => (
              <li key={n}>
                {f.label}: {f.value} — <Cite ws={ws} s={f.source} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {a.assumptions.length ? (
        <section aria-label="Assumptions">
          <h3>Assumptions</h3>
          <ul>
            {a.assumptions.map((x, n) => (
              <li key={n}>{x}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="hint">Limitations: {a.limitations.join(' ')}</p>
    </div>
  );
}

const emptyDraft = (action = 'summarize.v1'): AssistDraft => ({
  action,
  instruction: '',
  brief: '',
  answers: [],
  brands: [],
  project: '',
  task: '',
  named: '',
});

export function AssistPage({ ws }: { ws: string }) {
  const { search } = useRouter();
  const account = useDraftAccount();
  const shell = useWorkspaceShell();
  const brands = (shell?.context?.brands ?? []).filter((b) => !b.is_sensitive);
  const [actions, setActions] = useState<AiActionView[] | null>(null);
  const [d, setD] = useState<AssistDraft>(() => ({
    ...emptyDraft(search.get('action') ?? 'summarize.v1'),
    project: search.get('project') ?? '',
    task: search.get('task') ?? '',
    brands: search.get('brand') ? [search.get('brand')!] : [],
  }));
  const [manifest, setManifest] = useState<AiManifest | null>(null);
  const [estimate, setEstimate] = useState<(AiEstimate & { input_digest: string }) | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [current, setCurrent] = useState<AiRun | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const runKey = useRef<string | null>(null);
  const restored = useRef(false);

  // The catalog load is the authoritative check for this workspace; a stored draft is restored only
  // after it succeeds, and the preselected scope from the entry point wins over a stored scope.
  useEffect(() => {
    if (account === null) return;
    let gone = false;
    aiClient.actions(ws).then(
      (items) => {
        if (gone) return;
        setActions(items);
        if (!restored.current) {
          restored.current = true;
          const stored = readAssistDraft(account, ws);
          const entry = search.get('project') || search.get('task') || search.get('brand');
          if (stored && !entry) setD(stored);
        }
      },
      (err) => {
        if (!gone) setError(aiProblem(err, 'AI actions could not be loaded.'));
      },
    );
    return () => {
      gone = true;
    };
  }, [account, ws, search]);

  const def = actions?.find((a) => a.id === d.action) ?? null;
  const change = (next: Partial<AssistDraft>) => {
    const merged = { ...d, ...next };
    setD(merged);
    // Any material change needs a fresh preview and estimate (the confirmation is bound to it).
    setEstimate(null);
    setConfirmed(false);
    if (account) writeAssistDraft(account, ws, merged);
  };
  const include = () =>
    d.named
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((id) => ({
        type: TYPE_PREFIX[Object.keys(TYPE_PREFIX).find((k) => id.startsWith(k)) ?? 'tsk_']!,
        id,
      }));
  const retrieval = () => ({
    scope: {
      ...(d.brands.length ? { brands: d.brands } : {}),
      ...(d.project.trim() ? { project: d.project.trim() } : {}),
      ...(d.task.trim() ? { task: d.task.trim() } : {}),
    },
    include: include(),
  });
  const requestBody = (m: AiManifest) => ({
    action: d.action,
    ...retrieval(),
    ...(d.instruction.trim() ? { instruction: d.instruction.trim() } : {}),
    ...(def?.needs === 'brief_or_goal' && d.brief.trim() ? { brief: d.brief.trim() } : {}),
    ...(d.answers.length ? { answers: d.answers } : {}),
    manifest_digest: m.digest,
  });

  const doPreview = async (event?: FormEvent) => {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    setEstimate(null);
    setConfirmed(false);
    try {
      if (
        d.named
          .split(/[\s,]+/)
          .filter(Boolean)
          .some((id) => !ID_RE.test(id))
      )
        throw new Error('ids');
      const m = await aiClient.preview(ws, retrieval());
      setManifest(m);
      setSaid(`Context preview ready: ${m.counts.included} source(s).`);
    } catch (err) {
      setError(
        err instanceof Error && err.message === 'ids'
          ? 'Name records by their identifiers.'
          : aiProblem(err, 'The context could not be previewed.'),
      );
    } finally {
      setBusy(false);
    }
  };

  const doEstimate = async () => {
    if (!manifest) return;
    setBusy(true);
    setError(null);
    setEstimate(null);
    setConfirmed(false);
    try {
      const e = await aiClient.estimateAssist(ws, requestBody(manifest));
      setEstimate(e);
      runKey.current = newIdempotencyKey();
    } catch (err) {
      setError(aiProblem(err, 'The estimate could not be made.'));
    } finally {
      setBusy(false);
    }
  };

  const doRun = async () => {
    if (!manifest || !estimate) return;
    setBusy(true);
    setError(null);
    try {
      const run = await aiClient.startAssist(
        ws,
        { ...requestBody(manifest), input_digest: estimate.input_digest, confirm_cost: confirmed },
        runKey.current ?? newIdempotencyKey(),
      );
      setCurrent(run);
      setEstimate(null);
      setSaid(`${def?.label ?? 'Action'} started.`);
    } catch (err) {
      setError(aiProblem(err, 'The action was not started.'));
    } finally {
      setBusy(false);
    }
  };

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
          if (TERMINAL.has(r.state)) setSaid(`${def?.label ?? 'Action'} finished: ${r.status}.`);
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [current, ws, def?.label]);

  const analysis = current?.content?.analysis ?? null;
  const proposal = current?.content?.proposal ?? null;
  const questions = analysis?.questions?.length ? analysis.questions : (proposal?.questions ?? []);
  const needsInput = analysis?.status === 'needs_input' || proposal?.status === 'needs_input';

  const answer = () => {
    const extra = questions
      .filter((q) => answers[q.id]?.trim())
      .map((q) => ({ question: q.text, answer: answers[q.id]!.trim() }));
    // Answers are a new input revision: a fresh preview and estimate are needed before running.
    change({ answers: [...d.answers, ...extra].slice(-5) });
    setCurrent(null);
    setAnswers({});
    setSaid('Answers added. Estimate again to run the action with them.');
  };

  return (
    <Page
      title="AI assist"
      lead="Summaries, extraction, analysis, and drafts from sources you can read. Results are labelled; drafts of records are proposals you review and apply yourself."
    >
      <p>
        <Link to={`/workspaces/${ws}/ai/ask`}>Ask with sources</Link> ·{' '}
        <Link to={`/workspaces/${ws}/ai/proposals`}>Change proposals</Link>
      </p>
      {error ? (
        <Banner tone="danger" title="Something went wrong">
          {error}
        </Banner>
      ) : null}
      {!actions && !error ? <p role="status">Loading actions…</p> : null}
      {actions ? (
        <section
          aria-labelledby="assist-action-heading"
          className="ai-panel"
          aria-busy={busy ? 'true' : 'false'}
        >
          <h2 id="assist-action-heading">1. Choose the action and context</h2>
          <form onSubmit={(e) => void doPreview(e)} className="portability-controls">
            <SelectField
              id="assist-action"
              label="Action"
              value={d.action}
              onChange={(v) => change({ action: v, answers: [] })}
              options={actions.map((a) => ({ value: a.id, label: a.label }))}
            />
            {def ? (
              <p className="hint">
                {def.kind === 'proposal'
                  ? 'Creates a proposal you review, edit, approve, and apply; nothing changes before that.'
                  : 'Read-only: nothing changes.'}{' '}
                {def.limitations.join(' ')}
              </p>
            ) : null}
            {def?.needs === 'brief_or_goal' ? (
              <TextAreaField
                id="assist-brief"
                label="Project brief"
                hint="What the project should achieve. Or include a goal below."
                value={d.brief}
                onChange={(v) => change({ brief: v })}
                maxLength={4000}
              />
            ) : null}
            <TextAreaField
              id="assist-instruction"
              label={def?.input.label ?? 'Instruction'}
              value={d.instruction}
              onChange={(v) => change({ instruction: v })}
              maxLength={def?.input.max ?? 2000}
            />
            <fieldset>
              <legend>Brands (none chosen means the whole workspace)</legend>
              {brands.map((b) => (
                <label key={b.id} className="ai-confirm">
                  <input
                    type="checkbox"
                    checked={d.brands.includes(b.id)}
                    onChange={(e) =>
                      change({
                        brands: e.target.checked
                          ? [...d.brands, b.id]
                          : d.brands.filter((x) => x !== b.id),
                      })
                    }
                  />{' '}
                  {b.name}
                </label>
              ))}
            </fieldset>
            <Field
              id="assist-project"
              label="Project (optional)"
              hint="A project identifier (prj_…)."
              value={d.project}
              onChange={(e) => change({ project: e.target.value })}
            />
            <Field
              id="assist-task"
              label="Task (optional)"
              hint="A task identifier (tsk_…)."
              value={d.task}
              onChange={(e) => change({ task: e.target.value })}
            />
            <TextAreaField
              id="assist-named"
              label="Also include (optional)"
              hint="Identifiers of tasks, projects, documents, comments, goals, or your own calendar events (cev_…)."
              value={d.named}
              onChange={(v) => change({ named: v })}
            />
            {d.answers.length ? (
              <div>
                <p>Your answers (part of the next request):</p>
                <ul>
                  {d.answers.map((a, n) => (
                    <li key={n}>
                      {a.question}: {a.answer}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <SubmitButton busy={busy}>Preview context</SubmitButton>
          </form>
        </section>
      ) : null}
      {manifest ? (
        <section aria-labelledby="assist-context-heading" className="ai-panel" role="region">
          <h2 id="assist-context-heading">2. Review the context</h2>
          <p>
            {manifest.counts.included} of {manifest.counts.listed} listed source(s) will be sent.
          </p>
          {manifest.notice ? <p className="hint">{manifest.notice}</p> : null}
          <ul aria-label="Context sources" className="ai-sources">
            {manifest.sources.map((s) => (
              <li key={`${s.type}:${s.id}`}>
                {s.handle ? `${s.handle} · ` : ''}
                {s.type}: {s.title}
                {s.exclusion_reason ? (
                  <span className="hint">
                    {' '}
                    — not used ({s.exclusion_reason.replace(/_/g, ' ')})
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {manifest.ai && !manifest.ai.can_answer ? (
            <Banner tone="info" title="AI is not available">
              {manifest.ai.reason} You can still review these sources and work without AI.
            </Banner>
          ) : (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => void doEstimate()}
            >
              Estimate cost
            </button>
          )}
          {estimate ? (
            <div role="region" aria-label="Estimate">
              <p>
                This could cost up to {estimate.max_cost.display}
                {estimate.synthetic ? ' (synthetic price; no provider is called)' : ''}.
              </p>
              {estimate.confirm_required ? (
                <label className="ai-confirm">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />{' '}
                  I confirm this may cost up to {estimate.max_cost.display}
                </label>
              ) : null}
              <button
                type="button"
                className="button button-primary"
                disabled={busy || (estimate.confirm_required && !confirmed)}
                onClick={() => void doRun()}
              >
                Run {def?.label ?? 'action'}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
      {current ? (
        <section aria-labelledby="assist-result-heading" className="ai-panel" aria-live="polite">
          <h2 id="assist-result-heading">Result</h2>
          <p>
            <strong>{current.status}</strong>
            {current.synthetic ? <span className="ai-tag"> Synthetic fixture</span> : null}
          </p>
          {current.refusal ? <p role="status">{current.refusal.message}</p> : null}
          {current.content?.note ? <p>{current.content.note}</p> : null}
          {analysis ? <AnalysisView ws={ws} a={analysis} /> : null}
          {proposal?.id ? (
            <p>
              <Link to={`/workspaces/${ws}/ai/proposals/${proposal.id}`}>
                Review the proposed changes
              </Link>{' '}
              <span className="hint">— nothing changes until you apply them.</span>
            </p>
          ) : proposal && proposal.status !== 'needs_input' ? (
            <Banner tone="warning" title="No proposal could be made">
              The suggested changes did not pass the proposal checks, so nothing is offered.
            </Banner>
          ) : null}
          {needsInput && questions.length ? (
            <form
              aria-label="Answer the questions"
              onSubmit={(e) => {
                e.preventDefault();
                answer();
              }}
            >
              {questions.map((q) => (
                <Field
                  key={q.id}
                  id={`assist-answer-${q.id}`}
                  label={q.text}
                  value={answers[q.id] ?? ''}
                  maxLength={500}
                  onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                />
              ))}
              <SubmitButton busy={busy}>Add answers</SubmitButton>
            </form>
          ) : null}
          {current.can_cancel ? (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => void aiClient.cancel(ws, current.id).then(setCurrent)}
            >
              Cancel
            </button>
          ) : null}
        </section>
      ) : null}
      <Announce>{said}</Announce>
    </Page>
  );
}
