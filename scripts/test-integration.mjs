import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import net from "node:net";
import pg from "pg";

const candidates = [
  process.env.POSTGRES_BIN,
  "/opt/homebrew/opt/postgresql@17/bin",
  "/usr/local/opt/postgresql@17/bin",
  "/usr/lib/postgresql/17/bin",
  "/Library/PostgreSQL/17/bin",
].filter(Boolean);
const bin = candidates.find((candidate) =>
  existsSync(join(candidate, "initdb")),
);
const externalDatabaseUrl = process.env.INTEGRATION_DATABASE_URL?.trim();
if (!externalDatabaseUrl && !bin)
  throw new Error(
    "PostgreSQL 17 binaries not found. Set POSTGRES_BIN or INTEGRATION_DATABASE_URL.",
  );

const directory = externalDatabaseUrl
  ? null
  : await mkdtemp(join(tmpdir(), "budgefi-pg17-test-"));
const port = externalDatabaseUrl ? null : await freePort();
const databaseUrl =
  externalDatabaseUrl ?? `postgresql://postgres@127.0.0.1:${port}/budgefi_test`;
let started = false;

try {
  if (externalDatabaseUrl) {
    await resetExternalDatabase(databaseUrl);
  } else {
    run(join(bin, "initdb"), [
      "-A",
      "trust",
      "-U",
      "postgres",
      "-D",
      directory,
    ]);
    run(join(bin, "pg_ctl"), [
      "-D",
      directory,
      "-o",
      `-h 127.0.0.1 -p ${port} -F`,
      "-w",
      "start",
    ]);
    started = true;
    run(join(bin, "createdb"), [
      "-h",
      "127.0.0.1",
      "-p",
      String(port),
      "-U",
      "postgres",
      "budgefi_test",
    ]);
  }
  run("npm", ["run", "db:migrate"], {
    DATABASE_URL: databaseUrl,
    MIGRATION_MAX_NAME: "021_plaid_worker_and_deletion_boundaries.sql",
  });
  await seedLegacySampleMigrationFixtures(databaseUrl);
  run("npm", ["run", "db:migrate"], { DATABASE_URL: databaseUrl });
  const runtimeUrl = new URL(databaseUrl);
  runtimeUrl.username = "budgefi_runtime";
  runtimeUrl.password = "integration-runtime-password-000000000001";
  const workerUrl = new URL(databaseUrl);
  workerUrl.username = "budgefi_worker_runtime";
  workerUrl.password = "integration-worker-password-0000000000002";
  const plaidWorkerUrl = new URL(databaseUrl);
  plaidWorkerUrl.username = "budgefi_plaid_worker_runtime";
  plaidWorkerUrl.password = "integration-plaid-worker-password-0000000003";
  run("npm", ["run", "db:bootstrap-runtime-roles"], {
    DATABASE_URL: databaseUrl,
    RUNTIME_DATABASE_URL: runtimeUrl.toString(),
    WORKER_DATABASE_URL: workerUrl.toString(),
    PLAID_WORKER_DATABASE_URL: plaidWorkerUrl.toString(),
  });
  run("npm", ["run", "db:seed"], { DATABASE_URL: databaseUrl });
  run("npm", ["run", "start:worker:once"], {
    NODE_ENV: "production",
    WORKER_DATABASE_URL: workerUrl.toString(),
    NOTIFICATION_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString("base64"),
    NOTIFICATION_TOKEN_KEY_ID: "integration-notifications-v1",
    WORKER_JOB_MAX_ITEMS: "10",
    WORKER_JOB_MAX_RUNTIME_MS: "10000",
  });
  run("npm", ["run", "start:plaid-worker"], {
    NODE_ENV: "production",
    ALLOW_DEV_AUTH: "false",
    PLAID_WORKER_DATABASE_URL: plaidWorkerUrl.toString(),
    PLAID_ENABLED: "true",
    PLAID_ENV: "production",
    PLAID_CLIENT_ID: "ci-client",
    PLAID_SECRET: "ci-secret",
    PLAID_ACTIVE_TOKEN_KEY_ID: "ci-v1",
    PLAID_TOKEN_KEYS: JSON.stringify({
      "ci-v1": Buffer.alloc(32, 13).toString("base64"),
    }),
    PLAID_JOB_MAX_ITEMS: "10",
    PLAID_JOB_MAX_RUNTIME_MS: "10000",
  });
  run("npx", ["vitest", "run", "test/migration.integration.test.ts"], {
    TEST_DATABASE_URL: databaseUrl,
  });
  run("npx", ["vitest", "run", "test/api.integration.test.ts"], {
    TEST_DATABASE_URL: databaseUrl,
  });
} finally {
  if (started)
    spawnSync(
      join(bin, "pg_ctl"),
      ["-D", directory, "-m", "fast", "-w", "stop"],
      { stdio: "inherit" },
    );
  if (directory) await rm(directory, { recursive: true, force: true });
}

async function resetExternalDatabase(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
    await client.query("GRANT ALL ON SCHEMA public TO public");
  } finally {
    await client.end();
  }
}

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited with status ${result.status}`);
}

async function seedLegacySampleMigrationFixtures(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      INSERT INTO users(id,auth_subject,display_name) VALUES
        ('22000000-0000-4000-8000-000000000001','test|legacy-sample-only','Sample only'),
        ('22000000-0000-4000-8000-000000000002','test|legacy-mixed-manual','Mixed manual'),
        ('22000000-0000-4000-8000-000000000003','test|legacy-mixed-plaid','Mixed plaid');
      INSERT INTO households(id,name) VALUES
        ('22000000-0000-4000-8000-000000000101','Sample only household'),
        ('22000000-0000-4000-8000-000000000102','Mixed manual household'),
        ('22000000-0000-4000-8000-000000000103','Mixed plaid household');
      INSERT INTO household_memberships(household_id,user_id,role,onboarding_completed_at) VALUES
        ('22000000-0000-4000-8000-000000000101','22000000-0000-4000-8000-000000000001','owner',now()),
        ('22000000-0000-4000-8000-000000000102','22000000-0000-4000-8000-000000000002','owner',now()),
        ('22000000-0000-4000-8000-000000000103','22000000-0000-4000-8000-000000000003','owner',now());
      INSERT INTO plans(id,household_id,planned_savings_minor,safety_buffer_minor,currency,calculation_policy_version) VALUES
        ('22000000-0000-4000-8000-000000000301','22000000-0000-4000-8000-000000000101',0,0,'USD','available-v1'),
        -- Nonzero legacy savings exercises the 029 creation and 033 immutable
        -- revision enrichment path before the test suite reaches current data.
        ('22000000-0000-4000-8000-000000000302','22000000-0000-4000-8000-000000000102',5000,0,'USD','available-v1'),
        ('22000000-0000-4000-8000-000000000303','22000000-0000-4000-8000-000000000103',0,0,'USD','available-v1');
      INSERT INTO connections(id,household_id,provider,provider_item_id,status) VALUES
        ('22000000-0000-4000-8000-000000000501','22000000-0000-4000-8000-000000000101','sample','legacy-sample-only','healthy'),
        ('22000000-0000-4000-8000-000000000502','22000000-0000-4000-8000-000000000102','sample','legacy-sample-manual','healthy'),
        ('22000000-0000-4000-8000-000000000503','22000000-0000-4000-8000-000000000103','sample','legacy-sample-plaid','healthy');
      INSERT INTO connections(id,household_id,provider,provider_item_id,status) VALUES
        ('22000000-0000-4000-8000-000000000504','22000000-0000-4000-8000-000000000103','plaid','legacy-real-plaid','revoked');
      INSERT INTO accounts(id,household_id,name,account_type,currency,provenance,connection_id,provider_account_id,include_in_plan) VALUES
        ('22000000-0000-4000-8000-000000000201','22000000-0000-4000-8000-000000000101','Manual cash','cash','USD','manual',NULL,NULL,true),
        ('22000000-0000-4000-8000-000000000211','22000000-0000-4000-8000-000000000101','Legacy sample','checking','USD','sample','22000000-0000-4000-8000-000000000501','sample-only',true),
        ('22000000-0000-4000-8000-000000000202','22000000-0000-4000-8000-000000000102','Manual cash','cash','USD','manual',NULL,NULL,true),
        ('22000000-0000-4000-8000-000000000212','22000000-0000-4000-8000-000000000102','Legacy sample','checking','USD','sample','22000000-0000-4000-8000-000000000502','sample-manual',true),
        ('22000000-0000-4000-8000-000000000203','22000000-0000-4000-8000-000000000103','Manual cash','cash','USD','manual',NULL,NULL,true),
        ('22000000-0000-4000-8000-000000000213','22000000-0000-4000-8000-000000000103','Legacy sample','checking','USD','sample','22000000-0000-4000-8000-000000000503','sample-plaid',true),
        ('22000000-0000-4000-8000-000000000223','22000000-0000-4000-8000-000000000103','Real checking','checking','USD','plaid','22000000-0000-4000-8000-000000000504','real-plaid',false);
      INSERT INTO balance_observations(household_id,account_id,amount_minor,currency,provenance,as_of,source_record_id) VALUES
        ('22000000-0000-4000-8000-000000000101','22000000-0000-4000-8000-000000000201',0,'USD','manual',now(),'provisioned'),
        ('22000000-0000-4000-8000-000000000101','22000000-0000-4000-8000-000000000211',999900,'USD','sample',now(),'legacy-sample-only'),
        ('22000000-0000-4000-8000-000000000102','22000000-0000-4000-8000-000000000202',123400,'USD','manual',now(),'user-confirmed'),
        ('22000000-0000-4000-8000-000000000102','22000000-0000-4000-8000-000000000212',999900,'USD','sample',now(),'legacy-sample-manual'),
        ('22000000-0000-4000-8000-000000000103','22000000-0000-4000-8000-000000000213',999900,'USD','sample',now(),'legacy-sample-plaid'),
        ('22000000-0000-4000-8000-000000000103','22000000-0000-4000-8000-000000000223',456700,'USD','plaid',now(),'real-plaid');
      INSERT INTO financial_transactions(id,household_id,account_id,source_kind,source_record_id,merchant,amount_minor,currency,direction,occurred_on,status) VALUES
        ('22000000-0000-4000-8000-000000000601','22000000-0000-4000-8000-000000000101','22000000-0000-4000-8000-000000000211','sample','legacy-charge','Legacy sample merchant',1000,'USD','debit',current_date,'posted'),
        ('22000000-0000-4000-8000-000000000602','22000000-0000-4000-8000-000000000102','22000000-0000-4000-8000-000000000202','manual','real-charge','Real manual merchant',2500,'USD','debit',current_date,'posted');
      INSERT INTO financial_transactions(household_id,account_id,source_kind,source_record_id,merchant,amount_minor,currency,direction,occurred_on,status)
        SELECT '22000000-0000-4000-8000-000000000102','22000000-0000-4000-8000-000000000202','manual',
          'scale-'||series,'Scale merchant '||series,1000+series,'USD','debit',current_date-(series % 365),'posted'
        FROM generate_series(1,10000) series;
      INSERT INTO exception_cases(id,household_id,case_type,status,title) VALUES
        ('22000000-0000-4000-8000-000000000701','22000000-0000-4000-8000-000000000101','possible_duplicate','open','Legacy sample case');
      INSERT INTO case_evidence(
        household_id,case_id,evidence_type,source_entity_type,source_entity_id,summary,
        merchant_snapshot,amount_minor_snapshot,currency_snapshot,occurred_on_snapshot,
        account_id_snapshot,account_name_snapshot,status_snapshot,provenance_snapshot
      ) VALUES (
        '22000000-0000-4000-8000-000000000101','22000000-0000-4000-8000-000000000701',
        'observed','financial_transaction','22000000-0000-4000-8000-000000000601','Legacy sample evidence',
        'Legacy sample merchant',1000,'USD',current_date,'22000000-0000-4000-8000-000000000211',
        'Legacy sample','posted','sample'
      );
      INSERT INTO commitments(id,household_id,name,amount_minor,currency,due_date,provenance) VALUES
        ('22000000-0000-4000-8000-000000000401','22000000-0000-4000-8000-000000000102','StreamBox',1899,'USD',current_date + 7,'manual');
      INSERT INTO commitment_revisions(household_id,commitment_id,version,name,amount_minor,currency,due_date,active,settled_at)
        SELECT household_id,id,version,name,amount_minor,currency,due_date,active,settled_at
        FROM commitments WHERE id='22000000-0000-4000-8000-000000000401';
    `);
  } finally {
    await client.end();
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(new Error("Could not allocate a PostgreSQL test port"));
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}
