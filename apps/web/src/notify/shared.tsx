import { useEffect, useState } from 'react';
import { ApiError } from '../api.ts';
import { explain, type Explained } from '../collab/shared.tsx';
import type { Delivery, DeliveryState, Mode } from './client.ts';

/** Plain wording and small helpers shared by the 4B notification surfaces (UXD-10, UXD-18). */

export { explain, useOnline, when } from '../collab/shared.tsx';
export type { Explained } from '../collab/shared.tsx';

/** Notification-specific wording first; everything else uses the shared plain copy. */
export function explainNotify(error: unknown, what = 'that', keeps = false): Explained {
  if (error instanceof ApiError) {
    if (error.code === 'offline' || error.code === 'network')
      return {
        message: keeps
          ? "You're offline or the connection dropped. Your edits are kept here. Try again when you're back online."
          : "You're offline or the connection dropped. Nothing was changed. Try again when you're back online.",
        kind: 'offline',
        retryable: true,
      };
    if (error.code === 'not_found')
      return {
        message:
          'This is no longer available to you. It may have been moved, deleted, or unshared.',
        kind: 'gone',
        retryable: false,
      };
    if (error.code === 'validation_failed') {
      const first = error.issues[0];
      return {
        message: first?.message ?? 'Check what you entered and try again.',
        kind: 'rejected',
        retryable: false,
      };
    }
  }
  return explain(error, what);
}

export const isStale = (error: unknown): boolean =>
  error instanceof ApiError &&
  (error.code === 'conflict' ||
    error.code === 'precondition_failed' ||
    error.code === 'precondition_required');

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** "5 minutes ago"; the exact time is always the element's `title`. */
export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of UNITS)
    if (abs >= size) return fmt.format(Math.round(seconds / size), unit);
  return fmt.format(Math.round(seconds / 60), 'minute');
}

/** Re-renders now and then so "5 minutes ago" stays honest on a page left open. */
export function useNow(everyMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

export const STATE_LABEL: Record<string, { icon: string; text: string }> = {
  unread: { icon: '●', text: 'Unread' },
  read: { icon: '○', text: 'Read' },
  saved: { icon: '★', text: 'Saved' },
  dismissed: { icon: '✕', text: 'Dismissed' },
};

export const MODE_LABEL: Record<Mode, string> = {
  immediate: 'Immediately',
  digest: 'In the digest',
  muted: 'Off',
};

export const CHANNEL_LABEL: Record<string, string> = {
  all: 'All channels',
  in_app: 'In the app',
  email: 'Email',
  browser: 'Browser',
};

export const DELIVERY_STATE_LABEL: Record<DeliveryState, string> = {
  pending: 'Waiting to send',
  sending: 'Sending',
  delivered: 'Delivered',
  failed: 'Failed',
  dead: 'Failed, no more tries',
  suppressed: 'Not sent',
  deferred_quiet_hours: 'Held until quiet hours end',
  expired: 'Expired before it could be sent',
};

const SUPPRESS_REASON: Record<string, string> = {
  provider_unconfigured: "Email isn't set up",
  access_lost: 'You no longer have access',
  quiet_hours: 'Held for quiet hours',
  muted: 'You muted this',
  email_disabled: 'Email is turned off in your settings',
  superseded: 'Replaced by a newer notification',
  recipient_unavailable: 'The recipient is no longer available',
  no_content: 'Nothing was left to include',
};

const FAILURE_CODE: Record<string, string> = {
  provider_rate_limited: 'The provider asked us to slow down',
  provider_rejected: 'The provider rejected it',
  provider_unreachable: "The provider couldn't be reached",
  transport_error: 'Delivery failed unexpectedly',
  provider_unconfigured: "Email isn't set up",
  client_declined: 'Your browser declined to show it',
};
const FAILURE_CLASS: Record<string, string> = {
  transient: 'A temporary problem',
  permanent: 'A permanent problem',
  unconfigured: 'Not set up',
  rate_limited: 'Slowed down by the provider',
};

/** The reason behind a delivery's state, in words (never content). */
export function deliveryReason(
  d: Pick<Delivery, 'state' | 'suppress_reason' | 'failure_class' | 'failure_code'>,
): string | null {
  if (d.state === 'suppressed' || d.state === 'expired') {
    if (!d.suppress_reason) return null;
    return SUPPRESS_REASON[d.suppress_reason] ?? 'Not needed any more';
  }
  if (d.state === 'deferred_quiet_hours') return SUPPRESS_REASON.quiet_hours!;
  if (d.state === 'failed' || d.state === 'dead') {
    const code = d.failure_code ? (FAILURE_CODE[d.failure_code] ?? null) : null;
    const cls = d.failure_class ? (FAILURE_CLASS[d.failure_class] ?? null) : null;
    return [cls, code].filter(Boolean).join(': ') || 'Delivery failed';
  }
  return null;
}

export const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;
