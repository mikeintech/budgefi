import { describe, expect, it } from "vitest";
import { incomeScheduleCreateRequestSchema } from "../../packages/contracts/src/index.js";

const base = {
  destinationAccountId: null,
  name: "Twice-monthly pay",
  expectedAmount: null,
  frequency: "semi_monthly" as const,
  nextExpectedDate: "2026-09-15",
  confirmed: true,
  anchorDay: 15,
  anchorEndOfMonth: false,
  secondAnchorDay: 30,
  secondAnchorEndOfMonth: false,
  requestId: "00000000-0000-4000-8000-000000000001",
};

describe("income schedule contract", () => {
  it("rejects twice-monthly anchors that collapse in shorter months", () => {
    for (const pair of [
      { anchorDay: 31, anchorEndOfMonth: false, secondAnchorDay: 30, secondAnchorEndOfMonth: false },
      { anchorDay: 30, anchorEndOfMonth: false, secondAnchorDay: 31, secondAnchorEndOfMonth: true },
      { anchorDay: 29, anchorEndOfMonth: false, secondAnchorDay: 30, secondAnchorEndOfMonth: false },
      { anchorDay: 28, anchorEndOfMonth: false, secondAnchorDay: 31, secondAnchorEndOfMonth: true },
    ]) expect(incomeScheduleCreateRequestSchema.safeParse({ ...base, ...pair }).success).toBe(false);
    expect(incomeScheduleCreateRequestSchema.safeParse(base).success).toBe(true);
  });
});
