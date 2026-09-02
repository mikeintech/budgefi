import type { OnboardingAnalysisResponse } from "@budgefi/contracts";

type IncomeFrequency =
  | "weekly"
  | "biweekly"
  | "semi_monthly"
  | "monthly"
  | "irregular";
type CalibrationDraft = {
  incomeAmount: number;
  incomeFrequency: IncomeFrequency;
  nextIncomeDate: string;
  incomeConfirmed: boolean;
  rentAmount: number;
  rentDueDate: string;
  electricMax: number;
  electricDueDate: string;
  streamBoxAmount: number;
  streamBoxDueDate: string;
  insuranceAmount: number;
  insuranceDueDate: string;
  editedCommitments: string[];
  customCommitments: { id: string; name: string; amount: number; dueDate: string }[];
  savingsContribution: number;
};

export function applyOnboardingSuggestions<T extends CalibrationDraft>(
  current: T,
  analysis: OnboardingAnalysisResponse,
): T {
  if (analysis.state !== "ready") return current;
  const next: T = {
    ...current,
    editedCommitments: [...current.editedCommitments],
    customCommitments: [...current.customCommitments],
  } as T;
  const income = analysis.suggestions.income;
  if (income) {
    if (next.incomeAmount <= 0) next.incomeAmount = toMajor(income.amount.minor);
    if (!next.nextIncomeDate) next.nextIncomeDate = income.nextExpectedDate;
    if (!next.incomeConfirmed)
      next.incomeFrequency = incomeFrequency(income.cadence);
  }
  const savings = analysis.suggestions.savings;
  if (savings && next.savingsContribution <= 0)
    next.savingsContribution = toMajor(savings.amount.minor);

  for (const item of analysis.suggestions.commitments) {
    const amount = toMajor(item.amount.minor);
    if (item.category === "housing" && next.rentAmount <= 0) {
      next.rentAmount = amount;
      next.rentDueDate = item.nextExpectedDate;
      continue;
    }
    if (item.category === "utilities" && next.electricMax <= 0) {
      next.electricMax = amount;
      next.electricDueDate = item.nextExpectedDate;
      continue;
    }
    if (item.category === "subscription" && next.streamBoxAmount <= 0) {
      next.streamBoxAmount = amount;
      next.streamBoxDueDate = item.nextExpectedDate;
      continue;
    }
    if (item.category === "insurance" && next.insuranceAmount <= 0) {
      next.insuranceAmount = amount;
      next.insuranceDueDate = item.nextExpectedDate;
      continue;
    }
    if (
      !next.customCommitments.some(
        (existing) => existing.name.toLowerCase() === item.name.toLowerCase(),
      )
    )
      next.customCommitments.push({
        id: `suggested-${item.candidateId}`,
        name: item.name,
        amount,
        dueDate: item.nextExpectedDate,
      });
  }
  return next;
}

function incomeFrequency(
  cadence: OnboardingAnalysisResponse["suggestions"]["commitments"][number]["cadence"],
): IncomeFrequency {
  if (
    cadence === "weekly" ||
    cadence === "biweekly" ||
    cadence === "semi_monthly" ||
    cadence === "monthly"
  )
    return cadence;
  return "irregular";
}

function toMajor(minor: string): number {
  return Number(BigInt(minor)) / 100;
}
