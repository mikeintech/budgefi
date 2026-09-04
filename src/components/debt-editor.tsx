import { useEffect, useState } from "react";
import { CreditCard, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useAppState, type Debt, type FinancialAccount } from "@/state/app-state";

export function DebtEditor({ debt, account, compact = false }: { debt?: Debt; account?: FinancialAccount; compact?: boolean }) {
  const state = useAppState();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(debt?.name ?? account?.name ?? "Credit card");
  const [type, setType] = useState<Debt["type"]>(debt?.type ?? (account?.type === "credit" ? "credit_card" : "other"));
  const [balance, setBalance] = useState(debt?.balance ? Number(debt.balance.owed.minor) / 100 : 0);
  const [apr, setApr] = useState(debt?.apr ? debt.apr.basisPoints / 100 : 0);
  const [hasApr, setHasApr] = useState(Boolean(debt?.apr));
  const [minimum, setMinimum] = useState(debt?.terms?.minimumPayment ? Number(debt.terms.minimumPayment.minor) / 100 : 0);
  const [due, setDue] = useState(debt?.terms?.nextDueOn ?? "");
  const [paymentMode, setPaymentMode] = useState<"minimum_due" | "fixed_amount">(debt?.paymentPolicy?.mode === "fixed_amount" ? "fixed_amount" : "minimum_due");
  const [fixed, setFixed] = useState(debt?.paymentPolicy?.fixedAmount ? Number(debt.paymentPolicy.fixedAmount.minor) / 100 : 0);
  const [extra, setExtra] = useState(debt?.paymentPolicy ? Number(debt.paymentPolicy.extraAmount.minor) / 100 : 0);
  const [link, setLink] = useState(debt?.linkedCommitmentId ?? "none");
  const [createPayment, setCreatePayment] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const manual = debt ? debt.provenance === "manual" : !account;
  useEffect(() => {
    if (!open) return;
    setName(debt?.name ?? account?.name ?? "Credit card");
    setType(debt?.type ?? (account?.type === "credit" ? "credit_card" : "other"));
    setBalance(debt?.balance ? Number(debt.balance.owed.minor) / 100 : 0);
    setApr(debt?.apr ? debt.apr.basisPoints / 100 : 0); setHasApr(Boolean(debt?.apr));
    setMinimum(debt?.terms?.minimumPayment ? Number(debt.terms.minimumPayment.minor) / 100 : 0);
    setDue(debt?.terms?.nextDueOn ?? ""); setLink(debt?.linkedCommitmentId ?? "none");
    setPaymentMode(debt?.paymentPolicy?.mode === "fixed_amount" ? "fixed_amount" : "minimum_due");
    setFixed(debt?.paymentPolicy?.fixedAmount ? Number(debt.paymentPolicy.fixedAmount.minor) / 100 : 0);
    setExtra(debt?.paymentPolicy ? Number(debt.paymentPolicy.extraAmount.minor) / 100 : 0);
    setCreatePayment(false); setMessage("");
  }, [open, debt, account]);
  const candidates = state.commitments.filter((item) => item.recurrence === "monthly" && !state.debts.some((other) => other.id !== debt?.id && other.linkedCommitmentId === item.id));
  const amountForNew = paymentMode === "fixed_amount" ? fixed : minimum;
  const showPaymentInputs = createPayment || Boolean(debt?.paymentManaged);
  const canSave = name.trim() && (!manual || balance >= 0) && (!createPayment || (amountForNew > 0 && due)) && (paymentMode !== "fixed_amount" || fixed > 0) && !saving;
  const money = (value: number) => ({ minor: String(Math.round(Math.max(0, value) * 100)), currency: "USD" as const });
  const save = async () => {
    if (!canSave) return;
    setSaving(true); setMessage("");
    const common = {
      name: name.trim(), type, linkedCommitmentId: createPayment ? null : link === "none" ? null : link,
      minimumPayment: minimum > 0 ? money(minimum) : null, nextDueOn: due || null,
      aprBasisPoints: hasApr ? Math.round(apr * 100) : null,
      paymentMode, fixedPayment: paymentMode === "fixed_amount" ? money(fixed) : null,
      extraPayment: money(extra), createPaymentCommitment: createPayment,
    };
    const okay = debt
      ? await state.updateDebt(debt, { ...common, currentBalance: manual ? money(balance) : null, status: debt.status === "needs_review" || debt.status === "paused" ? "active" : debt.status })
      : await state.createDebt({ ...common, accountId: account?.id ?? null, currentBalance: manual ? money(balance) : null });
    setSaving(false);
    if (okay) setOpen(false); else setMessage("The debt could not be saved. Review the details and try again.");
  };
  const archive = async () => {
    if (!debt || saving) return;
    setSaving(true); setMessage("");
    const okay = await state.updateDebt(debt, {
      name: debt.name, type: debt.type, linkedCommitmentId: debt.linkedCommitmentId,
      minimumPayment: debt.terms?.minimumPayment ?? null, nextDueOn: debt.terms?.nextDueOn ?? null,
      aprBasisPoints: debt.apr?.basisPoints ?? null, paymentMode: debt.paymentPolicy?.mode ?? "minimum_due",
      fixedPayment: debt.paymentPolicy?.fixedAmount ?? null,
      extraPayment: debt.paymentPolicy?.extraAmount ?? money(0), createPaymentCommitment: false,
      currentBalance: null, status: "archived",
    });
    setSaving(false);
    if (okay) setOpen(false); else setMessage("Tracking could not be stopped. Try again.");
  };
  return <Sheet open={open} onOpenChange={setOpen}>
    <SheetTrigger asChild>{debt || account ? <Button size="sm" variant={debt?.status === "needs_review" ? "outline" : "ghost"}>{debt?.status === "needs_review" ? "Review" : debt ? "Edit" : "Set up"}</Button> : <Button size={compact ? "sm" : "default"} variant={compact ? "ghost" : "outline"}><Plus className="size-4" /> Add debt</Button>}</SheetTrigger>
    <SheetContent side="bottom" className="max-h-[92dvh] overflow-y-auto">
      <SheetHeader><SheetTitle>{debt ? `Edit ${debt.name}` : account ? `Review ${account.name}` : "Add a debt"}</SheetTitle><SheetDescription>Track what is owed and reserve one payment. Budgefi never moves money or recommends a payoff strategy.</SheetDescription></SheetHeader>
      <div className="mt-5 space-y-4">
        {debt?.status === "paused" && <p className="rounded-2xl border border-pencil/40 bg-pencil/10 p-3 text-sm leading-5"><strong className="block">Bank tracking is paused</strong>{debt.linkedCommitmentId ? "Your existing payment is still planned, but bank verification is paused. Reconnect, then review this debt to resume." : "Reconnect the account, then review this debt to resume. No payment is reserved while it is paused."}</p>}
        <Field label="Name"><input className={inputClass} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Debt type"><select className={inputClass} value={type} onChange={(e) => setType(e.target.value as Debt["type"])}><option value="credit_card">Credit card</option><option value="student_loan">Student loan</option><option value="mortgage">Mortgage</option><option value="auto">Auto loan</option><option value="personal">Personal loan</option><option value="other">Other</option></select></Field>
        {manual ? <MoneyField label="Current amount owed" value={balance} onChange={setBalance} /> : <p className="rounded-2xl bg-recessed p-3 text-xs leading-5 text-muted"><CreditCard className="mr-2 inline size-4 text-cobalt" />Balance updates from {account?.name ?? debt?.name}. No account number is requested.</p>}
        <div className="grid grid-cols-2 gap-3"><MoneyField label="Minimum · optional" value={minimum} onChange={setMinimum} /><Field label="Next due · optional"><input type="date" className={inputClass} value={due} onChange={(e) => setDue(e.target.value)} /></Field></div>
        <div className="rounded-2xl bg-recessed p-3"><div className="flex items-center justify-between gap-3"><span><strong className="block text-sm">Add APR</strong><span className="text-xs text-muted">Only needed for a payoff estimate</span></span><Switch checked={hasApr} onCheckedChange={setHasApr} label="Add APR" /></div>{hasApr && <div className="mt-3 flex h-12 items-center rounded-xl border border-rule bg-white px-3"><NumberInput min={0} max={1000} value={apr} onValueChange={setApr} className="h-full min-w-0 flex-1 text-base font-bold outline-none" /><span className="text-muted">%</span></div>}</div>
        <Field label="Payment already in your plan"><select className={inputClass} value={link} disabled={createPayment} onChange={(e) => setLink(e.target.value)}><option value="none">None</option>{candidates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-rule p-3"><span><strong className="block text-sm">Create monthly payment</strong><span className="text-xs leading-5 text-muted">Adds it once to Upcoming and Plan</span></span><Switch checked={createPayment} onCheckedChange={(next) => { setCreatePayment(next); if (next) setLink("none"); }} label="Create monthly payment" /></div>
        {showPaymentInputs && <div className="space-y-4 rounded-2xl bg-recessed p-3"><Field label="How much do you plan to pay?"><select className={inputClass} value={paymentMode} onChange={(e) => setPaymentMode(e.target.value as typeof paymentMode)}><option value="minimum_due">Minimum due</option><option value="fixed_amount">Fixed monthly amount</option></select></Field>{paymentMode === "fixed_amount" && <MoneyField label="Fixed monthly amount" value={fixed} onChange={setFixed} />}<MoneyField label="Extra planned amount · optional" value={extra} onChange={setExtra} /><p className="text-xs leading-5 text-muted">These amounts update the same payment reserved in Plan.</p></div>}
        {message && <p className="text-sm text-coral">{message}</p>}
        <Button className="w-full" size="lg" disabled={!canSave} onClick={() => void save()}>{saving ? "Saving…" : debt?.status === "needs_review" ? "Confirm debt" : debt ? "Save debt" : "Add debt"}</Button>
        {debt && <Button className="w-full" variant="ghost" disabled={saving} onClick={() => void archive()}>{debt.status === "needs_review" ? "Don’t track this debt" : "Stop tracking this debt"}</Button>}
      </div>
    </SheetContent>
  </Sheet>;
}

const inputClass = "h-12 w-full rounded-xl border border-rule bg-white px-3 text-sm font-semibold outline-none focus:ring-2 focus:ring-pencil";
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block text-xs font-semibold">{label}<div className="mt-2">{children}</div></label>; }
function MoneyField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) { return <Field label={label}><div className="flex h-12 items-center rounded-xl border border-rule bg-white px-3 focus-within:ring-2 focus-within:ring-pencil"><span className="text-muted">$</span><NumberInput min={0} value={value} onValueChange={onChange} className="h-full min-w-0 flex-1 px-2 text-base font-bold outline-none" /></div></Field>; }
