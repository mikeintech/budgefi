export type DebtPayoffProjection =
  | { status: "missing_inputs" | "stale" | "payment_too_low" }
  | {
      status: "estimate";
      months: number;
      totalInterestMinor: bigint;
      finalPaymentMinor: bigint;
    };

/** A deliberately modest visibility estimate, not an optimization strategy. */
export function projectDebtPayoff(input: {
  owedMinor: bigint | null;
  aprBasisPoints: number | null;
  monthlyPaymentMinor: bigint | null;
  fresh: boolean;
}): DebtPayoffProjection {
  if (!input.fresh) return { status: "stale" };
  if (
    input.owedMinor === null ||
    input.aprBasisPoints === null ||
    input.monthlyPaymentMinor === null ||
    input.aprBasisPoints < 0 ||
    input.monthlyPaymentMinor <= 0n
  )
    return { status: "missing_inputs" };
  let balance = input.owedMinor > 0n ? input.owedMinor : 0n;
  if (balance === 0n)
    return {
      status: "estimate",
      months: 0,
      totalInterestMinor: 0n,
      finalPaymentMinor: 0n,
    };
  const rate = BigInt(input.aprBasisPoints);
  const monthlyInterest = (amount: bigint) =>
    (amount * rate + 60_000n) / 120_000n;
  if (input.monthlyPaymentMinor <= monthlyInterest(balance))
    return { status: "payment_too_low" };
  let totalInterest = 0n;
  let finalPayment = 0n;
  for (let months = 1; months <= 1_200; months += 1) {
    const interest = monthlyInterest(balance);
    totalInterest += interest;
    const due = balance + interest;
    finalPayment = input.monthlyPaymentMinor < due ? input.monthlyPaymentMinor : due;
    balance = due - finalPayment;
    if (balance <= 0n)
      return {
        status: "estimate",
        months,
        totalInterestMinor: totalInterest,
        finalPaymentMinor: finalPayment,
      };
  }
  return { status: "payment_too_low" };
}
