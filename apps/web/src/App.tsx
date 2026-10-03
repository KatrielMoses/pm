import { useCallback, useEffect, useState } from 'react';
import { PUBLIC_CONFIG } from '@pm/config/public';
import { fetchStatus, type ConnectionState } from './status.ts';

const COPY: Record<ConnectionState['kind'], { title: string; detail: string }> = {
  checking: { title: 'Checking connection…', detail: 'Contacting the service.' },
  available: { title: 'Connected', detail: 'The service is available.' },
  degraded: {
    title: 'Limited service',
    detail: 'Some features may be slow or unavailable. Your work is safe; try again shortly.',
  },
  unavailable: {
    title: 'Service unavailable',
    detail: "We can't reach the service right now. Check your connection and try again.",
  },
};

/** Application foundation screen: product name, safe build information, and API connectivity. */
export function App({ load = fetchStatus }: { load?: typeof fetchStatus }) {
  const [state, setState] = useState<ConnectionState>({ kind: 'checking' });

  useEffect(() => {
    const controller = new AbortController();
    void load(fetch, controller.signal).then((next) => {
      if (!controller.signal.aborted) setState(next);
    });
    return () => controller.abort();
  }, [load]);

  const retry = useCallback(() => {
    setState({ kind: 'checking' });
    void load(fetch).then(setState);
  }, [load]);

  const copy = COPY[state.kind];
  const build = state.kind === 'available' || state.kind === 'degraded' ? state.build : undefined;
  return (
    <main className="shell">
      <h1>{PUBLIC_CONFIG.appName}</h1>
      <p className="subtitle">Application foundation</p>
      <section
        className={`status status-${state.kind}`}
        aria-live="polite"
        aria-busy={state.kind === 'checking'}
        data-testid="status"
      >
        <h2>
          <span className="status-icon" aria-hidden="true">
            {state.kind === 'available' ? '✓' : state.kind === 'checking' ? '…' : '!'}
          </span>
          {copy.title}
        </h2>
        <p>{copy.detail}</p>
        {state.kind === 'degraded' || state.kind === 'unavailable' ? (
          <button type="button" onClick={retry}>
            Try again
          </button>
        ) : null}
      </section>
      <footer>
        {build ? (
          <p data-testid="build">
            Version {build.version} · build {build.build}
          </p>
        ) : null}
      </footer>
    </main>
  );
}
