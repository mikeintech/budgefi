-- Background work must discover queued rows before a tenant is known. Keep
-- RLS enabled so non-owner runtime roles remain policy-bound, while allowing
-- SECURITY DEFINER functions owned by the migration/table owner to perform
-- the narrowly granted cross-tenant discovery work.
ALTER TABLE connections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE plaid_sync_jobs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences NO FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_endpoints NO FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries NO FORCE ROW LEVEL SECURITY;
ALTER TABLE account_deletion_requests NO FORCE ROW LEVEL SECURITY;
ALTER TABLE financial_pattern_analyses NO FORCE ROW LEVEL SECURITY;

-- Notification generation discovers one preference owner at a time, then
-- establishes that tenant's RLS context before reading canonical money data.
CREATE OR REPLACE FUNCTION generate_notification_events()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  preference record;
  candidate record;
  v_event uuid;
  v_count integer := 0;
BEGIN
  FOR preference IN
    SELECT p.*
    FROM notification_preferences p
    WHERE p.push_enabled OR p.email_enabled
  LOOP
    PERFORM set_config('app.household_id', preference.household_id::text, true);
    PERFORM set_config('app.user_id', preference.user_id::text, true);

    FOR candidate IN
      SELECT
        'connection:' || c.id || ':' || c.status || ':' ||
          to_char((now() AT TIME ZONE preference.timezone)::date, 'YYYY-MM-DD') AS dedupe,
        'connection.health'::text AS event_type,
        '/connections'::text AS path,
        'Account connection needs attention'::text AS title,
        'Open Accounts & data to review a connection issue.'::text AS body
      FROM connections c
      WHERE c.household_id = preference.household_id
        AND preference.connection_health
        AND c.status IN ('stale', 'login_required', 'error')

      UNION ALL

      SELECT
        'commitment:' || k.id || ':' || k.due_date::text,
        'commitment.upcoming',
        '/plan',
        'A commitment is coming up',
        'Open your plan to review the due date.'
      FROM commitments k
      WHERE k.household_id = preference.household_id
        AND preference.commitment_reminders
        AND k.active
        AND k.due_date BETWEEN
          (now() AT TIME ZONE preference.timezone)::date AND
          (now() AT TIME ZONE preference.timezone)::date + 3

      UNION ALL

      SELECT
        'exception:' || x.id || ':' || x.version::text,
        'exception.open',
        '/review',
        'A financial exception needs review',
        'Open Review to see the evidence.'
      FROM exception_cases x
      WHERE x.household_id = preference.household_id
        AND preference.exception_activity
        AND x.status IN ('open', 'awaiting_verification')

      UNION ALL

      SELECT
        'weekly:' || to_char((now() AT TIME ZONE preference.timezone)::date, 'IYYY-IW'),
        'digest.weekly',
        '/activity',
        'Your weekly money summary is ready',
        'Open Activity to review what changed this week.'
      WHERE preference.weekly_digest
        AND extract(isodow FROM (now() AT TIME ZONE preference.timezone)) = 1
        AND extract(hour FROM (now() AT TIME ZONE preference.timezone)) >= preference.reminder_hour
    LOOP
      v_event := NULL;
      INSERT INTO notification_events(
        id, household_id, user_id, event_type, title, body, deep_link_path, dedupe_key
      ) VALUES (
        gen_random_uuid(), preference.household_id, preference.user_id,
        candidate.event_type, candidate.title, candidate.body, candidate.path,
        candidate.dedupe
      )
      ON CONFLICT (household_id, user_id, dedupe_key) DO NOTHING
      RETURNING id INTO v_event;

      IF v_event IS NULL THEN CONTINUE; END IF;

      INSERT INTO notification_deliveries(
        household_id, user_id, event_id, endpoint_id, channel
      )
      SELECT preference.household_id, preference.user_id, v_event, e.id, 'push'
      FROM notification_endpoints e
      WHERE e.household_id = preference.household_id
        AND e.user_id = preference.user_id
        AND e.enabled
        AND preference.push_enabled
      ON CONFLICT DO NOTHING;

      IF preference.email_enabled
        AND preference.email_verified_at IS NOT NULL
        AND preference.email_suppressed_at IS NULL
        AND preference.email_address IS NOT NULL
      THEN
        INSERT INTO notification_deliveries(
          household_id, user_id, event_id, channel, destination_hash
        ) VALUES (
          preference.household_id, preference.user_id, v_event, 'email',
          encode(digest(lower(preference.email_address), 'sha256'), 'hex')
        ) ON CONFLICT DO NOTHING;
      END IF;
      v_count := v_count + 1;
    END LOOP;
  END LOOP;
  RETURN v_count;
END
$$;

-- Account deletion first leases a request from the operational queue, then
-- scopes every canonical household read/write before touching financial data.
CREATE OR REPLACE FUNCTION claim_account_deletion()
RETURNS TABLE(request_id uuid, user_id uuid, household_id uuid, auth_subject text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  candidate record;
  v_id uuid;
BEGIN
  FOR candidate IN
    SELECT r.id, r.user_id, r.household_id
    FROM account_deletion_requests r
    WHERE (
      r.status IN ('ready_to_finalize', 'revoking_connections')
      OR (r.status = 'finalizing' AND r.updated_at < now() - interval '5 minutes')
    )
      AND r.updated_at < now() - interval '5 seconds'
    ORDER BY r.requested_at
    FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM set_config('app.household_id', candidate.household_id::text, true);
    -- A system household scope can inspect successor memberships without
    -- impersonating the departing user.
    PERFORM set_config('app.user_id', '', true);
    IF EXISTS (
      SELECT 1 FROM household_memberships m
      WHERE m.household_id = candidate.household_id
        AND m.user_id <> candidate.user_id
        AND m.revoked_at IS NULL
    ) OR NOT EXISTS (
      SELECT 1 FROM connections c
      WHERE c.household_id = candidate.household_id
        AND c.status <> 'revoked'
    ) THEN
      v_id := candidate.id;
      EXIT;
    END IF;
  END LOOP;

  IF v_id IS NULL THEN RETURN; END IF;
  UPDATE account_deletion_requests
  SET status = 'finalizing', updated_at = now()
  WHERE id = v_id;

  RETURN QUERY
  SELECT r.id, r.user_id, r.household_id, u.auth_subject
  FROM account_deletion_requests r
  JOIN users u ON u.id = r.user_id
  WHERE r.id = v_id;
END
$$;

CREATE OR REPLACE FUNCTION finalize_account_deletion(p_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid;
  v_household uuid;
  v_household_empty boolean;
BEGIN
  SELECT user_id, household_id INTO v_user, v_household
  FROM account_deletion_requests
  WHERE id = p_request_id AND status = 'finalizing'
  FOR UPDATE;
  IF v_user IS NULL THEN RETURN; END IF;

  PERFORM set_config('app.household_id', v_household::text, true);
  PERFORM set_config('app.user_id', v_user::text, true);
  PERFORM set_config('app.account_deletion_request_id', p_request_id::text, true);

  DELETE FROM notification_deliveries WHERE user_id = v_user;
  DELETE FROM notification_events WHERE user_id = v_user;
  DELETE FROM notification_endpoints WHERE user_id = v_user;
  DELETE FROM notification_preferences WHERE user_id = v_user;
  UPDATE household_memberships
  SET revoked_at = coalesce(revoked_at, now())
  WHERE household_id = v_household AND user_id = v_user;

  PERFORM set_config('app.user_id', '', true);
  SELECT NOT EXISTS (
    SELECT 1 FROM household_memberships
    WHERE household_id = v_household AND revoked_at IS NULL
  ) INTO v_household_empty;

  IF v_household_empty THEN
    DELETE FROM financial_pattern_analyses WHERE household_id = v_household;
    DELETE FROM case_evidence WHERE household_id = v_household;
    DELETE FROM exception_cases WHERE household_id = v_household;
    DELETE FROM calculation_snapshot_inputs WHERE household_id = v_household;
    DELETE FROM calculation_snapshots WHERE household_id = v_household;
    DELETE FROM sync_runs WHERE household_id = v_household;
    DELETE FROM plaid_sync_jobs WHERE household_id = v_household;
    DELETE FROM plaid_link_sessions WHERE household_id = v_household;
    DELETE FROM webhook_receipts WHERE household_id = v_household;
    DELETE FROM idempotency_records WHERE household_id = v_household;
    DELETE FROM activity_events WHERE household_id = v_household;
    DELETE FROM commitment_revisions WHERE household_id = v_household;
    DELETE FROM commitments WHERE household_id = v_household;
    DELETE FROM plan_revisions WHERE household_id = v_household;
    DELETE FROM financial_transactions WHERE household_id = v_household;
    DELETE FROM balance_observations WHERE household_id = v_household;
    DELETE FROM plans WHERE household_id = v_household;
    DELETE FROM accounts WHERE household_id = v_household;
    DELETE FROM connections WHERE household_id = v_household;
  END IF;

  UPDATE users
  SET auth_subject = 'deleted|' || id::text,
      display_name = 'Deleted member',
      email = NULL,
      deleted_at = now()
  WHERE id = v_user;
  IF v_household_empty THEN
    UPDATE households SET deleted_at = now() WHERE id = v_household;
  END IF;
  UPDATE account_deletion_requests
  SET status = 'completed', completed_at = now(), updated_at = now(), last_error_code = NULL
  WHERE id = p_request_id;
END
$$;

REVOKE ALL ON FUNCTION generate_notification_events() FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_account_deletion() FROM PUBLIC;
REVOKE ALL ON FUNCTION finalize_account_deletion(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION generate_notification_events() TO budgefi_worker;
GRANT EXECUTE ON FUNCTION claim_account_deletion() TO budgefi_worker;
GRANT EXECUTE ON FUNCTION finalize_account_deletion(uuid) TO budgefi_worker;
