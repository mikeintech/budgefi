import {
  bootstrapResponseSchema,
  plaidLinkTokenResponseSchema,
  notificationPreferencesSchema,
  notificationEndpointResponseSchema,
  notificationTestResponseSchema,
  accountExportResponseSchema,
  nativeAuthTicketResponseSchema,
  accountDeletionResponseSchema,
  onboardingAnalysisResponseSchema,
  featureFlagsResponseSchema,
  transactionFeedResponseSchema,
  merchantCategoryRulesResponseSchema,
  payCycleDetailResponseSchema,
  payCycleListResponseSchema,
  type BootstrapResponse,
  type CommitmentRequest,
  type DebtCreateRequest,
  type DebtUpdateRequest,
  type IncomeScheduleCreateRequest,
  type IncomeScheduleUpdateRequest,
  type AccountInclusionRequest,
  type AccountPlanningRoleRequest,
  type ManualBalanceRequest,
  type ManualModeRequest,
  type ManualTransactionRequest,
  type ManualTransactionUpdate,
  type ManualTransactionVoid,
  type PlanUpdateRequest,
  type SavingsGoalBalanceUpdateRequest,
  type SavingsGoalCreateRequest,
  type SavingsGoalUpdateRequest,
  type PlanCalibrationRequest,
  type PlaidExchangeRequest,
  type PlaidHostedCompleteRequest,
  type PlaidLinkTokenRequest,
  type PlaidUpdateCompleteRequest,
  type NotificationPreferencesUpdate,
  type NotificationEndpointRequest,
  type NotificationTestRequest,
  type AccountDeletionRequest,
  type ExceptionDecisionRequest,
  type NativeAuthTicketRequest,
  type OnboardingAnalysisRequest,
  type OccurrenceSkipRequest,
  type TransactionFeedQuery,
  type TransactionCategoryUpdate,
  type MerchantCategoryRuleDelete,
  type MerchantCategoryRuleUpdate,
  type TransactionOccurrenceLinkRequest,
  type TransactionOccurrenceUnlinkRequest,
  type PayCycleQuery,
} from "@budgefi/contracts";
import { authorizationHeader } from "@/lib/auth";
import { apiBaseUrl } from "@/lib/platform";

const baseUrl = apiBaseUrl();

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const api = {
  createNativeAuthTicket: (body: NativeAuthTicketRequest) =>
    requestParsed(
      "/native-auth/ticket",
      json("POST", body),
      nativeAuthTicketResponseSchema,
    ),
  bootstrap: () => request("/bootstrap", { method: "GET" }),
  features: () =>
    requestParsed("/features", { method: "GET" }, featureFlagsResponseSchema),
  payCycles: (query: Partial<PayCycleQuery> = {}) => {
    const params = new URLSearchParams();
    params.set("limit", String(query.limit ?? 12));
    if (query.cursor) params.set("cursor", query.cursor);
    params.set("planningLimit", String(query.planningLimit ?? 12));
    if (query.planningCursor)
      params.set("planningCursor", query.planningCursor);
    return requestParsed(
      `/pay-cycles?${params.toString()}`,
      { method: "GET" },
      payCycleListResponseSchema,
    );
  },
  payCycle: (cycleId: string) =>
    requestParsed(
      `/pay-cycles/${cycleId}`,
      { method: "GET" },
      payCycleDetailResponseSchema,
    ),
  completeOnboarding: () => request("/onboarding/complete", json("POST", {})),
  createSavingsGoal: (body: SavingsGoalCreateRequest) =>
    request("/savings-goals", json("POST", body)),
  updateSavingsGoal: (goalId: string, body: SavingsGoalUpdateRequest) =>
    request(`/savings-goals/${goalId}`, json("PUT", body)),
  updateSavingsGoalBalance: (
    goalId: string,
    body: SavingsGoalBalanceUpdateRequest,
  ) => request(`/savings-goals/${goalId}/balance`, json("POST", body)),
  createDebt: (body: DebtCreateRequest) =>
    request("/debts", json("POST", body)),
  updateDebt: (debtId: string, body: DebtUpdateRequest) =>
    request(`/debts/${debtId}`, json("PUT", body)),
  createIncomeSchedule: (body: IncomeScheduleCreateRequest) =>
    request("/income-schedules", json("POST", body)),
  updateIncomeSchedule: (
    scheduleId: string,
    body: IncomeScheduleUpdateRequest,
  ) => request(`/income-schedules/${scheduleId}`, json("PUT", body)),
  setAccountPlanningRole: (
    accountId: string,
    body: AccountPlanningRoleRequest,
  ) => request(`/accounts/${accountId}/planning-role`, json("PUT", body)),
  transactions: (query: TransactionFeedQuery = { limit: 30 }) => {
    const parameters = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined && value !== "")
        parameters.set(key, String(value));
    return requestParsed(
      `/transactions${parameters.size ? `?${parameters}` : ""}`,
      { method: "GET" },
      transactionFeedResponseSchema,
    );
  },
  updateTransactionCategory: (
    transactionId: string,
    body: TransactionCategoryUpdate,
  ) =>
    requestParsed(
      `/transactions/${transactionId}/category`,
      json("PUT", body),
      transactionFeedResponseSchema,
    ),
  linkTransactionToOccurrence: (
    transactionId: string,
    body: TransactionOccurrenceLinkRequest,
  ) =>
    request(
      `/transactions/${transactionId}/link-occurrence`,
      json("POST", body),
    ),
  unlinkTransactionFromOccurrence: (
    transactionId: string,
    body: TransactionOccurrenceUnlinkRequest,
  ) =>
    request(
      `/transactions/${transactionId}/unlink-occurrence`,
      json("POST", body),
    ),
  updateManualTransaction: (
    transactionId: string,
    body: ManualTransactionUpdate,
  ) =>
    requestParsed(
      `/transactions/${transactionId}/manual`,
      json("PUT", body),
      transactionFeedResponseSchema,
    ),
  voidManualTransaction: (transactionId: string, body: ManualTransactionVoid) =>
    requestParsed(
      `/transactions/${transactionId}/void`,
      json("POST", body),
      transactionFeedResponseSchema,
    ),
  transactionCategoryRules: () =>
    requestParsed(
      "/transaction-category-rules",
      { method: "GET" },
      merchantCategoryRulesResponseSchema,
    ),
  updateTransactionCategoryRule: (
    ruleId: string,
    body: MerchantCategoryRuleUpdate,
  ) =>
    requestParsed(
      `/transaction-category-rules/${ruleId}`,
      json("PUT", body),
      merchantCategoryRulesResponseSchema,
    ),
  deleteTransactionCategoryRule: (
    ruleId: string,
    body: MerchantCategoryRuleDelete,
  ) =>
    requestParsed(
      `/transaction-category-rules/${ruleId}`,
      jsonDelete(body),
      merchantCategoryRulesResponseSchema,
    ),
  analyzeOnboarding: (body: OnboardingAnalysisRequest = { refresh: false }) =>
    requestParsed(
      "/insights/onboarding",
      json("POST", body),
      onboardingAnalysisResponseSchema,
    ),
  saveManualBalance: (body: ManualBalanceRequest) =>
    request("/manual/balances", json("POST", body)),
  activateManualMode: (body: ManualModeRequest) =>
    request("/manual/activate", json("POST", body)),
  addManualTransaction: (body: ManualTransactionRequest) =>
    request("/manual/transactions", json("POST", body)),
  addCommitment: (body: CommitmentRequest) =>
    request("/commitments", json("POST", body)),
  skipOccurrence: (occurrenceId: string, body: OccurrenceSkipRequest) =>
    request(`/occurrences/${occurrenceId}/skip`, json("POST", body)),
  updatePlan: (body: PlanUpdateRequest) => request("/plan", json("PUT", body)),
  setAccountInclusion: (accountId: string, body: AccountInclusionRequest) =>
    request(`/accounts/${accountId}/inclusion`, json("PUT", body)),
  calibratePlan: (body: PlanCalibrationRequest) =>
    request("/plan/calibration", json("PUT", body)),
  undoStarterApplication: (applicationId: string) =>
    request(
      `/plan/starter-applications/${applicationId}`,
      jsonDelete({ requestId: requestId() }),
    ),
  decideException: (caseId: string, body: ExceptionDecisionRequest) =>
    request(`/cases/${caseId}/decision`, json("POST", body)),
  createPlaidLinkToken: (body: PlaidLinkTokenRequest) =>
    requestParsed(
      "/plaid/link-token",
      json("POST", body),
      plaidLinkTokenResponseSchema,
    ),
  exchangePlaid: (body: PlaidExchangeRequest) =>
    request("/plaid/exchange", json("POST", body)),
  completeHostedPlaid: (body: PlaidHostedCompleteRequest) =>
    request("/plaid/hosted-complete", json("POST", body)),
  completePlaidUpdate: (body: PlaidUpdateCompleteRequest) =>
    request("/plaid/update-complete", json("POST", body)),
  syncPlaid: (connectionId: string) =>
    request(`/plaid/connections/${connectionId}/sync`, json("POST", {})),
  disconnectPlaid: (connectionId: string) =>
    request(`/plaid/connections/${connectionId}/disconnect`, json("POST", {})),
  notificationPreferences: () =>
    requestParsed(
      "/notifications/preferences",
      { method: "GET" },
      notificationPreferencesSchema,
    ),
  updateNotificationPreferences: (body: NotificationPreferencesUpdate) =>
    requestParsed(
      "/notifications/preferences",
      json("PUT", body),
      notificationPreferencesSchema,
    ),
  registerNotificationEndpoint: (body: NotificationEndpointRequest) =>
    requestParsed(
      "/notifications/endpoints",
      json("POST", body),
      notificationEndpointResponseSchema,
    ),
  disableNotificationEndpoint: (endpointId: string) =>
    requestParsed(
      `/notifications/endpoints/${endpointId}`,
      jsonDelete({ requestId: requestId() }),
      { parse: (value: unknown) => value as { disabled: boolean } },
    ),
  testNotification: (body: NotificationTestRequest) =>
    requestParsed(
      "/notifications/test",
      json("POST", body),
      notificationTestResponseSchema,
    ),
  exportAccount: () =>
    requestParsed(
      "/account/export",
      { method: "GET" },
      accountExportResponseSchema,
    ),
  requestAccountDeletion: (body: AccountDeletionRequest) =>
    requestParsed(
      "/account/deletion",
      json("POST", body),
      accountDeletionResponseSchema,
    ),
  accountDeletionStatus: () =>
    requestParsed(
      "/account/deletion",
      { method: "GET" },
      {
        parse: (value: unknown) =>
          value === null ? null : accountDeletionResponseSchema.parse(value),
      },
    ),
};

async function request(
  path: string,
  init: RequestInit,
): Promise<BootstrapResponse> {
  return requestParsed(path, init, bootstrapResponseSchema);
}

async function requestParsed<T>(
  path: string,
  init: RequestInit,
  schema: { parse(value: unknown): T },
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    const send = async (forceRefresh = false) =>
      fetch(`${baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(await authorizationHeader({ forceRefresh })),
          ...(init.headers ?? {}),
        },
      });
    response = await send();
    // Mobile browsers can preserve an expired token while the app is asleep.
    // Give Clerk one explicit refresh before treating the session as invalid.
    if (response.status === 401) response = await send(true);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw new ApiError(
        0,
        "request_timeout",
        "Budgefi didn’t receive a response in time. Check your connection and try again.",
      );
    throw new ApiError(
      0,
      "service_unreachable",
      "Budgefi couldn’t reach the secure service. Your last action was not confirmed.",
    );
  } finally {
    window.clearTimeout(timeout);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error =
      payload && typeof payload === "object" && "error" in payload
        ? (payload as { error?: { code?: string; message?: string } }).error
        : undefined;
    throw new ApiError(
      response.status,
      error?.code ?? "request_failed",
      error?.message ?? "The Budgefi service could not complete the request",
    );
  }
  try {
    return schema.parse(payload);
  } catch {
    throw new ApiError(
      502,
      "invalid_response",
      "Budgefi received an unexpected service response and stopped before using it.",
    );
  }
}

function json(method: "POST" | "PUT", body: unknown): RequestInit {
  return {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Request-Id": requestId(),
    },
    body: JSON.stringify(body),
  };
}
function jsonDelete(body: unknown): RequestInit {
  return {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      "X-Request-Id": requestId(),
    },
    body: JSON.stringify(body),
  };
}

export function requestId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `00000000-0000-4000-8000-${Date.now().toString().padStart(12, "0").slice(-12)}`
  );
}
