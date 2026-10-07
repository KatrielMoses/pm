-- Reverts 0035 (local/test only). Restores the exact 0034 catalog.
DROP TABLE planning.capacity_reservation;
DROP TABLE planning.holiday;
DROP TABLE planning.time_off;
DROP TABLE planning.availability_rule;
DROP FUNCTION planning.availability_rule_guard();
DROP TABLE planning.capacity_profile;
