CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'budgefi_app') THEN
    CREATE ROLE budgefi_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_subject text NOT NULL UNIQUE,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE households (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/New_York',
  base_currency char(3) NOT NULL DEFAULT 'USD' CHECK (base_currency = 'USD'),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE household_memberships (
  household_id uuid NOT NULL REFERENCES households(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (household_id, user_id)
);

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id),
  name text NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('checking', 'savings', 'cash', 'credit', 'loan', 'other')),
  currency char(3) NOT NULL CHECK (currency = 'USD'),
  provenance text NOT NULL CHECK (provenance IN ('manual', 'csv', 'plaid', 'sample')),
  provider_account_id text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (household_id, id),
  UNIQUE NULLS NOT DISTINCT (household_id, provenance, provider_account_id)
);

CREATE TABLE balance_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  account_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL CHECK (currency = 'USD'),
  provenance text NOT NULL CHECK (provenance IN ('manual', 'csv', 'plaid', 'sample')),
  as_of timestamptz NOT NULL,
  source_record_id text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  UNIQUE NULLS NOT DISTINCT (household_id, account_id, provenance, source_record_id),
  FOREIGN KEY (household_id, account_id) REFERENCES accounts(household_id, id)
);

CREATE TABLE financial_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  account_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('manual', 'csv', 'plaid', 'sample')),
  source_record_id text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  merchant text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency = 'USD'),
  occurred_on date NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'posted', 'removed', 'superseded')),
  pending_source_record_id text,
  source_updated_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  raw_hash text,
  UNIQUE (household_id, id),
  UNIQUE (household_id, account_id, source_kind, source_record_id, revision),
  FOREIGN KEY (household_id, account_id) REFERENCES accounts(household_id, id)
);

CREATE INDEX financial_transactions_household_date_idx
  ON financial_transactions (household_id, occurred_on DESC, recorded_at DESC);

CREATE TABLE commitments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id),
  name text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL CHECK (currency = 'USD'),
  due_date date,
  recurrence text,
  provenance text NOT NULL CHECK (provenance IN ('manual', 'csv', 'plaid', 'sample', 'derived')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id)
);

CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL UNIQUE REFERENCES households(id),
  planned_savings_minor bigint NOT NULL DEFAULT 0 CHECK (planned_savings_minor >= 0),
  safety_buffer_minor bigint NOT NULL DEFAULT 0 CHECK (safety_buffer_minor >= 0),
  currency char(3) NOT NULL CHECK (currency = 'USD'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  calculation_policy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id)
);

CREATE TABLE calculation_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  plan_version integer NOT NULL,
  known_cash_minor bigint NOT NULL,
  commitments_minor bigint NOT NULL,
  planned_savings_minor bigint NOT NULL,
  safety_buffer_minor bigint NOT NULL,
  available_minor bigint NOT NULL,
  currency char(3) NOT NULL CHECK (currency = 'USD'),
  policy_version text NOT NULL,
  input_fingerprint text NOT NULL,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, input_fingerprint),
  FOREIGN KEY (household_id, plan_id) REFERENCES plans(household_id, id)
);

CREATE TABLE activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id),
  actor_user_id uuid REFERENCES users(id),
  event_type text NOT NULL,
  title text NOT NULL,
  detail text NOT NULL,
  entity_type text,
  entity_id uuid,
  provenance text NOT NULL CHECK (provenance IN ('manual', 'csv', 'plaid', 'sample', 'derived')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (household_id, id)
);

CREATE TABLE idempotency_records (
  household_id uuid NOT NULL REFERENCES households(id),
  request_id uuid NOT NULL,
  operation text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  PRIMARY KEY (household_id, request_id)
);

CREATE TABLE connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id),
  provider text NOT NULL CHECK (provider IN ('plaid', 'sample')),
  provider_item_id text NOT NULL,
  encrypted_access_token bytea,
  status text NOT NULL CHECK (status IN ('pending', 'healthy', 'stale', 'error', 'revoked')),
  sync_cursor text,
  last_successful_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  UNIQUE (provider, provider_item_id)
);

CREATE TABLE webhook_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_event_key text NOT NULL,
  connection_id uuid,
  household_id uuid,
  payload_hash text NOT NULL,
  event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, provider_event_key),
  FOREIGN KEY (household_id, connection_id) REFERENCES connections(household_id, id)
);

CREATE TABLE sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('initial', 'webhook', 'scheduled', 'manual', 'recovery')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  cursor_before text,
  cursor_after text,
  added_count integer NOT NULL DEFAULT 0,
  modified_count integer NOT NULL DEFAULT 0,
  removed_count integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, connection_id) REFERENCES connections(household_id, id)
);

CREATE TABLE exception_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id),
  case_type text NOT NULL CHECK (case_type IN ('amount_changed', 'possible_duplicate', 'missing_expected', 'continued_charge')),
  status text NOT NULL CHECK (status IN ('open', 'decided', 'awaiting_verification', 'verified', 'failed', 'expired')),
  expected_amount_minor bigint,
  observed_amount_minor bigint,
  currency char(3) CHECK (currency IS NULL OR currency = 'USD'),
  title text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id)
);

CREATE TABLE case_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  case_id uuid NOT NULL,
  evidence_type text NOT NULL,
  source_entity_type text NOT NULL,
  source_entity_id uuid NOT NULL,
  summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, case_id) REFERENCES exception_cases(household_id, id)
);

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
    AND (p_household_id IS NULL OR m.household_id = p_household_id)
  ORDER BY m.created_at
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION resolve_principal(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_principal(text, uuid) TO budgefi_app;

GRANT USAGE ON SCHEMA public TO budgefi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO budgefi_app;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'accounts', 'balance_observations',
    'financial_transactions', 'commitments', 'plans', 'calculation_snapshots',
    'activity_events', 'idempotency_records', 'connections', 'webhook_receipts',
    'sync_runs', 'exception_cases', 'case_evidence'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY household_isolation ON %I USING (household_id = nullif(current_setting(''app.household_id'', true), '''')::uuid) WITH CHECK (household_id = nullif(current_setting(''app.household_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END
$$;

ALTER TABLE households ENABLE ROW LEVEL SECURITY;
ALTER TABLE households FORCE ROW LEVEL SECURITY;
CREATE POLICY household_self ON households
  USING (id = nullif(current_setting('app.household_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.household_id', true), '')::uuid);

ALTER TABLE household_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE household_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_user ON household_memberships
  USING (
    household_id = nullif(current_setting('app.household_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
  );
