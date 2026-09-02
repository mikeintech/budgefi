CREATE OR REPLACE FUNCTION prune_financial_pattern_analyses()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_count integer := 0;
BEGIN
  DELETE FROM financial_pattern_analyses WHERE expires_at <= now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

REVOKE ALL ON FUNCTION prune_financial_pattern_analyses() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION prune_financial_pattern_analyses() TO budgefi_worker;
