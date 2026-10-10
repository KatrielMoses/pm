import { createHash } from 'node:crypto';

/** Claims an adapter returns after a successful code exchange (subject is immutable). */
export interface OAuthClaims {
  subject: string;
  nonce: string;
  email?: string | undefined;
  emailVerified?: boolean | undefined;
  displayName?: string | undefined;
}

export class OAuthProviderError extends Error {
  readonly reason: 'invalid_grant' | 'invalid_response' | 'unavailable';

  constructor(reason: OAuthProviderError['reason']) {
    super(`oauth provider error: ${reason}`);
    this.name = 'OAuthProviderError';
    this.reason = reason;
  }
}

/**
 * Provider-neutral OAuth 2.0 / OIDC boundary: authorization request creation and code exchange
 * with PKCE. State and nonce are generated and verified by the identity service, never the adapter.
 * No commercial provider is selected (product-owner approval required).
 */
export interface OAuthProvider {
  readonly id: string;
  readonly displayName: string;
  authorizationUrl(request: {
    state: string;
    nonce: string;
    codeChallenge: string;
    redirectUri: string;
  }): string;
  exchangeCode(request: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<OAuthClaims>;
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}
