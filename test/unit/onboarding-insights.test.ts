import { describe, expect, it } from "vitest";
import type { OnboardingAnalysisResponse } from "@budgefi/contracts";
import { applyOnboardingSuggestions } from "../../src/lib/onboarding-insights.js";

const defaultCalibration = {
  knownCash: 0,
  includeChase: false,
  includeJoint: false,
  cashProvenance: "user_entered" as const,
  rentId: null,
  rentAmount: 0,
  rentDueDate: "",
  rentRecurrence: "monthly" as const,
  electricId: null,
  electricMax: 0,
  electricDueDate: "",
  electricRecurrence: "monthly" as const,
  streamBoxId: null,
  streamBoxAmount: 0,
  streamBoxDueDate: "",
  streamBoxRecurrence: "monthly" as const,
  insuranceId: null,
  insuranceAmount: 0,
  insuranceDueDate: "",
  insuranceRecurrence: "monthly" as const,
  editedCommitments: [] as string[],
  customCommitments: [] as {
    id: string;
    name: string;
    amount: number;
    dueDate: string;
    recurrence: "weekly" | "biweekly" | "monthly" | "quarterly" | "annual";
  }[],
  savingsContribution: 0,
};

const recurring = (
  candidateId: string,
  name: string,
  minor: string,
  category:
    | "housing"
    | "utilities"
    | "subscription"
    | "income"
    | "savings"
    | "bill",
  cadence:
    | "weekly"
    | "biweekly"
    | "semi_monthly"
    | "monthly"
    | "quarterly"
    | "annual" = "monthly",
) => ({
  candidateId,
  name,
  amount: { minor, currency: "USD" as const },
  nextExpectedDate: "2026-09-08",
  cadence,
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
      incomes: [recurring("income", "ACME Payroll", "225000", "income")],
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
  it("prefills bills and dates without auto-allocating income or savings", () => {
    const result = applyOnboardingSuggestions(defaultCalibration, analysis());
    expect(result.rentAmount).toBe(1800);
    expect(result.electricMax).toBe(142.5);
    expect(result.savingsContribution).toBe(0);
    expect(result.customCommitments).toEqual([
      expect.objectContaining({ name: "Mobile Co", amount: 85 }),
    ]);
  });

  it("never overwrites values already entered by the user", () => {
    const result = applyOnboardingSuggestions(
      {
        ...defaultCalibration,
        rentAmount: 1200,
        rentDueDate: "2026-09-03",
        savingsContribution: 50,
      },
      analysis(),
    );
    expect(result.rentAmount).toBe(1200);
    expect(result.rentDueDate).toBe("2026-09-03");
    expect(result.savingsContribution).toBe(50);
  });

  it("preserves annual and quarterly schedules instead of converting them to monthly", () => {
    const value = analysis();
    value.suggestions.commitments = [
      recurring("rent", "City Apartments", "180000", "housing", "annual"),
      recurring("phone", "Mobile Co", "8500", "bill", "quarterly"),
    ];
    const result = applyOnboardingSuggestions(defaultCalibration, value);
    expect(result.rentRecurrence).toBe("annual");
    expect(result.customCommitments[0]?.recurrence).toBe("quarterly");
  });

  it("never auto-saves a twice-monthly suggestion as monthly", () => {
    const value = analysis();
    value.suggestions.commitments = [
      recurring("hoa", "HOA", "9000", "bill", "semi_monthly"),
    ];
    expect(
      applyOnboardingSuggestions(defaultCalibration, value).customCommitments,
    ).toEqual([]);
  });
});
