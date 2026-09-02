import "reflect-metadata";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { createHash, createHmac, generateKeyPairSync, type KeyObject } from "node:crypto";
import { SignJWT, type JWK } from "jose";
import pg from "pg";
import type { AccountBase, Transaction } from "plaid";
import { v7 as uuidv7 } from "uuid";
import {
  bootstrapResponseSchema,
  featureFlagsResponseSchema,
} from "../packages/contracts/src/index.js";
import { onboardingAnalysisResponseSchema } from "../packages/contracts/src/index.js";
import { PlaidRequestError, type PlaidSyncPage } from "../apps/api/src/plaid/plaid.gateway.js";
import { PlaidService } from "../apps/api/src/plaid/plaid.service.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required; PostgreSQL integration tests must never be skipped");
const testRuntimePassword = "integration-api-runtime-password-000000000004";
const ids = {
  userA: "10000000-0000-4000-8000-000000000001",
  userB: "10000000-0000-4000-8000-000000000002",
  householdA: "10000000-0000-4000-8000-000000000101",
  householdB: "10000000-0000-4000-8000-000000000102",
  accountA: "10000000-0000-4000-8000-000000000201",
  accountB: "10000000-0000-4000-8000-000000000202",
  planA: "10000000-0000-4000-8000-000000000301",
  planB: "10000000-0000-4000-8000-000000000302",
};

describe("Budgefi API with PostgreSQL", () => {
  let app: NestFastifyApplication;
  let admin: pg.Client;
  let fakePlaid: FakePlaidGateway;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.ALLOW_DEV_AUTH = "true";
    process.env.ALLOW_USER_PROVISIONING = "true";
    process.env.NODE_ENV = "test";
    process.env.PLAID_ENABLED = "true";
    process.env.PLAID_ENV = "sandbox";
    process.env.PLAID_CLIENT_ID = "integration-client";
    process.env.PLAID_SECRET = "integration-secret";
    process.env.PLAID_REDIRECT_URI = "https://app.budgefi.test/open/plaid-oauth";
    process.env.PLAID_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.PLAID_WORKER_DISABLED = "true";
    process.env.OPENAI_FINANCE_ENABLED = "false";
    process.env.FEATURE_ONBOARDING_AI = "true";
    process.env.FEATURE_HOUSEHOLD_MODE = "false";
    process.env.CLERK_WEBHOOK_SIGNING_SECRET = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
    admin = new pg.Client({ connectionString: testDatabaseUrl });
    await admin.connect();
    await admin.query("DROP ROLE IF EXISTS budgefi_runtime_test");
    await admin.query("DROP ROLE IF EXISTS budgefi_function_owner_test");
    await admin.query(`CREATE ROLE budgefi_runtime_test LOGIN PASSWORD '${testRuntimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS IN ROLE budgefi_app, budgefi_plaid_worker`);
    await admin.query("CREATE ROLE budgefi_function_owner_test NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS");
    await admin.query("GRANT USAGE ON SCHEMA public TO budgefi_function_owner_test");
    await admin.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO budgefi_function_owner_test");
    await admin.query("ALTER FUNCTION provision_principal(text,text,text) OWNER TO budgefi_function_owner_test");
    await admin.query("ALTER FUNCTION resolve_principal(text,uuid) OWNER TO budgefi_function_owner_test");
    await admin.query("ALTER FUNCTION resolve_system_household_actor(uuid) OWNER TO budgefi_function_owner_test");
    await admin.query("GRANT EXECUTE ON FUNCTION provision_principal(text,text,text), resolve_principal(text,uuid) TO budgefi_app");
    await admin.query("GRANT EXECUTE ON FUNCTION resolve_system_household_actor(uuid) TO budgefi_plaid_worker");
    const runtimeUrl = new URL(testDatabaseUrl);
    runtimeUrl.username = "budgefi_runtime_test";
    runtimeUrl.password = testRuntimePassword;
    process.env.RUNTIME_DATABASE_URL = runtimeUrl.toString();
    await resetFixture(admin);
    const [{ AppModule }, { ErrorFilter }, { PlaidGateway }] = await Promise.all([import("../apps/api/src/app.module.js"), import("../apps/api/src/http/error.filter.js"), import("../apps/api/src/plaid/plaid.gateway.js")]);
    fakePlaid = new FakePlaidGateway();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PlaidGateway)
      .useValue(fakePlaid)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ["error"], rawBody: true });
    app.setGlobalPrefix("v1");
    app.useGlobalFilters(new ErrorFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(async () => {
    await resetFixture(admin);
    fakePlaid.reset();
  });

  afterAll(async () => {
    await app?.close();
    await admin?.end();
    delete process.env.RUNTIME_DATABASE_URL;
  });

  it("serves authenticated, typed product feature flags", async () => {
    const response = await inject("GET", "/v1/features", undefined, "dev|maya");
    expect(response.statusCode).toBe(200);
    expect(featureFlagsResponseSchema.parse(response.json())).toEqual({
      onboardingAi: true,
      householdMode: false,
    });
  });

  it("returns an authoritative integer-money projection", async () => {
    const response = await inject("GET", "/v1/bootstrap", undefined, "dev|maya");
    expect(response.statusCode).toBe(200);
    const body = bootstrapResponseSchema.parse(response.json());
    expect(body.plan.knownCash.minor).toBe("423039");
    expect(body.plan.reserved.minor).toBe("294639");
    expect(body.plan.available.minor).toBe("128400");
    expect(body.plan.freshness.status).toBe("manual");
  });

  it("persists a manual balance across independent reads", async () => {
    const requestId = uuidv7();
    const firstPayload = {
      accountId: ids.accountA,
      amount: { minor: "500000" as const, currency: "USD" as const },
      asOf: new Date().toISOString(),
      requestId,
    };
    const saved = await inject("POST", "/v1/manual/balances", firstPayload, "dev|maya");
    expect(saved.statusCode).toBe(201);
    expect(bootstrapResponseSchema.parse(saved.json()).plan.knownCash.minor).toBe("500000");
    const later = await inject(
      "POST",
      "/v1/manual/balances",
      {
        ...firstPayload,
        amount: { minor: "600000", currency: "USD" },
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(bootstrapResponseSchema.parse(later.json()).plan.knownCash.minor).toBe("600000");
    const retriedFirst = await inject("POST", "/v1/manual/balances", firstPayload, "dev|maya");
    expect(bootstrapResponseSchema.parse(retriedFirst.json()).plan.knownCash.minor).toBe("600000");
    const refreshed = await inject("GET", "/v1/bootstrap", undefined, "dev|maya");
    expect(bootstrapResponseSchema.parse(refreshed.json()).plan.knownCash.minor).toBe("600000");
  });

  it("keeps distinct calculation evidence when different observations have equal totals", async () => {
    for (let index = 0; index < 2; index += 1) {
      const response = await inject(
        "POST",
        "/v1/manual/balances",
        {
          accountId: ids.accountA,
          amount: { minor: "423039", currency: "USD" },
          asOf: new Date(Date.now() + index).toISOString(),
          requestId: uuidv7(),
        },
        "dev|maya",
      );
      expect(response.statusCode).toBe(201);
    }
    const snapshots = await admin.query<{ count: number }>("SELECT count(*)::int AS count FROM calculation_snapshots WHERE household_id = $1", [ids.householdA]);
    expect(snapshots.rows[0]?.count).toBe(2);
    const manifests = await admin.query<{ count: number }>("SELECT count(*)::int AS count FROM calculation_snapshot_inputs WHERE household_id = $1", [ids.householdA]);
    expect(manifests.rows[0]?.count).toBeGreaterThan(0);
    const snapshotId = (await admin.query<{ id: string }>("SELECT id FROM calculation_snapshots WHERE household_id = $1 LIMIT 1", [ids.householdA])).rows[0]?.id;
    await expect(admin.query("UPDATE calculation_snapshots SET available_minor = available_minor WHERE id = $1", [snapshotId])).rejects.toThrow(/append-only/);
    await expect(admin.query("DELETE FROM calculation_snapshot_inputs WHERE snapshot_id = $1", [snapshotId])).rejects.toThrow(/append-only/);
  });

  it("applies an idempotent commitment request exactly once", async () => {
    const requestId = uuidv7();
    const payload = {
      name: "Phone",
      amount: { minor: "7422", currency: "USD" },
      dueDate: "2026-09-09",
      requestId,
    };
    const first = await inject("POST", "/v1/commitments", payload, "dev|maya");
    const second = await inject("POST", "/v1/commitments", payload, "dev|maya");
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(bootstrapResponseSchema.parse(second.json()).plan.commitments.filter((item) => item.name === "Phone")).toHaveLength(1);
    const count = await admin.query("SELECT count(*)::int AS count FROM commitments WHERE household_id = $1 AND name = 'Phone'", [ids.householdA]);
    expect(count.rows[0]?.count).toBe(1);
    const conflicting = await inject("POST", "/v1/commitments", { ...payload, amount: { minor: "7500", currency: "USD" } }, "dev|maya");
    expect(conflicting.statusCode).toBe(409);
  });

  it("tracks an undated commitment without reserving it", async () => {
    const created = await inject(
      "POST",
      "/v1/commitments",
      {
        name: "Flexible goal",
        amount: { minor: "2500", currency: "USD" },
        dueDate: null,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(created.statusCode).toBe(201);
    const body = bootstrapResponseSchema.parse(created.json());
    expect(body.plan.commitments.find((item) => item.name === "Flexible goal")?.dueDate).toBeNull();
  });

  it("rejects unknown fields and invalid money at the contract boundary", async () => {
    const response = await inject(
      "POST",
      "/v1/commitments",
      {
        name: "Bad",
        amount: { minor: "1.25", currency: "USD" },
        dueDate: null,
        requestId: uuidv7(),
        surprise: true,
      },
      "dev|maya",
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("validation_failed");
    const impossibleDate = await inject(
      "POST",
      "/v1/commitments",
      {
        name: "Impossible",
        amount: { minor: "100", currency: "USD" },
        dueDate: "2026-02-31",
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(impossibleDate.statusCode).toBe(400);
  });

  it("uses optimistic concurrency for plan edits", async () => {
    const current = bootstrapResponseSchema.parse((await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json());
    const first = await inject(
      "PUT",
      "/v1/plan",
      {
        expectedVersion: current.plan.version,
        plannedSavings: { minor: "51000", currency: "USD" },
        safetyBuffer: { minor: "28000", currency: "USD" },
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(first.statusCode).toBe(200);
    const stale = await inject(
      "PUT",
      "/v1/plan",
      {
        expectedVersion: current.plan.version,
        plannedSavings: { minor: "52000", currency: "USD" },
        safetyBuffer: { minor: "28000", currency: "USD" },
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(stale.statusCode).toBe(409);
  });

  it("prevents cross-household access in the API and database", async () => {
    const b = await inject("GET", "/v1/bootstrap", undefined, "dev|riley");
    const bodyB = bootstrapResponseSchema.parse(b.json());
    expect(bodyB.household.id).toBe(ids.householdB);
    expect(bodyB.plan.knownCash.minor).toBe("100000");
    const guessed = await inject("GET", "/v1/bootstrap", undefined, "dev|riley", ids.householdA);
    expect(guessed.statusCode).toBe(403);

    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL ROLE budgefi_app");
      await admin.query("SELECT set_config('app.user_id', $1, true)", [ids.userB]);
      await admin.query("SELECT set_config('app.household_id', $1, true)", [ids.householdB]);
      const hidden = await admin.query("SELECT count(*)::int AS count FROM accounts WHERE household_id = $1", [ids.householdA]);
      expect(hidden.rows[0]?.count).toBe(0);
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("permits only owners and administrators to mutate financial truth", async () => {
    const attempts = [
      [
        "POST",
        "/v1/manual/balances",
        {
          accountId: ids.accountA,
          amount: { minor: "1", currency: "USD" },
          asOf: new Date().toISOString(),
          requestId: uuidv7(),
        },
      ],
      [
        "POST",
        "/v1/manual/transactions",
        {
          accountId: ids.accountA,
          merchant: "Nope",
          amount: { minor: "1", currency: "USD" },
          occurredOn: "2026-08-31",
          requestId: uuidv7(),
        },
      ],
      [
        "POST",
        "/v1/commitments",
        {
          name: "Nope",
          amount: { minor: "1", currency: "USD" },
          dueDate: null,
          requestId: uuidv7(),
        },
      ],
      [
        "PUT",
        "/v1/plan",
        {
          expectedVersion: 1,
          plannedSavings: { minor: "1", currency: "USD" },
          safetyBuffer: { minor: "1", currency: "USD" },
          requestId: uuidv7(),
        },
      ],
      ["PUT", `/v1/accounts/${ids.accountA}/inclusion`, { expectedVersion: 1, includeInPlan: false, requestId: uuidv7() }],
      [
        "PUT",
        "/v1/plan/calibration",
        {
          expectedVersion: 1,
          plannedSavings: { minor: "1", currency: "USD" },
          safetyBuffer: { minor: "1", currency: "USD" },
          commitments: [],
          requestId: uuidv7(),
        },
      ],
    ] as const;
    for (const role of ["member", "viewer"] as const) {
      await admin.query("UPDATE household_memberships SET role = $1 WHERE household_id = $2 AND user_id = $3", [role, ids.householdA, ids.userA]);
      for (const [method, url, payload] of attempts) expect((await inject(method, url, payload, "dev|maya")).statusCode).toBe(403);
    }
    await admin.query("UPDATE household_memberships SET role = 'admin' WHERE household_id = $1 AND user_id = $2", [ids.householdA, ids.userA]);
    expect(
      (
        await inject(
          "POST",
          "/v1/commitments",
          {
            name: "Allowed",
            amount: { minor: "1", currency: "USD" },
            dueDate: null,
            requestId: uuidv7(),
          },
          "dev|maya",
        )
      ).statusCode,
    ).toBe(201);
  });

  it("includes only explicitly planned liquid assets in known cash", async () => {
    const rows = [
      [uuidv7(), "Protected savings", "savings", true, null, "50000"],
      [uuidv7(), "Excluded checking", "checking", false, null, "90000"],
      [uuidv7(), "Credit", "credit", false, null, "700000"],
      [uuidv7(), "Loan", "loan", false, null, "800000"],
      [uuidv7(), "Archived cash", "cash", true, new Date(), "60000"],
    ] as const;
    for (const [id, name, type, included, archivedAt, amount] of rows) {
      await admin.query("INSERT INTO accounts (id, household_id, name, account_type, currency, provenance, include_in_plan, archived_at) VALUES ($1, $2, $3, $4, 'USD', 'manual', $5, $6)", [id, ids.householdA, name, type, included, archivedAt]);
      await admin.query("INSERT INTO balance_observations (household_id, account_id, amount_minor, currency, provenance, as_of, source_record_id) VALUES ($1, $2, $3, 'USD', 'manual', now(), $4)", [ids.householdA, id, amount, `fixture-${id}`]);
    }
    const body = bootstrapResponseSchema.parse((await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json());
    expect(body.plan.knownCash.minor).toBe("473039");
  });

  it("makes account inclusion explicit, versioned and projection-authoritative", async () => {
    const savingsId = uuidv7();
    await admin.query("INSERT INTO accounts (id, household_id, name, account_type, currency, provenance, include_in_plan) VALUES ($1, $2, 'Savings', 'savings', 'USD', 'manual', false)", [savingsId, ids.householdA]);
    await admin.query("INSERT INTO balance_observations (household_id, account_id, amount_minor, currency, provenance, as_of, source_record_id) VALUES ($1, $2, 50000, 'USD', 'manual', now(), 'savings-v1')", [ids.householdA, savingsId]);
    const before = bootstrapResponseSchema.parse((await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json());
    expect(before.accounts.find((account) => account.id === savingsId)?.coverage).toBe("excluded");
    const included = await inject("PUT", `/v1/accounts/${savingsId}/inclusion`, { expectedVersion: 1, includeInPlan: true, requestId: uuidv7() }, "dev|maya");
    const body = bootstrapResponseSchema.parse(included.json());
    expect(body.plan.knownCash.minor).toBe("473039");
    expect(BigInt(body.revision)).toBeGreaterThan(BigInt(before.revision));
    expect((await inject("PUT", `/v1/accounts/${savingsId}/inclusion`, { expectedVersion: 1, includeInPlan: false, requestId: uuidv7() }, "dev|maya")).statusCode).toBe(409);
  });

  it("excludes only an unused manual placeholder when connected cash is included", async () => {
    const placeholderId = uuidv7();
    const connectedId = uuidv7();
    await admin.query(
      "INSERT INTO accounts (id, household_id, name, account_type, currency, provenance, include_in_plan, provider_account_id) VALUES ($1, $2, 'Unused manual cash', 'cash', 'USD', 'manual', true, $3), ($4, $2, 'Connected checking', 'checking', 'USD', 'plaid', false, $5)",
      [
        placeholderId,
        ids.householdA,
        `manual-${placeholderId}`,
        connectedId,
        `plaid-${connectedId}`,
      ],
    );
    await admin.query(
      "INSERT INTO balance_observations (household_id, account_id, amount_minor, currency, provenance, as_of, source_record_id) VALUES ($1, $2, 250000, 'USD', 'plaid', now(), 'connected-v1')",
      [ids.householdA, connectedId],
    );

    const response = await inject(
      "PUT",
      `/v1/accounts/${connectedId}/inclusion`,
      {
        expectedVersion: 1,
        includeInPlan: true,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(response.statusCode, response.body).toBe(200);
    const body = bootstrapResponseSchema.parse(response.json());
    expect(body.accounts.find((item) => item.id === placeholderId)).toEqual(
      expect.objectContaining({ includeInPlan: false, coverage: "excluded" }),
    );
    expect(body.accounts.find((item) => item.id === ids.accountA)).toEqual(
      expect.objectContaining({ includeInPlan: true, coverage: "complete" }),
    );
    expect(body.accounts.find((item) => item.id === connectedId)).toEqual(
      expect.objectContaining({ includeInPlan: true }),
    );
  });

  it("marks a plan incomplete when any included account lacks a balance", async () => {
    await admin.query("INSERT INTO accounts (household_id, name, account_type, currency, provenance, include_in_plan) VALUES ($1, 'Unknown checking', 'checking', 'USD', 'manual', true)", [ids.householdA]);
    const body = bootstrapResponseSchema.parse((await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json());
    expect(body.plan.freshness.status).toBe("incomplete");
    expect(body.accounts.find((account) => account.name === "Unknown checking")?.coverage).toBe("missing");
  });

  it("calibrates cash, guardrails and editable commitments atomically", async () => {
    const before = bootstrapResponseSchema.parse((await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json());
    const electricBefore = before.plan.commitments.find((item) => item.name === "Electric");
    expect(electricBefore).toBeDefined();
    const requestId = uuidv7();
    const payload = {
      expectedVersion: before.plan.version,
      manualBalance: {
        accountId: ids.accountA,
        amount: { minor: "450000", currency: "USD" },
        asOf: new Date().toISOString(),
      },
      plannedSavings: { minor: "60000", currency: "USD" },
      safetyBuffer: { minor: "30000", currency: "USD" },
      commitments: before.plan.commitments.map((item) => ({
        id: item.id,
        expectedVersion: item.version,
        name: item.name === "Electric" ? "Power bill" : item.name,
        amount: item.name === "Electric" ? { minor: "17000", currency: "USD" } : item.amount,
        dueDate: item.dueDate,
      })),
      removeCommitments: [],
      requestId,
    } as const;
    const saved = bootstrapResponseSchema.parse((await inject("PUT", "/v1/plan/calibration", payload, "dev|maya")).json());
    expect(saved.plan.knownCash.minor).toBe("450000");
    expect(saved.plan.plannedSavings.minor).toBe("60000");
    expect(saved.plan.safetyBuffer.minor).toBe("30000");
    const renamed = saved.plan.commitments.find((item) => item.name === "Power bill");
    expect(renamed?.id).toBe(electricBefore?.id);
    expect(renamed?.amount.minor).toBe("17000");
    expect(saved.plan.commitments.some((item) => item.name === "Electric")).toBe(false);
    expect(BigInt(saved.revision)).toBe(BigInt(before.revision) + 1n);
    const retry = bootstrapResponseSchema.parse((await inject("PUT", "/v1/plan/calibration", payload, "dev|maya")).json());
    expect(retry.revision).toBe(saved.revision);
  });

  it("does not expose the retired interactive sample connection API", async () => {
    const response = await inject("POST", "/v1/connections/sample", { requestId: uuidv7() }, "dev|maya");
    expect(response.statusCode).toBe(404);
  });

  it("accepts only signed, idempotent Clerk identity-deletion events", async () => {
    const userId = "14000000-0000-4000-8000-000000000001";
    const householdId = "14000000-0000-4000-8000-000000000101";
    const clerkUserId = "user_webhook_fixture";
    await admin.query("insert into users(id,auth_subject,display_name) values($1,$2,'Webhook Fixture')", [userId, `clerk|${clerkUserId}`]);
    await admin.query("insert into households(id,name) values($1,'Webhook Fixture Household')", [householdId]);
    await admin.query("insert into household_memberships(household_id,user_id,role) values($1,$2,'owner')", [householdId, userId]);
    const eventId = "msg_clerk_deletion_fixture";
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const payload = JSON.stringify({
      type: "user.deleted",
      object: "event",
      data: { id: clerkUserId, object: "user", deleted: true },
      event_attributes: {
        http_request: { client_ip: "127.0.0.1", user_agent: "integration" },
      },
    });
    const secret = Buffer.alloc(32, 9);
    const signature = `v1,${createHmac("sha256", secret).update(`${eventId}.${timestamp}.${payload}`).digest("base64")}`;
    const headers = {
      "content-type": "application/json",
      "svix-id": eventId,
      "svix-timestamp": timestamp,
      "svix-signature": signature,
    };
    const tampered = await app.inject({
      method: "POST",
      url: "/v1/clerk/webhook",
      payload,
      headers: { ...headers, "svix-signature": "v1,invalid" },
    });
    expect(tampered.statusCode).toBe(400);
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/clerk/webhook",
      payload,
      headers,
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({
      accepted: true,
      handled: true,
      duplicate: false,
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/clerk/webhook",
      payload,
      headers,
    });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json().duplicate).toBe(true);
    expect((await admin.query("select status from account_deletion_requests where user_id=$1 and household_id=$2", [userId, householdId])).rows[0]?.status).toBe("ready_to_finalize");
  });

  it("keeps legacy sample ledger rows out of every live bootstrap surface", async () => {
    const connectionId = uuidv7();
    const accountId = uuidv7();
    await admin.query("INSERT INTO connections (id, household_id, provider, provider_item_id, status) VALUES ($1,$2,'sample','legacy-sample-item','healthy')", [connectionId, ids.householdA]);
    await admin.query("INSERT INTO accounts (id, household_id, name, account_type, currency, provenance, connection_id, provider_account_id, include_in_plan) VALUES ($1,$2,'Legacy fixture checking','checking','USD','sample',$3,'legacy-sample-account',true)", [accountId, ids.householdA, connectionId]);
    await admin.query("INSERT INTO balance_observations (household_id, account_id, amount_minor, currency, provenance, as_of, source_record_id) VALUES ($1,$2,999999,'USD','sample',now(),'legacy-sample-balance')", [ids.householdA, accountId]);
    await admin.query("INSERT INTO financial_transactions (household_id, account_id, source_kind, source_record_id, merchant, amount_minor, currency, direction, occurred_on, status) VALUES ($1,$2,'sample','legacy-sample-charge','Legacy fixture merchant',9999,'USD','debit',current_date,'posted')", [ids.householdA, accountId]);
    await admin.query("INSERT INTO activity_events (household_id, event_type, title, detail, provenance, entity_type, entity_id) VALUES ($1,'legacy.sample','Legacy fixture activity','Must remain outside the product','sample','connection',$2)", [ids.householdA, connectionId]);
    const body = bootstrapResponseSchema.parse((await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json());
    expect(body.plan.knownCash.minor).toBe("423039");
    expect(body.accounts.some((item) => item.provenance === "sample")).toBe(false);
    expect(body.connections.some((item) => item.provider === "sample")).toBe(false);
    expect(body.transactions.some((item) => item.provenance === "sample")).toBe(false);
    expect(body.activity.some((item) => item.title === "Legacy fixture activity")).toBe(false);
  });

  it("turns recurring activity into reviewable onboarding suggestions without promoting transfers", async () => {
    const today = new Date();
    const date = (daysAgo: number) => {
      const value = new Date(today);
      value.setUTCDate(value.getUTCDate() - daysAgo);
      return value.toISOString().slice(0, 10);
    };
    const rows = [...[2, 16, 30, 44].map((days, index) => [`payroll-${index}`, "Payroll deposit", "220000", date(days), "credit"]), ...[3, 33, 63].map((days, index) => [`internet-${index}`, "MetroNet", index === 0 ? "8320" : "8210", date(days), "debit"]), ...[28, 58, 88].map((days, index) => [`rent-${index}`, "Juniper Apartments", "165000", date(days), "debit"]), ...[24, 54, 84].map((days, index) => [`invest-${index}`, "Acorns", "2500", date(days), "debit"])] as const;
    for (const [sourceId, merchant, amount, occurredOn, direction] of rows) await admin.query("INSERT INTO financial_transactions (household_id, account_id, source_kind, source_record_id, merchant, amount_minor, currency, direction, occurred_on, status) VALUES ($1,$2,'plaid',$3,$4,$5,'USD',$6,$7,'posted')", [ids.householdA, ids.accountA, sourceId, merchant, amount, direction, occurredOn]);
    const analyzed = await inject("POST", "/v1/insights/onboarding", { refresh: false }, "dev|maya");
    expect(analyzed.statusCode, analyzed.body).toBe(201);
    const body = onboardingAnalysisResponseSchema.parse(analyzed.json());
    expect(body.state).toBe("ready");
    expect(body.source).toBe("deterministic");
    expect(body.suggestions.income?.name).toBe("Payroll deposit");
    expect(body.suggestions.savings?.name).toBe("Acorns");
    expect(body.suggestions.commitments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "MetroNet", category: "bill" }),
        expect.objectContaining({
          name: "Juniper Apartments",
          category: "housing",
        }),
      ]),
    );
    expect(body.suggestions.commitments.map((item) => item.name)).not.toContain("Online card payment");
    const cached = onboardingAnalysisResponseSchema.parse((await inject("POST", "/v1/insights/onboarding", { refresh: false }, "dev|maya")).json());
    expect(cached.generatedAt).toBe(body.generatedAt);
  });

  it("keeps onboarding analysis unavailable when its product flag is off", async () => {
    process.env.FEATURE_ONBOARDING_AI = "false";
    try {
      const response = await inject("POST", "/v1/insights/onboarding", { refresh: false }, "dev|maya");
      expect(response.statusCode).toBe(404);
    } finally {
      process.env.FEATURE_ONBOARDING_AI = "true";
    }
  });

  it("keeps savings round-ups and pending replacements out of duplicate review", async () => {
    const occurredOn = new Date().toISOString().slice(0, 10);
    for (const merchant of ["Round Up to Savings", "Round Up from Credit Card"]) {
      for (let index = 0; index < 2; index += 1) {
        const response = await inject(
          "POST",
          "/v1/manual/transactions",
          {
            accountId: ids.accountA,
            merchant,
            amount: { minor: "500", currency: "USD" },
            occurredOn,
            requestId: uuidv7(),
          },
          "dev|maya",
        );
        expect(response.statusCode).toBe(201);
      }
    }
    const savings = bootstrapResponseSchema.parse((await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json());
    expect(savings.cases.some((item) => item.title.includes("Round Up"))).toBe(false);

    for (let index = 0; index < 2; index += 1)
      await inject(
        "POST",
        "/v1/manual/transactions",
        {
          accountId: ids.accountA,
          merchant: "Ordinary duplicate fixture",
          amount: { minor: "875", currency: "USD" },
          occurredOn,
          requestId: uuidv7(),
        },
        "dev|maya",
      );
    const ordinary = bootstrapResponseSchema.parse((await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json());
    expect(ordinary.cases.some((item) => item.title.includes("Ordinary duplicate fixture"))).toBe(true);
    const duplicate = ordinary.cases.find((item) => item.title.includes("Ordinary duplicate fixture"))!;
    const decision = {
      decision: "expected" as const,
      expectedVersion: duplicate.version,
      requestId: uuidv7(),
    };
    expect((await inject("POST", `/v1/cases/${duplicate.id}/decision`, decision, "dev|maya")).statusCode).toBe(201);
    expect((await inject("POST", `/v1/cases/${duplicate.id}/decision`, { ...decision, requestId: uuidv7() }, "dev|maya")).statusCode).toBe(409);
  });

  it("surfaces every active commitment while reserving only overdue and in-horizon dated items", async () => {
    const today = householdDate();
    const insert = async (name: string, amount: number, offset: number | null, settled = false) => admin.query("INSERT INTO commitments (household_id, name, amount_minor, currency, due_date, provenance, settled_at) VALUES ($1, $2, $3, 'USD', $4, 'manual', $5)", [ids.householdA, name, amount, offset === null ? null : plusDays(today, offset), settled ? new Date() : null]);
    await insert("Overdue", 100, -5);
    await insert("Boundary", 200, 10);
    await insert("Undated", 50, null);
    await insert("Outside", 400, 11);
    await insert("Settled", 800, 1, true);
    const body = bootstrapResponseSchema.parse((await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json());
    expect(body.plan.reserved.minor).toBe("294939");
    expect(body.plan.commitments.map((item) => item.name)).toEqual(expect.arrayContaining(["Overdue", "Boundary", "Undated", "Outside"]));
    expect(body.plan.commitments.map((item) => item.name)).not.toContain("Settled");
  });

  it("keeps a surfaced out-of-horizon commitment active through calibration", async () => {
    const outsideId = uuidv7();
    const outsideDate = plusDays(householdDate(), 30);
    await admin.query("INSERT INTO commitments (id, household_id, name, amount_minor, currency, due_date, provenance) VALUES ($1, $2, 'Future tuition', 250000, 'USD', $3, 'manual')", [outsideId, ids.householdA, outsideDate]);
    const before = bootstrapResponseSchema.parse((await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json());
    expect(before.plan.commitments.some((item) => item.id === outsideId)).toBe(true);
    const payload = {
      expectedVersion: before.plan.version,
      plannedSavings: before.plan.plannedSavings,
      safetyBuffer: before.plan.safetyBuffer,
      commitments: before.plan.commitments.map((item) => ({
        id: item.id,
        expectedVersion: item.version,
        name: item.name,
        amount: item.amount,
        dueDate: item.dueDate,
      })),
      removeCommitments: [],
      requestId: uuidv7(),
    };
    expect((await inject("PUT", "/v1/plan/calibration", payload, "dev|maya")).statusCode).toBe(200);
    const stored = await admin.query<{ active: boolean }>("SELECT active FROM commitments WHERE id = $1", [outsideId]);
    expect(stored.rows[0]?.active).toBe(true);
  });

  it("forces RLS on every household-owned table", async () => {
    const result = await admin.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>("SELECT DISTINCT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'household_id' AND NOT a.attisdropped WHERE n.nspname = 'public' AND c.relkind = 'r' AND (a.attname IS NOT NULL OR c.relname = 'households') ORDER BY c.relname");
    expect(result.rows.map((row) => row.relname)).toEqual(expect.arrayContaining(["accounts", "activity_events", "balance_observations", "calculation_snapshot_inputs", "calculation_snapshots", "case_evidence", "commitment_revisions", "commitments", "connections", "exception_cases", "financial_transactions", "household_memberships", "households", "idempotency_records", "plan_revisions", "plans", "sync_runs", "webhook_receipts"]));
    const ownerBypassTables = new Set(["account_deletion_requests", "connections", "financial_pattern_analyses", "notification_deliveries", "notification_endpoints", "notification_events", "notification_preferences", "plaid_sync_jobs"]);
    expect(result.rows.every((row) => row.relrowsecurity)).toBe(true);
    expect(
      result.rows
        .filter((row) => !row.relforcerowsecurity)
        .map((row) => row.relname)
        .sort(),
    ).toEqual([...ownerBypassTables].sort());
    const privileges = await admin.query<{
      users_read: boolean;
      migrations_read: boolean;
      accounts_read: boolean;
    }>("SELECT has_table_privilege('budgefi_app', 'users', 'SELECT') AS users_read, has_table_privilege('budgefi_app', 'schema_migrations', 'SELECT') AS migrations_read, has_table_privilege('budgefi_app', 'accounts', 'SELECT') AS accounts_read");
    expect(privileges.rows[0]).toEqual({
      users_read: false,
      migrations_read: false,
      accounts_read: true,
    });
  });

  it("hands household ownership to a successor before requesting account deletion", async () => {
    await admin.query("insert into household_memberships(household_id,user_id,role,onboarding_completed_at) values($1,$2,'member',now())", [ids.householdA, ids.userB]);
    const requested = await inject("POST", "/v1/account/deletion", { confirmation: "DELETE", requestId: uuidv7() }, "dev|maya");
    expect(requested.statusCode, requested.body).toBe(201);
    expect((await admin.query<{ role: string }>("select role from household_memberships where household_id=$1 and user_id=$2", [ids.householdA, ids.userB])).rows[0]?.role).toBe("owner");
    expect((await admin.query<{ status: string }>("select status from account_deletion_requests where household_id=$1 and user_id=$2", [ids.householdA, ids.userA])).rows[0]?.status).toBe("ready_to_finalize");
  });

  it("blocks new bank links as soon as final-household deletion begins", async () => {
    const issued = await inject("POST", "/v1/plaid/link-token", { mode: "create" }, "dev|maya");
    expect(issued.statusCode).toBe(201);
    const requested = await inject("POST", "/v1/account/deletion", { confirmation: "DELETE", requestId: uuidv7() }, "dev|maya");
    expect(requested.statusCode, requested.body).toBe(201);
    expect((await admin.query<{ lifecycle_state: string }>("select lifecycle_state from households where id=$1", [ids.householdA])).rows[0]?.lifecycle_state).toBe("deleting");
    const link = await inject("POST", "/v1/plaid/link-token", { mode: "create" }, "dev|maya");
    expect(link.statusCode).toBe(409);
    expect(fakePlaid.linkCalls).toBe(1);
    const exchange = await inject(
      "POST",
      "/v1/plaid/exchange",
      {
        sessionId: issued.json().sessionId,
        publicToken: "public-issued-before-deletion",
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(exchange.statusCode).toBe(409);
    expect(fakePlaid.exchangeCalls).toBe(0);
  });

  it("provisions one complete household under concurrent first requests and refuses ambiguous routing", async () => {
    const subject = "dev|new-provisioned-member";
    const [first, second] = await Promise.all([inject("GET", "/v1/bootstrap", undefined, subject), inject("GET", "/v1/bootstrap", undefined, subject)]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstBootstrap = bootstrapResponseSchema.parse(first.json());
    const householdId = firstBootstrap.household.id;
    expect(firstBootstrap.household.onboardingCompleted).toBe(false);
    expect(firstBootstrap.accounts).toHaveLength(1);
    expect(firstBootstrap.accounts[0]).toMatchObject({
      provenance: "manual",
      balance: null,
      coverage: "missing",
    });
    expect(firstBootstrap.plan.freshness.status).toBe("incomplete");
    expect(firstBootstrap.transactions).toHaveLength(0);
    expect(firstBootstrap.cases).toHaveLength(0);
    expect(firstBootstrap.plan.commitments).toHaveLength(0);
    expect(bootstrapResponseSchema.parse(second.json()).household.id).toBe(householdId);
    const counts = await admin.query<{
      users: number;
      households: number;
      plans: number;
      accounts: number;
    }>(
      `select
      (select count(*)::int from users where auth_subject = $1) users,
      (select count(*)::int from household_memberships m join users u on u.id = m.user_id where u.auth_subject = $1) households,
      (select count(*)::int from plans where household_id = $2) plans,
      (select count(*)::int from accounts where household_id = $2) accounts`,
      [subject, householdId],
    );
    expect(counts.rows[0]).toEqual({
      users: 1,
      households: 1,
      plans: 1,
      accounts: 1,
    });

    const completed = await inject("POST", "/v1/onboarding/complete", {}, subject);
    expect(completed.statusCode).toBe(201);
    expect(bootstrapResponseSchema.parse(completed.json()).household.onboardingCompleted).toBe(true);
    expect(bootstrapResponseSchema.parse((await inject("GET", "/v1/bootstrap", undefined, subject)).json()).household.onboardingCompleted).toBe(true);
    const completionEvents = await admin.query<{ count: number }>("select count(*)::int count from activity_events where household_id = $1 and event_type = 'onboarding.completed'", [householdId]);
    expect(completionEvents.rows[0]?.count).toBe(1);
    await inject("POST", "/v1/onboarding/complete", {}, subject);
    expect((await admin.query<{ count: number }>("select count(*)::int count from activity_events where household_id = $1 and event_type = 'onboarding.completed'", [householdId])).rows[0]?.count).toBe(1);

    const secondHousehold = uuidv7();
    const userId = (await admin.query<{ id: string }>("select id from users where auth_subject = $1", [subject])).rows[0]!.id;
    await admin.query("insert into households (id, name) values ($1, 'Second household')", [secondHousehold]);
    await admin.query("insert into household_memberships (household_id, user_id, role) values ($1, $2, 'owner')", [secondHousehold, userId]);
    expect((await inject("GET", "/v1/bootstrap", undefined, subject)).statusCode).toBe(403);
    expect((await inject("GET", "/v1/bootstrap", undefined, subject, householdId)).statusCode).toBe(200);
  });

  it("exchanges a server-side Plaid token, synchronizes revisions, and revokes provider access", async () => {
    const link = await inject("POST", "/v1/plaid/link-token", { mode: "create" }, "dev|maya");
    expect(link.statusCode).toBe(201);
    const sessionId = link.json().sessionId as string;
    const exchangePayload = {
      sessionId,
      publicToken: "public-sandbox-token",
      linkSessionId: "link-session-1",
      institution: { id: "ins_109508", name: "First Platypus Bank" },
      requestId: uuidv7(),
    };
    const exchanged = await inject("POST", "/v1/plaid/exchange", exchangePayload, "dev|maya");
    expect(exchanged.statusCode).toBe(201);
    const accepted = bootstrapResponseSchema.parse(exchanged.json());
    const connection = accepted.connections.find((item) => item.provider === "plaid");
    expect(connection).toMatchObject({
      environment: "sandbox",
      institutionName: "First Platypus Bank",
      status: "syncing",
      initialUpdateComplete: false,
    });
    expect(accepted.accounts.some((account) => account.provenance === "plaid")).toBe(false);
    expect(await processQueued(connection!.id)).toBe(true);
    const initial = bootstrapResponseSchema.parse((await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json());
    expect(initial.connections.find((item) => item.id === connection!.id)).toMatchObject({ status: "healthy", initialUpdateComplete: true });
    const plaidAccount = initial.accounts.find((account) => account.provenance === "plaid");
    expect(plaidAccount).toMatchObject({
      includeInPlan: false,
      coverage: "excluded",
      balance: { minor: "120034", currency: "USD" },
    });
    expect(initial.transactions.find((transaction) => transaction.merchant === "Coffee Lab")).toMatchObject({
      amount: { minor: "825", currency: "USD" },
      status: "pending",
    });
    expect(fakePlaid.exchangeCalls).toBe(1);
    const replay = await inject("POST", "/v1/plaid/exchange", { ...exchangePayload, requestId: uuidv7() }, "dev|maya");
    expect(replay.statusCode).toBe(201);
    expect(fakePlaid.exchangeCalls).toBe(1);
    const stored = await admin.query<{ encrypted: string }>("select encode(encrypted_access_token, 'escape') encrypted from connections where id = $1", [connection!.id]);
    expect(stored.rows[0]!.encrypted).not.toContain("access-sandbox-token");

    fakePlaid.pages.set(
      "cursor-initial",
      syncPage({
        added: [
          plaidTransaction({
            transaction_id: "posted-coffee",
            pending_transaction_id: "pending-coffee",
            pending: false,
            name: "Coffee Lab",
          }),
        ],
        removed: [{ transaction_id: "pending-coffee", account_id: "plaid-checking" }],
        nextCursor: "cursor-posted",
        updateStatus: "HISTORICAL_UPDATE_COMPLETE",
      }),
    );
    const synchronized = await inject("POST", `/v1/plaid/connections/${connection!.id}/sync`, {}, "dev|maya");
    expect(synchronized.statusCode).toBe(201);
    expect(bootstrapResponseSchema.parse(synchronized.json()).connections.find((item) => item.id === connection!.id)?.status).toBe("syncing");
    expect(await processQueued(connection!.id)).toBe(true);
    const afterSync = bootstrapResponseSchema.parse((await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json());
    expect(afterSync.transactions.find((transaction) => transaction.merchant === "Coffee Lab" && transaction.status === "posted")).toBeTruthy();
    const pendingRevision = await admin.query<{
      revision: number;
      status: string;
    }>("select revision, status from financial_transactions where household_id = $1 and source_kind = 'plaid' and source_record_id = 'pending-coffee' order by revision desc limit 1", [ids.householdA]);
    expect(pendingRevision.rows[0]).toEqual({ revision: 2, status: "removed" });
    expect(afterSync.connections[0]?.historicalUpdateComplete).toBe(true);

    const disconnected = await inject("POST", `/v1/plaid/connections/${connection!.id}/disconnect`, {}, "dev|maya");
    expect(disconnected.statusCode).toBe(201);
    expect(bootstrapResponseSchema.parse(disconnected.json()).connections.find((item) => item.id === connection!.id)?.status).toBe("revocation_pending");
    expect(await processQueued(connection!.id, "revoke")).toBe(true);
    expect(fakePlaid.removedTokens).toContain("access-sandbox-token");
    const erased = await admin.query<{ token: Buffer | null }>("select encrypted_access_token token from connections where id = $1", [connection!.id]);
    expect(erased.rows[0]!.token).toBeNull();
  });

  it("keeps the first healthy Item and revokes an accidental duplicate bank-link retry", async () => {
    fakePlaid.uniqueItems = true;
    const firstLink = await inject("POST", "/v1/plaid/link-token", { mode: "create" }, "dev|maya");
    const firstExchange = await inject(
      "POST",
      "/v1/plaid/exchange",
      {
        sessionId: firstLink.json().sessionId,
        publicToken: "public-first-item",
        institution: { id: "ins_109508", name: "First Platypus Bank" },
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    const first = bootstrapResponseSchema.parse(firstExchange.json()).connections.find((item) => item.provider === "plaid")!;
    expect(await processQueued(first.id)).toBe(true);

    const secondLink = await inject("POST", "/v1/plaid/link-token", { mode: "create" }, "dev|maya");
    const secondExchange = await inject(
      "POST",
      "/v1/plaid/exchange",
      {
        sessionId: secondLink.json().sessionId,
        publicToken: "public-retry-item",
        institution: { id: "ins_109508", name: "First Platypus Bank" },
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    const second = bootstrapResponseSchema.parse(secondExchange.json()).connections.find((item) => item.provider === "plaid" && item.id !== first.id)!;
    expect(second.id).toBeTruthy();
    expect(await processQueued(second.id)).toBe(true);

    const pending = await admin.query<{ id: string; status: string }>("select id,status from connections where id=any($1::uuid[]) order by created_at", [[first.id, second.id]]);
    expect(pending.rows).toEqual([
      { id: first.id, status: "healthy" },
      { id: second.id, status: "revocation_pending" },
    ]);
    expect(await processQueued(second.id, "revoke")).toBe(true);
    const retired = await admin.query<{
      status: string;
      token_removed: boolean;
      duplicate_events: number;
    }>(
      `select c.status,
        c.encrypted_access_token is null as token_removed,
        (select count(*)::int from activity_events where household_id=$2 and event_type='connection.plaid.duplicate_retired') as duplicate_events
       from connections c where c.id=$1`,
      [second.id, ids.householdA],
    );
    expect(retired.rows[0]).toEqual({
      status: "revoked",
      token_removed: true,
      duplicate_events: 1,
    });
  });

  it("verifies the raw Plaid webhook, deduplicates delivery, and rejects body tampering", async () => {
    await connectPlaid();
    const payload = JSON.stringify({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "item-sandbox",
      environment: "sandbox",
    });
    const signature = await fakePlaid.signWebhook(payload);
    const first = await app.inject({
      method: "POST",
      url: "/v1/plaid/webhook",
      payload,
      headers: {
        "content-type": "application/json",
        "plaid-verification": signature,
      },
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ accepted: true, duplicate: false });
    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/plaid/webhook",
      payload,
      headers: {
        "content-type": "application/json",
        "plaid-verification": signature,
      },
    });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toEqual({ accepted: true, duplicate: true });
    const followupPayload = JSON.stringify({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "item-sandbox",
      environment: "sandbox",
      sequence: 2,
    });
    const followup = await app.inject({
      method: "POST",
      url: "/v1/plaid/webhook",
      payload: followupPayload,
      headers: {
        "content-type": "application/json",
        "plaid-verification": await fakePlaid.signWebhook(followupPayload),
      },
    });
    expect(followup.statusCode).toBe(202);
    const queued = await admin.query<{ receipts: number; jobs: number }>("select (select count(*)::int from webhook_receipts where household_id = $1) receipts, (select count(*)::int from plaid_sync_jobs where household_id = $1 and trigger = 'webhook') jobs", [ids.householdA]);
    expect(queued.rows[0]).toEqual({ receipts: 2, jobs: 1 });
    const tampered = await app.inject({
      method: "POST",
      url: "/v1/plaid/webhook",
      payload: payload.replace("SYNC_UPDATES_AVAILABLE", "DEFAULT_UPDATE"),
      headers: {
        "content-type": "application/json",
        "plaid-verification": signature,
      },
    });
    expect(tampered.statusCode).toBe(403);
    const expired = await fakePlaid.signWebhook(payload, Math.floor(Date.now() / 1_000) - 301);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/plaid/webhook",
          payload,
          headers: {
            "content-type": "application/json",
            "plaid-verification": expired,
          },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("converges local revocation when Plaid reports permission already revoked", async () => {
    const connected = bootstrapResponseSchema.parse((await connectPlaid()).json());
    const connection = connected.connections.find((item) => item.provider === "plaid")!;
    const payload = JSON.stringify({
      webhook_type: "ITEM",
      webhook_code: "USER_PERMISSION_REVOKED",
      item_id: "item-sandbox",
      environment: "sandbox",
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/plaid/webhook",
      payload,
      headers: {
        "content-type": "application/json",
        "plaid-verification": await fakePlaid.signWebhook(payload),
      },
    });
    expect(response.statusCode).toBe(202);
    expect(await processQueued(connection.id, "revoke")).toBe(true);
    const bootstrap = bootstrapResponseSchema.parse((await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json());
    expect(bootstrap.connections.find((item) => item.id === connection.id)?.status).toBe("revoked");
    expect((await admin.query<{ token: Buffer | null }>("select encrypted_access_token token from connections where id = $1", [connection.id])).rows[0]!.token).toBeNull();
  });

  it("keeps webhook revocation durable across a worker crash and converges on retry", async () => {
    const connected = bootstrapResponseSchema.parse((await connectPlaid()).json());
    const connection = connected.connections.find((item) => item.provider === "plaid")!;
    const payload = JSON.stringify({
      webhook_type: "ITEM",
      webhook_code: "USER_PERMISSION_REVOKED",
      item_id: "item-sandbox",
      environment: "sandbox",
    });
    const signature = await fakePlaid.signWebhook(payload);
    await admin.query(`create function test_block_revocation() returns trigger language plpgsql as $$ begin if new.status = 'revoked' then raise exception 'simulated crash boundary'; end if; return new; end $$`);
    await admin.query("create trigger test_block_revocation before update on connections for each row execute function test_block_revocation()");
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/plaid/webhook",
            payload,
            headers: {
              "content-type": "application/json",
              "plaid-verification": signature,
            },
          })
        ).statusCode,
      ).toBe(202);
      expect(await processQueued(connection.id, "revoke")).toBe(false);
      const interrupted = await admin.query<{
        receipts: number;
        status: string;
        token_present: boolean;
      }>("select (select count(*)::int from webhook_receipts) receipts, status, encrypted_access_token is not null token_present from connections where id = $1", [connection.id]);
      expect(interrupted.rows[0]).toEqual({
        receipts: 1,
        status: "revocation_pending",
        token_present: true,
      });
    } finally {
      await admin.query("drop trigger if exists test_block_revocation on connections");
      await admin.query("drop function if exists test_block_revocation()");
    }
    expect((await inject("POST", `/v1/plaid/connections/${connection.id}/disconnect`, {}, "dev|maya")).statusCode).toBe(201);
    expect(await processQueued(connection.id, "revoke")).toBe(true);
    const converged = await admin.query<{
      receipts: number;
      status: string;
      token_present: boolean;
    }>("select (select count(*)::int from webhook_receipts) receipts, status, encrypted_access_token is not null token_present from connections where id = $1", [connection.id]);
    expect(converged.rows[0]).toEqual({
      receipts: 1,
      status: "revoked",
      token_present: false,
    });
  });

  it("restarts pagination from the committed cursor and fails closed on token tampering", async () => {
    const connected = bootstrapResponseSchema.parse((await connectPlaid()).json());
    const connection = connected.connections.find((item) => item.provider === "plaid")!;
    fakePlaid.syncCallCursors.length = 0;
    fakePlaid.pages.set(
      "cursor-initial",
      syncPage({
        nextCursor: "page-2",
        hasMore: true,
        updateStatus: "NOT_READY",
      }),
    );
    fakePlaid.pages.set(
      "page-2",
      syncPage({
        nextCursor: "cursor-after-restart",
        updateStatus: "HISTORICAL_UPDATE_COMPLETE",
      }),
    );
    fakePlaid.mutationFailuresRemaining = 1;
    const converged = await inject("POST", `/v1/plaid/connections/${connection.id}/sync`, {}, "dev|maya");
    expect(converged.statusCode).toBe(201);
    expect(await processQueued(connection.id)).toBe(true);
    expect(fakePlaid.syncCallCursors).toEqual(["cursor-initial", "page-2", "cursor-initial", "page-2"]);
    expect(bootstrapResponseSchema.parse((await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json()).connections.find((item) => item.id === connection.id)?.historicalUpdateComplete).toBe(true);

    await admin.query("update connections set encrypted_access_token = set_byte(encrypted_access_token, 0, 0) where id = $1", [connection.id]);
    const failedClosed = await inject("POST", `/v1/plaid/connections/${connection.id}/sync`, {}, "dev|maya");
    expect(failedClosed.statusCode).toBe(201);
    expect(await processQueued(connection.id)).toBe(false);
    const failedBootstrap = bootstrapResponseSchema.parse((await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json());
    expect(failedBootstrap.connections.find((item) => item.id === connection.id)).toMatchObject({ status: "error", errorCode: "Error" });
    const cursor = await admin.query<{ sync_cursor: string }>("select sync_cursor from connections where id = $1", [connection.id]);
    expect(cursor.rows[0]!.sync_cursor).toBe("cursor-after-restart");
  });

  it("keeps accounts excluded while provider revocation retries durably", async () => {
    const connected = bootstrapResponseSchema.parse((await connectPlaid()).json());
    const connection = connected.connections.find((item) => item.provider === "plaid")!;
    fakePlaid.removeFailuresRemaining = 1;
    const pending = await inject("POST", `/v1/plaid/connections/${connection.id}/disconnect`, {}, "dev|maya");
    expect(pending.statusCode).toBe(201);
    const pendingBody = bootstrapResponseSchema.parse(pending.json());
    expect(pendingBody.connections.find((item) => item.id === connection.id)?.status).toBe("revocation_pending");
    expect(pendingBody.accounts.filter((account) => account.connectionId === connection.id).every((account) => !account.includeInPlan)).toBe(true);
    const job = await admin.query<{ id: string }>("select id from plaid_sync_jobs where connection_id = $1 and operation = 'revoke' and state = 'queued'", [connection.id]);
    expect(await app.get(PlaidService).processJob(job.rows[0]!.id, ids.householdA)).toBe(false);
    await admin.query("update plaid_sync_jobs set available_at=now() where id=$1", [job.rows[0]!.id]);
    fakePlaid.alreadyRemovedOnNext = true;
    expect(await app.get(PlaidService).processJob(job.rows[0]!.id, ids.householdA)).toBe(true);
    const revoked = bootstrapResponseSchema.parse((await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json());
    expect(revoked.connections.find((item) => item.id === connection.id)?.status).toBe("revoked");
    expect((await admin.query<{ token: Buffer | null }>("select encrypted_access_token token from connections where id = $1", [connection.id])).rows[0]!.token).toBeNull();
  });

  it("reports a stored Item as connected but not synchronized when the initial job must retry", async () => {
    const link = await inject("POST", "/v1/plaid/link-token", { mode: "create" }, "dev|maya");
    fakePlaid.pages.clear();
    const payload = {
      sessionId: link.json().sessionId,
      publicToken: "public-sync-failure",
      requestId: uuidv7(),
    };
    const result = await inject("POST", "/v1/plaid/exchange", payload, "dev|maya");
    expect(result.statusCode).toBe(201);
    const connection = bootstrapResponseSchema.parse(result.json()).connections.find((item) => item.provider === "plaid")!;
    expect(connection).toMatchObject({
      status: "syncing",
      initialUpdateComplete: false,
    });
    expect(await processQueued(connection.id)).toBe(false);
    expect(fakePlaid.removedTokens).toEqual([]);
    expect((await inject("POST", "/v1/plaid/exchange", { ...payload, requestId: uuidv7() }, "dev|maya")).statusCode).toBe(201);
    expect(fakePlaid.exchangeCalls).toBe(1);
    const bootstrap = bootstrapResponseSchema.parse((await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json());
    expect(bootstrap.connections.find((item) => item.provider === "plaid")).toMatchObject({ status: "error", initialUpdateComplete: false });
    expect(bootstrap.accounts.find((item) => item.provenance === "plaid")).toMatchObject({
      balance: { minor: "120034", currency: "USD" },
      includeInPlan: false,
      coverage: "excluded",
    });
  });

  it("reports a completed update session while keeping its failed sync visible", async () => {
    const connected = bootstrapResponseSchema.parse((await connectPlaid()).json());
    const connection = connected.connections.find((item) => item.provider === "plaid")!;
    const link = await inject("POST", "/v1/plaid/link-token", { mode: "update", connectionId: connection.id }, "dev|maya");
    fakePlaid.pages.clear();
    const payload = {
      sessionId: link.json().sessionId,
      linkSessionId: "update-link-session",
      requestId: uuidv7(),
    };
    expect((await inject("POST", "/v1/plaid/update-complete", payload, "dev|maya")).statusCode).toBe(201);
    expect((await inject("POST", "/v1/plaid/update-complete", { ...payload, requestId: uuidv7() }, "dev|maya")).statusCode).toBe(201);
    expect(await processQueued(connection.id)).toBe(false);
    const state = bootstrapResponseSchema.parse((await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json());
    expect(state.connections.find((item) => item.id === connection.id)?.status).toBe("error");
  });

  it("runs an explicitly requested sync immediately even when an older retry is backed off", async () => {
    const connected = bootstrapResponseSchema.parse((await connectPlaid()).json());
    const connection = connected.connections.find((item) => item.provider === "plaid")!;
    fakePlaid.pages.set(
      "cursor-initial",
      syncPage({
        nextCursor: "cursor-refreshed",
        updateStatus: "HISTORICAL_UPDATE_COMPLETE",
      }),
    );
    const delayedJobId = uuidv7();
    await admin.query("insert into plaid_sync_jobs(id,household_id,connection_id,operation,trigger,state,available_at) values($1,$2,$3,'sync','recovery','queued',now()+interval '1 hour')", [delayedJobId, ids.householdA, connection.id]);
    const refreshed = await inject("POST", `/v1/plaid/connections/${connection.id}/sync`, {}, "dev|maya");
    expect(refreshed.statusCode).toBe(201);
    expect(bootstrapResponseSchema.parse(refreshed.json()).connections.find((item) => item.id === connection.id)?.status).toBe("syncing");
    expect(await app.get(PlaidService).processJob(delayedJobId, ids.householdA)).toBe(true);
    expect((await admin.query<{ state: string }>("select state from plaid_sync_jobs where id=$1", [delayedJobId])).rows[0]?.state).toBe("succeeded");
  });

  it("accepts a manual sync when another worker already owns the durable job", async () => {
    const connected = bootstrapResponseSchema.parse((await connectPlaid()).json());
    const connection = connected.connections.find((item) => item.provider === "plaid")!;
    await admin.query("insert into plaid_sync_jobs(id,household_id,connection_id,operation,trigger,state,available_at,locked_at) values($1,$2,$3,'sync','scheduled','running',now(),now())", [uuidv7(), ids.householdA, connection.id]);
    const accepted = await inject("POST", `/v1/plaid/connections/${connection.id}/sync`, {}, "dev|maya");
    expect(accepted.statusCode).toBe(201);
    expect(bootstrapResponseSchema.parse(accepted.json()).connections.find((item) => item.id === connection.id)?.status).toBe("syncing");
  });

  it("allows the same public token to recover a stale pre-consumption exchange attempt", async () => {
    const link = await inject("POST", "/v1/plaid/link-token", { mode: "create" }, "dev|maya");
    const publicToken = "public-stale-recovery";
    await admin.query("update plaid_link_sessions set status = 'exchanging', public_token_hash = $1, exchange_started_at = now() - interval '3 minutes' where id = $2", [createHash("sha256").update(publicToken).digest("hex"), link.json().sessionId]);
    const recovered = await inject("POST", "/v1/plaid/exchange", { sessionId: link.json().sessionId, publicToken, requestId: uuidv7() }, "dev|maya");
    expect(recovered.statusCode).toBe(201);
    const connection = bootstrapResponseSchema.parse(recovered.json()).connections.find((item) => item.provider === "plaid")!;
    expect(connection.status).toBe("syncing");
    expect(await processQueued(connection.id)).toBe(true);
  });

  it("completes a tenant-bound native Hosted Link session server-side", async () => {
    const link = await inject("POST", "/v1/plaid/link-token", { mode: "create", nativeHosted: true }, "dev|maya");
    expect(link.statusCode).toBe(201);
    expect(link.json().hostedLinkUrl).toBe("https://secure.plaid.test/hosted-link");
    expect(fakePlaid.nativeCompletionUri).toContain("budgefi://open/plaid-complete?session_id=");

    const mismatched = await inject(
      "POST",
      "/v1/plaid/hosted-complete",
      {
        sessionId: link.json().sessionId,
        linkToken: "another-link-token",
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(mismatched.statusCode).toBe(403);

    const completed = await inject(
      "POST",
      "/v1/plaid/hosted-complete",
      {
        sessionId: link.json().sessionId,
        linkToken: link.json().linkToken,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(completed.statusCode).toBe(201);
    expect(bootstrapResponseSchema.parse(completed.json()).connections.find((item) => item.provider === "plaid")?.institutionName).toBe("First Platypus Bank");
  });

  function inject(method: "GET" | "POST" | "PUT", url: string, payload: unknown, subject: string, householdId?: string) {
    return app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload: payload as object }),
      headers: {
        "x-dev-auth-subject": subject,
        ...(householdId ? { "x-household-id": householdId } : {}),
      },
    });
  }

  async function connectPlaid() {
    const link = await inject("POST", "/v1/plaid/link-token", { mode: "create" }, "dev|maya");
    const exchanged = await inject(
      "POST",
      "/v1/plaid/exchange",
      {
        sessionId: link.json().sessionId,
        publicToken: "public-sandbox-token",
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    const connection = bootstrapResponseSchema.parse(exchanged.json()).connections.find((item) => item.provider === "plaid")!;
    expect(await processQueued(connection.id)).toBe(true);
    return inject("GET", "/v1/bootstrap", undefined, "dev|maya");
  }

  async function processQueued(connectionId: string, operation: "sync" | "revoke" = "sync") {
    const job = await admin.query<{ id: string }>("select id from plaid_sync_jobs where connection_id=$1 and operation=$2 and state='queued' order by created_at limit 1", [connectionId, operation]);
    expect(job.rows[0]?.id).toBeTruthy();
    return app.get(PlaidService).processJob(job.rows[0]!.id, ids.householdA);
  }
});

class FakePlaidGateway {
  readonly pages = new Map<string, PlaidSyncPage>();
  readonly removedTokens: string[] = [];
  readonly syncCallCursors: string[] = [];
  exchangeCalls = 0;
  mutationFailuresRemaining = 0;
  removeFailuresRemaining = 0;
  alreadyRemovedOnNext = false;
  nativeCompletionUri: string | null = null;
  linkCalls = 0;
  uniqueItems = false;
  private readonly privateKey: KeyObject;
  private readonly publicJwk: JWK;

  constructor() {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = pair.privateKey;
    this.publicJwk = {
      ...(pair.publicKey.export({ format: "jwk" }) as JWK),
      kid: "test-plaid-key",
      alg: "ES256",
      use: "sig",
    };
    this.reset();
  }

  reset(): void {
    this.pages.clear();
    this.removedTokens.length = 0;
    this.syncCallCursors.length = 0;
    this.exchangeCalls = 0;
    this.mutationFailuresRemaining = 0;
    this.removeFailuresRemaining = 0;
    this.alreadyRemovedOnNext = false;
    this.nativeCompletionUri = null;
    this.linkCalls = 0;
    this.uniqueItems = false;
    this.pages.set(
      "<initial>",
      syncPage({
        added: [plaidTransaction({})],
        nextCursor: "cursor-initial",
        updateStatus: "INITIAL_UPDATE_COMPLETE",
      }),
    );
  }

  async createLinkToken(input?: { nativeCompletionUri?: string }): Promise<{
    linkToken: string;
    expiration: string;
    requestId: string;
    hostedLinkUrl?: string;
  }> {
    this.linkCalls += 1;
    this.nativeCompletionUri = input?.nativeCompletionUri ?? null;
    return {
      linkToken: `link-sandbox-token-${this.linkCalls}`,
      expiration: new Date(Date.now() + 30 * 60_000).toISOString(),
      requestId: "link-request",
      ...(input?.nativeCompletionUri ? { hostedLinkUrl: "https://secure.plaid.test/hosted-link" } : {}),
    };
  }
  async getHostedCompletion(): Promise<{
    state: "success";
    linkSessionId: string;
    publicToken: string;
    institution: { id: string; name: string };
  }> {
    return {
      state: "success",
      linkSessionId: "hosted-link-session",
      publicToken: "public-hosted-token",
      institution: { id: "ins_109508", name: "First Platypus Bank" },
    };
  }
  async exchangePublicToken(): Promise<{
    accessToken: string;
    itemId: string;
    requestId: string;
  }> {
    this.exchangeCalls += 1;
    const suffix = this.uniqueItems ? `-${this.exchangeCalls}` : "";
    return {
      accessToken: `access-sandbox-token${suffix}`,
      itemId: `item-sandbox${suffix}`,
      requestId: "exchange-request",
    };
  }
  async getAccounts(): Promise<{
    accounts: AccountBase[];
    institutionId: string;
    requestId: string;
  }> {
    return {
      accounts: [plaidAccount()],
      institutionId: "ins_109508",
      requestId: "accounts-request",
    };
  }
  async getInstitutionName(): Promise<string> {
    return "First Platypus Bank";
  }
  async syncTransactions(_token: string, cursor: string | null): Promise<PlaidSyncPage> {
    this.syncCallCursors.push(cursor ?? "<initial>");
    if (cursor === "page-2" && this.mutationFailuresRemaining > 0) {
      this.mutationFailuresRemaining -= 1;
      throw new PlaidRequestError("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", "mutation-request", true);
    }
    const page = this.pages.get(cursor ?? "<initial>");
    if (!page) throw new PlaidRequestError("MISSING_FAKE_PAGE", null, false);
    return page;
  }
  async removeItem(token: string): Promise<{ requestId: string }> {
    if (this.removeFailuresRemaining > 0) {
      this.removeFailuresRemaining -= 1;
      throw new PlaidRequestError("INSTITUTION_DOWN", "remove-failure", true);
    }
    if (this.alreadyRemovedOnNext) {
      this.alreadyRemovedOnNext = false;
      throw new PlaidRequestError("ITEM_NOT_FOUND", "already-removed", false);
    }
    this.removedTokens.push(token);
    return { requestId: "remove-request" };
  }
  async getWebhookVerificationKey(): Promise<Record<string, unknown>> {
    return this.publicJwk as Record<string, unknown>;
  }
  async signWebhook(body: string, issuedAt?: number): Promise<string> {
    return new SignJWT({
      request_body_sha256: createHash("sha256").update(body).digest("hex"),
    })
      .setProtectedHeader({ alg: "ES256", kid: "test-plaid-key" })
      .setIssuedAt(issuedAt)
      .sign(this.privateKey);
  }
}

function plaidAccount(): AccountBase {
  return {
    account_id: "plaid-checking",
    balances: {
      available: 1200.34,
      current: 1200.34,
      limit: null,
      iso_currency_code: "USD",
      unofficial_currency_code: null,
    },
    mask: "1234",
    name: "Everyday checking",
    official_name: "Everyday Checking",
    persistent_account_id: "persistent-checking",
    type: "depository",
    subtype: "checking",
    verification_status: null,
  } as unknown as AccountBase;
}

function plaidTransaction(overrides: Partial<Transaction>): Transaction {
  return {
    account_id: "plaid-checking",
    account_owner: null,
    amount: 8.25,
    authorized_date: "2026-08-31",
    authorized_datetime: null,
    category: null,
    category_id: null,
    check_number: null,
    counterparties: [],
    date: "2026-08-31",
    datetime: null,
    iso_currency_code: "USD",
    location: {
      address: null,
      city: null,
      region: null,
      postal_code: null,
      country: null,
      lat: null,
      lon: null,
      store_number: null,
    },
    logo_url: null,
    merchant_entity_id: null,
    merchant_name: "Coffee Lab",
    name: "Coffee Lab",
    original_description: null,
    payment_channel: "in store",
    payment_meta: {
      by_order_of: null,
      payee: null,
      payer: null,
      payment_method: null,
      payment_processor: null,
      ppd_id: null,
      reason: null,
      reference_number: null,
    },
    pending: true,
    pending_transaction_id: null,
    personal_finance_category: null,
    personal_finance_category_icon_url: null,
    transaction_code: null,
    transaction_id: "pending-coffee",
    website: null,
    ...overrides,
  } as Transaction;
}

function syncPage(overrides: Partial<PlaidSyncPage>): PlaidSyncPage {
  return {
    added: [],
    modified: [],
    removed: [],
    nextCursor: "cursor",
    hasMore: false,
    updateStatus: "INITIAL_UPDATE_COMPLETE",
    requestId: `request-${uuidv7()}`,
    ...overrides,
  };
}

async function resetFixture(client: pg.Client): Promise<void> {
  await client.query("TRUNCATE case_evidence, exception_cases, sync_runs, webhook_receipts, connections, idempotency_records, activity_events, calculation_snapshots, financial_transactions, balance_observations, commitments, plans, accounts, household_memberships, households, users RESTART IDENTITY CASCADE");
  for (const [userId, subject, name] of [
    [ids.userA, "dev|maya", "Maya"],
    [ids.userB, "dev|riley", "Riley"],
  ])
    await client.query("INSERT INTO users (id, auth_subject, display_name) VALUES ($1, $2, $3)", [userId, subject, name]);
  for (const [householdId, userId, name] of [
    [ids.householdA, ids.userA, "Maya household"],
    [ids.householdB, ids.userB, "Riley household"],
  ]) {
    await client.query("INSERT INTO households (id, name, timezone, base_currency) VALUES ($1, $2, 'America/New_York', 'USD')", [householdId, name]);
    await client.query("INSERT INTO household_memberships (household_id, user_id, role, onboarding_completed_at) VALUES ($1, $2, 'owner', now())", [householdId, userId]);
  }
  for (const [accountId, householdId, amount] of [
    [ids.accountA, ids.householdA, "423039"],
    [ids.accountB, ids.householdB, "100000"],
  ]) {
    await client.query("INSERT INTO accounts (id, household_id, name, account_type, currency, provenance, include_in_plan) VALUES ($1, $2, 'Manual cash', 'cash', 'USD', 'manual', true)", [accountId, householdId]);
    await client.query("INSERT INTO balance_observations (household_id, account_id, amount_minor, currency, provenance, as_of, source_record_id) VALUES ($1, $2, $3, 'USD', 'manual', '2026-08-29T12:00:00Z', 'fixture-v1')", [householdId, accountId, amount]);
  }
  await client.query("INSERT INTO plans (id, household_id, planned_savings_minor, safety_buffer_minor, currency, calculation_policy_version) VALUES ($1, $2, 50000, 28000, 'USD', 'safe-to-spend/v1'), ($3, $4, 0, 0, 'USD', 'safe-to-spend/v1')", [ids.planA, ids.householdA, ids.planB, ids.householdB]);
  const commitments = [
    ["Rent", "185000", "2026-09-01"],
    ["Electric", "15500", "2026-09-04"],
    ["Subscriptions", "1899", "2026-09-06"],
    ["Insurance", "14240", "2026-09-08"],
  ];
  for (const [name, amount, dueDate] of commitments) await client.query("INSERT INTO commitments (household_id, name, amount_minor, currency, due_date, provenance) VALUES ($1, $2, $3, 'USD', $4, 'manual')", [ids.householdA, name, amount, dueDate]);
}

function plusDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function householdDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
