import { useEffect, useRef, useState } from 'react';
import { Link, useRouter } from '../router.tsx';
import { routeHref } from '../shell/registry.ts';
import {
  announceNotificationsChanged,
  notifications,
  NOTIFICATIONS_CHANGED,
  PROFILE_CHANGED,
  type Counts,
  type NotificationItem,
} from './client.ts';
import { explainNotify, relativeTime, useNow, useOnline, when, type Explained } from './shared.tsx';

/**
 * The header bell (4B): an unread count that stays honest (re-read on focus, on a slow interval
 * while the tab is visible, when the connection returns, and after any change made in this tab), and
 * a short list of the five most recent notifications.
 */

export const BELL_RECENT = 5;
const POLL_MS = 60_000;

/** `99+` past ninety-nine, so the badge never grows wide. */
export const capCount = (n: number) => (n > 99 ? '99+' : String(n));

export function bellName(counts: Counts | null): string {
  return counts ? `Notifications, ${counts.unread} unread` : 'Notifications';
}

export function useBellCounts(ws: string | null) {
  const [state, setState] = useState<{ ws: string; counts: Counts } | null>(null);
  useEffect(() => {
    if (!ws) return;
    let alive = true;
    let latest = 0;
    const refetch = () => {
      const mine = ++latest;
      notifications.counts(ws).then(
        (counts) => {
          if (alive && mine === latest) setState({ ws, counts });
        },
        // A failed read keeps the last count; the panel explains the problem when it is opened.
        () => undefined,
      );
    };
    refetch();
    const onVisible = () => {
      if (!document.hidden) refetch();
    };
    const timer = setInterval(() => {
      if (!document.hidden) refetch();
    }, POLL_MS);
    window.addEventListener('focus', refetch);
    window.addEventListener('online', refetch);
    window.addEventListener(NOTIFICATIONS_CHANGED, refetch);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('focus', refetch);
      window.removeEventListener('online', refetch);
      window.removeEventListener(NOTIFICATIONS_CHANGED, refetch);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ws]);
  return { counts: state && state.ws === ws ? state.counts : null };
}

export const recordPath = (ws: string, r: NonNullable<NotificationItem['record']>) =>
  r.type === 'project'
    ? routeHref('project', { ws, prj: r.id })
    : routeHref('task', { ws, tsk: r.id });

/** Opening a notification's record marks it read (idempotent; a failure changes nothing). */
export function markReadOnOpen(ws: string, n: NotificationItem): void {
  if (n.state !== 'unread') return;
  void notifications.setState(ws, n.id, 'read').then(announceNotificationsChanged, () => undefined);
}

export function BellPanel({ ws, close }: { ws: string; close: () => void }) {
  const online = useOnline();
  const now = useNow();
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; rows: NotificationItem[] }
    | { status: 'failed'; e: Explained }
  >({ status: 'loading' });
  const [marking, setMarking] = useState<Explained | null>(null);
  useEffect(() => {
    let active = true;
    notifications.list(ws, { limit: BELL_RECENT }).then(
      (r) => active && setState({ status: 'ready', rows: r.data }),
      (err: unknown) => active && setState({ status: 'failed', e: explainNotify(err, 'loading') }),
    );
    return () => {
      active = false;
    };
  }, [ws, nonce]);
  const markAll = async () => {
    setMarking(null);
    try {
      await notifications.bulk(ws, { all: { tab: 'all' } }, 'read');
      announceNotificationsChanged();
      setNonce((n) => n + 1);
    } catch (err) {
      setMarking(explainNotify(err, 'marking them read'));
    }
  };
  const retry = () => {
    setState({ status: 'loading' });
    setNonce((n) => n + 1);
  };
  const unreadHere = state.status === 'ready' && state.rows.some((r) => r.state === 'unread');
  return (
    <div className="bell-panel">
      {state.status === 'loading' ? (
        <p className="popover-text loading" role="status">
          Loading notifications…
        </p>
      ) : null}
      {state.status === 'failed' ? (
        <div className="popover-text" role="alert">
          <p>
            {!online
              ? "You're offline. Notifications will load when you're back online."
              : state.e.message}
          </p>
          <button type="button" className="button button-secondary" onClick={retry}>
            Retry
          </button>
        </div>
      ) : null}
      {state.status === 'ready' && !state.rows.length ? (
        <p className="popover-text">You're all caught up.</p>
      ) : null}
      {state.status === 'ready' && state.rows.length ? (
        <ul className="plain-list bell-list" aria-label="Recent notifications">
          {state.rows.map((n) => (
            <li key={n.id} className="bell-item">
              <p className="bell-summary">
                {n.state === 'unread' ? (
                  <>
                    <span className="unread-mark" aria-hidden="true">
                      ●{' '}
                    </span>
                    <span className="visually-hidden">Unread. </span>
                  </>
                ) : null}
                {n.summary}
              </p>
              {n.available && n.record ? (
                <Link
                  to={recordPath(ws, n.record)}
                  onClick={() => {
                    markReadOnOpen(ws, n);
                    close();
                  }}
                >
                  {n.record.title}
                </Link>
              ) : null}
              <time className="hint" dateTime={n.last_occurred_at} title={when(n.last_occurred_at)}>
                {relativeTime(n.last_occurred_at, now)}
              </time>
            </li>
          ))}
        </ul>
      ) : null}
      {marking ? (
        <p className="popover-text" role="alert">
          {marking.message}
        </p>
      ) : null}
      {unreadHere ? (
        <button
          type="button"
          className="button button-ghost bell-mark-all"
          disabled={!online}
          onClick={() => void markAll()}
        >
          Mark all read
        </button>
      ) : null}
      <Link to={routeHref('notifications', { ws })} onClick={close}>
        Open notification centre
      </Link>
      <Link to={routeHref('notification_settings', { ws })} onClick={close}>
        Notification settings
      </Link>
    </div>
  );
}

// -------------------------------------------------------------------------------------------------
// Browser notifications: shown only after the person turned them on and the browser allows them
// -------------------------------------------------------------------------------------------------

const POLL_BROWSER_MS = 30_000;

export const browserSupported = (): boolean => typeof Notification !== 'undefined';

/**
 * While the app is open and browser notifications are on and permitted, asks for what is waiting,
 * shows each as a browser notification (title only, tagged with its delivery so it never doubles),
 * and reports back whether it was shown or declined. Pauses while offline or hidden. Renders nothing.
 */
export function useBrowserDelivery(ws: string | null, armed: boolean) {
  const { navigate } = useRouter();
  const busy = useRef(false);
  useEffect(() => {
    if (!ws || !armed || !browserSupported() || Notification.permission !== 'granted') return;
    let active = true;
    const poll = async () => {
      if (busy.current || document.hidden || !navigator.onLine) return;
      busy.current = true;
      try {
        const pending = await notifications.browserPending(ws);
        for (const item of pending) {
          if (!active) return;
          let outcome: 'shown' | 'declined' = 'shown';
          try {
            const shown = new Notification(item.title, { tag: item.delivery });
            shown.onclick = () => {
              window.focus();
              if (item.path.startsWith('/') && !item.path.startsWith('//')) navigate(item.path);
              shown.close();
            };
          } catch {
            outcome = 'declined';
          }
          await notifications.ack(ws, item.delivery, outcome).catch(() => undefined);
        }
      } catch {
        // Offline or a failed read: the next tick asks again.
      } finally {
        busy.current = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_BROWSER_MS);
    const onVisible = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [ws, armed, navigate]);
}

/** Whether this person has browser notifications on, and the browser allows them. */
export function BrowserNotifier({ ws }: { ws: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    let active = true;
    // Without the browser's own permission nothing can be shown, so the page asks the server nothing.
    const load = () =>
      !browserSupported() || Notification.permission !== 'granted'
        ? void setArmed(false)
        : notifications.profile(ws).then(
            (p) => active && setArmed(p.browser_enabled && p.browser_permission === 'granted'),
            () => undefined,
          );
    void load();
    window.addEventListener(PROFILE_CHANGED, load);
    return () => {
      active = false;
      window.removeEventListener(PROFILE_CHANGED, load);
    };
  }, [ws]);
  useBrowserDelivery(ws, armed);
  return null;
}
