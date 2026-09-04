import { addMoney, money, subtractMoney, sumMoney, type Currency, type Money } from "./money.js";

export const calculationPolicyVersion = "safe-to-spend/v2";

export type ProjectionInput = Readonly<{
  knownCash: Money;
  commitments: readonly Money[];
  plannedSavings: Money;
  safetyBuffer: Money;
}>;

export type Projection = Readonly<{
  knownCash: Money;
  commitments: Money;
  plannedSavings: Money;
  safetyBuffer: Money;
  reserved: Money;
  available: Money;
  policyVersion: typeof calculationPolicyVersion;
}>;

export function calculateProjection(input: ProjectionInput): Projection {
  const currency: Currency = input.knownCash.currency;
  const commitments = sumMoney(input.commitments, currency);
  const reserved = addMoney(addMoney(commitments, input.plannedSavings), input.safetyBuffer);
  const available = subtractMoney(input.knownCash, reserved);
  return Object.freeze({
    knownCash: money(input.knownCash.minor, currency),
    commitments,
    plannedSavings: money(input.plannedSavings.minor, currency),
    safetyBuffer: money(input.safetyBuffer.minor, currency),
    reserved,
    available,
    policyVersion: calculationPolicyVersion,
  });
}
