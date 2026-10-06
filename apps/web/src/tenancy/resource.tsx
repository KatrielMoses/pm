import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../api.ts';
import { Link } from '../router.tsx';
import { Banner } from '../ui/feedback.tsx';
import { NotAvailableBody, useMarkNotAvailable } from '../ui/layout.tsx';

export type Resource<T> =
  { status: 'loading' } | { status: 'ready'; data: T } | { status: 'failed'; error: unknown };

/**
 * Loads data per key (`wait` defers loading). `retry` shows the loading state again; `reload` keeps showing the current
 * data until the new data arrives. State is only set from the request's own callbacks.
 */
export function useResource<T>(
  load: () => Promise<T>,
  key: string,
  options: { keepOnRefreshError?: boolean } = {},
) {
  const [entry, setEntry] = useState<{ key: string; state: Resource<T> }>({
    key,
    state: { status: 'loading' },
  });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    // `wait` = not ready to load yet (e.g. the session is still being resolved).
    if (key === 'wait') return;
    let active = true;
    load().then(
      (data) => active && setEntry({ key, state: { status: 'ready', data } }),
      // With `keepOnRefreshError` (2D REL-001: the task page), a failed background refresh keeps
      // what is already on screen, so going offline during a reload never discards the page or
      // what the person is typing. First loads, retries, and other keys still show the failure.
      (error: unknown) =>
        active &&
        setEntry((prev) =>
          options.keepOnRefreshError && prev.key === key && prev.state.status === 'ready'
            ? prev
            : { key, state: { status: 'failed', error } },
        ),
    );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);
  const state: Resource<T> = entry.key === key ? entry.state : { status: 'loading' };
  return {
    state,
    reload: () => setNonce((n) => n + 1),
    retry: () => {
      setEntry({ key, state: { status: 'loading' } });
      setNonce((n) => n + 1);
    },
    set: (data: T) => setEntry({ key, state: { status: 'ready', data } }),
  };
}

/**
 * Renders loading, not-found, forbidden, offline, and error states for a page resource. Not
 * found and no access look identical: the page never says whether something exists (0C AT-02).
 */
export function ResourceView<T>({
  resource,
  onRetry,
  what,
  children,
}: {
  resource: Resource<T>;
  onRetry: () => void;
  what: string;
  children: (data: T) => ReactNode;
}) {
  if (resource.status === 'ready') return <>{children(resource.data)}</>;
  if (resource.status === 'loading')
    return (
      <p className="loading" role="status" aria-live="polite">
        Loading {what}…
      </p>
    );
  return <LoadProblem error={resource.error} onRetry={onRetry} what={what} />;
}

export function LoadProblem({
  error,
  onRetry,
  what,
}: {
  error: unknown;
  onRetry: () => void;
  what: string;
}) {
  const code = error instanceof ApiError ? error.code : 'internal_error';
  const mark = useMarkNotAvailable();
  const missing = code === 'not_found';
  useEffect(() => {
    if (missing) mark?.();
  }, [missing, mark]);
  const retry = (
    <button type="button" className="button button-secondary" onClick={onRetry}>
      Try again
    </button>
  );
  // ST-41: not found and not authorized are one canonical state; inside a page the whole page
  // switches to it (heading and title included), so nothing about the target is disclosed.
  if (missing) return <NotAvailableBody />;
  if (code === 'forbidden')
    return (
      <Banner tone="warning" title="You don't have permission to do this">
        Ask a workspace owner if you need access.
      </Banner>
    );
  if (code === 'unauthenticated')
    return (
      <Banner
        tone="danger"
        title="Sign in again to continue"
        action={<Link to="/sign-in">Sign in</Link>}
      />
    );
  if (code === 'offline' || code === 'network')
    return (
      <Banner tone="warning" title="You're offline" action={retry}>
        Check your connection, then try again.
      </Banner>
    );
  return (
    <Banner tone="danger" title={`We couldn't load this ${what}`} action={retry}>
      Try again in a moment.
      {error instanceof ApiError && error.requestId ? ` Reference: ${error.requestId}` : ''}
    </Banner>
  );
}
