export type AnchoredCadence =
  | "weekly"
  | "biweekly"
  | "monthly"
  | "quarterly"
  | "annual";

export type ScheduleAnchor = Readonly<{
  day: number;
  endOfMonth: boolean;
}>;

/**
 * Returns the zero-based occurrence derived from the original calendar anchor.
 * Month-based schedules never compound a short-month clamp.
 */
export function anchoredOccurrenceDate(
  firstDate: string,
  cadence: AnchoredCadence,
  occurrenceIndex: number,
  anchor: ScheduleAnchor = anchorFromDate(firstDate),
): string {
  if (!Number.isSafeInteger(occurrenceIndex) || occurrenceIndex < 0)
    throw new RangeError("Occurrence index must be a nonnegative integer");
  const first = parseLocalDate(firstDate);
  if (cadence === "weekly" || cadence === "biweekly")
    return addLocalDays(
      firstDate,
      occurrenceIndex * (cadence === "weekly" ? 7 : 14),
    );
  const monthStep =
    cadence === "monthly" ? 1 : cadence === "quarterly" ? 3 : 12;
  const monthIndex =
    first.year * 12 + first.month - 1 + occurrenceIndex * monthStep;
  const year = Math.floor(monthIndex / 12);
  const month = modulo(monthIndex, 12) + 1;
  const lastDay = daysInMonth(year, month);
  return formatLocalDate({
    year,
    month,
    day: anchor.endOfMonth ? lastDay : Math.min(anchor.day, lastDay),
  });
}

export function advanceAnchoredDate(
  currentDate: string,
  cadence: AnchoredCadence,
  anchor: ScheduleAnchor = anchorFromDate(currentDate),
): string {
  if (cadence === "weekly") return addLocalDays(currentDate, 7);
  if (cadence === "biweekly") return addLocalDays(currentDate, 14);
  const current = parseLocalDate(currentDate);
  const monthStep =
    cadence === "monthly" ? 1 : cadence === "quarterly" ? 3 : 12;
  const monthIndex = current.year * 12 + current.month - 1 + monthStep;
  const year = Math.floor(monthIndex / 12);
  const month = modulo(monthIndex, 12) + 1;
  const lastDay = daysInMonth(year, month);
  return formatLocalDate({
    year,
    month,
    day: anchor.endOfMonth ? lastDay : Math.min(anchor.day, lastDay),
  });
}

export function anchorFromDate(value: string): ScheduleAnchor {
  const date = parseLocalDate(value);
  return {
    day: date.day,
    endOfMonth: date.day === daysInMonth(date.year, date.month),
  };
}

export function addLocalDays(value: string, amount: number): string {
  if (!Number.isSafeInteger(amount))
    throw new RangeError("Day offset must be an integer");
  const date = parseLocalDate(value);
  // Noon UTC deliberately keeps LocalDate arithmetic away from midnight and
  // therefore away from host/browser timezone and DST transitions.
  const instant = new Date(
    Date.UTC(date.year, date.month - 1, date.day + amount, 12),
  );
  return formatLocalDate({
    year: instant.getUTCFullYear(),
    month: instant.getUTCMonth() + 1,
    day: instant.getUTCDate(),
  });
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2)
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseLocalDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError("Invalid LocalDate");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month))
    throw new RangeError("Invalid LocalDate");
  return { year, month, day };
}

function formatLocalDate(value: { year: number; month: number; day: number }) {
  return `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
}

function modulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}
