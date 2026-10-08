import { useState } from 'react';
import { ApiError } from '../api.ts';
import { Link, useRouter } from '../router.tsx';
import type { BrandMarkerData } from '../shell/client.ts';
import { routeHref } from '../shell/registry.ts';
import { useStepUp } from '../stepup.tsx';
import { useResource } from '../tenancy/resource.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { SelectField } from '../ui/form.tsx';
import { goals } from './client.ts';
import { CreateGoalDialog } from './dialogs.tsx';
import { GoalRow } from './row.tsx';
import { ProblemLine, useExplain, type Explained } from './shared.tsx';

/**
 * The Goals card on a project (5B, IA "Project goals appear inside their project"): goals scoped
 * to the project and goals linked to it or to its tasks, among those the viewer may read. A guest
 * is refused by the API and sees no card at all.
 */

function LinkToGoal({
  ws,
  project,
  onClose,
  onLinked,
}: {
  ws: string;
  project: { id: string; brand: BrandMarkerData };
  onClose: () => void;
  onLinked: () => void;
}) {
  const stepUp = useStepUp();
  const explainError = useExplain();
  const list = useResource(
    () => goals.list(ws, { status: 'draft,active', limit: 100 }),
    `pg-link:${ws}`,
  );
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const brandId = project.brand.kind === 'brand' ? project.brand.id : null;
  // A project goal links its own tasks, and a brand goal links its own brand's work.
  const options = (list.state.status === 'ready' ? list.state.data.data : []).filter(
    (g) =>
      g.scope.kind === 'workspace' ||
      (g.scope.kind === 'brand' && g.scope.brand.kind === 'brand' && g.scope.brand.id === brandId),
  );
  const submit = async () => {
    if (!goal || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await goals.addLink(ws, goal, { target: project.id }, stepUp);
      onLinked();
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled'))
        setProblem(explainError(err, 'linking the project'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Link this project to a goal" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <SelectField
          id="pg-goal"
          label="Goal"
          hint="Goals you can edit, in this project's brand or workspace-wide."
          value={goal}
          onChange={setGoal}
          options={[
            { value: '', label: list.state.status === 'loading' ? 'Loading goals…' : 'Choose a goal' },
            ...options.map((g) => ({ value: g.id, label: `${g.title} (${g.period.label})` })),
          ]}
        />
        <ProblemLine problem={problem} busy={busy} />
        <p className="actions">
          <button type="submit" className="button button-primary" disabled={busy || !goal}>
            {busy ? 'Linking…' : 'Link project'}
          </button>
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
        </p>
      </form>
    </Dialog>
  );
}

export function ProjectGoalsCard({
  ws,
  project,
  canEdit,
}: {
  ws: string;
  project: { id: string; name: string; brand: BrandMarkerData };
  /** The viewer may change the project (and so link it to goals). */
  canEdit: boolean;
}) {
  const { navigate } = useRouter();
  const data = useResource(() => goals.ofProject(ws, project.id), `pgoals:${ws}:${project.id}`);
  const [dialog, setDialog] = useState<'create' | 'link' | null>(null);
  const [said, setSaid] = useState('');
  // Guests and people who lost access are refused by the API: nothing about goals is shown.
  if (
    data.state.status === 'failed' &&
    data.state.error instanceof ApiError &&
    (data.state.error.code === 'forbidden' || data.state.error.code === 'not_found')
  )
    return null;
  return (
    <section className="card" aria-labelledby="pg-h">
      <h2 id="pg-h">Goals</h2>
      <p className="hint">
        Goals for this project and goals linked to it or its tasks, among those you can read.
      </p>
      {data.state.status === 'loading' ? (
        <p className="loading" role="status">
          Loading goals…
        </p>
      ) : data.state.status === 'failed' ? (
        <p role="alert">
          We couldn't load the goals.{' '}
          <button type="button" className="link-button" onClick={data.retry}>
            Try again
          </button>
        </p>
      ) : data.state.data.data.length ? (
        <ul className="gl-list">
          {data.state.data.data.map((g) => (
            <GoalRow key={g.id} ws={ws} goal={g} headingLevel={4} />
          ))}
        </ul>
      ) : (
        <p className="hint">No goal you can see is linked to this project.</p>
      )}
      <p className="announce" role="status">
        {said}
      </p>
      <p className="actions">
        <Link className="button button-ghost" to={routeHref('goals', { ws })}>
          Open Goals
        </Link>
        {canEdit ? (
          <>
            <button type="button" className="button button-secondary" onClick={() => setDialog('link')}>
              Link to a goal
            </button>
            <button type="button" className="button button-secondary" onClick={() => setDialog('create')}>
              Add a goal for this project
            </button>
          </>
        ) : null}
      </p>
      {dialog === 'create' ? (
        <CreateGoalDialog
          ws={ws}
          fixedProject={{ id: project.id, name: project.name }}
          onClose={() => setDialog(null)}
          onCreated={(g) => {
            setDialog(null);
            navigate(routeHref('goal', { ws, goal: g.id }));
          }}
        />
      ) : null}
      {dialog === 'link' ? (
        <LinkToGoal
          ws={ws}
          project={project}
          onClose={() => setDialog(null)}
          onLinked={() => {
            setDialog(null);
            data.reload();
            setSaid('Project linked to the goal.');
          }}
        />
      ) : null}
    </section>
  );
}
