import { describe, expect, it } from 'vitest';
import {
  afterFailure,
  dedupeKey,
  dueDigestSlot,
  groupKey,
  inQuietWindow,
  localMinutes,
  minimalLine,
  quietEndsAt,
  resolveMode,
  retryDelayMs,
  sentence,
  systemDefault,
  type ModeRow,
} from '../../src/notify/semantics.ts';

const now = new Date('2026-10-08T12:00:00Z');
const row = (o: Partial<ModeRow>): ModeRow => ({
  event_type: '*',
  scope_kind: 'workspace',
  scope_record_id: null,
  channel: 'all',
  mode: 'muted',
  expires_at: null,
  ...o,
});
const scopes = { record: 'rec', project: 'prj', brand: 'brd' };

describe('explicit, privacy-safe defaults (UXD-18)', () => {
  it('keeps in-app complete, email immediate only for what needs a person, and browser opt-in', () => {
    for (const t of ['assignment', 'mention', 'review_requested', 'permission_changed'] as const)
      expect(systemDefault(t, 'email')).toBe('immediate');
    for (const t of ['comment', 'due_soon', 'overdue', 'blocker'] as const)
      expect(systemDefault(t, 'email')).toBe('digest');
    expect(systemDefault('comment', 'browser')).toBe('muted');
    expect(systemDefault('mention', 'browser')).toBe('immediate');
    expect(systemDefault('comment', 'in_app')).toBe('immediate');
  });
});

describe('preference resolution', () => {
  it('falls back to the system default with no rows', () => {
    expect(resolveMode('mention', 'email', scopes, [], [], now)).toEqual({
      mode: 'immediate',
      source: 'system',
    });
  });

  it('lets a more specific scope win whatever its mode, then an exact type, then an exact channel', () => {
    const prefs = [
      row({ scope_kind: 'workspace', mode: 'muted' }),
      row({
        scope_kind: 'brand',
        scope_record_id: 'brd',
        event_type: 'comment',
        channel: 'email',
        mode: 'immediate',
      }),
      row({ scope_kind: 'record', scope_record_id: 'rec', mode: 'muted' }),
    ];
    expect(resolveMode('comment', 'email', scopes, prefs, [], now)).toEqual({
      mode: 'muted',
      source: 'record',
    });
    expect(resolveMode('comment', 'email', { ...scopes, record: null }, prefs, [], now)).toEqual({
      mode: 'immediate',
      source: 'brand',
    });
    expect(resolveMode('mention', 'email', { ...scopes, record: null }, prefs, [], now)).toEqual({
      mode: 'muted',
      source: 'workspace',
    });
    const typed = [
      row({
        scope_kind: 'brand',
        scope_record_id: 'brd',
        event_type: '*',
        channel: 'email',
        mode: 'muted',
      }),
      row({
        scope_kind: 'brand',
        scope_record_id: 'brd',
        event_type: 'mention',
        channel: 'all',
        mode: 'immediate',
      }),
    ];
    // An exact type beats `*`, even through the `all` channel.
    expect(resolveMode('mention', 'email', scopes, typed, [], now).mode).toBe('immediate');
    expect(resolveMode('comment', 'email', scopes, typed, [], now).mode).toBe('muted');
  });

  it('ignores expired mutes and other records', () => {
    const prefs = [
      row({
        scope_kind: 'record',
        scope_record_id: 'rec',
        expires_at: new Date(now.getTime() - 1000),
      }),
      row({ scope_kind: 'record', scope_record_id: 'other' }),
    ];
    expect(resolveMode('mention', 'in_app', scopes, prefs, [], now).source).toBe('system');
  });

  it('applies administrator defaults below the person’s own choices', () => {
    const defaults = [
      row({ scope_kind: 'brand', scope_record_id: 'brd', channel: 'email', mode: 'digest' }),
      row({ scope_kind: 'project', scope_record_id: 'prj', channel: 'email', mode: 'muted' }),
    ];
    expect(resolveMode('mention', 'email', scopes, [], defaults, now)).toEqual({
      mode: 'muted',
      source: 'project_default',
    });
    expect(
      resolveMode('mention', 'email', { ...scopes, project: null }, [], defaults, now).source,
    ).toBe('brand_default');
    const own = [row({ scope_kind: 'workspace', channel: 'email', mode: 'immediate' })];
    expect(resolveMode('mention', 'email', scopes, own, defaults, now)).toEqual({
      mode: 'immediate',
      source: 'workspace',
    });
  });
});

describe('quiet hours', () => {
  it('reads the local clock in the person’s zone', () => {
    expect(localMinutes(new Date('2026-10-08T12:30:00Z'), 'UTC')).toBe(750);
    expect(localMinutes(new Date('2026-10-08T12:30:00Z'), 'Asia/Kolkata')).toBe(18 * 60);
  });

  it('handles windows that wrap midnight and ends them on time', () => {
    expect(inQuietWindow(22 * 60, 7 * 60, 23 * 60)).toBe(true);
    expect(inQuietWindow(22 * 60, 7 * 60, 6 * 60 + 59)).toBe(true);
    expect(inQuietWindow(22 * 60, 7 * 60, 7 * 60)).toBe(false);
    expect(inQuietWindow(9 * 60, 17 * 60, 12 * 60)).toBe(true);
    expect(inQuietWindow(null, null, 0)).toBe(false);
    const late = new Date('2026-10-08T23:10:30Z');
    expect(quietEndsAt(late, 'UTC', 22 * 60, 7 * 60)?.toISOString()).toBe(
      '2026-10-09T07:00:00.000Z',
    );
    expect(quietEndsAt(new Date('2026-10-08T12:00:00Z'), 'UTC', 22 * 60, 7 * 60)).toBeNull();
    // 23:10 UTC is 04:40 in Kolkata, inside that zone's night too: it ends at 07:00 local.
    expect(quietEndsAt(late, 'Asia/Kolkata', 22 * 60, 7 * 60)?.toISOString()).toBe(
      '2026-10-09T01:30:00.000Z',
    );
  });
});

describe('digest slots', () => {
  const profile = {
    digest_cadence: 'daily' as const,
    daily_digest_minute: 8 * 60,
    weekly_digest_weekday: 1,
    weekly_digest_minute: 9 * 60,
  };
  const day = (s: ReturnType<typeof dueDigestSlot>) =>
    s && [s.kind, s.start.toISOString().slice(0, 10), s.end.toISOString().slice(0, 10)];
  it('picks the latest slot whose time has passed, in the person’s zone', () => {
    // Thursday 2026-10-08 12:00 UTC: today's daily slot; the weekly slot is Monday 2026-10-05.
    expect(day(dueDigestSlot(profile, 'UTC', now))).toEqual(['daily', '2026-10-08', '2026-10-09']);
    const weekly = { ...profile, digest_cadence: 'weekly' as const };
    expect(day(dueDigestSlot(weekly, 'UTC', now))).toEqual(['weekly', '2026-10-05', '2026-10-12']);
    // Before 08:00 local the daily slot is yesterday's; on Monday before 09:00, last week's.
    expect(day(dueDigestSlot(profile, 'UTC', new Date('2026-10-05T07:00:00Z')))![1]).toBe(
      '2026-10-04',
    );
    expect(day(dueDigestSlot(weekly, 'UTC', new Date('2026-10-05T07:00:00Z')))![1]).toBe(
      '2026-09-28',
    );
    // A far-east zone is already on the next day.
    expect(
      day(dueDigestSlot(profile, 'Pacific/Auckland', new Date('2026-10-08T20:00:00Z')))![1],
    ).toBe('2026-10-09');
  });
  it('has no slot when digests are off', () => {
    expect(dueDigestSlot({ ...profile, digest_cadence: 'off' }, 'UTC', now)).toBeNull();
  });
});

describe('deduplication, grouping, and retry', () => {
  it('collapses repeats in one bucket and separates other people, records, and buckets', () => {
    const a = dedupeKey('comment', 'r1', 'm1', now, 60);
    expect(dedupeKey('comment', 'r1', 'm1', new Date(now.getTime() + 59 * 60_000 - 1), 60)).toBe(
      dedupeKey('comment', 'r1', 'm1', new Date(now.getTime() + 30 * 60_000), 60),
    );
    expect(dedupeKey('comment', 'r1', 'm2', now, 60)).not.toBe(a);
    expect(dedupeKey('comment', 'r2', 'm1', now, 60)).not.toBe(a);
    expect(dedupeKey('comment', 'r1', 'm1', new Date(now.getTime() + 3_600_000), 60)).not.toBe(a);
    expect(dedupeKey('overdue', 'r1', null, now, 60, '2026-10-07')).toBe('overdue|r1|-|2026-10-07');
  });
  it('groups only low-value repeats about a record', () => {
    expect(groupKey('comment', 'r1')).toBe('comment|r1');
    expect(groupKey('comment', null)).toBeNull();
    for (const t of [
      'mention',
      'integration_failure',
      'permission_changed',
      'review_requested',
    ] as const)
      expect(groupKey(t, 'r1')).toBeNull();
  });
  it('doubles the delay up to a cap and decides what a failure leads to', () => {
    expect([1, 2, 3, 4, 10].map((n) => retryDelayMs(n, 60, 3600) / 1000)).toEqual([
      60, 120, 240, 480, 3600,
    ]);
    expect(afterFailure('transient', 2, 6)).toBe('retry');
    expect(afterFailure('rate_limited', 6, 6)).toBe('dead');
    expect(afterFailure('permanent', 1, 6)).toBe('failed');
    expect(afterFailure('unconfigured', 1, 6)).toBe('suppressed');
  });
});

describe('words', () => {
  it('words events without titles and counts repeats', () => {
    expect(sentence('comment', { reply: true }, 'Ada', 3)).toBe('Ada replied (3 times)');
    expect(sentence('approval_decided', { outcome: 'changes_requested' }, null)).toBe(
      'Someone asked for changes to your review request',
    );
    expect(sentence('assignment', { delegated: true }, 'Ada')).toBe('Ada handed this over to you');
    expect(sentence('integration_failure', {}, null)).toBe('An integration needs attention');
  });
  it('names only the brand and the kind in minimal content', () => {
    expect(minimalLine('mention', 'Optestra')).toBe('You have a mention notification in Optestra');
    expect(minimalLine('assignment', null)).toBe('You have an assignment notification');
  });
});
