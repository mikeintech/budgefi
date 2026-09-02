import { describe, expect, it } from "vitest";
import { withSuggestedCommitmentDates } from "../../src/lib/commitment-defaults.js";

const blankPlan = {
  rentDueDate: "",
  electricDueDate: "",
  streamBoxDueDate: "",
  insuranceDueDate: "",
  customCommitments: [] as { amount: number; dueDate: string }[],
};

describe("commitment setup suggestions", () => {
  it("provides useful dates even before amounts are entered", () => {
    const result = withSuggestedCommitmentDates(
      blankPlan,
      "2026-09-01",
      "2026-09-30",
    );

    expect(result.rentDueDate).toBe("2026-09-01");
    expect(result.electricDueDate).toBe("2026-09-10");
    expect(result.streamBoxDueDate).toBe("2026-09-15");
    expect(result.insuranceDueDate).toBe("2026-09-20");
  });

  it("never overwrites dates loaded from the ledger", () => {
    const result = withSuggestedCommitmentDates(
      { ...blankPlan, rentDueDate: "2026-09-07" },
      "2026-09-01",
      "2026-09-30",
    );

    expect(result.rentDueDate).toBe("2026-09-07");
  });
});
