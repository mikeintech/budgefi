import { Link } from "react-router-dom";
import { CheckCircle2, ChevronRight, CircleDashed, ShoppingBasket, Tv, WifiOff } from "lucide-react";
import { MobileShell } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppState } from "@/state/app-state";

function QueueRow({ to, icon: Icon, title, meta, amount, state }: { to: string; icon: typeof Tv; title: string; meta: string; amount?: string; state: string }) {
  return (
    <Link to={to} className="flex min-h-[82px] items-center gap-3 border-b border-ink/8 px-4 py-3 last:border-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cobalt">
      <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-paper-deep text-cobalt"><Icon className="size-5" strokeWidth={1.8} /></span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2"><span className="truncate text-sm font-semibold">{title}</span>{amount && <span className="ml-auto text-sm font-bold tabular-nums">{amount}</span>}</span>
        <span className="mt-1 block truncate text-xs text-muted">{meta}</span>
        <span className="mt-1 block text-[11px] font-bold uppercase tracking-[.08em] text-cobalt">{state}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted" />
    </Link>
  );
}

export function ReviewPage() {
  const { reviewSaved, grocerySaved } = useAppState();
  const openCount = (reviewSaved ? 0 : 1) + (grocerySaved ? 0 : 1);
  return (
    <MobileShell>
      <main className="px-4 pb-8 pt-5">
        <p className="eyebrow">Decision queue</p>
        <div className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-[31px] font-bold leading-tight tracking-[-0.04em]">Review</h1>
            <p className="mt-1 text-sm text-muted">Evidence first. You stay in control.</p>
          </div>
          <Badge>{openCount} open</Badge>
        </div>

        <Tabs defaultValue="input" className="mt-5">
          <TabsList aria-label="Review queue filters">
            <TabsTrigger value="input">Needs input</TabsTrigger>
            <TabsTrigger value="watching">Watching</TabsTrigger>
            <TabsTrigger value="resolved">Resolved</TabsTrigger>
          </TabsList>
          <TabsContent value="input">
            <div className="overflow-hidden rounded-[22px] border border-ink/10 bg-white">
              {!reviewSaved && <QueueRow to="/review/metronet" icon={WifiOff} title="MetroNet" meta="Expected $65 · observed $83.20" amount="+$18.20" state="Confirm what changed" />}
              {!grocerySaved && <QueueRow to="/review/grocery" icon={ShoppingBasket} title="Green Basket" meta="Two similar charges · Aug 27" amount="$47.82" state="Tell us if both are yours" />}
              {openCount === 0 && <div className="p-6 text-center"><CheckCircle2 className="mx-auto size-7 text-teal" /><p className="mt-2 text-sm font-semibold">You’re all caught up</p><p className="mt-1 text-xs text-muted">New exceptions will appear here.</p></div>}
            </div>
          </TabsContent>
          <TabsContent value="watching">
            <div className="overflow-hidden rounded-[22px] border border-ink/10 bg-white">
              <QueueRow to="/activity" icon={Tv} title="StreamBox" meta="Cancellation requested Aug 21" state="Verifying next statement" />
              {reviewSaved && <QueueRow to="/review/metronet" icon={CircleDashed} title="MetroNet" meta="Plan saved today" state="Watching next charge" />}
            </div>
          </TabsContent>
          <TabsContent value="resolved">
            <div className="rounded-[22px] border border-ink/10 bg-white p-6 text-center">
              <CheckCircle2 className="mx-auto size-7 text-teal" strokeWidth={1.8} />
              <p className="mt-3 text-sm font-semibold">{grocerySaved ? "Green Basket reviewed" : "Nothing resolved yet"}</p>
              <p className="mt-1 text-xs leading-5 text-muted">{grocerySaved ? "Your answer and matched charges remain in the proof trail." : "Completed work will keep its evidence and outcome here."}</p>
            </div>
          </TabsContent>
        </Tabs>
      </main>
    </MobileShell>
  );
}
