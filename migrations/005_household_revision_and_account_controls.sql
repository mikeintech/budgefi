ALTER TABLE households
  ADD COLUMN data_revision bigint NOT NULL DEFAULT 1 CHECK (data_revision > 0);

GRANT UPDATE (data_revision) ON households TO budgefi_app;
GRANT UPDATE (include_in_plan, version) ON accounts TO budgefi_app;
GRANT UPDATE (name, amount_minor, due_date, active, settled_at, version, updated_at) ON commitments TO budgefi_app;
