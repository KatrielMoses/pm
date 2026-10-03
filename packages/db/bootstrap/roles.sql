-- Provider-level role bootstrap (0C §12.3). Runs ONCE per database cluster, as the provider's
-- administrative user (needs CREATEROLE), before the first migration. It is deliberately outside
-- the migration stream: managed services often reserve role creation for their admin user.
--
-- Passwords are never written in this file. The runner passes them as transaction-local settings:
--   SELECT set_config('pm.bootstrap.<role>_password', '<value>', true);   -- for each login role
--   SELECT set_config('pm.bootstrap.database', '<database name>', true);
-- Missing passwords fail the bootstrap. Re-running is safe: existing roles get their attributes and
-- passwords re-asserted; nothing is dropped.
--
-- Identities:
--   pm_owner          NOLOGIN. Owns every schema and object. Subject to RLS (tables use FORCE).
--   migrator          LOGIN. DDL via SET ROLE pm_owner. CI/deploy only; never used by app processes.
--   restore_operator  LOGIN. Break-glass restore and purge-ledger replay via SET ROLE pm_owner.
--   app_rw            LOGIN. Web/API process. NOBYPASSRLS, owns nothing.
--   app_worker        LOGIN. Worker process tenant work. NOBYPASSRLS, owns nothing.
--   dispatcher        LOGIN. Worker process scheduling discovery: EXECUTE on payload-free functions only.
--   pm_scheduler      NOLOGIN. Owns the payload-free SECURITY DEFINER scheduling functions. Column-limited.
--   audit_maintainer  NOLOGIN (1F, 0C §12.3). Owns only the guarded audit redaction procedure; the
--                     sole identity the audit append-only triggers let change value fields. No login
--                     role is granted membership, so API/worker connections can never SET ROLE to it.
-- No role created here has BYPASSRLS, SUPERUSER, CREATEDB, CREATEROLE, or REPLICATION.

DO $bootstrap$
DECLARE
  r record;
  pw text;
  db text := current_setting('pm.bootstrap.database', true);
BEGIN
  -- Role attributes are cluster-wide: serialize concurrent bootstraps.
  PERFORM pg_advisory_xact_lock(7340002);
  IF db IS NULL OR db = '' THEN
    RAISE EXCEPTION 'pm.bootstrap.database must be set';
  END IF;

  -- Group roles without login.
  FOR r IN SELECT * FROM (VALUES ('pm_owner'), ('pm_scheduler'), ('audit_maintainer')) AS t(name) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r.name);
    END IF;
    EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', r.name);
  END LOOP;

  -- Login roles. Application identities use NOINHERIT so no group privilege leaks in implicitly.
  FOR r IN SELECT * FROM (VALUES ('migrator'), ('restore_operator'), ('app_rw'), ('app_worker'), ('dispatcher')) AS t(name) LOOP
    pw := current_setting('pm.bootstrap.' || r.name || '_password', true);
    IF pw IS NULL OR pw = '' THEN
      RAISE EXCEPTION 'password for % must be provided', r.name;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name) THEN
      EXECUTE format('CREATE ROLE %I LOGIN', r.name);
    END IF;
    EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD %L', r.name, pw);
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', db, r.name);
  END LOOP;

  -- Operational identities may act as the owner, but only by explicit SET ROLE (no inheritance).
  EXECUTE 'GRANT pm_owner TO migrator WITH INHERIT FALSE, SET TRUE';
  EXECUTE 'GRANT pm_owner TO restore_operator WITH INHERIT FALSE, SET TRUE';
  -- The owner may transfer function ownership to pm_scheduler without inheriting its policies.
  EXECUTE 'GRANT pm_scheduler TO pm_owner WITH INHERIT FALSE, SET TRUE';
  -- Likewise for the guarded audit redaction procedure (owned by audit_maintainer).
  EXECUTE 'GRANT audit_maintainer TO pm_owner WITH INHERIT FALSE, SET TRUE';

  -- Schemas are created by migrations as pm_owner.
  EXECUTE format('GRANT CREATE ON DATABASE %I TO pm_owner', db);
  -- Nobody but the owner creates objects in public; application objects never live there.
  EXECUTE 'REVOKE CREATE ON SCHEMA public FROM PUBLIC';
END
$bootstrap$;
