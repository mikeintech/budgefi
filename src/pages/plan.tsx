import { Link } from "react-router-dom";
import { CalendarRange, ChevronRight, CloudOff, House, ShoppingBag, Tv, Zap } from "lucide-react";
import { MobileShell, HealthSheet } from "@/components/layout";
import { CommitmentEditor } from "@/components/commitment-editor";
import { MoneySummary } from "@/components/money-summary";
import { Button } from "@/components/ui/button";
import { useAppState } from "@/state/app-state";
import { money } from "@/lib/utils";

export function PlanPage() {
  const { sourceStale, commitments: planCommitments, authoritativeProjection, dataMode } = useAppState();
  const manual=dataMode==='manual';
  const effectiveStale=!manual&&sourceStale;
  const {available}=authoritativeProjection;
  const unallocatedCash=Math.max(0,available);
  const iconFor=(name:string)=>name.toLowerCase().includes('rent')?House:name.toLowerCase().includes('electric')?Zap:name.toLowerCase().includes('stream')?Tv:CalendarRange;
  const commitments = [...planCommitments].sort((left,right)=>(left.dueDate??"9999-12-31").localeCompare(right.dueDate??"9999-12-31")||left.name.localeCompare(right.name)).map(item=>({item,icon:iconFor(item.name),title:item.name,date:item.dueDate?`${formatPlanDate(item.dueDate)}${item.dueDate>authoritativeProjection.horizonEnd?' · outside this plan window':''}`:'Not reserved · add a due date',amount:money(Number(BigInt(item.amount.minor))/100),note:item.provenance==='manual'?'You entered':item.provenance==='plaid'?'Connected data':item.provenance==='csv'?'Imported':item.provenance==='derived'?'Detected':'Historical'}));
  return (
    <MobileShell>
      <main className="px-4 pb-8 pt-5">
        <p className="eyebrow">Through {formatPlanDate(authoritativeProjection.horizonEnd)}</p>
        <h1 className="text-[31px] font-bold tracking-[-0.04em]">Your plan</h1>
        <p className="mb-5 mt-1 text-sm text-muted">A cash view built from what has cleared and what is still expected.</p>
        <MoneySummary variant="compact" />

        {effectiveStale && (
          <HealthSheet>
            <button className="mt-3 flex w-full items-center gap-3 rounded-2xl border border-amber-500/25 bg-amber-50 p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt">
              <CloudOff className="size-5 shrink-0 text-amber-700" strokeWidth={1.8} />
              <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">One account may be behind</span><span className="block truncate text-xs text-muted">Tap to inspect the plan’s data sources</span></span>
              <ChevronRight className="size-4 text-muted" />
            </button>
          </HealthSheet>
        )}

        <section className="mt-7" aria-labelledby="commitments-heading">
          <div className="mb-3 flex items-end justify-between">
            <div><p className="eyebrow">Already accounted for</p><h2 id="commitments-heading" className="text-xl font-bold">Commitments</h2></div>
            <span className="text-xs font-semibold text-muted">{commitments.length} items</span>
          </div>
          <div className="divide-y divide-ink/8 overflow-hidden rounded-[22px] border border-ink/10 bg-white">
            {commitments.map(({ item, icon: Icon, title, date, amount, note }) => (
              <div key={item.id} className="flex min-h-[76px] items-center gap-3 px-4 py-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-paper-deep text-cobalt"><Icon className="size-5" strokeWidth={1.8} /></span>
                <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{title}</span><span className="block text-xs text-muted">{date} · {note}</span></span>
                <span className="shrink-0 text-right"><span className="block text-sm font-bold tabular-nums">{amount}</span><CommitmentEditor item={item}/></span>
              </div>
            ))}
            {commitments.length===0&&<div className="p-5 text-center"><strong className="block text-sm">No active commitments</strong><p className="mt-1 text-xs leading-5 text-muted">Add a dated bill in the manual workspace so the plan can reserve it.</p><Button asChild variant="outline" className="mt-3"><Link to="/manual">Add commitment</Link></Button></div>}
          </div>
        </section>

        <section className="mt-7 rounded-[24px] bg-ink p-5 text-white">
          <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[.12em] text-citron">Unallocated cash</p><h2 className="mt-1 text-2xl font-bold tracking-[-0.035em]">{available<0?'Paused for shortfall':money(unallocatedCash)}</h2></div><ShoppingBag className="size-6 text-citron" strokeWidth={1.8} /></div>
          <p className="mt-5 text-xs leading-5 text-white/65">This is the server-calculated amount left after commitments, planned savings, and your safety buffer. Budgefi is not setting a category cap here.</p>
        </section>
      </main>
    </MobileShell>
  );
}

function formatPlanDate(value:string){return new Intl.DateTimeFormat("en-US",{month:"long",day:"numeric",timeZone:"UTC"}).format(new Date(`${value}T12:00:00Z`))}
