import { isPublicBuildInfo, PUBLIC_CONFIG, type PublicBuildInfo } from '@pm/config/public';

export type ConnectionState =
  | { kind: 'checking' }
  | { kind: 'available'; build: PublicBuildInfo }
  | { kind: 'degraded'; build: PublicBuildInfo }
  | { kind: 'unavailable' };

/**
 * Reads the public platform status. Anything unexpected (network failure, non-JSON, error
 * envelope, unknown shape) is reported as "unavailable"; no server detail reaches the UI.
 */
export async function fetchStatus(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ConnectionState> {
  try {
    const res = await fetchImpl(`${PUBLIC_CONFIG.apiBasePath}/status`, {
      headers: { accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return { kind: 'unavailable' };
    const body = (await res.json()) as { data?: { status?: unknown; build?: unknown } };
    const build = body.data?.build;
    if (!isPublicBuildInfo(build)) return { kind: 'unavailable' };
    if (body.data?.status === 'available') return { kind: 'available', build };
    if (body.data?.status === 'degraded') return { kind: 'degraded', build };
    return { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}
