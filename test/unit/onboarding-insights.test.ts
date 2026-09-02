import { describe, expect, it } from "vitest";
import type { OnboardingAnalysisResponse } from "@budgefi/contracts";
import { applyOnboardingSuggestions } from "../../src/lib/onboarding-insights.js";

const defaultCalibration = {
  knownCash: 0,
  includeChase: false,
  includeJoint: false,
  cashProvenance: "user_entered" as const,
  incomeAmount: 0,
  incomeFrequency: "biweekly" as const,
  nextIncomeDate: "",
  incomeConfirmed: false,
  rentAmount: 0,
  rentDueDate: "",
  electricMax: 0,
  electricDueDate: "",
  streamBoxAmount: 0,
  streamBoxDueDate: "",
  insuranceAmount: 0,
  insuranceDueDate: "",
  editedCommitments: [] as string[],
  customCommitments: [] as { id: string; name: string; amount: number; dueDate: string }[],
  savingsContribution: 0,
};

const recurring = (
  candidateId: string,
  name: string,
  minor: string,
  category: "housing" | "utilities" | "subscription" | "income" | "savings" | "bill",
) => ({
  candidateId,
  name,
  amount: { minor, currency: "USD" as const },
  nextExpectedDate: "2026-09-08",
  cadence: "monthly" as const,
  category,
  confidence: "strong" as const,
  variableAmount: false,
  observationCount: 4,
  explanation: "4 monthly occurrences",
});

function analysis(): OnboardingAnalysisResponse {
  return {
    state: "ready",
    source: "openai",
    model: "gpt-5.4-mini",
    generatedAt: "2026-09-01T12:00:00.000Z",
    transactionCount: 80,
    candidateCount: 5,
    notice: "Suggestions ready",
    suggestions: {
      income: recurring("income", "ACME Payroll", "225000", "income"),
      savings: recurring("acorns", "Acorns", "2500", "savings"),
      commitments: [
        recurring("rent", "City Apartments", "180000", "housing"),
        recurring("power", "City Power", "14250", "utilities"),
        recurring("phone", "Mobile Co", "8500", "bill"),
      ],
      needsReview: [],
      filtered: [],
    },
  };
}

describe("onboarding suggestion merge", () => {
  it("prefills income, bills, dates, and in-horizon savings", () => {
    const result = applyOnboardingSuggestions(defaultCalibration, analysis());
    expect(result.incomeAmount).toBe(2250);
    expect(result.nextIncomeDate).toBe("2026-09-08");
    expect(result.rentAmount).toBe(1800);
    expect(result.electricMax).toBe(142.5);
    expect(result.savingsContribution).toBe(25);
    expect(result.customCommitments).toEqual([
      expect.objectContaining({ name: "Mobile Co", amount: 85 }),
    ]);
  });

  it("never overwrites values already entered by the user", () => {
    const result = applyOnboardingSuggestions(
      {
        ...defaultCalibration,
        incomeAmount: 999,
        rentAmount: 1200,
        rentDueDate: "2026-09-03",
        savingsContribution: 50,
      },
      analysis(),
    );
    expect(result.incomeAmount).toBe(999);
    expect(result.rentAmount).toBe(1200);
    expect(result.rentDueDate).toBe("2026-09-03");
    expect(result.savingsContribution).toBe(50);
  });
});
