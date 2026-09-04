import { describe, expect, it } from "vitest";
import { scoreReconciliationCandidate } from "../src/reconciliation.js";

describe("reconciliation scoring", () => {
  it("automatically accepts a posted bill only with strong agreement", () => {
    expect(scoreReconciliationCandidate({
      kind: "commitment", expectedName: "Duke Energy", expectedAmountMinor: 12500n,
      expectedOn: "2026-09-05", merchant: "DUKE ENERGY PAYMENT", amountMinor: 12500n,
      occurredOn: "2026-09-06", direction: "debit",
    }).automatic).toBe(true);
  });

  it("does not treat a similar amount alone as proof", () => {
    expect(scoreReconciliationCandidate({
      kind: "commitment", expectedName: "Electric", expectedAmountMinor: 12500n,
      expectedOn: "2026-09-05", merchant: "GROCERY MART", amountMinor: 12500n,
      occurredOn: "2026-09-05", direction: "debit",
    }).automatic).toBe(false);
  });

  it("never auto-verifies savings without destination evidence", () => {
    expect(scoreReconciliationCandidate({
      kind: "savings", expectedName: "Planned savings", expectedAmountMinor: 30000n,
      expectedOn: "2026-09-05", merchant: "TRANSFER", amountMinor: 30000n,
      occurredOn: "2026-09-05", direction: "debit",
    }).automatic).toBe(false);
  });
});
