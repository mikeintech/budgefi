import { useState } from "react";
import { Check, Pencil, Trash2 } from "lucide-react";
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
import { nextMonthlyDate } from "@/lib/dates";
import {
  useAppState,
  type PlanCalibrationData,
  type PlanCommitment,
} from "@/state/app-state";
import { SchedulePreview } from "@/components/schedule-preview";

const fixedSlots = {
  housing: {
    id: "rentId",
    name: "rentName",
    amount: "rentAmount",
    date: "rentDueDate",
    recurrence: "rentRecurrence",
    day: 1,
  },
  utilities: {
    id: "electricId",
    name: "electricName",
    amount: "electricMax",
    date: "electricDueDate",
    recurrence: "electricRecurrence",
    day: 10,
  },
  subscriptions: {
    id: "streamBoxId",
    name: "streamBoxName",
    amount: "streamBoxAmount",
    date: "streamBoxDueDate",
    recurrence: "streamBoxRecurrence",
    day: 15,
  },
  insurance: {
    id: "insuranceId",
    name: "insuranceName",
    amount: "insuranceAmount",
    date: "insuranceDueDate",
    recurrence: "insuranceRecurrence",
    day: 20,
  },
} as const;
const legacyFixedSlots = {
  rent: "housing",
  electric: "utilities",
  streambox: "subscriptions",
  subscriptions: "subscriptions",
  insurance: "insurance",
} as const;

export function CommitmentEditor({
  item,
  compact = false,
}: {
  item: PlanCommitment;
  compact?: boolean;
}) {
  const state = useAppState();
  const legacySlot =
    legacyFixedSlots[item.name.toLowerCase() as keyof typeof legacyFixedSlots];
  const resolvedSlot =
    item.setupSlot ??
    (legacySlot && state.calibration[fixedSlots[legacySlot].id] === item.id
      ? legacySlot
      : undefined);
  const fixed = resolvedSlot ? fixedSlots[resolvedSlot] : undefined;
  const initialDate =
    item.dueDate ??
    (item.starterItemKey
      ? ""
      : fixed
        ? nextMonthlyDate(state.authoritativeProjection.horizonStart, fixed.day)
        : state.authoritativeProjection.horizonEnd);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(item.name);
  const [amount, setAmount] = useState(Number(BigInt(item.amount.minor)) / 100);
  const [dueDate, setDueDate] = useState(initialDate);
  const [recurrence, setRecurrence] = useState(item.recurrence);
  const [saving, setSaving] = useState(false);
  const normalizedName = name.trim().toLocaleLowerCase();
  const nameTaken = state.commitments.some(
    (entry) =>
      entry.id !== item.id &&
      normalizedName !== item.name.trim().toLocaleLowerCase() &&
      entry.name.trim().toLocaleLowerCase() === normalizedName,
  );
  const resetDraft = () => {
    setName(item.name);
    setAmount(Number(BigInt(item.amount.minor)) / 100);
    setDueDate(initialDate);
    setRecurrence(item.recurrence);
  };
  const updateCalibration = (remove = false): PlanCalibrationData => {
    if (fixed) {
      const edited = state.calibration.editedCommitments.includes(fixed.amount)
        ? state.calibration.editedCommitments
        : [...state.calibration.editedCommitments, fixed.amount];
      const withoutCurrent = state.calibration.customCommitments.filter(
        (entry) => entry.id !== item.id,
      );
      return {
        ...state.calibration,
        [fixed.id]: remove ? null : item.id,
        [fixed.name]: name.trim(),
        [fixed.amount]: remove ? 0 : amount,
        [fixed.date]: remove ? "" : dueDate,
        [fixed.recurrence]: recurrence,
        editedCommitments: edited,
        customCommitments: withoutCurrent,
      };
    }
    const exists = state.calibration.customCommitments.some(
      (entry) => entry.id === item.id,
    );
    return {
      ...state.calibration,
      customCommitments: remove
        ? state.calibration.customCommitments.filter(
            (entry) => entry.id !== item.id,
          )
        : exists
          ? state.calibration.customCommitments.map((entry) =>
              entry.id === item.id
                ? { ...entry, name: name.trim(), amount, dueDate, recurrence }
                : entry,
            )
          : [
              ...state.calibration.customCommitments,
              { id: item.id, name: name.trim(), amount, dueDate, recurrence },
            ],
    };
  };
  const persist = async (remove = false) => {
    setSaving(true);
    const okay = await state.savePlanCalibration(
      updateCalibration(remove),
      state.planningBuffer,
    );
    setSaving(false);
    if (okay) setOpen(false);
  };
  if (item.provenance !== "manual") return null;
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) resetDraft();
      }}
    >
      <SheetTrigger asChild>
        <Button
          aria-label={`Edit ${item.name}`}
          variant="ghost"
          size="sm"
          className={
            compact
              ? "h-9 px-2.5 text-[11px] text-pencil"
              : "mt-0.5 h-8 px-2 text-[11px] text-pencil"
          }
        >
          <Pencil className="size-3" />
          Edit
        </Button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        className="mx-auto max-w-[430px] rounded-t-[28px]"
      >
        <SheetHeader>
          <SheetTitle>Edit commitment</SheetTitle>
          <SheetDescription>
            Changes update the plan and remain in your activity history.
          </SheetDescription>
        </SheetHeader>
        <label
          className="mt-5 block text-sm font-semibold"
          htmlFor={`commitment-name-${item.id}`}
        >
          Name
        </label>
        <input
          id={`commitment-name-${item.id}`}
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-base font-semibold outline-none focus:ring-2 focus:ring-pencil"
        />
        {nameTaken && (
          <p className="mt-2 text-xs font-semibold text-coral">
            Use a unique name for each commitment.
          </p>
        )}
        <label
          className="mt-5 block text-sm font-semibold"
          htmlFor={`commitment-amount-${item.id}`}
        >
          Expected amount
        </label>
        <div className="mt-2 flex h-12 items-center rounded-xl border border-rule bg-white px-3 focus-within:ring-2 focus-within:ring-pencil">
          <span className="text-muted">$</span>
          <NumberInput
            id={`commitment-amount-${item.id}`}
            value={amount}
            onValueChange={setAmount}
            min={0}
            step="0.01"
            inputMode="decimal"
            className="h-full min-w-0 flex-1 bg-transparent px-2 text-lg font-bold outline-none"
          />
        </div>
        <label
          className="mt-4 block text-sm font-semibold"
          htmlFor={`commitment-date-${item.id}`}
        >
          Due date <span className="font-normal text-muted">(optional)</span>
        </label>
        <input
          id={`commitment-date-${item.id}`}
          type="date"
          value={dueDate}
          onChange={(event) => setDueDate(event.target.value)}
          className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-base outline-none focus:ring-2 focus:ring-pencil"
        />
        {!dueDate && (
          <p className="mt-2 text-xs text-muted">
            This stays visible but is not reserved until it has a due date.
          </p>
        )}
        <label
          className="mt-4 block text-sm font-semibold"
          htmlFor={`commitment-repeat-${item.id}`}
        >
          Repeats
        </label>
        <select
          id={`commitment-repeat-${item.id}`}
          value={recurrence}
          onChange={(event) =>
            setRecurrence(event.target.value as typeof recurrence)
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
        <SchedulePreview firstDate={dueDate} cadence={recurrence} />
        <Button
          disabled={saving || !name.trim() || nameTaken || amount <= 0}
          onClick={() => void persist()}
          className="mt-5 w-full"
          size="lg"
        >
          <Check className="size-4" />
          {saving ? "Saving…" : "Save commitment"}
        </Button>
        <Button
          disabled={saving}
          variant="ghost"
          onClick={() => void persist(true)}
          className="mt-2 w-full text-coral"
        >
          <Trash2 className="size-4" />
          Remove commitment
        </Button>
      </SheetContent>
    </Sheet>
  );
}
