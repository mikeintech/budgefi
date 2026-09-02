-- Clerk identities are an authentication boundary, not the owner of Budgefi's
-- financial deletion workflow. Disable frontend self-delete per user in the
-- API and reconcile any externally deleted identity through this verified,
-- idempotent event queue.

DROP INDEX IF EXISTS account_deletion_one_active_per_user;
CREATE UNIQUE INDEX account_deletion_one_active_per_membership
  ON account_deletion_requests(user_id, household_id)
  WHERE completed_at IS NULL;

CREATE TABLE clerk_webhook_receipts (
  event_id text PRIMARY KEY CHECK (event_id ~ '^[A-Za-z0-9_-]{3,200}$'),
  event_type text NOT NULL CHECK (event_type = 'user.deleted'),
  clerk_user_id_hash text NOT NULL CHECK (length(clerk_user_id_hash) = 64),
  user_id uuid REFERENCES users(id),
  known boolean NOT NULL,
  processing_status text NOT NULL CHECK (processing_status IN ('ignored','queued','processed')),
  queued_deletions integer NOT NULL DEFAULT 0 CHECK (queued_deletions >= 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE OR REPLACE FUNCTION ingest_verified_clerk_user_deleted(
  p_event_id text,
  p_clerk_user_id text
)
RETURNS TABLE(known boolean, duplicate boolean, queued_deletions integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid;
  v_household uuid;
  v_households uuid[];
  v_role text;
  v_successor uuid;
  v_status text;
  v_queued integer := 0;
  v_active integer := 0;
  v_existing clerk_webhook_receipts%ROWTYPE;
BEGIN
  IF p_event_id IS NULL OR p_event_id !~ '^[A-Za-z0-9_-]{3,200}$' THEN
    RAISE EXCEPTION 'invalid Clerk event id';
  END IF;
  IF p_clerk_user_id IS NULL OR p_clerk_user_id !~ '^user_[A-Za-z0-9_-]{3,180}$' THEN
    RAISE EXCEPTION 'invalid Clerk user id';
  END IF;

  SELECT * INTO v_existing
  FROM clerk_webhook_receipts
  WHERE event_id = p_event_id;
  IF FOUND THEN
    RETURN QUERY SELECT v_existing.known, true, v_existing.queued_deletions;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('clerk|' || p_clerk_user_id, 0));
  -- The first lookup is a fast path. Recheck after the per-identity lock so
  -- two simultaneously delivered copies cannot both report first handling.
  SELECT * INTO v_existing
  FROM clerk_webhook_receipts
  WHERE event_id = p_event_id;
  IF FOUND THEN
    RETURN QUERY SELECT v_existing.known, true, v_existing.queued_deletions;
    RETURN;
  END IF;
  SELECT id INTO v_user
  FROM users
  WHERE auth_subject = 'clerk|' || p_clerk_user_id
    AND deleted_at IS NULL
  FOR UPDATE;

  IF v_user IS NULL THEN
    INSERT INTO clerk_webhook_receipts(
      event_id,event_type,clerk_user_id_hash,user_id,known,processing_status,processed_at
    ) VALUES (
      p_event_id,'user.deleted',encode(digest(p_clerk_user_id,'sha256'),'hex'),
      NULL,false,'ignored',now()
    ) ON CONFLICT(event_id) DO NOTHING;
    RETURN QUERY SELECT false, false, 0;
    RETURN;
  END IF;

  PERFORM set_config('app.user_id', v_user::text, true);
  PERFORM set_config('app.household_id', '', true);
  SELECT array_agg(m.household_id ORDER BY m.created_at)
  INTO v_households
  FROM household_memberships m
  WHERE m.user_id = v_user AND m.revoked_at IS NULL;

  FOREACH v_household IN ARRAY coalesce(v_households, ARRAY[]::uuid[])
  LOOP
    PERFORM set_config('app.household_id', v_household::text, true);
    PERFORM set_config('app.user_id', v_user::text, true);
    PERFORM 1 FROM households h WHERE h.id = v_household FOR UPDATE;
    SELECT m.role INTO v_role
    FROM household_memberships m
    WHERE m.household_id = v_household
      AND m.user_id = v_user
      AND m.revoked_at IS NULL;
    IF v_role IS NULL THEN CONTINUE; END IF;

    v_successor := NULL;
    IF v_role = 'owner' THEN
      PERFORM set_config('app.user_id', '', true);
      SELECT m.user_id INTO v_successor
      FROM household_memberships m
      WHERE m.household_id = v_household
        AND m.user_id <> v_user
        AND m.revoked_at IS NULL
      ORDER BY m.created_at, m.user_id
      LIMIT 1;
      IF v_successor IS NOT NULL THEN
        PERFORM set_config('app.user_id', v_successor::text, true);
        UPDATE household_memberships
        SET role = 'owner'
        WHERE household_id = v_household
          AND user_id = v_successor
          AND revoked_at IS NULL;
      END IF;
    ELSE
      -- A non-owner always leaves a household that still has an owner.
      v_successor := v_user;
    END IF;

    PERFORM set_config('app.user_id', v_user::text, true);
    IF v_successor IS NULL THEN
      UPDATE households SET lifecycle_state = 'deleting' WHERE id = v_household;
      UPDATE connections
      SET status = 'revocation_pending', updated_at = now(), error_code = NULL
      WHERE household_id = v_household
        AND provider = 'plaid'
        AND status NOT IN ('revoked','revocation_pending');
      INSERT INTO plaid_sync_jobs(
        household_id,connection_id,operation,trigger,state,available_at
      )
      SELECT household_id,id,'revoke','recovery','queued',now()
      FROM connections
      WHERE household_id = v_household
        AND provider = 'plaid'
        AND status <> 'revoked'
      ON CONFLICT DO NOTHING;
      UPDATE connections
      SET status = 'revoked', revoked_at = coalesce(revoked_at,now()), updated_at = now()
      WHERE household_id = v_household AND provider = 'sample' AND status <> 'revoked';
      UPDATE accounts
      SET include_in_plan = false, archived_at = coalesce(archived_at,now()), version = version + 1
      WHERE household_id = v_household AND provenance = 'sample'
        AND (include_in_plan OR archived_at IS NULL);
    END IF;

    SELECT CASE WHEN v_successor IS NULL AND EXISTS(
      SELECT 1 FROM connections
      WHERE household_id = v_household
        AND provider = 'plaid'
        AND status <> 'revoked'
    ) THEN 'revoking_connections' ELSE 'ready_to_finalize' END
    INTO v_status;

    INSERT INTO account_deletion_requests(
      household_id,user_id,status,requested_at,updated_at
    ) VALUES (v_household,v_user,v_status,now(),now())
    ON CONFLICT(user_id,household_id) WHERE completed_at IS NULL DO NOTHING;
    IF FOUND THEN v_queued := v_queued + 1; END IF;

    UPDATE notification_endpoints
    SET enabled = false, disabled_at = coalesce(disabled_at,now())
    WHERE household_id = v_household AND user_id = v_user;
    UPDATE notification_preferences
    SET email_enabled = false, push_enabled = false, updated_at = now()
    WHERE household_id = v_household AND user_id = v_user;
  END LOOP;

  IF coalesce(array_length(v_households,1),0) = 0 THEN
    UPDATE users
    SET auth_subject = 'deleted|' || id::text,
        display_name = 'Deleted member', email = NULL, deleted_at = now()
    WHERE id = v_user;
  END IF;

  SELECT count(*)::integer INTO v_active
  FROM account_deletion_requests
  WHERE user_id = v_user AND completed_at IS NULL;

  INSERT INTO clerk_webhook_receipts(
    event_id,event_type,clerk_user_id_hash,user_id,known,processing_status,
    queued_deletions,processed_at
  ) VALUES (
    p_event_id,'user.deleted',encode(digest(p_clerk_user_id,'sha256'),'hex'),
    v_user,true,CASE WHEN v_active > 0 THEN 'queued' ELSE 'processed' END,
    v_active,CASE WHEN v_active > 0 THEN NULL ELSE now() END
  ) ON CONFLICT(event_id) DO NOTHING;

  RETURN QUERY SELECT true, false, v_active;
END
$$;

CREATE OR REPLACE FUNCTION finish_clerk_deletion_receipts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.completed_at IS NOT NULL AND OLD.completed_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM account_deletion_requests
       WHERE user_id = NEW.user_id AND completed_at IS NULL
     ) THEN
    UPDATE clerk_webhook_receipts
    SET processing_status = 'processed', processed_at = coalesce(processed_at,now())
    WHERE user_id = NEW.user_id AND processing_status = 'queued';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER account_deletion_finishes_clerk_receipts
AFTER UPDATE OF completed_at ON account_deletion_requests
FOR EACH ROW EXECUTE FUNCTION finish_clerk_deletion_receipts();

REVOKE ALL ON TABLE clerk_webhook_receipts FROM PUBLIC;
REVOKE ALL ON FUNCTION ingest_verified_clerk_user_deleted(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finish_clerk_deletion_receipts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingest_verified_clerk_user_deleted(text,text) TO budgefi_app;
