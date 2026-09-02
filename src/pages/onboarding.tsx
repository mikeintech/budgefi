import { useCallback, useEffect, useState } from "react";
import {
  onboardingAnalysisResponseSchema,
  type OnboardingAnalysisResponse,
} from "@budgefi/contracts";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  Eye,
  Landmark,
  LockKeyhole,
  PenLine,
  ShieldCheck,
  Sparkles,
  Users,
  RefreshCw,
} from "lucide-react";
import { BudgefiMark, Wordmark } from "@/components/brand";
import { PlaidLinkButton } from "@/components/plaid-link-button";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { PlanCalibration } from "@/components/plan-calibration";
import { ServiceStatePanel } from "@/components/layout";
import {
  useAppState,
  type DataMode,
  type HouseholdMode,
  type NotificationMode,
  type PlanCalibrationData,
} from "@/state/app-state";
import { cn } from "@/lib/utils";
import { api, requestId } from "@/lib/api";
import { enablePushOnThisDevice } from "@/lib/native-notifications";
import { isNativeApp } from "@/lib/platform";
import { applyOnboardingSuggestions } from "@/lib/onboarding-insights";
import { authCacheScope } from "@/lib/auth";
import {
  createOnboardingDraftEnvelope,
  onboardingDraftKey,
  parseOnboardingDraftEnvelope,
} from "@/lib/onboarding-draft";
import {
  nativeSecureGet,
  nativeSecureRemove,
  nativeSecureSet,
} from "@/lib/native-storage";

const steps = ["Welcome", "Household", "Connect", "Plan", "Alerts", "Ready"];
const legacyOnboardingStorageKey = "budgefi:onboarding-draft:v1";
type OnboardingDraft = {
  step: number;
  connectionPhase: "choose" | "done" | "error";
  householdDraft: HouseholdMode;
  notificationDraft: NotificationMode;
  digestDraft: boolean;
  connectionDraft: boolean;
  dataModeDraft: DataMode;
  planDraft: { data: PlanCalibrationData; buffer: number } | null;
  planStage: number;
  analysis: OnboardingAnalysisResponse | null;
};
function validDraft(value: unknown): value is OnboardingDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<OnboardingDraft>;
  return (
    Number.isInteger(draft.step) &&
    Number(draft.step) >= 0 &&
    Number(draft.step) <= 5 &&
    ["choose", "done", "error"].includes(String(draft.connectionPhase)) &&
    ["solo", "shared"].includes(String(draft.householdDraft)) &&
    ["exceptions", "daily", "all"].includes(String(draft.notificationDraft)) &&
    typeof draft.digestDraft === "boolean" &&
    typeof draft.connectionDraft === "boolean" &&
    ["connected", "manual"].includes(String(draft.dataModeDraft)) &&
    validPlanDraft(draft.planDraft) &&
    Number.isInteger(draft.planStage) &&
    Number(draft.planStage) >= 0 &&
    Number(draft.planStage) <= 3 &&
    (draft.analysis === null ||
      onboardingAnalysisResponseSchema.safeParse(draft.analysis).success)
  );
}

function validPlanDraft(
  value: OnboardingDraft["planDraft"] | undefined,
): boolean {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const plan = value.data as Partial<PlanCalibrationData> | undefined;
  if (!plan || !finiteNonnegative(value.buffer)) return false;
  const amounts = [
    plan.knownCash,
    plan.incomeAmount,
    plan.rentAmount,
    plan.electricMax,
    plan.streamBoxAmount,
    plan.insuranceAmount,
    plan.savingsContribution,
  ];
  return (
    amounts.every(finiteNonnegative) &&
    typeof plan.includeChase === "boolean" &&
    typeof plan.includeJoint === "boolean" &&
    ["observed", "user_entered"].includes(String(plan.cashProvenance)) &&
    ["weekly", "biweekly", "semi_monthly", "monthly", "irregular"].includes(
      String(plan.incomeFrequency),
    ) &&
    typeof plan.incomeConfirmed === "boolean" &&
    [
      plan.rentName,
      plan.electricName,
      plan.streamBoxName,
      plan.insuranceName,
    ].every((item) => item === undefined || typeof item === "string") &&
    [
      plan.nextIncomeDate,
      plan.rentDueDate,
      plan.electricDueDate,
      plan.streamBoxDueDate,
      plan.insuranceDueDate,
    ].every((item) => typeof item === "string") &&
    Array.isArray(plan.editedCommitments) &&
    plan.editedCommitments.every((item) => typeof item === "string") &&
    Array.isArray(plan.customCommitments) &&
    plan.customCommitments.every(
      (item) =>
        item &&
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        finiteNonnegative(item.amount) &&
        typeof item.dueDate === "string",
    )
  );
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function OnboardingPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const fromSignUp = params.get("from") === "signup";
  const state = useAppState();
  const householdModeEnabled = state.features.householdMode;
  const onboardingAiEnabled = state.features.onboardingAi;
  const activeSteps = steps
    .map((label, index) => ({ label, index }))
    .filter(({ index }) => householdModeEnabled || index !== 1);
  const visibleSteps = fromSignUp
    ? activeSteps.filter(({ index }) => index !== 0)
    : activeSteps;
  const plaidConnection = state.connections.find(
    (connection) =>
      connection.provider === "plaid" &&
      connection.status !== "revoked" &&
      connection.status !== "revocation_pending",
  );
  const [step, setStep] = useState(
    fromSignUp ? (householdModeEnabled ? 1 : 2) : 0,
  );
  const [connectionPhase, setConnectionPhase] = useState<
    "choose" | "done" | "error"
  >("choose");
  const [householdDraft, setHouseholdDraft] = useState<HouseholdMode>(
    householdModeEnabled ? state.householdMode : "solo",
  );
  const [notificationDraft, setNotificationDraft] = useState(
    state.notificationMode,
  );
  const [digestDraft, setDigestDraft] = useState(state.weeklyDigest);
  const [connectionDraft, setConnectionDraft] = useState(false);
  const [dataModeDraft, setDataModeDraft] = useState<DataMode>(state.dataMode);
  const [planDraft, setPlanDraft] = useState<{
    data: PlanCalibrationData;
    buffer: number;
  } | null>(null);
  const [planStage, setPlanStage] = useState(0);
  const [analysis, setAnalysis] = useState<OnboardingAnalysisResponse | null>(
    null,
  );
  const [analyzing, setAnalyzing] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const [draftStorageKey, setDraftStorageKey] = useState<string | null>(null);
  const [draftScope, setDraftScope] = useState<string | null>(null);
  const [alertMessage, setAlertMessage] = useState("");
  const visibleStep = Math.max(
    0,
    visibleSteps.findIndex(({ index }) => index === step),
  );
  const capturePlanDraft = useCallback(
    (data: PlanCalibrationData, buffer: number) =>
      setPlanDraft({ data, buffer }),
    [],
  );
  useEffect(() => {
    if (
      draftReady ||
      state.backendStatus !== "connected" ||
      !state.householdId ||
      !state.revision
    )
      return;
    void authCacheScope()
      .then(async (scope) => {
        if (!scope) return;
        const key = onboardingDraftKey(scope, state.householdId!);
        setDraftStorageKey(key);
        setDraftScope(scope);
        const raw = isNativeApp
          ? await nativeSecureGet<string>(key)
          : sessionStorage.getItem(key);
        if (!raw) return;
        const parsed = parseOnboardingDraftEnvelope<OnboardingDraft>(
          raw,
          scope,
          state.householdId!,
          state.revision!,
        );
        if (parsed.status !== "ready" || !validDraft(parsed.draft)) {
          if (isNativeApp) await nativeSecureRemove(key);
          else sessionStorage.removeItem(key);
          return;
        }
        const value = parsed.draft;
        setStep(!householdModeEnabled && value.step === 1 ? 2 : value.step);
        setConnectionPhase(value.connectionPhase);
        setHouseholdDraft(householdModeEnabled ? value.householdDraft : "solo");
        setNotificationDraft(value.notificationDraft);
        setDigestDraft(value.digestDraft);
        setConnectionDraft(value.connectionDraft);
        setDataModeDraft(value.dataModeDraft);
        setPlanDraft(value.planDraft);
        setPlanStage(value.planStage);
        setAnalysis(value.analysis ?? null);
      })
      .catch(() => undefined)
      .finally(() => {
        if (isNativeApp)
          void nativeSecureRemove(legacyOnboardingStorageKey).catch(
            () => undefined,
          );
        else sessionStorage.removeItem(legacyOnboardingStorageKey);
        setDraftReady(true);
      });
  }, [
    draftReady,
    householdModeEnabled,
    state.backendStatus,
    state.householdId,
    state.revision,
  ]);
  useEffect(() => {
    if (
      state.backendStatus !== "connected" ||
      !draftReady ||
      !draftStorageKey ||
      !draftScope ||
      !state.householdId ||
      !state.revision
    )
      return;
    const value = JSON.stringify(
      createOnboardingDraftEnvelope(
        {
          step,
          connectionPhase,
          householdDraft,
          notificationDraft,
          digestDraft,
          connectionDraft,
          dataModeDraft,
          planDraft,
          planStage,
          analysis,
        } satisfies OnboardingDraft,
        draftScope,
        state.householdId,
        state.revision,
      ),
    );
    if (isNativeApp) void nativeSecureSet(draftStorageKey, value);
    else sessionStorage.setItem(draftStorageKey, value);
  }, [
    state.backendStatus,
    draftReady,
    draftStorageKey,
    draftScope,
    state.householdId,
    state.revision,
    step,
    connectionPhase,
    householdDraft,
    notificationDraft,
    digestDraft,
    connectionDraft,
    dataModeDraft,
    planDraft,
    planStage,
    analysis,
  ]);
  useEffect(() => {
    if (state.backendStatus !== "connected") return;
    const connectedMode = plaidConnection ? "connected" : state.dataMode;
    setDataModeDraft(connectedMode);
    setConnectionDraft(connectedMode !== "manual");
    if (step === 2) {
      if (connectedMode === "connected") setConnectionPhase("done");
      else if (connectionPhase === "done") setConnectionPhase("choose");
    }
  }, [
    state.backendStatus,
    state.dataMode,
    plaidConnection,
    step,
    connectionPhase,
  ]);

  const next = () =>
    setStep((value) => {
      const nextStep = activeSteps.find(({ index }) => index > value);
      return nextStep?.index ?? value;
    });
  const back = () => {
    if (
      step === 2 &&
      connectionPhase !== "choose" &&
      connectionPhase !== "done"
    )
      setConnectionPhase("choose");
    else {
      const previous = [...activeSteps]
        .reverse()
        .find(({ index }) => index < step);
      if (fromSignUp && (!previous || previous.index === 0))
        navigate("/sign-up");
      else if (previous) setStep(previous.index);
    }
  };
  const chooseManual = async () => {
    if (!(await state.activateManualMode())) {
      setConnectionPhase("error");
      return;
    }
    setConnectionDraft(false);
    setDataModeDraft("manual");
    setAnalysis(null);
    next();
  };
  const realPlaidConnected = () => {
    setConnectionDraft(true);
    setDataModeDraft("connected");
    setConnectionPhase("done");
  };
  const preparePlan = async () => {
    if (analyzing) return;
    if (!onboardingAiEnabled) {
      setAnalysis(null);
      next();
      return;
    }
    setAnalyzing(true);
    try {
      const result = await api.analyzeOnboarding();
      setAnalysis(result);
      const base = planDraft?.data ?? state.calibration;
      setPlanDraft({
        data: applyOnboardingSuggestions(base, result),
        buffer: planDraft?.buffer ?? state.planningBuffer,
      });
      next();
    } catch {
      setAnalysis({
        state: "unavailable",
        source: "none",
        model: null,
        generatedAt: new Date().toISOString(),
        transactionCount: 0,
        candidateCount: 0,
        notice:
          "Automatic setup is temporarily unavailable. You can continue and enter or review every value manually.",
        suggestions: {
          income: null,
          commitments: [],
          savings: null,
          needsReview: [],
          filtered: [],
        },
      });
      next();
    } finally {
      setAnalyzing(false);
    }
  };
  const finish = async () => {
    state.setHouseholdMode(householdModeEnabled ? householdDraft : "solo");
    state.setNotificationMode(notificationDraft);
    state.setWeeklyDigest(digestDraft);
    if (!connectionDraft) state.setDataMode(dataModeDraft);
    if (
      planDraft &&
      !(await state.savePlanCalibration(planDraft.data, planDraft.buffer))
    )
      return;
    if (!(await state.completeOnboarding())) return;
    if (draftStorageKey) {
      if (isNativeApp) await nativeSecureRemove(draftStorageKey);
      else sessionStorage.removeItem(draftStorageKey);
    }
    navigate("/today");
  };
  const saveAlerts = async () => {
    setAlertMessage("");
    try {
      const prefs = await api.notificationPreferences();
      let pushEnabled = false;
      if (isNativeApp) {
        const result = await enablePushOnThisDevice();
        pushEnabled = result.okay;
        if (!result.okay) setAlertMessage(result.message);
      }
      const { emailVerified: _, ...update } = prefs;
      await api.updateNotificationPreferences({
        ...update,
        pushEnabled,
        connectionHealth: notificationDraft !== "exceptions",
        commitmentReminders: notificationDraft === "all",
        exceptionActivity: true,
        weeklyDigest: digestDraft,
        requestId: requestId(),
      });
      if (pushEnabled || !isNativeApp) next();
    } catch (error) {
      setAlertMessage(
        error instanceof Error
          ? error.message
          : "Notification choices could not be saved",
      );
    }
  };

  if (state.backendStatus !== "connected")
    return (
      <div className="min-h-dvh bg-[#ded8ca] sm:p-4">
        <div className="native-app-shell paper-grain mx-auto min-h-dvh w-full max-w-[430px] overflow-hidden sm:min-h-[calc(100dvh-32px)] sm:rounded-[26px] sm:border sm:border-carbon/10 sm:shadow-2xl">
          <header className="flex h-16 items-center justify-center border-b border-rule/80">
            <Wordmark />
          </header>
          <ServiceStatePanel
            status={state.backendStatus}
            error={state.backendError}
            onRetry={state.reloadBackend}
          />
        </div>
      </div>
    );

  return (
    <div className="min-h-dvh bg-[#ded8ca] sm:p-4">
      <div className="native-app-shell paper-grain mx-auto flex min-h-dvh w-full max-w-[430px] flex-col overflow-hidden sm:min-h-[calc(100dvh-32px)] sm:rounded-[26px] sm:border sm:border-carbon/10 sm:shadow-2xl">
        <header className="relative flex h-16 items-center border-b border-rule/80 px-4">
          {step === 3 ? (
            <div className="size-11" />
          ) : step > 0 ? (
            <button
              onClick={back}
              className="grid size-11 place-items-center rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil"
              aria-label="Previous onboarding step"
            >
              <ArrowLeft className="size-5" />
            </button>
          ) : (
            <button
              onClick={() => navigate("/")}
              className="grid size-11 place-items-center rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil"
              aria-label="Close onboarding"
            >
              <ArrowLeft className="size-5" />
            </button>
          )}
          <button
            onClick={() => navigate("/")}
            className="absolute left-1/2 flex min-h-11 -translate-x-1/2 items-center rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil"
            aria-label="Budgefi landing"
          >
            <Wordmark />
          </button>
          <span className="ml-auto size-11" aria-hidden="true" />
        </header>
        {step !== 3 && (
          <div className="px-5 pt-4">
            <div
              className={cn("grid gap-1.5", "grid")}
              style={{
                gridTemplateColumns: `repeat(${visibleSteps.length}, minmax(0, 1fr))`,
              }}
              aria-label={`Onboarding step ${visibleStep + 1} of ${
                visibleSteps.length
              }`}
            >
              {visibleSteps.map(({ label }, index) => (
                <span
                  key={label}
                  className={cn(
                    "h-1 rounded-full",
                    index <= visibleStep ? "bg-pencil" : "bg-carbon/12",
                  )}
                />
              ))}
            </div>
            <p className="mt-2 text-right text-[10px] font-bold uppercase tracking-[.1em] text-muted">
              {steps[step]} · {visibleStep + 1} of {visibleSteps.length}
            </p>
          </div>
        )}

        <main className="flex flex-1 flex-col px-5 pb-[calc(24px+env(safe-area-inset-bottom))] pt-5">
          {step === 0 && <Welcome onNext={next} />}
          {step === 1 && householdModeEnabled && (
            <Household
              value={householdDraft}
              onChange={setHouseholdDraft}
              onNext={next}
            />
          )}
          {step === 2 && (
            <Connection
              phase={connectionPhase}
              setPhase={setConnectionPhase}
              analysisEnabled={onboardingAiEnabled}
              onAnalyze={preparePlan}
              analyzing={analyzing}
              onSkipAnalysis={() => {
                setAnalysis(null);
                next();
              }}
              onManual={chooseManual}
              onRealPlaidConnected={realPlaidConnected}
              onRetryRealConnection={state.syncPlaid}
              realConnection={plaidConnection}
              plaid={{
                createPlaidLinkToken: state.createPlaidLinkToken,
                exchangePlaid: state.exchangePlaid,
                completePlaidUpdate: state.completePlaidUpdate,
              }}
            />
          )}
          {step === 3 && (
            <PlanCalibration
              embedded
              manual={dataModeDraft === "manual"}
              initialData={planDraft?.data}
              initialBuffer={planDraft?.buffer}
              initialStage={planStage}
              onStageChange={setPlanStage}
              onBack={back}
              onDraftChange={capturePlanDraft}
              onDraftComplete={capturePlanDraft}
              onComplete={next}
              analysis={analysis}
            />
          )}
          {step === 4 && (
            <Alerts
              mode={notificationDraft}
              setMode={setNotificationDraft}
              digest={digestDraft}
              setDigest={setDigestDraft}
              onNext={saveAlerts}
              onSkip={next}
              message={alertMessage}
            />
          )}
          {step === 5 && (
            <Ready
              mode={dataModeDraft}
              household={householdDraft}
              calibration={planDraft?.data ?? state.calibration}
              onFinish={finish}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="flex flex-1 flex-col">
      <div className="mt-4">
        <span className="grid size-16 place-items-center rounded-[22px] bg-citron">
          <BudgefiMark className="size-9" />
        </span>
        <p className="eyebrow mt-7">A plan you can trace</p>
        <h1 className="max-w-[360px] text-[38px] font-bold leading-[1.02] tracking-[-0.055em]">
          Start with the numbers you have.
        </h1>
        <p className="mt-4 max-w-[350px] text-base leading-6 text-muted">
          Add your accounts or enter everything manually. You can review and
          adjust each part before it affects your plan.
        </p>
      </div>
      <div className="mt-7 grid grid-cols-3 gap-2">
        {[
          [Eye, "Read-only"],
          [ShieldCheck, "Your approval"],
          [Sparkles, "Clear history"],
        ].map(([Icon, label]) => {
          const I = Icon as typeof Eye;
          return (
            <div
              key={label as string}
              className="rounded-2xl border border-ink/10 bg-white p-3"
            >
              <I className="size-5 text-pencil" strokeWidth={1.8} />
              <p className="mt-3 text-xs font-semibold">{label as string}</p>
            </div>
          );
        })}
      </div>
      <Button onClick={onNext} size="lg" className="mt-auto w-full">
        Set up your plan <ChevronRight className="size-4" />
      </Button>
    </div>
  );
}

function Household({
  value,
  onChange,
  onNext,
}: {
  value: HouseholdMode;
  onChange: (value: HouseholdMode) => void;
  onNext: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col">
      <p className="eyebrow">Your money context</p>
      <h1 className="text-[32px] font-bold leading-tight tracking-[-0.045em]">
        Who should this plan work for?
      </h1>
      <p className="mt-2 text-sm leading-5 text-muted">
        This changes planning language and can be updated later.
      </p>
      <RadioGroup
        value={value}
        onValueChange={(v) => onChange(v as HouseholdMode)}
        className="mt-6 space-y-3"
      >
        <Choice
          value="solo"
          icon={LockKeyhole}
          title="Just me"
          description="A private plan with one decision-maker."
        />
        <Choice
          value="shared"
          icon={Users}
          title="My household"
          description="Shared commitments, answers, and accountability."
        />
      </RadioGroup>
      <div className="mt-5 rounded-2xl bg-recessed p-4 text-xs leading-5 text-muted">
        Member invitations are not available yet. For now, this choice adjusts
        the language used throughout your plan.
      </div>
      <Button onClick={onNext} size="lg" className="mt-auto w-full">
        Continue <ChevronRight className="size-4" />
      </Button>
    </div>
  );
}

function Connection({
  phase,
  setPhase,
  analysisEnabled,
  onAnalyze,
  analyzing,
  onSkipAnalysis,
  onManual,
  onRealPlaidConnected,
  onRetryRealConnection,
  realConnection,
  plaid,
}: {
  phase: "choose" | "done" | "error";
  setPhase: (phase: "choose" | "done" | "error") => void;
  analysisEnabled: boolean;
  onAnalyze: () => Promise<void>;
  analyzing: boolean;
  onSkipAnalysis: () => void;
  onManual: () => Promise<void>;
  onRealPlaidConnected: () => void;
  onRetryRealConnection: (connectionId: string) => Promise<boolean>;
  realConnection?: ReturnType<typeof useAppState>["connections"][number];
  plaid: Pick<
    ReturnType<typeof useAppState>,
    "createPlaidLinkToken" | "exchangePlaid" | "completePlaidUpdate"
  >;
}) {
  const [checkingAccounts, setCheckingAccounts] = useState(false);
  const [accountCheckMessage, setAccountCheckMessage] = useState("");
  const checkAccounts = async () => {
    if (!realConnection) return;
    setCheckingAccounts(true);
    setAccountCheckMessage("");
    const okay = await onRetryRealConnection(realConnection.id);
    setCheckingAccounts(false);
    setAccountCheckMessage(
      okay
        ? "Refresh requested. Budgefi will update this connection in the background."
        : "Your connection is saved. Any available balances were refreshed while transaction history continues syncing.",
    );
  };
  if (phase === "done")
    return (
      <div className="flex flex-1 flex-col">
        <div className="mt-8 text-center">
          <span className="mx-auto grid size-16 place-items-center rounded-[22px] bg-leaf text-white">
            <Check className="size-8" />
          </span>
          <p className="eyebrow mt-6">Ready to review</p>
          <h1 className="text-[31px] font-bold tracking-[-0.045em]">
            Bank access saved
          </h1>
          <p className="mx-auto mt-2 max-w-[320px] text-sm leading-5 text-muted">
            {realConnection?.initialUpdateComplete
              ? "Your accounts are ready. You will choose which balances belong in your plan."
              : "Your bank finished sharing. Budgefi is securely syncing the account details in the background."}
          </p>
        </div>
        {realConnection && (
          <div className="mt-6 rounded-2xl border border-rule bg-white p-4">
            <div className="flex items-center gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-pencil/8 text-pencil">
                <Landmark className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-sm">
                  {realConnection.institutionName ?? "Connected bank"}
                </strong>
                <span className="mt-1 block text-xs text-muted">
                  {realConnection.initialUpdateComplete
                    ? "Accounts received · ready to review"
                    : "Connected · account details still syncing"}
                </span>
              </span>
              <span className="rounded-full bg-leaf/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[.08em] text-leaf">
                Connected
              </span>
            </div>
            {!realConnection.initialUpdateComplete && (
              <div className="mt-3 rounded-xl bg-recessed p-3">
                <p className="text-xs leading-5 text-muted">
                  You can continue now. Budgefi will keep balances out of your
                  plan until they have been received and reviewed.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-3 w-full bg-white"
                  disabled={checkingAccounts}
                  onClick={() => void checkAccounts()}
                >
                  <RefreshCw
                    className={cn("size-4", checkingAccounts && "animate-spin")}
                  />
                  {checkingAccounts
                    ? "Checking accounts…"
                    : "Check for accounts"}
                </Button>
                {accountCheckMessage && (
                  <p
                    role="status"
                    className="mt-2 text-xs leading-5 text-muted"
                  >
                    {accountCheckMessage}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
        {analysisEnabled && (
          <div className="mt-5 rounded-2xl border border-pencil/15 bg-pencil/[.035] p-4">
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-citron text-ink">
                <Sparkles className="size-5" />
              </span>
              <span>
                <strong className="block text-sm">
                  Prepare the first draft
                </strong>
                <span className="mt-1 block text-xs leading-5 text-muted">
                  Budgefi can use recurring merchant labels, dates, and amounts
                  to suggest income, bills, and savings. Account numbers,
                  balances, credentials, and transaction IDs are not sent for
                  classification.
                </span>
              </span>
            </div>
            <p className="mt-3 text-[11px] leading-4 text-muted">
              Suggestions stay editable and do not join your plan until you
              approve the final review.
            </p>
          </div>
        )}
        <div className="mt-auto space-y-2 pt-5">
          {!analysisEnabled ? (
            <Button onClick={onSkipAnalysis} size="lg" className="w-full">
              Review accounts and plan <ChevronRight className="size-4" />
            </Button>
          ) : realConnection?.initialUpdateComplete ? (
            <>
              <Button
                onClick={() => void onAnalyze()}
                disabled={analyzing}
                size="lg"
                className="w-full"
              >
                {analyzing ? (
                  <>
                    <RefreshCw className="size-4 animate-spin" /> Finding
                    patterns…
                  </>
                ) : (
                  <>
                    Organize my activity <ChevronRight className="size-4" />
                  </>
                )}
              </Button>
              <Button
                onClick={onSkipAnalysis}
                disabled={analyzing}
                variant="ghost"
                className="w-full"
              >
                Continue without suggestions
              </Button>
            </>
          ) : (
            <>
              <p className="rounded-2xl bg-recessed p-3 text-center text-xs leading-5 text-muted">
                Stay here while accounts arrive, or finish setup manually now.
                You can include connected balances later.
              </p>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="w-full bg-white"
                onClick={() => void onManual()}
              >
                <PenLine className="size-4" /> Continue with manual setup
              </Button>
            </>
          )}
        </div>
      </div>
    );
  if (phase === "error")
    return (
      <div className="flex flex-1 flex-col items-center justify-center text-center">
        <span className="grid size-16 place-items-center rounded-[22px] bg-coral/10 text-coral">
          <AlertTriangle className="size-8" />
        </span>
        <h1 className="mt-5 text-2xl font-bold">Connection was not saved</h1>
        <p className="mt-2 max-w-[300px] text-sm leading-5 text-muted">
          Budgefi could not complete this request. Nothing was connected.
        </p>
        <Button
          onClick={() => setPhase("choose")}
          variant="outline"
          className="mt-6 w-full"
        >
          Choose another setup
        </Button>
      </div>
    );
  return (
    <div className="flex flex-1 flex-col">
      <p className="eyebrow">Choose your starting point</p>
      <h1 className="text-[32px] font-bold leading-tight tracking-[-0.045em]">
        How should Budgefi learn your numbers?
      </h1>
      <p className="mt-2 text-sm leading-5 text-muted">
        Connect a bank or enter everything yourself. You will review each
        account and commitment before it affects the plan.
      </p>
      <div className="mt-6 space-y-3">
        <div className="rounded-[20px] border border-pencil/20 bg-white p-3 shadow-sm">
          <div className="mb-3 flex items-center gap-3 px-1">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-pencil text-white">
              <LockKeyhole className="size-5" />
            </span>
            <span>
              <strong className="block text-sm">Connect a bank</strong>
              <span className="text-xs text-muted">Secure · read-only</span>
            </span>
          </div>
          <PlaidLinkButton
            mode="create"
            createToken={plaid.createPlaidLinkToken}
            exchange={plaid.exchangePlaid}
            completeUpdate={plaid.completePlaidUpdate}
            onComplete={onRealPlaidConnected}
          />
        </div>
        <button
          onClick={() => void onManual()}
          className="flex min-h-[78px] w-full items-center gap-3 rounded-[20px] border border-rule bg-white p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil"
        >
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-citron text-ink">
            <PenLine className="size-5" />
          </span>
          <span className="flex-1">
            <strong className="block">Enter everything manually</strong>
            <span className="text-xs text-muted">
              Guided defaults for cash, bills, dates, and charges
            </span>
          </span>
          <ChevronRight className="size-4 text-muted" />
        </button>
      </div>
      <div className="mt-3 flex items-center gap-2 text-xs text-muted">
        <ShieldCheck className="size-4" />
        Bank connections are optional and read-only.
      </div>
    </div>
  );
}

function Alerts({
  mode,
  setMode,
  digest,
  setDigest,
  onNext,
  onSkip,
  message,
}: {
  mode: NotificationMode;
  setMode: (value: NotificationMode) => void;
  digest: boolean;
  setDigest: (value: boolean) => void;
  onNext: () => Promise<void>;
  onSkip: () => void;
  message: string;
}) {
  return (
    <div className="flex flex-1 flex-col">
      <p className="eyebrow">Your attention</p>
      <h1 className="text-[32px] font-bold leading-tight tracking-[-0.045em]">
        What is worth an interruption?
      </h1>
      <p className="mt-2 text-sm leading-5 text-muted">
        Choose the events Budgefi may send. Your phone asks for permission only
        after you continue.
      </p>
      <RadioGroup
        value={mode}
        onValueChange={(v) => setMode(v as NotificationMode)}
        className="mt-6 space-y-2"
      >
        <PlainChoice
          value="exceptions"
          title="Decisions only"
          description="Financial exceptions that need an answer"
        />
        <PlainChoice
          value="daily"
          title="Decisions and connection health"
          description="Also warn when account data needs attention"
        />
        <PlainChoice
          value="all"
          title="Add commitment reminders"
          description="Also remind me before upcoming commitments"
        />
      </RadioGroup>
      <div className="mt-4 flex items-center justify-between rounded-2xl border border-rule bg-white p-4">
        <span>
          <strong className="block text-sm">Weekly proof digest</strong>
          <span className="mt-0.5 block text-xs text-muted">
            A calm summary of meaningful changes
          </span>
        </span>
        <Switch
          checked={digest}
          onCheckedChange={setDigest}
          label="Weekly proof digest"
        />
      </div>
      {message && (
        <p
          className="mt-3 rounded-2xl bg-recessed p-3 text-xs leading-5"
          role="alert"
        >
          {message}
        </p>
      )}
      <div className="mt-auto space-y-2">
        <Button onClick={() => void onNext()} size="lg" className="w-full">
          {message ? "Try again" : "Save and continue"}{" "}
          <ChevronRight className="size-4" />
        </Button>
        {message && (
          <Button variant="outline" onClick={onSkip} className="w-full">
            Continue without push
          </Button>
        )}
      </div>
    </div>
  );
}

function Ready({
  mode,
  household,
  calibration,
  onFinish,
}: {
  mode: DataMode;
  household: HouseholdMode;
  calibration: PlanCalibrationData;
  onFinish: () => Promise<void>;
}) {
  const [finishing, setFinishing] = useState(false);
  const { sourceStale, backendError } = useAppState();
  const commitmentCount =
    [
      [calibration.rentAmount, calibration.rentDueDate],
      [calibration.electricMax, calibration.electricDueDate],
      [calibration.streamBoxAmount, calibration.streamBoxDueDate],
      [calibration.insuranceAmount, calibration.insuranceDueDate],
    ].filter(([amount, date]) => Number(amount) > 0 && Boolean(date)).length +
    calibration.customCommitments.filter(
      (item) => item.amount > 0 && item.dueDate,
    ).length;
  const effectiveStale = mode !== "manual" && sourceStale;
  const rows = [
    [
      Users,
      household === "shared" ? "Household language" : "Personal plan",
      false,
    ],
    [
      mode === "manual" ? PenLine : Landmark,
      mode === "manual"
        ? "Manual entry · bank connection optional"
        : "Bank connected · accounts reviewed",
      false,
    ],
    [
      effectiveStale ? AlertTriangle : ShieldCheck,
      effectiveStale
        ? "Coverage incomplete"
        : mode === "manual"
          ? "You confirm manual freshness"
          : "Coverage current",
      effectiveStale,
    ],
  ] as const;
  return (
    <div className="flex flex-1 flex-col">
      <div className="text-center">
        <span
          className={cn(
            "mx-auto grid size-16 place-items-center rounded-[22px] text-white",
            effectiveStale ? "bg-amber-600" : "bg-leaf",
          )}
        >
          {effectiveStale ? (
            <AlertTriangle className="size-8" />
          ) : (
            <Check className="size-8" />
          )}
        </span>
        <p className="eyebrow mt-6">
          {effectiveStale ? "Setup needs attention" : "Setup reviewed"}
        </p>
        <h1 className="text-[34px] font-bold tracking-[-0.05em]">
          {effectiveStale
            ? "Plan preview needs source attention"
            : mode === "manual"
              ? "Your manual plan is ready"
              : "Your connected plan is ready to save"}
        </h1>
        <p className="mx-auto mt-2 max-w-[320px] text-sm leading-5 text-muted">
          {effectiveStale
            ? "Resolve incomplete account coverage before relying on the preview. "
            : ""}
          Built from{" "}
          {mode === "manual"
            ? "the cash and bills you entered"
            : "included deposit accounts"}
          , {commitmentCount} reviewed commitments, no future income, planned
          savings, and the cash you chose to keep untouched.
        </p>
      </div>
      <div className="mt-7 divide-y divide-rule overflow-hidden rounded-[20px] border border-rule bg-white">
        {rows.map(([Icon, text, warning]) => {
          const I = Icon as typeof Users;
          return (
            <div key={text} className="flex min-h-14 items-center gap-3 px-4">
              <I
                className={cn(
                  "size-[18px]",
                  warning ? "text-amber-700" : "text-pencil",
                )}
              />
              <span className="text-sm font-semibold">{text}</span>
              {warning ? (
                <AlertTriangle className="ml-auto size-4 text-amber-700" />
              ) : (
                <Check className="ml-auto size-4 text-leaf" />
              )}
            </div>
          );
        })}
      </div>
      {backendError && (
        <p
          role="alert"
          className="mt-3 rounded-2xl border border-coral/20 bg-coral/[.05] p-3 text-xs leading-5 text-coral"
        >
          Plan not saved: {backendError}
        </p>
      )}
      <Button
        disabled={finishing}
        onClick={async () => {
          setFinishing(true);
          await onFinish();
          setFinishing(false);
        }}
        size="lg"
        className="mt-auto w-full"
      >
        {finishing
          ? "Saving…"
          : effectiveStale
            ? "Save and open preview"
            : "Save plan and open Today"}
      </Button>
    </div>
  );
}

function Choice({
  value,
  icon: Icon,
  title,
  description,
}: {
  value: string;
  icon: typeof Users;
  title: string;
  description: string;
}) {
  return (
    <label className="flex min-h-[82px] cursor-pointer items-center gap-3 rounded-[20px] border border-rule bg-white p-4 has-[[data-state=checked]]:border-pencil has-[[data-state=checked]]:bg-pencil/[.035]">
      <span className="grid size-10 place-items-center rounded-2xl bg-recessed text-pencil">
        <Icon className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block text-sm">{title}</strong>
        <span className="mt-1 block text-xs text-muted">{description}</span>
      </span>
      <RadioGroupItem value={value} />
    </label>
  );
}
function PlainChoice({
  value,
  title,
  description,
}: {
  value: string;
  title: string;
  description: string;
}) {
  return (
    <label className="flex min-h-[68px] cursor-pointer items-center gap-3 rounded-2xl border border-rule bg-white p-3 has-[[data-state=checked]]:border-pencil">
      <RadioGroupItem value={value} />
      <span>
        <strong className="block text-sm">{title}</strong>
        <span className="text-xs text-muted">{description}</span>
      </span>
    </label>
  );
}
