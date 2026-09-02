import { describe, expect, it } from "vitest";
import {
  detectRecurringPatterns,
  type PatternTransaction,
} from "../src/index.js";

const transaction = (
  id: string,
  merchant: string,
  amountMinor: string,
  direction: "debit" | "credit",
  occurredOn: string,
  accountId = "checking",
): PatternTransaction => ({
  id,
  accountId,
  accountType: accountId === "card" ? "credit" : "checking",
  merchant,
  amountMinor,
  direction,
  occurredOn,
});

describe("recurring pattern detection", () => {
  it("finds stable monthly bills and recurring income", () => {
    const result = detectRecurringPatterns([
      transaction("r1", "City Apartments", "180000", "debit", "2026-04-01"),
      transaction("r2", "CITY APARTMENTS 49382", "180000", "debit", "2026-05-01"),
      transaction("r3", "City Apartments", "180000", "debit", "2026-05-31"),
      transaction("p1", "ACME PAYROLL", "235000", "credit", "2026-04-03"),
      transaction("p2", "ACME PAYROLL", "235000", "credit", "2026-04-17"),
      transaction("p3", "ACME PAYROLL", "235000", "credit", "2026-05-01"),
      transaction("p4", "ACME PAYROLL", "235000", "credit", "2026-05-15"),
    ]);

    expect(result.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ direction: "debit", cadence: "monthly" }),
        expect.objectContaining({ direction: "credit", cadence: "biweekly" }),
      ]),
    );
  });

  it("removes paired transfers and refunds while retaining Acorns for savings classification", () => {
    const result = detectRecurringPatterns([
      transaction("t1", "Online transfer", "50000", "debit", "2026-05-01"),
      transaction("t2", "Online transfer", "50000", "credit", "2026-05-02", "savings"),
      transaction("a1", "Acorns", "2500", "debit", "2026-04-01"),
      transaction("a2", "Acorns", "2500", "debit", "2026-05-01"),
      transaction("a3", "Acorns", "2500", "debit", "2026-05-31"),
      transaction("d1", "Corner Market", "4200", "debit", "2026-04-03"),
      transaction("c1", "Corner Market", "4200", "credit", "2026-04-10"),
    ]);

    expect(result.candidates).toEqual([
      expect.objectContaining({ merchant: "Acorns", direction: "debit" }),
    ]);
    expect(result.filtered.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["internal_transfer", "refund"]),
    );
  });

  it("does not promote a one-off or pending-style sparse history", () => {
    const result = detectRecurringPatterns([
      transaction("x1", "One time shop", "8100", "debit", "2026-05-01"),
      transaction("x2", "Random store", "2200", "debit", "2026-05-02"),
    ]);
    expect(result.candidates).toHaveLength(0);
  });
});
