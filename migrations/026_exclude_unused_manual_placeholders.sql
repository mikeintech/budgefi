-- A connected plan must not be made incomplete by the empty manual fallback
-- created during account provisioning. Preserve every manual account that has
-- a real balance observation or transaction; only unused placeholders qualify.
WITH unused_manual AS (
  UPDATE accounts manual_account
  SET include_in_plan = false,
      version = manual_account.version + 1
  WHERE manual_account.provenance = 'manual'
    AND manual_account.include_in_plan = true
    AND manual_account.archived_at IS NULL
    AND manual_account.account_type IN ('cash', 'checking', 'savings')
    AND EXISTS (
      SELECT 1
      FROM accounts connected_account
      WHERE connected_account.household_id = manual_account.household_id
        AND connected_account.provenance = 'plaid'
        AND connected_account.include_in_plan = true
        AND connected_account.archived_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM balance_observations observation
      WHERE observation.household_id = manual_account.household_id
        AND observation.account_id = manual_account.id
        AND NOT (
          observation.provenance = 'manual'
          AND observation.source_record_id = 'provisioned'
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM financial_transactions entry
      WHERE entry.household_id = manual_account.household_id
        AND entry.account_id = manual_account.id
    )
  RETURNING manual_account.id, manual_account.household_id
), bumped_households AS (
  UPDATE households household
  SET data_revision = household.data_revision + 1
  FROM (SELECT DISTINCT household_id FROM unused_manual) affected
  WHERE household.id = affected.household_id
  RETURNING household.id
)
INSERT INTO activity_events (
  household_id, event_type, title, detail, provenance, entity_type, entity_id
)
SELECT
  unused_manual.household_id,
  'account.manual_placeholder.excluded',
  'Unused manual account excluded',
  'Connected balances now own plan coverage; no manual balance or activity was removed',
  'derived',
  'account',
  unused_manual.id
FROM unused_manual;
