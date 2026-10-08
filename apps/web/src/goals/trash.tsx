import { useState } from 'react';
import { ApiError } from '../api.ts';
import { useStepUp } from '../stepup.tsx';
import { goals, portfolios, type TrashedItem } from './client.ts';
import { ConfirmDialog } from './dialogs.tsx';
import { ProblemLine, useExplain, type Explained } from './shared.tsx';

/**
 * Trash for goals or portfolios: only items the viewer may restore are listed. Restore returns the
 * item; permanent delete is behind a confirmation and cannot be undone.
 */
export function TrashSection({
  ws,
  kind,
  onRestored,
}: {
  ws: string;
  kind: 'goal' | 'portfolio';
  onRestored: () => void;
}) {
  const stepUp = useStepUp();
  const explainError = useExplain();
  const noun = kind === 'goal' ? 'goal' : 'portfolio';
  const [items, setItems] = useState<TrashedItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const [said, setSaid] = useState('');
  const [purging, setPurging] = useState<TrashedItem | null>(null);
  const api = kind === 'goal' ? goals : portfolios;
  const label = (i: TrashedItem) => i.title ?? i.name ?? 'Untitled';

  const act = async (fn: () => Promise<void>, what: string) => {
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
  const load = () => act(async () => setItems((await api.trashed(ws)).data), `loading the trash`);
  const restore = (i: TrashedItem) =>
    act(async () => {
      await api.verb(ws, i.id, 'restore', i.version, stepUp);
      setItems((cur) => cur?.filter((x) => x.id !== i.id) ?? null);
      setSaid(`Restored ${label(i)}.`);
      onRestored();
    }, `restoring the ${noun}`);
  const purge = (i: TrashedItem) =>
    act(async () => {
      await api.verb(ws, i.id, 'purge', i.version, stepUp);
      setPurging(null);
      setItems((cur) => cur?.filter((x) => x.id !== i.id) ?? null);
      setSaid(`Permanently deleted ${label(i)}.`);
    }, `deleting the ${noun}`);

  return (
    <section className="card" aria-labelledby={`trash-${kind}`}>
      <h2 id={`trash-${kind}`}>Trash</h2>
      <p className="hint">
        {kind === 'goal' ? 'Goals' : 'Portfolios'} you moved to trash that you can still restore.
      </p>
      {items === null ? (
        <button
          type="button"
          className="button button-secondary"
          disabled={busy}
          onClick={() => void load()}
        >
          {busy ? 'Loading…' : 'Show trash'}
        </button>
      ) : !items.length ? (
        <p className="hint">The trash is empty.</p>
      ) : (
        <ul className="gl-list" aria-label={`Trashed ${noun}s`}>
          {items.map((i) => (
            <li key={i.id} className="gl-row">
              <h3 className="gl-row-title">{label(i)}</h3>
              <div className="actions-compact" role="group" aria-label={`Actions for ${label(i)}`}>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  aria-label={`Restore ${label(i)}`}
                  onClick={() => void restore(i)}
                >
                  Restore
                </button>
                <button
                  type="button"
                  className="button button-danger"
                  disabled={busy}
                  aria-label={`Delete ${label(i)} permanently`}
                  onClick={() => setPurging(i)}
                >
                  Delete permanently
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ProblemLine problem={purging ? null : problem} />
      <p className="announce" role="status">
        {said}
      </p>
      {purging ? (
        <ConfirmDialog
          title={`Delete this ${noun} permanently?`}
          confirm="Delete permanently"
          busy={busy}
          problem={problem}
          onClose={() => setPurging(null)}
          onConfirm={() => void purge(purging)}
        >
          <p>“{label(purging)}” and its history will be removed for good. This cannot be undone.</p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
