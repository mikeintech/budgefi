-- Stable transaction identities separate changing source evidence from user
-- organization. A pending Plaid transaction and its posted replacement share
-- one entity; source revisions remain immutable financial evidence.

CREATE TABLE transaction_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  current_transaction_id uuid,
  current_occurred_on date,
  CHECK ((current_transaction_id IS NULL) = (current_occurred_on IS NULL)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id,id),
  UNIQUE (household_id,account_id,id),
  FOREIGN KEY (household_id,account_id) REFERENCES accounts(household_id,id) ON DELETE CASCADE
);

CREATE TABLE transaction_source_aliases (
  household_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  account_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('manual','csv','plaid','sample')),
  source_record_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id,account_id,source_kind,source_record_id),
  FOREIGN KEY (household_id,transaction_id)
    REFERENCES transaction_entities(household_id,id) ON DELETE CASCADE,
  FOREIGN KEY (household_id,account_id) REFERENCES accounts(household_id,id) ON DELETE CASCADE
);

ALTER TABLE financial_transactions ADD COLUMN transaction_id uuid;

-- Production migrations run as the table owner without BYPASSRLS. Temporarily
-- lift FORCE RLS inside this migration transaction so the owner can see and
-- backfill every household's historical evidence. Any failure rolls this
-- change back with the rest of the migration.
ALTER TABLE financial_transactions NO FORCE ROW LEVEL SECURITY;

-- Record exactly which verified occurrence caused a one-time rule settlement
-- or payday advance. Undo can then reverse only its own consequence and will
-- never overwrite a later user edit.
ALTER TABLE commitments
  ADD COLUMN settled_by_occurrence_id uuid,
  ADD CONSTRAINT commitments_settlement_lineage_fk
    FOREIGN KEY(household_id,settled_by_occurrence_id)
    REFERENCES plan_occurrences(household_id,id)
    ON DELETE SET NULL (settled_by_occurrence_id);
ALTER TABLE plans
  ADD COLUMN income_advanced_from_occurrence_id uuid,
  ADD COLUMN income_previous_expected_date date,
  ADD CONSTRAINT plans_income_advance_lineage_fk
    FOREIGN KEY(household_id,income_advanced_from_occurrence_id)
    REFERENCES plan_occurrences(household_id,id)
    ON DELETE SET NULL (income_advanced_from_occurrence_id);

-- Existing posted replacements carry the pending source id. Use that as the
-- grouping root so an upgrade does not expose two cards for the same purchase.
CREATE TEMP TABLE transaction_entity_backfill ON COMMIT DROP AS
SELECT gen_random_uuid() entity_id,household_id,account_id,source_kind,
  coalesce(pending_source_record_id,source_record_id) root_record_id,
  min(recorded_at) created_at
FROM financial_transactions
GROUP BY household_id,account_id,source_kind,
  coalesce(pending_source_record_id,source_record_id);

INSERT INTO transaction_entities(id,household_id,account_id,created_at,updated_at)
SELECT entity_id,household_id,account_id,created_at,now()
FROM transaction_entity_backfill;

UPDATE financial_transactions f SET transaction_id=b.entity_id
FROM transaction_entity_backfill b
WHERE b.household_id=f.household_id AND b.account_id=f.account_id
  AND b.source_kind=f.source_kind
  AND b.root_record_id=coalesce(f.pending_source_record_id,f.source_record_id);

INSERT INTO transaction_source_aliases(
  household_id,transaction_id,account_id,source_kind,source_record_id
)
SELECT f.household_id,(array_agg(f.transaction_id ORDER BY f.transaction_id))[1],f.account_id,f.source_kind,f.source_record_id
FROM financial_transactions f
GROUP BY f.household_id,f.account_id,f.source_kind,f.source_record_id;

ALTER TABLE financial_transactions ALTER COLUMN transaction_id SET NOT NULL;
ALTER TABLE financial_transactions ADD CONSTRAINT financial_transactions_entity_fk
  FOREIGN KEY (household_id,transaction_id)
  REFERENCES transaction_entities(household_id,id);
ALTER TABLE financial_transactions ADD CONSTRAINT financial_transactions_entity_account_fk
  FOREIGN KEY (household_id,account_id,transaction_id)
  REFERENCES transaction_entities(household_id,account_id,id);
ALTER TABLE transaction_source_aliases ADD CONSTRAINT transaction_aliases_entity_account_fk
  FOREIGN KEY (household_id,account_id,transaction_id)
  REFERENCES transaction_entities(household_id,account_id,id);
CREATE INDEX financial_transactions_entity_revision_idx
  ON financial_transactions(household_id,transaction_id,recorded_at DESC,id DESC);

-- Reversed or rejected evidence may be reconsidered later. Only an active
-- proposal/confirmation must be unique for a transaction/occurrence pair.
DROP INDEX occurrence_transaction_pair_unique;
CREATE UNIQUE INDEX occurrence_transaction_active_pair_unique
  ON occurrence_transaction_matches(household_id,occurrence_id,transaction_id)
  WHERE state IN ('proposed','confirmed');

-- Materialize the active evidence pointer once at ingestion time. Feed paging
-- can then use a true indexed keyset path instead of ranking all revisions.
WITH alias_latest AS (
  SELECT f.*,row_number() OVER (
    PARTITION BY f.household_id,f.account_id,f.source_kind,f.source_record_id
    ORDER BY f.revision DESC,f.recorded_at DESC,f.id DESC
  ) alias_rank
  FROM financial_transactions f
), active AS (
  SELECT f.*,row_number() OVER (
    PARTITION BY f.household_id,f.transaction_id
    ORDER BY (f.status='posted') DESC,f.source_updated_at DESC NULLS LAST,
      f.revision DESC,f.source_record_id DESC,f.id DESC
  ) entity_rank
  FROM alias_latest f
  WHERE f.alias_rank=1 AND f.status IN ('posted','pending')
)
UPDATE transaction_entities e SET
  current_transaction_id=a.id,
  current_occurred_on=a.occurred_on
FROM active a
WHERE a.entity_rank=1 AND a.household_id=e.household_id AND a.transaction_id=e.id;

ALTER TABLE financial_transactions ADD CONSTRAINT financial_transactions_entity_evidence_unique
  UNIQUE(household_id,account_id,transaction_id,id);
ALTER TABLE transaction_entities ADD CONSTRAINT transaction_entities_current_evidence_fk
  FOREIGN KEY(household_id,account_id,id,current_transaction_id)
  REFERENCES financial_transactions(household_id,account_id,transaction_id,id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE financial_transactions
  ADD COLUMN provider_category_primary text,
  ADD COLUMN provider_category_detailed text;

CREATE TABLE transaction_category_assignments (
  household_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN (
    'income','housing','utilities','groceries','dining','transportation',
    'shopping','health','insurance','debt','subscriptions','fees',
    'entertainment','education','giving','taxes','savings_investments',
    'transfer','cash_atm','other','uncategorized'
  )),
  source text NOT NULL CHECK (source IN ('provider','deterministic','merchant_rule','user')),
  confidence text NOT NULL CHECK (confidence IN ('high','medium','low')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  actor_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id,transaction_id),
  FOREIGN KEY (household_id,transaction_id)
    REFERENCES transaction_entities(household_id,id) ON DELETE CASCADE
);

CREATE TABLE transaction_category_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN (
    'income','housing','utilities','groceries','dining','transportation',
    'shopping','health','insurance','debt','subscriptions','fees',
    'entertainment','education','giving','taxes','savings_investments',
    'transfer','cash_atm','other','uncategorized'
  )),
  source text NOT NULL CHECK (source IN ('provider','deterministic','merchant_rule','user')),
  confidence text NOT NULL CHECK (confidence IN ('high','medium','low')),
  version integer NOT NULL CHECK (version > 0),
  actor_user_id uuid REFERENCES users(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,transaction_id,version),
  FOREIGN KEY (household_id,transaction_id)
    REFERENCES transaction_entities(household_id,id) ON DELETE CASCADE
);

CREATE TABLE merchant_category_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  normalized_merchant text NOT NULL CHECK (length(normalized_merchant) BETWEEN 1 AND 160),
  category text NOT NULL CHECK (category IN (
    'income','housing','utilities','groceries','dining','transportation',
    'shopping','health','insurance','debt','subscriptions','fees',
    'entertainment','education','giving','taxes','savings_investments',
    'transfer','cash_atm','other','uncategorized'
  )),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE(household_id,normalized_merchant)
);

-- Existing evidence gets a conservative deterministic category. Incoming money
-- is useful immediately; outgoing money stays uncategorized until provider
-- evidence, a deterministic mapping, a rule, or the user says otherwise.
INSERT INTO transaction_category_assignments(
  household_id,transaction_id,category,source,confidence
)
SELECT e.household_id,e.id,
  CASE WHEN latest.direction='credit' THEN 'income' ELSE 'uncategorized' END,
  'deterministic',CASE WHEN latest.direction='credit' THEN 'medium' ELSE 'low' END
FROM transaction_entities e
JOIN LATERAL (
  SELECT direction FROM financial_transactions f
  WHERE f.household_id=e.household_id AND f.transaction_id=e.id
  ORDER BY recorded_at DESC,id DESC LIMIT 1
) latest ON true;

INSERT INTO transaction_category_revisions(
  household_id,transaction_id,category,source,confidence,version,reason
)
SELECT household_id,transaction_id,category,source,confidence,version,'Initial category backfill'
FROM transaction_category_assignments;

ALTER TABLE financial_transactions FORCE ROW LEVEL SECURITY;

CREATE TRIGGER transaction_category_revisions_append_only
  BEFORE UPDATE OR DELETE ON transaction_category_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- Preserve the established ingestion contract for imports and maintenance
-- code that inserts source evidence directly. New application paths resolve
-- aliases explicitly, while this trigger safely provisions a fresh identity.
CREATE FUNCTION provision_transaction_entity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_category text;
BEGIN
  -- Explicit application ingestion owns alias/version concurrency. This
  -- fallback completes the lifecycle only for legacy direct inserts.
  IF NEW.transaction_id IS NOT NULL THEN RETURN NEW; END IF;
  SELECT a.transaction_id INTO NEW.transaction_id
  FROM transaction_source_aliases a
  WHERE a.household_id=NEW.household_id AND a.account_id=NEW.account_id
    AND a.source_kind=NEW.source_kind
    AND a.source_record_id IN (NEW.source_record_id,coalesce(NEW.pending_source_record_id,NEW.source_record_id))
  ORDER BY (a.source_record_id=NEW.source_record_id) DESC LIMIT 1;
  IF NEW.transaction_id IS NOT NULL THEN
    INSERT INTO transaction_source_aliases(household_id,transaction_id,account_id,source_kind,source_record_id)
    VALUES(NEW.household_id,NEW.transaction_id,NEW.account_id,NEW.source_kind,NEW.source_record_id)
    ON CONFLICT DO NOTHING;
    UPDATE transaction_entities SET version=version+1,updated_at=now()
    WHERE household_id=NEW.household_id AND id=NEW.transaction_id;
    RETURN NEW;
  END IF;
  INSERT INTO transaction_entities(household_id,account_id)
  VALUES(NEW.household_id,NEW.account_id) RETURNING id INTO NEW.transaction_id;
  INSERT INTO transaction_source_aliases(household_id,transaction_id,account_id,source_kind,source_record_id)
  VALUES(NEW.household_id,NEW.transaction_id,NEW.account_id,NEW.source_kind,NEW.source_record_id);
  v_category:=CASE WHEN NEW.direction='credit' THEN 'income' ELSE 'uncategorized' END;
  INSERT INTO transaction_category_assignments(household_id,transaction_id,category,source,confidence)
  VALUES(NEW.household_id,NEW.transaction_id,v_category,'deterministic',CASE WHEN NEW.direction='credit' THEN 'medium' ELSE 'low' END);
  INSERT INTO transaction_category_revisions(household_id,transaction_id,category,source,confidence,version,reason)
  VALUES(NEW.household_id,NEW.transaction_id,v_category,'deterministic',CASE WHEN NEW.direction='credit' THEN 'medium' ELSE 'low' END,1,'Identity provisioned for source evidence');
  RETURN NEW;
END $$;
CREATE TRIGGER financial_transactions_provision_entity
  BEFORE INSERT ON financial_transactions FOR EACH ROW
  EXECUTE FUNCTION provision_transaction_entity();

CREATE FUNCTION refresh_transaction_current_state() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  WITH alias_latest AS (
    SELECT f.*,row_number() OVER (
      PARTITION BY f.household_id,f.account_id,f.source_kind,f.source_record_id
      ORDER BY f.revision DESC,f.recorded_at DESC,f.id DESC
    ) alias_rank
    FROM financial_transactions f
    WHERE f.household_id=NEW.household_id AND f.transaction_id=NEW.transaction_id
  ), active AS (
    SELECT f.* FROM alias_latest f
    WHERE f.alias_rank=1 AND f.status IN ('posted','pending')
    ORDER BY (f.status='posted') DESC,f.source_updated_at DESC NULLS LAST,
      f.revision DESC,f.source_record_id DESC,f.id DESC
    LIMIT 1
  )
  UPDATE transaction_entities e SET
    current_transaction_id=a.id,
    current_occurred_on=a.occurred_on
  FROM (SELECT 1) marker
  LEFT JOIN active a ON true
  WHERE e.household_id=NEW.household_id AND e.id=NEW.transaction_id;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_transactions_refresh_current
  AFTER INSERT ON financial_transactions FOR EACH ROW
  EXECUTE FUNCTION refresh_transaction_current_state();
REVOKE ALL ON FUNCTION refresh_transaction_current_state() FROM PUBLIC;

CREATE INDEX transaction_entities_feed_idx
  ON transaction_entities(household_id,current_occurred_on DESC,id DESC)
  WHERE current_transaction_id IS NOT NULL;
CREATE INDEX transaction_entities_account_history_idx
  ON transaction_entities(household_id,account_id)
  WHERE current_transaction_id IS NOT NULL;
CREATE INDEX transaction_categories_filter_idx
  ON transaction_category_assignments(household_id,category,transaction_id);
CREATE INDEX merchant_category_rules_lookup_idx
  ON merchant_category_rules(household_id,normalized_merchant);

ALTER TABLE transaction_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_entities FORCE ROW LEVEL SECURITY;
ALTER TABLE transaction_source_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_source_aliases FORCE ROW LEVEL SECURITY;
ALTER TABLE transaction_category_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_category_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE transaction_category_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_category_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE merchant_category_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_category_rules FORCE ROW LEVEL SECURITY;

CREATE POLICY household_isolation ON transaction_entities
  USING (household_id=nullif(current_setting('app.household_id',true),'')::uuid)
  WITH CHECK (household_id=nullif(current_setting('app.household_id',true),'')::uuid);
CREATE POLICY household_isolation ON transaction_source_aliases
  USING (household_id=nullif(current_setting('app.household_id',true),'')::uuid)
  WITH CHECK (household_id=nullif(current_setting('app.household_id',true),'')::uuid);
CREATE POLICY household_isolation ON transaction_category_assignments
  USING (household_id=nullif(current_setting('app.household_id',true),'')::uuid)
  WITH CHECK (household_id=nullif(current_setting('app.household_id',true),'')::uuid);
CREATE POLICY household_isolation ON transaction_category_revisions
  USING (household_id=nullif(current_setting('app.household_id',true),'')::uuid)
  WITH CHECK (household_id=nullif(current_setting('app.household_id',true),'')::uuid);
CREATE POLICY household_isolation ON merchant_category_rules
  USING (household_id=nullif(current_setting('app.household_id',true),'')::uuid)
  WITH CHECK (household_id=nullif(current_setting('app.household_id',true),'')::uuid);

GRANT SELECT,INSERT ON transaction_entities,transaction_source_aliases,
  transaction_category_assignments,transaction_category_revisions,
  merchant_category_rules TO budgefi_app;
GRANT UPDATE(version,updated_at) ON transaction_entities TO budgefi_app;
GRANT UPDATE(category,source,confidence,version,actor_user_id,updated_at)
  ON transaction_category_assignments TO budgefi_app;
GRANT UPDATE(category,version,actor_user_id,updated_at,archived_at)
  ON merchant_category_rules TO budgefi_app;
GRANT UPDATE(state,amount_applied_minor,confidence,reason,version,actor_user_id,
  resolved_at,reflected_in_balance_observation_id)
  ON occurrence_transaction_matches TO budgefi_app;
GRANT UPDATE(settled_at,settled_by_occurrence_id,version,updated_at)
  ON commitments TO budgefi_app;
GRANT UPDATE(next_income_date,income_confirmed,income_advanced_from_occurrence_id,
  income_previous_expected_date,version,updated_at) ON plans TO budgefi_app;

GRANT SELECT,INSERT ON transaction_entities,transaction_source_aliases,
  transaction_category_assignments,transaction_category_revisions
  TO budgefi_plaid_worker;
GRANT UPDATE(version,updated_at) ON transaction_entities TO budgefi_plaid_worker;

GRANT INSERT(transaction_id,provider_category_primary,provider_category_detailed)
  ON financial_transactions TO budgefi_app;
GRANT INSERT(transaction_id,provider_category_primary,provider_category_detailed)
  ON financial_transactions TO budgefi_plaid_worker;

-- A final account deletion soft-deletes the household rather than deleting its
-- row. Remove household-level categorization preferences at that boundary;
-- successor households keep their shared rules.
CREATE FUNCTION purge_transaction_preferences_after_final_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status='completed' AND OLD.status IS DISTINCT FROM 'completed'
    AND EXISTS (
      SELECT 1 FROM households h
      WHERE h.id=NEW.household_id AND h.deleted_at IS NOT NULL
    )
  THEN
    DELETE FROM merchant_category_rules
    WHERE household_id=NEW.household_id;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION purge_transaction_preferences_after_final_deletion() FROM PUBLIC;
CREATE TRIGGER account_deletion_purge_transaction_preferences
  AFTER UPDATE OF status ON account_deletion_requests
  FOR EACH ROW EXECUTE FUNCTION purge_transaction_preferences_after_final_deletion();
