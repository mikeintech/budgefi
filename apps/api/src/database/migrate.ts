import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const migrationMaxName = process.env.MIGRATION_MAX_NAME?.trim();

const migrationsDirectory = fileURLToPath(
  new URL("../../../../migrations/", import.meta.url),
);
const client = new Client({ connectionString: databaseUrl });
await client.connect();

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const files = (await readdir(migrationsDirectory))
    .filter(
      (name) =>
        name.endsWith(".sql") &&
        (!migrationMaxName || name.localeCompare(migrationMaxName) <= 0),
    )
    .sort();
  for (const name of files) {
    const sql = await readFile(
      new URL(`../../../../migrations/${name}`, import.meta.url),
      "utf8",
    );
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existing = await client.query<{ checksum: string }>(
      "SELECT checksum FROM schema_migrations WHERE name = $1",
      [name],
    );
    if (existing.rowCount) {
      if (existing.rows[0]?.checksum !== checksum)
        throw new Error(`Applied migration changed: ${name}`);
      continue;
    }
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
        [name, checksum],
      );
      await client.query("COMMIT");
      process.stdout.write(`Applied ${name}\n`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.end();
}
