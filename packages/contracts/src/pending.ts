/**
 * Public-ID prefixes introduced by Phase 1B that are not yet in the accepted 0D registry. They
 * are used only for platform-scoped identity resources and await registration (ADR-0008 B1).
 */
export const PENDING_ID_PREFIXES = [
  { prefix: 'ses', entity: 'identity.session', ownerModule: 'identity' },
  { prefix: 'mfa', entity: 'identity.mfa_factor', ownerModule: 'identity' },
  { prefix: 'oid', entity: 'identity.oauth_identity', ownerModule: 'identity' },
] as const;
export type PendingIdPrefix = (typeof PENDING_ID_PREFIXES)[number]['prefix'];
