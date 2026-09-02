import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./types.js";

const { Pool } = pg;

export function createDatabase(connectionString = runtimeDatabaseUrl()): Kysely<Database> {
  if (!connectionString) throw new Error("RUNTIME_DATABASE_URL or DATABASE_URL is required");
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString, max: Number(process.env.DB_POOL_SIZE ?? 10) }),
    }),
  });
}

function runtimeDatabaseUrl(): string | undefined {
  if (process.env.NODE_ENV === "production" && !process.env.RUNTIME_DATABASE_URL) throw new Error("Production requires a restricted RUNTIME_DATABASE_URL separate from the migration owner");
  if (process.env.NODE_ENV === "production" && process.env.DATABASE_URL && process.env.RUNTIME_DATABASE_URL === process.env.DATABASE_URL) throw new Error("RUNTIME_DATABASE_URL must not use the migration-owner credentials in production");
  return process.env.RUNTIME_DATABASE_URL ?? process.env.DATABASE_URL;
}

export * from "./types.js";
