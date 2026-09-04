-- Income timing and reconciliation evidence. Historical append-only revisions
-- are preserved; new schedule metadata is populated on future revisions.
ALTER TABLE plans
  ADD COLUMN income_amount_minor bigint NOT NULL DEFAULT 0 CHECK (income_amount_minor >= 0),
  ADD COLUMN income_frequency text NOT NULL DEFAULT 'irregular'
    CHECK (income_frequency IN ('weekly','biweekly','semi_monthly','monthly','irregular')),
  ADD COLUMN next_income_date date,
  ADD COLUMN income_confirmed boolean NOT NULL DEFAULT false,
  ADD COLUMN income_source_name text NOT NULL DEFAULT 'Primary income'
    CHECK (length(trim(income_source_name)) BETWEEN 1 AND 120),
  ADD COLUMN fallback_horizon_days integer NOT NULL DEFAULT 14
    CHECK (fallback_horizon_days BETWEEN 1 AND 90),
  ADD COLUMN income_anchor_day smallint CHECK (income_anchor_day BETWEEN 1 AND 31),
  ADD COLUMN income_anchor_eom boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT plans_confirmed_income_has_date
    CHECK (NOT income_confirmed OR next_income_date IS NOT NULL);

-- Existing plans retain their configured fallback. Fourteen days is the default
-- only for plans provisioned after this migration.
UPDATE plans SET fallback_horizon_days = planning_horizon_days;
UPDATE plans SET income_anchor_day=extract(day from next_income_date),
  income_anchor_eom=(next_income_date=(date_trunc('month',next_income_date)+interval '1 month - 1 day')::date)
WHERE next_income_date IS NOT NULL;

ALTER TABLE commitments
  ADD COLUMN recurrence_anchor_day smallint CHECK (recurrence_anchor_day BETWEEN 1 AND 31),
  ADD COLUMN recurrence_anchor_eom boolean NOT NULL DEFAULT false;
UPDATE commitments SET recurrence_anchor_day=extract(day from due_date),
  recurrence_anchor_eom=(due_date=(date_trunc('month',due_date)+interval '1 month - 1 day')::date)
WHERE due_date IS NOT NULL;

ALTER TABLE plan_revisions
  ADD COLUMN income_amount_minor bigint NOT NULL DEFAULT 0 CHECK (income_amount_minor >= 0),
  ADD COLUMN income_frequency text NOT NULL DEFAULT 'irregular'
    CHECK (income_frequency IN ('weekly','biweekly','semi_monthly','monthly','irregular')),
  ADD COLUMN next_income_date date,
  ADD COLUMN income_confirmed boolean NOT NULL DEFAULT false,
  ADD COLUMN income_source_name text NOT NULL DEFAULT 'Primary income'
    CHECK (length(trim(income_source_name)) BETWEEN 1 AND 120),
  ADD COLUMN fallback_horizon_days integer NOT NULL DEFAULT 10
    CHECK (fallback_horizon_days BETWEEN 1 AND 90),
  ADD COLUMN income_anchor_day smallint,
  ADD COLUMN income_anchor_eom boolean NOT NULL DEFAULT false;

ALTER TABLE commitment_revisions
  ADD COLUMN recurrence text,
  ADD COLUMN recurrence_anchor_day smallint,
  ADD COLUMN recurrence_anchor_eom boolean NOT NULL DEFAULT false;
-- All calculations after this boundary use occurrence-aware v2. Preserve old
-- revisions and append a new revision for the current policy transition.
WITH changed AS (
  UPDATE plans
  SET calculation_policy_version='safe-to-spend/v2', version=version+1, updated_at=now()
  WHERE calculation_policy_version <> 'safe-to-spend/v2'
  RETURNING *
)
INSERT INTO plan_revisions (
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

CREATE OR REPLACE FUNCTION normalize_current_plan_policy() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  NEW.calculation_policy_version := 'safe-to-spend/v2';
  RETURN NEW;
END $$;
CREATE TRIGGER plans_current_policy
  BEFORE INSERT OR UPDATE OF calculation_policy_version ON plans
  FOR EACH ROW EXECUTE FUNCTION normalize_current_plan_policy();

CREATE OR REPLACE FUNCTION normalize_current_plan_revision_policy() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.policy_version IN ('available-v1','safe-to-spend/v1') THEN
    NEW.policy_version := 'safe-to-spend/v2';
  END IF;
  SELECT income_amount_minor,income_frequency,next_income_date,income_confirmed,
         income_source_name,fallback_horizon_days,income_anchor_day,income_anchor_eom
  INTO NEW.income_amount_minor,NEW.income_frequency,NEW.next_income_date,
       NEW.income_confirmed,NEW.income_source_name,NEW.fallback_horizon_days,
       NEW.income_anchor_day,NEW.income_anchor_eom
  FROM plans WHERE id=NEW.plan_id AND household_id=NEW.household_id;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_revisions_current_policy
  BEFORE INSERT ON plan_revisions
  FOR EACH ROW EXECUTE FUNCTION normalize_current_plan_revision_policy();

CREATE OR REPLACE FUNCTION normalize_commitment_revision_anchor() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  SELECT recurrence,recurrence_anchor_day,recurrence_anchor_eom
  INTO NEW.recurrence,NEW.recurrence_anchor_day,NEW.recurrence_anchor_eom
  FROM commitments WHERE id=NEW.commitment_id AND household_id=NEW.household_id;
  RETURN NEW;
END $$;
CREATE TRIGGER commitment_revisions_current_anchor
  BEFORE INSERT ON commitment_revisions
  FOR EACH ROW EXECUTE FUNCTION normalize_commitment_revision_anchor();

ALTER TABLE calculation_snapshot_inputs
  DROP CONSTRAINT calculation_snapshot_inputs_input_kind_check;
ALTER TABLE calculation_snapshot_inputs
  ADD CONSTRAINT calculation_snapshot_inputs_input_kind_check CHECK (
    input_kind IN (
      'plan_revision','balance_observation','commitment_revision',
      'plan_occurrence_revision','occurrence_match_revision'
    )
  );

CREATE TABLE plan_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id),
  supersedes_occurrence_id uuid,
  source_key text NOT NULL CHECK (length(source_key) BETWEEN 3 AND 180),
  kind text NOT NULL CHECK (kind IN ('income','commitment','savings')),
  commitment_id uuid,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  expected_amount_minor bigint CHECK (expected_amount_minor IS NULL OR expected_amount_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  expected_on date NOT NULL,
  state text NOT NULL DEFAULT 'expected'
    CHECK (state IN ('expected','pending','verified','partial','overdue','skipped','needs_review')),
  matched_amount_minor bigint NOT NULL DEFAULT 0 CHECK (matched_amount_minor >= 0),
  provenance text NOT NULL CHECK (provenance IN ('manual','csv','plaid','derived')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, commitment_id) REFERENCES commitments(household_id, id),
  FOREIGN KEY (household_id, supersedes_occurrence_id) REFERENCES plan_occurrences(household_id, id),
  CHECK ((kind = 'commitment') = (commitment_id IS NOT NULL)),
  CHECK (kind = 'income' OR expected_amount_minor IS NOT NULL),
  CHECK (expected_amount_minor IS NULL OR matched_amount_minor <= expected_amount_minor OR state = 'needs_review'),
  CHECK ((state = 'verified') = (verified_at IS NOT NULL))
);

CREATE INDEX plan_occurrences_projection_idx
  ON plan_occurrences (household_id, expected_on, state);
CREATE UNIQUE INDEX plan_occurrences_active_identity_unique
  ON plan_occurrences (household_id, source_key, expected_on)
  WHERE state <> 'skipped';

-- Every mutable occurrence state has an immutable before/after audit row.
CREATE TABLE plan_occurrence_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  occurrence_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  state text NOT NULL,
  matched_amount_minor bigint NOT NULL,
  verified_at timestamptz,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 240),
  actor_user_id uuid REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, occurrence_id, version),
  FOREIGN KEY (household_id, occurrence_id) REFERENCES plan_occurrences(household_id, id)
);

CREATE TABLE occurrence_transaction_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  occurrence_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  reflected_in_balance_observation_id uuid,
  amount_applied_minor bigint NOT NULL CHECK (amount_applied_minor > 0),
  state text NOT NULL CHECK (state IN ('proposed','confirmed','rejected','reversed')),
  confidence numeric(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 240),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  actor_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, occurrence_id) REFERENCES plan_occurrences(household_id, id),
  FOREIGN KEY (household_id, transaction_id) REFERENCES financial_transactions(household_id, id),
  FOREIGN KEY (household_id, reflected_in_balance_observation_id) REFERENCES balance_observations(household_id, id),
  CHECK ((state IN ('confirmed','rejected','reversed')) = (resolved_at IS NOT NULL))
);

-- One exact ledger revision may support one occurrence in the MVP. One
-- occurrence may still be paid by multiple transactions.
CREATE UNIQUE INDEX occurrence_transaction_active_evidence_unique
  ON occurrence_transaction_matches (household_id, transaction_id)
  WHERE state = 'confirmed';
CREATE UNIQUE INDEX occurrence_transaction_pair_unique
  ON occurrence_transaction_matches (household_id, occurrence_id, transaction_id);

CREATE TABLE occurrence_match_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  match_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  state text NOT NULL CHECK (state IN ('proposed','confirmed','rejected','reversed')),
  amount_applied_minor bigint NOT NULL CHECK (amount_applied_minor > 0),
  reflected_in_balance_observation_id uuid,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 240),
  actor_user_id uuid REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, match_id, version),
  FOREIGN KEY (household_id, match_id) REFERENCES occurrence_transaction_matches(household_id, id)
);

-- Backfill one current occurrence per active, dated legacy rule. No recurrence
-- is invented and no historical plan revision is rewritten.
WITH expanded AS (
  SELECT c.*, timezone(h.timezone,now())::date AS today,
    CASE c.recurrence
      WHEN 'weekly' THEN c.due_date + (n.value * 7)
      WHEN 'biweekly' THEN c.due_date + (n.value * 14)
      WHEN 'monthly' THEN (
        date_trunc('month',c.due_date)+(n.value*interval '1 month')+
        (least(
          CASE WHEN c.recurrence_anchor_eom THEN 31 ELSE coalesce(c.recurrence_anchor_day,extract(day from c.due_date)::integer) END,
          extract(day from date_trunc('month',c.due_date)+((n.value+1)*interval '1 month')-interval '1 day')::integer
        )-1)*interval '1 day'
      )::date
      ELSE c.due_date
    END AS occurrence_date
  FROM commitments c
  JOIN households h ON h.id=c.household_id
  CROSS JOIN LATERAL generate_series(0,CASE WHEN c.recurrence IS NULL THEN 0 ELSE 120 END) n(value)
  WHERE c.active AND c.settled_at IS NULL AND c.due_date IS NOT NULL
)
INSERT INTO plan_occurrences (
  household_id, source_key, kind, commitment_id, name,
  expected_amount_minor, expected_on, provenance
)
SELECT e.household_id,
       'commitment:' || e.id::text,
       'commitment',e.id,e.name,e.amount_minor,e.occurrence_date,
       CASE WHEN e.provenance IN ('manual','csv','plaid','derived')
            THEN e.provenance ELSE 'derived' END
FROM expanded e
JOIN plans p ON p.household_id=e.household_id
WHERE e.occurrence_date >= e.today - 90
  AND e.occurrence_date <= e.today + p.fallback_horizon_days;

INSERT INTO plan_occurrences (
  household_id, source_key, kind, name, expected_amount_minor,
  expected_on, provenance
)
SELECT p.household_id, 'savings:' || p.id::text, 'savings',
       'Planned savings', p.planned_savings_minor,
       (timezone(h.timezone, now())::date + p.fallback_horizon_days), 'manual'
FROM plans p
JOIN households h ON h.id = p.household_id
WHERE p.planned_savings_minor > 0;

INSERT INTO plan_occurrence_revisions (
  household_id, occurrence_id, version, state, matched_amount_minor, reason
)
SELECT household_id, id, version, state, matched_amount_minor, 'Legacy commitment backfill'
FROM plan_occurrences;

CREATE TRIGGER plan_occurrence_revisions_append_only
  BEFORE UPDATE OR DELETE ON plan_occurrence_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER occurrence_match_revisions_append_only
  BEFORE UPDATE OR DELETE ON occurrence_match_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

ALTER TABLE plan_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_occurrences FORCE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON plan_occurrences
  USING (household_id = nullif(current_setting('app.household_id', true), '')::uuid)
  WITH CHECK (household_id = nullif(current_setting('app.household_id', true), '')::uuid);
ALTER TABLE plan_occurrence_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_occurrence_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON plan_occurrence_revisions
  USING (household_id = nullif(current_setting('app.household_id', true), '')::uuid)
  WITH CHECK (household_id = nullif(current_setting('app.household_id', true), '')::uuid);
ALTER TABLE occurrence_transaction_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE occurrence_transaction_matches FORCE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON occurrence_transaction_matches
  USING (household_id = nullif(current_setting('app.household_id', true), '')::uuid)
  WITH CHECK (household_id = nullif(current_setting('app.household_id', true), '')::uuid);
ALTER TABLE occurrence_match_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE occurrence_match_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON occurrence_match_revisions
  USING (household_id = nullif(current_setting('app.household_id', true), '')::uuid)
  WITH CHECK (household_id = nullif(current_setting('app.household_id', true), '')::uuid);

GRANT SELECT, INSERT ON plan_occurrences TO budgefi_app;
GRANT UPDATE (state, matched_amount_minor, version, verified_at, updated_at)
  ON plan_occurrences TO budgefi_app;
GRANT SELECT, INSERT ON plan_occurrence_revisions TO budgefi_app;
GRANT SELECT, INSERT ON occurrence_transaction_matches TO budgefi_app;
GRANT UPDATE (state, reason, version, resolved_at, reflected_in_balance_observation_id)
  ON occurrence_transaction_matches TO budgefi_app;
GRANT SELECT, INSERT ON occurrence_match_revisions TO budgefi_app;
GRANT SELECT, INSERT ON plan_occurrences, plan_occurrence_revisions,
  occurrence_transaction_matches, occurrence_match_revisions TO budgefi_plaid_worker;
GRANT UPDATE (state, matched_amount_minor, version, verified_at, updated_at)
  ON plan_occurrences TO budgefi_plaid_worker;
GRANT UPDATE (state, reason, version, resolved_at, reflected_in_balance_observation_id)
  ON occurrence_transaction_matches TO budgefi_plaid_worker;

GRANT UPDATE (
  income_amount_minor, income_frequency, next_income_date, income_confirmed,
  income_source_name, fallback_horizon_days, income_anchor_day, income_anchor_eom
) ON plans TO budgefi_app;
GRANT UPDATE (recurrence, recurrence_anchor_day, recurrence_anchor_eom) ON commitments TO budgefi_app;

CREATE OR REPLACE FUNCTION maintain_plan_occurrences()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record; v_count integer:=0;
BEGIN
  IF NOT pg_has_role(session_user,'budgefi_worker','MEMBER') THEN
    RAISE EXCEPTION 'worker capability required';
  END IF;
  FOR r IN
    UPDATE plan_occurrences o SET state='overdue',version=o.version+1,updated_at=now()
    FROM households h
    WHERE h.id=o.household_id AND h.deleted_at IS NULL
      AND o.state='expected'
      AND o.expected_on<timezone(h.timezone,now())::date
    RETURNING o.household_id,o.id,o.version,o.state,o.matched_amount_minor
  LOOP
    INSERT INTO plan_occurrence_revisions(household_id,occurrence_id,version,state,matched_amount_minor,reason,actor_user_id)
    VALUES(r.household_id,r.id,r.version,r.state,r.matched_amount_minor,'Expected date passed',NULL);
    UPDATE households SET data_revision=data_revision+1 WHERE id=r.household_id;
    v_count:=v_count+1;
  END LOOP;
  FOR r IN
    WITH rules AS (
      SELECT c.*,timezone(h.timezone,now())::date AS today,
        CASE WHEN p.income_confirmed AND p.next_income_date BETWEEN timezone(h.timezone,now())::date AND timezone(h.timezone,now())::date+90
          THEN p.next_income_date ELSE timezone(h.timezone,now())::date+p.fallback_horizon_days END AS horizon_end
      FROM commitments c JOIN households h ON h.id=c.household_id
      JOIN plans p ON p.household_id=c.household_id
      WHERE c.active AND c.settled_at IS NULL AND c.due_date IS NOT NULL AND h.deleted_at IS NULL
    ), expanded AS (
      SELECT rules.*,
        CASE recurrence
          WHEN 'weekly' THEN due_date+(n.value*7)
          WHEN 'biweekly' THEN due_date+(n.value*14)
          WHEN 'monthly' THEN (
            date_trunc('month',due_date)+(n.value*interval '1 month')+
            (least(
              CASE WHEN recurrence_anchor_eom THEN 31 ELSE coalesce(recurrence_anchor_day,extract(day from due_date)::integer) END,
              extract(day from date_trunc('month',due_date)+((n.value+1)*interval '1 month')-interval '1 day')::integer
            )-1)*interval '1 day'
          )::date
          ELSE due_date END AS occurrence_date
      FROM rules
      CROSS JOIN LATERAL generate_series(
        CASE recurrence
          WHEN 'weekly' THEN greatest(0,((today-90)-due_date)/7)
          WHEN 'biweekly' THEN greatest(0,((today-90)-due_date)/14)
          WHEN 'monthly' THEN greatest(0,((extract(year from age(today-90,due_date))*12+extract(month from age(today-90,due_date)))::integer)-2)
          ELSE 0 END,
        CASE WHEN recurrence IS NULL THEN 0 ELSE
          (CASE recurrence
            WHEN 'weekly' THEN greatest(0,((today-90)-due_date)/7)
            WHEN 'biweekly' THEN greatest(0,((today-90)-due_date)/14)
            WHEN 'monthly' THEN greatest(0,((extract(year from age(today-90,due_date))*12+extract(month from age(today-90,due_date)))::integer)-2)
            ELSE 0 END)+40 END
      ) n(value)
    )
    INSERT INTO plan_occurrences(household_id,source_key,kind,commitment_id,name,expected_amount_minor,expected_on,provenance)
    SELECT household_id,'commitment:'||id::text,'commitment',id,name,amount_minor,occurrence_date,
      CASE WHEN provenance IN ('manual','csv','plaid','derived') THEN provenance ELSE 'derived' END
    FROM expanded WHERE occurrence_date>=today-90 AND occurrence_date<=horizon_end
    ON CONFLICT DO NOTHING RETURNING household_id,id,version,state,matched_amount_minor
  LOOP
    INSERT INTO plan_occurrence_revisions(household_id,occurrence_id,version,state,matched_amount_minor,reason,actor_user_id)
    VALUES(r.household_id,r.id,r.version,r.state,r.matched_amount_minor,'Daily schedule materialization',NULL);
    UPDATE households SET data_revision=data_revision+1 WHERE id=r.household_id;
    v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION maintain_plan_occurrences() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maintain_plan_occurrences() TO budgefi_worker;

-- Keep verified evidence inside the existing deletion boundary. This is the
-- latest definition of the worker-only finalizer.
CREATE OR REPLACE FUNCTION finalize_account_deletion(p_request_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user uuid; v_household uuid; v_household_empty boolean;
BEGIN
  SELECT user_id,household_id INTO v_user,v_household
  FROM account_deletion_requests WHERE id=p_request_id AND status='finalizing' FOR UPDATE;
  IF v_user IS NULL THEN RETURN; END IF;
  PERFORM 1 FROM households WHERE id=v_household FOR UPDATE;
  IF EXISTS(SELECT 1 FROM connections WHERE household_id=v_household AND provider='plaid' AND status<>'revoked') THEN
    UPDATE connections SET status='revocation_pending',updated_at=now()
    WHERE household_id=v_household AND provider='plaid' AND status<>'revoked';
    INSERT INTO plaid_sync_jobs(household_id,connection_id,operation,trigger,state,available_at)
    SELECT household_id,id,'revoke','recovery','queued',now()
    FROM connections WHERE household_id=v_household AND provider='plaid' AND status<>'revoked'
    ON CONFLICT DO NOTHING;
    UPDATE account_deletion_requests SET status='revoking_connections',updated_at=now(),last_error_code=NULL
    WHERE id=p_request_id;
    RETURN;
  END IF;
  PERFORM set_config('app.household_id',v_household::text,true);
  PERFORM set_config('app.user_id',v_user::text,true);
  PERFORM set_config('app.account_deletion_request_id',p_request_id::text,true);
  DELETE FROM notification_deliveries WHERE user_id=v_user;
  DELETE FROM notification_events WHERE user_id=v_user;
  DELETE FROM notification_endpoints WHERE user_id=v_user;
  DELETE FROM notification_preferences WHERE user_id=v_user;
  UPDATE household_memberships SET revoked_at=coalesce(revoked_at,now())
    WHERE household_id=v_household AND user_id=v_user;
  PERFORM set_config('app.user_id','',true);
  SELECT NOT EXISTS(SELECT 1 FROM household_memberships WHERE household_id=v_household AND revoked_at IS NULL)
    INTO v_household_empty;
  IF v_household_empty THEN
    DELETE FROM financial_pattern_analyses WHERE household_id=v_household;
    DELETE FROM case_evidence WHERE household_id=v_household;
    DELETE FROM exception_cases WHERE household_id=v_household;
    DELETE FROM calculation_snapshot_inputs WHERE household_id=v_household;
    DELETE FROM calculation_snapshots WHERE household_id=v_household;
    DELETE FROM sync_runs WHERE household_id=v_household;
    DELETE FROM plaid_sync_jobs WHERE household_id=v_household;
    DELETE FROM plaid_link_sessions WHERE household_id=v_household;
    DELETE FROM webhook_receipts WHERE household_id=v_household;
    DELETE FROM idempotency_records WHERE household_id=v_household;
    DELETE FROM activity_events WHERE household_id=v_household;
    DELETE FROM occurrence_match_revisions WHERE household_id=v_household;
    DELETE FROM occurrence_transaction_matches WHERE household_id=v_household;
    DELETE FROM plan_occurrence_revisions WHERE household_id=v_household;
    DELETE FROM plan_occurrences WHERE household_id=v_household;
    DELETE FROM commitment_revisions WHERE household_id=v_household;
    DELETE FROM commitments WHERE household_id=v_household;
    DELETE FROM plan_revisions WHERE household_id=v_household;
    DELETE FROM financial_transactions WHERE household_id=v_household;
    DELETE FROM balance_observations WHERE household_id=v_household;
    DELETE FROM plans WHERE household_id=v_household;
    DELETE FROM accounts WHERE household_id=v_household;
    DELETE FROM connections WHERE household_id=v_household;
  END IF;
  UPDATE users SET auth_subject='deleted|'||id::text,display_name='Deleted member',email=NULL,deleted_at=now() WHERE id=v_user;
  IF v_household_empty THEN UPDATE households SET deleted_at=now() WHERE id=v_household;
  ELSE UPDATE households SET lifecycle_state='active' WHERE id=v_household; END IF;
  UPDATE account_deletion_requests SET status='completed',completed_at=now(),updated_at=now(),last_error_code=NULL WHERE id=p_request_id;
END $$;

REVOKE ALL ON FUNCTION finalize_account_deletion(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finalize_account_deletion(uuid) TO budgefi_worker;
