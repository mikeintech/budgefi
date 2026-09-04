import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Filter,
  Search,
  Tag,
  WifiOff,
  X,
} from "lucide-react";
import type {
  BootstrapResponse,
  TransactionFeedResponse,
} from "@budgefi/contracts";
import { Link } from "react-router-dom";
import { api, requestId } from "@/lib/api";
import { money } from "@/lib/utils";
import { linkedOutcome } from "@/lib/transaction-copy";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  transactionCategories as categories,
  transactionCategoryLabels as label,
} from "@/lib/transaction-categories";

type Item = TransactionFeedResponse["items"][number];
type Occurrence = BootstrapResponse["plan"]["occurrences"][number];
type SavingsGoal = BootstrapResponse["plan"]["savingsGoals"][number];
export function TransactionFeed({
  fallback,
  offline,
  accounts,
  occurrences,
  savingsGoals,
  today,
  initialTransactionId,
  initialFrom,
  initialTo,
  onInitialTransactionOpened,
  onCanonicalChange,
}: {
  fallback: BootstrapResponse["transactions"];
  offline: boolean;
  accounts: BootstrapResponse["accounts"];
  occurrences: BootstrapResponse["plan"]["occurrences"];
  savingsGoals: BootstrapResponse["plan"]["savingsGoals"];
  today: string;
  initialTransactionId?: string | null;
  initialFrom?: string | null;
  initialTo?: string | null;
  onInitialTransactionOpened?: () => void;
  onCanonicalChange: () => Promise<void>;
}) {
  const cached = useMemo<Item[]>(
    () =>
      fallback.map((item) => ({
        id: item.id,
        version: item.version,
        merchant: item.merchant,
        amount: item.amount,
        occurredOn: item.occurredOn,
        status: item.status === "pending" ? "pending" : "posted",
        direction: item.direction,
        provenance: item.provenance === "sample" ? "manual" : item.provenance,
        account: {
          id: item.accountId,
          name: item.accountName,
          type: item.accountType,
          archived: item.accountArchived,
        },
        category: item.category,
        categorySource: item.categorySource,
        categoryConfidence: item.categoryConfidence,
        categoryVersion: item.categoryVersion,
        linkedOccurrence: (() => {
          const occurrence = occurrences.find((candidate) =>
            candidate.evidence.some(
              (evidence) => evidence.transactionId === item.id,
            ),
          );
          const evidence = occurrence?.evidence.find(
            (candidate) => candidate.transactionId === item.id,
          );
          return occurrence && evidence
            ? {
                id: occurrence.id,
                name: occurrence.name,
                state: occurrence.state,
                matchState: evidence.matchState,
                matchId: evidence.matchId,
                matchVersion: evidence.matchVersion,
              }
            : null;
        })(),
      })),
    [fallback, occurrences],
  );
  const [items, setItems] = useState<Item[]>(cached),
    [historicalAccounts, setHistoricalAccounts] = useState<
      TransactionFeedResponse["accounts"]
    >(
      cached.map((item) => ({
        id: item.account.id,
        name: item.account.name,
        archived: item.account.archived,
      })),
    ),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(!offline),
    [paging, setPaging] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [draftSearch, setDraftSearch] = useState(""),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState(""),
    [direction, setDirection] = useState(""),
    [status, setStatus] = useState(""),
    [accountId, setAccountId] = useState(""),
    [from, setFrom] = useState(initialFrom ?? ""),
    [to, setTo] = useState(initialTo ?? "");
  const [filtersOpen, setFiltersOpen] = useState(false),
    [selected, setSelected] = useState<Item | null>(null),
    [showingOlderWindow, setShowingOlderWindow] = useState(false),
    [failedCursor, setFailedCursor] = useState<string | null | undefined>();
  const requestSequence = useRef(0);
  const load = async (next?: string | null) => {
    if (offline) return;
    const sequence = ++requestSequence.current;
    if (next) setPaging(true);
    else {
      setLoading(true);
      setItems([]);
      setCursor(null);
      setShowingOlderWindow(false);
    }
    setError(null);
    setFailedCursor(undefined);
    try {
      const page = await api.transactions({
        limit: 30,
        ...(initialTransactionId
          ? { transactionId: initialTransactionId }
          : {}),
        ...(next ? { cursor: next } : {}),
        ...(search ? { query: search } : {}),
        ...(category ? { category: category as any } : {}),
        ...(direction ? { direction: direction as any } : {}),
        ...(status ? { status: status as any } : {}),
        ...(accountId ? { accountId } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      });
      if (sequence !== requestSequence.current) return;
      if (next) {
        const combined = [
          ...items,
          ...page.items.filter(
            (item) => !items.some((existing) => existing.id === item.id),
          ),
        ];
        if (combined.length > 300) setShowingOlderWindow(true);
        setItems(combined.slice(-300));
      } else {
        setItems(page.items);
        setShowingOlderWindow(false);
      }
      setCursor(page.nextCursor);
      setHistoricalAccounts(page.accounts);
      setFailedCursor(undefined);
    } catch (reason) {
      if (sequence !== requestSequence.current) return;
      setFailedCursor(next ?? null);
      setError(
        reason instanceof Error
          ? reason.message
          : "Transactions could not be loaded",
      );
    } finally {
      if (sequence !== requestSequence.current) return;
      setLoading(false);
      setPaging(false);
    }
  };
  useEffect(() => {
    if (offline) {
      requestSequence.current += 1;
      setItems(cached);
      setCursor(null);
      setError(null);
      setLoading(false);
      setPaging(false);
      setShowingOlderWindow(false);
      setFailedCursor(undefined);
      setHistoricalAccounts(
        cached.map((item) => ({
          id: item.account.id,
          name: item.account.name,
          archived: item.account.archived,
        })),
      );
      return;
    }
    void load(null);
  }, [
    search,
    category,
    direction,
    status,
    accountId,
    from,
    to,
    offline,
    cached,
    initialTransactionId,
  ]);
  useEffect(() => {
    const handle = window.setTimeout(() => setSearch(draftSearch.trim()), 300);
    return () => window.clearTimeout(handle);
  }, [draftSearch]);
  const clearFilters = () => {
    setCategory("");
    setDirection("");
    setStatus("");
    setAccountId("");
    setFrom("");
    setTo("");
  };
  const active = [category, direction, status, accountId, from, to].filter(
    Boolean,
  ).length;
  const activeFilterLabels = [
    category ? label.get(category) : null,
    direction === "debit"
      ? "Money out"
      : direction === "credit"
        ? "Money in"
        : null,
    status === "posted" ? "Posted" : status === "pending" ? "Pending" : null,
    accountId
      ? (accounts.find((account) => account.id === accountId)?.name ??
        historicalAccounts.find((account) => account.id === accountId)?.name)
      : null,
    from ? `From ${formatTransactionDate(from)}` : null,
    to ? `Through ${formatTransactionDate(to)}` : null,
  ].filter((value): value is string => Boolean(value));
  const accountOptions = useMemo(() => {
    const options = new Map(
      accounts.map((account) => [account.id, account.name]),
    );
    for (const account of historicalAccounts)
      options.set(account.id, account.name);
    return [...options.entries()];
  }, [accounts, historicalAccounts]);
  const visibleItems = offline
    ? items.filter(
        (item) =>
          (!search ||
            item.merchant.toLowerCase().includes(search.toLowerCase())) &&
          (!category || item.category === category) &&
          (!direction || item.direction === direction) &&
          (!status || item.status === status) &&
          (!accountId || item.account.id === accountId) &&
          (!from || item.occurredOn >= from) &&
          (!to || item.occurredOn <= to),
      )
    : items;
  const closeDetail = () => {
    const id = selected?.id;
    setSelected(null);
    if (id)
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>(`[data-transaction-id="${id}"]`)
          ?.focus(),
      );
  };
  const openedInitial = useRef("");
  useEffect(() => {
    if (!initialTransactionId || openedInitial.current === initialTransactionId)
      return;
    const item = items.find((entry) => entry.id === initialTransactionId);
    if (item) {
      openedInitial.current = initialTransactionId;
      setSelected(item);
      onInitialTransactionOpened?.();
    }
  }, [initialTransactionId, items, onInitialTransactionOpened]);
  return (
    <>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(draftSearch.trim());
        }}
      >
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search transactions</span>
          <Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted" />
          <input
            value={draftSearch}
            onChange={(e) => setDraftSearch(e.target.value)}
            placeholder="Search transactions"
            className="h-12 w-full rounded-xl border border-rule bg-white pl-9 pr-12 text-base outline-none focus:ring-2 focus:ring-pencil"
          />
          {draftSearch && (
            <button
              type="button"
              aria-label="Clear transaction search"
              onClick={() => {
                setDraftSearch("");
                setSearch("");
              }}
              className="absolute right-0 top-0 grid size-12 place-items-center text-muted"
            >
              <X className="size-4" />
            </button>
          )}
        </label>
        <button
          type="button"
          onClick={() => setFiltersOpen(true)}
          className="relative grid size-12 shrink-0 place-items-center rounded-xl border border-rule bg-white"
          aria-label={`Filters${active ? `, ${active} active` : ""}`}
        >
          <Filter className="size-5" />
          {active > 0 && (
            <span className="absolute -right-1 -top-1 grid size-5 place-items-center rounded-full bg-cobalt text-[11px] font-bold text-white">
              {active}
            </span>
          )}
        </button>
      </form>
      {activeFilterLabels.length > 0 && (
        <div
          className="mt-3 flex flex-wrap items-center gap-2"
          aria-label="Active filters"
        >
          {activeFilterLabels.map((activeLabel, index) => (
            <span
              key={`${activeLabel}:${index}`}
              className="rounded-full bg-recessed px-3 py-2 text-sm font-medium"
            >
              {activeLabel}
            </span>
          ))}
          <button
            type="button"
            onClick={clearFilters}
            className="min-h-11 px-2 text-sm font-bold text-pencil"
          >
            Clear filters
          </button>
        </div>
      )}
      {offline && (
        <div className="mt-3 flex gap-2 rounded-xl bg-recessed p-3 text-sm">
          <WifiOff className="size-4 shrink-0" />
          <span>
            Recent saved transactions · view only. Search and filters apply only
            to these saved rows.
          </span>
        </div>
      )}
      {loading ? (
        <div className="mt-3 space-y-2" aria-label="Loading transactions">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-[76px] animate-pulse rounded-2xl bg-recessed"
            />
          ))}
        </div>
      ) : error && visibleItems.length === 0 ? null : visibleItems.length ===
        0 ? (
        <div className="mt-3 rounded-[22px] border border-dashed border-rule bg-white p-6 text-center">
          <Tag className="mx-auto size-6 text-cobalt" />
          <strong className="mt-2 block">
            {search || active
              ? "No matching transactions"
              : "No transactions yet"}
          </strong>
          <p className="mt-1 text-sm text-muted">
            {search || active
              ? "Clear your search or filters to see more."
              : "Connected activity will appear after history arrives. You can also record missing activity manually."}
          </p>
          {!search && !active && (
            <div className="mt-4 grid grid-cols-2 gap-3">
              <Button asChild variant="outline">
                <Link to="/manual">Record activity</Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/connections">Manage accounts</Link>
              </Button>
            </div>
          )}
          {Boolean(search || active) && (
            <Button
              className="mt-4"
              variant="outline"
              onClick={() => {
                setDraftSearch("");
                setSearch("");
                clearFilters();
              }}
            >
              Clear all
            </Button>
          )}
        </div>
      ) : (
        <>
          {showingOlderWindow && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-recessed p-3 text-sm">
              <span>Showing an older part of your history.</span>
              <button
                className="min-h-11 shrink-0 font-bold text-pencil"
                onClick={() => void load(null)}
              >
                Back to newest
              </button>
            </div>
          )}
          <TransactionGroups items={visibleItems} onSelect={setSelected} />
        </>
      )}
      {error && (
        <div role="alert" className="mt-3 rounded-xl bg-coral/10 p-3 text-sm">
          <strong>Couldn’t load transactions.</strong>
          <p className="mt-1">{error}</p>
          <button
            className="mt-2 min-h-11 font-bold text-pencil"
            onClick={() => void load(failedCursor ?? null)}
          >
            Try again
          </button>
        </div>
      )}
      {cursor && !offline && (
        <Button
          className="mt-4 w-full"
          variant="outline"
          disabled={paging}
          onClick={() => void load(cursor)}
        >
          {paging ? "Loading…" : "Load older transactions"}
        </Button>
      )}
      {!cursor && visibleItems.length > 0 && !loading && (
        <p className="py-5 text-center text-sm text-muted">
          You’ve reached the end.
        </p>
      )}
      <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
        <SheetContent side="bottom">
          <SheetHeader>
            <SheetTitle>Filter transactions</SheetTitle>
            <SheetDescription>
              Choose any filters. You can clear them whenever you want.
            </SheetDescription>
          </SheetHeader>
          <div className="mt-4 space-y-3">
            <Select
              label="Category"
              value={category}
              onChange={setCategory}
              options={categories}
            />
            <Select
              label="Money"
              value={direction}
              onChange={setDirection}
              options={[
                ["debit", "Money out"],
                ["credit", "Money in"],
              ]}
            />
            <Select
              label="Status"
              value={status}
              onChange={setStatus}
              options={[
                ["posted", "Posted"],
                ["pending", "Pending"],
              ]}
            />
            <Select
              label="Account"
              value={accountId}
              onChange={setAccountId}
              options={accountOptions}
            />
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm font-bold">
                From
                <input
                  type="date"
                  value={from}
                  max={to || undefined}
                  onChange={(event) => setFrom(event.target.value)}
                  className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-2 text-base"
                />
              </label>
              <label className="block text-sm font-bold">
                To
                <input
                  type="date"
                  value={to}
                  min={from || undefined}
                  onChange={(event) => setTo(event.target.value)}
                  className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-2 text-base"
                />
              </label>
            </div>
            <Button className="w-full" onClick={() => setFiltersOpen(false)}>
              Show transactions
            </Button>
            <Button
              className="w-full"
              variant="ghost"
              onClick={() => {
                clearFilters();
                setFiltersOpen(false);
              }}
            >
              Clear filters
            </Button>
          </div>
        </SheetContent>
      </Sheet>
      <TransactionDetail
        item={selected}
        offline={offline}
        today={today}
        occurrences={occurrences}
        savingsGoals={savingsGoals}
        onClose={closeDetail}
        onSaved={(changed, changedCategory) => {
          setItems((value) =>
            value.map((entry) =>
              entry.id === changed.id
                ? {
                    ...entry,
                    category: changedCategory,
                    categorySource: "user",
                    categoryConfidence: "high",
                    categoryVersion: changed.categoryVersion + 1,
                  }
                : entry,
            ),
          );
          closeDetail();
          void onCanonicalChange();
        }}
        onEdited={(changed, values) => {
          setItems((current) =>
            current.map((entry) =>
              entry.id === changed.id
                ? {
                    ...entry,
                    ...values,
                    version: entry.version + 1,
                    categoryVersion:
                      values.category === entry.category &&
                      entry.categorySource === "user"
                        ? entry.categoryVersion
                        : entry.categoryVersion + 1,
                    categorySource: "user",
                    categoryConfidence: "high",
                  }
                : entry,
            ),
          );
          closeDetail();
          void onCanonicalChange();
        }}
        onVoided={(changed) => {
          setItems((current) =>
            current.filter((entry) => entry.id !== changed.id),
          );
          closeDetail();
          void onCanonicalChange();
        }}
        onLinked={async () => {
          await onCanonicalChange();
          closeDetail();
        }}
        onUnlinked={(changed) => {
          setItems((current) =>
            current.map((entry) =>
              entry.id === changed.id
                ? { ...entry, linkedOccurrence: null }
                : entry,
            ),
          );
          closeDetail();
          void onCanonicalChange();
        }}
      />
    </>
  );
}

function TransactionGroups({
  items,
  onSelect,
}: {
  items: Item[];
  onSelect: (item: Item) => void;
}) {
  let previous = "";
  return (
    <div className="mt-3">
      {items.map((item) => {
        const heading = item.occurredOn !== previous;
        previous = item.occurredOn;
        return (
          <div key={item.id}>
            {heading && (
              <h3 className="px-1 pb-2 pt-4 text-sm font-bold">
                {new Intl.DateTimeFormat("en-US", {
                  weekday: "long",
                  month: "short",
                  day: "numeric",
                  timeZone: "UTC",
                }).format(new Date(`${item.occurredOn}T12:00:00Z`))}
              </h3>
            )}
            <button
              data-transaction-id={item.id}
              onClick={() => onSelect(item)}
              className="mb-2 flex min-h-[76px] w-full items-center gap-3 rounded-2xl border border-rule bg-white px-4 py-3 text-left"
              aria-label={`${item.merchant}, ${item.direction === "credit" ? "money in" : "money out"} ${money(Number(item.amount.minor) / 100)}, ${label.get(item.category)}, ${item.account.name}`}
            >
              <span
                className={`grid size-10 shrink-0 place-items-center rounded-2xl ${item.direction === "credit" ? "bg-citron/35" : "bg-recessed"}`}
              >
                {item.direction === "credit" ? (
                  <ArrowDownLeft className="size-5" />
                ) : (
                  <ArrowUpRight className="size-5" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-[15px]">
                  {item.merchant}
                </strong>
                <span className="block text-sm text-muted">
                  {label.get(item.category)} · {item.account.name}
                  {item.account.archived ? " · Disconnected" : ""}
                </span>
                <span className="block text-sm font-medium">
                  {item.linkedOccurrence?.matchState === "proposed"
                    ? "Suggested plan match · review"
                    : `${item.status === "pending" ? "Pending · " : ""}${
                        item.provenance === "manual"
                          ? "You added"
                          : "Connected data"
                      }`}
                </span>
              </span>
              <strong className="shrink-0 text-[15px] tabular-nums">
                {item.direction === "credit" ? "+" : "−"}
                {money(Number(item.amount.minor) / 100)}
              </strong>
            </button>
          </div>
        );
      })}
    </div>
  );
}
function Select({
  label: caption,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly (readonly [string, string])[];
}) {
  return (
    <label className="block text-sm font-bold">
      {caption}
      <select
        aria-label={caption}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-base"
      >
        <option value="">All</option>
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}
function TransactionDetail({
  item,
  offline,
  today,
  occurrences,
  savingsGoals,
  onClose,
  onSaved,
  onEdited,
  onVoided,
  onLinked,
  onUnlinked,
}: {
  item: Item | null;
  offline: boolean;
  today: string;
  occurrences: Occurrence[];
  savingsGoals: SavingsGoal[];
  onClose: () => void;
  onSaved: (item: Item, category: Item["category"]) => void;
  onEdited: (
    item: Item,
    values: Pick<
      Item,
      "merchant" | "amount" | "occurredOn" | "direction" | "category"
    >,
  ) => void;
  onVoided: (item: Item) => void;
  onLinked: (item: Item, occurrence: Occurrence) => void | Promise<void>;
  onUnlinked: (item: Item) => void;
}) {
  const [category, setCategory] = useState(""),
    [future, setFuture] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [editing, setEditing] = useState(false),
    [confirmingVoid, setConfirmingVoid] = useState(false),
    [occurrenceId, setOccurrenceId] = useState(""),
    [merchant, setMerchant] = useState(""),
    [amount, setAmount] = useState(0),
    [occurredOn, setOccurredOn] = useState(""),
    [direction, setDirection] = useState<Item["direction"]>("debit");
  useEffect(() => {
    setCategory(item?.category ?? "");
    setMerchant(item?.merchant ?? "");
    setAmount(item ? Number(item.amount.minor) / 100 : 0);
    setOccurredOn(item?.occurredOn ?? "");
    setDirection(item?.direction ?? "debit");
    setFuture(false);
    setError("");
    setEditing(false);
    setConfirmingVoid(false);
    setOccurrenceId("");
  }, [item]);
  const linkedPlanItem = occurrences.find(
    (occurrence) => occurrence.id === item?.linkedOccurrence?.id,
  );
  const proposedPlanItems = item
    ? occurrences.filter((occurrence) =>
        occurrence.evidence.some(
          (proof) =>
            proof.transactionId === item.id && proof.matchState === "proposed",
        ),
      )
    : [];
  const eligibleOccurrences = occurrences.filter(
    (occurrence) =>
      ["expected", "pending", "partial", "overdue", "needs_review"].includes(
        occurrence.state,
      ) &&
      (occurrence.kind === "income"
        ? item?.direction === "credit"
        : occurrence.kind === "savings"
          ? item?.direction === "credit" &&
            savingsGoals.some(
              (goal) =>
                goal.id === occurrence.savingsGoalId &&
                goal.destination?.accountId === item.account.id,
            )
          : item?.direction === "debit"),
  );
  return (
    <Sheet
      open={Boolean(item)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent side="bottom">
        <SheetHeader>
          <SheetTitle>{item?.merchant}</SheetTitle>
          <SheetDescription>
            {item &&
              `${item.account.name} · ${formatTransactionDate(item.occurredOn)} · ${item.status === "pending" ? "Pending" : "Posted"}`}
          </SheetDescription>
        </SheetHeader>
        {item && (
          <div className="mt-4">
            {editing ? (
              <div className="space-y-3">
                <label className="block text-sm font-bold">
                  Name
                  <input
                    value={merchant}
                    maxLength={160}
                    onChange={(event) => setMerchant(event.target.value)}
                    className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-base"
                  />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block text-sm font-bold">
                    Amount
                    <NumberInput
                      aria-label="Amount"
                      min={0.01}
                      step="0.01"
                      value={amount}
                      onValueChange={setAmount}
                      className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-base"
                    />
                  </label>
                  <label className="block text-sm font-bold">
                    Date
                    <input
                      type="date"
                      value={occurredOn}
                      max={today}
                      onChange={(event) => setOccurredOn(event.target.value)}
                      className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-2 text-base"
                    />
                  </label>
                </div>
                <Select
                  label="Money"
                  value={direction}
                  onChange={(value) => setDirection(value as Item["direction"])}
                  options={[
                    ["debit", "Money out"],
                    ["credit", "Money in"],
                  ]}
                />
              </div>
            ) : (
              <p className="text-2xl font-bold tabular-nums">
                {item.direction === "credit" ? "+" : "−"}
                {money(Number(item.amount.minor) / 100)}
              </p>
            )}
            {offline ? (
              <div className="mt-4 rounded-xl bg-recessed p-3">
                <span className="block text-xs font-bold uppercase tracking-wide text-muted">
                  Category
                </span>
                <strong className="mt-1 block">
                  {label.get(item.category)}
                </strong>
              </div>
            ) : (
              <>
                <Select
                  label="Category"
                  value={category}
                  onChange={setCategory}
                  options={categories}
                />
                {!editing && (
                  <label className="mt-4 flex min-h-11 items-center gap-3 text-sm">
                    <input
                      type="checkbox"
                      checked={future}
                      onChange={(e) => setFuture(e.target.checked)}
                      className="size-5"
                    />
                    Use this category for future transactions from this merchant
                  </label>
                )}
              </>
            )}
            {item.linkedOccurrence && (
              <div className="mt-3 rounded-xl bg-recessed p-3 text-sm">
                <p>
                  {proposedPlanItems.length > 1
                    ? `This deposit fits ${proposedPlanItems.length} expected incomes`
                    : `Linked to ${item.linkedOccurrence.name}`}{" "}
                  ·{" "}
                  {item.linkedOccurrence.matchState === "proposed"
                    ? "Needs your review"
                    : linkedOutcome(
                        item.linkedOccurrence.state,
                        linkedPlanItem?.kind,
                      )}
                </p>
                {!offline && !editing && (
                  <div className="mt-2 grid gap-2">
                    {item.linkedOccurrence.matchState === "proposed" && (
                      <>
                        {proposedPlanItems.length > 1 && (
                          <label className="block text-xs font-bold">
                            Choose the income source
                            <select
                              aria-label="Choose the income source"
                              className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-base"
                              value={occurrenceId || item.linkedOccurrence.id}
                              onChange={(event) =>
                                setOccurrenceId(event.target.value)
                              }
                            >
                              {proposedPlanItems.map((occurrence) => (
                                <option
                                  key={occurrence.id}
                                  value={occurrence.id}
                                >
                                  {occurrence.name} ·{" "}
                                  {formatTransactionDate(occurrence.expectedOn)}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        <Button
                          className="min-h-11 w-full"
                          disabled={saving}
                          onClick={async () => {
                            const occurrence = occurrences.find(
                              (entry) =>
                                entry.id ===
                                (occurrenceId || item.linkedOccurrence?.id),
                            );
                            if (!occurrence) return;
                            setSaving(true);
                            setError("");
                            try {
                              await api.linkTransactionToOccurrence(item.id, {
                                occurrenceId: occurrence.id,
                                expectedTransactionVersion: item.version,
                                expectedOccurrenceVersion: occurrence.version,
                                requestId: requestId(),
                              });
                              await onLinked(item, occurrence);
                            } catch (reason) {
                              setError(
                                reason instanceof Error
                                  ? reason.message
                                  : "Transaction could not be confirmed",
                              );
                            } finally {
                              setSaving(false);
                            }
                          }}
                        >
                          {saving
                            ? "Confirming…"
                            : linkedPlanItem?.kind === "savings"
                              ? "Yes, this reached savings"
                              : linkedPlanItem?.kind === "income"
                                ? "Yes, this is the deposit"
                                : "Yes, this is the payment"}
                        </Button>
                      </>
                    )}
                    <Button
                      className="min-h-11 w-full"
                      variant="ghost"
                      disabled={saving}
                      onClick={async () => {
                        setSaving(true);
                        setError("");
                        try {
                          await api.unlinkTransactionFromOccurrence(item.id, {
                            expectedTransactionVersion: item.version,
                            expectedOccurrenceId: item.linkedOccurrence!.id,
                            expectedMatchId: item.linkedOccurrence!.matchId,
                            expectedMatchVersion:
                              item.linkedOccurrence!.matchVersion,
                            requestId: requestId(),
                          });
                          onUnlinked(item);
                        } catch (reason) {
                          setError(
                            reason instanceof Error
                              ? reason.message
                              : "Transaction match could not be removed",
                          );
                        } finally {
                          setSaving(false);
                        }
                      }}
                    >
                      {saving
                        ? "Removing match…"
                        : linkedPlanItem?.kind === "savings"
                          ? "Not this contribution"
                          : linkedPlanItem?.kind === "income"
                            ? "Not this income"
                            : "Not this payment"}
                    </Button>
                  </div>
                )}
              </div>
            )}
            {!offline &&
              !editing &&
              !item.linkedOccurrence &&
              item.status === "posted" &&
              eligibleOccurrences.length > 0 && (
                <div className="mt-4 rounded-xl border border-rule bg-paper-deep/45 p-3">
                  <label className="block text-sm font-bold">
                    Match to a plan item
                    <select
                      aria-label="Match to a plan item"
                      value={occurrenceId}
                      onChange={(event) => setOccurrenceId(event.target.value)}
                      className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-base"
                    >
                      <option value="">Choose an open item</option>
                      {eligibleOccurrences.map((occurrence) => (
                        <option key={occurrence.id} value={occurrence.id}>
                          {occurrence.name} ·{" "}
                          {money(
                            Number(
                              occurrence.remainingAmount?.minor ??
                                occurrence.expectedAmount?.minor ??
                                "0",
                            ) / 100,
                          )}{" "}
                          · {formatTransactionDate(occurrence.expectedOn)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="mt-2 text-xs leading-5 text-muted">
                    Use this when the bank description differs from the name in
                    your plan.
                  </p>
                  <Button
                    className="mt-3 w-full"
                    variant="outline"
                    disabled={saving || !occurrenceId}
                    onClick={async () => {
                      const occurrence = eligibleOccurrences.find(
                        (entry) => entry.id === occurrenceId,
                      );
                      if (!occurrence) return;
                      setSaving(true);
                      setError("");
                      try {
                        await api.linkTransactionToOccurrence(item.id, {
                          occurrenceId: occurrence.id,
                          expectedTransactionVersion: item.version,
                          expectedOccurrenceVersion: occurrence.version,
                          requestId: requestId(),
                        });
                        await onLinked(item, occurrence);
                      } catch (reason) {
                        setError(
                          reason instanceof Error
                            ? reason.message
                            : "Transaction could not be matched",
                        );
                      } finally {
                        setSaving(false);
                      }
                    }}
                  >
                    {saving ? "Matching…" : "Match transaction"}
                  </Button>
                </div>
              )}
            {editing && item.linkedOccurrence && (
              <p className="mt-3 rounded-xl bg-citron/20 p-3 text-sm">
                Editing this recorded{" "}
                {linkedPlanItem?.kind === "income"
                  ? "deposit"
                  : linkedPlanItem?.kind === "savings"
                    ? "contribution"
                    : "payment"}{" "}
                will reopen the linked plan item for review.
              </p>
            )}
            {offline ? (
              <p className="mt-4 text-sm text-muted">
                Reconnect to change this category.
              </p>
            ) : editing ? (
              <div className="mt-4 grid grid-cols-2 gap-3">
                <Button variant="outline" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button
                  disabled={
                    saving ||
                    !merchant.trim() ||
                    !occurredOn ||
                    !Number.isFinite(amount) ||
                    amount <= 0
                  }
                  onClick={async () => {
                    setSaving(true);
                    setError("");
                    try {
                      const minor = Math.round(amount * 100);
                      await api.updateManualTransaction(item.id, {
                        merchant: merchant.trim(),
                        amount: { minor: String(minor), currency: "USD" },
                        occurredOn,
                        direction,
                        category: category as Item["category"],
                        expectedVersion: item.version,
                        expectedCategoryVersion: item.categoryVersion,
                        requestId: requestId(),
                      });
                      onEdited(item, {
                        merchant: merchant.trim(),
                        amount: { minor: String(minor), currency: "USD" },
                        occurredOn,
                        direction,
                        category: category as Item["category"],
                      });
                    } catch (reason) {
                      setError(
                        reason instanceof Error
                          ? reason.message
                          : "Transaction could not be updated",
                      );
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  {saving ? "Saving…" : "Save changes"}
                </Button>
              </div>
            ) : (
              <Button
                className="mt-4 w-full"
                disabled={
                  saving || !category || (category === item.category && !future)
                }
                onClick={async () => {
                  setSaving(true);
                  setError("");
                  try {
                    await api.updateTransactionCategory(item.id, {
                      category: category as any,
                      expectedVersion: item.categoryVersion,
                      applyToFuture: future,
                      requestId: requestId(),
                    });
                    onSaved(item, category as Item["category"]);
                  } catch (reason) {
                    setError(
                      reason instanceof Error
                        ? reason.message
                        : "Category could not be saved",
                    );
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                {saving ? "Saving…" : "Save category"}
              </Button>
            )}
            {!offline && item.provenance === "manual" && !editing && (
              <div className="mt-3 border-t border-rule pt-3">
                <Button
                  className="w-full"
                  variant="outline"
                  onClick={() => setEditing(true)}
                >
                  Edit details
                </Button>
                {confirmingVoid ? (
                  <div className="mt-3 rounded-xl bg-coral/10 p-3">
                    <p className="text-sm">
                      Remove this entry? Its change history will remain for your
                      records.
                    </p>
                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <Button
                        variant="outline"
                        onClick={() => setConfirmingVoid(false)}
                      >
                        Keep it
                      </Button>
                      <Button
                        disabled={saving}
                        onClick={async () => {
                          setSaving(true);
                          setError("");
                          try {
                            await api.voidManualTransaction(item.id, {
                              expectedVersion: item.version,
                              requestId: requestId(),
                            });
                            onVoided(item);
                          } catch (reason) {
                            setError(
                              reason instanceof Error
                                ? reason.message
                                : "Transaction could not be removed",
                            );
                          } finally {
                            setSaving(false);
                          }
                        }}
                      >
                        {saving ? "Removing…" : "Remove entry"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    className="mt-2 w-full text-coral"
                    variant="ghost"
                    onClick={() => setConfirmingVoid(true)}
                  >
                    Remove entry
                  </Button>
                )}
              </div>
            )}
            {error && (
              <p role="alert" className="mt-3 text-sm text-coral">
                {error}
              </p>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function formatTransactionDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}
