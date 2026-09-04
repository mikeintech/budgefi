import {
  AlertTriangle,
  CalendarClock,
  Cloud,
  FileCheck2,
  ReceiptText,
  ShieldCheck,
} from "lucide-react";
import { MobileShell } from "@/components/layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppState, type ActivityEvent } from "@/state/app-state";
import { money } from "@/lib/utils";
import { TransactionFeed } from "@/components/transaction-feed";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useEffect } from "react";
import { scheduleLabel } from "@/lib/schedule-labels";

const iconMap = {
  evidence: ReceiptText,
  plan: FileCheck2,
  source: Cloud,
  household: ShieldCheck,
} as const;

function Timeline({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0)
    return (
      <div className="rounded-[22px] border border-dashed border-rule bg-white p-6 text-center">
        <strong className="block text-sm">No ledger activity yet</strong>
        <p className="mt-1 text-xs leading-5 text-muted">
          Saved balances, commitments, connection changes, and imported
          transactions will appear here.
        </p>
      </div>
    );
  return (
    <ol className="relative ml-5 border-l border-ink/15 pl-6">
      {events.map((event, index) => {
        const Icon = iconMap[event.type];
        return (
          <li key={event.id} className="relative pb-7 last:pb-1">
            <span className="absolute -left-[39px] top-0 grid size-7 place-items-center rounded-full border-4 border-paper bg-cobalt text-white">
              <Icon className="size-3.5" strokeWidth={2} />
            </span>
            <div className="-mt-0.5">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-semibold">{event.title}</p>
                <time className="shrink-0 text-[11px] font-medium text-muted">
                  {event.time}
                </time>
              </div>
              <p className="mt-1 text-xs leading-5 text-muted">
                {event.detail}
              </p>
              {index === 0 && (
                <span className="mt-2 inline-flex rounded-full bg-cobalt/8 px-2 py-1 text-[10px] font-bold uppercase tracking-[.08em] text-cobalt">
                  Latest
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function ActivityPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const {
    events,
    occurrences,
    authoritativeProjection,
    transactions,
    backendStatus,
    accounts,
    savingsGoals,
    commitments,
    incomeSchedules,
    reloadBackend,
  } = useAppState();
  const highlightedOccurrence = searchParams.get("occurrence");
  useEffect(() => {
    if (!highlightedOccurrence) return;
    requestAnimationFrame(() =>
      document
        .getElementById(`occurrence-${highlightedOccurrence}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" }),
    );
  }, [highlightedOccurrence]);
  const today = authoritativeProjection.horizonStart;
  const upcoming = occurrences
    .filter(
      (item) =>
        (["commitment", "savings", "income"].includes(item.kind) &&
          !["verified", "skipped"].includes(item.state)) ||
        item.id === highlightedOccurrence,
    )
    .sort(
      (left, right) =>
        left.expectedOn.localeCompare(right.expectedOn) ||
        left.name.localeCompare(right.name),
    );
  return (
    <MobileShell>
      <main className="px-4 pb-8 pt-5">
        <p className="eyebrow">Proof trail</p>
        <h1 className="text-[31px] font-bold tracking-[-0.04em]">Activity</h1>
        <p className="mt-1 text-sm leading-5 text-muted">
          See money activity, upcoming commitments, and the record of what
          changed.
        </p>

        <Tabs
          key={highlightedOccurrence ? "upcoming" : "transactions"}
          defaultValue={highlightedOccurrence ? "upcoming" : "transactions"}
          className="mt-5"
        >
          <TabsList>
            <TabsTrigger value="transactions">Transactions</TabsTrigger>
            <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
            <TabsTrigger value="changes">Changes</TabsTrigger>
          </TabsList>
          <TabsContent value="transactions">
            <div className="mb-3 flex justify-end">
              <Link
                to="/category-rules"
                className="inline-flex min-h-11 items-center text-sm font-bold text-pencil"
              >
                Manage category rules
              </Link>
            </div>
            <TransactionFeed
              fallback={transactions}
              offline={backendStatus === "cached"}
              accounts={accounts}
              occurrences={occurrences}
              savingsGoals={savingsGoals}
              today={authoritativeProjection.horizonStart}
              initialTransactionId={searchParams.get("transaction")}
              initialFrom={searchParams.get("from")}
              initialTo={searchParams.get("to")}
              onInitialTransactionOpened={() =>
                navigate("/activity", { replace: true })
              }
              onCanonicalChange={reloadBackend}
            />
          </TabsContent>
          <TabsContent value="upcoming">
            <div className="divide-y divide-rule overflow-hidden rounded-[22px] border border-rule bg-white">
              {upcoming.map((item) => {
                const overdue =
                  item.state === "overdue" || item.expectedOn < today;
                const outside =
                  item.expectedOn > authoritativeProjection.horizonEnd;
                const Icon = overdue ? AlertTriangle : CalendarClock;
                const cadence =
                  item.kind === "commitment"
                    ? commitments.find((rule) => rule.id === item.commitmentId)
                        ?.recurrence
                    : item.kind === "savings"
                      ? savingsGoals.find(
                          (goal) => goal.id === item.savingsGoalId,
                        )?.schedule
                      : incomeSchedules.find(
                          (schedule) => schedule.id === item.incomeScheduleId,
                        )?.frequency;
                return (
                  <div
                    key={item.id}
                    id={`occurrence-${item.id}`}
                    className={`flex min-h-[78px] items-center gap-3 px-4 py-3 transition ${highlightedOccurrence === item.id ? "bg-cobalt/5 ring-2 ring-inset ring-cobalt" : ""}`}
                  >
                    <span
                      className={`grid size-10 shrink-0 place-items-center rounded-2xl ${overdue ? "bg-coral/10 text-coral" : "bg-paper-deep text-cobalt"}`}
                    >
                      <Icon className="size-5" strokeWidth={1.8} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-sm">
                        {item.name}
                      </strong>
                      <span
                        className={`block text-xs ${overdue ? "font-semibold text-coral" : "text-muted"}`}
                      >
                        {["verified", "skipped"].includes(item.state)
                          ? item.state === "verified"
                            ? `Verified · ${formatDate(item.expectedOn)}`
                            : `Skipped · ${formatDate(item.expectedOn)}`
                          : item.kind === "income"
                            ? item.state === "pending"
                              ? "Deposit seen · awaiting a current balance"
                              : item.state === "partial"
                                ? "Part of this income was recorded"
                                : item.state === "needs_review"
                                  ? "Possible deposit needs review"
                                  : overdue
                                    ? `Expected income not verified · ${formatDate(item.expectedOn)}`
                                    : `Expected income · ${formatDate(item.expectedOn)}${outside ? " · outside current plan" : ""}`
                            : item.kind === "savings"
                              ? item.state === "pending"
                                ? "Contribution seen · awaiting balance confirmation"
                                : item.state === "partial"
                                  ? "Part of the planned contribution added"
                                  : item.state === "needs_review"
                                    ? "Possible contribution needs review"
                                    : `Planned contribution · ${formatDate(item.expectedOn)}${outside ? " · outside current plan" : ""}`
                              : overdue
                                ? `Past due · ${formatDate(item.expectedOn)}`
                                : item.state === "pending"
                                  ? "Paid · awaiting balance refresh"
                                  : item.state === "partial"
                                    ? "Partially paid"
                                    : item.state === "needs_review"
                                      ? "Possible payment needs review"
                                      : item.expectedOn === today
                                        ? "Due today"
                                        : `${formatDate(item.expectedOn)}${outside ? " · outside current plan" : ""}`}
                      </span>
                      <span className="block text-[11px] text-muted">
                        {scheduleLabel(cadence)} ·{" "}
                        {sourceLabel(item.provenance)}
                      </span>
                    </span>
                    <strong className="shrink-0 text-sm tabular-nums">
                      {item.expectedAmount
                        ? money(
                            Number(BigInt(item.remainingAmount?.minor ?? "0")) /
                              100,
                          )
                        : item.kind === "income"
                          ? "Any amount"
                          : money(0)}
                    </strong>
                  </div>
                );
              })}
              {upcoming.length === 0 && (
                <div className="p-6 text-center">
                  <CalendarClock className="mx-auto size-6 text-cobalt" />
                  <strong className="mt-2 block text-sm">
                    Nothing upcoming
                  </strong>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    Add expected income, a commitment, or a savings goal and it
                    will appear here.
                  </p>
                </div>
              )}
            </div>
          </TabsContent>
          <TabsContent value="changes">
            <Timeline events={events} />
          </TabsContent>
        </Tabs>
      </main>
    </MobileShell>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year:
      new Date(`${value}T12:00:00Z`).getUTCFullYear() !==
      new Date().getFullYear()
        ? "numeric"
        : undefined,
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}
function sourceLabel(value: string) {
  return value === "manual"
    ? "You entered"
    : value === "plaid"
      ? "Connected data"
      : value === "csv"
        ? "Imported"
        : value === "derived"
          ? "Detected"
          : "Historical";
}
