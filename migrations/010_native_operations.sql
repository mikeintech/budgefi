CREATE TABLE notification_preferences (
  household_id uuid NOT NULL REFERENCES households(id),
  user_id uuid NOT NULL REFERENCES users(id),
  email_address text,
  email_verified_at timestamptz,
  email_consent_at timestamptz,
  email_suppressed_at timestamptz,
  email_enabled boolean NOT NULL DEFAULT false,
  push_enabled boolean NOT NULL DEFAULT false,
  connection_health boolean NOT NULL DEFAULT true,
  commitment_reminders boolean NOT NULL DEFAULT true,
  exception_activity boolean NOT NULL DEFAULT true,
  weekly_digest boolean NOT NULL DEFAULT true,
  lock_screen_detail boolean NOT NULL DEFAULT false,
  reminder_hour smallint NOT NULL DEFAULT 9 CHECK (reminder_hour BETWEEN 0 AND 23),
  timezone text NOT NULL DEFAULT 'America/New_York',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, user_id)
);

ALTER TABLE exception_cases ADD COLUMN detection_key text;
CREATE UNIQUE INDEX exception_case_detection_key ON exception_cases(household_id,detection_key) WHERE detection_key IS NOT NULL;
ALTER TABLE plaid_sync_jobs DROP CONSTRAINT plaid_sync_jobs_trigger_check;
ALTER TABLE plaid_sync_jobs ADD CONSTRAINT plaid_sync_jobs_trigger_check CHECK (trigger IN ('initial','webhook','scheduled','manual','recovery'));

CREATE TABLE notification_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id),
  user_id uuid NOT NULL REFERENCES users(id),
  platform text NOT NULL CHECK (platform IN ('ios','android','web')),
  token_hash text NOT NULL,
  encrypted_token bytea NOT NULL,
  token_key_id text NOT NULL,
  device_label text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  registered_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  UNIQUE (household_id, id)
);
CREATE UNIQUE INDEX notification_one_active_token ON notification_endpoints(token_hash) WHERE enabled;

CREATE TABLE notification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id),
  user_id uuid NOT NULL REFERENCES users(id),
  event_type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  deep_link_path text NOT NULL DEFAULT '/today',
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, user_id, dedupe_key),
  UNIQUE (household_id, id)
);

CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  event_id uuid NOT NULL,
  endpoint_id uuid,
  channel text NOT NULL CHECK (channel IN ('push','email')),
  destination_hash text,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sending','sent','retry','dead','suppressed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  sent_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (household_id, event_id) REFERENCES notification_events(household_id, id),
  FOREIGN KEY (household_id, endpoint_id) REFERENCES notification_endpoints(household_id, id)
);
CREATE INDEX notification_delivery_poll_idx ON notification_deliveries (available_at, created_at) WHERE state IN ('queued','retry');
CREATE UNIQUE INDEX notification_delivery_once ON notification_deliveries (event_id, channel, coalesce(endpoint_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE account_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id),
  user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','revoking_connections','ready_to_finalize','finalizing','completed','failed')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  last_error_code text
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='budgefi_worker') THEN CREATE ROLE budgefi_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; END IF;
END $$;
CREATE UNIQUE INDEX account_deletion_one_active_per_user ON account_deletion_requests (user_id) WHERE completed_at IS NULL;

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_endpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_events FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE account_deletion_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY notification_preferences_self ON notification_preferences USING (household_id = nullif(current_setting('app.household_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK (household_id = nullif(current_setting('app.household_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY notification_endpoints_self ON notification_endpoints USING (household_id = nullif(current_setting('app.household_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK (household_id = nullif(current_setting('app.household_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY notification_events_self ON notification_events USING (household_id = nullif(current_setting('app.household_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK (household_id = nullif(current_setting('app.household_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY notification_deliveries_self ON notification_deliveries USING (household_id = nullif(current_setting('app.household_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK (household_id = nullif(current_setting('app.household_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY account_deletion_self ON account_deletion_requests USING (household_id = nullif(current_setting('app.household_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK (household_id = nullif(current_setting('app.household_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON notification_preferences, notification_endpoints, notification_events, notification_deliveries, account_deletion_requests TO budgefi_app;

CREATE OR REPLACE FUNCTION claim_notification_delivery()
RETURNS TABLE(delivery_id uuid, household_id uuid, user_id uuid, endpoint_id uuid, channel text, platform text, encrypted_token bytea, token_key_id text, email_address text, title text, body text, deep_link_path text, lock_screen_detail boolean, attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  UPDATE notification_deliveries SET state='retry',locked_at=null,available_at=now(),last_error_code='worker_lease_expired' WHERE state='sending' AND locked_at<now()-interval '5 minutes';
  UPDATE notification_deliveries d SET state='suppressed',last_error_code='preference_or_endpoint_disabled'
  FROM notification_preferences p
  WHERE d.household_id=p.household_id AND d.user_id=p.user_id AND d.state IN ('queued','retry') AND ((d.channel='push' AND (NOT p.push_enabled OR NOT EXISTS(SELECT 1 FROM notification_endpoints x WHERE x.household_id=d.household_id AND x.id=d.endpoint_id AND x.user_id=d.user_id AND x.enabled))) OR (d.channel='email' AND (NOT p.email_enabled OR p.email_verified_at IS NULL OR p.email_suppressed_at IS NOT NULL)));
  UPDATE notification_deliveries d SET state='dead',last_error_code=coalesce(d.last_error_code,'retry_limit') WHERE d.state IN ('queued','retry') AND d.attempts>=6;
  SELECT d.id INTO v_id FROM notification_deliveries d JOIN notification_preferences p ON p.household_id=d.household_id AND p.user_id=d.user_id LEFT JOIN notification_endpoints e ON e.household_id=d.household_id AND e.id=d.endpoint_id AND e.user_id=d.user_id WHERE d.state IN ('queued','retry') AND d.available_at <= now() AND ((d.channel='push' AND p.push_enabled AND e.enabled) OR (d.channel='email' AND p.email_enabled AND p.email_verified_at IS NOT NULL AND p.email_suppressed_at IS NULL)) ORDER BY d.created_at FOR UPDATE OF d SKIP LOCKED LIMIT 1;
  IF v_id IS NULL THEN RETURN; END IF;
  UPDATE notification_deliveries d SET state='sending', locked_at=now(), attempts=d.attempts+1 WHERE d.id=v_id;
  RETURN QUERY SELECT d.id,d.household_id,d.user_id,d.endpoint_id,d.channel,e.platform,e.encrypted_token,e.token_key_id,p.email_address,n.title,n.body,n.deep_link_path,p.lock_screen_detail,d.attempts
  FROM notification_deliveries d JOIN notification_events n ON n.household_id=d.household_id AND n.id=d.event_id AND n.user_id=d.user_id
  JOIN notification_preferences p ON p.household_id=d.household_id AND p.user_id=d.user_id
  LEFT JOIN notification_endpoints e ON e.household_id=d.household_id AND e.id=d.endpoint_id AND e.user_id=d.user_id
  WHERE d.id=v_id AND ((d.channel='push' AND p.push_enabled AND e.enabled) OR (d.channel='email' AND p.email_enabled AND p.email_verified_at IS NOT NULL AND p.email_suppressed_at IS NULL));
END $$;

CREATE OR REPLACE FUNCTION register_notification_endpoint(p_id uuid,p_platform text,p_token_hash text,p_encrypted_token bytea,p_token_key_id text,p_device_label text)
RETURNS TABLE(id uuid,platform text,device_label text,enabled boolean,registered_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user uuid:=nullif(current_setting('app.user_id',true),'')::uuid; v_household uuid:=nullif(current_setting('app.household_id',true),'')::uuid; v_existing notification_endpoints%ROWTYPE; v_result_id uuid;
BEGIN
  IF v_user IS NULL OR v_household IS NULL THEN RAISE EXCEPTION 'tenant context required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_token_hash,0));
  SELECT e.* INTO v_existing FROM notification_endpoints e WHERE e.token_hash=p_token_hash AND e.enabled FOR UPDATE;
  IF v_existing.id IS NOT NULL AND v_existing.household_id=v_household AND v_existing.user_id=v_user THEN
    UPDATE notification_endpoints e SET platform=p_platform,encrypted_token=p_encrypted_token,token_key_id=p_token_key_id,device_label=p_device_label,last_seen_at=now(),disabled_at=null WHERE e.id=v_existing.id;
    v_result_id:=v_existing.id;
  ELSE
    IF v_existing.id IS NOT NULL THEN UPDATE notification_endpoints e SET enabled=false,disabled_at=now() WHERE e.id=v_existing.id; END IF;
    INSERT INTO notification_endpoints(id,household_id,user_id,platform,token_hash,encrypted_token,token_key_id,device_label,enabled,registered_at,last_seen_at,disabled_at)
    VALUES(p_id,v_household,v_user,p_platform,p_token_hash,p_encrypted_token,p_token_key_id,p_device_label,true,now(),now(),null);
    v_result_id:=p_id;
  END IF;
  RETURN QUERY SELECT e.id,e.platform,e.device_label,e.enabled,e.registered_at FROM notification_endpoints e WHERE e.id=v_result_id;
END $$;

CREATE OR REPLACE FUNCTION finish_notification_delivery(p_id uuid, p_state text, p_error text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_state NOT IN ('sent','retry','dead','suppressed') THEN RAISE EXCEPTION 'invalid delivery state'; END IF;
  UPDATE notification_deliveries SET state=CASE WHEN p_state='retry' AND attempts>=6 THEN 'dead' ELSE p_state END, sent_at=CASE WHEN p_state='sent' THEN now() ELSE sent_at END, locked_at=NULL, last_error_code=left(p_error,120), available_at=CASE WHEN p_state='retry' THEN now()+make_interval(secs=>least(3600,30*(2^greatest(attempts-1,0))::integer)) ELSE available_at END WHERE id=p_id;
END $$;

CREATE OR REPLACE FUNCTION claim_account_deletion()
RETURNS TABLE(request_id uuid, user_id uuid, household_id uuid, auth_subject text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  SELECT r.id INTO v_id FROM account_deletion_requests r
  WHERE (r.status IN ('ready_to_finalize','revoking_connections') OR (r.status='finalizing' AND r.updated_at<now()-interval '5 minutes'))
    AND (
      EXISTS (SELECT 1 FROM household_memberships m WHERE m.household_id=r.household_id AND m.user_id<>r.user_id AND m.revoked_at IS NULL)
      OR NOT EXISTS (SELECT 1 FROM connections c WHERE c.household_id=r.household_id AND c.status <> 'revoked')
    )
    AND r.updated_at < now()-interval '5 seconds'
  ORDER BY r.requested_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF v_id IS NULL THEN RETURN; END IF;
  UPDATE account_deletion_requests SET status='finalizing', updated_at=now() WHERE id=v_id;
  RETURN QUERY SELECT r.id,r.user_id,r.household_id,u.auth_subject FROM account_deletion_requests r JOIN users u ON u.id=r.user_id WHERE r.id=v_id;
END $$;

-- Append-only records stay immutable during normal operation. A finalized,
-- tenant-scoped deletion request is the only audited exception, and only for
-- DELETE (never UPDATE). Application roles still have no DELETE grant on these
-- tables; this path is reached through finalize_account_deletion only.
CREATE OR REPLACE FUNCTION reject_append_only_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_request uuid:=nullif(current_setting('app.account_deletion_request_id',true),'')::uuid;
BEGIN
  IF TG_OP='DELETE' AND v_request IS NOT NULL AND EXISTS (
    SELECT 1 FROM account_deletion_requests r
    WHERE r.id=v_request AND r.status='finalizing' AND r.household_id=OLD.household_id
  ) THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;

CREATE OR REPLACE FUNCTION finalize_account_deletion(p_request_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid; v_household uuid;
BEGIN
  SELECT user_id,household_id INTO v_user,v_household FROM account_deletion_requests WHERE id=p_request_id AND status='finalizing' FOR UPDATE;
  IF v_user IS NULL THEN RETURN; END IF;
  PERFORM set_config('app.account_deletion_request_id',p_request_id::text,true);
  DELETE FROM notification_deliveries WHERE user_id=v_user;
  DELETE FROM notification_events WHERE user_id=v_user;
  DELETE FROM notification_endpoints WHERE user_id=v_user;
  DELETE FROM notification_preferences WHERE user_id=v_user;
  UPDATE household_memberships SET revoked_at=coalesce(revoked_at,now()) WHERE user_id=v_user;
  IF NOT EXISTS (SELECT 1 FROM household_memberships WHERE household_id=v_household AND revoked_at IS NULL) THEN
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
    DELETE FROM commitment_revisions WHERE household_id=v_household;
    DELETE FROM commitments WHERE household_id=v_household;
    DELETE FROM plan_revisions WHERE household_id=v_household;
    DELETE FROM financial_transactions WHERE household_id=v_household;
    DELETE FROM balance_observations WHERE household_id=v_household;
    DELETE FROM plans WHERE household_id=v_household;
    DELETE FROM accounts WHERE household_id=v_household;
    DELETE FROM connections WHERE household_id=v_household;
  END IF;
  UPDATE users SET auth_subject='deleted|'||id::text, display_name='Deleted member', email=NULL, deleted_at=now() WHERE id=v_user;
  IF NOT EXISTS (SELECT 1 FROM household_memberships WHERE household_id=v_household AND revoked_at IS NULL) THEN UPDATE households SET deleted_at=now() WHERE id=v_household; END IF;
  UPDATE account_deletion_requests SET status='completed', completed_at=now(), updated_at=now(), last_error_code=NULL WHERE id=p_request_id;
END $$;

CREATE OR REPLACE FUNCTION disable_notification_endpoint(p_id uuid,p_reason text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$ UPDATE notification_endpoints SET enabled=false,disabled_at=now() WHERE id=p_id $$;

CREATE OR REPLACE FUNCTION generate_notification_events()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record; v_event uuid; v_count integer:=0;
BEGIN
  FOR r IN
    SELECT p.household_id,p.user_id,p.push_enabled,p.email_enabled,p.email_verified_at,p.email_suppressed_at,p.email_address,
      'connection:'||c.id||':'||c.status||':'||to_char((now() AT TIME ZONE p.timezone)::date,'YYYY-MM-DD') AS dedupe,
      'connection.health' AS event_type,'/connections' AS path,
      'Account connection needs attention' AS title,'Open Accounts & data to review a connection issue.' AS body
    FROM notification_preferences p JOIN connections c ON c.household_id=p.household_id
    WHERE p.connection_health AND c.status IN ('stale','login_required','error')
    UNION ALL SELECT p.household_id,p.user_id,p.push_enabled,p.email_enabled,p.email_verified_at,p.email_suppressed_at,p.email_address,
      'commitment:'||k.id||':'||k.due_date::text,'commitment.upcoming','/plan',
      'A commitment is coming up','Open your plan to review the due date.'
    FROM notification_preferences p JOIN commitments k ON k.household_id=p.household_id
    WHERE p.commitment_reminders AND k.active AND k.due_date BETWEEN (now() AT TIME ZONE p.timezone)::date AND (now() AT TIME ZONE p.timezone)::date+3
    UNION ALL SELECT p.household_id,p.user_id,p.push_enabled,p.email_enabled,p.email_verified_at,p.email_suppressed_at,p.email_address,
      'exception:'||x.id||':'||x.version::text,'exception.open','/review',
      'A financial exception needs review','Open Review to see the evidence.'
    FROM notification_preferences p JOIN exception_cases x ON x.household_id=p.household_id
    WHERE p.exception_activity AND x.status IN ('open','decided','awaiting_verification')
    UNION ALL SELECT p.household_id,p.user_id,p.push_enabled,p.email_enabled,p.email_verified_at,p.email_suppressed_at,p.email_address,
      'weekly:'||to_char((now() AT TIME ZONE p.timezone)::date,'IYYY-IW'),'digest.weekly','/activity',
      'Your weekly money summary is ready','Open Activity to review what changed this week.'
    FROM notification_preferences p
    WHERE p.weekly_digest AND extract(isodow FROM (now() AT TIME ZONE p.timezone))=1 AND extract(hour FROM (now() AT TIME ZONE p.timezone))>=p.reminder_hour
  LOOP
    v_event:=null;
    INSERT INTO notification_events(id,household_id,user_id,event_type,title,body,deep_link_path,dedupe_key) VALUES(gen_random_uuid(),r.household_id,r.user_id,r.event_type,r.title,r.body,r.path,r.dedupe) ON CONFLICT(household_id,user_id,dedupe_key) DO NOTHING RETURNING id INTO v_event;
    IF v_event IS NULL THEN CONTINUE; END IF;
    INSERT INTO notification_deliveries(household_id,user_id,event_id,endpoint_id,channel) SELECT r.household_id,r.user_id,v_event,e.id,'push' FROM notification_endpoints e WHERE e.household_id=r.household_id AND e.user_id=r.user_id AND e.enabled AND r.push_enabled ON CONFLICT DO NOTHING;
    IF r.email_enabled AND r.email_verified_at IS NOT NULL AND r.email_suppressed_at IS NULL AND r.email_address IS NOT NULL THEN INSERT INTO notification_deliveries(household_id,user_id,event_id,channel,destination_hash) VALUES(r.household_id,r.user_id,v_event,'email',encode(digest(lower(r.email_address),'sha256'),'hex')) ON CONFLICT DO NOTHING; END IF;
    v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION refresh_financial_exceptions(p_household_id uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record; v_case uuid; v_count integer:=0; v_context uuid:=nullif(current_setting('app.household_id',true),'')::uuid;
BEGIN
  IF p_household_id IS NULL AND NOT pg_has_role(session_user,'budgefi_worker','MEMBER') THEN RAISE EXCEPTION 'worker capability required'; END IF;
  IF p_household_id IS NOT NULL AND v_context IS DISTINCT FROM p_household_id THEN RAISE EXCEPTION 'tenant context required'; END IF;
  FOR r IN
    WITH latest AS (
      SELECT DISTINCT ON (t.source_kind,t.source_record_id)
        t.id,t.household_id,t.account_id,t.source_kind,t.source_record_id,t.merchant,t.amount_minor,t.currency,t.occurred_on,t.status
      FROM financial_transactions t
      WHERE (p_household_id IS NULL OR t.household_id=p_household_id)
      ORDER BY t.source_kind,t.source_record_id,t.revision DESC
    )
    SELECT a.household_id,a.id AS first_id,b.id AS second_id,a.merchant,a.amount_minor,a.currency,
      'duplicate:'||encode(digest(least(a.source_kind||':'||a.source_record_id,b.source_kind||':'||b.source_record_id)||'|'||greatest(a.source_kind||':'||a.source_record_id,b.source_kind||':'||b.source_record_id),'sha256'),'hex') AS detection_key
    FROM latest a JOIN latest b ON b.household_id=a.household_id AND b.account_id=a.account_id
      AND (a.source_kind||':'||a.source_record_id)<(b.source_kind||':'||b.source_record_id)
      AND a.amount_minor=b.amount_minor
      AND lower(regexp_replace(trim(a.merchant),'\s+',' ','g'))=lower(regexp_replace(trim(b.merchant),'\s+',' ','g'))
      AND abs(a.occurred_on-b.occurred_on)<=2
    WHERE a.status IN ('pending','posted') AND b.status IN ('pending','posted')
      AND a.source_kind<>'sample' AND b.source_kind<>'sample'
  LOOP
    v_case:=null;
    INSERT INTO exception_cases(id,household_id,case_type,status,expected_amount_minor,observed_amount_minor,currency,title,version,detection_key)
    VALUES(gen_random_uuid(),r.household_id,'possible_duplicate','open',null,r.amount_minor,r.currency,left(r.merchant||' may be duplicated',200),1,r.detection_key)
    ON CONFLICT(household_id,detection_key) WHERE detection_key IS NOT NULL DO NOTHING RETURNING id INTO v_case;
    IF v_case IS NULL THEN CONTINUE; END IF;
    INSERT INTO case_evidence(household_id,case_id,evidence_type,source_entity_type,source_entity_id,summary)
    VALUES(r.household_id,v_case,'transaction','financial_transaction',r.first_id,'First matching charge'),
          (r.household_id,v_case,'transaction','financial_transaction',r.second_id,'Second matching charge');
    v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION schedule_plaid_maintenance()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_count integer:=0;
BEGIN
  UPDATE connections c
  SET status='stale',updated_at=now(),error_code='SYNC_STALE'
  WHERE c.provider='plaid' AND c.status='healthy'
    AND (c.last_successful_sync_at IS NULL OR c.last_successful_sync_at<now()-interval '36 hours');

  INSERT INTO plaid_sync_jobs(household_id,connection_id,operation,trigger,state,available_at)
  SELECT c.household_id,c.id,'sync','scheduled','queued',now()
  FROM connections c
  WHERE c.provider='plaid' AND c.status IN ('healthy','stale')
    AND (c.last_successful_sync_at IS NULL OR c.last_successful_sync_at<now()-interval '6 hours')
    AND c.revoked_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM plaid_sync_jobs j
      WHERE j.connection_id=c.id AND j.operation='sync' AND j.state IN ('queued','running')
    );
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION claim_notification_delivery(), finish_notification_delivery(uuid,text,text), claim_account_deletion(), finalize_account_deletion(uuid), register_notification_endpoint(uuid,text,text,bytea,text,text), disable_notification_endpoint(uuid,text), generate_notification_events(), refresh_financial_exceptions(uuid), schedule_plaid_maintenance() FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO budgefi_worker;
GRANT EXECUTE ON FUNCTION claim_notification_delivery(), finish_notification_delivery(uuid,text,text), claim_account_deletion(), finalize_account_deletion(uuid), disable_notification_endpoint(uuid,text), generate_notification_events(), refresh_financial_exceptions(uuid) TO budgefi_worker;
GRANT EXECUTE ON FUNCTION register_notification_endpoint(uuid,text,text,bytea,text,text) TO budgefi_app;
GRANT EXECUTE ON FUNCTION refresh_financial_exceptions(uuid) TO budgefi_app;
GRANT EXECUTE ON FUNCTION schedule_plaid_maintenance() TO budgefi_app;
