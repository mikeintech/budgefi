-- Savings round-ups and a pending transaction's posted replacement are not
-- actionable duplicate charges. Expire existing false positives and prevent
-- them from being recreated.
UPDATE exception_cases c
SET status='expired', version=version+1, updated_at=now()
WHERE c.case_type='possible_duplicate'
  AND c.status IN ('open','decided','awaiting_verification')
  AND (
    EXISTS (
      SELECT 1 FROM case_evidence e
      WHERE e.household_id=c.household_id AND e.case_id=c.id
        AND lower(coalesce(e.merchant_snapshot,'')) ~
          '(acorns|round[ -]?up(s)?( to)? savings|savings transfer|transfer to savings|betterment|wealthfront|vanguard|fidelity|robinhood|schwab)'
    )
    OR EXISTS (
      SELECT 1
      FROM case_evidence e1
      JOIN case_evidence e2 ON e2.household_id=e1.household_id
        AND e2.case_id=e1.case_id AND e2.id<>e1.id
      JOIN financial_transactions t1 ON t1.household_id=e1.household_id
        AND t1.id=e1.source_entity_id
      JOIN financial_transactions t2 ON t2.household_id=e2.household_id
        AND t2.id=e2.source_entity_id
      WHERE e1.household_id=c.household_id AND e1.case_id=c.id
        AND (
          t1.pending_source_record_id=t2.source_record_id
          OR t2.pending_source_record_id=t1.source_record_id
        )
    )
  );

CREATE OR REPLACE FUNCTION refresh_financial_exceptions(p_household_id uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record; v_case uuid; v_count integer:=0; v_context uuid:=nullif(current_setting('app.household_id',true),'')::uuid;
BEGIN
  IF p_household_id IS NULL AND NOT pg_has_role(session_user,'budgefi_worker','MEMBER') THEN RAISE EXCEPTION 'worker capability required'; END IF;
  IF p_household_id IS NOT NULL AND v_context IS DISTINCT FROM p_household_id THEN RAISE EXCEPTION 'tenant context required'; END IF;
  FOR r IN
    WITH latest AS (
      SELECT DISTINCT ON (t.source_kind,t.source_record_id)
        t.id,t.household_id,t.account_id,t.source_kind,t.source_record_id,
        t.pending_source_record_id,t.merchant,t.amount_minor,t.currency,
        t.occurred_on,t.status
      FROM financial_transactions t
      WHERE (p_household_id IS NULL OR t.household_id=p_household_id)
      ORDER BY t.source_kind,t.source_record_id,t.revision DESC
    )
    SELECT a.household_id,
      a.id AS first_id,a.merchant AS first_merchant,a.amount_minor AS first_amount_minor,
      a.currency AS first_currency,a.occurred_on AS first_occurred_on,a.status AS first_status,
      a.source_kind AS first_provenance,
      b.id AS second_id,b.merchant AS second_merchant,b.amount_minor AS second_amount_minor,
      b.currency AS second_currency,b.occurred_on AS second_occurred_on,b.status AS second_status,
      b.source_kind AS second_provenance,
      a.account_id,acct.name AS account_name,
      'duplicate:'||encode(digest(least(a.source_kind||':'||a.source_record_id,b.source_kind||':'||b.source_record_id)||'|'||greatest(a.source_kind||':'||a.source_record_id,b.source_kind||':'||b.source_record_id),'sha256'),'hex') AS detection_key
    FROM latest a
    JOIN latest b ON b.household_id=a.household_id AND b.account_id=a.account_id
      AND (a.source_kind||':'||a.source_record_id)<(b.source_kind||':'||b.source_record_id)
      AND a.amount_minor=b.amount_minor
      AND lower(regexp_replace(trim(a.merchant),'\s+',' ','g'))=lower(regexp_replace(trim(b.merchant),'\s+',' ','g'))
      AND abs(a.occurred_on-b.occurred_on)<=2
      AND coalesce(a.pending_source_record_id,'')<>b.source_record_id
      AND coalesce(b.pending_source_record_id,'')<>a.source_record_id
    JOIN accounts acct ON acct.household_id=a.household_id AND acct.id=a.account_id
    WHERE a.status IN ('pending','posted') AND b.status IN ('pending','posted')
      AND a.source_kind<>'sample' AND b.source_kind<>'sample'
      AND lower(a.merchant) !~
        '(acorns|round[ -]?up(s)?( to)? savings|savings transfer|transfer to savings|betterment|wealthfront|vanguard|fidelity|robinhood|schwab)'
  LOOP
    v_case:=null;
    INSERT INTO exception_cases(id,household_id,case_type,status,expected_amount_minor,observed_amount_minor,currency,title,version,detection_key)
    VALUES(gen_random_uuid(),r.household_id,'possible_duplicate','open',null,r.first_amount_minor,r.first_currency,left(r.first_merchant||' may be duplicated',200),1,r.detection_key)
    ON CONFLICT(household_id,detection_key) WHERE detection_key IS NOT NULL DO NOTHING RETURNING id INTO v_case;
    IF v_case IS NULL THEN CONTINUE; END IF;
    INSERT INTO case_evidence(
      household_id,case_id,evidence_type,source_entity_type,source_entity_id,summary,
      merchant_snapshot,amount_minor_snapshot,currency_snapshot,occurred_on_snapshot,
      account_id_snapshot,account_name_snapshot,status_snapshot,provenance_snapshot
    ) VALUES
      (r.household_id,v_case,'transaction','financial_transaction',r.first_id,'First matching charge',
       r.first_merchant,r.first_amount_minor,r.first_currency,r.first_occurred_on,
       r.account_id,r.account_name,r.first_status,r.first_provenance),
      (r.household_id,v_case,'transaction','financial_transaction',r.second_id,'Second matching charge',
       r.second_merchant,r.second_amount_minor,r.second_currency,r.second_occurred_on,
       r.account_id,r.account_name,r.second_status,r.second_provenance);
    v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION refresh_financial_exceptions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_financial_exceptions(uuid) TO budgefi_app, budgefi_worker;
