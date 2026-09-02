GRANT INSERT ON connections, accounts TO budgefi_app;
GRANT UPDATE (status, last_successful_sync_at, updated_at) ON connections TO budgefi_app;
GRANT UPDATE (archived_at, include_in_plan, connection_id, name, account_type) ON accounts TO budgefi_app;
