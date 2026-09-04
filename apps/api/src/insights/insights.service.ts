import { createHash } from "node:crypto";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "kysely";
import {
  onboardingAnalysisResponseSchema,
  type OnboardingAnalysisRequest,
  type OnboardingAnalysisResponse,
} from "../../../../packages/contracts/src/index.js";
import {
  detectRecurringPatterns,
  isKnownInvestmentTransfer,
  normalizeMerchant,
  type RecurringCandidate,
} from "../../../../packages/domain/src/index.js";
import {
  TenantDatabase,
  type RequestIdentity,
} from "../database/tenant-database.js";
import {
  InsightsGateway,
  type PatternClassification,
} from "./insights.gateway.js";
import { featureEnabled } from "../config/feature-flags.js";

const PROMPT_VERSION = "onboarding-patterns-v1";

type Snapshot = Readonly<{
  householdId: string;
  horizonEnd: string;
  historySyncing: boolean;
  transactions: readonly {
    id: string;
    accountId: string;
    accountType: string;
    merchant: string;
    amountMinor: string;
    direction: "debit" | "credit";
    occurredOn: string;
  }[];
}>;

@Injectable()
export class InsightsService {
  constructor(
    @Inject(TenantDatabase) private readonly tenant: TenantDatabase,
    @Inject(InsightsGateway) private readonly gateway: InsightsGateway,
  ) {}

  async analyzeOnboarding(
    identity: RequestIdentity,
    request: OnboardingAnalysisRequest,
  ): Promise<OnboardingAnalysisResponse> {
    if (!featureEnabled("onboardingAi")) {
      throw new NotFoundException("This feature is not available");
    }
    const snapshot = await this.loadSnapshot(identity);
    const fingerprint = fingerprintSnapshot(snapshot);
    if (!request.refresh) {
      const cached = await this.loadCached(identity, fingerprint);
      if (cached) return cached;
    }

    const generatedAt = new Date().toISOString();
    if (snapshot.historySyncing) {
      return this.persist(
        identity,
        fingerprint,
        emptyResponse(
          "history_syncing",
          generatedAt,
          snapshot.transactions.length,
          "Historical activity is still arriving. Continue manually or try automatic setup again when the connection is current.",
        ),
      );
    }

    const detection = detectRecurringPatterns(snapshot.transactions);
    if (detection.candidates.length === 0) {
      return this.persist(
        identity,
        fingerprint,
        emptyResponse(
          "not_enough_history",
          generatedAt,
          detection.transactionCount,
          "There is not enough repeated activity yet to suggest plan inputs safely.",
        ),
      );
    }

    let classifications: PatternClassification[] = [];
    let source: "openai" | "deterministic" = "deterministic";
    let model: string | null = null;
    let modelUnavailable = false;
    if (this.gateway.enabled) {
      try {
        classifications = await this.gateway.classify(detection.candidates);
        if (classifications.length) {
          source = "openai";
          model = this.gateway.model;
        }
      } catch {
        modelUnavailable = true;
      }
    }
    const classificationMap = new Map(
      classifications.map((item) => [item.candidateId, item]),
    );
    const suggestions = buildSuggestions(
      detection.candidates,
      classificationMap,
      detection.filtered,
      snapshot.horizonEnd,
    );
    const surfaced =
      suggestions.commitments.length +
      suggestions.needsReview.length +
      suggestions.incomes.length +
      Number(Boolean(suggestions.savings));
    const response = onboardingAnalysisResponseSchema.parse({
      state: surfaced ? "ready" : "not_enough_history",
      source,
      model,
      generatedAt,
      transactionCount: detection.transactionCount,
      candidateCount: detection.candidates.length,
      notice: surfaced
        ? modelUnavailable
          ? "Budgefi found repeat patterns locally. Automatic labels were unavailable, so every suggestion remains yours to review."
          : "Budgefi found repeat patterns and prepared editable suggestions. Nothing joins your plan until you approve it."
        : "Repeated activity was found, but none was reliable enough to add to setup.",
      suggestions,
    });
    return this.persist(identity, fingerprint, response);
  }

  private loadSnapshot(identity: RequestIdentity): Promise<Snapshot> {
    return this.tenant.run(identity, async (db, principal) => {
      const plan = await db
        .selectFrom("plans")
        .select("planning_horizon_days")
        .where("household_id", "=", principal.householdId)
        .executeTakeFirstOrThrow();
      const connections = await db
        .selectFrom("connections")
        .select(["provider", "historical_update_complete", "status"])
        .where("household_id", "=", principal.householdId)
        .where("revoked_at", "is", null)
        .execute();
      const rows = await sql<{
        id: string;
        account_id: string;
        account_type: string;
        merchant: string;
        amount_minor: string;
        direction: "debit" | "credit";
        occurred_on: string;
      }>`
        select distinct on (t.source_kind, t.source_record_id)
          t.id, t.account_id, a.account_type, t.merchant, t.amount_minor,
          t.direction, t.occurred_on::text
        from financial_transactions t
        join accounts a on a.household_id=t.household_id and a.id=t.account_id
        where t.household_id=${principal.householdId}
          and t.status='posted'
          and t.currency='USD'
          and t.occurred_on >= current_date - interval '400 days'
        order by t.source_kind, t.source_record_id, t.revision desc
      `.execute(db);
      const today = new Date();
      const horizon = new Date(
        Date.UTC(
          today.getUTCFullYear(),
          today.getUTCMonth(),
          today.getUTCDate(),
        ),
      );
      horizon.setUTCDate(horizon.getUTCDate() + plan.planning_horizon_days);
      return {
        householdId: principal.householdId,
        horizonEnd: horizon.toISOString().slice(0, 10),
        historySyncing: connections.some(
          (item) =>
            item.provider === "plaid" &&
            item.status !== "revoked" &&
            !item.historical_update_complete,
        ),
        transactions: rows.rows.map((item) => ({
          id: item.id,
          accountId: item.account_id,
          accountType: item.account_type,
          merchant: item.merchant,
          amountMinor: item.amount_minor,
          direction: item.direction,
          occurredOn: item.occurred_on,
        })),
      };
    });
  }

  private loadCached(
    identity: RequestIdentity,
    fingerprint: string,
  ): Promise<OnboardingAnalysisResponse | null> {
    return this.tenant.run(identity, async (db, principal) => {
      const row = await db
        .selectFrom("financial_pattern_analyses")
        .select("result")
        .where("household_id", "=", principal.householdId)
        .where("input_fingerprint", "=", fingerprint)
        .where("model", "=", this.gateway.model)
        .where("prompt_version", "=", PROMPT_VERSION)
        .where("expires_at", ">", new Date())
        .orderBy("created_at", "desc")
        .executeTakeFirst();
      if (!row) return null;
      const parsed = onboardingAnalysisResponseSchema.safeParse(row.result);
      return parsed.success ? parsed.data : null;
    });
  }

  private async persist(
    identity: RequestIdentity,
    fingerprint: string,
    response: OnboardingAnalysisResponse,
  ): Promise<OnboardingAnalysisResponse> {
    await this.tenant.run(identity, async (db, principal) => {
      await db
        .insertInto("financial_pattern_analyses")
        .values({
          household_id: principal.householdId,
          input_fingerprint: fingerprint,
          model: this.gateway.model,
          prompt_version: PROMPT_VERSION,
          source: response.source,
          state: response.state,
          transaction_count: response.transactionCount,
          candidate_count: response.candidateCount,
          result: response,
        })
        .onConflict((conflict) =>
          conflict
            .columns([
              "household_id",
              "input_fingerprint",
              "model",
              "prompt_version",
            ])
            .doNothing(),
        )
        .execute();
    });
    return response;
  }
}

function buildSuggestions(
  candidates: readonly RecurringCandidate[],
  classifications: ReadonlyMap<string, PatternClassification>,
  filteredPatterns: readonly {
    merchant: string;
    kind: "internal_transfer" | "refund" | "savings_transfer";
    reason: string;
  }[],
  horizonEnd: string,
): OnboardingAnalysisResponse["suggestions"] {
  const commitments: OnboardingAnalysisResponse["suggestions"]["commitments"] =
    [];
  const needsReview: OnboardingAnalysisResponse["suggestions"]["needsReview"] =
    [];
  const incomes: OnboardingAnalysisResponse["suggestions"]["needsReview"] = [];
  const savings: OnboardingAnalysisResponse["suggestions"]["needsReview"] = [];
  const ordinary: OnboardingAnalysisResponse["suggestions"]["filtered"] = [];
  for (const candidate of candidates) {
    const classification =
      classifications.get(candidate.candidateId) ??
      fallbackClassification(candidate);
    const strong =
      candidate.observations.length >= 3 && candidate.recurrenceScore >= 0.88;
    const suggestion = {
      candidateId: candidate.candidateId,
      name: cleanName(classification.displayName || candidate.merchant),
      amount: {
        minor: candidate.amountVariable
          ? candidate.maximumAmountMinor
          : candidate.typicalAmountMinor,
        currency: "USD" as const,
      },
      nextExpectedDate: candidate.nextExpectedDate,
      cadence: candidate.cadence,
      category: classification.category,
      confidence: strong ? ("strong" as const) : ("review" as const),
      variableAmount: candidate.amountVariable,
      observationCount: candidate.observations.length,
      explanation:
        `${candidate.observations.length} ${cadenceLabel(candidate.cadence)} occurrences. ${classification.explanation}`.slice(
          0,
          240,
        ),
    };
    if (classification.kind === "income") incomes.push(suggestion);
    else if (classification.kind === "savings") savings.push(suggestion);
    else if (
      classification.kind === "bill" ||
      classification.kind === "subscription"
    ) {
      // Commitments do not support twice-monthly schedules yet. Keep these
      // visible for explicit review instead of silently saving them monthly.
      if (strong && suggestion.cadence !== "semi_monthly")
        commitments.push(suggestion);
      else needsReview.push(suggestion);
    } else {
      ordinary.push({
        name: suggestion.name,
        kind:
          classification.kind === "internal_transfer"
            ? "internal_transfer"
            : classification.kind === "refund"
              ? "refund"
              : "ordinary_activity",
        explanation: classification.explanation,
      });
    }
  }
  incomes.sort(compareSuggestions);
  savings.sort(compareSuggestions);
  const strongIncomes = incomes
    .filter((item) => item.confidence === "strong")
    .slice(0, 12);
  const savingsSuggestion =
    savings.find(
      (item) =>
        item.confidence === "strong" && item.nextExpectedDate <= horizonEnd,
    ) ?? null;
  needsReview.push(
    ...incomes.filter((item) => !strongIncomes.includes(item)),
    ...savings.filter((item) => item.confidence === "review"),
  );
  return {
    incomes: strongIncomes,
    commitments: commitments.sort(compareSuggestions),
    savings: savingsSuggestion,
    needsReview: needsReview.sort(compareSuggestions).slice(0, 20),
    filtered: [
      ...filteredPatterns.map((item) => ({
        name: cleanName(item.merchant),
        kind: item.kind,
        explanation: item.reason,
      })),
      ...ordinary,
    ].slice(0, 20),
  };
}

function fallbackClassification(
  candidate: RecurringCandidate,
): PatternClassification {
  const name = normalizeMerchant(candidate.merchant);
  if (isKnownInvestmentTransfer(name))
    return classification(
      candidate,
      "savings",
      "savings",
      "Recognized as a recurring investment transfer",
    );
  if (/\b(transfer|card payment|credit card|loan payment)\b/.test(name))
    return classification(
      candidate,
      "internal_transfer",
      "other",
      "Looks like money moving between accounts",
    );
  if (candidate.direction === "credit") {
    if (/\b(payroll|salary|direct deposit|pension|benefit)\b/.test(name))
      return classification(
        candidate,
        "income",
        "income",
        "Label is consistent with a regular income source",
      );
    return classification(
      candidate,
      "unknown",
      "other",
      "Recurring credit is not clearly income",
    );
  }
  if (/\b(rent|mortgage|property management|apartments?)\b/.test(name))
    return classification(
      candidate,
      "bill",
      "housing",
      "Looks like a housing payment",
    );
  if (
    /\b(electric|energy|power|water|sewer|utility|utilities|internet|wireless|mobile|phone|gas company)\b/.test(
      name,
    )
  )
    return classification(
      candidate,
      "bill",
      "utilities",
      "Looks like a household utility",
    );
  if (/\binsurance\b/.test(name))
    return classification(
      candidate,
      "bill",
      "insurance",
      "Looks like an insurance payment",
    );
  if (
    /\b(netflix|spotify|hulu|disney|youtube|apple com bill|subscription|membership)\b/.test(
      name,
    )
  )
    return classification(
      candidate,
      "subscription",
      "subscription",
      "Looks like a recurring subscription",
    );
  return classification(
    candidate,
    "bill",
    "bill",
    "Consistent recurring debit pattern",
  );
}

function classification(
  candidate: RecurringCandidate,
  kind: PatternClassification["kind"],
  category: PatternClassification["category"],
  explanation: string,
): PatternClassification {
  return {
    candidateId: candidate.candidateId,
    kind,
    category,
    displayName: candidate.merchant,
    explanation,
  };
}

function compareSuggestions(
  left: OnboardingAnalysisResponse["suggestions"]["needsReview"][number],
  right: OnboardingAnalysisResponse["suggestions"]["needsReview"][number],
): number {
  if (left.confidence !== right.confidence)
    return left.confidence === "strong" ? -1 : 1;
  return left.nextExpectedDate.localeCompare(right.nextExpectedDate);
}

function cadenceLabel(cadence: RecurringCandidate["cadence"]): string {
  return {
    weekly: "weekly",
    biweekly: "two-week",
    semi_monthly: "twice-monthly",
    monthly: "monthly",
    quarterly: "quarterly",
    annual: "annual",
  }[cadence];
}

function cleanName(value: string): string {
  const cleaned = value.trim().replace(/\s+/g, " ").slice(0, 120);
  return cleaned || "Recurring payment";
}

function emptyResponse(
  state: "history_syncing" | "not_enough_history" | "unavailable",
  generatedAt: string,
  transactionCount: number,
  notice: string,
): OnboardingAnalysisResponse {
  return onboardingAnalysisResponseSchema.parse({
    state,
    source: "none",
    model: null,
    generatedAt,
    transactionCount,
    candidateCount: 0,
    notice,
    suggestions: {
      incomes: [],
      commitments: [],
      savings: null,
      needsReview: [],
      filtered: [],
    },
  });
}

function fingerprintSnapshot(snapshot: Snapshot): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        historySyncing: snapshot.historySyncing,
        horizonEnd: snapshot.horizonEnd,
        transactions: snapshot.transactions.map((item) => [
          item.id,
          item.accountId,
          item.merchant,
          item.amountMinor,
          item.direction,
          item.occurredOn,
        ]),
      }),
    )
    .digest("hex");
}
