import { describe, expect, it } from "vitest";
import {
  calculatePayCycleReport,
  derivePayCycleWindows,
} from "../src/pay-cycles.js";

describe("pay-cycle reporting", () => {
  it("creates no fake cycle before payday and coalesces same-day deposits", () => {
    expect(derivePayCycleWindows([])).toEqual([]);
    expect(
      derivePayCycleWindows([
        { id: "second-job", boundaryOn: "2026-08-01" },
        { id: "main-job", boundaryOn: "2026-08-01" },
        { id: "next-pay", boundaryOn: "2026-08-15" },
      ]),
    ).toEqual([
      {
        startBoundaryId: "main-job",
        endBoundaryId: "next-pay",
        startOn: "2026-08-01",
        endOn: "2026-08-15",
      },
      {
        startBoundaryId: "next-pay",
        endBoundaryId: null,
        startOn: "2026-08-15",
        endOn: null,
      },
    ]);
  });
  it("uses half-open boundaries and does not count transfers, savings, or debt twice", () => {
    const report = calculatePayCycleReport({
      startOn: "2026-08-01",
      endOn: "2026-08-15",
      transactions: [
        tx("pay", "2026-08-01", "credit", "income", 200000n),
        tx("food", "2026-08-03", "debit", "groceries", 12000n),
        tx("card", "2026-08-04", "debit", "bills", 30000n),
        tx("save", "2026-08-05", "debit", "groceries", 20000n),
        tx("next-pay", "2026-08-15", "credit", "income", 210000n),
      ],
      occurrences: [
        {
          id: "rent",
          version: 2,
          kind: "commitment",
          name: "Rent",
          expectedOn: "2026-08-02",
          expectedAmountMinor: 90000n,
          matchedAmountMinor: 90000n,
          state: "verified",
          commitmentId: "rent-rule",
          incomeScheduleId: null,
        },
        {
          id: "income",
          version: 2,
          kind: "income",
          name: "Job",
          expectedOn: "2026-08-01",
          expectedAmountMinor: 200000n,
          matchedAmountMinor: 200000n,
          state: "verified",
          commitmentId: null,
          incomeScheduleId: "job",
        },
      ],
      savingsMovements: [
        {
          id: "saved",
          name: "Emergency",
          kind: "contribution",
          amountMinor: 20000n,
          effectiveOn: "2026-08-05",
        },
      ],
      debtPayments: [
        {
          id: "proof",
          debtName: "Card",
          transactionId: "card",
          amountMinor: 30000n,
          occurredOn: "2026-08-04",
        },
      ],
      incomeReceipts: [
        {
          transactionId: "pay",
          name: "Main job",
          amountMinor: 200000n,
          occurredOn: "2026-08-01",
        },
      ],
      representedOutflowTransactionIds: new Set(["card", "save"]),
    });
    expect(report.earnedMinor).toBe(200000n);
    expect(report.spentMinor).toBe(12000n);
    expect(report.savedMinor).toBe(20000n);
    expect(report.debtPaidMinor).toBe(30000n);
    expect(report.commitmentsPaidMinor).toBe(90000n);
    expect(report.incomeSources).toEqual([
      { name: "Main job", amountMinor: 200000n },
    ]);
  });

  it("keeps pending spending separate and shows partial commitments", () => {
    const report = calculatePayCycleReport({
      startOn: "2026-08-01",
      endOn: "2026-08-15",
      transactions: [
        {
          ...tx("pending", "2026-08-04", "debit", "utilities", 5000n),
          status: "pending",
        },
      ],
      occurrences: [
        {
          id: "power",
          version: 2,
          kind: "commitment",
          name: "Power",
          expectedOn: "2026-08-08",
          expectedAmountMinor: 10000n,
          matchedAmountMinor: 4000n,
          state: "partial",
          commitmentId: "power-rule",
          incomeScheduleId: null,
        },
      ],
      savingsMovements: [],
      debtPayments: [],
      incomeReceipts: [],
      representedOutflowTransactionIds: new Set(),
    });
    expect(report.spentMinor).toBe(0n);
    expect(report.pendingMinor).toBe(5000n);
    expect(report.commitmentsRemainingMinor).toBe(6000n);
  });

  it("attributes income by the actual receipt date, not its expected date", () => {
    const report = calculatePayCycleReport({
      startOn: "2026-08-15",
      endOn: "2026-08-29",
      transactions: [tx("late-pay", "2026-08-16", "credit", "income", 125000n)],
      occurrences: [
        {
          id: "late-income",
          version: 2,
          kind: "income",
          name: "Expected job",
          expectedOn: "2026-08-14",
          expectedAmountMinor: 125000n,
          matchedAmountMinor: 0n,
          state: "verified",
          commitmentId: null,
          incomeScheduleId: "job",
        },
      ],
      savingsMovements: [],
      debtPayments: [],
      incomeReceipts: [
        {
          transactionId: "late-pay",
          name: "Actual job",
          amountMinor: 125000n,
          occurredOn: "2026-08-16",
        },
      ],
      representedOutflowTransactionIds: new Set(),
    });
    expect(report.incomeSources).toEqual([
      { name: "Actual job", amountMinor: 125000n },
    ]);
  });

  it("counts unmatched and irregular categorized income without creating a boundary", () => {
    const report = calculatePayCycleReport({
      startOn: "2026-08-01",
      endOn: "2026-08-15",
      transactions: [
        tx("side-gig", "2026-08-03", "credit", "income", 90000n),
        tx("transfer", "2026-08-04", "credit", "transfer", 50000n),
        tx("refund", "2026-08-05", "credit", "refund", 2500n),
      ],
      occurrences: [],
      savingsMovements: [],
      debtPayments: [],
      incomeReceipts: [],
      representedOutflowTransactionIds: new Set(),
    });
    expect(report.earnedMinor).toBe(90000n);
    expect(report.incomeSources).toEqual([
      { name: "side-gig", amountMinor: 90000n },
    ]);
  });

  it("uses actual variable deposits while matches only label each transaction once", () => {
    const report = calculatePayCycleReport({
      startOn: "2026-08-01",
      endOn: "2026-08-15",
      transactions: [
        tx("overtime", "2026-08-01", "credit", "income", 110000n),
        tx("split-pay", "2026-08-02", "credit", "income", 40000n),
      ],
      occurrences: [],
      savingsMovements: [],
      debtPayments: [],
      incomeReceipts: [
        {
          transactionId: "overtime",
          name: "Main job",
          amountMinor: 100000n,
          occurredOn: "2026-08-01",
        },
        {
          transactionId: "overtime",
          name: "Main job",
          amountMinor: 100000n,
          occurredOn: "2026-08-01",
        },
        {
          transactionId: "overtime",
          name: "Other guess",
          amountMinor: 1000n,
          occurredOn: "2026-08-01",
        },
        {
          transactionId: "split-pay",
          name: "Main job",
          amountMinor: 40000n,
          occurredOn: "2026-08-02",
        },
      ],
      representedOutflowTransactionIds: new Set(),
    });
    expect(report.earnedMinor).toBe(150000n);
    expect(report.incomeSources).toEqual([
      { name: "Main job", amountMinor: 150000n },
    ]);
  });

  it("reports protected and verified excluded income without putting it in spendable reconciliation", () => {
    const report = calculatePayCycleReport({
      startOn: "2026-08-01",
      endOn: "2026-08-15",
      transactions: [
        {
          ...tx("protected-pay", "2026-08-02", "credit", "income", 80000n),
          planningRole: "protected",
        },
        {
          ...tx("excluded-pay", "2026-08-03", "credit", "income", 70000n),
          planningRole: "excluded",
        },
        {
          ...tx("excluded-guess", "2026-08-04", "credit", "income", 60000n),
          planningRole: "excluded",
        },
      ],
      occurrences: [],
      savingsMovements: [],
      debtPayments: [],
      incomeReceipts: [
        {
          transactionId: "protected-pay",
          name: "Protected job",
          amountMinor: 80000n,
          occurredOn: "2026-08-02",
        },
        {
          transactionId: "excluded-pay",
          name: "Excluded job",
          amountMinor: 70000n,
          occurredOn: "2026-08-03",
        },
      ],
      representedOutflowTransactionIds: new Set(),
    });
    expect(report.earnedMinor).toBe(150000n);
    expect(report.spendableEarnedMinor).toBe(0n);
    expect(report.incomeSources).toEqual([
      { name: "Protected job", amountMinor: 80000n },
      { name: "Excluded job", amountMinor: 70000n },
    ]);
  });
});

function tx(
  id: string,
  occurredOn: string,
  direction: "debit" | "credit",
  category: string,
  amountMinor: bigint,
) {
  return {
    id,
    revision: 1,
    accountId: "cash",
    merchant: id,
    amountMinor,
    occurredOn,
    direction,
    category,
    status: "posted" as const,
    planningRole: "spendable" as const,
  };
}
