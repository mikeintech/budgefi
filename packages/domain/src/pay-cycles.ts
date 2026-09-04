export type PayCycleTransaction = Readonly<{
  id: string;
  revision: number;
  accountId: string;
  merchant: string;
  amountMinor: bigint;
  occurredOn: string;
  direction: "debit" | "credit";
  status: "pending" | "posted";
  category: string;
  planningRole: "spendable" | "protected" | "excluded";
}>;

export type PayCycleOccurrence = Readonly<{
  id: string;
  version: number;
  kind: "income" | "commitment" | "savings";
  name: string;
  expectedOn: string;
  expectedAmountMinor: bigint | null;
  matchedAmountMinor: bigint;
  state: string;
  commitmentId: string | null;
  incomeScheduleId: string | null;
}>;

export type VerifiedMovement = Readonly<{
  id: string;
  name: string;
  kind: "contribution" | "withdrawal";
  amountMinor: bigint;
  effectiveOn: string;
}>;

export type DebtPayment = Readonly<{
  id: string;
  debtName: string;
  transactionId: string;
  amountMinor: bigint;
  occurredOn: string;
}>;

export type IncomeReceipt = Readonly<{
  transactionId: string;
  name: string;
  amountMinor: bigint;
  occurredOn: string;
}>;

export type PayCycleReport = Readonly<{
  earnedMinor: bigint;
  spendableEarnedMinor: bigint;
  spentMinor: bigint;
  pendingMinor: bigint;
  savedMinor: bigint;
  savingsWithdrawnMinor: bigint;
  commitmentsExpectedMinor: bigint;
  commitmentsPaidMinor: bigint;
  commitmentsRemainingMinor: bigint;
  debtPaidMinor: bigint;
  categories: ReadonlyArray<{ name: string; amountMinor: bigint }>;
  incomeSources: ReadonlyArray<{ name: string; amountMinor: bigint }>;
  commitments: ReadonlyArray<{
    id: string;
    name: string;
    expectedMinor: bigint;
    paidMinor: bigint;
    remainingMinor: bigint;
    state: string;
  }>;
  savings: ReadonlyArray<{
    id: string;
    name: string;
    kind: "contribution" | "withdrawal";
    amountMinor: bigint;
    effectiveOn: string;
  }>;
}>;

const NON_SPEND_CATEGORIES = new Set([
  "transfer",
  "savings_investments",
  "debt",
]);

export function derivePayCycleWindows(
  boundaries: ReadonlyArray<{ id: string; boundaryOn: string }>,
): ReadonlyArray<{
  startBoundaryId: string;
  endBoundaryId: string | null;
  startOn: string;
  endOn: string | null;
}> {
  const canonical = [...boundaries]
    .sort(
      (left, right) =>
        left.boundaryOn.localeCompare(right.boundaryOn) ||
        left.id.localeCompare(right.id),
    )
    .filter(
      (item, index, values) =>
        index === 0 || item.boundaryOn !== values[index - 1]!.boundaryOn,
    );
  return canonical.map((start, index) => {
    const end = canonical[index + 1] ?? null;
    return {
      startBoundaryId: start.id,
      endBoundaryId: end?.id ?? null,
      startOn: start.boundaryOn,
      endOn: end?.boundaryOn ?? null,
    };
  });
}

/**
 * Produces a cash-flow report for a half-open household-local date range.
 * Commitments and debt are explanatory overlays: their cash transaction is
 * counted exactly once and never added to `spentMinor` a second time.
 */
export function calculatePayCycleReport(
  input: Readonly<{
    startOn: string;
    endOn: string;
    transactions: ReadonlyArray<PayCycleTransaction>;
    occurrences: ReadonlyArray<PayCycleOccurrence>;
    savingsMovements: ReadonlyArray<VerifiedMovement>;
    debtPayments: ReadonlyArray<DebtPayment>;
    incomeReceipts: ReadonlyArray<IncomeReceipt>;
    representedOutflowTransactionIds: ReadonlySet<string>;
  }>,
): PayCycleReport {
  const inRange = (date: string) => date >= input.startOn && date < input.endOn;
  const posted = input.transactions.filter(
    (item) => item.status === "posted" && inRange(item.occurredOn),
  );
  const pendingMinor = input.transactions
    .filter(
      (item) =>
        item.status === "pending" &&
        item.direction === "debit" &&
        item.planningRole === "spendable" &&
        inRange(item.occurredOn),
    )
    .reduce((sum, item) => sum + item.amountMinor, 0n);

  const spendTransactions = posted.filter(
    (item) =>
      item.direction === "debit" &&
      item.planningRole === "spendable" &&
      !NON_SPEND_CATEGORIES.has(item.category) &&
      !input.representedOutflowTransactionIds.has(item.id),
  );
  const categories = groupAmounts(
    spendTransactions.map((item) => [item.category, item.amountMinor] as const),
  );

  const cycleOccurrences = input.occurrences.filter((item) =>
    inRange(item.expectedOn),
  );
  const commitments = cycleOccurrences
    .filter(
      (item): item is PayCycleOccurrence & { commitmentId: string } =>
        item.kind === "commitment" && item.commitmentId !== null,
    )
    .map((item) => {
      const expected = item.expectedAmountMinor ?? 0n;
      const paid =
        item.matchedAmountMinor > expected ? expected : item.matchedAmountMinor;
      return {
        id: item.id,
        name: item.name,
        expectedMinor: expected,
        paidMinor: paid,
        remainingMinor: expected > paid ? expected - paid : 0n,
        state: item.state,
      };
    });
  const incomeLabels = preferredIncomeLabels(
    input.incomeReceipts.filter((item) => inRange(item.occurredOn)),
  );
  const incomeTransactions = posted.filter(
    (item) =>
      item.direction === "credit" &&
      item.category === "income" &&
      (item.planningRole !== "excluded" || incomeLabels.has(item.id)),
  );
  const incomeSources = groupAmounts(
    incomeTransactions.map(
      (item) =>
        [incomeLabels.get(item.id) ?? item.merchant, item.amountMinor] as const,
    ),
  );
  const earnedMinor = incomeSources.reduce(
    (sum, item) => sum + item.amountMinor,
    0n,
  );
  const savings = input.savingsMovements
    .filter((item) => inRange(item.effectiveOn))
    .map((item) => ({ ...item }));
  const debtPayments = input.debtPayments.filter((item) =>
    inRange(item.occurredOn),
  );

  return {
    earnedMinor,
    spendableEarnedMinor: incomeTransactions
      .filter((item) => item.planningRole === "spendable")
      .reduce((sum, item) => sum + item.amountMinor, 0n),
    spentMinor: spendTransactions.reduce(
      (sum, item) => sum + item.amountMinor,
      0n,
    ),
    pendingMinor,
    savedMinor: savings
      .filter((item) => item.kind === "contribution")
      .reduce((sum, item) => sum + item.amountMinor, 0n),
    savingsWithdrawnMinor: savings
      .filter((item) => item.kind === "withdrawal")
      .reduce((sum, item) => sum + item.amountMinor, 0n),
    commitmentsExpectedMinor: commitments.reduce(
      (sum, item) => sum + item.expectedMinor,
      0n,
    ),
    commitmentsPaidMinor: commitments.reduce(
      (sum, item) => sum + item.paidMinor,
      0n,
    ),
    commitmentsRemainingMinor: commitments.reduce(
      (sum, item) => sum + item.remainingMinor,
      0n,
    ),
    debtPaidMinor: debtPayments.reduce(
      (sum, item) => sum + item.amountMinor,
      0n,
    ),
    categories,
    incomeSources,
    commitments,
    savings,
  };
}

/**
 * Match evidence names a source but never gates or caps money that actually
 * arrived. Multiple current matches can exist while a user resolves evidence;
 * choose one stable label and leave the transaction amount authoritative.
 */
function preferredIncomeLabels(
  receipts: ReadonlyArray<IncomeReceipt>,
): ReadonlyMap<string, string> {
  const candidates = new Map<
    string,
    Map<string, { amountMinor: bigint; firstIndex: number }>
  >();
  receipts.forEach((receipt, index) => {
    const byName = candidates.get(receipt.transactionId) ?? new Map();
    const current = byName.get(receipt.name);
    byName.set(receipt.name, {
      amountMinor: (current?.amountMinor ?? 0n) + receipt.amountMinor,
      firstIndex: current?.firstIndex ?? index,
    });
    candidates.set(receipt.transactionId, byName);
  });
  return new Map(
    [...candidates.entries()].map(([transactionId, byName]) => {
      const [name] = [...byName.entries()].sort(
        ([leftName, left], [rightName, right]) =>
          (right.amountMinor === left.amountMinor
            ? 0
            : right.amountMinor > left.amountMinor
              ? 1
              : -1) ||
          left.firstIndex - right.firstIndex ||
          leftName.localeCompare(rightName),
      )[0]!;
      return [transactionId, name];
    }),
  );
}

function groupAmounts(
  values: ReadonlyArray<readonly [string, bigint]>,
): ReadonlyArray<{ name: string; amountMinor: bigint }> {
  const totals = new Map<string, bigint>();
  for (const [name, amount] of values)
    totals.set(name, (totals.get(name) ?? 0n) + amount);
  return [...totals.entries()]
    .map(([name, amountMinor]) => ({ name, amountMinor }))
    .sort(
      (left, right) =>
        Number(right.amountMinor - left.amountMinor) ||
        left.name.localeCompare(right.name),
    );
}
