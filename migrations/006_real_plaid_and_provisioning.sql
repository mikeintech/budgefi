ALTER TABLE users
  ADD COLUMN email text,
  ADD COLUMN provisioned_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE balance_observations
  DROP CONSTRAINT balance_observations_amount_minor_check,
  ADD CONSTRAINT balance_observations_amount_minor_check
    CHECK (amount_minor BETWEEN -1000000000000000 AND 1000000000000000),
  ADD COLUMN balance_basis text NOT NULL DEFAULT 'manual'
    CHECK (balance_basis IN ('manual', 'available', 'current')),
  ADD COLUMN provider_request_id text;

ALTER TABLE financial_transactions
  DROP CONSTRAINT financial_transactions_amount_minor_check,
  ADD CONSTRAINT financial_transactions_amount_minor_check
    CHECK (amount_minor BETWEEN 0 AND 1000000000000000);

ALTER TABLE connections
  ADD COLUMN environment text CHECK (environment IN ('sandbox', 'development', 'production')),
  ADD COLUMN institution_id text,
  ADD COLUMN institution_name text,
  ADD COLUMN token_key_id text,
  ADD COLUMN error_code text,
  ADD COLUMN consent_expires_at timestamptz,
  ADD COLUMN initial_update_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN historical_update_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN revoked_at timestamptz;

ALTER TABLE connections
  DROP CONSTRAINT connections_status_check,
  ADD CONSTRAINT connections_status_check CHECK (status IN (
    'pending', 'syncing', 'healthy', 'stale', 'login_required', 'error',
    'revocation_pending', 'revoked'
  )),
  ADD CONSTRAINT plaid_token_envelope_check CHECK (
    provider <> 'plaid'
    OR status IN ('revoked')
    OR (encrypted_access_token IS NOT NULL AND token_key_id IS NOT NULL AND environment IS NOT NULL)
  );

CREATE TABLE plaid_link_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id),
  user_id uuid NOT NULL REFERENCES users(id),
  mode text NOT NULL CHECK (mode IN ('create', 'update')),
  connection_id uuid,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'development', 'production')),
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'exchanging', 'completed', 'failed', 'expired')),
  public_token_hash text,
  encrypted_public_token bytea,
  public_token_key_id text,
  link_session_id text,
  provider_item_id text,
  error_code text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (household_id, id),
  UNIQUE (environment, public_token_hash),
  FOREIGN KEY (household_id, connection_id) REFERENCES connections(household_id, id),
  CHECK ((mode = 'create' AND connection_id IS NULL) OR mode = 'update')
);

CREATE INDEX plaid_link_sessions_active_idx
  ON plaid_link_sessions (household_id, user_id, expires_at)
  WHERE status IN ('created', 'exchanging');

CREATE TABLE plaid_sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  webhook_receipt_id uuid,
  operation text NOT NULL DEFAULT 'sync' CHECK (operation IN ('sync', 'revoke')),
  trigger text NOT NULL CHECK (trigger IN ('initial', 'webhook', 'manual', 'recovery')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  completed_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  UNIQUE (webhook_receipt_id),
  FOREIGN KEY (household_id, connection_id) REFERENCES connections(household_id, id),
  FOREIGN KEY (webhook_receipt_id) REFERENCES webhook_receipts(id)
);

CREATE UNIQUE INDEX plaid_sync_jobs_one_active_per_connection
  ON plaid_sync_jobs (connection_id, operation)
  WHERE state IN ('queued', 'running');
CREATE INDEX plaid_sync_jobs_poll_idx
  ON plaid_sync_jobs (available_at, created_at)
  WHERE state = 'queued';

CREATE TABLE plaid_unknown_webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider = 'plaid'),
  provider_item_id text,
  environment text,
  event_type text NOT NULL,
  event_code text,
  payload_hash text NOT NULL UNIQUE,
  verification_key_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE webhook_receipts
  ADD COLUMN environment text CHECK (environment IN ('sandbox', 'development', 'production')),
  ADD COLUMN event_code text,
  ADD COLUMN provider_item_id text,
  ADD COLUMN verification_key_id text,
  ADD COLUMN signature_issued_at timestamptz,
  ADD COLUMN processing_status text NOT NULL DEFAULT 'queued' CHECK (processing_status IN ('queued', 'processed', 'ignored', 'failed')),
  ADD COLUMN error_code text;

CREATE UNIQUE INDEX financial_transactions_plaid_latest_identity
  ON financial_transactions (household_id, account_id, source_record_id, revision)
  WHERE source_kind = 'plaid';

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
  WHERE u.auth_subject = p_auth_subject AND u.deleted_at IS NULL;

  IF v_user_id IS NULL THEN
    v_name := left(coalesce(nullif(trim(p_display_name), ''), 'Budgefi member'), 120);
    INSERT INTO users (auth_subject, display_name, email)
    VALUES (p_auth_subject, v_name, nullif(trim(p_email), ''))
    RETURNING id INTO v_user_id;

    INSERT INTO households (name)
    VALUES (left(v_name || '''s household', 160))
    RETURNING id INTO v_household_id;

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
  END IF;

  RETURN QUERY
  SELECT u.id, m.household_id, m.role
  FROM users u
  JOIN household_memberships m ON m.user_id = u.id AND m.revoked_at IS NULL
  JOIN households h ON h.id = m.household_id AND h.deleted_at IS NULL
  WHERE u.id = v_user_id
  ORDER BY m.created_at
  LIMIT 1;
END
$$;

REVOKE ALL ON FUNCTION provision_principal(text, text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION resolve_principal(p_auth_subject text, p_household_id uuid DEFAULT NULL)
RETURNS TABLE(user_id uuid, household_id uuid, membership_role text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT u.id, m.household_id, m.role
  FROM users u
  JOIN household_memberships m ON m.user_id = u.id
  JOIN households h ON h.id = m.household_id
  WHERE u.auth_subject = p_auth_subject
    AND u.deleted_at IS NULL
    AND m.revoked_at IS NULL
    AND h.deleted_at IS NULL
    AND (
      m.household_id = p_household_id
      OR (
        p_household_id IS NULL
        AND 1 = (
          SELECT count(*)
          FROM household_memberships active_membership
          JOIN households active_household ON active_household.id = active_membership.household_id
          WHERE active_membership.user_id = u.id
            AND active_membership.revoked_at IS NULL
            AND active_household.deleted_at IS NULL
        )
      )
    )
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION resolve_principal(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_principal(text, uuid) TO budgefi_app;

CREATE OR REPLACE FUNCTION resolve_plaid_webhook_connection(p_item_id text, p_environment text)
RETURNS TABLE(connection_id uuid, household_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT c.id, c.household_id
  FROM connections c
  WHERE c.provider = 'plaid'
    AND c.provider_item_id = p_item_id
    AND c.environment = p_environment
    AND c.status <> 'revoked'
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION claim_plaid_sync_job(p_job_id uuid DEFAULT NULL)
RETURNS TABLE(job_id uuid, household_id uuid, connection_id uuid, operation text, job_trigger text, attempts integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  claimed plaid_sync_jobs%ROWTYPE;
BEGIN
  UPDATE plaid_sync_jobs
  SET state = 'queued', locked_at = NULL, available_at = now(), last_error_code = 'LEASE_RECOVERED'
  WHERE state = 'running' AND locked_at < now() - interval '5 minutes';

  SELECT * INTO claimed
  FROM plaid_sync_jobs j
  WHERE j.state = 'queued'
    AND j.available_at <= now()
    AND (p_job_id IS NULL OR j.id = p_job_id)
  ORDER BY j.created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF claimed.id IS NULL THEN RETURN; END IF;
  UPDATE plaid_sync_jobs
  SET state = 'running', locked_at = now(), attempts = plaid_sync_jobs.attempts + 1
  WHERE id = claimed.id;
  RETURN QUERY SELECT claimed.id, claimed.household_id, claimed.connection_id,
    claimed.operation, claimed.trigger, claimed.attempts + 1;
END
$$;

REVOKE ALL ON FUNCTION resolve_plaid_webhook_connection(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_plaid_sync_job(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_plaid_webhook_connection(text, text) TO budgefi_app;
GRANT EXECUTE ON FUNCTION claim_plaid_sync_job(uuid) TO budgefi_app;

ALTER TABLE plaid_link_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE plaid_link_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON plaid_link_sessions
  USING (household_id = nullif(current_setting('app.household_id', true), '')::uuid)
  WITH CHECK (household_id = nullif(current_setting('app.household_id', true), '')::uuid);

ALTER TABLE plaid_sync_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE plaid_sync_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON plaid_sync_jobs
  USING (household_id = nullif(current_setting('app.household_id', true), '')::uuid)
  WITH CHECK (household_id = nullif(current_setting('app.household_id', true), '')::uuid);

REVOKE ALL ON plaid_link_sessions, plaid_sync_jobs FROM budgefi_app;
GRANT SELECT, INSERT ON plaid_link_sessions, plaid_sync_jobs TO budgefi_app;
GRANT UPDATE (status, public_token_hash, encrypted_public_token, public_token_key_id, link_session_id, provider_item_id, error_code, completed_at)
  ON plaid_link_sessions TO budgefi_app;
GRANT UPDATE (state, attempts, available_at, locked_at, completed_at, last_error_code)
  ON plaid_sync_jobs TO budgefi_app;

GRANT UPDATE (
  status, sync_cursor, last_successful_sync_at, updated_at, encrypted_access_token,
  token_key_id, institution_id, institution_name, error_code,
  consent_expires_at, initial_update_complete, historical_update_complete, revoked_at
) ON connections TO budgefi_app;
GRANT INSERT ON sync_runs, webhook_receipts TO budgefi_app;
GRANT SELECT ON sync_runs, webhook_receipts TO budgefi_app;
GRANT UPDATE (
  status, cursor_after, added_count, modified_count, removed_count,
  started_at, completed_at, error_code
) ON sync_runs TO budgefi_app;
GRANT UPDATE (processed_at, processing_status, error_code) ON webhook_receipts TO budgefi_app;
GRANT INSERT ON plaid_unknown_webhooks TO budgefi_app;
