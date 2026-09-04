import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  CalendarRange,
  ChevronRight,
  CloudOff,
  HelpCircle,
  Info,
  RefreshCw,
} from "lucide-react";
import type {
  PayCycleDetailResponse,
  PayCycleListResponse,
} from "@budgefi/contracts";
import { MobileShell } from "@/components/layout";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { api } from "@/lib/api";
import {
  readPayCycleDetailCache,
  readPayCycleListCache,
  writePayCycleDetailCache,
  writePayCycleListCache,
} from "@/lib/pay-cycle-cache";
import { money } from "@/lib/utils";

export function PayCyclesPage() {
  const [data, setData] = useState<PayCycleListResponse | null>(null);
  const dataRef = useRef<PayCycleListResponse | null>(null);
  const confirmedAtRef = useRef<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [pagingCycles, setPagingCycles] = useState(false);
  const [pagingPlanning, setPagingPlanning] = useState(false);
  const [pageError, setPageError] = useState<"cycles" | "planning" | null>(
    null,
  );
  const [requestedOlderCycles, setRequestedOlderCycles] = useState(false);
  const [requestedOlderPlanning, setRequestedOlderPlanning] = useState(false);
  const load = useCallback(
    async (kind: "initial" | "cycles" | "planning" = "initial") => {
      if (kind === "initial") setLoading(true);
      if (kind === "cycles") setPagingCycles(true);
      if (kind === "planning") setPagingPlanning(true);
      if (kind === "cycles") setRequestedOlderCycles(true);
      if (kind === "planning") setRequestedOlderPlanning(true);
      setError(false);
      setPageError(null);
      try {
        const page = await api.payCycles({
          limit: kind === "planning" ? 1 : 12,
          planningLimit: kind === "cycles" ? 1 : 12,
          ...(kind === "cycles" && dataRef.current?.nextCursor
            ? { cursor: dataRef.current.nextCursor }
            : {}),
          ...(kind === "planning" && dataRef.current?.nextPlanningCursor
            ? { planningCursor: dataRef.current.nextPlanningCursor }
            : {}),
        });
        const current = dataRef.current;
        const merged =
          kind === "initial" || !current
            ? page
            : {
                ...page,
                items: mergeById(current.items, page.items),
                planningPeriods: mergeById(
                  current.planningPeriods,
                  page.planningPeriods,
                ),
                nextCursor:
                  kind === "cycles" ? page.nextCursor : current.nextCursor,
                nextPlanningCursor:
                  kind === "planning"
                    ? page.nextPlanningCursor
                    : current.nextPlanningCursor,
                hasVerifiedPayday:
                  current.hasVerifiedPayday || page.hasVerifiedPayday,
              };
        dataRef.current = merged;
        setData(merged);
        setSavedAt(null);
        const confirmedAt = new Date().toISOString();
        confirmedAtRef.current = confirmedAt;
        void writePayCycleListCache(merged, confirmedAt).catch(() => undefined);
      } catch {
        if (kind !== "initial") setPageError(kind);
        else if (dataRef.current)
          setSavedAt(confirmedAtRef.current ?? new Date().toISOString());
        else {
          const cached = await readPayCycleListCache();
          if (cached) {
            setData(cached.data);
            dataRef.current = cached.data;
            confirmedAtRef.current = cached.confirmedAt;
            setSavedAt(cached.confirmedAt);
          } else setError(true);
        }
      } finally {
        if (kind === "initial") setLoading(false);
        if (kind === "cycles") setPagingCycles(false);
        if (kind === "planning") setPagingPlanning(false);
      }
    },
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <MobileShell>
      <main className="px-4 pb-8 pt-5">
        <p className="eyebrow">Verified history</p>
        <h1 className="text-[31px] font-bold tracking-[-0.04em]">Pay cycles</h1>
        <p className="mt-1 text-sm leading-5 text-muted">
          What actually happened between confirmed reliable paydays.
        </p>
        <TotalsHelp />
        {savedAt && (
          <SavedReportNotice confirmedAt={savedAt} onRetry={() => load()} />
        )}
        {loading ? (
          <CycleSkeleton />
        ) : error ? (
          <Failure onRetry={() => load()} />
        ) : !data?.hasVerifiedPayday ? (
          <Empty />
        ) : (
          <div className="mt-6 space-y-3">
            {data.items.map((cycle) => (
              <Link
                key={cycle.id}
                to={`/pay-cycles/${cycle.id}`}
                className="block rounded-[22px] border border-rule bg-white p-4 shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil"
              >
                <div className="flex items-start gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-recessed text-cobalt">
                    <CalendarRange className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block text-sm">
                      {cycle.status === "open"
                        ? "Current cycle"
                        : `${formatDate(cycle.startOn)}–${formatDate(addDays(cycle.endOn!, -1))}`}
                    </strong>
                    <span className="block text-xs text-muted">
                      {cycle.status === "open"
                        ? `${formatDate(cycle.startOn)} to today`
                        : "Completed between verified paydays"}
                    </span>
                  </span>
                  <ChevronRight className="mt-1 size-4 text-muted" />
                </div>
                {cycle.report && (
                  <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3 border-t border-rule pt-3 text-xs">
                    <Metric label="Earned" value={cycle.report.earned.minor} />
                    <Metric label="Spent" value={cycle.report.spent.minor} />
                    <Metric label="Saved" value={cycle.report.saved.minor} />
                    <span>
                      <span className="block text-muted">Commitments</span>
                      <strong className="mt-1 block text-[11px] leading-4 tabular-nums">
                        {formatMoney(cycle.report.commitmentsPaid.minor)} paid ·{" "}
                        {formatMoney(cycle.report.commitmentsRemaining.minor)}{" "}
                        left
                      </strong>
                    </span>
                  </div>
                )}
                {cycle.report?.assurance === "incomplete" && (
                  <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    Some account coverage is incomplete. Cash-flow totals are
                    shown, but balance change is not confirmed.
                  </p>
                )}
                {cycle.updatedAfterBankCorrection && (
                  <p className="mt-2 text-[11px] font-medium text-cobalt">
                    Updated after bank data changed
                  </p>
                )}
                {!cycle.updatedAfterBankCorrection &&
                  cycle.updatedAfterEvidenceChange && (
                    <p className="mt-2 text-[11px] font-medium text-cobalt">
                      Updated after verified activity changed
                    </p>
                  )}
              </Link>
            ))}
            {data.nextCursor && (
              <LoadOlder
                loading={pagingCycles}
                failed={pageError === "cycles"}
                label="Load older cycles"
                onClick={() => load("cycles")}
              />
            )}
            {requestedOlderCycles && !data.nextCursor && (
              <p className="pt-2 text-center text-xs text-muted">
                Beginning of verified pay-cycle history
              </p>
            )}
          </div>
        )}
        {!loading && !error && data && data.planningPeriods.length > 0 && (
          <section className="mt-8">
            <p className="eyebrow">Planning history</p>
            <h2 className="text-xl font-bold">Cash windows</h2>
            <p className="mt-1 text-xs leading-5 text-muted">
              Expected and fallback windows are preserved here for context. They
              are not completed pay cycles.
            </p>
            <div className="mt-3 divide-y divide-rule rounded-[22px] border border-rule bg-white px-4">
              {data.planningPeriods.map((period) => (
                <div
                  key={period.id}
                  className="flex min-h-[62px] items-center gap-3 text-sm"
                >
                  <span className="flex-1">
                    <strong className="block">
                      Through {formatDate(period.throughOn)}
                    </strong>
                    <span className="text-xs text-muted">
                      {period.basis === "expected_income"
                        ? "Expected-income window"
                        : "Fallback window"}
                    </span>
                  </span>
                  <span className="rounded-full bg-recessed px-2.5 py-1 text-[11px] font-semibold capitalize">
                    {planningStateLabel(period.state)}
                  </span>
                </div>
              ))}
            </div>
            {data.nextPlanningCursor && (
              <LoadOlder
                loading={pagingPlanning}
                failed={pageError === "planning"}
                label="Load older cash windows"
                onClick={() => load("planning")}
              />
            )}
            {requestedOlderPlanning && !data.nextPlanningCursor && (
              <p className="pt-3 text-center text-xs text-muted">
                No older cash windows
              </p>
            )}
          </section>
        )}
      </main>
    </MobileShell>
  );
}

export function PayCycleDetailPage() {
  const { cycleId } = useParams();
  const [data, setData] = useState<PayCycleDetailResponse | null>(null);
  const dataRef = useRef<PayCycleDetailResponse | null>(null);
  const confirmedAtRef = useRef<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!cycleId) return;
    setLoading(true);
    setError(false);
    try {
      const response = await api.payCycle(cycleId);
      dataRef.current = response;
      setData(response);
      setSavedAt(null);
      const confirmedAt = new Date().toISOString();
      confirmedAtRef.current = confirmedAt;
      void writePayCycleDetailCache(cycleId, response, confirmedAt).catch(
        () => undefined,
      );
    } catch {
      if (dataRef.current)
        setSavedAt(confirmedAtRef.current ?? new Date().toISOString());
      else {
        const cached = await readPayCycleDetailCache(cycleId);
        if (cached) {
          setData(cached.data);
          dataRef.current = cached.data;
          confirmedAtRef.current = cached.confirmedAt;
          setSavedAt(cached.confirmedAt);
        } else setError(true);
      }
    } finally {
      setLoading(false);
    }
  }, [cycleId]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <MobileShell>
      <main className="px-4 pb-8 pt-5">
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
          <Link to="/pay-cycles">
            <ArrowLeft className="size-4" />
            Pay cycles
          </Link>
        </Button>
        {savedAt && <SavedReportNotice confirmedAt={savedAt} onRetry={load} />}
        {loading ? (
          <CycleSkeleton />
        ) : error || !data ? (
          <Failure onRetry={load} />
        ) : (
          <CycleDetail data={data} />
        )}
      </main>
    </MobileShell>
  );
}

function CycleDetail({ data }: { data: PayCycleDetailResponse }) {
  const { cycle } = data;
  const report = cycle.report;
  if (!report) return <Empty />;
  const through = cycle.endOn ? formatDate(addDays(cycle.endOn, -1)) : "Today";
  const activityThrough = cycle.endOn
    ? addDays(cycle.endOn, -1)
    : todayInZone(cycle.timezone);
  return (
    <>
      <p className="eyebrow">
        {cycle.status === "open" ? "Current cycle" : "Completed cycle"}
      </p>
      <h1 className="text-[29px] font-bold tracking-[-0.04em]">
        {formatDate(cycle.startOn)} – {through}
      </h1>
      <p className="mt-1 text-sm text-muted">
        Income received, verified savings, posted spendable-account spending,
        and separately labeled pending charges in this payday-to-payday window.
      </p>
      <TotalsHelp />
      {(report.assurance === "incomplete" ||
        report.assurance === "user_confirmed" ||
        cycle.updatedAfterBankCorrection ||
        cycle.updatedAfterEvidenceChange) && (
        <div className="mt-4 rounded-2xl border border-amber-500/20 bg-amber-50 p-3 text-xs leading-5 text-amber-950">
          <Info className="mr-2 inline size-4" />
          {cycle.updatedAfterBankCorrection
            ? "This cycle was updated after bank data changed. Earlier calculations remain in the audit history. "
            : cycle.updatedAfterEvidenceChange
              ? "This cycle was updated after verified activity changed. Earlier calculations remain in the audit history. "
              : ""}
          {report.assurance === "user_confirmed"
            ? "Some balances or activity were confirmed by you. "
            : ""}
          {report.assurance !== "user_confirmed"
            ? (report.coverageReason ?? "")
            : ""}
        </div>
      )}
      <section className="mt-5 rounded-[24px] bg-ink p-5 text-white">
        <p className="text-xs font-semibold uppercase tracking-[.12em] text-citron">
          Cycle totals
        </p>
        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-5">
          <BigMetric label="Earned" value={report.earned.minor} />
          <BigMetric label="Spent" value={report.spent.minor} />
          <BigMetric label="Verified saved" value={report.saved.minor} />
          <BigMetric label="Pending" value={report.pending.minor} />
        </div>
      </section>
      <section className="mt-6">
        <p className="eyebrow">Commitments</p>
        <h2 className="text-xl font-bold">Paid and remaining</h2>
        <div className="mt-3 rounded-[22px] border border-rule bg-white p-4">
          <div className="grid grid-cols-2 gap-3">
            <Metric label="Paid" value={report.commitmentsPaid.minor} />
            <Metric
              label="Remaining"
              value={report.commitmentsRemaining.minor}
            />
          </div>
          <p className="mt-3 text-xs leading-5 text-muted">
            Commitments explain spending; they are not added to the spent total
            again.
          </p>
          {report.breakdown.commitments.map((item) => (
            <Link
              key={item.id}
              to={`/activity?from=${cycle.startOn}&to=${activityThrough}`}
              className="mt-3 flex items-center border-t border-rule pt-3 text-sm"
            >
              <span className="flex-1">
                <strong className="block">{item.name}</strong>
                <span className="text-xs text-muted">
                  {formatMoney(item.paid.minor)} of{" "}
                  {formatMoney(item.expected.minor)} verified
                </span>
              </span>
              <ChevronRight className="size-4 text-muted" />
            </Link>
          ))}
        </div>
      </section>
      {report.breakdown.categories.length > 0 && (
        <Breakdown title="Top spending" items={report.breakdown.categories} />
      )}{" "}
      {report.breakdown.incomeSources.length > 0 && (
        <Breakdown
          title="Income received"
          items={report.breakdown.incomeSources}
        />
      )}{" "}
      {report.breakdown.savings.length > 0 && (
        <section className="mt-6">
          <p className="eyebrow">Savings evidence</p>
          <h2 className="text-xl font-bold">Verified movements</h2>
          <div className="mt-3 divide-y divide-rule rounded-[22px] border border-rule bg-white px-4">
            {report.breakdown.savings.map((item) => (
              <div
                key={item.id}
                className="flex min-h-[58px] items-center text-sm"
              >
                <span className="flex-1">
                  <strong className="block">{item.name}</strong>
                  <span className="text-xs text-muted">
                    {item.kind === "contribution" ? "Added" : "Withdrawn"} ·{" "}
                    {formatDate(item.effectiveOn)}
                  </span>
                </span>
                <strong>{formatMoney(item.amount.minor)}</strong>
              </div>
            ))}
          </div>
        </section>
      )}
      <Button asChild variant="outline" className="mt-6 w-full">
        <Link to={`/activity?from=${cycle.startOn}&to=${activityThrough}`}>
          View transactions in this cycle
        </Link>
      </Button>
      {data.revisions.length > 1 && (
        <p className="mt-4 text-center text-xs text-muted">
          {data.revisions.length} preserved calculations · latest shown
        </p>
      )}
    </>
  );
}
function Breakdown({
  title,
  items,
}: {
  title: string;
  items: Array<{ name: string; amount: { minor: string } }>;
}) {
  return (
    <section className="mt-6">
      <p className="eyebrow">Breakdown</p>
      <h2 className="text-xl font-bold">{title}</h2>
      <div className="mt-3 divide-y divide-rule rounded-[22px] border border-rule bg-white px-4">
        {items.slice(0, 6).map((item) => (
          <div
            key={item.name}
            className="flex min-h-[54px] items-center text-sm"
          >
            <span className="flex-1 capitalize">
              {item.name.replace(/_/g, " ")}
            </span>
            <strong>{formatMoney(item.amount.minor)}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}
function TotalsHelp() {
  const definitions = [
    [
      "Earned",
      "Posted income received in eligible deposit accounts during this cycle. Protected income appears here but stays outside spendable cash. Transfers and refunds are excluded.",
    ],
    [
      "Spent",
      "Posted purchases and bills. Transfers, verified savings, and debt-payment duplicates are excluded.",
    ],
    [
      "Saved",
      "Only contributions Budgefi can verify or that you explicitly confirmed.",
    ],
    ["Pending", "Unsettled charges shown separately and excluded from Spent."],
    [
      "Commitments",
      "Expected bills overlap Spent when paid; Budgefi never adds them twice.",
    ],
  ];
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 mt-2 min-h-11 text-cobalt"
        >
          <HelpCircle className="size-4" />
          How totals work
        </Button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[85dvh] max-w-[430px] overflow-y-auto rounded-t-[28px]"
      >
        <SheetHeader>
          <SheetTitle>How pay-cycle totals work</SheetTitle>
          <SheetDescription>
            Cash activity is counted once, using confirmed evidence inside the
            displayed dates.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-5 divide-y divide-rule">
          {definitions.map(([title, detail]) => (
            <div key={title} className="py-3">
              <strong className="text-sm">{title}</strong>
              <p className="mt-1 text-xs leading-5 text-muted">{detail}</p>
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
function SavedReportNotice({
  confirmedAt,
  onRetry,
}: {
  confirmedAt: string;
  onRetry: () => void | Promise<void>;
}) {
  return (
    <div className="mt-4 flex items-center gap-3 rounded-2xl border border-rule bg-white px-3 py-3">
      <CloudOff className="size-5 shrink-0 text-muted" />
      <span className="min-w-0 flex-1">
        <strong className="block text-xs">
          Saved report · updated {formatTimestamp(confirmedAt)}
        </strong>
        <span className="block text-[11px] text-muted">
          Read-only until Budgefi reconnects.
        </span>
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void onRetry()}
        className="shrink-0"
      >
        Connect to refresh
      </Button>
    </div>
  );
}
function LoadOlder({
  loading,
  failed,
  label,
  onClick,
}: {
  loading: boolean;
  failed: boolean;
  label: string;
  onClick: () => void | Promise<void>;
}) {
  return (
    <div className="mt-3 text-center">
      {failed && (
        <p className="mb-2 text-xs text-amber-900">
          Older history did not load. Your saved rows are unchanged.
        </p>
      )}
      <Button
        variant="outline"
        onClick={() => void onClick()}
        disabled={loading}
        className="min-h-11 w-full"
      >
        {loading ? "Loading…" : failed ? "Try loading again" : label}
      </Button>
    </div>
  );
}
function Empty() {
  return (
    <div className="mt-8 rounded-[24px] border border-rule bg-white p-6 text-center">
      <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-recessed text-cobalt">
        <CalendarRange className="size-6" />
      </span>
      <h2 className="mt-4 text-lg font-bold">No verified pay cycle yet</h2>
      <p className="mt-1 text-sm leading-5 text-muted">
        A cycle begins only after Budgefi confirms a regular income deposit and
        a later balance. Expected dates never create history.
      </p>
      <div className="mt-5 grid gap-2">
        <Button asChild>
          <Link to="/plan">Review expected income</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/manual">Record a deposit</Link>
        </Button>
      </div>
    </div>
  );
}
function Failure({ onRetry }: { onRetry: () => void | Promise<void> }) {
  return (
    <div className="mt-8 rounded-[24px] border border-rule bg-white p-6 text-center">
      <CloudOff className="mx-auto size-7 text-muted" />
      <h2 className="mt-3 font-bold">Pay-cycle history is unavailable</h2>
      <p className="mt-1 text-sm text-muted">
        Your existing plan is unchanged. Check your connection and try again.
      </p>
      <Button onClick={() => void onRetry()} className="mt-4">
        <RefreshCw className="size-4" />
        Try again
      </Button>
    </div>
  );
}
function CycleSkeleton() {
  return (
    <div className="mt-6 space-y-3" aria-label="Loading pay cycles">
      {[0, 1].map((n) => (
        <div
          key={n}
          className="h-28 animate-pulse rounded-[22px] border border-rule bg-white/60"
        />
      ))}
    </div>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="block text-muted">{label}</span>
      <strong className="mt-1 block tabular-nums">{formatMoney(value)}</strong>
    </span>
  );
}
function BigMetric({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="block text-xs text-white/65">{label}</span>
      <strong className="mt-1 block text-xl tabular-nums">
        {formatMoney(value)}
      </strong>
    </span>
  );
}
function formatMoney(minor: string) {
  return money(Number(BigInt(minor)) / 100);
}
function formatDate(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}
function addDays(value: string, days: number) {
  const d = new Date(`${value}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function todayInZone(timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (kind: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === kind)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}
function planningStateLabel(state: string) {
  if (state === "active") return "Current";
  if (state === "replaced") return "Updated";
  if (state === "elapsed_verified") return "Payday confirmed";
  return "Ended";
}
function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !seen.has(item.id))];
}
function formatTimestamp(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
