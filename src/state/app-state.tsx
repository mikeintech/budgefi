import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  bootstrapResponseSchema,
  defaultFeatureFlags,
  type BootstrapResponse,
  type FeatureFlagsResponse,
  type PlaidLinkTokenResponse,
  type ManualTransactionRequest,
  type SavingsGoalCreateRequest,
  type SavingsGoalUpdateRequest,
  type DebtCreateRequest,
  type DebtUpdateRequest,
  type IncomeScheduleCreateRequest,
  type IncomeScheduleUpdateRequest,
} from "@budgefi/contracts";
import { api, requestId } from "@/lib/api";
import { isNativeApp } from "@/lib/platform";
import { authCacheScope } from "@/lib/auth";
import { readNativeCache, writeNativeCache } from "@/lib/native-cache";
import { calculatePlanProjection } from "@/lib/plan-preview";
import { runKeyedSingleFlight } from "@/lib/single-flight";
import { untouchedStarterKey } from "@/lib/common-bill-starters";
import { resolveAccountWorkspace } from "@/lib/account-workspace";
import { shouldAcceptBootstrap } from "@/lib/bootstrap-version";
import { mutationFailureKeepsConfirmedData } from "@/lib/mutation-failure";
export { calculatePlanProjection } from "@/lib/plan-preview";

export type HouseholdMode = "solo" | "shared";
export type NotificationMode = "exceptions" | "daily" | "all";
export type DataMode = "connected" | "manual";
export type BackendStatus = "loading" | "connected" | "cached" | "unavailable";
export type FinancialAccount = BootstrapResponse["accounts"][number];
export type FinancialConnection = BootstrapResponse["connections"][number];
export type PlanCommitment = BootstrapResponse["plan"]["commitments"][number];
export type PlanOccurrence = BootstrapResponse["plan"]["occurrences"][number];
export type SavingsGoal = BootstrapResponse["plan"]["savingsGoals"][number];
export type Debt = BootstrapResponse["debts"][number];
export type IncomeSchedule =
  BootstrapResponse["plan"]["incomeSchedules"][number];
export type FinancialException = BootstrapResponse["cases"][number];
export type IncomeFrequency =
  | "weekly"
  | "biweekly"
  | "semi_monthly"
  | "monthly"
  | "quarterly"
  | "annual"
  | "irregular";
export type CommitmentRecurrence =
  | "one_time"
  | "weekly"
  | "biweekly"
  | "monthly"
  | "quarterly"
  | "annual";
export type CustomCommitment = {
  id: string;
  name: string;
  amount: number;
  dueDate: string;
  recurrence: CommitmentRecurrence;
  starterItemKey?:
    | "housing"
    | "utilities"
    | "phone_internet"
    | "insurance"
    | "subscriptions"
    | "debt_payment";
};
export type ManualActual = {
  id: string;
  merchant: string;
  amount: number;
  date: string;
};
export type AuthoritativeProjection = {
  knownCash: number;
  commitments: number;
  plannedSavings: number;
  safetyBuffer: number;
  reserved: number;
  available: number;
  calculatedAt: string;
  policyVersion: string;
  horizonStart: string;
  horizonEnd: string;
  planningHorizonDays: number;
};
export type PlanCalibrationData = {
  knownCash: number;
  includeChase: boolean;
  includeJoint: boolean;
  cashProvenance: "observed" | "user_entered";
  fallbackHorizonDays: number;
  rentId: string | null;
  rentName: string;
  rentAmount: number;
  rentDueDate: string;
  rentRecurrence: CommitmentRecurrence;
  electricId: string | null;
  electricName: string;
  electricMax: number;
  electricDueDate: string;
  electricRecurrence: CommitmentRecurrence;
  streamBoxId: string | null;
  streamBoxName: string;
  streamBoxAmount: number;
  streamBoxDueDate: string;
  streamBoxRecurrence: CommitmentRecurrence;
  insuranceId: string | null;
  insuranceName: string;
  insuranceAmount: number;
  insuranceDueDate: string;
  insuranceRecurrence: CommitmentRecurrence;
  editedCommitments: string[];
  starterItemKeys: NonNullable<CustomCommitment["starterItemKey"]>[];
  customCommitments: CustomCommitment[];
  savingsContribution: number;
};

export const defaultCalibration: PlanCalibrationData = {
  knownCash: 0,
  includeChase: false,
  includeJoint: false,
  cashProvenance: "user_entered",
  fallbackHorizonDays: 14,
  rentId: null,
  rentName: "Rent",
  rentAmount: 0,
  rentDueDate: "",
  rentRecurrence: "monthly",
  electricId: null,
  electricName: "Electric",
  electricMax: 0,
  electricDueDate: "",
  electricRecurrence: "monthly",
  streamBoxId: null,
  streamBoxName: "Subscriptions",
  streamBoxAmount: 0,
  streamBoxDueDate: "",
  streamBoxRecurrence: "monthly",
  insuranceId: null,
  insuranceName: "Insurance",
  insuranceAmount: 0,
  insuranceDueDate: "",
  insuranceRecurrence: "monthly",
  editedCommitments: [],
  starterItemKeys: [],
  customCommitments: [],
  savingsContribution: 0,
};

export type EventItem = {
  id: string;
  title: string;
  detail: string;
  time: string;
  type: "evidence" | "plan" | "source" | "household";
};
export type ActivityEvent = EventItem;

type State = {
  householdId: string | null;
  revision: string | null;
  sourceStale: boolean;
  workspaceName: string;
  bankConnectionsEnabled: boolean;
  features: FeatureFlagsResponse;
  calibration: PlanCalibrationData;
  authoritativeProjection: AuthoritativeProjection;
  availableCashAlert: BootstrapResponse["plan"]["availableCashAlert"];
  latestStarterApplication: BootstrapResponse["plan"]["latestStarterApplication"];
  undoStarterApplicationPendingId: string | null;
  commitments: PlanCommitment[];
  occurrences: PlanOccurrence[];
  savingsGoals: SavingsGoal[];
  debts: Debt[];
  incomeSchedules: IncomeSchedule[];
  horizonIncomeScheduleId: string | null;
  horizonBasis: "expected_income" | "fallback";
  horizonMissedIncome: boolean;
  planCalibrated: boolean;
  electricMax: number;
  planningBuffer: number;
  householdMode: HouseholdMode;
  notificationMode: NotificationMode;
  weeklyDigest: boolean;
  dataMode: DataMode;
  accounts: FinancialAccount[];
  connections: FinancialConnection[];
  cases: FinancialException[];
  manualActuals: ManualActual[];
  transactions: BootstrapResponse["transactions"];
  onboardingCompleted: boolean;
  events: EventItem[];
  backendStatus: BackendStatus;
  backendError: string | null;
  lastConfirmedAt: string | null;
  reloadBackend: () => Promise<void>;
  setHouseholdMode: (v: HouseholdMode) => void;
  setNotificationMode: (v: NotificationMode) => void;
  setWeeklyDigest: (v: boolean) => void;
  completeOnboarding: () => Promise<boolean>;
  setDataMode: (v: DataMode) => void;
  activateManualMode: () => Promise<boolean>;
  createPlaidLinkToken: (
    mode?: "create" | "update",
    connectionId?: string,
  ) => Promise<PlaidLinkTokenResponse | null>;
  exchangePlaid: (
    sessionId: string,
    publicToken: string,
    metadata: {
      linkSessionId?: string;
      institution?: { id: string; name: string };
    },
  ) => Promise<boolean>;
  completeHostedPlaid: (
    sessionId: string,
    linkToken: string,
  ) => Promise<boolean>;
  completePlaidUpdate: (
    sessionId: string,
    linkSessionId?: string,
  ) => Promise<boolean>;
  syncPlaid: (connectionId: string) => Promise<boolean>;
  disconnectPlaid: (connectionId: string) => Promise<boolean>;
  decideException: (
    item: FinancialException,
    decision: "expected" | "unexpected" | "unsure",
  ) => Promise<boolean>;
  setAccountInclusion: (
    account: FinancialAccount,
    includeInPlan: boolean,
  ) => Promise<boolean>;
  setAccountPlanningRole: (
    account: FinancialAccount,
    role: FinancialAccount["planningRole"],
  ) => Promise<boolean>;
  createSavingsGoal: (
    input: Omit<SavingsGoalCreateRequest, "requestId">,
  ) => Promise<boolean>;
  updateSavingsGoal: (
    goal: SavingsGoal,
    input: Omit<SavingsGoalUpdateRequest, "expectedVersion" | "requestId">,
  ) => Promise<boolean>;
  updateSavingsGoalBalance: (
    goal: SavingsGoal,
    balance: number,
  ) => Promise<boolean>;
  createDebt: (input: Omit<DebtCreateRequest, "requestId">) => Promise<boolean>;
  updateDebt: (
    debt: Debt,
    input: Omit<DebtUpdateRequest, "expectedVersion" | "requestId">,
  ) => Promise<boolean>;
  createIncomeSchedule: (
    input: Omit<IncomeScheduleCreateRequest, "requestId">,
  ) => Promise<boolean>;
  updateIncomeSchedule: (
    schedule: IncomeSchedule,
    input: Omit<IncomeScheduleUpdateRequest, "expectedVersion" | "requestId">,
  ) => Promise<boolean>;
  saveElectric: (v: number) => Promise<boolean>;
  savePlanningBuffer: (v: number) => Promise<boolean>;
  savePlanningPolicy: (
    v: Pick<PlanCalibrationData, "fallbackHorizonDays">,
    buffer: number,
  ) => Promise<boolean>;
  savePlanCalibration: (
    v: PlanCalibrationData,
    buffer: number,
  ) => Promise<boolean>;
  saveManualCash: (v: number) => Promise<boolean>;
  addManualActual: (
    merchant: string,
    amount: number,
    date: string,
    occurrenceId?: string,
    balanceIncludesActivity?: boolean,
    direction?: "debit" | "credit",
    accountId?: string,
    category?: ManualTransactionRequest["category"],
  ) => Promise<boolean>;
  addManualCommitment: (
    name: string,
    amount: number,
    dueDate: string,
    recurrence?: CommitmentRecurrence,
  ) => Promise<boolean>;
  skipOccurrence: (occurrence: PlanOccurrence) => Promise<boolean>;
  undoStarterApplication: (applicationId: string) => Promise<boolean>;
};

const initialEvents: EventItem[] = [
  {
    id: "e1",
    title: "Loading activity",
    detail: "Your history will appear when it is ready",
    time: "Now",
    type: "source",
  },
];

const C = createContext<State | null>(null);

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [householdId, setHouseholdId] = useState<string | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [sourceStale, setSourceStaleRaw] = useState(true);
  const [workspaceName, setWorkspaceName] = useState("My plan");
  const [bankConnectionsEnabled, setBankConnectionsEnabled] = useState(false);
  const [features, setFeatures] =
    useState<FeatureFlagsResponse>(defaultFeatureFlags);
  const [undoStarterApplicationPendingId, setUndoStarterApplicationPendingId] =
    useState<string | null>(null);
  const undoStarterApplicationFlights = useRef(
    new Map<string, Promise<boolean>>(),
  );
  const [calibration, setCalibration] =
    useState<PlanCalibrationData>(defaultCalibration);
  const [planCalibrated, setPlanCalibrated] = useState(true);
  const electricMax = calibration.electricMax;
  const [planningBuffer, setPlanningBuffer] = useState(0);
  const [householdMode, setHouseholdMode] = useState<HouseholdMode>("solo");
  const [notificationMode, setNotificationMode] =
    useState<NotificationMode>("all");
  const [weeklyDigest, setWeeklyDigest] = useState(true);
  const [dataMode, setDataModeRaw] = useState<DataMode>("manual");
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  const [connections, setConnections] = useState<FinancialConnection[]>([]);
  const [cases, setCases] = useState<FinancialException[]>([]);
  const [commitments, setCommitments] = useState<PlanCommitment[]>([]);
  const [occurrences, setOccurrences] = useState<PlanOccurrence[]>([]);
  const [savingsGoals, setSavingsGoals] = useState<SavingsGoal[]>([]);
  const [debts, setDebts] = useState<Debt[]>([]);
  const [incomeSchedules, setIncomeSchedules] = useState<IncomeSchedule[]>([]);
  const [horizonIncomeScheduleId, setHorizonIncomeScheduleId] = useState<
    string | null
  >(null);
  const [horizonBasis, setHorizonBasis] = useState<
    "expected_income" | "fallback"
  >("fallback");
  const [horizonMissedIncome, setHorizonMissedIncome] = useState(false);
  const [manualActuals, setManualActuals] = useState<ManualActual[]>([]);
  const [transactions, setTransactions] = useState<
    BootstrapResponse["transactions"]
  >([]);
  const [onboardingCompleted, setOnboardingCompleted] = useState(false);
  const [events, setEvents] = useState(initialEvents);
  const [backendStatus, setBackendStatus] = useState<BackendStatus>("loading");
  const [backendError, setBackendError] = useState<string | null>(null);
  const [lastConfirmedAt, setLastConfirmedAt] = useState<string | null>(null);
  const [apiAccountId, setApiAccountId] = useState<string | null>(null);
  const [planVersion, setPlanVersion] = useState(1);
  const planVersionRef = useRef(1);
  const revisionRef = useRef(0n);
  const commitmentRef = useRef(
    new Map<
      string,
      {
        id: string;
        version: number;
        dueDate: string | null;
        recurrence: CommitmentRecurrence;
      }
    >(),
  );
  const commitmentVersionRef = useRef(new Map<string, number>());
  const mutationQueue = useRef<Promise<void>>(Promise.resolve());
  const confirmedBootstrapRef = useRef<BootstrapResponse | null>(null);
  const plaidPollGeneration = useRef(0);
  const reloadGeneration = useRef(0);
  const scheduledReload = useRef<number | null>(null);
  const initialProjection = calculatePlanProjection(defaultCalibration, 0);
  const [authoritativeProjection, setAuthoritativeProjection] =
    useState<AuthoritativeProjection>({
      knownCash: defaultCalibration.knownCash,
      commitments: initialProjection.futureBills,
      plannedSavings: defaultCalibration.savingsContribution,
      safetyBuffer: 0,
      reserved: initialProjection.reserved,
      available: initialProjection.available,
      calculatedAt: new Date(0).toISOString(),
      policyVersion: "unconfirmed-preview",
      horizonStart: new Date().toISOString().slice(0, 10),
      horizonEnd: new Date().toISOString().slice(0, 10),
      planningHorizonDays: 10,
    });
  const [availableCashAlert, setAvailableCashAlert] = useState<
    BootstrapResponse["plan"]["availableCashAlert"]
  >({
    enabled: false,
    threshold: { minor: "25000", currency: "USD" },
    currentAvailable: { minor: "0", currency: "USD" },
    status: "disabled",
    episodeId: null,
    alertAvailable: null,
    alertEvaluatedAt: null,
    alertFreshness: null,
  });
  const [latestStarterApplication, setLatestStarterApplication] =
    useState<BootstrapResponse["plan"]["latestStarterApplication"]>(null);

  const add = (event: EventItem) =>
    setEvents((value) => [
      event,
      ...value.filter((item) => item.id !== event.id),
    ]);

  const applyBootstrap = (
    bootstrap: BootstrapResponse,
    source: "network" | "cache" = "network",
  ) => {
    const incomingRevision = BigInt(bootstrap.revision);
    const currentHouseholdId =
      confirmedBootstrapRef.current?.household.id ?? null;
    if (
      !shouldAcceptBootstrap(
        currentHouseholdId,
        revisionRef.current,
        bootstrap.household.id,
        incomingRevision,
      )
    )
      return;
    if (currentHouseholdId !== bootstrap.household.id) revisionRef.current = 0n;
    confirmedBootstrapRef.current = bootstrap;
    setHouseholdId(bootstrap.household.id);
    setRevision(bootstrap.revision);
    setWorkspaceName(bootstrap.household.name);
    setBankConnectionsEnabled(bootstrap.capabilities.bankConnections.enabled);
    setOnboardingCompleted(bootstrap.household.onboardingCompleted);
    revisionRef.current = incomingRevision;
    const freshness = bootstrap.plan.freshness ?? {
      status: "incomplete" as const,
      asOf: null,
    };
    commitmentRef.current = new Map(
      bootstrap.plan.commitments.map((item) => [
        item.name.toLocaleLowerCase(),
        {
          id: item.id,
          version: item.version,
          dueDate: item.dueDate,
          recurrence: item.recurrence,
        },
      ]),
    );
    commitmentVersionRef.current = new Map(
      bootstrap.plan.commitments.map((item) => [item.id, item.version]),
    );
    const namedCommitments = new Map(
      bootstrap.plan.commitments.map((item) => [item.name.toLowerCase(), item]),
    );
    const slottedCommitments = new Map(
      bootstrap.plan.commitments.flatMap((item) =>
        item.setupSlot ? [[item.setupSlot, item] as const] : [],
      ),
    );
    const fixedCommitment = (
      slot: "housing" | "utilities" | "subscriptions" | "insurance",
      legacyNames: string[],
    ) =>
      slottedCommitments.get(slot) ??
      legacyNames.map((name) => namedCommitments.get(name)).find(Boolean);
    const rent = fixedCommitment("housing", ["rent"]);
    const electric = fixedCommitment("utilities", ["electric"]);
    const subscriptions = fixedCommitment("subscriptions", [
      "subscriptions",
      "streambox",
    ]);
    const insurance = fixedCommitment("insurance", ["insurance"]);
    const fixedIds = new Set(
      [rent, electric, subscriptions, insurance].flatMap((item) =>
        item ? [item.id] : [],
      ),
    );
    setCalibration((value) => ({
      ...value,
      knownCash: minorToMajor(bootstrap.plan.knownCash.minor),
      cashProvenance:
        freshness.status === "manual" ? "user_entered" : "observed",
      includeChase: bootstrap.accounts.some(
        (account) => account.provenance === "plaid",
      ),
      includeJoint: false,
      rentId: rent?.id ?? null,
      rentName: rent?.name ?? "Rent",
      rentAmount: rent ? minorToMajor(rent.amount.minor) : 0,
      rentDueDate: rent?.dueDate ?? "",
      rentRecurrence: rent?.recurrence ?? "monthly",
      electricId: electric?.id ?? null,
      electricName: electric?.name ?? "Electric",
      electricMax: electric ? minorToMajor(electric.amount.minor) : 0,
      electricDueDate: electric?.dueDate ?? "",
      electricRecurrence: electric?.recurrence ?? "monthly",
      streamBoxId: subscriptions?.id ?? null,
      streamBoxName: subscriptions?.name ?? "Subscriptions",
      streamBoxAmount: subscriptions
        ? minorToMajor(subscriptions.amount.minor)
        : 0,
      streamBoxDueDate: subscriptions?.dueDate ?? "",
      streamBoxRecurrence: subscriptions?.recurrence ?? "monthly",
      insuranceId: insurance?.id ?? null,
      insuranceName: insurance?.name ?? "Insurance",
      insuranceAmount: insurance ? minorToMajor(insurance.amount.minor) : 0,
      insuranceDueDate: insurance?.dueDate ?? "",
      insuranceRecurrence: insurance?.recurrence ?? "monthly",
      customCommitments: bootstrap.plan.commitments
        .filter((item) => !fixedIds.has(item.id))
        .map((item) => ({
          id: item.id,
          name: item.name,
          amount: minorToMajor(item.amount.minor),
          dueDate: item.dueDate ?? "",
          recurrence: item.recurrence,
          ...(item.starterItemKey
            ? { starterItemKey: item.starterItemKey }
            : {}),
        })),
      starterItemKeys: bootstrap.plan.commitments.flatMap((item) =>
        item.starterItemKey ? [item.starterItemKey] : [],
      ),
      savingsContribution: minorToMajor(bootstrap.plan.plannedSavings.minor),
      fallbackHorizonDays: bootstrap.plan.fallbackHorizonDays,
      editedCommitments: bootstrap.plan.commitments
        .filter((item) => item.provenance === "manual")
        .map((item) => item.name),
    }));
    setPlanningBuffer(minorToMajor(bootstrap.plan.safetyBuffer.minor));
    setPlanVersion(bootstrap.plan.version);
    planVersionRef.current = bootstrap.plan.version;
    setAuthoritativeProjection({
      knownCash: minorToMajor(bootstrap.plan.knownCash.minor),
      commitments:
        minorToMajor(bootstrap.plan.reserved.minor) -
        minorToMajor(bootstrap.plan.plannedSavings.minor) -
        minorToMajor(bootstrap.plan.safetyBuffer.minor),
      plannedSavings: minorToMajor(bootstrap.plan.plannedSavings.minor),
      safetyBuffer: minorToMajor(bootstrap.plan.safetyBuffer.minor),
      reserved: minorToMajor(bootstrap.plan.reserved.minor),
      available: minorToMajor(bootstrap.plan.available.minor),
      calculatedAt: bootstrap.plan.calculatedAt,
      policyVersion: bootstrap.plan.policyVersion,
      horizonStart: bootstrap.plan.horizonStart,
      horizonEnd: bootstrap.plan.horizonEnd,
      planningHorizonDays: bootstrap.plan.planningHorizonDays,
    });
    setAvailableCashAlert(bootstrap.plan.availableCashAlert);
    setLatestStarterApplication(bootstrap.plan.latestStarterApplication);
    setAccounts(bootstrap.accounts);
    setConnections(bootstrap.connections);
    setCases(bootstrap.cases);
    setTransactions(bootstrap.transactions);
    setCommitments(bootstrap.plan.commitments);
    setOccurrences(bootstrap.plan.occurrences);
    setSavingsGoals(bootstrap.plan.savingsGoals);
    setDebts(bootstrap.debts);
    setIncomeSchedules(bootstrap.plan.incomeSchedules);
    setHorizonIncomeScheduleId(bootstrap.plan.horizonIncomeScheduleId);
    setHorizonBasis(bootstrap.plan.horizonBasis);
    setHorizonMissedIncome(bootstrap.plan.horizonMissedIncome);
    const workspace = resolveAccountWorkspace(
      bootstrap.accounts,
      bootstrap.connections,
    );
    setApiAccountId(workspace.manualAccountId);
    setDataModeRaw(workspace.mode);
    setSourceStaleRaw(
      freshness.status === "stale" || freshness.status === "incomplete",
    );
    setManualActuals(
      bootstrap.transactions
        .filter((item) => item.provenance === "manual")
        .map((item) => ({
          id: item.id,
          merchant: item.merchant,
          amount: minorToMajor(item.amount.minor),
          date: item.occurredOn,
        })),
    );
    setEvents(
      bootstrap.activity.map((event) => ({
        id: event.id,
        title: event.title,
        detail: event.detail,
        time: relativeTime(event.occurredAt),
        type: eventType(event.type),
      })),
    );
    setBackendStatus(source === "network" ? "connected" : "cached");
    setBackendError(
      source === "network"
        ? null
        : "You’re viewing the last confirmed copy. Reconnect before making changes.",
    );
    if (source === "network") {
      const confirmedAt = new Date().toISOString();
      setLastConfirmedAt(confirmedAt);
      if (isNativeApp)
        void authCacheScope()
          .then((scope) =>
            scope
              ? writeNativeCache(
                  cacheKey(scope),
                  JSON.stringify({
                    scope,
                    householdId: bootstrap.household.id,
                    confirmedAt,
                    bootstrap,
                  }),
                )
              : undefined,
          )
          .catch(() => undefined);
    }
  };

  const reportError = (error: unknown) => {
    setBackendError(
      error instanceof Error
        ? error.message
        : "Budgefi is temporarily unavailable",
    );
    setBackendStatus(confirmedBootstrapRef.current ? "cached" : "unavailable");
  };

  const loadCachedBootstrap = async (generation?: number): Promise<boolean> => {
    if (!isNativeApp) return false;
    try {
      const scope = await authCacheScope();
      if (!scope) return false;
      const raw = await readNativeCache(cacheKey(scope));
      if (!raw) return false;
      const parsed = JSON.parse(raw) as {
        scope?: unknown;
        householdId?: unknown;
        confirmedAt?: unknown;
        bootstrap?: unknown;
      };
      if (parsed.scope !== scope) return false;
      const bootstrap = bootstrapResponseSchema.parse(parsed.bootstrap);
      if (parsed.householdId !== bootstrap.household.id) return false;
      if (generation !== undefined && generation !== reloadGeneration.current)
        return false;
      setLastConfirmedAt(
        typeof parsed.confirmedAt === "string"
          ? parsed.confirmedAt
          : bootstrap.plan.calculatedAt,
      );
      applyBootstrap(bootstrap, "cache");
      return true;
    } catch {
      return false;
    }
  };

  const reloadBackend = async () => {
    const generation = ++reloadGeneration.current;
    if (!confirmedBootstrapRef.current) setBackendStatus("loading");
    try {
      const [bootstrap, flags] = await Promise.all([
        api.bootstrap(),
        api.features().catch(() => defaultFeatureFlags),
      ]);
      if (generation !== reloadGeneration.current) return;
      setFeatures(flags);
      applyBootstrap(bootstrap, "network");
    } catch (error) {
      if (generation !== reloadGeneration.current) return;
      if (!(await loadCachedBootstrap(generation))) {
        if (generation === reloadGeneration.current) reportError(error);
      }
    }
  };

  const mutate = (
    operation: () => Promise<BootstrapResponse>,
  ): Promise<boolean> => {
    if (backendStatus === "cached") {
      setBackendError(
        "This change wasn’t attempted because Budgefi is offline. Reconnect and try again.",
      );
      return Promise.resolve(false);
    }
    const result = mutationQueue.current
      .then(operation)
      .then((bootstrap) => {
        applyBootstrap(bootstrap);
        return true;
      })
      .catch(async (error: unknown) => {
        const message =
          error instanceof Error
            ? error.message
            : "The change could not be saved";
        setBackendError(message);
        if (!mutationFailureKeepsConfirmedData(error))
          setBackendStatus(
            confirmedBootstrapRef.current ? "cached" : "unavailable",
          );
        try {
          applyBootstrap(await api.bootstrap());
          // Reconciliation restores canonical server state, but the rejected write
          // must remain visible instead of being mistaken for a successful save.
          setBackendError(message);
          setBackendStatus("connected");
        } catch (reloadError) {
          reportError(reloadError);
        }
        return false;
      });
    mutationQueue.current = result.then(() => undefined);
    return result;
  };

  const pollPlaidUntilSettled = async (): Promise<void> => {
    const generation = ++plaidPollGeneration.current;
    // The scheduled worker can begin near the end of its two-minute cadence.
    // Keep the UI reconciled through that full window instead of stranding a
    // successful Link session behind an obsolete "Fix" warning.
    const deadline = Date.now() + 180_000;
    let delay = 1_500;
    while (
      generation === plaidPollGeneration.current &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, delay));
      try {
        const bootstrap = await api.bootstrap();
        if (generation !== plaidPollGeneration.current) return;
        applyBootstrap(bootstrap, "network");
        const unsettled = bootstrap.connections.some((connection) =>
          ["pending", "syncing", "revocation_pending"].includes(
            connection.status,
          ),
        );
        if (!unsettled) return;
        delay = Math.min(Math.round(delay * 1.6), 10_000);
      } catch {
        // The normal offline/retry surface owns errors. A provider poll is
        // deliberately quiet so a transient refresh cannot erase good data.
        delay = Math.min(Math.round(delay * 1.6), 10_000);
      }
    }
  };

  const mutatePlaid = async (
    operation: () => Promise<BootstrapResponse>,
  ): Promise<boolean> => {
    const saved = await mutate(operation);
    if (saved) void pollPlaidUntilSettled();
    return saved;
  };

  useEffect(() => {
    void reloadBackend();
    const queueReload = () => {
      if (scheduledReload.current !== null)
        window.clearTimeout(scheduledReload.current);
      // Native resume and document visibility commonly arrive together. One
      // refresh is enough and avoids racing two copies of the same snapshot.
      scheduledReload.current = window.setTimeout(() => {
        scheduledReload.current = null;
        void reloadBackend();
      }, 150);
    };
    const reconnect = (event: Event) => {
      const detail = (event as CustomEvent<{ connected?: boolean }>).detail;
      if (detail?.connected === false) {
        if (confirmedBootstrapRef.current) {
          setBackendStatus("cached");
          setBackendError(
            "You’re offline. Budgefi is showing the last confirmed copy.",
          );
        }
        return;
      }
      queueReload();
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") queueReload();
    };
    window.addEventListener("budgefi:network", reconnect);
    window.addEventListener("budgefi:resume", queueReload);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      plaidPollGeneration.current += 1;
      reloadGeneration.current += 1;
      if (scheduledReload.current !== null)
        window.clearTimeout(scheduledReload.current);
      window.removeEventListener("budgefi:network", reconnect);
      window.removeEventListener("budgefi:resume", queueReload);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);

  useEffect(() => {
    if (
      backendStatus !== "connected" ||
      dataMode === "manual" ||
      !sourceStale ||
      document.visibilityState !== "visible"
    )
      return;
    const timer = window.setTimeout(() => void reloadBackend(), 20_000);
    return () => window.clearTimeout(timer);
  }, [backendStatus, connections, dataMode, sourceStale]);

  const completeOnboarding = () => mutate(() => api.completeOnboarding());
  const saveElectric = (value: number) => {
    const maximum = Math.max(0, value);
    const next = {
      ...calibration,
      electricMax: maximum,
      editedCommitments: calibration.editedCommitments.includes("electricMax")
        ? calibration.editedCommitments
        : [...calibration.editedCommitments, "electricMax"],
    };
    return savePlanCalibration(next, planningBuffer);
  };
  const savePlanningBuffer = (value: number) => {
    const id = requestId();
    return mutate(() =>
      api.updatePlan({
        expectedVersion: planVersionRef.current,
        plannedSavings: toApiMoney(calibration.savingsContribution),
        safetyBuffer: toApiMoney(value),
        requestId: id,
      }),
    );
  };
  const savePlanningPolicy: State["savePlanningPolicy"] = (value, buffer) => {
    const id = requestId();
    return mutate(() =>
      api.updatePlan({
        expectedVersion: planVersionRef.current,
        plannedSavings: toApiMoney(calibration.savingsContribution),
        safetyBuffer: toApiMoney(buffer),
        fallbackHorizonDays: value.fallbackHorizonDays,
        requestId: id,
      }),
    );
  };
  const savePlanCalibration = (value: PlanCalibrationData, buffer: number) => {
    const commitment = (
      name: string,
      amount: number,
      explicitId?: string,
      dueDate?: string,
      recurrence?: CommitmentRecurrence,
      setupSlot?:
        | "housing"
        | "utilities"
        | "subscriptions"
        | "insurance"
        | null,
    ) => {
      const existing = explicitId
        ? {
            id: explicitId,
            version: commitmentVersionRef.current.get(explicitId),
            dueDate:
              commitmentRef.current.get(name.toLocaleLowerCase())?.dueDate ??
              null,
            recurrence:
              [...commitmentRef.current.values()].find(
                (item) => item.id === explicitId,
              )?.recurrence ?? ("monthly" as const),
          }
        : commitmentRef.current.get(name.toLocaleLowerCase());
      return {
        ...(existing?.id && existing.version
          ? { id: existing.id, expectedVersion: existing.version }
          : {}),
        name,
        amount: toApiMoney(amount),
        dueDate: dueDate || existing?.dueDate || null,
        recurrence: recurrence ?? existing?.recurrence ?? "monthly",
        setupSlot: setupSlot ?? null,
      };
    };
    const commitments = [
      ...(value.rentAmount > 0 || Boolean(value.rentId)
        ? [
            commitment(
              value.rentName.trim(),
              value.rentAmount,
              value.rentId ?? commitmentRef.current.get("rent")?.id,
              value.rentDueDate,
              value.rentRecurrence,
              "housing",
            ),
          ]
        : []),
      ...(value.electricMax > 0 || Boolean(value.electricId)
        ? [
            commitment(
              value.electricName.trim(),
              value.electricMax,
              value.electricId ?? commitmentRef.current.get("electric")?.id,
              value.electricDueDate,
              value.electricRecurrence,
              "utilities",
            ),
          ]
        : []),
      ...(value.streamBoxAmount > 0 || Boolean(value.streamBoxId)
        ? [
            commitment(
              value.streamBoxName.trim(),
              value.streamBoxAmount,
              value.streamBoxId ??
                commitmentRef.current.get("subscriptions")?.id ??
                commitmentRef.current.get("streambox")?.id,
              value.streamBoxDueDate,
              value.streamBoxRecurrence,
              "subscriptions",
            ),
          ]
        : []),
      ...(value.insuranceAmount > 0 || Boolean(value.insuranceId)
        ? [
            commitment(
              value.insuranceName.trim(),
              value.insuranceAmount,
              value.insuranceId ?? commitmentRef.current.get("insurance")?.id,
              value.insuranceDueDate,
              value.insuranceRecurrence,
              "insurance",
            ),
          ]
        : []),
      ...value.customCommitments.flatMap((item) => {
        const persisted = commitmentVersionRef.current.has(item.id);
        const starterItemKey = untouchedStarterKey(item, persisted);
        // Existing empty starter rows are legitimate saved commitments. Keep
        // them in every calibration request until the user edits or removes
        // them; omitting one is intentionally interpreted by the API as a
        // deletion.
        if (item.amount <= 0 && !starterItemKey && !persisted) return [];
        return [
          {
            ...commitment(
              item.name,
              item.amount,
              item.id,
              item.dueDate,
              item.recurrence,
              null,
            ),
            ...(starterItemKey ? { starterItemKey } : {}),
          },
        ];
      }),
    ];
    const retainedIds = new Set(
      commitments.flatMap((item) => (item.id ? [item.id] : [])),
    );
    const removeCommitments = [...commitmentVersionRef.current]
      .filter(([id]) => !retainedIds.has(id))
      .map(([id, expectedVersion]) => ({ id, expectedVersion }));
    const id = requestId();
    return mutate(() =>
      api.calibratePlan({
        expectedVersion: planVersionRef.current,
        ...(dataMode === "manual" && apiAccountId
          ? {
              manualBalance: {
                accountId: apiAccountId,
                amount: toApiMoney(value.knownCash),
                asOf: new Date().toISOString(),
              },
            }
          : {}),
        plannedSavings: toApiMoney(value.savingsContribution),
        safetyBuffer: toApiMoney(buffer),
        fallbackHorizonDays: value.fallbackHorizonDays,
        commitments,
        ...(value.customCommitments.some((item) =>
          Boolean(
            untouchedStarterKey(
              item,
              commitmentVersionRef.current.has(item.id),
            ),
          ),
        )
          ? {
              starterTemplate: {
                key: "common_bills" as const,
                version: 1 as const,
              },
            }
          : {}),
        removeCommitments,
        requestId: id,
      }),
    ).then((okay) => {
      if (okay) setPlanCalibrated(true);
      return okay;
    });
  };
  const setDataMode = (mode: DataMode) => {
    setDataModeRaw(mode);
    if (mode === "manual") {
      setSourceStaleRaw(false);
      setCalibration((value) => ({
        ...value,
        cashProvenance: "user_entered",
        editedCommitments: [
          "rentAmount",
          "electricMax",
          "streamBoxAmount",
          "insuranceAmount",
        ],
      }));
      add({
        id: "manual-mode",
        title: "Manual values selected",
        detail:
          "Connected sources may remain available but excluded · manual values stay labeled as you-entered",
        time: "Just now",
        type: "source",
      });
    }
  };
  const createPlaidLinkToken = async (
    mode: "create" | "update" = "create",
    connectionId?: string,
  ) => {
    try {
      setBackendError(null);
      return await api.createPlaidLinkToken({
        mode,
        nativeHosted: isNativeApp,
        ...(connectionId ? { connectionId } : {}),
      });
    } catch (error) {
      setBackendError(
        error instanceof Error
          ? error.message
          : "The secure connection could not start",
      );
      setBackendStatus("connected");
      return null;
    }
  };
  const exchangePlaid = (
    sessionId: string,
    publicToken: string,
    metadata: {
      linkSessionId?: string;
      institution?: { id: string; name: string };
    },
  ) =>
    mutatePlaid(() =>
      api.exchangePlaid({
        sessionId,
        publicToken,
        ...(metadata.linkSessionId
          ? { linkSessionId: metadata.linkSessionId }
          : {}),
        ...(metadata.institution ? { institution: metadata.institution } : {}),
        requestId: requestId(),
      }),
    );
  const completePlaidUpdate = (sessionId: string, linkSessionId?: string) =>
    mutatePlaid(() =>
      api.completePlaidUpdate({
        sessionId,
        ...(linkSessionId ? { linkSessionId } : {}),
        requestId: requestId(),
      }),
    );
  const completeHostedPlaid = (sessionId: string, linkToken: string) =>
    mutatePlaid(() =>
      api.completeHostedPlaid({
        sessionId,
        linkToken,
        requestId: requestId(),
      }),
    );
  const syncPlaid = (connectionId: string) =>
    mutatePlaid(() => api.syncPlaid(connectionId));
  const disconnectPlaid = (connectionId: string) =>
    mutatePlaid(() => api.disconnectPlaid(connectionId));
  const activateManualMode = async () => {
    return mutate(() => api.activateManualMode({ requestId: requestId() }));
  };
  const setAccountInclusion = (
    account: FinancialAccount,
    includeInPlan: boolean,
  ) =>
    mutate(() =>
      api.setAccountInclusion(account.id, {
        expectedVersion: account.version,
        includeInPlan,
        requestId: requestId(),
      }),
    );
  const setAccountPlanningRole: State["setAccountPlanningRole"] = (
    account,
    role,
  ) =>
    mutate(() =>
      api.setAccountPlanningRole(account.id, {
        expectedVersion: account.version,
        role,
        requestId: requestId(),
      }),
    );
  const createSavingsGoal: State["createSavingsGoal"] = (input) =>
    mutate(() => api.createSavingsGoal({ ...input, requestId: requestId() }));
  const updateSavingsGoal: State["updateSavingsGoal"] = (goal, input) =>
    mutate(() =>
      api.updateSavingsGoal(goal.id, {
        ...input,
        expectedVersion: goal.version,
        requestId: requestId(),
      }),
    );
  const updateSavingsGoalBalance: State["updateSavingsGoalBalance"] = (
    goal,
    balance,
  ) =>
    mutate(() =>
      api.updateSavingsGoalBalance(goal.id, {
        expectedGoalVersion: goal.version,
        balance: toApiMoney(Math.max(0, balance)),
        asOf: new Date().toISOString(),
        requestId: requestId(),
      }),
    );
  const createDebt: State["createDebt"] = (input) =>
    mutate(() => api.createDebt({ ...input, requestId: requestId() }));
  const updateDebt: State["updateDebt"] = (debt, input) =>
    mutate(() =>
      api.updateDebt(debt.id, {
        ...input,
        expectedVersion: debt.version,
        requestId: requestId(),
      }),
    );
  const createIncomeSchedule: State["createIncomeSchedule"] = (input) =>
    mutate(() =>
      api.createIncomeSchedule({ ...input, requestId: requestId() }),
    );
  const updateIncomeSchedule: State["updateIncomeSchedule"] = (
    schedule,
    input,
  ) =>
    mutate(() =>
      api.updateIncomeSchedule(schedule.id, {
        ...input,
        expectedVersion: schedule.version,
        requestId: requestId(),
      }),
    );
  const decideException = (
    item: FinancialException,
    decision: "expected" | "unexpected" | "unsure",
  ) =>
    mutate(() =>
      api.decideException(item.id, {
        decision,
        expectedVersion: item.version,
        requestId: requestId(),
      }),
    );
  const saveManualCash = (knownCash: number) => {
    const id = requestId();
    if (!apiAccountId) {
      reportError(
        new Error("A manual account is required before recording a balance"),
      );
      return Promise.resolve(false);
    }
    return mutate(() =>
      api.saveManualBalance({
        accountId: apiAccountId,
        amount: toApiMoney(Math.max(0, knownCash)),
        asOf: new Date().toISOString(),
        requestId: id,
      }),
    );
  };
  const addManualActual = (
    merchant: string,
    amount: number,
    date: string,
    occurrenceId?: string,
    balanceIncludesActivity = false,
    direction: "debit" | "credit" = "debit",
    accountId?: string,
    category: ManualTransactionRequest["category"] = direction === "credit"
      ? "income"
      : "uncategorized",
  ) => {
    const id = requestId();
    const eligibleAccounts = accounts.filter(
      (account) => account.includeInPlan,
    );
    const evidenceAccountId =
      accountId ??
      (eligibleAccounts.length === 1 ? eligibleAccounts[0]?.id : undefined);
    if (!evidenceAccountId) {
      reportError(
        new Error("An active account is required before recording activity"),
      );
      return Promise.resolve(false);
    }
    return mutate(() =>
      api.addManualTransaction({
        accountId: evidenceAccountId,
        merchant: merchant.trim(),
        amount: toApiMoney(Math.max(0, amount)),
        occurredOn: date,
        direction,
        category,
        ...(occurrenceId ? { occurrenceId } : {}),
        balanceIncludesActivity,
        requestId: id,
      }),
    );
  };
  const addManualCommitment = (
    name: string,
    amount: number,
    dueDate: string,
    recurrence: CommitmentRecurrence = "one_time",
  ) => {
    const id = requestId();
    return mutate(() =>
      api.addCommitment({
        name: name.trim(),
        amount: toApiMoney(Math.max(0, amount)),
        dueDate: dueDate || null,
        recurrence,
        requestId: id,
      }),
    );
  };
  const skipOccurrence = (occurrence: PlanOccurrence) =>
    mutate(() =>
      api.skipOccurrence(occurrence.id, {
        expectedVersion: occurrence.version,
        requestId: requestId(),
      }),
    );
  const undoStarterApplication = (applicationId: string) =>
    runKeyedSingleFlight(
      undoStarterApplicationFlights.current,
      applicationId,
      async () => {
        setUndoStarterApplicationPendingId(applicationId);
        try {
          return await mutate(() => api.undoStarterApplication(applicationId));
        } finally {
          setUndoStarterApplicationPendingId((pendingId) =>
            pendingId === applicationId ? null : pendingId,
          );
        }
      },
    );
  const value = useMemo(
    () => ({
      householdId,
      revision,
      sourceStale,
      workspaceName,
      bankConnectionsEnabled,
      features,
      calibration,
      authoritativeProjection,
      availableCashAlert,
      latestStarterApplication,
      undoStarterApplicationPendingId,
      commitments,
      occurrences,
      savingsGoals,
      debts,
      incomeSchedules,
      horizonIncomeScheduleId,
      horizonBasis,
      horizonMissedIncome,
      planCalibrated,
      electricMax,
      planningBuffer,
      householdMode,
      notificationMode,
      weeklyDigest,
      dataMode,
      accounts,
      connections,
      cases,
      manualActuals,
      transactions,
      onboardingCompleted,
      events,
      backendStatus,
      backendError,
      lastConfirmedAt,
      reloadBackend,
      setHouseholdMode,
      setNotificationMode,
      setWeeklyDigest,
      completeOnboarding,
      setDataMode,
      activateManualMode,
      createPlaidLinkToken,
      exchangePlaid,
      completeHostedPlaid,
      completePlaidUpdate,
      syncPlaid,
      disconnectPlaid,
      decideException,
      setAccountInclusion,
      setAccountPlanningRole,
      createSavingsGoal,
      updateSavingsGoal,
      updateSavingsGoalBalance,
      createDebt,
      updateDebt,
      createIncomeSchedule,
      updateIncomeSchedule,
      saveElectric,
      savePlanningBuffer,
      savePlanningPolicy,
      savePlanCalibration,
      saveManualCash,
      addManualActual,
      addManualCommitment,
      skipOccurrence,
      undoStarterApplication,
    }),
    [
      householdId,
      revision,
      sourceStale,
      workspaceName,
      bankConnectionsEnabled,
      features,
      calibration,
      authoritativeProjection,
      availableCashAlert,
      latestStarterApplication,
      undoStarterApplicationPendingId,
      commitments,
      occurrences,
      savingsGoals,
      debts,
      incomeSchedules,
      horizonIncomeScheduleId,
      horizonBasis,
      horizonMissedIncome,
      planCalibrated,
      electricMax,
      planningBuffer,
      householdMode,
      notificationMode,
      weeklyDigest,
      dataMode,
      accounts,
      connections,
      cases,
      manualActuals,
      transactions,
      onboardingCompleted,
      events,
      backendStatus,
      backendError,
      lastConfirmedAt,
      apiAccountId,
      planVersion,
    ],
  );
  return <C.Provider value={value}>{children}</C.Provider>;
}

export function useAppState() {
  const value = useContext(C);
  if (!value) throw new Error("missing AppStateProvider");
  return value;
}

function minorToMajor(minor: string): number {
  return Number(BigInt(minor)) / 100;
}
function toApiMoney(value: number) {
  return { minor: String(Math.round(value * 100)), currency: "USD" as const };
}
function relativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  return elapsed < 90_000
    ? "Just now"
    : new Date(value).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}
function eventType(type: string): EventItem["type"] {
  if (type.startsWith("transaction") || type.startsWith("case"))
    return "evidence";
  if (
    type.startsWith("plan") ||
    type.startsWith("commitment") ||
    type.startsWith("balance")
  )
    return "plan";
  if (type.startsWith("household")) return "household";
  return "source";
}
function cacheKey(scope: string): string {
  return `bootstrap-cache:${scope
    .replace(/[^a-zA-Z0-9._|-]/g, "_")
    .slice(0, 180)}`;
}
