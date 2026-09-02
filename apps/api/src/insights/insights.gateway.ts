import { Injectable } from "@nestjs/common";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { RecurringCandidate } from "../../../../packages/domain/src/index.js";

const classificationSchema = z
  .object({
    classifications: z.array(
      z
        .object({
          candidateId: z.string(),
          kind: z.enum([
            "bill",
            "subscription",
            "income",
            "savings",
            "internal_transfer",
            "refund",
            "ordinary",
            "unknown",
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
          displayName: z.string().min(1).max(120),
          explanation: z.string().min(1).max(180),
        })
        .strict(),
    ),
  })
  .strict();

export type PatternClassification = z.infer<
  typeof classificationSchema
>["classifications"][number];

const PROMPT = `You classify already-detected recurring personal-finance patterns for onboarding.
The local system, not you, measured recurrence. Never invent a candidate or change its ID.
Classify recurring debits as bills, subscriptions, savings/investment transfers, internal transfers, refunds, ordinary activity, or unknown. Classify recurring credits as income only when the label strongly resembles payroll, benefits, pension, or a regular income source. P2P payments, refunds, interest, cash deposits, and account transfers are not income.
Brokerage and round-up services such as Acorns, Vanguard, Fidelity, Betterment, Wealthfront, Schwab, or Robinhood are savings—not bills.
Credit-card payments and transfers are not bills. Ordinary shopping, restaurants, and ATM activity should be ordinary.
Use a concise familiar display name. Explanation must be a short reason for the classification, not financial advice.`;

@Injectable()
export class InsightsGateway {
  readonly model = process.env.OPENAI_FINANCE_MODEL?.trim() || "gpt-5.4-mini";
  private readonly client = process.env.OPENAI_API_KEY
    ? new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        timeout: 12_000,
        maxRetries: 1,
      })
    : null;

  get enabled(): boolean {
    return Boolean(this.client) && process.env.OPENAI_FINANCE_ENABLED !== "false";
  }

  async classify(
    candidates: readonly RecurringCandidate[],
  ): Promise<PatternClassification[]> {
    if (!this.client || !this.enabled || candidates.length === 0) return [];
    const batches = chunk(candidates.slice(0, 75), 25);
    const responses = await Promise.all(
      batches.map(async (batch, index) => {
        const response = await this.client!.responses.parse({
          model: this.model,
          store: false,
          reasoning: { effort: "low" },
          max_output_tokens: 2_500,
          instructions: PROMPT,
          input: JSON.stringify({
            batch: index + 1,
            candidates: batch.map((candidate) => ({
              candidateId: candidate.candidateId,
              merchant: candidate.merchant,
              direction: candidate.direction,
              cadence: candidate.cadence,
              typicalAmountMinor: candidate.typicalAmountMinor,
              variableAmount: candidate.amountVariable,
              observations: candidate.observations.map((observation) => ({
                date: observation.occurredOn,
                amountMinor: observation.amountMinor,
              })),
            })),
          }),
          text: {
            format: zodTextFormat(
              classificationSchema,
              `budgefi_pattern_classification_${index + 1}`,
            ),
          },
        });
        return response.output_parsed?.classifications ?? [];
      }),
    );
    const allowed = new Set(candidates.map((item) => item.candidateId));
    const seen = new Set<string>();
    return responses.flat().filter((item) => {
      if (!allowed.has(item.candidateId) || seen.has(item.candidateId))
        return false;
      seen.add(item.candidateId);
      return true;
    });
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    result.push(items.slice(index, index + size));
  return result;
}
