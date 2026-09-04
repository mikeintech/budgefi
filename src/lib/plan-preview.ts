import {
  advanceAnchoredDate,
  addLocalDays,
  anchorFromDate,
  type AnchoredCadence,
} from "../../packages/domain/src/index.js";

type Recurrence = "one_time" | AnchoredCadence;
type Rule = {
  id: string | null;
  name: string;
  amount: number;
  dueDate: string;
  recurrence: Recurrence;
};
type Calibration = {
  knownCash: number;
  savingsContribution: number;
  rentId: string | null;
  rentName: string;
  rentAmount: number;
  rentDueDate: string;
  rentRecurrence: Recurrence;
  electricId: string | null;
  electricName: string;
  electricMax: number;
  electricDueDate: string;
  electricRecurrence: Recurrence;
  streamBoxId: string | null;
  streamBoxName: string;
  streamBoxAmount: number;
  streamBoxDueDate: string;
  streamBoxRecurrence: Recurrence;
  insuranceId: string | null;
  insuranceName: string;
  insuranceAmount: number;
  insuranceDueDate: string;
  insuranceRecurrence: Recurrence;
  customCommitments: Rule[];
};

export function calculatePlanProjection(
  calibration: Calibration,
  planningBuffer: number,
  horizonEnd?: string,
  context?: {
    horizonStart: string;
    commitments: {
      id: string;
      name: string;
      dueDate: string | null;
      recurrence: Recurrence;
      amount: { minor: string };
    }[];
    savingsGoals: {
      id: string;
      contributionAmount: { minor: string };
      schedule: "planning_period" | "one_time" | AnchoredCadence;
      nextDueOn: string | null;
      status: string;
    }[];
    occurrences: {
      kind: string;
      commitmentId: string | null;
      savingsGoalId: string | null;
      name: string;
      expectedOn: string;
      state: string;
      explicitlySkipped?: boolean;
      remainingAmount: { minor: string } | null;
    }[];
  },
) {
  const cents = (value: number) => Math.round(value * 100);
  const rules: Rule[] = [
    {
      id: calibration.rentId,
      name: calibration.rentName,
      amount: calibration.rentAmount,
      dueDate: calibration.rentDueDate,
      recurrence: calibration.rentRecurrence,
    },
    {
      id: calibration.electricId,
      name: calibration.electricName,
      amount: calibration.electricMax,
      dueDate: calibration.electricDueDate,
      recurrence: calibration.electricRecurrence,
    },
    {
      id: calibration.streamBoxId,
      name: calibration.streamBoxName,
      amount: calibration.streamBoxAmount,
      dueDate: calibration.streamBoxDueDate,
      recurrence: calibration.streamBoxRecurrence,
    },
    {
      id: calibration.insuranceId,
      name: calibration.insuranceName,
      amount: calibration.insuranceAmount,
      dueDate: calibration.insuranceDueDate,
      recurrence: calibration.insuranceRecurrence,
    },
    ...calibration.customCommitments,
  ];
  const futureBillsCents = rules.reduce((sum, rule) => {
    if (rule.amount <= 0 || !rule.dueDate) return sum;
    const canonical = context?.commitments.find(
      (item) =>
        (rule.id && item.id === rule.id) ||
        (!rule.id &&
          item.name.toLocaleLowerCase() ===
            rule.name.trim().toLocaleLowerCase()),
    );
    const definitionUnchanged =
      canonical?.dueDate === rule.dueDate &&
      canonical?.recurrence === rule.recurrence &&
      canonical?.name === rule.name.trim() &&
      BigInt(canonical?.amount.minor ?? "-1") === BigInt(cents(rule.amount));
    const dates = new Set(
      scheduleDatesThrough(
        rule.dueDate,
        rule.recurrence,
        horizonEnd ?? rule.dueDate,
        context ? addLocalDays(context.horizonStart, -90) : undefined,
      ),
    );
    if (context && definitionUnchanged)
      for (const occurrence of context.occurrences)
        if (
          occurrence.kind === "commitment" &&
          occurrence.expectedOn <= (horizonEnd ?? rule.dueDate) &&
          (canonical
            ? occurrence.commitmentId === canonical.id
            : occurrence.name.toLocaleLowerCase() ===
              rule.name.trim().toLocaleLowerCase())
        )
          dates.add(occurrence.expectedOn);
    return (
      sum +
      [...dates].reduce((scheduled, expectedOn) => {
        const existing = context?.occurrences.find(
          (item) =>
            item.kind === "commitment" &&
            item.expectedOn === expectedOn &&
            (canonical
              ? item.commitmentId === canonical.id
              : item.name.toLocaleLowerCase() ===
                rule.name.trim().toLocaleLowerCase()),
        );
        if (
          existing &&
          (existing.state === "verified" ||
            (existing.state === "skipped" && existing.explicitlySkipped))
        )
          return scheduled;
        const remaining =
          existing?.remainingAmount && definitionUnchanged
            ? Number(BigInt(existing.remainingAmount.minor))
            : cents(rule.amount);
        return scheduled + Math.max(0, remaining);
      }, 0)
    );
  }, 0);
  const plannedSavingsCents = context
    ? context.savingsGoals
        .filter((goal) => goal.status === "active")
        .reduce((sum, goal) => {
          const end = horizonEnd ?? context.horizonStart;
          const dates = new Set(
            goal.schedule === "planning_period"
              ? [end]
              : goal.nextDueOn
                ? scheduleDatesThrough(
                    goal.nextDueOn,
                    goal.schedule,
                    end,
                    addLocalDays(context.horizonStart, -90),
                  )
                : [],
          );
          if (goal.schedule !== "planning_period")
            for (const occurrence of context.occurrences)
              if (
                occurrence.kind === "savings" &&
                occurrence.savingsGoalId === goal.id &&
                occurrence.expectedOn <= end
              )
                dates.add(occurrence.expectedOn);
          return (
            sum +
            [...dates].reduce((scheduled, expectedOn) => {
              const existing = context.occurrences.find(
                (item) =>
                  item.kind === "savings" &&
                  item.savingsGoalId === goal.id &&
                  item.expectedOn === expectedOn,
              );
              if (
                existing &&
                (existing.state === "verified" ||
                  (existing.state === "skipped" && existing.explicitlySkipped))
              )
                return scheduled;
              return (
                scheduled +
                (existing?.remainingAmount
                  ? Number(BigInt(existing.remainingAmount.minor))
                  : Number(BigInt(goal.contributionAmount.minor)))
              );
            }, 0)
          );
        }, 0)
    : cents(calibration.savingsContribution);
  const reservedCents =
    futureBillsCents + plannedSavingsCents + cents(planningBuffer);
  return {
    incomeInWindow: 0,
    futureBills: futureBillsCents / 100,
    plannedSavings: plannedSavingsCents / 100,
    reserved: reservedCents / 100,
    available: (cents(calibration.knownCash) - reservedCents) / 100,
  };
}

function scheduleDatesThrough(
  firstDate: string,
  recurrence: Recurrence,
  horizonEnd: string,
  earliestDate?: string,
): string[] {
  if (firstDate > horizonEnd) return [];
  if (recurrence === "one_time") return [firstDate];
  const dates: string[] = [];
  const anchor = anchorFromDate(firstDate);
  let cursor = firstDate;
  for (let index = 0; index < 2_000 && cursor <= horizonEnd; index += 1) {
    if (!earliestDate || cursor >= earliestDate) dates.push(cursor);
    cursor = advanceAnchoredDate(cursor, recurrence, anchor);
  }
  return dates;
}
