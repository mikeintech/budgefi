-- First-login provisioning runs before a tenant scope exists. Establish the
-- authenticated user's scope inside the trusted functions so FORCE RLS remains
-- enabled without requiring a BYPASSRLS runtime or function owner.

DROP POLICY IF EXISTS membership_user ON household_memberships;
DROP POLICY IF EXISTS membership_select_scope ON household_memberships;
DROP POLICY IF EXISTS membership_insert_scope ON household_memberships;
DROP POLICY IF EXISTS membership_update_scope ON household_memberships;
DROP POLICY IF EXISTS membership_delete_scope ON household_memberships;

CREATE POLICY membership_select_scope ON household_memberships
  FOR SELECT
  USING (
    (
      nullif(current_setting('app.user_id', true), '') IS NOT NULL
      AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND (
        nullif(current_setting('app.household_id', true), '') IS NULL
        OR household_id = nullif(current_setting('app.household_id', true), '')::uuid
      )
    )
    OR (
      nullif(current_setting('app.user_id', true), '') IS NULL
      AND nullif(current_setting('app.household_id', true), '') IS NOT NULL
      AND household_id = nullif(current_setting('app.household_id', true), '')::uuid
    )
  );

CREATE POLICY membership_insert_scope ON household_memberships
  FOR INSERT
  WITH CHECK (
    household_id = nullif(current_setting('app.household_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
  );

CREATE POLICY membership_update_scope ON household_memberships
  FOR UPDATE
  USING (
    household_id = nullif(current_setting('app.household_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    household_id = nullif(current_setting('app.household_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
  );

CREATE POLICY membership_delete_scope ON household_memberships
  FOR DELETE
  USING (
    household_id = nullif(current_setting('app.household_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
  );

CREATE OR REPLACE FUNCTION resolve_principal(
  p_auth_subject text,
  p_household_id uuid DEFAULT NULL
)
RETURNS TABLE(user_id uuid, household_id uuid, membership_role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid;
  v_household_id uuid;
  v_membership_role text;
  v_candidate_household_id uuid;
  v_candidate_households uuid[];
  v_active_count integer := 0;
BEGIN
  SELECT u.id INTO v_user_id
  FROM users u
  WHERE u.auth_subject = p_auth_subject
    AND u.deleted_at IS NULL;

  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM set_config('app.user_id', v_user_id::text, true);
  PERFORM set_config('app.household_id', '', true);

  IF p_household_id IS NOT NULL THEN
    v_household_id := p_household_id;
    PERFORM set_config('app.household_id', v_household_id::text, true);
  ELSE
    SELECT array_agg(m.household_id ORDER BY m.created_at)
    INTO v_candidate_households
    FROM household_memberships m
    WHERE m.user_id = v_user_id
      AND m.revoked_at IS NULL;

    FOREACH v_candidate_household_id IN ARRAY coalesce(v_candidate_households, ARRAY[]::uuid[])
    LOOP
      PERFORM set_config('app.household_id', v_candidate_household_id::text, true);
      IF EXISTS (
        SELECT 1
        FROM households h
        WHERE h.id = v_candidate_household_id
          AND h.deleted_at IS NULL
      ) THEN
        v_active_count := v_active_count + 1;
        v_household_id := v_candidate_household_id;
      END IF;
    END LOOP;

    IF v_active_count <> 1 THEN
      PERFORM set_config('app.household_id', '', true);
      RETURN;
    END IF;

    PERFORM set_config('app.household_id', v_household_id::text, true);
  END IF;

  SELECT m.role INTO v_membership_role
  FROM household_memberships m
  JOIN households h ON h.id = m.household_id
  WHERE m.user_id = v_user_id
    AND m.household_id = v_household_id
    AND m.revoked_at IS NULL
    AND h.deleted_at IS NULL;

  IF v_membership_role IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT v_user_id, v_household_id, v_membership_role;
END
$$;

CREATE OR REPLACE FUNCTION provision_principal(
  p_auth_subject text,
  p_display_name text DEFAULT NULL,
  p_email text DEFAULT NULL
)
RETURNS TABLE(user_id uuid, household_id uuid, membership_role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid;
  v_household_id uuid;
  v_plan_id uuid;
  v_account_id uuid;
  v_name text;
BEGIN
  IF p_auth_subject IS NULL OR length(trim(p_auth_subject)) < 3 THEN
    RAISE EXCEPTION 'Invalid authentication subject';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_auth_subject, 0));
  SELECT u.id INTO v_user_id
  FROM users u
  WHERE u.auth_subject = p_auth_subject
    AND u.deleted_at IS NULL;

  IF v_user_id IS NOT NULL THEN
    RETURN QUERY
    SELECT resolved.user_id, resolved.household_id, resolved.membership_role
    FROM resolve_principal(p_auth_subject, NULL) resolved;
    RETURN;
  END IF;

  v_user_id := gen_random_uuid();
  v_household_id := gen_random_uuid();
  v_name := left(coalesce(nullif(trim(p_display_name), ''), 'Budgefi member'), 120);

  PERFORM set_config('app.user_id', v_user_id::text, true);
  PERFORM set_config('app.household_id', v_household_id::text, true);

  INSERT INTO users (id, auth_subject, display_name, email)
  VALUES (v_user_id, p_auth_subject, v_name, nullif(trim(p_email), ''));

  INSERT INTO households (id, name)
  VALUES (v_household_id, left(v_name || '''s household', 160));

  INSERT INTO household_memberships (household_id, user_id, role)
  VALUES (v_household_id, v_user_id, 'owner');

  INSERT INTO plans (
    household_id, planned_savings_minor, safety_buffer_minor, currency,
    calculation_policy_version, planning_horizon_days
  ) VALUES (v_household_id, 0, 0, 'USD', 'available-v1', 10)
  RETURNING id INTO v_plan_id;

  INSERT INTO plan_revisions (
    household_id, plan_id, version, planned_savings_minor,
    safety_buffer_minor, currency, planning_horizon_days, policy_version,
    actor_user_id
  ) VALUES (v_household_id, v_plan_id, 1, 0, 0, 'USD', 10, 'available-v1', v_user_id);

  INSERT INTO accounts (
    household_id, name, account_type, currency, provenance, include_in_plan
  ) VALUES (v_household_id, 'Manual cash', 'cash', 'USD', 'manual', true)
  RETURNING id INTO v_account_id;

  INSERT INTO balance_observations (
    household_id, account_id, amount_minor, currency, provenance, as_of,
    source_record_id
  ) VALUES (v_household_id, v_account_id, 0, 'USD', 'manual', now(), 'provisioned');

  INSERT INTO activity_events (
    household_id, actor_user_id, event_type, title, detail, provenance,
    entity_type, entity_id
  ) VALUES (
    v_household_id, v_user_id, 'workspace.provisioned', 'Budgefi workspace created',
    'Private household, manual cash account, and conservative plan initialized',
    'derived', 'household', v_household_id
  );

  RETURN QUERY SELECT v_user_id, v_household_id, 'owner'::text;
END
$$;

CREATE OR REPLACE FUNCTION resolve_system_household_actor(p_household_id uuid)
RETURNS TABLE(user_id uuid, membership_role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid;
  v_membership_role text;
BEGIN
  PERFORM set_config('app.user_id', '', true);
  PERFORM set_config('app.household_id', p_household_id::text, true);

  SELECT m.user_id, m.role
  INTO v_user_id, v_membership_role
  FROM household_memberships m
  JOIN households h ON h.id = m.household_id
  WHERE m.household_id = p_household_id
    AND m.revoked_at IS NULL
    AND h.deleted_at IS NULL
  ORDER BY CASE WHEN m.role = 'owner' THEN 0 ELSE 1 END, m.created_at
  LIMIT 1;

  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM set_config('app.user_id', v_user_id::text, true);
  RETURN QUERY SELECT v_user_id, v_membership_role;
END
$$;

REVOKE ALL ON FUNCTION resolve_principal(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION provision_principal(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_system_household_actor(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_principal(text, uuid) TO budgefi_app;
GRANT EXECUTE ON FUNCTION provision_principal(text, text, text) TO budgefi_app;
GRANT EXECUTE ON FUNCTION resolve_system_household_actor(uuid) TO budgefi_app;
