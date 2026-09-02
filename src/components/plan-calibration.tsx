import { useEffect, useMemo, useState } from "react";
import type { OnboardingAnalysisResponse } from "@budgefi/contracts";
import {
  ChevronRight,
  Landmark,
  PenLine,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  WalletCards,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { Switch } from "@/components/ui/switch";
import {
  calculatePlanProjection,
  type FinancialAccount,
  type IncomeFrequency,
  type PlanCalibrationData,
  useAppState,
} from "@/state/app-state";
import { withSuggestedCommitmentDates } from "@/lib/commitment-defaults";
import { nextMonthlyDate } from "@/lib/dates";
import { cn, money } from "@/lib/utils";

const stageNames = ["Cash scope", "Income timing", "Commitments", "Guardrails"];
let commitmentSequence = 0;
const createCommitmentId = () =>
  `custom-${Date.now().toString(36)}-${(commitmentSequence++).toString(36)}`;

export function PlanCalibration({
  onComplete,
  onBack,
  onDraftComplete,
  onDraftChange,
  onStageChange,
  initialData,
  initialBuffer,
  initialStage = 0,
  embedded = false,
  manual = false,
  analysis = null,
}: {
  onComplete?: () => void;
  onBack?: () => void;
  onDraftComplete?: (data: PlanCalibrationData, buffer: number) => void;
  onDraftChange?: (data: PlanCalibrationData, buffer: number) => void;
  onStageChange?: (stage: number) => void;
  initialData?: PlanCalibrationData;
  initialBuffer?: number;
  initialStage?: number;
  embedded?: boolean;
  manual?: boolean;
  analysis?: OnboardingAnalysisResponse | null;
}) {
  const state = useAppState();
  const [stage, setStage] = useState(Math.max(0, Math.min(3, initialStage)));
  const [draft, setDraft] = useState<PlanCalibrationData>(() => {
    const base = manual
      ? {
          ...state.calibration,
          includeChase: false,
          includeJoint: false,
          cashProvenance: "user_entered" as const,
          editedCommitments: [
            "rentAmount",
            "electricMax",
            "streamBoxAmount",
            "insuranceAmount",
          ],
        }
      : state.calibration;
    return withSuggestedCommitmentDates(
      initialData ? mergeCalibrationDraft(base, initialData) : base,
      state.authoritativeProjection.horizonStart,
      state.authoritativeProjection.horizonEnd,
    );
  });
  const [buffer, setBuffer] = useState(initialBuffer ?? state.planningBuffer);
  const [cashEdited, setCashEdited] = useState(
    manual || state.calibration.cashProvenance === "user_entered",
  );
  const [zeroCashConfirmed, setZeroCashConfirmed] = useState(false);
  const [commitmentDatesReviewed, setCommitmentDatesReviewed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingAccountIds, setPendingAccountIds] = useState<string[]>([]);
  const cashAccounts = useMemo(
    () =>
      state.accounts.filter(
        (account) =>
          ["cash", "checking", "savings"].includes(account.type) &&
          account.balance,
      ),
    [state.accounts],
  );
  const [includedIds, setIncludedIds] = useState<string[]>(() =>
    cashAccounts
      .filter((account) => account.includeInPlan)
      .map((account) => account.id),
  );
  useEffect(() => {
    if (!manual)
      setIncludedIds(
        cashAccounts
          .filter((account) => account.includeInPlan)
          .map((account) => account.id),
      );
  }, [cashAccounts, manual]);
  const projection = calculatePlanProjection(
    draft,
    buffer,
    state.authoritativeProjection.horizonEnd,
  );
  const customInvalid = draft.customCommitments.some(
    (item) => !item.name.trim() || item.amount <= 0,
  );
  const fixedCommitments = [
    { name: draft.rentName, amount: draft.rentAmount, date: draft.rentDueDate },
    { name: draft.electricName, amount: draft.electricMax, date: draft.electricDueDate },
    { name: draft.streamBoxName, amount: draft.streamBoxAmount, date: draft.streamBoxDueDate },
    { name: draft.insuranceName, amount: draft.insuranceAmount, date: draft.insuranceDueDate },
  ];
  const activeNames = [
    ...fixedCommitments.filter((item) => item.amount > 0).map((item) => item.name.trim().toLocaleLowerCase()),
    ...draft.customCommitments.filter((item) => item.amount > 0).map((item) => item.name.trim().toLocaleLowerCase()),
  ];
  const commitmentInvalid =
    customInvalid ||
    fixedCommitments.some((item) => item.amount > 0 && !item.name.trim()) ||
    new Set(activeNames).size !== activeNames.length;
  const hasDatedCommitments =
    fixedCommitments.some((item) => item.amount > 0 && Boolean(item.date)) ||
    draft.customCommitments.some((item) => item.amount > 0 && Boolean(item.dueDate));
  useEffect(() => {
    onDraftChange?.(draft, buffer);
  }, [draft, buffer, onDraftChange]);
  useEffect(() => {
    onStageChange?.(stage);
  }, [stage, onStageChange]);

  const setIncluded = async (account: FinancialAccount, included: boolean) => {
    if (pendingAccountIds.includes(account.id)) return;
    const previousIds = includedIds;
    const nextIds = included
      ? [...new Set([...includedIds, account.id])]
      : includedIds.filter((id) => id !== account.id);
    setIncludedIds(nextIds);
    setPendingAccountIds((value) => [...value, account.id]);
    setCashEdited(false);
    const cashFor = (ids: string[]) =>
      cashAccounts
        .filter((item) => ids.includes(item.id))
        .reduce(
          (sum, item) => sum + Number(BigInt(item.balance?.minor ?? "0")) / 100,
          0,
        );
    setDraft((value) => ({
      ...value,
      includeChase: nextIds.length > 0,
      includeJoint: false,
      cashProvenance: "observed",
      knownCash: cashFor(nextIds),
    }));
    const okay = await state.setAccountInclusion(account, included);
    setPendingAccountIds((value) => value.filter((id) => id !== account.id));
    if (!okay) {
      setIncludedIds(previousIds);
      setDraft((value) => ({
        ...value,
        includeChase: previousIds.length > 0,
        knownCash: cashFor(previousIds),
      }));
    }
  };
  const finish = async () => {
    const completed = {
      ...draft,
      includeChase: includedIds.length > 0,
      includeJoint: false,
      cashProvenance: cashEdited
        ? ("user_entered" as const)
        : ("observed" as const),
    };
    if (onDraftComplete) {
      onDraftComplete(completed, buffer);
      onComplete?.();
      return;
    }
    setSaving(true);
    const okay = await state.savePlanCalibration(completed, buffer);
    setSaving(false);
    if (okay) onComplete?.();
  };

  return (
    <div
      className={cn(
        "flex flex-1 flex-col",
        !embedded && "min-h-[calc(100dvh-126px)]",
      )}
    >
      <div className="mb-5">
        <div
          className="grid grid-cols-4 gap-1.5"
          aria-label={`Plan setup step ${stage + 1} of 4`}
        >
          {stageNames.map((name, index) => (
            <span
              key={name}
              className={cn(
                "h-1 rounded-full",
                index <= stage ? "bg-pencil" : "bg-carbon/12",
              )}
            />
          ))}
        </div>
        <p className="mt-2 text-right text-[10px] font-bold uppercase tracking-[.1em] text-muted">
          Plan setup · {stage + 1} of 4
        </p>
      </div>
      {stage === 0 && analysis && <AnalysisNotice analysis={analysis} />}
      {stage === 0 && (
        <CashScope
          manual={manual}
          draft={draft}
          setDraft={setDraft}
          accounts={cashAccounts}
          includedIds={includedIds}
          pendingAccountIds={pendingAccountIds}
          setIncluded={setIncluded}
          cashEdited={cashEdited}
          setCashEdited={setCashEdited}
          zeroCashConfirmed={zeroCashConfirmed}
          setZeroCashConfirmed={setZeroCashConfirmed}
        />
      )}
      {stage === 1 && (
        <IncomeTiming manual={manual} draft={draft} setDraft={setDraft} />
      )}
      {stage === 2 && (
        <Commitments
          manual={manual}
          draft={draft}
          setDraft={setDraft}
          requireDateReview={embedded}
          datesReviewed={commitmentDatesReviewed}
          setDatesReviewed={setCommitmentDatesReviewed}
        />
      )}
      {stage === 3 && (
        <Guardrails
          draft={draft}
          setDraft={setDraft}
          buffer={buffer}
          setBuffer={setBuffer}
          projection={projection}
          stale={!manual && state.sourceStale}
        />
      )}
      <div className="mt-auto grid grid-cols-[auto_1fr] gap-2 pt-6">
        <Button
          variant="outline"
          size="lg"
          disabled={saving || pendingAccountIds.length > 0}
          onClick={() =>
            stage === 0 ? onBack?.() : setStage((value) => value - 1)
          }
        >
          Back
        </Button>
        <Button
          size="lg"
          disabled={
            saving ||
            pendingAccountIds.length > 0 ||
            (stage === 0 &&
              (draft.knownCash < 0 ||
                (draft.knownCash === 0 && (!manual || !zeroCashConfirmed)))) ||
            (stage === 2 &&
              (commitmentInvalid ||
                (embedded && hasDatedCommitments && !commitmentDatesReviewed)))
          }
          onClick={() =>
            stage < 3 ? setStage((value) => value + 1) : void finish()
          }
        >
          {saving ? (
            "Saving…"
          ) : stage < 3 ? (
            <>
              Continue <ChevronRight className="size-4" />
            </>
          ) : projection.available < 0 ? (
            "Continue with shortfall"
          ) : (
            "Use this plan"
          )}
        </Button>
      </div>
      {stage === 0 &&
        draft.knownCash === 0 &&
        (!manual || !zeroCashConfirmed) && (
          <p className="mt-2 text-center text-xs text-coral">
            {manual
              ? "Confirm that $0 is your current spendable cash."
              : "Include at least one spendable cash account."}
          </p>
        )}
      {stage === 2 && commitmentInvalid && (
        <p className="mt-2 text-center text-xs text-coral">
          Every commitment needs a unique name and an amount—or set it to $0
          or remove it. Due dates may be added later.
        </p>
      )}
      {stage === 2 &&
        embedded &&
        hasDatedCommitments &&
        !commitmentDatesReviewed &&
        !commitmentInvalid && (
          <p className="mt-2 text-center text-xs text-coral">
            Review and confirm the commitment dates before continuing.
          </p>
        )}
    </div>
  );
}

function AnalysisNotice({
  analysis,
}: {
  analysis: OnboardingAnalysisResponse;
}) {
  const added =
    analysis.suggestions.commitments.length +
    Number(Boolean(analysis.suggestions.income)) +
    Number(Boolean(analysis.suggestions.savings));
  const keptOut =
    analysis.suggestions.filtered.length +
    analysis.suggestions.needsReview.length;
  return (
    <div
      className={cn(
        "mb-4 rounded-2xl border p-4",
        analysis.state === "ready"
          ? "border-leaf/20 bg-leaf/[.055]"
          : "border-rule bg-recessed",
      )}
      role="status"
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-xl",
            analysis.state === "ready"
              ? "bg-leaf text-white"
              : "bg-white text-pencil",
          )}
        >
          <Sparkles className="size-[18px]" />
        </span>
        <span>
          <strong className="block text-sm">
            {analysis.state === "ready"
              ? `${added} ${added === 1 ? "suggestion" : "suggestions"} added to this draft`
              : analysis.state === "history_syncing"
                ? "Activity is still arriving"
                : "Start with your own numbers"}
          </strong>
          <span className="mt-1 block text-xs leading-5 text-muted">
            {analysis.notice}
          </span>
          {analysis.state === "ready" && keptOut > 0 && (
            <span className="mt-1 block text-[11px] leading-4 text-muted">
              {keptOut} uncertain, transfer, refund, or ordinary{" "}
              {keptOut === 1 ? "pattern was" : "patterns were"} kept out.
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

function CashScope({
  manual,
  draft,
  setDraft,
  accounts,
  includedIds,
  pendingAccountIds,
  setIncluded,
  cashEdited,
  setCashEdited,
  zeroCashConfirmed,
  setZeroCashConfirmed,
}: {
  manual: boolean;
  draft: PlanCalibrationData;
  setDraft: React.Dispatch<React.SetStateAction<PlanCalibrationData>>;
  accounts: FinancialAccount[];
  includedIds: string[];
  pendingAccountIds: string[];
  setIncluded: (account: FinancialAccount, included: boolean) => Promise<void>;
  cashEdited: boolean;
  setCashEdited: (value: boolean) => void;
  zeroCashConfirmed: boolean;
  setZeroCashConfirmed: (value: boolean) => void;
}) {
  if (manual)
    return (
      <section>
        <p className="eyebrow">Manual cash</p>
        <h1 className="text-[29px] font-bold leading-tight tracking-[-.045em]">
          How much spendable cash is available today?
        </h1>
        <p className="mt-2 text-sm leading-5 text-muted">
          Add the current balances of checking and cash accounts you are willing
          to use. Leave emergency savings and credit limits out.
        </p>
        <div className="mt-5 rounded-[20px] border border-pencil/15 bg-white p-4">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-2xl bg-citron">
              <PenLine className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <strong className="block text-sm">Spendable cash today</strong>
              <span className="text-xs text-muted">
                Checking + usable cash accounts
              </span>
            </span>
            <Provenance label="You enter" />
          </div>
          <label
            htmlFor="manual-cash"
            className="mt-5 block text-xs font-semibold"
          >
            Current total
          </label>
          <div className="mt-2 flex h-14 items-center rounded-2xl border border-rule bg-white px-3 focus-within:ring-2 focus-within:ring-pencil">
            <span className="text-lg text-muted">$</span>
            <NumberInput
              id="manual-cash"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={draft.knownCash}
              onValueChange={(knownCash) => {
                setCashEdited(true);
                setZeroCashConfirmed(false);
                setDraft((value) => ({
                  ...value,
                  knownCash,
                  cashProvenance: "user_entered",
                }));
              }}
              className="h-full min-w-0 flex-1 bg-transparent px-2 text-xl font-bold outline-none"
            />
          </div>
          {draft.knownCash === 0 && (
            <label className="mt-3 flex min-h-12 cursor-pointer items-center justify-between gap-3 rounded-xl bg-recessed px-3">
              <span className="text-xs font-semibold">
                I confirm I have $0 spendable cash today
              </span>
              <Switch
                checked={zeroCashConfirmed}
                onCheckedChange={setZeroCashConfirmed}
                label="Confirm zero spendable cash"
              />
            </label>
          )}
        </div>
        <div className="mt-3 flex items-start gap-3 rounded-2xl bg-recessed p-4">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-pencil" />
          <p className="text-xs leading-5 text-muted">
            <strong className="text-ink">Simple on purpose:</strong> start from
            money you actually have, exclude credit availability, and keep
            protected savings outside everyday spending.
          </p>
        </div>
      </section>
    );
  return (
    <section>
      <p className="eyebrow">Observed cash</p>
      <h1 className="text-[29px] font-bold leading-tight tracking-[-.045em]">
        Which cash can this plan use?
      </h1>
      <p className="mt-2 text-sm leading-5 text-muted">
        Include deposit balances that can actually pay household commitments.
        Credit availability is never cash.
      </p>
      <div className="mt-5 space-y-2">
        {accounts.map((account) => (
          <AccountScope
            key={account.id}
            name={account.name}
            detail={
              account.balanceAsOf
                ? `Observed ${new Date(account.balanceAsOf).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
                : "Balance missing"
            }
            amount={Number(BigInt(account.balance?.minor ?? "0")) / 100}
            included={includedIds.includes(account.id)}
            onChange={(value) => void setIncluded(account, value)}
            locked={pendingAccountIds.includes(account.id)}
          />
        ))}
        {accounts.length === 0 && (
          <div className="rounded-2xl border border-dashed border-rule p-4 text-sm text-muted">
            No cash, checking, or savings balance is available. Return to
            Accounts & data or choose manual setup.
          </div>
        )}
      </div>
      <div className="mt-4 rounded-[20px] border border-pencil/15 bg-pencil/[.035] p-4">
        <div className="flex items-center justify-between">
          <span>
            <span className="block text-[10px] font-bold uppercase tracking-[.1em] text-muted">
              Included cash
            </span>
            <strong className="tabular mt-1 block text-2xl">
              {money(draft.knownCash)}
            </strong>
          </span>
          <Provenance label={cashEdited ? "You entered" : "Server observed"} />
        </div>
        <p className="mt-3 text-[11px] leading-4 text-muted">
          Account switches save to the ledger immediately. Correct user-entered
          balances in the manual workspace so provenance stays explicit.
        </p>
      </div>
    </section>
  );
}

function IncomeTiming({
  manual,
  draft,
  setDraft,
}: {
  manual: boolean;
  draft: PlanCalibrationData;
  setDraft: React.Dispatch<React.SetStateAction<PlanCalibrationData>>;
}) {
  const { authoritativeProjection } = useAppState();
  const inside =
    Boolean(draft.nextIncomeDate) &&
    draft.nextIncomeDate >= authoritativeProjection.horizonStart &&
    draft.nextIncomeDate <= authoritativeProjection.horizonEnd;
  const horizonEnd = formatCalibrationDate(authoritativeProjection.horizonEnd);
  return (
    <section>
      <p className="eyebrow">Optional planning context</p>
      <h1 className="text-[29px] font-bold leading-tight tracking-[-.045em]">
        When is money coming in?
      </h1>
      <p className="mt-2 text-sm leading-5 text-muted">
        Add a schedule only if it helps you reason about timing. This note does
        not increase available cash; future deposits remain excluded until
        received.
      </p>
      <div className="mt-5 rounded-[20px] border border-rule bg-white p-4">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <WalletCards className="size-5 text-pencil" />
            <strong className="text-sm">Primary paycheck</strong>
          </span>
          <Provenance label="Planning note" />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <Field label="Typical net amount">
            <MoneyInput
              value={draft.incomeAmount}
              onChange={(incomeAmount) =>
                setDraft((value) => ({ ...value, incomeAmount }))
              }
            />
          </Field>
          <Field label="Next expected date">
            <input
              type="date"
              value={draft.nextIncomeDate}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  nextIncomeDate: event.target.value,
                }))
              }
              className="h-12 w-full rounded-xl border border-rule bg-white px-3 text-base outline-none focus:ring-2 focus:ring-pencil"
            />
          </Field>
        </div>
        <label
          className="mt-4 block text-xs font-semibold"
          htmlFor="income-frequency"
        >
          Pay frequency
        </label>
        <select
          id="income-frequency"
          value={draft.incomeFrequency}
          onChange={(event) =>
            setDraft((value) => ({
              ...value,
              incomeFrequency: event.target.value as IncomeFrequency,
              incomeConfirmed:
                event.target.value === "irregular"
                  ? false
                  : value.incomeConfirmed,
            }))
          }
          className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-base outline-none focus:ring-2 focus:ring-pencil"
        >
          <option value="weekly">Weekly</option>
          <option value="biweekly">Every two weeks</option>
          <option value="semi_monthly">Twice a month</option>
          <option value="monthly">Monthly</option>
          <option value="irregular">Irregular</option>
        </select>
        <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl bg-recessed p-3">
          <span>
            <strong className="block text-sm">Schedule looks right</strong>
            <span className="text-xs text-muted">
              Planning note only; it does not affect cash
            </span>
          </span>
          <Switch
            checked={draft.incomeConfirmed}
            onCheckedChange={(incomeConfirmed) =>
              setDraft((value) => ({ ...value, incomeConfirmed }))
            }
            label="Confirm income schedule"
          />
        </div>
      </div>
      <div
        className={cn(
          "mt-4 rounded-2xl p-4 text-sm",
          inside ? "border border-pencil/15 bg-pencil/[.035]" : "bg-recessed",
        )}
      >
        <strong>
          {inside
            ? `${money(draft.incomeAmount)} noted by ${horizonEnd}`
            : draft.nextIncomeDate
              ? `Next pay is outside the plan through ${horizonEnd}`
              : "No income schedule added"}
        </strong>
        <p className="mt-1 text-xs leading-5 text-muted">
          Not counted until received. Reimbursements and transfers are also
          excluded.
        </p>
      </div>
    </section>
  );
}

function Commitments({
  manual,
  draft,
  setDraft,
  requireDateReview,
  datesReviewed,
  setDatesReviewed,
}: {
  manual: boolean;
  draft: PlanCalibrationData;
  setDraft: React.Dispatch<React.SetStateAction<PlanCalibrationData>>;
  requireDateReview: boolean;
  datesReviewed: boolean;
  setDatesReviewed: (value: boolean) => void;
}) {
  const { authoritativeProjection, commitments } = useAppState();
  const savedNames = new Set(
    commitments.map((item) => item.name.toLocaleLowerCase()),
  );
  const items: [FixedNameKey, FixedAmountKey, FixedDateKey, string, string][] = [
    ["rentName", "rentAmount", "rentDueDate", "Rent", "rent"],
    ["electricName", "electricMax", "electricDueDate", "Electric", "electric"],
    ["streamBoxName", "streamBoxAmount", "streamBoxDueDate", "Subscriptions", "streambox"],
    ["insuranceName", "insuranceAmount", "insuranceDueDate", "Insurance", "insurance"],
  ];
  const updateName = (key: FixedNameKey, name: string) => {
    setDraft((value) => ({ ...value, [key]: name }));
  };
  const update = (key: FixedAmountKey, raw: number) => {
    setDatesReviewed(false);
    setDraft((value) => {
      const amount = Math.max(0, raw);
      const dateKey = fixedDateKeyForAmount[key];
      return {
        ...value,
        [key]: amount,
        [dateKey]:
          amount > 0 && !value[dateKey]
            ? nextMonthlyDate(
                authoritativeProjection.horizonStart,
                fixedPreferredDays[dateKey],
              )
            : value[dateKey],
        editedCommitments: value.editedCommitments.includes(key)
          ? value.editedCommitments
          : [...value.editedCommitments, key],
      };
    });
  };
  const updateDate = (key: FixedDateKey, date: string) => {
    setDatesReviewed(false);
    setDraft((value) => ({ ...value, [key]: date }));
  };
  const add = () => {
    setDatesReviewed(false);
    setDraft((value) => ({
      ...value,
      customCommitments: [
        ...value.customCommitments,
        { id: createCommitmentId(), name: "", amount: 0, dueDate: "" },
      ],
    }));
  };
  const updateCustom = (
    id: string,
    patch: Partial<{ name: string; amount: number; dueDate: string }>,
  ) => {
    setDatesReviewed(false);
    setDraft((value) => ({
      ...value,
      customCommitments: value.customCommitments.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    }));
  };
  const removeCustom = (id: string) => {
    setDatesReviewed(false);
    setDraft((value) => ({
      ...value,
      customCommitments: value.customCommitments.filter(
        (item) => item.id !== id,
      ),
    }));
  };
  const total =
    draft.rentAmount +
    draft.electricMax +
    draft.streamBoxAmount +
    draft.insuranceAmount +
    draft.customCommitments.reduce((sum, item) => sum + item.amount, 0);
  return (
    <section>
      <p className="eyebrow">
        Through {formatCalibrationDate(authoritativeProjection.horizonEnd)}
      </p>
      <h1 className="text-[29px] font-bold leading-tight tracking-[-.045em]">
        What must be paid?
      </h1>
      <p className="mt-2 text-sm leading-5 text-muted">
        Start with these common commitments, then add anything missing. Saved
        amounts stay intact; new amounts remain $0 until you enter them.
      </p>
      <div className="mt-5 space-y-2">
        {items.map(([nameKey, amountKey, dateKey, suggestedName, canonicalName]) => {
          const name = draft[nameKey];
          const source =
            manual || draft.editedCommitments.includes(amountKey)
              ? "You entered"
              : savedNames.has(canonicalName) ||
                  (amountKey === "streamBoxAmount" &&
                    savedNames.has("subscriptions"))
                ? "Saved commitment"
                : "Suggested setup";
          return (
            <div
              key={amountKey}
              className="rounded-[18px] border border-rule bg-white p-3"
            >
              <div className="flex items-center justify-between gap-3">
                <input
                  aria-label={`${suggestedName} commitment name`}
                  value={name}
                  maxLength={120}
                  onChange={(event) => updateName(nameKey, event.target.value)}
                  className="h-10 min-w-0 flex-1 rounded-xl border border-rule bg-white px-3 text-sm font-semibold outline-none focus:ring-2 focus:ring-pencil"
                />
                <span className="text-[10px] font-semibold text-muted">
                  {source}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] gap-2">
                <div className="flex h-11 items-center rounded-xl border border-rule px-2 focus-within:ring-2 focus-within:ring-pencil">
                  <span className="text-sm text-muted">$</span>
                  <NumberInput
                    aria-label={`${name || suggestedName} amount`}
                    min={0}
                    step="0.01"
                    value={draft[amountKey]}
                    onValueChange={(value) => update(amountKey, value)}
                    className="h-full min-w-0 flex-1 bg-transparent px-1 text-right text-base font-bold outline-none"
                  />
                </div>
                <input
                  aria-label={`${name || suggestedName} due date`}
                  type="date"
                  value={draft[dateKey]}
                  onChange={(event) => updateDate(dateKey, event.target.value)}
                  className="h-11 min-w-0 rounded-xl border border-rule px-2 text-sm outline-none focus:ring-2 focus:ring-pencil"
                />
              </div>
              {draft[amountKey] > 0 && !draft[dateKey] && (
                <p className="mt-2 text-[11px] font-semibold text-muted">
                  Tracked, but not reserved until you add a due date.
                </p>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-3 rounded-2xl bg-recessed p-3 text-[11px] leading-4 text-muted">
        Dates are suggested starting points, not detected facts. Change them to
        match your bills, or clear a date to track something without reserving
        it yet. Rows left at $0 are not saved as commitments.
      </p>
      {requireDateReview && total > 0 && (
        <label className="mt-3 flex min-h-14 cursor-pointer items-center justify-between gap-3 rounded-2xl border border-pencil/15 bg-pencil/[.035] px-4">
          <span>
            <strong className="block text-sm">
              I reviewed these due dates
            </strong>
            <span className="mt-0.5 block text-[11px] text-muted">
              Suggested dates are not treated as confirmed until you approve
              them.
            </span>
          </span>
          <Switch
            checked={datesReviewed}
            onCheckedChange={setDatesReviewed}
            label="Confirm commitment due dates"
          />
        </label>
      )}
      {draft.customCommitments.map((item) => (
        <div
          key={item.id}
          className="mt-2 rounded-2xl border border-pencil/15 bg-white p-3"
        >
          <div className="grid grid-cols-[1fr_44px] gap-2">
            <input
              aria-label="Custom commitment name"
              value={item.name}
              onChange={(event) =>
                updateCustom(item.id, { name: event.target.value })
              }
              placeholder="Phone bill"
              maxLength={120}
              className="h-11 min-w-0 rounded-xl border border-rule px-3 text-sm font-semibold outline-none focus:ring-2 focus:ring-pencil"
            />
            <button
              onClick={() => removeCustom(item.id)}
              className="grid size-11 place-items-center rounded-xl text-coral focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil"
              aria-label={`Remove ${item.name || "commitment"}`}
            >
              <Trash2 className="size-4" />
            </button>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div className="flex h-11 items-center rounded-xl border border-rule px-2">
              <span className="text-sm text-muted">$</span>
              <NumberInput
                aria-label={`${item.name || "Custom commitment"} amount`}
                min={0}
                step="0.01"
                value={item.amount}
                onValueChange={(amount) => updateCustom(item.id, { amount })}
                className="min-w-0 flex-1 bg-transparent px-1 text-right text-sm font-bold outline-none"
              />
            </div>
            <input
              aria-label={`${item.name || "Custom commitment"} due date`}
              type="date"
              value={item.dueDate}
              onChange={(event) =>
                updateCustom(item.id, { dueDate: event.target.value })
              }
              className="h-11 min-w-0 rounded-xl border border-rule px-2 text-sm outline-none focus:ring-2 focus:ring-pencil"
            />
          </div>
          {item.amount > 0 && !item.dueDate && (
            <p className="mt-2 text-[11px] font-semibold text-muted">
              Tracked, but not reserved until you add a due date.
            </p>
          )}
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        onClick={add}
        className="mt-3 w-full"
      >
        <Plus className="size-4" />
        Add missing commitment
      </Button>
      <div className="mt-4 flex items-center justify-between rounded-2xl bg-recessed p-4">
        <span>
          <span className="block text-[10px] font-bold uppercase tracking-[.1em] text-muted">
            Reserved for commitments
          </span>
          <strong className="tabular mt-1 block text-xl">{money(total)}</strong>
        </span>
        <Provenance label="Reviewed" />
      </div>
      <p className="mt-3 text-xs leading-5 text-muted">
        Cleared charges already reflected in cash are not subtracted again.
      </p>
    </section>
  );
}

type FixedAmountKey =
  | "rentAmount"
  | "electricMax"
  | "streamBoxAmount"
  | "insuranceAmount";
type FixedNameKey =
  | "rentName"
  | "electricName"
  | "streamBoxName"
  | "insuranceName";
type FixedDateKey =
  | "rentDueDate"
  | "electricDueDate"
  | "streamBoxDueDate"
  | "insuranceDueDate";
const fixedDateKeyForAmount: Record<FixedAmountKey, FixedDateKey> = {
  rentAmount: "rentDueDate",
  electricMax: "electricDueDate",
  streamBoxAmount: "streamBoxDueDate",
  insuranceAmount: "insuranceDueDate",
};
const fixedPreferredDays: Record<FixedDateKey, number> = {
  rentDueDate: 1,
  electricDueDate: 10,
  streamBoxDueDate: 15,
  insuranceDueDate: 20,
};
function mergeCalibrationDraft(
  canonical: PlanCalibrationData,
  stored: PlanCalibrationData,
): PlanCalibrationData {
  const storedIds = new Set(
    (stored.customCommitments ?? []).map((item) => item.id),
  );
  return {
    ...canonical,
    ...stored,
    customCommitments: [
      ...(stored.customCommitments ?? []),
      ...canonical.customCommitments.filter((item) => !storedIds.has(item.id)),
    ],
  };
}
function Guardrails({
  draft,
  setDraft,
  buffer,
  setBuffer,
  projection,
  stale,
}: {
  draft: PlanCalibrationData;
  setDraft: React.Dispatch<React.SetStateAction<PlanCalibrationData>>;
  buffer: number;
  setBuffer: (value: number) => void;
  projection: ReturnType<typeof calculatePlanProjection>;
  stale: boolean;
}) {
  const shortfall = projection.available < 0;
  const { accounts, authoritativeProjection } = useAppState();
  const incomplete = accounts
    .filter(
      (account) =>
        account.coverage === "stale" || account.coverage === "missing",
    )
    .map((account) => account.name);
  const coverageSubject = incomplete.length
    ? incomplete.join(", ")
    : "One or more included accounts";
  return (
    <section>
      <p className="eyebrow">Guardrails and preview</p>
      <h1 className="text-[29px] font-bold leading-tight tracking-[-.045em]">
        What should stay protected?
      </h1>
      <p className="mt-2 text-sm leading-5 text-muted">
        Savings is reserved now for this horizon, not shown as a completed
        transfer. The buffer remains untouched for surprises.
      </p>
      <div className="mt-5 grid grid-cols-1 gap-3 min-[370px]:grid-cols-2">
        <Field label="Planned savings">
          <MoneyInput
            value={draft.savingsContribution}
            onChange={(savingsContribution) =>
              setDraft((value) => ({ ...value, savingsContribution }))
            }
          />
        </Field>
        <Field label="Safety buffer">
          <MoneyInput value={buffer} onChange={setBuffer} />
        </Field>
      </div>
      <div className="mt-5 overflow-hidden rounded-[22px] bg-ink p-4 text-white">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-bold uppercase tracking-[.1em] text-citron">
            {shortfall
              ? "Projected shortfall"
              : stale
                ? "Partial-data preview"
                : "Available to use"}
          </p>
          {stale && (
            <span className="rounded-full bg-white/10 px-2 py-1 text-[9px] font-bold uppercase tracking-[.08em]">
              Coverage incomplete
            </span>
          )}
        </div>
        <p className="tabular mt-2 text-[36px] font-bold tracking-[-.05em]">
          {money(Math.abs(projection.available))}
        </p>
        <div className="mt-4 space-y-2 border-t border-white/15 pt-3 text-xs text-white/70">
          <Equation
            label={
              draft.cashProvenance === "user_entered"
                ? "You-entered cash"
                : "Observed cash"
            }
            value={draft.knownCash}
          />
          <Equation
            label="Reviewed commitments"
            value={-projection.futureBills}
          />
          <Equation
            label="Planned savings"
            value={-draft.savingsContribution}
          />
          <Equation label="Safety buffer" value={-buffer} />
        </div>
        <p className="mt-4 text-[11px] leading-5 text-white/55">
          No future income counted. Preview runs through{" "}
          {formatCalibrationDate(authoritativeProjection.horizonEnd)}.
        </p>
      </div>
      {stale && (
        <div className="mt-3 rounded-2xl border border-coral/20 bg-coral/[.05] p-3 text-xs leading-5 text-muted">
          {coverageSubject} {incomplete.length === 1 ? "has" : "have"}{" "}
          incomplete coverage. Treat this as a preview until coverage is
          current.
        </div>
      )}
      {shortfall && (
        <div className="mt-3 rounded-2xl border border-coral/20 bg-coral/[.05] p-3 text-xs leading-5 text-muted">
          <strong className="text-ink">
            Cash on hand does not fund the full plan yet.
          </strong>{" "}
          You can continue and save it with this shortfall visible. Expected
          income stays out of available cash until it actually arrives.
        </div>
      )}
    </section>
  );
}

function AccountScope({
  name,
  detail,
  amount,
  included,
  onChange,
  locked = false,
}: {
  name: string;
  detail: string;
  amount: number;
  included: boolean;
  onChange: (value: boolean) => void;
  locked?: boolean;
}) {
  return (
    <div className="flex min-h-[70px] items-center gap-3 rounded-2xl border border-rule bg-white p-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-recessed text-pencil">
        <Landmark className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block text-sm">{name}</strong>
        <span className="block text-xs text-muted">{detail}</span>
      </span>
      <span className="text-right">
        <strong className="tabular block text-sm">{money(amount)}</strong>
        <Switch
          checked={included}
          disabled={locked}
          onCheckedChange={onChange}
          label={`Include ${name}`}
        />
      </span>
    </div>
  );
}
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-xs font-semibold">
      <span className="mb-2 block">{label}</span>
      {children}
    </label>
  );
}
function MoneyInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex h-12 items-center rounded-xl border border-rule bg-white px-3 focus-within:ring-2 focus-within:ring-pencil">
      <span className="text-muted">$</span>
      <NumberInput
        inputMode="decimal"
        min={0}
        step="0.01"
        value={value}
        onValueChange={onChange}
        className="h-full min-w-0 flex-1 bg-transparent px-1 text-base font-bold outline-none"
      />
    </div>
  );
}
function Provenance({ label }: { label: string }) {
  return (
    <span className="rounded-full border border-pencil/15 bg-white px-2 py-1 text-[9px] font-bold uppercase tracking-[.08em] text-pencil">
      {label}
    </span>
  );
}
function Equation({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between gap-3">
      <span>{label}</span>
      <strong className="tabular text-white">
        {value < 0 ? "−" : ""}
        {money(Math.abs(value))}
      </strong>
    </div>
  );
}
function formatCalibrationDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}
