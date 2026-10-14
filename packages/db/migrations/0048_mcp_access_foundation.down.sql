-- migrate:phase contract
-- Restores the exact 0047 catalog.
DROP FUNCTION integrations.resolve_oauth_access_token(text, bytea);
DROP TABLE integrations.mcp_invocation;
DROP TABLE integrations.oauth_access_token;
DROP TABLE integrations.oauth_consent;
DROP TABLE integrations.oauth_client;
DELETE FROM core.record_type
 WHERE record_type IN ('mcp_invocation', 'oauth_access_token', 'oauth_client', 'oauth_consent');
