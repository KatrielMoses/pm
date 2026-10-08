import { useState } from 'react';
import { ApiError } from '../api.ts';
import { Link } from '../router.tsx';
import { routeHref } from '../shell/registry.ts';
import { BrandMarker } from '../shell/brand-marker.tsx';
import { useStepUp } from '../stepup.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { CheckinForm } from './checkin.tsx';
import {
  BASIS_LABEL,
  CATEGORY_LABEL,
  goals,
  type GoalDetail,
  type GoalLink,
  type KeyResult,
  type ProjectCategory,
} from './client.ts';
import { ConfirmDialog, KeyResultDialog, LinkDialog } from './dialogs.tsx';
import {
  ConfidenceChip,
  ProblemLine,
  ProgressView,
  UpdateChip,
  useExplain,
  type Explained,
} from './shared.tsx';

/** The key results and linked-work sections of a goal. Reads reflect only what the viewer may see. */

const metricLine = (m: GoalDetail['metric'] | KeyResult['metric']): string | null =>
  m.target === null
    ? null
    : `From ${m.baseline} to ${m.target}${m.unit ? ` ${m.unit}` : ''}; currently ${m.current ?? 'not measured'}${m.current !== null && m.unit ? ` ${m.unit}` : ''}.`;

export function KeyResultsSection({
  ws,
  goal,
  editable,
  reload,
  onChanged,
}: {
  ws: string;
  goal: GoalDetail;
  editable: boolean;
  reload: () => Promise<void>;
  onChanged: (message: string) => void;
}) {
  const stepUp = useStepUp();
  const explainError = useExplain();
  const [dialog, setDialog] = useState<
    | { kind: 'add' }
    | { kind: 'edit'; id: string }
    | { kind: 'checkin'; id: string }
    | { kind: 'archive'; id: string }
    | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const krs = goal.key_results;
  const target = (id: string) => krs.find((k) => k.id === id);

  const move = async (kr: KeyResult, index: number, by: -1 | 1) => {
    // `after` is the key result the moved one should follow; none puts it first.
    const without = krs.filter((k) => k.id !== kr.id);
    const to = index + by;
    const after = to <= 0 ? null : (without[to - 1]?.id ?? null);
    setBusy(true);
    setProblem(null);
    try {
      await goals.updateKeyResult(ws, goal.id, kr.id, kr.version, { after }, stepUp);
      await reload();
      onChanged(`Moved “${kr.title}”.`);
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled'))
        setProblem(explainError(err, 'moving the key result'));
    } finally {
      setBusy(false);
    }
  };
  const archive = async (kr: KeyResult) => {
    setBusy(true);
    setProblem(null);
    try {
      await goals.keyResultVerb(ws, goal.id, kr.id, 'archive', kr.version, stepUp);
      setDialog(null);
      await reload();
      onChanged(`Archived “${kr.title}”.`);
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled'))
        setProblem(explainError(err, 'archiving the key result'));
    } finally {
      setBusy(false);
    }
  };

  const open = dialog && 'id' in dialog ? target(dialog.id) : undefined;
  return (
    <section className="card" aria-labelledby="gd-krs">
      <h2 id="gd-krs">Key results</h2>
      {goal.basis !== 'key_results' ? (
        <p className="hint">
          This goal's progress is measured by “{BASIS_LABEL[goal.basis]}”. Key results are tracked
          alongside it and do not change its progress.
        </p>
      ) : null}
      <ProblemLine problem={problem} />
      {!krs.length ? (
        <p className="hint">No key results yet.</p>
      ) : (
        <ul className="gl-list">
          {krs.map((k, i) => {
            const links = goal.links.filter((l) => l.key_result === k.id);
            return (
              <li key={k.id} className="gl-row">
                <h3 className="gl-row-title">{k.title}</h3>
                <p className="gl-meta">
                  Owner: {k.owner?.name ?? 'No owner'} · {BASIS_LABEL[k.basis]}
                </p>
                {metricLine(k.metric) ? <p className="gl-meta">{metricLine(k.metric)}</p> : null}
                <ProgressView progress={k.progress} label={`Progress of key result ${k.title}`} />
                <p className="gl-chips">
                  <ConfidenceChip value={k.latest.confidence} />
                  {k.latest.at ? (
                    <span className="hint">Last check-in {new Date(k.latest.at).toLocaleDateString()}</span>
                  ) : (
                    <span className="hint">No check-in yet</span>
                  )}
                </p>
                {k.basis === 'linked_work' ? (
                  <p className="hint">
                    {links.length
                      ? `${links.length} linked project or task${links.length === 1 ? '' : 's'} you can see.`
                      : 'No linked work you can see.'}
                  </p>
                ) : null}
                {editable ? (
                  <div className="actions-compact" role="group" aria-label={`Actions for ${k.title}`}>
                    {goal.capabilities?.check_in ? (
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => setDialog({ kind: 'checkin', id: k.id })}
                      >
                        Check in<span className="visually-hidden"> on {k.title}</span>
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="button button-ghost"
                      onClick={() => setDialog({ kind: 'edit', id: k.id })}
                    >
                      Edit<span className="visually-hidden"> {k.title}</span>
                    </button>
                    <button
                      type="button"
                      className="button button-ghost"
                      disabled={busy || i === 0}
                      onClick={() => void move(k, i, -1)}
                    >
                      Move up<span className="visually-hidden">: {k.title}</span>
                    </button>
                    <button
                      type="button"
                      className="button button-ghost"
                      disabled={busy || i === krs.length - 1}
                      onClick={() => void move(k, i, 1)}
                    >
                      Move down<span className="visually-hidden">: {k.title}</span>
                    </button>
                    <button
                      type="button"
                      className="button button-ghost"
                      onClick={() => setDialog({ kind: 'archive', id: k.id })}
                    >
                      Archive<span className="visually-hidden"> {k.title}</span>
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {editable ? (
        <p className="actions">
          <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: 'add' })}>
            Add key result
          </button>
        </p>
      ) : null}
      {dialog?.kind === 'add' || (dialog?.kind === 'edit' && open) ? (
        <KeyResultDialog
          ws={ws}
          goal={goal}
          {...(dialog.kind === 'edit' ? { krId: dialog.id } : {})}
          onClose={() => setDialog(null)}
          onReload={reload}
          onSaved={() => {
            const wasEdit = dialog.kind === 'edit';
            setDialog(null);
            void reload().then(() => onChanged(wasEdit ? 'Key result saved.' : 'Key result added.'));
          }}
        />
      ) : null}
      {dialog?.kind === 'checkin' && open ? (
        <Dialog title={`Check in: ${open.title}`} onClose={() => setDialog(null)}>
          <CheckinForm
            ws={ws}
            goal={goal}
            initialTarget={open.id}
            onCancel={() => setDialog(null)}
            onRecorded={() => {
              setDialog(null);
              void reload().then(() => onChanged('Check-in recorded.'));
            }}
          />
        </Dialog>
      ) : null}
      {dialog?.kind === 'archive' && open ? (
        <ConfirmDialog
          title="Archive this key result?"
          confirm="Archive key result"
          busy={busy}
          problem={problem}
          onClose={() => setDialog(null)}
          onConfirm={() => void archive(open)}
        >
          <p>
            “{open.title}” will leave the goal's progress and this list. Its check-in history is kept.
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

// ---- Linked work ------------------------------------------------------------------------------

function LinkItem({
  ws,
  link,
  krTitle,
  removable,
  busy,
  onRemove,
}: {
  ws: string;
  link: GoalLink;
  krTitle: string | null;
  removable: boolean;
  busy: boolean;
  onRemove: () => void;
}) {
  const t = link.target;
  const to = t.type === 'project' ? routeHref('project', { ws, prj: t.id }) : routeHref('task', { ws, tsk: t.id });
  return (
    <li className="gl-link">
      <span>
        <span className="badge">{t.type === 'project' ? 'Project' : 'Task'}</span>{' '}
        <Link to={to}>{t.name}</Link>{' '}
        <BrandMarker marker={t.brand} size={16} />
        <span className="hint">
          {' '}
          · {CATEGORY_LABEL[t.status_category as ProjectCategory] ?? t.status_category}
          {krTitle ? ` · Key result: ${krTitle}` : ''}
        </span>
      </span>
      {removable ? (
        <button type="button" className="button button-ghost" disabled={busy} onClick={onRemove}>
          Remove<span className="visually-hidden"> link to {t.name}</span>
        </button>
      ) : null}
    </li>
  );
}

export function LinkedWorkSection({
  ws,
  goal,
  editable,
  reload,
  onChanged,
}: {
  ws: string;
  goal: GoalDetail;
  editable: boolean;
  reload: () => Promise<void>;
  onChanged: (message: string) => void;
}) {
  const stepUp = useStepUp();
  const explainError = useExplain();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const krTitle = (id: string | null) =>
    id ? (goal.key_results.find((k) => k.id === id)?.title ?? null) : null;
  const remove = async (l: GoalLink) => {
    setBusy(true);
    setProblem(null);
    try {
      await goals.removeLink(ws, goal.id, l.target.id, l.key_result, stepUp);
      await reload();
      onChanged(`Removed the link to ${l.target.name}.`);
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled'))
        setProblem(explainError(err, 'removing the link'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="gd-links">
      <h2 id="gd-links">Linked work</h2>
      <p className="hint">
        Shows the linked projects and tasks you can read. Progress and counts here cover only that
        work, and can differ between people.
      </p>
      <ProblemLine problem={problem} />
      {goal.links.length ? (
        <ul className="gl-links">
          {goal.links.map((l) => (
            <LinkItem
              key={`${l.target.id}:${l.key_result ?? ''}`}
              ws={ws}
              link={l}
              krTitle={krTitle(l.key_result)}
              removable={editable}
              busy={busy}
              onRemove={() => void remove(l)}
            />
          ))}
        </ul>
      ) : (
        <p className="hint">No linked work you can see.</p>
      )}
      <p className="hint">
        {goal.work.visible_links} linked, {goal.work.active_links} active (relative to you).
      </p>
      {editable ? (
        <p className="actions">
          <button type="button" className="button button-secondary" onClick={() => setAdding(true)}>
            Link work
          </button>
        </p>
      ) : null}
      {adding ? (
        <LinkDialog
          ws={ws}
          goal={goal}
          onClose={() => setAdding(false)}
          onLinked={() => {
            setAdding(false);
            void reload().then(() => onChanged('Linked work added.'));
          }}
        />
      ) : null}
    </section>
  );
}

export { UpdateChip, metricLine };
