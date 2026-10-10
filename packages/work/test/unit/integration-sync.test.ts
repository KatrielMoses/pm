import { describe, expect, it } from 'vitest';
import { scopesAllowed, syncBackoffMs, PROVIDERS } from '../../src/integrations/semantics.ts';

describe('sync backoff', () => {
  it('backs off and stops at the attempt bound', () => {
    expect(syncBackoffMs(1, 30)).toBe(30_000);
    expect(syncBackoffMs(2, 30)).toBe(60_000);
    expect(syncBackoffMs(3, 30)).toBe(120_000);
    expect(syncBackoffMs(20, 30)).toBe(syncBackoffMs(8, 30));
    const loopback = PROVIDERS.find((p) => p.id === 'loopback')!;
    expect(scopesAllowed(loopback, ['read'])).toBe(true);
    expect(scopesAllowed(loopback, ['calendar.read'])).toBe(false);
  });
});
