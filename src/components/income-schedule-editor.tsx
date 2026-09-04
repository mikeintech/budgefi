import { useEffect, useState } from "react";
import { CalendarClock, Pause, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { Switch } from "@/components/ui/switch";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  useAppState,
  type IncomeFrequency,
  type IncomeSchedule,
} from "@/state/app-state";
import { cn, money as formatMoney } from "@/lib/utils";
import { SchedulePreview } from "@/components/schedule-preview";

export function IncomeScheduleList({ compact = false }: { compact?: boolean }) {
  const state = useAppState();
  const schedules = state.incomeSchedules.filter(
    (item) => item.status !== "archived",
  );
  return (
    <div className="space-y-2">
      {schedules.map((item) => {
        const drivesPlan =
          state.horizonBasis === "expected_income" &&
          item.id === state.horizonIncomeScheduleId;
        const missed =
          state.horizonMissedIncome &&
          item.id === state.horizonIncomeScheduleId;
        return (
          <article
            key={item.id}
            className={cn(
              "rounded-2xl border bg-white",
              drivesPlan ? "border-cobalt/25" : "border-rule",
              compact ? "p-3" : "p-4",
            )}
          >
            <div className="flex items-center gap-3">
              <span
                className={cn(
                  "grid size-10 shrink-0 place-items-center rounded-2xl",
                  drivesPlan
                    ? "bg-cobalt text-white"
                    : "bg-recessed text-pencil",
                )}
              >
                <CalendarClock className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-sm">{item.name}</strong>
                <span className="block text-xs leading-5 text-muted">
                  {item.status === "paused"
                    ? "Paused"
                    : item.confirmed && item.nextExpectedDate
                      ? `${formatDate(item.nextExpectedDate)} · ${frequencyLabel(item.frequency)}`
                      : item.nextExpectedDate
                        ? `${formatDate(item.nextExpectedDate)} · not used for planning`
                        : "No reliable next date"}
                </span>
              </span>
              <span className="shrink-0 text-right">
                {item.expectedAmount && (
                  <strong className="block text-sm tabular-nums">
                    {formatMoney(Number(item.expectedAmount.minor) / 100)}
                  </strong>
                )}
                <IncomeScheduleEditor schedule={item} compact />
              </span>
            </div>
            {drivesPlan && (
              <p className="mt-2 text-[11px] font-semibold text-cobalt">
                Earliest reliable income · sets this plan’s end date
              </p>
            )}
            {missed && (
              <p className="mt-2 rounded-xl bg-amber-50 p-2 text-xs text-amber-800">
                This income is overdue. Budgefi is using the fallback window
                through {formatDate(state.authoritativeProjection.horizonEnd)}.
              </p>
            )}
            {item.reviewReason === "destination_disconnected" && (
              <p className="mt-2 rounded-xl bg-amber-50 p-2 text-xs text-amber-800">
                Its bank account was disconnected. Review the destination and
                date before using it for planning.
              </p>
            )}
          </article>
        );
      })}
      {schedules.length === 0 && (
        <div className="rounded-2xl border border-dashed border-rule p-4 text-center">
          <strong className="block text-sm">No expected income added</strong>
          <p className="mt-1 text-xs leading-5 text-muted">
            That’s okay. Budgefi uses your fallback window and never assumes
            future cash.
          </p>
        </div>
      )}
    </div>
  );
}

export function IncomeScheduleEditor({
  schedule,
  compact = false,
}: {
  schedule?: IncomeSchedule;
  compact?: boolean;
}) {
  const state = useAppState();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("Paycheck");
  const [amount, setAmount] = useState(0);
  const [frequency, setFrequency] = useState<IncomeFrequency>("biweekly");
  const [nextDate, setNextDate] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [destination, setDestination] = useState("");
  const [firstDay, setFirstDay] = useState(1);
  const [firstEom, setFirstEom] = useState(false);
  const [secondDay, setSecondDay] = useState(15);
  const [secondEom, setSecondEom] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(schedule?.name ?? "Paycheck");
    setAmount(
      schedule?.expectedAmount
        ? Number(schedule.expectedAmount.minor) / 100
        : 0,
    );
    setFrequency(schedule?.frequency ?? "biweekly");
    setNextDate(schedule?.nextExpectedDate ?? "");
    setConfirmed(schedule?.confirmed ?? false);
    setDestination(schedule?.destinationAccountId ?? "");
    setFirstDay(
      schedule?.anchorDay ?? dateDay(schedule?.nextExpectedDate) ?? 1,
    );
    setFirstEom(schedule?.anchorEndOfMonth ?? false);
    setSecondDay(schedule?.secondAnchorDay ?? 15);
    setSecondEom(schedule?.secondAnchorEndOfMonth ?? false);
    setMessage("");
  }, [open, schedule]);

  const accounts = state.accounts.filter((account) =>
    ["cash", "checking", "savings"].includes(account.type),
  );
  const canSave =
    Boolean(name.trim()) &&
    (!confirmed || Boolean(nextDate)) &&
    (frequency !== "semi_monthly" ||
      ((!firstEom || !secondEom) &&
        (firstEom || secondEom || firstDay !== secondDay))) &&
    (frequency !== "semi_monthly" ||
      !(firstEom || firstDay >= 28) ||
      !(secondEom || secondDay >= 28)) &&
    !saving;
  const money =
    amount > 0
      ? { minor: String(Math.round(amount * 100)), currency: "USD" as const }
      : null;
  const payload = (status: "active" | "paused" | "archived" = "active") => ({
    destinationAccountId: destination || null,
    name: name.trim(),
    expectedAmount: money,
    frequency,
    nextExpectedDate: nextDate || null,
    confirmed: status === "active" && confirmed,
    anchorDay: frequency === "semi_monthly" ? firstDay : dateDay(nextDate),
    anchorEndOfMonth: frequency === "semi_monthly" ? firstEom : false,
    secondAnchorDay: frequency === "semi_monthly" ? secondDay : null,
    secondAnchorEndOfMonth: frequency === "semi_monthly" && secondEom,
    status,
  });
  const save = async (status: "active" | "paused" | "archived" = "active") => {
    if (!canSave && status === "active") return;
    setSaving(true);
    setMessage("");
    const values = payload(status);
    const okay = schedule
      ? await state.updateIncomeSchedule(schedule, values)
      : await state.createIncomeSchedule(
          (({ status: _status, ...create }) => create)(values),
        );
    setSaving(false);
    if (okay) setOpen(false);
    else
      setMessage(
        "This income schedule could not be saved. Review it and try again.",
      );
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        {schedule ? (
          <Button size="sm" variant="ghost">
            {schedule.reviewReason ? "Review" : "Edit"}
          </Button>
        ) : (
          <Button
            size={compact ? "sm" : "default"}
            variant={compact ? "ghost" : "outline"}
          >
            <Plus className="size-4" />{" "}
            {state.incomeSchedules.some((item) => item.status !== "archived")
              ? "Add another income"
              : "Add income"}
          </Button>
        )}
      </SheetTrigger>
      <SheetContent side="bottom">
        <SheetHeader>
          <SheetTitle>
            {schedule ? `Edit ${schedule.name}` : "Add expected income"}
          </SheetTitle>
          <SheetDescription>
            This helps choose how far ahead to plan. It never adds money before
            a deposit is received.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4">
          <Field label="Name">
            <input
              className={inputClass}
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              placeholder="Employer, pension, client…"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Typical amount · optional">
              <div className="flex h-12 items-center rounded-xl border border-rule bg-white px-3 focus-within:ring-2 focus-within:ring-pencil">
                <span className="text-muted">$</span>
                <NumberInput
                  min={0}
                  value={amount}
                  onValueChange={setAmount}
                  className="h-full min-w-0 flex-1 px-2 text-base font-bold outline-none"
                />
              </div>
            </Field>
            <Field label="Next expected · optional">
              <input
                type="date"
                className={inputClass}
                value={nextDate}
                onChange={(event) => {
                  setNextDate(event.target.value);
                  if (!event.target.value) setConfirmed(false);
                  else setFirstDay(dateDay(event.target.value) ?? 1);
                }}
              />
            </Field>
          </div>
          <Field label="How often">
            <select
              className={inputClass}
              value={frequency}
              onChange={(event) => {
                const next = event.target.value as IncomeFrequency;
                setFrequency(next);
                if (next === "irregular") setConfirmed(false);
              }}
            >
              <option value="weekly">Weekly</option>
              <option value="biweekly">Every two weeks</option>
              <option value="semi_monthly">Twice a month</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Every three months</option>
              <option value="annual">Yearly</option>
              <option value="irregular">Irregular or unknown</option>
            </select>
          </Field>
          <SchedulePreview firstDate={nextDate} cadence={frequency} />
          {frequency === "semi_monthly" && (
            <div className="rounded-2xl bg-recessed p-3">
              <p className="text-xs font-semibold">Usual pay days</p>
              <p className="mt-1 text-xs leading-5 text-muted">
                Choose both anchors. End of month handles February and shorter
                months safely.
              </p>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Anchor
                  label="First"
                  value={firstDay}
                  eom={firstEom}
                  onValue={setFirstDay}
                  onEom={setFirstEom}
                />
                <Anchor
                  label="Second"
                  value={secondDay}
                  eom={secondEom}
                  onValue={setSecondDay}
                  onEom={setSecondEom}
                />
              </div>
              {((firstEom && secondEom) ||
                (!firstEom && !secondEom && firstDay === secondDay)) && (
                <p className="mt-2 text-xs font-semibold text-coral">
                  Choose two different pay days.
                </p>
              )}
              {(firstEom || firstDay >= 28) &&
                (secondEom || secondDay >= 28) && (
                  <p className="mt-2 text-xs font-semibold text-coral">
                    Choose at least one pay day from 1 through 27 so February
                    still has two deposits.
                  </p>
                )}
            </div>
          )}
          <Field label="Usually deposited to · optional">
            <select
              className={inputClass}
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
            >
              <option value="">Any account</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                  {account.planningRole === "protected" ? " · protected" : ""}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex min-h-16 items-center justify-between gap-3 rounded-2xl border border-rule p-3">
            <span className="flex min-w-0 items-start gap-3">
              <CalendarClock className="mt-0.5 size-5 shrink-0 text-cobalt" />
              <span>
                <strong className="block text-sm">
                  Use this date for my plan
                </strong>
                <span className="block text-xs leading-5 text-muted">
                  The earliest reliable income date sets the horizon.
                </span>
              </span>
            </span>
            <Switch
              checked={confirmed}
              disabled={!nextDate || frequency === "irregular"}
              onCheckedChange={setConfirmed}
              label="Use this date for my plan"
            />
          </div>
          <p className="text-xs leading-5 text-muted">
            The typical amount helps match deposits only. Future income is never
            spendable cash.
          </p>
          {message && (
            <p role="alert" className="text-sm text-coral">
              {message}
            </p>
          )}
          <Button
            className="w-full"
            size="lg"
            disabled={!canSave}
            onClick={() => void save("active")}
          >
            {saving ? "Saving…" : schedule ? "Save income" : "Add income"}
          </Button>
          {schedule && schedule.status !== "paused" && (
            <Button
              className="w-full"
              variant="ghost"
              disabled={saving}
              onClick={() => void save("paused")}
            >
              <Pause className="size-4" /> Pause this income
            </Button>
          )}
          {schedule?.status === "paused" && (
            <Button
              className="w-full"
              variant="outline"
              disabled={
                saving ||
                !nextDate ||
                nextDate < state.authoritativeProjection.horizonStart ||
                frequency === "irregular"
              }
              onClick={() => {
                setConfirmed(true);
                void saveIncomeWithConfirmation();
              }}
            >
              {nextDate &&
              nextDate >= state.authoritativeProjection.horizonStart &&
              frequency !== "irregular"
                ? "Resume and use for plan"
                : "Choose a current date to resume"}
            </Button>
          )}
          {schedule && (
            <Button
              className="w-full text-coral"
              variant="ghost"
              disabled={saving}
              onClick={() => void save("archived")}
            >
              Stop tracking this income
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );

  async function saveIncomeWithConfirmation() {
    setSaving(true);
    setMessage("");
    if (!schedule) return;
    const values = { ...payload("active"), confirmed: true };
    const okay = await state.updateIncomeSchedule(schedule, values);
    setSaving(false);
    if (okay) setOpen(false);
    else
      setMessage(
        "This income schedule could not be saved. Review it and try again.",
      );
  }
}

function dateDay(value?: string | null) {
  if (!value) return null;
  const day = Number(value.slice(8, 10));
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : null;
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}
function frequencyLabel(value: IncomeFrequency) {
  return value === "weekly"
    ? "weekly"
    : value === "biweekly"
      ? "every two weeks"
      : value === "semi_monthly"
        ? "twice monthly"
        : value === "monthly"
          ? "monthly"
          : value === "quarterly"
            ? "every three months"
            : value === "annual"
              ? "yearly"
              : "irregular";
}

function Anchor({
  label,
  value,
  eom,
  onValue,
  onEom,
}: {
  label: string;
  value: number;
  eom: boolean;
  onValue: (value: number) => void;
  onEom: (value: boolean) => void;
}) {
  return (
    <div>
      <label className="text-[11px] font-semibold">
        {label}
        <select
          className={`${inputClass} mt-2`}
          value={eom ? "eom" : String(value)}
          onChange={(event) => {
            if (event.target.value === "eom") onEom(true);
            else {
              onEom(false);
              onValue(Number(event.target.value));
            }
          }}
        >
          <option value="eom">End of month</option>
          {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
            <option key={day} value={day}>
              {day}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

const inputClass =
  "h-12 w-full rounded-xl border border-rule bg-white px-3 text-sm font-semibold outline-none focus:ring-2 focus:ring-pencil";
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-xs font-semibold">
      {label}
      <div className="mt-2">{children}</div>
    </label>
  );
}
