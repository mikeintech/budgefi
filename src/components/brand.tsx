import { cn } from "@/lib/utils";
import budgefiMarkUrl from "../../assets/brand/budgefi-mark.svg";

export function BudgefiMark({
  className,
  decorative = false,
}: {
  className?: string;
  decorative?: boolean;
}) {
  return (
    <img
      src={budgefiMarkUrl}
      className={cn("size-8", className)}
      alt={decorative ? "" : "Budgefi"}
    />
  );
}

export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <BudgefiMark className="size-[30px] shrink-0" decorative />
      <span
        className={cn(
          "text-[21px] font-bold leading-none tracking-[-.045em]",
          compact && "hidden min-[360px]:inline",
        )}
      >
        budgefi
      </span>
    </div>
  );
}
