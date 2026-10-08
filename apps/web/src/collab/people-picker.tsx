import { useEffect, useId, useState } from 'react';
import { collaboration } from './client.ts';
import { explain, Problem, type Explained } from './shared.tsx';

export interface Person {
  id: string;
  name: string;
}

/**
 * Chooses people who can see a record (the same list the @mention picker offers, people only).
 * Checkboxes for several people (reviewers), radios for one (a hand-over). Choices are kept while
 * the search changes, and the chosen people are listed with a Remove button for each.
 */
export function PeoplePicker({
  ws,
  rec,
  legend,
  mode,
  selected,
  onChange,
  max,
  error,
}: {
  ws: string;
  rec: string;
  legend: string;
  mode: 'many' | 'one';
  selected: Person[];
  onChange: (next: Person[]) => void;
  max?: number;
  error?: string | undefined;
}) {
  const id = useId();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Person[] | null>(null);
  const [problem, setProblem] = useState<Explained | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      collaboration.candidates(ws, rec, q.trim(), controller.signal).then(
        (list) => {
          if (controller.signal.aborted) return;
          setFound(
            list.filter((c) => c.kind === 'member').map((c) => ({ id: c.id, name: c.name })),
          );
          setProblem(null);
        },
        (err: unknown) => {
          if (controller.signal.aborted) return;
          setFound([]);
          setProblem({ ...explain(err, 'searching'), retryable: true });
        },
      );
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [ws, rec, q, nonce]);

  const has = (p: Person) => selected.some((s) => s.id === p.id);
  const toggle = (p: Person) => {
    if (mode === 'one') return onChange([p]);
    if (has(p)) onChange(selected.filter((s) => s.id !== p.id));
    else if (!max || selected.length < max) onChange([...selected, p]);
  };

  return (
    <fieldset
      className={error ? 'picker field-invalid' : 'picker'}
      aria-describedby={error ? `${id}-err` : undefined}
    >
      <legend>{legend}</legend>
      {error ? (
        <p className="field-error" id={`${id}-err`} role="alert">
          <span aria-hidden="true">! </span>
          {error}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor={`${id}-q`}>Search people</label>
        <input
          id={`${id}-q`}
          type="search"
          value={q}
          autoComplete="off"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <Problem problem={problem} onRetry={() => setNonce((n) => n + 1)} />
      {found === null ? (
        <p className="loading">Loading people…</p>
      ) : found.length ? (
        <ul className="plain-list picker-list">
          {found.map((p) => (
            <li key={p.id}>
              <label className="choice">
                <input
                  type={mode === 'one' ? 'radio' : 'checkbox'}
                  name={`${id}-pick`}
                  checked={has(p)}
                  disabled={mode === 'many' && !has(p) && !!max && selected.length >= max}
                  onChange={() => toggle(p)}
                />
                {p.name}
              </label>
            </li>
          ))}
        </ul>
      ) : problem ? null : (
        <p className="hint">No one matches. Only people who can see this are listed.</p>
      )}
      {mode === 'many' ? (
        <div aria-live="polite">
          {selected.length ? (
            <>
              <p className="hint">
                Chosen ({selected.length}
                {max ? ` of ${max}` : ''}):
              </p>
              <ul className="plain-list picker-chosen">
                {selected.map((p) => (
                  <li key={p.id}>
                    {p.name}{' '}
                    <button
                      type="button"
                      className="button button-ghost"
                      onClick={() => onChange(selected.filter((s) => s.id !== p.id))}
                    >
                      Remove<span className="visually-hidden"> {p.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="hint">No one chosen yet.</p>
          )}
        </div>
      ) : null}
    </fieldset>
  );
}
