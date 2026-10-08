import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../api.ts';
import { Problem } from '../collab/shared.tsx';
import {
  NOTIFICATION_TYPES,
  notifications,
  TYPE_LABEL,
  type Mode,
  type ScopeDefault,
} from './client.ts';
import { CHANNEL_LABEL, explainNotify, MODE_LABEL, type Explained } from './shared.tsx';

/**
 * Notification defaults for one brand or project (4B): what people get here unless they chose
 * otherwise. Shown only to someone the server lets read them (a refusal hides the section); saving
 * needs the permission to configure the scope, and a refusal is said plainly.
 */
export function ScopeDefaultsEditor({
  ws,
  kind,
  id,
  name,
}: {
  ws: string;
  kind: 'brands' | 'projects';
  id: string;
  name: string;
}) {
  const [rows, setRows] = useState<ScopeDefault[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [failed, setFailed] = useState<Explained | null>(null);
  const [nonce, setNonce] = useState(0);
  const [type, setType] = useState('*');
  const [channel, setChannel] = useState<ScopeDefault['channel']>('email');
  const [mode, setMode] = useState<Mode>('immediate');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    notifications.scopeDefaults(ws, kind, id).then(
      (r) => {
        if (!active) return;
        setRows(r);
        setFailed(null);
      },
      (err: unknown) => {
        if (!active) return;
        if (err instanceof ApiError && [401, 403, 404].includes(err.status)) setHidden(true);
        else setFailed(explainNotify(err, 'loading'));
      },
    );
    return () => {
      active = false;
    };
  }, [ws, kind, id, nonce]);

  if (hidden) return null;
  const heading = `heading-defaults-${id}`;
  const refresh = () => setNonce((n) => n + 1);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    setNotice('');
    try {
      await notifications.setScopeDefault(ws, kind, id, {
        event_type: type,
        channel,
        mode,
      });
      refresh();
      setNotice('Default saved.');
    } catch (err) {
      setProblem(
        err instanceof ApiError && err.code === 'forbidden'
          ? {
              message: "You can read these defaults but you don't have permission to change them.",
              kind: 'permission',
              retryable: false,
            }
          : explainNotify(err, 'saving'),
      );
    } finally {
      setBusy(false);
    }
  };
  const remove = async (r: ScopeDefault) => {
    setProblem(null);
    setNotice('');
    try {
      await notifications.removeScopeDefault(ws, kind, id, {
        event_type: r.event_type,
        channel: r.channel,
      });
      refresh();
      setNotice('Default removed.');
    } catch (err) {
      setProblem(explainNotify(err, 'removing it'));
    }
  };

  const label = (r: ScopeDefault) =>
    `${r.event_type === '*' ? 'All types' : (TYPE_LABEL[r.event_type as keyof typeof TYPE_LABEL] ?? r.event_type)} · ${CHANNEL_LABEL[r.channel]}: ${MODE_LABEL[r.mode]}`;

  return (
    <section className="card" aria-labelledby={heading}>
      <h2 id={heading}>Notification defaults</h2>
      <p className="hint">
        What people get for {name} unless they chose otherwise themselves. Security notices are not
        affected, and nobody's own choices are overwritten.
      </p>
      {failed ? <Problem problem={failed} onRetry={refresh} /> : null}
      {rows && !rows.length ? <p className="empty">No defaults are set here.</p> : null}
      {rows?.length ? (
        <ul className="plain-list ntf-mutes" aria-label="Defaults">
          {rows.map((r) => (
            <li key={`${r.event_type}|${r.channel}`} className="ntf-mute">
              <span>{label(r)}</span>
              <button
                type="button"
                className="button button-secondary"
                aria-label={`Remove default: ${label(r)}`}
                onClick={() => void remove(r)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form onSubmit={(e) => void save(e)} className="ntf-mute-form" aria-label="Add a default">
        <div className="field">
          <label htmlFor={`${heading}-type`}>Type</label>
          <select id={`${heading}-type`} value={type} onChange={(e) => setType(e.target.value)}>
            <option value="*">All types</option>
            {NOTIFICATION_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${heading}-channel`}>Channel</label>
          <select
            id={`${heading}-channel`}
            value={channel}
            onChange={(e) => {
              const next = e.target.value as ScopeDefault['channel'];
              setChannel(next);
              if (next !== 'email' && mode === 'digest') setMode('immediate');
            }}
          >
            <option value="in_app">In the app</option>
            <option value="email">Email</option>
            <option value="browser">Browser</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${heading}-mode`}>Default</label>
          <select
            id={`${heading}-mode`}
            value={mode}
            onChange={(e) => setMode(e.target.value as Mode)}
          >
            <option value="immediate">Immediately</option>
            {channel === 'email' ? <option value="digest">In the digest</option> : null}
            <option value="muted">Off</option>
          </select>
        </div>
        <div className="actions">
          <button type="submit" className="button button-secondary" disabled={busy}>
            Save default
          </button>
        </div>
      </form>
      <Problem problem={problem} />
      <p className="announce" role="status">
        {notice}
      </p>
    </section>
  );
}
