const DAY_MS = 86_400_000;

export type ReconciliationCandidate = Readonly<{
  kind: "income" | "commitment" | "savings";
  expectedName: string;
  expectedAmountMinor: bigint | null;
  expectedOn: string;
  merchant: string;
  amountMinor: bigint;
  occurredOn: string;
  direction: "debit" | "credit";
}>;

export type ReconciliationScore = Readonly<{
  score: number;
  automatic: boolean;
  reason: string;
}>;

export function scoreReconciliationCandidate(
  candidate: ReconciliationCandidate,
): ReconciliationScore {
  if (candidate.kind === "savings")
    return { score: 0, automatic: false, reason: "Savings requires destination evidence" };
  const expectedDirection = candidate.kind === "income" ? "credit" : "debit";
  if (candidate.direction !== expectedDirection)
    return { score: 0, automatic: false, reason: "Transaction direction does not match" };
  const days = Math.abs(daysBetween(candidate.expectedOn, candidate.occurredOn));
  if (days > 7)
    return { score: 0, automatic: false, reason: "Transaction date is outside the match window" };
  const amountMatches =
    candidate.expectedAmountMinor === null ||
    candidate.expectedAmountMinor === candidate.amountMinor;
  const nameMatches = tokenOverlap(candidate.expectedName, candidate.merchant);
  const score =
    0.2 +
    (days <= 3 ? 0.25 : 0.15) +
    (amountMatches ? 0.4 : 0) +
    (nameMatches ? 0.15 : 0);
  const automatic = amountMatches && nameMatches && days <= 3 && score >= 0.9;
  return {
    score,
    automatic,
    reason: automatic
      ? "Posted amount, date, direction, and name match"
      : "Possible match requires review",
  };
}

function tokenOverlap(left: string, right: string): boolean {
  const ignored = new Set(["the", "payment", "pay", "bill", "primary", "income"]);
  const tokens = (value: string) =>
    new Set(
      value
        .toLocaleLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter((token) => token.length >= 3 && !ignored.has(token)),
    );
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  return [...leftTokens].some((token) => rightTokens.has(token));
}

function daysBetween(left: string, right: string): number {
  return Math.round(
    (Date.parse(`${right}T12:00:00Z`) - Date.parse(`${left}T12:00:00Z`)) /
      DAY_MS,
  );
}
