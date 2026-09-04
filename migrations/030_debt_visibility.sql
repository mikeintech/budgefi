-- Debt is a liability account plus evidence and a single payment commitment.
-- Provider facts, user payment intent, and ledger payments remain separate.

CREATE TABLE debts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  linked_commitment_id uuid,
  payment_commitment_managed boolean NOT NULL DEFAULT false,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  debt_type text NOT NULL CHECK (debt_type IN ('credit_card','student_loan','mortgage','auto','personal','other')),
  status text NOT NULL DEFAULT 'needs_review' CHECK (status IN ('needs_review','active','paused','closed','archived')),
  provenance text NOT NULL CHECK (provenance IN ('manual','csv','plaid','derived')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,id),
  FOREIGN KEY(household_id,account_id) REFERENCES accounts(household_id,id),
  FOREIGN KEY(household_id,linked_commitment_id) REFERENCES commitments(household_id,id)
);
CREATE UNIQUE INDEX debts_active_account_unique ON debts(household_id,account_id)
  WHERE status<>'archived';
CREATE UNIQUE INDEX debts_active_commitment_unique ON debts(household_id,linked_commitment_id)
  WHERE linked_commitment_id IS NOT NULL AND status<>'archived';
CREATE INDEX debts_household_status_idx ON debts(household_id,status,created_at);

CREATE TABLE debt_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  debt_id uuid NOT NULL,
  account_id uuid NOT NULL,
  linked_commitment_id uuid,
  payment_commitment_managed boolean NOT NULL,
  name text NOT NULL,
  debt_type text NOT NULL,
  status text NOT NULL,
  provenance text NOT NULL,
  version integer NOT NULL CHECK (version>0),
  actor_user_id uuid REFERENCES users(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 240),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,debt_id,version),
  FOREIGN KEY(household_id,debt_id) REFERENCES debts(household_id,id) ON DELETE CASCADE
);

CREATE TABLE debt_balance_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  debt_id uuid NOT NULL,
  current_balance_minor bigint NOT NULL,
  currency char(3) NOT NULL DEFAULT 'USD' CHECK(currency='USD'),
  provenance text NOT NULL CHECK(provenance IN ('manual','csv','plaid')),
  source_record_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,id),
  UNIQUE(household_id,debt_id,provenance,source_record_id),
  FOREIGN KEY(household_id,debt_id) REFERENCES debts(household_id,id) ON DELETE CASCADE
);
CREATE INDEX debt_balance_latest_idx ON debt_balance_observations(household_id,debt_id,observed_at DESC,recorded_at DESC);

CREATE TABLE debt_term_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  debt_id uuid NOT NULL,
  minimum_payment_minor bigint CHECK(minimum_payment_minor IS NULL OR minimum_payment_minor>=0),
  next_due_on date,
  statement_balance_minor bigint CHECK(statement_balance_minor IS NULL OR statement_balance_minor>=0),
  statement_on date,
  last_payment_minor bigint CHECK(last_payment_minor IS NULL OR last_payment_minor>=0),
  last_payment_on date,
  overdue boolean,
  provenance text NOT NULL CHECK(provenance IN ('manual','csv','plaid')),
  source_record_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,debt_id,provenance,source_record_id),
  FOREIGN KEY(household_id,debt_id) REFERENCES debts(household_id,id) ON DELETE CASCADE
);
CREATE INDEX debt_terms_latest_idx ON debt_term_observations(household_id,debt_id,observed_at DESC,recorded_at DESC);

CREATE TABLE debt_apr_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  debt_id uuid NOT NULL,
  component_key text NOT NULL,
  apr_basis_points integer NOT NULL CHECK(apr_basis_points BETWEEN 0 AND 100000),
  balance_minor bigint CHECK(balance_minor IS NULL OR balance_minor>=0),
  apr_type text NOT NULL DEFAULT 'unknown' CHECK(apr_type IN ('purchase','cash_advance','balance_transfer','promotional','fixed','variable','unknown')),
  selected_for_projection boolean NOT NULL DEFAULT false,
  provenance text NOT NULL CHECK(provenance IN ('manual','csv','plaid')),
  source_record_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,debt_id,provenance,source_record_id,component_key),
  FOREIGN KEY(household_id,debt_id) REFERENCES debts(household_id,id) ON DELETE CASCADE
);
CREATE INDEX debt_apr_selected_latest ON debt_apr_components(household_id,debt_id,observed_at DESC,recorded_at DESC)
  WHERE selected_for_projection;

CREATE TABLE debt_payment_policies (
  household_id uuid NOT NULL,
  debt_id uuid NOT NULL,
  mode text NOT NULL CHECK(mode IN ('minimum_due','fixed_amount')),
  fixed_amount_minor bigint CHECK(fixed_amount_minor IS NULL OR fixed_amount_minor>0),
  extra_amount_minor bigint NOT NULL DEFAULT 0 CHECK(extra_amount_minor>=0),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  actor_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(household_id,debt_id),
  FOREIGN KEY(household_id,debt_id) REFERENCES debts(household_id,id) ON DELETE CASCADE,
  CHECK((mode='fixed_amount')=(fixed_amount_minor IS NOT NULL))
);

CREATE TABLE debt_payment_policy_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  debt_id uuid NOT NULL,
  mode text NOT NULL,
  fixed_amount_minor bigint,
  extra_amount_minor bigint NOT NULL,
  version integer NOT NULL CHECK(version>0),
  actor_user_id uuid REFERENCES users(id),
  reason text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,debt_id,version),
  FOREIGN KEY(household_id,debt_id) REFERENCES debts(household_id,id) ON DELETE CASCADE
);

CREATE TABLE debt_payment_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  debt_id uuid NOT NULL,
  occurrence_match_id uuid NOT NULL,
  liability_transaction_id uuid NOT NULL,
  liability_balance_observation_id uuid NOT NULL,
  source_balance_observation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,id),
  UNIQUE(household_id,occurrence_match_id),
  FOREIGN KEY(household_id,debt_id) REFERENCES debts(household_id,id) ON DELETE CASCADE,
  FOREIGN KEY(household_id,occurrence_match_id) REFERENCES occurrence_transaction_matches(household_id,id),
  FOREIGN KEY(household_id,liability_transaction_id) REFERENCES financial_transactions(household_id,id),
  FOREIGN KEY(household_id,liability_balance_observation_id) REFERENCES debt_balance_observations(household_id,id),
  FOREIGN KEY(household_id,source_balance_observation_id) REFERENCES balance_observations(household_id,id)
);

CREATE TABLE debt_payment_evidence_reversals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,evidence_id),
  FOREIGN KEY(household_id,evidence_id) REFERENCES debt_payment_evidence(household_id,id)
);

CREATE TRIGGER debt_revisions_append_only BEFORE UPDATE OR DELETE ON debt_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER debt_balances_append_only BEFORE UPDATE OR DELETE ON debt_balance_observations
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER debt_terms_append_only BEFORE UPDATE OR DELETE ON debt_term_observations
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER debt_aprs_append_only BEFORE UPDATE OR DELETE ON debt_apr_components
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER debt_policy_revisions_append_only BEFORE UPDATE OR DELETE ON debt_payment_policy_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER debt_payment_evidence_append_only BEFORE UPDATE OR DELETE ON debt_payment_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER debt_payment_evidence_reversals_append_only BEFORE UPDATE OR DELETE ON debt_payment_evidence_reversals
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

ALTER TABLE debts ENABLE ROW LEVEL SECURITY; ALTER TABLE debts FORCE ROW LEVEL SECURITY;
ALTER TABLE debt_revisions ENABLE ROW LEVEL SECURITY; ALTER TABLE debt_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE debt_balance_observations ENABLE ROW LEVEL SECURITY; ALTER TABLE debt_balance_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE debt_term_observations ENABLE ROW LEVEL SECURITY; ALTER TABLE debt_term_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE debt_apr_components ENABLE ROW LEVEL SECURITY; ALTER TABLE debt_apr_components FORCE ROW LEVEL SECURITY;
ALTER TABLE debt_payment_policies ENABLE ROW LEVEL SECURITY; ALTER TABLE debt_payment_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE debt_payment_policy_revisions ENABLE ROW LEVEL SECURITY; ALTER TABLE debt_payment_policy_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE debt_payment_evidence ENABLE ROW LEVEL SECURITY; ALTER TABLE debt_payment_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE debt_payment_evidence_reversals ENABLE ROW LEVEL SECURITY; ALTER TABLE debt_payment_evidence_reversals FORCE ROW LEVEL SECURITY;

CREATE POLICY household_isolation ON debts USING(household_id=nullif(current_setting('app.household_id',true),'')::uuid) WITH CHECK(household_id=nullif(current_setting('app.household_id',true),'')::uuid);
CREATE POLICY household_isolation ON debt_revisions USING(household_id=nullif(current_setting('app.household_id',true),'')::uuid) WITH CHECK(household_id=nullif(current_setting('app.household_id',true),'')::uuid);
CREATE POLICY household_isolation ON debt_balance_observations USING(household_id=nullif(current_setting('app.household_id',true),'')::uuid) WITH CHECK(household_id=nullif(current_setting('app.household_id',true),'')::uuid);
CREATE POLICY household_isolation ON debt_term_observations USING(household_id=nullif(current_setting('app.household_id',true),'')::uuid) WITH CHECK(household_id=nullif(current_setting('app.household_id',true),'')::uuid);
CREATE POLICY household_isolation ON debt_apr_components USING(household_id=nullif(current_setting('app.household_id',true),'')::uuid) WITH CHECK(household_id=nullif(current_setting('app.household_id',true),'')::uuid);
CREATE POLICY household_isolation ON debt_payment_policies USING(household_id=nullif(current_setting('app.household_id',true),'')::uuid) WITH CHECK(household_id=nullif(current_setting('app.household_id',true),'')::uuid);
CREATE POLICY household_isolation ON debt_payment_policy_revisions USING(household_id=nullif(current_setting('app.household_id',true),'')::uuid) WITH CHECK(household_id=nullif(current_setting('app.household_id',true),'')::uuid);
CREATE POLICY household_isolation ON debt_payment_evidence USING(household_id=nullif(current_setting('app.household_id',true),'')::uuid) WITH CHECK(household_id=nullif(current_setting('app.household_id',true),'')::uuid);
CREATE POLICY household_isolation ON debt_payment_evidence_reversals USING(household_id=nullif(current_setting('app.household_id',true),'')::uuid) WITH CHECK(household_id=nullif(current_setting('app.household_id',true),'')::uuid);

GRANT SELECT,INSERT,UPDATE ON debts,debt_payment_policies TO budgefi_app;
GRANT SELECT,INSERT ON debt_revisions,debt_balance_observations,debt_term_observations,debt_apr_components,debt_payment_policy_revisions TO budgefi_app;
GRANT SELECT,INSERT ON debt_payment_evidence TO budgefi_app;
GRANT SELECT,INSERT ON debt_payment_evidence_reversals TO budgefi_app;
GRANT SELECT,INSERT,UPDATE ON debts TO budgefi_plaid_worker;
GRANT SELECT,INSERT ON debt_revisions,debt_balance_observations,debt_term_observations,debt_apr_components,debt_payment_evidence,debt_payment_evidence_reversals TO budgefi_plaid_worker;

CREATE FUNCTION delete_debts_with_plan() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF nullif(current_setting('app.account_deletion_request_id',true),'') IS NULL THEN
    RAISE EXCEPTION 'debt cleanup requires account deletion boundary';
  END IF;
  DELETE FROM debt_payment_policy_revisions WHERE household_id=OLD.household_id;
  DELETE FROM debt_payment_evidence_reversals WHERE household_id=OLD.household_id;
  DELETE FROM debt_payment_evidence WHERE household_id=OLD.household_id;
  DELETE FROM debt_payment_policies WHERE household_id=OLD.household_id;
  DELETE FROM debt_apr_components WHERE household_id=OLD.household_id;
  DELETE FROM debt_term_observations WHERE household_id=OLD.household_id;
  DELETE FROM debt_balance_observations WHERE household_id=OLD.household_id;
  DELETE FROM debt_revisions WHERE household_id=OLD.household_id;
  DELETE FROM debts WHERE household_id=OLD.household_id;
  RETURN OLD;
END $$;
CREATE TRIGGER plans_delete_debts BEFORE DELETE ON plans FOR EACH ROW EXECUTE FUNCTION delete_debts_with_plan();
