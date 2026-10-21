/** A bearer token or inbound webhook acting as a membership, only ever narrowing it. */
export interface TokenDelegation {
  tokenId: string;
  tokenPublicId: string;
  kind: 'personal' | 'service' | 'inbound' | 'oauth' | 'agent_run';
  principalType:
    | 'api_token_personal'
    | 'service_principal'
    | 'inbound_webhook'
    | 'oauth_client'
    | 'agent_run';
  scopes: readonly string[];
  /** Null means every brand the membership can already access. */
  brandIds: readonly string[] | null;
  membershipId: string;
  accountId: string;
  sourceKind: 'api' | 'webhook' | 'mcp';
  /** Present for consent-scoped OAuth clients; reloaded from the live consent on authentication. */
  consentId?: string;
  /**
   * 8C run-bound credential: the one run (and attempt operation) it acts for. The membership is the
   * run's assigner; every call is narrowed to the run's live ceiling and tools (ADR-0048 D5).
   */
  agentRun?: { credentialId: string; runId: string; operationId: string };
}
