ALTER TABLE plaid_link_sessions
  ADD COLUMN link_token_hash text;

CREATE UNIQUE INDEX plaid_link_sessions_link_token_hash_idx
  ON plaid_link_sessions (environment, link_token_hash)
  WHERE link_token_hash IS NOT NULL;

COMMENT ON COLUMN plaid_link_sessions.link_token_hash IS
  'SHA-256 binding for a client-returned Hosted Link token; raw Link tokens are never persisted.';
