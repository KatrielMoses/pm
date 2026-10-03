import { randomBytes } from 'node:crypto';
import {
  OAuthProviderError,
  pkceChallenge,
  type OAuthClaims,
  type OAuthProvider,
} from './provider.ts';

interface PendingCode {
  subject: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
  expiresAt: number;
  displayName: string;
  email: string;
}

const LOGIN_HINT = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Deterministic local/test identity provider. Configuration allows it only in local and test.
 * The subject is derived from a login hint ("alice" -> "local|alice"); codes are single-use,
 * short-lived, bound to the redirect URI, and require the PKCE (S256) verifier.
 */
export class LocalOAuthProvider implements OAuthProvider {
  readonly id = 'local';
  readonly displayName = 'Local test provider';
  readonly #codes = new Map<string, PendingCode>();
  readonly #authorizeEndpoint: string;
  /** Test hook: claims returned with a different nonce (nonce-mismatch tests). */
  tamperNonce = false;

  constructor(publicApiOrigin: string) {
    this.#authorizeEndpoint = `${publicApiOrigin}/v1/dev/oauth/local/authorize`;
  }

  authorizationUrl(r: {
    state: string;
    nonce: string;
    codeChallenge: string;
    redirectUri: string;
  }): string {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: 'pm-local',
      state: r.state,
      nonce: r.nonce,
      code_challenge: r.codeChallenge,
      code_challenge_method: 'S256',
      redirect_uri: r.redirectUri,
      scope: 'openid email profile',
    });
    return `${this.#authorizeEndpoint}?${q.toString()}`;
  }

  /** The provider's consent step (driven by the dev-only authorize route or tests). */
  approve(r: {
    loginHint: string;
    nonce: string;
    codeChallenge: string;
    redirectUri: string;
  }): string {
    if (!LOGIN_HINT.test(r.loginHint)) throw new OAuthProviderError('invalid_response');
    const code = randomBytes(24).toString('base64url');
    this.#codes.set(code, {
      subject: `local|${r.loginHint}`,
      nonce: r.nonce,
      codeChallenge: r.codeChallenge,
      redirectUri: r.redirectUri,
      expiresAt: Date.now() + 60_000,
      displayName: `Local ${r.loginHint}`,
      email: `${r.loginHint}@local.test`,
    });
    return code;
  }

  exchangeCode(r: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<OAuthClaims> {
    const pending = this.#codes.get(r.code);
    this.#codes.delete(r.code); // single use, even on failure
    if (
      !pending ||
      pending.expiresAt < Date.now() ||
      pending.redirectUri !== r.redirectUri ||
      pkceChallenge(r.codeVerifier) !== pending.codeChallenge
    ) {
      return Promise.reject(new OAuthProviderError('invalid_grant'));
    }
    return Promise.resolve({
      subject: pending.subject,
      nonce: this.tamperNonce ? `${pending.nonce}x` : pending.nonce,
      email: pending.email,
      emailVerified: true,
      displayName: pending.displayName,
    });
  }
}
