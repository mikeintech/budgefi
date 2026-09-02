-- Retire the old interactive sample-data product path without rewriting the
-- immutable ledger. Historical sample rows remain labeled for audit/export,
-- but are revoked, archived, and excluded from every live product view.

UPDATE connections
SET status = 'revoked',
    revoked_at = coalesce(revoked_at, now()),
    encrypted_access_token = NULL,
    sync_cursor = NULL,
    updated_at = now()
WHERE provider = 'sample'
  AND status <> 'revoked';

UPDATE accounts
SET include_in_plan = false,
    archived_at = coalesce(archived_at, now()),
    version = version + 1
WHERE provenance = 'sample'
  AND (include_in_plan OR archived_at IS NULL);

-- Invalidate server-revision-bound caches and onboarding drafts for every
-- household touched by the retirement, including sample-only households.
UPDATE households h
SET data_revision = h.data_revision + 1
WHERE EXISTS (
  SELECT 1 FROM accounts a
  WHERE a.household_id = h.id AND a.provenance = 'sample'
);

UPDATE exception_cases c
SET status = 'expired',
    updated_at = now(),
    version = version + 1
WHERE c.status IN ('open', 'decided', 'awaiting_verification')
  AND EXISTS (
    SELECT 1
    FROM case_evidence e
    JOIN financial_transactions t
      ON t.household_id = e.household_id
     AND t.id = e.source_entity_id
    WHERE e.household_id = c.household_id
      AND e.case_id = c.id
      AND t.source_kind = 'sample'
  );

-- A household that only completed onboarding against the old sample fixture
-- should see honest setup again. Any real Plaid or user-entered financial data,
-- including plan guardrails, preserves the user's completed status.
WITH sample_households AS (
  SELECT DISTINCT household_id FROM accounts WHERE provenance = 'sample'
)
UPDATE household_memberships m
SET onboarding_completed_at = NULL
FROM sample_households s
WHERE m.household_id = s.household_id
  AND m.onboarding_completed_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.household_id = m.household_id
      AND a.provenance IN ('plaid', 'csv')
      AND a.archived_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM financial_transactions t
    WHERE t.household_id = m.household_id
      AND t.source_kind IN ('manual', 'csv', 'plaid')
  )
  AND NOT EXISTS (
    SELECT 1 FROM balance_observations b
    WHERE b.household_id = m.household_id
      AND b.provenance IN ('manual', 'csv', 'plaid')
      AND coalesce(b.source_record_id, '') <> 'provisioned'
  )
  AND NOT EXISTS (
    SELECT 1 FROM commitments c
    WHERE c.household_id = m.household_id
      AND c.provenance IN ('manual', 'csv', 'plaid')
  )
  AND NOT EXISTS (
    SELECT 1 FROM plans p
    WHERE p.household_id = m.household_id
      AND (p.planned_savings_minor <> 0 OR p.safety_buffer_minor <> 0)
  );

-- A newly provisioned household gets an empty manual account, not a fabricated
-- confirmed $0 observation. The user must explicitly confirm cash, including 0.
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
  ) VALUES (v_household_id, 'Manual cash', 'cash', 'USD', 'manual', true);

  INSERT INTO activity_events (
    household_id, actor_user_id, event_type, title, detail, provenance,
    entity_type, entity_id
  ) VALUES (
    v_household_id, v_user_id, 'workspace.provisioned', 'Budgefi workspace created',
    'Private household and conservative manual plan initialized',
    'derived', 'household', v_household_id
  );

  RETURN QUERY SELECT v_user_id, v_household_id, 'owner'::text;
END
$$;

REVOKE ALL ON FUNCTION provision_principal(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provision_principal(text, text, text) TO budgefi_app;
