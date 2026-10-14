/** A bearer token or inbound webhook acting as a membership, only ever narrowing it. */
export interface TokenDelegation {
  tokenId: string;
  tokenPublicId: string;
  kind: 'personal' | 'service' | 'inbound' | 'oauth';
  principalType: 'api_token_personal' | 'service_principal' | 'inbound_webhook' | 'oauth_client';
  scopes: readonly string[];
  /** Null means every brand the membership can already access. */
  brandIds: readonly string[] | null;
  membershipId: string;
  accountId: string;
  sourceKind: 'api' | 'webhook' | 'mcp';
  /** Present for consent-scoped OAuth clients; reloaded from the live consent on authentication. */
  consentId?: string;
}
