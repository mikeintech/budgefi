import { useEffect, useMemo, useState } from "react";
import type { OnboardingAnalysisResponse } from "@budgefi/contracts";
import { resolvePlanningHorizonFromSchedules } from "../../packages/domain/src/index.js";
import {
  ChevronRight,
  Landmark,
  PenLine,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SavingsGoalEditor } from "@/components/savings-goal-editor";
import { DebtEditor } from "@/components/debt-editor";
import {
  IncomeScheduleEditor,
  IncomeScheduleList,
} from "@/components/income-schedule-editor";
import { NumberInput } from "@/components/ui/number-input";
import { Switch } from "@/components/ui/switch";
import {
  calculatePlanProjection,
  type FinancialAccount,
  type PlanCalibrationData,
  useAppState,
} from "@/state/app-state";
import { withSuggestedCommitmentDates } from "@/lib/commitment-defaults";
import { mergeCalibrationDraft } from "@/lib/calibration-merge";
import { nextMonthlyDate } from "@/lib/dates";
import { cn, money } from "@/lib/utils";
import { CommonBillsSheet } from "@/components/common-bills-sheet";
import { hasInvalidDuplicateCommitmentNames } from "@/lib/commitment-validation";

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
          editedCommitments: state.calibration.editedCommitments,
        }
      : state.calibration;
    const suggested = withSuggestedCommitmentDates(
      initialData ? mergeCalibrationDraft(base, initialData) : base,
      state.authoritativeProjection.horizonStart,
      state.authoritativeProjection.horizonEnd,
    );
    return {
      ...suggested,
      ...(suggested.rentAmount === 0 &&
      suggested.starterItemKeys.includes("housing")
        ? { rentDueDate: "" }
        : {}),
      ...(suggested.electricMax === 0 &&
      suggested.starterItemKeys.includes("utilities")
        ? { electricDueDate: "" }
        : {}),
      ...(suggested.streamBoxAmount === 0 &&
      suggested.starterItemKeys.includes("subscriptions")
        ? { streamBoxDueDate: "" }
        : {}),
      ...(suggested.insuranceAmount === 0 &&
      suggested.starterItemKeys.includes("insurance")
        ? { insuranceDueDate: "" }
        : {}),
    };
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
          account.planningRole !== "protected" &&
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
  const draftHorizon = resolvePlanningHorizonFromSchedules({
    today: state.authoritativeProjection.horizonStart,
    fallbackDays: draft.fallbackHorizonDays,
    schedules: state.incomeSchedules.map((item) => ({
      id: item.id,
      nextExpectedDate: item.nextExpectedDate,
      confirmed: item.confirmed,
      status: item.status,
    })),
  });
  const projection = calculatePlanProjection(draft, buffer, draftHorizon.end, {
    horizonStart: state.authoritativeProjection.horizonStart,
    commitments: state.commitments,
    savingsGoals: state.savingsGoals,
    occurrences: state.occurrences,
  });
  const customInvalid = draft.customCommitments.some(
    (item) => !item.name.trim() || (item.amount <= 0 && !item.starterItemKey),
  );
  const fixedCommitments = [
    {
      id: draft.rentId,
      name: draft.rentName,
      amount: draft.rentAmount,
      date: draft.rentDueDate,
    },
    {
      id: draft.electricId,
      name: draft.electricName,
      amount: draft.electricMax,
      date: draft.electricDueDate,
    },
    {
      id: draft.streamBoxId,
      name: draft.streamBoxName,
      amount: draft.streamBoxAmount,
      date: draft.streamBoxDueDate,
    },
    {
      id: draft.insuranceId,
      name: draft.insuranceName,
      amount: draft.insuranceAmount,
      date: draft.insuranceDueDate,
    },
  ];
  const commitmentInvalid =
    customInvalid ||
    fixedCommitments.some((item) => item.amount > 0 && !item.name.trim()) ||
    hasInvalidDuplicateCommitmentNames(
      [...fixedCommitments, ...draft.customCommitments],
      state.commitments,
    );
  const hasDatedCommitments =
    fixedCommitments.some((item) => item.amount > 0 && Boolean(item.date)) ||
    draft.customCommitments.some(
      (item) => item.amount > 0 && Boolean(item.dueDate),
    );
  useEffect(() => {
    onDraftChange?.(draft, buffer);
  }, [draft, buffer, onDraftChange]);
  useEffect(() => {
    const contribution = state.savingsGoals
      .filter((goal) => goal.status === "active")
      .reduce(
        (sum, goal) =>
          sum + Number(BigInt(goal.contributionAmount.minor)) / 100,
        0,
      );
    setDraft((value) =>
      value.savingsContribution === contribution
        ? value
        : { ...value, savingsContribution: contribution },
    );
  }, [state.savingsGoals]);
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
        <IncomeTiming
          draft={draft}
          setDraft={setDraft}
          horizonEnd={draftHorizon.end}
          analysis={analysis}
        />
      )}
      {stage === 2 && (
        <Commitments
          manual={manual}
          draft={draft}
          setDraft={setDraft}
          requireDateReview={embedded}
          datesReviewed={commitmentDatesReviewed}
          setDatesReviewed={setCommitmentDatesReviewed}
          horizonEnd={draftHorizon.end}
          horizonStart={draftHorizon.start}
        />
      )}
      {stage === 3 && (
        <Guardrails
          draft={draft}
          buffer={buffer}
          setBuffer={setBuffer}
          projection={projection}
          stale={!manual && state.sourceStale}
          horizonEnd={draftHorizon.end}
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
          Add an amount and name to each commitment. New or renamed commitments
          also need distinct names. Due dates may be added later.
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
    analysis.suggestions.incomes.length +
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
  draft,
  setDraft,
  horizonEnd: horizonEndValue,
  analysis,
}: {
  draft: PlanCalibrationData;
  setDraft: React.Dispatch<React.SetStateAction<PlanCalibrationData>>;
  horizonEnd: string;
  analysis: OnboardingAnalysisResponse | null;
}) {
  const state = useAppState();
  const [addingSuggestion, setAddingSuggestion] = useState<string | null>(null);
  const horizonEnd = formatCalibrationDate(horizonEndValue);
  return (
    <section>
      <p className="eyebrow">Planning horizon</p>
      <h1 className="text-[29px] font-bold leading-tight tracking-[-.045em]">
        When is money coming in?
      </h1>
      <p className="mt-2 text-sm leading-5 text-muted">
        Your plan runs through the next paycheck you confirm. Future deposits
        never increase available cash until they are actually received.
      </p>
      <div className="mt-5">
        {analysis?.state === "ready" &&
          analysis.suggestions.incomes.length > 0 && (
            <div className="mb-3 rounded-[20px] border border-cobalt/15 bg-cobalt/[.035] p-4">
              <p className="text-xs font-bold uppercase tracking-[.1em] text-cobalt">
                Found in your activity
              </p>
              <div className="mt-2 divide-y divide-rule">
                {analysis.suggestions.incomes.map((item) => {
                  const alreadyAdded = state.incomeSchedules.some(
                    (schedule) =>
                      schedule.status !== "archived" &&
                      schedule.name.toLowerCase() === item.name.toLowerCase() &&
                      schedule.nextExpectedDate === item.nextExpectedDate,
                  );
                  const needsAnchors = item.cadence === "semi_monthly";
                  const supported = [
                    "weekly",
                    "biweekly",
                    "semi_monthly",
                    "monthly",
                    "quarterly",
                    "annual",
                  ].includes(item.cadence);
                  return (
                    <div
                      key={item.candidateId}
                      className="flex min-h-16 items-center gap-3 py-2"
                    >
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-sm">
                          {item.name}
                        </strong>
                        <span className="block text-xs text-muted">
                          {money(Number(item.amount.minor) / 100)} ·{" "}
                          {item.cadence.replace("_", " ")} · expected{" "}
                          {formatCalibrationDate(item.nextExpectedDate)}
                        </span>
                      </span>
                      {alreadyAdded ? (
                        <span className="text-xs font-bold text-leaf">
                          Added
                        </span>
                      ) : needsAnchors ? (
                        <span className="max-w-24 text-right text-[11px] leading-4 text-muted">
                          Add below and choose both pay days
                        </span>
                      ) : supported ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={addingSuggestion !== null}
                          onClick={async () => {
                            setAddingSuggestion(item.candidateId);
                            await state.createIncomeSchedule({
                              destinationAccountId: null,
                              name: item.name,
                              expectedAmount:
                                Number(item.amount.minor) > 0
                                  ? item.amount
                                  : null,
                              frequency: item.cadence as
                                | "weekly"
                                | "biweekly"
                                | "monthly"
                                | "quarterly"
                                | "annual",
                              nextExpectedDate: item.nextExpectedDate,
                              confirmed: true,
                              anchorDay: Number(
                                item.nextExpectedDate.slice(8, 10),
                              ),
                              anchorEndOfMonth: false,
                              secondAnchorDay: null,
                              secondAnchorEndOfMonth: false,
                            });
                            setAddingSuggestion(null);
                          }}
                        >
                          {addingSuggestion === item.candidateId
                            ? "Adding…"
                            : "Add"}
                        </Button>
                      ) : (
                        <span className="text-[11px] text-muted">
                          Not auto-added
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        <IncomeScheduleList compact />
        <div className="mt-3">
          <IncomeScheduleEditor />
        </div>
      </div>
      <div className="mt-4 rounded-[20px] border border-rule bg-white p-4">
        <label
          className="block text-xs font-semibold"
          htmlFor="fallback-horizon"
        >
          If payday is unknown
        </label>
        <select
          id="fallback-horizon"
          value={draft.fallbackHorizonDays}
          onChange={(event) =>
            setDraft((value) => ({
              ...value,
              fallbackHorizonDays: Number(event.target.value),
            }))
          }
          className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-base outline-none focus:ring-2 focus:ring-pencil"
        >
          <option value={7}>Plan 7 days ahead</option>
          <option value={14}>Plan 14 days ahead</option>
          <option value={21}>Plan 21 days ahead</option>
          <option value={30}>Plan 30 days ahead</option>
        </select>
      </div>
      <div className="mt-4 rounded-2xl border border-pencil/15 bg-pencil/[.035] p-4 text-sm">
        <strong>Plan runs through {horizonEnd}</strong>
        <p className="mt-1 text-xs leading-5 text-muted">
          The earliest reliable income date controls this window. Expected
          amounts, reimbursements, and transfers are not counted as cash.
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
  horizonEnd,
  horizonStart,
}: {
  manual: boolean;
  draft: PlanCalibrationData;
  setDraft: React.Dispatch<React.SetStateAction<PlanCalibrationData>>;
  requireDateReview: boolean;
  datesReviewed: boolean;
  setDatesReviewed: (value: boolean) => void;
  horizonEnd: string;
  horizonStart: string;
}) {
  const { commitments } = useAppState();
  const savedNames = new Set(
    commitments.map((item) => item.name.toLocaleLowerCase()),
  );
  const items: [
    FixedIdKey,
    FixedNameKey,
    FixedAmountKey,
    FixedDateKey,
    FixedRecurrenceKey,
    string,
    string,
  ][] = [
    [
      "rentId",
      "rentName",
      "rentAmount",
      "rentDueDate",
      "rentRecurrence",
      "Rent",
      "rent",
    ],
    [
      "electricId",
      "electricName",
      "electricMax",
      "electricDueDate",
      "electricRecurrence",
      "Electric",
      "electric",
    ],
    [
      "streamBoxId",
      "streamBoxName",
      "streamBoxAmount",
      "streamBoxDueDate",
      "streamBoxRecurrence",
      "Subscriptions",
      "streambox",
    ],
    [
      "insuranceId",
      "insuranceName",
      "insuranceAmount",
      "insuranceDueDate",
      "insuranceRecurrence",
      "Insurance",
      "insurance",
    ],
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
            ? nextMonthlyDate(horizonStart, fixedPreferredDays[dateKey])
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
  const updateRecurrence = (
    key: FixedRecurrenceKey,
    recurrence: PlanCalibrationData[FixedRecurrenceKey],
  ) => {
    setDatesReviewed(false);
    setDraft((value) => ({ ...value, [key]: recurrence }));
  };
  const add = () => {
    setDatesReviewed(false);
    setDraft((value) => ({
      ...value,
      customCommitments: [
        ...value.customCommitments,
        {
          id: createCommitmentId(),
          name: "",
          amount: 0,
          dueDate: "",
          recurrence: "monthly",
        },
      ],
    }));
  };
  const updateCustom = (
    id: string,
    patch: Partial<{
      name: string;
      amount: number;
      dueDate: string;
      recurrence:
        | "one_time"
        | "weekly"
        | "biweekly"
        | "monthly"
        | "quarterly"
        | "annual";
    }>,
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
    setDraft((value) => {
      const removedKey = value.customCommitments.find(
        (item) => item.id === id,
      )?.starterItemKey;
      const customCommitments = value.customCommitments.filter(
        (item) => item.id !== id,
      );
      return {
        ...value,
        customCommitments,
        starterItemKeys:
          removedKey &&
          !customCommitments.some((item) => item.starterItemKey === removedKey)
            ? value.starterItemKeys.filter((key) => key !== removedKey)
            : value.starterItemKeys,
      };
    });
  };
  const activeRuleCount =
    [
      draft.rentAmount,
      draft.electricMax,
      draft.streamBoxAmount,
      draft.insuranceAmount,
    ].filter((amount) => amount > 0).length +
    draft.customCommitments.filter((item) => item.amount > 0).length;
  const visibleItems = items.filter(
    ([idKey, , amountKey]) =>
      Boolean(draft[idKey]) ||
      draft[amountKey] > 0 ||
      draft.editedCommitments.includes(amountKey),
  );
  return (
    <section>
      <p className="eyebrow">Through {formatCalibrationDate(horizonEnd)}</p>
      <h1 className="text-[29px] font-bold leading-tight tracking-[-.045em]">
        What must be paid?
      </h1>
      <p className="mt-2 text-sm leading-5 text-muted">
        Review what is already here or add only the bills that apply. Empty
        starter rows do not change Available to use.
      </p>
      <div className="mt-5 space-y-2">
        {visibleItems.map(
          ([
            idKey,
            nameKey,
            amountKey,
            dateKey,
            recurrenceKey,
            suggestedName,
            canonicalName,
          ]) => {
            const name = draft[nameKey];
            const source =
              manual || draft.editedCommitments.includes(amountKey)
                ? "You entered"
                : draft[idKey] ||
                    savedNames.has(canonicalName) ||
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
                    onChange={(event) =>
                      updateName(nameKey, event.target.value)
                    }
                    className="h-10 min-w-0 flex-1 rounded-xl border border-rule bg-white px-3 text-sm font-semibold outline-none focus:ring-2 focus:ring-pencil"
                  />
                  <span className="text-[10px] font-semibold text-muted">
                    {source}
                  </span>
                </div>
                <select
                  aria-label={`${name || suggestedName} recurrence`}
                  value={draft[recurrenceKey]}
                  onChange={(event) =>
                    updateRecurrence(
                      recurrenceKey,
                      event.target
                        .value as PlanCalibrationData[FixedRecurrenceKey],
                    )
                  }
                  className="mt-2 h-11 w-full rounded-xl border border-rule bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-pencil"
                >
                  <option value="one_time">One time</option>
                  <option value="weekly">Weekly</option>
                  <option value="biweekly">Every two weeks</option>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Every three months</option>
                  <option value="annual">Yearly</option>
                </select>
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
                    onChange={(event) =>
                      updateDate(dateKey, event.target.value)
                    }
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
          },
        )}
      </div>
      <p className="mt-3 rounded-2xl bg-recessed p-3 text-[11px] leading-4 text-muted">
        Dates are suggested starting points, not detected facts. Change them to
        match your bills, or clear a date to track something without reserving
        it yet. Rows left at $0 are not saved as commitments.
      </p>
      {requireDateReview && activeRuleCount > 0 && (
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
          <select
            aria-label={`${item.name || "Custom commitment"} recurrence`}
            value={item.recurrence}
            onChange={(event) =>
              updateCustom(item.id, {
                recurrence: event.target.value as typeof item.recurrence,
              })
            }
            className="mt-2 h-11 w-full rounded-xl border border-rule bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-pencil"
          >
            <option value="one_time">One time</option>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Every two weeks</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Every three months</option>
            <option value="annual">Yearly</option>
          </select>
          {item.amount > 0 && !item.dueDate && (
            <p className="mt-2 text-[11px] font-semibold text-muted">
              Tracked, but not reserved until you add a due date.
            </p>
          )}
          {item.starterItemKey && item.amount === 0 && (
            <p className="mt-2 text-[11px] font-semibold text-cobalt">
              Empty starter · add an amount and date when you know them.
            </p>
          )}
        </div>
      ))}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={add}
          className="w-full px-2"
        >
          <Plus className="size-4" /> Add one
        </Button>
        <CommonBillsSheet
          existingKeys={draft.starterItemKeys}
          existingNames={[
            ...draft.customCommitments.map((item) => item.name),
            ...(draft.rentId || draft.rentAmount > 0 ? ["Housing"] : []),
            ...(draft.electricId || draft.electricMax > 0 ? ["Utilities"] : []),
            ...(draft.streamBoxId || draft.streamBoxAmount > 0
              ? ["Subscriptions"]
              : []),
            ...(draft.insuranceId || draft.insuranceAmount > 0
              ? ["Insurance"]
              : []),
          ]}
          onAdd={(items) => {
            setDraft((value) => ({
              ...value,
              customCommitments: [...value.customCommitments, ...items],
              starterItemKeys: [
                ...new Set([
                  ...value.starterItemKeys,
                  ...items.flatMap((item) =>
                    item.starterItemKey ? [item.starterItemKey] : [],
                  ),
                ]),
              ],
            }));
            setDatesReviewed(false);
            return true;
          }}
        />
      </div>
      <div className="mt-4 flex items-center justify-between rounded-2xl bg-recessed p-4">
        <span>
          <span className="block text-[10px] font-bold uppercase tracking-[.1em] text-muted">
            Commitment rules ready
          </span>
          <strong className="tabular mt-1 block text-xl">
            {activeRuleCount}
          </strong>
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
type FixedIdKey = "rentId" | "electricId" | "streamBoxId" | "insuranceId";
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
type FixedRecurrenceKey =
  | "rentRecurrence"
  | "electricRecurrence"
  | "streamBoxRecurrence"
  | "insuranceRecurrence";
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
function Guardrails({
  draft,
  buffer,
  setBuffer,
  projection,
  stale,
  horizonEnd,
}: {
  draft: PlanCalibrationData;
  buffer: number;
  setBuffer: (value: number) => void;
  projection: ReturnType<typeof calculatePlanProjection>;
  stale: boolean;
  horizonEnd: string;
}) {
  const shortfall = projection.available < 0;
  const { accounts, savingsGoals, debts } = useAppState();
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
        Goal contributions are planned, not moved. Cash cushion is the extra
        spendable cash you want Budgefi to leave alone.
      </p>
      <div className="mt-5 rounded-[20px] border border-rule bg-white p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold">
              Savings goals{" "}
              <span className="font-normal text-muted">· optional</span>
            </h2>
            <p className="mt-1 text-xs leading-5 text-muted">
              {savingsGoals.some((goal) => goal.status !== "archived")
                ? `${savingsGoals.filter((goal) => goal.status !== "archived").length} ${savingsGoals.filter((goal) => goal.status !== "archived").length === 1 ? "goal" : "goals"} · ${money(projection.plannedSavings)} reserved through ${formatCalibrationDate(horizonEnd)}`
                : "Create one only if you want to track progress toward a destination."}
            </p>
          </div>
          <SavingsGoalEditor compact simple />
        </div>
      </div>
      <div className="mt-3 rounded-[20px] border border-rule bg-white p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold">
              Debts <span className="font-normal text-muted">· optional</span>
            </h2>
            <p className="mt-1 text-xs leading-5 text-muted">
              {debts.length
                ? `${debts.length} found · review only what you want to track`
                : "Add a card or loan only if payment visibility would help."}
            </p>
          </div>
          <DebtEditor compact />
        </div>
        {debts
          .filter((debt) => debt.status === "needs_review")
          .map((debt) => (
            <div
              key={debt.id}
              className="mt-3 flex items-center justify-between gap-3 rounded-2xl bg-amber-50 p-3"
            >
              <span className="min-w-0">
                <strong className="block truncate text-sm">{debt.name}</strong>
                <span className="block text-xs text-muted">
                  Connected debt · details are optional
                </span>
              </span>
              <DebtEditor debt={debt} />
            </div>
          ))}
      </div>
      <details className="mt-3 rounded-[20px] border border-rule bg-white p-4">
        <summary className="min-h-11 cursor-pointer text-sm font-bold">
          Cash cushion{" "}
          <span className="font-normal text-muted">· optional</span>
        </summary>
        <p className="mb-3 text-xs leading-5 text-muted">
          Extra spendable cash reserved for surprises. This is not a savings
          transfer or a goal.
        </p>
        <Field label="Cushion amount">
          <MoneyInput value={buffer} onChange={setBuffer} />
        </Field>
      </details>
      <div className="mt-5 overflow-hidden rounded-[22px] bg-ink p-4 text-white">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-bold uppercase tracking-[.1em] text-citron">
            {shortfall
              ? "Projected shortfall"
              : stale
                ? "Partial-data preview"
                : `Safe to spend through ${formatCalibrationDate(horizonEnd)}`}
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
            label="Goal contributions"
            value={-projection.plannedSavings}
          />
          <Equation label="Cash cushion" value={-buffer} />
        </div>
        <p className="mt-4 text-[11px] leading-5 text-white/55">
          Future income is excluded until received. Plan runs through{" "}
          {formatCalibrationDate(horizonEnd)}.
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
