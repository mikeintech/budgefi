export function scheduleLabel(value: string | null | undefined): string {
  switch (value) {
    case "one_time":
      return "One time";
    case "weekly":
      return "Weekly";
    case "biweekly":
      return "Every two weeks";
    case "semi_monthly":
      return "Twice a month";
    case "monthly":
      return "Monthly";
    case "quarterly":
      return "Every three months";
    case "annual":
      return "Yearly";
    case "irregular":
      return "Irregular";
    default:
      return "Schedule not set";
  }
}
