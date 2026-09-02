export const supportedCurrencies = ["USD"] as const;
export type Currency = (typeof supportedCurrencies)[number];

export type Money = Readonly<{
  minor: bigint;
  currency: Currency;
}>;

const decimalPattern = /^-?(?:0|[1-9]\d*)(?:\.(\d{1,2}))?$/;

export function assertCurrency(value: string): asserts value is Currency {
  if (!supportedCurrencies.includes(value as Currency)) {
    throw new Error(`Unsupported currency: ${value}`);
  }
}

export function money(minor: bigint | string, currency: Currency = "USD"): Money {
  assertCurrency(currency);
  const parsed = typeof minor === "bigint" ? minor : BigInt(minor);
  return Object.freeze({ minor: parsed, currency });
}

export function parseDecimalMoney(value: string, currency: Currency = "USD"): Money {
  const normalized = value.trim();
  const match = decimalPattern.exec(normalized);
  if (!match) throw new Error("Money must be a decimal string with at most two fractional digits");
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return money(negative ? -minor : minor, currency);
}

export function addMoney(left: Money, right: Money): Money {
  requireSameCurrency(left, right);
  return money(left.minor + right.minor, left.currency);
}

export function subtractMoney(left: Money, right: Money): Money {
  requireSameCurrency(left, right);
  return money(left.minor - right.minor, left.currency);
}

export function sumMoney(values: readonly Money[], currency: Currency = "USD"): Money {
  return values.reduce((total, value) => addMoney(total, value), money(0n, currency));
}

export function serializeMoney(value: Money): { minor: string; currency: Currency } {
  return { minor: value.minor.toString(), currency: value.currency };
}

function requireSameCurrency(left: Money, right: Money): void {
  if (left.currency !== right.currency) {
    throw new Error(`Cannot combine ${left.currency} and ${right.currency}`);
  }
}
