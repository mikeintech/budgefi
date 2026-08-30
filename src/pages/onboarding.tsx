import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AlertTriangle, ArrowLeft, Check, ChevronRight, Eye, Landmark, LockKeyhole, ShieldCheck, Sparkles, Users } from "lucide-react";
import { BudgefiMark, Wordmark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { PlanCalibration } from "@/components/plan-calibration";
import { useAppState, type HouseholdMode, type NotificationMode, type PlanCalibrationData } from "@/state/app-state";
import { cn } from "@/lib/utils";

const steps = ["Welcome", "Household", "Connect", "Plan", "Alerts", "Ready"];

export function OnboardingPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const fromSignUp = params.get("from") === "signup";
  const state = useAppState();
  const [step, setStep] = useState(fromSignUp ? 1 : 0);
  const [connectionPhase, setConnectionPhase] = useState<"choose" | "consent" | "syncing" | "done">("choose");
  const [householdDraft,setHouseholdDraft]=useState(state.householdMode);
  const [notificationDraft,setNotificationDraft]=useState(state.notificationMode);
  const [digestDraft,setDigestDraft]=useState(state.weeklyDigest);
  const [connectionDraft,setConnectionDraft]=useState(false);
  const [planDraft,setPlanDraft]=useState<{data:PlanCalibrationData;buffer:number}|null>(null);
  const visibleSteps=fromSignUp?steps.slice(1):steps;
  const visibleStep=fromSignUp?step-1:step;

  const next = () => setStep((value) => Math.min(5, value + 1));
  const back = () => {
    if (step === 2 && connectionPhase !== "choose" && connectionPhase !== "done") setConnectionPhase("choose");
    else if (step === 1 && fromSignUp) navigate("/sign-up");
    else setStep((value) => Math.max(0, value - 1));
  };
  const connect = () => {
    setConnectionPhase("syncing");
    window.setTimeout(() => {
      setConnectionDraft(true);
      setConnectionPhase("done");
    }, 1100);
  };
  const finish = () => {
    state.setHouseholdMode(householdDraft);
    state.setNotificationMode(notificationDraft);
    state.setWeeklyDigest(digestDraft);
    if(connectionDraft)state.connectDemoBank();
    if(planDraft)state.savePlanCalibration(planDraft.data,planDraft.buffer);
    state.setOnboardingCompleted(true);
    navigate("/today");
  };

  return (
    <div className="min-h-dvh bg-[#ded8ca] sm:p-4">
      <div className="paper-grain mx-auto flex min-h-dvh w-full max-w-[430px] flex-col overflow-hidden sm:min-h-[calc(100dvh-32px)] sm:rounded-[26px] sm:border sm:border-carbon/10 sm:shadow-2xl">
        <header className="relative flex h-16 items-center border-b border-rule/80 px-4">
          {step === 3 ? <div className="size-11" /> : step > 0 ? <button onClick={back} className="grid size-11 place-items-center rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil" aria-label="Previous onboarding step"><ArrowLeft className="size-5" /></button> : <button onClick={() => navigate("/")} className="grid size-11 place-items-center rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil" aria-label="Close onboarding"><ArrowLeft className="size-5" /></button>}
          <button onClick={() => navigate("/")} className="absolute left-1/2 flex min-h-11 -translate-x-1/2 items-center rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil" aria-label="Budgefi landing"><Wordmark /></button><span className="ml-auto rounded-full border border-pencil/15 bg-white/60 px-2 py-1 text-[9px] font-bold uppercase tracking-[.1em] text-pencil">Sample</span>
        </header>
        {step!==3&&<div className="px-5 pt-4">
          <div className={cn("grid gap-1.5",fromSignUp?"grid-cols-5":"grid-cols-6")} aria-label={`Onboarding step ${visibleStep + 1} of ${visibleSteps.length}`}>
            {visibleSteps.map((label, index) => <span key={label} className={cn("h-1 rounded-full", index <= visibleStep ? "bg-pencil" : "bg-carbon/12")} />)}
          </div>
          <p className="mt-2 text-right text-[10px] font-bold uppercase tracking-[.1em] text-carbon/45">{steps[step]} · {visibleStep + 1} of {visibleSteps.length}</p>
        </div>}

        <main className="flex flex-1 flex-col px-5 pb-[calc(24px+env(safe-area-inset-bottom))] pt-5">
          {step === 0 && <Welcome onNext={next} />}
          {step === 1 && <Household value={householdDraft} onChange={setHouseholdDraft} onNext={next} />}
          {step === 2 && <Connection phase={connectionPhase} setPhase={setConnectionPhase} connect={connect} onNext={next} />}
          {step === 3 && <PlanCalibration embedded onBack={back} onDraftComplete={(data,buffer)=>setPlanDraft({data,buffer})} onComplete={next} />}
          {step === 4 && <Alerts mode={notificationDraft} setMode={setNotificationDraft} digest={digestDraft} setDigest={setDigestDraft} onNext={next} />}
          {step === 5 && <Ready connected={connectionDraft} household={householdDraft} calibration={planDraft?.data??state.calibration} onFinish={finish} />}
        </main>
      </div>
    </div>
  );
}

function Welcome({ onNext }: { onNext: () => void }) {
  return <div className="flex flex-1 flex-col"><div className="mt-4"><span className="grid size-16 place-items-center rounded-[22px] bg-citron"><BudgefiMark className="size-9" /></span><p className="eyebrow mt-7">Financial operations, verified</p><h1 className="max-w-[360px] text-[38px] font-bold leading-[1.02] tracking-[-0.055em]">Know what changed—and what actually worked.</h1><p className="mt-4 max-w-[350px] text-base leading-6 text-muted">Budgefi reconciles expected and actual bills, asks before acting, and keeps watching until there’s proof.</p></div><div className="mt-7 grid grid-cols-3 gap-2">{[[Eye,"Read-only"],[ShieldCheck,"Approval first"],[Sparkles,"Proof after"]].map(([Icon,label]) => { const I=Icon as typeof Eye; return <div key={label as string} className="rounded-2xl border border-ink/10 bg-white p-3"><I className="size-5 text-pencil" strokeWidth={1.8}/><p className="mt-3 text-xs font-semibold">{label as string}</p></div>})}</div><Button onClick={onNext} size="lg" className="mt-auto w-full">Set up Budgefi <ChevronRight className="size-4" /></Button></div>;
}

function Household({ value, onChange, onNext }: { value: HouseholdMode; onChange: (value: HouseholdMode) => void; onNext: () => void }) {
  return <div className="flex flex-1 flex-col"><p className="eyebrow">Your money context</p><h1 className="text-[32px] font-bold leading-tight tracking-[-0.045em]">Who should this plan work for?</h1><p className="mt-2 text-sm leading-5 text-muted">This changes collaboration language and household controls. You can update it later.</p><RadioGroup value={value} onValueChange={(v) => onChange(v as HouseholdMode)} className="mt-6 space-y-3"><Choice value="solo" icon={LockKeyhole} title="Just me" description="A private plan with one decision-maker." /><Choice value="shared" icon={Users} title="My household" description="Shared commitments, answers, and accountability." /></RadioGroup><div className="mt-5 rounded-2xl bg-recessed p-4 text-xs leading-5 text-muted">Role controls are simulated in this prototype and are not saved. A production household would give each member separate access without sharing bank credentials.</div><Button onClick={onNext} size="lg" className="mt-auto w-full">Continue <ChevronRight className="size-4" /></Button></div>;
}

function Connection({ phase, setPhase, connect, onNext }: { phase: "choose" | "consent" | "syncing" | "done"; setPhase: (phase: "choose" | "consent" | "syncing" | "done") => void; connect: () => void; onNext: () => void }) {
  if (phase === "syncing") return <div className="flex flex-1 flex-col items-center justify-center text-center"><span className="grid size-16 place-items-center rounded-[22px] bg-pencil/8"><Landmark className="size-8 animate-pulse text-pencil" /></span><h1 className="mt-5 text-2xl font-bold">Checking coverage</h1><p className="mt-2 max-w-[290px] text-sm leading-5 text-muted">Connecting read-only demo accounts and finding the latest successful refresh.</p><div className="mt-6 h-1.5 w-52 overflow-hidden rounded-full bg-carbon/10"><div className="h-full w-2/3 animate-pulse rounded-full bg-pencil" /></div></div>;
  if (phase === "done") return <div className="flex flex-1 flex-col"><div className="mt-8 text-center"><span className="mx-auto grid size-16 place-items-center rounded-[22px] bg-leaf text-white"><Check className="size-8" /></span><p className="eyebrow mt-6">Connection complete</p><h1 className="text-[31px] font-bold tracking-[-0.045em]">Sample accounts connected</h1><p className="mx-auto mt-2 max-w-[320px] text-sm leading-5 text-muted">Now review which balances, commitments, and guardrails can safely be used in the plan.</p></div><div className="mt-6 divide-y divide-rule overflow-hidden rounded-2xl border border-rule bg-white"><AccountPreview name="Chase Checking •42" note="Current · 14 months available"/><AccountPreview name="Joint Cash •07" note="Current · balance and transactions"/><AccountPreview name="Emergency Savings •16" note="Current · protected by default"/></div><Button onClick={onNext} size="lg" className="mt-auto w-full">Review plan inputs <ChevronRight className="size-4" /></Button></div>;
  if (phase === "consent") return <div className="flex flex-1 flex-col"><p className="eyebrow">Before connecting</p><h1 className="text-[32px] font-bold leading-tight tracking-[-0.045em]">Approve read-only access</h1><p className="mt-2 text-sm leading-5 text-muted">This simulated consent screen shows exactly what Budgefi would request.</p><div className="mt-6 space-y-2">{[[Eye,"View balances and transactions"],[Landmark,"Read account names and types"],[LockKeyhole,"Never see or store bank passwords"]].map(([Icon,text])=>{const I=Icon as typeof Eye;return <div key={text as string} className="flex min-h-14 items-center gap-3 rounded-2xl border border-rule bg-white p-3"><span className="grid size-9 place-items-center rounded-xl bg-pencil/8 text-pencil"><I className="size-[18px]"/></span><span className="text-sm font-semibold">{text as string}</span></div>})}</div><div className="mt-5 rounded-2xl border border-leaf/20 bg-leaf/5 p-4 text-xs leading-5 text-muted"><strong className="text-leaf">Demo connection:</strong> no real credentials are requested or transmitted.</div><Button onClick={connect} size="lg" className="mt-auto w-full">Approve and connect</Button></div>;
  return <div className="flex flex-1 flex-col"><p className="eyebrow">Build trustworthy coverage</p><h1 className="text-[32px] font-bold leading-tight tracking-[-0.045em]">Connect your first account</h1><p className="mt-2 text-sm leading-5 text-muted">Start with the account that pays most household bills. This prototype uses a simulated institution.</p><button onClick={() => setPhase("consent")} className="mt-6 flex min-h-[76px] items-center gap-3 rounded-[20px] border border-pencil/20 bg-white p-4 text-left shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil"><span className="grid size-11 place-items-center rounded-2xl bg-pencil text-white"><Landmark className="size-5"/></span><span className="flex-1"><strong className="block">Chase sample connection</strong><span className="text-xs text-muted">Checking •42 and Joint Cash •07</span></span><ChevronRight className="size-4 text-muted"/></button><div className="mt-3 flex items-center gap-2 text-xs text-muted"><LockKeyhole className="size-4"/> Simulated handoff · no credentials requested</div><Button onClick={onNext} variant="ghost" className="mt-auto w-full">Explore with sample data</Button></div>;
}

function Alerts({ mode, setMode, digest, setDigest, onNext }: { mode: NotificationMode; setMode: (value: NotificationMode) => void; digest: boolean; setDigest: (value: boolean) => void; onNext: () => void }) {
  return <div className="flex flex-1 flex-col"><p className="eyebrow">Attention, protected</p><h1 className="text-[32px] font-bold leading-tight tracking-[-0.045em]">How often should Budgefi reach you?</h1><p className="mt-2 text-sm leading-5 text-muted">Preview notification preferences for a future production service. This local prototype does not send alerts or email.</p><RadioGroup value={mode} onValueChange={(v) => setMode(v as NotificationMode)} className="mt-6 space-y-2"><PlainChoice value="exceptions" title="Only when I need to decide" description="Recommended · quietest"/><PlainChoice value="daily" title="One daily summary" description="Open work and meaningful changes"/><PlainChoice value="all" title="All detected changes" description="Highest frequency"/></RadioGroup><div className="mt-4 flex items-center justify-between rounded-2xl border border-rule bg-white p-4"><span><strong className="block text-sm">Weekly proof digest</strong><span className="mt-0.5 block text-xs text-muted">Preference preview · no delivery active</span></span><Switch checked={digest} onCheckedChange={setDigest} label="Weekly proof digest"/></div><Button onClick={onNext} size="lg" className="mt-auto w-full">Save preference preview <ChevronRight className="size-4" /></Button></div>;
}

function Ready({ connected, household, calibration, onFinish }: { connected: boolean; household: HouseholdMode; calibration:PlanCalibrationData; onFinish: () => void }) {
  const {sourceStale}=useAppState();const commitmentCount=4+calibration.customCommitments.length;
  const rows=[[Users,household==='shared'?'Shared household':'Personal plan',false],[Landmark,connected?'Sample source connected':'Sample accounts reviewed',false],[sourceStale?AlertTriangle:ShieldCheck,sourceStale?'Coverage incomplete · preview only':'Coverage current · approval required',sourceStale]] as const;
  return <div className="flex flex-1 flex-col"><div className="text-center"><span className={cn("mx-auto grid size-16 place-items-center rounded-[22px] text-white",sourceStale?'bg-amber-600':'bg-leaf')}>{sourceStale?<AlertTriangle className="size-8"/>:<Check className="size-8"/>}</span><p className="eyebrow mt-6">{sourceStale?'Setup needs attention':'Setup reviewed'}</p><h1 className="text-[34px] font-bold tracking-[-0.05em]">{sourceStale?'Sample plan preview ready to save':'Your conservative sample plan is ready to save'}</h1><p className="mx-auto mt-2 max-w-[320px] text-sm leading-5 text-muted">{sourceStale?'Update MetroCard before relying on the preview. ':''}Built from included deposit accounts, {commitmentCount} reviewed commitments, no future income, planned savings, and your safety buffer.</p></div><div className="mt-7 divide-y divide-rule overflow-hidden rounded-[20px] border border-rule bg-white">{rows.map(([Icon,text,warning])=>{const I=Icon as typeof Users;return <div key={text} className="flex min-h-14 items-center gap-3 px-4"><I className={cn("size-[18px]",warning?'text-amber-700':'text-pencil')}/><span className="text-sm font-semibold">{text}</span>{warning?<AlertTriangle className="ml-auto size-4 text-amber-700"/>:<Check className="ml-auto size-4 text-leaf"/>}</div>})}</div><Button onClick={onFinish} size="lg" className="mt-auto w-full">{sourceStale?'Save and open preview':'Save plan and open Today'}</Button></div>;
}

function Choice({ value, icon: Icon, title, description }: { value: string; icon: typeof Users; title: string; description: string }) { return <label className="flex min-h-[82px] cursor-pointer items-center gap-3 rounded-[20px] border border-rule bg-white p-4 has-[[data-state=checked]]:border-pencil has-[[data-state=checked]]:bg-pencil/[.035]"><span className="grid size-10 place-items-center rounded-2xl bg-recessed text-pencil"><Icon className="size-5"/></span><span className="min-w-0 flex-1"><strong className="block text-sm">{title}</strong><span className="mt-1 block text-xs text-muted">{description}</span></span><RadioGroupItem value={value}/></label> }
function PlainChoice({ value, title, description }: { value: string; title: string; description: string }) { return <label className="flex min-h-[68px] cursor-pointer items-center gap-3 rounded-2xl border border-rule bg-white p-3 has-[[data-state=checked]]:border-pencil"><RadioGroupItem value={value}/><span><strong className="block text-sm">{title}</strong><span className="text-xs text-muted">{description}</span></span></label> }
function AccountPreview({name,note}:{name:string;note:string}){return <div className="flex min-h-16 items-center gap-3 px-4"><span className="grid size-9 place-items-center rounded-xl bg-pencil/8 text-pencil"><Landmark className="size-[18px]"/></span><span><strong className="block text-sm">{name}</strong><span className="text-xs text-muted">{note}</span></span><Check className="ml-auto size-4 text-leaf"/></div>}
