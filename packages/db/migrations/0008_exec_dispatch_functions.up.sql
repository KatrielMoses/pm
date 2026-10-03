-- migrate:phase expand
-- Payload-free, cross-tenant scheduling surface (0C §12.3-§12.4, AC-06). Every function here:
--   * is SECURITY DEFINER owned by pm_scheduler (NOLOGIN, column-limited, no BYPASSRLS);
--   * returns only identifiers, queue names, timestamps, or counts - never payloads or context;
--   * is executable by the dispatcher login role only.
-- Processing then happens with app_worker in one fail-closed workspace transaction per job/event.

CREATE FUNCTION exec_dispatch.claim_jobs(
  p_queue text, p_worker_id text, p_limit integer, p_workspace_cap integer, p_lease_ms integer)
  RETURNS TABLE (job_id uuid, workspace_id uuid, lease_token uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
#variable_conflict use_column
BEGIN
  IF p_queue !~ '^[a-z_]{1,64}$' OR p_worker_id !~ '^wrk_[0-9a-f]{16}$'
     OR p_limit NOT BETWEEN 1 AND 500 OR p_workspace_cap NOT BETWEEN 1 AND 1000
     OR p_lease_ms NOT BETWEEN 1000 AND 3600000 THEN
    RAISE EXCEPTION 'invalid claim parameters' USING ERRCODE = '22023';
  END IF;
  -- Serialize claims per queue so per-workspace caps hold under concurrent workers (REL-018).
  PERFORM pg_advisory_xact_lock(hashtextextended('pm.exec.claim:' || p_queue, 0));
  RETURN QUERY
  WITH inflight AS (
    SELECT j.workspace_id, count(*)::integer AS n
    FROM exec.job j
    WHERE j.queue = p_queue AND j.state = 'leased'
    GROUP BY j.workspace_id
  ), ranked AS (
    SELECT j.id, j.workspace_id, j.run_at,
           row_number() OVER (PARTITION BY j.workspace_id ORDER BY j.run_at, j.id) AS rnk
    FROM exec.job j
    WHERE j.queue = p_queue AND j.state IN ('queued', 'retry_scheduled')
      AND j.run_at <= now() AND j.attempts < j.max_attempts
  ), candidates AS (
    -- Round-robin across workspaces: every workspace's first due job before anyone's second.
    SELECT r.id
    FROM ranked r LEFT JOIN inflight i ON i.workspace_id = r.workspace_id
    WHERE r.rnk + coalesce(i.n, 0) <= p_workspace_cap
    ORDER BY r.rnk, r.run_at, r.id
    LIMIT p_limit
  ), locked AS (
    SELECT j.id
    FROM exec.job j JOIN candidates c ON c.id = j.id
    WHERE j.state IN ('queued', 'retry_scheduled')
    FOR UPDATE OF j SKIP LOCKED
  )
  UPDATE exec.job j
     SET state = 'leased',
         lease_token = gen_random_uuid(),
         lease_owner = p_worker_id,
         lease_until = now() + make_interval(secs => p_lease_ms / 1000.0),
         heartbeat_at = now(),
         attempts = j.attempts + 1,
         updated_at = now()
    FROM locked l
   WHERE j.id = l.id
  RETURNING j.id, j.workspace_id, j.lease_token;
END $$;

CREATE FUNCTION exec_dispatch.discover_expired_leases(p_limit integer)
  RETURNS TABLE (job_id uuid, workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT j.id, j.workspace_id
  FROM exec.job j
  WHERE j.state = 'leased' AND j.lease_until < now()
  ORDER BY j.lease_until
  LIMIT least(greatest(p_limit, 1), 500)
$$;

CREATE FUNCTION exec_dispatch.job_queue_stats()
  RETURNS TABLE (queue text, state exec.job_state, jobs bigint, oldest_due_age_ms bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT j.queue, j.state, count(*),
         coalesce((extract(epoch FROM now() - min(j.run_at)
           FILTER (WHERE j.state IN ('queued', 'retry_scheduled') AND j.run_at <= now())) * 1000)::bigint, 0)
  FROM exec.job j
  GROUP BY j.queue, j.state
$$;

CREATE FUNCTION exec_dispatch.claim_outbox_events(p_limit integer, p_lease_ms integer)
  RETURNS TABLE (event_id uuid, workspace_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
#variable_conflict use_column
BEGIN
  IF p_limit NOT BETWEEN 1 AND 1000 OR p_lease_ms NOT BETWEEN 1000 AND 3600000 THEN
    RAISE EXCEPTION 'invalid claim parameters' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH c AS (
    SELECT o.id
    FROM exec.outbox_event o
    WHERE o.dispatched_at IS NULL
      AND (o.dispatch_lease_until IS NULL OR o.dispatch_lease_until < now())
    ORDER BY o.id
    LIMIT p_limit
    FOR UPDATE OF o SKIP LOCKED
  )
  UPDATE exec.outbox_event o
     SET dispatch_lease_until = now() + make_interval(secs => p_lease_ms / 1000.0),
         dispatch_attempts = o.dispatch_attempts + 1
    FROM c
   WHERE o.id = c.id
  RETURNING o.id, o.workspace_id;
END $$;

CREATE FUNCTION exec_dispatch.outbox_backlog()
  RETURNS TABLE (pending bigint, oldest_age_ms bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT count(*), coalesce((extract(epoch FROM now() - min(o.recorded_at)) * 1000)::bigint, 0)
  FROM exec.outbox_event o
  WHERE o.dispatched_at IS NULL
$$;

-- Maintenance iterates explicit workspace IDs, one transaction per workspace (0C §12.4 step 3).
CREATE FUNCTION exec_dispatch.discover_maintenance_workspaces(p_cutoff timestamptz, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT w.workspace_id FROM (
    SELECT o.workspace_id FROM exec.outbox_event o WHERE o.dispatched_at < p_cutoff
    UNION
    SELECT k.workspace_id FROM exec.idempotency_key k WHERE k.expires_at < now()
    UNION
    SELECT r.workspace_id FROM exec.inbox_receipt r WHERE r.processed_at < p_cutoff
    UNION
    SELECT j.workspace_id FROM exec.job j WHERE j.finished_at < p_cutoff
  ) w
  LIMIT least(greatest(p_limit, 1), 1000)
$$;

-- Privileges first, while pm_owner still owns the functions: ALTER OWNER carries the ACL over to
-- pm_scheduler. (A REVOKE issued by a non-owner after the transfer would silently do nothing and
-- leave the default PUBLIC EXECUTE in place.)
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA exec_dispatch FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA exec_dispatch TO dispatcher;

ALTER FUNCTION exec_dispatch.claim_jobs(text, text, integer, integer, integer) OWNER TO pm_scheduler;
ALTER FUNCTION exec_dispatch.discover_expired_leases(integer) OWNER TO pm_scheduler;
ALTER FUNCTION exec_dispatch.job_queue_stats() OWNER TO pm_scheduler;
ALTER FUNCTION exec_dispatch.claim_outbox_events(integer, integer) OWNER TO pm_scheduler;
ALTER FUNCTION exec_dispatch.outbox_backlog() OWNER TO pm_scheduler;
ALTER FUNCTION exec_dispatch.discover_maintenance_workspaces(timestamptz, integer) OWNER TO pm_scheduler;

