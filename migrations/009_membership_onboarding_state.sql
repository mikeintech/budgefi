ALTER TABLE household_memberships
  ADD COLUMN onboarding_completed_at timestamptz;

-- This migration introduces first-login routing. Existing memberships predate
-- that flow and must not be mistaken for unfinished new accounts.
UPDATE household_memberships
SET onboarding_completed_at = created_at
WHERE onboarding_completed_at IS NULL;

GRANT UPDATE (onboarding_completed_at) ON household_memberships TO budgefi_app;
