import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash, timingSafeEqual } from "node:crypto";
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import {
  sql,
  type Kysely,
  type Transaction as DatabaseTransaction,
} from "kysely";
import type { AccountBase, Transaction as PlaidTransaction } from "plaid";
import { v7 as uuidv7 } from "uuid";
import { ZodError } from "zod";
import {
  plaidLinkTokenResponseSchema,
  type BootstrapResponse,
  type PlaidExchangeRequest,
  type PlaidHostedCompleteRequest,
  type PlaidLinkTokenRequest,
  type PlaidLinkTokenResponse,
  type PlaidUpdateCompleteRequest,
} from "../../../../packages/contracts/src/index.js";
import type { Database } from "../../../../packages/database/src/index.js";
import {
  activatePendingSavingsTrackingForConnection,
  addActivity,
  buildBootstrap,
  bumpRevision,
  detachSavingsGoalsForConnection,
  detachIncomeSchedulesForConnection,
  detachIncomeSchedulesForAccounts,
  pauseDebtTrackingForConnection,
  pauseDebtTrackingForAccounts,
  persistSnapshot,
  reconcilePlanEvidence,
  requireEditor,
} from "../core/core.service.js";
import { DATABASE } from "../database/database.token.js";
import {
  TenantDatabase,
  type Principal,
  type RequestIdentity,
} from "../database/tenant-database.js";
import { PlaidConfig, type PlaidEnvironment } from "./plaid.config.js";
import {
  PlaidGateway,
  PlaidRequestError,
  type PlaidSyncPage,
} from "./plaid.gateway.js";
import { PlaidTokenCrypto } from "./token-crypto.js";

type ConnectionSecret = Readonly<{
  id: string;
  householdId: string;
  itemId: string;
  environment: PlaidEnvironment;
  encrypted: Uint8Array;
  keyId: string;
  cursor: string | null;
}>;
type ClaimedJob = Readonly<{
  jobId: string;
  householdId: string;
  connectionId: string;
  operation: "sync" | "revoke";
  trigger: "initial" | "webhook" | "manual" | "recovery" | "scheduled";
  attempts: number;
}>;
type VerifiedWebhook = Readonly<{
  payload: Record<string, unknown>;
  payloadHash: string;
  keyId: string;
  issuedAt: Date;
}>;

@Injectable()
export class PlaidService implements OnModuleInit, OnModuleDestroy {
  private workerTimer: ReturnType<typeof setInterval> | null = null;
  private workerActive = false;
  private nextMaintenanceAt = 0;
  private readonly webhookKeys = new Map<
    string,
    {
      key: Awaited<ReturnType<typeof importJWK>>;
      cachedAt: number;
      expiresAt: number;
    }
  >();

  constructor(
    @Inject(PlaidConfig) private readonly config: PlaidConfig,
    @Inject(PlaidGateway) private readonly gateway: PlaidGateway,
    @Inject(PlaidTokenCrypto) private readonly crypto: PlaidTokenCrypto,
    @Inject(TenantDatabase) private readonly tenantDatabase: TenantDatabase,
    @Inject(DATABASE) private readonly database: Kysely<Database>,
  ) {}

  onModuleInit(): void {
    // Production provider work belongs exclusively to the finite worker job.
    // The request-serving process must never become a second queue consumer.
    if (
      process.env.NODE_ENV === "production" ||
      !this.config.enabled ||
      process.env.PLAID_WORKER_DISABLED === "true"
    )
      return;
    this.workerTimer = setInterval(() => {
      void this.drainOne();
    }, 2_000);
    this.workerTimer.unref();
    void this.drainOne();
  }

  onModuleDestroy(): void {
    if (this.workerTimer) clearInterval(this.workerTimer);
  }

  async createLinkToken(
    identity: RequestIdentity,
    request: PlaidLinkTokenRequest,
  ): Promise<PlaidLinkTokenResponse> {
    const context = await this.tenantDatabase.run(
      identity,
      async (transaction, principal) => {
        requireEditor(principal);
        await requireActiveHousehold(transaction, principal.householdId);
        if (request.mode === "create")
          return { principal, accessToken: undefined };
        const connection = await transaction
          .selectFrom("connections")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .where("id", "=", request.connectionId!)
          .where("provider", "=", "plaid")
          .where("status", "not in", ["revoked", "revocation_pending"])
          .executeTakeFirst();
        if (
          !connection?.encrypted_access_token ||
          !connection.token_key_id ||
          !connection.environment
        )
          throw new NotFoundException(
            "Plaid connection is not available for update mode",
          );
        const environment = parsePlaidEnvironment(connection.environment);
        return {
          principal,
          accessToken: this.crypto.decrypt(
            connection.encrypted_access_token,
            connection.token_key_id,
            {
              environment,
              itemId: connection.provider_item_id,
              connectionId: connection.id,
            },
          ),
        };
      },
    );
    if (
      request.nativeHosted &&
      !this.config.redirectUri?.startsWith("https://")
    )
      throw new ServiceUnavailableException(
        "Mobile bank connections require an HTTPS PLAID_REDIRECT_URI registered with Plaid",
      );
    const sessionId = uuidv7();
    const completionUri = new URL(this.config.nativeCompletionUri);
    completionUri.searchParams.set("session_id", sessionId);
    const created = await this.gateway.createLinkToken({
      clientUserId: context.principal.userId,
      mode: request.mode,
      ...(context.accessToken ? { accessToken: context.accessToken } : {}),
      ...(request.nativeHosted
        ? { nativeCompletionUri: completionUri.toString() }
        : {}),
    });
    if (request.nativeHosted && !created.hostedLinkUrl)
      throw new ServiceUnavailableException(
        "Plaid did not return a Hosted Link URL",
      );
    const expiration = new Date(created.expiration);
    if (!Number.isFinite(expiration.getTime()))
      throw new Error("Plaid returned an invalid Link expiration");
    await this.tenantDatabase.run(identity, async (transaction, principal) => {
      requireEditor(principal);
      await requireActiveHousehold(transaction, principal.householdId);
      if (
        principal.userId !== context.principal.userId ||
        principal.householdId !== context.principal.householdId
      )
        throw new ForbiddenException("Link session principal changed");
      await transaction
        .insertInto("plaid_link_sessions")
        .values({
          id: sessionId,
          household_id: principal.householdId,
          user_id: principal.userId,
          mode: request.mode,
          connection_id: request.connectionId ?? null,
          environment: this.config.environment,
          status: "created",
          link_token_hash: sha256(created.linkToken),
          public_token_hash: null,
          encrypted_public_token: null,
          public_token_key_id: null,
          link_session_id: null,
          provider_item_id: null,
          error_code: null,
          expires_at: expiration,
          exchange_started_at: null,
          completed_at: null,
        })
        .execute();
    });
    return plaidLinkTokenResponseSchema.parse({
      sessionId,
      linkToken: created.linkToken,
      expiration: expiration.toISOString(),
      environment: this.config.environment,
      mode: request.mode,
      ...(created.hostedLinkUrl
        ? { hostedLinkUrl: created.hostedLinkUrl }
        : {}),
    });
  }

  async completeHosted(
    identity: RequestIdentity,
    request: PlaidHostedCompleteRequest,
  ): Promise<BootstrapResponse> {
    const mode = await this.tenantDatabase.run(
      identity,
      async (transaction, principal) => {
        requireEditor(principal);
        await requireActiveHousehold(transaction, principal.householdId);
        const session = await transaction
          .selectFrom("plaid_link_sessions")
          .select(["mode", "status", "expires_at", "link_token_hash"])
          .where("household_id", "=", principal.householdId)
          .where("user_id", "=", principal.userId)
          .where("id", "=", request.sessionId)
          .executeTakeFirst();
        if (!session)
          throw new NotFoundException("Hosted Link session was not found");
        if (
          !session.link_token_hash ||
          !safeHashEqual(session.link_token_hash, sha256(request.linkToken))
        )
          throw new ForbiddenException(
            "Hosted Link token does not match this session",
          );
        if (session.expires_at.getTime() <= Date.now())
          throw new ConflictException(
            "Hosted Link session expired; start a new connection",
          );
        if (session.status === "failed" || session.status === "expired")
          throw new ConflictException(
            "Hosted Link session can no longer be completed",
          );
        return session.mode === "update"
          ? ("update" as const)
          : ("create" as const);
      },
    );
    const completion = await this.gateway.getHostedCompletion(
      request.linkToken,
    );
    if (completion.state === "pending")
      throw new ConflictException(
        "Plaid is still finalizing the bank connection; try again in a moment",
      );
    if (completion.state === "exit")
      throw new BadRequestException(
        "The bank connection was closed before it finished",
      );
    if (mode === "update")
      return this.completeUpdate(identity, {
        sessionId: request.sessionId,
        ...(completion.linkSessionId
          ? { linkSessionId: completion.linkSessionId }
          : {}),
        requestId: request.requestId,
      });
    if (!completion.publicToken)
      throw new ServiceUnavailableException(
        "Plaid finished without returning an account token",
      );
    return this.exchange(identity, {
      sessionId: request.sessionId,
      publicToken: completion.publicToken,
      ...(completion.linkSessionId
        ? { linkSessionId: completion.linkSessionId }
        : {}),
      ...(completion.institution
        ? { institution: completion.institution }
        : {}),
      requestId: request.requestId,
    });
  }

  async exchange(
    identity: RequestIdentity,
    request: PlaidExchangeRequest,
  ): Promise<BootstrapResponse> {
    const publicTokenHash = sha256(request.publicToken);
    const preflight = await this.tenantDatabase.run(
      identity,
      async (transaction, principal) => {
        requireEditor(principal);
        await requireActiveHousehold(transaction, principal.householdId);
        const session = await transaction
          .selectFrom("plaid_link_sessions")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .where("user_id", "=", principal.userId)
          .where("id", "=", request.sessionId)
          .forUpdate()
          .executeTakeFirst();
        if (!session || session.mode !== "create")
          throw new NotFoundException("Link session was not found");
        if (session.status === "completed") {
          if (session.public_token_hash !== publicTokenHash)
            throw new ConflictException(
              "Completed Link session does not match this public token",
            );
          await requireCompletedSessionPersisted(
            transaction,
            principal.householdId,
            session,
          );
          return { completed: true as const };
        }
        if (session.expires_at.getTime() <= Date.now()) {
          await transaction
            .updateTable("plaid_link_sessions")
            .set({ status: "expired", error_code: "LINK_SESSION_EXPIRED" })
            .where("id", "=", session.id)
            .execute();
          throw new ConflictException(
            "Link session expired; start a new connection",
          );
        }
        if (session.status === "exchanging") {
          if (session.public_token_hash !== publicTokenHash)
            throw new ConflictException(
              "Link exchange is already in progress for a different public token",
            );
          if (
            session.exchange_started_at &&
            session.exchange_started_at.getTime() > Date.now() - 2 * 60_000
          )
            throw new ConflictException(
              "Link exchange is already in progress; retry after the recovery window if it does not complete",
            );
        } else if (session.status !== "created")
          throw new ConflictException(
            "Link exchange failed; start a new connection",
          );
        const envelope = this.crypto.encryptPublicToken(request.publicToken, {
          environment: parsePlaidEnvironment(session.environment),
          sessionId: session.id,
        });
        await transaction
          .updateTable("plaid_link_sessions")
          .set({
            status: "exchanging",
            public_token_hash: publicTokenHash,
            encrypted_public_token: envelope.encrypted,
            public_token_key_id: envelope.keyId,
            link_session_id: request.linkSessionId ?? null,
            exchange_started_at: new Date(),
          })
          .where("id", "=", session.id)
          .where("status", "=", session.status)
          .executeTakeFirstOrThrow();
        return {
          completed: false as const,
          householdId: principal.householdId,
        };
      },
    );
    if (preflight.completed) return this.getBootstrap(identity);

    let exchanged: Awaited<
      ReturnType<PlaidGateway["exchangePublicToken"]>
    > | null = null;
    let persisted = false;
    try {
      exchanged = await this.gateway.exchangePublicToken(request.publicToken);
      const institutionId = request.institution?.id ?? null;
      const institutionName = request.institution?.name ?? null;
      const connectionId = uuidv7();
      const token = this.crypto.encrypt(exchanged.accessToken, {
        environment: this.config.environment,
        itemId: exchanged.itemId,
        connectionId,
      });
      const jobId = uuidv7();
      await this.tenantDatabase.run(
        identity,
        async (transaction, principal) => {
          requireEditor(principal);
          await requireActiveHousehold(transaction, principal.householdId);
          const session = await transaction
            .selectFrom("plaid_link_sessions")
            .selectAll()
            .where("household_id", "=", principal.householdId)
            .where("user_id", "=", principal.userId)
            .where("id", "=", request.sessionId)
            .where("status", "=", "exchanging")
            .where("public_token_hash", "=", publicTokenHash)
            .forUpdate()
            .executeTakeFirst();
          if (!session)
            throw new ConflictException(
              "Link exchange state changed before it could be committed",
            );
          await transaction
            .insertInto("connections")
            .values({
              id: connectionId,
              household_id: principal.householdId,
              provider: "plaid",
              provider_item_id: exchanged!.itemId,
              encrypted_access_token: token.encrypted,
              token_key_id: token.keyId,
              environment: this.config.environment,
              institution_id: institutionId,
              institution_name: institutionName,
              status: "syncing",
              sync_cursor: null,
              last_successful_sync_at: null,
              error_code: null,
              consent_expires_at: null,
              initial_update_complete: false,
              historical_update_complete: false,
              revoked_at: null,
              updated_at: new Date(),
            })
            .execute();
          await transaction
            .insertInto("plaid_sync_jobs")
            .values({
              id: jobId,
              household_id: principal.householdId,
              connection_id: connectionId,
              webhook_receipt_id: null,
              operation: "sync",
              trigger: "initial",
              state: "queued",
              available_at: sql<Date>`now()`,
              locked_at: null,
              completed_at: null,
              last_error_code: null,
            })
            .execute();
          await transaction
            .updateTable("plaid_link_sessions")
            .set({
              status: "completed",
              connection_id: connectionId,
              provider_item_id: exchanged!.itemId,
              completed_at: new Date(),
              exchange_started_at: null,
              encrypted_public_token: null,
              public_token_key_id: null,
              error_code: null,
            })
            .where("id", "=", session.id)
            .execute();
          await addActivity(
            transaction,
            principal,
            "connection.plaid.stored",
            `${institutionName ?? "Plaid institution"} connected`,
            "Read-only Item stored with encrypted credentials; initial synchronization queued",
            "plaid",
            "connection",
            connectionId,
          );
          await bumpRevision(transaction, principal);
        },
      );
      persisted = true;
      // Link success and transaction readiness are separate provider states.
      // The durable worker owns provider synchronization so an interrupted
      // HTTP request cannot strand or misreport a successfully stored Item.
      return this.getBootstrap(identity);
    } catch (error) {
      if (exchanged && !persisted) {
        try {
          await this.gateway.removeItem(exchanged.accessToken);
        } catch {
          /* best-effort exchange compensation; session remains failed */
        }
      }
      if (!persisted)
        await this.markSessionFailed(
          identity,
          request.sessionId,
          errorCode(error),
        );
      throw error;
    }
  }

  async completeUpdate(
    identity: RequestIdentity,
    request: PlaidUpdateCompleteRequest,
  ): Promise<BootstrapResponse> {
    const jobId = await this.tenantDatabase.run(
      identity,
      async (transaction, principal) => {
        requireEditor(principal);
        await requireActiveHousehold(transaction, principal.householdId);
        const session = await transaction
          .selectFrom("plaid_link_sessions")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .where("user_id", "=", principal.userId)
          .where("id", "=", request.sessionId)
          .where("mode", "=", "update")
          .forUpdate()
          .executeTakeFirst();
        if (!session?.connection_id)
          throw new NotFoundException("Update-mode Link session was not found");
        if (session.expires_at.getTime() <= Date.now())
          throw new ConflictException("Update-mode Link session expired");
        if (session.status === "completed") {
          await requireCompletedSessionPersisted(
            transaction,
            principal.householdId,
            session,
          );
          return null;
        }
        if (session.status !== "created")
          throw new ConflictException(
            "Update-mode Link session cannot be completed",
          );
        await transaction
          .updateTable("plaid_link_sessions")
          .set({
            status: "completed",
            link_session_id: request.linkSessionId ?? null,
            completed_at: new Date(),
            error_code: null,
          })
          .where("id", "=", session.id)
          .execute();
        await transaction
          .updateTable("connections")
          .set({ status: "syncing", error_code: null, updated_at: new Date() })
          .where("household_id", "=", principal.householdId)
          .where("id", "=", session.connection_id)
          .execute();
        const jobId = await enqueueSyncJob(
          transaction,
          principal.householdId,
          session.connection_id,
          "manual",
          null,
          "sync",
        );
        return { jobId, householdId: principal.householdId };
      },
    );
    return this.getBootstrap(identity);
  }

  async requestSync(
    identity: RequestIdentity,
    connectionId: string,
  ): Promise<BootstrapResponse> {
    const jobId = await this.tenantDatabase.run(
      identity,
      async (transaction, principal) => {
        requireEditor(principal);
        await requireActiveHousehold(transaction, principal.householdId);
        const connection = await transaction
          .selectFrom("connections")
          .select(["id", "status"])
          .where("household_id", "=", principal.householdId)
          .where("id", "=", connectionId)
          .where("provider", "=", "plaid")
          .executeTakeFirst();
        if (
          !connection ||
          connection.status === "revoked" ||
          connection.status === "revocation_pending"
        )
          throw new NotFoundException("Active Plaid connection not found");
        await transaction
          .updateTable("connections")
          .set({ status: "syncing", updated_at: new Date() })
          .where("id", "=", connection.id)
          .execute();
        const jobId = await enqueueSyncJob(
          transaction,
          principal.householdId,
          connection.id,
          "manual",
          null,
          "sync",
        );
        // An explicit user retry should not inherit an earlier backoff window.
        // Keep the durable queued job, but make it claimable immediately.
        await transaction
          .updateTable("plaid_sync_jobs")
          .set({ available_at: sql<Date>`now()` })
          .where("household_id", "=", principal.householdId)
          .where("id", "=", jobId)
          .where("state", "=", "queued")
          .execute();
        return { jobId, householdId: principal.householdId };
      },
    );
    return this.getBootstrap(identity);
  }

  async disconnect(
    identity: RequestIdentity,
    connectionId: string,
  ): Promise<BootstrapResponse> {
    await this.tenantDatabase.run(identity, async (transaction, principal) => {
      requireEditor(principal);
      const connection = await transaction
        .selectFrom("connections")
        .selectAll()
        .where("household_id", "=", principal.householdId)
        .where("id", "=", connectionId)
        .where("provider", "=", "plaid")
        .where("status", "!=", "revoked")
        .forUpdate()
        .executeTakeFirst();
      if (
        !connection?.encrypted_access_token ||
        !connection.token_key_id ||
        !connection.environment
      )
        throw new NotFoundException("Active Plaid connection not found");
      await detachSavingsGoalsForConnection(
        transaction,
        principal,
        connection.id,
      );
      await detachIncomeSchedulesForConnection(transaction, principal, connection.id);
      await pauseDebtTrackingForConnection(transaction, principal, connection.id);
      await transaction
        .updateTable("connections")
        .set({
          status: "revocation_pending",
          error_code: null,
          updated_at: new Date(),
        })
        .where("id", "=", connection.id)
        .execute();
      await transaction
        .updateTable("accounts")
        .set((eb) => ({
          include_in_plan: false,
          version: eb("version", "+", 1),
        }))
        .where("household_id", "=", principal.householdId)
        .where("connection_id", "=", connection.id)
        .where("archived_at", "is", null)
        .execute();
      await persistSnapshot(transaction, principal, { externalEligible: true });
      await bumpRevision(transaction, principal);
      await enqueueSyncJob(
        transaction,
        principal.householdId,
        connection.id,
        "manual",
        null,
        "revoke",
      );
    });
    return this.getBootstrap(identity);
  }

  async receiveWebhook(
    rawBody: Buffer,
    verificationHeader: string | undefined,
  ): Promise<{ accepted: true; duplicate: boolean }> {
    const verified = await this.verifyWebhook(rawBody, verificationHeader);
    const payload = verified.payload;
    const itemId = stringField(payload, "item_id");
    const environment = stringField(payload, "environment");
    const eventType = stringField(payload, "webhook_type") ?? "UNKNOWN";
    const eventCode = stringField(payload, "webhook_code");
    if (!itemId || !environment)
      throw new BadRequestException(
        "Plaid webhook is missing item_id or environment",
      );
    const plaidError = isRecord(payload.error)
      ? stringField(payload.error, "error_code")
      : null;
    const result = await this.database
      .transaction()
      .execute(async (transaction) => {
        await sql`set local role budgefi_app`.execute(transaction);
        return sql<{
          known: boolean;
          duplicate: boolean;
        }>`select * from ingest_verified_plaid_webhook(
        ${itemId},${environment},${eventType},${eventCode},${verified.payloadHash},
        ${verified.keyId},${verified.issuedAt},${plaidError}
      )`.execute(transaction);
      });
    return { accepted: true, duplicate: result.rows[0]?.duplicate ?? false };
  }

  async processJob(jobId?: string, householdId?: string): Promise<boolean> {
    const claimed = await this.claimJob(jobId, householdId);
    if (!claimed) return false;
    return this.executeClaimedJob(claimed);
  }

  private async executeClaimedJob(claimed: ClaimedJob): Promise<boolean> {
    let syncRunId: string | null = null;
    try {
      if (claimed.operation === "revoke") {
        await this.processRevocation(claimed);
      } else {
        syncRunId = await this.processSync(claimed);
      }
      await this.finishJob(claimed, "succeeded", null);
      return true;
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "plaid_sync_job_failed",
          jobId: claimed.jobId,
          connectionId: claimed.connectionId,
          operation: claimed.operation,
          trigger: claimed.trigger,
          attempt: claimed.attempts,
          errorCode: errorCode(error),
          providerRequestId:
            error instanceof PlaidRequestError ? error.requestId : null,
          retryable:
            error instanceof PlaidRequestError
              ? error.retryable
              : error instanceof ConflictException,
          validationIssues:
            error instanceof ZodError
              ? error.issues.slice(0, 12).map((issue) => ({
                  code: issue.code,
                  path: issue.path.map(String).join("."),
                }))
              : null,
          stackFrames:
            error instanceof Error
              ? (error.stack
                  ?.split("\n")
                  .slice(1, 7)
                  .map((frame) => frame.trim()) ?? null)
              : null,
        }),
      );
      await this.failSyncRun(claimed, syncRunId, errorCode(error));
      await this.retryOrDeadLetter(claimed, error);
      return false;
    }
  }

  async processNextJob(): Promise<"empty" | "handled"> {
    const claimed = await this.claimJob();
    if (!claimed) return "empty";
    await this.executeClaimedJob(claimed);
    return "handled";
  }

  async scheduleMaintenance(): Promise<number> {
    return this.database.transaction().execute(async (transaction) => {
      await sql`set local role budgefi_plaid_worker`.execute(transaction);
      const result = await sql<{
        count: number;
      }>`select schedule_plaid_maintenance() as count`.execute(transaction);
      return Number(result.rows[0]?.count ?? 0);
    });
  }

  private async processSync(job: ClaimedJob): Promise<string> {
    const secret = await this.loadConnectionSecret(
      job.householdId,
      job.connectionId,
    );
    const accessToken = this.crypto.decrypt(secret.encrypted, secret.keyId, {
      environment: secret.environment,
      itemId: secret.itemId,
      connectionId: secret.id,
    });
    const syncRunId = uuidv7();
    await this.tenantDatabase.runSystemHousehold(
      job.householdId,
      async (transaction) => {
        await transaction
          .insertInto("sync_runs")
          .values({
            id: syncRunId,
            household_id: job.householdId,
            connection_id: job.connectionId,
            trigger: job.trigger,
            status: "running",
            cursor_before: secret.cursor,
            cursor_after: null,
            started_at: new Date(),
            completed_at: null,
            error_code: null,
          })
          .execute();
      },
    );
    let pages: PlaidSyncPage[];
    try {
      pages = await this.fetchAllPages(accessToken, secret.cursor);
    } catch (error) {
      // Accounts and balances are available independently from the Transactions
      // product. Preserve that verified observation even when transaction
      // history is still warming up or temporarily unavailable.
      const accounts = await this.gateway.getAccounts(accessToken);
      const liabilities = await this.gateway.getLiabilities(accessToken).catch(() => null);
      const resolvedInstitutionName = accounts.institutionId
        ? await this.gateway.getInstitutionName(accounts.institutionId)
        : null;
      const duplicateRetired = await this.persistAccountsWhileTransactionsWait(
        job,
        syncRunId,
        secret.cursor,
        accounts,
        liabilities,
        resolvedInstitutionName,
      );
      if (duplicateRetired) return syncRunId;
      throw error;
    }
    // Fetch balances after transaction pages. A match may release a reserve only
    // when this later provider observation is stored as reflection evidence.
    const accounts = await this.gateway.getAccounts(accessToken);
    const liabilities = await this.gateway.getLiabilities(accessToken).catch(() => null);
    const resolvedInstitutionName = accounts.institutionId
      ? await this.gateway.getInstitutionName(accounts.institutionId)
      : null;
    const added = pages.flatMap((page) => page.added);
    const modified = pages.flatMap((page) => page.modified);
    const removed = pages.flatMap((page) => page.removed);
    const finalPage = pages.at(-1);
    if (!finalPage) throw new Error("Plaid synchronization returned no page");
    const duplicateRetired = await this.tenantDatabase.runSystemHousehold(
      job.householdId,
      async (transaction, principal) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${job.householdId}, 7241))`.execute(
          transaction,
        );
        await sql`select pg_advisory_xact_lock(hashtextextended(${job.connectionId}, 0))`.execute(
          transaction,
        );
        const current = await transaction
          .selectFrom("connections")
          .selectAll()
          .where("household_id", "=", job.householdId)
          .where("id", "=", job.connectionId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (
          current.status === "revocation_pending" ||
          current.status === "revoked"
        )
          throw new PlaidRequestError(
            "ITEM_REVOCATION_IN_PROGRESS",
            null,
            false,
            "Plaid Item revocation superseded this synchronization",
          );
        if ((current.sync_cursor ?? null) !== secret.cursor)
          throw new ConflictException(
            "Plaid cursor advanced in another sync; this batch will be retried",
          );
        const duplicate = await resolveDuplicatePlaidItem(
          transaction,
          principal,
          current,
          accounts.accounts,
          accounts.institutionId,
          resolvedInstitutionName,
          syncRunId,
        );
        if (duplicate.retireCurrent) return true;
        await reconcileAccounts(
          transaction,
          principal,
          job.connectionId,
          accounts.accounts,
          accounts.requestId,
          new Date(),
          liabilities,
        );
        const accountMap = new Map(
          (
            await transaction
              .selectFrom("accounts")
              .select(["id", "provider_account_id"])
              .where("household_id", "=", job.householdId)
              .where("connection_id", "=", job.connectionId)
              .execute()
          ).map((account) => [account.provider_account_id!, account.id]),
        );
        for (const transactionItem of added)
          await applyPlaidTransaction(
            transaction,
            job.householdId,
            accountMap,
            transactionItem,
          );
        for (const transactionItem of modified)
          await applyPlaidTransaction(
            transaction,
            job.householdId,
            accountMap,
            transactionItem,
          );
        for (const transactionItem of removed)
          await applyRemovedTransaction(
            transaction,
            job.householdId,
            transactionItem.transaction_id,
          );
        if (finalPage.updateStatus === "HISTORICAL_UPDATE_COMPLETE")
          await activatePendingSavingsTrackingForConnection(
            transaction,
            principal,
            job.connectionId,
          );
        await reconcilePlanEvidence(transaction, principal);
        await sql`select refresh_financial_exceptions(${job.householdId}::uuid)`.execute(
          transaction,
        );
        const historical =
          finalPage.updateStatus === "HISTORICAL_UPDATE_COMPLETE";
        const initial =
          historical || finalPage.updateStatus === "INITIAL_UPDATE_COMPLETE";
        const now = new Date();
        await transaction
          .updateTable("connections")
          .set({
            sync_cursor: finalPage.nextCursor,
            status: initial ? "healthy" : "syncing",
            last_successful_sync_at: now,
            initial_update_complete: initial,
            historical_update_complete: historical,
            institution_id: accounts.institutionId ?? current.institution_id,
            institution_name:
              resolvedInstitutionName ?? current.institution_name,
            error_code: null,
            updated_at: now,
          })
          .where("id", "=", current.id)
          .execute();
        await transaction
          .updateTable("sync_runs")
          .set({
            status: "succeeded",
            cursor_after: finalPage.nextCursor,
            added_count: added.length,
            modified_count: modified.length,
            removed_count: removed.length,
            completed_at: now,
            error_code: null,
          })
          .where("id", "=", syncRunId)
          .execute();
        await addActivity(
          transaction,
          principal,
          "connection.plaid.synced",
          `${current.institution_name ?? "Plaid connection"} synchronized`,
          `${added.length} added · ${modified.length} modified · ${removed.length} removed`,
          "plaid",
          "connection",
          current.id,
        );
        await persistSnapshot(transaction, principal, {
          externalEligible: true,
        });
        await bumpRevision(transaction, principal);
        return false;
      },
    );
    if (duplicateRetired) return syncRunId;
    return syncRunId;
  }

  private async persistAccountsWhileTransactionsWait(
    job: ClaimedJob,
    syncRunId: string,
    expectedCursor: string | null,
    accounts: Awaited<ReturnType<PlaidGateway["getAccounts"]>>,
    liabilities: Awaited<ReturnType<PlaidGateway["getLiabilities"]>>,
    resolvedInstitutionName: string | null,
  ): Promise<boolean> {
    return this.tenantDatabase.runSystemHousehold(
      job.householdId,
      async (transaction, principal) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${job.householdId}, 7241))`.execute(
          transaction,
        );
        await sql`select pg_advisory_xact_lock(hashtextextended(${job.connectionId}, 0))`.execute(
          transaction,
        );
        const current = await transaction
          .selectFrom("connections")
          .selectAll()
          .where("household_id", "=", job.householdId)
          .where("id", "=", job.connectionId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (
          current.status === "revocation_pending" ||
          current.status === "revoked"
        )
          throw new PlaidRequestError(
            "ITEM_REVOCATION_IN_PROGRESS",
            null,
            false,
            "Plaid Item revocation superseded this synchronization",
          );
        if ((current.sync_cursor ?? null) !== expectedCursor)
          throw new ConflictException(
            "Plaid cursor advanced while account balances were being observed",
          );
        const duplicate = await resolveDuplicatePlaidItem(
          transaction,
          principal,
          current,
          accounts.accounts,
          accounts.institutionId,
          resolvedInstitutionName,
          syncRunId,
        );
        if (duplicate.retireCurrent) return true;
        const observedAt = new Date();
        await reconcileAccounts(
          transaction,
          principal,
          job.connectionId,
          accounts.accounts,
          accounts.requestId,
          observedAt,
          liabilities,
        );
        await transaction
          .updateTable("connections")
          .set({
            status: "syncing",
            institution_id: accounts.institutionId ?? current.institution_id,
            institution_name:
              resolvedInstitutionName ?? current.institution_name,
            updated_at: observedAt,
          })
          .where("id", "=", current.id)
          .execute();
        await persistSnapshot(transaction, principal, {
          externalEligible: true,
        });
        await bumpRevision(transaction, principal);
        return false;
      },
    );
  }

  private async processRevocation(job: ClaimedJob): Promise<void> {
    const secret = await this.loadConnectionSecret(
      job.householdId,
      job.connectionId,
    );
    const accessToken = this.crypto.decrypt(secret.encrypted, secret.keyId, {
      environment: secret.environment,
      itemId: secret.itemId,
      connectionId: secret.id,
    });
    try {
      await this.gateway.removeItem(accessToken);
    } catch (error) {
      if (!isAlreadyRevoked(error)) throw error;
    }
    await this.finalizeRevocation(job.householdId, job.connectionId);
  }

  private async queueRevocationRetry(
    householdId: string,
    connectionId: string,
    error: unknown,
  ): Promise<void> {
    await this.tenantDatabase.runSystemHousehold(
      householdId,
      async (transaction) => {
        await transaction
          .updateTable("connections")
          .set({
            status: "revocation_pending",
            error_code: errorCode(error),
            updated_at: new Date(),
          })
          .where("id", "=", connectionId)
          .execute();
        await enqueueSyncJob(
          transaction,
          householdId,
          connectionId,
          "recovery",
          null,
          "revoke",
        );
      },
    );
  }

  private async fetchAllPages(
    accessToken: string,
    originalCursor: string | null,
  ): Promise<PlaidSyncPage[]> {
    for (let restart = 0; restart < 3; restart += 1) {
      const pages: PlaidSyncPage[] = [];
      let cursor = originalCursor;
      try {
        for (let pageNumber = 0; pageNumber < 1_000; pageNumber += 1) {
          const page = await this.gateway.syncTransactions(accessToken, cursor);
          pages.push(page);
          cursor = page.nextCursor;
          if (!page.hasMore) return pages;
        }
        throw new PlaidRequestError(
          "SYNC_PAGE_LIMIT_EXCEEDED",
          null,
          false,
          "Plaid sync exceeded the safety page limit",
        );
      } catch (error) {
        if (
          !(error instanceof PlaidRequestError) ||
          error.code !== "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" ||
          restart === 2
        )
          throw error;
      }
    }
    throw new Error("Plaid synchronization restart limit exceeded");
  }

  private async claimJob(
    jobId?: string,
    householdId?: string,
  ): Promise<ClaimedJob | null> {
    return this.database.transaction().execute(async (transaction) => {
      await sql`set local role budgefi_plaid_worker`.execute(transaction);
      if (householdId) {
        await sql`select set_config('app.household_id', ${householdId}, true)`.execute(
          transaction,
        );
      }
      const claimed = await sql<{
        job_id: string;
        household_id: string;
        connection_id: string;
        operation: "sync" | "revoke";
        job_trigger: ClaimedJob["trigger"];
        attempts: number;
      }>`select * from claim_plaid_sync_job(${jobId ?? null}::uuid)`.execute(
        transaction,
      );
      const row = claimed.rows[0];
      return row
        ? {
            jobId: row.job_id,
            householdId: row.household_id,
            connectionId: row.connection_id,
            operation: row.operation,
            trigger: row.job_trigger,
            attempts: row.attempts,
          }
        : null;
    });
  }

  private async finishJob(
    job: ClaimedJob,
    state: "succeeded",
    error: null,
  ): Promise<void> {
    await this.tenantDatabase.runSystemHousehold(
      job.householdId,
      async (transaction) => {
        await transaction
          .updateTable("plaid_sync_jobs")
          .set({
            state,
            completed_at: new Date(),
            locked_at: null,
            last_error_code: error,
          })
          .where("id", "=", job.jobId)
          .execute();
        const receipt = await transaction
          .selectFrom("plaid_sync_jobs")
          .select("webhook_receipt_id")
          .where("id", "=", job.jobId)
          .executeTakeFirst();
        if (receipt?.webhook_receipt_id)
          await transaction
            .updateTable("webhook_receipts")
            .set({
              processing_status: "processed",
              processed_at: new Date(),
              error_code: null,
            })
            .where("id", "=", receipt.webhook_receipt_id)
            .execute();
      },
    );
  }

  private async retryOrDeadLetter(
    job: ClaimedJob,
    error: unknown,
  ): Promise<void> {
    const code = errorCode(error);
    const retryable =
      error instanceof PlaidRequestError
        ? error.retryable
        : error instanceof ConflictException;
    const dead = !retryable || job.attempts >= 8;
    const delay = Math.min(
      3_600_000,
      2 ** Math.min(job.attempts, 10) * 1_000 +
        Math.floor(Math.random() * 1_000),
    );
    await this.tenantDatabase.runSystemHousehold(
      job.householdId,
      async (transaction) => {
        await transaction
          .updateTable("plaid_sync_jobs")
          .set({
            state: dead ? "dead" : "queued",
            available_at: new Date(Date.now() + delay),
            locked_at: null,
            completed_at: dead ? new Date() : null,
            last_error_code: code,
          })
          .where("id", "=", job.jobId)
          .execute();
        let connectionUpdate = transaction
          .updateTable("connections")
          .set({
            status:
              code === "ITEM_LOGIN_REQUIRED"
                ? "login_required"
                : job.operation === "revoke"
                  ? "revocation_pending"
                  : "error",
            error_code: code,
            updated_at: new Date(),
          })
          .where("id", "=", job.connectionId)
          .where("status", "!=", "revoked");
        if (job.operation === "sync")
          connectionUpdate = connectionUpdate.where(
            "status",
            "!=",
            "revocation_pending",
          );
        await connectionUpdate.execute();
        const receipt = await transaction
          .selectFrom("plaid_sync_jobs")
          .select("webhook_receipt_id")
          .where("id", "=", job.jobId)
          .executeTakeFirst();
        if (dead && receipt?.webhook_receipt_id)
          await transaction
            .updateTable("webhook_receipts")
            .set({
              processing_status: "failed",
              processed_at: new Date(),
              error_code: code,
            })
            .where("id", "=", receipt.webhook_receipt_id)
            .execute();
      },
    );
  }

  private async failSyncRun(
    job: ClaimedJob,
    syncRunId: string | null,
    code: string,
  ): Promise<void> {
    if (!syncRunId) return;
    await this.tenantDatabase.runSystemHousehold(
      job.householdId,
      async (transaction) => {
        await transaction
          .updateTable("sync_runs")
          .set({ status: "failed", completed_at: new Date(), error_code: code })
          .where("id", "=", syncRunId)
          .execute();
      },
    );
  }

  private async drainOne(): Promise<void> {
    if (this.workerActive) return;
    this.workerActive = true;
    try {
      if (Date.now() >= this.nextMaintenanceAt) {
        await this.scheduleMaintenance();
        this.nextMaintenanceAt = Date.now() + 60_000;
      }
      await this.processJob();
    } finally {
      this.workerActive = false;
    }
  }

  private async loadConnectionSecret(
    householdId: string,
    connectionId: string,
  ): Promise<ConnectionSecret> {
    return this.tenantDatabase.runSystemHousehold(
      householdId,
      async (transaction) => {
        const connection = await transaction
          .selectFrom("connections")
          .selectAll()
          .where("household_id", "=", householdId)
          .where("id", "=", connectionId)
          .where("provider", "=", "plaid")
          .executeTakeFirst();
        if (
          !connection?.encrypted_access_token ||
          !connection.token_key_id ||
          !connection.environment ||
          connection.status === "revoked"
        )
          throw new NotFoundException("Plaid connection secret is unavailable");
        return connectionSecret(connection);
      },
    );
  }

  private async finalizeRevocation(
    householdId: string,
    connectionId: string,
  ): Promise<void> {
    await this.tenantDatabase.runSystemHousehold(
      householdId,
      async (transaction, principal) => {
        await finalizeRevocationInTransaction(
          transaction,
          principal,
          connectionId,
        );
      },
    );
  }

  private async markSessionFailed(
    identity: RequestIdentity,
    sessionId: string,
    code: string,
  ): Promise<void> {
    try {
      await this.tenantDatabase.run(
        identity,
        async (transaction, principal) => {
          await transaction
            .updateTable("plaid_link_sessions")
            .set({
              status: "failed",
              error_code: code,
              exchange_started_at: null,
              encrypted_public_token: null,
              public_token_key_id: null,
              completed_at: new Date(),
            })
            .where("household_id", "=", principal.householdId)
            .where("user_id", "=", principal.userId)
            .where("id", "=", sessionId)
            .where("status", "!=", "completed")
            .execute();
        },
      );
    } catch {
      /* preserve original error */
    }
  }

  private async verifyWebhook(
    rawBody: Buffer,
    header: string | undefined,
  ): Promise<VerifiedWebhook> {
    if (!header)
      throw new ForbiddenException("Plaid-Verification header is required");
    let protectedHeader: ReturnType<typeof decodeProtectedHeader>;
    try {
      protectedHeader = decodeProtectedHeader(header);
    } catch {
      throw new ForbiddenException("Plaid webhook signature is malformed");
    }
    if (
      protectedHeader.alg !== "ES256" ||
      typeof protectedHeader.kid !== "string"
    )
      throw new ForbiddenException(
        "Plaid webhook signature algorithm or key is invalid",
      );
    let cached = this.webhookKeys.get(protectedHeader.kid);
    if (
      !cached ||
      Date.now() - cached.cachedAt > 24 * 60 * 60 * 1_000 ||
      cached.expiresAt <= Date.now()
    ) {
      const jwk = await this.gateway.getWebhookVerificationKey(
        protectedHeader.kid,
      );
      if (
        jwk.alg !== "ES256" ||
        jwk.kid !== protectedHeader.kid ||
        jwk.kty !== "EC" ||
        jwk.crv !== "P-256"
      )
        throw new ForbiddenException(
          "Plaid webhook verification key is invalid",
        );
      const expiresAt =
        typeof jwk.expired_at === "number"
          ? jwk.expired_at * 1_000
          : Date.now() + 24 * 60 * 60 * 1_000;
      if (expiresAt <= Date.now())
        throw new ForbiddenException(
          "Plaid webhook verification key is expired",
        );
      cached = {
        key: await importJWK(jwk, "ES256"),
        cachedAt: Date.now(),
        expiresAt,
      };
      this.webhookKeys.set(protectedHeader.kid, cached);
    }
    let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
    try {
      payload = (await jwtVerify(header, cached.key, { algorithms: ["ES256"] }))
        .payload;
    } catch {
      throw new ForbiddenException("Plaid webhook signature is invalid");
    }
    if (
      typeof payload.iat !== "number" ||
      Math.abs(Date.now() / 1_000 - payload.iat) > 300
    )
      throw new ForbiddenException("Plaid webhook signature is expired");
    if (
      typeof payload.request_body_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(payload.request_body_sha256)
    )
      throw new ForbiddenException("Plaid webhook body digest is invalid");
    const digest = createHash("sha256").update(rawBody).digest();
    const expected = Buffer.from(payload.request_body_sha256, "hex");
    if (expected.length !== digest.length || !timingSafeEqual(digest, expected))
      throw new ForbiddenException(
        "Plaid webhook body does not match its signature",
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new BadRequestException("Plaid webhook body is not valid JSON");
    }
    if (!isRecord(parsed))
      throw new BadRequestException("Plaid webhook body must be an object");
    return {
      payload: parsed,
      payloadHash: digest.toString("hex"),
      keyId: protectedHeader.kid,
      issuedAt: new Date(payload.iat * 1_000),
    };
  }

  private getBootstrap(identity: RequestIdentity): Promise<BootstrapResponse> {
    return this.tenantDatabase.run(identity, (transaction, principal) =>
      buildBootstrap(transaction, principal),
    );
  }
}

async function requireCompletedSessionPersisted(
  transaction: DatabaseTransaction<Database>,
  householdId: string,
  session: { connection_id: string | null; provider_item_id: string | null },
): Promise<void> {
  let query = transaction
    .selectFrom("connections")
    .select(["status"])
    .where("household_id", "=", householdId)
    .where("provider", "=", "plaid");
  query = session.connection_id
    ? query.where("id", "=", session.connection_id)
    : query.where("provider_item_id", "=", session.provider_item_id ?? "");
  const connection = await query.executeTakeFirst();
  if (!connection || connection.status === "revoked") {
    throw new ServiceUnavailableException(
      "Plaid Link completed, but its stored connection is unavailable",
    );
  }
}

async function finalizeRevocationInTransaction(
  transaction: DatabaseTransaction<Database>,
  principal: Principal,
  connectionId: string,
): Promise<void> {
  const now = new Date();
  await transaction
    .updateTable("connections")
    .set({
      status: "revoked",
      encrypted_access_token: null,
      token_key_id: null,
      sync_cursor: null,
      error_code: null,
      revoked_at: now,
      updated_at: now,
    })
    .where("household_id", "=", principal.householdId)
    .where("id", "=", connectionId)
    .execute();
  await transaction
    .updateTable("accounts")
    .set((eb) => ({
      archived_at: now,
      include_in_plan: false,
      version: eb("version", "+", 1),
    }))
    .where("household_id", "=", principal.householdId)
    .where("connection_id", "=", connectionId)
    .where("archived_at", "is", null)
    .execute();
  await addActivity(
    transaction,
    principal,
    "connection.plaid.revoked",
    "Plaid access revoked",
    "Provider access removed; historical ledger records retained",
    "plaid",
    "connection",
    connectionId,
  );
  await persistSnapshot(transaction, principal, { externalEligible: true });
  await bumpRevision(transaction, principal);
}

async function enqueueSyncJob(
  transaction: DatabaseTransaction<Database>,
  householdId: string,
  connectionId: string,
  trigger: ClaimedJob["trigger"],
  webhookReceiptId: string | null,
  operation: "sync" | "revoke",
): Promise<string> {
  const inserted = await transaction
    .insertInto("plaid_sync_jobs")
    .values({
      household_id: householdId,
      connection_id: connectionId,
      webhook_receipt_id: webhookReceiptId,
      operation,
      trigger,
      state: "queued",
      available_at: sql<Date>`now()`,
      locked_at: null,
      completed_at: null,
      last_error_code: null,
    })
    .onConflict((oc) => oc.doNothing())
    .returning("id")
    .executeTakeFirst();
  if (inserted) return inserted.id;
  const existing = await transaction
    .selectFrom("plaid_sync_jobs")
    .select("id")
    .where("household_id", "=", householdId)
    .where("connection_id", "=", connectionId)
    .where("operation", "=", operation)
    .where("state", "in", ["queued", "running"])
    .orderBy("created_at", "asc")
    .executeTakeFirst();
  if (!existing)
    throw new ConflictException("Plaid work could not be queued safely");
  return existing.id;
}

async function requireActiveHousehold(
  transaction: DatabaseTransaction<Database>,
  householdId: string,
): Promise<void> {
  const household = await transaction
    .selectFrom("households")
    .select("lifecycle_state")
    .where("id", "=", householdId)
    .forUpdate()
    .executeTakeFirst();
  if (!household || household.lifecycle_state !== "active")
    throw new ConflictException(
      "Bank connections are unavailable while account deletion is in progress",
    );
}

async function resolveDuplicatePlaidItem(
  transaction: DatabaseTransaction<Database>,
  principal: Principal,
  current: {
    id: string;
    household_id: string;
    institution_id: string | null;
    institution_name: string | null;
    created_at: Date;
    sync_cursor: string | null;
    initial_update_complete: boolean;
  },
  providerAccounts: AccountBase[],
  observedInstitutionId: string | null,
  observedInstitutionName: string | null,
  syncRunId: string,
): Promise<{ retireCurrent: boolean }> {
  // Duplicate resolution is intentionally limited to a new Item's first sync.
  // A later account-set change at the same institution is normal provider data,
  // not evidence that the user linked the bank twice.
  if (
    current.sync_cursor !== null ||
    current.initial_update_complete ||
    providerAccounts.length === 0
  )
    return { retireCurrent: false };

  const institutionId = observedInstitutionId ?? current.institution_id;
  const institutionName = observedInstitutionName ?? current.institution_name;
  let candidates = transaction
    .selectFrom("connections")
    .select([
      "id",
      "created_at",
      "institution_id",
      "institution_name",
      "status",
    ])
    .where("household_id", "=", principal.householdId)
    .where("provider", "=", "plaid")
    .where("id", "!=", current.id)
    .where("status", "in", ["syncing", "healthy"]);
  if (institutionId)
    candidates = candidates.where("institution_id", "=", institutionId);
  else if (institutionName)
    candidates = candidates.where(
      sql<boolean>`lower(institution_name) = lower(${institutionName})`,
    );
  else return { retireCurrent: false };

  const incomingFingerprints = sortedUnique(
    providerAccounts.map(plaidAccountFingerprint),
  );
  const incomingFallback = sortedUnique(
    providerAccounts.map(plaidAccountFallbackIdentity),
  );
  const matching: { id: string; createdAt: Date }[] = [];
  for (const candidate of await candidates.execute()) {
    const stored = await transaction
      .selectFrom("accounts")
      .select(["name", "account_type", "provider_account_fingerprint"])
      .where("household_id", "=", principal.householdId)
      .where("connection_id", "=", candidate.id)
      .where("provenance", "=", "plaid")
      .where("archived_at", "is", null)
      .execute();
    if (stored.length !== providerAccounts.length) continue;
    const storedFingerprints = stored.every(
      (account) => account.provider_account_fingerprint,
    )
      ? sortedUnique(
          stored.map((account) => account.provider_account_fingerprint!),
        )
      : [];
    const strongMatch =
      storedFingerprints.length > 0 &&
      sameStringSet(storedFingerprints, incomingFingerprints);
    const fallbackMatch = sameStringSet(
      sortedUnique(
        stored.map(
          (account) =>
            `${account.name.trim().toLowerCase()}|${account.account_type}`,
        ),
      ),
      incomingFallback,
    );
    if (strongMatch || fallbackMatch)
      matching.push({ id: candidate.id, createdAt: candidate.created_at });
  }
  if (!matching.length) return { retireCurrent: false };

  const keeper = [
    { id: current.id, createdAt: current.created_at },
    ...matching,
  ].sort(
    (left, right) =>
      left.createdAt.getTime() - right.createdAt.getTime() ||
      left.id.localeCompare(right.id),
  )[0]!;
  const retire = [
    { id: current.id, createdAt: current.created_at },
    ...matching,
  ].filter((connection) => connection.id !== keeper.id);
  const now = new Date();
  for (const duplicate of retire) {
    await transaction
      .updateTable("connections")
      .set({
        status: "revocation_pending",
        error_code: null,
        updated_at: now,
      })
      .where("household_id", "=", principal.householdId)
      .where("id", "=", duplicate.id)
      .where("status", "in", ["syncing", "healthy"])
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("accounts")
      .set((eb) => ({
        include_in_plan: false,
        version: eb("version", "+", 1),
      }))
      .where("household_id", "=", principal.householdId)
      .where("connection_id", "=", duplicate.id)
      .where("archived_at", "is", null)
      .execute();
    await enqueueSyncJob(
      transaction,
      principal.householdId,
      duplicate.id,
      "recovery",
      null,
      "revoke",
    );
    await addActivity(
      transaction,
      principal,
      "connection.plaid.duplicate_retired",
      "Duplicate bank connection removed",
      `${institutionName ?? "Bank"} was already connected; the earlier healthy connection was kept`,
      "plaid",
      "connection",
      duplicate.id,
    );
  }
  const retireCurrent = retire.some(
    (connection) => connection.id === current.id,
  );
  if (retireCurrent)
    await transaction
      .updateTable("sync_runs")
      .set({
        status: "succeeded",
        cursor_after: current.sync_cursor,
        added_count: 0,
        modified_count: 0,
        removed_count: 0,
        completed_at: now,
        error_code: null,
      })
      .where("id", "=", syncRunId)
      .execute();
  await persistSnapshot(transaction, principal, { externalEligible: true });
  await bumpRevision(transaction, principal);
  return { retireCurrent };
}

function plaidAccountFingerprint(account: AccountBase): string {
  const persistentId =
    typeof account.persistent_account_id === "string" &&
    account.persistent_account_id.trim()
      ? `persistent|${account.persistent_account_id.trim()}`
      : `fallback|${plaidAccountFallbackIdentity(account)}`;
  return sha256(`budgefi-plaid-account-v1|${persistentId}`);
}

function plaidAccountFallbackIdentity(account: AccountBase): string {
  const accountType = mapAccountType(
    String(account.type),
    account.subtype === null ? null : String(account.subtype),
  );
  const name = `${account.name}${account.mask ? ` •${account.mask}` : ""}`
    .slice(0, 200)
    .trim()
    .toLowerCase();
  return `${name}|${accountType}`;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function sameStringSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

async function reconcileAccounts(
  transaction: DatabaseTransaction<Database>,
  principal: Principal,
  connectionId: string,
  accounts: AccountBase[],
  requestId: string,
  observedAt: Date,
  liabilityResponse: Awaited<ReturnType<PlaidGateway["getLiabilities"]>>,
): Promise<void> {
  const providerIds: string[] = [];
  const liabilityByAccount = new Map<string, {
    type: "credit_card" | "student_loan" | "mortgage" | "other";
    minimum: number | null; due: string | null; statementBalance: number | null;
    statementOn: string | null; lastPayment: number | null; lastPaymentOn: string | null;
    overdue: boolean | null; aprs: Array<{ key: string; percentage: number; balance: number | null; type: string }>;
  }>();
  for (const item of liabilityResponse?.liabilities.credit ?? []) if (item.account_id)
    liabilityByAccount.set(item.account_id, {
      type: "credit_card", minimum: item.minimum_payment_amount, due: item.next_payment_due_date,
      statementBalance: item.last_statement_balance, statementOn: item.last_statement_issue_date,
      lastPayment: item.last_payment_amount, lastPaymentOn: item.last_payment_date, overdue: item.is_overdue,
      aprs: item.aprs.map((apr, index) => ({ key: `${apr.apr_type}:${index}`, percentage: apr.apr_percentage, balance: apr.balance_subject_to_apr, type: String(apr.apr_type) })),
    });
  for (const item of liabilityResponse?.liabilities.student ?? []) if (item.account_id)
    liabilityByAccount.set(item.account_id, {
      type: "student_loan", minimum: item.minimum_payment_amount, due: item.next_payment_due_date,
      statementBalance: item.last_statement_balance ?? null, statementOn: item.last_statement_issue_date,
      lastPayment: item.last_payment_amount, lastPaymentOn: item.last_payment_date, overdue: item.is_overdue,
      aprs: [{ key: "student", percentage: item.interest_rate_percentage, balance: null, type: "fixed" }],
    });
  for (const item of liabilityResponse?.liabilities.mortgage ?? [])
    liabilityByAccount.set(item.account_id, {
      type: "mortgage", minimum: item.next_monthly_payment, due: item.next_payment_due_date,
      statementBalance: null, statementOn: null, lastPayment: item.last_payment_amount,
      lastPaymentOn: item.last_payment_date, overdue: item.past_due_amount === null ? null : item.past_due_amount > 0,
      aprs: item.interest_rate.percentage === null ? [] : [{ key: "mortgage", percentage: item.interest_rate.percentage, balance: null, type: item.interest_rate.type ?? "unknown" }],
    });
  for (const item of liabilityResponse?.liabilities.loan ?? [])
    liabilityByAccount.set(item.account_id, {
      type: "other", minimum: item.next_payment_amount, due: item.next_payment_due_date,
      statementBalance: null, statementOn: null, lastPayment: item.last_payment_amount,
      lastPaymentOn: item.last_payment_date, overdue: null,
      aprs: item.interest_rate?.percentage === null || item.interest_rate?.percentage === undefined ? [] : [{ key: "loan", percentage: item.interest_rate.percentage, balance: null, type: item.interest_rate.type ?? "unknown" }],
    });
  for (const account of accounts) {
    const currency = account.balances.iso_currency_code;
    if (currency !== "USD" || account.balances.unofficial_currency_code)
      throw new PlaidRequestError(
        "UNSUPPORTED_ACCOUNT_CURRENCY",
        requestId,
        false,
        "Budgefi currently supports only USD Plaid accounts",
      );
    providerIds.push(account.account_id);
    const accountType = mapAccountType(
      String(account.type),
      account.subtype === null ? null : String(account.subtype),
    );
    const name =
      `${account.name}${account.mask ? ` •${account.mask}` : ""}`.slice(0, 200);
    const providerFingerprint = plaidAccountFingerprint(account);
    const existing = await transaction
      .selectFrom("accounts")
      .selectAll()
      .where("household_id", "=", principal.householdId)
      .where("connection_id", "=", connectionId)
      .where("provenance", "=", "plaid")
      .where("provider_account_id", "=", account.account_id)
      .executeTakeFirst();
    let accountId: string;
    if (!existing) {
      accountId = (
        await transaction
          .insertInto("accounts")
          .values({
            household_id: principal.householdId,
            name,
            account_type: accountType,
            currency: "USD",
            provenance: "plaid",
            provider_account_id: account.account_id,
            provider_account_fingerprint: providerFingerprint,
            connection_id: connectionId,
            include_in_plan: false,
            planning_role: "excluded",
            archived_at: null,
          })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;
    } else {
      accountId = existing.id;
      if (
        existing.name !== name ||
        existing.account_type !== accountType ||
        existing.provider_account_fingerprint !== providerFingerprint ||
        existing.archived_at !== null
      )
        await transaction
          .updateTable("accounts")
          .set((eb) => ({
            name,
            account_type: accountType,
            provider_account_fingerprint: providerFingerprint,
            archived_at: null,
            version: eb("version", "+", 1),
          }))
          .where("id", "=", existing.id)
          .execute();
    }
    // For liabilities, `available` is remaining credit—not cash and not the
    // amount owed. Preserve the signed provider current balance separately.
    const liability = accountType === "credit" || accountType === "loan";
    const basis = liability
      ? "current"
      : account.balances.available !== null
        ? "available"
        : "current";
    const amount = liability
      ? account.balances.current
      : (account.balances.available ?? account.balances.current);
    if (amount !== null)
      await transaction
        .insertInto("balance_observations")
        .values({
          household_id: principal.householdId,
          account_id: accountId,
          amount_minor: (liability && decimalNumberToMinor(amount) < 0n
            ? 0n
            : decimalNumberToMinor(amount)
          ).toString(),
          currency: "USD",
          provenance: "plaid",
          as_of: observedAt,
          source_record_id: `${requestId}:${account.account_id}`,
          balance_basis: basis,
          provider_request_id: requestId,
        })
        .onConflict((conflict) =>
          conflict
            .columns([
              "household_id",
              "account_id",
              "provenance",
              "source_record_id",
            ])
            .doNothing(),
        )
        .execute();
    if (liability) {
      const providerLiability = liabilityByAccount.get(account.account_id);
      let debt = await transaction
        .selectFrom("debts")
        .selectAll()
        .where("household_id", "=", principal.householdId)
        .where("account_id", "=", accountId)
        .orderBy("created_at", "desc")
        .executeTakeFirst();
      // An archived connected debt is a durable opt-out. The account remains
      // available and the user can explicitly set it up again, but sync must
      // not recreate a review card on every refresh.
      if (debt?.status === "archived") continue;
      if (!debt) {
        debt = await transaction
          .insertInto("debts")
          .values({
            household_id: principal.householdId,
            account_id: accountId,
            linked_commitment_id: null,
            name,
            payment_commitment_managed: false,
            debt_type: providerLiability?.type ?? (accountType === "credit" ? "credit_card" : "other"),
            status: "needs_review",
            provenance: "plaid",
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await transaction.insertInto("debt_revisions").values({
          household_id: principal.householdId,
          debt_id: debt.id,
          account_id: debt.account_id,
          linked_commitment_id: null,
          payment_commitment_managed: false,
          name: debt.name,
          debt_type: debt.debt_type,
          status: debt.status,
          provenance: debt.provenance,
          version: debt.version,
          actor_user_id: null,
          reason: "Connected liability discovered",
        }).execute();
      }
      if (account.balances.current !== null)
        await transaction.insertInto("debt_balance_observations").values({
          household_id: principal.householdId,
          debt_id: debt.id,
          current_balance_minor: decimalNumberToMinor(account.balances.current).toString(),
          currency: "USD",
          provenance: "plaid",
          source_record_id: `${requestId}:${account.account_id}`,
          observed_at: observedAt,
        }).onConflict((conflict) => conflict.columns(["household_id", "debt_id", "provenance", "source_record_id"]).doNothing()).execute();
      if (providerLiability) {
        const liabilityRequestId = liabilityResponse?.requestId ?? requestId;
        if (providerLiability.minimum !== null || providerLiability.due || providerLiability.statementBalance !== null || providerLiability.lastPayment !== null)
          await transaction.insertInto("debt_term_observations").values({
            household_id: principal.householdId, debt_id: debt.id,
            minimum_payment_minor: providerLiability.minimum === null ? null : decimalNumberToMinor(providerLiability.minimum).toString(),
            next_due_on: providerLiability.due,
            statement_balance_minor: providerLiability.statementBalance === null ? null : decimalNumberToMinor(providerLiability.statementBalance).toString(),
            statement_on: providerLiability.statementOn,
            last_payment_minor: providerLiability.lastPayment === null ? null : decimalNumberToMinor(providerLiability.lastPayment).toString(),
            last_payment_on: providerLiability.lastPaymentOn, overdue: providerLiability.overdue,
            provenance: "plaid", source_record_id: `${liabilityRequestId}:${account.account_id}`,
            observed_at: observedAt,
          }).onConflict((conflict) => conflict.columns(["household_id", "debt_id", "provenance", "source_record_id"]).doNothing()).execute();
        // Applying one component to a multi-rate balance can understate cost.
        // Until the projection models each balance bucket, only an unambiguous
        // single APR may drive a payoff estimate.
        const selected = providerLiability.aprs.length === 1 ? 0 : -1;
        for (const [index, apr] of providerLiability.aprs.entries())
          await transaction.insertInto("debt_apr_components").values({
            household_id: principal.householdId, debt_id: debt.id, component_key: apr.key,
            apr_basis_points: Math.round(apr.percentage * 100),
            balance_minor: apr.balance === null ? null : decimalNumberToMinor(apr.balance).toString(),
            apr_type: mapPlaidAprType(apr.type), selected_for_projection: index === selected,
            provenance: "plaid", source_record_id: `${liabilityRequestId}:${account.account_id}`,
            observed_at: observedAt,
          }).onConflict((conflict) => conflict.columns(["household_id", "debt_id", "provenance", "source_record_id", "component_key"]).doNothing()).execute();
        await synchronizeProviderMinimumPayment(transaction, principal, debt, providerLiability.minimum, providerLiability.due);
      }
    }
  }
  const disappeared = await transaction.selectFrom("accounts").select("id")
    .where("household_id", "=", principal.householdId).where("connection_id", "=", connectionId)
    .where("provenance", "=", "plaid").where("archived_at", "is", null)
    .$if(providerIds.length > 0, (query) => query.where("provider_account_id", "not in", providerIds))
    .execute();
  await detachIncomeSchedulesForAccounts(transaction, principal, disappeared.map((account) => account.id));
  await pauseDebtTrackingForAccounts(transaction, principal, disappeared.map((account) => account.id));
  let archive = transaction
    .updateTable("accounts")
    .set((eb) => ({
      archived_at: observedAt,
      include_in_plan: false,
      version: eb("version", "+", 1),
    }))
    .where("household_id", "=", principal.householdId)
    .where("connection_id", "=", connectionId)
    .where("provenance", "=", "plaid")
    .where("archived_at", "is", null);
  if (providerIds.length)
    archive = archive.where("provider_account_id", "not in", providerIds);
  await archive.execute();
}

async function synchronizeProviderMinimumPayment(
  transaction: DatabaseTransaction<Database>, principal: Principal,
  debt: { id: string; linked_commitment_id: string | null; payment_commitment_managed: boolean; name: string },
  minimum: number | null, due: string | null,
) {
  if (!debt.payment_commitment_managed || !debt.linked_commitment_id || minimum === null || !due) return;
  const policy = await transaction.selectFrom("debt_payment_policies").selectAll()
    .where("household_id", "=", principal.householdId).where("debt_id", "=", debt.id).executeTakeFirst();
  if (policy?.mode !== "minimum_due") return;
  const commitment = await transaction.selectFrom("commitments").selectAll()
    .where("household_id", "=", principal.householdId).where("id", "=", debt.linked_commitment_id)
    .where("active", "=", true).forUpdate().executeTakeFirst();
  if (!commitment) return;
  const amount = decimalNumberToMinor(minimum) + BigInt(policy.extra_amount_minor);
  if (commitment.amount_minor === amount.toString() && String(commitment.due_date) === due) return;
  const day = Number(due.slice(8, 10));
  const date = new Date(`${due}T12:00:00Z`);
  const next = new Date(date); next.setUTCDate(next.getUTCDate() + 1);
  const endOfMonth = next.getUTCMonth() !== date.getUTCMonth();
  const version = commitment.version + 1;
  const updated = await transaction.updateTable("commitments").set({
    name: `${debt.name} payment`, amount_minor: amount.toString(), due_date: due,
    recurrence_anchor_day: day, recurrence_anchor_eom: endOfMonth,
    version, updated_at: new Date(),
  }).where("household_id", "=", principal.householdId).where("id", "=", commitment.id)
    .where("version", "=", commitment.version).returningAll().executeTakeFirstOrThrow();
  await transaction.insertInto("commitment_revisions").values({
    household_id: principal.householdId, commitment_id: commitment.id, version,
    name: updated.name, amount_minor: updated.amount_minor, currency: updated.currency,
    due_date: updated.due_date, active: true, settled_at: null, actor_user_id: null,
  }).execute();
}

function mapPlaidAprType(value: string): "purchase" | "cash_advance" | "balance_transfer" | "fixed" | "variable" | "unknown" {
  if (value === "purchase_apr") return "purchase";
  if (value === "cash_apr") return "cash_advance";
  if (value === "balance_transfer_apr") return "balance_transfer";
  if (value === "fixed" || value === "variable") return value;
  return "unknown";
}

async function applyPlaidTransaction(
  transaction: DatabaseTransaction<Database>,
  householdId: string,
  accountMap: Map<string, string>,
  item: PlaidTransaction,
): Promise<void> {
  const accountId = accountMap.get(item.account_id);
  if (!accountId)
    throw new PlaidRequestError(
      "PLAID_TRANSACTION_ACCOUNT_MISSING",
      null,
      false,
    );
  if (item.iso_currency_code !== "USD" || item.unofficial_currency_code)
    throw new PlaidRequestError(
      "UNSUPPORTED_TRANSACTION_CURRENCY",
      null,
      false,
    );
  const signedMinor = decimalNumberToMinor(item.amount);
  const amountMinor = signedMinor < 0n ? -signedMinor : signedMinor;
  const direction = signedMinor < 0n ? "credit" : "debit";
  const merchant =
    (item.merchant_name ?? item.name ?? "Unknown transaction")
      .trim()
      .slice(0, 160) || "Unknown transaction";
  const status = item.pending ? "pending" : "posted";
  const providerPrimary = item.personal_finance_category?.primary ?? null;
  const providerDetailed = item.personal_finance_category?.detailed ?? null;
  const aliases = [item.transaction_id, item.pending_transaction_id].filter(
    (value): value is string => Boolean(value),
  );
  let entity = await transaction
    .selectFrom("transaction_source_aliases")
    .select("transaction_id")
    .where("household_id", "=", householdId)
    .where("account_id", "=", accountId)
    .where("source_kind", "=", "plaid")
    .where("source_record_id", "in", aliases)
    .executeTakeFirst();
  if (!entity) {
    const created = await transaction
      .insertInto("transaction_entities")
      .values({
        household_id: householdId,
        account_id: accountId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    entity = { transaction_id: created.id };
  }
  await transaction
    .insertInto("transaction_source_aliases")
    .values({
      household_id: householdId,
      transaction_id: entity.transaction_id,
      account_id: accountId,
      source_kind: "plaid",
      source_record_id: item.transaction_id,
    })
    .onConflict((conflict) =>
      conflict
        .columns([
          "household_id",
          "account_id",
          "source_kind",
          "source_record_id",
        ])
        .doNothing(),
    )
    .execute();
  const rawHash = sha256(
    JSON.stringify({
      accountId: item.account_id,
      transactionId: item.transaction_id,
      pendingTransactionId: item.pending_transaction_id ?? null,
      merchant,
      amountMinor: amountMinor.toString(),
      direction,
      date: item.date,
      status,
      providerPrimary,
      providerDetailed,
    }),
  );
  const latest = await latestTransaction(
    transaction,
    householdId,
    item.transaction_id,
  );
  if (latest?.raw_hash === rawHash && latest.status === status) return;
  await transaction
    .insertInto("financial_transactions")
    .values({
      household_id: householdId,
      account_id: accountId,
      source_kind: "plaid",
      source_record_id: item.transaction_id,
      revision: (latest?.revision ?? 0) + 1,
      merchant,
      amount_minor: amountMinor.toString(),
      currency: "USD",
      direction,
      occurred_on: item.date,
      status,
      pending_source_record_id: item.pending_transaction_id ?? null,
      source_updated_at: new Date(),
      raw_hash: rawHash,
      transaction_id: entity.transaction_id,
      provider_category_primary: providerPrimary,
      provider_category_detailed: providerDetailed,
    })
    .execute();
  await transaction
    .updateTable("transaction_entities")
    .set({
      version: sql`version + 1`,
      updated_at: new Date(),
    })
    .where("household_id", "=", householdId)
    .where("id", "=", entity.transaction_id)
    .execute();
  const assignment = await transaction
    .selectFrom("transaction_category_assignments")
    .selectAll()
    .where("household_id", "=", householdId)
    .where("transaction_id", "=", entity.transaction_id)
    .executeTakeFirst();
  if (!assignment) {
    const rule = await transaction
      .selectFrom("merchant_category_rules")
      .select("category")
      .where("household_id", "=", householdId)
      .where("normalized_merchant", "=", normalizeMerchantForRule(merchant))
      .where("archived_at", "is", null)
      .executeTakeFirst();
    const category =
      rule?.category ??
      mapPlaidCategory(providerPrimary, providerDetailed, direction);
    const categorySource = rule
      ? "merchant_rule"
      : providerPrimary
        ? "provider"
        : "deterministic";
    const categoryConfidence = rule
      ? "high"
      : providerPrimary
        ? "medium"
        : category === "income"
          ? "medium"
          : "low";
    await transaction
      .insertInto("transaction_category_assignments")
      .values({
        household_id: householdId,
        transaction_id: entity.transaction_id,
        category,
        source: categorySource,
        confidence: categoryConfidence,
        actor_user_id: null,
      })
      .execute();
    await transaction
      .insertInto("transaction_category_revisions")
      .values({
        household_id: householdId,
        transaction_id: entity.transaction_id,
        category,
        source: categorySource,
        confidence: categoryConfidence,
        version: 1,
        actor_user_id: null,
        reason: "Category assigned during bank synchronization",
      })
      .execute();
  } else if (!["user", "merchant_rule"].includes(assignment.source)) {
    const category = mapPlaidCategory(
      providerPrimary,
      providerDetailed,
      direction,
    );
    const source = providerPrimary ? "provider" : "deterministic";
    const confidence = providerPrimary
      ? "medium"
      : category === "income"
        ? "medium"
        : "low";
    if (
      assignment.category !== category ||
      assignment.source !== source ||
      assignment.confidence !== confidence
    ) {
      const version = assignment.version + 1;
      await transaction
        .updateTable("transaction_category_assignments")
        .set({ category, source, confidence, version, updated_at: new Date() })
        .where("household_id", "=", householdId)
        .where("transaction_id", "=", entity.transaction_id)
        .execute();
      await transaction
        .insertInto("transaction_category_revisions")
        .values({
          household_id: householdId,
          transaction_id: entity.transaction_id,
          category,
          source,
          confidence,
          version,
          actor_user_id: null,
          reason: "Provider category evidence changed",
        })
        .execute();
    }
  }
}

function normalizeMerchantForRule(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .slice(0, 160) || "unknown"
  );
}

function mapPlaidCategory(
  primary: string | null,
  detailed: string | null,
  direction: "debit" | "credit",
): string {
  const value = `${primary ?? ""} ${detailed ?? ""}`.toUpperCase();
  if (value.includes("TRANSFER") || value.includes("CREDIT_CARD_PAYMENT"))
    return "transfer";
  if (value.includes("INCOME")) return "income";
  if (value.includes("RENT") || value.includes("MORTGAGE")) return "housing";
  if (
    value.includes("UTILITY") ||
    value.includes("PHONE") ||
    value.includes("INTERNET")
  )
    return "utilities";
  if (value.includes("GROCER")) return "groceries";
  if (value.includes("RESTAURANT") || value.includes("FOOD_AND_DRINK"))
    return "dining";
  if (
    value.includes("TRANSPORT") ||
    value.includes("GAS") ||
    value.includes("PARKING")
  )
    return "transportation";
  if (value.includes("MEDICAL") || value.includes("HEALTH")) return "health";
  if (value.includes("INSURANCE")) return "insurance";
  if (value.includes("LOAN") || value.includes("DEBT")) return "debt";
  if (value.includes("SUBSCRIPTION")) return "subscriptions";
  if (value.includes("FEE")) return "fees";
  if (value.includes("ENTERTAINMENT")) return "entertainment";
  if (value.includes("EDUCATION")) return "education";
  if (value.includes("CHARITY") || value.includes("DONATION")) return "giving";
  if (value.includes("TAX")) return "taxes";
  if (value.includes("INVESTMENT") || value.includes("SAVINGS"))
    return "savings_investments";
  if (value.includes("ATM") || value.includes("CASH")) return "cash_atm";
  if (value.includes("SHOP") || value.includes("MERCHANDISE"))
    return "shopping";
  return direction === "credit" ? "income" : "uncategorized";
}

async function applyRemovedTransaction(
  transaction: DatabaseTransaction<Database>,
  householdId: string,
  transactionId: string,
): Promise<void> {
  const latest = await latestTransaction(
    transaction,
    householdId,
    transactionId,
  );
  if (!latest || latest.status === "removed") return;
  const rawHash = sha256(`${latest.raw_hash ?? ""}:removed`);
  await transaction
    .insertInto("financial_transactions")
    .values({
      household_id: householdId,
      account_id: latest.account_id,
      source_kind: "plaid",
      source_record_id: transactionId,
      revision: latest.revision + 1,
      merchant: latest.merchant,
      amount_minor: latest.amount_minor,
      currency: latest.currency,
      direction: latest.direction,
      occurred_on: latest.occurred_on,
      status: "removed",
      pending_source_record_id: latest.pending_source_record_id,
      source_updated_at: new Date(),
      raw_hash: rawHash,
      transaction_id: latest.transaction_id,
      provider_category_primary: latest.provider_category_primary,
      provider_category_detailed: latest.provider_category_detailed,
    })
    .execute();
  await transaction
    .updateTable("transaction_entities")
    .set({
      version: sql`version + 1`,
      updated_at: new Date(),
    })
    .where("household_id", "=", householdId)
    .where("id", "=", latest.transaction_id)
    .execute();
}

function latestTransaction(
  transaction: DatabaseTransaction<Database>,
  householdId: string,
  transactionId: string,
) {
  return transaction
    .selectFrom("financial_transactions")
    .selectAll()
    .where("household_id", "=", householdId)
    .where("source_kind", "=", "plaid")
    .where("source_record_id", "=", transactionId)
    .orderBy("revision", "desc")
    .executeTakeFirst();
}

function connectionSecret(connection: {
  id: string;
  household_id: string;
  provider_item_id: string;
  environment: string | null;
  encrypted_access_token: Uint8Array | null;
  token_key_id: string | null;
  sync_cursor: string | null;
}): ConnectionSecret {
  if (
    !connection.environment ||
    !connection.encrypted_access_token ||
    !connection.token_key_id
  )
    throw new Error("Plaid connection token metadata is incomplete");
  return {
    id: connection.id,
    householdId: connection.household_id,
    itemId: connection.provider_item_id,
    environment: parsePlaidEnvironment(connection.environment),
    encrypted: connection.encrypted_access_token,
    keyId: connection.token_key_id,
    cursor: connection.sync_cursor,
  };
}

function decimalNumberToMinor(value: number): bigint {
  if (!Number.isFinite(value))
    throw new PlaidRequestError("INVALID_PLAID_AMOUNT", null, false);
  const text = String(value);
  if (/e/i.test(text))
    throw new PlaidRequestError(
      "UNSUPPORTED_PLAID_AMOUNT_PRECISION",
      null,
      false,
    );
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [wholePart, fraction = ""] = unsigned.split(".");
  const whole = wholePart ?? "";
  if (
    !/^\d+$/.test(whole) ||
    !/^\d*$/.test(fraction) ||
    fraction.slice(2).replace(/0/g, "") !== ""
  )
    throw new PlaidRequestError(
      "UNSUPPORTED_PLAID_AMOUNT_PRECISION",
      null,
      false,
    );
  const minor = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
  if (minor > 1_000_000_000_000_000n)
    throw new PlaidRequestError("PLAID_AMOUNT_OUT_OF_RANGE", null, false);
  return negative ? -minor : minor;
}

function mapAccountType(
  type: string,
  subtype: string | null,
): "checking" | "savings" | "credit" | "loan" | "other" {
  if (type === "depository")
    return subtype === "savings" ||
      subtype === "money market" ||
      subtype === "cd"
      ? "savings"
      : "checking";
  if (type === "credit") return "credit";
  if (type === "loan") return "loan";
  return "other";
}

function parsePlaidEnvironment(value: string): PlaidEnvironment {
  if (value === "sandbox" || value === "development" || value === "production")
    return value;
  throw new Error("Stored Plaid environment is invalid");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function safeHashEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
function errorCode(error: unknown): string {
  return error instanceof PlaidRequestError
    ? error.code
    : error instanceof Error
      ? error.name.slice(0, 120)
      : "UNKNOWN_ERROR";
}
function isAlreadyRevoked(error: unknown): boolean {
  return (
    error instanceof PlaidRequestError &&
    (error.code === "ITEM_NOT_FOUND" || error.code === "INVALID_ACCESS_TOKEN")
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function stringField(
  value: Record<string, unknown>,
  key: string,
): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}
