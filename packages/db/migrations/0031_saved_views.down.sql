-- Reverts 0031 (local/test only). Restores the exact 0030 catalog.
REVOKE INSERT, DELETE ON views.view_pin FROM app_rw;
REVOKE UPDATE (rank) ON views.view_pin FROM app_rw;
REVOKE DELETE ON views.view_pin FROM app_worker;
DROP TRIGGER view_pin_shared_guard ON views.view_pin;
DROP FUNCTION views.view_pin_shared_guard();
DROP TABLE views.view_default;
DROP TABLE views.saved_view;
