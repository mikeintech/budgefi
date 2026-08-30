import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Check, ChevronRight, ReceiptText, ShieldCheck } from "lucide-react";
import { MobileShell } from "@/components/layout";
import { ProofPair } from "@/components/proof-pair";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useAppState, type GroceryAnswer, type PlanChoice, type ReviewAnswer } from "@/state/app-state";
import { cn } from "@/lib/utils";

const answers: { value: NonNullable<ReviewAnswer>; title: string; description: string }[] = [
  { value: "expected", title: "Yes, I expected this", description: "The higher amount is legitimate." },
  { value: "unexpected", title: "No, this is unexpected", description: "I want to understand or challenge it." },
  { value: "unsure", title: "I’m not sure yet", description: "Keep the evidence and remind me." },
];

export function ReviewCasePage() {
  const { slug } = useParams();
  if (slug === "grocery") return <GroceryCase />;
  return <MetroNetCase />;
}

function MetroNetCase() {
  const state = useAppState();
  const [stage, setStage] = useState<1 | 2 | 3>(state.reviewSaved ? 3 : 1);
  const choices = useMemo<{ value: NonNullable<PlanChoice>; title: string; description: string }[]>(() => {
    if (state.reviewAnswer === "expected") return [
      { value: "update", title: "Update future bills to $83.20", description: "Use this as the new expected amount." },
      { value: "watch", title: "Watch one more charge", description: "Keep $65 expected until we see it again." },
    ];
    if (state.reviewAnswer === "unsure") return [
      { value: "watch", title: "Watch one more charge", description: "Compare this with the next bill automatically." },
      { value: "contact", title: "Remind me to check the bill", description: "Keep the evidence and add a task." },
    ];
    return [
      { value: "contact", title: "I’ll contact MetroNet", description: "Keep this evidence ready and verify the result." },
      { value: "watch", title: "Watch one more charge", description: "Wait for another signal before acting." },
    ];
  }, [state.reviewAnswer]);

  const save = () => {
    state.saveReview();
    setStage(3);
  };

  return (
    <MobileShell>
      <main className="pb-4">
        <div className="px-4 pt-3">
          <div className="mt-3 grid grid-cols-3 gap-2" aria-label={`Step ${stage} of 3`}>
            {[1, 2, 3].map((item) => <span key={item} className={cn("h-1 rounded-full", item <= stage ? "bg-cobalt" : "bg-ink/12")} />)}
          </div>
        </div>

        {stage === 1 && (
          <section className="px-4 pt-5">
            <p className="eyebrow">Step 1 · Evidence</p>
            <h1 className="mt-1 text-[29px] font-bold leading-[1.08] tracking-[-0.04em]">Do you recognize this MetroNet increase?</h1>
            <p className="mt-2 text-sm leading-5 text-muted">Nothing will be changed or sent. Your answer tells Budgefi what to do next.</p>
            <div className="mt-5"><ProofPair /></div>
            <div className="mt-5">
              <p className="mb-3 text-sm font-semibold">What happened?</p>
              <RadioGroup value={state.reviewAnswer ?? ""} onValueChange={(v) => state.setReviewAnswer(v as ReviewAnswer)} className="space-y-2">
                {answers.map((answer) => (
                  <label key={answer.value} className="flex min-h-[70px] cursor-pointer items-center gap-3 rounded-2xl border border-ink/12 bg-white p-3 has-[[data-state=checked]]:border-cobalt has-[[data-state=checked]]:bg-cobalt/[0.035]">
                    <RadioGroupItem value={answer.value} />
                    <span><span className="block text-sm font-semibold">{answer.title}</span><span className="mt-0.5 block text-xs text-muted">{answer.description}</span></span>
                  </label>
                ))}
              </RadioGroup>
            </div>
            <StickyAction><Button disabled={!state.reviewAnswer} onClick={() => setStage(2)} size="lg" className="w-full">Continue <ChevronRight className="size-4" /></Button></StickyAction>
          </section>
        )}

        {stage === 2 && (
          <section className="px-4 pt-5">
            <p className="eyebrow">Step 2 · Future plan</p>
            <h1 className="mt-1 text-[29px] font-bold leading-[1.08] tracking-[-0.04em]">What should happen next?</h1>
            <div className="mt-4 rounded-2xl border border-cobalt/15 bg-cobalt/[0.04] p-4">
              <div className="flex items-start gap-3"><ReceiptText className="mt-0.5 size-5 shrink-0 text-cobalt" strokeWidth={1.8} /><p className="text-sm leading-5"><strong>Your answer:</strong> {answers.find((item) => item.value === state.reviewAnswer)?.title}</p></div>
            </div>
            <RadioGroup value={state.planChoice ?? ""} onValueChange={(v) => state.setPlanChoice(v as PlanChoice)} className="mt-5 space-y-3">
              {choices.map((choice) => (
                <label key={choice.value} className="flex min-h-[78px] cursor-pointer items-center gap-3 rounded-2xl border border-ink/12 bg-white p-4 has-[[data-state=checked]]:border-cobalt has-[[data-state=checked]]:bg-cobalt/[0.035]">
                  <RadioGroupItem value={choice.value} />
                  <span><span className="block text-sm font-semibold">{choice.title}</span><span className="mt-1 block text-xs leading-4 text-muted">{choice.description}</span></span>
                </label>
              ))}
            </RadioGroup>
            <div className="mt-5 flex items-start gap-3 rounded-2xl bg-ink p-4 text-white">
              <ShieldCheck className="size-5 shrink-0 text-citron" strokeWidth={1.8} />
              <p className="text-xs leading-5 text-white/75">Budgefi records your choice and watches for proof. It won’t contact a merchant or move money without a separate approval.</p>
            </div>
            <StickyAction>
              <div className="grid grid-cols-[auto_1fr] gap-2"><Button onClick={() => setStage(1)} variant="outline" size="lg">Back</Button><Button disabled={!state.planChoice} onClick={save} size="lg">Save plan</Button></div>
            </StickyAction>
          </section>
        )}

        {stage === 3 && (
          <section className="px-4 pb-6 pt-10 text-center">
            <span className="mx-auto grid size-16 place-items-center rounded-[22px] bg-teal text-white"><Check className="size-8" strokeWidth={2} /></span>
            <p className="eyebrow mt-6">Plan saved</p>
            <h1 className="mt-1 text-[30px] font-bold tracking-[-0.04em]">We’re watching MetroNet</h1>
            <p className="mx-auto mt-2 max-w-[320px] text-sm leading-6 text-muted">The increase is recorded. When the next charge arrives, Budgefi will compare it with your plan and show the result.</p>
            <div className="mt-6 rounded-[22px] border border-ink/10 bg-white p-4 text-left">
              <p className="text-xs font-bold uppercase tracking-[.1em] text-muted">Next checkpoint</p>
              <div className="mt-3 flex items-center justify-between"><span className="text-sm font-semibold">September statement</span><span className="text-sm font-bold">Watching</span></div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink/10"><div className="h-full w-1/3 rounded-full bg-cobalt" /></div>
              <p className="mt-2 text-xs text-muted">Evidence saved · outcome pending</p>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-2"><Button asChild variant="outline"><Link to="/review">Review queue</Link></Button><Button asChild><Link to="/activity">View activity</Link></Button></div>
          </section>
        )}
      </main>
    </MobileShell>
  );
}

function GroceryCase() {
  const state = useAppState();
  return (
    <MobileShell>
      <main className="px-4 pb-8 pt-3">
        <p className="eyebrow mt-6">Matched evidence</p>
        <h1 className="mt-1 text-[29px] font-bold leading-tight tracking-[-0.04em]">Were both Green Basket charges yours?</h1>
        <div className="mt-5 space-y-2 rounded-[22px] border border-ink/10 bg-white p-4">
          <div className="flex justify-between border-b border-ink/8 pb-3"><span><strong className="block text-sm">Green Basket</strong><small className="text-muted">Aug 27 · 6:42 PM</small></span><strong>$47.82</strong></div>
          <div className="flex justify-between pt-1"><span><strong className="block text-sm">Green Basket</strong><small className="text-muted">Aug 27 · 6:44 PM</small></span><strong>$47.82</strong></div>
        </div>
        {!state.grocerySaved ? <>
          <RadioGroup value={state.groceryAnswer ?? ""} onValueChange={(value) => state.setGroceryAnswer(value as GroceryAnswer)} className="mt-5 space-y-2">
            {[
              ["both", "Yes, both are mine", "Keep both transactions as normal spending."],
              ["duplicate", "One may be a duplicate", "Record the exception and watch for a reversal."],
              ["unsure", "I’m not sure", "Keep the evidence and check the next statement."],
            ].map(([value, title, description]) => <label key={value} className="flex min-h-[72px] cursor-pointer items-center gap-3 rounded-2xl border border-ink/12 bg-white p-3 has-[[data-state=checked]]:border-cobalt has-[[data-state=checked]]:bg-cobalt/[0.035]"><RadioGroupItem value={value} /><span><strong className="block text-sm">{title}</strong><span className="mt-0.5 block text-xs text-muted">{description}</span></span></label>)}
          </RadioGroup>
          <Button disabled={!state.groceryAnswer} className="mt-5 w-full" size="lg" onClick={state.saveGrocery}>Save answer</Button>
        </> : <div className="mt-5 rounded-[22px] border border-teal/20 bg-teal/5 p-5 text-center"><span className="mx-auto grid size-12 place-items-center rounded-2xl bg-teal text-white"><Check className="size-6" /></span><h2 className="mt-3 text-lg font-bold">Review complete</h2><p className="mt-1 text-sm text-muted">Your answer is saved in Activity with the matched charges.</p><Button asChild className="mt-4 w-full"><Link to="/activity">View proof trail</Link></Button></div>}
      </main>
    </MobileShell>
  );
}

function StickyAction({ children }: { children: React.ReactNode }) {
  return <div className="sticky bottom-0 z-10 -mx-4 mt-6 border-t border-ink/10 bg-paper/95 px-4 pb-[calc(16px+env(safe-area-inset-bottom))] pt-3 backdrop-blur">{children}</div>;
}
