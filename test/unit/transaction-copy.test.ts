import { describe, expect, it } from "vitest";
import { linkedOutcome } from "../../src/lib/transaction-copy.js";

describe("transaction evidence copy", () => {
  it("describes income as deposits rather than bill payments", () => {
    expect(linkedOutcome("verified", "income")).toBe("Deposit received · verified");
    expect(linkedOutcome("pending", "income")).toContain("Deposit recorded");
    expect(linkedOutcome("partial", "income")).toBe("Part of deposit recorded");
    expect(linkedOutcome("overdue", "income")).toContain("expected income remains overdue");
  });
});
