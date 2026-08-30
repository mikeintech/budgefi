import { Link } from "react-router-dom";
import { Bell, ChevronRight, Database, HelpCircle, RotateCcw, Settings2, Shield, SlidersHorizontal, Sparkles, Users } from "lucide-react";
import { MobileShell } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useAppState } from "@/state/app-state";

function InfoSheet({ icon, title, detail, children }: { icon: typeof Bell; title: string; detail: string; children: React.ReactNode }) {
  const Icon = icon;
  return <Sheet><SheetTrigger asChild><button className="w-full border-b border-ink/8 last:border-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cobalt"><div className="flex min-h-[70px] items-center gap-3 px-4 py-3 text-left"><span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-paper-deep text-cobalt"><Icon className="size-5" strokeWidth={1.8} /></span><span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{title}</span><span className="block truncate text-xs text-muted">{detail}</span></span><ChevronRight className="size-4 text-muted" /></div></button></SheetTrigger><SheetContent side="bottom" className="mx-auto max-w-[430px] rounded-t-[28px]"><SheetHeader><SheetTitle>{title}</SheetTitle><SheetDescription>{detail}</SheetDescription></SheetHeader><div className="mt-5 text-sm leading-6 text-muted">{children}</div></SheetContent></Sheet>;
}

export function MorePage() {
  const { sourceStale, setSourceStale, reset, householdMode, notificationMode, setOnboardingCompleted } = useAppState();
  return (
    <MobileShell>
      <main className="px-4 pb-8 pt-5">
        <p className="eyebrow">Household & controls</p>
        <h1 className="text-[31px] font-bold tracking-[-0.04em]">More</h1>
        <Link to="/settings/household" className="mt-5 block rounded-[24px] bg-ink p-5 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil">
          <div className="flex items-center gap-3"><span className="grid size-12 place-items-center rounded-2xl bg-citron font-bold text-ink">MA</span><div><p className="font-semibold">Maya’s household</p><p className="text-xs text-white/60">Personal workspace · Demo data</p></div></div>
          <div className="mt-4 flex items-center gap-2 text-xs text-white/70"><Shield className="size-4 text-citron" strokeWidth={1.8} /> {householdMode==='shared'?'Shared household controls':'Personal planning controls'}<ChevronRight className="ml-auto size-4"/></div>
        </Link>

        <section className="mt-6 overflow-hidden rounded-[22px] border border-ink/10 bg-white">
          <MoreLink to="/connections" icon={Database} title="Accounts & data health" detail={sourceStale ? "1 connection needs attention" : "All sources current"}/>
          <MoreLink to="/settings/notifications" icon={Bell} title="Notifications" detail={notificationMode==='exceptions'?"Exceptions and verification only":notificationMode==='daily'?"One daily summary":"All detected changes"}/>
          <MoreLink to="/settings" icon={Settings2} title="Settings & configuration" detail="Household, planning rules, and privacy"/>
          <InfoSheet icon={HelpCircle} title="Help & product tour" detail="Replay how the workflow works"><p>Start on Today, inspect MetroNet evidence, make a decision, save a future plan, then visit Activity to see how observation and verification stay separate.</p></InfoSheet>
        </section>

        <Button asChild variant="outline" className="mt-4 w-full"><Link to="/onboarding" onClick={()=>setOnboardingCompleted(false)}><Users className="size-4"/>Replay onboarding and connection</Link></Button>

        <section className="mt-7 rounded-[24px] border border-cobalt/15 bg-cobalt/[0.035] p-4">
          <div className="flex items-start gap-3"><Sparkles className="mt-0.5 size-5 shrink-0 text-cobalt" strokeWidth={1.8} /><div><p className="text-sm font-semibold">Demo state controls</p><p className="mt-1 text-xs leading-5 text-muted">Change conditions to inspect honest loading, warning, and completed states.</p></div></div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={() => setSourceStale(!sourceStale)}><SlidersHorizontal className="size-4" /> {sourceStale ? "Make current" : "Make stale"}</Button>
            <Button variant="outline" onClick={reset}><RotateCcw className="size-4" /> Reset demo</Button>
          </div>
        </section>

        <p className="mt-7 text-center text-[11px] font-medium text-muted">Budgefi clickable prototype · Local demo build</p>
      </main>
    </MobileShell>
  );
}

function MoreLink({to,icon:Icon,title,detail}:{to:string;icon:typeof Bell;title:string;detail:string}){return <Link to={to} className="flex min-h-[70px] items-center gap-3 border-b border-ink/8 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cobalt"><span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-paper-deep text-cobalt"><Icon className="size-5" strokeWidth={1.8}/></span><span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{title}</span><span className="block truncate text-xs text-muted">{detail}</span></span><ChevronRight className="size-4 text-muted"/></Link>}
