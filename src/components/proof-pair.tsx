import { CandidateIcon, ExpectedIcon, ObservedIcon } from '@/components/icons'
import { cn } from '@/lib/utils'

export function ProofPair({compact=false}:{compact?:boolean}) { return <div className={cn('rounded-xl border border-rule bg-sheet',compact?'p-3':'p-3.5')}>
  <div className="mb-2.5 flex items-center justify-between gap-2 text-xs font-semibold"><span>Candidate match</span><span className="text-carbon/55">Not verified</span></div>
  <div className="rounded-[10px] border border-rule bg-white/55 p-3">
    <div className="flex gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-lg border border-rule bg-sheet text-pencil"><ExpectedIcon className="size-6"/></span><div className="min-w-0 flex-1"><div className="text-[11px] font-bold tracking-[.13em] text-pencil">EXPECTED</div><div className="font-semibold">MetroNet recurring plan</div><div className="mt-1 text-sm"><span className="tabular font-semibold">$65.00</span> · due Aug 27</div>{!compact&&<div className="text-xs text-carbon/55">Confirmed Jul 27</div>}</div></div>
  </div>
  <div className="relative mx-6 flex h-10 items-center justify-center text-[11px] font-semibold text-pencil"><span className="absolute left-1/2 h-full w-px -translate-x-1/2 bg-pencil"/><span className="relative bg-sheet px-2">Same merchant and date</span></div>
  <div className="rounded-[10px] border border-rule bg-white/55 p-3">
    <div className="flex gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-lg border border-rule bg-sheet text-pencil"><ObservedIcon className="size-6"/></span><div className="min-w-0 flex-1"><div className="text-[11px] font-bold tracking-[.13em] text-pencil">OBSERVED</div><div className="font-semibold">MetroNet · First Platypus •00</div><div className="mt-1 text-sm"><span className="tabular font-semibold">$83.20</span> · posted Aug 27</div>{!compact&&<div className="text-xs text-carbon/55">Synthetic sandbox observation</div>}</div></div>
  </div>
  <div className="mt-2.5 flex items-start gap-2 border-t border-rule pt-2.5"><CandidateIcon className="mt-0.5 size-5 shrink-0 text-coral"/><p className="text-sm leading-snug"><b className="tabular">+$18.20 difference</b><span className="text-carbon/65"> · merchant and date align</span></p></div>
</div> }
