import { Link } from "react-router-dom";
import { CheckCircle2, ChevronRight, ReceiptText } from "lucide-react";
import { MobileShell } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { useAppState } from "@/state/app-state";
import { money } from "@/lib/utils";

export function ReviewPage() {
  const { cases } = useAppState();
  const currentCases = cases.filter((item) =>
    ["open", "decided", "awaiting_verification"].includes(item.status),
  );
  return (
    <MobileShell>
      <main className="px-4 pb-8 pt-5">
        <p className="eyebrow">Exception queue</p>
        <div className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-[31px] font-bold leading-tight tracking-[-0.04em]">Review</h1>
            <p className="mt-1 text-sm text-muted">Items that need your decision will appear here.</p>
          </div>
          <Badge>{currentCases.length ? `${currentCases.length} current` : "Current"}</Badge>
        </div>
        {currentCases.length ? (
          <div className="mt-5 overflow-hidden rounded-[22px] border border-ink/10 bg-white">
            {currentCases.map((item) => (
              <Link key={item.id} to={`/review/${item.id}`} className="flex min-h-[82px] items-center gap-3 border-b border-ink/8 px-4 py-3 last:border-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cobalt">
                <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-paper-deep text-cobalt"><ReceiptText className="size-5" strokeWidth={1.8}/></span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2"><span className="truncate text-sm font-semibold">{item.title}</span>{item.observedAmount&&<span className="ml-auto text-sm font-bold tabular-nums">{money(Number(item.observedAmount.minor)/100)}</span>}</span>
                  <span className="mt-1 block truncate text-xs text-muted">{item.evidence.length} evidence record{item.evidence.length===1?"":"s"}</span>
                  <span className="mt-1 block text-[11px] font-bold uppercase tracking-[.08em] text-cobalt">{item.status.replace(/_/g," ")}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted"/>
              </Link>
            ))}
          </div>
        ) : (
          <div className="mt-5 rounded-[22px] border border-dashed border-rule bg-white p-6 text-center">
            <CheckCircle2 className="mx-auto size-7 text-leaf"/>
            <p className="mt-3 text-sm font-semibold">Nothing needs review</p>
            <p className="mt-1 text-xs leading-5 text-muted">Budgefi checks current connected and manual transactions for exact duplicate charges. New supported detectors will appear here as they are added.</p>
          </div>
        )}
      </main>
    </MobileShell>
  );
}
