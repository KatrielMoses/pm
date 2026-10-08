/*
 * Release data for the project Release tab (absorbs the old Releases page). Each release belongs
 * to one project; suites and defects per release. v1.4 uses the shared lib/app-data rows.
 */

import { defects as opDefects, releases, suites as opSuites, type Release } from '@/lib/app-data';

export type Suite = { name: string; total: number; pass: number; fail: number; flaky: number; history: number[] };
export type DefectStatus = 'open' | 'fixing' | 'merged' | 'verified' | 'deferred';
export type Defect = { id: string; title: string; severity: 'S1' | 'S2' | 'S3'; status: DefectStatus; owner: string; env: string; pr: string | null; repro: string };

/** Which project ships which release. */
const RELEASE_OF: Record<string, string> = { p1: 'rl1', p5: 'rl2', p8: 'rl3' };
export const releaseFor = (projectId: string): Release | undefined => releases.find((r) => r.id === RELEASE_OF[projectId]);

/* history: 1 pass, 0 fail, 2 flaky (oldest → newest) */
export const suitesByRelease: Record<string, Suite[]> = {
  rl1: opSuites.map((s) => ({ ...s, history: s.history.map((h, i) => (h === 1 && s.flaky && i === 2 ? 2 : h)) })),
  rl2: [
    { name: 'Inbox read', total: 30, pass: 27, fail: 3, flaky: 0, history: [1, 1, 0, 1, 0, 0, 1, 0, 1, 0] },
    { name: 'OAuth', total: 22, pass: 19, fail: 2, flaky: 1, history: [1, 1, 1, 2, 1, 0, 1, 1, 0, 1] },
    { name: 'Rate limits', total: 18, pass: 17, fail: 1, flaky: 0, history: [1, 1, 1, 1, 1, 1, 0, 0, 1, 0] },
    { name: 'Webhooks', total: 26, pass: 25, fail: 0, flaky: 0, history: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
  ],
  rl3: [
    { name: 'CVE rules', total: 80, pass: 80, fail: 0, flaky: 0, history: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
    { name: 'False positives', total: 60, pass: 60, fail: 0, flaky: 0, history: [1, 1, 2, 1, 1, 1, 1, 1, 1, 1] },
  ],
};

export const defectsByRelease: Record<string, Defect[]> = {
  rl1: opDefects.map((d) => ({ ...d })),
  rl2: [
    { id: 'DF-41', title: '429 headers missing', severity: 'S1', status: 'fixing', owner: 'km', env: 'Dev', pr: '#341', repro: 'Always' },
    { id: 'DF-42', title: 'Token refresh race', severity: 'S1', status: 'open', owner: 'km', env: 'Dev', pr: null, repro: 'Sometimes' },
    { id: 'DF-43', title: 'Cursor skips last page', severity: 'S2', status: 'merged', owner: 'km', env: 'Staging', pr: '#336', repro: 'Always' },
    { id: 'DF-44', title: 'Webhook retry jitter', severity: 'S3', status: 'open', owner: 'ar', env: 'Dev', pr: null, repro: 'Rare' },
  ],
  rl3: [
    { id: 'DF-21', title: 'Rule 88 false positive', severity: 'S2', status: 'verified', owner: 'ln', env: 'Prod', pr: '#74', repro: 'Always' },
    { id: 'DF-22', title: 'Slow regex on large repos', severity: 'S3', status: 'verified', owner: 'ln', env: 'Prod', pr: '#75', repro: 'Sometimes' },
  ],
};

/** Defects that map to a task open the task drawer. */
export const defectTask: Record<string, string> = { 'DF-31': 'w3', 'DF-32': 'w2', 'DF-27': 'w7', 'DF-29': 'w9', 'DF-41': 'w18', 'DF-42': 'w19', 'DF-43': 'w22' };

/** S1/S2 defects block the release until verified or deferred. */
export const isBlocker = (d: Defect) => (d.severity === 'S1' || d.severity === 'S2') && d.status !== 'verified' && d.status !== 'deferred';
