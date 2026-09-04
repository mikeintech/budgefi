-- Planning periods preserve forecast decisions. Pay cycles preserve verified
-- payday-to-payday history. They are deliberately separate so an expected or
-- fallback date can never masquerade as received income.

-- The production migration owner remains subject to forced tenant RLS.
ALTER TABLE accounts NO FORCE ROW LEVEL SECURITY;

CREATE TABLE account_planning_role_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  account_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0),
  planning_role text NOT NULL CHECK(planning_role IN ('spendable','protected','excluded')),
  account_name text NOT NULL,
  account_type text NOT NULL,
  provenance text NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  effective_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,account_id,version),
  FOREIGN KEY(household_id,account_id) REFERENCES accounts(household_id,id) ON DELETE CASCADE
);

INSERT INTO account_planning_role_revisions(household_id,account_id,version,planning_role,account_name,account_type,provenance,effective_at)
SELECT household_id,id,1,CASE WHEN archived_at IS NULL THEN planning_role ELSE 'excluded' END,name,account_type,provenance,created_at FROM accounts;

ALTER TABLE accounts FORCE ROW LEVEL SECURITY;

CREATE FUNCTION record_account_planning_role_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v_version integer;
BEGIN
  IF TG_OP='INSERT' OR NEW.planning_role IS DISTINCT FROM OLD.planning_role OR NEW.name IS DISTINCT FROM OLD.name OR NEW.account_type IS DISTINCT FROM OLD.account_type OR NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
    -- The account row version is an optimistic-lock counter and is not
    -- guaranteed to advance for every historically relevant field. Keep a
    -- separate, gap-free history version while the account row is locked by
    -- the INSERT/UPDATE that invoked this trigger.
    SELECT coalesce(max(version),0)+1 INTO v_version
    FROM account_planning_role_revisions
    WHERE household_id=NEW.household_id AND account_id=NEW.id;
    INSERT INTO account_planning_role_revisions(household_id,account_id,version,planning_role,account_name,account_type,provenance,actor_user_id,effective_at)
    VALUES(NEW.household_id,NEW.id,v_version,CASE WHEN NEW.archived_at IS NULL THEN NEW.planning_role ELSE 'excluded' END,NEW.name,NEW.account_type,NEW.provenance,nullif(current_setting('app.user_id',true),'')::uuid,now());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_planning_role_history AFTER INSERT OR UPDATE OF planning_role,name,account_type,archived_at ON accounts
  FOR EACH ROW EXECUTE FUNCTION record_account_planning_role_revision();

-- Every write that can alter a report takes the same household lock before it
-- changes canonical state. Report reads take this lock before choosing their
-- event cutoff, so a revision never claims facts committed halfway through it.
CREATE FUNCTION lock_pay_cycle_household() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v_household_id uuid;
BEGIN
  v_household_id:=CASE WHEN TG_OP='DELETE' THEN OLD.household_id ELSE NEW.household_id END;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_household_id::text,7241));
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY[
  'accounts','balance_observations','financial_transactions','transaction_entities',
  'transaction_category_assignments','plan_occurrences','occurrence_transaction_matches',
  'savings_goal_movements','savings_movement_evidence','debt_payment_evidence',
  'debt_payment_evidence_reversals','income_schedules'
] LOOP
  EXECUTE format('CREATE TRIGGER pay_cycle_household_lock BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION lock_pay_cycle_household()',t);
END LOOP; END $$;

CREATE TABLE planning_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  start_on date NOT NULL,
  -- Date ranges are half-open: [start_on,end_on).
  end_on date NOT NULL CHECK(end_on>start_on),
  timezone_snapshot text NOT NULL,
  boundary_basis text NOT NULL CHECK(boundary_basis IN ('expected_income','fallback')),
  driving_income_schedule_id uuid,
  driving_expected_occurrence_id uuid,
  policy_version text NOT NULL,
  input_fingerprint text NOT NULL CHECK(length(input_fingerprint)=64),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,id),
  UNIQUE(household_id,input_fingerprint),
  FOREIGN KEY(household_id,driving_income_schedule_id) REFERENCES income_schedules(household_id,id),
  FOREIGN KEY(household_id,driving_expected_occurrence_id) REFERENCES plan_occurrences(household_id,id)
);
CREATE TABLE planning_period_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), household_id uuid NOT NULL,
  planning_period_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
  supersedes_revision_id uuid, state text NOT NULL CHECK(state IN ('active','elapsed_verified','elapsed_unverified','replaced')),
  reason text NOT NULL CHECK(reason IN ('initial','payday_verified','expected_income_missed','fallback_elapsed','planning_input_changed')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,planning_period_id,version), UNIQUE(household_id,id),
  FOREIGN KEY(household_id,planning_period_id) REFERENCES planning_periods(household_id,id) ON DELETE CASCADE,
  FOREIGN KEY(household_id,supersedes_revision_id) REFERENCES planning_period_revisions(household_id,id)
);

CREATE TABLE income_boundaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  boundary_on date NOT NULL, timezone_snapshot text NOT NULL,
  verification_level text NOT NULL CHECK(verification_level IN ('provider_verified','user_confirmed')),
  verified_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,id), UNIQUE(household_id,boundary_on)
);
CREATE TABLE income_boundary_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), household_id uuid NOT NULL,
  income_boundary_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
  state text NOT NULL CHECK(state IN ('verified','invalidated')),
  verification_level text NOT NULL CHECK(verification_level IN ('provider_verified','user_confirmed')),
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 240), recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,id), UNIQUE(household_id,income_boundary_id,version),
  FOREIGN KEY(household_id,income_boundary_id) REFERENCES income_boundaries(household_id,id) ON DELETE CASCADE
);
CREATE TABLE income_boundary_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), household_id uuid NOT NULL,
  income_boundary_id uuid NOT NULL, income_occurrence_id uuid NOT NULL, income_occurrence_version integer NOT NULL,
  income_schedule_id uuid NOT NULL, income_schedule_version integer NOT NULL,
  match_id uuid NOT NULL, match_version integer NOT NULL,
  transaction_id uuid NOT NULL, transaction_revision integer NOT NULL,
  balance_observation_id uuid NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>0),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(household_id,id), UNIQUE(household_id,match_id,match_version),
  FOREIGN KEY(household_id,income_boundary_id) REFERENCES income_boundaries(household_id,id) ON DELETE CASCADE,
  FOREIGN KEY(household_id,income_occurrence_id) REFERENCES plan_occurrences(household_id,id),
  FOREIGN KEY(household_id,income_schedule_id) REFERENCES income_schedules(household_id,id),
  FOREIGN KEY(household_id,match_id) REFERENCES occurrence_transaction_matches(household_id,id),
  FOREIGN KEY(household_id,transaction_id) REFERENCES financial_transactions(household_id,id),
  FOREIGN KEY(household_id,balance_observation_id) REFERENCES balance_observations(household_id,id)
);

CREATE TABLE pay_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  start_boundary_id uuid NOT NULL, end_boundary_id uuid,
  start_on date NOT NULL, end_on date, timezone_snapshot text NOT NULL,
  supersedes_cycle_id uuid,
  topology_reason text NOT NULL CHECK(topology_reason IN ('initial','normal_close','boundary_correction')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,id),
  FOREIGN KEY(household_id,start_boundary_id) REFERENCES income_boundaries(household_id,id),
  FOREIGN KEY(household_id,end_boundary_id) REFERENCES income_boundaries(household_id,id),
  FOREIGN KEY(household_id,supersedes_cycle_id) REFERENCES pay_cycles(household_id,id),
  CHECK((end_boundary_id IS NULL)=(end_on IS NULL)), CHECK(end_on IS NULL OR end_on>start_on)
);
CREATE UNIQUE INDEX pay_cycles_topology_unique ON pay_cycles(household_id,start_boundary_id,coalesce(end_boundary_id,'00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX pay_cycles_household_end_idx ON pay_cycles(household_id,end_on DESC NULLS FIRST,id);

CREATE TABLE pay_cycle_report_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), household_id uuid NOT NULL, pay_cycle_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0), supersedes_revision_id uuid,
  event_cutoff_at timestamptz NOT NULL, algorithm_version text NOT NULL,
  calculated_at timestamptz NOT NULL DEFAULT now(), status text NOT NULL CHECK(status IN ('provisional','closed','revised')),
  assurance text NOT NULL CHECK(assurance IN ('complete','incomplete','user_confirmed')),
  coverage_reason text, earned_minor bigint, spent_minor bigint, pending_minor bigint NOT NULL DEFAULT 0,
  saved_minor bigint, savings_withdrawn_minor bigint, commitments_expected_minor bigint,
  commitments_paid_minor bigint, commitments_remaining_minor bigint, debt_paid_minor bigint,
  opening_cash_minor bigint, closing_cash_minor bigint, unexplained_delta_minor bigint,
  currency char(3) NOT NULL DEFAULT 'USD' CHECK(currency='USD'), output jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_fingerprint text NOT NULL CHECK(length(input_fingerprint)=64),
  UNIQUE(household_id,id), UNIQUE(household_id,pay_cycle_id,version), UNIQUE(household_id,pay_cycle_id,input_fingerprint),
  FOREIGN KEY(household_id,pay_cycle_id) REFERENCES pay_cycles(household_id,id) ON DELETE CASCADE,
  FOREIGN KEY(household_id,supersedes_revision_id) REFERENCES pay_cycle_report_revisions(household_id,id)
);
CREATE INDEX pay_cycle_reports_latest_idx ON pay_cycle_report_revisions(household_id,pay_cycle_id,version DESC);

CREATE TABLE pay_cycle_report_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), household_id uuid NOT NULL, report_revision_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal>=0), input_kind text NOT NULL CHECK(input_kind IN (
    'transaction','occurrence_revision','occurrence_match_revision','savings_movement','savings_movement_evidence','debt_payment_evidence',
    'balance_observation','account_role_revision','boundary_evidence','income_schedule_revision',
    'transaction_category_revision'
  )),
  input_id uuid NOT NULL, input_version integer, role text NOT NULL,
  amount_attributed_minor bigint, input_snapshot jsonb NOT NULL,
  input_hash text NOT NULL CHECK(length(input_hash)=64),
  UNIQUE(household_id,report_revision_id,ordinal),
  FOREIGN KEY(household_id,report_revision_id) REFERENCES pay_cycle_report_revisions(household_id,id) ON DELETE CASCADE
);
CREATE INDEX pay_cycle_report_inputs_reverse_idx ON pay_cycle_report_inputs(household_id,input_kind,input_id);

-- Generic manifests are useful for exact replay, but only if every referenced
-- UUID/version is validated inside the tenant boundary at write time.
CREATE FUNCTION validate_pay_cycle_report_input() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v_exists boolean:=false;
BEGIN
  CASE NEW.input_kind
    WHEN 'transaction' THEN SELECT EXISTS(SELECT 1 FROM financial_transactions x WHERE x.household_id=NEW.household_id AND x.id=NEW.input_id AND (NEW.input_version IS NULL OR x.revision=NEW.input_version)) INTO v_exists;
    WHEN 'occurrence_revision' THEN SELECT EXISTS(SELECT 1 FROM plan_occurrence_revisions x WHERE x.household_id=NEW.household_id AND x.id=NEW.input_id AND (NEW.input_version IS NULL OR x.version=NEW.input_version)) INTO v_exists;
    WHEN 'occurrence_match_revision' THEN SELECT EXISTS(SELECT 1 FROM occurrence_match_revisions x WHERE x.household_id=NEW.household_id AND x.id=NEW.input_id AND (NEW.input_version IS NULL OR x.version=NEW.input_version)) INTO v_exists;
    WHEN 'savings_movement' THEN SELECT EXISTS(SELECT 1 FROM savings_goal_movements x WHERE x.household_id=NEW.household_id AND x.id=NEW.input_id) INTO v_exists;
    WHEN 'savings_movement_evidence' THEN SELECT EXISTS(SELECT 1 FROM savings_movement_evidence x WHERE x.household_id=NEW.household_id AND x.id=NEW.input_id) INTO v_exists;
    WHEN 'debt_payment_evidence' THEN SELECT EXISTS(SELECT 1 FROM debt_payment_evidence x WHERE x.household_id=NEW.household_id AND x.id=NEW.input_id) INTO v_exists;
    WHEN 'balance_observation' THEN SELECT EXISTS(SELECT 1 FROM balance_observations x WHERE x.household_id=NEW.household_id AND x.id=NEW.input_id) INTO v_exists;
    WHEN 'account_role_revision' THEN SELECT EXISTS(SELECT 1 FROM account_planning_role_revisions x WHERE x.household_id=NEW.household_id AND x.id=NEW.input_id AND (NEW.input_version IS NULL OR x.version=NEW.input_version)) INTO v_exists;
    WHEN 'boundary_evidence' THEN SELECT EXISTS(SELECT 1 FROM income_boundary_evidence x WHERE x.household_id=NEW.household_id AND x.id=NEW.input_id) INTO v_exists;
    WHEN 'income_schedule_revision' THEN SELECT EXISTS(SELECT 1 FROM income_schedule_revisions x WHERE x.household_id=NEW.household_id AND x.id=NEW.input_id AND (NEW.input_version IS NULL OR x.version=NEW.input_version)) INTO v_exists;
    WHEN 'transaction_category_revision' THEN SELECT EXISTS(SELECT 1 FROM transaction_category_revisions x WHERE x.household_id=NEW.household_id AND x.id=NEW.input_id AND (NEW.input_version IS NULL OR x.version=NEW.input_version)) INTO v_exists;
  END CASE;
  IF NOT v_exists THEN RAISE EXCEPTION 'invalid pay-cycle report input % %',NEW.input_kind,NEW.input_id; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pay_cycle_report_input_owner BEFORE INSERT ON pay_cycle_report_inputs
  FOR EACH ROW EXECUTE FUNCTION validate_pay_cycle_report_input();

CREATE TABLE pay_cycle_account_coverage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), household_id uuid NOT NULL, report_revision_id uuid NOT NULL,
  account_id uuid NOT NULL, planning_role text NOT NULL, provenance text NOT NULL,
  opening_observation_id uuid, closing_observation_id uuid,
  coverage_state text NOT NULL CHECK(coverage_state IN ('complete','missing_opening','missing_closing','role_changed','stale','excluded')),
  reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,report_revision_id,account_id),
  FOREIGN KEY(household_id,report_revision_id) REFERENCES pay_cycle_report_revisions(household_id,id) ON DELETE CASCADE,
  FOREIGN KEY(household_id,account_id) REFERENCES accounts(household_id,id),
  FOREIGN KEY(household_id,opening_observation_id) REFERENCES balance_observations(household_id,id),
  FOREIGN KEY(household_id,closing_observation_id) REFERENCES balance_observations(household_id,id)
);

DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['account_planning_role_revisions','planning_periods','planning_period_revisions','income_boundaries','income_boundary_revisions','income_boundary_evidence','pay_cycles','pay_cycle_report_revisions','pay_cycle_report_inputs','pay_cycle_account_coverage'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY household_isolation ON %I USING(household_id=nullif(current_setting(''app.household_id'',true),'''')::uuid) WITH CHECK(household_id=nullif(current_setting(''app.household_id'',true),'''')::uuid)',t);
END LOOP; END $$;

CREATE TRIGGER account_planning_role_revisions_append_only BEFORE UPDATE OR DELETE ON account_planning_role_revisions FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER planning_periods_append_only BEFORE UPDATE OR DELETE ON planning_periods FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER planning_period_revisions_append_only BEFORE UPDATE OR DELETE ON planning_period_revisions FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER income_boundaries_append_only BEFORE UPDATE OR DELETE ON income_boundaries FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER income_boundary_revisions_append_only BEFORE UPDATE OR DELETE ON income_boundary_revisions FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER income_boundary_evidence_append_only BEFORE UPDATE OR DELETE ON income_boundary_evidence FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER pay_cycles_append_only BEFORE UPDATE OR DELETE ON pay_cycles FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER pay_cycle_report_revisions_append_only BEFORE UPDATE OR DELETE ON pay_cycle_report_revisions FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER pay_cycle_report_inputs_append_only BEFORE UPDATE OR DELETE ON pay_cycle_report_inputs FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER pay_cycle_account_coverage_append_only BEFORE UPDATE OR DELETE ON pay_cycle_account_coverage FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

GRANT SELECT,INSERT ON account_planning_role_revisions,planning_periods,planning_period_revisions,income_boundaries,income_boundary_revisions,income_boundary_evidence,pay_cycles,pay_cycle_report_revisions,pay_cycle_report_inputs,pay_cycle_account_coverage TO budgefi_app,budgefi_plaid_worker;

CREATE FUNCTION delete_pay_cycle_history_with_plan() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF nullif(current_setting('app.account_deletion_request_id',true),'') IS NULL THEN RAISE EXCEPTION 'pay cycle cleanup requires account deletion boundary'; END IF;
  DELETE FROM pay_cycle_account_coverage WHERE household_id=OLD.household_id;
  DELETE FROM pay_cycle_report_inputs WHERE household_id=OLD.household_id;
  DELETE FROM pay_cycle_report_revisions WHERE household_id=OLD.household_id;
  DELETE FROM pay_cycles WHERE household_id=OLD.household_id;
  DELETE FROM income_boundary_evidence WHERE household_id=OLD.household_id;
  DELETE FROM income_boundary_revisions WHERE household_id=OLD.household_id;
  DELETE FROM income_boundaries WHERE household_id=OLD.household_id;
  DELETE FROM planning_period_revisions WHERE household_id=OLD.household_id;
  DELETE FROM planning_periods WHERE household_id=OLD.household_id;
  DELETE FROM account_planning_role_revisions WHERE household_id=OLD.household_id;
  RETURN OLD;
END $$;
CREATE TRIGGER plans_00_delete_pay_cycle_history BEFORE DELETE ON plans FOR EACH ROW EXECUTE FUNCTION delete_pay_cycle_history_with_plan();

-- The existing deletion finalizer removes occurrence and transaction evidence
-- before the plan row. Clean the history at the first occurrence deletion as
-- well; the plan trigger remains the fallback for households with no rows.
CREATE TRIGGER occurrences_delete_pay_cycle_history BEFORE DELETE ON plan_occurrences
  FOR EACH ROW EXECUTE FUNCTION delete_pay_cycle_history_with_plan();
