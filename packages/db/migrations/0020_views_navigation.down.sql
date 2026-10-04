-- Reverses 0020_views_navigation (personal navigation, account preferences, cleanup discovery).
DROP FUNCTION IF EXISTS exec_dispatch.discover_views_cleanup(timestamptz, integer);
REVOKE SELECT (workspace_id, id, state, removed_at) ON tenancy.membership FROM pm_scheduler;
REVOKE USAGE ON SCHEMA tenancy FROM pm_scheduler;
DROP POLICY IF EXISTS scheduler_discovery ON tenancy.membership;
DROP INDEX IF EXISTS tenancy.membership_removed_at;
DROP TABLE IF EXISTS views.view_pin;
DROP FUNCTION IF EXISTS views.view_pin_guard();
DROP TABLE IF EXISTS views.view_state;
DROP TABLE IF EXISTS views.recent_item;
DROP TABLE IF EXISTS views.favorite;
DROP TABLE IF EXISTS identity.account_preference;
DROP SCHEMA IF EXISTS views;
