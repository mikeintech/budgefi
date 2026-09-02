import { AlertTriangle, CalendarClock, Cloud, FileCheck2, ReceiptText, ShieldCheck } from "lucide-react";
import { MobileShell } from "@/components/layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppState, type ActivityEvent } from "@/state/app-state";
import { money } from "@/lib/utils";

const iconMap = { evidence: ReceiptText, plan: FileCheck2, source: Cloud, household: ShieldCheck } as const;

function Timeline({ events }: { events: ActivityEvent[] }) {
  if(events.length===0)return <div className="rounded-[22px] border border-dashed border-rule bg-white p-6 text-center"><strong className="block text-sm">No ledger activity yet</strong><p className="mt-1 text-xs leading-5 text-muted">Saved balances, commitments, connection changes, and imported transactions will appear here.</p></div>;
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
  const { events, commitments, authoritativeProjection } = useAppState();
  const today=new Date().toLocaleDateString("en-CA");
  const upcoming=[...commitments].sort((left,right)=>(left.dueDate??"9999-12-31").localeCompare(right.dueDate??"9999-12-31")||left.name.localeCompare(right.name));
  return (
    <MobileShell>
      <main className="px-4 pb-8 pt-5">
        <p className="eyebrow">Proof trail</p>
        <h1 className="text-[31px] font-bold tracking-[-0.04em]">Activity</h1>
        <p className="mt-1 text-sm leading-5 text-muted">History records what changed. Upcoming shows the active commitments your plan is working around.</p>

        <Tabs defaultValue="history" className="mt-5">
          <TabsList><TabsTrigger value="history">History</TabsTrigger><TabsTrigger value="upcoming">Upcoming</TabsTrigger></TabsList>
          <TabsContent value="history"><Timeline events={events} /></TabsContent>
          <TabsContent value="upcoming">
            <div className="divide-y divide-rule overflow-hidden rounded-[22px] border border-rule bg-white">
              {upcoming.map(item=>{const overdue=Boolean(item.dueDate&&item.dueDate<today);const undated=!item.dueDate;const outside=Boolean(item.dueDate&&item.dueDate>authoritativeProjection.horizonEnd);const Icon=overdue||undated?AlertTriangle:CalendarClock;return <div key={item.id} className="flex min-h-[78px] items-center gap-3 px-4 py-3"><span className={`grid size-10 shrink-0 place-items-center rounded-2xl ${overdue||undated?"bg-coral/10 text-coral":"bg-paper-deep text-cobalt"}`}><Icon className="size-5" strokeWidth={1.8}/></span><span className="min-w-0 flex-1"><strong className="block truncate text-sm">{item.name}</strong><span className={`block text-xs ${overdue||undated?"font-semibold text-coral":"text-muted"}`}>{undated?"Needs a due date · not reserved":overdue?`Past due · ${formatDate(item.dueDate!)}`:item.dueDate===today?"Due today":`${formatDate(item.dueDate!)}${outside?" · outside current plan":""}`}</span><span className="block text-[11px] text-muted">{sourceLabel(item.provenance)}</span></span><strong className="shrink-0 text-sm tabular-nums">{money(Number(BigInt(item.amount.minor))/100)}</strong></div>})}
              {upcoming.length===0&&<div className="p-6 text-center"><CalendarClock className="mx-auto size-6 text-cobalt"/><strong className="mt-2 block text-sm">No upcoming commitments</strong><p className="mt-1 text-xs leading-5 text-muted">Add one in the manual workspace and it will appear here.</p></div>}
            </div>
          </TabsContent>
        </Tabs>
      </main>
    </MobileShell>
  );
}

function formatDate(value:string){return new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric",year:new Date(`${value}T12:00:00Z`).getUTCFullYear()!==new Date().getFullYear()?"numeric":undefined,timeZone:"UTC"}).format(new Date(`${value}T12:00:00Z`))}
function sourceLabel(value:string){return value==="manual"?"You entered":value==="plaid"?"Connected data":value==="csv"?"Imported":value==="derived"?"Detected":"Historical"}
