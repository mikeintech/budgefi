-- Separate provider-wide work from the request-serving role, make active
-- Plaid work a database invariant, and close account-deletion/link races.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='budgefi_plaid_worker') THEN
    CREATE ROLE budgefi_plaid_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

ALTER TABLE households
  ADD COLUMN lifecycle_state text NOT NULL DEFAULT 'active'
  CHECK (lifecycle_state IN ('active','deleting'));
GRANT UPDATE(lifecycle_state) ON households TO budgefi_app;

-- Migration 007 intentionally allowed webhook-specific duplicates. That
-- check-then-insert design is unsafe under concurrency. Coalesce all active
-- work for the same Item/operation instead.
WITH duplicate_active AS (
  SELECT id, row_number() OVER (
    PARTITION BY connection_id,operation
    ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END,created_at,id
  ) AS keep_rank
  FROM plaid_sync_jobs
  WHERE state IN ('queued','running')
)
UPDATE plaid_sync_jobs j
SET state='dead',completed_at=now(),locked_at=NULL,last_error_code='COALESCED_BY_MIGRATION'
FROM duplicate_active d
WHERE j.id=d.id AND d.keep_rank>1;

DROP INDEX IF EXISTS plaid_sync_jobs_active_connection_idx;
CREATE UNIQUE INDEX plaid_sync_jobs_one_active_per_connection
  ON plaid_sync_jobs(connection_id,operation)
  WHERE state IN ('queued','running');

CREATE INDEX financial_transactions_latest_lookup_idx
  ON financial_transactions(household_id,account_id,source_kind,source_record_id,revision DESC)
  INCLUDE(id,merchant,amount_minor,currency,occurred_on,status,direction,pending_source_record_id);

CREATE INDEX exception_cases_active_household_idx
  ON exception_cases(household_id,updated_at DESC)
  WHERE status IN ('open','decided','awaiting_verification');

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
  FROM connections c JOIN households h ON h.id=c.household_id
  WHERE h.lifecycle_state='active'
    AND c.provider='plaid' AND c.status IN ('healthy','stale')
    AND (c.last_successful_sync_at IS NULL OR c.last_successful_sync_at<now()-interval '6 hours')
    AND c.revoked_at IS NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count;
END $$;

-- The API may record a verified provider event, but it never receives a
-- household id or tenant authority. The definer function performs only a
-- fixed, auditable state transition for an existing provider Item.
CREATE OR REPLACE FUNCTION ingest_verified_plaid_webhook(
  p_item_id text,p_environment text,p_event_type text,p_event_code text,
  p_payload_hash text,p_key_id text,p_issued_at timestamptz,p_error_code text
)
RETURNS TABLE(known boolean,duplicate boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_connection connections%ROWTYPE;
  v_receipt uuid;
  v_inserted integer:=0;
BEGIN
  SELECT * INTO v_connection
  FROM connections c
  WHERE c.provider='plaid' AND c.provider_item_id=p_item_id
    AND c.environment=p_environment AND c.status<>'revoked'
  LIMIT 1 FOR UPDATE;

  IF v_connection.id IS NULL THEN
    INSERT INTO plaid_unknown_webhooks(provider,provider_item_id,environment,event_type,event_code,payload_hash,verification_key_id)
    VALUES('plaid',p_item_id,p_environment,p_event_type,p_event_code,p_payload_hash,p_key_id)
    ON CONFLICT(payload_hash) DO NOTHING;
    RETURN QUERY SELECT false,false;
    RETURN;
  END IF;

  IF EXISTS(SELECT 1 FROM webhook_receipts WHERE provider='plaid' AND provider_event_key=p_payload_hash) THEN
    RETURN QUERY SELECT true,true;
    RETURN;
  END IF;

  INSERT INTO webhook_receipts(
    provider,provider_event_key,connection_id,household_id,payload_hash,event_type,
    environment,event_code,provider_item_id,verification_key_id,signature_issued_at,
    processing_status,error_code,processed_at
  ) VALUES(
    'plaid',p_payload_hash,v_connection.id,v_connection.household_id,p_payload_hash,p_event_type,
    p_environment,p_event_code,p_item_id,p_key_id,p_issued_at,'queued',NULL,NULL
  ) ON CONFLICT(provider,provider_event_key) DO NOTHING
    RETURNING id INTO v_receipt;
  IF v_receipt IS NULL THEN
    RETURN QUERY SELECT true,true;
    RETURN;
  END IF;

  IF p_event_type='ITEM' AND p_event_code='USER_PERMISSION_REVOKED' THEN
    UPDATE connections SET status='revocation_pending',error_code=NULL,updated_at=now()
    WHERE id=v_connection.id;
    UPDATE accounts SET include_in_plan=false,version=version+1
    WHERE household_id=v_connection.household_id AND connection_id=v_connection.id AND archived_at IS NULL;
    UPDATE households SET data_revision=data_revision+1 WHERE id=v_connection.household_id;
    INSERT INTO plaid_sync_jobs(household_id,connection_id,webhook_receipt_id,operation,trigger,state,available_at)
    VALUES(v_connection.household_id,v_connection.id,v_receipt,'revoke','webhook','queued',now())
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_inserted=ROW_COUNT;
  ELSIF p_event_type='ITEM' AND p_event_code='NEW_ACCOUNTS_AVAILABLE' THEN
    UPDATE connections SET status='login_required',error_code=p_event_code,updated_at=now() WHERE id=v_connection.id;
    UPDATE webhook_receipts SET processing_status='processed',processed_at=now() WHERE id=v_receipt;
    RETURN QUERY SELECT true,false; RETURN;
  ELSIF p_event_type='ITEM' AND p_event_code IN ('ERROR','PENDING_DISCONNECT','PENDING_EXPIRATION') THEN
    UPDATE connections SET
      status=CASE WHEN p_error_code='ITEM_LOGIN_REQUIRED' OR p_event_code<>'ERROR' THEN 'login_required' ELSE 'error' END,
      error_code=coalesce(p_error_code,p_event_code),updated_at=now()
    WHERE id=v_connection.id;
    UPDATE webhook_receipts SET processing_status='processed',processed_at=now() WHERE id=v_receipt;
    RETURN QUERY SELECT true,false; RETURN;
  ELSIF (p_event_type='ITEM' AND p_event_code='LOGIN_REPAIRED')
     OR (p_event_type='TRANSACTIONS' AND p_event_code='SYNC_UPDATES_AVAILABLE')
     OR p_event_code='USER_ACCOUNT_REVOKED' THEN
    UPDATE connections SET status='syncing',error_code=NULL,updated_at=now()
    WHERE id=v_connection.id AND status NOT IN ('revoked','revocation_pending');
    INSERT INTO plaid_sync_jobs(household_id,connection_id,webhook_receipt_id,operation,trigger,state,available_at)
    VALUES(v_connection.household_id,v_connection.id,v_receipt,'sync','webhook','queued',now())
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_inserted=ROW_COUNT;
  ELSE
    UPDATE webhook_receipts SET processing_status='ignored',processed_at=now() WHERE id=v_receipt;
    RETURN QUERY SELECT true,false; RETURN;
  END IF;

  IF v_inserted=0 THEN
    UPDATE webhook_receipts SET processing_status='processed',processed_at=now(),error_code='COALESCED'
    WHERE id=v_receipt;
  END IF;
  RETURN QUERY SELECT true,false;
END $$;

-- Finalization is defensive even though lifecycle_state prevents new links.
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

REVOKE ALL ON FUNCTION claim_plaid_sync_job(uuid) FROM budgefi_app;
REVOKE ALL ON FUNCTION schedule_plaid_maintenance() FROM budgefi_app;
REVOKE ALL ON FUNCTION resolve_system_household_actor(uuid) FROM budgefi_app;
REVOKE ALL ON FUNCTION resolve_plaid_webhook_connection(text,text) FROM budgefi_app;
REVOKE ALL ON FUNCTION ingest_verified_plaid_webhook(text,text,text,text,text,text,timestamptz,text) FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO budgefi_plaid_worker;
GRANT EXECUTE ON FUNCTION claim_plaid_sync_job(uuid),schedule_plaid_maintenance(),resolve_system_household_actor(uuid) TO budgefi_plaid_worker;
GRANT EXECUTE ON FUNCTION ingest_verified_plaid_webhook(text,text,text,text,text,text,timestamptz,text) TO budgefi_app;
