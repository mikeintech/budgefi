CREATE TABLE financial_pattern_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id),
  input_fingerprint text NOT NULL CHECK (length(input_fingerprint) = 64),
  model text NOT NULL,
  prompt_version text NOT NULL,
  source text NOT NULL CHECK (source IN ('openai', 'deterministic', 'none')),
  state text NOT NULL CHECK (state IN ('ready', 'history_syncing', 'not_enough_history', 'unavailable')),
  transaction_count integer NOT NULL CHECK (transaction_count >= 0),
  candidate_count integer NOT NULL CHECK (candidate_count >= 0),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  UNIQUE (household_id, input_fingerprint, model, prompt_version)
);

CREATE INDEX financial_pattern_analyses_household_created_idx
  ON financial_pattern_analyses (household_id, created_at DESC);

ALTER TABLE financial_pattern_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_pattern_analyses FORCE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON financial_pattern_analyses
  USING (household_id = nullif(current_setting('app.household_id', true), '')::uuid)
  WITH CHECK (household_id = nullif(current_setting('app.household_id', true), '')::uuid);

GRANT SELECT, INSERT ON financial_pattern_analyses TO budgefi_app;

-- Keep analysis artifacts inside the existing verified deletion boundary.
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
  UPDATE users SET auth_subject='deleted|'||id::text, display_name='Deleted member', email=NULL, deleted_at=now() WHERE id=v_user;
  IF NOT EXISTS (SELECT 1 FROM household_memberships WHERE household_id=v_household AND revoked_at IS NULL) THEN UPDATE households SET deleted_at=now() WHERE id=v_household; END IF;
  UPDATE account_deletion_requests SET status='completed', completed_at=now(), updated_at=now(), last_error_code=NULL WHERE id=p_request_id;
END $$;

REVOKE ALL ON FUNCTION finalize_account_deletion(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finalize_account_deletion(uuid) TO budgefi_worker;
