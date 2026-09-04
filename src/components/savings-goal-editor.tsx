import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarDays, Landmark, PenLine, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useAppState, type SavingsGoal } from "@/state/app-state";
import { money } from "@/lib/utils";
import { SchedulePreview } from "@/components/schedule-preview";

export function SavingsGoalEditor({
  goal,
  compact = false,
  simple = false,
}: {
  goal?: SavingsGoal;
  compact?: boolean;
  simple?: boolean;
}) {
  const state = useAppState();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(goal?.name ?? "Emergency fund");
  const [target, setTarget] = useState(
    goal?.targetAmount ? Number(goal.targetAmount.minor) / 100 : 0,
  );
  const [contribution, setContribution] = useState(
    goal ? Number(goal.contributionAmount.minor) / 100 : 0,
  );
  const [targetDate, setTargetDate] = useState(goal?.targetDate ?? "");
  const [schedule, setSchedule] = useState<SavingsGoal["schedule"]>(
    goal?.schedule ?? "planning_period",
  );
  const [nextDueOn, setNextDueOn] = useState(goal?.nextDueOn ?? "");
  const [destination, setDestination] = useState(
    goal?.destination?.accountId ?? (goal ? "later" : "manual"),
  );
  const [useBalance, setUseBalance] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!open) return;
    setName(goal?.name ?? "Emergency fund");
    setTarget(goal?.targetAmount ? Number(goal.targetAmount.minor) / 100 : 0);
    setContribution(goal ? Number(goal.contributionAmount.minor) / 100 : 0);
    setTargetDate(goal?.targetDate ?? "");
    setSchedule(goal?.schedule ?? "planning_period");
    setNextDueOn(goal?.nextDueOn ?? "");
    setDestination(goal?.destination?.accountId ?? (goal ? "later" : "manual"));
    setUseBalance(false);
    setMessage("");
  }, [goal, open]);
  const usedDestinations = useMemo(
    () =>
      new Set(
        state.savingsGoals
          .filter((item) => item.id !== goal?.id && item.status !== "archived")
          .flatMap((item) =>
            item.destination ? [item.destination.accountId] : [],
          ),
      ),
    [goal?.id, state.savingsGoals],
  );
  const eligibleAccounts = state.accounts.filter(
    (account) =>
      !usedDestinations.has(account.id) && account.type === "savings",
  );
  const selectedAccount = eligibleAccounts.find(
    (account) => account.id === destination,
  );
  const destinationChanged =
    !goal || destination !== (goal.destination?.accountId ?? "later");
  const recoveringDestination =
    Boolean(goal) && goal?.status === "paused" && !goal.destination;
  const hasDestination = destination !== "later";
  const canSave =
    name.trim().length > 0 &&
    target >= 0 &&
    (contribution <= 0 || hasDestination) &&
    (schedule === "planning_period" || Boolean(nextDueOn)) &&
    !saving;
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setMessage("");
    const common = {
      name: name.trim(),
      targetAmount:
        target > 0
          ? {
              minor: String(Math.round(target * 100)),
              currency: "USD" as const,
            }
          : null,
      targetDate: targetDate || null,
      contributionAmount: {
        minor: String(Math.round(Math.max(0, contribution) * 100)),
        currency: "USD" as const,
      },
      schedule,
      nextDueOn: schedule === "planning_period" ? null : nextDueOn,
      destinationAccountId:
        destination === "manual" || destination === "later"
          ? null
          : destination,
    };
    const okay = goal
      ? await state.updateSavingsGoal(goal, {
          ...common,
          status:
            recoveringDestination && hasDestination ? "active" : goal.status,
          useCurrentDestinationBalance:
            Boolean(selectedAccount) && destinationChanged && useBalance,
        })
      : await state.createSavingsGoal({
          ...common,
          trackManually: destination === "manual",
          useCurrentDestinationBalance:
            destination !== "manual" && destination !== "later" && useBalance,
        });
    setSaving(false);
    if (okay) setOpen(false);
    else
      setMessage(
        "The goal could not be saved. Review the fields and try again.",
      );
  };
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        {goal ? (
          <Button
            size="sm"
            variant={recoveringDestination ? "outline" : "ghost"}
            aria-label={
              recoveringDestination
                ? `Choose new savings account for ${goal.name}`
                : `Edit ${goal.name}`
            }
          >
            {recoveringDestination ? "Repair" : "Edit"}
          </Button>
        ) : (
          <Button
            size={compact ? "sm" : "default"}
            variant={compact ? "ghost" : "outline"}
          >
            <Plus className="size-4" /> Add goal
          </Button>
        )}
      </SheetTrigger>
      <SheetContent side="bottom" className="max-h-[92dvh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>
            {goal ? `Edit ${goal.name}` : "Set up a savings goal"}
          </SheetTitle>
          <SheetDescription>
            A goal tracks progress. The plan contribution below only reserves
            money—it never moves it.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-5 space-y-4">
          <Field label="What are you saving for?">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-12 w-full rounded-xl border border-rule bg-white px-3 text-base font-semibold outline-none focus:ring-2 focus:ring-pencil"
              maxLength={120}
            />
          </Field>
          {!simple && (
            <div className="grid grid-cols-2 gap-3">
              <MoneyField
                label="Total target · optional"
                value={target}
                onChange={setTarget}
              />
              <Field label="Target date · optional">
                <input
                  type="date"
                  value={targetDate}
                  onChange={(event) => setTargetDate(event.target.value)}
                  className="h-12 w-full rounded-xl border border-rule bg-white px-3 text-sm font-semibold outline-none focus:ring-2 focus:ring-pencil"
                />
              </Field>
            </div>
          )}
          <MoneyField
            label="Set aside before the next payday · optional"
            value={contribution}
            onChange={setContribution}
          />
          <p className="-mt-2 text-xs leading-5 text-muted">
            {contribution > 0
              ? `${money(contribution)} stays reserved in spendable cash until Budgefi confirms it reached the destination.`
              : "Choose $0 to track progress without reserving anything in this plan."}
          </p>
          {!simple && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Contribution timing">
                <select
                  value={schedule}
                  onChange={(event) => {
                    const next = event.target.value as SavingsGoal["schedule"];
                    setSchedule(next);
                    if (next === "planning_period") setNextDueOn("");
                  }}
                  className="h-12 w-full rounded-xl border border-rule bg-white px-3 text-sm font-semibold outline-none focus:ring-2 focus:ring-pencil"
                >
                  <option value="planning_period">Before next payday</option>
                  <option value="one_time">One time</option>
                  <option value="weekly">Weekly</option>
                  <option value="biweekly">Every two weeks</option>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Every three months</option>
                  <option value="annual">Yearly</option>
                </select>
              </Field>
              {schedule !== "planning_period" && (
                <Field label="Next contribution">
                  <input
                    type="date"
                    value={nextDueOn}
                    max={targetDate || undefined}
                    onChange={(event) => setNextDueOn(event.target.value)}
                    className="h-12 w-full rounded-xl border border-rule bg-white px-2 text-sm font-semibold outline-none focus:ring-2 focus:ring-pencil"
                  />
                </Field>
              )}
            </div>
          )}
          {!simple && (
            <SchedulePreview firstDate={nextDueOn} cadence={schedule} />
          )}
          <Field label="Where will you keep it?">
            <select
              value={destination}
              onChange={(event) => {
                const next = event.target.value;
                setDestination(next);
                if (next === "later") setContribution(0);
                setUseBalance(false);
              }}
              className="h-12 w-full rounded-xl border border-rule bg-white px-3 text-sm font-semibold outline-none focus:ring-2 focus:ring-pencil"
            >
              {!goal && (
                <option value="manual">Track the balance manually</option>
              )}
              <option value="later">Choose an account later</option>
              {eligibleAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name} ·{" "}
                  {account.provenance === "plaid" ? "connected" : "manual"}
                </option>
              ))}
            </select>
          </Field>
          {recoveringDestination && eligibleAccounts.length === 0 && (
            <p className="rounded-2xl border border-coral/20 bg-coral/[.05] p-3 text-xs leading-5 text-muted">
              No connected savings account is available. Reconnect the bank in{" "}
              <Link
                className="font-bold text-cobalt underline"
                to="/connections"
              >
                Accounts &amp; data
              </Link>
              , then return here to resume this goal.
            </p>
          )}
          {selectedAccount && destinationChanged && (
            <div className="flex items-center justify-between gap-3 rounded-2xl bg-recessed p-3">
              <span className="min-w-0">
                <strong className="block text-sm">
                  Count its full current balance
                </strong>
                <span className="block text-xs leading-5 text-muted">
                  Explicitly count {selectedAccount.name} as this goal’s opening
                  progress.
                </span>
              </span>
              <Switch
                checked={useBalance}
                onCheckedChange={setUseBalance}
                label="Use current account balance"
              />
            </div>
          )}
          {selectedAccount && (
            <div className="flex gap-3 rounded-2xl border border-cobalt/15 bg-cobalt/[.04] p-3 text-xs leading-5 text-muted">
              <Landmark className="mt-0.5 size-4 shrink-0 text-cobalt" />
              <p>
                {selectedAccount.name} will become protected savings and stay
                outside safe-to-spend. Budgefi remains read-only.
              </p>
            </div>
          )}
          {message && <p className="text-sm text-coral">{message}</p>}
          {contribution > 0 && !hasDestination && (
            <p className="text-sm text-coral">
              Choose where the goal is kept before reserving a contribution.
            </p>
          )}
          <Button
            className="w-full"
            size="lg"
            disabled={!canSave}
            onClick={save}
          >
            {saving
              ? "Saving…"
              : recoveringDestination && hasDestination
                ? "Save and resume"
                : goal
                  ? "Save goal"
                  : "Create goal"}
          </Button>
          {goal && (
            <GoalStatusActions goal={goal} onDone={() => setOpen(false)} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function SavingsBalanceEditor({ goal }: { goal: SavingsGoal }) {
  const state = useAppState();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(
    Number(goal.progress.confirmed.minor) / 100,
  );
  const [saving, setSaving] = useState(false);
  if (goal.destination?.provenance !== "manual") return null;
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button size="sm" variant="outline">
          <PenLine className="size-4" /> Update balance
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom">
        <SheetHeader>
          <SheetTitle>Update {goal.name}</SheetTitle>
          <SheetDescription>
            Enter the current balance once. Budgefi records the increase or
            withdrawal for you.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-5">
          <MoneyField
            label="Current goal balance"
            value={value}
            onChange={setValue}
          />
          <p className="mt-2 flex items-center gap-2 text-xs text-muted">
            <CalendarDays className="size-4" /> Dated today · confirmed by you
          </p>
          <Button
            className="mt-5 w-full"
            size="lg"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              const okay = await state.updateSavingsGoalBalance(goal, value);
              setSaving(false);
              if (okay) setOpen(false);
            }}
          >
            {saving ? "Saving…" : "Save current balance"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function GoalStatusActions({
  goal,
  onDone,
}: {
  goal: SavingsGoal;
  onDone: () => void;
}) {
  const state = useAppState();
  const update = async (status: SavingsGoal["status"]) => {
    const okay = await state.updateSavingsGoal(goal, {
      name: goal.name,
      targetAmount: goal.targetAmount,
      targetDate: goal.targetDate,
      contributionAmount: goal.contributionAmount,
      schedule: goal.schedule,
      nextDueOn: goal.nextDueOn,
      destinationAccountId: goal.destination?.accountId ?? null,
      useCurrentDestinationBalance: false,
      status,
    });
    if (okay) onDone();
  };
  return (
    <div className="grid grid-cols-2 gap-2">
      <Button
        variant="outline"
        onClick={() =>
          void update(goal.status === "paused" ? "active" : "paused")
        }
      >
        {goal.status === "paused" ? "Resume goal" : "Pause goal"}
      </Button>
      <Button variant="ghost" onClick={() => void update("archived")}>
        Archive goal
      </Button>
    </div>
  );
}

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

function MoneyField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label}>
      <div className="flex h-12 items-center rounded-xl border border-rule bg-white px-3 focus-within:ring-2 focus-within:ring-pencil">
        <span className="text-muted">$</span>
        <NumberInput
          min={0}
          value={value}
          onValueChange={onChange}
          className="h-full min-w-0 flex-1 px-2 text-base font-bold outline-none"
        />
      </div>
    </Field>
  );
}
