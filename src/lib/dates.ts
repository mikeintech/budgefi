export function nextMonthlyDate(reference: string, preferredDay: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(reference);
  if (!match) return reference;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const referenceDay = Number(match[3]);
  const thisMonthDay = Math.min(Math.max(1, preferredDay), daysInMonth(year, monthIndex));
  if (thisMonthDay >= referenceDay) return isoDate(year, monthIndex, thisMonthDay);
  const nextMonthIndex = monthIndex + 1;
  const nextYear = year + Math.floor(nextMonthIndex / 12);
  const normalizedMonth = nextMonthIndex % 12;
  return isoDate(nextYear, normalizedMonth, Math.min(Math.max(1, preferredDay), daysInMonth(nextYear, normalizedMonth)));
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function isoDate(year: number, monthIndex: number, day: number): string {
  return `${year.toString().padStart(4, "0")}-${(monthIndex + 1).toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}
