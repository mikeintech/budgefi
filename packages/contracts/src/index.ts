import { z } from "zod";

export const currencySchema = z.literal("USD");
const MAX_MINOR = 1_000_000_000_000_000n;
export const moneySchema = z
  .object({
    minor: z
      .string()
      .regex(/^-?\d+$/)
      .refine(
        (value) => validMinor(value, -MAX_MINOR, MAX_MINOR),
        "Amount is outside supported bounds",
      ),
    currency: currencySchema,
  })
  .strict();
export const uuidSchema = z.string().uuid();
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isCalendarDate, "Invalid calendar date");
export const instantSchema = z.string().datetime({ offset: true });
export const provenanceSchema = z.enum([
  "manual",
  "csv",
  "plaid",
  "derived",
  "sample",
]);
const nonnegativeMoneySchema = moneySchema.refine(
  (value) => validMinor(value.minor, 0n, MAX_MINOR),
  "Amount cannot be negative",
);
const positiveMoneySchema = moneySchema.refine(
  (value) => validMinor(value.minor, 1n, MAX_MINOR),
  "Amount must be positive",
);

export const planResponseSchema = z
  .object({
    id: uuidSchema,
    householdId: uuidSchema,
    version: z.number().int().positive(),
    planningHorizonDays: z.number().int().positive(),
    horizonStart: dateSchema,
    horizonEnd: dateSchema,
    knownCash: moneySchema,
    commitments: z.array(
      z
        .object({
          id: uuidSchema,
          version: z.number().int().positive(),
          name: z.string(),
          amount: moneySchema,
          dueDate: dateSchema.nullable(),
          provenance: provenanceSchema,
        })
        .strict(),
    ),
    plannedSavings: moneySchema,
    safetyBuffer: moneySchema,
    available: moneySchema,
    reserved: moneySchema,
    policyVersion: z.string(),
    calculatedAt: instantSchema,
    freshness: z
      .object({
        status: z.enum(["current", "stale", "incomplete", "manual"]),
        asOf: instantSchema.nullable(),
      })
      .strict(),
  })
  .strict();

export const manualBalanceRequestSchema = z
  .object({
    accountId: uuidSchema,
    amount: nonnegativeMoneySchema,
    asOf: instantSchema.refine(
      (value) => new Date(value).getTime() <= Date.now() + 5 * 60_000,
      "Balance time cannot be more than five minutes in the future",
    ),
    requestId: uuidSchema,
  })
  .strict();

export const manualTransactionRequestSchema = z
  .object({
    accountId: uuidSchema,
    merchant: z.string().trim().min(1).max(160),
    amount: positiveMoneySchema,
    occurredOn: dateSchema,
    requestId: uuidSchema,
  })
  .strict();

export const commitmentRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    amount: nonnegativeMoneySchema,
    dueDate: dateSchema.nullable().default(null),
    requestId: uuidSchema,
  })
  .strict();

export const planUpdateRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    plannedSavings: nonnegativeMoneySchema,
    safetyBuffer: nonnegativeMoneySchema,
    requestId: uuidSchema,
  })
  .strict();

export const connectionMutationRequestSchema = z
  .object({ requestId: uuidSchema })
  .strict();
export const nativeAuthTicketRequestSchema = z
  .object({ state: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/) })
  .strict();
export const nativeAuthTicketResponseSchema = z
  .object({
    state: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
    ticket: z.string().min(1).max(4096),
    expiresAt: instantSchema,
  })
  .strict();
export const plaidLinkTokenRequestSchema = z
  .object({
    mode: z.enum(["create", "update"]).default("create"),
    connectionId: uuidSchema.optional(),
    nativeHosted: z.boolean().default(false),
  })
  .strict()
  .refine(
    (value) =>
      value.mode === "create"
        ? value.connectionId === undefined
        : value.connectionId !== undefined,
    "Update mode requires a connectionId",
  );
export const plaidLinkTokenResponseSchema = z
  .object({
    sessionId: uuidSchema,
    linkToken: z.string().min(1),
    expiration: instantSchema,
    environment: z.enum(["sandbox", "development", "production"]),
    mode: z.enum(["create", "update"]),
    hostedLinkUrl: z.string().url().optional(),
  })
  .strict();
export const plaidHostedCompleteRequestSchema = z
  .object({
    sessionId: uuidSchema,
    linkToken: z.string().min(1).max(4096),
    requestId: uuidSchema,
  })
  .strict();
export const plaidExchangeRequestSchema = z
  .object({
    sessionId: uuidSchema,
    publicToken: z.string().min(1).max(2048),
    linkSessionId: z.string().min(1).max(256).optional(),
    institution: z
      .object({
        id: z.string().min(1).max(128),
        name: z.string().min(1).max(200),
      })
      .strict()
      .optional(),
    requestId: uuidSchema,
  })
  .strict();
export const plaidUpdateCompleteRequestSchema = z
  .object({
    sessionId: uuidSchema,
    linkSessionId: z.string().min(1).max(256).optional(),
    requestId: uuidSchema,
  })
  .strict();
export const accountInclusionRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    includeInPlan: z.boolean(),
    requestId: uuidSchema,
  })
  .strict();
export const planCalibrationRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    manualBalance: z
      .object({
        accountId: uuidSchema,
        amount: nonnegativeMoneySchema,
        asOf: instantSchema,
      })
      .strict()
      .optional(),
    plannedSavings: nonnegativeMoneySchema,
    safetyBuffer: nonnegativeMoneySchema,
    commitments: z
      .array(
        z
          .object({
            id: uuidSchema.optional(),
            expectedVersion: z.number().int().positive().optional(),
            name: z.string().trim().min(1).max(120),
            amount: nonnegativeMoneySchema,
            dueDate: dateSchema.nullable(),
          })
          .strict()
          .refine(
            (item) => Boolean(item.id) === Boolean(item.expectedVersion),
            "Existing commitments require both id and expectedVersion",
          ),
      )
      .max(100)
      .refine(
        (items) =>
          new Set(items.map((item) => item.name.toLocaleLowerCase())).size ===
          items.length,
        "Commitment names must be unique",
      ),
    removeCommitments: z
      .array(
        z
          .object({
            id: uuidSchema,
            expectedVersion: z.number().int().positive(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    requestId: uuidSchema,
  })
  .strict();

export const activityEventSchema = z
  .object({
    id: uuidSchema,
    type: z.string(),
    title: z.string(),
    detail: z.string(),
    provenance: provenanceSchema,
    occurredAt: instantSchema,
  })
  .strict();

export const transactionSchema = z
  .object({
    id: uuidSchema,
    accountId: uuidSchema,
    merchant: z.string(),
    amount: moneySchema,
    occurredOn: dateSchema,
    status: z.enum(["pending", "posted", "removed", "superseded"]),
    direction: z.enum(["debit", "credit"]),
    provenance: z.enum(["manual", "csv", "plaid", "sample"]),
    revision: z.number().int().positive(),
  })
  .strict();

export const onboardingAnalysisRequestSchema = z
  .object({ refresh: z.boolean().default(false) })
  .strict();

const confidenceBandSchema = z.enum(["strong", "review"]);
const recurringSuggestionSchema = z
  .object({
    candidateId: z.string().min(1).max(80),
    name: z.string().min(1).max(120),
    amount: nonnegativeMoneySchema,
    nextExpectedDate: dateSchema,
    cadence: z.enum([
      "weekly",
      "biweekly",
      "semi_monthly",
      "monthly",
      "quarterly",
      "annual",
    ]),
    category: z.enum([
      "housing",
      "utilities",
      "insurance",
      "subscription",
      "bill",
      "income",
      "savings",
      "other",
    ]),
    confidence: confidenceBandSchema,
    variableAmount: z.boolean(),
    observationCount: z.number().int().min(2).max(12),
    explanation: z.string().min(1).max(240),
  })
  .strict();

export const onboardingAnalysisResponseSchema = z
  .object({
    state: z.enum([
      "ready",
      "history_syncing",
      "not_enough_history",
      "unavailable",
    ]),
    source: z.enum(["openai", "deterministic", "none"]),
    model: z.string().max(120).nullable(),
    generatedAt: instantSchema,
    transactionCount: z.number().int().nonnegative(),
    candidateCount: z.number().int().nonnegative(),
    notice: z.string().min(1).max(320),
    suggestions: z
      .object({
        income: recurringSuggestionSchema.nullable(),
        commitments: z.array(recurringSuggestionSchema).max(40),
        savings: recurringSuggestionSchema.nullable(),
        needsReview: z.array(recurringSuggestionSchema).max(20),
        filtered: z
          .array(
            z
              .object({
                name: z.string().min(1).max(120),
                kind: z.enum([
                  "internal_transfer",
                  "refund",
                  "savings_transfer",
                  "ordinary_activity",
                ]),
                explanation: z.string().min(1).max(240),
              })
              .strict(),
          )
          .max(20),
      })
      .strict(),
  })
  .strict();

export const exceptionCaseSchema = z
  .object({
    id: uuidSchema,
    type: z.enum([
      "amount_changed",
      "possible_duplicate",
      "missing_expected",
      "continued_charge",
    ]),
    status: z.enum([
      "open",
      "decided",
      "awaiting_verification",
      "verified",
      "failed",
      "expired",
    ]),
    title: z.string(),
    expectedAmount: moneySchema.nullable(),
    observedAmount: moneySchema.nullable(),
    version: z.number().int().positive(),
    createdAt: instantSchema,
    updatedAt: instantSchema,
    evidence: z.array(
      z
        .object({
          id: uuidSchema,
          type: z.string(),
          summary: z.string(),
          sourceEntityType: z.string(),
          sourceEntityId: uuidSchema,
          createdAt: instantSchema,
          transaction: z
            .object({
              merchant: z.string(),
              amount: moneySchema,
              occurredOn: dateSchema,
              accountId: uuidSchema,
              accountName: z.string(),
              status: z.enum(["pending", "posted", "removed", "superseded"]),
              provenance: z.enum(["manual", "csv", "plaid", "sample"]),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const exceptionDecisionRequestSchema = z
  .object({
    decision: z.enum(["expected", "unexpected", "unsure"]),
    expectedVersion: z.number().int().positive(),
    requestId: uuidSchema,
  })
  .strict();

export const bootstrapResponseSchema = z
  .object({
    revision: z.string().regex(/^\d+$/),
    household: z
      .object({
        id: uuidSchema,
        name: z.string(),
        role: z.enum(["owner", "admin", "member", "viewer"]),
        onboardingCompleted: z.boolean(),
      })
      .strict(),
    capabilities: z
      .object({
        bankConnections: z
          .object({
            enabled: z.boolean(),
            environment: z.enum(["sandbox", "development", "production"]),
          })
          .strict(),
      })
      .strict(),
    accounts: z.array(
      z
        .object({
          id: uuidSchema,
          connectionId: uuidSchema.nullable(),
          version: z.number().int().positive(),
          name: z.string(),
          type: z.string(),
          currency: currencySchema,
          provenance: z.enum(["manual", "csv", "plaid", "sample"]),
          includeInPlan: z.boolean(),
          coverage: z.enum(["complete", "stale", "missing", "excluded"]),
          balance: moneySchema.nullable(),
          balanceAsOf: instantSchema.nullable(),
        })
        .strict(),
    ),
    connections: z.array(
      z
        .object({
          id: uuidSchema,
          provider: z.enum(["plaid", "sample"]),
          environment: z
            .enum(["sandbox", "development", "production"])
            .nullable(),
          institutionName: z.string().nullable(),
          status: z.enum([
            "pending",
            "syncing",
            "healthy",
            "stale",
            "login_required",
            "error",
            "revocation_pending",
            "revoked",
          ]),
          errorCode: z.string().nullable(),
          lastSuccessfulSyncAt: instantSchema.nullable(),
          initialUpdateComplete: z.boolean(),
          historicalUpdateComplete: z.boolean(),
        })
        .strict(),
    ),
    plan: planResponseSchema,
    transactions: z.array(transactionSchema),
    cases: z.array(exceptionCaseSchema),
    activity: z.array(activityEventSchema),
  })
  .strict();

export const errorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        requestId: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export const notificationPreferencesSchema = z
  .object({
    emailAddress: z.string().email().max(320).nullable(),
    emailVerified: z.boolean(),
    emailEnabled: z.boolean(),
    pushEnabled: z.boolean(),
    connectionHealth: z.boolean(),
    commitmentReminders: z.boolean(),
    exceptionActivity: z.boolean(),
    weeklyDigest: z.boolean(),
    lockScreenDetail: z.boolean(),
    reminderHour: z.number().int().min(0).max(23),
    timezone: z
      .string()
      .min(1)
      .max(80)
      .refine(isTimeZone, "Invalid IANA timezone"),
  })
  .strict();
export const notificationPreferencesUpdateSchema = notificationPreferencesSchema
  .omit({ emailVerified: true })
  .extend({ requestId: uuidSchema })
  .strict();
export const notificationEndpointRequestSchema = z
  .object({
    platform: z.enum(["ios", "android", "web"]),
    token: z.string().min(16).max(4096),
    deviceLabel: z.string().trim().min(1).max(120),
    requestId: uuidSchema,
  })
  .strict();
export const notificationEndpointResponseSchema = z
  .object({
    id: uuidSchema,
    platform: z.enum(["ios", "android", "web"]),
    deviceLabel: z.string(),
    enabled: z.boolean(),
    registeredAt: instantSchema,
  })
  .strict();
export const notificationEndpointDisableRequestSchema = z
  .object({ requestId: uuidSchema })
  .strict();
export const notificationTestRequestSchema = z
  .object({ channel: z.enum(["push", "email"]), requestId: uuidSchema })
  .strict();
export const notificationTestResponseSchema = z
  .object({ queued: z.boolean(), reason: z.string().nullable() })
  .strict();
export const accountExportResponseSchema = z
  .object({
    generatedAt: instantSchema,
    formatVersion: z.literal(1),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();
export const accountDeletionRequestSchema = z
  .object({ confirmation: z.literal("DELETE"), requestId: uuidSchema })
  .strict();
export const accountDeletionResponseSchema = z
  .object({
    id: uuidSchema,
    status: z.enum([
      "requested",
      "revoking_connections",
      "ready_to_finalize",
      "finalizing",
      "completed",
      "failed",
    ]),
    requestedAt: instantSchema,
  })
  .strict();

export const featureFlagsResponseSchema = z
  .object({
    onboardingAi: z.boolean(),
    householdMode: z.boolean(),
  })
  .strict();

export const defaultFeatureFlags = Object.freeze({
  onboardingAi: false,
  householdMode: false,
});

export type PlanResponse = z.infer<typeof planResponseSchema>;
export type ManualBalanceRequest = z.infer<typeof manualBalanceRequestSchema>;
export type ManualTransactionRequest = z.infer<
  typeof manualTransactionRequestSchema
>;
export type CommitmentRequest = z.infer<typeof commitmentRequestSchema>;
export type PlanUpdateRequest = z.infer<typeof planUpdateRequestSchema>;
export type ConnectionMutationRequest = z.infer<
  typeof connectionMutationRequestSchema
>;
export type NativeAuthTicketRequest = z.infer<
  typeof nativeAuthTicketRequestSchema
>;
export type NativeAuthTicketResponse = z.infer<
  typeof nativeAuthTicketResponseSchema
>;
export type PlaidLinkTokenRequest = z.infer<typeof plaidLinkTokenRequestSchema>;
export type PlaidLinkTokenResponse = z.infer<
  typeof plaidLinkTokenResponseSchema
>;
export type PlaidHostedCompleteRequest = z.infer<
  typeof plaidHostedCompleteRequestSchema
>;
export type PlaidExchangeRequest = z.infer<typeof plaidExchangeRequestSchema>;
export type PlaidUpdateCompleteRequest = z.infer<
  typeof plaidUpdateCompleteRequestSchema
>;
export type AccountInclusionRequest = z.infer<
  typeof accountInclusionRequestSchema
>;
export type ExceptionDecisionRequest = z.infer<
  typeof exceptionDecisionRequestSchema
>;
export type PlanCalibrationRequest = z.infer<
  typeof planCalibrationRequestSchema
>;
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;
export type FeatureFlagsResponse = z.infer<typeof featureFlagsResponseSchema>;
export type OnboardingAnalysisRequest = z.infer<
  typeof onboardingAnalysisRequestSchema
>;
export type OnboardingAnalysisResponse = z.infer<
  typeof onboardingAnalysisResponseSchema
>;
export type NotificationPreferences = z.infer<
  typeof notificationPreferencesSchema
>;
export type NotificationPreferencesUpdate = z.infer<
  typeof notificationPreferencesUpdateSchema
>;
export type NotificationEndpointRequest = z.infer<
  typeof notificationEndpointRequestSchema
>;
export type NotificationEndpointResponse = z.infer<
  typeof notificationEndpointResponseSchema
>;
export type NotificationEndpointDisableRequest = z.infer<
  typeof notificationEndpointDisableRequestSchema
>;
export type NotificationTestRequest = z.infer<
  typeof notificationTestRequestSchema
>;
export type NotificationTestResponse = z.infer<
  typeof notificationTestResponseSchema
>;
export type AccountExportResponse = z.infer<typeof accountExportResponseSchema>;
export type AccountDeletionRequest = z.infer<
  typeof accountDeletionRequestSchema
>;
export type AccountDeletionResponse = z.infer<
  typeof accountDeletionResponseSchema
>;

function validMinor(value: string, minimum: bigint, maximum: bigint): boolean {
  try {
    const parsed = BigInt(value);
    return /^-?\d+$/.test(value) && parsed >= minimum && parsed <= maximum;
  } catch {
    return false;
  }
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3])
  );
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
