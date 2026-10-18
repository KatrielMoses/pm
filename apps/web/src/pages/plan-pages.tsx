import { useEffect, useRef, useState } from 'react';
import { ApiError, newIdempotencyKey } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { aiProblem } from '../ai/client.ts';
import { localToday } from '../capture/client.ts';
import { planning, type DayPlanPreview, type DayPlanRequest } from '../planning/client.ts';
import { Link, useRouter } from '../router.tsx';
import { discardDraft, loadDraft, saveDraft } from '../shell/drafts.ts';
import { Announce, Banner } from '../ui/feedback.tsx';
import { Page } from '../ui/layout.tsx';

/**
 * Phase 7F plan assistant (ADR-0043 D4; PLAN-010–PLAN-013, AI-021). A deterministic, rule-based
 * plan for one day from working hours, time off, holidays, meetings, blocks, Today, estimates, and
 * dependencies: explained placements, what does not fit and why, postponement suggestions, and
 * locked work as hard constraints. Previewing writes nothing; "Create plan proposal" makes a
 * change proposal the person edits, approves, and applies on its own page. Options (split,
 * assumed estimates) are kept as a personal draft so a refresh does not lose them.
 */
const DRAFT_TTL_MS = 24 * 3_600_000;
const draftId = (ws: string) => `ai-plan.${ws.toLowerCase()}`;
const REASON_TEXT: Record<string, string> = {
  locked_commitment: 'locked on Today',
  committed: 'on Today',
  deadline_today: 'deadline today',
  overdue: 'overdue',
  due_today: 'due today',
  priority: 'priority',
  due_soon: 'due soon',
  assumed_estimate: 'your assumed estimate',
};

function useAccount(): string | null {
  try {
    return useAuth().me?.id ?? null;
  } catch {
    return 'device';
  }
}

interface PlanOptions {
  split: boolean;
  assumptions: Record<string, number>;
}

export function DayPlanPage({ ws }: { ws: string }) {
  const { search, navigate } = useRouter();
  const account = useAccount();
  const asked = search.get('day');
  const [day, setDay] = useState(asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : localToday());
  const [options, setOptions] = useState<PlanOptions>({ split: false, assumptions: {} });
  const [restored, setRestored] = useState(false);
  const [plan, setPlan] = useState<DayPlanPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [said, setSaid] = useState('');
  const pendingKey = useRef<string | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  const request = (): DayPlanRequest => ({
    day,
    ...(options.split ? { split: true } : {}),
    ...(Object.keys(options.assumptions).length ? { assumptions: options.assumptions } : {}),
  });

  // The preview follows the day and options; only the latest answer is shown.
  useEffect(() => {
    if (!online) return;
    const n = ++latest.current;
    planning.previewDayPlan(ws, request()).then(
      (v) => {
        if (n !== latest.current) return;
        setError('');
        setPlan(v);
        // Options are restored only after the server answered for this workspace.
        if (!restored && account) {
          setRestored(true);
          const d = loadDraft(account, draftId(ws));
          if (d && Date.now() - Date.parse(d.savedAt) <= DRAFT_TTL_MS) {
            try {
              const o = JSON.parse(d.value) as PlanOptions & { day?: string };
              if (
                o.day === day &&
                typeof o.split === 'boolean' &&
                o.assumptions &&
                typeof o.assumptions === 'object'
              )
                setOptions({ split: o.split, assumptions: o.assumptions });
            } catch {
              discardDraft(account, draftId(ws));
            }
          }
        }
      },
      (err) => {
        if (n === latest.current) setError(aiProblem(err, 'The plan could not be prepared.'));
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, day, options, online]);

  useEffect(() => {
    if (!account || !restored) return;
    if (options.split || Object.keys(options.assumptions).length)
      saveDraft(account, draftId(ws), JSON.stringify({ day, ...options }));
    else discardDraft(account, draftId(ws));
  }, [account, ws, day, options, restored]);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    pendingKey.current ??= newIdempotencyKey();
    try {
      const p = await planning.createDayPlan(ws, request(), pendingKey.current);
      pendingKey.current = null;
      if (account) discardDraft(account, draftId(ws));
      setSaid('Plan proposal created. Review it before applying.');
      navigate(`/workspaces/${ws}/ai/proposals/${p.id}`);
    } catch (err) {
      // Keep the key only while the outcome is unknown, so a retry resolves the same attempt.
      if (err instanceof ApiError && !err.offline && err.status > 0 && err.status < 500)
        pendingKey.current = null;
      setError(aiProblem(err, 'The plan proposal was not created.'));
    } finally {
      setBusy(false);
    }
  };

  const missing = plan?.unscheduled.filter((u) => u.code === 'missing_estimate') ?? [];
  return (
    <Page
      title="Plan my day"
      section="Today"
      lead="A rule-based plan from your capacity and work. Nothing changes until you review and apply it; task dates never change."
    >
      <p>
        <Link to={`/workspaces/${ws}/today`}>Back to Today</Link>
      </p>
      {!online ? (
        <Banner tone="warning" title="You're offline">
          The plan needs your current day from the server. Your options are kept; reconnect to
          continue.
        </Banner>
      ) : null}
      {error ? (
        <Banner tone="danger" title="Not completed">
          {error}
        </Banner>
      ) : null}
      <form className="plan-options" onSubmit={(e) => e.preventDefault()} aria-label="Plan options">
        <div className="field">
          <label htmlFor="plan-day">Day</label>
          <input
            id="plan-day"
            type="date"
            value={day}
            onChange={(e) => e.target.value && setDay(e.target.value)}
          />
        </div>
        <label className="ai-confirm">
          <input
            type="checkbox"
            checked={options.split}
            onChange={(e) => setOptions({ ...options, split: e.target.checked })}
          />{' '}
          Split long tasks across free time
        </label>
        {missing.length ? (
          <fieldset>
            <legend>Missing estimates</legend>
            <p className="hint">
              These tasks have no estimate, so they are not planned. Enter an assumption to plan
              them; the task itself is not changed.
            </p>
            {missing.map((u) => (
              <div className="field" key={u.task.id}>
                <label htmlFor={`assume-${u.task.id}`}>{u.task.title ?? 'A task'} (minutes)</label>
                <input
                  id={`assume-${u.task.id}`}
                  type="number"
                  min={5}
                  max={1440}
                  step={5}
                  value={options.assumptions[u.task.id] ?? ''}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    const next = { ...options.assumptions };
                    if (e.target.value && Number.isInteger(n) && n >= 5 && n <= 1440)
                      next[u.task.id] = n;
                    else delete next[u.task.id];
                    setOptions({ ...options, assumptions: next });
                  }}
                />
              </div>
            ))}
          </fieldset>
        ) : null}
      </form>
      {!plan && !error ? <p role="status">Preparing the plan…</p> : null}
      {plan ? (
        <>
          <section aria-labelledby="plan-summary" className="ai-panel">
            <h2 id="plan-summary">
              {plan.day} · {plan.timezone}
            </h2>
            <dl className="plan-totals">
              <dt>Available</dt>
              <dd>{plan.totals.capacity_minutes} min</dd>
              <dt>Already blocked</dt>
              <dd>{plan.totals.existing_block_minutes} min</dd>
              <dt>Scheduled by this plan</dt>
              <dd>{plan.totals.scheduled_minutes} min</dd>
              <dt>Not scheduled</dt>
              <dd>{plan.totals.unscheduled_minutes} min</dd>
              <dt>Missing estimates</dt>
              <dd>{plan.totals.unknown_estimates}</dd>
            </dl>
            <p className="hint">
              {plan.considered} open task(s) considered.{plan.coverage ? ` ${plan.coverage}` : ''}
            </p>
            <p>
              {plan.feasible
                ? 'Everything considered fits this day.'
                : 'Not everything fits this day.'}
            </p>
          </section>
          {plan.conflicts.length ? (
            <Banner tone="warning" title="Locked work or capacity needs your attention">
              <ul>
                {plan.conflicts.map((c, i) => (
                  <li key={i}>{c.detail}</li>
                ))}
              </ul>
            </Banner>
          ) : null}
          <section aria-labelledby="plan-scheduled" className="ai-panel">
            <h2 id="plan-scheduled">Planned ({plan.scheduled.length})</h2>
            {plan.scheduled.length ? (
              <ol>
                {plan.scheduled.map((s) => (
                  <li key={s.task.id}>
                    <strong>{s.task.title}</strong> · {s.minutes} min ·{' '}
                    {s.slots.map((x) => x.local).join(', ')}
                    <br />
                    <span className="hint">
                      Why here:{' '}
                      {s.reasons.map((r) => REASON_TEXT[r.code] ?? r.code).join(', ') ||
                        'next by rank'}
                      {s.warnings.length
                        ? ` · ${s.warnings.map((w) => w.replace(/_/g, ' ')).join(', ')}`
                        : ''}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p>Nothing could be placed on this day.</p>
            )}
          </section>
          {plan.unscheduled.length ? (
            <section aria-labelledby="plan-unscheduled" className="ai-panel">
              <h2 id="plan-unscheduled">Not planned ({plan.unscheduled.length})</h2>
              <ul>
                {plan.unscheduled.map((u) => (
                  <li key={u.task.id}>
                    <strong>{u.task.title}</strong>: {u.detail}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {plan.postpone.length ? (
            <section aria-labelledby="plan-postpone" className="ai-panel">
              <h2 id="plan-postpone">Postponement suggestions</h2>
              <p className="hint">
                Suggestions only: in the proposal they are unselected until you choose them.
              </p>
              <ul>
                {plan.postpone.map((x) => (
                  <li key={x.task.id}>
                    <strong>{x.task.title}</strong>: {x.tradeoff}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {plan.blocks.length ? (
            <section aria-labelledby="plan-blocks" className="ai-panel">
              <h2 id="plan-blocks">Already on your day</h2>
              <ul>
                {plan.blocks.map((b) => (
                  <li key={b.id}>
                    {b.local} · {b.task?.title ?? 'Work block'}
                    {b.locked ? <span className="ai-tag"> Locked</span> : null}
                    {b.focus ? <span className="ai-tag"> Focus</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section
            aria-labelledby="plan-next"
            className="ai-panel"
            aria-busy={busy ? 'true' : 'false'}
          >
            <h2 id="plan-next">Next</h2>
            <p>
              Create a plan proposal to edit times, choose which changes to keep, and apply them
              together. Your day is checked again before anything is applied.
            </p>
            <button
              type="button"
              className="button button-primary"
              disabled={busy || !online || (!plan.scheduled.length && !plan.postpone.length)}
              onClick={() => void create()}
            >
              Create plan proposal
            </button>
          </section>
        </>
      ) : null}
      <Announce>{said}</Announce>
    </Page>
  );
}
