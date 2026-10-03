import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../api.ts';

type Tone = 'info' | 'success' | 'warning' | 'danger';

/** Persistent banner (0E DS banner): icon + text + colour; status/alert role by severity. */
export function Banner({
  tone,
  title,
  children,
  action,
}: {
  tone: Tone;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const icon = { info: 'ℹ', success: '✓', warning: '!', danger: '!' }[tone];
  return (
    <div className={`banner banner-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <span className="banner-icon" aria-hidden="true">
        {icon}
      </span>
      <div>
        <p className="banner-title">{title}</p>
        {children ? <div className="banner-body">{children}</div> : null}
        {action ? <div className="banner-action">{action}</div> : null}
      </div>
    </div>
  );
}

/** Global offline banner (0E ST-05); network-dependent actions explain they need a connection. */
export function OfflineBanner() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  if (online) return null;
  return (
    <div className="banner banner-warning banner-global" role="status">
      <span className="banner-icon" aria-hidden="true">
        !
      </span>
      <p className="banner-title">
        You're offline. Signing in and account changes need a connection.
      </p>
    </div>
  );
}

/**
 * Explains a failed request (0E ST-03): what failed, why, and what to do. Field-level validation
 * is shown by the form; this covers rate limits, offline, server errors, and safe retry.
 */
export function ProblemBanner({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  const e =
    error instanceof ApiError
      ? error
      : new ApiError({ code: 'internal_error', status: 0, message: '' });
  if (e.code === 'validation_failed' && e.issues.some((i) => i.pointer)) return null;
  const retry = onRetry ? (
    <button type="button" className="button button-secondary" onClick={onRetry}>
      Try again
    </button>
  ) : null;
  switch (e.code) {
    case 'rate_limited': {
      const minutes = Math.max(1, Math.ceil((e.retryAfterSeconds ?? 60) / 60));
      return (
        <Banner tone="warning" title="Too many attempts">
          For your security, wait about {minutes} minute{minutes === 1 ? '' : 's'} before trying
          again.
        </Banner>
      );
    }
    case 'offline':
      return (
        <Banner tone="warning" title="You're offline" action={retry}>
          Check your connection, then try again. Nothing was sent.
        </Banner>
      );
    case 'network':
    case 'service_unavailable':
    case 'internal_error':
    case 'dependency_unavailable':
      return (
        <Banner tone="danger" title="Something went wrong on our side" action={retry}>
          Your input is still here. Try again in a moment.
          {e.requestId ? ` Reference: ${e.requestId}` : ''}
        </Banner>
      );
    case 'forbidden':
      return (
        <Banner tone="danger" title="This request was blocked">
          Reload the page and try again.
        </Banner>
      );
    case 'unauthenticated':
      return <Banner tone="danger" title={e.issues[0]?.message ?? 'Sign in again to continue.'} />;
    default:
      return <Banner tone="danger" title={e.issues[0]?.message ?? e.message} action={retry} />;
  }
}

/** Polite live region for success messages. */
export function Announce({ children }: { children: ReactNode }) {
  return (
    <p className="announce" role="status">
      {children}
    </p>
  );
}
