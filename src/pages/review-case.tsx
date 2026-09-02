import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ChevronRight, ReceiptText, ShieldCheck } from "lucide-react";
import { MobileShell } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useAppState } from "@/state/app-state";
import { money } from "@/lib/utils";
import { NotFoundPage } from "@/pages/not-found";

const choices = [
  ["expected", "Both charges are mine", "Keep the evidence and close this item."],
  ["unexpected", "One charge is unexpected", "Keep this open as a possible duplicate."],
  ["unsure", "I’m not sure yet", "Keep it available for a later decision."],
] as const;

export function ReviewCasePage() {
  const { slug } = useParams();
  const state = useAppState();
  const item = state.cases.find((entry) => entry.id === slug);
  if (!item) return <NotFoundPage/>;
  return <RealCase item={item}/>;
}

function RealCase({item}:{item:ReturnType<typeof useAppState>["cases"][number]}) {
  const state=useAppState();
  const [decision,setDecision]=useState<"expected"|"unexpected"|"unsure"|null>(null);
  const [saving,setSaving]=useState(false);
  const terminal=["verified","failed","expired"].includes(item.status);
  const decide=async()=>{if(!decision||terminal)return;setSaving(true);await state.decideException(item,decision);setSaving(false)};
  return <MobileShell><main className="px-4 pb-8 pt-6">
    <p className="eyebrow">Observed evidence</p>
    <h1 className="text-[29px] font-bold leading-tight tracking-[-.045em]">{item.title}</h1>
    <p className="mt-2 text-sm leading-6 text-muted">Budgefi matched these records using an exact duplicate-charge rule. Review the evidence before deciding.</p>
    <div className="mt-5 overflow-hidden rounded-[22px] border border-ink/10 bg-white">
      {item.evidence.map((proof)=><div key={proof.id} className="border-b border-ink/8 p-4 last:border-0">
        {proof.transaction?<div className="flex items-start justify-between gap-4"><span className="min-w-0"><strong className="block truncate text-sm">{proof.transaction.merchant}</strong><span className="mt-1 block text-xs text-muted">{formatDate(proof.transaction.occurredOn)} · {proof.transaction.accountName}</span><span className="mt-1 block text-[11px] font-semibold text-cobalt">{proof.transaction.provenance} · {proof.transaction.status}</span></span><strong className="shrink-0 text-sm tabular-nums">{money(Number(proof.transaction.amount.minor)/100)}</strong></div>:<div className="flex gap-3"><ReceiptText className="mt-0.5 size-4 shrink-0 text-cobalt"/><p className="text-sm text-muted">{proof.summary}</p></div>}
      </div>)}
    </div>
    <div className="mt-5 rounded-2xl bg-paper-deep p-4"><div className="flex gap-3"><ShieldCheck className="mt-0.5 size-5 shrink-0 text-cobalt"/><p className="text-xs leading-5 text-muted"><strong className="text-ink">Your decision does not move money.</strong> It records how this evidence should be treated and keeps the history traceable.</p></div></div>
    {!terminal&&<><h2 className="mt-6 text-lg font-bold">What happened?</h2><RadioGroup value={decision??""} onValueChange={(value)=>setDecision(value as NonNullable<typeof decision>)} className="mt-3 space-y-2">{choices.map(([value,title,description])=><label key={value} className="flex min-h-[72px] cursor-pointer items-center gap-3 rounded-2xl border border-ink/12 bg-white p-3 has-[[data-state=checked]]:border-cobalt has-[[data-state=checked]]:bg-cobalt/[.035]"><RadioGroupItem value={value}/><span><strong className="block text-sm">{title}</strong><span className="mt-0.5 block text-xs text-muted">{description}</span></span></label>)}</RadioGroup><Button disabled={!decision||saving} onClick={()=>void decide()} size="lg" className="mt-4 w-full">{saving?"Saving…":"Save decision"}</Button></>}
    {terminal&&<Button asChild variant="outline" className="mt-5 w-full"><Link to="/review">Back to review <ChevronRight className="size-4"/></Link></Button>}
  </main></MobileShell>;
}

function formatDate(value:string){return new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric",year:"numeric",timeZone:"UTC"}).format(new Date(`${value}T12:00:00Z`))}
