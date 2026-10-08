/* Builder vocabulary, icons and deterministic run history for the Automations prototype. */

import {
  ArrowRight, Bell, Bot, CalendarClock, ClipboardList, Clock, Eye, FlaskConical, GitMerge, MessageCircle, Paperclip, Plus, Sparkles, Tag, Timer,
  TriangleAlert, UserRound, Webhook, Zap,
} from 'lucide-react';
import type { BrandId } from '@/lib/data';

export type Flow = {
  id: string; brand: BrandId | null; name: string; trigger: string; conditions: string[]; logic: 'AND' | 'OR'; actions: string[];
  on: boolean; runs: number; fails: number; last: string; series: number[]; previewed: boolean; draft?: boolean;
};

export const TRIGGERS = ['Test failed', 'Every day 08:00', 'PR merged', 'Form submitted', 'No update 7d', 'Status changed', 'Agent run failed', 'Due date passed', 'Comment added', 'Webhook received'];
export const CONDITIONS = ['Suite is critical', 'Has linked task', 'No acceptance check', 'Brand is API Access', 'Status not Done', 'Priority is Urgent', 'Label is bug', 'Assignee is set'];
export const ACTIONS = ['Create task', 'Create defect', 'Attach evidence', 'Notify owner', 'Move to Review', 'Request review', 'Assign Lea', 'Label stale', 'AI briefing', 'Run agent', 'Send webhook', 'Delay 1h', 'Due +2d'];

export const triggerIcon = (t: string) =>
  t.startsWith('Test') ? FlaskConical : t.startsWith('Every') ? Clock : t.startsWith('PR') ? GitMerge : t.startsWith('Form') ? ClipboardList
    : t.startsWith('No update') ? Timer : t.startsWith('Agent') ? Bot : t.startsWith('Due') ? CalendarClock : t.startsWith('Comment') ? MessageCircle
      : t.startsWith('Webhook') ? Webhook : Zap;

export const actionIcon = (a: string) => {
  const x = a.toLowerCase();
  if (x.includes('create')) return Plus;
  if (x.includes('notify') || x.includes('send in app')) return Bell;
  if (x.includes('attach')) return Paperclip;
  if (x.includes('move')) return ArrowRight;
  if (x.includes('review')) return Eye;
  if (x.includes('assign')) return UserRound;
  if (x.includes('label')) return Tag;
  if (x.includes('ai')) return Sparkles;
  if (x.includes('agent')) return Bot;
  if (x.includes('webhook')) return Webhook;
  if (x.includes('delay')) return Timer;
  if (x.includes('due')) return CalendarClock;
  return Zap;
};

export const TEMPLATES = [
  { name: 'Overdue → nudge', trigger: 'Due date passed', conditions: ['Status not Done'], actions: ['Notify owner', 'Label stale'] },
  { name: 'Agent failed → alert', trigger: 'Agent run failed', conditions: [], actions: ['Notify owner', 'Create task'] },
  { name: 'Release → webhook', trigger: 'Status changed', conditions: ['Label is bug'], actions: ['Send webhook'] },
  { name: 'Comment → AI reply', trigger: 'Comment added', conditions: ['Assignee is set'], actions: ['AI briefing', 'Notify owner'] },
];

export type Run = { id: string; t: string; event: string; status: 'ok' | 'failed' | 'skipped'; ms: number; steps: [number, number]; error?: string };

const TIMES = ['12m', '1h', '3h', '5h', '9h', '1d', '1d', '2d', '3d'];
const EVENTS: Record<string, string[]> = {
  au1: ['Checkout #4471', 'Android smoke #212', 'Auth #4468', 'Checkout #4460', 'Heal engine #4452', 'Billing #4449', 'Checkout #4440', 'Android smoke #208', 'Auth #4431'],
  au2: ['Tue 08:00', 'Mon 08:00', 'Sun 08:00', 'Sat 08:00', 'Fri 08:00', 'Thu 08:00', 'Wed 08:00', 'Tue 08:00', 'Mon 08:00'],
  au3: ['PR #341', 'PR #339', 'PR #336', 'PR #333', 'PR #331', 'PR #330', 'PR #328', 'PR #325', 'PR #322'],
  au4: ['Acme sandbox', 'Globex intro', 'Initech keys', 'Umbrella pilot', 'Hooli trial', 'Stark API', 'Wayne docs', 'Acme follow-up', 'Soylent'],
};
const ERRORS: Record<string, string[]> = {
  au2: ['Email provider timeout (30s)'],
  au4: ['Lea Novak not in brand scope', 'Form missing contact email'],
};

export function runsFor(f: Flow): Run[] {
  if (f.runs === 0) return [];
  const ev = EVENTS[f.id] ?? TIMES.map((_, i) => `${f.trigger} #${120 - i * 3}`);
  const failAt = f.fails ? (f.id === 'au4' ? [1, 4] : [3]).slice(0, f.fails) : [];
  return TIMES.slice(0, Math.min(8, f.runs)).map((t, i) => {
    const failed = failAt.includes(i);
    const skipped = !failed && f.id === 'au1' && i === 6;
    const n = f.actions.length || 1;
    return {
      id: `${f.id}-${i}`, t: i === 0 ? f.last : t, event: ev[i % ev.length],
      status: failed ? 'failed' : skipped ? 'skipped' : 'ok',
      ms: failed ? 3000 + i * 13 : 180 + ((i * 97 + f.runs * 13) % 900),
      steps: failed ? [Math.max(0, n - 1), n] : skipped ? [0, n] : [n, n],
      error: failed ? ERRORS[f.id]?.[failAt.indexOf(i)] ?? 'Step timed out' : skipped ? 'Loop guard: same record 3× in 1h' : undefined,
    };
  });
}

/** Simulated effects over the last 7 days, shown before activation. */
export function previewFor(f: Flow) {
  const hits = Math.max(2, f.series.slice(-7).reduce((a, b) => a + b, 0) || (f.trigger.startsWith('Every') ? 7 : 5));
  return {
    hits,
    effects: f.actions.map((a, i) => ({ a, n: a.startsWith('Delay') ? 0 : Math.max(1, hits - i), sample: SAMPLES[a] ?? 'Owner' })),
    monthly: hits * 4,
    loop: f.actions.some((a) => a === 'Move to Review') && f.trigger === 'Status changed',
  };
}
const SAMPLES: Record<string, string> = {
  'Create task': 'MA-94, MA-95…', 'Create defect': 'DF-33, DF-34…', 'Attach evidence': 'Screenshots + logs', 'Notify owner': 'Dev Patel, Katriel',
  'Move to Review': 'OP-212, MA-91…', 'Request review': 'Katriel', 'Assign Lea': 'Lea Novak', 'Label stale': 'w15, w27…', 'AI briefing': '1 per run',
  'Run agent': 'Dev agent', 'Send webhook': 'hooks.optestra.dev', 'Delay 1h': '—', 'Due +2d': 'Thu 8 Oct', 'Send in app + email': 'Katriel',
};

export const warnIcon = TriangleAlert;
