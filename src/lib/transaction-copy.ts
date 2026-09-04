export function linkedOutcome(value: string, kind?: "income" | "commitment" | "savings") {
  if (kind === "savings")
    return value === "verified"
      ? "Added · verified"
      : value === "pending"
        ? "Recorded · waiting for balance confirmation"
        : value === "partial"
          ? "Partially added"
          : "Recorded as a savings contribution";
  if (kind === "income")
    return value === "verified"
      ? "Deposit received · verified"
      : value === "pending"
        ? "Deposit recorded · waiting for balance refresh"
        : value === "partial"
          ? "Part of deposit recorded"
          : value === "overdue"
            ? "Deposit recorded · expected income remains overdue"
            : "Deposit recorded in your plan";
  return value === "verified"
    ? "Paid · verified"
    : value === "pending"
      ? "Recorded · waiting for balance refresh"
      : value === "partial"
        ? "Partially paid"
        : value === "overdue"
          ? "Recorded · plan item is still overdue"
          : "Recorded in your plan";
}
