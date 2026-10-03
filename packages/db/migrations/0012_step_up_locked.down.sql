-- Reverts 0012. Locked challenges become `expired` (never verifiable either), so no row can regain
-- a verifiable state on the way down. The locked-state constraints go first: they forbid the update.
ALTER TABLE identity.step_up_challenge DROP CONSTRAINT step_up_challenge_locked_tokenless;
ALTER TABLE identity.step_up_challenge DROP CONSTRAINT step_up_challenge_locked_state;
UPDATE identity.step_up_challenge SET state = 'expired' WHERE state = 'locked';
ALTER TABLE identity.step_up_challenge DROP CONSTRAINT step_up_challenge_state_known;
ALTER TABLE identity.step_up_challenge ADD CONSTRAINT step_up_challenge_state_known
  CHECK (state IN ('pending', 'verified', 'consumed', 'expired', 'cancelled'));
ALTER TABLE identity.step_up_challenge DROP COLUMN locked_at;
