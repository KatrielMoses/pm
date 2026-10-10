-- migrate:phase contract
DROP FUNCTION exec_dispatch.discover_webhook_work(timestamptz, timestamptz, integer);
DROP FUNCTION integrations.resolve_api_token(text, bytea);
DROP FUNCTION integrations.resolve_inbound_endpoint(text, bytea);
DROP TABLE integrations.inbound_message;
DROP TABLE integrations.inbound_endpoint;
DROP TABLE integrations.webhook_delivery;
DROP TABLE integrations.webhook_subscription;
DROP TABLE integrations.api_token;
