import "reflect-metadata";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { SignJWT, type JWK } from "jose";
import pg from "pg";
import type { AccountBase, Transaction } from "plaid";
import { v7 as uuidv7 } from "uuid";
import {
  bootstrapResponseSchema,
  accountExportResponseSchema,
  featureFlagsResponseSchema,
  notificationPreferencesSchema,
  payCycleDetailResponseSchema,
  payCycleListResponseSchema,
  transactionFeedResponseSchema,
} from "../packages/contracts/src/index.js";
import { onboardingAnalysisResponseSchema } from "../packages/contracts/src/index.js";
import {
  PlaidRequestError,
  type PlaidSyncPage,
} from "../apps/api/src/plaid/plaid.gateway.js";
import { PlaidService } from "../apps/api/src/plaid/plaid.service.js";
import { OperationsService } from "../apps/api/src/operations/operations.service.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl)
  throw new Error(
    "TEST_DATABASE_URL is required; PostgreSQL integration tests must never be skipped",
  );
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
    process.env.PLAID_REDIRECT_URI =
      "https://app.budgefi.test/open/plaid-oauth";
    process.env.PLAID_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString(
      "base64",
    );
    process.env.PLAID_WORKER_DISABLED = "true";
    process.env.OPENAI_FINANCE_ENABLED = "false";
    process.env.FEATURE_ONBOARDING_AI = "true";
    process.env.FEATURE_HOUSEHOLD_MODE = "false";
    process.env.CLERK_WEBHOOK_SIGNING_SECRET = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
    admin = new pg.Client({ connectionString: testDatabaseUrl });
    await admin.connect();
    await admin.query("DROP ROLE IF EXISTS budgefi_runtime_test");
    await admin.query("DROP ROLE IF EXISTS budgefi_function_owner_test");
    await admin.query(
      `CREATE ROLE budgefi_runtime_test LOGIN PASSWORD '${testRuntimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS IN ROLE budgefi_app, budgefi_plaid_worker`,
    );
    await admin.query(
      "CREATE ROLE budgefi_function_owner_test NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS",
    );
    await admin.query(
      "GRANT USAGE ON SCHEMA public TO budgefi_function_owner_test",
    );
    await admin.query(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO budgefi_function_owner_test",
    );
    await admin.query(
      "ALTER FUNCTION provision_principal(text,text,text) OWNER TO budgefi_function_owner_test",
    );
    await admin.query(
      "ALTER FUNCTION resolve_principal(text,uuid) OWNER TO budgefi_function_owner_test",
    );
    await admin.query(
      "ALTER FUNCTION resolve_system_household_actor(uuid) OWNER TO budgefi_function_owner_test",
    );
    await admin.query(
      "GRANT EXECUTE ON FUNCTION provision_principal(text,text,text), resolve_principal(text,uuid) TO budgefi_app",
    );
    await admin.query(
      "GRANT EXECUTE ON FUNCTION resolve_system_household_actor(uuid) TO budgefi_plaid_worker",
    );
    const runtimeUrl = new URL(testDatabaseUrl);
    runtimeUrl.username = "budgefi_runtime_test";
    runtimeUrl.password = testRuntimePassword;
    process.env.RUNTIME_DATABASE_URL = runtimeUrl.toString();
    await resetFixture(admin);
    const [{ AppModule }, { ErrorFilter }, { PlaidGateway }] =
      await Promise.all([
        import("../apps/api/src/app.module.js"),
        import("../apps/api/src/http/error.filter.js"),
        import("../apps/api/src/plaid/plaid.gateway.js"),
      ]);
    fakePlaid = new FakePlaidGateway();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PlaidGateway)
      .useValue(fakePlaid)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
      { logger: ["error"], rawBody: true },
    );
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

  it("saves quiet, versioned reminder choices with optimistic concurrency", async () => {
    const loaded = await inject(
      "GET",
      "/v1/notifications/preferences",
      undefined,
      "dev|maya",
    );
    expect(loaded.statusCode, loaded.body).toBe(200);
    const current = notificationPreferencesSchema.parse(loaded.json());
    expect(current).toMatchObject({
      version: 1,
      commitmentReminderDays: [3],
      longTermReminderDays: [7],
      savingsReminderDays: [0],
    });
    const { version, emailVerified: _, ...editable } = current;
    const payload = {
      ...editable,
      expectedVersion: version,
      availableCashAlerts: true,
      availableCashThreshold: { minor: "150000", currency: "USD" as const },
      commitmentReminderDays: [7, 1],
      reminderHour: 8,
      reminderMinute: 30,
      requestId: uuidv7(),
    };
    const saved = await inject(
      "PUT",
      "/v1/notifications/preferences",
      payload,
      "dev|maya",
    );
    expect(saved.statusCode, saved.body).toBe(200);
    expect(notificationPreferencesSchema.parse(saved.json())).toMatchObject({
      version: 2,
      commitmentReminderDays: [7, 1],
      reminderHour: 8,
      reminderMinute: 30,
      availableCashAlerts: true,
      availableCashThreshold: { minor: "150000", currency: "USD" },
    });
    expect(
      (
        await inject(
          "PUT",
          "/v1/notifications/preferences",
          payload,
          "dev|maya",
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await inject(
          "PUT",
          "/v1/notifications/preferences",
          { ...payload, requestId: uuidv7() },
          "dev|maya",
        )
      ).statusCode,
    ).toBe(409);
  });

  it("does not invalidate a freshly loaded notification version while confirming the same email", async () => {
    const operations = app.get(OperationsService);
    const identity = {
      authSubject: "dev|maya",
      email: "maya@example.com",
    };
    const current = await operations.getPreferences(identity);
    const { version, emailVerified: _, ...editable } = current;
    const saved = await operations.updatePreferences(identity, {
      ...editable,
      expectedVersion: version,
      weeklyDigest: !editable.weeklyDigest,
      requestId: uuidv7(),
    });
    expect(saved.version).toBe(version + 1);
    expect(saved.weeklyDigest).toBe(!editable.weeklyDigest);
  });

  it("returns an authoritative integer-money projection", async () => {
    const response = await inject(
      "GET",
      "/v1/bootstrap",
      undefined,
      "dev|maya",
    );
    expect(response.statusCode).toBe(200);
    const body = bootstrapResponseSchema.parse(response.json());
    expect(body.plan.knownCash.minor).toBe("423039");
    expect(body.plan.reserved.minor).toBe("294639");
    expect(body.plan.available.minor).toBe("128400");
    expect(body.plan.freshness.status).toBe("manual");
  });

  it("tracks multiple income schedules independently and uses the earliest reliable date", async () => {
    const today = householdDate();
    const create = async (name: string, days: number, requestId = uuidv7()) => {
      const date = plusDays(today, days);
      const response = await inject(
        "POST",
        "/v1/income-schedules",
        {
          destinationAccountId: ids.accountA,
          name,
          expectedAmount: {
            minor: days === 5 ? "70000" : "120000",
            currency: "USD",
          },
          frequency: "biweekly",
          nextExpectedDate: date,
          confirmed: true,
          anchorDay: Number(date.slice(8, 10)),
          anchorEndOfMonth: false,
          secondAnchorDay: null,
          secondAnchorEndOfMonth: false,
          requestId,
        },
        "dev|maya",
      );
      expect(response.statusCode).toBe(201);
      return bootstrapResponseSchema.parse(response.json());
    };
    await create("Consulting", 12);
    let current = await create("Day job", 5);
    expect(current.plan.incomeSchedules).toHaveLength(2);
    const early = current.plan.incomeSchedules.find(
      (item) => item.name === "Day job",
    )!;
    const later = current.plan.incomeSchedules.find(
      (item) => item.name === "Consulting",
    )!;
    expect(current.plan.horizonIncomeScheduleId).toBe(early.id);
    expect(current.plan.horizonEnd).toBe(plusDays(today, 5));
    expect(current.plan.knownCash.minor).toBe("423039");
    expect(BigInt(current.plan.available.minor)).toBe(
      BigInt(current.plan.knownCash.minor) -
        BigInt(current.plan.reserved.minor),
    );
    expect(
      current.plan.occurrences
        .filter((item) => item.kind === "income")
        .map((item) => item.incomeScheduleId)
        .sort(),
    ).toEqual([early.id, later.id].sort());

    const paused = await inject(
      "PUT",
      `/v1/income-schedules/${early.id}`,
      {
        destinationAccountId: early.destinationAccountId,
        name: early.name,
        expectedAmount: early.expectedAmount,
        frequency: early.frequency,
        nextExpectedDate: early.nextExpectedDate,
        confirmed: early.confirmed,
        anchorDay: early.anchorDay,
        anchorEndOfMonth: early.anchorEndOfMonth,
        secondAnchorDay: early.secondAnchorDay,
        secondAnchorEndOfMonth: early.secondAnchorEndOfMonth,
        status: "paused",
        expectedVersion: early.version,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(paused.statusCode).toBe(200);
    current = bootstrapResponseSchema.parse(paused.json());
    expect(current.plan.horizonIncomeScheduleId).toBe(later.id);
    expect(current.plan.horizonEnd).toBe(plusDays(today, 12));

    const invalid = await inject(
      "POST",
      "/v1/income-schedules",
      {
        destinationAccountId: null,
        name: "Uncertain work",
        expectedAmount: null,
        frequency: "irregular",
        nextExpectedDate: null,
        confirmed: true,
        anchorDay: null,
        anchorEndOfMonth: false,
        secondAnchorDay: null,
        secondAnchorEndOfMonth: false,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(invalid.statusCode).toBe(400);
  });

  it("fails ambiguous connected income visibly and lets the user choose exactly one schedule", async () => {
    const today = householdDate();
    fakePlaid.pages.set(
      "<initial>",
      syncPage({
        nextCursor: "income-ambiguous",
        updateStatus: "INITIAL_UPDATE_COMPLETE",
      }),
    );
    let current = bootstrapResponseSchema.parse((await connectPlaid()).json());
    const connection = current.connections.find(
      (item) => item.provider === "plaid",
    )!;
    let depositAccount = current.accounts.find(
      (item) => item.provenance === "plaid",
    )!;
    current = bootstrapResponseSchema.parse(
      (
        await inject(
          "PUT",
          `/v1/accounts/${depositAccount.id}/inclusion`,
          {
            includeInPlan: true,
            expectedVersion: depositAccount.version,
            requestId: uuidv7(),
          },
          "dev|maya",
        )
      ).json(),
    );
    depositAccount = current.accounts.find(
      (item) => item.id === depositAccount.id,
    )!;
    for (const name of ["Employer A", "Employer B"]) {
      const created = await inject(
        "POST",
        "/v1/income-schedules",
        {
          destinationAccountId: depositAccount.id,
          name,
          expectedAmount: { minor: "10000", currency: "USD" },
          frequency: "biweekly",
          nextExpectedDate: today,
          confirmed: true,
          anchorDay: Number(today.slice(8, 10)),
          anchorEndOfMonth: false,
          secondAnchorDay: null,
          secondAnchorEndOfMonth: false,
          requestId: uuidv7(),
        },
        "dev|maya",
      );
      expect(created.statusCode, created.body).toBe(201);
    }
    fakePlaid.pages.set(
      "income-ambiguous",
      syncPage({
        added: [
          plaidTransaction({
            transaction_id: "ambiguous-payroll",
            pending: false,
            amount: -100,
            date: today,
            authorized_date: today,
            name: "Payroll",
            merchant_name: "Payroll",
            personal_finance_category: {
              primary: "INCOME",
              detailed: "INCOME_WAGES",
              confidence_level: "VERY_HIGH",
            } as NonNullable<Transaction["personal_finance_category"]>,
          }),
        ],
        nextCursor: "income-ambiguous-done",
        updateStatus: "HISTORICAL_UPDATE_COMPLETE",
      }),
    );
    expect(
      (
        await inject(
          "POST",
          `/v1/plaid/connections/${connection.id}/sync`,
          {},
          "dev|maya",
        )
      ).statusCode,
    ).toBe(201);
    expect(await processQueued(connection.id)).toBe(true);
    current = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    const candidates = current.plan.occurrences.filter(
      (item) =>
        item.kind === "income" &&
        item.evidence.some((proof) => proof.matchState === "proposed"),
    );
    expect(candidates).toHaveLength(2);
    expect(candidates.every((item) => item.state === "needs_review")).toBe(
      true,
    );
    const feed = transactionFeedResponseSchema.parse(
      (
        await inject(
          "GET",
          "/v1/transactions?query=Payroll",
          undefined,
          "dev|maya",
        )
      ).json(),
    );
    const deposit = feed.items[0]!;
    expect(deposit.linkedOccurrence?.matchState).toBe("proposed");
    const chosen = candidates.find(
      (item) => item.id !== deposit.linkedOccurrence!.id,
    )!;
    const resolved = await inject(
      "POST",
      `/v1/transactions/${deposit.id}/link-occurrence`,
      {
        occurrenceId: chosen.id,
        expectedTransactionVersion: deposit.version,
        expectedOccurrenceVersion: chosen.version,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(resolved.statusCode, resolved.body).toBe(201);
    const states = await admin.query<{ state: string; count: number }>(
      "select state,count(*)::int count from occurrence_transaction_matches where household_id=$1 and transaction_id in (select id from financial_transactions where household_id=$1 and source_record_id='ambiguous-payroll') group by state",
      [ids.householdA],
    );
    expect(
      Object.fromEntries(states.rows.map((row) => [row.state, row.count])),
    ).toEqual({ confirmed: 1, rejected: 1 });
  });

  it("combines split connected deposits and advances the schedule only after both reach a later balance", async () => {
    const today = householdDate();
    fakePlaid.pages.set(
      "<initial>",
      syncPage({
        nextCursor: "split-one",
        updateStatus: "INITIAL_UPDATE_COMPLETE",
      }),
    );
    let current = bootstrapResponseSchema.parse((await connectPlaid()).json());
    const connection = current.connections.find(
      (item) => item.provider === "plaid",
    )!;
    let depositAccount = current.accounts.find(
      (item) => item.provenance === "plaid",
    )!;
    current = bootstrapResponseSchema.parse(
      (
        await inject(
          "PUT",
          `/v1/accounts/${depositAccount.id}/inclusion`,
          {
            includeInPlan: true,
            expectedVersion: depositAccount.version,
            requestId: uuidv7(),
          },
          "dev|maya",
        )
      ).json(),
    );
    depositAccount = current.accounts.find(
      (item) => item.id === depositAccount.id,
    )!;
    current = bootstrapResponseSchema.parse(
      (
        await inject(
          "POST",
          "/v1/income-schedules",
          {
            destinationAccountId: depositAccount.id,
            name: "Employer payroll",
            expectedAmount: { minor: "15000", currency: "USD" },
            frequency: "biweekly",
            nextExpectedDate: today,
            confirmed: true,
            anchorDay: Number(today.slice(8, 10)),
            anchorEndOfMonth: false,
            secondAnchorDay: null,
            secondAnchorEndOfMonth: false,
            requestId: uuidv7(),
          },
          "dev|maya",
        )
      ).json(),
    );
    const schedule = current.plan.incomeSchedules.find(
      (item) => item.name === "Employer payroll",
    )!;
    fakePlaid.pages.set(
      "split-one",
      syncPage({
        added: [incomeTransaction("split-pay-1", 50, today)],
        nextCursor: "split-two",
        updateStatus: "HISTORICAL_UPDATE_COMPLETE",
      }),
    );
    await inject(
      "POST",
      `/v1/plaid/connections/${connection.id}/sync`,
      {},
      "dev|maya",
    );
    expect(await processQueued(connection.id)).toBe(true);
    let feed = transactionFeedResponseSchema.parse(
      (
        await inject(
          "GET",
          "/v1/transactions?query=Employer",
          undefined,
          "dev|maya",
        )
      ).json(),
    );
    const firstDeposit = feed.items.find(
      (item) => item.amount.minor === "5000",
    )!;
    expect(firstDeposit.linkedOccurrence?.matchState).toBe("proposed");
    current = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    const occurrence = current.plan.occurrences.find(
      (item) => item.incomeScheduleId === schedule.id,
    )!;
    expect(
      (
        await inject(
          "POST",
          `/v1/transactions/${firstDeposit.id}/link-occurrence`,
          {
            occurrenceId: occurrence.id,
            expectedTransactionVersion: firstDeposit.version,
            expectedOccurrenceVersion: occurrence.version,
            requestId: uuidv7(),
          },
          "dev|maya",
        )
      ).statusCode,
    ).toBe(201);

    fakePlaid.accounts = [plaidAccountWithBalance(1250.34)];
    fakePlaid.pages.set(
      "split-two",
      syncPage({
        added: [incomeTransaction("split-pay-2", 100, today)],
        nextCursor: "split-balance",
        updateStatus: "HISTORICAL_UPDATE_COMPLETE",
      }),
    );
    await inject(
      "POST",
      `/v1/plaid/connections/${connection.id}/sync`,
      {},
      "dev|maya",
    );
    expect(await processQueued(connection.id)).toBe(true);
    current = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(
      current.plan.incomeSchedules.find((item) => item.id === schedule.id)
        ?.nextExpectedDate,
    ).toBe(today);
    expect(
      current.plan.occurrences.find((item) => item.id === occurrence.id)?.state,
    ).toBe("pending");

    fakePlaid.accounts = [plaidAccountWithBalance(1350.34)];
    fakePlaid.pages.set(
      "split-balance",
      syncPage({
        nextCursor: "split-done",
        updateStatus: "HISTORICAL_UPDATE_COMPLETE",
      }),
    );
    await inject(
      "POST",
      `/v1/plaid/connections/${connection.id}/sync`,
      {},
      "dev|maya",
    );
    expect(await processQueued(connection.id)).toBe(true);
    current = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(
      current.plan.occurrences.find((item) => item.id === occurrence.id)?.state,
    ).toBe("verified");
    expect(
      current.plan.incomeSchedules.find((item) => item.id === schedule.id)
        ?.nextExpectedDate,
    ).toBe(plusDays(today, 14));
    const confirmed = await admin.query<{ count: number }>(
      "select count(*)::int count from occurrence_transaction_matches where household_id=$1 and occurrence_id=$2 and state='confirmed'",
      [ids.householdA, occurrence.id],
    );
    expect(confirmed.rows[0]?.count).toBe(2);
    fakePlaid.pages.set(
      "split-done",
      syncPage({
        removed: [
          { transaction_id: "split-pay-2", account_id: "plaid-checking" },
        ],
        nextCursor: "split-reversed",
        updateStatus: "HISTORICAL_UPDATE_COMPLETE",
      }),
    );
    await inject(
      "POST",
      `/v1/plaid/connections/${connection.id}/sync`,
      {},
      "dev|maya",
    );
    expect(await processQueued(connection.id)).toBe(true);
    current = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(
      current.activity.some(
        (item) =>
          item.title === "A previous deposit match was reopened" &&
          item.detail.includes("expected income needs review again"),
      ),
    ).toBe(true);
    expect(
      current.activity.some(
        (item) =>
          item.detail.includes("money is reserved again") &&
          item.title.includes("deposit"),
      ),
    ).toBe(false);
  });

  it("persists a manual balance across independent reads", async () => {
    const requestId = uuidv7();
    const firstPayload = {
      accountId: ids.accountA,
      amount: { minor: "500000" as const, currency: "USD" as const },
      asOf: new Date().toISOString(),
      requestId,
    };
    const saved = await inject(
      "POST",
      "/v1/manual/balances",
      firstPayload,
      "dev|maya",
    );
    expect(saved.statusCode).toBe(201);
    expect(
      bootstrapResponseSchema.parse(saved.json()).plan.knownCash.minor,
    ).toBe("500000");
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
    expect(
      bootstrapResponseSchema.parse(later.json()).plan.knownCash.minor,
    ).toBe("600000");
    const retriedFirst = await inject(
      "POST",
      "/v1/manual/balances",
      firstPayload,
      "dev|maya",
    );
    expect(
      bootstrapResponseSchema.parse(retriedFirst.json()).plan.knownCash.minor,
    ).toBe("600000");
    const refreshed = await inject(
      "GET",
      "/v1/bootstrap",
      undefined,
      "dev|maya",
    );
    expect(
      bootstrapResponseSchema.parse(refreshed.json()).plan.knownCash.minor,
    ).toBe("600000");
  });

  it("pages and searches the complete transaction feed and preserves category corrections", async () => {
    for (let index = 0; index < 55; index++)
      await admin.query(
        `insert into financial_transactions(household_id,account_id,source_kind,source_record_id,merchant,amount_minor,currency,occurred_on,status,direction) values($1,$2,'manual',$3,$4,$5,'USD',$6,'posted','debit')`,
        [
          ids.householdA,
          ids.accountA,
          `feed-${index}`,
          index === 54 ? "Older Special Pharmacy" : `Merchant ${index}`,
          100 + index,
          `2026-07-${String(1 + (index % 28)).padStart(2, "0")}`,
        ],
      );
    const first = transactionFeedResponseSchema.parse(
      (
        await inject("GET", "/v1/transactions?limit=10", undefined, "dev|maya")
      ).json(),
    );
    expect(first.items).toHaveLength(10);
    expect(first.nextCursor).toBeTruthy();
    const second = transactionFeedResponseSchema.parse(
      (
        await inject(
          "GET",
          `/v1/transactions?limit=10&cursor=${encodeURIComponent(first.nextCursor!)}`,
          undefined,
          "dev|maya",
        )
      ).json(),
    );
    expect(
      new Set([...first.items, ...second.items].map((item) => item.id)).size,
    ).toBe(20);
    const searched = transactionFeedResponseSchema.parse(
      (
        await inject(
          "GET",
          "/v1/transactions?query=Special%20Pharmacy",
          undefined,
          "dev|maya",
        )
      ).json(),
    );
    expect(searched.items).toHaveLength(1);
    const item = searched.items[0]!;
    const changed = await inject(
      "PUT",
      `/v1/transactions/${item.id}/category`,
      {
        category: "health",
        expectedVersion: item.categoryVersion,
        applyToFuture: true,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(changed.statusCode).toBe(200);
    const refreshed = transactionFeedResponseSchema.parse(
      (
        await inject(
          "GET",
          "/v1/transactions?query=Special%20Pharmacy",
          undefined,
          "dev|maya",
        )
      ).json(),
    );
    expect(refreshed.items[0]?.category).toBe("health");
    expect(refreshed.items[0]?.categorySource).toBe("user");
    const ruleApplied = await inject(
      "POST",
      "/v1/manual/transactions",
      {
        accountId: ids.accountA,
        merchant: "Older Special Pharmacy",
        amount: { minor: "999", currency: "USD" },
        occurredOn: "2026-09-01",
        direction: "debit",
        balanceIncludesActivity: false,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(ruleApplied.statusCode).toBe(201);
    const matching = transactionFeedResponseSchema.parse(
      (
        await inject(
          "GET",
          "/v1/transactions?query=Special%20Pharmacy",
          undefined,
          "dev|maya",
        )
      ).json(),
    );
    expect(
      matching.items.some(
        (entry) =>
          entry.category === "health" &&
          entry.categorySource === "merchant_rule",
      ),
    ).toBe(true);
    const rules = (
      await inject(
        "GET",
        "/v1/transaction-category-rules",
        undefined,
        "dev|maya",
      )
    ).json().rules as Array<{
      id: string;
      merchant: string;
      category: string;
      version: number;
    }>;
    const rule = rules.find(
      (entry) => entry.merchant === "older special pharmacy",
    )!;
    expect(rule.category).toBe("health");
    const updatedRule = await inject(
      "PUT",
      `/v1/transaction-category-rules/${rule.id}`,
      {
        category: "shopping",
        expectedVersion: rule.version,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(updatedRule.statusCode).toBe(200);
    const updated = updatedRule
      .json()
      .rules.find((entry: { id: string }) => entry.id === rule.id);
    expect(updated).toMatchObject({
      category: "shopping",
      version: rule.version + 1,
    });
    const removedRule = await inject(
      "DELETE",
      `/v1/transaction-category-rules/${rule.id}`,
      {
        expectedVersion: rule.version + 1,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(removedRule.statusCode).toBe(200);
    expect(removedRule.json().rules).toHaveLength(0);
    expect(
      (
        await inject(
          "PUT",
          `/v1/transactions/${item.id}/category`,
          {
            category: "shopping",
            expectedVersion: item.categoryVersion,
            applyToFuture: false,
            requestId: uuidv7(),
          },
          "dev|maya",
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await inject(
          "PUT",
          `/v1/transactions/${item.id}/category`,
          {
            category: "health",
            expectedVersion: item.categoryVersion + 1,
            applyToFuture: false,
            requestId: uuidv7(),
          },
          "dev|riley",
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await inject(
          "GET",
          "/v1/transactions?cursor=definitely-not-a-cursor",
          undefined,
          "dev|maya",
        )
      ).statusCode,
    ).toBe(400);
    const filtered = transactionFeedResponseSchema.parse(
      (
        await inject(
          "GET",
          `/v1/transactions?accountId=${ids.accountA}&category=health&direction=debit&status=posted&from=2026-07-01&to=2026-09-02`,
          undefined,
          "dev|maya",
        )
      ).json(),
    );
    expect(filtered.items.length).toBeGreaterThan(0);
    expect(
      filtered.items.every(
        (entry) =>
          entry.account.id === ids.accountA &&
          entry.category === "health" &&
          entry.direction === "debit" &&
          entry.status === "posted" &&
          entry.occurredOn >= "2026-07-01" &&
          entry.occurredOn <= "2026-09-02",
      ),
    ).toBe(true);
  });

  it("lets users review, correct, and reassign connected plan evidence safely", async () => {
    const insertEvidence = async (
      sourceRecordId: string,
      direction: "debit" | "credit",
      status: "pending" | "posted" = "posted",
    ) => {
      await admin.query(
        "insert into financial_transactions(household_id,account_id,source_kind,source_record_id,merchant,amount_minor,currency,occurred_on,status,direction) values($1,$2,'plaid',$3,$4,185000,'USD','2026-09-01',$5,$6)",
        [
          ids.householdA,
          ids.accountA,
          sourceRecordId,
          `Property ACH ${sourceRecordId}`,
          status,
          direction,
        ],
      );
      const feed = transactionFeedResponseSchema.parse(
        (
          await inject(
            "GET",
            `/v1/transactions?query=${encodeURIComponent(sourceRecordId)}`,
            undefined,
            "dev|maya",
          )
        ).json(),
      );
      return feed.items[0]!;
    };
    const rent = bootstrapResponseSchema
      .parse(
        (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
      )
      .plan.occurrences.find((occurrence) => occurrence.name === "Rent")!;
    const posted = await insertEvidence("review-posted", "debit");
    const payload = {
      occurrenceId: rent.id,
      expectedTransactionVersion: posted.version,
      expectedOccurrenceVersion: rent.version,
      requestId: uuidv7(),
    };
    expect(
      (
        await inject(
          "POST",
          `/v1/transactions/${posted.id}/link-occurrence`,
          { ...payload, expectedTransactionVersion: posted.version + 1 },
          "dev|maya",
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await inject(
          "POST",
          `/v1/transactions/${posted.id}/link-occurrence`,
          { ...payload, expectedOccurrenceVersion: rent.version + 1 },
          "dev|maya",
        )
      ).statusCode,
    ).toBe(409);
    const wrongDirection = await insertEvidence("review-credit", "credit");
    expect(
      (
        await inject(
          "POST",
          `/v1/transactions/${wrongDirection.id}/link-occurrence`,
          {
            ...payload,
            expectedTransactionVersion: wrongDirection.version,
            requestId: uuidv7(),
          },
          "dev|maya",
        )
      ).statusCode,
    ).toBe(409);
    const pending = await insertEvidence("review-pending", "debit", "pending");
    expect(
      (
        await inject(
          "POST",
          `/v1/transactions/${pending.id}/link-occurrence`,
          {
            ...payload,
            expectedTransactionVersion: pending.version,
            requestId: uuidv7(),
          },
          "dev|maya",
        )
      ).statusCode,
    ).toBe(409);
    await admin.query("update accounts set include_in_plan=false where id=$1", [
      ids.accountA,
    ]);
    expect(
      (
        await inject(
          "POST",
          `/v1/transactions/${posted.id}/link-occurrence`,
          { ...payload, requestId: uuidv7() },
          "dev|maya",
        )
      ).statusCode,
    ).toBe(409);
    await admin.query(
      "update accounts set include_in_plan=true,archived_at=now() where id=$1",
      [ids.accountA],
    );
    expect(
      (
        await inject(
          "POST",
          `/v1/transactions/${posted.id}/link-occurrence`,
          { ...payload, requestId: uuidv7() },
          "dev|maya",
        )
      ).statusCode,
    ).toBe(409);
    await admin.query("update accounts set archived_at=null where id=$1", [
      ids.accountA,
    ]);
    const linkedResponse = await inject(
      "POST",
      `/v1/transactions/${posted.id}/link-occurrence`,
      payload,
      "dev|maya",
    );
    expect(linkedResponse.statusCode).toBe(201);
    const linkedBootstrap = bootstrapResponseSchema.parse(
      linkedResponse.json(),
    );
    const linkedRent = linkedBootstrap.plan.occurrences.find(
      (occurrence) => occurrence.id === rent.id,
    )!;
    expect(linkedRent.state).toBe("pending");
    expect(linkedRent.evidence).toEqual([
      expect.objectContaining({
        transactionId: posted.id,
        merchant: "Property ACH review-posted",
        amountApplied: { minor: "185000", currency: "USD" },
      }),
    ]);
    const linkedFeed = transactionFeedResponseSchema.parse(
      (
        await inject(
          "GET",
          `/v1/transactions?transactionId=${posted.id}`,
          undefined,
          "dev|maya",
        )
      ).json(),
    );
    expect(linkedFeed.items[0]?.linkedOccurrence).toMatchObject({
      id: rent.id,
      matchState: "confirmed",
    });
    const activeLink = linkedFeed.items[0]!.linkedOccurrence!;
    expect(
      (
        await inject(
          "POST",
          `/v1/transactions/${posted.id}/link-occurrence`,
          {
            ...payload,
            expectedOccurrenceVersion: linkedRent.version,
            requestId: uuidv7(),
          },
          "dev|maya",
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await inject(
          "POST",
          `/v1/transactions/${posted.id}/unlink-occurrence`,
          {
            expectedTransactionVersion: posted.version,
            expectedOccurrenceId: activeLink.id,
            expectedMatchId: activeLink.matchId,
            expectedMatchVersion: activeLink.matchVersion,
            requestId: uuidv7(),
          },
          "dev|riley",
        )
      ).statusCode,
    ).toBe(404);
    const unlinked = await inject(
      "POST",
      `/v1/transactions/${posted.id}/unlink-occurrence`,
      {
        expectedTransactionVersion: posted.version,
        expectedOccurrenceId: activeLink.id,
        expectedMatchId: activeLink.matchId,
        expectedMatchVersion: activeLink.matchVersion,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(unlinked.statusCode).toBe(201);
    const afterUnlink = bootstrapResponseSchema.parse(unlinked.json());
    const reopened = afterUnlink.plan.occurrences.find(
      (occurrence) => occurrence.id === rent.id,
    )!;
    expect(reopened.evidence).toHaveLength(0);
    expect(["expected", "overdue"]).toContain(reopened.state);
    const electric = afterUnlink.plan.occurrences.find(
      (occurrence) => occurrence.name === "Electric",
    )!;
    const reassigned = await inject(
      "POST",
      `/v1/transactions/${posted.id}/link-occurrence`,
      {
        occurrenceId: electric.id,
        expectedTransactionVersion: posted.version,
        expectedOccurrenceVersion: electric.version,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(reassigned.statusCode).toBe(201);
    expect(
      (
        await inject(
          "POST",
          `/v1/transactions/${posted.id}/unlink-occurrence`,
          {
            expectedTransactionVersion: posted.version,
            expectedOccurrenceId: activeLink.id,
            expectedMatchId: activeLink.matchId,
            expectedMatchVersion: activeLink.matchVersion,
            requestId: uuidv7(),
          },
          "dev|maya",
        )
      ).statusCode,
    ).toBe(409);
    const reassignedFeed = transactionFeedResponseSchema.parse(
      (
        await inject(
          "GET",
          `/v1/transactions?transactionId=${posted.id}`,
          undefined,
          "dev|maya",
        )
      ).json(),
    );
    expect(reassignedFeed.items[0]?.linkedOccurrence?.id).toBe(electric.id);
  });

  it("surfaces an ambiguous connected payment for review and lets the user confirm it", async () => {
    await admin.query(
      "insert into financial_transactions(household_id,account_id,source_kind,source_record_id,merchant,amount_minor,currency,occurred_on,status,direction) values($1,$2,'plaid','ambiguous-rent','ACH 9842',185000,'USD','2026-09-01','posted','debit')",
      [ids.householdA, ids.accountA],
    );
    const reconciled = await inject(
      "POST",
      "/v1/manual/balances",
      {
        accountId: ids.accountA,
        amount: { minor: "423039", currency: "USD" },
        asOf: new Date().toISOString(),
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(reconciled.statusCode).toBe(201);
    const bootstrap = bootstrapResponseSchema.parse(reconciled.json());
    const rent = bootstrap.plan.occurrences.find(
      (occurrence) => occurrence.name === "Rent",
    )!;
    expect(rent.state).toBe("needs_review");
    expect(rent.evidence[0]?.merchant).toBe("ACH 9842");
    const transaction = transactionFeedResponseSchema.parse(
      (
        await inject(
          "GET",
          "/v1/transactions?query=ACH%209842",
          undefined,
          "dev|maya",
        )
      ).json(),
    ).items[0]!;
    expect(transaction.linkedOccurrence).toMatchObject({
      id: rent.id,
      matchState: "proposed",
    });
    const confirmed = await inject(
      "POST",
      `/v1/transactions/${transaction.id}/link-occurrence`,
      {
        occurrenceId: rent.id,
        expectedTransactionVersion: transaction.version,
        expectedOccurrenceVersion: rent.version,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(confirmed.statusCode).toBe(201);
    expect(
      bootstrapResponseSchema
        .parse(confirmed.json())
        .plan.occurrences.find((occurrence) => occurrence.id === rent.id)
        ?.state,
    ).toBe("pending");
  });

  it("undoes only the one-time settlement caused by a verified payment", async () => {
    await admin.query(
      "insert into financial_transactions(household_id,account_id,source_kind,source_record_id,merchant,amount_minor,currency,occurred_on,status,direction) values($1,$2,'plaid','verified-rent','Rent',185000,'USD','2026-09-01','posted','debit')",
      [ids.householdA, ids.accountA],
    );
    await admin.query(
      "insert into balance_observations(household_id,account_id,amount_minor,currency,provenance,as_of,source_record_id,recorded_at) values($1,$2,238039,'USD','plaid',now(),'verified-rent-balance',now()+interval '1 second')",
      [ids.householdA, ids.accountA],
    );
    for (let index = 0; index < 2; index++)
      expect(
        (
          await inject(
            "POST",
            "/v1/manual/balances",
            {
              accountId: ids.accountA,
              amount: { minor: "423039", currency: "USD" },
              asOf: new Date().toISOString(),
              requestId: uuidv7(),
            },
            "dev|maya",
          )
        ).statusCode,
      ).toBe(201);
    const verified = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(verified.plan.commitments.some((item) => item.name === "Rent")).toBe(
      false,
    );
    const transaction = transactionFeedResponseSchema.parse(
      (
        await inject(
          "GET",
          "/v1/transactions?query=Rent",
          undefined,
          "dev|maya",
        )
      ).json(),
    ).items[0]!;
    const link = transaction.linkedOccurrence!;
    expect(link.state).toBe("verified");
    const undone = await inject(
      "POST",
      `/v1/transactions/${transaction.id}/unlink-occurrence`,
      {
        expectedTransactionVersion: transaction.version,
        expectedOccurrenceId: link.id,
        expectedMatchId: link.matchId,
        expectedMatchVersion: link.matchVersion,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(undone.statusCode).toBe(201);
    const reopened = bootstrapResponseSchema.parse(undone.json());
    expect(reopened.plan.commitments.some((item) => item.name === "Rent")).toBe(
      true,
    );
    expect(
      reopened.plan.occurrences.find((item) => item.id === link.id)?.evidence,
    ).toHaveLength(0);
    const lineage = await admin.query(
      "select settled_at,settled_by_occurrence_id from commitments where household_id=$1 and name='Rent'",
      [ids.householdA],
    );
    expect(lineage.rows[0]).toEqual({
      settled_at: null,
      settled_by_occurrence_id: null,
    });
  });

  it("restores the payday advanced by a verified income match", async () => {
    const expectedOn = householdDate();
    const scheduleResponse = await inject(
      "POST",
      "/v1/income-schedules",
      {
        destinationAccountId: ids.accountA,
        name: "Employer",
        expectedAmount: { minor: "150000", currency: "USD" },
        frequency: "biweekly",
        nextExpectedDate: expectedOn,
        confirmed: true,
        anchorDay: Number(expectedOn.slice(8, 10)),
        anchorEndOfMonth: false,
        secondAnchorDay: null,
        secondAnchorEndOfMonth: false,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(scheduleResponse.statusCode).toBe(201);
    let current = bootstrapResponseSchema.parse(scheduleResponse.json());
    const schedule = current.plan.incomeSchedules.find(
      (item) => item.name === "Employer",
    )!;
    const occurrence = current.plan.occurrences.find(
      (item) => item.incomeScheduleId === schedule.id,
    )!;
    await inject(
      "POST",
      "/v1/manual/balances",
      {
        accountId: ids.accountA,
        amount: { minor: "573039", currency: "USD" },
        asOf: new Date().toISOString(),
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    const recorded = await inject(
      "POST",
      "/v1/manual/transactions",
      {
        accountId: ids.accountA,
        merchant: "Employer payroll",
        amount: { minor: "150000", currency: "USD" },
        occurredOn: expectedOn,
        direction: "credit",
        category: "income",
        occurrenceId: occurrence.id,
        balanceIncludesActivity: true,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(recorded.statusCode).toBe(201);
    const advanced = bootstrapResponseSchema.parse(recorded.json());
    expect(
      advanced.plan.incomeSchedules.find((item) => item.id === schedule.id)
        ?.nextExpectedDate,
    ).toBe(plusDays(expectedOn, 14));
    const transaction = transactionFeedResponseSchema.parse(
      (
        await inject(
          "GET",
          "/v1/transactions?query=Employer%20payroll",
          undefined,
          "dev|maya",
        )
      ).json(),
    ).items[0]!;
    const link = transaction.linkedOccurrence!;
    expect(link.state).toBe("verified");
    const cycleHistory = payCycleListResponseSchema.parse(
      (
        await inject("GET", "/v1/pay-cycles?limit=5", undefined, "dev|maya")
      ).json(),
    );
    expect(cycleHistory.hasVerifiedPayday).toBe(true);
    expect(cycleHistory.items).toHaveLength(1);
    expect(cycleHistory.items[0]?.status).toBe("open");
    expect(cycleHistory.items[0]?.report?.earned.minor).toBe("150000");
    expect(cycleHistory.items[0]?.report?.assurance).toBe("incomplete");
    expect(cycleHistory.items[0]?.report?.unexplainedDelta).toBeNull();
    expect(cycleHistory.planningPeriods.length).toBeGreaterThan(0);
    const firstPlanningPage = payCycleListResponseSchema.parse(
      (
        await inject(
          "GET",
          "/v1/pay-cycles?limit=1&planningLimit=1",
          undefined,
          "dev|maya",
        )
      ).json(),
    );
    expect(firstPlanningPage.nextPlanningCursor).toBeTruthy();
    const secondPlanningPage = payCycleListResponseSchema.parse(
      (
        await inject(
          "GET",
          `/v1/pay-cycles?limit=1&planningLimit=1&planningCursor=${encodeURIComponent(firstPlanningPage.nextPlanningCursor!)}`,
          undefined,
          "dev|maya",
        )
      ).json(),
    );
    expect(secondPlanningPage.planningPeriods).toHaveLength(1);
    expect(secondPlanningPage.planningPeriods[0]?.id).not.toBe(
      firstPlanningPage.planningPeriods[0]?.id,
    );
    const manifest = await admin.query<{
      input_kind: string;
      input_snapshot: unknown;
    }>(
      "select input_kind,input_snapshot from pay_cycle_report_inputs where household_id=$1 order by ordinal",
      [ids.householdA],
    );
    expect(
      manifest.rows.some((row) => row.input_kind === "occurrence_revision"),
    ).toBe(true);
    expect(
      manifest.rows.some(
        (row) => row.input_kind === "occurrence_match_revision",
      ),
    ).toBe(true);
    expect(manifest.rows.every((row) => row.input_snapshot !== null)).toBe(
      true,
    );
    expect(
      manifest.rows.some(
        (row) =>
          row.input_kind === "account_role_revision" &&
          typeof row.input_snapshot === "object" &&
          row.input_snapshot !== null &&
          "accountType" in row.input_snapshot,
      ),
    ).toBe(true);
    const boundaryAssurance = await admin.query<{ verification_level: string }>(
      "select r.verification_level from income_boundary_revisions r where r.household_id=$1 order by r.recorded_at desc limit 1",
      [ids.householdA],
    );
    expect(boundaryAssurance.rows[0]?.verification_level).toBe(
      "user_confirmed",
    );
    const undone = await inject(
      "POST",
      `/v1/transactions/${transaction.id}/unlink-occurrence`,
      {
        expectedTransactionVersion: transaction.version,
        expectedOccurrenceId: link.id,
        expectedMatchId: link.matchId,
        expectedMatchVersion: link.matchVersion,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(undone.statusCode).toBe(201);
    const restored = bootstrapResponseSchema.parse(undone.json());
    expect(
      restored.plan.incomeSchedules.find((item) => item.id === schedule.id)
        ?.nextExpectedDate,
    ).toBe(expectedOn);
    const correctedCycles = payCycleListResponseSchema.parse(
      (
        await inject("GET", "/v1/pay-cycles?limit=5", undefined, "dev|maya")
      ).json(),
    );
    expect(correctedCycles.hasVerifiedPayday).toBe(false);
    expect(correctedCycles.items).toHaveLength(0);
    const retainedAudit = await admin.query<{ count: number }>(
      "select count(*)::int count from pay_cycles where household_id=$1",
      [ids.householdA],
    );
    expect(retainedAudit.rows[0]?.count).toBeGreaterThan(0);
    expect(
      restored.plan.occurrences.find((item) => item.id === link.id)?.evidence,
    ).toHaveLength(0);
    const lineage = await admin.query(
      "select advanced_from_occurrence_id,previous_expected_date from income_schedules where household_id=$1 and id=$2",
      [ids.householdA, schedule.id],
    );
    expect(lineage.rows[0]).toEqual({
      advanced_from_occurrence_id: null,
      previous_expected_date: null,
    });
  });

  it("keeps protected flows outside reconciliation and restores a debit after savings reversal", async () => {
    const subject = `dev|pay-cycle-population-${uuidv7()}`;
    let state = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, subject)).json(),
    );
    const householdId = state.household.id;
    const spendableAccountId = state.accounts[0]!.id;
    const expectedOn = householdDate();
    state = bootstrapResponseSchema.parse(
      (
        await inject(
          "POST",
          "/v1/income-schedules",
          {
            destinationAccountId: spendableAccountId,
            name: "Regression payroll",
            expectedAmount: { minor: "100000", currency: "USD" },
            frequency: "biweekly",
            nextExpectedDate: expectedOn,
            confirmed: true,
            anchorDay: Number(expectedOn.slice(8, 10)),
            anchorEndOfMonth: false,
            secondAnchorDay: null,
            secondAnchorEndOfMonth: false,
            requestId: uuidv7(),
          },
          subject,
        )
      ).json(),
    );
    const occurrence = state.plan.occurrences.find(
      (item) => item.name === "Regression payroll",
    )!;
    await inject(
      "POST",
      "/v1/manual/balances",
      {
        accountId: spendableAccountId,
        amount: { minor: "200000", currency: "USD" },
        asOf: new Date(Date.now() - 86_400_000).toISOString(),
        requestId: uuidv7(),
      },
      subject,
    );
    await inject(
      "POST",
      "/v1/manual/transactions",
      {
        accountId: spendableAccountId,
        merchant: "Regression payroll",
        amount: { minor: "100000", currency: "USD" },
        occurredOn: expectedOn,
        direction: "credit",
        category: "income",
        occurrenceId: occurrence.id,
        balanceIncludesActivity: true,
        requestId: uuidv7(),
      },
      subject,
    );
    const protectedAccount = await admin.query<{ id: string }>(
      `insert into accounts(household_id,name,account_type,currency,provenance,include_in_plan,planning_role)
       values($1,'Protected regression','savings','USD','manual',false,'protected') returning id`,
      [householdId],
    );
    const protectedScheduleState = bootstrapResponseSchema.parse(
      (
        await inject(
          "POST",
          "/v1/income-schedules",
          {
            destinationAccountId: protectedAccount.rows[0]!.id,
            name: "Protected payroll",
            expectedAmount: { minor: "7000", currency: "USD" },
            frequency: "weekly",
            nextExpectedDate: expectedOn,
            confirmed: true,
            anchorDay: Number(expectedOn.slice(8, 10)),
            anchorEndOfMonth: false,
            secondAnchorDay: null,
            secondAnchorEndOfMonth: false,
            requestId: uuidv7(),
          },
          subject,
        )
      ).json(),
    );
    const protectedOccurrence = protectedScheduleState.plan.occurrences.find(
      (item) => item.name === "Protected payroll",
    )!;
    await inject(
      "POST",
      "/v1/manual/balances",
      {
        accountId: protectedAccount.rows[0]!.id,
        amount: { minor: "50000", currency: "USD" },
        asOf: new Date(Date.now() - 86_400_000).toISOString(),
        requestId: uuidv7(),
      },
      subject,
    );
    expect(
      (
        await inject(
          "POST",
          "/v1/manual/transactions",
          {
            accountId: protectedAccount.rows[0]!.id,
            merchant: "Protected payroll",
            amount: { minor: "7000", currency: "USD" },
            occurredOn: expectedOn,
            direction: "credit",
            category: "income",
            occurrenceId: protectedOccurrence.id,
            balanceIncludesActivity: true,
            requestId: uuidv7(),
          },
          subject,
        )
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await inject(
          "POST",
          "/v1/manual/transactions",
          {
            accountId: protectedAccount.rows[0]!.id,
            merchant: "Protected purchase",
            amount: { minor: "3000", currency: "USD" },
            occurredOn: expectedOn,
            direction: "debit",
            category: "groceries",
            balanceIncludesActivity: false,
            requestId: uuidv7(),
          },
          subject,
        )
      ).statusCode,
    ).toBe(201);
    const cycleList = payCycleListResponseSchema.parse(
      (await inject("GET", "/v1/pay-cycles", undefined, subject)).json(),
    );
    const cycleId = cycleList.items[0]!.id;
    expect(cycleList.items[0]!.report?.earned.minor).toBe("107000");
    expect(cycleList.items[0]!.report?.spent.minor).toBe("0");
    const protectedCoverage = await admin.query<{ count: number }>(
      `select count(*)::int count from pay_cycle_account_coverage coverage
       join pay_cycle_report_revisions report on report.household_id=coverage.household_id and report.id=coverage.report_revision_id
       where coverage.household_id=$1 and report.pay_cycle_id=$2 and coverage.account_id=$3`,
      [householdId, cycleId, protectedAccount.rows[0]!.id],
    );
    expect(protectedCoverage.rows[0]?.count).toBe(0);
    const protectedRoleRevision = await admin.query<{
      id: string;
      version: number;
    }>(
      `select id,version from account_planning_role_revisions
       where household_id=$1 and account_id=$2 order by version desc limit 1`,
      [householdId, protectedAccount.rows[0]!.id],
    );
    const protectedRoleInput = await admin.query<{
      input_id: string;
      input_version: number;
      input_snapshot: Record<string, unknown>;
    }>(
      `select input.input_id,input.input_version,input.input_snapshot
       from pay_cycle_report_inputs input
       join pay_cycle_report_revisions report
         on report.household_id=input.household_id and report.id=input.report_revision_id
       where input.household_id=$1 and report.pay_cycle_id=$2
         and input.input_kind='account_role_revision'
         and input.input_snapshot->>'accountId'=$3
       order by report.version desc limit 1`,
      [householdId, cycleId, protectedAccount.rows[0]!.id],
    );
    expect(protectedRoleInput.rows[0]).toMatchObject({
      input_id: protectedRoleRevision.rows[0]!.id,
      input_version: protectedRoleRevision.rows[0]!.version,
      input_snapshot: {
        accountId: protectedAccount.rows[0]!.id,
        role: "protected",
        accountType: "savings",
      },
    });

    await inject(
      "POST",
      "/v1/manual/transactions",
      {
        accountId: spendableAccountId,
        merchant: "Savings source regression",
        amount: { minor: "5000", currency: "USD" },
        occurredOn: expectedOn,
        direction: "debit",
        category: "groceries",
        balanceIncludesActivity: false,
        requestId: uuidv7(),
      },
      subject,
    );
    const sourceEvidence = await admin.query<{ id: string }>(
      `select transaction.id from transaction_entities entity
       join financial_transactions transaction on transaction.household_id=entity.household_id and transaction.id=entity.current_transaction_id
       where entity.household_id=$1 and transaction.merchant='Savings source regression'`,
      [householdId],
    );
    const goal = await admin.query<{ id: string }>(
      `insert into savings_goals(household_id,name,contribution_amount_minor,schedule,status,currency,provenance)
       values($1,'Savings reversal regression',0,'planning_period','active','USD','manual') returning id`,
      [householdId],
    );
    const contribution = await admin.query<{ id: string }>(
      `insert into savings_goal_movements(household_id,savings_goal_id,kind,amount_minor,currency,effective_on,verification_method,provenance)
       values($1,$2,'contribution',5000,'USD',$3,'user_confirmed','manual') returning id`,
      [householdId, goal.rows[0]!.id, expectedOn],
    );
    await admin.query(
      `insert into savings_movement_evidence(household_id,movement_id,evidence_role,transaction_id)
       values($1,$2,'source_debit',$3)`,
      [householdId, contribution.rows[0]!.id, sourceEvidence.rows[0]!.id],
    );
    const beforeReversal = payCycleDetailResponseSchema.parse(
      (
        await inject("GET", `/v1/pay-cycles/${cycleId}`, undefined, subject)
      ).json(),
    );
    expect(beforeReversal.cycle.report?.saved.minor).toBe("5000");
    expect(beforeReversal.cycle.report?.spent.minor).toBe("0");
    await admin.query(
      `insert into savings_goal_movements(household_id,savings_goal_id,kind,amount_minor,currency,effective_on,verification_method,reversed_movement_id,provenance)
       values($1,$2,'reversal',5000,'USD',$3,'user_confirmed',$4,'manual')`,
      [householdId, goal.rows[0]!.id, expectedOn, contribution.rows[0]!.id],
    );
    const afterReversal = payCycleDetailResponseSchema.parse(
      (
        await inject("GET", `/v1/pay-cycles/${cycleId}`, undefined, subject)
      ).json(),
    );
    expect(afterReversal.cycle.report?.saved.minor).toBe("0");
    expect(afterReversal.cycle.report?.spent.minor).toBe("5000");
  });

  it("does not let old verified income overwrite a newer user-edited date", async () => {
    const expectedOn = householdDate();
    let current = bootstrapResponseSchema.parse(
      (
        await inject(
          "POST",
          "/v1/income-schedules",
          {
            destinationAccountId: ids.accountA,
            name: "Edited employer",
            expectedAmount: { minor: "90000", currency: "USD" },
            frequency: "biweekly",
            nextExpectedDate: expectedOn,
            confirmed: true,
            anchorDay: Number(expectedOn.slice(8, 10)),
            anchorEndOfMonth: false,
            secondAnchorDay: null,
            secondAnchorEndOfMonth: false,
            requestId: uuidv7(),
          },
          "dev|maya",
        )
      ).json(),
    );
    let schedule = current.plan.incomeSchedules.find(
      (item) => item.name === "Edited employer",
    )!;
    const occurrence = current.plan.occurrences.find(
      (item) => item.incomeScheduleId === schedule.id,
    )!;
    current = bootstrapResponseSchema.parse(
      (
        await inject(
          "POST",
          "/v1/manual/transactions",
          {
            accountId: ids.accountA,
            merchant: "Edited employer",
            amount: { minor: "90000", currency: "USD" },
            occurredOn: expectedOn,
            direction: "credit",
            category: "income",
            occurrenceId: occurrence.id,
            balanceIncludesActivity: true,
            requestId: uuidv7(),
          },
          "dev|maya",
        )
      ).json(),
    );
    schedule = current.plan.incomeSchedules.find(
      (item) => item.id === schedule.id,
    )!;
    expect(schedule.nextExpectedDate).toBe(plusDays(expectedOn, 14));
    const userDate = plusDays(expectedOn, 21);
    current = bootstrapResponseSchema.parse(
      (
        await inject(
          "PUT",
          `/v1/income-schedules/${schedule.id}`,
          {
            destinationAccountId: schedule.destinationAccountId,
            name: schedule.name,
            expectedAmount: schedule.expectedAmount,
            frequency: schedule.frequency,
            nextExpectedDate: userDate,
            confirmed: true,
            anchorDay: Number(userDate.slice(8, 10)),
            anchorEndOfMonth: false,
            secondAnchorDay: null,
            secondAnchorEndOfMonth: false,
            status: "active",
            expectedVersion: schedule.version,
            requestId: uuidv7(),
          },
          "dev|maya",
        )
      ).json(),
    );
    await inject(
      "POST",
      "/v1/manual/balances",
      {
        accountId: ids.accountA,
        amount: { minor: "513039", currency: "USD" },
        asOf: new Date(Date.now() + 1_000).toISOString(),
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    current = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(
      current.plan.incomeSchedules.find((item) => item.id === schedule.id)
        ?.nextExpectedDate,
    ).toBe(userDate);
  });

  it("corrects and voids manual transactions without erasing their audit history", async () => {
    expect(
      (
        await inject(
          "POST",
          "/v1/manual/transactions",
          {
            accountId: ids.accountA,
            merchant: "Future activity",
            amount: { minor: "1099", currency: "USD" },
            occurredOn: "2099-01-01",
            direction: "debit",
            category: "shopping",
            balanceIncludesActivity: false,
            requestId: uuidv7(),
          },
          "dev|maya",
        )
      ).statusCode,
    ).toBe(400);
    const created = await inject(
      "POST",
      "/v1/manual/transactions",
      {
        accountId: ids.accountA,
        merchant: "Mistyped store",
        amount: { minor: "1099", currency: "USD" },
        occurredOn: "2026-08-28",
        direction: "debit",
        category: "shopping",
        balanceIncludesActivity: false,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(created.statusCode).toBe(201);
    const original = transactionFeedResponseSchema.parse(
      (
        await inject(
          "GET",
          "/v1/transactions?query=Mistyped",
          undefined,
          "dev|maya",
        )
      ).json(),
    ).items[0]!;
    expect(
      (
        await inject(
          "PUT",
          `/v1/transactions/${original.id}/manual`,
          {
            merchant: "Future mistake",
            amount: { minor: "1199", currency: "USD" },
            occurredOn: "2099-01-01",
            direction: "debit",
            category: "groceries",
            expectedVersion: original.version,
            expectedCategoryVersion: original.categoryVersion,
            requestId: uuidv7(),
          },
          "dev|maya",
        )
      ).statusCode,
    ).toBe(400);
    const corrected = await inject(
      "PUT",
      `/v1/transactions/${original.id}/manual`,
      {
        merchant: "Neighborhood market",
        amount: { minor: "1199", currency: "USD" },
        occurredOn: "2026-08-29",
        direction: "debit",
        category: "groceries",
        expectedVersion: original.version,
        expectedCategoryVersion: original.categoryVersion,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(corrected.statusCode, corrected.body).toBe(200);
    const afterCorrection = transactionFeedResponseSchema.parse(
      (
        await inject(
          "GET",
          "/v1/transactions?query=Neighborhood",
          undefined,
          "dev|maya",
        )
      ).json(),
    ).items[0]!;
    expect(afterCorrection).toEqual(
      expect.objectContaining({
        id: original.id,
        merchant: "Neighborhood market",
        occurredOn: "2026-08-29",
        category: "groceries",
        categorySource: "user",
      }),
    );
    expect(afterCorrection.amount.minor).toBe("1199");
    expect(afterCorrection.version).toBe(original.version + 1);
    expect(
      (
        await inject(
          "PUT",
          `/v1/transactions/${original.id}/manual`,
          {
            merchant: "Stale overwrite",
            amount: { minor: "1", currency: "USD" },
            occurredOn: "2026-08-29",
            direction: "debit",
            category: "other",
            expectedVersion: original.version,
            expectedCategoryVersion: original.categoryVersion,
            requestId: uuidv7(),
          },
          "dev|maya",
        )
      ).statusCode,
    ).toBe(409);
    const auditBeforeVoid = await admin.query<{ count: number }>(
      "select count(*)::int count from financial_transactions where household_id=$1 and transaction_id=$2",
      [ids.householdA, original.id],
    );
    expect(auditBeforeVoid.rows[0]?.count).toBe(2);
    const voided = await inject(
      "POST",
      `/v1/transactions/${original.id}/void`,
      { expectedVersion: afterCorrection.version, requestId: uuidv7() },
      "dev|maya",
    );
    expect(voided.statusCode, voided.body).toBe(201);
    const afterVoid = transactionFeedResponseSchema.parse(
      (
        await inject(
          "GET",
          "/v1/transactions?query=Neighborhood",
          undefined,
          "dev|maya",
        )
      ).json(),
    );
    expect(afterVoid.items).toHaveLength(0);
    const auditAfterVoid = await admin.query<{
      count: number;
      latest_status: string;
    }>(
      "select count(*)::int count,(array_agg(status order by revision desc))[1] latest_status from financial_transactions where household_id=$1 and transaction_id=$2",
      [ids.householdA, original.id],
    );
    expect(auditAfterVoid.rows[0]).toEqual({
      count: 3,
      latest_status: "removed",
    });
  });

  it("projects a posted successor even when a same-time removed UUID sorts later", async () => {
    const entityId = "30000000-0000-4000-8000-000000000301";
    await admin.query(
      "insert into transaction_entities(id,household_id,account_id) values($1,$2,$3)",
      [entityId, ids.householdA, ids.accountA],
    );
    for (const sourceId of ["pending-adversarial", "posted-adversarial"])
      await admin.query(
        "insert into transaction_source_aliases(household_id,transaction_id,account_id,source_kind,source_record_id) values($1,$2,$3,'plaid',$4)",
        [ids.householdA, entityId, ids.accountA, sourceId],
      );
    await admin.query(
      "insert into transaction_category_assignments(household_id,transaction_id,category,source,confidence) values($1,$2,'dining','provider','medium')",
      [ids.householdA, entityId],
    );
    await admin.query(
      `insert into financial_transactions(id,household_id,account_id,source_kind,source_record_id,revision,merchant,amount_minor,currency,occurred_on,status,direction,transaction_id,raw_hash)
       values
       ('00000000-0000-4000-8000-000000000002',$1,$2,'plaid','posted-adversarial',1,'Adversarial Coffee','825','USD','2026-08-31','posted','debit',$3,'posted'),
       ('ffffffff-ffff-4fff-8fff-ffffffffffff',$1,$2,'plaid','pending-adversarial',2,'Adversarial Coffee','825','USD','2026-08-31','removed','debit',$3,'removed')`,
      [ids.householdA, ids.accountA, entityId],
    );
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = transactionFeedResponseSchema.parse(
        (
          await inject(
            "GET",
            "/v1/transactions?query=Adversarial%20Coffee",
            undefined,
            "dev|maya",
          )
        ).json(),
      );
      expect(response.items).toHaveLength(1);
      expect(response.items[0]).toMatchObject({
        id: entityId,
        status: "posted",
      });
    }
  });

  it("includes stable transaction identities and category history in account export", async () => {
    await inject(
      "POST",
      "/v1/manual/transactions",
      {
        accountId: ids.accountA,
        merchant: "Exported grocery",
        amount: { minor: "2200", currency: "USD" },
        occurredOn: "2026-08-29",
        direction: "debit",
        category: "groceries",
        balanceIncludesActivity: false,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    const response = await inject(
      "GET",
      "/v1/account/export",
      undefined,
      "dev|maya",
    );
    expect(response.statusCode, response.body).toBe(200);
    const exported = accountExportResponseSchema.parse(response.json());
    const data = exported.data as Record<string, unknown[]>;
    for (const key of [
      "transactionEntities",
      "transactionAliases",
      "transactionCategories",
      "transactionCategoryRevisions",
      "merchantCategoryRules",
      "savingsGoals",
      "savingsGoalRevisions",
      "savingsGoalMovements",
      "savingsMovementEvidence",
      "incomeSchedules",
      "incomeScheduleRevisions",
      "preferenceRevisions",
      "notificationEvents",
      "notificationDeliveries",
    ])
      expect(Array.isArray(data[key]), `${key} should be exported`).toBe(true);
    expect(data.transactionEntities?.length).toBeGreaterThan(0);
    expect(data.transactionCategories?.length).toBeGreaterThan(0);
    expect(data.transactionCategoryRevisions?.length).toBeGreaterThan(0);
    expect(exported.formatVersion).toBe(5);
    const serializedExport = JSON.stringify(exported.data);
    expect(serializedExport).not.toContain("encrypted_token");
    expect(serializedExport).not.toContain("destination_hash");
    expect(serializedExport).not.toContain("lease_token");
    expect(
      Object.keys((data.plans?.[0] ?? {}) as Record<string, unknown>).some(
        (key) => key.startsWith("income_") || key === "next_income_date",
      ),
    ).toBe(false);
  });

  it("keeps a recorded commitment reserved until a later balance confirms it", async () => {
    const before = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    const rent = before.plan.occurrences.find((item) => item.name === "Rent")!;
    const recorded = await inject(
      "POST",
      "/v1/manual/transactions",
      {
        accountId: ids.accountA,
        merchant: "Rent",
        amount: { minor: "185000", currency: "USD" },
        occurredOn: householdDate(),
        direction: "debit",
        occurrenceId: rent.id,
        balanceIncludesActivity: false,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(recorded.statusCode).toBe(201);
    const pending = bootstrapResponseSchema.parse(recorded.json());
    expect(
      pending.plan.occurrences.find((item) => item.id === rent.id)?.state,
    ).toBe("pending");
    expect(
      pending.plan.occurrences.find((item) => item.id === rent.id)?.evidence,
    ).toEqual([
      expect.objectContaining({
        merchant: "Rent",
        accountName: "Manual cash",
        amountApplied: { minor: "185000", currency: "USD" },
      }),
    ]);
    expect(pending.plan.reserved.minor).toBe(before.plan.reserved.minor);
    const duplicateEvidence = await inject(
      "POST",
      "/v1/manual/transactions",
      {
        accountId: ids.accountA,
        merchant: "Rent duplicate assertion",
        amount: { minor: "185000", currency: "USD" },
        occurredOn: householdDate(),
        direction: "debit",
        occurrenceId: rent.id,
        balanceIncludesActivity: false,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(duplicateEvidence.statusCode).toBe(409);

    const refreshed = await inject(
      "POST",
      "/v1/manual/balances",
      {
        accountId: ids.accountA,
        amount: { minor: "238039", currency: "USD" },
        asOf: new Date().toISOString(),
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(refreshed.statusCode).toBe(201);
    const verified = bootstrapResponseSchema.parse(refreshed.json());
    expect(
      verified.plan.occurrences.find((item) => item.id === rent.id)?.state,
    ).toBe("verified");
    expect(verified.plan.reserved.minor).toBe("109639");
    expect(verified.plan.available.minor).toBe(before.plan.available.minor);
  });

  it("reopens a plan item when its linked manual evidence is corrected", async () => {
    const before = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    const electric = before.plan.occurrences.find(
      (item) => item.name === "Electric",
    )!;
    await inject(
      "POST",
      "/v1/manual/transactions",
      {
        accountId: ids.accountA,
        merchant: "Electric payment",
        amount: electric.expectedAmount!,
        occurredOn: householdDate(),
        direction: "debit",
        category: "utilities",
        occurrenceId: electric.id,
        balanceIncludesActivity: false,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    const linked = transactionFeedResponseSchema.parse(
      (
        await inject(
          "GET",
          "/v1/transactions?query=Electric%20payment",
          undefined,
          "dev|maya",
        )
      ).json(),
    ).items[0]!;
    expect(linked.linkedOccurrence?.id).toBe(electric.id);
    const corrected = await inject(
      "PUT",
      `/v1/transactions/${linked.id}/manual`,
      {
        merchant: "Corrected electric payment",
        amount: { minor: "1000", currency: "USD" },
        occurredOn: householdDate(),
        direction: "debit",
        category: "utilities",
        expectedVersion: linked.version,
        expectedCategoryVersion: linked.categoryVersion,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(corrected.statusCode, corrected.body).toBe(200);
    const after = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(
      after.plan.occurrences.find((item) => item.id === electric.id),
    ).toEqual(
      expect.objectContaining({
        state: "expected",
        matchedAmount: { minor: "0", currency: "USD" },
      }),
    );
  });

  it("does not let a generic debit clear the protected savings allocation", async () => {
    const before = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    const savings = before.plan.occurrences.find(
      (item) => item.kind === "savings",
    )!;
    const response = await inject(
      "POST",
      "/v1/manual/transactions",
      {
        accountId: ids.accountA,
        merchant: "Transfer to savings",
        amount: { minor: "50000", currency: "USD" },
        occurredOn: householdDate(),
        direction: "debit",
        occurrenceId: savings.id,
        balanceIncludesActivity: true,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(response.statusCode).toBe(409);
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
    const snapshots = await admin.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM calculation_snapshots WHERE household_id = $1",
      [ids.householdA],
    );
    expect(snapshots.rows[0]?.count).toBe(2);
    const manifests = await admin.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM calculation_snapshot_inputs WHERE household_id = $1",
      [ids.householdA],
    );
    expect(manifests.rows[0]?.count).toBeGreaterThan(0);
    const snapshotId = (
      await admin.query<{ id: string }>(
        "SELECT id FROM calculation_snapshots WHERE household_id = $1 LIMIT 1",
        [ids.householdA],
      )
    ).rows[0]?.id;
    await expect(
      admin.query(
        "UPDATE calculation_snapshots SET available_minor = available_minor WHERE id = $1",
        [snapshotId],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      admin.query(
        "DELETE FROM calculation_snapshot_inputs WHERE snapshot_id = $1",
        [snapshotId],
      ),
    ).rejects.toThrow(/append-only/);
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
    expect(
      bootstrapResponseSchema
        .parse(second.json())
        .plan.commitments.filter((item) => item.name === "Phone"),
    ).toHaveLength(1);
    const count = await admin.query(
      "SELECT count(*)::int AS count FROM commitments WHERE household_id = $1 AND name = 'Phone'",
      [ids.householdA],
    );
    expect(count.rows[0]?.count).toBe(1);
    const conflicting = await inject(
      "POST",
      "/v1/commitments",
      { ...payload, amount: { minor: "7500", currency: "USD" } },
      "dev|maya",
    );
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
    expect(
      body.plan.commitments.find((item) => item.name === "Flexible goal")
        ?.dueDate,
    ).toBeNull();
  });

  it("materializes every recurring payment through the planning horizon", async () => {
    const created = await inject(
      "POST",
      "/v1/commitments",
      {
        name: "Weekly care",
        amount: { minor: "10000", currency: "USD" },
        dueDate: householdDate(),
        recurrence: "weekly",
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(created.statusCode).toBe(201);
    const body = bootstrapResponseSchema.parse(created.json());
    const rule = body.plan.commitments.find(
      (item) => item.name === "Weekly care",
    )!;
    const occurrences = body.plan.occurrences.filter(
      (item) => item.commitmentId === rule.id && item.state !== "skipped",
    );
    expect(occurrences.map((item) => item.expectedOn)).toEqual([
      householdDate(),
      plusDays(householdDate(), 7),
      plusDays(householdDate(), 14),
      plusDays(householdDate(), 21),
      plusDays(householdDate(), 28),
    ]);
    expect(body.plan.reserved.minor).toBe("324639");
    const skipped = await inject(
      "POST",
      `/v1/occurrences/${occurrences[0]!.id}/skip`,
      {
        expectedVersion: occurrences[0]!.version,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(skipped.statusCode).toBe(201);
    const afterSkip = bootstrapResponseSchema.parse(skipped.json());
    expect(afterSkip.plan.reserved.minor).toBe("314639");
    expect(
      afterSkip.plan.occurrences.find((item) => item.id === occurrences[0]!.id),
    ).toEqual(
      expect.objectContaining({ state: "skipped", explicitlySkipped: true }),
    );
    expect(
      afterSkip.plan.occurrences.filter(
        (item) => item.commitmentId === rule.id && item.state !== "skipped",
      ),
    ).toHaveLength(4);
  });

  it("uses plain quarterly and yearly schedules across commitments, savings, and income", async () => {
    const today = householdDate();
    for (const [name, recurrence, dueDate] of [
      ["Quarterly insurance", "quarterly", today],
      ["Yearly registration", "annual", plusDays(today, 200)],
    ] as const) {
      const response = await inject(
        "POST",
        "/v1/commitments",
        {
          name,
          amount: { minor: "2500", currency: "USD" },
          dueDate,
          recurrence,
          requestId: uuidv7(),
        },
        "dev|maya",
      );
      expect(response.statusCode, response.body).toBe(201);
      const state = bootstrapResponseSchema.parse(response.json());
      const rule = state.plan.commitments.find((item) => item.name === name)!;
      expect(rule.recurrence).toBe(recurrence);
      expect(
        state.plan.occurrences.find(
          (item) =>
            item.commitmentId === rule.id && item.expectedOn === dueDate,
        )?.scheduleRevision,
      ).toMatchObject({ kind: "commitment", version: 1 });
    }

    const savings = await inject(
      "POST",
      "/v1/savings-goals",
      {
        name: "Quarterly reserve",
        targetAmount: null,
        targetDate: null,
        contributionAmount: { minor: "5000", currency: "USD" },
        schedule: "quarterly",
        nextDueOn: plusDays(today, 75),
        destinationAccountId: null,
        useCurrentDestinationBalance: false,
        trackManually: true,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(savings.statusCode, savings.body).toBe(201);
    const savingsState = bootstrapResponseSchema.parse(savings.json());
    const quarterlyGoal = savingsState.plan.savingsGoals.find(
      (item) => item.name === "Quarterly reserve",
    )!;
    expect(quarterlyGoal.schedule).toBe("quarterly");
    expect(
      savingsState.plan.occurrences.some(
        (item) =>
          item.savingsGoalId === quarterlyGoal.id &&
          item.expectedOn === plusDays(today, 75),
      ),
    ).toBe(true);

    const incomeDate = plusDays(today, 5);
    const income = await inject(
      "POST",
      "/v1/income-schedules",
      {
        destinationAccountId: ids.accountA,
        name: "Yearly distribution",
        expectedAmount: { minor: "100000", currency: "USD" },
        frequency: "annual",
        nextExpectedDate: incomeDate,
        confirmed: true,
        anchorDay: Number(incomeDate.slice(8, 10)),
        anchorEndOfMonth: false,
        secondAnchorDay: null,
        secondAnchorEndOfMonth: false,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(income.statusCode, income.body).toBe(201);
    expect(
      bootstrapResponseSchema
        .parse(income.json())
        .plan.incomeSchedules.find(
          (item) => item.name === "Yearly distribution",
        )?.frequency,
    ).toBe("annual");
  });

  it("lets scheduled maintenance extend recurring occurrences without a user edit", async () => {
    const created = bootstrapResponseSchema.parse(
      (
        await inject(
          "POST",
          "/v1/commitments",
          {
            name: "Weekly maintenance fixture",
            amount: { minor: "1000", currency: "USD" },
            dueDate: householdDate(),
            recurrence: "weekly",
            requestId: uuidv7(),
          },
          "dev|maya",
        )
      ).json(),
    );
    const rule = created.plan.commitments.find(
      (item) => item.name === "Weekly maintenance fixture",
    )!;
    expect(
      created.plan.occurrences.filter((item) => item.commitmentId === rule.id),
    ).toHaveLength(5);
    await admin.query(
      "UPDATE plans SET fallback_horizon_days=45 WHERE household_id=$1",
      [ids.householdA],
    );
    const maintained = await admin.query<{ maintain_plan_occurrences: number }>(
      "SELECT maintain_plan_occurrences()",
    );
    expect(maintained.rows[0]?.maintain_plan_occurrences).toBeGreaterThan(0);
    const after = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(
      after.plan.occurrences.filter((item) => item.commitmentId === rule.id),
    ).toHaveLength(7);
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
    const current = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
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

  it("keeps one active savings reserve when the horizon contracts and expands", async () => {
    let current = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    for (const fallbackDays of [30, 7, 30]) {
      const response = await inject(
        "PUT",
        "/v1/plan",
        {
          expectedVersion: current.plan.version,
          plannedSavings: current.plan.plannedSavings,
          safetyBuffer: current.plan.safetyBuffer,
          fallbackHorizonDays: fallbackDays,
          requestId: uuidv7(),
        },
        "dev|maya",
      );
      expect(response.statusCode).toBe(200);
      current = bootstrapResponseSchema.parse(response.json());
      expect(
        current.plan.occurrences.filter((item) => item.kind === "savings"),
      ).toHaveLength(1);
    }
    const active = await admin.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM plan_occurrences WHERE household_id=$1 AND kind='savings' AND state<>'skipped'",
      [ids.householdA],
    );
    expect(active.rows[0]?.count).toBe(1);
  });

  it("keeps an explicitly skipped savings contribution dismissed on plan refresh", async () => {
    const before = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    const contribution = before.plan.occurrences.find(
      (item) => item.kind === "savings",
    )!;
    const skipped = await inject(
      "POST",
      `/v1/occurrences/${contribution.id}/skip`,
      { expectedVersion: contribution.version, requestId: uuidv7() },
      "dev|maya",
    );
    expect(skipped.statusCode, skipped.body).toBe(201);
    const afterSkip = bootstrapResponseSchema.parse(skipped.json());
    const refreshed = await inject(
      "PUT",
      "/v1/plan",
      {
        expectedVersion: afterSkip.plan.version,
        plannedSavings: afterSkip.plan.plannedSavings,
        safetyBuffer: {
          minor: (BigInt(afterSkip.plan.safetyBuffer.minor) + 1n).toString(),
          currency: "USD",
        },
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    const refreshedState = bootstrapResponseSchema.parse(refreshed.json());
    expect(
      refreshedState.plan.occurrences.filter(
        (item) => item.kind === "savings" && item.state !== "skipped",
      ),
    ).toHaveLength(0);
    expect(
      refreshedState.plan.occurrences.find(
        (item) => item.id === contribution.id,
      ),
    ).toEqual(
      expect.objectContaining({ state: "skipped", explicitlySkipped: true }),
    );
  });

  it("prevents cross-household access in the API and database", async () => {
    const b = await inject("GET", "/v1/bootstrap", undefined, "dev|riley");
    const bodyB = bootstrapResponseSchema.parse(b.json());
    expect(bodyB.household.id).toBe(ids.householdB);
    expect(bodyB.plan.knownCash.minor).toBe("100000");
    const guessed = await inject(
      "GET",
      "/v1/bootstrap",
      undefined,
      "dev|riley",
      ids.householdA,
    );
    expect(guessed.statusCode).toBe(403);

    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL ROLE budgefi_app");
      await admin.query("SELECT set_config('app.user_id', $1, true)", [
        ids.userB,
      ]);
      await admin.query("SELECT set_config('app.household_id', $1, true)", [
        ids.householdB,
      ]);
      const hidden = await admin.query(
        "SELECT count(*)::int AS count FROM accounts WHERE household_id = $1",
        [ids.householdA],
      );
      expect(hidden.rows[0]?.count).toBe(0);
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("permits only owners and administrators to mutate financial truth", async () => {
    await inject(
      "POST",
      "/v1/manual/transactions",
      {
        accountId: ids.accountA,
        merchant: "Authorization fixture",
        amount: { minor: "500", currency: "USD" },
        occurredOn: "2026-08-29",
        direction: "debit",
        category: "other",
        balanceIncludesActivity: false,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    const protectedTransaction = transactionFeedResponseSchema.parse(
      (
        await inject(
          "GET",
          "/v1/transactions?query=Authorization",
          undefined,
          "dev|maya",
        )
      ).json(),
    ).items[0]!;
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
        "PUT",
        `/v1/transactions/${protectedTransaction.id}/category`,
        {
          category: "shopping",
          expectedVersion: protectedTransaction.categoryVersion,
          applyToFuture: false,
          requestId: uuidv7(),
        },
      ],
      [
        "PUT",
        `/v1/transactions/${protectedTransaction.id}/manual`,
        {
          merchant: "Unauthorized edit",
          amount: protectedTransaction.amount,
          occurredOn: protectedTransaction.occurredOn,
          direction: protectedTransaction.direction,
          category: protectedTransaction.category,
          expectedVersion: protectedTransaction.version,
          expectedCategoryVersion: protectedTransaction.categoryVersion,
          requestId: uuidv7(),
        },
      ],
      [
        "POST",
        `/v1/transactions/${protectedTransaction.id}/void`,
        {
          expectedVersion: protectedTransaction.version,
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
      [
        "PUT",
        `/v1/accounts/${ids.accountA}/inclusion`,
        { expectedVersion: 1, includeInPlan: false, requestId: uuidv7() },
      ],
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
      await admin.query(
        "UPDATE household_memberships SET role = $1 WHERE household_id = $2 AND user_id = $3",
        [role, ids.householdA, ids.userA],
      );
      for (const [method, url, payload] of attempts)
        expect(
          (await inject(method, url, payload, "dev|maya")).statusCode,
        ).toBe(403);
    }
    await admin.query(
      "UPDATE household_memberships SET role = 'admin' WHERE household_id = $1 AND user_id = $2",
      [ids.householdA, ids.userA],
    );
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
      await admin.query(
        "INSERT INTO accounts (id, household_id, name, account_type, currency, provenance, include_in_plan, archived_at) VALUES ($1, $2, $3, $4, 'USD', 'manual', $5, $6)",
        [id, ids.householdA, name, type, included, archivedAt],
      );
      await admin.query(
        "INSERT INTO balance_observations (household_id, account_id, amount_minor, currency, provenance, as_of, source_record_id) VALUES ($1, $2, $3, 'USD', 'manual', now(), $4)",
        [ids.householdA, id, amount, `fixture-${id}`],
      );
    }
    const body = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(body.plan.knownCash.minor).toBe("473039");
  });

  it("makes account inclusion explicit, versioned and projection-authoritative", async () => {
    const savingsId = uuidv7();
    await admin.query(
      "INSERT INTO accounts (id, household_id, name, account_type, currency, provenance, include_in_plan) VALUES ($1, $2, 'Savings', 'savings', 'USD', 'manual', false)",
      [savingsId, ids.householdA],
    );
    await admin.query(
      "INSERT INTO balance_observations (household_id, account_id, amount_minor, currency, provenance, as_of, source_record_id) VALUES ($1, $2, 50000, 'USD', 'manual', now(), 'savings-v1')",
      [ids.householdA, savingsId],
    );
    const before = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(
      before.accounts.find((account) => account.id === savingsId)?.coverage,
    ).toBe("excluded");
    const included = await inject(
      "PUT",
      `/v1/accounts/${savingsId}/inclusion`,
      { expectedVersion: 1, includeInPlan: true, requestId: uuidv7() },
      "dev|maya",
    );
    const body = bootstrapResponseSchema.parse(included.json());
    expect(body.plan.knownCash.minor).toBe("50000");
    expect(
      body.accounts.find((account) => account.id === ids.accountA),
    ).toEqual(expect.objectContaining({ includeInPlan: false }));
    expect(BigInt(body.revision)).toBeGreaterThan(BigInt(before.revision));
    expect(
      (
        await inject(
          "PUT",
          `/v1/accounts/${savingsId}/inclusion`,
          { expectedVersion: 1, includeInPlan: false, requestId: uuidv7() },
          "dev|maya",
        )
      ).statusCode,
    ).toBe(409);
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
    await admin.query(
      "INSERT INTO accounts (household_id, name, account_type, currency, provenance, include_in_plan) VALUES ($1, 'Unknown checking', 'checking', 'USD', 'manual', true)",
      [ids.householdA],
    );
    const body = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(body.plan.freshness.status).toBe("incomplete");
    expect(
      body.accounts.find((account) => account.name === "Unknown checking")
        ?.coverage,
    ).toBe("missing");
  });

  it("marks a plan incomplete when no spendable account is included", async () => {
    const subject = `dev|empty-sources-${Date.now()}`;
    const provisioned = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, subject)).json(),
    );
    await admin.query(
      "UPDATE accounts SET include_in_plan = false, planning_role = 'excluded' WHERE household_id = $1",
      [provisioned.household.id],
    );
    const body = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, subject)).json(),
    );
    expect(body.plan.knownCash.minor).toBe("0");
    expect(body.plan.freshness.status).toBe("incomplete");
    expect(body.plan.freshness.asOf).toBeNull();
  });

  it("switches every connected cash source to manual in one transaction", async () => {
    const subject = `dev|atomic-manual-${Date.now()}`;
    const provisioned = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, subject)).json(),
    );
    const bankA = uuidv7();
    const bankB = uuidv7();
    await admin.query(
      "INSERT INTO accounts(id,household_id,name,account_type,currency,provenance,provider_account_id,include_in_plan,planning_role) VALUES($1,$3,'Bank A','checking','USD','plaid',$4,true,'spendable'),($2,$3,'Bank B','checking','USD','plaid',$5,true,'spendable')",
      [
        bankA,
        bankB,
        provisioned.household.id,
        `bank-a-${bankA}`,
        `bank-b-${bankB}`,
      ],
    );
    await admin.query(
      "INSERT INTO balance_observations(household_id,account_id,amount_minor,currency,provenance,as_of,source_record_id) VALUES($1,$2,10000,'USD','plaid',now(),'bank-a'),($1,$3,20000,'USD','plaid',now(),'bank-b')",
      [provisioned.household.id, bankA, bankB],
    );
    const response = await inject(
      "POST",
      "/v1/manual/activate",
      { requestId: uuidv7() },
      subject,
    );
    expect(response.statusCode, response.body).toBe(201);
    const body = bootstrapResponseSchema.parse(response.json());
    expect(
      body.accounts
        .filter((account) => account.provenance === "plaid")
        .every(
          (account) =>
            !account.includeInPlan && account.planningRole === "excluded",
        ),
    ).toBe(true);
    expect(
      body.accounts.find((account) => account.provenance === "manual"),
    ).toEqual(
      expect.objectContaining({
        includeInPlan: true,
        planningRole: "spendable",
      }),
    );
    expect(body.plan.freshness.status).toBe("incomplete");
  });

  it("keeps one canonical manual cash total when legacy duplicates exist", async () => {
    const subject = `dev|duplicate-manual-${Date.now()}`;
    const provisioned = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, subject)).json(),
    );
    const canonical = provisioned.accounts.find(
      (account) => account.provenance === "manual",
    )!;
    const duplicate = uuidv7();
    await admin.query(
      "INSERT INTO accounts(id,household_id,name,account_type,currency,provenance,provider_account_id,include_in_plan,planning_role) VALUES($1,$2,'Legacy manual cash','cash','USD','manual',$3,true,'spendable')",
      [duplicate, provisioned.household.id, `manual-${duplicate}`],
    );
    await admin.query(
      "INSERT INTO balance_observations(household_id,account_id,amount_minor,currency,provenance,as_of,source_record_id) VALUES($1,$2,100000,'USD','manual',now(),'legacy-balance')",
      [provisioned.household.id, duplicate],
    );
    const ambiguous = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, subject)).json(),
    );
    expect(ambiguous.plan.freshness.status).toBe("incomplete");
    const response = await inject(
      "POST",
      "/v1/manual/balances",
      {
        accountId: canonical.id,
        amount: { minor: "250000", currency: "USD" },
        asOf: new Date().toISOString(),
        requestId: uuidv7(),
      },
      subject,
    );
    expect(response.statusCode, response.body).toBe(201);
    const body = bootstrapResponseSchema.parse(response.json());
    expect(body.plan.knownCash.minor).toBe("250000");
    expect(body.plan.freshness.status).toBe("manual");
    expect(body.accounts.find((account) => account.id === duplicate)).toEqual(
      expect.objectContaining({
        includeInPlan: false,
        planningRole: "excluded",
      }),
    );
  });

  it("marks an aged manual cash confirmation stale", async () => {
    const subject = `dev|stale-manual-${Date.now()}`;
    const provisioned = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, subject)).json(),
    );
    const account = provisioned.accounts.find(
      (item) => item.provenance === "manual",
    )!;
    await inject(
      "POST",
      "/v1/manual/balances",
      {
        accountId: account.id,
        amount: { minor: "50000", currency: "USD" },
        asOf: new Date().toISOString(),
        requestId: uuidv7(),
      },
      subject,
    );
    await admin.query(
      "UPDATE balance_observations SET as_of = now() - interval '8 days' WHERE household_id = $1 AND account_id = $2 AND source_record_id <> 'provisioned'",
      [provisioned.household.id, account.id],
    );
    const body = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, subject)).json(),
    );
    expect(body.plan.knownCash.minor).toBe("50000");
    expect(body.plan.freshness.status).toBe("stale");
  });

  it("rejects direct manual inclusion while connected cash is active", async () => {
    const subject = `dev|manual-hybrid-${Date.now()}`;
    const provisioned = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, subject)).json(),
    );
    const manual = provisioned.accounts.find(
      (account) => account.provenance === "manual",
    )!;
    const bank = uuidv7();
    await admin.query(
      "UPDATE accounts SET include_in_plan=false,planning_role='excluded' WHERE id=$1",
      [manual.id],
    );
    await admin.query(
      "INSERT INTO accounts(id,household_id,name,account_type,currency,provenance,provider_account_id,include_in_plan,planning_role) VALUES($1,$2,'Connected cash','checking','USD','plaid',$3,true,'spendable')",
      [bank, provisioned.household.id, `connected-${bank}`],
    );
    await admin.query(
      "INSERT INTO balance_observations(household_id,account_id,amount_minor,currency,provenance,as_of,source_record_id) VALUES($1,$2,100000,'USD','plaid',now(),'connected-cash')",
      [provisioned.household.id, bank],
    );
    const response = await inject(
      "PUT",
      `/v1/accounts/${manual.id}/inclusion`,
      {
        expectedVersion: manual.version,
        includeInPlan: true,
        requestId: uuidv7(),
      },
      subject,
    );
    expect(response.statusCode).toBe(409);
    const body = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, subject)).json(),
    );
    expect(body.accounts.find((account) => account.id === manual.id)).toEqual(
      expect.objectContaining({ includeInPlan: false }),
    );
    expect(body.accounts.find((account) => account.id === bank)).toEqual(
      expect.objectContaining({ includeInPlan: true }),
    );
    expect(body.plan.knownCash.minor).toBe("100000");
  });

  it("creates a protected manual savings goal and records balance-derived progress", async () => {
    const before = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    const createdResponse = await inject(
      "POST",
      "/v1/savings-goals",
      {
        name: "Emergency fund",
        targetAmount: { minor: "500000", currency: "USD" },
        targetDate: null,
        contributionAmount: { minor: "10000", currency: "USD" },
        schedule: "planning_period",
        nextDueOn: null,
        destinationAccountId: null,
        useCurrentDestinationBalance: false,
        trackManually: true,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(createdResponse.statusCode, createdResponse.body).toBe(201);
    const created = bootstrapResponseSchema.parse(createdResponse.json());
    const goal = created.plan.savingsGoals.find(
      (item) => item.name === "Emergency fund",
    );
    expect(goal).toEqual(
      expect.objectContaining({
        contributionAmount: { minor: "10000", currency: "USD" },
        progress: expect.objectContaining({
          confirmed: { minor: "0", currency: "USD" },
          assurance: "not_started",
          protected: true,
        }),
      }),
    );
    expect(
      created.accounts.find(
        (account) => account.id === goal?.destination?.accountId,
      )?.planningRole,
    ).toBe("protected");
    expect(created.plan.knownCash.minor).toBe(before.plan.knownCash.minor);

    const firstUpdate = await inject(
      "POST",
      `/v1/savings-goals/${goal!.id}/balance`,
      {
        expectedGoalVersion: goal!.version,
        balance: { minor: "25000", currency: "USD" },
        asOf: new Date().toISOString(),
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(firstUpdate.statusCode, firstUpdate.body).toBe(201);
    const funded = bootstrapResponseSchema.parse(firstUpdate.json());
    expect(
      funded.plan.savingsGoals.find((item) => item.id === goal!.id)?.progress,
    ).toEqual(
      expect.objectContaining({
        confirmed: { minor: "25000", currency: "USD" },
        userConfirmed: { minor: "25000", currency: "USD" },
        assurance: "user_confirmed",
      }),
    );

    const secondUpdate = await inject(
      "POST",
      `/v1/savings-goals/${goal!.id}/balance`,
      {
        expectedGoalVersion: goal!.version,
        balance: { minor: "20000", currency: "USD" },
        asOf: new Date(Date.now() + 1).toISOString(),
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    const reduced = bootstrapResponseSchema.parse(secondUpdate.json());
    expect(
      reduced.plan.savingsGoals.find((item) => item.id === goal!.id)?.progress
        .confirmed.minor,
    ).toBe("20000");
  });

  it("uses a connected destination balance only after explicit goal allocation", async () => {
    const destinationId = uuidv7();
    await admin.query(
      "INSERT INTO accounts(id,household_id,name,account_type,currency,provenance,provider_account_id,include_in_plan,planning_role) VALUES($1,$2,'Rainy day savings','savings','USD','plaid',$3,true,'spendable')",
      [destinationId, ids.householdA, `provider-${destinationId}`],
    );
    await admin.query(
      "INSERT INTO balance_observations(household_id,account_id,amount_minor,currency,provenance,as_of,source_record_id) VALUES($1,$2,90000,'USD','plaid',now(),$3)",
      [ids.householdA, destinationId, `balance-${destinationId}`],
    );
    const before = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(before.plan.knownCash.minor).toBe("513039");
    const response = await inject(
      "POST",
      "/v1/savings-goals",
      {
        name: "Rainy day",
        targetAmount: { minor: "300000", currency: "USD" },
        targetDate: null,
        contributionAmount: { minor: "0", currency: "USD" },
        schedule: "planning_period",
        nextDueOn: null,
        destinationAccountId: destinationId,
        useCurrentDestinationBalance: true,
        trackManually: false,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(response.statusCode, response.body).toBe(201);
    const body = bootstrapResponseSchema.parse(response.json());
    expect(body.plan.knownCash.minor).toBe("423039");
    expect(body.accounts.find((item) => item.id === destinationId)).toEqual(
      expect.objectContaining({
        planningRole: "protected",
        includeInPlan: false,
      }),
    );
    expect(
      body.plan.savingsGoals.find((item) => item.name === "Rainy day")
        ?.progress,
    ).toEqual(
      expect.objectContaining({
        confirmed: { minor: "90000", currency: "USD" },
        providerVerified: { minor: "90000", currency: "USD" },
        assurance: "stale",
      }),
    );
    const protectedAccount = body.accounts.find(
      (item) => item.id === destinationId,
    )!;
    expect(
      (
        await inject(
          "PUT",
          `/v1/accounts/${destinationId}/planning-role`,
          {
            expectedVersion: protectedAccount.version,
            role: "spendable",
            requestId: uuidv7(),
          },
          "dev|maya",
        )
      ).statusCode,
    ).toBe(409);

    const secondDestinationId = uuidv7();
    await admin.query(
      "INSERT INTO accounts(id,household_id,name,account_type,currency,provenance,provider_account_id,include_in_plan,planning_role) VALUES($1,$2,'Protected later','savings','USD','plaid',$3,false,'excluded')",
      [secondDestinationId, ids.householdA, `provider-${secondDestinationId}`],
    );
    await admin.query(
      "INSERT INTO balance_observations(household_id,account_id,amount_minor,currency,provenance,as_of,source_record_id) VALUES($1,$2,120000,'USD','plaid',now(),$3)",
      [ids.householdA, secondDestinationId, `balance-${secondDestinationId}`],
    );
    const rainyDay = body.plan.savingsGoals.find(
      (item) => item.name === "Rainy day",
    )!;
    const movedResponse = await inject(
      "PUT",
      `/v1/savings-goals/${rainyDay.id}`,
      {
        expectedVersion: rainyDay.version,
        name: rainyDay.name,
        targetAmount: rainyDay.targetAmount,
        targetDate: rainyDay.targetDate,
        contributionAmount: rainyDay.contributionAmount,
        schedule: rainyDay.schedule,
        nextDueOn: rainyDay.nextDueOn,
        destinationAccountId: secondDestinationId,
        useCurrentDestinationBalance: true,
        status: "active",
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(movedResponse.statusCode, movedResponse.body).toBe(200);
    const moved = bootstrapResponseSchema.parse(movedResponse.json());
    expect(
      moved.accounts.find((item) => item.id === destinationId)?.planningRole,
    ).toBe("spendable");
    expect(
      moved.accounts.find((item) => item.id === secondDestinationId)
        ?.planningRole,
    ).toBe("protected");
    const movedGoal = moved.plan.savingsGoals.find(
      (item) => item.id === rainyDay.id,
    )!;
    expect(movedGoal.progress.confirmed.minor).toBe("120000");
    const archivedResponse = await inject(
      "PUT",
      `/v1/savings-goals/${rainyDay.id}`,
      {
        expectedVersion: movedGoal.version,
        name: movedGoal.name,
        targetAmount: movedGoal.targetAmount,
        targetDate: movedGoal.targetDate,
        contributionAmount: movedGoal.contributionAmount,
        schedule: movedGoal.schedule,
        nextDueOn: movedGoal.nextDueOn,
        destinationAccountId: secondDestinationId,
        useCurrentDestinationBalance: false,
        status: "archived",
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(archivedResponse.statusCode, archivedResponse.body).toBe(200);
    const archived = bootstrapResponseSchema.parse(archivedResponse.json());
    expect(
      archived.accounts.find((item) => item.id === secondDestinationId)
        ?.planningRole,
    ).toBe("excluded");

    const checkingDestination = await inject(
      "POST",
      "/v1/savings-goals",
      {
        name: "Unsafe checking goal",
        targetAmount: null,
        targetDate: null,
        contributionAmount: { minor: "0", currency: "USD" },
        schedule: "planning_period",
        nextDueOn: null,
        destinationAccountId: ids.accountA,
        useCurrentDestinationBalance: false,
        trackManually: false,
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(checkingDestination.statusCode).toBe(409);
  });

  it("reconciles connected savings conservatively across history, ambiguity, withdrawals, and reversals", async () => {
    const today = householdDate();
    const yesterday = plusDays(today, -1);
    const savingsProviderIds = [
      "plaid-save-transfer",
      "plaid-save-destination-only",
      "plaid-save-withdrawal",
      "plaid-save-ambiguous-a",
      "plaid-save-ambiguous-b",
    ];
    fakePlaid.accounts = [
      plaidAccount(),
      ...savingsProviderIds.map((id, index) =>
        plaidSavingsAccount(id, 500 + index * 100),
      ),
    ];
    fakePlaid.pages.set(
      "<initial>",
      syncPage({
        added: [
          {
            ...transferTransaction(
              "historical-source",
              "plaid-checking",
              100,
              yesterday,
            ),
            pending: true,
          },
          {
            ...transferTransaction(
              "historical-destination",
              savingsProviderIds[0]!,
              -100,
              yesterday,
            ),
            pending: true,
          },
        ],
        nextCursor: "savings-initial",
        updateStatus: "HISTORICAL_UPDATE_COMPLETE",
      }),
    );
    const connected = bootstrapResponseSchema.parse(
      (await connectPlaid()).json(),
    );
    const connection = connected.connections.find(
      (item) => item.provider === "plaid",
    )!;
    const accountRows = await admin.query<{
      id: string;
      provider_account_id: string;
    }>(
      "select id,provider_account_id from accounts where household_id=$1 and connection_id=$2",
      [ids.householdA, connection.id],
    );
    const accountIds = new Map(
      accountRows.rows.map((account) => [
        account.provider_account_id,
        account.id,
      ]),
    );
    const checking = connected.accounts.find(
      (account) => account.id === accountIds.get("plaid-checking"),
    )!;
    expect(
      (
        await inject(
          "PUT",
          `/v1/accounts/${checking.id}/planning-role`,
          {
            expectedVersion: checking.version,
            role: "spendable",
            requestId: uuidv7(),
          },
          "dev|maya",
        )
      ).statusCode,
    ).toBe(200);

    const createGoal = async (
      name: string,
      providerAccountId: string,
      contributionMinor: string,
    ) => {
      const response = await inject(
        "POST",
        "/v1/savings-goals",
        {
          name,
          targetAmount: null,
          targetDate: null,
          contributionAmount: { minor: contributionMinor, currency: "USD" },
          schedule: contributionMinor === "0" ? "planning_period" : "one_time",
          nextDueOn: contributionMinor === "0" ? null : today,
          destinationAccountId: accountIds.get(providerAccountId),
          useCurrentDestinationBalance: true,
          trackManually: false,
          requestId: uuidv7(),
        },
        "dev|maya",
      );
      expect(response.statusCode, response.body).toBe(201);
      return bootstrapResponseSchema
        .parse(response.json())
        .plan.savingsGoals.find((goal) => goal.name === name)!;
    };
    const transferGoal = await createGoal(
      "Verified transfer",
      savingsProviderIds[0]!,
      "10000",
    );
    const destinationOnlyGoal = await createGoal(
      "Destination only",
      savingsProviderIds[1]!,
      "20000",
    );
    const withdrawalGoal = await createGoal(
      "Withdrawal watch",
      savingsProviderIds[2]!,
      "0",
    );
    const ambiguousA = await createGoal(
      "Ambiguous A",
      savingsProviderIds[3]!,
      "15000",
    );
    const ambiguousB = await createGoal(
      "Ambiguous B",
      savingsProviderIds[4]!,
      "15000",
    );
    const beforeHistoryScan = await admin.query<{ count: number }>(
      "select count(*)::int count from savings_goal_movements where household_id=$1 and savings_goal_id=$2",
      [ids.householdA, transferGoal.id],
    );
    expect(beforeHistoryScan.rows[0]?.count).toBe(1);

    fakePlaid.pages.set(
      "savings-initial",
      syncPage({
        modified: [
          // A transaction first seen before attachment stays outside the goal
          // boundary even when Plaid posts it afterward and creates a new
          // financial-transaction revision.
          transferTransaction(
            "historical-source",
            "plaid-checking",
            100,
            yesterday,
          ),
          transferTransaction(
            "historical-destination",
            savingsProviderIds[0]!,
            -100,
            yesterday,
          ),
        ],
        added: [
          transferTransaction("current-source", "plaid-checking", 100, today),
          transferTransaction("source-only", "plaid-checking", 300, today),
          transferTransaction("ambiguous-source", "plaid-checking", 150, today),
          transferTransaction(
            "current-destination",
            savingsProviderIds[0]!,
            -100,
            today,
          ),
          transferTransaction(
            "destination-only",
            savingsProviderIds[1]!,
            -200,
            today,
          ),
          transferTransaction(
            "protected-withdrawal",
            savingsProviderIds[2]!,
            50,
            today,
          ),
          transferTransaction(
            "ambiguous-credit-a",
            savingsProviderIds[3]!,
            -150,
            today,
          ),
          transferTransaction(
            "ambiguous-credit-b",
            savingsProviderIds[4]!,
            -150,
            today,
          ),
          transferTransaction(
            "protected-reallocation-out",
            savingsProviderIds[2]!,
            25,
            today,
          ),
          transferTransaction(
            "protected-reallocation-in",
            savingsProviderIds[3]!,
            -25,
            today,
          ),
        ],
        nextCursor: "savings-evidence",
        updateStatus: "HISTORICAL_UPDATE_COMPLETE",
      }),
    );
    await inject(
      "POST",
      `/v1/plaid/connections/${connection.id}/sync`,
      {},
      "dev|maya",
    );
    expect(await processQueued(connection.id)).toBe(true);
    const firstPassMatches = await admin.query<{ name: string; state: string }>(
      `select goal.name,match.state
       from occurrence_transaction_matches match
       join plan_occurrences occurrence on occurrence.id=match.occurrence_id
       join savings_goals goal on goal.id=occurrence.savings_goal_id
       where match.household_id=$1 and goal.id=any($2::uuid[])
       order by goal.name`,
      [
        ids.householdA,
        [transferGoal.id, destinationOnlyGoal.id, ambiguousA.id, ambiguousB.id],
      ],
    );
    expect(firstPassMatches.rows).toEqual([
      { name: "Ambiguous A", state: "proposed" },
      { name: "Ambiguous B", state: "proposed" },
      { name: "Destination only", state: "proposed" },
      { name: "Verified transfer", state: "proposed" },
    ]);
    fakePlaid.pages.set(
      "savings-evidence",
      syncPage({
        nextCursor: "savings-reflected",
        updateStatus: "HISTORICAL_UPDATE_COMPLETE",
      }),
    );
    await inject(
      "POST",
      `/v1/plaid/connections/${connection.id}/sync`,
      {},
      "dev|maya",
    );
    expect(await processQueued(connection.id)).toBe(true);

    const reconciled = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    const progress = (goalId: string) =>
      reconciled.plan.savingsGoals.find((goal) => goal.id === goalId)!.progress
        .confirmed.minor;
    expect(progress(transferGoal.id)).toBe("60000");
    expect(progress(destinationOnlyGoal.id)).toBe("60000");
    expect(progress(withdrawalGoal.id)).toBe("65000");
    expect(progress(ambiguousA.id)).toBe("80000");
    expect(progress(ambiguousB.id)).toBe("90000");
    const matchStates = await admin.query<{
      name: string;
      state: string;
    }>(
      `select goal.name,match.state
       from occurrence_transaction_matches match
       join plan_occurrences occurrence on occurrence.id=match.occurrence_id
       join savings_goals goal on goal.id=occurrence.savings_goal_id
       where match.household_id=$1 and goal.id=any($2::uuid[])
       order by goal.name`,
      [
        ids.householdA,
        [transferGoal.id, destinationOnlyGoal.id, ambiguousA.id, ambiguousB.id],
      ],
    );
    expect(matchStates.rows).toEqual([
      { name: "Ambiguous A", state: "proposed" },
      { name: "Ambiguous B", state: "proposed" },
      { name: "Destination only", state: "proposed" },
      { name: "Verified transfer", state: "confirmed" },
    ]);
    const protectedReallocation = await admin.query<{ count: number }>(
      `select count(*)::int count
       from savings_goal_movements movement
       join savings_movement_evidence evidence on evidence.movement_id=movement.id
       join financial_transactions transaction on transaction.id=evidence.transaction_id
       where movement.household_id=$1 and transaction.source_record_id='protected-reallocation-out'`,
      [ids.householdA],
    );
    expect(protectedReallocation.rows[0]?.count).toBe(0);

    fakePlaid.pages.set(
      "savings-reflected",
      syncPage({
        removed: [
          {
            transaction_id: "current-destination",
            account_id: savingsProviderIds[0]!,
          },
        ],
        nextCursor: "savings-reversed",
        updateStatus: "HISTORICAL_UPDATE_COMPLETE",
      }),
    );
    await inject(
      "POST",
      `/v1/plaid/connections/${connection.id}/sync`,
      {},
      "dev|maya",
    );
    expect(await processQueued(connection.id)).toBe(true);
    const reversed = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(
      reversed.plan.savingsGoals.find((goal) => goal.id === transferGoal.id)
        ?.progress.confirmed.minor,
    ).toBe("50000");

    const disconnected = await inject(
      "POST",
      `/v1/plaid/connections/${connection.id}/disconnect`,
      {},
      "dev|maya",
    );
    expect(disconnected.statusCode, disconnected.body).toBe(201);
    const afterDisconnect = bootstrapResponseSchema.parse(disconnected.json());
    // The unrelated fixture goal remains; every contribution backed by this
    // disconnected bank is removed from the aggregate below.
    expect(afterDisconnect.plan.plannedSavings.minor).toBe("50000");
    expect(
      afterDisconnect.plan.savingsGoals
        .filter((goal) =>
          [
            transferGoal.id,
            destinationOnlyGoal.id,
            withdrawalGoal.id,
            ambiguousA.id,
            ambiguousB.id,
          ].includes(goal.id),
        )
        .every((goal) => goal.status === "paused" && goal.destination === null),
    ).toBe(true);
  });

  it("tracks a manual debt with one payment and honest payoff visibility", async () => {
    const today = householdDate();
    const requestId = uuidv7();
    const payload = {
      accountId: null,
      name: "Visa",
      type: "credit_card",
      currentBalance: { minor: "500000", currency: "USD" },
      linkedCommitmentId: null,
      minimumPayment: { minor: "10000", currency: "USD" },
      nextDueOn: today,
      aprBasisPoints: 2400,
      paymentMode: "fixed_amount",
      fixedPayment: { minor: "15000", currency: "USD" },
      extraPayment: { minor: "0", currency: "USD" },
      createPaymentCommitment: true,
      requestId,
    } as const;
    const createdResponse = await inject(
      "POST",
      "/v1/debts",
      payload,
      "dev|maya",
    );
    expect(createdResponse.statusCode, createdResponse.body).toBe(201);
    const created = bootstrapResponseSchema.parse(createdResponse.json());
    const debt = created.debts.find((item) => item.name === "Visa")!;
    expect(debt.balance?.owed.minor).toBe("500000");
    expect(debt.projection.status).toBe("estimate");
    expect(debt.linkedCommitmentId).not.toBeNull();
    expect(debt.paymentManaged).toBe(true);
    expect(
      created.plan.commitments.filter(
        (item) => item.id === debt.linkedCommitmentId,
      ),
    ).toHaveLength(1);
    expect(created.plan.knownCash.minor).not.toBe("500000");

    const weeklyId = uuidv7();
    await admin.query(
      `insert into commitments(id,household_id,name,amount_minor,currency,due_date,recurrence,provenance) values($1,$2,'Weekly payoff',5000,'USD',$3,'weekly','manual')`,
      [weeklyId, ids.householdA, today],
    );
    await admin.query(
      `insert into commitment_revisions(household_id,commitment_id,version,name,amount_minor,currency,due_date,active,settled_at) values($1,$2,1,'Weekly payoff',5000,'USD',$3,true,null)`,
      [ids.householdA, weeklyId, today],
    );
    const invalidCadence = await inject(
      "PUT",
      `/v1/debts/${debt.id}`,
      {
        expectedVersion: debt.version,
        name: debt.name,
        type: debt.type,
        currentBalance: null,
        linkedCommitmentId: weeklyId,
        minimumPayment: debt.terms?.minimumPayment ?? null,
        nextDueOn: debt.terms?.nextDueOn ?? null,
        aprBasisPoints: debt.apr?.basisPoints ?? null,
        paymentMode: "minimum_due",
        fixedPayment: null,
        extraPayment: { minor: "0", currency: "USD" },
        createPaymentCommitment: false,
        status: "active",
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(invalidCadence.statusCode).toBe(409);

    const replay = bootstrapResponseSchema.parse(
      (await inject("POST", "/v1/debts", payload, "dev|maya")).json(),
    );
    expect(replay.debts.filter((item) => item.name === "Visa")).toHaveLength(1);

    const overpaidResponse = await inject(
      "PUT",
      `/v1/debts/${debt.id}`,
      {
        expectedVersion: debt.version,
        name: debt.name,
        type: debt.type,
        currentBalance: { minor: "-500", currency: "USD" },
        linkedCommitmentId: debt.linkedCommitmentId,
        minimumPayment: { minor: "10000", currency: "USD" },
        nextDueOn: today,
        aprBasisPoints: 2400,
        paymentMode: "fixed_amount",
        fixedPayment: { minor: "15000", currency: "USD" },
        extraPayment: { minor: "0", currency: "USD" },
        createPaymentCommitment: false,
        status: "active",
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(overpaidResponse.statusCode, overpaidResponse.body).toBe(200);
    const overpaid = bootstrapResponseSchema
      .parse(overpaidResponse.json())
      .debts.find((item) => item.id === debt.id)!;
    expect(overpaid.balance?.raw.minor).toBe("-500");
    expect(overpaid.balance?.owed.minor).toBe("0");
    expect(overpaid.projection).toMatchObject({
      status: "estimate",
      months: 0,
    });
    const renamedResponse = await inject(
      "PUT",
      `/v1/debts/${debt.id}`,
      {
        expectedVersion: overpaid.version,
        name: "Travel Visa",
        type: debt.type,
        currentBalance: { minor: "500000", currency: "USD" },
        linkedCommitmentId: debt.linkedCommitmentId,
        minimumPayment: { minor: "10000", currency: "USD" },
        nextDueOn: today,
        aprBasisPoints: 2400,
        paymentMode: "fixed_amount",
        fixedPayment: { minor: "15000", currency: "USD" },
        extraPayment: { minor: "5000", currency: "USD" },
        createPaymentCommitment: false,
        status: "active",
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(renamedResponse.statusCode, renamedResponse.body).toBe(200);
    const renamed = bootstrapResponseSchema.parse(renamedResponse.json());
    const renamedDebt = renamed.debts.find((item) => item.id === debt.id)!;
    expect(
      renamed.plan.commitments.find(
        (item) => item.id === debt.linkedCommitmentId,
      ),
    ).toMatchObject({
      name: "Travel Visa payment",
      amount: { minor: "20000" },
    });
    const archivedResponse = await inject(
      "PUT",
      `/v1/debts/${debt.id}`,
      {
        expectedVersion: renamedDebt.version,
        name: renamedDebt.name,
        type: renamedDebt.type,
        currentBalance: null,
        linkedCommitmentId: renamedDebt.linkedCommitmentId,
        minimumPayment: renamedDebt.terms?.minimumPayment ?? null,
        nextDueOn: renamedDebt.terms?.nextDueOn ?? null,
        aprBasisPoints: renamedDebt.apr?.basisPoints ?? null,
        paymentMode: renamedDebt.paymentPolicy?.mode ?? "minimum_due",
        fixedPayment: renamedDebt.paymentPolicy?.fixedAmount ?? null,
        extraPayment: renamedDebt.paymentPolicy?.extraAmount ?? {
          minor: "0",
          currency: "USD",
        },
        createPaymentCommitment: false,
        status: "archived",
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    const archived = bootstrapResponseSchema.parse(archivedResponse.json());
    expect(archived.debts.some((item) => item.id === debt.id)).toBe(false);
    expect(
      archived.plan.commitments.some(
        (item) => item.id === debt.linkedCommitmentId,
      ),
    ).toBe(false);
  });

  it("uses current liability balance instead of available credit", async () => {
    const before = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    fakePlaid.accounts = [plaidAccount(), plaidCreditAccount()];
    fakePlaid.liabilities = {
      credit: [
        {
          account_id: "plaid-credit",
          aprs: [
            {
              apr_percentage: 24.99,
              apr_type: "purchase_apr",
              balance_subject_to_apr: 1900,
              interest_charge_amount: 20,
            },
          ],
          is_overdue: false,
          last_payment_amount: 100,
          last_payment_date: householdDate(),
          last_statement_issue_date: householdDate(),
          last_statement_balance: 1900,
          minimum_payment_amount: 100,
          next_payment_due_date: householdDate(),
        },
      ],
      mortgage: null,
      student: null,
      loan: null,
    };
    const connected = bootstrapResponseSchema.parse(
      (await connectPlaid()).json(),
    );
    const card = connected.accounts.find(
      (account) => account.type === "credit",
    )!;
    expect(card.balance?.minor).toBe("200000");
    expect(card.includeInPlan).toBe(false);
    const debt = connected.debts.find((item) => item.accountId === card.id)!;
    expect(debt.balance?.owed.minor).toBe("200000");
    expect(debt.status).toBe("needs_review");
    expect(debt.terms?.minimumPayment?.minor).toBe("10000");
    expect(debt.apr?.basisPoints).toBe(2499);
    expect(connected.plan.knownCash.minor).toBe(before.plan.knownCash.minor);
    const checking = connected.accounts.find(
      (account) => account.type === "checking",
    )!;
    expect(
      (
        await inject(
          "PUT",
          `/v1/accounts/${checking.id}/planning-role`,
          {
            expectedVersion: checking.version,
            role: "spendable",
            requestId: uuidv7(),
          },
          "dev|maya",
        )
      ).statusCode,
    ).toBe(200);

    const configuredResponse = await inject(
      "PUT",
      `/v1/debts/${debt.id}`,
      {
        expectedVersion: debt.version,
        name: "Everyday card",
        type: "credit_card",
        currentBalance: null,
        linkedCommitmentId: null,
        minimumPayment: { minor: "10000", currency: "USD" },
        nextDueOn: householdDate(),
        aprBasisPoints: null,
        paymentMode: "minimum_due",
        fixedPayment: null,
        extraPayment: { minor: "0", currency: "USD" },
        createPaymentCommitment: true,
        status: "active",
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(configuredResponse.statusCode, configuredResponse.body).toBe(200);
    const configured = bootstrapResponseSchema.parse(configuredResponse.json());
    const configuredDebt = configured.debts.find(
      (item) => item.id === debt.id,
    )!;
    expect(configuredDebt.linkedCommitmentId).not.toBeNull();
    expect(configuredDebt.paymentManaged).toBe(true);
    expect(
      configured.plan.occurrences.some(
        (item) => item.commitmentId === configuredDebt.linkedCommitmentId,
      ),
    ).toBe(true);
    const connection = configured.connections.find(
      (item) => item.provider === "plaid",
    )!;
    fakePlaid.pages.set(
      "cursor-initial",
      syncPage({
        added: [
          {
            ...transferTransaction(
              "card-pay-source",
              "plaid-checking",
              100,
              householdDate(),
            ),
            merchant_name: "Everyday card",
            name: "Everyday card",
          },
          {
            ...transferTransaction(
              "card-pay-credit",
              "plaid-credit",
              -100,
              householdDate(),
            ),
            merchant_name: "Everyday card",
            name: "Everyday card",
          },
        ],
        nextCursor: "debt-payment-seen",
        updateStatus: "HISTORICAL_UPDATE_COMPLETE",
      }),
    );
    await inject(
      "POST",
      `/v1/plaid/connections/${connection.id}/sync`,
      {},
      "dev|maya",
    );
    expect(await processQueued(connection.id)).toBe(true);
    const proposed = await admin.query<{ state: string }>(
      `select match.state from occurrence_transaction_matches match join plan_occurrences occurrence on occurrence.id=match.occurrence_id where occurrence.commitment_id=$1`,
      [configuredDebt.linkedCommitmentId],
    );
    expect(proposed.rows).toEqual([{ state: "proposed" }]);
    fakePlaid.liabilities.credit[0].minimum_payment_amount = 125;
    fakePlaid.pages.set(
      "debt-payment-seen",
      syncPage({
        nextCursor: "debt-payment-reflected",
        updateStatus: "HISTORICAL_UPDATE_COMPLETE",
      }),
    );
    await inject(
      "POST",
      `/v1/plaid/connections/${connection.id}/sync`,
      {},
      "dev|maya",
    );
    expect(await processQueued(connection.id)).toBe(true);
    const verified = await admin.query<{ state: string; proof_count: number }>(
      `select match.state,(select count(*)::int from debt_payment_evidence proof where proof.occurrence_match_id=match.id) proof_count from occurrence_transaction_matches match join plan_occurrences occurrence on occurrence.id=match.occurrence_id where occurrence.commitment_id=$1`,
      [configuredDebt.linkedCommitmentId],
    );
    expect(verified.rows).toEqual([{ state: "confirmed", proof_count: 1 }]);
    const afterPayment = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(
      afterPayment.debts.find((item) => item.id === debt.id)?.balance?.owed
        .minor,
    ).toBe("200000");
    expect(
      afterPayment.plan.commitments.find(
        (item) => item.id === configuredDebt.linkedCommitmentId,
      )?.amount.minor,
    ).toBe("12500");

    const currentDebt = afterPayment.debts.find((item) => item.id === debt.id)!;
    const externalPaymentId = uuidv7();
    await admin.query(
      `insert into commitments(id,household_id,name,amount_minor,currency,due_date,recurrence,provenance) values($1,$2,'My card payment',12500,'USD',$3,'monthly','manual')`,
      [externalPaymentId, ids.householdA, householdDate()],
    );
    await admin.query(
      `insert into commitment_revisions(household_id,commitment_id,version,name,amount_minor,currency,due_date,active,settled_at) values($1,$2,1,'My card payment',12500,'USD',$3,true,null)`,
      [ids.householdA, externalPaymentId, householdDate()],
    );
    const relinkedResponse = await inject(
      "PUT",
      `/v1/debts/${debt.id}`,
      {
        expectedVersion: currentDebt.version,
        name: currentDebt.name,
        type: currentDebt.type,
        currentBalance: null,
        linkedCommitmentId: externalPaymentId,
        minimumPayment: currentDebt.terms?.minimumPayment ?? null,
        nextDueOn: currentDebt.terms?.nextDueOn ?? null,
        aprBasisPoints: currentDebt.apr?.basisPoints ?? null,
        paymentMode: "minimum_due",
        fixedPayment: null,
        extraPayment: { minor: "0", currency: "USD" },
        createPaymentCommitment: false,
        status: "active",
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    const relinked = bootstrapResponseSchema.parse(relinkedResponse.json());
    expect(relinked.debts.find((item) => item.id === debt.id)).toMatchObject({
      linkedCommitmentId: externalPaymentId,
      paymentManaged: false,
    });
    const disconnected = bootstrapResponseSchema.parse(
      (
        await inject(
          "POST",
          `/v1/plaid/connections/${connection.id}/disconnect`,
          {},
          "dev|maya",
        )
      ).json(),
    );
    expect(
      disconnected.debts.find((item) => item.id === debt.id),
    ).toMatchObject({
      status: "paused",
      linkedCommitmentId: externalPaymentId,
      paymentManaged: false,
    });
    expect(
      disconnected.debts.find((item) => item.id === debt.id)?.balance?.coverage,
    ).toBe("stale");
    expect(
      disconnected.debts.find((item) => item.id === debt.id)?.projection.status,
    ).toBe("stale");
    expect(
      disconnected.plan.commitments.some(
        (item) => item.id === externalPaymentId,
      ),
    ).toBe(true);
  });

  it("keeps a connected liability opt-out archived across later syncs", async () => {
    fakePlaid.accounts = [plaidAccount(), plaidCreditAccount()];
    const connected = bootstrapResponseSchema.parse(
      (await connectPlaid()).json(),
    );
    const debt = connected.debts.find((item) => item.provenance === "plaid")!;
    const archivedResponse = await inject(
      "PUT",
      `/v1/debts/${debt.id}`,
      {
        expectedVersion: debt.version,
        name: debt.name,
        type: debt.type,
        currentBalance: null,
        linkedCommitmentId: null,
        minimumPayment: null,
        nextDueOn: null,
        aprBasisPoints: null,
        paymentMode: "minimum_due",
        fixedPayment: null,
        extraPayment: { minor: "0", currency: "USD" },
        createPaymentCommitment: false,
        status: "archived",
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(
      bootstrapResponseSchema
        .parse(archivedResponse.json())
        .debts.some((item) => item.id === debt.id),
    ).toBe(false);
    const connection = connected.connections.find(
      (item) => item.provider === "plaid",
    )!;
    fakePlaid.pages.set(
      "cursor-initial",
      syncPage({
        nextCursor: "after-opt-out",
        updateStatus: "HISTORICAL_UPDATE_COMPLETE",
      }),
    );
    await inject(
      "POST",
      `/v1/plaid/connections/${connection.id}/sync`,
      {},
      "dev|maya",
    );
    expect(await processQueued(connection.id)).toBe(true);
    const refreshed = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(
      refreshed.debts.some((item) => item.accountId === debt.accountId),
    ).toBe(false);
  });

  it("calibrates cash, guardrails and editable commitments atomically", async () => {
    const before = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    const electricBefore = before.plan.commitments.find(
      (item) => item.name === "Electric",
    );
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
        amount:
          item.name === "Electric"
            ? { minor: "17000", currency: "USD" }
            : item.amount,
        dueDate: item.dueDate,
        setupSlot: item.setupSlot,
      })),
      removeCommitments: [],
      requestId,
    } as const;
    const saved = bootstrapResponseSchema.parse(
      (await inject("PUT", "/v1/plan/calibration", payload, "dev|maya")).json(),
    );
    expect(saved.plan.knownCash.minor).toBe("450000");
    expect(saved.plan.plannedSavings.minor).toBe("60000");
    expect(saved.plan.safetyBuffer.minor).toBe("30000");
    const renamed = saved.plan.commitments.find(
      (item) => item.name === "Power bill",
    );
    expect(renamed?.id).toBe(electricBefore?.id);
    expect(renamed?.amount.minor).toBe("17000");
    expect(renamed?.setupSlot).toBe("utilities");
    expect(
      saved.plan.commitments.some((item) => item.name === "Electric"),
    ).toBe(false);
    expect(BigInt(saved.revision)).toBe(BigInt(before.revision) + 1n);
    const retry = bootstrapResponseSchema.parse(
      (await inject("PUT", "/v1/plan/calibration", payload, "dev|maya")).json(),
    );
    expect(retry.revision).toBe(saved.revision);
    const reopened = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(
      reopened.plan.commitments.filter(
        (item) => item.setupSlot === "utilities",
      ),
    ).toEqual([
      expect.objectContaining({
        id: electricBefore?.id,
        name: "Power bill",
      }),
    ]);
  });

  it("reuses a fixed setup slot after its one-time commitment settles", async () => {
    const electric = await admin.query<{ id: string }>(
      "select id from commitments where household_id=$1 and setup_slot='utilities'",
      [ids.householdA],
    );
    await admin.query(
      "update commitments set recurrence=null,settled_at=now(),version=version+1 where id=$1",
      [electric.rows[0]!.id],
    );
    const before = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(
      before.plan.commitments.some((item) => item.setupSlot === "utilities"),
    ).toBe(false);
    const response = await inject(
      "PUT",
      "/v1/plan/calibration",
      {
        expectedVersion: before.plan.version,
        plannedSavings: before.plan.plannedSavings,
        safetyBuffer: before.plan.safetyBuffer,
        commitments: [
          ...before.plan.commitments.map((item) => ({
            id: item.id,
            expectedVersion: item.version,
            name: item.name,
            amount: item.amount,
            dueDate: item.dueDate,
            recurrence: item.recurrence,
            setupSlot: item.setupSlot,
          })),
          {
            name: "Replacement power",
            amount: { minor: "12000", currency: "USD" },
            dueDate: plusDays(householdDate(), 10),
            recurrence: "monthly",
            setupSlot: "utilities",
          },
        ],
        removeCommitments: [],
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(response.statusCode, response.body).toBe(200);
    const after = bootstrapResponseSchema.parse(response.json());
    expect(
      after.plan.commitments.filter((item) => item.setupSlot === "utilities"),
    ).toEqual([expect.objectContaining({ name: "Replacement power" })]);
  });

  it("preserves, deduplicates, and atomically undoes common-bill starter rows", async () => {
    const before = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    const existing = before.plan.commitments.map((item) => ({
      id: item.id,
      expectedVersion: item.version,
      name: item.name,
      amount: item.amount,
      dueDate: item.dueDate,
      recurrence: item.recurrence,
      setupSlot: item.setupSlot,
    }));
    const addedResponse = await inject(
      "PUT",
      "/v1/plan/calibration",
      {
        expectedVersion: before.plan.version,
        plannedSavings: before.plan.plannedSavings,
        safetyBuffer: before.plan.safetyBuffer,
        commitments: [
          ...existing,
          {
            name: "Phone & internet",
            amount: { minor: "0", currency: "USD" },
            dueDate: null,
            recurrence: "monthly",
            setupSlot: null,
            starterItemKey: "phone_internet",
          },
        ],
        starterTemplate: { key: "common_bills", version: 1 },
        removeCommitments: [],
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(addedResponse.statusCode).toBe(200);
    const added = bootstrapResponseSchema.parse(addedResponse.json());
    const phone = added.plan.commitments.find(
      (item) => item.starterItemKey === "phone_internet",
    )!;
    expect(phone.amount.minor).toBe("0");
    expect(phone.dueDate).toBeNull();
    expect(added.plan.latestStarterApplication).toMatchObject({
      itemCount: 1,
      removable: true,
    });

    const unrelated = await inject(
      "PUT",
      "/v1/plan/calibration",
      {
        expectedVersion: added.plan.version,
        plannedSavings: added.plan.plannedSavings,
        safetyBuffer: added.plan.safetyBuffer,
        commitments: added.plan.commitments.map((item) => ({
          id: item.id,
          expectedVersion: item.version,
          name: item.name,
          amount: item.amount,
          dueDate: item.dueDate,
          recurrence: item.recurrence,
          setupSlot: item.setupSlot,
        })),
        removeCommitments: [],
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(unrelated.statusCode).toBe(200);
    const reloaded = bootstrapResponseSchema.parse(unrelated.json());
    expect(
      reloaded.plan.commitments.find((item) => item.id === phone.id)
        ?.starterItemKey,
    ).toBe("phone_internet");

    const duplicate = await inject(
      "PUT",
      "/v1/plan/calibration",
      {
        expectedVersion: reloaded.plan.version,
        plannedSavings: reloaded.plan.plannedSavings,
        safetyBuffer: reloaded.plan.safetyBuffer,
        commitments: [
          ...reloaded.plan.commitments.map((item) => ({
            id: item.id,
            expectedVersion: item.version,
            name: item.id === phone.id ? "Verizon" : item.name,
            amount: item.amount,
            dueDate: item.dueDate,
            recurrence: item.recurrence,
            setupSlot: item.setupSlot,
          })),
          {
            name: "Phone & internet",
            amount: { minor: "0", currency: "USD" },
            dueDate: null,
            recurrence: "monthly",
            setupSlot: null,
            starterItemKey: "phone_internet",
          },
        ],
        starterTemplate: { key: "common_bills", version: 1 },
        removeCommitments: [],
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(duplicate.statusCode).toBe(409);

    const undo = await inject(
      "DELETE",
      `/v1/plan/starter-applications/${reloaded.plan.latestStarterApplication!.id}`,
      { requestId: uuidv7() },
      "dev|maya",
    );
    expect(undo.statusCode).toBe(200);
    const undone = bootstrapResponseSchema.parse(undo.json());
    expect(undone.plan.commitments.some((item) => item.id === phone.id)).toBe(
      false,
    );
  });

  it("round-trips duplicate legacy names without making calibration unsavable", async () => {
    const duplicate = await admin.query<{ id: string }>(
      `insert into commitments(household_id,name,amount_minor,currency,due_date,provenance)
       values($1,'Electric',9000,'USD',$2,'manual') returning id`,
      [ids.householdA, plusDays(householdDate(), 12)],
    );
    await admin.query(
      `insert into commitment_revisions(household_id,commitment_id,version,name,amount_minor,currency,due_date,active,settled_at)
       select household_id,id,version,name,amount_minor,currency,due_date,active,settled_at from commitments where id=$1`,
      [duplicate.rows[0]!.id],
    );
    const before = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(
      before.plan.commitments.filter(
        (item) => item.name.toLocaleLowerCase() === "electric",
      ),
    ).toHaveLength(2);
    const response = await inject(
      "PUT",
      "/v1/plan/calibration",
      {
        expectedVersion: before.plan.version,
        plannedSavings: before.plan.plannedSavings,
        safetyBuffer: before.plan.safetyBuffer,
        commitments: before.plan.commitments.map((item) => ({
          id: item.id,
          expectedVersion: item.version,
          name: item.name,
          amount: item.amount,
          dueDate: item.dueDate,
          recurrence: item.recurrence,
          setupSlot: item.setupSlot,
        })),
        removeCommitments: [],
        requestId: uuidv7(),
      },
      "dev|maya",
    );
    expect(response.statusCode, response.body).toBe(200);
  });

  it("does not expose the retired interactive sample connection API", async () => {
    const response = await inject(
      "POST",
      "/v1/connections/sample",
      { requestId: uuidv7() },
      "dev|maya",
    );
    expect(response.statusCode).toBe(404);
  });

  it("accepts only signed, idempotent Clerk identity-deletion events", async () => {
    const userId = "14000000-0000-4000-8000-000000000001";
    const householdId = "14000000-0000-4000-8000-000000000101";
    const clerkUserId = "user_webhook_fixture";
    await admin.query(
      "insert into users(id,auth_subject,display_name) values($1,$2,'Webhook Fixture')",
      [userId, `clerk|${clerkUserId}`],
    );
    await admin.query(
      "insert into households(id,name) values($1,'Webhook Fixture Household')",
      [householdId],
    );
    await admin.query(
      "insert into household_memberships(household_id,user_id,role) values($1,$2,'owner')",
      [householdId, userId],
    );
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
    expect(
      (
        await admin.query(
          "select status from account_deletion_requests where user_id=$1 and household_id=$2",
          [userId, householdId],
        )
      ).rows[0]?.status,
    ).toBe("ready_to_finalize");
  });

  it("keeps legacy sample ledger rows out of every live bootstrap surface", async () => {
    const connectionId = uuidv7();
    const accountId = uuidv7();
    await admin.query(
      "INSERT INTO connections (id, household_id, provider, provider_item_id, status) VALUES ($1,$2,'sample','legacy-sample-item','healthy')",
      [connectionId, ids.householdA],
    );
    await admin.query(
      "INSERT INTO accounts (id, household_id, name, account_type, currency, provenance, connection_id, provider_account_id, include_in_plan) VALUES ($1,$2,'Legacy fixture checking','checking','USD','sample',$3,'legacy-sample-account',true)",
      [accountId, ids.householdA, connectionId],
    );
    await admin.query(
      "INSERT INTO balance_observations (household_id, account_id, amount_minor, currency, provenance, as_of, source_record_id) VALUES ($1,$2,999999,'USD','sample',now(),'legacy-sample-balance')",
      [ids.householdA, accountId],
    );
    await admin.query(
      "INSERT INTO financial_transactions (household_id, account_id, source_kind, source_record_id, merchant, amount_minor, currency, direction, occurred_on, status) VALUES ($1,$2,'sample','legacy-sample-charge','Legacy fixture merchant',9999,'USD','debit',current_date,'posted')",
      [ids.householdA, accountId],
    );
    await admin.query(
      "INSERT INTO activity_events (household_id, event_type, title, detail, provenance, entity_type, entity_id) VALUES ($1,'legacy.sample','Legacy fixture activity','Must remain outside the product','sample','connection',$2)",
      [ids.householdA, connectionId],
    );
    const body = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(body.plan.knownCash.minor).toBe("423039");
    expect(body.accounts.some((item) => item.provenance === "sample")).toBe(
      false,
    );
    expect(body.connections.some((item) => item.provider === "sample")).toBe(
      false,
    );
    expect(body.transactions.some((item) => item.provenance === "sample")).toBe(
      false,
    );
    expect(
      body.activity.some((item) => item.title === "Legacy fixture activity"),
    ).toBe(false);
  });

  it("turns recurring activity into reviewable onboarding suggestions without promoting transfers", async () => {
    const today = new Date();
    const date = (daysAgo: number) => {
      const value = new Date(today);
      value.setUTCDate(value.getUTCDate() - daysAgo);
      return value.toISOString().slice(0, 10);
    };
    const rows = [
      ...[2, 16, 30, 44].map((days, index) => [
        `payroll-${index}`,
        "Payroll deposit",
        "220000",
        date(days),
        "credit",
      ]),
      ...[3, 33, 63].map((days, index) => [
        `internet-${index}`,
        "MetroNet",
        index === 0 ? "8320" : "8210",
        date(days),
        "debit",
      ]),
      ...[28, 58, 88].map((days, index) => [
        `rent-${index}`,
        "Juniper Apartments",
        "165000",
        date(days),
        "debit",
      ]),
      ...[24, 54, 84].map((days, index) => [
        `invest-${index}`,
        "Acorns",
        "2500",
        date(days),
        "debit",
      ]),
    ] as const;
    for (const [sourceId, merchant, amount, occurredOn, direction] of rows)
      await admin.query(
        "INSERT INTO financial_transactions (household_id, account_id, source_kind, source_record_id, merchant, amount_minor, currency, direction, occurred_on, status) VALUES ($1,$2,'plaid',$3,$4,$5,'USD',$6,$7,'posted')",
        [
          ids.householdA,
          ids.accountA,
          sourceId,
          merchant,
          amount,
          direction,
          occurredOn,
        ],
      );
    const analyzed = await inject(
      "POST",
      "/v1/insights/onboarding",
      { refresh: false },
      "dev|maya",
    );
    expect(analyzed.statusCode, analyzed.body).toBe(201);
    const body = onboardingAnalysisResponseSchema.parse(analyzed.json());
    expect(body.state).toBe("ready");
    expect(body.source).toBe("deterministic");
    expect(body.suggestions.incomes[0]?.name).toBe("Payroll deposit");
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
    expect(body.suggestions.commitments.map((item) => item.name)).not.toContain(
      "Online card payment",
    );
    const cached = onboardingAnalysisResponseSchema.parse(
      (
        await inject(
          "POST",
          "/v1/insights/onboarding",
          { refresh: false },
          "dev|maya",
        )
      ).json(),
    );
    expect(cached.generatedAt).toBe(body.generatedAt);
  });

  it("keeps onboarding analysis unavailable when its product flag is off", async () => {
    process.env.FEATURE_ONBOARDING_AI = "false";
    try {
      const response = await inject(
        "POST",
        "/v1/insights/onboarding",
        { refresh: false },
        "dev|maya",
      );
      expect(response.statusCode).toBe(404);
    } finally {
      process.env.FEATURE_ONBOARDING_AI = "true";
    }
  });

  it("keeps savings round-ups and pending replacements out of duplicate review", async () => {
    const occurredOn = householdDate();
    for (const merchant of [
      "Round Up to Savings",
      "Round Up from Credit Card",
    ]) {
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
    const savings = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(savings.cases.some((item) => item.title.includes("Round Up"))).toBe(
      false,
    );

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
    const ordinary = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(
      ordinary.cases.some((item) =>
        item.title.includes("Ordinary duplicate fixture"),
      ),
    ).toBe(true);
    const duplicate = ordinary.cases.find((item) =>
      item.title.includes("Ordinary duplicate fixture"),
    )!;
    const decision = {
      decision: "expected" as const,
      expectedVersion: duplicate.version,
      requestId: uuidv7(),
    };
    expect(
      (
        await inject(
          "POST",
          `/v1/cases/${duplicate.id}/decision`,
          decision,
          "dev|maya",
        )
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await inject(
          "POST",
          `/v1/cases/${duplicate.id}/decision`,
          { ...decision, requestId: uuidv7() },
          "dev|maya",
        )
      ).statusCode,
    ).toBe(409);
  });

  it("surfaces every active commitment while reserving only overdue and in-horizon dated items", async () => {
    const today = householdDate();
    const insert = async (
      name: string,
      amount: number,
      offset: number | null,
      settled = false,
    ) => {
      const created = await admin.query<{ id: string }>(
        "INSERT INTO commitments (household_id, name, amount_minor, currency, due_date, provenance, settled_at) VALUES ($1, $2, $3, 'USD', $4, 'manual', $5) RETURNING id",
        [
          ids.householdA,
          name,
          amount,
          offset === null ? null : plusDays(today, offset),
          settled ? new Date() : null,
        ],
      );
      await admin.query(
        "INSERT INTO commitment_revisions(household_id,commitment_id,version,name,amount_minor,currency,due_date,recurrence,active,settled_at) SELECT household_id,id,version,name,amount_minor,currency,due_date,recurrence,active,settled_at FROM commitments WHERE id=$1",
        [created.rows[0]!.id],
      );
      await admin.query(
        "INSERT INTO plan_occurrences(household_id,source_key,kind,commitment_id,name,expected_amount_minor,expected_on,provenance) SELECT household_id,'commitment:'||id::text,'commitment',id,name,amount_minor,due_date,provenance FROM commitments WHERE id=$1 AND due_date IS NOT NULL AND settled_at IS NULL",
        [created.rows[0]!.id],
      );
    };
    await insert("Overdue", 100, -5);
    await insert("Boundary", 200, 14);
    await insert("Undated", 50, null);
    await insert("Outside", 400, 15);
    await insert("Settled", 800, 1, true);
    const body = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(body.plan.reserved.minor).toBe("294939");
    expect(body.plan.commitments.map((item) => item.name)).toEqual(
      expect.arrayContaining(["Overdue", "Boundary", "Undated", "Outside"]),
    );
    expect(body.plan.commitments.map((item) => item.name)).not.toContain(
      "Settled",
    );
  });

  it("keeps a surfaced out-of-horizon commitment active through calibration", async () => {
    const outsideId = uuidv7();
    const outsideDate = plusDays(householdDate(), 30);
    await admin.query(
      "INSERT INTO commitments (id, household_id, name, amount_minor, currency, due_date, provenance) VALUES ($1, $2, 'Future tuition', 250000, 'USD', $3, 'manual')",
      [outsideId, ids.householdA, outsideDate],
    );
    await admin.query(
      "INSERT INTO commitment_revisions(household_id,commitment_id,version,name,amount_minor,currency,due_date,recurrence,active,settled_at) SELECT household_id,id,version,name,amount_minor,currency,due_date,recurrence,active,settled_at FROM commitments WHERE id=$1",
      [outsideId],
    );
    await admin.query(
      "INSERT INTO plan_occurrences(household_id,source_key,kind,commitment_id,name,expected_amount_minor,expected_on,provenance) SELECT household_id,'commitment:'||id::text,'commitment',id,name,amount_minor,due_date,provenance FROM commitments WHERE id=$1",
      [outsideId],
    );
    const before = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(before.plan.commitments.some((item) => item.id === outsideId)).toBe(
      true,
    );
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
    expect(
      (await inject("PUT", "/v1/plan/calibration", payload, "dev|maya"))
        .statusCode,
    ).toBe(200);
    const stored = await admin.query<{ active: boolean }>(
      "SELECT active FROM commitments WHERE id = $1",
      [outsideId],
    );
    expect(stored.rows[0]?.active).toBe(true);
  });

  it("forces RLS on every household-owned table", async () => {
    const result = await admin.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      "SELECT DISTINCT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'household_id' AND NOT a.attisdropped WHERE n.nspname = 'public' AND c.relkind = 'r' AND (a.attname IS NOT NULL OR c.relname = 'households') ORDER BY c.relname",
    );
    expect(result.rows.map((row) => row.relname)).toEqual(
      expect.arrayContaining([
        "accounts",
        "activity_events",
        "balance_observations",
        "calculation_snapshot_inputs",
        "calculation_snapshots",
        "case_evidence",
        "commitment_revisions",
        "commitments",
        "connections",
        "exception_cases",
        "financial_transactions",
        "household_memberships",
        "households",
        "idempotency_records",
        "plan_revisions",
        "plans",
        "sync_runs",
        "webhook_receipts",
      ]),
    );
    const ownerBypassTables = new Set([
      "account_deletion_requests",
      "available_cash_alert_episodes",
      "available_cash_alert_states",
      "connections",
      "financial_pattern_analyses",
      "notification_deliveries",
      "notification_endpoints",
      "notification_events",
      "notification_preferences",
      "plaid_sync_jobs",
      "starter_template_application_items",
      "starter_template_applications",
    ]);
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
    }>(
      "SELECT has_table_privilege('budgefi_app', 'users', 'SELECT') AS users_read, has_table_privilege('budgefi_app', 'schema_migrations', 'SELECT') AS migrations_read, has_table_privilege('budgefi_app', 'accounts', 'SELECT') AS accounts_read",
    );
    expect(privileges.rows[0]).toEqual({
      users_read: false,
      migrations_read: false,
      accounts_read: true,
    });
  });

  it("hands household ownership to a successor before requesting account deletion", async () => {
    await admin.query(
      "insert into household_memberships(household_id,user_id,role,onboarding_completed_at) values($1,$2,'member',now())",
      [ids.householdA, ids.userB],
    );
    const requested = await inject(
      "POST",
      "/v1/account/deletion",
      { confirmation: "DELETE", requestId: uuidv7() },
      "dev|maya",
    );
    expect(requested.statusCode, requested.body).toBe(201);
    expect(
      (
        await admin.query<{ role: string }>(
          "select role from household_memberships where household_id=$1 and user_id=$2",
          [ids.householdA, ids.userB],
        )
      ).rows[0]?.role,
    ).toBe("owner");
    expect(
      (
        await admin.query<{ status: string }>(
          "select status from account_deletion_requests where household_id=$1 and user_id=$2",
          [ids.householdA, ids.userA],
        )
      ).rows[0]?.status,
    ).toBe("ready_to_finalize");
  });

  it("blocks new bank links as soon as final-household deletion begins", async () => {
    const issued = await inject(
      "POST",
      "/v1/plaid/link-token",
      { mode: "create" },
      "dev|maya",
    );
    expect(issued.statusCode).toBe(201);
    const requested = await inject(
      "POST",
      "/v1/account/deletion",
      { confirmation: "DELETE", requestId: uuidv7() },
      "dev|maya",
    );
    expect(requested.statusCode, requested.body).toBe(201);
    expect(
      (
        await admin.query<{ lifecycle_state: string }>(
          "select lifecycle_state from households where id=$1",
          [ids.householdA],
        )
      ).rows[0]?.lifecycle_state,
    ).toBe("deleting");
    const link = await inject(
      "POST",
      "/v1/plaid/link-token",
      { mode: "create" },
      "dev|maya",
    );
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
    const [first, second] = await Promise.all([
      inject("GET", "/v1/bootstrap", undefined, subject),
      inject("GET", "/v1/bootstrap", undefined, subject),
    ]);
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
    expect(bootstrapResponseSchema.parse(second.json()).household.id).toBe(
      householdId,
    );
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

    const completed = await inject(
      "POST",
      "/v1/onboarding/complete",
      {},
      subject,
    );
    expect(completed.statusCode).toBe(201);
    expect(
      bootstrapResponseSchema.parse(completed.json()).household
        .onboardingCompleted,
    ).toBe(true);
    expect(
      bootstrapResponseSchema.parse(
        (await inject("GET", "/v1/bootstrap", undefined, subject)).json(),
      ).household.onboardingCompleted,
    ).toBe(true);
    const completionEvents = await admin.query<{ count: number }>(
      "select count(*)::int count from activity_events where household_id = $1 and event_type = 'onboarding.completed'",
      [householdId],
    );
    expect(completionEvents.rows[0]?.count).toBe(1);
    await inject("POST", "/v1/onboarding/complete", {}, subject);
    expect(
      (
        await admin.query<{ count: number }>(
          "select count(*)::int count from activity_events where household_id = $1 and event_type = 'onboarding.completed'",
          [householdId],
        )
      ).rows[0]?.count,
    ).toBe(1);

    const secondHousehold = uuidv7();
    const userId = (
      await admin.query<{ id: string }>(
        "select id from users where auth_subject = $1",
        [subject],
      )
    ).rows[0]!.id;
    await admin.query(
      "insert into households (id, name) values ($1, 'Second household')",
      [secondHousehold],
    );
    await admin.query(
      "insert into household_memberships (household_id, user_id, role) values ($1, $2, 'owner')",
      [secondHousehold, userId],
    );
    expect(
      (await inject("GET", "/v1/bootstrap", undefined, subject)).statusCode,
    ).toBe(403);
    expect(
      (await inject("GET", "/v1/bootstrap", undefined, subject, householdId))
        .statusCode,
    ).toBe(200);
  });

  it("exchanges a server-side Plaid token, synchronizes revisions, and revokes provider access", async () => {
    const link = await inject(
      "POST",
      "/v1/plaid/link-token",
      { mode: "create" },
      "dev|maya",
    );
    expect(link.statusCode).toBe(201);
    const sessionId = link.json().sessionId as string;
    const exchangePayload = {
      sessionId,
      publicToken: "public-sandbox-token",
      linkSessionId: "link-session-1",
      institution: { id: "ins_109508", name: "First Platypus Bank" },
      requestId: uuidv7(),
    };
    const exchanged = await inject(
      "POST",
      "/v1/plaid/exchange",
      exchangePayload,
      "dev|maya",
    );
    expect(exchanged.statusCode).toBe(201);
    const accepted = bootstrapResponseSchema.parse(exchanged.json());
    const connection = accepted.connections.find(
      (item) => item.provider === "plaid",
    );
    expect(connection).toMatchObject({
      environment: "sandbox",
      institutionName: "First Platypus Bank",
      status: "syncing",
      initialUpdateComplete: false,
    });
    expect(
      accepted.accounts.some((account) => account.provenance === "plaid"),
    ).toBe(false);
    expect(await processQueued(connection!.id)).toBe(true);
    const initial = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(
      initial.connections.find((item) => item.id === connection!.id),
    ).toMatchObject({ status: "healthy", initialUpdateComplete: true });
    const plaidAccount = initial.accounts.find(
      (account) => account.provenance === "plaid",
    );
    expect(plaidAccount).toMatchObject({
      includeInPlan: false,
      coverage: "excluded",
      balance: { minor: "120034", currency: "USD" },
    });
    expect(
      initial.transactions.find(
        (transaction) => transaction.merchant === "Coffee Lab",
      ),
    ).toMatchObject({
      amount: { minor: "825", currency: "USD" },
      status: "pending",
    });
    const pendingPublicId = initial.transactions.find(
      (transaction) => transaction.merchant === "Coffee Lab",
    )!.id;
    const pendingCategory = initial.transactions.find(
      (transaction) => transaction.id === pendingPublicId,
    )!;
    expect(
      (
        await inject(
          "PUT",
          `/v1/transactions/${pendingPublicId}/category`,
          {
            category: "dining",
            expectedVersion: pendingCategory.categoryVersion,
            applyToFuture: false,
            requestId: uuidv7(),
          },
          "dev|maya",
        )
      ).statusCode,
    ).toBe(200);
    expect(fakePlaid.exchangeCalls).toBe(1);
    const replay = await inject(
      "POST",
      "/v1/plaid/exchange",
      { ...exchangePayload, requestId: uuidv7() },
      "dev|maya",
    );
    expect(replay.statusCode).toBe(201);
    expect(fakePlaid.exchangeCalls).toBe(1);
    const stored = await admin.query<{ encrypted: string }>(
      "select encode(encrypted_access_token, 'escape') encrypted from connections where id = $1",
      [connection!.id],
    );
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
        removed: [
          { transaction_id: "pending-coffee", account_id: "plaid-checking" },
        ],
        nextCursor: "cursor-posted",
        updateStatus: "HISTORICAL_UPDATE_COMPLETE",
      }),
    );
    const synchronized = await inject(
      "POST",
      `/v1/plaid/connections/${connection!.id}/sync`,
      {},
      "dev|maya",
    );
    expect(synchronized.statusCode).toBe(201);
    expect(
      bootstrapResponseSchema
        .parse(synchronized.json())
        .connections.find((item) => item.id === connection!.id)?.status,
    ).toBe("syncing");
    expect(await processQueued(connection!.id)).toBe(true);
    const afterSync = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(
      afterSync.transactions.find(
        (transaction) =>
          transaction.merchant === "Coffee Lab" &&
          transaction.status === "posted",
      ),
    ).toBeTruthy();
    expect(
      afterSync.transactions.filter(
        (transaction) => transaction.merchant === "Coffee Lab",
      ),
    ).toHaveLength(1);
    expect(
      afterSync.transactions.find(
        (transaction) => transaction.merchant === "Coffee Lab",
      )?.id,
    ).toBe(pendingPublicId);
    expect(
      afterSync.transactions.find(
        (transaction) => transaction.merchant === "Coffee Lab",
      )?.category,
    ).toBe("dining");
    const pendingRevision = await admin.query<{
      revision: number;
      status: string;
    }>(
      "select revision, status from financial_transactions where household_id = $1 and source_kind = 'plaid' and source_record_id = 'pending-coffee' order by revision desc limit 1",
      [ids.householdA],
    );
    expect(pendingRevision.rows[0]).toEqual({ revision: 2, status: "removed" });
    expect(afterSync.connections[0]?.historicalUpdateComplete).toBe(true);

    fakePlaid.pages.set(
      "cursor-posted",
      syncPage({
        modified: [
          plaidTransaction({
            transaction_id: "posted-coffee",
            pending_transaction_id: "pending-coffee",
            pending: false,
            personal_finance_category: {
              primary: "TRANSPORTATION",
              detailed: "TRANSPORTATION_PUBLIC_TRANSIT",
              confidence_level: "VERY_HIGH",
            } as NonNullable<Transaction["personal_finance_category"]>,
          }),
        ],
        nextCursor: "cursor-category",
        updateStatus: "HISTORICAL_UPDATE_COMPLETE",
      }),
    );
    await inject(
      "POST",
      `/v1/plaid/connections/${connection!.id}/sync`,
      {},
      "dev|maya",
    );
    expect(await processQueued(connection!.id)).toBe(true);
    const categoryEvidence = await admin.query<{
      revision: number;
      provider_category_primary: string;
    }>(
      "select revision,provider_category_primary from financial_transactions where household_id=$1 and source_record_id='posted-coffee' order by revision desc limit 1",
      [ids.householdA],
    );
    expect(categoryEvidence.rows[0]).toEqual({
      revision: 2,
      provider_category_primary: "TRANSPORTATION",
    });
    const afterCategoryEvidence = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(
      afterCategoryEvidence.transactions.find(
        (transaction) => transaction.id === pendingPublicId,
      )?.category,
    ).toBe("dining");

    const disconnected = await inject(
      "POST",
      `/v1/plaid/connections/${connection!.id}/disconnect`,
      {},
      "dev|maya",
    );
    expect(disconnected.statusCode).toBe(201);
    expect(
      bootstrapResponseSchema
        .parse(disconnected.json())
        .connections.find((item) => item.id === connection!.id)?.status,
    ).toBe("revocation_pending");
    expect(await processQueued(connection!.id, "revoke")).toBe(true);
    expect(fakePlaid.removedTokens).toContain("access-sandbox-token");
    const erased = await admin.query<{ token: Buffer | null }>(
      "select encrypted_access_token token from connections where id = $1",
      [connection!.id],
    );
    expect(erased.rows[0]!.token).toBeNull();
    const disconnectedHistory = transactionFeedResponseSchema.parse(
      (await inject("GET", "/v1/transactions", undefined, "dev|maya")).json(),
    );
    expect(
      disconnectedHistory.accounts.some(
        (account) =>
          account.name.startsWith("Everyday checking") && account.archived,
      ),
    ).toBe(true);
  });

  it("keeps the first healthy Item and revokes an accidental duplicate bank-link retry", async () => {
    fakePlaid.uniqueItems = true;
    const firstLink = await inject(
      "POST",
      "/v1/plaid/link-token",
      { mode: "create" },
      "dev|maya",
    );
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
    const first = bootstrapResponseSchema
      .parse(firstExchange.json())
      .connections.find((item) => item.provider === "plaid")!;
    expect(await processQueued(first.id)).toBe(true);

    const secondLink = await inject(
      "POST",
      "/v1/plaid/link-token",
      { mode: "create" },
      "dev|maya",
    );
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
    const second = bootstrapResponseSchema
      .parse(secondExchange.json())
      .connections.find(
        (item) => item.provider === "plaid" && item.id !== first.id,
      )!;
    expect(second.id).toBeTruthy();
    expect(await processQueued(second.id)).toBe(true);

    const pending = await admin.query<{ id: string; status: string }>(
      "select id,status from connections where id=any($1::uuid[]) order by created_at",
      [[first.id, second.id]],
    );
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
    const queued = await admin.query<{ receipts: number; jobs: number }>(
      "select (select count(*)::int from webhook_receipts where household_id = $1) receipts, (select count(*)::int from plaid_sync_jobs where household_id = $1 and trigger = 'webhook') jobs",
      [ids.householdA],
    );
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
    const expired = await fakePlaid.signWebhook(
      payload,
      Math.floor(Date.now() / 1_000) - 301,
    );
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
    const connected = bootstrapResponseSchema.parse(
      (await connectPlaid()).json(),
    );
    const connection = connected.connections.find(
      (item) => item.provider === "plaid",
    )!;
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
    const bootstrap = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(
      bootstrap.connections.find((item) => item.id === connection.id)?.status,
    ).toBe("revoked");
    expect(
      (
        await admin.query<{ token: Buffer | null }>(
          "select encrypted_access_token token from connections where id = $1",
          [connection.id],
        )
      ).rows[0]!.token,
    ).toBeNull();
  });

  it("keeps webhook revocation durable across a worker crash and converges on retry", async () => {
    const connected = bootstrapResponseSchema.parse(
      (await connectPlaid()).json(),
    );
    const connection = connected.connections.find(
      (item) => item.provider === "plaid",
    )!;
    const payload = JSON.stringify({
      webhook_type: "ITEM",
      webhook_code: "USER_PERMISSION_REVOKED",
      item_id: "item-sandbox",
      environment: "sandbox",
    });
    const signature = await fakePlaid.signWebhook(payload);
    await admin.query(
      `create function test_block_revocation() returns trigger language plpgsql as $$ begin if new.status = 'revoked' then raise exception 'simulated crash boundary'; end if; return new; end $$`,
    );
    await admin.query(
      "create trigger test_block_revocation before update on connections for each row execute function test_block_revocation()",
    );
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
      }>(
        "select (select count(*)::int from webhook_receipts) receipts, status, encrypted_access_token is not null token_present from connections where id = $1",
        [connection.id],
      );
      expect(interrupted.rows[0]).toEqual({
        receipts: 1,
        status: "revocation_pending",
        token_present: true,
      });
    } finally {
      await admin.query(
        "drop trigger if exists test_block_revocation on connections",
      );
      await admin.query("drop function if exists test_block_revocation()");
    }
    expect(
      (
        await inject(
          "POST",
          `/v1/plaid/connections/${connection.id}/disconnect`,
          {},
          "dev|maya",
        )
      ).statusCode,
    ).toBe(201);
    expect(await processQueued(connection.id, "revoke")).toBe(true);
    const converged = await admin.query<{
      receipts: number;
      status: string;
      token_present: boolean;
    }>(
      "select (select count(*)::int from webhook_receipts) receipts, status, encrypted_access_token is not null token_present from connections where id = $1",
      [connection.id],
    );
    expect(converged.rows[0]).toEqual({
      receipts: 1,
      status: "revoked",
      token_present: false,
    });
  });

  it("restarts pagination from the committed cursor and fails closed on token tampering", async () => {
    const connected = bootstrapResponseSchema.parse(
      (await connectPlaid()).json(),
    );
    const connection = connected.connections.find(
      (item) => item.provider === "plaid",
    )!;
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
    const converged = await inject(
      "POST",
      `/v1/plaid/connections/${connection.id}/sync`,
      {},
      "dev|maya",
    );
    expect(converged.statusCode).toBe(201);
    expect(await processQueued(connection.id)).toBe(true);
    expect(fakePlaid.syncCallCursors).toEqual([
      "cursor-initial",
      "page-2",
      "cursor-initial",
      "page-2",
    ]);
    expect(
      bootstrapResponseSchema
        .parse(
          (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
        )
        .connections.find((item) => item.id === connection.id)
        ?.historicalUpdateComplete,
    ).toBe(true);

    await admin.query(
      "update connections set encrypted_access_token = set_byte(encrypted_access_token, 0, 0) where id = $1",
      [connection.id],
    );
    const failedClosed = await inject(
      "POST",
      `/v1/plaid/connections/${connection.id}/sync`,
      {},
      "dev|maya",
    );
    expect(failedClosed.statusCode).toBe(201);
    expect(await processQueued(connection.id)).toBe(false);
    const failedBootstrap = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(
      failedBootstrap.connections.find((item) => item.id === connection.id),
    ).toMatchObject({ status: "error", errorCode: "Error" });
    const cursor = await admin.query<{ sync_cursor: string }>(
      "select sync_cursor from connections where id = $1",
      [connection.id],
    );
    expect(cursor.rows[0]!.sync_cursor).toBe("cursor-after-restart");
  });

  it("keeps accounts excluded while provider revocation retries durably", async () => {
    const connected = bootstrapResponseSchema.parse(
      (await connectPlaid()).json(),
    );
    const connection = connected.connections.find(
      (item) => item.provider === "plaid",
    )!;
    fakePlaid.removeFailuresRemaining = 1;
    const pending = await inject(
      "POST",
      `/v1/plaid/connections/${connection.id}/disconnect`,
      {},
      "dev|maya",
    );
    expect(pending.statusCode).toBe(201);
    const pendingBody = bootstrapResponseSchema.parse(pending.json());
    expect(
      pendingBody.connections.find((item) => item.id === connection.id)?.status,
    ).toBe("revocation_pending");
    expect(
      pendingBody.accounts
        .filter((account) => account.connectionId === connection.id)
        .every((account) => !account.includeInPlan),
    ).toBe(true);
    const job = await admin.query<{ id: string }>(
      "select id from plaid_sync_jobs where connection_id = $1 and operation = 'revoke' and state = 'queued'",
      [connection.id],
    );
    expect(
      await app.get(PlaidService).processJob(job.rows[0]!.id, ids.householdA),
    ).toBe(false);
    await admin.query(
      "update plaid_sync_jobs set available_at=now() where id=$1",
      [job.rows[0]!.id],
    );
    fakePlaid.alreadyRemovedOnNext = true;
    expect(
      await app.get(PlaidService).processJob(job.rows[0]!.id, ids.householdA),
    ).toBe(true);
    const revoked = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(
      revoked.connections.find((item) => item.id === connection.id)?.status,
    ).toBe("revoked");
    expect(
      (
        await admin.query<{ token: Buffer | null }>(
          "select encrypted_access_token token from connections where id = $1",
          [connection.id],
        )
      ).rows[0]!.token,
    ).toBeNull();
  });

  it("reports a stored Item as connected but not synchronized when the initial job must retry", async () => {
    const link = await inject(
      "POST",
      "/v1/plaid/link-token",
      { mode: "create" },
      "dev|maya",
    );
    fakePlaid.pages.clear();
    const payload = {
      sessionId: link.json().sessionId,
      publicToken: "public-sync-failure",
      requestId: uuidv7(),
    };
    const result = await inject(
      "POST",
      "/v1/plaid/exchange",
      payload,
      "dev|maya",
    );
    expect(result.statusCode).toBe(201);
    const connection = bootstrapResponseSchema
      .parse(result.json())
      .connections.find((item) => item.provider === "plaid")!;
    expect(connection).toMatchObject({
      status: "syncing",
      initialUpdateComplete: false,
    });
    expect(await processQueued(connection.id)).toBe(false);
    expect(fakePlaid.removedTokens).toEqual([]);
    expect(
      (
        await inject(
          "POST",
          "/v1/plaid/exchange",
          { ...payload, requestId: uuidv7() },
          "dev|maya",
        )
      ).statusCode,
    ).toBe(201);
    expect(fakePlaid.exchangeCalls).toBe(1);
    const bootstrap = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(
      bootstrap.connections.find((item) => item.provider === "plaid"),
    ).toMatchObject({ status: "error", initialUpdateComplete: false });
    expect(
      bootstrap.accounts.find((item) => item.provenance === "plaid"),
    ).toMatchObject({
      balance: { minor: "120034", currency: "USD" },
      includeInPlan: false,
      coverage: "excluded",
    });
  });

  it("reports a completed update session while keeping its failed sync visible", async () => {
    const connected = bootstrapResponseSchema.parse(
      (await connectPlaid()).json(),
    );
    const connection = connected.connections.find(
      (item) => item.provider === "plaid",
    )!;
    const link = await inject(
      "POST",
      "/v1/plaid/link-token",
      { mode: "update", connectionId: connection.id },
      "dev|maya",
    );
    fakePlaid.pages.clear();
    const payload = {
      sessionId: link.json().sessionId,
      linkSessionId: "update-link-session",
      requestId: uuidv7(),
    };
    expect(
      (await inject("POST", "/v1/plaid/update-complete", payload, "dev|maya"))
        .statusCode,
    ).toBe(201);
    expect(
      (
        await inject(
          "POST",
          "/v1/plaid/update-complete",
          { ...payload, requestId: uuidv7() },
          "dev|maya",
        )
      ).statusCode,
    ).toBe(201);
    expect(await processQueued(connection.id)).toBe(false);
    const state = bootstrapResponseSchema.parse(
      (await inject("GET", "/v1/bootstrap", undefined, "dev|maya")).json(),
    );
    expect(
      state.connections.find((item) => item.id === connection.id)?.status,
    ).toBe("error");
  });

  it("runs an explicitly requested sync immediately even when an older retry is backed off", async () => {
    const connected = bootstrapResponseSchema.parse(
      (await connectPlaid()).json(),
    );
    const connection = connected.connections.find(
      (item) => item.provider === "plaid",
    )!;
    fakePlaid.pages.set(
      "cursor-initial",
      syncPage({
        nextCursor: "cursor-refreshed",
        updateStatus: "HISTORICAL_UPDATE_COMPLETE",
      }),
    );
    const delayedJobId = uuidv7();
    await admin.query(
      "insert into plaid_sync_jobs(id,household_id,connection_id,operation,trigger,state,available_at) values($1,$2,$3,'sync','recovery','queued',now()+interval '1 hour')",
      [delayedJobId, ids.householdA, connection.id],
    );
    const refreshed = await inject(
      "POST",
      `/v1/plaid/connections/${connection.id}/sync`,
      {},
      "dev|maya",
    );
    expect(refreshed.statusCode).toBe(201);
    expect(
      bootstrapResponseSchema
        .parse(refreshed.json())
        .connections.find((item) => item.id === connection.id)?.status,
    ).toBe("syncing");
    expect(
      await app.get(PlaidService).processJob(delayedJobId, ids.householdA),
    ).toBe(true);
    expect(
      (
        await admin.query<{ state: string }>(
          "select state from plaid_sync_jobs where id=$1",
          [delayedJobId],
        )
      ).rows[0]?.state,
    ).toBe("succeeded");
  });

  it("accepts a manual sync when another worker already owns the durable job", async () => {
    const connected = bootstrapResponseSchema.parse(
      (await connectPlaid()).json(),
    );
    const connection = connected.connections.find(
      (item) => item.provider === "plaid",
    )!;
    await admin.query(
      "insert into plaid_sync_jobs(id,household_id,connection_id,operation,trigger,state,available_at,locked_at) values($1,$2,$3,'sync','scheduled','running',now(),now())",
      [uuidv7(), ids.householdA, connection.id],
    );
    const accepted = await inject(
      "POST",
      `/v1/plaid/connections/${connection.id}/sync`,
      {},
      "dev|maya",
    );
    expect(accepted.statusCode).toBe(201);
    expect(
      bootstrapResponseSchema
        .parse(accepted.json())
        .connections.find((item) => item.id === connection.id)?.status,
    ).toBe("syncing");
  });

  it("allows the same public token to recover a stale pre-consumption exchange attempt", async () => {
    const link = await inject(
      "POST",
      "/v1/plaid/link-token",
      { mode: "create" },
      "dev|maya",
    );
    const publicToken = "public-stale-recovery";
    await admin.query(
      "update plaid_link_sessions set status = 'exchanging', public_token_hash = $1, exchange_started_at = now() - interval '3 minutes' where id = $2",
      [
        createHash("sha256").update(publicToken).digest("hex"),
        link.json().sessionId,
      ],
    );
    const recovered = await inject(
      "POST",
      "/v1/plaid/exchange",
      { sessionId: link.json().sessionId, publicToken, requestId: uuidv7() },
      "dev|maya",
    );
    expect(recovered.statusCode).toBe(201);
    const connection = bootstrapResponseSchema
      .parse(recovered.json())
      .connections.find((item) => item.provider === "plaid")!;
    expect(connection.status).toBe("syncing");
    expect(await processQueued(connection.id)).toBe(true);
  });

  it("completes a tenant-bound native Hosted Link session server-side", async () => {
    const link = await inject(
      "POST",
      "/v1/plaid/link-token",
      { mode: "create", nativeHosted: true },
      "dev|maya",
    );
    expect(link.statusCode).toBe(201);
    expect(link.json().hostedLinkUrl).toBe(
      "https://secure.plaid.test/hosted-link",
    );
    expect(fakePlaid.nativeCompletionUri).toContain(
      "budgefi://open/plaid-complete?session_id=",
    );

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
    expect(
      bootstrapResponseSchema
        .parse(completed.json())
        .connections.find((item) => item.provider === "plaid")?.institutionName,
    ).toBe("First Platypus Bank");
  });

  function inject(
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload: unknown,
    subject: string,
    householdId?: string,
  ) {
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
    const link = await inject(
      "POST",
      "/v1/plaid/link-token",
      { mode: "create" },
      "dev|maya",
    );
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
    const connection = bootstrapResponseSchema
      .parse(exchanged.json())
      .connections.find((item) => item.provider === "plaid")!;
    expect(await processQueued(connection.id)).toBe(true);
    return inject("GET", "/v1/bootstrap", undefined, "dev|maya");
  }

  async function processQueued(
    connectionId: string,
    operation: "sync" | "revoke" = "sync",
  ) {
    const job = await admin.query<{ id: string }>(
      "select id from plaid_sync_jobs where connection_id=$1 and operation=$2 and state='queued' order by created_at limit 1",
      [connectionId, operation],
    );
    expect(job.rows[0]?.id).toBeTruthy();
    return app.get(PlaidService).processJob(job.rows[0]!.id, ids.householdA);
  }
});

class FakePlaidGateway {
  readonly pages = new Map<string, PlaidSyncPage>();
  accounts: AccountBase[] = [plaidAccount()];
  readonly removedTokens: string[] = [];
  readonly syncCallCursors: string[] = [];
  exchangeCalls = 0;
  accountCalls = 0;
  mutationFailuresRemaining = 0;
  removeFailuresRemaining = 0;
  alreadyRemovedOnNext = false;
  nativeCompletionUri: string | null = null;
  linkCalls = 0;
  uniqueItems = false;
  liabilities: any = null;
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
    this.accountCalls = 0;
    this.mutationFailuresRemaining = 0;
    this.removeFailuresRemaining = 0;
    this.alreadyRemovedOnNext = false;
    this.nativeCompletionUri = null;
    this.linkCalls = 0;
    this.uniqueItems = false;
    this.liabilities = null;
    this.accounts = [plaidAccount()];
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
      ...(input?.nativeCompletionUri
        ? { hostedLinkUrl: "https://secure.plaid.test/hosted-link" }
        : {}),
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
    this.accountCalls += 1;
    return {
      accounts: this.accounts,
      institutionId: "ins_109508",
      requestId: `accounts-request-${this.accountCalls}`,
    };
  }
  async getInstitutionName(): Promise<string> {
    return "First Platypus Bank";
  }
  async getLiabilities(): Promise<any> {
    return this.liabilities
      ? {
          liabilities: this.liabilities,
          requestId: `liabilities-request-${this.accountCalls}`,
        }
      : null;
  }
  async syncTransactions(
    _token: string,
    cursor: string | null,
  ): Promise<PlaidSyncPage> {
    this.syncCallCursors.push(cursor ?? "<initial>");
    if (cursor === "page-2" && this.mutationFailuresRemaining > 0) {
      this.mutationFailuresRemaining -= 1;
      throw new PlaidRequestError(
        "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
        "mutation-request",
        true,
      );
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

function plaidAccountWithBalance(balance: number): AccountBase {
  const account = plaidAccount();
  return {
    ...account,
    balances: { ...account.balances, available: balance, current: balance },
  } as AccountBase;
}

function incomeTransaction(
  transactionId: string,
  amount: number,
  date: string,
): Transaction {
  return plaidTransaction({
    transaction_id: transactionId,
    pending: false,
    amount: -amount,
    date,
    authorized_date: date,
    name: "Employer payroll",
    merchant_name: "Employer payroll",
    personal_finance_category: {
      primary: "INCOME",
      detailed: "INCOME_WAGES",
      confidence_level: "VERY_HIGH",
    } as NonNullable<Transaction["personal_finance_category"]>,
  });
}

function plaidSavingsAccount(
  accountId = "plaid-savings",
  balance = 500,
): AccountBase {
  return {
    ...plaidAccount(),
    account_id: accountId,
    balances: {
      available: balance,
      current: balance,
      limit: null,
      iso_currency_code: "USD",
      unofficial_currency_code: null,
    },
    mask: "9876",
    name: "Rainy day savings",
    official_name: "Rainy Day Savings",
    persistent_account_id: `persistent-${accountId}`,
    subtype: "savings",
  } as unknown as AccountBase;
}

function plaidCreditAccount(): AccountBase {
  return {
    ...plaidAccount(),
    account_id: "plaid-credit",
    balances: {
      available: 8000,
      current: 2000,
      limit: 10000,
      iso_currency_code: "USD",
      unofficial_currency_code: null,
    },
    mask: "4444",
    name: "Everyday card",
    official_name: "Everyday Credit Card",
    persistent_account_id: "persistent-credit",
    type: "credit",
    subtype: "credit card",
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

function transferTransaction(
  transactionId: string,
  accountId: string,
  amount: number,
  date: string,
): Transaction {
  return plaidTransaction({
    transaction_id: transactionId,
    account_id: accountId,
    amount,
    date,
    authorized_date: date,
    pending: false,
    merchant_name: "Account transfer",
    name: "Account transfer",
    personal_finance_category: {
      primary: "TRANSFER_IN",
      detailed: "TRANSFER_IN_ACCOUNT_TRANSFER",
      confidence_level: "VERY_HIGH",
    } as NonNullable<Transaction["personal_finance_category"]>,
  });
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
  await client.query(
    "TRUNCATE case_evidence, exception_cases, sync_runs, webhook_receipts, connections, idempotency_records, activity_events, calculation_snapshots, financial_transactions, balance_observations, commitments, plans, accounts, household_memberships, households, users RESTART IDENTITY CASCADE",
  );
  for (const [userId, subject, name] of [
    [ids.userA, "dev|maya", "Maya"],
    [ids.userB, "dev|riley", "Riley"],
  ])
    await client.query(
      "INSERT INTO users (id, auth_subject, display_name) VALUES ($1, $2, $3)",
      [userId, subject, name],
    );
  for (const [householdId, userId, name] of [
    [ids.householdA, ids.userA, "Maya household"],
    [ids.householdB, ids.userB, "Riley household"],
  ]) {
    await client.query(
      "INSERT INTO households (id, name, timezone, base_currency) VALUES ($1, $2, 'America/New_York', 'USD')",
      [householdId, name],
    );
    await client.query(
      "INSERT INTO household_memberships (household_id, user_id, role, onboarding_completed_at) VALUES ($1, $2, 'owner', now())",
      [householdId, userId],
    );
  }
  for (const [accountId, householdId, amount] of [
    [ids.accountA, ids.householdA, "423039"],
    [ids.accountB, ids.householdB, "100000"],
  ]) {
    await client.query(
      "INSERT INTO accounts (id, household_id, name, account_type, currency, provenance, include_in_plan) VALUES ($1, $2, 'Manual cash', 'cash', 'USD', 'manual', true)",
      [accountId, householdId],
    );
    await client.query(
      "INSERT INTO balance_observations (household_id, account_id, amount_minor, currency, provenance, as_of, source_record_id) VALUES ($1, $2, $3, 'USD', 'manual', '2026-08-29T12:00:00Z', 'fixture-v1')",
      [householdId, accountId, amount],
    );
  }
  await client.query(
    "INSERT INTO plans (id, household_id, planned_savings_minor, safety_buffer_minor, currency, calculation_policy_version) VALUES ($1, $2, 50000, 28000, 'USD', 'safe-to-spend/v1'), ($3, $4, 0, 0, 'USD', 'safe-to-spend/v1')",
    [ids.planA, ids.householdA, ids.planB, ids.householdB],
  );
  const commitments = [
    ["Rent", "185000", "2026-09-01", "housing"],
    ["Electric", "15500", "2026-09-04", "utilities"],
    ["Subscriptions", "1899", "2026-09-06", "subscriptions"],
    ["Insurance", "14240", "2026-09-08", "insurance"],
  ];
  for (const [name, amount, dueDate, setupSlot] of commitments)
    await client.query(
      "INSERT INTO commitments (household_id, name, amount_minor, currency, due_date, provenance, setup_slot) VALUES ($1, $2, $3, 'USD', $4, 'manual', $5)",
      [ids.householdA, name, amount, dueDate, setupSlot],
    );
  await client.query(
    "INSERT INTO commitment_revisions(household_id,commitment_id,version,name,amount_minor,currency,due_date,recurrence,active,settled_at) SELECT household_id,id,version,name,amount_minor,currency,due_date,recurrence,active,settled_at FROM commitments WHERE household_id=$1",
    [ids.householdA],
  );
  await client.query(
    "INSERT INTO plan_occurrences(household_id,source_key,kind,commitment_id,name,expected_amount_minor,expected_on,provenance) SELECT household_id,'commitment:'||id::text,'commitment',id,name,amount_minor,due_date,provenance FROM commitments WHERE household_id=$1 AND due_date IS NOT NULL",
    [ids.householdA],
  );
  await client.query(
    "INSERT INTO savings_goals(household_id,name,contribution_amount_minor,schedule,status,currency,provenance) SELECT household_id,'General savings',planned_savings_minor,'planning_period','active',currency,'manual' FROM plans WHERE household_id=$1 AND planned_savings_minor>0",
    [ids.householdA],
  );
  await client.query(
    "INSERT INTO savings_goal_revisions(household_id,savings_goal_id,destination_account_id,name,target_amount_minor,target_date,contribution_amount_minor,schedule,next_due_on,status,currency,provenance,version,reason) SELECT household_id,id,destination_account_id,name,target_amount_minor,target_date,contribution_amount_minor,schedule,next_due_on,status,currency,provenance,version,'Integration fixture' FROM savings_goals WHERE household_id=$1",
    [ids.householdA],
  );
  await client.query(
    "INSERT INTO plan_occurrences(household_id,source_key,kind,savings_goal_id,name,expected_amount_minor,expected_on,provenance) SELECT g.household_id,'savings-goal:'||g.id::text,'savings',g.id,g.name,g.contribution_amount_minor,(current_date+p.fallback_horizon_days),g.provenance FROM savings_goals g JOIN plans p ON p.household_id=g.household_id WHERE g.household_id=$1 AND g.contribution_amount_minor>0",
    [ids.householdA],
  );
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
  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${value.year}-${value.month}-${value.day}`;
}
