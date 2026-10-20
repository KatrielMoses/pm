-- migrate:phase expand
-- Phase 8A corrective review 01 (R2; ADR-0046 D19, 0B ADR-51). An automation run's job checkpoint
-- holds references and bounded state facts only: a webhook step's checkpoint names the step and
-- its logical effect key, and the payload is rebuilt in memory under fresh authorization just
-- before the request leaves. The 8A candidate before this migration also stored the prepared
-- payload (selected record values), the subscription, and the fingerprint in that checkpoint.
--
-- One-time cleanup of those copies, in every workspace. Only the content is removed: the step
-- name, its logical effect key, and every other step stay; no effect, attempt, claim, or decision
-- is touched (an attempted effect keeps its state and liability). The new worker reads only the
-- step and key, so a cleaned run resumes normally and re-decides authority before sending.
-- exec.job forces tenant row-level security even on its owner; as in 0041 and 0054 the force is
-- lifted for this one statement inside the migration transaction and set again straight after.
ALTER TABLE exec.job NO FORCE ROW LEVEL SECURITY;
UPDATE exec.job j
   SET checkpoint = (
         SELECT jsonb_object_agg(e.k, CASE
                  WHEN jsonb_typeof(e.v) = 'object' AND jsonb_typeof(e.v -> 'advance') = 'object'
                       AND e.v -> 'advance' ->> 'kind' = 'effect'
                    THEN jsonb_set(e.v, '{advance}',
                           (e.v -> 'advance') - 'envelope' - 'subscriptionId' - 'fingerprint')
                  ELSE e.v END)
           FROM jsonb_each(j.checkpoint) AS e(k, v)),
       updated_at = now()
 WHERE j.kind = 'automation.run'
   AND j.checkpoint IS NOT NULL
   AND EXISTS (
         SELECT 1 FROM jsonb_each(j.checkpoint) AS e(k, v)
          WHERE jsonb_typeof(e.v) = 'object' AND jsonb_typeof(e.v -> 'advance') = 'object'
            AND e.v -> 'advance' ->> 'kind' = 'effect'
            AND (e.v -> 'advance' ? 'envelope' OR e.v -> 'advance' ? 'subscriptionId'
                 OR e.v -> 'advance' ? 'fingerprint'));
ALTER TABLE exec.job FORCE ROW LEVEL SECURITY;
