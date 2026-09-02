import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL?.trim();
const runtimePassword =
  process.env.RUNTIME_DATABASE_PASSWORD?.trim() ||
  databasePassword("RUNTIME_DATABASE_URL");
const workerPassword =
  process.env.WORKER_DATABASE_PASSWORD?.trim() ||
  databasePassword("WORKER_DATABASE_URL");
const plaidWorkerPassword =
  process.env.PLAID_WORKER_DATABASE_PASSWORD?.trim() ||
  databasePassword("PLAID_WORKER_DATABASE_URL");

if (!databaseUrl) throw new Error("DATABASE_URL is required");
assertPassword("RUNTIME_DATABASE_PASSWORD", runtimePassword);
assertPassword("WORKER_DATABASE_PASSWORD", workerPassword);
assertPassword("PLAID_WORKER_DATABASE_PASSWORD", plaidWorkerPassword);

const client = new Client({ connectionString: databaseUrl });
await client.connect();

try {
  await client.query("begin");
  await client.query(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'budgefi_runtime') then
        create role budgefi_runtime login nosuperuser nocreatedb nocreaterole nobypassrls noinherit;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'budgefi_worker_runtime') then
        create role budgefi_worker_runtime login nosuperuser nocreatedb nocreaterole nobypassrls noinherit;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'budgefi_plaid_worker_runtime') then
        create role budgefi_plaid_worker_runtime login nosuperuser nocreatedb nocreaterole nobypassrls noinherit;
      end if;
    end $$
  `);

  await setPassword("budgefi_runtime", runtimePassword!);
  await setPassword("budgefi_worker_runtime", workerPassword!);
  await setPassword("budgefi_plaid_worker_runtime", plaidWorkerPassword!);
  await client.query("grant budgefi_app to budgefi_runtime");
  await client.query("grant budgefi_worker to budgefi_worker_runtime");
  await client.query("grant budgefi_app, budgefi_plaid_worker to budgefi_plaid_worker_runtime");
  await client.query(`
    do $$ begin
      if pg_has_role('budgefi_runtime', 'budgefi_worker', 'MEMBER') then
        execute 'revoke budgefi_worker from budgefi_runtime';
      end if;
      if pg_has_role('budgefi_worker_runtime', 'budgefi_app', 'MEMBER') then
        execute 'revoke budgefi_app from budgefi_worker_runtime';
      end if;
      if pg_has_role('budgefi_runtime', 'budgefi_plaid_worker', 'MEMBER') then
        execute 'revoke budgefi_plaid_worker from budgefi_runtime';
      end if;
      if pg_has_role('budgefi_plaid_worker_runtime', 'budgefi_worker', 'MEMBER') then
        execute 'revoke budgefi_worker from budgefi_plaid_worker_runtime';
      end if;
    end $$
  `);
  await client.query("commit");
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  await client.end();
}

async function setPassword(
  role:
    | "budgefi_runtime"
    | "budgefi_worker_runtime"
    | "budgefi_plaid_worker_runtime",
  password: string,
): Promise<void> {
  const result = await client.query<{ literal: string }>(
    "select quote_literal($1) as literal",
    [password],
  );
  await client.query(`alter role ${role} password ${result.rows[0]!.literal}`);
}

function assertPassword(
  name: string,
  value: string | undefined,
): asserts value is string {
  if (!value || value.length < 32)
    throw new Error(`${name} must contain at least 32 characters`);
}

function databasePassword(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  try {
    const socketUrl = value.replace("@/", "@localhost/");
    const password = decodeURIComponent(new URL(socketUrl).password);
    return password || undefined;
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL`);
  }
}
