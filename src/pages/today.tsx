import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowDownLeft,
  ArrowUpRight,
  CalendarDays,
  CalendarClock,
  ChevronRight,
  CloudOff,
  CreditCard,
  House,
  PenLine,
  PiggyBank,
  ReceiptText,
  ShieldCheck,
  Tv,
  Zap,
  TriangleAlert,
  CircleCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HealthSheet, MobileShell } from "@/components/layout";
import { MoneySummary } from "@/components/money-summary";
import { useAppState } from "@/state/app-state";
import { money } from "@/lib/utils";
import { transactionCategoryLabels } from "@/lib/transaction-categories";
import { PayCycleCard } from "@/components/pay-cycle-card";

export function TodayPage() {
  const [searchParams] = useSearchParams();
  const {
    sourceStale,
    occurrences,
    authoritativeProjection,
    dataMode,
    manualActuals,
    accounts,
    cases,
    transactions,
    savingsGoals,
    debts,
    incomeSchedules,
    horizonIncomeScheduleId,
    horizonBasis,
    horizonMissedIncome,
    availableCashAlert,
  } = useAppState();
  const openedFromCashAlert = Boolean(searchParams.get("cash-alert"));
  const manual = dataMode === "manual";
  const manualAsOf = accounts.find(
    (account) => account.provenance === "manual",
  )?.balanceAsOf;
  const iconFor = (name: string) =>
    name.toLowerCase().includes("rent")
      ? House
      : name.toLowerCase().includes("electric")
        ? Zap
        : name.toLowerCase().includes("stream")
          ? Tv
          : CalendarDays;
  const upcoming = occurrences
    .filter(
      (item) =>
        item.kind === "commitment" &&
        item.state !== "verified" &&
        item.state !== "skipped" &&
        item.expectedOn <= authoritativeProjection.horizonEnd,
    )
    .slice(0, 3)
    .map((item) => ({
      id: item.id,
      icon: iconFor(item.name),
      label: item.name,
      meta: `${formatDate(item.expectedOn)} · ${occurrenceLabel(item.state)}`,
      amount: money(Number(BigInt(item.remainingAmount?.minor ?? "0")) / 100),
    }));
  const openCase = cases.find(
    (item) => item.status === "open" || item.status === "awaiting_verification",
  );
  const suggestedOccurrences = occurrences
    .filter((item) =>
      item.evidence.some((entry) => entry.matchState === "proposed"),
    )
    .sort((left, right) => left.expectedOn.localeCompare(right.expectedOn));
  const suggestedOccurrence = suggestedOccurrences[0];
  const suggestedEvidence = suggestedOccurrence?.evidence.find(
    (entry) => entry.matchState === "proposed",
  );
  const reviewCount =
    cases.filter(
      (item) =>
        item.status === "open" || item.status === "awaiting_verification",
    ).length + suggestedOccurrences.length;
  return (
    <MobileShell>
      <main className="px-4 pb-8 pt-5">
        <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[.14em] text-muted">
          <CalendarDays className="size-4" strokeWidth={1.8} />
          {new Intl.DateTimeFormat("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
          }).format(new Date())}
        </div>
        <MoneySummary />
        {availableCashAlert.status === "below" && (
          <section
            className="mt-3 rounded-2xl border border-amber-500/30 bg-amber-50 p-4"
            aria-label="Low available cash alert"
          >
            <div className="flex items-start gap-3">
              <TriangleAlert className="mt-0.5 size-5 shrink-0 text-amber-700" />
              <div className="min-w-0 flex-1">
                <strong className="block text-sm">
                  Available to use is below your alert
                </strong>
                <p className="mt-1 text-xs leading-5 text-muted">
                  {money(
                    Number(BigInt(availableCashAlert.currentAvailable.minor)) /
                      100,
                  )}{" "}
                  is available; your alert is{" "}
                  {money(
                    Number(BigInt(availableCashAlert.threshold.minor)) / 100,
                  )}
                  .
                  {manual && manualAsOf
                    ? ` Based on cash you last confirmed ${new Date(manualAsOf).toLocaleDateString([], { month: "short", day: "numeric" })}.`
                    : ""}
                </p>
                <div className="mt-2 flex gap-4">
                  <Link
                    to="/plan"
                    className="min-h-11 py-3 text-xs font-bold text-cobalt"
                  >
                    Review plan
                  </Link>
                  <Link
                    to="/settings/notifications"
                    className="min-h-11 py-3 text-xs font-bold text-cobalt"
                  >
                    Adjust alert
                  </Link>
                </div>
              </div>
            </div>
          </section>
        )}
        {openedFromCashAlert && availableCashAlert.status === "above" && (
          <section className="mt-3 flex items-start gap-3 rounded-2xl border border-emerald-600/20 bg-emerald-50 p-4">
            <CircleCheck className="mt-0.5 size-5 shrink-0 text-emerald-700" />
            <div>
              <strong className="block text-sm">
                Available cash has recovered
              </strong>
              <p className="mt-1 text-xs leading-5 text-muted">
                Today’s plan is now above the alert amount.
              </p>
            </div>
          </section>
        )}
        {openedFromCashAlert && availableCashAlert.status === "unavailable" && (
          <section className="mt-3 flex items-start gap-3 rounded-2xl border border-amber-500/25 bg-amber-50 p-4">
            <CloudOff className="mt-0.5 size-5 shrink-0 text-amber-700" />
            <div>
              <strong className="block text-sm">
                This alert can’t be confirmed yet
              </strong>
              <p className="mt-1 text-xs leading-5 text-muted">
                Refresh the account data before relying on the earlier amount.
              </p>
            </div>
          </section>
        )}
        {openedFromCashAlert && availableCashAlert.status === "disabled" && (
          <section className="mt-3 flex items-start gap-3 rounded-2xl border border-rule bg-white p-4">
            <CircleCheck className="mt-0.5 size-5 shrink-0 text-muted" />
            <div>
              <strong className="block text-sm">
                This alert is turned off
              </strong>
              <p className="mt-1 text-xs leading-5 text-muted">
                Your current plan is shown above. You can change alerts in
                Notifications.
              </p>
            </div>
          </section>
        )}
        {(manual || openCase || suggestedOccurrence) && (
          <section className="mt-7" aria-labelledby="review-heading">
            <div className="mb-3 flex items-end justify-between">
              <div>
                <p className="eyebrow">
                  {manual ? "Needs your input" : "Verifier status"}
                </p>
                <h1
                  id="review-heading"
                  className="text-[27px] font-bold leading-none tracking-[-.035em]"
                >
                  {manual
                    ? "Your manual check-in"
                    : openCase
                      ? "A possible duplicate needs review"
                      : suggestedOccurrence
                        ? "A possible payment needs review"
                        : "No exceptions need review"}
                </h1>
              </div>
              <Badge>
                {manual
                  ? `${manualActuals.length} recorded`
                  : reviewCount > 0
                    ? `${reviewCount} to review`
                    : "Current"}
              </Badge>
            </div>
            {manual ? (
              <article className="overflow-hidden rounded-[24px] border border-pencil/15 bg-white p-5 shadow-card">
                <span className="grid size-12 place-items-center rounded-2xl bg-recessed text-pencil">
                  <PenLine className="size-6" />
                </span>
                <h2 className="mt-4 text-xl font-bold tracking-[-.025em]">
                  Keep the plan current in a few taps
                </h2>
                <p className="mt-1 text-sm leading-5 text-muted">
                  Update today’s spendable balance, record a charge, or add an
                  upcoming commitment. Manual entries always stay clearly
                  labeled.
                </p>
                <Button asChild className="mt-4 w-full" size="lg">
                  <Link to="/manual">
                    Open manual workspace <ChevronRight className="size-4" />
                  </Link>
                </Button>
              </article>
            ) : (
              <article className="rounded-[24px] border border-rule bg-white p-5 shadow-card">
                <div className="flex items-start gap-3">
                  <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-pencil/8 text-pencil">
                    {suggestedOccurrence && !openCase ? (
                      <ReceiptText className="size-5" />
                    ) : (
                      <ShieldCheck className="size-5" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-xl font-bold leading-tight tracking-[-.025em]">
                      {openCase?.title ??
                        (suggestedOccurrence
                          ? `${suggestedOccurrence.name} may be paid`
                          : "Exact duplicate check is current")}
                    </h2>
                    <p className="mt-1 text-sm leading-5 text-muted">
                      {openCase
                        ? "Budgefi saved both transaction records so you can compare them before deciding."
                        : suggestedOccurrence
                          ? "Budgefi found a transaction that may belong to this plan item. Confirm it before the plan counts it as payment proof."
                          : "Budgefi checks current connected and manual transaction records for exact duplicate charges."}
                    </p>
                  </div>
                </div>
                <Button
                  asChild
                  className="mt-4 w-full"
                  variant={
                    openCase || suggestedOccurrence ? "default" : "outline"
                  }
                >
                  <Link
                    to={
                      openCase
                        ? `/review/${openCase.id}`
                        : suggestedEvidence
                          ? `/activity?transaction=${suggestedEvidence.transactionId}`
                          : "/review"
                    }
                  >
                    {openCase
                      ? "Review both charges"
                      : suggestedOccurrence
                        ? "Review possible payment"
                        : "View exception queue"}
                  </Link>
                </Button>
              </article>
            )}
          </section>
        )}
        <section className="mt-8" aria-labelledby="coming-up-heading">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="eyebrow">
                {authoritativeProjection.planningHorizonDays === 0
                  ? "Through today"
                  : `Next ${authoritativeProjection.planningHorizonDays} days`}
              </p>
              <h2
                id="coming-up-heading"
                className="text-xl font-bold tracking-[-.025em]"
              >
                Coming up
              </h2>
            </div>
            <Button asChild size="sm" variant="ghost">
              <Link to="/plan">See plan</Link>
            </Button>
          </div>
          <div className="divide-y divide-ink/8 overflow-hidden rounded-[22px] border border-ink/10 bg-white">
            {upcoming.map(({ id, icon: Icon, label, meta, amount }) => (
              <Link
                key={id}
                to="/plan"
                className="flex min-h-[72px] items-center gap-3 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cobalt"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-paper-deep text-cobalt">
                  <Icon className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{label}</span>
                  <span className="block truncate text-xs text-muted">
                    {meta}
                  </span>
                </span>
                <span className="text-sm font-bold tabular-nums">{amount}</span>
                <ChevronRight className="size-4 text-muted" />
              </Link>
            ))}
            {upcoming.length === 0 && (
              <div className="p-5 text-center">
                <strong className="block text-sm">
                  Nothing dated in this horizon
                </strong>
                <p className="mt-1 text-xs leading-5 text-muted">
                  Add the next bill or obligation you want Budgefi to reserve.
                </p>
                <Button asChild variant="outline" className="mt-3">
                  <Link to="/manual">Add commitment</Link>
                </Button>
              </div>
            )}
          </div>
        </section>
        <section className="mt-8" aria-labelledby="recent-transactions-heading">
          <div className="mb-3 flex items-end justify-between">
            <div>
              <p className="eyebrow">Money activity</p>
              <h2
                id="recent-transactions-heading"
                className="text-xl font-bold"
              >
                Recent transactions
              </h2>
            </div>
            <Button asChild size="sm" variant="ghost">
              <Link to="/activity">See all</Link>
            </Button>
          </div>
          <div className="divide-y divide-rule overflow-hidden rounded-[22px] border border-rule bg-white">
            {transactions.slice(0, 4).map((item) => (
              <Link
                key={item.id}
                to="/activity"
                className="flex min-h-[72px] items-center gap-3 px-4 py-3"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-recessed">
                  {item.direction === "credit" ? (
                    <ArrowDownLeft className="size-5" />
                  ) : (
                    <ArrowUpRight className="size-5" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-sm">
                    {item.merchant}
                  </strong>
                  <span className="block truncate text-sm text-muted">
                    {transactionCategoryLabels.get(item.category)} ·{" "}
                    {item.accountName}
                    {item.status === "pending" ? " · Pending" : ""}
                  </span>
                </span>
                <strong className="shrink-0 text-sm tabular-nums">
                  {item.direction === "credit" ? "+" : "−"}
                  {money(Number(item.amount.minor) / 100)}
                </strong>
              </Link>
            ))}
            {transactions.length === 0 && (
              <div className="p-5 text-center text-sm text-muted">
                Transactions will appear after activity is recorded or bank
                history arrives.
              </div>
            )}
          </div>
        </section>
        <PayCycleCard />
        <Link
          to="/plan"
          className="mt-3 flex min-h-[64px] items-center gap-3 rounded-2xl border border-rule bg-white px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil"
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-recessed text-cobalt">
            <CalendarClock className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <strong className="block text-sm">
              {horizonBasis === "expected_income"
                ? `Planning to ${incomeSchedules.find((item) => item.id === horizonIncomeScheduleId)?.name ?? "next income"}`
                : horizonMissedIncome
                  ? `${incomeSchedules.find((item) => item.id === horizonIncomeScheduleId)?.name ?? "Expected income"} is overdue`
                  : "Fallback planning window"}
            </strong>
            <span className="block truncate text-xs text-muted">
              Through {formatDate(authoritativeProjection.horizonEnd)} ·{" "}
              {horizonMissedIncome
                ? "using fallback"
                : "future income not counted"}
            </span>
          </span>
          <ChevronRight className="size-4 text-muted" />
        </Link>
        {savingsGoals.some((goal) => goal.status !== "archived") && (
          <section className="mt-8" aria-labelledby="today-goals-heading">
            <div className="mb-3 flex items-end justify-between">
              <div>
                <p className="eyebrow">Protected savings</p>
                <h2 id="today-goals-heading" className="text-xl font-bold">
                  Goals
                </h2>
              </div>
              <Button asChild size="sm" variant="ghost">
                <Link to="/plan">See plan</Link>
              </Button>
            </div>
            <div className="divide-y divide-rule overflow-hidden rounded-[22px] border border-rule bg-white">
              {savingsGoals
                .filter((goal) => goal.status !== "archived")
                .slice(0, 3)
                .map((goal) => {
                  const current = Number(goal.progress.confirmed.minor) / 100;
                  const target = goal.targetAmount
                    ? Number(goal.targetAmount.minor) / 100
                    : 0;
                  const planned = occurrences.find(
                    (item) =>
                      item.savingsGoalId === goal.id &&
                      !["verified", "skipped"].includes(item.state),
                  );
                  return (
                    <Link
                      key={goal.id}
                      to="/plan"
                      className="flex min-h-[78px] items-center gap-3 px-4 py-3"
                    >
                      <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-citron/70">
                        <PiggyBank className="size-5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-sm">
                          {goal.name}
                        </strong>
                        <span className="block truncate text-xs text-muted">
                          {!goal.destination && goal.status === "paused"
                            ? "Bank removed · choose a new account"
                            : goal.progress.assurance === "bank_confirmed"
                              ? "Bank confirmed"
                              : goal.progress.assurance === "user_confirmed"
                                ? "Confirmed by you"
                                : goal.progress.assurance === "stale"
                                  ? "Saved progress · refresh needed"
                                  : "Not started"}
                          {planned
                            ? ` · ${money(Number(planned.remainingAmount?.minor ?? "0") / 100)} planned`
                            : " · nothing reserved now"}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <strong className="block text-sm tabular-nums">
                          {money(current)}
                        </strong>
                        <span className="text-[11px] text-muted">
                          {target > 0 ? `of ${money(target)}` : "saved"}
                        </span>
                      </span>
                      <ChevronRight className="size-4 text-muted" />
                    </Link>
                  );
                })}
            </div>
          </section>
        )}
        {debts.some((debt) => debt.status !== "archived") && (
          <section className="mt-8" aria-labelledby="today-debt-heading">
            <div className="mb-3 flex items-end justify-between">
              <div>
                <p className="eyebrow">Debt snapshot</p>
                <h2 id="today-debt-heading" className="text-xl font-bold">
                  What you owe
                </h2>
              </div>
              <Button asChild size="sm" variant="ghost">
                <Link to="/plan">See plan</Link>
              </Button>
            </div>
            <div className="divide-y divide-rule overflow-hidden rounded-[22px] border border-rule bg-white">
              {debts
                .filter((debt) => debt.status !== "archived")
                .slice(0, 3)
                .map((debt) => {
                  const payment = occurrences.find(
                    (item) =>
                      item.commitmentId === debt.linkedCommitmentId &&
                      !["verified", "skipped"].includes(item.state),
                  );
                  return (
                    <Link
                      key={debt.id}
                      to="/plan"
                      className="flex min-h-[76px] items-center gap-3 px-4 py-3"
                    >
                      <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-paper-deep text-cobalt">
                        <CreditCard className="size-5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-sm">
                          {debt.name}
                        </strong>
                        <span className="block truncate text-xs text-muted">
                          {debt.status === "paused"
                            ? debt.linkedCommitmentId
                              ? "Bank tracking paused · payment still planned"
                              : "Bank tracking paused · no payment reserved"
                            : debt.status === "needs_review"
                              ? "Needs review"
                              : payment
                                ? `${money(Number(payment.remainingAmount?.minor ?? "0") / 100)} due ${formatDate(payment.expectedOn)}`
                                : "No payment reserved"}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <strong className="block text-sm tabular-nums">
                          {debt.balance
                            ? money(Number(debt.balance.owed.minor) / 100)
                            : "—"}
                        </strong>
                        <span className="text-[11px] text-muted">
                          {debt.balance?.coverage === "stale"
                            ? "stale"
                            : "owed"}
                        </span>
                      </span>
                      <ChevronRight className="size-4 text-muted" />
                    </Link>
                  );
                })}
            </div>
          </section>
        )}
        {sourceStale && !manual && (
          <div className="mt-8 flex items-center justify-between gap-3 rounded-2xl border border-amber-500/25 bg-amber-50 px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <CloudOff className="size-5 shrink-0 text-amber-700" />
              <div className="min-w-0">
                <p className="text-sm font-semibold">
                  An included account needs attention
                </p>
                <p className="truncate text-xs text-muted">
                  Coverage is stale or missing
                </p>
              </div>
            </div>
            <HealthSheet>
              <Button size="sm" variant="outline">
                Fix
              </Button>
            </HealthSheet>
          </div>
        )}
      </main>
    </MobileShell>
  );
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}
function occurrenceLabel(value: string) {
  return value === "pending"
    ? "paid · confirming balance"
    : value === "partial"
      ? "partially paid"
      : value === "needs_review"
        ? "suggested payment needs review"
        : value === "overdue"
          ? "past expected date"
          : "still expected";
}
