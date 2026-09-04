import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  CalendarClock,
  CalendarPlus,
  Check,
  CreditCard,
  Landmark,
  PenLine,
  PiggyBank,
  ReceiptText,
  ShieldCheck,
} from "lucide-react";
import { MobileShell } from "@/components/layout";
import { CommitmentEditor } from "@/components/commitment-editor";
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
import { NumberInput } from "@/components/ui/number-input";
import { useAppState, type CommitmentRecurrence } from "@/state/app-state";
import { money } from "@/lib/utils";
import { scheduleLabel } from "@/lib/schedule-labels";
import {
  transactionCategories,
  type TransactionCategory,
} from "@/lib/transaction-categories";

function localToday(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function ManualEntryPage() {
  const state = useAppState();
  const [cash, setCash] = useState(state.calibration.knownCash);
  const [merchant, setMerchant] = useState("");
  const [actualAmount, setActualAmount] = useState(0);
  const [actualDate, setActualDate] = useState(localToday);
  const [actualOccurrenceId, setActualOccurrenceId] = useState("");
  const [actualDirection, setActualDirection] = useState<"debit" | "credit">(
    "debit",
  );
  const [actualCategory, setActualCategory] =
    useState<TransactionCategory>("uncategorized");
  const eligibleAccounts = state.accounts.filter(
    (account) =>
      account.planningRole !== "excluded" &&
      ["cash", "checking", "savings"].includes(account.type),
  );
  const [actualAccountId, setActualAccountId] = useState(
    eligibleAccounts.length === 1 ? eligibleAccounts[0]!.id : "",
  );
  const [balanceIncludesActivity, setBalanceIncludesActivity] = useState(false);
  const [commitment, setCommitment] = useState("");
  const [commitmentAmount, setCommitmentAmount] = useState(0);
  const [commitmentDate, setCommitmentDate] = useState("");
  const [commitmentRecurrence, setCommitmentRecurrence] =
    useState<CommitmentRecurrence>("monthly");
  const currentDate = useRef(localToday());
  const [saved, setSaved] = useState<"cash" | "actual" | "commitment" | null>(
    null,
  );
  const [saving, setSaving] = useState<
    "cash" | "actual" | "commitment" | "mode" | null
  >(null);
  const [confirmManualMode, setConfirmManualMode] = useState(false);
  const commitments = [...state.commitments].sort(
    (left, right) =>
      (left.dueDate ?? "9999-12-31").localeCompare(
        right.dueDate ?? "9999-12-31",
      ) || left.name.localeCompare(right.name),
  );
  useEffect(
    () => setCash(state.calibration.knownCash),
    [state.calibration.knownCash],
  );
  useEffect(() => {
    if (eligibleAccounts.length === 1 && !actualAccountId)
      setActualAccountId(eligibleAccounts[0]!.id);
    if (
      actualAccountId &&
      !eligibleAccounts.some((account) => account.id === actualAccountId)
    )
      setActualAccountId(
        eligibleAccounts.length === 1 ? eligibleAccounts[0]!.id : "",
      );
  }, [eligibleAccounts, actualAccountId]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = localToday();
      if (next !== currentDate.current) {
        setActualDate((value) =>
          value === currentDate.current ? next : value,
        );
        currentDate.current = next;
      }
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const saveCash = async () => {
    setSaving("cash");
    setSaved(null);
    const okay = await state.saveManualCash(cash);
    setSaving(null);
    if (okay) setSaved("cash");
  };
  const switchToManual = async () => {
    setSaving("mode");
    setSaved(null);
    const okay = await state.activateManualMode();
    setSaving(null);
    if (okay) setConfirmManualMode(false);
  };
  const saveActual = async () => {
    setSaving("actual");
    setSaved(null);
    const okay = await state.addManualActual(
      merchant,
      actualAmount,
      actualDate,
      actualOccurrenceId || undefined,
      balanceIncludesActivity,
      actualDirection,
      actualAccountId || undefined,
      actualCategory,
    );
    setSaving(null);
    if (okay) {
      setMerchant("");
      setActualAmount(0);
      setActualDate(localToday());
      setActualOccurrenceId("");
      setBalanceIncludesActivity(false);
      setActualDirection("debit");
      setActualCategory("uncategorized");
      setSaved("actual");
    }
  };
  const saveCommitment = async () => {
    setSaving("commitment");
    setSaved(null);
    const okay = await state.addManualCommitment(
      commitment,
      commitmentAmount,
      commitmentDate,
      commitmentRecurrence,
    );
    setSaving(null);
    if (okay) {
      setCommitment("");
      setCommitmentAmount(0);
      setCommitmentDate("");
      setCommitmentRecurrence("monthly");
      setSaved("commitment");
    }
  };

  return (
    <MobileShell>
      <main className="px-4 pb-8 pt-5">
        <p className="eyebrow">
          {state.dataMode === "manual"
            ? "No connection required"
            : "Add what your bank missed"}
        </p>
        <h1 className="text-[31px] font-bold tracking-[-0.045em]">
          Manual workspace
        </h1>
        <p className="mt-1 text-sm leading-5 text-muted">
          {state.dataMode === "manual"
            ? "Update only what changed. Saving a cash value confirms it as current now; Budgefi never labels it bank-observed."
            : "Connected balances stay bank-observed. You can record missing activity here without overwriting them."}
        </p>
        <div className="sr-only" role="status" aria-live="polite">
          {saved ? `${saved} saved` : saving ? `Saving ${saving}` : ""}
        </div>

        {state.dataMode === "manual" ? (
          <section className="mt-5 rounded-[22px] border border-pencil/15 bg-white p-4">
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-citron">
                <PenLine className="size-5" />
              </span>
              <div>
                <h2 className="text-base font-bold">Spendable cash today</h2>
                <p className="text-xs leading-5 text-muted">
                  Use current balances. Do not add a new charge again if it is
                  already reflected here.
                </p>
              </div>
            </div>
            <MoneyField
              id="manual-workspace-cash"
              label="Current spendable total"
              value={cash}
              onChange={setCash}
            />
            <Button
              className="mt-3 w-full"
              disabled={saving !== null}
              onClick={() => void saveCash()}
            >
              {saving === "cash" ? (
                "Saving…"
              ) : saved === "cash" ? (
                <>
                  <Check className="size-4" />
                  Balance updated
                </>
              ) : (
                "Update balance"
              )}
            </Button>
          </section>
        ) : (
          <section className="mt-5 rounded-[22px] border border-cobalt/20 bg-white p-4">
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-cobalt/10 text-cobalt">
                <Landmark className="size-5" />
              </span>
              <div>
                <h2 className="text-base font-bold">
                  Cash comes from connected accounts
                </h2>
                <p className="text-xs leading-5 text-muted">
                  Budgefi will not mix a typed total with your included bank
                  balances. Change which accounts count, or deliberately switch
                  the plan to manual values.
                </p>
              </div>
            </div>
            <Button asChild className="mt-4 w-full">
              <Link to="/connections">Review included accounts</Link>
            </Button>
            {!confirmManualMode ? (
              <Button
                variant="ghost"
                className="mt-1 w-full"
                disabled={saving !== null}
                onClick={() => setConfirmManualMode(true)}
              >
                Switch plan to manual values
              </Button>
            ) : (
              <div className="mt-3 rounded-2xl bg-recessed p-3">
                <p className="text-xs leading-5 text-muted">
                  Connected accounts stay available, but their spendable
                  balances will be excluded from the plan until you include them
                  again.
                </p>
                <Button
                  className="mt-3 w-full"
                  disabled={saving !== null}
                  onClick={() => void switchToManual()}
                >
                  {saving === "mode" ? "Switching…" : "Use manual cash instead"}
                </Button>
                <Button
                  variant="ghost"
                  className="mt-1 w-full"
                  disabled={saving !== null}
                  onClick={() => setConfirmManualMode(false)}
                >
                  Keep connected balances
                </Button>
              </div>
            )}
          </section>
        )}

        <section className="mt-3 rounded-[22px] border border-rule bg-white p-4">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-recessed text-pencil">
              <CalendarClock className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-bold">Expected income</h2>
              <p className="text-xs leading-5 text-muted">
                Add each schedule separately. When money arrives, link the
                deposit below so Budgefi can advance only that schedule.
              </p>
            </div>
          </div>
          <div className="mt-4">
            <IncomeScheduleList compact />
          </div>
          <div className="mt-3">
            <IncomeScheduleEditor compact />
          </div>
        </section>

        <section className="mt-3 rounded-[22px] border border-rule bg-white p-4">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-recessed text-pencil">
              <CreditCard className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-bold">Debts</h2>
              <p className="text-xs leading-5 text-muted">
                Update a manual balance without counting a payment twice.
              </p>
            </div>
          </div>
          {state.debts.length > 0 && (
            <div className="mt-4 space-y-2">
              {state.debts
                .filter((debt) => debt.status !== "archived")
                .map((debt) => (
                  <div
                    key={debt.id}
                    className="flex items-center justify-between gap-3 rounded-2xl bg-recessed p-3"
                  >
                    <span className="min-w-0">
                      <strong className="block truncate text-sm">
                        {debt.name}
                      </strong>
                      <span className="text-xs text-muted">
                        {debt.balance
                          ? `${money(Number(debt.balance.owed.minor) / 100)} owed${debt.balance.coverage === "stale" ? " · stale" : ""}`
                          : "Balance not provided"}
                      </span>
                    </span>
                    <DebtEditor debt={debt} />
                  </div>
                ))}
            </div>
          )}
          <div className="mt-3">
            <DebtEditor compact />
          </div>
        </section>

        <section className="mt-3 rounded-[22px] border border-rule bg-white p-4">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-recessed text-pencil">
              <PiggyBank className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-bold">Savings goals</h2>
              <p className="text-xs leading-5 text-muted">
                Update a manually tracked goal once using its current balance.
                Budgefi records the difference as confirmed by you.
              </p>
            </div>
          </div>
          {state.savingsGoals.length ? (
            <div className="mt-4 space-y-3">
              {state.savingsGoals
                .filter((goal) => goal.status !== "archived")
                .map((goal) => (
                  <div key={goal.id} className="rounded-2xl bg-recessed p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <strong className="block truncate text-sm">
                          {goal.name}
                        </strong>
                        <span className="text-xs text-muted">
                          {money(
                            Number(BigInt(goal.progress.confirmed.minor)) / 100,
                          )}{" "}
                          confirmed
                        </span>
                      </div>
                      {goal.destination?.provenance === "manual" ? (
                        <SavingsBalanceEditor goal={goal} />
                      ) : (
                        <span className="text-xs font-semibold text-muted">
                          Bank observed
                        </span>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted">No savings goals yet.</p>
          )}
          <SavingsGoalEditor compact />
        </section>

        <section className="mt-3 rounded-[22px] border border-rule bg-white p-4">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-recessed text-pencil">
              <ReceiptText className="size-5" />
            </span>
            <div>
              <h2 className="text-base font-bold">Record money activity</h2>
              <p className="text-xs leading-5 text-muted">
                Creates an evidence item without silently changing your current
                balance.
              </p>
            </div>
          </div>
          <label
            className="mt-4 block text-xs font-semibold"
            htmlFor="manual-merchant"
          >
            Name or description
          </label>
          <input
            id="manual-merchant"
            value={merchant}
            onChange={(event) => {
              setMerchant(event.target.value);
              setSaved(null);
            }}
            placeholder={
              actualDirection === "credit" ? "Paycheck" : "Internet bill"
            }
            className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-base outline-none focus:ring-2 focus:ring-pencil"
          />
          <div className="mt-3 grid grid-cols-2 gap-3">
            <MoneyField
              id="manual-actual-amount"
              label="Amount"
              value={actualAmount}
              className=""
              onChange={(value) => {
                setActualAmount(value);
                setSaved(null);
              }}
            />
            <label
              className="block text-xs font-semibold"
              htmlFor="manual-actual-date"
            >
              Date
              <input
                id="manual-actual-date"
                type="date"
                value={actualDate}
                max={localToday()}
                onChange={(event) => setActualDate(event.target.value)}
                className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-base font-bold outline-none focus:ring-2 focus:ring-pencil"
              />
            </label>
          </div>
          <label
            className="mt-3 block text-xs font-semibold"
            htmlFor="manual-actual-account"
          >
            Account
            <select
              id="manual-actual-account"
              value={actualAccountId}
              onChange={(event) => setActualAccountId(event.target.value)}
              className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-base outline-none focus:ring-2 focus:ring-pencil"
            >
              <option value="">Choose an account</option>
              {eligibleAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </label>
          <label
            className="mt-3 block text-xs font-semibold"
            htmlFor="manual-actual-commitment"
          >
            What did this complete?{" "}
            <span className="font-normal text-muted">(optional)</span>
          </label>
          <select
            id="manual-actual-commitment"
            value={actualOccurrenceId}
            onChange={(event) => {
              const id = event.target.value;
              setActualOccurrenceId(id);
              const occurrence = state.occurrences.find(
                (item) => item.id === id,
              );
              if (occurrence) {
                const next = occurrence.kind === "income" ? "credit" : "debit";
                setActualDirection(next);
                if (
                  actualCategory === "uncategorized" ||
                  actualCategory === "income"
                )
                  setActualCategory(
                    next === "credit" ? "income" : "uncategorized",
                  );
              }
            }}
            className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-base outline-none focus:ring-2 focus:ring-pencil"
          >
            <option value="">Not linked to a plan item</option>
            {state.occurrences
              .filter(
                (item) =>
                  item.kind !== "savings" &&
                  !["verified", "skipped"].includes(item.state),
              )
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.kind === "income" ? "Income" : "Commitment"} ·{" "}
                  {item.name} · {formatDate(item.expectedOn)}
                </option>
              ))}
          </select>
          {state.accounts.find((account) => account.id === actualAccountId)
            ?.planningRole === "protected" &&
            actualDirection !== "credit" && (
              <p className="mt-2 text-xs font-semibold text-coral">
                Protected accounts can verify deposits, but everyday charges
                should be recorded against a spendable account.
              </p>
            )}
          {!actualOccurrenceId && (
            <label
              className="mt-3 block text-xs font-semibold"
              htmlFor="manual-actual-direction"
            >
              Money direction
              <select
                id="manual-actual-direction"
                value={actualDirection}
                onChange={(event) => {
                  const next = event.target.value as typeof actualDirection;
                  setActualDirection(next);
                  if (
                    actualCategory === "uncategorized" ||
                    actualCategory === "income"
                  )
                    setActualCategory(
                      next === "credit" ? "income" : "uncategorized",
                    );
                }}
                className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-base outline-none focus:ring-2 focus:ring-pencil"
              >
                <option value="debit">Money went out</option>
                <option value="credit">Money came in</option>
              </select>
            </label>
          )}
          <label
            className="mt-3 block text-xs font-semibold"
            htmlFor="manual-actual-category"
          >
            Category <span className="font-normal text-muted">(optional)</span>
            <select
              id="manual-actual-category"
              value={actualCategory}
              onChange={(event) =>
                setActualCategory(event.target.value as TransactionCategory)
              }
              className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-base outline-none focus:ring-2 focus:ring-pencil"
            >
              {transactionCategories.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {actualOccurrenceId && (
            <label className="mt-3 flex min-h-12 items-start gap-3 rounded-xl bg-recessed p-3 text-xs leading-5">
              <input
                type="checkbox"
                checked={balanceIncludesActivity}
                onChange={(event) =>
                  setBalanceIncludesActivity(event.target.checked)
                }
                className="mt-1 size-4 accent-pencil"
              />
              <span>
                <strong className="block text-sm">
                  My{" "}
                  {eligibleAccounts.find(
                    (account) => account.id === actualAccountId,
                  )?.name ?? "account"}{" "}
                  balance already includes this activity
                </strong>
                Leave this off if the balance has not caught up yet. Budgefi
                will keep the plan item pending until a later balance confirms
                it.
              </span>
            </label>
          )}
          <Button
            variant="outline"
            className="mt-3 w-full"
            disabled={
              saving !== null ||
              !merchant.trim() ||
              !actualAccountId ||
              actualAmount <= 0 ||
              !actualDate ||
              actualDate > localToday()
            }
            onClick={() => void saveActual()}
          >
            {saving === "actual" ? (
              "Recording…"
            ) : saved === "actual" ? (
              <>
                <Check className="size-4" />
                Activity recorded
              </>
            ) : (
              "Record activity"
            )}
          </Button>
        </section>

        <section className="mt-3 rounded-[22px] border border-rule bg-white p-4">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-recessed text-pencil">
              <CalendarPlus className="size-5" />
            </span>
            <div>
              <h2 className="text-base font-bold">
                Add an upcoming commitment
              </h2>
              <p className="text-xs leading-5 text-muted">
                Track it now; add a date when you want the plan to reserve it.
              </p>
            </div>
          </div>
          <label
            className="mt-4 block text-xs font-semibold"
            htmlFor="manual-commitment"
          >
            Name
          </label>
          <input
            id="manual-commitment"
            value={commitment}
            onChange={(event) => {
              setCommitment(event.target.value);
              setSaved(null);
            }}
            placeholder="Phone bill"
            className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-base outline-none focus:ring-2 focus:ring-pencil"
          />
          <div className="mt-3 grid grid-cols-2 gap-3">
            <MoneyField
              id="manual-commitment-amount"
              label="Expected amount"
              value={commitmentAmount}
              className=""
              onChange={(value) => {
                setCommitmentAmount(value);
                setSaved(null);
              }}
            />
            <label
              className="block text-xs font-semibold"
              htmlFor="manual-commitment-date"
            >
              Due date{" "}
              <span className="font-normal text-muted">(optional)</span>
              <input
                id="manual-commitment-date"
                type="date"
                value={commitmentDate}
                onChange={(event) => {
                  setCommitmentDate(event.target.value);
                  setSaved(null);
                }}
                className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-base font-bold outline-none focus:ring-2 focus:ring-pencil"
              />
            </label>
          </div>
          <label
            className="mt-3 block text-xs font-semibold"
            htmlFor="manual-commitment-repeat"
          >
            Repeats
          </label>
          <select
            id="manual-commitment-repeat"
            value={commitmentRecurrence}
            onChange={(event) =>
              setCommitmentRecurrence(
                event.target.value as CommitmentRecurrence,
              )
            }
            className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-base outline-none focus:ring-2 focus:ring-pencil"
          >
            <option value="one_time">One time</option>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Every two weeks</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Every three months</option>
            <option value="annual">Yearly</option>
          </select>
          <Button
            variant="outline"
            className="mt-3 w-full"
            disabled={
              saving !== null || !commitment.trim() || commitmentAmount <= 0
            }
            onClick={() => void saveCommitment()}
          >
            {saving === "commitment" ? (
              "Adding…"
            ) : saved === "commitment" ? (
              <>
                <Check className="size-4" />
                Commitment added
              </>
            ) : (
              "Add to plan"
            )}
          </Button>
        </section>

        <section className="mt-6" aria-labelledby="manual-commitments-heading">
          <div className="flex items-end justify-between">
            <div>
              <p className="eyebrow">Maintained by you</p>
              <h2 id="manual-commitments-heading" className="text-xl font-bold">
                Your commitments
              </h2>
            </div>
            <span className="text-xs font-semibold text-muted">
              {commitments.length} active
            </span>
          </div>
          <div className="mb-3 flex justify-end">
            <CommonBillsSheet
              existingKeys={state.calibration.starterItemKeys}
              existingNames={state.commitments.map((item) => item.name)}
              onAdd={(items) =>
                state.savePlanCalibration(
                  {
                    ...state.calibration,
                    customCommitments: [
                      ...state.calibration.customCommitments,
                      ...items,
                    ],
                  },
                  state.planningBuffer,
                )
              }
            />
          </div>
          {state.latestStarterApplication?.removable && (
            <div className="mb-3 flex min-h-14 items-center justify-between gap-3 rounded-2xl bg-cobalt/[.06] px-4 py-3">
              <p className="text-xs leading-5 text-muted">
                Empty common-bill rows added.
              </p>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={
                  state.undoStarterApplicationPendingId ===
                  state.latestStarterApplication.id
                }
                aria-busy={
                  state.undoStarterApplicationPendingId ===
                  state.latestStarterApplication.id
                }
                onClick={() =>
                  void state.undoStarterApplication(
                    state.latestStarterApplication!.id,
                  )
                }
              >
                {state.undoStarterApplicationPendingId ===
                state.latestStarterApplication.id
                  ? "Undoing…"
                  : "Undo"}
              </Button>
            </div>
          )}
          <div className="mt-3 divide-y divide-rule overflow-hidden rounded-[22px] border border-rule bg-white">
            {commitments.map((item) => (
              <div
                key={item.id}
                className="flex min-h-[78px] items-center gap-3 px-4 py-3"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-recessed text-pencil">
                  <CalendarClock className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-sm">
                    {item.name}
                  </strong>
                  <span
                    className={`block text-xs ${item.dueDate ? "text-muted" : "font-semibold text-coral"}`}
                  >
                    {item.dueDate
                      ? `${formatDate(item.dueDate)} · ${scheduleLabel(item.recurrence)} · ${sourceLabel(item.provenance)}`
                      : "Needs a due date · not reserved"}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <strong className="block text-sm tabular-nums">
                    {money(Number(BigInt(item.amount.minor)) / 100)}
                  </strong>
                  <CommitmentEditor item={item} compact />
                </span>
              </div>
            ))}
            {commitments.length === 0 && (
              <div className="p-5 text-center">
                <strong className="block text-sm">No commitments yet</strong>
                <p className="mt-1 text-xs leading-5 text-muted">
                  Add the next bill or obligation you need the plan to reserve.
                </p>
              </div>
            )}
          </div>
          {commitments.some((item) => item.provenance !== "manual") && (
            <p className="mt-2 text-xs leading-5 text-muted">
              Connected or imported commitments are evidence. Change those at
              their source; only entries you added here can be edited.
            </p>
          )}
        </section>

        <div className="mt-4 flex items-start gap-3 rounded-2xl bg-ink p-4 text-white">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-citron" />
          <p className="text-xs leading-5 text-white/70">
            <strong className="text-white">
              Manual means user-maintained, not less valid.
            </strong>{" "}
            Budgefi shows when a value came from you and never presents it as
            bank-observed evidence.
          </p>
        </div>
        {state.manualActuals.length > 0 && (
          <section className="mt-6">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold">Recently entered</h2>
              <span className="text-xs text-muted">
                {state.manualActuals.length} actual
              </span>
            </div>
            <div className="mt-2 divide-y divide-rule overflow-hidden rounded-[20px] border border-rule bg-white">
              {state.manualActuals.slice(0, 3).map((item) => (
                <div
                  key={item.id}
                  className="flex min-h-16 items-center gap-3 px-4"
                >
                  <ReceiptText className="size-4 text-pencil" />
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-sm">
                      {item.merchant}
                    </strong>
                    <span className="text-xs text-muted">
                      {item.date} · You entered
                    </span>
                  </span>
                  <strong className="text-sm tabular-nums">
                    {money(item.amount)}
                  </strong>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </MobileShell>
  );
}

function MoneyField({
  id,
  label,
  value,
  onChange,
  className = "mt-3",
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  className?: string;
}) {
  return (
    <label className={`${className} block text-xs font-semibold`} htmlFor={id}>
      {label}
      <span className="mt-2 flex h-12 items-center rounded-xl border border-rule bg-white px-3 focus-within:ring-2 focus-within:ring-pencil">
        <span className="text-muted">$</span>
        <NumberInput
          id={id}
          inputMode="decimal"
          min={0}
          step="0.01"
          value={value}
          onValueChange={onChange}
          className="h-full min-w-0 flex-1 bg-transparent px-1 text-base font-bold outline-none"
        />
      </span>
    </label>
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
