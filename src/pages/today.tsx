import { Link } from "react-router-dom";
import { CalendarDays, ChevronRight, CloudOff, House, ShoppingBasket, Tv, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HealthSheet, MobileShell } from "@/components/layout";
import { MoneySummary } from "@/components/money-summary";
import { ProofPair } from "@/components/proof-pair";
import { useAppState } from "@/state/app-state";
import { money } from "@/lib/utils";

export function TodayPage() {
  const { reviewSaved, grocerySaved, sourceStale, calibration } = useAppState();
  const upcoming = [
    { icon: House, label: "Rent", meta: `Sep 1 · ${calibration.editedCommitments.includes('rentAmount')?'you entered':'confirmed'}`, amount: money(calibration.rentAmount) },
    { icon: Zap, label: "Electric", meta: `Sep 4 · ${calibration.editedCommitments.includes('electricMax')?'you entered':'estimated range'}`, amount: `$130–${money(calibration.electricMax)}` },
    { icon: Tv, label: "StreamBox", meta: `Sep 6 · ${calibration.editedCommitments.includes('streamBoxAmount')?'you entered':'detected'}`, amount: money(calibration.streamBoxAmount) },
  ];

  return (
    <MobileShell>
      <main className="px-4 pb-8 pt-5">
        <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
          <CalendarDays className="size-4" strokeWidth={1.8} />
          Saturday, August 29
        </div>
        <MoneySummary />

        {sourceStale && (
          <div className="mt-3 flex items-center justify-between gap-3 rounded-2xl border border-amber-500/25 bg-amber-50 px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <CloudOff className="size-5 shrink-0 text-amber-700" strokeWidth={1.8} />
              <div className="min-w-0">
                <p className="text-sm font-semibold">MetroCard needs attention</p>
                <p className="truncate text-xs text-muted">Last refreshed 2 days ago</p>
              </div>
            </div>
            <HealthSheet>
              <Button size="sm" variant="outline">Fix</Button>
            </HealthSheet>
          </div>
        )}

        <section className="mt-7" aria-labelledby="review-heading">
          <div className="mb-3 flex items-end justify-between">
            <div>
              <p className="eyebrow">Needs your input</p>
              <h1 id="review-heading" className="text-[27px] font-bold leading-none tracking-[-0.035em]">{grocerySaved ? "You’re caught up" : "One thing to review"}</h1>
            </div>
            <Badge>{grocerySaved ? "0 open" : reviewSaved ? "1 open" : "1 of 2"}</Badge>
          </div>

          {!reviewSaved ? <article className="overflow-hidden rounded-[24px] border border-ink/12 bg-white shadow-card">
            <div className="border-b border-ink/8 bg-cobalt/[0.045] px-4 py-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <Badge>Possible bill change</Badge>
                <span className="text-xs font-medium text-muted">2 min</span>
              </div>
              <h2 className="text-xl font-bold tracking-[-0.025em]">MetroNet looks higher than expected</h2>
              <p className="mt-1 text-sm leading-5 text-muted">We found the evidence. You decide what it means before anything changes.</p>
            </div>
            <div className="p-4">
              <ProofPair compact />
              <Button asChild className="mt-4 w-full" size="lg">
                <Link to="/review/metronet">Review the evidence <ChevronRight className="size-4" /></Link>
              </Button>
            </div>
          </article> : !grocerySaved ? <article className="overflow-hidden rounded-[24px] border border-ink/12 bg-white shadow-card">
            <div className="border-b border-ink/8 bg-cobalt/[0.045] px-4 py-4">
              <div className="mb-2 flex items-center justify-between gap-2"><Badge>Possible duplicate</Badge><span className="text-xs font-medium text-muted">1 min</span></div>
              <h2 className="text-xl font-bold tracking-[-0.025em]">Two Green Basket charges look alike</h2>
              <p className="mt-1 text-sm leading-5 text-muted">They posted two minutes apart for the same amount.</p>
            </div>
            <div className="p-4">
              <div className="divide-y divide-ink/8 rounded-2xl border border-ink/10">
                {["6:42 PM", "6:44 PM"].map((time) => <div key={time} className="flex items-center justify-between p-3"><span><strong className="block text-sm">Green Basket</strong><small className="text-muted">Aug 27 · {time}</small></span><strong className="tabular-nums">$47.82</strong></div>)}
              </div>
              <Button asChild className="mt-4 w-full" size="lg"><Link to="/review/grocery">Inspect both charges <ChevronRight className="size-4" /></Link></Button>
            </div>
          </article> : <article className="rounded-[24px] border border-teal/20 bg-white p-5 text-center shadow-card">
            <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-teal text-white"><CalendarDays className="size-6" strokeWidth={1.8} /></span>
            <h2 className="mt-3 text-lg font-bold">No decisions waiting</h2>
            <p className="mt-1 text-sm leading-5 text-muted">Budgefi is watching the plans you saved and will bring back anything that needs proof.</p>
            <Button asChild className="mt-4 w-full" variant="outline"><Link to="/activity">See what’s being watched</Link></Button>
          </article>}

          {reviewSaved && (
            <div className="mt-3 rounded-2xl border border-teal/25 bg-teal/5 p-4">
              <p className="text-sm font-semibold text-teal">MetroNet plan saved</p>
              <p className="mt-1 text-sm text-muted">We’ll watch the next charge and verify whether the new amount holds.</p>
            </div>
          )}
        </section>

        <section className="mt-8" aria-labelledby="coming-up-heading">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="eyebrow">Next 8 days</p>
              <h2 id="coming-up-heading" className="text-xl font-bold tracking-[-0.025em]">Coming up</h2>
            </div>
            <Button asChild size="sm" variant="ghost"><Link to="/plan">See plan</Link></Button>
          </div>
          <div className="divide-y divide-ink/8 overflow-hidden rounded-[22px] border border-ink/10 bg-white">
            {upcoming.map(({ icon: Icon, label, meta, amount }) => (
              <Link key={label} to="/plan" className="flex min-h-[72px] items-center gap-3 px-4 py-3 transition-colors hover:bg-ink/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cobalt">
                <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-paper-deep text-cobalt">
                  <Icon className="size-5" strokeWidth={1.8} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{label}</span>
                  <span className="block truncate text-xs text-muted">{meta}</span>
                </span>
                <span className="text-sm font-bold tabular-nums">{amount}</span>
                <ChevronRight className="size-4 text-muted" />
              </Link>
            ))}
          </div>
        </section>

        <section className="mt-8">
          <p className="eyebrow">Quietly working</p>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <Link to="/review" className="rounded-[20px] border border-ink/10 bg-white p-4 shadow-sm transition-transform active:scale-[.98]">
              <ShoppingBasket className="size-5 text-cobalt" strokeWidth={1.8} />
              <p className="mt-5 text-sm font-semibold">Grocery duplicate?</p>
              <p className="mt-1 text-xs leading-4 text-muted">Waiting for one more signal</p>
            </Link>
            <Link to="/activity" className="rounded-[20px] border border-ink/10 bg-ink p-4 text-white shadow-sm transition-transform active:scale-[.98]">
              <Tv className="size-5 text-citron" strokeWidth={1.8} />
              <p className="mt-5 text-sm font-semibold">StreamBox</p>
              <p className="mt-1 text-xs leading-4 text-white/65">Next charge is being watched</p>
            </Link>
          </div>
        </section>
      </main>
    </MobileShell>
  );
}
