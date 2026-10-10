/** A bearer token or inbound webhook acting as a membership, only ever narrowing it. */
export interface TokenDelegation {
  tokenId: string;
  tokenPublicId: string;
  kind: 'personal' | 'service' | 'inbound';
  principalType: 'api_token_personal' | 'service_principal' | 'inbound_webhook';
  scopes: readonly string[];
  /** Null means every brand the membership can already access. */
  brandIds: readonly string[] | null;
  membershipId: string;
  accountId: string;
  sourceKind: 'api' | 'webhook';
}
