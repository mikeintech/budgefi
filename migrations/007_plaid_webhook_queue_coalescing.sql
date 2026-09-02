DROP INDEX IF EXISTS plaid_sync_jobs_one_active_per_connection;

CREATE INDEX plaid_sync_jobs_active_connection_idx
  ON plaid_sync_jobs (connection_id, operation, created_at)
  WHERE state IN ('queued', 'running');

ALTER TABLE plaid_link_sessions
  ADD COLUMN exchange_started_at timestamptz;

GRANT UPDATE (exchange_started_at) ON plaid_link_sessions TO budgefi_app;

CREATE UNIQUE INDEX financial_transactions_plaid_global_revision
  ON financial_transactions (household_id, source_record_id, revision)
  WHERE source_kind = 'plaid';
