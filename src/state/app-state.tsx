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
  type BootstrapResponse,
  type PlaidLinkTokenResponse,
} from "@budgefi/contracts";
import { api, requestId } from "@/lib/api";
import { isNativeApp } from "@/lib/platform";
import { authCacheScope } from "@/lib/auth";
import { readNativeCache, writeNativeCache } from "@/lib/native-cache";

export type HouseholdMode = "solo" | "shared";
export type NotificationMode = "exceptions" | "daily" | "all";
export type DataMode = "connected" | "manual";
export type BackendStatus = "loading" | "connected" | "cached" | "unavailable";
export type FinancialAccount = BootstrapResponse["accounts"][number];
export type FinancialConnection = BootstrapResponse["connections"][number];
export type PlanCommitment = BootstrapResponse["plan"]["commitments"][number];
export type FinancialException = BootstrapResponse["cases"][number];
export type IncomeFrequency =
  | "weekly"
  | "biweekly"
  | "semi_monthly"
  | "monthly"
  | "irregular";
export type CustomCommitment = {
  id: string;
  name: string;
  amount: number;
  dueDate: string;
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
  incomeAmount: number;
  incomeFrequency: IncomeFrequency;
  nextIncomeDate: string;
  incomeConfirmed: boolean;
  rentName: string;
  rentAmount: number;
  rentDueDate: string;
  electricName: string;
  electricMax: number;
  electricDueDate: string;
  streamBoxName: string;
  streamBoxAmount: number;
  streamBoxDueDate: string;
  insuranceName: string;
  insuranceAmount: number;
  insuranceDueDate: string;
  editedCommitments: string[];
  customCommitments: CustomCommitment[];
  savingsContribution: number;
};

export const defaultCalibration: PlanCalibrationData = {
  knownCash: 0,
  includeChase: false,
  includeJoint: false,
  cashProvenance: "user_entered",
  incomeAmount: 0,
  incomeFrequency: "biweekly",
  nextIncomeDate: "",
  incomeConfirmed: false,
  rentName: "Rent",
  rentAmount: 0,
  rentDueDate: "",
  electricName: "Electric",
  electricMax: 0,
  electricDueDate: "",
  streamBoxName: "Subscriptions",
  streamBoxAmount: 0,
  streamBoxDueDate: "",
  insuranceName: "Insurance",
  insuranceAmount: 0,
  insuranceDueDate: "",
  editedCommitments: [],
  customCommitments: [],
  savingsContribution: 0,
};

export function calculatePlanProjection(
  calibration: PlanCalibrationData,
  planningBuffer: number,
  horizonEnd?: string,
) {
  const cents = (value: number) => Math.round(value * 100);
  const incomeInWindow = 0;
  const inWindow = (date: string) => !horizonEnd || !date || date <= horizonEnd;
  const customCents = calibration.customCommitments.reduce(
    (sum, item) => sum + (inWindow(item.dueDate) ? cents(item.amount) : 0),
    0,
  );
  const futureBillsCents =
    (inWindow(calibration.rentDueDate) ? cents(calibration.rentAmount) : 0) +
    (inWindow(calibration.electricDueDate)
      ? cents(calibration.electricMax)
      : 0) +
    (inWindow(calibration.streamBoxDueDate)
      ? cents(calibration.streamBoxAmount)
      : 0) +
    (inWindow(calibration.insuranceDueDate)
      ? cents(calibration.insuranceAmount)
      : 0) +
    customCents;
  const reservedCents =
    futureBillsCents +
    cents(calibration.savingsContribution) +
    cents(planningBuffer);
  return {
    incomeInWindow,
    futureBills: futureBillsCents / 100,
    reserved: reservedCents / 100,
    available: (cents(calibration.knownCash) - reservedCents) / 100,
  };
}

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
  calibration: PlanCalibrationData;
  authoritativeProjection: AuthoritativeProjection;
  commitments: PlanCommitment[];
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
  saveElectric: (v: number) => Promise<boolean>;
  savePlanningBuffer: (v: number) => Promise<boolean>;
  savePlanCalibration: (
    v: PlanCalibrationData,
    buffer: number,
  ) => Promise<boolean>;
  saveManualCash: (v: number) => Promise<boolean>;
  addManualActual: (
    merchant: string,
    amount: number,
    date: string,
  ) => Promise<boolean>;
  addManualCommitment: (
    name: string,
    amount: number,
    dueDate: string,
  ) => Promise<boolean>;
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
  const [calibration, setCalibration] =
    useState<PlanCalibrationData>(defaultCalibration);
  const [planCalibrated, setPlanCalibrated] = useState(true);
  const electricMax = calibration.electricMax;
  const [planningBuffer, setPlanningBuffer] = useState(0);
  const [householdMode, setHouseholdMode] = useState<HouseholdMode>("shared");
  const [notificationMode, setNotificationMode] =
    useState<NotificationMode>("exceptions");
  const [weeklyDigest, setWeeklyDigest] = useState(true);
  const [dataMode, setDataModeRaw] = useState<DataMode>("manual");
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  const [connections, setConnections] = useState<FinancialConnection[]>([]);
  const [cases, setCases] = useState<FinancialException[]>([]);
  const [commitments, setCommitments] = useState<PlanCommitment[]>([]);
  const [manualActuals, setManualActuals] = useState<ManualActual[]>([]);
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
    new Map<string, { id: string; version: number; dueDate: string | null }>(),
  );
  const commitmentVersionRef = useRef(new Map<string, number>());
  const mutationQueue = useRef<Promise<void>>(Promise.resolve());
  const confirmedBootstrapRef = useRef<BootstrapResponse | null>(null);
  const plaidPollGeneration = useRef(0);
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
    if (incomingRevision < revisionRef.current) return;
    confirmedBootstrapRef.current = bootstrap;
    setHouseholdId(bootstrap.household.id);
    setRevision(bootstrap.revision);
    setWorkspaceName(bootstrap.household.name);
    setBankConnectionsEnabled(bootstrap.capabilities.bankConnections.enabled);
    setOnboardingCompleted(bootstrap.household.onboardingCompleted);
    revisionRef.current = incomingRevision;
    commitmentRef.current = new Map(
      bootstrap.plan.commitments.map((item) => [
        item.name.toLocaleLowerCase(),
        { id: item.id, version: item.version, dueDate: item.dueDate },
      ]),
    );
    commitmentVersionRef.current = new Map(
      bootstrap.plan.commitments.map((item) => [item.id, item.version]),
    );
    const namedCommitments = new Map(
      bootstrap.plan.commitments.map((item) => [item.name.toLowerCase(), item]),
    );
    const named = new Map(
      bootstrap.plan.commitments.map((item) => [
        item.name.toLowerCase(),
        minorToMajor(item.amount.minor),
      ]),
    );
    const known = new Set([
      "rent",
      "electric",
      "subscriptions",
      "streambox",
      "insurance",
    ]);
    setCalibration((value) => ({
      ...value,
      knownCash: minorToMajor(bootstrap.plan.knownCash.minor),
      cashProvenance:
        bootstrap.plan.freshness.status === "manual"
          ? "user_entered"
          : "observed",
      includeChase: bootstrap.accounts.some(
        (account) =>
          account.provenance === "plaid",
      ),
      includeJoint: false,
      rentName: "Rent",
      rentAmount: named.get("rent") ?? 0,
      rentDueDate: namedCommitments.get("rent")?.dueDate ?? "",
      electricName: "Electric",
      electricMax: named.get("electric") ?? 0,
      electricDueDate: namedCommitments.get("electric")?.dueDate ?? "",
      streamBoxName: "Subscriptions",
      streamBoxAmount:
        named.get("subscriptions") ?? named.get("streambox") ?? 0,
      streamBoxDueDate:
        namedCommitments.get("subscriptions")?.dueDate ??
        namedCommitments.get("streambox")?.dueDate ??
        "",
      insuranceName: "Insurance",
      insuranceAmount: named.get("insurance") ?? 0,
      insuranceDueDate: namedCommitments.get("insurance")?.dueDate ?? "",
      customCommitments: bootstrap.plan.commitments
        .filter((item) => !known.has(item.name.toLowerCase()))
        .map((item) => ({
          id: item.id,
          name: item.name,
          amount: minorToMajor(item.amount.minor),
          dueDate: item.dueDate ?? "",
        })),
      savingsContribution: minorToMajor(bootstrap.plan.plannedSavings.minor),
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
    setAccounts(bootstrap.accounts);
    setConnections(bootstrap.connections);
    setCases(bootstrap.cases);
    setCommitments(bootstrap.plan.commitments);
    const manualAccount = bootstrap.accounts.find(
      (account) => account.provenance === "manual",
    );
    setApiAccountId(manualAccount?.id ?? null);
    const hasPlaid = bootstrap.accounts.some(
      (account) => account.provenance === "plaid" && account.includeInPlan,
    );
    setDataModeRaw(hasPlaid ? "connected" : "manual");
    setSourceStaleRaw(
      bootstrap.plan.freshness.status === "stale" ||
        bootstrap.plan.freshness.status === "incomplete",
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

  const loadCachedBootstrap = async (): Promise<boolean> => {
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
    if (!confirmedBootstrapRef.current) setBackendStatus("loading");
    try {
      applyBootstrap(await api.bootstrap(), "network");
    } catch (error) {
      if (!(await loadCachedBootstrap())) reportError(error);
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
        reportError(error);
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
    while (generation === plaidPollGeneration.current && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, delay));
      try {
        const bootstrap = await api.bootstrap();
        if (generation !== plaidPollGeneration.current) return;
        applyBootstrap(bootstrap, "network");
        const unsettled = bootstrap.connections.some((connection) =>
          ["pending", "syncing", "revocation_pending"].includes(connection.status),
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
      void reloadBackend();
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void reloadBackend();
    };
    window.addEventListener("budgefi:network", reconnect);
    window.addEventListener("budgefi:resume", reloadBackend);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      plaidPollGeneration.current += 1;
      window.removeEventListener("budgefi:network", reconnect);
      window.removeEventListener("budgefi:resume", reloadBackend);
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
  const savePlanCalibration = (value: PlanCalibrationData, buffer: number) => {
    const commitment = (
      name: string,
      amount: number,
      explicitId?: string,
      dueDate?: string,
    ) => {
      const existing = explicitId
        ? {
            id: explicitId,
            version: commitmentVersionRef.current.get(explicitId),
            dueDate:
              commitmentRef.current.get(name.toLocaleLowerCase())?.dueDate ??
              null,
          }
        : commitmentRef.current.get(name.toLocaleLowerCase());
      return {
        ...(existing?.id && existing.version
          ? { id: existing.id, expectedVersion: existing.version }
          : {}),
        name,
        amount: toApiMoney(amount),
        dueDate: dueDate || existing?.dueDate || null,
      };
    };
    const commitments = [
      ...(value.rentAmount > 0
        ? [
            commitment(
              value.rentName.trim(),
              value.rentAmount,
              commitmentRef.current.get("rent")?.id,
              value.rentDueDate,
            ),
          ]
        : []),
      ...(value.electricMax > 0
        ? [
            commitment(
              value.electricName.trim(),
              value.electricMax,
              commitmentRef.current.get("electric")?.id,
              value.electricDueDate,
            ),
          ]
        : []),
      ...(value.streamBoxAmount > 0
        ? [
            commitment(
              value.streamBoxName.trim(),
              value.streamBoxAmount,
              commitmentRef.current.get("subscriptions")?.id ??
                commitmentRef.current.get("streambox")?.id,
              value.streamBoxDueDate,
            ),
          ]
        : []),
      ...(value.insuranceAmount > 0
        ? [
            commitment(
              value.insuranceName.trim(),
              value.insuranceAmount,
              commitmentRef.current.get("insurance")?.id,
              value.insuranceDueDate,
            ),
          ]
        : []),
      ...value.customCommitments
        .filter((item) => item.amount > 0)
        .map((item) =>
          commitment(item.name, item.amount, item.id, item.dueDate),
        ),
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
        commitments,
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
    for (const account of accounts.filter(
      (item) => item.provenance !== "manual" && item.includeInPlan,
    )) {
      if (!(await setAccountInclusion(account, false))) return false;
    }
    setDataModeRaw("manual");
    setSourceStaleRaw(false);
    return true;
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
  const addManualActual = (merchant: string, amount: number, date: string) => {
    const id = requestId();
    if (!apiAccountId) {
      reportError(
        new Error("Create or load a manual account before recording a charge"),
      );
      return Promise.resolve(false);
    }
    return mutate(() =>
      api.addManualTransaction({
        accountId: apiAccountId,
        merchant: merchant.trim(),
        amount: toApiMoney(Math.max(0, amount)),
        occurredOn: date,
        requestId: id,
      }),
    );
  };
  const addManualCommitment = (
    name: string,
    amount: number,
    dueDate: string,
  ) => {
    const id = requestId();
    return mutate(() =>
      api.addCommitment({
        name: name.trim(),
        amount: toApiMoney(Math.max(0, amount)),
        dueDate: dueDate || null,
        requestId: id,
      }),
    );
  };
  const value = useMemo(
    () => ({
      householdId,
      revision,
      sourceStale,
      workspaceName,
      bankConnectionsEnabled,
      calibration,
      authoritativeProjection,
      commitments,
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
      saveElectric,
      savePlanningBuffer,
      savePlanCalibration,
      saveManualCash,
      addManualActual,
      addManualCommitment,
    }),
    [
      householdId,
      revision,
      sourceStale,
      workspaceName,
      bankConnectionsEnabled,
      calibration,
      authoritativeProjection,
      commitments,
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
