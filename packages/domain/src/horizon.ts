import { advanceAnchoredDate, type AnchoredCadence } from "./schedule.js";

const DAY_MS = 86_400_000;

export type HorizonPolicy = Readonly<{
  today: string;
  nextIncomeDate: string | null;
  incomeConfirmed: boolean;
  fallbackDays: number;
}>;

export type PlanningHorizon = Readonly<{
  start: string;
  end: string;
  days: number;
  basis: "expected_income" | "fallback";
  incomeScheduleId?: string | null;
  missedIncome?: boolean;
}>;

export function resolvePlanningHorizonFromSchedules(policy: {
  today: string;
  fallbackDays: number;
  schedules: ReadonlyArray<{
    id: string;
    nextExpectedDate: string | null;
    confirmed: boolean;
    status: string;
  }>;
}): PlanningHorizon {
  const active = policy.schedules.filter(
    (item) =>
      item.status === "active" && item.confirmed && item.nextExpectedDate,
  );
  const missed = active
    .filter((item) => item.nextExpectedDate! < policy.today)
    .sort((a, b) => a.nextExpectedDate!.localeCompare(b.nextExpectedDate!));
  if (missed.length) {
    const fallback = resolvePlanningHorizon({
      today: policy.today,
      nextIncomeDate: null,
      incomeConfirmed: false,
      fallbackDays: policy.fallbackDays,
    });
    return { ...fallback, incomeScheduleId: missed[0]!.id, missedIncome: true };
  }
  const upcoming = active
    .filter(
      (item) =>
        item.nextExpectedDate! >= policy.today &&
        item.nextExpectedDate! <= addDays(policy.today, 90),
    )
    .sort(
      (a, b) =>
        a.nextExpectedDate!.localeCompare(b.nextExpectedDate!) ||
        a.id.localeCompare(b.id),
    );
  if (!upcoming.length)
    return {
      ...resolvePlanningHorizon({
        today: policy.today,
        nextIncomeDate: null,
        incomeConfirmed: false,
        fallbackDays: policy.fallbackDays,
      }),
      incomeScheduleId: null,
      missedIncome: false,
    };
  const winner = upcoming[0]!;
  return {
    start: policy.today,
    end: winner.nextExpectedDate!,
    days: daysBetween(policy.today, winner.nextExpectedDate!),
    basis: "expected_income",
    incomeScheduleId: winner.id,
    missedIncome: false,
  };
}

export function resolvePlanningHorizon(policy: HorizonPolicy): PlanningHorizon {
  const fallbackDays = Math.max(
    1,
    Math.min(90, Math.trunc(policy.fallbackDays)),
  );
  const fallbackEnd = addDays(policy.today, fallbackDays);
  if (
    policy.incomeConfirmed &&
    policy.nextIncomeDate &&
    policy.nextIncomeDate >= policy.today &&
    policy.nextIncomeDate <= addDays(policy.today, 90)
  ) {
    return {
      start: policy.today,
      end: policy.nextIncomeDate,
      days: daysBetween(policy.today, policy.nextIncomeDate),
      basis: "expected_income",
    };
  }
  return {
    start: policy.today,
    end: fallbackEnd,
    days: fallbackDays,
    basis: "fallback",
  };
}

export function advanceIncomeDate(
  current: string,
  frequency:
    | "weekly"
    | "biweekly"
    | "semi_monthly"
    | "monthly"
    | "quarterly"
    | "annual"
    | "irregular",
  anchor: string | { day: number; endOfMonth: boolean } = current,
): string | null {
  if (frequency === "irregular" || frequency === "semi_monthly") return null;
  const anchorDate =
    typeof anchor === "string" ? new Date(`${anchor}T12:00:00Z`) : null;
  const day =
    typeof anchor === "string" ? anchorDate!.getUTCDate() : anchor.day;
  const anchorLast = anchorDate
    ? new Date(
        Date.UTC(
          anchorDate.getUTCFullYear(),
          anchorDate.getUTCMonth() + 1,
          0,
          12,
        ),
      ).getUTCDate()
    : null;
  // A single date cannot distinguish 1st/15th from 15th/month-end (or custom
  // anchors), so twice-monthly schedules require the user to confirm the next
  // date after a deposit rather than silently moving the planning horizon.
  const preserveEndOfMonth =
    typeof anchor === "string" ? day === anchorLast : anchor.endOfMonth;
  return advanceAnchoredDate(current, frequency as AnchoredCadence, {
    day,
    endOfMonth: preserveEndOfMonth,
  });
}

export function advanceIncomeScheduleDate(
  current: string,
  schedule: {
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
): string | null {
  if (schedule.frequency !== "semi_monthly")
    return advanceIncomeDate(current, schedule.frequency, {
      day: schedule.anchorDay ?? Number(current.slice(8, 10)),
      endOfMonth: schedule.anchorEndOfMonth,
    });
  if (schedule.anchorDay === null || schedule.secondAnchorDay === null)
    return null;
  const currentDate = new Date(`${current}T12:00:00Z`);
  for (let monthOffset = 0; monthOffset <= 2; monthOffset++) {
    const year = currentDate.getUTCFullYear();
    const month = currentDate.getUTCMonth() + monthOffset;
    const last = new Date(Date.UTC(year, month + 1, 0, 12)).getUTCDate();
    const candidates = [
      schedule.anchorEndOfMonth ? last : Math.min(schedule.anchorDay, last),
      schedule.secondAnchorEndOfMonth
        ? last
        : Math.min(schedule.secondAnchorDay, last),
    ]
      .map((day) =>
        new Date(Date.UTC(year, month, day, 12)).toISOString().slice(0, 10),
      )
      .sort();
    const next = candidates.find((value) => value > current);
    if (next) return next;
  }
  return null;
}

function addDays(value: string, amount: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function daysBetween(left: string, right: string): number {
  return Math.round(
    (Date.parse(`${right}T12:00:00Z`) - Date.parse(`${left}T12:00:00Z`)) /
      DAY_MS,
  );
}
