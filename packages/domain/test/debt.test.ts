import { describe, expect, it } from "vitest";
import { projectDebtPayoff } from "../src/debt.js";

describe("debt payoff visibility", () => {
  it("does not invent projections from missing or stale facts", () => {
    expect(projectDebtPayoff({ owedMinor: 10_000n, aprBasisPoints: null, monthlyPaymentMinor: 1_000n, fresh: true }).status).toBe("missing_inputs");
    expect(projectDebtPayoff({ owedMinor: 10_000n, aprBasisPoints: 0, monthlyPaymentMinor: 1_000n, fresh: false }).status).toBe("stale");
  });

  it("supports zero APR and floors an overpaid card at zero", () => {
    expect(projectDebtPayoff({ owedMinor: 10_000n, aprBasisPoints: 0, monthlyPaymentMinor: 1_000n, fresh: true })).toMatchObject({ status: "estimate", months: 10, totalInterestMinor: 0n });
    expect(projectDebtPayoff({ owedMinor: -2_000n, aprBasisPoints: 2_999, monthlyPaymentMinor: 1_000n, fresh: true })).toMatchObject({ status: "estimate", months: 0 });
  });

  it("refuses a false payoff date when payment cannot cover interest", () => {
    expect(projectDebtPayoff({ owedMinor: 100_000n, aprBasisPoints: 3_600, monthlyPaymentMinor: 3_000n, fresh: true }).status).toBe("payment_too_low");
  });
});
