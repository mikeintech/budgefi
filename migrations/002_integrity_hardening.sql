ALTER TABLE accounts
  DROP CONSTRAINT accounts_household_id_provenance_provider_account_id_key;

CREATE UNIQUE INDEX accounts_provider_identity_unique
  ON accounts (household_id, provenance, provider_account_id)
  WHERE provider_account_id IS NOT NULL;

ALTER TABLE accounts
  ADD COLUMN include_in_plan boolean NOT NULL DEFAULT false,
  ADD COLUMN connection_id uuid;

UPDATE accounts
SET include_in_plan = true
WHERE account_type IN ('cash', 'checking');

ALTER TABLE accounts
  ADD CONSTRAINT accounts_plan_inclusion_type_check
    CHECK (NOT include_in_plan OR account_type IN ('cash', 'checking', 'savings')),
  ADD CONSTRAINT accounts_connection_fk
    FOREIGN KEY (household_id, connection_id) REFERENCES connections(household_id, id);

ALTER TABLE commitments
  ADD COLUMN settled_at timestamptz;

ALTER TABLE plans
  ADD COLUMN planning_horizon_days integer NOT NULL DEFAULT 10
    CHECK (planning_horizon_days BETWEEN 1 AND 90);

ALTER TABLE financial_transactions
  ADD COLUMN direction text NOT NULL DEFAULT 'debit'
    CHECK (direction IN ('debit', 'credit'));

CREATE TABLE plan_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  version integer NOT NULL,
  planned_savings_minor bigint NOT NULL,
  safety_buffer_minor bigint NOT NULL,
  currency char(3) NOT NULL CHECK (currency = 'USD'),
  planning_horizon_days integer NOT NULL,
  policy_version text NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, plan_id, version),
  FOREIGN KEY (household_id, plan_id) REFERENCES plans(household_id, id)
);

CREATE TABLE commitment_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  commitment_id uuid NOT NULL,
  version integer NOT NULL,
  name text NOT NULL,
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL CHECK (currency = 'USD'),
  due_date date,
  active boolean NOT NULL,
  settled_at timestamptz,
  actor_user_id uuid REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, commitment_id, version),
  FOREIGN KEY (household_id, commitment_id) REFERENCES commitments(household_id, id)
);

INSERT INTO plan_revisions (
  household_id, plan_id, version, planned_savings_minor, safety_buffer_minor,
  currency, planning_horizon_days, policy_version
)
SELECT household_id, id, version, planned_savings_minor, safety_buffer_minor,
       currency, planning_horizon_days, calculation_policy_version
FROM plans;

INSERT INTO commitment_revisions (
  household_id, commitment_id, version, name, amount_minor, currency,
  due_date, active, settled_at
)
SELECT household_id, id, version, name, amount_minor, currency,
       due_date, active, settled_at
FROM commitments;

CREATE OR REPLACE FUNCTION reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END
$$;

CREATE TRIGGER activity_events_append_only
  BEFORE UPDATE OR DELETE ON activity_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER calculation_snapshots_append_only
  BEFORE UPDATE OR DELETE ON calculation_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER plan_revisions_append_only
  BEFORE UPDATE OR DELETE ON plan_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER commitment_revisions_append_only
  BEFORE UPDATE OR DELETE ON commitment_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

ALTER TABLE plan_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON plan_revisions
  USING (household_id = nullif(current_setting('app.household_id', true), '')::uuid)
  WITH CHECK (household_id = nullif(current_setting('app.household_id', true), '')::uuid);

ALTER TABLE commitment_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE commitment_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON commitment_revisions
  USING (household_id = nullif(current_setting('app.household_id', true), '')::uuid)
  WITH CHECK (household_id = nullif(current_setting('app.household_id', true), '')::uuid);

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM budgefi_app;

GRANT SELECT ON households, household_memberships, accounts, balance_observations,
  financial_transactions, commitments, plans, calculation_snapshots,
  plan_revisions, commitment_revisions, activity_events, connections,
  exception_cases, case_evidence
TO budgefi_app;

GRANT INSERT ON balance_observations, financial_transactions, commitments,
  commitment_revisions, plan_revisions, calculation_snapshots, activity_events,
  idempotency_records
TO budgefi_app;

GRANT SELECT ON idempotency_records TO budgefi_app;
GRANT UPDATE (response_status, response_body) ON idempotency_records TO budgefi_app;
GRANT UPDATE (planned_savings_minor, safety_buffer_minor, version, updated_at)
  ON plans TO budgefi_app;

REVOKE ALL ON users, schema_migrations FROM budgefi_app;
