import { describe, expect, it } from "vitest";
import { addMoney, calculateProjection, money, parseDecimalMoney } from "../src/index.js";

describe("money", () => {
  it("parses decimal inputs without floating-point arithmetic", () => {
    expect(addMoney(parseDecimalMoney("0.10"), parseDecimalMoney("0.20")).minor).toBe(30n);
  });

  it("rejects fractions smaller than one cent", () => {
    expect(() => parseDecimalMoney("1.001")).toThrow(/at most two/);
  });

  it("rejects mixed currencies", () => {
    expect(() => addMoney(money(100n, "USD"), { minor: 100n, currency: "EUR" } as never)).toThrow(/Cannot combine/);
  });
});

describe("safe-to-spend policy", () => {
  it("matches the audited Budgefi reference calculation", () => {
    const result = calculateProjection({
      knownCash: money(423_039n),
      commitments: [money(185_000n), money(15_500n), money(1_899n), money(14_240n)],
      plannedSavings: money(50_000n),
      safetyBuffer: money(28_000n),
    });
    expect(result.available.minor).toBe(128_400n);
    expect(result.reserved.minor).toBe(294_639n);
  });

  it("preserves a negative projection instead of clamping it", () => {
    const result = calculateProjection({
      knownCash: money(10_000n),
      commitments: [money(12_000n)],
      plannedSavings: money(0n),
      safetyBuffer: money(0n),
    });
    expect(result.available.minor).toBe(-2_000n);
  });
});
