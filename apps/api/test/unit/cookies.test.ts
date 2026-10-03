import { describe, expect, it } from 'vitest';
import { cookieNames, parseCookies, serializeCookie } from '../../src/auth/cookies.ts';

describe('session cookies', () => {
  it('uses __Secure- names and Secure outside explicit local HTTP', () => {
    expect(cookieNames(true)).toEqual({
      session: '__Secure-pm_session',
      continuation: '__Secure-pm_continue',
    });
    const c = serializeCookie('__Secure-pm_session', 'a'.repeat(43), {
      path: '/v1',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: 60,
    });
    expect(c).toBe(
      `__Secure-pm_session=${'a'.repeat(43)}; Path=/v1; SameSite=Lax; HttpOnly; Secure; Max-Age=60`,
    );
    expect(c).not.toMatch(/Domain=/);
  });

  it('refuses values that are not opaque tokens and parses the first occurrence only', () => {
    expect(() =>
      serializeCookie('x', 'a;b', { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }),
    ).toThrow();
    expect(parseCookies('pm_session=first; pm_session=second; other=1').get('pm_session')).toBe(
      'first',
    );
    expect(parseCookies(undefined).size).toBe(0);
  });
});
