import { useCallback, useEffect, useState } from 'react';
import { ApiError, newIdempotencyKey } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { Link, useRouter } from '../router.tsx';
import { discardDraft, loadDraft, saveDraft } from '../shell/drafts.ts';
import { Announce, Banner } from '../ui/feedback.tsx';
import { Page } from '../ui/layout.tsx';
import { aiProblem } from './client.ts';
import {
  briefingClient,
  KIND_TEXT,
  type Briefing,
  type BriefingKind,
  type BriefingPreview,
  type BriefingRef,
  type BriefingSchedule,
  type BriefingStatement,
  type BriefingSummary,
} from './briefing-client.ts';

/**
 * Phase 7E briefings and reviews (ADR-0042; BRF-001–BRF-018, UXD-16). Briefings are fact-only:
 * every statement names its trust kind and links its evidence; generated wording is never part of
 * one. Correction notes and schedule edits are kept on this device as bounded personal drafts
 * until saved, and are only shown again after the server confirms the briefing is still yours.
 */

const SECTION_TEXT: Record<string, string> = {
  overview: 'Overview',
  completed: 'Completed since the previous briefing',
  accepted: 'Accepted deliverables and claimed completion',
  attention: 'Overdue, blocked, stale, and at risk',
  decisions: 'Decisions waiting for you',
  deadlines: 'Approaching deadlines',
  capacity: 'Capacity and conflicts',
  time: 'Planned versus actual time',
  ai_cost: 'AI usage and cost',
  agent_runs: 'Agent runs',
  project: 'Project status',
  release: 'Release readiness',
  generated: 'Generated wording',
};
const KIND_LABEL: Record<BriefingStatement['kind'], string> = {
  fact: 'Fact',
  calculation: 'Calculation',
  excerpt: 'Exact excerpt',
  suggestion: 'Generated suggestion',
  unknown: 'Unknown',
  annotation: 'Your note',
  unavailable: 'Not available',
};
const STATE_TEXT: Record<BriefingSummary['state'], string> = {
  queued: 'Queued',
  published: 'Published',
  failed: 'Failed',
  superseded: 'Superseded (schedule changed)',
};
const TRIGGER_TEXT: Record<BriefingSummary['trigger'], string> = {
  schedule: 'Scheduled',
  manual: 'Generated now',
  regenerate: 'Regenerated',
};
const COVERAGE_TEXT: Record<string, string> = {
  truncated: 'Only the first items are listed; the count covers all of them.',
  partial: 'Only part of your work was examined for this section.',
  unavailable: 'Not available yet.',
};
const DELIVERY_TEXT: Record<string, string> = {
  delivered: 'Delivered',
  pending: 'Pending',
  suppressed: 'Not sent',
  failed: 'Failed',
  dead: 'Failed (no more retries)',
  none: 'Not requested',
  muted: 'Muted by your notification settings',
  not_notified: 'Not notified (you generated it)',
};
const REASON_TEXT: Record<string, string> = {
  provider_unconfigured: 'Email is not configured for this product, so nothing was emailed.',
  access_lost: 'You no longer had access when it was due to send.',
  generated_by_you: 'You generated this briefing yourself.',
};
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const NEEDS_BRAND = new Set<BriefingKind>(['brand_daily']);
const ALLOWS_BRAND = new Set<BriefingKind>(['brand_daily', 'weekly_review']);
const NEEDS_PROJECT = new Set<BriefingKind>(['project_status', 'release_readiness']);
const fmt = (iso: string, tz?: string) =>
  new Date(iso).toLocaleString(undefined, tz ? { timeZone: tz } : {});
const CORRECTION_DRAFT_TTL_MS = 72 * 3_600_000;

/** The signed-in account; null while unknown (drafts are then neither read nor written). */
function useDraftAccount(): string | null {
  try {
    const me = useAuth().me;
    return me ? me.id : null;
  } catch {
    return 'device';
  }
}
const noteDraftId = (ws: string, brf: string, key: string) =>
  `ai-briefing.${ws}.${brf}.${key}`
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]/g, '_')
    .slice(0, 120);

/** Removes every unsaved note for one briefing (it was withheld, erased, or is not available). */
function discardBriefingDrafts(account: string, ws: string, brf: string): void {
  const prefix = noteDraftId(ws, brf, '');
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      const at = k ? k.indexOf(`.${prefix}`) : -1;
      if (k && at >= 0 && k.startsWith(`pm.draft.${account}.`))
        discardDraft(account, k.slice(at + 1));
    }
  } catch {
    // storage unavailable
  }
}

function readNote(account: string | null, id: string): string | null {
  if (!account) return null;
  const d = loadDraft(account, id);
  if (!d) return null;
  const age = Date.now() - Date.parse(d.savedAt);
  if (!Number.isFinite(age) || age < 0 || age > CORRECTION_DRAFT_TTL_MS || d.value.length > 1000) {
    discardDraft(account, id);
    return null;
  }
  return d.value;
}

function refHref(ws: string, r: BriefingRef): string | null {
  switch (r.type) {
    case 'task':
      return `/workspaces/${ws}/tasks/${r.id}`;
    case 'project':
      return `/workspaces/${ws}/projects/${r.id}`;
    case 'briefing':
      return `/workspaces/${ws}/briefings/${r.id}`;
    case 'review':
      return `/workspaces/${ws}/reviews`;
    case 'approval':
      return `/workspaces/${ws}/approvals`;
    case 'timesheet':
      return `/workspaces/${ws}/time/approvals`;
    case 'time':
      return `/workspaces/${ws}/time/reports`;
    case 'capacity':
      return `/workspaces/${ws}/capacity`;
    case 'ai_usage':
      return `/workspaces/${ws}/ai`;
    default:
      return null;
  }
}
const REF_TEXT: Record<string, string> = {
  task: 'Task',
  project: 'Project',
  deliverable: 'Deliverable',
  review: 'Review',
  approval: 'Approval',
  timesheet: 'Timesheet',
  project_update: 'Project update',
  brand: 'Brand',
  briefing: 'Earlier briefing',
  correction: 'Your note',
  time: 'Your time report',
  capacity: 'Your capacity',
  ai_usage: 'Your AI usage',
};

function Evidence({ ws, refs }: { ws: string; refs: BriefingRef[] }) {
  if (!refs.length) return null;
  return (
    <ul className="ai-sources" aria-label="Evidence">
      {refs.slice(0, 8).map((r, i) => {
        const href = refHref(ws, r);
        const label =
          `${REF_TEXT[r.type] ?? r.type} ${r.id.length > 12 ? r.id.slice(0, 8) + '…' : ''}`.trim();
        return (
          <li key={`${r.type}-${r.id}-${i}`}>
            {href ? <Link to={href}>{label}</Link> : <span>{label}</span>}
            {r.version !== undefined ? (
              <span className="hint"> (version {String(r.version)})</span>
            ) : null}
          </li>
        );
      })}
      {refs.length > 8 ? <li className="hint">and {refs.length - 8} more</li> : null}
    </ul>
  );
}

// -------------------------------------------------------------------------------------------
// List and Generate now
// -------------------------------------------------------------------------------------------

export function BriefingsPage({ ws }: { ws: string }) {
  const { navigate } = useRouter();
  const [items, setItems] = useState<BriefingSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<BriefingKind>('owner_daily');
  const [brand, setBrand] = useState('');
  const [project, setProject] = useState('');
  const [brands, setBrands] = useState<Array<{ id: string; name: string }>>([]);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [preview, setPreview] = useState<BriefingPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);

  useEffect(() => {
    briefingClient
      .list(ws)
      .then((r) => setItems(r.items))
      .catch((err) => setError(aiProblem(err, 'Briefings could not be loaded.')));
    briefingClient
      .brands(ws)
      .then(setBrands)
      .catch(() => setBrands([]));
    briefingClient
      .projects(ws)
      .then(setProjects)
      .catch(() => setProjects([]));
  }, [ws]);
  const body = () => ({
    kind,
    scope: NEEDS_PROJECT.has(kind) ? { project } : ALLOWS_BRAND.has(kind) && brand ? { brand } : {},
  });
  const change = (fn: () => void) => {
    fn();
    setPreview(null);
    setProblem(null);
    setKey(newIdempotencyKey());
  };
  const doPreview = async () => {
    setProblem(null);
    try {
      setPreview(await briefingClient.preview(ws, body()));
    } catch (err) {
      setProblem(aiProblem(err, 'The preview could not be shown.'));
    }
  };
  const generate = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const b = await briefingClient.generate(ws, body(), key);
      navigate(`/workspaces/${ws}/briefings/${b.id}`);
    } catch (err) {
      // An ambiguous failure keeps the same key, so a retry never generates twice.
      if (err instanceof ApiError && !err.offline && err.status >= 400 && err.status < 500)
        setKey(newIdempotencyKey());
      setProblem(aiProblem(err, 'The briefing could not be generated.'));
    } finally {
      setBusy(false);
    }
  };
  const ready = (!NEEDS_PROJECT.has(kind) || !!project) && (!NEEDS_BRAND.has(kind) || !!brand);

  return (
    <Page
      title="Briefings"
      lead="Source-linked reviews of your work, computed from what you can read. Briefings are fact-only: nothing is generated or changed."
    >
      <p>
        <Link to={`/workspaces/${ws}/settings/briefings`}>Schedules and delivery</Link>
      </p>
      <section aria-labelledby="brf-generate-heading" className="ai-panel">
        <h2 id="brf-generate-heading">Generate now</h2>
        <label htmlFor="brf-kind">Briefing type</label>
        <select
          id="brf-kind"
          value={kind}
          onChange={(e) => change(() => setKind(e.target.value as BriefingKind))}
        >
          {(Object.keys(KIND_TEXT) as BriefingKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_TEXT[k]}
            </option>
          ))}
        </select>
        {ALLOWS_BRAND.has(kind) ? (
          <>
            <label htmlFor="brf-brand">Brand{NEEDS_BRAND.has(kind) ? '' : ' (optional)'}</label>
            <select
              id="brf-brand"
              value={brand}
              onChange={(e) => change(() => setBrand(e.target.value))}
            >
              <option value="">
                {NEEDS_BRAND.has(kind) ? 'Choose a brand' : 'Every brand you can read'}
              </option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </>
        ) : null}
        {NEEDS_PROJECT.has(kind) ? (
          <>
            <label htmlFor="brf-project">Project</label>
            <select
              id="brf-project"
              value={project}
              onChange={(e) => change(() => setProject(e.target.value))}
            >
              <option value="">Choose a project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <div className="button-row">
          <button type="button" className="button" onClick={doPreview} disabled={!ready}>
            Preview scope and window
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={generate}
            disabled={!ready || busy || !preview}
          >
            {busy ? 'Generating…' : 'Generate briefing'}
          </button>
        </div>
        {preview ? (
          <div role="region" aria-label="Briefing preview">
            <p>
              <strong>{preview.kind_label}</strong> for {preview.scope.label}.
            </p>
            <p>
              Window: {fmt(preview.window.start, preview.timezone)} to{' '}
              {fmt(preview.window.end, preview.timezone)} ({preview.timezone})
              {preview.window.clamped ? ' — limited to the last 31 days' : ''}.
            </p>
            <p>
              {preview.first
                ? 'First briefing for this scope: there is no earlier briefing to compare with.'
                : `Continues from your briefing published ${fmt(preview.baseline!.published_at)}.`}
            </p>
            <p className="hint">Fact-only. {preview.generated.reason}</p>
          </div>
        ) : null}
        {problem ? (
          <p role="alert" className="field-error">
            {problem}
          </p>
        ) : null}
      </section>
      {error ? (
        <Banner tone="danger" title="Something went wrong">
          {error}
        </Banner>
      ) : null}
      {!items && !error ? <p role="status">Loading briefings…</p> : null}
      {items && !items.length ? (
        <p>No briefings yet. Generate one now or set up a schedule.</p>
      ) : null}
      {items?.length ? (
        <ul aria-label="Your briefings" className="ai-sources">
          {items.map((b) => (
            <li key={b.id}>
              <Link to={`/workspaces/${ws}/briefings/${b.id}`}>
                {b.kind_label} · {fmt(b.window.end, b.timezone)}
              </Link>{' '}
              <span className="hint">
                — {STATE_TEXT[b.state]} · {TRIGGER_TEXT[b.trigger]}
                {b.first ? ' · First (no baseline)' : ''}
                {b.content === 'erased' ? ' · Erased' : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Page>
  );
}

// -------------------------------------------------------------------------------------------
// Detail, evidence, corrections, delivery
// -------------------------------------------------------------------------------------------

function NoteForm({
  ws,
  brf,
  statement,
  account,
  onSaved,
  onRefused,
}: {
  ws: string;
  brf: string;
  statement: BriefingStatement;
  account: string | null;
  onSaved: () => void;
  onRefused: () => void;
}) {
  const id = noteDraftId(ws, brf, statement.key);
  const [text, setText] = useState(() => readNote(account, id) ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const [key, setKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const fieldId = `note-${statement.position}`;
  const update = (v: string) => {
    setText(v);
    if (account) {
      if (v) saveDraft(account, id, v);
      else discardDraft(account, id);
    }
  };
  const submit = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await briefingClient.propose(ws, brf, { statement: statement.key, text }, key);
      if (account) discardDraft(account, id);
      setText('');
      setKey(newIdempotencyKey());
      onSaved();
    } catch (err) {
      // An authoritative refusal (the briefing or its evidence is no longer yours) removes the
      // unsaved note; an offline or ambiguous failure keeps it for a retry with the same key.
      if (err instanceof ApiError && !err.offline && (err.status === 404 || err.status === 403)) {
        if (account) discardBriefingDrafts(account, ws, brf);
        setText('');
        setKey(newIdempotencyKey());
        setProblem(
          'This briefing is no longer available to you, so your unsaved note was removed.',
        );
        onRefused();
        return;
      }
      if (err instanceof ApiError && !err.offline && err.status >= 400 && err.status < 500)
        setKey(newIdempotencyKey());
      setProblem(
        `${aiProblem(err, 'The note could not be saved.')} Your text is kept on this device.`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="note-form">
      <label htmlFor={fieldId}>Your note or correction (only you see it)</label>
      <textarea
        id={fieldId}
        rows={3}
        maxLength={1000}
        value={text}
        onChange={(e) => update(e.target.value)}
      />
      <p className="hint">
        A note annotates future briefings for you. It never changes the record; to change work, edit
        it or propose a change.
      </p>
      <button type="button" className="button" onClick={submit} disabled={!text.trim() || busy}>
        Propose note
      </button>
      {problem ? (
        <p role="alert" className="field-error">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

export function BriefingPage({ ws, id }: { ws: string; id: string }) {
  const account = useDraftAccount();
  const { navigate } = useRouter();
  const [b, setB] = useState<Briefing | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [regenKey] = useState(newIdempotencyKey);
  const load = useCallback(() => {
    briefingClient
      .get(ws, id)
      .then((r) => {
        setB(r);
        setError(null);
        // Content that is no longer the person's is never kept as a local draft.
        if (account && r.availability !== 'available') discardBriefingDrafts(account, ws, id);
      })
      .catch((err) => {
        if (account && err instanceof ApiError && (err.status === 404 || err.status === 403))
          discardBriefingDrafts(account, ws, id);
        setError(err);
      });
  }, [ws, id, account]);
  useEffect(load, [load]);
  if (error)
    return (
      <Page title="Briefing">
        <Banner
          tone={error instanceof ApiError && error.offline ? 'warning' : 'danger'}
          title="This briefing could not be shown"
        >
          {aiProblem(error, 'It is not available to you.')}
        </Banner>
        <button type="button" className="button" onClick={load}>
          Try again
        </button>
      </Page>
    );
  if (!b)
    return (
      <Page title="Briefing">
        <p role="status">Loading the briefing…</p>
      </Page>
    );
  const sections: Array<[string, BriefingStatement[]]> = [];
  for (const s of b.statements) {
    const last = sections[sections.length - 1];
    if (last && last[0] === s.section) last[1].push(s);
    else sections.push([s.section, [s]]);
  }
  const regenerate = async () => {
    try {
      const r = await briefingClient.regenerate(ws, b.id, regenKey);
      navigate(`/workspaces/${ws}/briefings/${r.id}`);
    } catch (err) {
      setAnnounce(aiProblem(err, 'The briefing could not be regenerated.'));
    }
  };
  return (
    <Page
      title={b.kind_label}
      lead={`${TRIGGER_TEXT[b.trigger]} · ${STATE_TEXT[b.state]} · Fact-only`}
    >
      <Announce>{announce}</Announce>
      <p>
        <Link to={`/workspaces/${ws}/briefings`}>All briefings</Link>
      </p>
      <dl className="ai-meta">
        <dt>Window</dt>
        <dd>
          {fmt(b.window.start, b.timezone)} to {fmt(b.window.end, b.timezone)} ({b.timezone})
        </dd>
        <dt>Compared with</dt>
        <dd>
          {b.baseline ? (
            <Link to={`/workspaces/${ws}/briefings/${b.baseline}`}>
              Your previous published briefing
            </Link>
          ) : (
            'Nothing: this is the first briefing for this scope.'
          )}
        </dd>
        {b.regenerates ? (
          <>
            <dt>Regenerates</dt>
            <dd>
              <Link to={`/workspaces/${ws}/briefings/${b.regenerates}`}>The original briefing</Link>{' '}
              (same window and baseline)
            </dd>
          </>
        ) : null}
        <dt>In-app</dt>
        <dd>{DELIVERY_TEXT[b.delivery.in_app] ?? b.delivery.in_app}</dd>
        <dt>Email</dt>
        <dd>
          {DELIVERY_TEXT[b.delivery.email] ?? b.delivery.email}
          {b.delivery.email_reason
            ? ` — ${REASON_TEXT[b.delivery.email_reason] ?? b.delivery.email_reason}`
            : ''}
        </dd>
      </dl>
      {b.availability === 'withheld' ? (
        <Banner tone="warning" title="This briefing is withheld">
          Some of its evidence is no longer available to you, so none of it is shown. Generate a new
          briefing for what you can read now.
        </Banner>
      ) : null}
      {b.availability === 'erased' ? (
        <Banner tone="info" title="This briefing's content was erased">
          Its record remains; the statements were removed under the retention or departure rules.
        </Banner>
      ) : null}
      {b.state === 'failed' ? (
        <Banner tone="danger" title="This briefing failed">
          It was not published ({b.failure_code}). Nothing was sent.
        </Banner>
      ) : null}
      {b.state === 'published' || b.state === 'failed' ? (
        <button type="button" className="button" onClick={regenerate}>
          Regenerate (same window)
        </button>
      ) : null}
      {sections.map(([section, list]) => {
        const cov = b.coverage?.sections[section === 'attention' ? 'overdue' : section];
        return (
          <section key={section} aria-labelledby={`brf-${section}`}>
            <h2 id={`brf-${section}`}>{SECTION_TEXT[section] ?? section}</h2>
            {cov && cov.state !== 'complete' ? (
              <p className="hint" role="note">
                {COVERAGE_TEXT[cov.state]}
              </p>
            ) : null}
            <ul className="brf-statements">
              {list.map((s) => (
                <li key={s.position} className={`brf-${s.kind}`}>
                  <span className="badge">{KIND_LABEL[s.kind]}</span> <span>{s.text}</span>
                  <Evidence ws={ws} refs={s.refs} />
                  {s.corrections.length ? (
                    <p className="hint">
                      Notes on this statement: {s.corrections.map((c) => c.state).join(', ')}
                    </p>
                  ) : null}
                  {b.availability === 'available' &&
                  s.kind !== 'annotation' &&
                  s.kind !== 'unavailable' ? (
                    open === s.key ? (
                      <NoteForm
                        ws={ws}
                        brf={b.id}
                        statement={s}
                        account={account}
                        onRefused={load}
                        onSaved={() => {
                          setOpen(null);
                          setAnnounce('Note proposed. Review it under Schedules and delivery.');
                          load();
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="button button-ghost"
                        onClick={() => setOpen(s.key)}
                      >
                        Add a note
                      </button>
                    )
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </Page>
  );
}

// -------------------------------------------------------------------------------------------
// Schedules, delivery, and notes
// -------------------------------------------------------------------------------------------

export function BriefingSettingsPage({ ws }: { ws: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof briefingClient.schedules>> | null>(
    null,
  );
  const [notes, setNotes] = useState<Awaited<ReturnType<typeof briefingClient.corrections>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [brands, setBrands] = useState<Array<{ id: string; name: string }>>([]);
  const [form, setForm] = useState({
    kind: 'owner_daily' as BriefingKind,
    brand: '',
    timezone: '',
    local_time: '08:00',
    weekdays: [1, 2, 3, 4, 5],
    email: false,
  });
  const [problem, setProblem] = useState<string | null>(null);
  const [key, setKey] = useState(newIdempotencyKey);
  const load = useCallback(() => {
    briefingClient
      .schedules(ws)
      .then((d) => {
        setData(d);
        setForm((f) => (f.timezone ? f : { ...f, timezone: d.timezone }));
      })
      .catch((err) => setError(aiProblem(err, 'Schedules could not be loaded.')));
    briefingClient
      .corrections(ws)
      .then(setNotes)
      .catch(() => setNotes([]));
  }, [ws]);
  useEffect(() => {
    load();
    briefingClient
      .brands(ws)
      .then(setBrands)
      .catch(() => setBrands([]));
  }, [ws, load]);
  const create = async () => {
    setProblem(null);
    try {
      await briefingClient.createSchedule(
        ws,
        {
          kind: form.kind,
          scope: ALLOWS_BRAND.has(form.kind) && form.brand ? { brand: form.brand } : {},
          timezone: form.timezone,
          local_time: form.local_time,
          weekdays: form.weekdays,
          channels: form.email ? ['in_app', 'email'] : ['in_app'],
        },
        key,
      );
      setKey(newIdempotencyKey());
      setAnnounce('Schedule saved.');
      load();
    } catch (err) {
      if (err instanceof ApiError && !err.offline && err.status >= 400 && err.status < 500)
        setKey(newIdempotencyKey());
      setProblem(aiProblem(err, 'The schedule could not be saved.'));
    }
  };
  const toggle = async (s: BriefingSchedule) => {
    try {
      await briefingClient.updateSchedule(
        ws,
        s.id,
        { enabled: !s.enabled },
        s.version,
        newIdempotencyKey(),
      );
      setAnnounce(s.enabled ? 'Schedule turned off.' : 'Schedule turned on.');
      load();
    } catch (err) {
      setAnnounce(aiProblem(err, 'The schedule could not be changed. Reload and try again.'));
    }
  };
  const decide = async (id: string, verb: 'approve' | 'reject', version: number) => {
    try {
      await briefingClient.decide(ws, id, verb, version, newIdempotencyKey());
      setAnnounce(
        verb === 'approve' ? 'Note approved for your future briefings.' : 'Note rejected.',
      );
      load();
    } catch (err) {
      setAnnounce(aiProblem(err, 'The note could not be decided.'));
      // A note that is no longer available disappears from the list on the authoritative reload.
      if (err instanceof ApiError && err.status === 404) load();
    }
  };
  return (
    <Page
      title="Briefing schedules"
      lead="When your briefings are prepared, in your own time zone, and how you hear about them. Scheduled briefings never start AI runs."
    >
      <Announce>{announce}</Announce>
      <p>
        <Link to={`/workspaces/${ws}/briefings`}>Your briefings</Link>
      </p>
      {error ? (
        <Banner tone="danger" title="Something went wrong">
          {error}
        </Banner>
      ) : null}
      {data?.email === 'not_configured' ? (
        <Banner tone="info" title="Email is not configured">
          Briefings arrive in the app. Email delivery is requested but will be shown as not sent
          until an email provider is configured.
        </Banner>
      ) : null}
      {!data && !error ? <p role="status">Loading schedules…</p> : null}
      {data?.items.length ? (
        <ul aria-label="Your schedules" className="ai-sources">
          {data.items.map((s) => (
            <li key={s.id}>
              <strong>{s.kind_label}</strong> at {s.local_time} ({s.timezone}) on{' '}
              {s.weekdays.map((d) => WEEKDAYS[d - 1]).join(', ')} ·{' '}
              {s.channels.includes('email')
                ? `In-app and email${s.email === 'not_configured' ? ' (email not configured)' : ''}`
                : 'In-app'}
              <br />
              <span className="hint">
                {s.enabled && s.next_run_at ? `Next: ${fmt(s.next_run_at, s.timezone)}` : 'Off'} ·
                revision {s.revision}
              </span>{' '}
              <button type="button" className="button" onClick={() => toggle(s)}>
                {s.enabled ? 'Turn off' : 'Turn on'}
              </button>
            </li>
          ))}
        </ul>
      ) : data ? (
        <p>No schedules yet.</p>
      ) : null}
      <section aria-labelledby="brf-new-schedule" className="ai-panel">
        <h2 id="brf-new-schedule">New schedule</h2>
        <label htmlFor="sch-kind">Briefing type</label>
        <select
          id="sch-kind"
          value={form.kind}
          onChange={(e) => setForm({ ...form, kind: e.target.value as BriefingKind })}
        >
          {(['owner_daily', 'brand_daily', 'weekly_review'] as BriefingKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_TEXT[k]}
            </option>
          ))}
        </select>
        {ALLOWS_BRAND.has(form.kind) ? (
          <>
            <label htmlFor="sch-brand">
              Brand{NEEDS_BRAND.has(form.kind) ? '' : ' (optional)'}
            </label>
            <select
              id="sch-brand"
              value={form.brand}
              onChange={(e) => setForm({ ...form, brand: e.target.value })}
            >
              <option value="">
                {NEEDS_BRAND.has(form.kind) ? 'Choose a brand' : 'Every brand you can read'}
              </option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <label htmlFor="sch-tz">Time zone</label>
        <input
          id="sch-tz"
          value={form.timezone}
          onChange={(e) => setForm({ ...form, timezone: e.target.value })}
        />
        <label htmlFor="sch-time">Local time</label>
        <input
          id="sch-time"
          type="time"
          value={form.local_time}
          onChange={(e) => setForm({ ...form, local_time: e.target.value })}
        />
        <fieldset>
          <legend>Weekdays</legend>
          {WEEKDAYS.map((d, i) => (
            <label key={d} className="inline">
              <input
                type="checkbox"
                checked={form.weekdays.includes(i + 1)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    weekdays: e.target.checked
                      ? [...form.weekdays, i + 1].sort()
                      : form.weekdays.filter((x) => x !== i + 1),
                  })
                }
              />{' '}
              {d}
            </label>
          ))}
        </fieldset>
        <label className="inline">
          <input
            type="checkbox"
            checked={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.checked })}
          />{' '}
          Also email me a link (no briefing content is put in the email)
        </label>
        <button type="button" className="button button-primary" onClick={create}>
          Save schedule
        </button>
        {problem ? (
          <p role="alert" className="field-error">
            {problem}
          </p>
        ) : null}
      </section>
      <section aria-labelledby="brf-notes">
        <h2 id="brf-notes">Your notes</h2>
        {notes.length ? (
          <ul className="ai-sources" aria-label="Your briefing notes">
            {notes.map((n) => (
              <li key={n.id}>
                <span>{n.text ?? '(erased)'}</span> <span className="hint">— {n.state}</span>{' '}
                {n.state === 'proposed' ? (
                  <>
                    <button
                      type="button"
                      className="button"
                      onClick={() => decide(n.id, 'approve', n.version)}
                    >
                      Approve
                    </button>{' '}
                    <button
                      type="button"
                      className="button"
                      onClick={() => decide(n.id, 'reject', n.version)}
                    >
                      Reject
                    </button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p>No notes yet. Add a note to a statement in a briefing.</p>
        )}
      </section>
    </Page>
  );
}
