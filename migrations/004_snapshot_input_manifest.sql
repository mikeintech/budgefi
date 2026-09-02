ALTER TABLE calculation_snapshots
  ADD CONSTRAINT calculation_snapshots_household_id_id_unique UNIQUE (household_id, id);

CREATE TABLE calculation_snapshot_inputs (
  household_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  input_kind text NOT NULL CHECK (input_kind IN ('plan_revision', 'balance_observation', 'commitment_revision')),
  input_id uuid NOT NULL,
  input_version integer,
  input_hash text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (household_id, snapshot_id, input_kind, input_id),
  UNIQUE (household_id, snapshot_id, ordinal),
  FOREIGN KEY (household_id, snapshot_id) REFERENCES calculation_snapshots(household_id, id)
);

CREATE TRIGGER calculation_snapshot_inputs_append_only
  BEFORE UPDATE OR DELETE ON calculation_snapshot_inputs
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

ALTER TABLE calculation_snapshot_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE calculation_snapshot_inputs FORCE ROW LEVEL SECURITY;
CREATE POLICY household_isolation ON calculation_snapshot_inputs
  USING (household_id = nullif(current_setting('app.household_id', true), '')::uuid)
  WITH CHECK (household_id = nullif(current_setting('app.household_id', true), '')::uuid);

GRANT SELECT, INSERT ON calculation_snapshot_inputs TO budgefi_app;
