import { useMemo, useState } from "react";
import { Check, ListPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import type { CustomCommitment } from "@/state/app-state";
import { cn } from "@/lib/utils";
import {
  commonBillStarters,
  type CommonBillStarterKey,
} from "@/lib/common-bill-starters";

export function CommonBillsSheet({
  existingNames,
  existingKeys = [],
  onAdd,
  disabled = false,
}: {
  existingNames: string[];
  existingKeys?: CommonBillStarterKey[];
  onAdd: (items: CustomCommitment[]) => Promise<boolean> | boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<CommonBillStarterKey[]>([]);
  const [saving, setSaving] = useState(false);
  const normalized = useMemo(
    () => new Set(existingNames.map((name) => name.trim().toLocaleLowerCase())),
    [existingNames],
  );
  const available = commonBillStarters.filter(
    (item) =>
      !existingKeys.includes(item.key) &&
      !normalized.has(item.name.toLocaleLowerCase()),
  );
  const add = async () => {
    setSaving(true);
    const stamp = Date.now().toString(36);
    const okay = await onAdd(
      available
        .filter((item) => selected.includes(item.key))
        .map((item, index) => ({
          id: `starter-${stamp}-${index}`,
          name: item.name,
          amount: 0,
          dueDate: "",
          recurrence: "monthly" as const,
          starterItemKey: item.key,
        })),
    );
    setSaving(false);
    if (okay) {
      setSelected([]);
      setOpen(false);
    }
  };
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled} className="bg-white">
          <ListPlus className="size-4" /> Add common bills
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" className="mx-auto max-w-[430px] rounded-t-[28px]">
        <SheetHeader>
          <SheetTitle>Add common bills</SheetTitle>
          <SheetDescription>
            Choose only what applies. Budgefi saves empty rows for you to complete, but Available to use won’t change until you enter amounts and dates.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-5 space-y-2">
          {available.map((item) => {
            const checked = selected.includes(item.key);
            return (
              <button
                key={item.key}
                type="button"
                aria-pressed={checked}
                onClick={() =>
                  setSelected((value) =>
                    checked ? value.filter((key) => key !== item.key) : [...value, item.key],
                  )
                }
                className={cn(
                  "flex min-h-14 w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left",
                  checked ? "border-cobalt bg-cobalt/[.05]" : "border-rule bg-white",
                )}
              >
                <span className={cn("grid size-6 place-items-center rounded-full border", checked ? "border-cobalt bg-cobalt text-white" : "border-rule")}>
                  {checked && <Check className="size-4" />}
                </span>
                <span className="min-w-0 flex-1">
                  <strong className="block text-sm">{item.name}</strong>
                  <span className="block text-xs text-muted">{item.detail}</span>
                </span>
              </button>
            );
          })}
          {available.length === 0 && (
            <p className="rounded-2xl bg-recessed p-4 text-sm text-muted">All common bill rows are already in your plan.</p>
          )}
        </div>
        <Button type="button" className="mt-5 w-full" size="lg" disabled={saving || selected.length === 0} onClick={() => void add()}>
          {saving ? "Adding…" : `Add ${selected.length || ""} ${selected.length === 1 ? "bill row" : "bill rows"}`}
        </Button>
      </SheetContent>
    </Sheet>
  );
}
