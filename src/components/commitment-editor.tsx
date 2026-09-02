import { useState } from "react";
import { Check, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { nextMonthlyDate } from "@/lib/dates";
import { useAppState, type PlanCalibrationData, type PlanCommitment } from "@/state/app-state";

const fixedFields = {
  rent: { amount: "rentAmount", date: "rentDueDate", day: 1 },
  electric: { amount: "electricMax", date: "electricDueDate", day: 10 },
  streambox: { amount: "streamBoxAmount", date: "streamBoxDueDate", day: 15 },
  subscriptions: { amount: "streamBoxAmount", date: "streamBoxDueDate", day: 15 },
  insurance: { amount: "insuranceAmount", date: "insuranceDueDate", day: 20 },
} as const;

type FixedName = keyof typeof fixedFields;

export function CommitmentEditor({item,compact=false}:{item:PlanCommitment;compact?:boolean}) {
  const state=useAppState();
  const fixed=fixedFields[item.name.toLowerCase() as FixedName];
  const initialDate=item.dueDate??(fixed?nextMonthlyDate(state.authoritativeProjection.horizonStart,fixed.day):state.authoritativeProjection.horizonEnd);
  const [open,setOpen]=useState(false);
  const [name,setName]=useState(item.name);
  const [amount,setAmount]=useState(Number(BigInt(item.amount.minor))/100);
  const [dueDate,setDueDate]=useState(initialDate);
  const [saving,setSaving]=useState(false);
  const normalizedName=name.trim().toLocaleLowerCase();
  const nameTaken=state.commitments.some(entry=>entry.id!==item.id&&entry.name.trim().toLocaleLowerCase()===normalizedName);
  const resetDraft=()=>{setName(item.name);setAmount(Number(BigInt(item.amount.minor))/100);setDueDate(initialDate)};
  const updateCalibration=(remove=false):PlanCalibrationData=>{
    if(fixed){
      const edited=state.calibration.editedCommitments.includes(fixed.amount)?state.calibration.editedCommitments:[...state.calibration.editedCommitments,fixed.amount];
      const withoutCurrent=state.calibration.customCommitments.filter(entry=>entry.id!==item.id);
      return {...state.calibration,[fixed.amount]:0,[fixed.date]:"",editedCommitments:edited,customCommitments:remove?withoutCurrent:[...withoutCurrent,{id:item.id,name:name.trim(),amount,dueDate}]};
    }
    const exists=state.calibration.customCommitments.some(entry=>entry.id===item.id);
    return {...state.calibration,customCommitments:remove
      ?state.calibration.customCommitments.filter(entry=>entry.id!==item.id)
      :exists
        ?state.calibration.customCommitments.map(entry=>entry.id===item.id?{...entry,name:name.trim(),amount,dueDate}:entry)
        :[...state.calibration.customCommitments,{id:item.id,name:name.trim(),amount,dueDate}]};
  };
  const persist=async(remove=false)=>{setSaving(true);const okay=await state.savePlanCalibration(updateCalibration(remove),state.planningBuffer);setSaving(false);if(okay)setOpen(false)};
  if(item.provenance!=="manual")return null;
  return <Sheet open={open} onOpenChange={next=>{setOpen(next);if(next)resetDraft()}}>
    <SheetTrigger asChild><Button aria-label={`Edit ${item.name}`} variant="ghost" size="sm" className={compact?"h-9 px-2.5 text-[11px] text-pencil":"mt-0.5 h-8 px-2 text-[11px] text-pencil"}><Pencil className="size-3"/>Edit</Button></SheetTrigger>
    <SheetContent side="bottom" className="mx-auto max-w-[430px] rounded-t-[28px]">
      <SheetHeader><SheetTitle>Edit commitment</SheetTitle><SheetDescription>Changes update the plan and remain in your activity history.</SheetDescription></SheetHeader>
      <label className="mt-5 block text-sm font-semibold" htmlFor={`commitment-name-${item.id}`}>Name</label><input id={`commitment-name-${item.id}`} value={name} maxLength={120} onChange={event=>setName(event.target.value)} className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-base font-semibold outline-none focus:ring-2 focus:ring-pencil"/>
      {nameTaken&&<p className="mt-2 text-xs font-semibold text-coral">Use a unique name for each commitment.</p>}
      <label className="mt-5 block text-sm font-semibold" htmlFor={`commitment-amount-${item.id}`}>Expected amount</label><div className="mt-2 flex h-12 items-center rounded-xl border border-rule bg-white px-3 focus-within:ring-2 focus-within:ring-pencil"><span className="text-muted">$</span><NumberInput id={`commitment-amount-${item.id}`} value={amount} onValueChange={setAmount} min={0} step="0.01" inputMode="decimal" className="h-full min-w-0 flex-1 bg-transparent px-2 text-lg font-bold outline-none"/></div>
      <label className="mt-4 block text-sm font-semibold" htmlFor={`commitment-date-${item.id}`}>Due date <span className="font-normal text-muted">(optional)</span></label><input id={`commitment-date-${item.id}`} type="date" value={dueDate} onChange={event=>setDueDate(event.target.value)} className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-base outline-none focus:ring-2 focus:ring-pencil"/>
      {!dueDate&&<p className="mt-2 text-xs text-muted">This stays visible but is not reserved until it has a due date.</p>}
      <Button disabled={saving||!name.trim()||nameTaken||amount<=0} onClick={()=>void persist()} className="mt-5 w-full" size="lg"><Check className="size-4"/>{saving?"Saving…":"Save commitment"}</Button>
      <Button disabled={saving} variant="ghost" onClick={()=>void persist(true)} className="mt-2 w-full text-coral"><Trash2 className="size-4"/>Remove commitment</Button>
    </SheetContent>
  </Sheet>;
}
