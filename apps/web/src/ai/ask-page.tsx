import { useEffect, useRef, useState, type FormEvent } from 'react';
import { newIdempotencyKey } from '../api.ts';
import { Link } from '../router.tsx';
import { useWorkspaceShell } from '../shell/workspace.tsx';
import { Announce, Banner } from '../ui/feedback.tsx';
import { Field, SubmitButton, TextAreaField } from '../ui/form.tsx';
import { Page } from '../ui/layout.tsx';
import {
  aiClient,
  aiProblem,
  TERMINAL,
  type AiAnswer,
  type AiCitedSource,
  type AiEstimate,
  type AiManifest,
  type AiManifestSource,
  type AiRun,
} from './client.ts';

/**
 * Phase 7B: ask a read-only question grounded in sources you can read (ADR-0039). The context is
 * previewed first (scope, every source, warnings, bounds, index freshness) and works with AI off;
 * the answer separates facts from the records, calculations, exact excerpts, unverified generated
 * statements, suggestions, and unknowns, and every citation opens the record through your current
 * access. Only record facts and calculations are established; citations are provenance.
 */

const POLL_MS = 1000;
const ID_RE = /^(tsk|prj|doc|cmt)_[0-9A-HJKMNP-TV-Z]{26}$/;

const FLAG_TEXT: Record<string, string> = {
  stale: 'Review overdue (stale)',
  draft: 'Draft',
  unapproved: 'Not approved as an AI source',
  approved_version_differs: 'Changed since it was approved',
  archived: 'Archived',
  truncated: 'Shortened to fit the limit',
};
const EXCLUSION_TEXT: Record<string, string> = {
  field_not_ai_eligible: 'Its fields are not allowed for AI',
  data_class: 'Above the data class this workspace allows for AI',
  sensitive_brand: 'In a restricted brand (never used by AI)',
  out_of_scope: 'Outside the chosen scope',
  user_excluded: 'Excluded by you',
  needs_explicit_choice: 'Not used unless you include it',
  brand_only_policy: "Outside the brand (the brand's AI sources are limited to itself)",
  over_limit: 'Over the source limit',
};
const TYPE_TEXT: Record<string, string> = {
  task: 'Task',
  project: 'Project',
  document: 'Document',
  comment: 'Comment',
  activity: 'Task activity',
};
const ISSUE_TEXT: Record<string, string> = {
  no_valid_citation: 'no valid source was cited',
  citation_invalid: 'a cited source was not in the context',
  quote_mismatch: 'a quotation did not match its source',
  unsupported_figure: 'a figure is not in the cited sources',
  contradicts_record: "it contradicts the record's current status",
  untrusted_link: 'it contains a link, which is shown as text and never opened',
  untrusted_reference: 'it names a record that was not cited',
};

const hrefOf = (ws: string, l: AiCitedSource['link'] | AiManifestSource['link']) =>
  l.type === 'task'
    ? `/workspaces/${ws}/tasks/${l.id}`
    : l.type === 'project'
      ? `/workspaces/${ws}/projects/${l.id}`
      : `/workspaces/${ws}/documents/${l.id}`;

function Citation({ ws, c }: { ws: string; c: AiCitedSource | null }) {
  if (!c) return <span className="hint">(source no longer listed)</span>;
  return (
    <span>
      <Link to={hrefOf(ws, c.link)}>
        {c.handle}: {c.title}
      </Link>
      {c.changed ? <span className="hint"> (changed since this answer)</span> : null}
    </span>
  );
}

function AnswerView({ ws, answer }: { ws: string; answer: AiAnswer }) {
  const by = (k: string) => answer.statements.filter((s) => s.kind === k);
  const list = (k: string, heading: string) =>
    by(k).length ? (
      <section aria-label={heading}>
        <h3>{heading}</h3>
        <ul>
          {by(k).map((s, i) => (
            <li key={i}>
              {k === 'excerpt' ? (
                // An excerpt shows the source's own matched text, never the model's wording.
                <span>
                  “{s.citations[0]?.excerpt ?? s.text}” —{' '}
                  <Citation ws={ws} c={s.citations[0]?.source ?? null} />
                </span>
              ) : (
                <>
                  {/* Generated text is rendered as text only: no HTML, links, or lookups. */}
                  <span>{s.text}</span>
                  {s.citations.length ? (
                    <span className="hint">
                      {' '}
                      — cites{' '}
                      {s.citations.map((c, j) => (
                        <span key={j}>
                          <Citation ws={ws} c={c.source} />
                          {c.excerpt ? ` (quoting the source: “${c.excerpt}”)` : ''}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </>
              )}
              {s.issues.length ? (
                <p className="hint">
                  {k === 'unverified' ? 'Also: ' : 'Note: '}
                  {s.issues.map((x) => ISSUE_TEXT[x] ?? x).join('; ')}.
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    ) : null;
  const incomplete = answer.reason === 'truncated_response' || answer.reason === 'partial_response';
  return (
    <div className="ai-answer">
      {answer.note ? (
        <Banner
          tone={answer.status === 'downgraded' ? 'warning' : 'danger'}
          title={
            incomplete
              ? 'The answer is incomplete'
              : answer.status === 'rejected'
                ? 'The answer could not be checked'
                : answer.status === 'withheld'
                  ? 'The answer was withheld'
                  : 'Some citations were removed'
          }
        >
          {answer.note}
        </Banner>
      ) : null}
      <p className="hint">{answer.trust_note}</p>
      {answer.facts.length ? (
        <section aria-label="Facts from the records">
          <h3>Facts from the records</h3>
          <ul>
            {answer.facts.map((f, i) => (
              <li key={i}>
                {f.label}: {f.value} — <Citation ws={ws} c={f.source} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {answer.calculations.length ? (
        <section aria-label="Calculations">
          <h3>Calculations</h3>
          <ul>
            {answer.calculations.map((c) => (
              <li key={c.key}>
                {c.label}: {c.value} <span className="hint">({c.basis})</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {list('excerpt', 'Exact excerpts from the sources')}
      {list('unverified', 'Unverified statements (generated)')}
      {list('suggestion', 'Suggestions (generated)')}
      {list('unknown', 'Unknown')}
      {answer.dropped_citations ? (
        <p className="hint">
          {answer.dropped_citations} citation(s) that did not match the context were removed.
        </p>
      ) : null}
      <p className="hint">{answer.provenance_note}</p>
    </div>
  );
}

export function AskPage({ ws }: { ws: string }) {
  const shell = useWorkspaceShell();
  const brands = (shell?.context?.brands ?? []).filter((b) => !b.is_sensitive);
  const [chosenBrands, setChosenBrands] = useState<string[]>([]);
  const [project, setProject] = useState('');
  const [task, setTask] = useState('');
  const [query, setQuery] = useState('');
  const [named, setNamed] = useState('');
  const [include, setInclude] = useState<Array<{ type: string; id: string }>>([]);
  const [exclude, setExclude] = useState<Array<{ type: string; id: string }>>([]);
  const [manifest, setManifest] = useState<AiManifest | null>(null);
  /** The person's latest choice per source, shown at once while the preview refreshes. */
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [question, setQuestion] = useState('');
  const [estimate, setEstimate] = useState<(AiEstimate & { manifest: AiManifest }) | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [current, setCurrent] = useState<AiRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const askKey = useRef<string | null>(null);

  const typed = () =>
    named
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((id) => ({
        type: id.startsWith('tsk_')
          ? 'task'
          : id.startsWith('prj_')
            ? 'project'
            : id.startsWith('doc_')
              ? 'document'
              : 'comment',
        id,
      }));
  const retrieval = (inc = include, exc = exclude) => {
    const same = (r: { type: string; id: string }) => (x: { type: string; id: string }) =>
      x.id === r.id && x.type === r.type;
    // A typed identifier the person has since excluded is not also sent as an include.
    const extra = typed().filter((r) => !inc.some(same(r)) && !exc.some(same(r)));
    return {
      scope: {
        ...(chosenBrands.length ? { brands: chosenBrands } : {}),
        ...(project.trim() ? { project: project.trim() } : {}),
        ...(task.trim() ? { task: task.trim() } : {}),
      },
      ...(query.trim() ? { query: query.trim() } : {}),
      include: [...inc, ...extra],
      exclude: exc,
    };
  };

  const doPreview = async (inc = include, exc = exclude) => {
    setBusy(true);
    setError(null);
    setEstimate(null);
    setConfirmed(false);
    try {
      if (
        named
          .split(/[\s,]+/)
          .filter(Boolean)
          .some((id) => !ID_RE.test(id))
      )
        throw new Error('ids');
      const m = await aiClient.preview(ws, retrieval(inc, exc));
      setManifest(m);
      setChosen({});
      setSaid(`Context preview ready: ${m.counts.included} source(s) will be sent.`);
    } catch (err) {
      setError(
        err instanceof Error && err.message === 'ids'
          ? 'Name tasks, projects, documents, or comments by their identifiers.'
          : aiProblem(err, 'The context could not be previewed.'),
      );
    } finally {
      setBusy(false);
    }
  };

  const toggle = (s: AiManifestSource) => {
    const ref = { type: s.type, id: s.id };
    const same = (r: { type: string; id: string }) => r.type === s.type && r.id === s.id;
    let inc = include.filter((r) => !same(r));
    let exc = exclude.filter((r) => !same(r));
    if (s.included) exc = [...exc, ref];
    else inc = [...inc, ref];
    setChosen((c) => ({ ...c, [`${s.type}:${s.id}`]: !s.included }));
    setInclude(inc);
    setExclude(exc);
    void doPreview(inc, exc);
  };

  const doEstimate = async (event: FormEvent) => {
    event.preventDefault();
    if (!manifest) return;
    setBusy(true);
    setError(null);
    // Every estimate needs its own confirmation; an earlier one never carries over.
    setEstimate(null);
    setConfirmed(false);
    try {
      const e = await aiClient.estimateAnswer(ws, {
        ...retrieval(),
        question,
        manifest_digest: manifest.digest,
      });
      setEstimate(e);
      askKey.current = newIdempotencyKey();
    } catch (err) {
      setError(aiProblem(err, 'The estimate could not be made.'));
    } finally {
      setBusy(false);
    }
  };

  const doAsk = async () => {
    if (!manifest || !estimate) return;
    setBusy(true);
    setError(null);
    try {
      const run = await aiClient.ask(
        ws,
        { ...retrieval(), question, manifest_digest: manifest.digest, confirm_cost: confirmed },
        askKey.current ?? newIdempotencyKey(),
      );
      setCurrent(run);
      setEstimate(null);
      setSaid('Question queued.');
    } catch (err) {
      setError(aiProblem(err, 'The question was not sent.'));
    } finally {
      setBusy(false);
    }
  };

  /** 7D: the same previewed manifest, but the run proposes changes for review (nothing applies). */
  const doPropose = async () => {
    if (!manifest || !estimate) return;
    setBusy(true);
    setError(null);
    try {
      const run = await aiClient.propose(
        ws,
        { ...retrieval(), question, manifest_digest: manifest.digest, confirm_cost: confirmed },
        askKey.current ?? newIdempotencyKey(),
      );
      setCurrent(run);
      setEstimate(null);
      setSaid('Proposal requested. Nothing changes until you review and apply it.');
    } catch (err) {
      setError(aiProblem(err, 'The proposal was not requested.'));
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
          if (TERMINAL.has(r.state)) setSaid(`Answer finished: ${r.status}.`);
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [current, ws]);

  const answer = current?.content?.answer ?? null;
  return (
    <Page
      title="Ask with sources"
      lead="Answers use only sources you can read now. Review them before anything is sent; nothing here changes a record."
    >
      <p>
        <Link to={`/workspaces/${ws}/ai`}>AI test runs and history</Link> ·{' '}
        <Link to={`/workspaces/${ws}/ai/proposals`}>Change proposals</Link>
      </p>
      {error ? (
        <Banner tone="danger" title="Something went wrong">
          {error}
        </Banner>
      ) : null}
      <section
        aria-labelledby="ask-scope-heading"
        className="ai-panel"
        aria-busy={busy ? 'true' : 'false'}
      >
        <h2 id="ask-scope-heading">1. Choose the scope</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setInclude([]);
            setExclude([]);
            void doPreview([], []);
          }}
          className="portability-controls"
        >
          <fieldset>
            <legend>Brands (none chosen means the whole workspace)</legend>
            {brands.map((b) => (
              <label key={b.id} className="ai-confirm">
                <input
                  type="checkbox"
                  checked={chosenBrands.includes(b.id)}
                  onChange={(e) =>
                    setChosenBrands(
                      e.target.checked
                        ? [...chosenBrands, b.id]
                        : chosenBrands.filter((x) => x !== b.id),
                    )
                  }
                />{' '}
                {b.name}
              </label>
            ))}
          </fieldset>
          <Field
            id="ask-project"
            label="Project (optional)"
            hint="A project identifier (prj_…)."
            value={project}
            onChange={(e) => setProject(e.target.value)}
          />
          <Field
            id="ask-task"
            label="Task (optional)"
            hint="A task identifier (tsk_…)."
            value={task}
            onChange={(e) => setTask(e.target.value)}
          />
          <Field
            id="ask-query"
            label="Find sources by words"
            hint="Matches words in records you can read. Semantic (meaning-based) search is not available."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <TextAreaField
            id="ask-named"
            label="Also include (optional)"
            hint="Identifiers of tasks, projects, documents, or comments, separated by spaces."
            value={named}
            onChange={setNamed}
          />
          <SubmitButton busy={busy}>Preview context</SubmitButton>
        </form>
      </section>
      {manifest ? (
        <section aria-labelledby="ask-context-heading" className="ai-panel" role="region">
          <h2 id="ask-context-heading">2. Review the context</h2>
          <p>
            Scope:{' '}
            {manifest.scope.task
              ? `task ${manifest.scope.task.title}`
              : manifest.scope.project
                ? `project ${manifest.scope.project.title}`
                : manifest.scope.brands.length
                  ? `brands ${manifest.scope.brands.map((b) => b.name).join(', ')}`
                  : 'the whole workspace'}
            . {manifest.counts.included} of {manifest.counts.listed} listed source(s) will be sent
            (up to {manifest.limits.sources_max}, {manifest.limits.source_chars} characters each)
            {manifest.counts.omitted ? `; ${manifest.counts.omitted} more not listed` : ''}.
          </p>
          {manifest.notice ? <p className="hint">{manifest.notice}</p> : null}
          {manifest.warnings.length ? (
            <Banner tone="warning" title="Some included sources need care">
              {manifest.warnings
                .map((w) => `${w.handle}: ${w.flags.map((f) => FLAG_TEXT[f] ?? f).join(', ')}`)
                .join('; ')}
              . Prefer current, approved sources.
            </Banner>
          ) : null}
          {manifest.ai && !manifest.ai.can_answer ? (
            <Banner tone="info" title="AI is not available">
              {manifest.ai.reason} You can still review these sources and work without AI.
            </Banner>
          ) : null}
          {manifest.sources.length ? (
            <ul aria-label="Context sources" className="ai-sources">
              {manifest.sources.map((s) => (
                <li key={`${s.type}:${s.id}`}>
                  <label className="ai-confirm">
                    <input
                      type="checkbox"
                      checked={chosen[`${s.type}:${s.id}`] ?? s.included}
                      disabled={
                        busy ||
                        (!s.included &&
                          !['user_excluded', 'needs_explicit_choice', 'over_limit'].includes(
                            s.exclusion_reason ?? '',
                          ))
                      }
                      onChange={() => toggle(s)}
                    />{' '}
                    {s.handle ? `${s.handle} · ` : ''}
                    {TYPE_TEXT[s.type]}: {s.title}
                  </label>{' '}
                  <Link to={hrefOf(ws, s.link)}>Open</Link>
                  {s.flags.length ? (
                    <span className="hint">
                      {' '}
                      — {s.flags.map((f) => FLAG_TEXT[f] ?? f).join(', ')}
                    </span>
                  ) : null}
                  {s.exclusion_reason ? (
                    <span className="hint">
                      {' '}
                      — {EXCLUSION_TEXT[s.exclusion_reason] ?? s.exclusion_reason}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p>No sources match this scope. Search with other words or name records to include.</p>
          )}
        </section>
      ) : null}
      {manifest && manifest.counts.included > 0 && manifest.ai?.can_answer !== false ? (
        <section aria-labelledby="ask-question-heading" className="ai-panel">
          <h2 id="ask-question-heading">3. Ask</h2>
          <form onSubmit={doEstimate} className="portability-controls">
            <TextAreaField
              id="ask-question"
              label="Question"
              value={question}
              onChange={setQuestion}
              maxLength={8000}
            />
            <SubmitButton busy={busy}>Estimate cost</SubmitButton>
          </form>
          {estimate ? (
            <div role="region" aria-label="Estimate">
              <p>
                This answer could cost up to {estimate.max_cost.display}
                {estimate.synthetic ? ' (synthetic price; no provider is called)' : ''}.
              </p>
              {estimate.confirm_required ? (
                <label className="ai-confirm">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />{' '}
                  I confirm this answer may cost up to {estimate.max_cost.display}
                </label>
              ) : null}
              <button
                type="button"
                className="button button-primary"
                disabled={busy || (estimate.confirm_required && !confirmed)}
                onClick={() => void doAsk()}
              >
                Ask
              </button>{' '}
              {estimate.synthetic ? (
                // 7D generates proposals only with the labelled synthetic fixture.
                <button
                  type="button"
                  className="button"
                  disabled={busy || (estimate.confirm_required && !confirmed)}
                  onClick={() => void doPropose()}
                >
                  Propose changes (synthetic fixture)
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
      {current ? (
        <section aria-labelledby="ask-answer-heading" className="ai-panel" aria-live="polite">
          <h2 id="ask-answer-heading">Answer</h2>
          <p>
            <strong>{current.status}</strong>
            {current.synthetic ? <span className="ai-tag"> Synthetic</span> : null}
          </p>
          {current.refusal ? <p role="status">{current.refusal.message}</p> : null}
          {current.content?.note ? <p>{current.content.note}</p> : null}
          {answer ? <AnswerView ws={ws} answer={answer} /> : null}
          {current.content?.proposal ? (
            current.content.proposal.id ? (
              <p>
                <Link to={`/workspaces/${ws}/ai/proposals/${current.content.proposal.id}`}>
                  Review the proposed changes
                </Link>{' '}
                <span className="hint">— nothing changes until you apply them.</span>
              </p>
            ) : (
              <Banner tone="warning" title="No proposal could be made">
                {current.content.proposal.status === 'withheld'
                  ? 'A source changed or became unavailable before the proposal was ready.'
                  : 'The suggested changes did not pass the proposal checks, so nothing is offered.'}
                {current.content.proposal.issues.length ? (
                  <ul>
                    {current.content.proposal.issues.slice(0, 5).map((i, n) => (
                      <li key={n}>{i.message}</li>
                    ))}
                  </ul>
                ) : null}
              </Banner>
            )
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
