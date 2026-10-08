/* Deterministic document bodies, review dates and version history for the Docs page (copied from the old Knowledge route). */

import type { Doc } from '@/lib/app-data';

export type Block =
  | { k: 'h'; t: string }
  | { k: 'p'; t: string }
  | { k: 'list'; items: string[] }
  | { k: 'check'; items: [string, boolean][] }
  | { k: 'code'; t: string }
  | { k: 'table'; head: string[]; rows: string[][] }
  | { k: 'quote'; t: string };

/** Review dates (October 2026 unless stated); `overdue` means the date is before Tue 6 Oct. */
export const REVIEW: Record<string, { date: string; overdue?: boolean }> = {
  d1: { date: '20 Oct' }, d2: { date: '13 Oct' }, d3: { date: '9 Oct' }, d4: { date: '1 Nov' },
  d5: { date: '24 Jul', overdue: true }, d6: { date: '16 Oct' }, d7: { date: '—' }, d8: { date: '2 Oct', overdue: true },
  d9: { date: '30 Oct' }, d10: { date: '—' }, d11: { date: '1 Jan' },
};

const BODIES: Record<string, Block[]> = {
  d2: [
    { k: 'h', t: 'Scope' },
    { k: 'p', t: 'Heal review, Android emulator pool and spoken tests ship in v1.4. Device matrix UI moves to v1.5.' },
    { k: 'check', items: [['Scope frozen', true], ['214 tests green', false], ['Docs updated', true], ['Go / no-go Thu 8 Oct', false]] },
    { k: 'h', t: 'Risks' },
    { k: 'table', head: ['Risk', 'Owner', 'Status'], rows: [['Emulator boot > 90s', 'Dev Patel', 'Open'], ['Heal loop on checkout', 'Katriel', 'Fixed']] },
  ],
  d3: [
    { k: 'h', t: 'When a heal is proposed' },
    { k: 'check', items: [['Open the diff', true], ['Replay the failing step', true], ['Accept or reject in the drawer', false]] },
    { k: 'code', t: 'optestra heal review --run 4471 --accept' },
  ],
  d4: [
    { k: 'quote', t: '1 credit = 1¢. Meter usage, never gate features.' },
    { k: 'table', head: ['Plan', 'Price', 'Credits'], rows: [['Free', '$0', '100'], ['Solo Dev', '$8', '1,600'], ['Tester', '$19', '4,000'], ['Team', '$49', '12,000']] },
    { k: 'h', t: 'Guardrails' },
    { k: 'list', items: ['Raise action prices, never plan prices', '≥ 80% margin per action', 'Top-ups never beat a plan'] },
  ],
  d5: [
    { k: 'h', t: 'Audience' },
    { k: 'p', t: 'Developers who need disposable inboxes in tests. Security teams auditing mail flows.' },
    { k: 'h', t: 'Voice' },
    { k: 'list', items: ['Plain, technical, no hype', 'Show the API call first', 'Free tier forever'] },
    { k: 'quote', t: 'Pricing section still lists the 2025 Pro plan.' },
  ],
  d6: [
    { k: 'h', t: 'Endpoints' },
    { k: 'code', t: 'GET  /v2/inboxes/{id}/messages?cursor=…\nPOST /v2/inboxes\nDELETE /v2/inboxes/{id}' },
    { k: 'table', head: ['Limit', 'Free', 'Pro'], rows: [['Requests / min', '60', '600'], ['Inboxes', '5', '500']] },
  ],
  d8: [
    { k: 'h', t: 'Writing a rule' },
    { k: 'check', items: [['Reference the CVE', true], ['Add a failing fixture', true], ['Run false-positive suite', false]] },
    { k: 'code', t: 'ax rules test ./packs/cve-2026-4471.yaml' },
    { k: 'quote', t: 'Rule pack 3.2 changed the fixture layout.' },
  ],
};

const BY_TYPE: Record<Doc['type'], Block[]> = {
  Brief: [{ k: 'h', t: 'Audience' }, { k: 'p', t: 'Who it is for, and the one problem it solves.' }, { k: 'h', t: 'Voice' }, { k: 'list', items: ['Plain words', 'Proof over claims'] }],
  SOP: [{ k: 'h', t: 'Steps' }, { k: 'check', items: [['Prepare', true], ['Run', false], ['Record outcome', false]] }],
  Spec: [{ k: 'h', t: 'Goal' }, { k: 'p', t: 'What ships, what does not, and how we know it works.' }, { k: 'list', items: ['Acceptance criteria', 'Out of scope'] }],
  Decision: [{ k: 'quote', t: 'Decision recorded with options and owner.' }, { k: 'list', items: ['Option A', 'Option B'] }],
  Meeting: [{ k: 'h', t: 'Notes' }, { k: 'list', items: ['Export fails above 10k rows', 'Wants CSV + JSON', 'Follow up Fri'] }, { k: 'check', items: [['Create task', false]] }],
  'Release notes': [{ k: 'h', t: 'Changes' }, { k: 'list', items: ['Faster heals', 'Android beta', 'Bug fixes'] }],
};

export const bodyFor = (d: Doc): Block[] => BODIES[d.id] ?? BY_TYPE[d.type];

export type Version = { v: number; who: string; when: string; delta: number; note: string };
const WHEN = ['1h', '1d', '3d', '6d', '12d', '20d', '34d', '41d'];
const NOTES = ['Edited', 'Added risks', 'AI summary', 'Restructured', 'Fixed links', 'Created'];
export function versionsFor(d: Doc): Version[] {
  const n = (d.words % 4) + 3;
  const who = [d.owner, 'ag-docs', 'km', 'dp'];
  return Array.from({ length: n }, (_, i) => ({
    v: n - i,
    who: who[i % who.length],
    when: d.id === 'd5' ? ['74d', '90d', '120d', '160d', '200d', '260d'][i] ?? '300d' : WHEN[i] ?? '60d',
    delta: i === n - 1 ? Math.round(d.words * 0.6) : ((d.words * (i + 3)) % 140) - 40,
    note: i === n - 1 ? 'Created' : NOTES[(d.words + i) % (NOTES.length - 1)],
  }));
}

/** How often AI cited each doc in the last 7 days. */
export const CITED: Record<string, number> = { d1: 14, d2: 22, d3: 9, d4: 17, d5: 0, d6: 31, d7: 0, d8: 6, d9: 0, d10: 0, d11: 3 };
