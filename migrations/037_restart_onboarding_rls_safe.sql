-- Migration 036 expressed the correct reset but production's migration owner
-- does not bypass FORCE RLS. Relax FORCE only for this migration transaction,
-- apply the reset across tenants, then restore the runtime boundary.
ALTER TABLE household_memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE households NO FORCE ROW LEVEL SECURITY;

UPDATE household_memberships
SET onboarding_completed_at = NULL
WHERE revoked_at IS NULL
  AND onboarding_completed_at IS NOT NULL;

UPDATE households household
SET data_revision = household.data_revision + 1
WHERE EXISTS (
  SELECT 1
  FROM household_memberships membership
  WHERE membership.household_id = household.id
    AND membership.revoked_at IS NULL
);

ALTER TABLE household_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE households FORCE ROW LEVEL SECURITY;
