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
    planningHorizonDays: z.number().int().nonnegative(),
    fallbackHorizonDays: z.number().int().min(1).max(90),
    horizonBasis: z.enum(["expected_income", "fallback"]),
    horizonMissedIncome: z.boolean(),
    horizonStart: dateSchema,
    horizonEnd: dateSchema,
    horizonIncomeScheduleId: uuidSchema.nullable(),
    incomeSchedules: z.array(
      z
        .object({
          id: uuidSchema,
          version: z.number().int().positive(),
          destinationAccountId: uuidSchema.nullable(),
          name: z.string().min(1).max(120),
          expectedAmount: positiveMoneySchema.nullable(),
          frequency: z.enum([
            "weekly",
            "biweekly",
            "semi_monthly",
            "monthly",
            "quarterly",
            "annual",
            "irregular",
          ]),
          nextExpectedDate: dateSchema.nullable(),
          confirmed: z.boolean(),
          status: z.enum(["active", "paused", "archived"]),
          anchorDay: z.number().int().min(1).max(31).nullable(),
          anchorEndOfMonth: z.boolean(),
          secondAnchorDay: z.number().int().min(1).max(31).nullable(),
          secondAnchorEndOfMonth: z.boolean(),
          reviewReason: z.enum(["destination_disconnected"]).nullable(),
          provenance: z.enum(["manual", "csv", "plaid", "derived"]),
        })
        .strict(),
    ),
    knownCash: moneySchema,
    commitments: z.array(
      z
        .object({
          id: uuidSchema,
          version: z.number().int().positive(),
          name: z.string(),
          amount: moneySchema,
          dueDate: dateSchema.nullable(),
          recurrence: z.enum([
            "one_time",
            "weekly",
            "biweekly",
            "monthly",
            "quarterly",
            "annual",
          ]),
          setupSlot: z
            .enum(["housing", "utilities", "subscriptions", "insurance"])
            .nullable(),
          starterItemKey: z
            .enum([
              "housing",
              "utilities",
              "phone_internet",
              "insurance",
              "subscriptions",
              "debt_payment",
            ])
            .nullable(),
          provenance: provenanceSchema,
        })
        .strict(),
    ),
    availableCashAlert: z
      .object({
        enabled: z.boolean(),
        threshold: nonnegativeMoneySchema,
        currentAvailable: moneySchema,
        status: z.enum(["disabled", "above", "below", "unavailable"]),
        episodeId: uuidSchema.nullable(),
        alertAvailable: moneySchema.nullable(),
        alertEvaluatedAt: instantSchema.nullable(),
        alertFreshness: z
          .enum(["current", "manual", "stale", "incomplete"])
          .nullable(),
      })
      .strict(),
    latestStarterApplication: z
      .object({
        id: uuidSchema,
        itemCount: z.number().int().positive(),
        removable: z.boolean(),
        createdAt: instantSchema,
      })
      .strict()
      .nullable(),
    occurrences: z.array(
      z
        .object({
          id: uuidSchema,
          kind: z.enum(["income", "commitment", "savings"]),
          sourceKey: z.string(),
          commitmentId: uuidSchema.nullable(),
          savingsGoalId: uuidSchema.nullable(),
          incomeScheduleId: uuidSchema.nullable(),
          name: z.string(),
          expectedAmount: nonnegativeMoneySchema.nullable(),
          expectedOn: dateSchema,
          state: z.enum([
            "expected",
            "pending",
            "verified",
            "partial",
            "overdue",
            "skipped",
            "needs_review",
          ]),
          explicitlySkipped: z.boolean(),
          matchedAmount: nonnegativeMoneySchema,
          remainingAmount: nonnegativeMoneySchema.nullable(),
          provenance: provenanceSchema,
          version: z.number().int().positive(),
          scheduleRevision: z
            .object({
              kind: z.enum(["commitment", "savings", "income"]),
              id: uuidSchema,
              version: z.number().int().positive(),
            })
            .strict(),
          verifiedAt: instantSchema.nullable(),
          evidence: z.array(
            z
              .object({
                transactionId: uuidSchema,
                matchId: uuidSchema,
                matchVersion: z.number().int().positive(),
                merchant: z.string(),
                occurredOn: dateSchema,
                accountName: z.string(),
                amountApplied: nonnegativeMoneySchema,
                status: z.enum(["pending", "posted"]),
                matchState: z.enum(["proposed", "confirmed"]),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    savingsGoals: z.array(
      z
        .object({
          id: uuidSchema,
          version: z.number().int().positive(),
          name: z.string().trim().min(1).max(120),
          targetAmount: nonnegativeMoneySchema.nullable(),
          targetDate: dateSchema.nullable(),
          contributionAmount: nonnegativeMoneySchema,
          schedule: z.enum([
            "planning_period",
            "one_time",
            "weekly",
            "biweekly",
            "monthly",
            "quarterly",
            "annual",
          ]),
          nextDueOn: dateSchema.nullable(),
          status: z.enum(["active", "paused", "completed", "archived"]),
          provenance: provenanceSchema.exclude(["sample"]),
          destination: z
            .object({
              accountId: uuidSchema,
              name: z.string(),
              provenance: z.enum(["manual", "csv", "plaid"]),
              coverage: z.enum(["complete", "stale", "missing"]),
            })
            .strict()
            .nullable(),
          progress: z
            .object({
              confirmed: nonnegativeMoneySchema,
              providerVerified: nonnegativeMoneySchema,
              userConfirmed: nonnegativeMoneySchema,
              assurance: z.enum([
                "bank_confirmed",
                "user_confirmed",
                "not_started",
                "stale",
              ]),
              protected: z.boolean(),
              asOf: instantSchema.nullable(),
            })
            .strict(),
          movements: z.array(
            z
              .object({
                id: uuidSchema,
                kind: z.enum([
                  "opening_allocation",
                  "contribution",
                  "withdrawal",
                  "reversal",
                ]),
                amount: nonnegativeMoneySchema,
                effectiveOn: dateSchema,
                verificationMethod: z.enum([
                  "provider_verified",
                  "user_confirmed",
                ]),
                provenance: z.enum(["manual", "plaid", "derived"]),
                reversedMovementId: uuidSchema.nullable(),
                createdAt: instantSchema,
              })
              .strict(),
          ),
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
    direction: z.enum(["debit", "credit"]).default("debit"),
    category: z
      .enum([
        "income",
        "housing",
        "utilities",
        "groceries",
        "dining",
        "transportation",
        "shopping",
        "health",
        "insurance",
        "debt",
        "subscriptions",
        "fees",
        "entertainment",
        "education",
        "giving",
        "taxes",
        "savings_investments",
        "transfer",
        "cash_atm",
        "other",
        "uncategorized",
      ])
      .default("uncategorized"),
    occurrenceId: uuidSchema.optional(),
    balanceIncludesActivity: z.boolean().default(false),
    requestId: uuidSchema,
  })
  .strict();

export const commitmentRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    amount: nonnegativeMoneySchema,
    dueDate: dateSchema.nullable().default(null),
    recurrence: z
      .enum([
        "one_time",
        "weekly",
        "biweekly",
        "monthly",
        "quarterly",
        "annual",
      ])
      .default("one_time"),
    requestId: uuidSchema,
  })
  .strict();

export const planUpdateRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    plannedSavings: nonnegativeMoneySchema,
    safetyBuffer: nonnegativeMoneySchema,
    fallbackHorizonDays: z.number().int().min(1).max(90).optional(),
    requestId: uuidSchema,
  })
  .strict();

const incomeScheduleFields = {
  destinationAccountId: uuidSchema.nullable().default(null),
  name: z.string().trim().min(1).max(120),
  expectedAmount: positiveMoneySchema.nullable().default(null),
  frequency: z.enum([
    "weekly",
    "biweekly",
    "semi_monthly",
    "monthly",
    "quarterly",
    "annual",
    "irregular",
  ]),
  nextExpectedDate: dateSchema.nullable().default(null),
  confirmed: z.boolean(),
  anchorDay: z.number().int().min(1).max(31).nullable().default(null),
  anchorEndOfMonth: z.boolean().default(false),
  secondAnchorDay: z.number().int().min(1).max(31).nullable().default(null),
  secondAnchorEndOfMonth: z.boolean().default(false),
};
function validateIncomeSchedule(
  value: {
    confirmed: boolean;
    nextExpectedDate: string | null;
    frequency:
      | "weekly"
      | "biweekly"
      | "semi_monthly"
      | "monthly"
      | "quarterly"
      | "annual"
      | "irregular";
    anchorDay: number | null;
    anchorEndOfMonth: boolean;
    secondAnchorDay: number | null;
    secondAnchorEndOfMonth: boolean;
  },
  context: z.RefinementCtx,
) {
  if (value.confirmed && !value.nextExpectedDate)
    context.addIssue({
      code: "custom",
      path: ["nextExpectedDate"],
      message: "Choose the next expected date before using it for the plan",
    });
  if (value.confirmed && value.frequency === "irregular")
    context.addIssue({
      code: "custom",
      path: ["confirmed"],
      message: "Irregular income cannot shorten the plan",
    });
  if (
    value.frequency === "semi_monthly" &&
    (value.anchorDay === null || value.secondAnchorDay === null)
  )
    context.addIssue({
      code: "custom",
      path: ["secondAnchorDay"],
      message: "Twice-monthly income needs both pay days",
    });
  if (
    value.frequency === "semi_monthly" &&
    ((value.anchorEndOfMonth && value.secondAnchorEndOfMonth) ||
      (!value.anchorEndOfMonth &&
        !value.secondAnchorEndOfMonth &&
        value.anchorDay === value.secondAnchorDay))
  )
    context.addIssue({
      code: "custom",
      path: ["secondAnchorDay"],
      message: "Choose two different pay days",
    });
  if (
    value.frequency === "semi_monthly" &&
    (value.anchorEndOfMonth || (value.anchorDay ?? 31) >= 28) &&
    (value.secondAnchorEndOfMonth || (value.secondAnchorDay ?? 31) >= 28)
  )
    context.addIssue({
      code: "custom",
      path: ["secondAnchorDay"],
      message:
        "Choose at least one pay day from 1 through 27 so shorter months still have two deposits",
    });
}
export const incomeScheduleCreateRequestSchema = z
  .object({ ...incomeScheduleFields, requestId: uuidSchema })
  .strict()
  .superRefine(validateIncomeSchedule);
export const incomeScheduleUpdateRequestSchema = z
  .object({
    ...incomeScheduleFields,
    expectedVersion: z.number().int().positive(),
    status: z.enum(["active", "paused", "archived"]),
    requestId: uuidSchema,
  })
  .strict()
  .superRefine(validateIncomeSchedule);

export const connectionMutationRequestSchema = z
  .object({ requestId: uuidSchema })
  .strict();
export const occurrenceSkipRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    requestId: uuidSchema,
  })
  .strict();
export const transactionOccurrenceLinkRequestSchema = z
  .object({
    occurrenceId: uuidSchema,
    expectedTransactionVersion: z.number().int().positive(),
    expectedOccurrenceVersion: z.number().int().positive(),
    requestId: uuidSchema,
  })
  .strict();
export const transactionOccurrenceUnlinkRequestSchema = z
  .object({
    expectedTransactionVersion: z.number().int().positive(),
    expectedOccurrenceId: uuidSchema,
    expectedMatchId: uuidSchema,
    expectedMatchVersion: z.number().int().positive(),
    requestId: uuidSchema,
  })
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
export const manualModeRequestSchema = z
  .object({ requestId: uuidSchema })
  .strict();
export const accountPlanningRoleRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    role: z.enum(["spendable", "protected", "excluded"]),
    requestId: uuidSchema,
  })
  .strict();
const savingsGoalFields = {
  name: z.string().trim().min(1).max(120),
  targetAmount: positiveMoneySchema.nullable(),
  targetDate: dateSchema.nullable(),
  contributionAmount: nonnegativeMoneySchema,
  schedule: z.enum([
    "planning_period",
    "one_time",
    "weekly",
    "biweekly",
    "monthly",
    "quarterly",
    "annual",
  ]),
  nextDueOn: dateSchema.nullable(),
  destinationAccountId: uuidSchema.nullable(),
} as const;
export const savingsGoalCreateRequestSchema = z
  .object({
    ...savingsGoalFields,
    useCurrentDestinationBalance: z.boolean().default(false),
    trackManually: z.boolean().default(false),
    requestId: uuidSchema,
  })
  .strict()
  .superRefine((value, context) => {
    validateSavingsGoalSchedule(value, context);
    if (value.trackManually && value.destinationAccountId)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trackManually"],
        message: "Manual tracking creates its own savings account",
      });
    if (value.useCurrentDestinationBalance && !value.destinationAccountId)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["useCurrentDestinationBalance"],
        message: "Choose a destination account before using its balance",
      });
    if (
      BigInt(value.contributionAmount.minor) > 0n &&
      !value.destinationAccountId &&
      !value.trackManually
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["destinationAccountId"],
        message: "Choose a destination before reserving a contribution",
      });
  });
export const savingsGoalUpdateRequestSchema = z
  .object({
    ...savingsGoalFields,
    expectedVersion: z.number().int().positive(),
    useCurrentDestinationBalance: z.boolean().default(false),
    status: z.enum(["active", "paused", "completed", "archived"]),
    requestId: uuidSchema,
  })
  .strict()
  .superRefine((value, context) => {
    validateSavingsGoalSchedule(value, context);
    if (value.useCurrentDestinationBalance && !value.destinationAccountId)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["useCurrentDestinationBalance"],
        message: "Choose a destination before using its balance",
      });
    if (
      BigInt(value.contributionAmount.minor) > 0n &&
      !value.destinationAccountId
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["destinationAccountId"],
        message: "Choose a destination before reserving a contribution",
      });
  });
export const savingsGoalBalanceUpdateRequestSchema = z
  .object({
    expectedGoalVersion: z.number().int().positive(),
    balance: nonnegativeMoneySchema,
    asOf: instantSchema.refine(
      (value) => new Date(value).getTime() <= Date.now() + 5 * 60_000,
      "Balance time cannot be more than five minutes in the future",
    ),
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
    fallbackHorizonDays: z.number().int().min(1).max(90).optional(),
    commitments: z
      .array(
        z
          .object({
            id: uuidSchema.optional(),
            expectedVersion: z.number().int().positive().optional(),
            name: z.string().trim().min(1).max(120),
            amount: nonnegativeMoneySchema,
            dueDate: dateSchema.nullable(),
            recurrence: z
              .enum([
                "one_time",
                "weekly",
                "biweekly",
                "monthly",
                "quarterly",
                "annual",
              ])
              .optional(),
            setupSlot: z
              .enum(["housing", "utilities", "subscriptions", "insurance"])
              .nullable()
              .optional(),
            starterItemKey: z
              .enum([
                "housing",
                "utilities",
                "phone_internet",
                "insurance",
                "subscriptions",
                "debt_payment",
              ])
              .optional(),
          })
          .strict()
          .refine(
            (item) => Boolean(item.id) === Boolean(item.expectedVersion),
            "Existing commitments require both id and expectedVersion",
          ),
      )
      .max(100)
      .refine((items) => {
        const byName = new Map<string, typeof items>();
        for (const item of items) {
          const name = item.name.toLocaleLowerCase();
          byName.set(name, [...(byName.get(name) ?? []), item]);
        }
        return [...byName.values()].every(
          (matches) =>
            matches.length === 1 || matches.every((item) => Boolean(item.id)),
        );
      }, "New commitments must have unique names"),
    starterTemplate: z
      .object({ key: z.literal("common_bills"), version: z.literal(1) })
      .strict()
      .optional(),
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
  .strict()
  .superRefine((value, context) => {
    const starterItems = value.commitments.filter(
      (item) => item.starterItemKey,
    );
    if (starterItems.length > 0 && !value.starterTemplate)
      context.addIssue({
        code: "custom",
        path: ["starterTemplate"],
        message: "Starter bill rows require their template identity",
      });
    if (value.starterTemplate && starterItems.length === 0)
      context.addIssue({
        code: "custom",
        path: ["starterTemplate"],
        message: "Choose at least one common bill row",
      });
    if (
      new Set(starterItems.map((item) => item.starterItemKey)).size !==
      starterItems.length
    )
      context.addIssue({
        code: "custom",
        path: ["commitments"],
        message: "Each common bill row can only be added once",
      });
    starterItems.forEach((item) => {
      if (item.id || item.expectedVersion)
        context.addIssue({
          code: "custom",
          path: [
            "commitments",
            value.commitments.indexOf(item),
            "starterItemKey",
          ],
          message:
            "Existing commitments cannot be reclassified as starter rows",
        });
    });
  });
export const starterApplicationUndoRequestSchema = z
  .object({ requestId: uuidSchema })
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

export const transactionCategorySchema = z.enum([
  "income",
  "housing",
  "utilities",
  "groceries",
  "dining",
  "transportation",
  "shopping",
  "health",
  "insurance",
  "debt",
  "subscriptions",
  "fees",
  "entertainment",
  "education",
  "giving",
  "taxes",
  "savings_investments",
  "transfer",
  "cash_atm",
  "other",
  "uncategorized",
]);

export const transactionSchema = z
  .object({
    id: uuidSchema,
    version: z.number().int().positive(),
    accountId: uuidSchema,
    accountName: z.string(),
    accountType: z.string(),
    accountArchived: z.boolean(),
    merchant: z.string(),
    amount: moneySchema,
    occurredOn: dateSchema,
    status: z.enum(["pending", "posted", "removed", "superseded"]),
    direction: z.enum(["debit", "credit"]),
    provenance: z.enum(["manual", "csv", "plaid", "sample"]),
    revision: z.number().int().positive(),
    category: transactionCategorySchema.optional().default("uncategorized"),
    categorySource: z
      .enum(["provider", "deterministic", "merchant_rule", "user"])
      .optional()
      .default("deterministic"),
    categoryConfidence: z
      .enum(["high", "medium", "low"])
      .optional()
      .default("low"),
    categoryVersion: z.number().int().positive().optional().default(1),
  })
  .strict();

export const transactionFeedQuerySchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    accountId: uuidSchema.optional(),
    transactionId: uuidSchema.optional(),
    category: transactionCategorySchema.optional(),
    direction: z.enum(["debit", "credit"]).optional(),
    status: z.enum(["pending", "posted"]).optional(),
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    query: z.string().trim().max(80).optional(),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: "From date must not be after to date",
  });

export const transactionFeedItemSchema = z
  .object({
    id: uuidSchema,
    version: z.number().int().positive(),
    merchant: z.string(),
    amount: moneySchema,
    occurredOn: dateSchema,
    status: z.enum(["pending", "posted"]),
    direction: z.enum(["debit", "credit"]),
    provenance: z.enum(["manual", "csv", "plaid"]),
    account: z
      .object({
        id: uuidSchema,
        name: z.string(),
        type: z.string(),
        archived: z.boolean(),
      })
      .strict(),
    category: transactionCategorySchema,
    categorySource: z.enum([
      "provider",
      "deterministic",
      "merchant_rule",
      "user",
    ]),
    categoryConfidence: z.enum(["high", "medium", "low"]),
    categoryVersion: z.number().int().positive(),
    linkedOccurrence: z
      .object({
        id: uuidSchema,
        name: z.string(),
        state: z.string(),
        matchState: z.enum(["proposed", "confirmed"]),
        matchId: uuidSchema,
        matchVersion: z.number().int().positive(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const transactionFeedResponseSchema = z
  .object({
    items: z.array(transactionFeedItemSchema),
    accounts: z.array(
      z
        .object({ id: uuidSchema, name: z.string(), archived: z.boolean() })
        .strict(),
    ),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const payCycleQuerySchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(12),
    planningCursor: z.string().max(512).optional(),
    planningLimit: z.coerce.number().int().min(1).max(50).default(12),
  })
  .strict();

const payCycleBreakdownSchema = z
  .object({
    categories: z.array(
      z.object({ name: z.string(), amount: moneySchema }).strict(),
    ),
    incomeSources: z.array(
      z.object({ name: z.string(), amount: moneySchema }).strict(),
    ),
    commitments: z.array(
      z
        .object({
          id: uuidSchema,
          name: z.string(),
          expected: moneySchema,
          paid: moneySchema,
          remaining: moneySchema,
          state: z.string(),
        })
        .strict(),
    ),
    savings: z.array(
      z
        .object({
          id: uuidSchema,
          name: z.string(),
          kind: z.enum(["contribution", "withdrawal"]),
          amount: moneySchema,
          effectiveOn: dateSchema,
        })
        .strict(),
    ),
  })
  .strict();

export const payCycleSchema = z
  .object({
    id: uuidSchema,
    startOn: dateSchema,
    endOn: dateSchema.nullable(),
    status: z.enum(["open", "completed"]),
    timezone: z.string(),
    updatedAfterBankCorrection: z.boolean(),
    updatedAfterEvidenceChange: z.boolean(),
    report: z
      .object({
        id: uuidSchema,
        version: z.number().int().positive(),
        status: z.enum(["provisional", "closed", "revised"]),
        assurance: z.enum(["complete", "incomplete", "user_confirmed"]),
        coverageReason: z.string().nullable(),
        calculatedAt: instantSchema,
        earned: moneySchema,
        spent: moneySchema,
        pending: moneySchema,
        saved: moneySchema,
        savingsWithdrawn: moneySchema,
        commitmentsExpected: moneySchema,
        commitmentsPaid: moneySchema,
        commitmentsRemaining: moneySchema,
        debtPaid: moneySchema,
        openingCash: moneySchema.nullable(),
        closingCash: moneySchema.nullable(),
        unexplainedDelta: moneySchema.nullable(),
        breakdown: payCycleBreakdownSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();

export const payCycleListResponseSchema = z
  .object({
    items: z.array(payCycleSchema),
    nextCursor: z.string().nullable(),
    nextPlanningCursor: z.string().nullable(),
    hasVerifiedPayday: z.boolean(),
    planningPeriods: z.array(
      z
        .object({
          id: uuidSchema,
          startOn: dateSchema,
          throughOn: dateSchema,
          basis: z.enum(["expected_income", "fallback"]),
          state: z.enum([
            "active",
            "elapsed_verified",
            "elapsed_unverified",
            "replaced",
          ]),
          reason: z.enum([
            "initial",
            "payday_verified",
            "expected_income_missed",
            "fallback_elapsed",
            "planning_input_changed",
          ]),
          recordedAt: instantSchema,
        })
        .strict(),
    ),
  })
  .strict();

export const payCycleDetailResponseSchema = z
  .object({
    cycle: payCycleSchema,
    revisions: z.array(
      z
        .object({
          id: uuidSchema,
          version: z.number().int().positive(),
          calculatedAt: instantSchema,
          reason: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export const transactionCategoryUpdateSchema = z
  .object({
    category: transactionCategorySchema,
    expectedVersion: z.number().int().positive(),
    applyToFuture: z.boolean().default(false),
    requestId: uuidSchema,
  })
  .strict();

export const merchantCategoryRuleSchema = z
  .object({
    id: uuidSchema,
    merchant: z.string().min(1).max(160),
    category: transactionCategorySchema,
    version: z.number().int().positive(),
  })
  .strict();
export const merchantCategoryRulesResponseSchema = z
  .object({ rules: z.array(merchantCategoryRuleSchema) })
  .strict();
export const merchantCategoryRuleUpdateSchema = z
  .object({
    category: transactionCategorySchema,
    expectedVersion: z.number().int().positive(),
    requestId: uuidSchema,
  })
  .strict();
export const merchantCategoryRuleDeleteSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    requestId: uuidSchema,
  })
  .strict();

export const debtTypeSchema = z.enum([
  "credit_card",
  "student_loan",
  "mortgage",
  "auto",
  "personal",
  "other",
]);
export const debtSchema = z
  .object({
    id: uuidSchema,
    version: z.number().int().positive(),
    accountId: uuidSchema,
    linkedCommitmentId: uuidSchema.nullable(),
    paymentManaged: z.boolean(),
    name: z.string().trim().min(1).max(120),
    type: debtTypeSchema,
    status: z.enum(["needs_review", "active", "paused", "closed", "archived"]),
    provenance: z.enum(["manual", "csv", "plaid", "derived"]),
    balance: z
      .object({
        raw: moneySchema,
        owed: nonnegativeMoneySchema,
        asOf: instantSchema,
        coverage: z.enum(["complete", "stale"]),
      })
      .strict()
      .nullable(),
    terms: z
      .object({
        minimumPayment: nonnegativeMoneySchema.nullable(),
        nextDueOn: dateSchema.nullable(),
        asOf: instantSchema,
        coverage: z.enum(["complete", "stale"]),
      })
      .strict()
      .nullable(),
    apr: z
      .object({
        basisPoints: z.number().int().min(0).max(100000),
        type: z.enum([
          "purchase",
          "cash_advance",
          "balance_transfer",
          "promotional",
          "fixed",
          "variable",
          "unknown",
        ]),
        asOf: instantSchema,
        coverage: z.enum(["complete", "stale"]),
      })
      .strict()
      .nullable(),
    paymentPolicy: z
      .object({
        mode: z.enum(["minimum_due", "fixed_amount"]),
        fixedAmount: nonnegativeMoneySchema.nullable(),
        extraAmount: nonnegativeMoneySchema,
        version: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    projection: z.discriminatedUnion("status", [
      z
        .object({
          status: z.enum(["missing_inputs", "stale", "payment_too_low"]),
        })
        .strict(),
      z
        .object({
          status: z.literal("estimate"),
          months: z.number().int().nonnegative(),
          totalInterest: nonnegativeMoneySchema,
          finalPayment: nonnegativeMoneySchema,
        })
        .strict(),
    ]),
  })
  .strict();

const debtEditableFields = {
  name: z.string().trim().min(1).max(120),
  type: debtTypeSchema,
  linkedCommitmentId: uuidSchema.nullable().default(null),
  minimumPayment: nonnegativeMoneySchema.nullable().default(null),
  nextDueOn: dateSchema.nullable().default(null),
  aprBasisPoints: z.number().int().min(0).max(100000).nullable().default(null),
  paymentMode: z.enum(["minimum_due", "fixed_amount"]).default("minimum_due"),
  fixedPayment: positiveMoneySchema.nullable().default(null),
  extraPayment: nonnegativeMoneySchema.default({ minor: "0", currency: "USD" }),
};
export const debtCreateRequestSchema = z
  .object({
    ...debtEditableFields,
    accountId: uuidSchema.nullable().default(null),
    currentBalance: moneySchema.nullable().default(null),
    createPaymentCommitment: z.boolean().default(false),
    requestId: uuidSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.accountId && !value.currentBalance)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currentBalance"],
        message: "A manual debt needs a current balance",
      });
    if (value.paymentMode === "fixed_amount" && !value.fixedPayment)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fixedPayment"],
        message: "Enter the fixed payment amount",
      });
    if (
      value.createPaymentCommitment &&
      (!value.nextDueOn || (!value.fixedPayment && !value.minimumPayment))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["createPaymentCommitment"],
        message: "A new payment needs an amount and due date",
      });
  });
export const debtUpdateRequestSchema = z
  .object({
    ...debtEditableFields,
    expectedVersion: z.number().int().positive(),
    currentBalance: moneySchema.nullable().default(null),
    createPaymentCommitment: z.boolean().default(false),
    status: z.enum(["needs_review", "active", "paused", "closed", "archived"]),
    requestId: uuidSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.paymentMode === "fixed_amount" && !value.fixedPayment)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fixedPayment"],
        message: "Enter the fixed payment amount",
      });
    if (
      value.createPaymentCommitment &&
      (!value.nextDueOn || (!value.fixedPayment && !value.minimumPayment))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["createPaymentCommitment"],
        message: "A new payment needs an amount and due date",
      });
  });

export const manualTransactionUpdateSchema = z
  .object({
    merchant: z.string().trim().min(1).max(160),
    amount: positiveMoneySchema,
    occurredOn: dateSchema,
    direction: z.enum(["debit", "credit"]),
    category: transactionCategorySchema,
    expectedVersion: z.number().int().positive(),
    expectedCategoryVersion: z.number().int().positive(),
    requestId: uuidSchema,
  })
  .strict();

export const manualTransactionVoidSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    requestId: uuidSchema,
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
        incomes: z.array(recurringSuggestionSchema).max(12).default([]),
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
          planningRole: z.enum(["spendable", "protected", "excluded"]),
          coverage: z.enum(["complete", "stale", "missing", "excluded"]),
          balance: moneySchema.nullable(),
          balanceAsOf: instantSchema.nullable(),
        })
        .strict(),
    ),
    debts: z.array(debtSchema),
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

const reminderLeadDaysSchema = z
  .array(z.number().int().min(0).max(30))
  .min(1)
  .max(2)
  .refine(
    (days) =>
      new Set(days).size === days.length &&
      days.every((day, index) => index === 0 || days[index - 1]! > day),
    "Reminder days must be unique and ordered from earliest to latest",
  );
const notificationPreferenceFields = {
  version: z.number().int().positive(),
  emailAddress: z.string().email().max(320).nullable(),
  emailVerified: z.boolean(),
  emailEnabled: z.boolean(),
  pushEnabled: z.boolean(),
  connectionHealth: z.boolean(),
  commitmentReminders: z.boolean(),
  incomeReminders: z.boolean(),
  savingsReminders: z.boolean(),
  exceptionActivity: z.boolean(),
  weeklyDigest: z.boolean(),
  availableCashAlerts: z.boolean(),
  availableCashThreshold: z
    .object({
      minor: z
        .string()
        .regex(/^\d+$/)
        .refine((value) => BigInt(value) <= 100000000n),
      currency: z.literal("USD"),
    })
    .strict(),
  lockScreenDetail: z.boolean(),
  reminderHour: z.number().int().min(0).max(23),
  reminderMinute: z.number().int().min(0).max(59),
  commitmentReminderDays: reminderLeadDaysSchema,
  longTermReminderDays: reminderLeadDaysSchema,
  savingsReminderDays: reminderLeadDaysSchema,
  quietStartMinute: z.number().int().min(0).max(1439),
  quietEndMinute: z.number().int().min(0).max(1439),
  timezone: z
    .string()
    .min(1)
    .max(80)
    .refine(isTimeZone, "Invalid IANA timezone"),
} as const;

const quietWindowIsValid = (value: {
  quietStartMinute: number;
  quietEndMinute: number;
}) => value.quietStartMinute !== value.quietEndMinute;

export const notificationPreferencesSchema = z
  .object(notificationPreferenceFields)
  .strict()
  .refine(quietWindowIsValid, {
    path: ["quietEndMinute"],
    message: "Quiet time must have a start and end",
  });
const {
  emailVerified: _emailVerified,
  version: _version,
  ...notificationPreferenceUpdateFields
} = notificationPreferenceFields;
export const notificationPreferencesUpdateSchema = z
  .object({
    ...notificationPreferenceUpdateFields,
    expectedVersion: z.number().int().positive(),
    requestId: uuidSchema,
  })
  .strict()
  .refine(quietWindowIsValid, {
    path: ["quietEndMinute"],
    message: "Quiet time must have a start and end",
  });
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
    formatVersion: z.literal(5),
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
export type TransactionFeedQuery = z.infer<typeof transactionFeedQuerySchema>;
export type TransactionFeedResponse = z.infer<
  typeof transactionFeedResponseSchema
>;
export type PayCycleQuery = z.infer<typeof payCycleQuerySchema>;
export type PayCycleListResponse = z.infer<typeof payCycleListResponseSchema>;
export type PayCycleDetailResponse = z.infer<
  typeof payCycleDetailResponseSchema
>;
export type TransactionCategoryUpdate = z.infer<
  typeof transactionCategoryUpdateSchema
>;
export type MerchantCategoryRulesResponse = z.infer<
  typeof merchantCategoryRulesResponseSchema
>;
export type MerchantCategoryRuleUpdate = z.infer<
  typeof merchantCategoryRuleUpdateSchema
>;
export type MerchantCategoryRuleDelete = z.infer<
  typeof merchantCategoryRuleDeleteSchema
>;
export type ManualTransactionUpdate = z.infer<
  typeof manualTransactionUpdateSchema
>;
export type ManualTransactionVoid = z.infer<typeof manualTransactionVoidSchema>;
export type CommitmentRequest = z.infer<typeof commitmentRequestSchema>;
export type OccurrenceSkipRequest = z.infer<typeof occurrenceSkipRequestSchema>;
export type TransactionOccurrenceLinkRequest = z.infer<
  typeof transactionOccurrenceLinkRequestSchema
>;
export type TransactionOccurrenceUnlinkRequest = z.infer<
  typeof transactionOccurrenceUnlinkRequestSchema
>;
export type PlanUpdateRequest = z.infer<typeof planUpdateRequestSchema>;
export type StarterApplicationUndoRequest = z.infer<
  typeof starterApplicationUndoRequestSchema
>;
export type IncomeScheduleCreateRequest = z.infer<
  typeof incomeScheduleCreateRequestSchema
>;
export type IncomeScheduleUpdateRequest = z.infer<
  typeof incomeScheduleUpdateRequestSchema
>;
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
export type ManualModeRequest = z.infer<typeof manualModeRequestSchema>;
export type AccountPlanningRoleRequest = z.infer<
  typeof accountPlanningRoleRequestSchema
>;
export type SavingsGoalCreateRequest = z.infer<
  typeof savingsGoalCreateRequestSchema
>;
export type SavingsGoalUpdateRequest = z.infer<
  typeof savingsGoalUpdateRequestSchema
>;
export type SavingsGoalBalanceUpdateRequest = z.infer<
  typeof savingsGoalBalanceUpdateRequestSchema
>;
export type DebtCreateRequest = z.infer<typeof debtCreateRequestSchema>;
export type DebtUpdateRequest = z.infer<typeof debtUpdateRequestSchema>;
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

function validateSavingsGoalSchedule(
  value: {
    schedule:
      | "planning_period"
      | "one_time"
      | "weekly"
      | "biweekly"
      | "monthly"
      | "quarterly"
      | "annual";
    nextDueOn: string | null;
    targetDate: string | null;
  },
  context: z.RefinementCtx,
) {
  if (value.schedule !== "planning_period" && !value.nextDueOn)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["nextDueOn"],
      message: "This savings schedule requires a next contribution date",
    });
  if (value.targetDate && value.nextDueOn && value.targetDate < value.nextDueOn)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["targetDate"],
      message: "The target date cannot be before the next contribution",
    });
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
