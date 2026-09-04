import type { OnboardingAnalysisResponse } from "@budgefi/contracts";

type CalibrationDraft = {
  rentAmount: number;
  rentDueDate: string;
  rentRecurrence: SupportedCadence;
  electricMax: number;
  electricDueDate: string;
  electricRecurrence: SupportedCadence;
  streamBoxAmount: number;
  streamBoxDueDate: string;
  streamBoxRecurrence: SupportedCadence;
  insuranceAmount: number;
  insuranceDueDate: string;
  insuranceRecurrence: SupportedCadence;
  editedCommitments: string[];
  customCommitments: {
    id: string;
    name: string;
    amount: number;
    dueDate: string;
    recurrence: SupportedCadence;
  }[];
  savingsContribution: number;
};

type SupportedCadence =
  | "one_time"
  | "weekly"
  | "biweekly"
  | "monthly"
  | "quarterly"
  | "annual";

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
  // Savings-like activity may be shown for review, but never creates or funds
  // a goal automatically. Allocation remains an explicit user choice.

  for (const item of analysis.suggestions.commitments) {
    // Defensive boundary: the canonical commitment scheduler cannot represent
    // twice-monthly rules. The API routes these to needsReview, and the client
    // refuses to coerce one into an incorrect monthly schedule.
    if (item.cadence === "semi_monthly") continue;
    const amount = toMajor(item.amount.minor);
    if (item.category === "housing" && next.rentAmount <= 0) {
      next.rentAmount = amount;
      next.rentDueDate = item.nextExpectedDate;
      next.rentRecurrence = item.cadence as SupportedCadence;
      continue;
    }
    if (item.category === "utilities" && next.electricMax <= 0) {
      next.electricMax = amount;
      next.electricDueDate = item.nextExpectedDate;
      next.electricRecurrence = item.cadence as SupportedCadence;
      continue;
    }
    if (item.category === "subscription" && next.streamBoxAmount <= 0) {
      next.streamBoxAmount = amount;
      next.streamBoxDueDate = item.nextExpectedDate;
      next.streamBoxRecurrence = item.cadence as SupportedCadence;
      continue;
    }
    if (item.category === "insurance" && next.insuranceAmount <= 0) {
      next.insuranceAmount = amount;
      next.insuranceDueDate = item.nextExpectedDate;
      next.insuranceRecurrence = item.cadence as SupportedCadence;
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
        recurrence: item.cadence as SupportedCadence,
      });
  }
  return next;
}

function toMajor(minor: string): number {
  return Number(BigInt(minor)) / 100;
}
