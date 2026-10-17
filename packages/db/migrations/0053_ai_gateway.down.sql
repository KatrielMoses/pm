-- migrate:phase contract
-- Restores the exact 0052 catalog. Every AI action, dispatch, output, reservation, balance, and
-- usage event is dropped with its schema; nothing outside `ai` and `metering` changes.
DROP FUNCTION exec_dispatch.discover_ai_retention_work(timestamptz, integer);
DROP TABLE metering.usage_event;
DROP TABLE metering.usage_reservation;
DROP TABLE metering.usage_balance;
DROP TABLE metering.spend_limit;
DROP TRIGGER ai_output_immutable ON ai.ai_output;
DROP TABLE ai.ai_output;
DROP FUNCTION ai.output_guard();
DROP TABLE ai.ai_dispatch;
DROP TABLE ai.ai_context_ref;
DROP TABLE ai.ai_action;
DROP TABLE ai.brand_ai_profile;
DROP TABLE ai.ai_provider_config;
DROP SCHEMA metering;
DROP SCHEMA ai;
