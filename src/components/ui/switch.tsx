import { cn } from "@/lib/utils";

export function Switch({ checked, onCheckedChange, label, disabled = false }: { checked: boolean; onCheckedChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative h-11 w-14 shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil disabled:opacity-40",
      )}
    >
      <span className={cn("absolute inset-x-1 top-2 h-7 rounded-full border transition-colors", checked ? "border-pencil bg-pencil" : "border-rule bg-recessed")}>
        <span className={cn("absolute left-0 top-0.5 size-[22px] rounded-full bg-white shadow-sm transition-transform", checked ? "translate-x-[24px]" : "translate-x-0.5")} />
      </span>
    </button>
  );
}
