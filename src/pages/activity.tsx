import { CalendarClock, Check, CircleDashed, Cloud, FileCheck2, ReceiptText, ShieldCheck } from "lucide-react";
import { MobileShell } from "@/components/layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppState, type ActivityEvent } from "@/state/app-state";

const iconMap = { evidence: ReceiptText, plan: FileCheck2, source: Cloud, household: ShieldCheck } as const;

function Timeline({ events }: { events: ActivityEvent[] }) {
  return (
    <ol className="relative ml-5 border-l border-ink/15 pl-6">
      {events.map((event, index) => {
        const Icon = iconMap[event.type];
        return (
          <li key={event.id} className="relative pb-7 last:pb-1">
            <span className="absolute -left-[39px] top-0 grid size-7 place-items-center rounded-full border-4 border-paper bg-cobalt text-white"><Icon className="size-3.5" strokeWidth={2} /></span>
            <div className="-mt-0.5">
              <div className="flex items-start justify-between gap-3"><p className="text-sm font-semibold">{event.title}</p><time className="shrink-0 text-[11px] font-medium text-muted">{event.time}</time></div>
              <p className="mt-1 text-xs leading-5 text-muted">{event.detail}</p>
              {index === 0 && <span className="mt-2 inline-flex rounded-full bg-cobalt/8 px-2 py-1 text-[10px] font-bold uppercase tracking-[.08em] text-cobalt">Latest</span>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function ActivityPage() {
  const { events } = useAppState();
  return (
    <MobileShell>
      <main className="px-4 pb-8 pt-5">
        <p className="eyebrow">Proof trail</p>
        <h1 className="text-[31px] font-bold tracking-[-0.04em]">Activity</h1>
        <p className="mt-1 text-sm leading-5 text-muted">What Budgefi observed, what you decided, and what remains unverified.</p>

        <Tabs defaultValue="history" className="mt-5">
          <TabsList><TabsTrigger value="history">History</TabsTrigger><TabsTrigger value="upcoming">Upcoming</TabsTrigger></TabsList>
          <TabsContent value="history"><Timeline events={events} /></TabsContent>
          <TabsContent value="upcoming">
            <div className="space-y-3">
              <div className="rounded-[22px] border border-cobalt/20 bg-white p-4"><div className="flex items-start gap-3"><CircleDashed className="size-5 shrink-0 text-cobalt" strokeWidth={1.8} /><div><p className="text-sm font-semibold">Verify MetroNet’s next statement</p><p className="mt-1 text-xs leading-5 text-muted">Expected in September. We’ll compare the amount with your saved plan.</p></div></div></div>
              <div className="rounded-[22px] border border-ink/10 bg-white p-4"><div className="flex items-start gap-3"><CalendarClock className="size-5 shrink-0 text-cobalt" strokeWidth={1.8} /><div><p className="text-sm font-semibold">Check StreamBox cancellation</p><p className="mt-1 text-xs leading-5 text-muted">September 6 · Confirm no new subscription charge appears.</p></div></div></div>
              <div className="rounded-[22px] bg-teal/7 p-4"><div className="flex items-start gap-3"><Check className="size-5 shrink-0 text-teal" strokeWidth={2} /><div><p className="text-sm font-semibold">No action needed now</p><p className="mt-1 text-xs leading-5 text-muted">Budgefi will bring exceptions back to Review when fresh evidence arrives.</p></div></div></div>
            </div>
          </TabsContent>
        </Tabs>
      </main>
    </MobileShell>
  );
}
