import { routeHref } from '../shell/registry.ts';
import { Link } from '../router.tsx';
import { type Goal } from './client.ts';
import { Chip, ConfidenceChip, ProgressView, ScopeLine, StatusChip, UpdateChip } from './shared.tsx';

/** One goal: title, scope, owner, period, status, progress with its rule, freshness, linked work. */
export function GoalRow({ ws, goal, headingLevel = 3 }: { ws: string; goal: Goal; headingLevel?: 3 | 4 }) {
  const H = `h${headingLevel}` as 'h3' | 'h4';
  const open = goal.status === 'draft' || goal.status === 'active';
  const w = goal.work;
  return (
    <li className="gl-row">
      <div className="gl-row-head">
        <H className="gl-row-title">
          <Link to={routeHref('goal', { ws, goal: goal.id })}>{goal.title}</Link>
        </H>
        <StatusChip status={goal.status} />
      </div>
      <p className="gl-meta">
        <ScopeLine scope={goal.scope} />
        <span> · Owner: {goal.owner?.name ?? 'No owner'}</span>
        <span> · {goal.period.label}</span>
        {goal.period.state === 'ended' ? <span> (period ended)</span> : null}
        {goal.period.state === 'upcoming' ? <span> (starts later)</span> : null}
      </p>
      <ProgressView progress={goal.progress} label={`Progress of ${goal.title}`} />
      <p className="gl-chips">
        <ConfidenceChip value={goal.latest.confidence} />
        <UpdateChip fresh={goal.freshness} latest={goal.latest} />
        {open && goal.freshness.recalculation.state === 'failing' ? (
          <Chip tone="warn" glyph="△">
            Recalculation failing
          </Chip>
        ) : null}
      </p>
      <p className="gl-work">
        {w.visible_links === 0
          ? 'No linked work you can see.'
          : `${w.visible_links} linked project or task${w.visible_links === 1 ? '' : 's'} you can see, ${w.active_links} active.`}
        {open && w.active_links === 0 ? (
          <>
            {' '}
            <Chip tone="warn" glyph="△">
              No active work you can see
            </Chip>
          </>
        ) : null}
      </p>
    </li>
  );
}

