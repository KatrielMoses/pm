import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, newIdempotencyKey } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { Link } from '../router.tsx';
import { Announce, Banner } from '../ui/feedback.tsx';
import { Page } from '../ui/layout.tsx';
import {
  aiClient,
  aiProblem,
  type AiProposal,
  type AiProposalChange,
  type AiProposalRef,
} from './client.ts';
import { readProposalDraft, writeProposalDraft, type ProposalDraft } from './proposal-drafts.ts';

/**
 * Phase 7D: review, edit, select, approve, and explicitly apply an AI change proposal (ADR-0040;
 * AI-023–AI-025, AI-029; UXD-15). Nothing changes until the person presses Apply; Apply is atomic
 * (all selected changes or none). Unsaved edits are kept on this device per proposal, so a
 * refresh, a conflict, or going offline never silently discards them.
 */

const OP_TEXT: Record<AiProposalChange['op'], string> = {
  'task.create': 'Create task',
  'task.update': 'Update task',
  'project.create': 'Create project',
  'project.update': 'Update project',
  'milestone.create': 'Create milestone',
  'relation.add': 'Add relationship',
  'document.replace': 'Replace document text (new version)',
  'task.assign': 'Assign task',
  'label.add': 'Add label',
  'criterion.add': 'Add acceptance criterion',
  'block.create': 'Schedule a work block',
  'block.update': 'Move a work block',
  'block.delete': 'Remove a work block (postpone)',
  'commitment.add': 'Add to Today',
  'commitment.remove': 'Remove from Today (postpone)',
};
const FIELD_TEXT: Record<string, string> = {
  title: 'Title',
  name: 'Name',
  description: 'Description',
  priority: 'Priority',
  start_date: 'Start date',
  due_date: 'Due date',
  target_date: 'Target date',
  status: 'Status',
  text: 'Text',
  starts_at: 'Starts',
  ends_at: 'Ends',
  day: 'Day',
};
const INSTANTS = new Set(['starts_at', 'ends_at']);
/** An ISO instant as a `datetime-local` value in this browser's time zone, and back. */
const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);
const shownInstant = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const ISSUE_TEXT: Record<string, string> = {
  overlaps_block: 'overlaps one of your blocks',
  overlaps_meeting: 'overlaps a meeting',
  overlaps_plan: 'overlaps another block in this plan',
  outside_working_hours: 'is outside your working hours',
  after_deadline: 'ends after the task deadline',
};
const STATE_TEXT: Record<AiProposal['state'], string> = {
  open: 'Open for review',
  approved: 'Approved, not applied',
  applied: 'Applied',
  failed: 'Apply failed (nothing changed)',
  rejected: 'Rejected',
};
const OUTCOME_TEXT: Record<AiProposalChange['applied_state'], string> = {
  not_applied: '',
  applied: 'Applied',
  failed: 'Failed',
  rolled_back: 'Rolled back (not kept)',
  blocked: 'Not attempted',
};
const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];
const LONG = new Set(['description', 'text']);
const DATES = new Set(['start_date', 'due_date', 'target_date']);

type Draft = ProposalDraft;

/** The signed-in account; null while it is unknown (drafts are then neither read nor written). */
function useDraftAccount(): string | null {
  try {
    const me = useAuth().me;
    return me ? me.id : null;
  } catch {
    // Rendered outside the auth provider (component tests): one device-local key.
    return 'device';
  }
}
/** A response from the server that ends this person's authority over the proposal content. */
const AUTHORITY_ENDED = new Set([
  'not_found',
  'forbidden',
  'unauthenticated',
  'proposal_sources_unavailable',
  'proposal_erased',
]);
/** A result that may not have reached the server: the same attempt is retried with its key. */
const ambiguous = (err: unknown) =>
  !(err instanceof ApiError) ||
  err.offline ||
  err.code === 'network' ||
  err.status === 0 ||
  err.status >= 500;
const emptyDraft = (revision: number): Draft => ({
  revision,
  fields: {},
  selected: null,
  decisions: {},
});
const dirty = (d: Draft | null) =>
  !!d &&
  (Object.keys(d.fields).length > 0 || d.selected !== null || Object.keys(d.decisions).length > 0);

function RefText({ ws, r }: { ws: string; r: AiProposalRef | null }) {
  if (!r) return null;
  if (r.new) return <span>the new record from change {r.change ?? '?'}</span>;
  if (r.available === false) return <span className="hint">a record you can no longer see</span>;
  const href =
    r.type === 'task'
      ? `/workspaces/${ws}/tasks/${r.id}`
      : r.type === 'project'
        ? `/workspaces/${ws}/projects/${r.id}`
        : `/workspaces/${ws}/documents/${r.id}`;
  return <Link to={href}>{r.title}</Link>;
}

function ResultText({ ws, r }: { ws: string; r: AiProposalChange['result'] }) {
  if (!r) return null;
  if (r.available === false) return <span className="hint"> (no longer visible to you)</span>;
  if (!r.title || !r.type || r.type === 'milestone' || r.type === 'record') return null;
  return (
    <>
      {' — '}
      <RefText ws={ws} r={r} />
    </>
  );
}

export function ProposalsPage({ ws }: { ws: string }) {
  const [items, setItems] = useState<Awaited<ReturnType<typeof aiClient.proposals>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    aiClient
      .proposals(ws)
      .then(setItems)
      .catch((err) => setError(aiProblem(err, 'Proposals could not be loaded.')));
  }, [ws]);
  return (
    <Page
      title="Change proposals"
      lead="AI-generated suggestions you review, edit, and apply yourself. Nothing changes until you apply a proposal."
    >
      <p>
        <Link to={`/workspaces/${ws}/ai/ask`}>Ask with sources or propose changes</Link>
      </p>
      {error ? (
        <Banner tone="danger" title="Something went wrong">
          {error}
        </Banner>
      ) : null}
      {!items && !error ? <p role="status">Loading proposals…</p> : null}
      {items && !items.length ? (
        <p>No proposals yet. Propose changes from a previewed context on the Ask page.</p>
      ) : null}
      {items?.length ? (
        <ul aria-label="Your change proposals" className="ai-sources">
          {items.map((p) => (
            <li key={p.id}>
              <Link to={`/workspaces/${ws}/ai/proposals/${p.id}`}>
                {p.content.state === 'present'
                  ? (p.title ?? 'Untitled proposal')
                  : p.content.state === 'erased'
                    ? 'Erased proposal'
                    : 'Withheld proposal'}
              </Link>{' '}
              <span className="hint">
                — {STATE_TEXT[p.state]} · {new Date(p.created_at).toLocaleString()}
                {p.synthetic ? ' · Synthetic' : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Page>
  );
}

function FieldEditor({
  change,
  field,
  value,
  disabled,
  onChange,
}: {
  change: AiProposalChange;
  field: string;
  value: string | null;
  disabled: boolean;
  onChange: (v: string | null) => void;
}) {
  const id = `prp-${change.key}-${field}`;
  const label = `${FIELD_TEXT[field] ?? field} (proposed)`;
  // 7F: block times are edited in this browser's time zone and sent as exact instants.
  if (INSTANTS.has(field))
    return (
      <label htmlFor={id}>
        <span className="visually-hidden">{label}, in your browser's time zone</span>
        <input
          id={id}
          type="datetime-local"
          step={300}
          value={toLocalInput(value)}
          disabled={disabled}
          onChange={(e) => onChange(fromLocalInput(e.target.value))}
        />
      </label>
    );
  // A planner commitment's day is the plan's day: shown, never edited here.
  if (field === 'day') return <span>{value ?? '—'}</span>;
  if (field === 'priority')
    return (
      <label htmlFor={id}>
        <span className="visually-hidden">{label}</span>
        <select
          id={id}
          value={value ?? 'none'}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
    );
  if (LONG.has(field))
    return (
      <label htmlFor={id}>
        <span className="visually-hidden">{label}</span>
        <textarea
          id={id}
          rows={field === 'text' ? 6 : 3}
          value={value ?? ''}
          disabled={disabled}
          maxLength={field === 'text' ? 20000 : 4000}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        />
      </label>
    );
  return (
    <label htmlFor={id}>
      <span className="visually-hidden">{label}</span>
      <input
        id={id}
        type={DATES.has(field) ? 'date' : 'text'}
        value={value ?? ''}
        disabled={disabled}
        maxLength={500}
        onChange={(e) =>
          onChange(e.target.value === '' && DATES.has(field) ? null : e.target.value)
        }
      />
    </label>
  );
}

export function ProposalPage({ ws, id }: { ws: string; id: string }) {
  const account = useDraftAccount();
  const [p, setP] = useState<AiProposal | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<Array<{ change: string | null; message: string }>>([]);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const [reason, setReason] = useState('');
  const [notFound, setNotFound] = useState(false);
  /**
   * One key per deliberate attempt. A key is kept only while its attempt's outcome is unknown (a
   * dropped connection or server error), so a retry resolves that same attempt; after a known
   * result the next click is a new attempt with a new key (corrective review 01 R2).
   */
  const pendingKeys = useRef<Record<string, string>>({});
  const keyFor = (action: string) => (pendingKeys.current[action] ??= newIdempotencyKey());
  const settle = (action: string, err?: unknown) => {
    if (err === undefined || !ambiguous(err)) delete pendingKeys.current[action];
  };
  /** Set synchronously, so a second click before the next render never sends a request. */
  const inFlight = useRef(false);
  /** Only the latest response may change what is shown (no stale async rehydration). */
  const latest = useRef(0);

  const forget = useCallback(() => {
    if (account) writeProposalDraft(account, ws, id, null);
    setDraft(null);
  }, [account, ws, id]);

  const show = useCallback(
    (v: AiProposal) => {
      // Keeps any error already shown (a refresh after a refusal explains what happened).
      setP(v);
      // Erased, withheld, applied, or rejected: nothing local is worth keeping.
      if (v.content.state !== 'present' || v.state === 'applied' || v.state === 'rejected') {
        if (account) writeProposalDraft(account, ws, id, null);
        setDraft(emptyDraft(v.revision));
        setConflict(false);
        return;
      }
      const saved = account ? readProposalDraft(account, ws, id) : null;
      if (saved && saved.revision !== v.revision && dirty(saved)) setConflict(true);
      setDraft(saved ?? emptyDraft(v.revision));
    },
    [account, ws, id],
  );
  const loadFailed = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && AUTHORITY_ENDED.has(err.code)) {
        forget();
        setP(null);
        setNotFound(true);
      } else setError(aiProblem(err, 'The proposal could not be loaded.'));
    },
    [forget],
  );
  const refresh = useCallback(() => {
    const n = ++latest.current;
    return aiClient.proposal(ws, id).then(
      (v) => {
        if (n === latest.current) show(v);
        return v;
      },
      (err) => {
        if (n === latest.current) loadFailed(err);
        return null;
      },
    );
  }, [ws, id, show, loadFailed]);
  useEffect(() => {
    // Wait for the account before reading any stored draft.
    if (account === null) return;
    let gone = false;
    const n = ++latest.current;
    aiClient.proposal(ws, id).then(
      (v) => {
        if (!gone && n === latest.current) show(v);
      },
      (err) => {
        if (!gone && n === latest.current) loadFailed(err);
      },
    );
    return () => {
      gone = true;
    };
  }, [account, ws, id, show, loadFailed]);

  const update = (d: Draft) => {
    setDraft(d);
    if (account) writeProposalDraft(account, ws, id, dirty(d) ? d : null);
  };

  const fail = (err: unknown, fallback: string) => {
    setError(aiProblem(err, fallback));
    if (err instanceof ApiError) {
      setProblem(
        err.issues
          .filter((i) => i.pointer && i.pointer.startsWith('/changes/'))
          .map((i) => ({ change: i.pointer!.split('/')[2] ?? null, message: i.message })),
      );
      if (err.issues.some((i) => i.code === 'revision_changed')) setConflict(true);
      const code = err.issues[0]?.code ?? err.code;
      if (AUTHORITY_ENDED.has(err.code) || AUTHORITY_ENDED.has(code)) {
        // The server ended this person's authority: drop local content, then show its answer.
        forget();
        void refresh();
      } else if (err.status === 409) void refresh(); // e.g. an expired approval: show the state.
    }
  };

  if (notFound)
    return (
      <Page title="Proposal not found">
        <p>This proposal does not exist or is not yours.</p>
        <p>
          <Link to={`/workspaces/${ws}/ai/proposals`}>All proposals</Link>
        </p>
      </Page>
    );
  if (!p || !draft)
    return (
      <Page title="Change proposal">
        {error ? (
          <Banner tone="danger" title="Something went wrong">
            {error}
          </Banner>
        ) : (
          <p role="status">Loading the proposal…</p>
        )}
      </Page>
    );

  if (p.content.state !== 'present')
    return (
      <Page title={p.content.state === 'erased' ? 'Erased proposal' : 'Withheld proposal'}>
        <Banner
          tone="info"
          title={p.content.state === 'erased' ? 'Content erased' : 'Content withheld'}
        >
          {p.content.note}
        </Banner>
        {p.application ? (
          <p>
            Applied by you on {new Date(p.application.at).toLocaleString()} ·{' '}
            {p.application.applied_count} change(s) · proposed by AI.
          </p>
        ) : null}
        <p>
          <Link to={`/workspaces/${ws}/ai/proposals`}>All proposals</Link>
        </p>
      </Page>
    );

  const isSelected = (c: AiProposalChange) =>
    draft.selected ? draft.selected.includes(c.key) : c.selected;
  const decisionOf = (c: AiProposalChange) => draft.decisions[c.key] ?? c.decision;
  const valueOf = (c: AiProposalChange, field: string, original: string | null) =>
    draft.fields[c.key] && field in draft.fields[c.key]! ? draft.fields[c.key]![field]! : original;
  const selected = p.changes.filter(isSelected);
  const pending = dirty(draft);
  const editable = p.can.edit && !busy;
  // Live dependency feedback for the current (unsaved) selection.
  const missing = selected.flatMap((c) =>
    c.depends_on.filter((d) => !selected.some((s) => s.key === d)).map((d) => ({ c: c.key, d })),
  );

  const toggle = (c: AiProposalChange) => {
    const base = draft.selected ?? p.changes.filter((x) => x.selected).map((x) => x.key);
    const next = base.includes(c.key) ? base.filter((k) => k !== c.key) : [...base, c.key];
    update({ ...draft, selected: next });
  };
  const setField = (c: AiProposalChange, field: string, v: string | null) =>
    update({
      ...draft,
      fields: { ...draft.fields, [c.key]: { ...draft.fields[c.key], [field]: v } },
    });
  const reject = (c: AiProposalChange) => {
    const base = draft.selected ?? p.changes.filter((x) => x.selected).map((x) => x.key);
    update({
      ...draft,
      decisions: { ...draft.decisions, [c.key]: 'rejected' },
      selected: base.filter((k) => k !== c.key),
    });
  };

  const save = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setProblem([]);
    try {
      const changes: Record<string, Record<string, unknown>> = {};
      for (const [k, f] of Object.entries(draft.fields)) changes[k] = { ...changes[k], fields: f };
      for (const [k, d] of Object.entries(draft.decisions))
        changes[k] = { ...changes[k], decision: d };
      const v = await aiClient.editProposal(
        ws,
        id,
        {
          revision: p.revision,
          ...(draft.selected ? { selected: draft.selected } : {}),
          ...(Object.keys(changes).length ? { changes } : {}),
        },
        keyFor('edit'),
      );
      settle('edit');
      latest.current++;
      setP(v);
      update(emptyDraft(v.revision));
      setConflict(false);
      setSaid(`Saved as revision ${v.revision}. Approve it again before applying.`);
    } catch (err) {
      settle('edit', err);
      fail(err, 'Your edits were not saved. They are kept on this device.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const decide = async (verb: 'approve' | 'apply' | 'reject') => {
    if (inFlight.current) return; // A repeated click never sends a second request.
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setProblem([]);
    try {
      const v = await aiClient.decideProposal(
        ws,
        id,
        verb,
        verb === 'reject'
          ? reason.trim()
            ? { reason: reason.trim() }
            : {}
          : { revision: p.revision, fingerprint: p.fingerprint },
        keyFor(verb),
      );
      settle(verb);
      latest.current++;
      show(v);
      setSaid(
        verb === 'approve'
          ? `Approved ${v.approval?.selected.length ?? 0} change(s). Apply when ready.`
          : verb === 'reject'
            ? 'Proposal rejected. Nothing was changed.'
            : v.application?.outcome === 'applied'
              ? `Applied ${v.application.applied_count} of ${p.changes.length} change(s).`
              : 'Nothing was applied: one change failed and every change was rolled back.',
      );
    } catch (err) {
      settle(verb, err);
      if (err instanceof ApiError && err.offline)
        // Nothing left the device; the same attempt (and key) is sent when back online.
        setError(aiProblem(err, 'You are offline.'));
      else if (ambiguous(err))
        setError(
          verb === 'apply'
            ? 'Apply did not complete because the connection dropped. Try again when you are online: it is safe and never applies twice.'
            : 'That did not complete because the connection dropped. Try again: the same request is resent, never repeated.',
        );
      else fail(err, 'That did not complete.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  /** Explicitly accept the current versions of the changed records shown here (rebase). */
  const rebase = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setProblem([]);
    const reviewed = Object.fromEntries(
      p.changes
        .filter((c) => c.target?.out_of_date && typeof c.target.version === 'number')
        .map((c) => [c.key, c.target!.version!]),
    );
    try {
      const v = await aiClient.decideProposal(
        ws,
        id,
        'rebase',
        {
          revision: p.revision,
          reviewed,
          // 7F: the day snapshot the person reviewed on this page (a changed plan's new basis).
          ...(p.plan?.current.state === 'changed' && p.plan.current.snapshot
            ? { snapshot: p.plan.current.snapshot }
            : {}),
        },
        keyFor('rebase'),
      );
      settle('rebase');
      latest.current++;
      setP(v);
      // The person reviewed the new base on this page: keep their unsaved edits on it.
      if (draft) update({ ...draft, revision: v.revision });
      setConflict(false);
      setSaid(`Using the current versions as revision ${v.revision}. Approve it before applying.`);
    } catch (err) {
      settle('rebase', err);
      fail(err, 'The current versions could not be used.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const app = p.application;
  const planner = p.origin === 'planner';
  const plan = p.plan ?? null;
  const issuesOf = (key: string) => plan?.current.issues.filter((i) => i.block === key) ?? [];
  return (
    <Page title={p.title ?? 'Change proposal'} lead={p.trust_note}>
      <p>
        <Link to={`/workspaces/${ws}/ai/proposals`}>All proposals</Link> ·{' '}
        <strong>{STATE_TEXT[p.state]}</strong> · revision {p.revision}
        {p.synthetic ? <span className="ai-tag"> Synthetic fixture</span> : null}
      </p>
      {error ? (
        <Banner tone="danger" title="Something went wrong">
          {error}
          {problem.length ? (
            <ul>
              {problem.map((x, i) => (
                <li key={i}>
                  {x.change ? `Change ${x.change}: ` : ''}
                  {x.message}
                </li>
              ))}
            </ul>
          ) : null}
        </Banner>
      ) : null}
      {conflict ? (
        <Banner
          tone="warning"
          title="The proposal changed since you started editing"
          action={
            <>
              <button
                type="button"
                className="button"
                onClick={() =>
                  void refresh().then((v) => {
                    // Keep the edits and carry them to the current revision.
                    if (!v || !account) return;
                    const kept = readProposalDraft(account, ws, id);
                    update({ ...(kept ?? emptyDraft(v.revision)), revision: v.revision });
                    setConflict(false);
                  })
                }
              >
                Reload and keep my edits
              </button>{' '}
              <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                  update(emptyDraft(p.revision));
                  setConflict(false);
                }}
              >
                Discard my edits
              </button>
            </>
          }
        >
          Your unsaved edits are kept on this device. Review the current revision, then save again.
        </Banner>
      ) : null}
      {app ? (
        <section aria-labelledby="prp-outcome" className="ai-panel" role="region">
          <h2 id="prp-outcome">Outcome</h2>
          {app.outcome === 'applied' ? (
            <Banner tone="success" title={`Applied ${app.applied_count} change(s)`}>
              {planner
                ? 'Applied by you · proposed by the rule-based planner'
                : 'Applied by you · proposed by AI'}{' '}
              · {new Date(app.at).toLocaleString()}.
            </Banner>
          ) : (
            <Banner tone="danger" title="Nothing was applied">
              One change failed, so every change was rolled back. Review the details below, then
              approve and apply again.
            </Banner>
          )}
        </section>
      ) : null}

      {plan ? (
        <section aria-labelledby="prp-plan" className="ai-panel" role="region">
          <h2 id="prp-plan">
            Plan for {plan.day} ({plan.timezone})
          </h2>
          <p className="hint">
            Rule-based plan: deterministic, not generated. Times below are shown in your browser's
            time zone. Task dates never change.
          </p>
          <dl className="plan-totals">
            <dt>Available</dt>
            <dd>{plan.totals.capacity_minutes ?? 0} min</dd>
            <dt>Scheduled</dt>
            <dd>{plan.totals.scheduled_minutes ?? 0} min</dd>
            <dt>Not scheduled</dt>
            <dd>{plan.totals.unscheduled_minutes ?? 0} min</dd>
            <dt>Missing estimates</dt>
            <dd>{plan.totals.unknown_estimates ?? 0}</dd>
          </dl>
          {plan.coverage ? <p className="hint">{plan.coverage}</p> : null}
          {plan.feasible ? null : (
            <p>Not everything fits this day; see what was left out and why.</p>
          )}
          {plan.unscheduled.length ? (
            <>
              <h3>Not scheduled</h3>
              <ul>
                {plan.unscheduled.map((u, i) => (
                  <li key={i}>
                    <strong>{u.task?.title ?? 'A task you can no longer see'}</strong>: {u.detail}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {plan.postpone.length ? (
            <>
              <h3>Postponement suggestions (only if you select them)</h3>
              <ul>
                {plan.postpone.map((x, i) => (
                  <li key={i}>
                    <strong>{x.task?.title ?? 'A task you can no longer see'}</strong>: {x.tradeoff}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {plan.conflicts.length ? (
            <Banner tone="warning" title="Locked work that does not fit">
              <ul>
                {plan.conflicts.map((c, i) => (
                  <li key={i}>{c.detail}</li>
                ))}
              </ul>
            </Banner>
          ) : null}
          {plan.current.state === 'changed' ? (
            <Banner tone="warning" title="Your day changed since this plan was made">
              Time off, meetings, blocks, Today, or the tasks it uses changed. Review the plan, then
              use your current day as its basis below and approve again.
            </Banner>
          ) : plan.current.state === 'unavailable' ? (
            <Banner tone="info" title="This plan can no longer be checked">
              Its day has passed or its scope is no longer available to you.
            </Banner>
          ) : null}
        </section>
      ) : null}
      {p.can.rebase && planner ? (
        <section aria-labelledby="prp-rebase" className="ai-panel" role="region">
          <h2 id="prp-rebase">Use your current day as this plan's basis</h2>
          <p>
            Keeps your selections and edits; conflicting times are shown on each block. You approve
            again before applying.
          </p>
          <button
            type="button"
            className="button button-primary"
            disabled={busy}
            onClick={() => void rebase()}
          >
            Use my current day
          </button>
        </section>
      ) : null}
      {p.can.rebase && !planner ? (
        <section aria-labelledby="prp-rebase" className="ai-panel" role="region">
          <h2 id="prp-rebase">Some records changed since this proposal was made</h2>
          <p>
            Review the current values shown as “Now” for{' '}
            {p.changes
              .filter((c) => c.target?.out_of_date)
              .map((c) => c.key)
              .join(', ')}
            . To keep the proposal, use these current versions as its new base: you then approve it
            again before applying. Nothing is overwritten without that review.
          </p>
          <button
            type="button"
            className="button button-primary"
            disabled={busy}
            onClick={() => void rebase()}
          >
            Use the current versions
          </button>
        </section>
      ) : null}
      <section aria-labelledby="prp-changes" className="ai-panel">
        <h2 id="prp-changes">
          Changes ({selected.length} of {p.changes.length} selected)
        </h2>
        {missing.length ? (
          <Banner tone="warning" title="Some selected changes depend on unselected ones">
            {missing.map((m) => `Change ${m.c} needs change ${m.d}`).join('; ')}. Select them too or
            deselect the dependent change.
          </Banner>
        ) : null}
        <ol className="ai-proposal-changes">
          {p.changes.map((c) => {
            const decision = decisionOf(c);
            const rejected = decision === 'rejected';
            const own = problem.find((x) => x.change === c.key);
            return (
              <li key={c.key} className="ai-proposal-change">
                <h3 id={`prp-${c.key}-h`}>
                  <label className="ai-confirm">
                    <input
                      type="checkbox"
                      checked={isSelected(c)}
                      disabled={!editable || rejected}
                      onChange={() => toggle(c)}
                    />{' '}
                    {c.key} · {OP_TEXT[c.op]}
                  </label>
                </h3>
                <p className="hint">
                  {c.target ? (
                    c.target.available === false ? (
                      'Target: a record you can no longer see.'
                    ) : (
                      <>
                        Target: <RefText ws={ws} r={c.target as AiProposalRef} />
                        {c.target.out_of_date
                          ? ' — changed since the proposal was made; review the current value.'
                          : ''}
                      </>
                    )
                  ) : null}
                  {c.project ? (
                    <>
                      In project <RefText ws={ws} r={c.project} />.{' '}
                    </>
                  ) : null}
                  {c.parent ? (
                    <>
                      Under <RefText ws={ws} r={c.parent} />.{' '}
                    </>
                  ) : null}
                  {c.relation ? (
                    <>
                      <RefText ws={ws} r={c.relation.from} />{' '}
                      {c.relation.kind === 'blocks' ? 'blocks' : 'is related to'}{' '}
                      <RefText ws={ws} r={c.relation.to} />.{' '}
                    </>
                  ) : null}
                  {c.task ? (
                    <>
                      For <RefText ws={ws} r={c.task} />.{' '}
                    </>
                  ) : null}
                  {c.label ? (
                    <>
                      Label:{' '}
                      {c.label.available === false ? 'a label that was removed' : c.label.name}
                      .{' '}
                    </>
                  ) : null}
                  {c.assignees?.length ? (
                    <>
                      Assign to:{' '}
                      {c.assignees
                        .map((a) => (a.available === false ? 'a person who left' : a.name))
                        .join(', ')}
                      .{' '}
                    </>
                  ) : null}
                  {c.depends_on.length ? `Needs ${c.depends_on.join(', ')}. ` : ''}
                  {c.sources.length ? `Based on ${c.sources.join(', ')}.` : ''}
                </p>
                {c.fields.length ? (
                  <table className="ai-diff">
                    <caption className="visually-hidden">Proposed values for {c.key}</caption>
                    <thead>
                      <tr>
                        <th scope="col">Field</th>
                        <th scope="col">Now</th>
                        <th scope="col">Proposed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.fields.map((f) => (
                        <tr key={f.field}>
                          <th scope="row">{FIELD_TEXT[f.field] ?? f.field}</th>
                          <td>
                            {c.target
                              ? INSTANTS.has(f.field)
                                ? shownInstant(f.before)
                                : (f.before ?? '—')
                              : 'New'}
                          </td>
                          <td>
                            {p.can.edit && !rejected ? (
                              <FieldEditor
                                change={c}
                                field={f.field}
                                value={valueOf(c, f.field, f.after)}
                                disabled={!editable}
                                onChange={(v) => setField(c, f.field, v)}
                              />
                            ) : INSTANTS.has(f.field) ? (
                              shownInstant(f.after)
                            ) : (
                              (f.after ?? '—')
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
                <p>
                  {decision === 'edited' ? <span className="ai-tag">Edited by you</span> : null}
                  {rejected ? <span className="ai-tag">Rejected</span> : null}
                  {c.applied_state !== 'not_applied' ? (
                    <strong>
                      {' '}
                      {OUTCOME_TEXT[c.applied_state]}
                      <ResultText ws={ws} r={c.result} />
                    </strong>
                  ) : null}
                  {c.failure ? <span className="field-error"> {c.failure.message}</span> : null}
                  {issuesOf(c.key).map((i) => (
                    <span key={i.code} className={i.severity === 'error' ? 'field-error' : 'hint'}>
                      {' '}
                      This time {ISSUE_TEXT[i.code] ?? i.code}
                      {i.severity === 'error' ? ': change it or deselect this block.' : '.'}
                    </span>
                  ))}
                  {own ? <span className="field-error"> {own.message}</span> : null}
                </p>
                {p.can.edit && !rejected ? (
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={!editable}
                    onClick={() => reject(c)}
                  >
                    Reject change {c.key}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ol>
      </section>

      {p.can.edit || p.can.approve || p.can.apply || p.can.reject ? (
        <section
          aria-labelledby="prp-actions"
          className="ai-panel"
          aria-busy={busy ? 'true' : 'false'}
        >
          <h2 id="prp-actions">Review and apply</h2>
          {pending ? (
            <>
              <p>You have unsaved edits. Save them as a new revision before approving.</p>
              <button
                type="button"
                className="button button-primary"
                disabled={busy}
                onClick={() => void save()}
              >
                Save edits
              </button>{' '}
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={() => update(emptyDraft(p.revision))}
              >
                Discard edits
              </button>
            </>
          ) : (
            <>
              {p.approval?.valid ? (
                <p>
                  Approved {p.approval.selected.length} change(s) of revision {p.approval.revision};
                  the approval expires {new Date(p.approval.expires_at).toLocaleString()}.
                </p>
              ) : (
                <p>Approve exactly what you reviewed; any later edit needs a new approval.</p>
              )}
              {p.can.approve && !p.approval?.valid ? (
                <button
                  type="button"
                  className="button button-primary"
                  disabled={busy || !selected.length || missing.length > 0}
                  onClick={() => void decide('approve')}
                >
                  Approve {selected.length} change(s)
                </button>
              ) : null}{' '}
              {p.can.apply ? (
                <button
                  type="button"
                  className="button button-primary"
                  disabled={busy}
                  onClick={() => void decide('apply')}
                >
                  Apply {selected.length} of {p.changes.length} changes
                </button>
              ) : null}
            </>
          )}
          {p.can.reject ? (
            <div className="field">
              <label htmlFor="prp-reason">Reason for rejecting (optional)</label>
              <input
                id="prp-reason"
                value={reason}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
              />
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={() => void decide('reject')}
              >
                Reject the whole proposal
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {p.history.length ? (
        <section aria-labelledby="prp-history" className="ai-panel">
          <h2 id="prp-history">History</h2>
          <ol>
            {p.history.map((h, i) => (
              <li key={i}>
                {h.kind.replace(/_/g, ' ')} · revision {h.revision}
                {h.changes.length ? ` · ${h.changes.join(', ')}` : ''} ·{' '}
                {new Date(h.at).toLocaleString()}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <Announce>{said}</Announce>
    </Page>
  );
}
