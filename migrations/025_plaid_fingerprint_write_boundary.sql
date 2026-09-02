-- The runtime role intentionally has column-scoped UPDATE rights on accounts.
-- Permit only the new provider fingerprint column required during Plaid sync.
GRANT SELECT (provider_account_fingerprint),
      INSERT (provider_account_fingerprint),
      UPDATE (provider_account_fingerprint)
ON accounts TO budgefi_app;
