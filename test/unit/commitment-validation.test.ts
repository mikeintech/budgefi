import { describe, expect, it } from "vitest";
import { hasInvalidDuplicateCommitmentNames } from "../../src/lib/commitment-validation.js";

describe("commitment name validation", () => {
  it("round-trips distinct canonical commitments with the same legacy name", () => {
    const canonical = [
      { id: "insurance-a", name: "Insurance" },
      { id: "insurance-b", name: "Insurance" },
    ];
    expect(
      hasInvalidDuplicateCommitmentNames(
        canonical.map((item) => ({ ...item, amount: 100 })),
        canonical,
      ),
    ).toBe(false);
  });

  it("blocks a new row or rename that creates a duplicate", () => {
    const canonical = [{ id: "rent", name: "Rent" }];
    expect(
      hasInvalidDuplicateCommitmentNames(
        [
          { id: "rent", name: "Rent", amount: 1000 },
          { id: null, name: " rent ", amount: 900 },
        ],
        canonical,
      ),
    ).toBe(true);
    expect(
      hasInvalidDuplicateCommitmentNames(
        [
          { id: "rent", name: "Rent", amount: 1000 },
          { id: "power", name: "Rent", amount: 100 },
        ],
        [...canonical, { id: "power", name: "Power" }],
      ),
    ).toBe(true);
  });
});
