-- Calendar-anchored quarterly/annual schedules and auditable reminder inputs.

-- Production migrations are owned by a non-BYPASSRLS role. Make legacy rows
-- visible only for this transaction's audited backfills, then restore FORCE.
ALTER TABLE savings_goals NO FORCE ROW LEVEL SECURITY;
ALTER TABLE savings_goal_revisions NO FORCE ROW LEVEL SECURITY;

ALTER TABLE commitments
  ADD CONSTRAINT commitments_recurrence_check CHECK (
    recurrence IS NULL OR recurrence IN ('weekly','biweekly','monthly','quarterly','annual')
  );

ALTER TABLE savings_goals DROP CONSTRAINT savings_goals_schedule_check;
ALTER TABLE savings_goals ADD CONSTRAINT savings_goals_schedule_check CHECK (
  schedule IN ('planning_period','one_time','weekly','biweekly','monthly','quarterly','annual')
);
ALTER TABLE savings_goals
  ADD COLUMN schedule_anchor_day smallint CHECK(schedule_anchor_day BETWEEN 1 AND 31),
  ADD COLUMN schedule_anchor_eom boolean NOT NULL DEFAULT false;
UPDATE savings_goals SET
  schedule_anchor_day=extract(day FROM next_due_on),
  schedule_anchor_eom=next_due_on=(date_trunc('month',next_due_on)+interval '1 month - 1 day')::date
WHERE next_due_on IS NOT NULL;

ALTER TABLE savings_goal_revisions
  ADD COLUMN schedule_anchor_day smallint,
  ADD COLUMN schedule_anchor_eom boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION synchronize_savings_schedule_anchor()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.next_due_on IS NULL THEN
    NEW.schedule_anchor_day:=NULL; NEW.schedule_anchor_eom:=false;
  ELSIF TG_OP='INSERT' OR NEW.next_due_on IS DISTINCT FROM OLD.next_due_on THEN
    NEW.schedule_anchor_day:=extract(day FROM NEW.next_due_on);
    NEW.schedule_anchor_eom:=NEW.next_due_on=(date_trunc('month',NEW.next_due_on)+interval '1 month - 1 day')::date;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER savings_goal_schedule_anchor
  BEFORE INSERT OR UPDATE OF next_due_on ON savings_goals
  FOR EACH ROW EXECUTE FUNCTION synchronize_savings_schedule_anchor();

CREATE OR REPLACE FUNCTION normalize_savings_goal_revision_schedule()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  SELECT schedule_anchor_day,schedule_anchor_eom
    INTO NEW.schedule_anchor_day,NEW.schedule_anchor_eom
  FROM savings_goals WHERE household_id=NEW.household_id AND id=NEW.savings_goal_id;
  RETURN NEW;
END $$;
CREATE TRIGGER savings_goal_revision_schedule
  BEFORE INSERT ON savings_goal_revisions
  FOR EACH ROW EXECUTE FUNCTION normalize_savings_goal_revision_schedule();
UPDATE savings_goal_revisions revision SET
  schedule_anchor_day=goal.schedule_anchor_day,
  schedule_anchor_eom=goal.schedule_anchor_eom
FROM savings_goals goal
WHERE goal.household_id=revision.household_id AND goal.id=revision.savings_goal_id;

ALTER TABLE savings_goals FORCE ROW LEVEL SECURITY;
ALTER TABLE savings_goal_revisions FORCE ROW LEVEL SECURITY;

ALTER TABLE income_schedules DROP CONSTRAINT income_schedules_frequency_check;
ALTER TABLE income_schedules ADD CONSTRAINT income_schedules_frequency_check CHECK(
  frequency IN ('weekly','biweekly','semi_monthly','monthly','quarterly','annual','irregular')
);
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_income_frequency_check;
ALTER TABLE plans ADD CONSTRAINT plans_income_frequency_check CHECK(
  income_frequency IN ('weekly','biweekly','semi_monthly','monthly','quarterly','annual','irregular')
);
ALTER TABLE plan_revisions DROP CONSTRAINT IF EXISTS plan_revisions_income_frequency_check;
ALTER TABLE plan_revisions ADD CONSTRAINT plan_revisions_income_frequency_check CHECK(
  income_frequency IN ('weekly','biweekly','semi_monthly','monthly','quarterly','annual','irregular')
);

ALTER TABLE plan_occurrences
  ADD COLUMN source_revision_kind text,
  ADD COLUMN source_revision_id uuid,
  ADD COLUMN source_revision_version integer;

ALTER TABLE plan_occurrences NO FORCE ROW LEVEL SECURITY;
ALTER TABLE commitment_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE savings_goal_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE income_schedule_revisions NO FORCE ROW LEVEL SECURITY;

WITH chosen AS (
  SELECT occurrence.id,(SELECT revision.id FROM commitment_revisions revision
    WHERE revision.household_id=occurrence.household_id AND revision.commitment_id=occurrence.commitment_id
    ORDER BY (revision.recorded_at<=occurrence.created_at) DESC,revision.recorded_at DESC,revision.version DESC LIMIT 1) revision_id,
    (SELECT revision.version FROM commitment_revisions revision
    WHERE revision.household_id=occurrence.household_id AND revision.commitment_id=occurrence.commitment_id
    ORDER BY (revision.recorded_at<=occurrence.created_at) DESC,revision.recorded_at DESC,revision.version DESC LIMIT 1) revision_version
  FROM plan_occurrences occurrence WHERE occurrence.kind='commitment'
) UPDATE plan_occurrences occurrence SET source_revision_kind='commitment',source_revision_id=chosen.revision_id,source_revision_version=chosen.revision_version
FROM chosen WHERE occurrence.id=chosen.id;
WITH chosen AS (
  SELECT occurrence.id,(SELECT revision.id FROM savings_goal_revisions revision
    WHERE revision.household_id=occurrence.household_id AND revision.savings_goal_id=occurrence.savings_goal_id
    ORDER BY (revision.recorded_at<=occurrence.created_at) DESC,revision.recorded_at DESC,revision.version DESC LIMIT 1) revision_id,
    (SELECT revision.version FROM savings_goal_revisions revision
    WHERE revision.household_id=occurrence.household_id AND revision.savings_goal_id=occurrence.savings_goal_id
    ORDER BY (revision.recorded_at<=occurrence.created_at) DESC,revision.recorded_at DESC,revision.version DESC LIMIT 1) revision_version
  FROM plan_occurrences occurrence WHERE occurrence.kind='savings'
) UPDATE plan_occurrences occurrence SET source_revision_kind='savings',source_revision_id=chosen.revision_id,source_revision_version=chosen.revision_version
FROM chosen WHERE occurrence.id=chosen.id;
WITH chosen AS (
  SELECT occurrence.id,(SELECT revision.id FROM income_schedule_revisions revision
    WHERE revision.household_id=occurrence.household_id AND revision.income_schedule_id=occurrence.income_schedule_id
    ORDER BY (revision.recorded_at<=occurrence.created_at) DESC,revision.recorded_at DESC,revision.version DESC LIMIT 1) revision_id,
    (SELECT revision.version FROM income_schedule_revisions revision
    WHERE revision.household_id=occurrence.household_id AND revision.income_schedule_id=occurrence.income_schedule_id
    ORDER BY (revision.recorded_at<=occurrence.created_at) DESC,revision.recorded_at DESC,revision.version DESC LIMIT 1) revision_version
  FROM plan_occurrences occurrence WHERE occurrence.kind='income'
) UPDATE plan_occurrences occurrence SET source_revision_kind='income',source_revision_id=chosen.revision_id,source_revision_version=chosen.revision_version
FROM chosen WHERE occurrence.id=chosen.id;

ALTER TABLE plan_occurrences FORCE ROW LEVEL SECURITY;
ALTER TABLE commitment_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE savings_goal_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE income_schedule_revisions FORCE ROW LEVEL SECURITY;

ALTER TABLE plan_occurrences
  ALTER COLUMN source_revision_kind SET NOT NULL,
  ALTER COLUMN source_revision_id SET NOT NULL,
  ALTER COLUMN source_revision_version SET NOT NULL,
  ADD CONSTRAINT plan_occurrence_source_revision_check CHECK(
    source_revision_kind=kind AND source_revision_version>0
  );

CREATE FUNCTION populate_occurrence_source_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.kind='commitment' THEN
    SELECT 'commitment',id,version INTO NEW.source_revision_kind,NEW.source_revision_id,NEW.source_revision_version
    FROM commitment_revisions WHERE household_id=NEW.household_id AND commitment_id=NEW.commitment_id ORDER BY version DESC LIMIT 1;
  ELSIF NEW.kind='savings' THEN
    SELECT 'savings',id,version INTO NEW.source_revision_kind,NEW.source_revision_id,NEW.source_revision_version
    FROM savings_goal_revisions WHERE household_id=NEW.household_id AND savings_goal_id=NEW.savings_goal_id ORDER BY version DESC LIMIT 1;
  ELSIF NEW.kind='income' THEN
    SELECT 'income',id,version INTO NEW.source_revision_kind,NEW.source_revision_id,NEW.source_revision_version
    FROM income_schedule_revisions WHERE household_id=NEW.household_id AND income_schedule_id=NEW.income_schedule_id ORDER BY version DESC LIMIT 1;
  END IF;
  IF NEW.source_revision_id IS NULL THEN RAISE EXCEPTION 'schedule revision required before occurrence'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_occurrence_source_revision
  BEFORE INSERT ON plan_occurrences FOR EACH ROW EXECUTE FUNCTION populate_occurrence_source_revision();

CREATE FUNCTION preserve_occurrence_source_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.source_revision_kind IS DISTINCT FROM OLD.source_revision_kind
    OR NEW.source_revision_id IS DISTINCT FROM OLD.source_revision_id
    OR NEW.source_revision_version IS DISTINCT FROM OLD.source_revision_version THEN
    RAISE EXCEPTION 'occurrence schedule revision is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_occurrence_source_revision_immutable
  BEFORE UPDATE ON plan_occurrences FOR EACH ROW EXECUTE FUNCTION preserve_occurrence_source_revision();

CREATE OR REPLACE FUNCTION anchored_occurrence_date(
  p_first date,p_cadence text,p_index integer,p_anchor_day integer,p_anchor_eom boolean
) RETURNS date LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=public,pg_temp AS $$
DECLARE v_month date; v_last date;
BEGIN
  IF p_index<0 THEN RAISE EXCEPTION 'occurrence index must be nonnegative'; END IF;
  IF p_cadence='weekly' THEN RETURN p_first+(p_index*7); END IF;
  IF p_cadence='biweekly' THEN RETURN p_first+(p_index*14); END IF;
  IF p_cadence NOT IN ('monthly','quarterly','annual') THEN
    RAISE EXCEPTION 'unsupported anchored cadence %',p_cadence;
  END IF;
  v_month:=(date_trunc('month',p_first)+make_interval(months=>p_index*CASE p_cadence WHEN 'monthly' THEN 1 WHEN 'quarterly' THEN 3 ELSE 12 END))::date;
  v_last:=(v_month+interval '1 month - 1 day')::date;
  RETURN CASE WHEN p_anchor_eom THEN v_last ELSE v_month+(least(p_anchor_day,extract(day FROM v_last)::integer)-1) END;
END $$;
REVOKE ALL ON FUNCTION anchored_occurrence_date(date,text,integer,integer,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION anchored_occurrence_date(date,text,integer,integer,boolean) TO budgefi_app,budgefi_worker;

DROP FUNCTION maintain_plan_occurrences();
CREATE FUNCTION maintain_plan_occurrences(p_household uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record; v_count integer:=0;
BEGIN
  IF NOT pg_has_role(session_user,'budgefi_worker','MEMBER') THEN RAISE EXCEPTION 'worker capability required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(h.id::text,7241))
    FROM households h WHERE h.deleted_at IS NULL AND (p_household IS NULL OR h.id=p_household) ORDER BY h.id;
  FOR r IN
    UPDATE plan_occurrences o SET state='overdue',version=o.version+1,updated_at=now()
    FROM households h WHERE h.id=o.household_id AND h.deleted_at IS NULL
      AND (p_household IS NULL OR o.household_id=p_household)
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
        greatest(canonical_income_horizon_end(c.household_id,timezone(h.timezone,now())::date,p.fallback_horizon_days),
          timezone(h.timezone,now())::date+CASE WHEN c.recurrence IN ('quarterly','annual') THEN 400 ELSE 30 END) AS horizon_end
      FROM commitments c JOIN households h ON h.id=c.household_id JOIN plans p ON p.household_id=c.household_id
      WHERE c.active AND c.settled_at IS NULL AND c.due_date IS NOT NULL AND h.deleted_at IS NULL
        AND (p_household IS NULL OR c.household_id=p_household)
    ), indexed AS (
      SELECT rules.*,CASE recurrence
        WHEN 'weekly' THEN greatest(0,((today-90)-due_date)/7)
        WHEN 'biweekly' THEN greatest(0,((today-90)-due_date)/14)
        WHEN 'monthly' THEN greatest(0,((extract(year FROM age(today-90,due_date))*12+extract(month FROM age(today-90,due_date)))::integer)-2)
        WHEN 'quarterly' THEN greatest(0,((extract(year FROM age(today-90,due_date))*12+extract(month FROM age(today-90,due_date)))::integer/3)-2)
        WHEN 'annual' THEN greatest(0,(extract(year FROM age(today-90,due_date))::integer)-2)
        ELSE 0 END AS first_index
      FROM rules
    ), expanded AS (
      SELECT indexed.*,CASE WHEN recurrence IS NULL THEN due_date ELSE anchored_occurrence_date(
        due_date,recurrence,n.value,coalesce(recurrence_anchor_day,extract(day FROM due_date)::integer),recurrence_anchor_eom
      ) END AS occurrence_date
      FROM indexed CROSS JOIN LATERAL generate_series(first_index,CASE WHEN recurrence IS NULL THEN 0 ELSE first_index+40 END) n(value)
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

DROP FUNCTION maintain_savings_goal_occurrences();
CREATE FUNCTION maintain_savings_goal_occurrences(p_household uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record; v_count integer:=0;
BEGIN
  IF NOT pg_has_role(session_user,'budgefi_worker','MEMBER') THEN RAISE EXCEPTION 'worker capability required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(h.id::text,7241))
    FROM households h WHERE h.deleted_at IS NULL AND (p_household IS NULL OR h.id=p_household) ORDER BY h.id;
  FOR r IN
    WITH rules AS (
      SELECT g.*,timezone(h.timezone,now())::date AS today,
        greatest(canonical_income_horizon_end(g.household_id,timezone(h.timezone,now())::date,p.fallback_horizon_days),
          timezone(h.timezone,now())::date+CASE WHEN g.schedule IN ('quarterly','annual') THEN 400 ELSE 30 END) AS horizon_end
      FROM savings_goals g JOIN households h ON h.id=g.household_id JOIN plans p ON p.household_id=g.household_id
      WHERE g.status='active' AND g.contribution_amount_minor>0 AND h.deleted_at IS NULL
        AND (p_household IS NULL OR g.household_id=p_household)
    ), indexed AS (
      SELECT rules.*,CASE schedule
        WHEN 'weekly' THEN greatest(0,((today-90)-next_due_on)/7)
        WHEN 'biweekly' THEN greatest(0,((today-90)-next_due_on)/14)
        WHEN 'monthly' THEN greatest(0,((extract(year FROM age(today-90,next_due_on))*12+extract(month FROM age(today-90,next_due_on)))::integer)-2)
        WHEN 'quarterly' THEN greatest(0,((extract(year FROM age(today-90,next_due_on))*12+extract(month FROM age(today-90,next_due_on)))::integer/3)-2)
        WHEN 'annual' THEN greatest(0,(extract(year FROM age(today-90,next_due_on))::integer)-2)
        ELSE 0 END AS first_index
      FROM rules
    ), expanded AS (
      SELECT indexed.*,CASE schedule WHEN 'planning_period' THEN horizon_end WHEN 'one_time' THEN next_due_on
        ELSE anchored_occurrence_date(next_due_on,schedule,n.value,coalesce(schedule_anchor_day,extract(day FROM next_due_on)::integer),schedule_anchor_eom) END AS occurrence_date
      FROM indexed CROSS JOIN LATERAL generate_series(first_index,CASE WHEN schedule IN ('planning_period','one_time') THEN 0 ELSE first_index+40 END) n(value)
    )
    INSERT INTO plan_occurrences(household_id,source_key,kind,savings_goal_id,name,expected_amount_minor,expected_on,provenance)
    SELECT household_id,'savings-goal:'||id::text,'savings',id,name,contribution_amount_minor,occurrence_date,
      CASE WHEN provenance IN ('manual','csv','plaid','derived') THEN provenance ELSE 'derived' END
    FROM expanded WHERE occurrence_date BETWEEN today-90 AND horizon_end
      AND NOT EXISTS (SELECT 1 FROM plan_occurrences skipped WHERE skipped.household_id=expanded.household_id
        AND skipped.source_key='savings-goal:'||expanded.id::text AND skipped.expected_on=expanded.occurrence_date
        AND skipped.state='skipped' AND EXISTS (SELECT 1 FROM plan_occurrence_revisions revision
          WHERE revision.household_id=skipped.household_id AND revision.occurrence_id=skipped.id
            AND revision.state='skipped' AND revision.reason='User marked this occurrence as not due'))
    ON CONFLICT DO NOTHING RETURNING household_id,id,version,state,matched_amount_minor
  LOOP
    INSERT INTO plan_occurrence_revisions(household_id,occurrence_id,version,state,matched_amount_minor,reason,actor_user_id)
    VALUES(r.household_id,r.id,r.version,r.state,r.matched_amount_minor,'Daily savings schedule materialization',NULL);
    UPDATE households SET data_revision=data_revision+1 WHERE id=r.household_id; v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION maintain_plan_occurrences(uuid),maintain_savings_goal_occurrences(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maintain_plan_occurrences(uuid),maintain_savings_goal_occurrences(uuid) TO budgefi_worker;

CREATE FUNCTION valid_reminder_leads(p_days smallint[])
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT cardinality(p_days) BETWEEN 1 AND 2
    AND p_days=(SELECT array_agg(value ORDER BY value DESC) FROM (SELECT DISTINCT unnest(p_days) value) valueset)
    AND p_days <@ ARRAY[30,14,7,3,2,1,0]::smallint[]
$$;

ALTER TABLE notification_preferences
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0),
  ADD COLUMN income_reminders boolean NOT NULL DEFAULT true,
  ADD COLUMN savings_reminders boolean NOT NULL DEFAULT true,
  ADD COLUMN commitment_reminder_days smallint[] NOT NULL DEFAULT ARRAY[3]::smallint[],
  ADD COLUMN long_term_reminder_days smallint[] NOT NULL DEFAULT ARRAY[7]::smallint[],
  ADD COLUMN savings_reminder_days smallint[] NOT NULL DEFAULT ARRAY[0]::smallint[],
  ADD COLUMN reminder_minute smallint NOT NULL DEFAULT 0 CHECK(reminder_minute BETWEEN 0 AND 59),
  ADD COLUMN quiet_start_minute smallint NOT NULL DEFAULT 1260 CHECK(quiet_start_minute BETWEEN 0 AND 1439),
  ADD COLUMN quiet_end_minute smallint NOT NULL DEFAULT 480 CHECK(quiet_end_minute BETWEEN 0 AND 1439),
  ADD CONSTRAINT notification_commitment_leads_valid CHECK(valid_reminder_leads(commitment_reminder_days)),
  ADD CONSTRAINT notification_long_term_leads_valid CHECK(valid_reminder_leads(long_term_reminder_days)),
  ADD CONSTRAINT notification_savings_leads_valid CHECK(valid_reminder_leads(savings_reminder_days)),
  ADD CONSTRAINT notification_quiet_window_valid CHECK(quiet_start_minute<>quiet_end_minute);

CREATE TABLE notification_preference_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  user_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0),
  email_enabled boolean NOT NULL,
  push_enabled boolean NOT NULL,
  connection_health boolean NOT NULL,
  commitment_reminders boolean NOT NULL,
  income_reminders boolean NOT NULL,
  savings_reminders boolean NOT NULL,
  exception_activity boolean NOT NULL,
  weekly_digest boolean NOT NULL,
  lock_screen_detail boolean NOT NULL,
  commitment_reminder_days smallint[] NOT NULL,
  long_term_reminder_days smallint[] NOT NULL,
  savings_reminder_days smallint[] NOT NULL,
  reminder_hour smallint NOT NULL,
  reminder_minute smallint NOT NULL,
  quiet_start_minute smallint NOT NULL,
  quiet_end_minute smallint NOT NULL,
  timezone text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,user_id,version),
  UNIQUE(household_id,id),
  FOREIGN KEY(household_id,user_id) REFERENCES notification_preferences(household_id,user_id) ON DELETE CASCADE
);
ALTER TABLE notification_preference_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preference_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_preference_revisions_self ON notification_preference_revisions
  USING(household_id=nullif(current_setting('app.household_id',true),'')::uuid AND user_id=nullif(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK(household_id=nullif(current_setting('app.household_id',true),'')::uuid AND user_id=nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT ON notification_preference_revisions TO budgefi_app;
CREATE TRIGGER notification_preference_revisions_append_only
  BEFORE UPDATE OR DELETE ON notification_preference_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE FUNCTION append_notification_preference_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  INSERT INTO notification_preference_revisions(
    household_id,user_id,version,email_enabled,push_enabled,connection_health,commitment_reminders,
    income_reminders,savings_reminders,exception_activity,weekly_digest,lock_screen_detail,
    commitment_reminder_days,long_term_reminder_days,savings_reminder_days,reminder_hour,reminder_minute,
    quiet_start_minute,quiet_end_minute,timezone)
  VALUES(NEW.household_id,NEW.user_id,NEW.version,NEW.email_enabled,NEW.push_enabled,NEW.connection_health,NEW.commitment_reminders,
    NEW.income_reminders,NEW.savings_reminders,NEW.exception_activity,NEW.weekly_digest,NEW.lock_screen_detail,
    NEW.commitment_reminder_days,NEW.long_term_reminder_days,NEW.savings_reminder_days,NEW.reminder_hour,NEW.reminder_minute,
    NEW.quiet_start_minute,NEW.quiet_end_minute,NEW.timezone);
  RETURN NEW;
END $$;
CREATE FUNCTION bump_notification_preference_version()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  NEW.version:=OLD.version+1; NEW.updated_at:=now(); RETURN NEW;
END $$;
CREATE TRIGGER notification_preference_version
  BEFORE UPDATE ON notification_preferences
  FOR EACH ROW EXECUTE FUNCTION bump_notification_preference_version();
CREATE TRIGGER notification_preference_revision
  AFTER INSERT OR UPDATE ON notification_preferences
  FOR EACH ROW EXECUTE FUNCTION append_notification_preference_revision();

ALTER TABLE notification_preferences NO FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_preference_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_events NO FORCE ROW LEVEL SECURITY;

INSERT INTO notification_preference_revisions(
  household_id,user_id,version,email_enabled,push_enabled,connection_health,commitment_reminders,
  income_reminders,savings_reminders,exception_activity,weekly_digest,lock_screen_detail,
  commitment_reminder_days,long_term_reminder_days,savings_reminder_days,reminder_hour,reminder_minute,
  quiet_start_minute,quiet_end_minute,timezone)
SELECT household_id,user_id,version,email_enabled,push_enabled,connection_health,commitment_reminders,
  income_reminders,savings_reminders,exception_activity,weekly_digest,lock_screen_detail,
  commitment_reminder_days,long_term_reminder_days,savings_reminder_days,reminder_hour,reminder_minute,
  quiet_start_minute,quiet_end_minute,timezone FROM notification_preferences;

CREATE FUNCTION delete_notification_preference_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF nullif(current_setting('app.account_deletion_request_id',true),'') IS NULL THEN
    RAISE EXCEPTION 'notification preference cleanup requires account deletion boundary';
  END IF;
  DELETE FROM notification_preference_revisions WHERE household_id=OLD.household_id AND user_id=OLD.user_id;
  RETURN OLD;
END $$;
CREATE TRIGGER notification_preferences_delete_history
  BEFORE DELETE ON notification_preferences FOR EACH ROW EXECUTE FUNCTION delete_notification_preference_history();

ALTER TABLE notification_events
  ADD COLUMN occurrence_id uuid,
  ADD COLUMN occurrence_revision integer,
  ADD COLUMN preference_revision integer,
  ADD COLUMN scheduled_for timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN lead_days smallint,
  ADD COLUMN timezone_snapshot text NOT NULL DEFAULT 'America/New_York';
UPDATE notification_events event SET preference_revision=preference.version,timezone_snapshot=preference.timezone
FROM notification_preferences preference
WHERE preference.household_id=event.household_id AND preference.user_id=event.user_id;

ALTER TABLE notification_preference_revisions FORCE ROW LEVEL SECURITY;
-- notification_preferences and notification_events deliberately remain
-- NO FORCE under migration 019's narrow SECURITY DEFINER worker boundary.

ALTER TABLE notification_events ALTER COLUMN preference_revision SET NOT NULL;
ALTER TABLE notification_events ADD CONSTRAINT notification_event_preference_revision_fk
  FOREIGN KEY(household_id,user_id,preference_revision)
  REFERENCES notification_preference_revisions(household_id,user_id,version);
ALTER TABLE notification_events ADD CONSTRAINT notification_event_occurrence_revision_fk
  FOREIGN KEY(household_id,occurrence_id,occurrence_revision)
  REFERENCES plan_occurrence_revisions(household_id,occurrence_id,version);
ALTER TABLE notification_events ADD CONSTRAINT notification_event_occurrence_pair CHECK(
  (occurrence_id IS NULL)=(occurrence_revision IS NULL)
);
CREATE TRIGGER notification_events_append_only
  BEFORE UPDATE OR DELETE ON notification_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

ALTER TABLE notification_deliveries
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_generation integer NOT NULL DEFAULT 0;

CREATE FUNCTION notification_local_instant(p_date date,p_minute integer,p_timezone text)
RETURNS timestamptz LANGUAGE plpgsql STABLE STRICT SET search_path=public,pg_temp AS $$
DECLARE v_local timestamp; v_candidate timestamptz; v_earliest timestamptz;
BEGIN
  IF p_minute<0 OR p_minute>1439 THEN RAISE EXCEPTION 'invalid local minute'; END IF;
  v_local:=p_date::timestamp+make_interval(mins=>p_minute);
  v_candidate:=v_local AT TIME ZONE p_timezone;
  -- PostgreSQL moves nonexistent wall time through the spring gap. For a
  -- repeated fall-back wall time, choose the earliest valid instant. Searching
  -- three hours also covers regions whose offset changes by 30 minutes.
  SELECT min(candidate) INTO v_earliest
  FROM (
    SELECT v_candidate+make_interval(mins=>offset_minute) candidate
    FROM generate_series(-180,180) offset_minute
  ) candidates
  WHERE timezone(p_timezone,candidate)=v_local;
  RETURN coalesce(v_earliest,v_candidate);
END $$;

CREATE FUNCTION notification_scheduled_instant(
  p_due date,p_lead integer,p_hour integer,p_minute integer,p_timezone text,
  p_quiet_start integer,p_quiet_end integer
) RETURNS timestamptz LANGUAGE plpgsql STABLE STRICT SET search_path=public,pg_temp AS $$
DECLARE v_date date:=p_due-p_lead; v_clock integer:=p_hour*60+p_minute; v_quiet boolean;
BEGIN
  v_quiet:=CASE WHEN p_quiet_start<p_quiet_end
    THEN v_clock>=p_quiet_start AND v_clock<p_quiet_end
    ELSE v_clock>=p_quiet_start OR v_clock<p_quiet_end END;
  IF v_quiet THEN
    IF p_quiet_start>p_quiet_end AND v_clock>=p_quiet_start THEN v_date:=v_date+1; END IF;
    v_clock:=p_quiet_end;
  END IF;
  RETURN notification_local_instant(v_date,v_clock,p_timezone);
END $$;

CREATE FUNCTION notification_immediate_instant(
  p_now timestamptz,p_timezone text,p_quiet_start integer,p_quiet_end integer
) RETURNS timestamptz LANGUAGE plpgsql STABLE STRICT SET search_path=public,pg_temp AS $$
DECLARE v_local timestamp:=timezone(p_timezone,p_now); v_clock integer; v_date date; v_quiet boolean;
BEGIN
  v_clock:=extract(hour FROM v_local)::integer*60+extract(minute FROM v_local)::integer;
  v_date:=v_local::date;
  v_quiet:=CASE WHEN p_quiet_start<p_quiet_end
    THEN v_clock>=p_quiet_start AND v_clock<p_quiet_end
    ELSE v_clock>=p_quiet_start OR v_clock<p_quiet_end END;
  IF NOT v_quiet THEN RETURN p_now; END IF;
  IF p_quiet_start>p_quiet_end AND v_clock>=p_quiet_start THEN v_date:=v_date+1; END IF;
  RETURN notification_local_instant(v_date,p_quiet_end,p_timezone);
END $$;

DROP FUNCTION claim_notification_delivery();
DROP FUNCTION finish_notification_delivery(uuid,text,text);
CREATE FUNCTION claim_notification_delivery()
RETURNS TABLE(delivery_id uuid,lease_token uuid,household_id uuid,user_id uuid,endpoint_id uuid,channel text,platform text,encrypted_token bytea,token_key_id text,email_address text,title text,body text,deep_link_path text,lock_screen_detail boolean,attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid; v_token uuid:=gen_random_uuid();
BEGIN
  IF NOT pg_has_role(session_user,'budgefi_worker','MEMBER') THEN RAISE EXCEPTION 'worker capability required'; END IF;
  UPDATE notification_deliveries SET state='retry',locked_at=null,lease_token=null,available_at=now(),last_error_code='worker_lease_expired'
    WHERE state='sending' AND locked_at<now()-interval '5 minutes';
  UPDATE notification_deliveries delivery SET state='suppressed',locked_at=null,lease_token=null,last_error_code='preference_or_occurrence_changed'
  FROM notification_events event JOIN notification_preferences preference
    ON preference.household_id=event.household_id AND preference.user_id=event.user_id
  LEFT JOIN plan_occurrences occurrence ON occurrence.household_id=event.household_id AND occurrence.id=event.occurrence_id
  WHERE delivery.household_id=event.household_id AND delivery.event_id=event.id AND delivery.state IN ('queued','retry') AND (
    event.scheduled_for<now()-interval '24 hours'
    OR event.preference_revision<>preference.version
    OR (delivery.channel='push' AND (NOT preference.push_enabled OR NOT EXISTS (
      SELECT 1 FROM notification_endpoints endpoint
      WHERE endpoint.household_id=delivery.household_id AND endpoint.id=delivery.endpoint_id
        AND endpoint.user_id=delivery.user_id AND endpoint.enabled
    )))
    OR (delivery.channel='email' AND (NOT preference.email_enabled OR preference.email_verified_at IS NULL OR preference.email_suppressed_at IS NOT NULL))
    OR (event.event_type='commitment.upcoming' AND NOT preference.commitment_reminders)
    OR (event.event_type='income.missed' AND NOT preference.income_reminders)
    OR (event.event_type='savings.upcoming' AND NOT preference.savings_reminders)
    OR (event.event_type='connection.health' AND NOT preference.connection_health)
    OR (event.event_type='exception.open' AND NOT preference.exception_activity)
    OR (event.event_type='digest.weekly' AND NOT preference.weekly_digest)
    OR (event.occurrence_id IS NOT NULL AND (occurrence.id IS NULL OR occurrence.version<>event.occurrence_revision
      OR (event.event_type='income.missed' AND occurrence.state<>'overdue')
      OR (event.event_type<>'income.missed' AND occurrence.state NOT IN ('expected','partial'))))
  );
  UPDATE notification_deliveries delivery
    SET state='dead',locked_at=null,lease_token=null,last_error_code=coalesce(delivery.last_error_code,'retry_limit')
    WHERE delivery.state IN ('queued','retry') AND delivery.attempts>=6;
  SELECT delivery.id INTO v_id FROM notification_deliveries delivery
  JOIN notification_events event ON event.household_id=delivery.household_id AND event.id=delivery.event_id
  WHERE delivery.state IN ('queued','retry') AND delivery.available_at<=now() AND event.scheduled_for<=now()
  ORDER BY event.scheduled_for,delivery.created_at FOR UPDATE OF delivery SKIP LOCKED LIMIT 1;
  IF v_id IS NULL THEN RETURN; END IF;
  UPDATE notification_deliveries delivery SET state='sending',locked_at=now(),lease_token=v_token,
    lease_generation=delivery.lease_generation+1,attempts=delivery.attempts+1 WHERE delivery.id=v_id;
  RETURN QUERY SELECT delivery.id,delivery.lease_token,delivery.household_id,delivery.user_id,delivery.endpoint_id,
    delivery.channel,endpoint.platform,endpoint.encrypted_token,endpoint.token_key_id,preference.email_address,
    event.title,event.body,event.deep_link_path,preference.lock_screen_detail,delivery.attempts
  FROM notification_deliveries delivery JOIN notification_events event
    ON event.household_id=delivery.household_id AND event.id=delivery.event_id AND event.user_id=delivery.user_id
  JOIN notification_preferences preference ON preference.household_id=delivery.household_id AND preference.user_id=delivery.user_id
  LEFT JOIN notification_endpoints endpoint ON endpoint.household_id=delivery.household_id AND endpoint.id=delivery.endpoint_id
  WHERE delivery.id=v_id AND delivery.lease_token=v_token;
END $$;

CREATE FUNCTION finish_notification_delivery(p_id uuid,p_lease_token uuid,p_state text,p_error text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT pg_has_role(session_user,'budgefi_worker','MEMBER') THEN RAISE EXCEPTION 'worker capability required'; END IF;
  IF p_state NOT IN ('sent','retry','dead','suppressed') THEN RAISE EXCEPTION 'invalid delivery state'; END IF;
  UPDATE notification_deliveries SET state=CASE WHEN p_state='retry' AND attempts>=6 THEN 'dead' ELSE p_state END,
    sent_at=CASE WHEN p_state='sent' THEN now() ELSE sent_at END,locked_at=NULL,lease_token=NULL,
    last_error_code=left(p_error,120),available_at=CASE WHEN p_state='retry' THEN now()+make_interval(secs=>least(3600,30*(2^greatest(attempts-1,0))::integer)) ELSE available_at END
  WHERE id=p_id AND state='sending' AND lease_token=p_lease_token;
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION notification_local_instant(date,integer,text),notification_scheduled_instant(date,integer,integer,integer,text,integer,integer),notification_immediate_instant(timestamptz,text,integer,integer),claim_notification_delivery(),finish_notification_delivery(uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_notification_delivery(),finish_notification_delivery(uuid,uuid,text,text) TO budgefi_worker;

DROP FUNCTION generate_notification_events();
CREATE FUNCTION generate_notification_events(p_household uuid DEFAULT NULL,p_now timestamptz DEFAULT now())
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record; v_event uuid; v_count integer:=0;
BEGIN
  IF NOT pg_has_role(session_user,'budgefi_worker','MEMBER') THEN RAISE EXCEPTION 'worker capability required'; END IF;
  FOR r IN
    WITH occurrence_candidates AS (
      SELECT preference.household_id,preference.user_id,preference.version preference_revision,
        preference.push_enabled,preference.email_enabled,preference.email_verified_at,preference.email_suppressed_at,preference.email_address,
        occurrence.id occurrence_id,occurrence.version occurrence_revision,lead.days lead_days,
        notification_scheduled_instant(occurrence.expected_on,lead.days,preference.reminder_hour,preference.reminder_minute,
          preference.timezone,preference.quiet_start_minute,preference.quiet_end_minute) scheduled_for,
        'commitment.upcoming' event_type,'Upcoming commitment' title,
        CASE WHEN occurrence.state='partial' THEN 'A commitment still has an amount left to verify.' ELSE 'A commitment is coming up.' END body,
        '/activity?occurrence='||occurrence.id::text path,
        'commitment:'||occurrence.id::text||':'||occurrence.version::text||':'||lead.days::text||':p'||preference.version::text dedupe,
        preference.timezone
      FROM notification_preferences preference JOIN plan_occurrences occurrence ON occurrence.household_id=preference.household_id
      JOIN commitments commitment ON commitment.household_id=occurrence.household_id AND commitment.id=occurrence.commitment_id
        AND commitment.active AND commitment.settled_at IS NULL
      CROSS JOIN LATERAL unnest(CASE WHEN commitment.recurrence IN ('quarterly','annual')
        THEN preference.long_term_reminder_days ELSE preference.commitment_reminder_days END) lead(days)
      WHERE preference.commitment_reminders AND occurrence.kind='commitment' AND occurrence.state IN ('expected','partial')
        AND (p_household IS NULL OR preference.household_id=p_household)
      UNION ALL
      SELECT preference.household_id,preference.user_id,preference.version,
        preference.push_enabled,preference.email_enabled,preference.email_verified_at,preference.email_suppressed_at,preference.email_address,
        occurrence.id,occurrence.version,lead.days,
        notification_scheduled_instant(occurrence.expected_on,lead.days,preference.reminder_hour,preference.reminder_minute,
          preference.timezone,preference.quiet_start_minute,preference.quiet_end_minute),
        'savings.upcoming','Savings plan reminder','A planned savings contribution is due. Budgefi will not mark it saved until it is confirmed.',
        '/activity?occurrence='||occurrence.id::text,
        'savings:'||occurrence.id::text||':'||occurrence.version::text||':'||lead.days::text||':p'||preference.version::text,
        preference.timezone
      FROM notification_preferences preference JOIN plan_occurrences occurrence ON occurrence.household_id=preference.household_id
      JOIN savings_goals goal ON goal.household_id=occurrence.household_id AND goal.id=occurrence.savings_goal_id AND goal.status='active'
      CROSS JOIN LATERAL unnest(preference.savings_reminder_days) lead(days)
      WHERE preference.savings_reminders AND occurrence.kind='savings' AND occurrence.state IN ('expected','partial')
        AND (p_household IS NULL OR preference.household_id=p_household)
      UNION ALL
      SELECT preference.household_id,preference.user_id,preference.version,
        preference.push_enabled,preference.email_enabled,preference.email_verified_at,preference.email_suppressed_at,preference.email_address,
        occurrence.id,occurrence.version,-1,
        notification_scheduled_instant(occurrence.expected_on,-1,preference.reminder_hour,preference.reminder_minute,
          preference.timezone,preference.quiet_start_minute,preference.quiet_end_minute),
        'income.missed','Expected income needs review','An expected deposit has not been confirmed. Open Budgefi to review it.',
        '/activity?occurrence='||occurrence.id::text,
        'income:'||occurrence.id::text||':'||occurrence.version::text||':missed:p'||preference.version::text,
        preference.timezone
      FROM notification_preferences preference JOIN plan_occurrences occurrence ON occurrence.household_id=preference.household_id
      JOIN income_schedules schedule ON schedule.household_id=occurrence.household_id AND schedule.id=occurrence.income_schedule_id
        AND schedule.status='active' AND schedule.confirmed
      WHERE preference.income_reminders AND occurrence.kind='income' AND occurrence.state='overdue'
        AND (p_household IS NULL OR preference.household_id=p_household)
    ), generic_candidates AS (
      SELECT preference.household_id,preference.user_id,preference.version preference_revision,
        preference.push_enabled,preference.email_enabled,preference.email_verified_at,preference.email_suppressed_at,preference.email_address,
        NULL::uuid occurrence_id,NULL::integer occurrence_revision,NULL::smallint lead_days,
        notification_immediate_instant(p_now,preference.timezone,preference.quiet_start_minute,preference.quiet_end_minute) scheduled_for,
        'connection.health' event_type,'Account connection needs attention' title,'Open Accounts & data to review a connection issue.' body,
        '/connections' path,'connection:'||connection.id||':'||connection.status||':'||to_char((p_now AT TIME ZONE preference.timezone)::date,'YYYY-MM-DD')||':p'||preference.version::text dedupe,
        preference.timezone
      FROM notification_preferences preference JOIN connections connection ON connection.household_id=preference.household_id
      WHERE preference.connection_health AND connection.status IN ('stale','login_required','error')
        AND (p_household IS NULL OR preference.household_id=p_household)
      UNION ALL
      SELECT preference.household_id,preference.user_id,preference.version,
        preference.push_enabled,preference.email_enabled,preference.email_verified_at,preference.email_suppressed_at,preference.email_address,
        NULL,NULL,NULL,notification_immediate_instant(p_now,preference.timezone,preference.quiet_start_minute,preference.quiet_end_minute),'exception.open','A financial exception needs review','Open Review to see the evidence.',
        '/review','exception:'||exception.id||':'||exception.version::text||':p'||preference.version::text,preference.timezone
      FROM notification_preferences preference JOIN exception_cases exception ON exception.household_id=preference.household_id
      WHERE preference.exception_activity AND exception.status IN ('open','decided','awaiting_verification')
        AND (p_household IS NULL OR preference.household_id=p_household)
      UNION ALL
      SELECT preference.household_id,preference.user_id,preference.version,
        preference.push_enabled,preference.email_enabled,preference.email_verified_at,preference.email_suppressed_at,preference.email_address,
        NULL,NULL,NULL,
        notification_scheduled_instant(
          (p_now AT TIME ZONE preference.timezone)::date-(extract(isodow FROM (p_now AT TIME ZONE preference.timezone))::integer-1),
          0,preference.reminder_hour,preference.reminder_minute,
          preference.timezone,preference.quiet_start_minute,preference.quiet_end_minute),
        'digest.weekly','Your weekly money summary is ready','Open Activity to review what changed this week.',
        '/activity','weekly:'||to_char((p_now AT TIME ZONE preference.timezone)::date,'IYYY-IW')||':p'||preference.version::text,preference.timezone
      FROM notification_preferences preference
      WHERE preference.weekly_digest
        AND (p_household IS NULL OR preference.household_id=p_household)
    )
    SELECT * FROM occurrence_candidates WHERE scheduled_for<=p_now AND scheduled_for>p_now-interval '24 hours'
      AND (push_enabled OR (email_enabled AND email_verified_at IS NOT NULL AND email_suppressed_at IS NULL))
    UNION ALL
    SELECT * FROM generic_candidates WHERE scheduled_for<=p_now AND scheduled_for>p_now-interval '24 hours'
      AND (push_enabled OR (email_enabled AND email_verified_at IS NOT NULL AND email_suppressed_at IS NULL))
  LOOP
    IF r.occurrence_id IS NOT NULL AND EXISTS(
      SELECT 1 FROM notification_events prior JOIN notification_deliveries delivery
        ON delivery.household_id=prior.household_id AND delivery.event_id=prior.id
      WHERE prior.household_id=r.household_id AND prior.user_id=r.user_id
        AND prior.event_type=r.event_type AND prior.occurrence_id=r.occurrence_id
        AND prior.occurrence_revision=r.occurrence_revision AND prior.lead_days=r.lead_days
        AND delivery.state='sent'
    ) THEN CONTINUE; END IF;
    INSERT INTO notification_events(id,household_id,user_id,event_type,title,body,deep_link_path,dedupe_key,
      occurrence_id,occurrence_revision,preference_revision,scheduled_for,lead_days,timezone_snapshot)
    VALUES(gen_random_uuid(),r.household_id,r.user_id,r.event_type,r.title,r.body,r.path,r.dedupe,
      r.occurrence_id,r.occurrence_revision,r.preference_revision,r.scheduled_for,r.lead_days,r.timezone)
    ON CONFLICT(household_id,user_id,dedupe_key) DO NOTHING;
    SELECT id INTO v_event FROM notification_events
      WHERE household_id=r.household_id AND user_id=r.user_id AND dedupe_key=r.dedupe;
    IF v_event IS NULL THEN CONTINUE; END IF;
    INSERT INTO notification_deliveries(household_id,user_id,event_id,endpoint_id,channel)
      SELECT r.household_id,r.user_id,v_event,endpoint.id,'push' FROM notification_endpoints endpoint
      WHERE endpoint.household_id=r.household_id AND endpoint.user_id=r.user_id AND endpoint.enabled AND r.push_enabled
      ON CONFLICT DO NOTHING;
    IF r.email_enabled AND r.email_verified_at IS NOT NULL AND r.email_suppressed_at IS NULL AND r.email_address IS NOT NULL THEN
      INSERT INTO notification_deliveries(household_id,user_id,event_id,channel,destination_hash)
      VALUES(r.household_id,r.user_id,v_event,'email',encode(digest(lower(r.email_address),'sha256'),'hex')) ON CONFLICT DO NOTHING;
    END IF;
    v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION generate_notification_events(uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION generate_notification_events(uuid,timestamptz) TO budgefi_worker;

CREATE TABLE schedule_maintenance_jobs (
  household_id uuid PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  lease_token uuid,
  attempts integer NOT NULL DEFAULT 0,
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE households NO FORCE ROW LEVEL SECURITY;
INSERT INTO schedule_maintenance_jobs(household_id)
SELECT id FROM households WHERE deleted_at IS NULL ON CONFLICT DO NOTHING;
ALTER TABLE households FORCE ROW LEVEL SECURITY;
ALTER TABLE schedule_maintenance_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_maintenance_jobs FORCE ROW LEVEL SECURITY;

CREATE FUNCTION create_schedule_maintenance_job()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN INSERT INTO schedule_maintenance_jobs(household_id) VALUES(NEW.id) ON CONFLICT DO NOTHING; RETURN NEW; END $$;
CREATE TRIGGER household_schedule_maintenance AFTER INSERT ON households
  FOR EACH ROW EXECUTE FUNCTION create_schedule_maintenance_job();

CREATE FUNCTION claim_schedule_maintenance()
RETURNS TABLE(household_id uuid,lease_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_household uuid; v_token uuid:=gen_random_uuid();
BEGIN
  IF NOT pg_has_role(session_user,'budgefi_worker','MEMBER') THEN RAISE EXCEPTION 'worker capability required'; END IF;
  UPDATE schedule_maintenance_jobs SET locked_at=NULL,lease_token=NULL,available_at=now(),last_error_code='worker_lease_expired'
    WHERE locked_at<now()-interval '5 minutes';
  SELECT job.household_id INTO v_household FROM schedule_maintenance_jobs job JOIN households household ON household.id=job.household_id
    WHERE household.deleted_at IS NULL AND job.available_at<=now() AND job.locked_at IS NULL
    ORDER BY job.available_at,job.household_id FOR UPDATE OF job SKIP LOCKED LIMIT 1;
  IF v_household IS NULL THEN RETURN; END IF;
  UPDATE schedule_maintenance_jobs job SET locked_at=now(),lease_token=v_token,attempts=attempts+1,updated_at=now()
    WHERE job.household_id=v_household;
  RETURN QUERY SELECT v_household,v_token;
END $$;

CREATE FUNCTION finish_schedule_maintenance(p_household uuid,p_lease uuid,p_error text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT pg_has_role(session_user,'budgefi_worker','MEMBER') THEN RAISE EXCEPTION 'worker capability required'; END IF;
  UPDATE schedule_maintenance_jobs SET locked_at=NULL,lease_token=NULL,
    available_at=CASE WHEN p_error IS NULL THEN now()+interval '1 hour' ELSE now()+make_interval(secs=>least(3600,30*(2^greatest(attempts-1,0))::integer)) END,
    attempts=CASE WHEN p_error IS NULL THEN 0 ELSE attempts END,last_error_code=left(p_error,120),updated_at=now()
  WHERE household_id=p_household AND lease_token=p_lease;
  RETURN FOUND;
END $$;

REVOKE ALL ON TABLE schedule_maintenance_jobs FROM PUBLIC,budgefi_app,budgefi_worker;
REVOKE ALL ON FUNCTION claim_schedule_maintenance(),finish_schedule_maintenance(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_schedule_maintenance(),finish_schedule_maintenance(uuid,uuid,text) TO budgefi_worker;
