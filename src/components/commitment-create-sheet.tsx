import { useState } from "react";
import { Check, Plus } from "lucide-react";
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
import { useAppState } from "@/state/app-state";

export function CommitmentCreateSheet() {
  const state = useAppState();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState(0);
  const [dueDate, setDueDate] = useState("");
  const [saving, setSaving] = useState(false);
  const normalizedName = name.trim().toLocaleLowerCase();
  const nameTaken = state.commitments.some(
    (item) => item.name.trim().toLocaleLowerCase() === normalizedName,
  );

  const reset = () => {
    setName("");
    setAmount(0);
    setDueDate("");
  };
  const save = async () => {
    setSaving(true);
    const okay = await state.addManualCommitment(name, amount, dueDate);
    setSaving(false);
    if (okay) {
      reset();
      setOpen(false);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset();
      }}
    >
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="shrink-0 bg-white">
          <Plus className="size-4" />
          Add
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" className="mx-auto max-w-[430px] rounded-t-[28px]">
        <SheetHeader>
          <SheetTitle>Add commitment</SheetTitle>
          <SheetDescription>
            Add any bill, subscription, household obligation, or one-time
            expense you want the plan to track.
          </SheetDescription>
        </SheetHeader>

        <label className="block text-sm font-semibold" htmlFor="new-commitment-name">
          Name
        </label>
        <input
          id="new-commitment-name"
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          placeholder="Phone bill"
          className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-base font-semibold outline-none focus:ring-2 focus:ring-pencil"
        />
        {nameTaken && (
          <p className="mt-2 text-xs font-semibold text-coral">
            Use a unique name for each commitment.
          </p>
        )}

        <label className="mt-5 block text-sm font-semibold" htmlFor="new-commitment-amount">
          Expected amount
        </label>
        <div className="mt-2 flex h-12 items-center rounded-xl border border-rule bg-white px-3 focus-within:ring-2 focus-within:ring-pencil">
          <span className="text-muted">$</span>
          <NumberInput
            id="new-commitment-amount"
            value={amount}
            onValueChange={setAmount}
            min={0}
            step="0.01"
            inputMode="decimal"
            className="h-full min-w-0 flex-1 bg-transparent px-2 text-lg font-bold outline-none"
          />
        </div>

        <label className="mt-4 block text-sm font-semibold" htmlFor="new-commitment-date">
          Due date <span className="font-normal text-muted">(optional)</span>
        </label>
        <input
          id="new-commitment-date"
          type="date"
          value={dueDate}
          onChange={(event) => setDueDate(event.target.value)}
          className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-base outline-none focus:ring-2 focus:ring-pencil"
        />
        <p className="mt-2 text-xs leading-5 text-muted">
          Without a date, Budgefi tracks the commitment but does not reserve it
          from available cash yet.
        </p>

        <Button
          disabled={saving || !name.trim() || nameTaken || amount <= 0}
          onClick={() => void save()}
          className="mt-5 w-full"
          size="lg"
        >
          {saving ? (
            "Adding…"
          ) : (
            <>
              <Check className="size-4" />
              Add commitment
            </>
          )}
        </Button>
      </SheetContent>
    </Sheet>
  );
}
