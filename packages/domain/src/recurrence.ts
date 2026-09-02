export type PatternDirection = "debit" | "credit";
export type PatternCadence =
  | "weekly"
  | "biweekly"
  | "semi_monthly"
  | "monthly"
  | "quarterly"
  | "annual";

export type PatternTransaction = Readonly<{
  id: string;
  accountId: string;
  accountType: string;
  merchant: string;
  amountMinor: string;
  direction: PatternDirection;
  occurredOn: string;
}>;

export type PatternObservation = Readonly<{
  id: string;
  accountId: string;
  amountMinor: string;
  occurredOn: string;
}>;

export type RecurringCandidate = Readonly<{
  candidateId: string;
  merchant: string;
  normalizedMerchant: string;
  direction: PatternDirection;
  cadence: PatternCadence;
  typicalAmountMinor: string;
  maximumAmountMinor: string;
  nextExpectedDate: string;
  amountVariable: boolean;
  recurrenceScore: number;
  observations: readonly PatternObservation[];
}>;

export type FilteredPattern = Readonly<{
  merchant: string;
  kind: "internal_transfer" | "refund" | "savings_transfer";
  reason: string;
}>;

export type PatternDetection = Readonly<{
  candidates: readonly RecurringCandidate[];
  filtered: readonly FilteredPattern[];
  transactionCount: number;
}>;

const DAY_MS = 86_400_000;
const INVESTMENT_DESTINATIONS = [
  "acorns",
  "betterment",
  "fidelity",
  "robinhood",
  "schwab",
  "sofi invest",
  "vanguard",
  "wealthfront",
];

export function detectRecurringPatterns(
  transactions: readonly PatternTransaction[],
): PatternDetection {
  const ordered = [...transactions]
    .filter((item) => item.merchant.trim() && BigInt(item.amountMinor) > 0n)
    .sort((left, right) => left.occurredOn.localeCompare(right.occurredOn));
  const excluded = new Set<string>();
  const filtered: FilteredPattern[] = [];

  markPairedTransfers(ordered, excluded, filtered);
  markRefunds(ordered, excluded, filtered);
  const groups = new Map<string, PatternTransaction[]>();
  for (const item of ordered) {
    if (excluded.has(item.id)) continue;
    const normalized = normalizeMerchant(item.merchant);
    if (!normalized) continue;
    const key = `${item.direction}:${normalized}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  const candidates: RecurringCandidate[] = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const uniqueDates = [...new Set(group.map((item) => item.occurredOn))].sort();
    if (uniqueDates.length < 2) continue;
    const intervals = uniqueDates
      .slice(1)
      .map((date, index) => daysBetween(uniqueDates[index]!, date));
    const cadence = inferCadence(intervals);
    if (!cadence) continue;
    const target = cadenceTarget(cadence);
    const intervalError = median(intervals.map((value) => Math.abs(value - target)));
    const amounts = group.map((item) => BigInt(item.amountMinor));
    const typical = medianBigInt(amounts);
    const maximum = amounts.reduce((max, value) => (value > max ? value : max));
    const minimum = amounts.reduce((min, value) => (value < min ? value : min));
    const amountSpread = typical === 0n ? 1 : Number(maximum - minimum) / Number(typical);
    const amountVariable = amountSpread > 0.12;
    const cadenceFit = Math.max(0, 1 - intervalError / Math.max(4, target * 0.25));
    const evidence = Math.min(1, (uniqueDates.length - 1) / 4);
    const amountFit = Math.max(0, 1 - Math.min(1, amountSpread));
    const recurrenceScore = roundScore(0.55 + evidence * 0.2 + cadenceFit * 0.16 + amountFit * 0.09);
    const lastDate = uniqueDates.at(-1)!;
    candidates.push({
      candidateId: stableCandidateId(key),
      merchant: displayMerchant(group.at(-1)!.merchant),
      normalizedMerchant: normalizeMerchant(group.at(-1)!.merchant),
      direction: group[0]!.direction,
      cadence,
      typicalAmountMinor: typical.toString(),
      maximumAmountMinor: maximum.toString(),
      nextExpectedDate: addDays(lastDate, target),
      amountVariable,
      recurrenceScore,
      observations: group.slice(-6).map((item) => ({
        id: item.id,
        accountId: item.accountId,
        amountMinor: item.amountMinor,
        occurredOn: item.occurredOn,
      })),
    });
  }

  return {
    candidates: candidates
      .sort((left, right) => right.recurrenceScore - left.recurrenceScore)
      .slice(0, 75),
    filtered: dedupeFiltered(filtered).slice(0, 12),
    transactionCount: ordered.length,
  };
}

export function normalizeMerchant(value: string): string {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/\b(?:pos|purchase|debit|credit|payment|online|recurring)\b/g, " ")
    .replace(/\b\d{4,}\b/g, " ")
    .replace(/[^a-z0-9&]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isKnownInvestmentTransfer(value: string): boolean {
  const merchant = normalizeMerchant(value);
  return INVESTMENT_DESTINATIONS.some((name) => merchant.includes(name));
}

function markPairedTransfers(
  items: readonly PatternTransaction[],
  excluded: Set<string>,
  filtered: FilteredPattern[],
) {
  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    const left = items[leftIndex]!;
    if (excluded.has(left.id)) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      const right = items[rightIndex]!;
      const distance = daysBetween(left.occurredOn, right.occurredOn);
      if (distance > 3) break;
      if (
        left.accountId === right.accountId ||
        left.direction === right.direction ||
        left.amountMinor !== right.amountMinor ||
        excluded.has(right.id)
      )
        continue;
      excluded.add(left.id);
      excluded.add(right.id);
      filtered.push({
        merchant: displayMerchant(left.merchant),
        kind: "internal_transfer",
        reason: "Matching movement between owned accounts",
      });
      break;
    }
  }
}

function markRefunds(
  items: readonly PatternTransaction[],
  excluded: Set<string>,
  filtered: FilteredPattern[],
) {
  for (const credit of items) {
    if (credit.direction !== "credit" || excluded.has(credit.id)) continue;
    const name = normalizeMerchant(credit.merchant);
    const debit = items.find(
      (item) =>
        item.direction === "debit" &&
        !excluded.has(item.id) &&
        item.amountMinor === credit.amountMinor &&
        normalizeMerchant(item.merchant) === name &&
        item.occurredOn <= credit.occurredOn &&
        daysBetween(item.occurredOn, credit.occurredOn) <= 60,
    );
    if (!debit) continue;
    excluded.add(credit.id);
    filtered.push({
      merchant: displayMerchant(credit.merchant),
      kind: "refund",
      reason: "Credit matched to an earlier charge",
    });
  }
}

function inferCadence(intervals: readonly number[]): PatternCadence | null {
  const value = median(intervals);
  if (value >= 5 && value <= 9) return "weekly";
  if (value >= 11 && value <= 17) return "biweekly";
  if (value >= 18 && value <= 24) return "semi_monthly";
  if (value >= 25 && value <= 35) return "monthly";
  if (value >= 80 && value <= 100) return "quarterly";
  if (value >= 340 && value <= 390) return "annual";
  return null;
}

function cadenceTarget(cadence: PatternCadence): number {
  return {
    weekly: 7,
    biweekly: 14,
    semi_monthly: 15,
    monthly: 30,
    quarterly: 91,
    annual: 365,
  }[cadence];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function medianBigInt(values: readonly bigint[]): bigint {
  const sorted = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2n;
}

function daysBetween(left: string, right: string): number {
  return Math.round((Date.parse(`${right}T12:00:00Z`) - Date.parse(`${left}T12:00:00Z`)) / DAY_MS);
}

function addDays(value: string, amount: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function displayMerchant(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 80);
}

function stableCandidateId(value: string): string {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return `pattern_${(hash >>> 0).toString(36)}`;
}

function roundScore(value: number): number {
  return Math.round(Math.min(0.99, Math.max(0, value)) * 100) / 100;
}

function dedupeFiltered(items: readonly FilteredPattern[]): FilteredPattern[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${normalizeMerchant(item.merchant)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
