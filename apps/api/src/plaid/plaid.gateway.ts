import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { Configuration, CountryCode, PlaidApi, PlaidEnvironments, Products, type AccountBase, type Transaction } from "plaid";
import { PlaidConfig } from "./plaid.config.js";

export type PlaidSyncPage = Readonly<{
  added: Transaction[];
  modified: Transaction[];
  removed: { transaction_id: string; account_id: string }[];
  nextCursor: string;
  hasMore: boolean;
  updateStatus: string;
  requestId: string;
}>;

export class PlaidRequestError extends Error {
  constructor(readonly code: string, readonly requestId: string | null, readonly retryable: boolean, message = "Plaid request failed") {
    super(message);
    this.name = "PlaidRequestError";
  }
}

@Injectable()
export class PlaidGateway {
  private readonly client: PlaidApi;

  constructor(@Inject(PlaidConfig) private readonly config: PlaidConfig) {
    this.client = new PlaidApi(new Configuration({
      basePath: environmentBasePath(this.config.environment),
      baseOptions: { headers: { "PLAID-CLIENT-ID": this.config.clientId, "PLAID-SECRET": this.config.secret } },
    }));
  }

  assertEnabled(): void {
    if (!this.config.enabled) throw new ServiceUnavailableException("Real Plaid is not configured on this Budgefi environment");
  }

  async createLinkToken(input: { clientUserId: string; mode: "create" | "update"; accessToken?: string; nativeCompletionUri?: string }): Promise<{ linkToken: string; expiration: string; requestId: string; hostedLinkUrl?: string }> {
    this.assertEnabled();
    try {
      if (input.mode === "update" && !input.accessToken) throw new Error("Update mode requires an access token");
      const response = await this.client.linkTokenCreate({
        user: { client_user_id: input.clientUserId },
        client_name: "Budgefi",
        language: "en",
        country_codes: [CountryCode.Us],
        ...(input.mode === "create"
          ? {
              products: [Products.Transactions],
              transactions: { days_requested: 180 },
            }
          : { access_token: input.accessToken! }),
        ...(this.config.webhookUrl ? { webhook: this.config.webhookUrl } : {}),
        ...(this.config.redirectUri ? { redirect_uri: this.config.redirectUri } : {}),
        ...(input.nativeCompletionUri ? { hosted_link: { is_mobile_app: true, completion_redirect_uri: input.nativeCompletionUri, url_lifetime_seconds: 30 * 60 }, enable_multi_item_link: false } : {}),
      });
      return { linkToken: response.data.link_token, expiration: response.data.expiration, requestId: response.data.request_id, ...(response.data.hosted_link_url ? { hostedLinkUrl: response.data.hosted_link_url } : {}) };
    } catch (error) { throw normalizePlaidError(error); }
  }

  async getHostedCompletion(linkToken: string): Promise<{
    state: "pending" | "success" | "exit";
    linkSessionId?: string;
    publicToken?: string;
    institution?: { id: string; name: string };
  }> {
    this.assertEnabled();
    try {
      const response = await this.client.linkTokenGet({ link_token: linkToken });
      const sessions = [...(response.data.link_sessions ?? [])].sort((left, right) =>
        String(right.finished_at ?? right.started_at ?? "").localeCompare(String(left.finished_at ?? left.started_at ?? "")),
      );
      const session = sessions[0];
      if (!session || !session.finished_at) return { state: "pending" };
      const itemAdds = session.results?.item_add_results ?? [];
      if (itemAdds.length > 1) throw new PlaidRequestError("MULTI_ITEM_NOT_SUPPORTED", response.data.request_id, false, "This Budgefi flow accepts one institution at a time");
      const result = itemAdds[0];
      const legacy = session.on_success;
      const publicToken = result?.public_token ?? legacy?.public_token;
      const institution = result?.institution ?? legacy?.metadata?.institution;
      if (publicToken) return {
        state: "success",
        linkSessionId: session.link_session_id,
        publicToken,
        ...(institution?.institution_id && institution.name ? { institution: { id: institution.institution_id, name: institution.name } } : {}),
      };
      if (session.exit) return { state: "exit", linkSessionId: session.link_session_id };
      return { state: "success", linkSessionId: session.link_session_id };
    } catch (error) { throw error instanceof PlaidRequestError ? error : normalizePlaidError(error); }
  }

  async exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string; requestId: string }> {
    this.assertEnabled();
    try {
      const response = await this.client.itemPublicTokenExchange({ public_token: publicToken });
      return { accessToken: response.data.access_token, itemId: response.data.item_id, requestId: response.data.request_id };
    } catch (error) { throw normalizePlaidError(error); }
  }

  async getAccounts(accessToken: string): Promise<{ accounts: AccountBase[]; institutionId: string | null; requestId: string }> {
    this.assertEnabled();
    try {
      const response = await this.client.accountsGet({ access_token: accessToken });
      return { accounts: response.data.accounts, institutionId: response.data.item.institution_id ?? null, requestId: response.data.request_id };
    } catch (error) { throw normalizePlaidError(error); }
  }

  async getInstitutionName(institutionId: string): Promise<string | null> {
    this.assertEnabled();
    try {
      const response = await this.client.institutionsGetById({ institution_id: institutionId, country_codes: [CountryCode.Us] });
      return response.data.institution.name;
    } catch { return null; }
  }

  async syncTransactions(accessToken: string, cursor: string | null): Promise<PlaidSyncPage> {
    this.assertEnabled();
    try {
      const response = await this.client.transactionsSync({ access_token: accessToken, ...(cursor ? { cursor } : {}), count: 500 });
      return { added: response.data.added, modified: response.data.modified, removed: response.data.removed, nextCursor: response.data.next_cursor, hasMore: response.data.has_more, updateStatus: response.data.transactions_update_status, requestId: response.data.request_id };
    } catch (error) { throw normalizePlaidError(error); }
  }

  async removeItem(accessToken: string): Promise<{ requestId: string }> {
    this.assertEnabled();
    try {
      const response = await this.client.itemRemove({ access_token: accessToken });
      return { requestId: response.data.request_id };
    } catch (error) { throw normalizePlaidError(error); }
  }

  async getWebhookVerificationKey(keyId: string): Promise<Record<string, unknown>> {
    this.assertEnabled();
    try {
      const response = await this.client.webhookVerificationKeyGet({ key_id: keyId });
      return response.data.key as unknown as Record<string, unknown>;
    } catch (error) { throw normalizePlaidError(error); }
  }
}

export function normalizePlaidError(error: unknown): PlaidRequestError {
  const payload = isRecord(error) && isRecord(error.response) && isRecord(error.response.data) ? error.response.data : null;
  const code = typeof payload?.error_code === "string" ? payload.error_code : "PLAID_REQUEST_FAILED";
  const requestId = typeof payload?.request_id === "string" ? payload.request_id : null;
  const message = typeof payload?.error_message === "string" ? payload.error_message : "Plaid request failed";
  return new PlaidRequestError(code, requestId, isRetryable(code), message);
}

function isRetryable(code: string): boolean {
  return code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" || code === "INTERNAL_SERVER_ERROR" || code === "INSTITUTION_DOWN" || code === "INSTITUTION_NOT_RESPONDING" || code === "RATE_LIMIT_EXCEEDED" || code === "PRODUCT_NOT_READY";
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }

function environmentBasePath(environment: "sandbox" | "development" | "production"): string {
  const value = PlaidEnvironments[environment];
  if (!value) throw new Error(`Plaid environment ${environment} is unavailable in the installed SDK`);
  return value;
}
