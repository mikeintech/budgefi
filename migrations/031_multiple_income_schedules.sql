-- Independent expected-income rules. Future income is evidence for the planning
-- horizon only; it never increases available cash until a deposit is verified.

CREATE TABLE income_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  destination_account_id uuid,
  name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
  expected_amount_minor bigint CHECK(expected_amount_minor IS NULL OR expected_amount_minor>0),
  currency char(3) NOT NULL DEFAULT 'USD' CHECK(currency='USD'),
  frequency text NOT NULL CHECK(frequency IN ('weekly','biweekly','semi_monthly','monthly','irregular')),
  next_expected_date date,
  confirmed boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','archived')),
  anchor_day integer CHECK(anchor_day IS NULL OR anchor_day BETWEEN 1 AND 31),
  anchor_eom boolean NOT NULL DEFAULT false,
  second_anchor_day integer CHECK(second_anchor_day IS NULL OR second_anchor_day BETWEEN 1 AND 31),
  second_anchor_eom boolean NOT NULL DEFAULT false,
  review_reason text CHECK(review_reason IS NULL OR review_reason IN ('destination_disconnected')),
  advanced_from_occurrence_id uuid,
  previous_expected_date date,
  provenance text NOT NULL CHECK(provenance IN ('manual','csv','plaid','derived')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,id),
  FOREIGN KEY(household_id,destination_account_id) REFERENCES accounts(household_id,id),
  FOREIGN KEY(household_id,advanced_from_occurrence_id) REFERENCES plan_occurrences(household_id,id) DEFERRABLE INITIALLY DEFERRED,
  CHECK(NOT confirmed OR (status='active' AND next_expected_date IS NOT NULL AND frequency<>'irregular')),
  CHECK((frequency='semi_monthly')=(second_anchor_day IS NOT NULL)),
  CHECK(frequency<>'semi_monthly' OR (
    anchor_day IS NOT NULL AND
    NOT ((anchor_eom AND second_anchor_eom) OR
         (NOT anchor_eom AND NOT second_anchor_eom AND anchor_day=second_anchor_day)) AND
    NOT ((anchor_eom OR anchor_day>=28) AND (second_anchor_eom OR second_anchor_day>=28))
  )),
  CHECK((advanced_from_occurrence_id IS NULL)=(previous_expected_date IS NULL))
);
CREATE INDEX income_schedules_household_next_idx ON income_schedules(household_id,next_expected_date,id)
  WHERE status='active' AND confirmed;

CREATE TABLE income_schedule_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  income_schedule_id uuid NOT NULL,
  destination_account_id uuid,
  name text NOT NULL,
  expected_amount_minor bigint,
  frequency text NOT NULL,
  next_expected_date date,
  confirmed boolean NOT NULL,
  status text NOT NULL,
  anchor_day integer,
  anchor_eom boolean NOT NULL,
  second_anchor_day integer,
  second_anchor_eom boolean NOT NULL,
  review_reason text,
  advanced_from_occurrence_id uuid,
  previous_expected_date date,
  provenance text NOT NULL,
  version integer NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 240),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,income_schedule_id,version),
  FOREIGN KEY(household_id,income_schedule_id) REFERENCES income_schedules(household_id,id) ON DELETE CASCADE
);

ALTER TABLE calculation_snapshot_inputs
  DROP CONSTRAINT calculation_snapshot_inputs_input_kind_check;
ALTER TABLE calculation_snapshot_inputs
  ADD CONSTRAINT calculation_snapshot_inputs_input_kind_check CHECK (
    input_kind IN (
      'plan_revision','balance_observation','commitment_revision',
      'plan_occurrence_revision','occurrence_match_revision',
      'savings_goal_revision','savings_goal_movement','income_schedule_revision'
    )
  );

ALTER TABLE plan_occurrences ADD COLUMN income_schedule_id uuid;
ALTER TABLE plan_occurrences ADD CONSTRAINT plan_occurrences_income_schedule_fk
  FOREIGN KEY(household_id,income_schedule_id) REFERENCES income_schedules(household_id,id);
ALTER TABLE plan_occurrences ADD CONSTRAINT plan_occurrences_kind_owner_check
  CHECK(
    (kind='income' AND income_schedule_id IS NOT NULL AND commitment_id IS NULL AND savings_goal_id IS NULL)
    OR (kind='commitment' AND commitment_id IS NOT NULL AND savings_goal_id IS NULL AND income_schedule_id IS NULL)
    OR (kind='savings' AND savings_goal_id IS NOT NULL AND commitment_id IS NULL AND income_schedule_id IS NULL)
  ) NOT VALID;

INSERT INTO income_schedules(household_id,name,expected_amount_minor,frequency,next_expected_date,confirmed,status,anchor_day,anchor_eom,second_anchor_day,second_anchor_eom,provenance)
SELECT household_id,income_source_name,NULLIF(income_amount_minor,0),income_frequency,next_income_date,
       income_confirmed AND next_income_date IS NOT NULL AND income_frequency<>'irregular','active',income_anchor_day,income_anchor_eom,
       CASE WHEN income_frequency='semi_monthly' THEN
         CASE WHEN COALESCE(income_anchor_day,15)>=16 THEN 15 ELSE LEAST(31,COALESCE(income_anchor_day,15)+15) END
       END,
       false,'manual'
FROM plans
WHERE income_confirmed OR next_income_date IS NOT NULL OR income_amount_minor>0;

UPDATE plan_occurrences occurrence SET
  income_schedule_id=schedule.id,
  source_key='income-schedule:'||schedule.id::text
FROM income_schedules schedule
WHERE occurrence.household_id=schedule.household_id AND occurrence.kind='income' AND occurrence.source_key='income:primary';

UPDATE plan_occurrences SET state='skipped',version=version+1,updated_at=now()
WHERE kind='income' AND income_schedule_id IS NULL AND state<>'skipped';

ALTER TABLE plan_occurrences VALIDATE CONSTRAINT plan_occurrences_kind_owner_check;

CREATE FUNCTION enforce_income_advancement_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.advanced_from_occurrence_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM plan_occurrences occurrence
    WHERE occurrence.household_id=NEW.household_id
      AND occurrence.id=NEW.advanced_from_occurrence_id
      AND occurrence.income_schedule_id=NEW.id
      AND occurrence.kind='income'
  ) THEN
    RAISE EXCEPTION 'income advancement must reference an occurrence owned by this schedule';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER income_advancement_owner BEFORE INSERT OR UPDATE OF advanced_from_occurrence_id
  ON income_schedules FOR EACH ROW EXECUTE FUNCTION enforce_income_advancement_owner();

INSERT INTO income_schedule_revisions(household_id,income_schedule_id,destination_account_id,name,expected_amount_minor,frequency,next_expected_date,confirmed,status,anchor_day,anchor_eom,second_anchor_day,second_anchor_eom,review_reason,advanced_from_occurrence_id,previous_expected_date,provenance,version,reason)
SELECT household_id,id,destination_account_id,name,expected_amount_minor,frequency,next_expected_date,confirmed,status,anchor_day,anchor_eom,second_anchor_day,second_anchor_eom,review_reason,advanced_from_occurrence_id,previous_expected_date,provenance,version,'Migrated from plan income fields'
FROM income_schedules;

CREATE TRIGGER income_schedule_revisions_append_only BEFORE UPDATE OR DELETE ON income_schedule_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
ALTER TABLE income_schedules ENABLE ROW LEVEL SECURITY; ALTER TABLE income_schedules FORCE ROW LEVEL SECURITY;
ALTER TABLE income_schedule_revisions ENABLE ROW LEVEL SECURITY; ALTER TABLE income_schedule_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON income_schedules USING(household_id=nullif(current_setting('app.household_id',true),'')::uuid) WITH CHECK(household_id=nullif(current_setting('app.household_id',true),'')::uuid);
CREATE POLICY household_isolation ON income_schedule_revisions USING(household_id=nullif(current_setting('app.household_id',true),'')::uuid) WITH CHECK(household_id=nullif(current_setting('app.household_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON income_schedules TO budgefi_app;
GRANT SELECT,INSERT ON income_schedule_revisions TO budgefi_app;
GRANT SELECT,INSERT,UPDATE ON income_schedules TO budgefi_plaid_worker;
GRANT SELECT,INSERT ON income_schedule_revisions TO budgefi_plaid_worker;

-- Scheduled materialization must use the same conservative canonical horizon
-- as request-time calculations. A missed confirmed source forces fallback;
-- otherwise the earliest reliable upcoming source wins.
CREATE FUNCTION canonical_income_horizon_end(p_household uuid,p_today date,p_fallback integer)
RETURNS date LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM income_schedules s WHERE s.household_id=p_household
        AND s.status='active' AND s.confirmed AND s.next_expected_date<p_today
    ) THEN p_today+p_fallback
    ELSE coalesce((
      SELECT min(s.next_expected_date) FROM income_schedules s
      WHERE s.household_id=p_household AND s.status='active' AND s.confirmed
        AND s.next_expected_date BETWEEN p_today AND p_today+90
    ),p_today+p_fallback)
  END
$$;
REVOKE ALL ON FUNCTION canonical_income_horizon_end(uuid,date,integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION maintain_plan_occurrences()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record; v_count integer:=0;
BEGIN
  IF NOT pg_has_role(session_user,'budgefi_worker','MEMBER') THEN RAISE EXCEPTION 'worker capability required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(h.id::text,7241))
    FROM households h WHERE h.deleted_at IS NULL ORDER BY h.id;
  FOR r IN
    UPDATE plan_occurrences o SET state='overdue',version=o.version+1,updated_at=now()
    FROM households h WHERE h.id=o.household_id AND h.deleted_at IS NULL
      AND o.state='expected' AND o.expected_on<timezone(h.timezone,now())::date
    RETURNING o.household_id,o.id,o.version,o.state,o.matched_amount_minor
  LOOP
    INSERT INTO plan_occurrence_revisions(household_id,occurrence_id,version,state,matched_amount_minor,reason,actor_user_id)
    VALUES(r.household_id,r.id,r.version,r.state,r.matched_amount_minor,'Expected date passed',NULL);
    UPDATE households SET data_revision=data_revision+1 WHERE id=r.household_id; v_count:=v_count+1;
  END LOOP;
  FOR r IN
    WITH rules AS (
      SELECT c.*,timezone(h.timezone,now())::date AS today,
        canonical_income_horizon_end(c.household_id,timezone(h.timezone,now())::date,p.fallback_horizon_days) AS horizon_end
      FROM commitments c JOIN households h ON h.id=c.household_id JOIN plans p ON p.household_id=c.household_id
      WHERE c.active AND c.settled_at IS NULL AND c.due_date IS NOT NULL AND h.deleted_at IS NULL
    ), expanded AS (
      SELECT rules.*,
        CASE recurrence
          WHEN 'weekly' THEN due_date+(n.value*7)
          WHEN 'biweekly' THEN due_date+(n.value*14)
          WHEN 'monthly' THEN (date_trunc('month',due_date)+(n.value*interval '1 month')+
            (least(CASE WHEN recurrence_anchor_eom THEN 31 ELSE coalesce(recurrence_anchor_day,extract(day from due_date)::integer) END,
              extract(day from date_trunc('month',due_date)+((n.value+1)*interval '1 month')-interval '1 day')::integer)-1)*interval '1 day')::date
          ELSE due_date END AS occurrence_date
      FROM rules CROSS JOIN LATERAL generate_series(
        CASE recurrence WHEN 'weekly' THEN greatest(0,((today-90)-due_date)/7) WHEN 'biweekly' THEN greatest(0,((today-90)-due_date)/14) WHEN 'monthly' THEN greatest(0,((extract(year from age(today-90,due_date))*12+extract(month from age(today-90,due_date)))::integer)-2) ELSE 0 END,
        CASE WHEN recurrence IS NULL THEN 0 ELSE (CASE recurrence WHEN 'weekly' THEN greatest(0,((today-90)-due_date)/7) WHEN 'biweekly' THEN greatest(0,((today-90)-due_date)/14) WHEN 'monthly' THEN greatest(0,((extract(year from age(today-90,due_date))*12+extract(month from age(today-90,due_date)))::integer)-2) ELSE 0 END)+40 END
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
    UPDATE households SET data_revision=data_revision+1 WHERE id=r.household_id; v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION maintain_savings_goal_occurrences()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record; v_count integer:=0;
BEGIN
  IF NOT pg_has_role(session_user,'budgefi_worker','MEMBER') THEN RAISE EXCEPTION 'worker capability required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(h.id::text,7241))
    FROM households h WHERE h.deleted_at IS NULL ORDER BY h.id;
  FOR r IN
    WITH rules AS (
      SELECT g.*,timezone(h.timezone,now())::date AS today,
        canonical_income_horizon_end(g.household_id,timezone(h.timezone,now())::date,p.fallback_horizon_days) AS horizon_end
      FROM savings_goals g JOIN households h ON h.id=g.household_id JOIN plans p ON p.household_id=g.household_id
      WHERE g.status='active' AND g.contribution_amount_minor>0 AND h.deleted_at IS NULL
    ), expanded AS (
      SELECT rules.*,
        CASE schedule
          WHEN 'planning_period' THEN horizon_end
          WHEN 'weekly' THEN next_due_on+(n.value*7)
          WHEN 'biweekly' THEN next_due_on+(n.value*14)
          WHEN 'monthly' THEN (date_trunc('month',next_due_on)+(n.value*interval '1 month')+
            (least(extract(day from next_due_on)::integer,extract(day from date_trunc('month',next_due_on)+((n.value+1)*interval '1 month')-interval '1 day')::integer)-1)*interval '1 day')::date
          ELSE next_due_on END AS occurrence_date
      FROM rules CROSS JOIN LATERAL generate_series(0,CASE WHEN schedule IN ('planning_period','one_time') THEN 0 ELSE 40 END) n(value)
    )
    INSERT INTO plan_occurrences(household_id,source_key,kind,savings_goal_id,name,expected_amount_minor,expected_on,provenance)
    SELECT household_id,'savings-goal:'||id::text,'savings',id,name,contribution_amount_minor,occurrence_date,
      CASE WHEN provenance IN ('manual','csv','plaid','derived') THEN provenance ELSE 'derived' END
    FROM expanded WHERE occurrence_date BETWEEN today-90 AND horizon_end
      AND NOT EXISTS (
        SELECT 1 FROM plan_occurrences skipped WHERE skipped.household_id=expanded.household_id
          AND skipped.source_key='savings-goal:'||expanded.id::text AND skipped.expected_on=expanded.occurrence_date
          AND skipped.state='skipped' AND EXISTS (
            SELECT 1 FROM plan_occurrence_revisions revision WHERE revision.household_id=skipped.household_id
              AND revision.occurrence_id=skipped.id AND revision.state='skipped'
              AND revision.reason='User marked this occurrence as not due'
          )
      )
    ON CONFLICT DO NOTHING RETURNING household_id,id,version,state,matched_amount_minor
  LOOP
    INSERT INTO plan_occurrence_revisions(household_id,occurrence_id,version,state,matched_amount_minor,reason,actor_user_id)
    VALUES(r.household_id,r.id,r.version,r.state,r.matched_amount_minor,'Daily savings schedule materialization',NULL);
    UPDATE households SET data_revision=data_revision+1 WHERE id=r.household_id; v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END $$;

CREATE FUNCTION delete_income_schedules_with_plan() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF nullif(current_setting('app.account_deletion_request_id',true),'') IS NULL THEN
    RAISE EXCEPTION 'income schedule cleanup requires account deletion boundary';
  END IF;
  DELETE FROM income_schedule_revisions WHERE household_id=OLD.household_id;
  DELETE FROM income_schedules WHERE household_id=OLD.household_id;
  RETURN OLD;
END $$;
CREATE TRIGGER plans_delete_income_schedules BEFORE DELETE ON plans FOR EACH ROW EXECUTE FUNCTION delete_income_schedules_with_plan();
