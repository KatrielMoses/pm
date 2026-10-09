import { describe, expect, it } from 'vitest';
import {
  parseCheckin,
  parseGoalCreate,
  parseGoalLink,
  parseGoalList,
  parseGoalUpdate,
  parseKeyResultCreate,
  parseKeyResultUpdate,
  parsePortfolio,
  parsePortfolioMembers,
  parseOverview,
} from '../../src/goals/validation.ts';

const Q4 = { kind: 'quarter', year: 2026, index: 4 };
const KR = 'kr_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const PRJ = 'prj_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const issues = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { issues: Array<{ pointer: string; code: string }> }).issues.map(
      (i) => `${i.pointer}:${i.code}`,
    );
  }
  throw new Error('expected the parser to refuse');
};

/** ADR-0028: every parser refuses unknown fields and says exactly where, without echoing input. */
describe('goal inputs (5B)', () => {
  it('accepts a minimal goal and trims text', () => {
    const g = parseGoalCreate({ title: '  Grow  ', period: Q4 });
    expect(g).toMatchObject({
      title: 'Grow',
      status: 'active',
      basis: 'manual',
      brand: null,
      project: null,
      owner: null,
    });
    expect(g.period).toEqual({ kind: 'quarter', start: '2026-10-01', end: '2026-12-31' });
    expect(
      parseGoalCreate({
        title: 'x',
        period: Q4,
        status: 'draft',
        metric: { unit: ' % ', baseline: 0, target: 100 },
      }).metric,
    ).toEqual({
      unit: '%',
      baseline: 0,
      target: 100,
      current: null,
    });
  });

  it('points at the exact field for every refusal', () => {
    expect(issues(() => parseGoalCreate({ period: Q4 }))).toEqual(['/title:required']);
    expect(issues(() => parseGoalCreate({ title: 'x' }))).toEqual(['/period:required']);
    expect(issues(() => parseGoalCreate({ title: 'x', period: Q4, extra: 1, other: 2 }))).toEqual([
      '/extra:unsupported_field',
      '/other:unsupported_field',
    ]);
    expect(issues(() => parseGoalCreate({ title: 'x', period: { kind: 'decade' } }))).toEqual([
      '/period/kind:invalid_option',
    ]);
    expect(issues(() => parseGoalCreate({ title: 'x', period: { ...Q4, bogus: 1 } }))).toContain(
      '/period/bogus:unsupported_field',
    );
    expect(issues(() => parseGoalCreate({ title: 'x', period: Q4, brand: 'nope' }))).toEqual([
      '/brand:invalid_reference',
    ]);
    expect(
      issues(() =>
        parseGoalCreate({
          title: 'x',
          period: Q4,
          brand: 'br_01HZZZZZZZZZZZZZZZZZZZZZZZ',
          project: PRJ,
        }),
      ),
    ).toEqual(['/project:conflicting']);
    expect(issues(() => parseGoalCreate({ title: 'x', period: Q4, status: 'achieved' }))).toEqual([
      '/status:invalid_option',
    ]);
    expect(issues(() => parseGoalCreate({ title: 'x', period: Q4, basis: 'vibes' }))).toEqual([
      '/basis:invalid_option',
    ]);
    expect(issues(() => parseGoalCreate({ title: 'x'.repeat(201), period: Q4 }))).toEqual([
      '/title:too_long',
    ]);
    expect(
      issues(() =>
        parseGoalCreate({ title: 'x', period: Q4, metric: { baseline: 1e13, target: 5 } }),
      ),
    ).toEqual(['/metric/baseline:invalid_number', '/metric:incomplete']);
    expect(
      issues(() => parseGoalCreate({ title: 'x', period: Q4, metric: { target: 5 } })),
    ).toEqual(['/metric:incomplete']);
    expect(
      issues(() => parseGoalCreate({ title: 'x', period: Q4, metric: { current: 5 } })),
    ).toEqual(['/metric/current:conflicting']);
    expect(
      issues(() =>
        parseGoalCreate({ title: 'x', period: Q4, basis: 'key_results', metric: { unit: 'n' } }),
      ),
    ).toEqual(['/metric:conflicting']);
    expect(issues(() => parseGoalCreate('nope'))).toContain('/:invalid_type');
  });

  it('parses updates, requires at least one change, and never echoes input', () => {
    expect(parseGoalUpdate({ version: 3, title: 'New', status: 'achieved' })).toEqual({
      version: 3,
      title: 'New',
      status: 'achieved',
    });
    expect(issues(() => parseGoalUpdate({ version: 3 }))).toEqual(['/:empty']);
    expect(issues(() => parseGoalUpdate({ version: -1, title: 'x' }))).toEqual([
      '/version:invalid_number',
    ]);
    expect(issues(() => parseGoalUpdate({ owner: null }))).toEqual(['/owner:required', '/:empty']);
    expect(issues(() => parseGoalUpdate({ status: 'draft2' }))).toContain('/status:invalid_option');
    const e = (() => {
      try {
        parseGoalUpdate({ title: 'x'.repeat(500) });
      } catch (err) {
        return JSON.stringify(err);
      }
      return '';
    })();
    expect(e).not.toContain('xxxxxxxx');
  });

  it('parses key results and check-ins by what each may carry', () => {
    expect(parseKeyResultCreate({ title: 'KR', basis: 'linked_work' })).toMatchObject({
      basis: 'linked_work',
      metric: { target: null },
    });
    expect(
      issues(() =>
        parseKeyResultCreate({
          title: 'KR',
          basis: 'linked_work',
          metric: { baseline: 0, target: 5 },
        }),
      ),
    ).toEqual(['/metric:conflicting']);
    expect(issues(() => parseKeyResultCreate({ title: 'KR', basis: 'auto' }))).toEqual([
      '/basis:invalid_option',
    ]);
    expect(parseKeyResultUpdate({ version: 1, after: KR })).toMatchObject({ after: KR });
    expect(parseKeyResultUpdate({ version: 1, after: null })).toMatchObject({ after: null });
    expect(issues(() => parseKeyResultUpdate({ version: 1, after: 'x' }))).toContain(
      '/after:invalid_reference',
    );
    expect(parseCheckin({ value: 5, confidence: 'on_track', note: '  fine  ' })).toEqual({
      keyResult: null,
      value: 5,
      percent: null,
      confidence: 'on_track',
      note: 'fine',
    });
    expect(parseCheckin({ percent: 33.333 }).percent).toBe(33.33);
    expect(issues(() => parseCheckin({}))).toEqual(['/:empty']);
    expect(issues(() => parseCheckin({ value: 1, percent: 1 }))).toEqual(['/percent:conflicting']);
    expect(issues(() => parseCheckin({ percent: 101 }))).toEqual(['/percent:invalid_number']);
    expect(issues(() => parseCheckin({ confidence: 'great' }))).toEqual([
      '/confidence:invalid_option',
    ]);
    expect(issues(() => parseCheckin({ note: 'x'.repeat(2001) }))).toEqual(['/note:too_long']);
    expect(
      issues(() => parseCheckin({ note: 'ok', key_result: 'goal_01HZZZZZZZZZZZZZZZZZZZZZZZ' })),
    ).toEqual(['/key_result:invalid_reference']);
  });

  it('parses links, lists, portfolios, and overview queries with bounded values', () => {
    expect(parseGoalLink({ target: PRJ })).toEqual({ target: PRJ, keyResult: null });
    expect(
      parseGoalLink({ target: 'tsk_01HZZZZZZZZZZZZZZZZZZZZZZZ', key_result: KR }).keyResult,
    ).toBe(KR);
    expect(issues(() => parseGoalLink({ target: 'br_01HZZZZZZZZZZZZZZZZZZZZZZZ' }))).toEqual([
      '/target:invalid_reference',
    ]);
    const q = parseGoalList(
      {
        status: 'active,draft,active',
        owner: 'me',
        period: 'current',
        confidence: 'none',
        limit: '25',
        archived: 'true',
        q: 'grow',
      },
      100,
    );
    expect(q).toMatchObject({
      statuses: ['active', 'draft'],
      owner: 'me',
      period: 'current',
      confidence: 'none',
      limit: 25,
      archived: true,
      q: 'grow',
    });
    expect(issues(() => parseGoalList({ status: 'active,great' }, 100))).toEqual([
      '/status:invalid_option',
    ]);
    expect(issues(() => parseGoalList({ limit: '101' }, 100))).toEqual(['/limit:invalid_number']);
    expect(
      issues(() => parseGoalList({ from: '2026-13-01', brand: 'x', q: 'y'.repeat(101) }, 100)),
    ).toEqual(['/brand:invalid_reference', '/from:invalid_date', '/q:too_long']);
    expect(parseGoalList({ brand: 'workspace' }, 100).brand).toBe('workspace');
    expect(
      parsePortfolio({ name: ' Board ', brand: 'br_01HZZZZZZZZZZZZZZZZZZZZZZZ' }, true),
    ).toMatchObject({ name: 'Board' });
    expect(issues(() => parsePortfolio({}, true))).toEqual(['/name:required']);
    expect(issues(() => parsePortfolio({ version: 1 }, false))).toEqual(['/:empty']);
    expect(
      issues(() =>
        parsePortfolio({ brand: 'br_01HZZZZZZZZZZZZZZZZZZZZZZZ', version: 1, name: 'x' }, false),
      ),
    ).toEqual(['/brand:unsupported_field']);
    expect(parsePortfolioMembers({ projects: [PRJ, PRJ], version: 2 }, 5)).toEqual({
      projects: [PRJ],
      version: 2,
    });
    expect(issues(() => parsePortfolioMembers({ projects: [PRJ, 'x'] }, 5))).toEqual([
      '/projects/1:invalid_reference',
    ]);
    expect(issues(() => parsePortfolioMembers({ projects: Array(6).fill(PRJ) }, 5))).toEqual([
      '/projects:too_many',
    ]);
    expect(issues(() => parsePortfolioMembers({}, 5))).toEqual(['/projects:required']);
    expect(
      parseOverview({ status: 'active,paused', health: 'off_track', owner: 'me' }, 100),
    ).toMatchObject({ statuses: ['active', 'paused'], health: ['off_track'], owner: 'me' });
    expect(issues(() => parseOverview({ health: 'ok', portfolio: 'x' }, 100))).toEqual([
      '/portfolio:invalid_reference',
      '/health:invalid_option',
    ]);
  });
});
