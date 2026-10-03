-- migrate:phase expand
-- Stored `locked` step-up challenge state (0D §11.2, PL-17; Phase 1B review 01 rejected B8).
-- The failed verification that reaches STEP_UP_MAX_ATTEMPTS sets state = 'locked' and locked_at in
-- the same row-locked transaction. `locked` is terminal: no transition leaves it, so a locked
-- challenge can never verify or yield a token, whatever the parameter is later set to.

ALTER TABLE identity.step_up_challenge ADD COLUMN locked_at timestamptz;

ALTER TABLE identity.step_up_challenge DROP CONSTRAINT step_up_challenge_state_known;
ALTER TABLE identity.step_up_challenge ADD CONSTRAINT step_up_challenge_state_known
  CHECK (state IN ('pending', 'verified', 'consumed', 'expired', 'cancelled', 'locked'));
ALTER TABLE identity.step_up_challenge ADD CONSTRAINT step_up_challenge_locked_state
  CHECK ((state = 'locked') = (locked_at IS NOT NULL));
-- A locked challenge was never verified: it holds no token.
ALTER TABLE identity.step_up_challenge ADD CONSTRAINT step_up_challenge_locked_tokenless
  CHECK (state <> 'locked' OR (token_hash IS NULL AND verified_at IS NULL));
