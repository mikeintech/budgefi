-- Make the application role sufficient for JIT provisioning and system work without
-- granting it direct access to global identity tables.
GRANT EXECUTE ON FUNCTION provision_principal(text, text, text) TO budgefi_app;

CREATE OR REPLACE FUNCTION resolve_system_household_actor(p_household_id uuid)
RETURNS TABLE(user_id uuid, membership_role text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT m.user_id, m.role
  FROM household_memberships m
  JOIN households h ON h.id = m.household_id
  WHERE m.household_id = p_household_id
    AND m.revoked_at IS NULL
    AND h.deleted_at IS NULL
  ORDER BY CASE WHEN m.role = 'owner' THEN 0 ELSE 1 END, m.created_at
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION resolve_system_household_actor(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_system_household_actor(uuid) TO budgefi_app;

-- A completed Link session must retain the canonical connection it created so a
-- replay can return the connection's real sync outcome instead of false success.
GRANT UPDATE (connection_id) ON plaid_link_sessions TO budgefi_app;

ALTER TABLE plaid_link_sessions DROP CONSTRAINT plaid_link_sessions_check;
ALTER TABLE plaid_link_sessions ADD CONSTRAINT plaid_link_sessions_connection_mode_check CHECK (
  (
    mode = 'create'
    AND (
      (status IN ('created', 'exchanging', 'failed', 'expired') AND connection_id IS NULL)
      OR (status = 'completed' AND connection_id IS NOT NULL)
    )
  )
  OR (mode = 'update' AND connection_id IS NOT NULL)
);

-- PostgreSQL's ON CONFLICT path requires read access to the conflict target.
-- Unknown webhook storage contains hashes and metadata only, never raw payloads.
GRANT SELECT ON plaid_unknown_webhooks TO budgefi_app;
