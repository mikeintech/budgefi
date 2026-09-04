-- Stable setup identities survive user-facing renames. Explicit skips remain
-- distinguishable from synchronization supersession in bootstrap projections.

ALTER TABLE commitments
  ADD COLUMN setup_slot text,
  ADD CONSTRAINT commitments_setup_slot_valid CHECK (
    setup_slot IS NULL OR setup_slot IN ('housing','utilities','subscriptions','insurance')
  );

WITH candidates AS (
  SELECT id,
    CASE
      WHEN lower(name) = 'rent' THEN 'housing'
      WHEN lower(name) = 'electric' THEN 'utilities'
      WHEN lower(name) IN ('subscriptions','streambox') THEN 'subscriptions'
      WHEN lower(name) = 'insurance' THEN 'insurance'
    END AS setup_slot,
    row_number() OVER (
      PARTITION BY household_id,
        CASE
          WHEN lower(name) = 'rent' THEN 'housing'
          WHEN lower(name) = 'electric' THEN 'utilities'
          WHEN lower(name) IN ('subscriptions','streambox') THEN 'subscriptions'
          WHEN lower(name) = 'insurance' THEN 'insurance'
        END
      ORDER BY created_at, id
    ) AS slot_rank
  FROM commitments
  WHERE active AND settled_at IS NULL AND provenance = 'manual'
    AND lower(name) IN ('rent','electric','subscriptions','streambox','insurance')
)
UPDATE commitments commitment
SET setup_slot = candidate.setup_slot
FROM candidates candidate
WHERE commitment.id = candidate.id AND candidate.slot_rank = 1;

CREATE UNIQUE INDEX commitments_active_setup_slot_unique
  ON commitments(household_id, setup_slot)
  WHERE active AND settled_at IS NULL AND setup_slot IS NOT NULL;

ALTER TABLE commitment_revisions ADD COLUMN setup_slot text;

CREATE FUNCTION capture_commitment_revision_setup_slot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT commitment.setup_slot INTO NEW.setup_slot
  FROM commitments commitment
  WHERE commitment.household_id = NEW.household_id
    AND commitment.id = NEW.commitment_id;
  RETURN NEW;
END
$$;

CREATE TRIGGER commitment_revision_setup_slot
  BEFORE INSERT ON commitment_revisions
  FOR EACH ROW EXECUTE FUNCTION capture_commitment_revision_setup_slot();
