import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, ChevronRight, CircleDashed, Clock3, Eye, Landmark, LockKeyhole, Plus, RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import { MobileShell } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useAppState } from "@/state/app-state";

type AddPhase = "choose" | "consent" | "syncing" | "done";

export function ConnectionsPage() {
  const state = useAppState();
  return (
    <MobileShell>
      <main className="px-4 pb-8 pt-5">
        <p className="eyebrow">Coverage before conclusions</p>
        <div className="flex items-end justify-between gap-3"><div><h1 className="text-[31px] font-bold tracking-[-0.045em]">Connections</h1><p className="mt-1 text-sm text-muted">See freshness, coverage, and plan impact.</p></div><Badge tone={state.sourceStale ? "coral" : "green"}>{state.sourceStale ? "1 stale" : "Current"}</Badge></div>

        <section className="mt-5 grid grid-cols-3 gap-2" aria-label="Connection coverage summary">
          <Metric value="4" label="Sources" />
          <Metric value={state.sourceStale ? "3/4" : "4/4"} label="Current" />
          <Metric value="14 mo" label="History" />
        </section>

        <section className="mt-6" aria-labelledby="active-sources"><div className="mb-3 flex items-center justify-between"><h2 id="active-sources" className="text-lg font-bold">Active sources</h2><span className="text-xs text-muted">Read-only</span></div><div className="space-y-2">
          <ConnectionCard name="Chase Checking •42" status="Current" detail="Updated today · 7:42 AM" impact="Known cash and transactions" />
          <ConnectionCard name="Joint Cash •07" status="Current" detail="Updated today · 7:38 AM" impact="Included in known cash" />
          <ConnectionCard name="Visa •19" status="Current" detail="Updated yesterday · 11:10 PM" impact="Transactions and recurring bills" />
          <ConnectionCard name="MetroCard" status={state.sourceStale ? "Stale" : "Current"} detail={state.sourceStale ? "Missing activity after Aug 26" : "Updated today · no new activity"} impact={state.sourceStale ? "Recent spending may be missing" : "Coverage confirmed"} stale={state.sourceStale} onRefresh={() => state.setSourceStale(false)} />
        </div></section>

        <AddConnection onConnected={state.connectDemoBank} connected={state.demoBankConnected} />

        <section className="mt-7 rounded-[22px] bg-ink p-4 text-white"><div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 size-5 shrink-0 text-citron"/><div><p className="text-sm font-semibold">Connection health is part of the product</p><p className="mt-1 text-xs leading-5 text-white/65">Budgefi marks incomplete coverage before presenting an amount as reliable. A successful login alone is not treated as proof of fresh data.</p></div></div></section>
      </main>
    </MobileShell>
  );
}

function Metric({value,label}:{value:string;label:string}){return <div className="rounded-2xl border border-rule bg-white p-3 text-center"><strong className="tabular block text-lg">{value}</strong><span className="mt-0.5 block text-[10px] font-bold uppercase tracking-[.08em] text-muted">{label}</span></div>}

function ConnectionCard({name,status,detail,impact,stale=false,demo=false,onRefresh,onDisconnect}:{name:string;status:string;detail:string;impact:string;stale?:boolean;demo?:boolean;onRefresh?:()=>void;onDisconnect?:()=>void}){
  const [checking,setChecking]=useState(false);const refresh=()=>{setChecking(true);window.setTimeout(()=>{onRefresh?.();setChecking(false)},900)};
  return <Sheet><SheetTrigger asChild><button className="flex min-h-[82px] w-full items-center gap-3 rounded-[20px] border border-rule bg-white p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil"><span className={stale?"grid size-11 place-items-center rounded-2xl bg-coral/8 text-coral":"grid size-11 place-items-center rounded-2xl bg-pencil/8 text-pencil"}>{stale?<Clock3 className="size-5"/>:<Landmark className="size-5"/>}</span><span className="min-w-0 flex-1"><span className="flex items-center gap-2"><strong className="truncate text-sm">{name}</strong>{demo&&<Badge tone="blue">Demo</Badge>}</span><span className="mt-1 block truncate text-xs text-muted">{detail}</span><span className={stale?"mt-1 block text-[11px] font-semibold text-coral":"mt-1 block text-[11px] font-semibold text-leaf"}>{status} · {impact}</span></span><ChevronRight className="size-4 text-muted"/></button></SheetTrigger><SheetContent title={name} description="Connection details and controls"><div className="space-y-3"><Detail label="Status" value={status}/><Detail label="Latest coverage" value={detail}/><Detail label="Used for" value={impact}/><Detail label="Permission" value="Balances and transactions · read-only"/></div>{stale&&<Button onClick={refresh} disabled={checking} className="mt-5 w-full">{checking?<><RefreshCw className="size-4 animate-spin"/>Checking coverage…</>:"Refresh connection"}</Button>}{demo&&<SheetClose asChild><Button variant="outline" className="mt-5 w-full text-coral" onClick={onDisconnect}><Unplug className="size-4"/>Disconnect demo bank</Button></SheetClose>}</SheetContent></Sheet>
}
function Detail({label,value}:{label:string;value:string}){return <div className="rounded-2xl border border-rule bg-white p-3"><span className="text-[10px] font-bold uppercase tracking-[.1em] text-muted">{label}</span><p className="mt-1 text-sm font-semibold">{value}</p></div>}

function AddConnection({onConnected,connected}:{onConnected:()=>void;connected:boolean}){
  const [open,setOpen]=useState(false);const [phase,setPhase]=useState<AddPhase>("choose");
  const change=(next:boolean)=>{setOpen(next);if(next)setPhase(connected?"done":"choose")};
  const connect=()=>{setPhase("syncing");window.setTimeout(()=>{onConnected();setPhase("done")},1100)};
  return <Sheet open={open} onOpenChange={change}><SheetTrigger asChild><Button variant="outline" size="lg" className="mt-5 w-full">{connected?<Check className="size-4"/>:<Plus className="size-4"/>}{connected?"Review sample connection":"Connect sample source"}</Button></SheetTrigger><SheetContent side="bottom" className="mx-auto max-w-[430px] rounded-t-[28px]">
    {phase==="choose"&&<><SheetHeader><SheetTitle>Choose a sample source</SheetTitle><SheetDescription>This prototype reconnects the accounts already visible in Sample mode.</SheetDescription></SheetHeader><button onClick={()=>setPhase("consent")} className="flex min-h-[76px] w-full items-center gap-3 rounded-[20px] border border-pencil/20 bg-white p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil"><span className="grid size-11 place-items-center rounded-2xl bg-pencil text-white"><Landmark className="size-5"/></span><span className="flex-1"><strong className="block">Chase sample connection</strong><span className="text-xs text-muted">Checking •42 and Joint Cash •07</span></span><ChevronRight className="size-4"/></button><p className="mt-4 flex items-center gap-2 text-xs text-muted"><LockKeyhole className="size-4"/>No credentials are collected in this demo.</p></>}
    {phase==="consent"&&<><SheetHeader><SheetTitle>Approve read-only access</SheetTitle><SheetDescription>Budgefi requests only what it needs to reconcile activity.</SheetDescription></SheetHeader><div className="space-y-2"><Permission icon={Eye} text="Balances and transaction history"/><Permission icon={Landmark} text="Account names and types"/><Permission icon={LockKeyhole} text="No transfers or money movement"/></div><Button onClick={connect} className="mt-5 w-full" size="lg">Approve and connect</Button></>}
    {phase==="syncing"&&<div className="py-12 text-center"><CircleDashed className="mx-auto size-10 animate-spin text-pencil"/><SheetTitle className="mt-5">Checking account coverage</SheetTitle><SheetDescription className="mx-auto mt-2 max-w-[280px]">Looking for the latest successful refresh and available history.</SheetDescription></div>}
    {phase==="done"&&<div className="py-5 text-center"><span className="mx-auto grid size-14 place-items-center rounded-[20px] bg-leaf text-white"><Check className="size-7"/></span><SheetTitle className="mt-5">Sample source connected</SheetTitle><SheetDescription className="mx-auto mt-2 max-w-[290px]">Chase Checking •42 and Joint Cash •07 are current. Review their inclusion before saving the plan.</SheetDescription><SheetClose asChild><Button asChild className="mt-6 w-full" size="lg"><Link to="/settings/calibration">Review plan inputs</Link></Button></SheetClose></div>}
  </SheetContent></Sheet>
}
function Permission({icon:Icon,text}:{icon:typeof Eye;text:string}){return <div className="flex min-h-14 items-center gap-3 rounded-2xl border border-rule bg-white p-3"><span className="grid size-9 place-items-center rounded-xl bg-pencil/8 text-pencil"><Icon className="size-[18px]"/></span><span className="text-sm font-semibold">{text}</span></div>}
