-- Migration statements run as the table owner, but Budgefi intentionally
-- FORCEs RLS even for that owner. Temporarily relax FORCE (RLS remains
-- enabled) inside this transaction so the one-time, cross-tenant cleanup can
-- see existing rows. The migration runner wraps this file in a transaction,
-- so FORCE RLS is restored atomically or the whole change rolls back.
ALTER TABLE exception_cases NO FORCE ROW LEVEL SECURITY;
ALTER TABLE case_evidence NO FORCE ROW LEVEL SECURITY;
ALTER TABLE financial_transactions NO FORCE ROW LEVEL SECURITY;

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

ALTER TABLE financial_transactions FORCE ROW LEVEL SECURITY;
ALTER TABLE case_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE exception_cases FORCE ROW LEVEL SECURITY;
