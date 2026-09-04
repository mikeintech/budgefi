import {
  CalendarRange,
  CreditCard,
  ChevronRight,
  CloudOff,
  House,
  ReceiptText,
  PiggyBank,
  ShoppingBag,
  Tv,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { MobileShell, HealthSheet } from "@/components/layout";
import { CommitmentEditor } from "@/components/commitment-editor";
import { CommitmentCreateSheet } from "@/components/commitment-create-sheet";
import { CommonBillsSheet } from "@/components/common-bills-sheet";
import { DebtEditor } from "@/components/debt-editor";
import {
  IncomeScheduleEditor,
  IncomeScheduleList,
} from "@/components/income-schedule-editor";
import {
  SavingsBalanceEditor,
  SavingsGoalEditor,
} from "@/components/savings-goal-editor";
import { Button } from "@/components/ui/button";
import { MoneySummary } from "@/components/money-summary";
import { useAppState, type PlanOccurrence } from "@/state/app-state";
import { money } from "@/lib/utils";
import { scheduleLabel } from "@/lib/schedule-labels";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

export function PlanPage() {
  const {
    sourceStale,
    commitments: planCommitments,
    occurrences,
    savingsGoals,
    debts,
    authoritativeProjection,
    dataMode,
    skipOccurrence,
    incomeSchedules,
    horizonBasis,
    horizonMissedIncome,
    calibration,
    planningBuffer,
    savePlanCalibration,
    latestStarterApplication,
    undoStarterApplicationPendingId,
    undoStarterApplication,
  } = useAppState();
  const manual = dataMode === "manual";
  const effectiveStale = !manual && sourceStale;
  const { available } = authoritativeProjection;
  const unallocatedCash = Math.max(0, available);
  const iconFor = (name: string) =>
    name.toLowerCase().includes("rent")
      ? House
      : name.toLowerCase().includes("electric")
        ? Zap
        : name.toLowerCase().includes("stream")
          ? Tv
          : CalendarRange;
  const debtCommitmentIds = new Set(
    debts.flatMap((debt) =>
      debt.linkedCommitmentId ? [debt.linkedCommitmentId] : [],
    ),
  );
  const commitments = [...planCommitments]
    .filter((item) => !debtCommitmentIds.has(item.id))
    .sort(
      (left, right) =>
        (left.dueDate ?? "9999-12-31").localeCompare(
          right.dueDate ?? "9999-12-31",
        ) || left.name.localeCompare(right.name),
    )
    .map((item) => {
      const open = occurrences
        .filter(
          (entry) =>
            entry.commitmentId === item.id &&
            !["verified", "skipped"].includes(entry.state) &&
            entry.expectedOn <= authoritativeProjection.horizonEnd,
        )
        .sort((left, right) => left.expectedOn.localeCompare(right.expectedOn));
      const remaining = open.reduce(
        (sum, entry) =>
          sum + Number(BigInt(entry.remainingAmount?.minor ?? "0")) / 100,
        0,
      );
      const paid = open.reduce(
        (sum, entry) => sum + Number(BigInt(entry.matchedAmount.minor)) / 100,
        0,
      );
      const first = open[0];
      const evidence = occurrences
        .filter((entry) => entry.commitmentId === item.id)
        .flatMap((entry) => entry.evidence);
      const confirmedEvidence = evidence.filter(
        (entry) => entry.matchState === "confirmed",
      );
      const suggestedEvidence = evidence.filter(
        (entry) => entry.matchState === "proposed",
      );
      const countNote =
        open.length > 1
          ? `${open.length} payments in this plan`
          : first
            ? statusLabel(first.state)
            : item.provenance === "manual"
              ? "You entered"
              : item.provenance === "plaid"
                ? "Connected data"
                : item.provenance === "csv"
                  ? "Imported"
                  : item.provenance === "derived"
                    ? "Detected"
                    : "Historical";
      return {
        item,
        occurrence: first,
        confirmedEvidence,
        suggestedEvidence,
        icon: iconFor(item.name),
        title: item.name,
        date: first
          ? `${first.state === "overdue" ? "Past due · " : "Next · "}${formatPlanDate(first.expectedOn)}`
          : item.dueDate
            ? `${formatPlanDate(item.dueDate)}${item.dueDate > authoritativeProjection.horizonEnd ? " · outside this plan window" : ""}`
            : "Not reserved · add a due date",
        amount: money(
          open.length ? remaining : Number(BigInt(item.amount.minor)) / 100,
        ),
        note: paid > 0 ? `${countNote} · ${money(paid)} recorded` : countNote,
      };
    });
  return (
    <MobileShell>
      <main className="px-4 pb-8 pt-5">
        <p className="eyebrow">
          Through {formatPlanDate(authoritativeProjection.horizonEnd)}
        </p>
        <h1 className="text-[31px] font-bold tracking-[-0.04em]">Your plan</h1>
        <p className="mb-5 mt-1 text-sm text-muted">
          A cash view built from what has cleared and what is still expected.
        </p>
        <MoneySummary variant="compact" />

        {effectiveStale && (
          <HealthSheet>
            <button className="mt-3 flex w-full items-center gap-3 rounded-2xl border border-amber-500/25 bg-amber-50 p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt">
              <CloudOff
                className="size-5 shrink-0 text-amber-700"
                strokeWidth={1.8}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">
                  One account may be behind
                </span>
                <span className="block truncate text-xs text-muted">
                  Tap to inspect the plan’s data sources
                </span>
              </span>
              <ChevronRight className="size-4 text-muted" />
            </button>
          </HealthSheet>
        )}

        <section className="mt-7" aria-labelledby="income-heading">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <p className="eyebrow">Planning horizon</p>
              <h2 id="income-heading" className="text-xl font-bold">
                Expected income
              </h2>
            </div>
            <IncomeScheduleEditor compact />
          </div>
          <IncomeScheduleList compact />
          <p className="mt-2 text-xs leading-5 text-muted">
            {horizonBasis === "expected_income"
              ? "The earliest reliable date sets this plan window. Deposits only become cash after they arrive."
              : horizonMissedIncome
                ? "An expected deposit is overdue, so Budgefi is using the fallback window until you review it."
                : "No reliable payday is assumed. Budgefi is using the fallback planning window."}
          </p>
          <Link
            to="/pay-cycles"
            className="mt-2 inline-flex min-h-11 items-center text-xs font-semibold text-cobalt"
          >
            See verified pay-cycle history{" "}
            <ChevronRight className="ml-1 size-3.5" />
          </Link>
        </section>

        <section className="mt-7" aria-labelledby="commitments-heading">
          <div className="mb-3 flex items-end justify-between">
            <div>
              <p className="eyebrow">Already accounted for</p>
              <h2 id="commitments-heading" className="text-xl font-bold">
                Commitments
              </h2>
            </div>
            <CommitmentCreateSheet />
          </div>
          <div className="mb-3 flex justify-end">
            <CommonBillsSheet
              existingKeys={calibration.starterItemKeys}
              existingNames={planCommitments.map((item) => item.name)}
              onAdd={(items) =>
                savePlanCalibration(
                  {
                    ...calibration,
                    customCommitments: [...calibration.customCommitments, ...items],
                  },
                  planningBuffer,
                )
              }
            />
          </div>
          {latestStarterApplication?.removable && (
            <div className="mb-3 flex min-h-14 items-center justify-between gap-3 rounded-2xl bg-cobalt/[.06] px-4 py-3">
              <p className="text-xs leading-5 text-muted">
                {latestStarterApplication.itemCount} empty bill {latestStarterApplication.itemCount === 1 ? "row was" : "rows were"} added.
              </p>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={undoStarterApplicationPendingId === latestStarterApplication.id}
                aria-busy={undoStarterApplicationPendingId === latestStarterApplication.id}
                onClick={() => void undoStarterApplication(latestStarterApplication.id)}
              >
                {undoStarterApplicationPendingId === latestStarterApplication.id
                  ? "Undoing…"
                  : "Undo"}
              </Button>
            </div>
          )}
          <div className="divide-y divide-ink/8 overflow-hidden rounded-[22px] border border-ink/10 bg-white">
            {commitments.map(
              ({
                item,
                occurrence,
                confirmedEvidence,
                suggestedEvidence,
                icon: Icon,
                title,
                date,
                amount,
                note,
              }) => (
                <div
                  key={item.id}
                  className="flex min-h-[76px] items-center gap-3 px-4 py-3"
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-paper-deep text-cobalt">
                    <Icon className="size-5" strokeWidth={1.8} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">{title}</span>
                    <span className="block text-xs text-muted">
                      {date} · {scheduleLabel(item.recurrence)} · {note}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-sm font-bold tabular-nums">
                      {amount}
                    </span>
                    <span className="flex items-center justify-end gap-1">
                      {confirmedEvidence.length > 0 && (
                        <OccurrenceEvidenceButton
                          name={item.name}
                          evidence={confirmedEvidence}
                        />
                      )}
                      {suggestedEvidence.length > 0 && (
                        <OccurrenceEvidenceButton
                          name={item.name}
                          evidence={suggestedEvidence}
                          suggested
                        />
                      )}{" "}
                      {occurrence && (
                        <OccurrenceSkipButton
                          occurrence={occurrence}
                          name={item.name}
                          onSkip={skipOccurrence}
                        />
                      )}
                      <CommitmentEditor item={item} />
                    </span>
                  </span>
                </div>
              ),
            )}
            {commitments.length === 0 && (
              <div className="p-5 text-center">
                <strong className="block text-sm">No active commitments</strong>
                <p className="mt-1 text-xs leading-5 text-muted">
                  Add a bill, subscription, or obligation for Budgefi to track.
                </p>
              </div>
            )}
          </div>
        </section>

        <section className="mt-7" aria-labelledby="debts-heading">
          <div className="mb-3 flex items-end justify-between">
            <div>
              <p className="eyebrow">What you owe</p>
              <h2 id="debts-heading" className="text-xl font-bold">
                Debt
              </h2>
            </div>
            <DebtEditor compact />
          </div>
          <div className="space-y-3">
            {debts
              .filter((debt) => debt.status !== "archived")
              .map((debt) => {
                const commitment = planCommitments.find(
                  (item) => item.id === debt.linkedCommitmentId,
                );
                const occurrence = occurrences.find(
                  (item) =>
                    item.commitmentId === debt.linkedCommitmentId &&
                    !["verified", "skipped"].includes(item.state),
                );
                const projection = debt.projection;
                return (
                  <article
                    key={debt.id}
                    className="rounded-[22px] border border-ink/10 bg-white p-4"
                  >
                    <div className="flex items-start gap-3">
                      <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-paper-deep text-cobalt">
                        <CreditCard className="size-5" strokeWidth={1.8} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <strong className="block text-sm">{debt.name}</strong>
                        <span className="block text-xs text-muted">
                          {debt.balance
                            ? `${debt.balance.coverage === "stale" ? "Stale balance · " : "Balance · "}${money(Number(debt.balance.owed.minor) / 100)}`
                            : "Balance not provided"}
                        </span>
                      </span>
                      <DebtEditor debt={debt} />
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-3 border-t border-ink/8 pt-3 text-xs">
                      <div>
                        <span className="text-muted">Next payment</span>
                        <strong className="mt-1 block">
                          {commitment
                            ? money(Number(commitment.amount.minor) / 100)
                            : "Not planned"}
                        </strong>
                        <span className="text-muted">
                          {occurrence
                            ? formatPlanDate(occurrence.expectedOn)
                            : debt.terms?.nextDueOn
                              ? formatPlanDate(debt.terms.nextDueOn)
                              : "No due date"}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted">Payoff visibility</span>
                        <strong className="mt-1 block">
                          {projection.status === "estimate"
                            ? `About ${projection.months} months`
                            : projection.status === "payment_too_low"
                              ? "Balance may grow"
                              : projection.status === "stale"
                                ? "Refresh needed"
                                : "More details needed"}
                        </strong>
                        <span className="text-muted">
                          Estimate · no new charges
                        </span>
                      </div>
                    </div>
                    {debt.status === "needs_review" && (
                      <p className="mt-3 rounded-xl bg-amber-50 p-2 text-xs text-amber-800">
                        Review this connected debt before relying on its payment
                        plan.
                      </p>
                    )}
                    {debt.status === "paused" && (
                      <p className="mt-3 rounded-xl bg-amber-50 p-2 text-xs text-amber-800">
                        {debt.linkedCommitmentId
                          ? "Bank verification is paused; your independently created payment remains planned. Reconnect, then review this debt to resume."
                          : "Bank tracking is paused and no payment is reserved. Reconnect, then review this debt to resume—or stop tracking it."}
                      </p>
                    )}
                  </article>
                );
              })}
            {debts.length === 0 && (
              <div className="rounded-[22px] border border-dashed border-ink/15 p-5 text-center">
                <strong className="block text-sm">No debts tracked</strong>
                <p className="mt-1 text-xs leading-5 text-muted">
                  Add a card or loan only if you want payment and payoff
                  visibility.
                </p>
              </div>
            )}
          </div>
        </section>

        <section className="mt-7" aria-labelledby="savings-goals-heading">
          <div className="mb-3 flex items-end justify-between">
            <div>
              <p className="eyebrow">Protected progress</p>
              <h2 id="savings-goals-heading" className="text-xl font-bold">
                Savings goals
              </h2>
            </div>
            <SavingsGoalEditor compact />
          </div>
          <div className="space-y-3">
            {savingsGoals
              .filter((goal) => goal.status !== "archived")
              .map((goal) => {
                const confirmed = Number(goal.progress.confirmed.minor) / 100;
                const target = goal.targetAmount
                  ? Number(goal.targetAmount.minor) / 100
                  : 0;
                const percent =
                  target > 0 ? Math.min(100, (confirmed / target) * 100) : 0;
                const occurrence = occurrences.find(
                  (item) =>
                    item.savingsGoalId === goal.id &&
                    !["verified", "skipped"].includes(item.state),
                );
                return (
                  <article
                    key={goal.id}
                    className="rounded-[22px] border border-rule bg-white p-4 shadow-card"
                  >
                    <div className="flex items-start gap-3">
                      <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-citron/70 text-ink">
                        <PiggyBank className="size-5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <h3 className="text-sm font-bold">{goal.name}</h3>
                            <p className="text-xs text-muted">
                              {goal.destination
                                ? `${goal.destination.name} · ${goal.progress.protected ? "protected" : "needs protection"}`
                                : goal.status === "paused"
                                  ? "Bank removed · choose a new savings account"
                                  : "Choose where this goal will be kept"}
                            </p>
                          </div>
                          <SavingsGoalEditor goal={goal} compact />
                        </div>
                        <div className="mt-3 flex items-end justify-between gap-3">
                          <strong className="text-xl tabular-nums">
                            {money(confirmed)}
                          </strong>
                          <span className="text-xs text-muted">
                            {target > 0
                              ? `of ${money(target)}`
                              : "No total target"}
                          </span>
                        </div>
                        <div className="mt-2 h-2 overflow-hidden rounded-full bg-recessed">
                          <div
                            className="h-full rounded-full bg-cobalt"
                            style={{ width: `${percent}%` }}
                          />
                        </div>
                        <p className="mt-2 text-xs leading-5 text-muted">
                          {!goal.destination && goal.status === "paused"
                            ? "Previously bank confirmed · tracking paused"
                            : goal.progress.assurance === "bank_confirmed"
                              ? "Bank confirmed"
                              : goal.progress.assurance === "user_confirmed"
                                ? "Confirmed by you"
                                : goal.progress.assurance === "stale"
                                  ? "Last progress saved · bank refresh needed"
                                  : "No progress confirmed yet"}
                          {occurrence
                            ? ` · ${money(Number(occurrence.remainingAmount?.minor ?? "0") / 100)} planned before ${formatPlanDate(occurrence.expectedOn)}`
                            : " · no contribution reserved now"}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <SavingsBalanceEditor goal={goal} />
                          {occurrence?.evidence.some(
                            (entry) => entry.matchState === "proposed",
                          ) && (
                            <Button asChild size="sm">
                              <Link
                                to={`/activity?transaction=${occurrence.evidence.find((entry) => entry.matchState === "proposed")!.transactionId}`}
                              >
                                Review possible transfer
                              </Link>
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            {!savingsGoals.some((goal) => goal.status !== "archived") && (
              <div className="rounded-[22px] border border-dashed border-rule bg-white p-5 text-center">
                <PiggyBank className="mx-auto size-6 text-cobalt" />
                <strong className="mt-2 block text-sm">
                  No savings goal yet
                </strong>
                <p className="mt-1 text-xs leading-5 text-muted">
                  Goals are optional. Add one when you want progress kept
                  separate from spendable cash.
                </p>
              </div>
            )}
          </div>
        </section>

        <section className="mt-7 rounded-[24px] bg-ink p-5 text-white">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-[.12em] text-citron">
                Unallocated cash
              </p>
              <h2 className="mt-1 text-2xl font-bold tracking-[-0.035em]">
                {available < 0
                  ? "Paused for shortfall"
                  : money(unallocatedCash)}
              </h2>
            </div>
            <ShoppingBag className="size-6 text-citron" strokeWidth={1.8} />
          </div>
          <p className="mt-5 text-xs leading-5 text-white/65">
            This is the server-calculated amount left after commitments, planned
            goal contributions, and your cash cushion. Budgefi is not setting a
            category cap here.
          </p>
        </section>
      </main>
    </MobileShell>
  );
}

function formatPlanDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}
function statusLabel(value: string) {
  return value === "verified"
    ? "Paid · verified"
    : value === "pending"
      ? "Recorded · awaiting balance refresh"
      : value === "partial"
        ? "Partially paid"
        : value === "needs_review"
          ? "Suggested payment · needs review"
          : value === "overdue"
            ? "Past expected date"
            : "Still expected";
}

function OccurrenceEvidenceButton({
  name,
  evidence,
  suggested = false,
}: {
  name: string;
  evidence: PlanOccurrence["evidence"];
  suggested?: boolean;
}) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" className="h-11 px-2.5 text-[11px] text-pencil">
          <span className="sr-only">
            {suggested
              ? `Review ${name} payment suggestions`
              : `View ${name} payment proof`}
          </span>
          <ReceiptText className="mr-1 size-3.5" />
          <span aria-hidden="true">
            {suggested
              ? `Review ${evidence.length} suggestion${evidence.length === 1 ? "" : "s"}`
              : "Proof"}
          </span>
        </Button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        className="mx-auto max-w-[430px] rounded-t-[28px]"
      >
        <SheetHeader>
          <SheetTitle>
            {suggested ? `${name} suggested payment` : `${name} payment proof`}
          </SheetTitle>
          <SheetDescription>
            {suggested
              ? "Budgefi found a possible match. Open it to confirm that it is the right payment or reject it."
              : "These confirmed transactions explain the amount Budgefi marked as recorded or paid."}
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-2">
          {evidence.map((item) => (
            <Link
              key={`${item.transactionId}:${item.amountApplied.minor}`}
              to={`/activity?transaction=${item.transactionId}`}
              className="flex min-h-[68px] items-center gap-3 rounded-2xl border border-rule bg-white p-3"
            >
              <ReceiptText className="size-5 shrink-0 text-cobalt" />
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-sm">
                  {item.merchant}
                </strong>
                <span className="block text-xs text-muted">
                  {item.accountName} · {formatPlanDate(item.occurredOn)} ·{" "}
                  {item.status}
                </span>
              </span>
              <strong className="text-sm tabular-nums">
                {money(Number(BigInt(item.amountApplied.minor)) / 100)}
              </strong>
            </Link>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function OccurrenceSkipButton({
  occurrence,
  name,
  onSkip,
}: {
  occurrence: PlanOccurrence;
  name: string;
  onSkip: (item: PlanOccurrence) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" className="h-11 px-2.5 text-[11px] text-muted">
          Skip
        </Button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        className="mx-auto max-w-[430px] rounded-t-[28px]"
      >
        <SheetHeader>
          <SheetTitle>Skip this payment?</SheetTitle>
          <SheetDescription>
            {name} on {formatPlanDate(occurrence.expectedOn)} will no longer
            reduce available cash. The recurring commitment stays active.
          </SheetDescription>
        </SheetHeader>
        <Button
          className="mt-5 w-full"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            const okay = await onSkip(occurrence);
            setSaving(false);
            if (okay) setOpen(false);
          }}
        >
          {saving ? "Skipping…" : "Skip this payment"}
        </Button>
        <Button
          className="mt-2 w-full"
          variant="ghost"
          disabled={saving}
          onClick={() => setOpen(false)}
        >
          Keep it in the plan
        </Button>
      </SheetContent>
    </Sheet>
  );
}
