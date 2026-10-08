import { useState } from 'react';
import { ApiError } from '../api.ts';
import { CheckinForm, CheckinHistory } from '../goals/checkin.tsx';
import {
  BASIS_LABEL,
  GOAL_STATUS_LABEL,
  GOAL_STATUSES,
  goals,
  type GoalDetail,
  type GoalStatus,
} from '../goals/client.ts';
import { KeyResultsSection, LinkedWorkSection, metricLine } from '../goals/detail.tsx';
import { ConfirmDialog, EditGoalDialog } from '../goals/dialogs.tsx';
import {
  AvailableView,
  Coverage,
  FreshnessLine,
  ProblemLine,
  ProgressView,
  ScopeLine,
  StatusChip,
  ConfidenceChip,
  UpdateChip,
  useExplain,
  type Explained,
} from '../goals/shared.tsx';
import { useRouter } from '../router.tsx';
import { routeHref } from '../shell/registry.ts';
import { useStepUp } from '../stepup.tsx';
import { useResource } from '../tenancy/resource.tsx';
import { Banner } from '../ui/feedback.tsx';
import { SelectField } from '../ui/form.tsx';
import { Page } from '../ui/layout.tsx';

/**
 * A goal (5B GOAL-001..006): header with status and lifecycle actions, progress with the rule that
 * produced it, key results, linked work (only what the viewer may read), check-ins and history.
 * Edits send the loaded version; a conflict keeps what was typed and offers the latest version.
 */

export function GoalPage({ ws, goal }: { ws: string; goal: string }) {
  const data = useResource(() => goals.get(ws, goal), `goal:${ws}:${goal}`, {
    keepOnRefreshError: true,
  });
  const loaded = data.state.status === 'ready' ? data.state.data : null;
  return (
    <Page
      title={loaded ? loaded.title : 'Goal'}
      wide
      section="Goals"
      record={loaded ? { title: loaded.title } : null}
      breadcrumbs={
        loaded
          ? [
              { label: 'Goals', to: routeHref('goals', { ws }) },
              ...(loaded.scope.kind !== 'workspace'
                ? [{ label: 'Brand', marker: loaded.scope.brand }]
                : []),
              { label: loaded.title },
            ]
          : undefined
      }
    >
      <AvailableView resource={data.state} onRetry={data.retry} what="goal">
        {(g) => <GoalBody ws={ws} g={g} reload={data.refresh} set={data.set} />}
      </AvailableView>
    </Page>
  );
}

function GoalBody({
  ws,
  g,
  reload,
  set,
}: {
  ws: string;
  g: GoalDetail;
  reload: () => Promise<void>;
  set: (g: GoalDetail) => void;
}) {
  const stepUp = useStepUp();
  const explainError = useExplain();
  const { navigate } = useRouter();
  const [dialog, setDialog] = useState<'edit' | 'archive' | 'trash' | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const [said, setSaid] = useState('');
  const [nonce, setNonce] = useState(0);
  const [status, setStatus] = useState<GoalStatus>(g.status);
  // The select follows the goal after a reload or a save; typed choices survive until then.
  const [seenStatus, setSeenStatus] = useState(g.status);
  if (seenStatus !== g.status) {
    setSeenStatus(g.status);
    setStatus(g.status);
  }
  const archived = g.lifecycle_state !== 'active';
  const closed = g.status !== 'draft' && g.status !== 'active';
  const can = g.capabilities;
  const editable = !!can?.update;
  const changed = (message: string) => {
    setSaid(message);
    setNonce((n) => n + 1);
  };

  const act = async (what: string, fn: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    setSaid('');
    try {
      await fn();
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled'))
        setProblem(explainError(err, what));
    } finally {
      setBusy(false);
    }
  };
  const lifecycle = (verb: 'archive' | 'unarchive' | 'trash') =>
    act(
      `${verb === 'unarchive' ? 'restoring' : verb === 'archive' ? 'archiving' : 'deleting'} the goal`,
      async () => {
        await goals.verb(ws, g.id, verb, g.version, stepUp);
        setDialog(null);
        if (verb === 'trash') navigate(routeHref('goals', { ws }));
        else {
          await reload();
          changed(verb === 'archive' ? 'Goal archived.' : 'Goal restored from the archive.');
        }
      },
    );
  const changeStatus = () =>
    act('changing the status', async () => {
      set(await goals.update(ws, g.id, g.version, { status }, stepUp));
      changed(`Status is now ${GOAL_STATUS_LABEL[status]}.`);
    });
  const recalc = () =>
    act('recalculating', async () => {
      set(await goals.recalculate(ws, g.id, stepUp));
      changed('Recalculated.');
    });

  const statuses = GOAL_STATUSES.filter((s) => s !== 'draft' || g.status === 'draft');
  return (
    <>
      <div className="record-header">
        <p className="record-meta">
          <StatusChip status={g.status} /> <ScopeLine scope={g.scope} />
        </p>
        <p className="gl-meta">
          Owner: {g.owner?.name ?? 'No owner'} · Period: {g.period.label} ({g.period.start} to{' '}
          {g.period.end}
          {g.period.calendar ? '' : ', not a calendar period'}) · Progress: {BASIS_LABEL[g.basis]}
        </p>
        {g.description ? <p className="gl-description">{g.description}</p> : null}
        {g.lifecycle_state === 'archived' ? (
          <Banner tone="info" title="This goal is archived">
            It is read-only: key results, links, and check-ins cannot change until it is restored.
          </Banner>
        ) : null}
        {!archived && closed ? (
          <Banner tone="info" title={`This goal is ${GOAL_STATUS_LABEL[g.status].toLowerCase()}`}>
            Check-ins are closed. Set the status back to Active to record an update.
          </Banner>
        ) : null}
      </div>
      <ProblemLine problem={problem}>
        {problem?.kind === 'stale' ? (
          <button type="button" className="button button-secondary" onClick={() => void reload()}>
            Reload the latest version
          </button>
        ) : null}
      </ProblemLine>
      <p className="announce" role="status">
        {said}
      </p>
      <div className="actions" role="group" aria-label="Goal actions">
        {editable ? (
          <button type="button" className="button button-primary" onClick={() => setDialog('edit')}>
            Edit goal
          </button>
        ) : null}
        {can?.archive && !archived ? (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setDialog('archive')}
          >
            Archive
          </button>
        ) : null}
        {g.lifecycle_state === 'archived' && can?.restore !== false ? (
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() => void lifecycle('unarchive')}
          >
            Restore from archive
          </button>
        ) : null}
        {can?.trash && !archived ? (
          <button type="button" className="button button-danger" onClick={() => setDialog('trash')}>
            Move to trash
          </button>
        ) : null}
      </div>
      {editable ? (
        <form
          className="gl-status-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (status !== g.status) void changeStatus();
          }}
        >
          <SelectField
            id="gd-status"
            label="Change status"
            hint={
              g.status === 'draft' ? undefined : 'A goal that has left draft cannot return to it.'
            }
            value={status}
            onChange={(v) => setStatus(v as GoalStatus)}
            options={statuses.map((s) => ({ value: s, label: GOAL_STATUS_LABEL[s] }))}
          />
          <button
            type="submit"
            className="button button-secondary"
            disabled={busy || status === g.status}
          >
            Set status
          </button>
        </form>
      ) : null}

      <section className="card" aria-labelledby="gd-progress">
        <h2 id="gd-progress">Progress</h2>
        <ProgressView
          progress={g.progress}
          label={`Progress of ${g.title}`}
          drill={{ ws, goal: g.id }}
        />
        {metricLine(g.metric) ? <p className="gl-meta">{metricLine(g.metric)}</p> : null}
        <p className="gl-chips">
          <ConfidenceChip value={g.latest.confidence} />
          <UpdateChip fresh={g.freshness} latest={g.latest} />
        </p>
        <Coverage
          note="Progress from linked work covers only the work you can read; another person may see a different figure."
          asOf={g.as_of}
        />
      </section>

      <section className="card" aria-labelledby="gd-fresh">
        <h2 id="gd-fresh">Freshness</h2>
        <FreshnessLine fresh={g.freshness} />
        {editable && g.freshness.recalculation.state !== 'current' ? (
          <p className="actions">
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => void recalc()}
            >
              Recalculate now
            </button>
          </p>
        ) : null}
      </section>

      <KeyResultsSection ws={ws} goal={g} editable={editable} reload={reload} onChanged={changed} />
      <LinkedWorkSection ws={ws} goal={g} editable={editable} reload={reload} onChanged={changed} />

      <section className="card" aria-labelledby="gd-checkin">
        <h2 id="gd-checkin">Check in</h2>
        <CheckinForm
          ws={ws}
          goal={g}
          onRecorded={() => {
            void reload().then(() => changed('Check-in recorded.'));
          }}
        />
      </section>
      <section className="card" aria-labelledby="gd-history">
        <h2 id="gd-history">Check-in history</h2>
        <CheckinHistory ws={ws} goal={g} nonce={nonce} />
      </section>

      {dialog === 'edit' ? (
        <EditGoalDialog
          ws={ws}
          goal={g}
          onClose={() => setDialog(null)}
          onReload={reload}
          onSaved={(next) => {
            set(next);
            setDialog(null);
            changed('Goal saved.');
          }}
        />
      ) : null}
      {dialog === 'archive' ? (
        <ConfirmDialog
          title="Archive this goal?"
          confirm="Archive goal"
          busy={busy}
          problem={problem}
          onClose={() => setDialog(null)}
          onConfirm={() => void lifecycle('archive')}
        >
          <p>
            It becomes read-only and leaves the Goals list. You can restore it later from its link.
          </p>
        </ConfirmDialog>
      ) : null}
      {dialog === 'trash' ? (
        <ConfirmDialog
          title="Move this goal to trash?"
          confirm="Move to trash"
          busy={busy}
          problem={problem}
          onClose={() => setDialog(null)}
          onConfirm={() => void lifecycle('trash')}
        >
          <p>It leaves the Goals list and can be restored by someone who can edit it.</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
