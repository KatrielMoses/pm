/*
 * Inbox: one list for three sources. Captured items (lib/app-data `inbox`), agent runs that need a
 * human (./runs, copied from the old Agents page) and notifications (lib/app-data `notifications`,
 * minus the ones that only repeat an agent run). Times are minutes before "now" (Tue 6 Oct 10:40).
 */

import { NOW, type BrandId } from '@/lib/data';
import { inbox as inboxItems, notifications, type Notice } from '@/lib/app-data';
import { seedRuns, type AgentRun, type RunState } from './runs';

export type Kind = 'captured' | 'review' | 'alert';
export type Tab = 'all' | 'captured' | 'reviews' | 'alerts';

/** '8m' | '2h' | '1d' → minutes ago */
export const agoMin = (t: string) => {
  const n = parseFloat(t);
  if (Number.isNaN(n)) return 9999;
  return t.endsWith('d') ? n * 1440 : t.endsWith('h') ? n * 60 : n;
};
/** 'HH:MM' today → minutes ago */
export const clockAgo = (hhmm: string, plus = 0) => {
  if (!/^\d\d:\d\d$/.test(hhmm)) return 9999;
  const [h, m] = hhmm.split(':').map(Number);
  return Math.max(1, NOW.minutes - (h * 60 + m + plus));
};
export const fmtAgo = (min: number) => (min < 60 ? `${Math.round(min)}m` : min < 1440 ? `${Math.floor(min / 60)}h` : `${Math.floor(min / 1440)}d`);

/** Runs a person should see: finished work to review, failures, approvals and live runs (so they can stop them). */
export const INBOX_RUN_STATES: RunState[] = ['review', 'failed', 'waiting', 'running'];
export const runMinutesAgo = (r: AgentRun) => (r.state === 'running' ? clockAgo(r.started) : clockAgo(r.started, r.mins));

/** Notifications that only repeat an agent run live in Reviews instead (one object, one place). */
export const isRunEcho = (n: Notice) => n.kind === 'review' || (n.kind === 'failure' && /agent/i.test(n.text));

export type NoticeCtx = { body: string; who?: string; quote?: string; open: { label: string; taskKey?: string; href?: string } };
export const NOTICE_CTX: Record<string, NoticeCtx> = {
  n3: {
    body: 'Comment on OP-214 · Android emulator boot timeout',
    who: 'dp',
    quote: '@Katriel the emulator image upgrade (OP-216) is blocking this. Can you approve the API 36 change today?',
    open: { label: 'Open OP-214', taskKey: 'OP-214' },
  },
  n4: { body: 'Rate-limit regression was due Mon 5 Oct. Inbox API v2 is 6h over plan.', open: { label: 'Open MA-88', taskKey: 'MA-88' } },
  n5: { body: 'AI spend is $18.40 of the $40 monthly cap. Projected $34.10 by 31 Oct.', open: { label: 'Open AI & limits', href: '/app/settings#ai' } },
  n6: { body: 'api.mailaccess.io/hook returned 500 twice for release.approved. Retries are paused after 3 tries.', open: { label: 'Open integrations', href: '/app/settings#integrations' } },
  n7: { body: 'Optestra v1.4: 206 of 214 tests pass, 2 blockers open. The decision is due Thu 8 Oct.', open: { label: 'Open release', href: '/app/projects' } },
};

export type Row = {
  id: string; kind: Kind; ref: string; brand: BrandId | null; title: string; meta?: string; min: number; unread: boolean;
  badge?: { tone: 'red' | 'amber' | 'blue' | 'accent' | 'neutral'; label: string };
};

export const tabOf: Record<Kind, Exclude<Tab, 'all'>> = { captured: 'captured', review: 'reviews', alert: 'alerts' };

/** Unread count before any interaction; the sidebar badge uses this so it matches the Inbox. */
export function initialUnread(brand: string | null) {
  const inBrand = (b: string | null | undefined) => !brand || !b || b === brand;
  const cap = inboxItems.filter((it) => inBrand(it.detected.brand) && agoMin(it.time) < 60).length;
  const rev = seedRuns.filter((r) => INBOX_RUN_STATES.includes(r.state) && r.state !== 'running' && (!brand || r.brand === brand)).length;
  const al = notifications.filter((n) => !isRunEcho(n) && !n.read && inBrand(n.brand)).length;
  return cap + rev + al;
}
