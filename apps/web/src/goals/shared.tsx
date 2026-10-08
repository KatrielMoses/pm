import { useId, type ReactNode } from 'react';
import { ApiError } from '../api.ts';
import { day, explain, when, type Explained } from '../collab/shared.tsx';
import { BrandMarker } from '../shell/brand-marker.tsx';
import type { BrandMarkerData } from '../shell/client.ts';
import { ResourceView, type Resource } from '../tenancy/resource.tsx';
import { useMarkNotAvailable } from '../ui/layout.tsx';
import {
  CONFIDENCE_LABEL,
  GOAL_STATUS_LABEL,
  HEALTH_LABEL,
  type Confidence,
  type Freshness,
  type GoalScope,
  type GoalStatus,
  type HealthIncomplete,
  type IncompleteReason,
  type LatestUpdate,
  type Progress,
  type ProjectHealth,
} from './client.ts';

/**
 * Shared 5B presentation. Status, health, confidence and freshness always carry text and a shape
 * as well as colour; every progress figure carries the rule that produced it in a disclosure that
 * works from the keyboard and with a screen reader.
 */

export { day, explain, when, type Explained };

// ---- Chips ------------------------------------------------------------------------------------

type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'info';

/** A short status label: a glyph (shape) and text, with colour only as reinforcement. */
export function Chip({
  tone,
  glyph,
  children,
  title,
}: {
  tone: Tone;
  glyph: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`gl-chip gl-chip-${tone}`} title={title}>
      <span aria-hidden="true" className="gl-chip-glyph">
        {glyph}
      </span>
      <span>{children}</span>
    </span>
  );
}

const CONFIDENCE_STYLE: Record<Confidence, { tone: Tone; glyph: string }> = {
  on_track: { tone: 'good', glyph: '✓' },
  at_risk: { tone: 'warn', glyph: '▲' },
  off_track: { tone: 'bad', glyph: '✖' },
};

export function ConfidenceChip({ value }: { value: Confidence | null }) {
  if (!value) return <Chip tone="neutral" glyph="○">No confidence set</Chip>;
  const s = CONFIDENCE_STYLE[value];
  return (
    <Chip tone={s.tone} glyph={s.glyph}>
      {CONFIDENCE_LABEL[value]}
    </Chip>
  );
}

const HEALTH_STYLE: Record<ProjectHealth, { tone: Tone; glyph: string }> = {
  on_track: { tone: 'good', glyph: '✓' },
  at_risk: { tone: 'warn', glyph: '▲' },
  off_track: { tone: 'bad', glyph: '✖' },
  complete: { tone: 'info', glyph: '●' },
  unknown: { tone: 'neutral', glyph: '?' },
};

export function HealthChip({ value, prefix }: { value: ProjectHealth; prefix?: string }) {
  const s = HEALTH_STYLE[value];
  return (
    <Chip tone={s.tone} glyph={s.glyph}>
      {prefix ? `${prefix} ` : ''}
      {HEALTH_LABEL[value]}
    </Chip>
  );
}

/** A project's declared health is the project's own word; it is shown as it was set. */
export function declaredHealthLabel(value: string): string {
  return (HEALTH_LABEL as Record<string, string>)[value] ?? value.replace(/_/g, ' ');
}

export function StatusChip({ status }: { status: GoalStatus }) {
  const glyph = { draft: '✎', active: '●', achieved: '✓', missed: '✖', cancelled: '⊘' }[status];
  const tone: Tone =
    status === 'achieved'
      ? 'good'
      : status === 'missed'
        ? 'bad'
        : status === 'active'
          ? 'info'
          : 'neutral';
  return (
    <Chip tone={tone} glyph={glyph}>
      {GOAL_STATUS_LABEL[status]}
    </Chip>
  );
}

/** How recently someone updated the goal, in words (never "stale" by colour alone). */
export function UpdateChip({ fresh, latest }: { fresh: Freshness; latest: LatestUpdate }) {
  if (fresh.update_state === 'never')
    return (
      <Chip tone="warn" glyph="○">
        No update yet
      </Chip>
    );
  if (fresh.update_state === 'stale')
    return (
      <Chip tone="warn" glyph="◌">
        Stale: last updated {day(latest.at)}
      </Chip>
    );
  return (
    <Chip tone="good" glyph="●">
      Updated {day(latest.at)}
    </Chip>
  );
}

// ---- Progress ---------------------------------------------------------------------------------

export const INCOMPLETE_TEXT: Record<IncompleteReason, string> = {
  no_measurement: 'No measurement has been recorded yet.',
  no_target: 'No target is set, so progress cannot be measured.',
  no_key_results: 'This goal has no key results yet.',
  no_readable_work: 'There is no linked work you can read, so there is nothing to count.',
  unmeasured_key_results:
    'Some key results have no measurement yet and are left out of the average.',
};

export const HEALTH_INCOMPLETE_TEXT: Record<HealthIncomplete, string> = {
  no_dates: 'no start, target, or deadline date is set',
  no_tasks: 'no tasks you can read are counted',
  no_time_budget: 'no time budget is set',
  paused: 'the project is paused',
  cancelled: 'the project is cancelled',
  not_started: 'the project has not started',
};

/** A percentage bar: `role="progressbar"` with a value and text, plus the number beside it. */
export function ProgressBar({ percent, label }: { percent: number | null; label: string }) {
  const text = percent === null ? 'No progress measured yet' : `${percent} percent`;
  return (
    <div className="gl-bar-wrap">
      <div
        className="gl-bar"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(percent === null ? {} : { 'aria-valuenow': percent })}
        aria-valuetext={text}
      >
        <span className="gl-bar-fill" style={{ width: `${percent ?? 0}%` }} />
      </div>
      <span className="gl-bar-text">{percent === null ? 'No progress yet' : `${percent}%`}</span>
    </div>
  );
}

/** The rule behind a figure, as a disclosure (a native `details`: keyboard and screen reader). */
export function ProgressView({
  progress,
  label,
  summary = 'How is this calculated?',
}: {
  progress: Progress;
  label: string;
  summary?: string;
}) {
  return (
    <div className="gl-progress">
      <ProgressBar percent={progress.percent} label={label} />
      <details className="gl-explain">
        <summary>
          {summary}
          <span className="visually-hidden"> ({label})</span>
        </summary>
        <p>{progress.explanation}</p>
        {progress.work ? (
          <p>
            {progress.work.done} of {progress.work.total} tasks you can read{' '}
            {progress.work.total === 1 ? 'is' : 'are'} done.
          </p>
        ) : null}
        {progress.key_results ? (
          <p>
            {progress.key_results.counted} of {progress.key_results.total} key result
            {progress.key_results.total === 1 ? '' : 's'} {progress.key_results.counted === 1 ? 'has' : 'have'} a
            measurement.
          </p>
        ) : null}
        {progress.incomplete.length ? (
          <ul className="gl-incomplete">
            {progress.incomplete.map((i) => (
              <li key={i}>
                <span aria-hidden="true">△ </span>
                {INCOMPLETE_TEXT[i]}
              </li>
            ))}
          </ul>
        ) : null}
      </details>
    </div>
  );
}

// ---- Scope ------------------------------------------------------------------------------------

export function ScopeLine({ scope }: { scope: GoalScope }) {
  if (scope.kind === 'workspace') return <span>Workspace goal</span>;
  return (
    <span className="gl-scope">
      <BrandMarker marker={scope.brand as BrandMarkerData} size={16} />
      {scope.kind === 'project' ? (
        <span>
          {' '}
          · Project{scope.project ? `: ${scope.project.name}` : ''}
        </span>
      ) : null}
    </span>
  );
}

/** Two sentences a viewer needs on every aggregate: what it covers and when it was computed. */
export function Coverage({
  note,
  asOf,
  children,
}: {
  note?: string | undefined;
  asOf?: string | undefined;
  children?: ReactNode;
}) {
  return (
    <div className="gl-coverage">
      {note ? <p>{note}</p> : null}
      {children}
      {asOf ? <p className="hint">As of {when(asOf)}.</p> : null}
    </div>
  );
}

/** Update, period, and recalculation state of a goal, each in words. */
export function FreshnessLine({ fresh }: { fresh: Freshness }) {
  const period = {
    upcoming: 'The period has not started.',
    current: 'The period is under way.',
    ended: 'The period has ended.',
  }[fresh.period_state];
  const recalc = {
    current: `Stored figures are current${fresh.recalculation.computed_at ? ` (computed ${when(fresh.recalculation.computed_at)})` : ''}.`,
    pending: 'A recalculation is pending; stored figures may lag for a moment.',
    failing: 'Recalculation is failing; stored figures may be out of date.',
  }[fresh.recalculation.state];
  return (
    <ul className="gl-fresh">
      <li>{period}</li>
      <li>
        {fresh.update_state === 'never'
          ? 'No check-in has been recorded.'
          : fresh.update_state === 'stale'
            ? `The last check-in is more than ${fresh.stale_after_days} days old.`
            : `A check-in was recorded within the last ${fresh.stale_after_days} days.`}
      </li>
      <li>
        <span aria-hidden="true">{fresh.recalculation.state === 'current' ? '✓ ' : '△ '}</span>
        {recalc}
      </li>
    </ul>
  );
}

// ---- Errors -----------------------------------------------------------------------------------

/** Not found and no access look identical: the page never says which (0C AT-02). */
export const isGone = (err: unknown): boolean =>
  err instanceof ApiError && (err.code === 'not_found' || err.status === 404);

/**
 * `ResourceView` where a refusal reads as "not available", so a reload after access was revoked
 * shows the standard state and never what used to be there.
 */
export function AvailableView<T>(props: {
  resource: Resource<T>;
  onRetry: () => void;
  what: string;
  children: (data: T) => ReactNode;
}) {
  const r = props.resource;
  const hidden =
    r.status === 'failed' && r.error instanceof ApiError && r.error.code === 'forbidden'
      ? ({
          status: 'failed',
          error: new ApiError({ code: 'not_found', status: 404, message: 'Not found.' }),
        } as Resource<T>)
      : r;
  return <ResourceView {...props} resource={hidden} />;
}

/**
 * For writes: turns the failure into plain copy and, when the page itself is no longer available
 * to this person, switches the whole page to the canonical state (nothing about it is disclosed).
 */
export function useExplain(): (err: unknown, what?: string) => Explained {
  const mark = useMarkNotAvailable();
  return (err, what) => {
    const e = explain(err, what);
    if (e.kind === 'gone') mark?.();
    return e;
  };
}

export function ProblemLine({
  problem,
  onRetry,
  busy,
  children,
}: {
  problem: Explained | null;
  onRetry?: (() => void) | undefined;
  busy?: boolean | undefined;
  children?: ReactNode;
}) {
  if (!problem) return null;
  return (
    <div className="gl-problem" role="alert">
      <span aria-hidden="true" className="gl-problem-icon">
        !
      </span>
      <div>
        <p>{problem.message}</p>
        {children}
        {problem.retryable && onRetry ? (
          <button type="button" className="button button-secondary" onClick={onRetry} disabled={busy}>
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** A labelled group of radio buttons with the same look as other forms. */
export function RadioGroup<T extends string>({
  legend,
  value,
  onChange,
  options,
  name,
}: {
  legend: string;
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
  name?: string;
}) {
  const id = useId();
  return (
    <fieldset className="plain gl-radios">
      <legend>{legend}</legend>
      {options.map((o) => (
        <label key={o.value} className="choice">
          <input
            type="radio"
            name={name ?? id}
            value={o.value}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
          />{' '}
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

/** A number from a text field: empty is null, anything else must be a finite number. */
export function parseNumber(text: string): number | null | undefined {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

export const fmtNumber = (n: number | null): string =>
  n === null ? '' : new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(n);

export const minutesText = (m: number): string => {
  if (m < 60) return `${m} min`;
  const h = Math.round((m / 60) * 10) / 10;
  return `${h} h`;
};
