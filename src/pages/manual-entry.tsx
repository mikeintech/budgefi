import { useEffect, useRef, useState } from "react";
import {
  CalendarClock,
  CalendarPlus,
  Check,
  PenLine,
  ReceiptText,
  ShieldCheck,
} from "lucide-react";
import { MobileShell } from "@/components/layout";
import { CommitmentEditor } from "@/components/commitment-editor";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { useAppState } from "@/state/app-state";
import { money } from "@/lib/utils";

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
  const [commitment, setCommitment] = useState("");
  const [commitmentAmount, setCommitmentAmount] = useState(0);
  const [commitmentDate, setCommitmentDate] = useState("");
  const currentDate = useRef(localToday());
  const [saved, setSaved] = useState<"cash" | "actual" | "commitment" | null>(
    null,
  );
  const [saving, setSaving] = useState<"cash" | "actual" | "commitment" | null>(
    null,
  );
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
  const saveActual = async () => {
    setSaving("actual");
    setSaved(null);
    const okay = await state.addManualActual(
      merchant,
      actualAmount,
      actualDate,
    );
    setSaving(null);
    if (okay) {
      setMerchant("");
      setActualAmount(0);
      setActualDate(localToday());
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
    );
    setSaving(null);
    if (okay) {
      setCommitment("");
      setCommitmentAmount(0);
      setCommitmentDate("");
      setSaved("commitment");
    }
  };

  return (
    <MobileShell>
      <main className="px-4 pb-8 pt-5">
        <p className="eyebrow">No connection required</p>
        <h1 className="text-[31px] font-bold tracking-[-0.045em]">
          Manual workspace
        </h1>
        <p className="mt-1 text-sm leading-5 text-muted">
          Update only what changed. Saving a cash value confirms it as current
          now; Budgefi never labels it bank-observed.
        </p>
        <div className="sr-only" role="status" aria-live="polite">
          {saved ? `${saved} saved` : saving ? `Saving ${saving}` : ""}
        </div>

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

        <section className="mt-3 rounded-[22px] border border-rule bg-white p-4">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-recessed text-pencil">
              <ReceiptText className="size-5" />
            </span>
            <div>
              <h2 className="text-base font-bold">Record an actual charge</h2>
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
            Merchant or description
          </label>
          <input
            id="manual-merchant"
            value={merchant}
            onChange={(event) => {
              setMerchant(event.target.value);
              setSaved(null);
            }}
            placeholder="Internet bill"
            className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-base outline-none focus:ring-2 focus:ring-pencil"
          />
          <div className="mt-3 grid grid-cols-2 gap-3">
            <MoneyField
              id="manual-actual-amount"
              label="Amount"
              value={actualAmount}
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
                className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-pencil"
              />
            </label>
          </div>
          <Button
            variant="outline"
            className="mt-3 w-full"
            disabled={
              saving !== null ||
              !merchant.trim() ||
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
                Charge recorded
              </>
            ) : (
              "Record charge"
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
                Reserve money before calling it available to use.
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
              onChange={(value) => {
                setCommitmentAmount(value);
                setSaved(null);
              }}
            />
            <label
              className="block text-xs font-semibold"
              htmlFor="manual-commitment-date"
            >
              Due date
              <input
                id="manual-commitment-date"
                type="date"
                value={commitmentDate}
                onChange={(event) => {
                  setCommitmentDate(event.target.value);
                  setSaved(null);
                }}
                className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-pencil"
              />
            </label>
          </div>
          <Button
            variant="outline"
            className="mt-3 w-full"
            disabled={
              saving !== null ||
              !commitment.trim() ||
              commitmentAmount <= 0 ||
              !commitmentDate
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
                      ? `${formatDate(item.dueDate)} · ${sourceLabel(item.provenance)}`
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
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="mt-3 block text-xs font-semibold" htmlFor={id}>
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
