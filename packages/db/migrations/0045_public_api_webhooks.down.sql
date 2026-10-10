-- migrate:phase contract
DROP FUNCTION exec_dispatch.discover_webhook_work(timestamptz, timestamptz, integer);
DROP FUNCTION integrations.resolve_api_token(text, bytea);
DROP FUNCTION integrations.resolve_inbound_endpoint(text, bytea);
DROP SCHEMA integrations CASCADE;
