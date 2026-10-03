// Browser-safe configuration. This module must not import server-only code: the web bundle imports
// it through `@pm/config/public`, and lint forbids web imports of the server entry.

export interface PublicConfig {
  /** Product display name. */
  readonly appName: string;
  /** Same-origin API prefix (0D §2.1). */
  readonly apiBasePath: '/v1';
}

export const PUBLIC_CONFIG: PublicConfig = Object.freeze({
  appName: 'PM',
  apiBasePath: '/v1',
});

/** Build information that is safe to show to users (no paths, hosts, or commit authors). */
export interface PublicBuildInfo {
  readonly version: string;
  readonly build: string;
}

export function isPublicBuildInfo(value: unknown): value is PublicBuildInfo {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.version === 'string' &&
    /^[0-9A-Za-z.+-]{1,32}$/.test(v.version) &&
    typeof v.build === 'string' &&
    /^[0-9A-Za-z.-]{1,40}$/.test(v.build)
  );
}
