import { useState } from "react";
import { CalendarRange, Check, ChevronRight, CloudOff, House, Lightbulb, Pencil, ShoppingBag, Tv, Zap } from "lucide-react";
import { MobileShell, HealthSheet } from "@/components/layout";
import { MoneySummary } from "@/components/money-summary";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { calculatePlanProjection, useAppState, type PlanCalibrationData } from "@/state/app-state";
import { money } from "@/lib/utils";

export function PlanPage() {
  const { sourceStale, electricMax, saveElectric, calibration, planningBuffer } = useAppState();
  const {available}=calculatePlanProjection(calibration,planningBuffer);
  const flexibleCap=Math.min(512,Math.max(0,available));
  const commitments = [
    { icon: House, title: "Rent", date: "Sep 1", amount: money(calibration.rentAmount), note: calibration.editedCommitments.includes('rentAmount')?"You entered":"Confirmed" },
    { icon: Zap, title: "Electric", date: "Sep 4", amount: `$130–${money(electricMax)}`, note: calibration.editedCommitments.includes('electricMax')?"You entered":"Estimated range", editable: true },
    { icon: Tv, title: "StreamBox", date: "Sep 6", amount: money(calibration.streamBoxAmount), note: calibration.editedCommitments.includes('streamBoxAmount')?"You entered":"Detected · watching" },
    { icon: CalendarRange, title: "Auto insurance", date: "Sep 8", amount: money(calibration.insuranceAmount), note: calibration.editedCommitments.includes('insuranceAmount')?"You entered":"Detected" },
    ...calibration.customCommitments.map(item=>({icon:CalendarRange,title:item.name,date:"By Sep 8",amount:money(item.amount),note:"You entered"})),
    { icon: Lightbulb, title: "MetroNet", date: "Already cleared", amount: "$83.20", note: "Observed · already in cash" },
  ];
  return (
    <MobileShell>
      <main className="px-4 pb-8 pt-5">
        <p className="eyebrow">Through September 8</p>
        <h1 className="text-[31px] font-bold tracking-[-0.04em]">Your plan</h1>
        <p className="mb-5 mt-1 text-sm text-muted">A cash view built from what has cleared and what is still expected.</p>
        <MoneySummary variant="compact" />

        {sourceStale && (
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
            {commitments.map(({ icon: Icon, title, date, amount, note, editable }) => (
              <div key={title} className="flex min-h-[76px] items-center gap-3 px-4 py-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-paper-deep text-cobalt"><Icon className="size-5" strokeWidth={1.8} /></span>
                <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{title}</span><span className="block text-xs text-muted">{date} · {note}</span></span>
                <span className="text-right"><span className="block text-sm font-bold tabular-nums">{amount}</span>{editable && <ElectricEditor value={electricMax} calibration={calibration} buffer={planningBuffer} stale={sourceStale} onSave={saveElectric} />}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-7 rounded-[24px] bg-ink p-5 text-white">
          <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[.12em] text-citron">Flexible guide</p><h2 className="mt-1 text-2xl font-bold tracking-[-0.035em]">{available<0?'Paused for shortfall':`${money(flexibleCap)} suggested cap`}</h2></div><ShoppingBag className="size-6 text-citron" strokeWidth={1.8} /></div>
          <div className="mt-5 h-2 overflow-hidden rounded-full bg-white/15"><div className="h-full w-[64%] rounded-full bg-citron" /></div>
          <div className="mt-2 flex justify-between text-xs text-white/65"><span>$908 used</span><span>$1,420 monthly guide</span></div><p className="mt-3 text-[11px] leading-4 text-white/55">This cap sits inside available-to-use. It is not additional spendable money.</p>
        </section>
      </main>
    </MobileShell>
  );
}

function ElectricEditor({ value, calibration, buffer, stale, onSave }: { value: number; calibration: PlanCalibrationData; buffer: number; stale:boolean; onSave: (value: number) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const available = calculatePlanProjection({ ...calibration, electricMax: draft }, buffer).available;
  return (
    <Sheet open={open} onOpenChange={(next) => { setOpen(next); if (next) setDraft(value); }}>
      <SheetTrigger asChild><Button variant="ghost" size="sm" className="mt-0.5 h-6 px-1.5 text-[11px] text-cobalt"><Pencil className="size-3" /> Edit range</Button></SheetTrigger>
      <SheetContent side="bottom" className="mx-auto max-w-[430px] rounded-t-[28px]">
        <SheetHeader><SheetTitle>Adjust Electric maximum</SheetTitle><SheetDescription>Use the highest realistic amount. The plan preview updates immediately.</SheetDescription></SheetHeader>
        <label className="mt-6 block text-sm font-semibold" htmlFor="electric-max">Maximum expected bill</label>
        <div className="mt-2 flex h-14 items-center rounded-2xl border border-ink/15 bg-white px-4 focus-within:ring-2 focus-within:ring-cobalt"><span className="text-lg font-semibold text-muted">$</span><input id="electric-max" className="h-full min-w-0 flex-1 bg-transparent px-2 text-xl font-bold tabular-nums outline-none" type="number" min="130" max="400" value={draft} onChange={(e) => setDraft(Math.max(130, Number(e.target.value) || 130))} inputMode="decimal" /></div>
        <div className="mt-4 rounded-2xl bg-paper-deep p-4"><p className="text-xs font-semibold uppercase tracking-[.1em] text-muted">{available<0?'Projected shortfall':stale?'Partial-data preview':'Available after this change'}</p><p className="mt-1 text-2xl font-bold tabular-nums">{money(Math.abs(available))}</p><p className="mt-1 text-xs text-muted">{stale?'Before unobserved MetroCard activity · ':''}through September 8</p></div>
        <Button className="mt-5 w-full" size="lg" onClick={() => { onSave(draft); setOpen(false); }}><Check className="size-4" /> Save estimate</Button>
      </SheetContent>
    </Sheet>
  );
}
