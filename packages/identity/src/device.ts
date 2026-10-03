import { isIP } from 'node:net';

/**
 * Privacy-minimized network context: IPv4 /24 or IPv6 /48 prefix. Full addresses are never
 * stored or logged (0D §17.1; brief: bounded security representation).
 */
export function networkPrefix(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  const v4mapped = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  if (isIP(v4mapped) === 4) {
    const [a, b, c] = v4mapped.split('.');
    return `${a}.${b}.${c}.0/24`;
  }
  if (isIP(v4mapped) === 6) {
    const expanded = expandV6(v4mapped);
    return `${expanded.slice(0, 3).join(':')}::/48`;
  }
  return undefined;
}

function expandV6(ip: string): string[] {
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = Array(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((g) => (g || '0').toLowerCase().replace(/^0+(?=.)/, ''));
}

/** Coarse browser and OS family ("Firefox on macOS"); the raw user agent is discarded. */
export function deviceLabel(userAgent: string | undefined): string | undefined {
  if (!userAgent) return undefined;
  const ua = userAgent.slice(0, 512);
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'unknown OS';
  return `${browser} on ${os}`;
}

export function userAgentFamily(userAgent: string | undefined): string | undefined {
  return deviceLabel(userAgent);
}

/** Safe in-app return paths only: same-origin absolute paths under an allow-listed prefix. */
const RETURN_PREFIXES = ['/account', '/onboarding', '/verify-email', '/sign-in'];
export function safeReturnPath(input: unknown, fallback = '/onboarding'): string {
  if (typeof input !== 'string' || input.length > 200) return fallback;
  if (
    !input.startsWith('/') ||
    input.startsWith('//') ||
    /[\\\s\p{Cc}]/u.test(input) ||
    input.includes('://')
  )
    return fallback;
  const path = input.split(/[?#]/)[0]!;
  return RETURN_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`)) ? input : fallback;
}
