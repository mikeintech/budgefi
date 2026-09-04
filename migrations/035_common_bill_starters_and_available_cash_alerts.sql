-- Audited blank planning starters and a plan-aware Available-to-use alert.

ALTER TABLE notification_preferences
  ADD COLUMN available_cash_alerts boolean NOT NULL DEFAULT false,
  ADD COLUMN available_cash_threshold_minor bigint NOT NULL DEFAULT 25000
    CHECK(available_cash_threshold_minor BETWEEN 0 AND 100000000);
ALTER TABLE notification_preference_revisions
  ADD COLUMN available_cash_alerts boolean NOT NULL DEFAULT false,
  ADD COLUMN available_cash_threshold_minor bigint NOT NULL DEFAULT 25000;

CREATE OR REPLACE FUNCTION append_notification_preference_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  INSERT INTO notification_preference_revisions(
    household_id,user_id,version,email_enabled,push_enabled,connection_health,commitment_reminders,
    income_reminders,savings_reminders,exception_activity,weekly_digest,available_cash_alerts,
    available_cash_threshold_minor,lock_screen_detail,commitment_reminder_days,long_term_reminder_days,
    savings_reminder_days,reminder_hour,reminder_minute,quiet_start_minute,quiet_end_minute,timezone)
  VALUES(NEW.household_id,NEW.user_id,NEW.version,NEW.email_enabled,NEW.push_enabled,NEW.connection_health,
    NEW.commitment_reminders,NEW.income_reminders,NEW.savings_reminders,NEW.exception_activity,
    NEW.weekly_digest,NEW.available_cash_alerts,NEW.available_cash_threshold_minor,NEW.lock_screen_detail,
    NEW.commitment_reminder_days,NEW.long_term_reminder_days,NEW.savings_reminder_days,NEW.reminder_hour,
    NEW.reminder_minute,NEW.quiet_start_minute,NEW.quiet_end_minute,NEW.timezone);
  RETURN NEW;
END $$;

ALTER TABLE calculation_snapshots
  ADD COLUMN horizon_start date,
  ADD COLUMN horizon_end date,
  ADD COLUMN freshness_status text NOT NULL DEFAULT 'incomplete'
    CHECK(freshness_status IN ('current','manual','stale','incomplete')),
  ADD COLUMN freshness_as_of timestamptz;

CREATE TABLE available_cash_alert_episodes(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  user_id uuid NOT NULL,
  preference_revision integer NOT NULL,
  threshold_minor bigint NOT NULL CHECK(threshold_minor BETWEEN 0 AND 100000000),
  hysteresis_minor bigint NOT NULL CHECK(hysteresis_minor BETWEEN 100 AND 2500),
  opened_snapshot_id uuid NOT NULL,
  last_snapshot_id uuid NOT NULL,
  opened_available_minor bigint NOT NULL,
  last_available_minor bigint NOT NULL,
  status text NOT NULL CHECK(status IN ('open','recovered','unavailable','cancelled')),
  notify_eligible_at timestamptz NOT NULL,
  notification_suppression_reason text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  recovered_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,id),
  FOREIGN KEY(household_id,user_id) REFERENCES notification_preferences(household_id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(household_id,opened_snapshot_id) REFERENCES calculation_snapshots(household_id,id),
  FOREIGN KEY(household_id,last_snapshot_id) REFERENCES calculation_snapshots(household_id,id)
);
CREATE TABLE available_cash_alert_states(
  household_id uuid NOT NULL,
  user_id uuid NOT NULL,
  current_status text NOT NULL CHECK(current_status IN ('above','below','unavailable')),
  armed boolean NOT NULL,
  current_episode_id uuid,
  last_snapshot_id uuid NOT NULL,
  last_evaluated_at timestamptz NOT NULL,
  last_available_minor bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(household_id,user_id),
  FOREIGN KEY(household_id,user_id) REFERENCES notification_preferences(household_id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(household_id,current_episode_id) REFERENCES available_cash_alert_episodes(household_id,id),
  FOREIGN KEY(household_id,last_snapshot_id) REFERENCES calculation_snapshots(household_id,id)
);

ALTER TABLE notification_events ADD COLUMN available_cash_episode_id uuid;
ALTER TABLE notification_events ADD CONSTRAINT notification_event_available_cash_episode_fk
  FOREIGN KEY(household_id,available_cash_episode_id)
  REFERENCES available_cash_alert_episodes(household_id,id) ON DELETE CASCADE;

CREATE TABLE starter_template_applications(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_key text NOT NULL CHECK(template_key='common_bills'),
  template_version integer NOT NULL CHECK(template_version=1),
  request_id uuid NOT NULL,
  plan_version integer NOT NULL,
  undone_at timestamptz,
  undone_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,request_id),
  UNIQUE(household_id,id)
);
CREATE TABLE starter_template_application_items(
  household_id uuid NOT NULL,
  application_id uuid NOT NULL,
  item_key text NOT NULL CHECK(item_key IN ('housing','utilities','phone_internet','insurance','subscriptions','debt_payment')),
  commitment_id uuid NOT NULL,
  commitment_version integer NOT NULL,
  name_snapshot text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(household_id,application_id,item_key),
  FOREIGN KEY(household_id,application_id) REFERENCES starter_template_applications(household_id,id) ON DELETE CASCADE,
  FOREIGN KEY(household_id,commitment_id) REFERENCES commitments(household_id,id)
);

CREATE FUNCTION delete_starter_applications_for_commitment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM starter_template_application_items item
    WHERE item.household_id=OLD.household_id AND item.commitment_id=OLD.id) THEN
    RETURN OLD;
  END IF;
  IF nullif(current_setting('app.account_deletion_request_id',true),'') IS NULL THEN
    RAISE EXCEPTION 'starter application cleanup requires account deletion boundary';
  END IF;
  DELETE FROM starter_template_applications application
  WHERE application.household_id=OLD.household_id AND EXISTS(
    SELECT 1 FROM starter_template_application_items item
    WHERE item.household_id=application.household_id AND item.application_id=application.id
      AND item.commitment_id=OLD.id
  );
  RETURN OLD;
END $$;
CREATE TRIGGER commitments_delete_starter_applications
  BEFORE DELETE ON commitments FOR EACH ROW
  EXECUTE FUNCTION delete_starter_applications_for_commitment();

CREATE FUNCTION delete_starter_applications_for_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    IF nullif(current_setting('app.account_deletion_request_id',true),'') IS NULL THEN
      RAISE EXCEPTION 'starter application cleanup requires account deletion boundary';
    END IF;
    DELETE FROM starter_template_applications WHERE user_id=OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_delete_starter_applications
  BEFORE UPDATE OF deleted_at ON users FOR EACH ROW
  EXECUTE FUNCTION delete_starter_applications_for_user();

ALTER TABLE available_cash_alert_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE available_cash_alert_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE starter_template_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE starter_template_application_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY available_cash_alert_episodes_self ON available_cash_alert_episodes
  USING(household_id=nullif(current_setting('app.household_id',true),'')::uuid AND user_id=nullif(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK(household_id=nullif(current_setting('app.household_id',true),'')::uuid AND user_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY available_cash_alert_states_self ON available_cash_alert_states
  USING(household_id=nullif(current_setting('app.household_id',true),'')::uuid AND user_id=nullif(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK(household_id=nullif(current_setting('app.household_id',true),'')::uuid AND user_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY starter_template_applications_self ON starter_template_applications
  USING(household_id=nullif(current_setting('app.household_id',true),'')::uuid AND user_id=nullif(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK(household_id=nullif(current_setting('app.household_id',true),'')::uuid AND user_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY starter_template_application_items_self ON starter_template_application_items
  USING(EXISTS(SELECT 1 FROM starter_template_applications application WHERE application.household_id=starter_template_application_items.household_id AND application.id=starter_template_application_items.application_id AND application.user_id=nullif(current_setting('app.user_id',true),'')::uuid))
  WITH CHECK(EXISTS(SELECT 1 FROM starter_template_applications application WHERE application.household_id=starter_template_application_items.household_id AND application.id=starter_template_application_items.application_id AND application.user_id=nullif(current_setting('app.user_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON available_cash_alert_episodes,available_cash_alert_states TO budgefi_app;
GRANT SELECT,INSERT,UPDATE ON starter_template_applications TO budgefi_app;
GRANT SELECT,INSERT ON starter_template_application_items TO budgefi_app;
GRANT UPDATE (setup_slot) ON commitments TO budgefi_app;

CREATE FUNCTION evaluate_available_cash_alert(p_snapshot uuid,p_external_eligible boolean DEFAULT false,p_now timestamptz DEFAULT now())
RETURNS uuid LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v_household uuid:=nullif(current_setting('app.household_id',true),'')::uuid;
  v_user uuid:=nullif(current_setting('app.user_id',true),'')::uuid; v_snapshot calculation_snapshots%ROWTYPE;
  v_pref notification_preferences%ROWTYPE; v_state available_cash_alert_states%ROWTYPE;
  v_episode uuid; v_fresh boolean; v_hysteresis bigint;
BEGIN
  SELECT * INTO v_snapshot FROM calculation_snapshots WHERE household_id=v_household AND id=p_snapshot;
  SELECT * INTO v_pref FROM notification_preferences WHERE household_id=v_household AND user_id=v_user;
  IF v_snapshot.id IS NULL OR v_pref.user_id IS NULL OR NOT v_pref.available_cash_alerts THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_household::text||':'||v_user::text,7242));
  SELECT * INTO v_state FROM available_cash_alert_states WHERE household_id=v_household AND user_id=v_user FOR UPDATE;
  IF v_state.last_evaluated_at IS NOT NULL AND v_snapshot.calculated_at<v_state.last_evaluated_at THEN RETURN v_state.current_episode_id; END IF;
  IF v_state.current_episode_id IS NOT NULL AND EXISTS(
    SELECT 1 FROM available_cash_alert_episodes episode
    WHERE episode.household_id=v_household AND episode.id=v_state.current_episode_id
      AND episode.preference_revision<>v_pref.version
  ) THEN
    UPDATE available_cash_alert_episodes SET status='cancelled',notification_suppression_reason='preference_changed',updated_at=p_now
      WHERE household_id=v_household AND id=v_state.current_episode_id AND status='open';
    UPDATE notification_deliveries delivery SET state='suppressed',last_error_code='available_cash_preference_changed'
      FROM notification_events event WHERE delivery.household_id=v_household AND delivery.event_id=event.id
        AND event.available_cash_episode_id=v_state.current_episode_id AND delivery.state IN ('queued','retry');
    v_state.current_episode_id:=NULL; v_state.current_status:='unavailable'; v_state.armed:=true;
  END IF;
  v_hysteresis:=least(2500::bigint,greatest(100::bigint,v_pref.available_cash_threshold_minor/10));
  v_fresh:=v_snapshot.freshness_status='current' OR (v_snapshot.freshness_status='manual' AND v_snapshot.freshness_as_of>=p_now-interval '7 days');
  IF NOT v_fresh THEN
    IF v_state.current_episode_id IS NOT NULL THEN
      UPDATE available_cash_alert_episodes SET status='unavailable',updated_at=p_now WHERE id=v_state.current_episode_id AND status='open';
      UPDATE notification_deliveries delivery SET state='suppressed',last_error_code='available_cash_unavailable'
      FROM notification_events event WHERE delivery.household_id=v_household AND delivery.event_id=event.id
        AND event.available_cash_episode_id=v_state.current_episode_id AND delivery.state IN ('queued','retry');
    END IF;
    INSERT INTO available_cash_alert_states(household_id,user_id,current_status,armed,current_episode_id,last_snapshot_id,last_evaluated_at,last_available_minor)
      VALUES(v_household,v_user,'unavailable',coalesce(v_state.armed,true),NULL,v_snapshot.id,v_snapshot.calculated_at,v_snapshot.available_minor)
      ON CONFLICT(household_id,user_id) DO UPDATE SET current_status='unavailable',current_episode_id=NULL,last_snapshot_id=excluded.last_snapshot_id,last_evaluated_at=excluded.last_evaluated_at,last_available_minor=excluded.last_available_minor,updated_at=p_now;
    RETURN NULL;
  END IF;
  IF v_snapshot.available_minor<v_pref.available_cash_threshold_minor THEN
    IF v_state.user_id IS NULL OR v_state.armed THEN
      INSERT INTO available_cash_alert_episodes(household_id,user_id,preference_revision,threshold_minor,hysteresis_minor,opened_snapshot_id,last_snapshot_id,opened_available_minor,last_available_minor,status,notify_eligible_at,notification_suppression_reason)
      VALUES(v_household,v_user,v_pref.version,v_pref.available_cash_threshold_minor,v_hysteresis,v_snapshot.id,v_snapshot.id,v_snapshot.available_minor,v_snapshot.available_minor,'open',CASE WHEN p_external_eligible THEN p_now ELSE p_now+interval '24 hours' END,CASE WHEN p_external_eligible THEN NULL ELSE 'user_change_grace' END)
      RETURNING id INTO v_episode;
    ELSE
      v_episode:=v_state.current_episode_id;
      UPDATE available_cash_alert_episodes SET last_snapshot_id=v_snapshot.id,last_available_minor=v_snapshot.available_minor,updated_at=p_now WHERE id=v_episode AND status='open';
    END IF;
    INSERT INTO available_cash_alert_states(household_id,user_id,current_status,armed,current_episode_id,last_snapshot_id,last_evaluated_at,last_available_minor)
      VALUES(v_household,v_user,'below',false,v_episode,v_snapshot.id,v_snapshot.calculated_at,v_snapshot.available_minor)
      ON CONFLICT(household_id,user_id) DO UPDATE SET current_status='below',armed=false,current_episode_id=excluded.current_episode_id,last_snapshot_id=excluded.last_snapshot_id,last_evaluated_at=excluded.last_evaluated_at,last_available_minor=excluded.last_available_minor,updated_at=p_now;
    RETURN v_episode;
  END IF;
  IF v_state.current_episode_id IS NOT NULL THEN
    UPDATE available_cash_alert_episodes SET status='recovered',last_snapshot_id=v_snapshot.id,last_available_minor=v_snapshot.available_minor,recovered_at=p_now,updated_at=p_now WHERE id=v_state.current_episode_id AND status='open';
    UPDATE notification_deliveries delivery SET state='suppressed',last_error_code='available_cash_recovered'
    FROM notification_events event WHERE delivery.household_id=v_household AND delivery.event_id=event.id
      AND event.available_cash_episode_id=v_state.current_episode_id AND delivery.state IN ('queued','retry');
  END IF;
  INSERT INTO available_cash_alert_states(household_id,user_id,current_status,armed,current_episode_id,last_snapshot_id,last_evaluated_at,last_available_minor)
    VALUES(v_household,v_user,'above',v_snapshot.available_minor>=v_pref.available_cash_threshold_minor+v_hysteresis,NULL,v_snapshot.id,v_snapshot.calculated_at,v_snapshot.available_minor)
    ON CONFLICT(household_id,user_id) DO UPDATE SET current_status='above',armed=excluded.armed,current_episode_id=NULL,last_snapshot_id=excluded.last_snapshot_id,last_evaluated_at=excluded.last_evaluated_at,last_available_minor=excluded.last_available_minor,updated_at=p_now;
  RETURN NULL;
END $$;

CREATE FUNCTION generate_available_cash_events(p_household uuid DEFAULT NULL,p_now timestamptz DEFAULT now())
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record; v_event uuid; v_count integer:=0;
BEGIN
  IF NOT pg_has_role(session_user,'budgefi_worker','MEMBER') THEN RAISE EXCEPTION 'worker capability required'; END IF;
  FOR r IN SELECT episode.*,preference.push_enabled,preference.email_enabled,preference.email_verified_at,
      preference.email_suppressed_at,preference.email_address,preference.reminder_hour,preference.reminder_minute,
      preference.quiet_start_minute,preference.quiet_end_minute,preference.timezone
    FROM available_cash_alert_episodes episode
    JOIN available_cash_alert_states state ON state.household_id=episode.household_id AND state.user_id=episode.user_id AND state.current_episode_id=episode.id AND state.current_status='below'
    JOIN notification_preferences preference ON preference.household_id=episode.household_id AND preference.user_id=episode.user_id
    JOIN LATERAL (
      SELECT snapshot.freshness_status,snapshot.freshness_as_of
      FROM calculation_snapshots snapshot WHERE snapshot.household_id=episode.household_id
      ORDER BY snapshot.calculated_at DESC,snapshot.id DESC LIMIT 1
    ) latest ON true
    WHERE episode.status='open' AND episode.notify_eligible_at<=p_now AND preference.available_cash_alerts
      AND episode.preference_revision=preference.version AND (p_household IS NULL OR episode.household_id=p_household)
      AND (latest.freshness_status='current' AND latest.freshness_as_of>=p_now-interval '36 hours'
        OR latest.freshness_status='manual' AND latest.freshness_as_of>=p_now-interval '7 days')
  LOOP
    INSERT INTO notification_events(household_id,user_id,event_type,title,body,deep_link_path,dedupe_key,preference_revision,scheduled_for,timezone_snapshot,available_cash_episode_id)
    VALUES(r.household_id,r.user_id,'plan.available_low','Available to use is below your alert',
      'Budgefi’s Available to use is below the amount you chose. Open Today to review the current plan.',
      '/today?cash-alert='||r.id::text,'available-cash:'||r.id::text||':p'||r.preference_revision::text,
      r.preference_revision,notification_immediate_instant(p_now,r.timezone,r.quiet_start_minute,r.quiet_end_minute),r.timezone,r.id)
    ON CONFLICT(household_id,user_id,dedupe_key) DO NOTHING RETURNING id INTO v_event;
    IF v_event IS NULL THEN CONTINUE; END IF;
    INSERT INTO notification_deliveries(household_id,user_id,event_id,endpoint_id,channel)
      SELECT r.household_id,r.user_id,v_event,endpoint.id,'push' FROM notification_endpoints endpoint
      WHERE endpoint.household_id=r.household_id AND endpoint.user_id=r.user_id AND endpoint.enabled AND r.push_enabled ON CONFLICT DO NOTHING;
    IF r.email_enabled AND r.email_verified_at IS NOT NULL AND r.email_suppressed_at IS NULL AND r.email_address IS NOT NULL THEN
      INSERT INTO notification_deliveries(household_id,user_id,event_id,channel,destination_hash)
      VALUES(r.household_id,r.user_id,v_event,'email',encode(digest(lower(r.email_address),'sha256'),'hex')) ON CONFLICT DO NOTHING;
    END IF;
    v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END $$;

-- Recheck the crossing at claim time so recovery, stale data, or a settings
-- change cannot race a worker that is about to deliver an older event.
CREATE OR REPLACE FUNCTION claim_notification_delivery()
RETURNS TABLE(delivery_id uuid,lease_token uuid,household_id uuid,user_id uuid,endpoint_id uuid,channel text,platform text,encrypted_token bytea,token_key_id text,email_address text,title text,body text,deep_link_path text,lock_screen_detail boolean,attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid; v_token uuid:=gen_random_uuid();
BEGIN
  IF NOT pg_has_role(session_user,'budgefi_worker','MEMBER') THEN RAISE EXCEPTION 'worker capability required'; END IF;
  UPDATE notification_deliveries SET state='retry',locked_at=null,lease_token=null,available_at=now(),last_error_code='worker_lease_expired'
    WHERE state='sending' AND locked_at<now()-interval '5 minutes';
  UPDATE notification_deliveries delivery SET state='suppressed',locked_at=null,lease_token=null,last_error_code='preference_occurrence_or_alert_changed'
  FROM notification_events event JOIN notification_preferences preference
    ON preference.household_id=event.household_id AND preference.user_id=event.user_id
  LEFT JOIN plan_occurrences occurrence ON occurrence.household_id=event.household_id AND occurrence.id=event.occurrence_id
  WHERE delivery.household_id=event.household_id AND delivery.event_id=event.id AND delivery.state IN ('queued','retry') AND (
    event.scheduled_for<now()-interval '24 hours'
    OR event.preference_revision<>preference.version
    OR (delivery.channel='push' AND (NOT preference.push_enabled OR NOT EXISTS (
      SELECT 1 FROM notification_endpoints endpoint WHERE endpoint.household_id=delivery.household_id
        AND endpoint.id=delivery.endpoint_id AND endpoint.user_id=delivery.user_id AND endpoint.enabled)))
    OR (delivery.channel='email' AND (NOT preference.email_enabled OR preference.email_verified_at IS NULL OR preference.email_suppressed_at IS NOT NULL))
    OR (event.event_type='commitment.upcoming' AND NOT preference.commitment_reminders)
    OR (event.event_type='income.missed' AND NOT preference.income_reminders)
    OR (event.event_type='savings.upcoming' AND NOT preference.savings_reminders)
    OR (event.event_type='connection.health' AND NOT preference.connection_health)
    OR (event.event_type='exception.open' AND NOT preference.exception_activity)
    OR (event.event_type='digest.weekly' AND NOT preference.weekly_digest)
    OR (event.event_type='plan.available_low' AND (NOT preference.available_cash_alerts OR NOT EXISTS (
      SELECT 1 FROM available_cash_alert_episodes episode
      JOIN available_cash_alert_states state ON state.household_id=episode.household_id
        AND state.user_id=episode.user_id AND state.current_episode_id=episode.id
      JOIN LATERAL (
        SELECT snapshot.freshness_status,snapshot.freshness_as_of
        FROM calculation_snapshots snapshot WHERE snapshot.household_id=episode.household_id
        ORDER BY snapshot.calculated_at DESC,snapshot.id DESC LIMIT 1
      ) latest ON true
      WHERE episode.household_id=event.household_id AND episode.id=event.available_cash_episode_id
        AND episode.status='open' AND state.current_status='below'
        AND (latest.freshness_status='current' AND latest.freshness_as_of>=now()-interval '36 hours'
          OR latest.freshness_status='manual' AND latest.freshness_as_of>=now()-interval '7 days')
    )))
    OR (event.occurrence_id IS NOT NULL AND (occurrence.id IS NULL OR occurrence.version<>event.occurrence_revision
      OR (event.event_type='income.missed' AND occurrence.state<>'overdue')
      OR (event.event_type<>'income.missed' AND occurrence.state NOT IN ('expected','partial'))))
  );
  UPDATE notification_deliveries delivery SET state='dead',locked_at=null,lease_token=null,
    last_error_code=coalesce(delivery.last_error_code,'retry_limit')
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

REVOKE ALL ON FUNCTION evaluate_available_cash_alert(uuid,boolean,timestamptz),generate_available_cash_events(uuid,timestamptz),claim_notification_delivery() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evaluate_available_cash_alert(uuid,boolean,timestamptz) TO budgefi_app;
GRANT EXECUTE ON FUNCTION generate_available_cash_events(uuid,timestamptz),claim_notification_delivery() TO budgefi_worker;
