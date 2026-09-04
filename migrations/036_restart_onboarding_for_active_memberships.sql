-- Restart setup after the planning model rollout. This deliberately changes
-- only the onboarding gate. Existing financial data remains available to the
-- setup flow and is not rewritten or removed.
UPDATE household_memberships
SET onboarding_completed_at = NULL
WHERE revoked_at IS NULL
  AND onboarding_completed_at IS NOT NULL;

-- Onboarding drafts are bound to the household revision. Advancing every
-- active household invalidates any saved pre-rollout draft so each member
-- starts at the first step with current canonical data.
UPDATE households household
SET data_revision = household.data_revision + 1
WHERE EXISTS (
  SELECT 1
  FROM household_memberships membership
  WHERE membership.household_id = household.id
    AND membership.revoked_at IS NULL
);
