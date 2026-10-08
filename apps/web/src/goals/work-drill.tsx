import { useState } from 'react';
import { Link } from '../router.tsx';
import { routeHref } from '../shell/registry.ts';
import { goals, type GoalWork } from './client.ts';
import { explain, type Explained } from '../collab/shared.tsx';

/**
 * The tasks behind a linked-work figure, exactly as the server counts them for this viewer: the
 * tasks they can read, nothing else. Loaded when asked for.
 */
export function WorkDrill({
  ws,
  goal,
  keyResult,
}: {
  ws: string;
  goal: string;
  keyResult?: string;
}) {
  const [work, setWork] = useState<GoalWork | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const load = async () => {
    setBusy(true);
    setProblem(null);
    try {
      setWork(await goals.work(ws, goal, keyResult));
    } catch (err) {
      setProblem(explain(err, 'loading the tasks'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="gl-drill">
      <button
        type="button"
        className="button button-secondary"
        disabled={busy}
        onClick={() => void load()}
      >
        {busy ? 'Loading…' : work ? 'Reload the tasks counted' : 'Show the tasks counted'}
      </button>
      {problem ? (
        <p role="alert" className="gl-warn">
          {problem.message}
        </p>
      ) : null}
      {work ? (
        <div role="region" aria-label="Tasks counted">
          <p>
            {work.summary.done} of {work.summary.total} tasks you can read are done.
          </p>
          <p className="hint">{work.coverage.note}</p>
          {work.coverage.truncated ? (
            <p className="gl-warn">
              <span aria-hidden="true">△ </span>Incomplete: only the first tasks are listed.
            </p>
          ) : null}
          <ul className="gl-plain">
            {work.data.map((t) => (
              <li key={t.id}>
                <span aria-hidden="true">{t.done ? '✓ ' : '○ '}</span>
                <Link to={routeHref('task', { ws, tsk: t.id })}>{t.title}</Link>
                <span className="hint">
                  {' '}
                  · {t.done ? 'Done' : t.status.category}
                  {t.due_date ? ` · due ${t.due_date}` : ''}
                  {t.project ? ` · ${t.project.name ?? 'Project'}` : ''}
                </span>
              </li>
            ))}
          </ul>
          <p className="hint">As of {new Date(work.as_of).toLocaleString()}.</p>
        </div>
      ) : null}
    </div>
  );
}
