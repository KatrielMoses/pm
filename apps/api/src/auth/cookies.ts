/** Minimal RFC 6265 cookie parsing and serialization (no third-party dependency). */
export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

export interface CookieOptions {
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'Lax' | 'Strict';
  /** Seconds; omitted = session cookie; 0 = delete. */
  maxAge?: number;
}

export function serializeCookie(name: string, value: string, o: CookieOptions): string {
  if (!/^[A-Za-z0-9_-]{0,128}$/.test(value)) throw new Error('cookie value must be a token');
  const parts = [`${name}=${value}`, `Path=${o.path}`, `SameSite=${o.sameSite}`];
  if (o.httpOnly) parts.push('HttpOnly');
  if (o.secure) parts.push('Secure');
  if (o.maxAge !== undefined) parts.push(`Max-Age=${o.maxAge}`);
  // No Domain attribute: host-only cookies.
  return parts.join('; ');
}

/**
 * Cookie names. `__Secure-` requires Secure; the session cookie is host-only and scoped to the API
 * path (`/v1`) because the static application never needs it. Insecure names exist only for
 * explicit local/test HTTP.
 */
export function cookieNames(secure: boolean) {
  return {
    session: secure ? '__Secure-pm_session' : 'pm_session',
    continuation: secure ? '__Secure-pm_continue' : 'pm_continue',
  };
}
