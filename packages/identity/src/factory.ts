import type { IdentityConfig, SecretVault } from '@pm/config';
import type { PlatformDatabase } from '@pm/db';
import type { Logger, Metrics } from '@pm/observability';
import { LocalOAuthProvider } from './oauth/local-provider.ts';
import type { OAuthProvider } from './oauth/provider.ts';
import { PasswordHasher } from './password.ts';
import { PostgresRateLimiter, type RateLimiter } from './rate-limit.ts';
import { AuditSecurityEventSink } from '@pm/audit';
import type { SecurityEventPort } from './security-events.ts';
import { IdentityService, noBotProtection, testBotProtection } from './service.ts';
import { DevDatabaseVault } from './vault.ts';

export function createVault(config: IdentityConfig): SecretVault {
  if (config.vault === 'dev-database' && config.devVaultKey)
    return new DevDatabaseVault(config.devVaultKey);
  throw new Error('no secret store configured');
}

/** Wires the identity service from validated configuration (API process and tests). */
export function createIdentityService(deps: {
  db: PlatformDatabase;
  config: IdentityConfig;
  appName: string;
  logger: Logger;
  metrics: Metrics;
  limiter?: RateLimiter;
  /** Security-event sink. Default: the final append-only `audit.security_event` (1F). */
  events?: SecurityEventPort;
}): { service: IdentityService; localOAuth: LocalOAuthProvider | undefined } {
  const { config } = deps;
  if (!config.signingKey) throw new Error('AUTH_SIGNING_KEY is required');
  const signingKey = Buffer.from(config.signingKey.reveal(), 'base64url');
  const oauth = new Map<string, OAuthProvider>();
  let localOAuth: LocalOAuthProvider | undefined;
  if (config.oauthProviders.includes('local')) {
    localOAuth = new LocalOAuthProvider(config.publicOrigin);
    oauth.set('local', localOAuth);
  }
  const service = new IdentityService({
    db: deps.db,
    config,
    appName: deps.appName,
    hasher: new PasswordHasher(config.argon2),
    vault: createVault(config),
    limiter:
      deps.limiter ?? new PostgresRateLimiter(deps.db, signingKey, config.rateLimitOverrides),
    events: deps.events ?? new AuditSecurityEventSink(deps.metrics),
    oauth,
    bot: config.botProtection === 'test' ? testBotProtection : noBotProtection,
    signingKey,
    logger: deps.logger,
    metrics: deps.metrics,
  });
  return { service, localOAuth };
}
