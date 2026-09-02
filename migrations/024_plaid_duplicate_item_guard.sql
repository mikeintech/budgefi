-- A Plaid account_id belongs to one Item and can change when a user links the
-- same bank again. Keep a privacy-preserving, Item-independent fingerprint so
-- initial syncs can recognize an accidental retry before duplicating a ledger.
ALTER TABLE accounts
  ADD COLUMN provider_account_fingerprint text;

ALTER TABLE accounts
  ADD CONSTRAINT accounts_provider_fingerprint_format_check CHECK (
    provider_account_fingerprint IS NULL
    OR provider_account_fingerprint ~ '^[a-f0-9]{64}$'
  );

CREATE INDEX accounts_active_provider_fingerprint_idx
  ON accounts(household_id, provider_account_fingerprint)
  WHERE provenance = 'plaid'
    AND archived_at IS NULL
    AND provider_account_fingerprint IS NOT NULL;
