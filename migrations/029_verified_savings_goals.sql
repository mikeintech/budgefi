-- Verified savings separates a goal, a current-plan reserve, actual movement,
-- and protection from spendable cash. Existing account inclusion choices are
-- preserved; no savings account is silently reclassified as protected.

-- Production migrations run as the table owner without BYPASSRLS. Temporarily
-- relax FORCE only inside this migration transaction so historical tenant rows
-- are visible to the deterministic backfill. Any failure rolls this state back.
ALTER TABLE accounts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE plans NO FORCE ROW LEVEL SECURITY;
ALTER TABLE plan_occurrences NO FORCE ROW LEVEL SECURITY;
ALTER TABLE plan_occurrence_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE plan_revisions NO FORCE ROW LEVEL SECURITY;

ALTER TABLE accounts ADD COLUMN planning_role text;
UPDATE accounts SET planning_role=CASE WHEN include_in_plan THEN 'spendable' ELSE 'excluded' END;
ALTER TABLE accounts ALTER COLUMN planning_role SET DEFAULT 'spendable';
ALTER TABLE accounts ALTER COLUMN planning_role SET NOT NULL;
ALTER TABLE accounts ADD CONSTRAINT accounts_planning_role_check
  CHECK (planning_role IN ('spendable','protected','excluded'));
CREATE INDEX accounts_planning_role_idx
  ON accounts(household_id,planning_role) WHERE archived_at IS NULL;

CREATE FUNCTION initialize_account_planning_role() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Legacy/import paths that explicitly create an excluded account should not
  -- inherit the spendable default. Explicit protected always wins.
  IF NOT NEW.include_in_plan AND NEW.planning_role='spendable' THEN
    NEW.planning_role:='excluded';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accounts_initialize_planning_role
  BEFORE INSERT ON accounts FOR EACH ROW
  EXECUTE FUNCTION initialize_account_planning_role();
CREATE FUNCTION synchronize_account_planning_role() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.planning_role IS DISTINCT FROM OLD.planning_role THEN
    NEW.include_in_plan:=(NEW.planning_role='spendable');
  ELSIF NEW.include_in_plan IS DISTINCT FROM OLD.include_in_plan THEN
    NEW.planning_role:=CASE WHEN NEW.include_in_plan THEN 'spendable' ELSE 'excluded' END;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accounts_synchronize_planning_role
  BEFORE UPDATE OF include_in_plan,planning_role ON accounts FOR EACH ROW
  EXECUTE FUNCTION synchronize_account_planning_role();

CREATE TABLE savings_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  destination_account_id uuid,
  destination_prior_planning_role text CHECK (destination_prior_planning_role IS NULL OR destination_prior_planning_role IN ('spendable','protected','excluded')),
  destination_tracking_started_at timestamptz,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  target_amount_minor bigint CHECK (target_amount_minor IS NULL OR target_amount_minor > 0),
  target_date date,
  contribution_amount_minor bigint NOT NULL DEFAULT 0 CHECK (contribution_amount_minor >= 0),
  schedule text NOT NULL DEFAULT 'planning_period'
    CHECK (schedule IN ('planning_period','one_time','weekly','biweekly','monthly')),
  next_due_on date,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','completed','archived')),
  currency char(3) NOT NULL DEFAULT 'USD' CHECK (currency='USD'),
  provenance text NOT NULL CHECK (provenance IN ('manual','csv','plaid','derived')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,id),
  FOREIGN KEY(household_id,destination_account_id)
    REFERENCES accounts(household_id,id),
  CHECK ((schedule='planning_period') OR next_due_on IS NOT NULL),
  CHECK (target_date IS NULL OR next_due_on IS NULL OR target_date>=next_due_on)
);
CREATE UNIQUE INDEX savings_goals_destination_unique
  ON savings_goals(household_id,destination_account_id)
  WHERE destination_account_id IS NOT NULL AND status<>'archived';
CREATE INDEX savings_goals_active_idx
  ON savings_goals(household_id,status,next_due_on);
CREATE INDEX savings_goals_destination_tracking_idx
  ON savings_goals(household_id,destination_account_id,destination_tracking_started_at)
  WHERE destination_account_id IS NOT NULL AND status<>'archived';

CREATE TABLE savings_goal_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  savings_goal_id uuid NOT NULL,
  destination_account_id uuid,
  destination_prior_planning_role text,
  destination_tracking_started_at timestamptz,
  name text NOT NULL,
  target_amount_minor bigint,
  target_date date,
  contribution_amount_minor bigint NOT NULL,
  schedule text NOT NULL,
  next_due_on date,
  status text NOT NULL,
  currency char(3) NOT NULL CHECK (currency='USD'),
  provenance text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  actor_user_id uuid REFERENCES users(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 240),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,savings_goal_id,version),
  FOREIGN KEY(household_id,savings_goal_id)
    REFERENCES savings_goals(household_id,id) ON DELETE CASCADE,
  FOREIGN KEY(household_id,destination_account_id)
    REFERENCES accounts(household_id,id)
);

ALTER TABLE plan_occurrences ADD COLUMN savings_goal_id uuid;
ALTER TABLE calculation_snapshot_inputs
  DROP CONSTRAINT calculation_snapshot_inputs_input_kind_check;
ALTER TABLE calculation_snapshot_inputs
  ADD CONSTRAINT calculation_snapshot_inputs_input_kind_check CHECK (
    input_kind IN (
      'plan_revision','balance_observation','commitment_revision',
      'plan_occurrence_revision','occurrence_match_revision',
      'savings_goal_revision','savings_goal_movement'
    )
  );
ALTER TABLE plan_occurrences ADD CONSTRAINT plan_occurrences_savings_goal_fk
  FOREIGN KEY(household_id,savings_goal_id)
  REFERENCES savings_goals(household_id,id);
ALTER TABLE plan_occurrences DROP CONSTRAINT plan_occurrences_check;
ALTER TABLE plan_occurrences ADD CONSTRAINT plan_occurrences_owner_check CHECK (
  (kind='commitment' AND commitment_id IS NOT NULL AND savings_goal_id IS NULL) OR
  (kind='savings' AND commitment_id IS NULL AND savings_goal_id IS NOT NULL) OR
  (kind='income' AND commitment_id IS NULL AND savings_goal_id IS NULL)
) NOT VALID;

-- Preserve the old reserve as an unverified General savings goal. It remains
-- an intention only: no opening movement and no protected account are invented.
INSERT INTO savings_goals(
  household_id,name,contribution_amount_minor,schedule,status,currency,provenance
)
SELECT household_id,'Review legacy savings',planned_savings_minor,'planning_period','paused',currency,'manual'
FROM plans WHERE planned_savings_minor>0;

INSERT INTO savings_goal_revisions(
  household_id,savings_goal_id,destination_account_id,destination_prior_planning_role,destination_tracking_started_at,name,target_amount_minor,
  target_date,contribution_amount_minor,schedule,next_due_on,status,currency,
  provenance,version,reason
)
SELECT household_id,id,destination_account_id,destination_prior_planning_role,destination_tracking_started_at,name,target_amount_minor,target_date,
  contribution_amount_minor,schedule,next_due_on,status,currency,provenance,version,
  'Migrated unverified legacy savings reserve'
FROM savings_goals;

UPDATE plan_occurrences occurrence SET
  savings_goal_id=goal.id,
  source_key='savings-goal:'||goal.id::text,
  name=goal.name
FROM savings_goals goal
WHERE occurrence.household_id=goal.household_id AND occurrence.kind='savings'
  AND goal.name='Review legacy savings';

WITH changed AS (
  UPDATE plan_occurrences SET state='skipped',version=version+1,updated_at=now()
  WHERE kind='savings' AND savings_goal_id IS NOT NULL
  RETURNING household_id,id,version,state,matched_amount_minor,verified_at
)
INSERT INTO plan_occurrence_revisions(
  household_id,occurrence_id,version,state,matched_amount_minor,verified_at,
  reason,actor_user_id
)
SELECT household_id,id,version,state,matched_amount_minor,verified_at,
  'Legacy savings reserve requires destination review',NULL
FROM changed;

WITH changed AS (
  UPDATE plans SET planned_savings_minor=0,version=version+1,updated_at=now()
  WHERE planned_savings_minor>0
  RETURNING *
)
INSERT INTO plan_revisions(
  household_id,plan_id,version,planned_savings_minor,safety_buffer_minor,
  currency,planning_horizon_days,income_amount_minor,income_frequency,
  next_income_date,income_confirmed,income_source_name,fallback_horizon_days,
  policy_version,actor_user_id
)
SELECT household_id,id,version,planned_savings_minor,safety_buffer_minor,
  currency,planning_horizon_days,income_amount_minor,income_frequency,
  next_income_date,income_confirmed,income_source_name,fallback_horizon_days,
  calculation_policy_version,NULL
FROM changed;

ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE plans FORCE ROW LEVEL SECURITY;
ALTER TABLE plan_occurrences FORCE ROW LEVEL SECURITY;
ALTER TABLE plan_occurrence_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE plan_revisions FORCE ROW LEVEL SECURITY;

ALTER TABLE plan_occurrences VALIDATE CONSTRAINT plan_occurrences_owner_check;

CREATE TABLE savings_goal_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  savings_goal_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('opening_allocation','contribution','withdrawal','reversal')),
  amount_minor bigint NOT NULL CHECK (amount_minor>0),
  currency char(3) NOT NULL DEFAULT 'USD' CHECK (currency='USD'),
  effective_on date NOT NULL,
  verification_method text NOT NULL CHECK (verification_method IN ('provider_verified','user_confirmed')),
  originating_occurrence_id uuid,
  originating_occurrence_version integer CHECK (originating_occurrence_version IS NULL OR originating_occurrence_version>0),
  reversed_movement_id uuid,
  actor_user_id uuid REFERENCES users(id),
  provenance text NOT NULL CHECK (provenance IN ('manual','plaid','derived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,id),
  FOREIGN KEY(household_id,savings_goal_id)
    REFERENCES savings_goals(household_id,id) ON DELETE CASCADE,
  FOREIGN KEY(household_id,originating_occurrence_id)
    REFERENCES plan_occurrences(household_id,id),
  FOREIGN KEY(household_id,reversed_movement_id)
    REFERENCES savings_goal_movements(household_id,id),
  CHECK ((kind='reversal')=(reversed_movement_id IS NOT NULL)),
  CHECK ((originating_occurrence_id IS NULL)=(originating_occurrence_version IS NULL))
);
CREATE UNIQUE INDEX savings_movement_occurrence_version_unique
  ON savings_goal_movements(household_id,originating_occurrence_id,originating_occurrence_version)
  WHERE kind='contribution';
CREATE UNIQUE INDEX savings_movement_single_reversal_unique
  ON savings_goal_movements(household_id,reversed_movement_id)
  WHERE kind='reversal';
CREATE INDEX savings_goal_movements_timeline_idx
  ON savings_goal_movements(household_id,savings_goal_id,effective_on DESC,created_at DESC);

CREATE TABLE savings_movement_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  movement_id uuid NOT NULL,
  evidence_role text NOT NULL CHECK (evidence_role IN (
    'source_debit','destination_credit','source_balance','destination_balance','manual_balance'
  )),
  transaction_id uuid,
  balance_observation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(household_id,movement_id)
    REFERENCES savings_goal_movements(household_id,id) ON DELETE CASCADE,
  FOREIGN KEY(household_id,transaction_id)
    REFERENCES financial_transactions(household_id,id),
  FOREIGN KEY(household_id,balance_observation_id)
    REFERENCES balance_observations(household_id,id),
  CHECK ((transaction_id IS NULL)<>(balance_observation_id IS NULL))
);
CREATE UNIQUE INDEX savings_movement_transaction_evidence_unique
  ON savings_movement_evidence(household_id,movement_id,evidence_role,transaction_id)
  WHERE transaction_id IS NOT NULL;
CREATE UNIQUE INDEX savings_movement_balance_evidence_unique
  ON savings_movement_evidence(household_id,movement_id,evidence_role,balance_observation_id)
  WHERE balance_observation_id IS NOT NULL;
CREATE UNIQUE INDEX savings_transaction_single_movement_unique
  ON savings_movement_evidence(household_id,transaction_id)
  WHERE transaction_id IS NOT NULL;

CREATE TRIGGER savings_goal_revisions_append_only
  BEFORE UPDATE OR DELETE ON savings_goal_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER savings_goal_movements_append_only
  BEFORE UPDATE OR DELETE ON savings_goal_movements
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER savings_movement_evidence_append_only
  BEFORE UPDATE OR DELETE ON savings_movement_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

ALTER TABLE savings_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE savings_goals FORCE ROW LEVEL SECURITY;
ALTER TABLE savings_goal_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE savings_goal_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE savings_goal_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE savings_goal_movements FORCE ROW LEVEL SECURITY;
ALTER TABLE savings_movement_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE savings_movement_evidence FORCE ROW LEVEL SECURITY;

CREATE POLICY household_isolation ON savings_goals
  USING (household_id=nullif(current_setting('app.household_id',true),'')::uuid)
  WITH CHECK (household_id=nullif(current_setting('app.household_id',true),'')::uuid);
CREATE POLICY household_isolation ON savings_goal_revisions
  USING (household_id=nullif(current_setting('app.household_id',true),'')::uuid)
  WITH CHECK (household_id=nullif(current_setting('app.household_id',true),'')::uuid);
CREATE POLICY household_isolation ON savings_goal_movements
  USING (household_id=nullif(current_setting('app.household_id',true),'')::uuid)
  WITH CHECK (household_id=nullif(current_setting('app.household_id',true),'')::uuid);
CREATE POLICY household_isolation ON savings_movement_evidence
  USING (household_id=nullif(current_setting('app.household_id',true),'')::uuid)
  WITH CHECK (household_id=nullif(current_setting('app.household_id',true),'')::uuid);

GRANT SELECT,INSERT ON savings_goals,savings_goal_revisions,
  savings_goal_movements,savings_movement_evidence TO budgefi_app;
GRANT UPDATE(destination_account_id,name,target_amount_minor,target_date,
  destination_prior_planning_role,destination_tracking_started_at,contribution_amount_minor,schedule,next_due_on,status,version,updated_at)
  ON savings_goals TO budgefi_app;
GRANT UPDATE(planning_role,include_in_plan,version) ON accounts TO budgefi_app;
GRANT INSERT(savings_goal_id) ON plan_occurrences TO budgefi_app;

GRANT SELECT,INSERT ON savings_goals,savings_goal_revisions,
  savings_goal_movements,savings_movement_evidence TO budgefi_plaid_worker;
GRANT UPDATE(status,version,updated_at) ON savings_goals TO budgefi_plaid_worker;
GRANT UPDATE(planning_role,include_in_plan,version) ON accounts TO budgefi_plaid_worker;
GRANT INSERT(savings_goal_id) ON plan_occurrences TO budgefi_plaid_worker;

-- The daily worker materializes active savings intentions independently from
-- commitments. Stable source/date identity makes retries harmless.
CREATE FUNCTION maintain_savings_goal_occurrences()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record; v_count integer:=0;
BEGIN
  IF NOT pg_has_role(session_user,'budgefi_worker','MEMBER') THEN
    RAISE EXCEPTION 'worker capability required';
  END IF;
  FOR r IN
    WITH rules AS (
      SELECT g.*,timezone(h.timezone,now())::date AS today,
        CASE WHEN p.income_confirmed AND p.next_income_date BETWEEN timezone(h.timezone,now())::date AND timezone(h.timezone,now())::date+90
          THEN p.next_income_date ELSE timezone(h.timezone,now())::date+p.fallback_horizon_days END AS horizon_end
      FROM savings_goals g JOIN households h ON h.id=g.household_id
      JOIN plans p ON p.household_id=g.household_id
      WHERE g.status='active' AND g.contribution_amount_minor>0 AND h.deleted_at IS NULL
    ), expanded AS (
      SELECT rules.*,
        CASE schedule
          WHEN 'planning_period' THEN horizon_end
          WHEN 'weekly' THEN next_due_on+(n.value*7)
          WHEN 'biweekly' THEN next_due_on+(n.value*14)
          WHEN 'monthly' THEN (date_trunc('month',next_due_on)+(n.value*interval '1 month')+
            (least(extract(day from next_due_on)::integer,
              extract(day from date_trunc('month',next_due_on)+((n.value+1)*interval '1 month')-interval '1 day')::integer)-1)*interval '1 day')::date
          ELSE next_due_on END AS occurrence_date
      FROM rules CROSS JOIN LATERAL generate_series(
        0,CASE WHEN schedule IN ('planning_period','one_time') THEN 0 ELSE 40 END
      ) n(value)
    )
    INSERT INTO plan_occurrences(household_id,source_key,kind,savings_goal_id,name,expected_amount_minor,expected_on,provenance)
    SELECT household_id,'savings-goal:'||id::text,'savings',id,name,
      contribution_amount_minor,occurrence_date,
      CASE WHEN provenance IN ('manual','csv','plaid','derived') THEN provenance ELSE 'derived' END
    FROM expanded
    WHERE occurrence_date BETWEEN today-90 AND horizon_end
      AND NOT EXISTS (
        SELECT 1 FROM plan_occurrences skipped
        WHERE skipped.household_id=expanded.household_id
          AND skipped.source_key='savings-goal:'||expanded.id::text
          AND skipped.expected_on=expanded.occurrence_date
          AND skipped.state='skipped'
          AND EXISTS (
            SELECT 1 FROM plan_occurrence_revisions revision
            WHERE revision.household_id=skipped.household_id
              AND revision.occurrence_id=skipped.id
              AND revision.state='skipped'
              AND revision.reason='User marked this occurrence as not due'
          )
      )
    ON CONFLICT DO NOTHING
    RETURNING household_id,id,version,state,matched_amount_minor
  LOOP
    INSERT INTO plan_occurrence_revisions(household_id,occurrence_id,version,state,matched_amount_minor,reason,actor_user_id)
    VALUES(r.household_id,r.id,r.version,r.state,r.matched_amount_minor,'Daily savings schedule materialization',NULL);
    UPDATE households SET data_revision=data_revision+1 WHERE id=r.household_id;
    v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION maintain_savings_goal_occurrences() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maintain_savings_goal_occurrences() TO budgefi_worker;

-- Existing account deletion deletes plans before accounts. Attach savings
-- cleanup to that audited boundary so new goal/evidence tables cannot retain
-- data or block deletion.
CREATE FUNCTION delete_savings_with_plan() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF nullif(current_setting('app.account_deletion_request_id',true),'') IS NULL THEN
    RAISE EXCEPTION 'savings cleanup requires account deletion boundary';
  END IF;
  DELETE FROM savings_movement_evidence WHERE household_id=OLD.household_id;
  DELETE FROM savings_goal_movements WHERE household_id=OLD.household_id;
  DELETE FROM savings_goal_revisions WHERE household_id=OLD.household_id;
  DELETE FROM savings_goals WHERE household_id=OLD.household_id;
  RETURN OLD;
END $$;
CREATE TRIGGER plans_delete_savings
  BEFORE DELETE ON plans FOR EACH ROW EXECUTE FUNCTION delete_savings_with_plan();
