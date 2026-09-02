import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { v7 as uuidv7 } from "uuid";
import {
  calculateProjection,
  money,
  serializeMoney,
} from "../../../../packages/domain/src/index.js";
import {
  bootstrapResponseSchema,
  type AccountInclusionRequest,
  type BootstrapResponse,
  type CommitmentRequest,
  type ExceptionDecisionRequest,
  type ManualBalanceRequest,
  type ManualTransactionRequest,
  type PlanCalibrationRequest,
  type PlanUpdateRequest,
} from "../../../../packages/contracts/src/index.js";
import type { Database } from "../../../../packages/database/src/index.js";
import {
  TenantDatabase,
  type RequestIdentity,
  type Principal,
} from "../database/tenant-database.js";
import { idempotent } from "./idempotency.js";

@Injectable()
export class CoreService {
  constructor(
    @Inject(TenantDatabase) private readonly tenantDatabase: TenantDatabase,
  ) {}

  getBootstrap(identity: RequestIdentity): Promise<BootstrapResponse> {
    return this.tenantDatabase.run(identity, (transaction, principal) =>
      buildBootstrap(transaction, principal),
    );
  }

  completeOnboarding(identity: RequestIdentity): Promise<BootstrapResponse> {
    return this.mutateThenRead(identity, async (transaction, principal) => {
      const completed = await transaction
        .updateTable("household_memberships")
        .set({ onboarding_completed_at: new Date() })
        .where("household_id", "=", principal.householdId)
        .where("user_id", "=", principal.userId)
        .where("revoked_at", "is", null)
        .where("onboarding_completed_at", "is", null)
        .returning("user_id")
        .executeTakeFirst();
      if (completed) {
        await addActivity(
          transaction,
          principal,
          "onboarding.completed",
          "Initial setup completed",
          "Accounts, commitments, and planning rules reviewed",
          "manual",
          "household",
          principal.householdId,
        );
        await bumpRevision(transaction, principal);
      }
    });
  }

  saveManualBalance(
    identity: RequestIdentity,
    request: ManualBalanceRequest,
  ): Promise<BootstrapResponse> {
    return this.mutateThenRead(identity, async (transaction, principal) =>
      idempotent(
        transaction,
        principal.householdId,
        request.requestId,
        "manual.balance.create",
        request,
        async () => {
          requireEditor(principal);
          const account = await transaction
            .selectFrom("accounts")
            .selectAll()
            .where("household_id", "=", principal.householdId)
            .where("id", "=", request.accountId)
            .where("archived_at", "is", null)
            .executeTakeFirst();
          if (!account) throw new NotFoundException("Manual account not found");
          if (account.provenance !== "manual")
            throw new ConflictException(
              "Manual balance updates require a manual account",
            );
          await transaction
            .insertInto("balance_observations")
            .values({
              household_id: principal.householdId,
              account_id: account.id,
              amount_minor: request.amount.minor,
              currency: request.amount.currency,
              provenance: "manual",
              as_of: request.asOf,
              source_record_id: request.requestId,
            })
            .execute();
          await addActivity(
            transaction,
            principal,
            "balance.recorded",
            "Manual cash balance updated",
            `Spendable cash recorded as $${minorToDecimal(request.amount.minor)}`,
            "manual",
            "account",
            account.id,
          );
          await persistSnapshot(transaction, principal);
          await bumpRevision(transaction, principal);
          return { operation: "manual.balance.create", resourceId: account.id };
        },
      ),
    );
  }

  addManualTransaction(
    identity: RequestIdentity,
    request: ManualTransactionRequest,
  ): Promise<BootstrapResponse> {
    return this.mutateThenRead(identity, async (transaction, principal) =>
      idempotent(
        transaction,
        principal.householdId,
        request.requestId,
        "manual.transaction.create",
        request,
        async () => {
          requireEditor(principal);
          const account = await transaction
            .selectFrom("accounts")
            .select(["id", "provenance"])
            .where("household_id", "=", principal.householdId)
            .where("id", "=", request.accountId)
            .where("archived_at", "is", null)
            .executeTakeFirst();
          if (!account) throw new NotFoundException("Account not found");
          if (account.provenance !== "manual")
            throw new ConflictException(
              "Manual transactions require a manual account",
            );
          const transactionId = uuidv7();
          await transaction
            .insertInto("financial_transactions")
            .values({
              id: transactionId,
              household_id: principal.householdId,
              account_id: account.id,
              source_kind: "manual",
              source_record_id: request.requestId,
              merchant: request.merchant,
              amount_minor: request.amount.minor,
              currency: request.amount.currency,
              occurred_on: request.occurredOn,
              status: "posted",
              pending_source_record_id: null,
              source_updated_at: null,
              raw_hash: null,
            })
            .execute();
          await addActivity(
            transaction,
            principal,
            "transaction.recorded",
            `${request.merchant} recorded manually`,
            `$${minorToDecimal(request.amount.minor)} · ${request.occurredOn}`,
            "manual",
            "transaction",
            transactionId,
          );
          await sql`select refresh_financial_exceptions(${principal.householdId}::uuid)`.execute(
            transaction,
          );
          await bumpRevision(transaction, principal);
          return {
            operation: "manual.transaction.create",
            resourceId: transactionId,
          };
        },
      ),
    );
  }

  addCommitment(
    identity: RequestIdentity,
    request: CommitmentRequest,
  ): Promise<BootstrapResponse> {
    return this.mutateThenRead(identity, async (transaction, principal) =>
      idempotent(
        transaction,
        principal.householdId,
        request.requestId,
        "commitment.create",
        request,
        async () => {
          requireEditor(principal);
          const commitmentId = uuidv7();
          await transaction
            .insertInto("commitments")
            .values({
              id: commitmentId,
              household_id: principal.householdId,
              name: request.name,
              amount_minor: request.amount.minor,
              currency: request.amount.currency,
              due_date: request.dueDate,
              recurrence: null,
              provenance: "manual",
            })
            .execute();
          await transaction
            .insertInto("commitment_revisions")
            .values({
              household_id: principal.householdId,
              commitment_id: commitmentId,
              version: 1,
              name: request.name,
              amount_minor: request.amount.minor,
              currency: request.amount.currency,
              due_date: request.dueDate,
              active: true,
              settled_at: null,
              actor_user_id: principal.userId,
            })
            .execute();
          await addActivity(
            transaction,
            principal,
            "commitment.created",
            `${request.name} commitment added`,
            `$${minorToDecimal(request.amount.minor)} reserved`,
            "manual",
            "commitment",
            commitmentId,
          );
          await persistSnapshot(transaction, principal);
          await bumpRevision(transaction, principal);
          return { operation: "commitment.create", resourceId: commitmentId };
        },
      ),
    );
  }

  updatePlan(
    identity: RequestIdentity,
    request: PlanUpdateRequest,
  ): Promise<BootstrapResponse> {
    return this.mutateThenRead(identity, async (transaction, principal) =>
      idempotent(
        transaction,
        principal.householdId,
        request.requestId,
        "plan.update",
        request,
        async () => {
          requireEditor(principal);
          const updated = await transaction
            .updateTable("plans")
            .set({
              planned_savings_minor: request.plannedSavings.minor,
              safety_buffer_minor: request.safetyBuffer.minor,
              version: request.expectedVersion + 1,
              updated_at: new Date(),
            })
            .where("household_id", "=", principal.householdId)
            .where("version", "=", request.expectedVersion)
            .returning(["id", "version"])
            .executeTakeFirst();
          if (!updated)
            throw new ConflictException(
              "Plan changed in another session; refresh before saving",
            );
          const current = await transaction
            .selectFrom("plans")
            .selectAll()
            .where("id", "=", updated.id)
            .executeTakeFirstOrThrow();
          await transaction
            .insertInto("plan_revisions")
            .values({
              household_id: principal.householdId,
              plan_id: current.id,
              version: current.version,
              planned_savings_minor: current.planned_savings_minor,
              safety_buffer_minor: current.safety_buffer_minor,
              currency: current.currency,
              planning_horizon_days: current.planning_horizon_days,
              policy_version: current.calculation_policy_version,
              actor_user_id: principal.userId,
            })
            .execute();
          await addActivity(
            transaction,
            principal,
            "plan.updated",
            "Planning rules updated",
            `Plan version ${updated.version} saved`,
            "manual",
            "plan",
            updated.id,
          );
          await persistSnapshot(transaction, principal);
          await bumpRevision(transaction, principal);
          return { operation: "plan.update", resourceId: updated.id };
        },
      ),
    );
  }

  setAccountInclusion(
    identity: RequestIdentity,
    accountId: string,
    request: AccountInclusionRequest,
  ): Promise<BootstrapResponse> {
    return this.mutateThenRead(identity, async (transaction, principal) =>
      idempotent(
        transaction,
        principal.householdId,
        request.requestId,
        "account.inclusion.update",
        { accountId, ...request },
        async () => {
          requireEditor(principal);
          const updated = await transaction
            .updateTable("accounts")
            .set({
              include_in_plan: request.includeInPlan,
              version: request.expectedVersion + 1,
            })
            .where("household_id", "=", principal.householdId)
            .where("id", "=", accountId)
            .where("version", "=", request.expectedVersion)
            .where("archived_at", "is", null)
            .where("account_type", "in", ["cash", "checking", "savings"])
            .returning(["id", "version"])
            .executeTakeFirst();
          if (!updated)
            throw new ConflictException(
              "Account changed, is unavailable, or cannot be included in planning",
            );
          await addActivity(
            transaction,
            principal,
            "account.inclusion.updated",
            request.includeInPlan
              ? "Account included in plan"
              : "Account excluded from plan",
            `Account version ${updated.version}`,
            "manual",
            "account",
            updated.id,
          );
          await persistSnapshot(transaction, principal);
          await bumpRevision(transaction, principal);
          return {
            operation: "account.inclusion.update",
            resourceId: updated.id,
          };
        },
      ),
    );
  }

  decideException(
    identity: RequestIdentity,
    caseId: string,
    request: ExceptionDecisionRequest,
  ): Promise<BootstrapResponse> {
    return this.mutateThenRead(identity, async (transaction, principal) =>
      idempotent(
        transaction,
        principal.householdId,
        request.requestId,
        "exception.decision",
        request,
        async () => {
          requireEditor(principal);
          const item = await transaction
            .selectFrom("exception_cases")
            .selectAll()
            .where("household_id", "=", principal.householdId)
            .where("id", "=", caseId)
            .forUpdate()
            .executeTakeFirst();
          if (!item) throw new NotFoundException("Review item not found");
          if (["verified", "failed", "expired"].includes(item.status))
            throw new ConflictException(
              "This review item is already closed; refresh to see its final status",
            );
          if (item.version !== request.expectedVersion)
            throw new ConflictException(
              "This review item changed; refresh before deciding",
            );
          const status =
            request.decision === "expected"
              ? "verified"
              : request.decision === "unexpected"
                ? "decided"
                : "awaiting_verification";
          await transaction
            .updateTable("exception_cases")
            .set({
              status,
              version: item.version + 1,
              updated_at: new Date(),
            })
            .where("id", "=", item.id)
            .execute();
          await addActivity(
            transaction,
            principal,
            "case.decision.recorded",
            item.title,
            request.decision === "expected"
              ? "Marked as expected"
              : request.decision === "unexpected"
                ? "Marked for follow-up"
                : "Kept for later review",
            "derived",
            "case",
            item.id,
          );
          await bumpRevision(transaction, principal);
          return { operation: "exception.decision", resourceId: item.id };
        },
      ),
    );
  }

  calibratePlan(
    identity: RequestIdentity,
    request: PlanCalibrationRequest,
  ): Promise<BootstrapResponse> {
    return this.mutateThenRead(identity, async (transaction, principal) =>
      idempotent(
        transaction,
        principal.householdId,
        request.requestId,
        "plan.calibrate",
        request,
        async () => {
          requireEditor(principal);
          if (request.manualBalance) {
            const account = await transaction
              .selectFrom("accounts")
              .select(["id", "provenance"])
              .where("household_id", "=", principal.householdId)
              .where("id", "=", request.manualBalance.accountId)
              .where("archived_at", "is", null)
              .executeTakeFirst();
            if (!account || account.provenance !== "manual")
              throw new ConflictException(
                "Calibration balance requires an active manual account",
              );
            await transaction
              .insertInto("balance_observations")
              .values({
                household_id: principal.householdId,
                account_id: account.id,
                amount_minor: request.manualBalance.amount.minor,
                currency: "USD",
                provenance: "manual",
                as_of: request.manualBalance.asOf,
                source_record_id: request.requestId,
              })
              .execute();
          }
          const updatedPlan = await transaction
            .updateTable("plans")
            .set({
              planned_savings_minor: request.plannedSavings.minor,
              safety_buffer_minor: request.safetyBuffer.minor,
              version: request.expectedVersion + 1,
              updated_at: new Date(),
            })
            .where("household_id", "=", principal.householdId)
            .where("version", "=", request.expectedVersion)
            .returningAll()
            .executeTakeFirst();
          if (!updatedPlan)
            throw new ConflictException(
              "Plan changed in another session; refresh before saving",
            );
          await transaction
            .insertInto("plan_revisions")
            .values({
              household_id: principal.householdId,
              plan_id: updatedPlan.id,
              version: updatedPlan.version,
              planned_savings_minor: updatedPlan.planned_savings_minor,
              safety_buffer_minor: updatedPlan.safety_buffer_minor,
              currency: updatedPlan.currency,
              planning_horizon_days: updatedPlan.planning_horizon_days,
              policy_version: updatedPlan.calculation_policy_version,
              actor_user_id: principal.userId,
            })
            .execute();
          const retainedIds: string[] = [];
          for (const item of request.commitments) {
            const existing = item.id
              ? await transaction
                  .selectFrom("commitments")
                  .selectAll()
                  .where("household_id", "=", principal.householdId)
                  .where("id", "=", item.id)
                  .where("version", "=", item.expectedVersion!)
                  .where("provenance", "=", "manual")
                  .where("active", "=", true)
                  .executeTakeFirst()
              : null;
            if (item.id && !existing)
              throw new ConflictException(
                "A commitment changed or is not manually editable; refresh before saving",
              );
            const row = existing
              ? await transaction
                  .updateTable("commitments")
                  .set({
                    name: item.name,
                    amount_minor: item.amount.minor,
                    due_date: item.dueDate,
                    active: true,
                    settled_at: null,
                    version: existing.version + 1,
                    updated_at: new Date(),
                  })
                  .where("id", "=", existing.id)
                  .returningAll()
                  .executeTakeFirstOrThrow()
              : await transaction
                  .insertInto("commitments")
                  .values({
                    household_id: principal.householdId,
                    name: item.name,
                    amount_minor: item.amount.minor,
                    currency: "USD",
                    due_date: item.dueDate,
                    recurrence: null,
                    provenance: "manual",
                  })
                  .returningAll()
                  .executeTakeFirstOrThrow();
            retainedIds.push(row.id);
            await transaction
              .insertInto("commitment_revisions")
              .values({
                household_id: principal.householdId,
                commitment_id: row.id,
                version: row.version,
                name: row.name,
                amount_minor: row.amount_minor,
                currency: row.currency,
                due_date: row.due_date,
                active: row.active,
                settled_at: row.settled_at,
                actor_user_id: principal.userId,
              })
              .execute();
          }
          for (const removal of request.removeCommitments) {
            if (retainedIds.includes(removal.id))
              throw new ConflictException(
                "A commitment cannot be retained and removed in the same request",
              );
            const row = await transaction
              .updateTable("commitments")
              .set({
                active: false,
                version: removal.expectedVersion + 1,
                updated_at: new Date(),
              })
              .where("household_id", "=", principal.householdId)
              .where("id", "=", removal.id)
              .where("version", "=", removal.expectedVersion)
              .where("provenance", "=", "manual")
              .where("active", "=", true)
              .returningAll()
              .executeTakeFirst();
            if (!row)
              throw new ConflictException(
                "A commitment changed or cannot be removed; refresh before saving",
              );
            await transaction
              .insertInto("commitment_revisions")
              .values({
                household_id: principal.householdId,
                commitment_id: row.id,
                version: row.version,
                name: row.name,
                amount_minor: row.amount_minor,
                currency: row.currency,
                due_date: row.due_date,
                active: row.active,
                settled_at: row.settled_at,
                actor_user_id: principal.userId,
              })
              .execute();
          }
          await addActivity(
            transaction,
            principal,
            "plan.calibrated",
            "Plan inputs confirmed",
            `${request.commitments.length} commitments reviewed`,
            "manual",
            "plan",
            updatedPlan.id,
          );
          await persistSnapshot(transaction, principal);
          await bumpRevision(transaction, principal);
          return { operation: "plan.calibrate", resourceId: updatedPlan.id };
        },
      ),
    );
  }

  private async mutateThenRead(
    identity: RequestIdentity,
    work: (
      transaction: Transaction<Database>,
      principal: Principal,
    ) => Promise<unknown>,
  ): Promise<BootstrapResponse> {
    await this.tenantDatabase.run(identity, work);
    return this.getBootstrap(identity);
  }
}

export async function buildBootstrap(
  transaction: Transaction<Database>,
  principal: Principal,
): Promise<BootstrapResponse> {
  const household = await transaction
    .selectFrom("households")
    .select(["id", "name", "timezone", "data_revision"])
    .where("id", "=", principal.householdId)
    .executeTakeFirstOrThrow();
  const membership = await transaction
    .selectFrom("household_memberships")
    .select("onboarding_completed_at")
    .where("household_id", "=", principal.householdId)
    .where("user_id", "=", principal.userId)
    .where("revoked_at", "is", null)
    .executeTakeFirstOrThrow();
  const accountRows = await sql<{
    id: string;
    connection_id: string | null;
    version: number;
    name: string;
    account_type: string;
    currency: "USD";
    provenance: "manual" | "csv" | "plaid" | "sample";
    include_in_plan: boolean;
    amount_minor: string | null;
    as_of: Date | null;
    connection_status: string | null;
    last_sync_at: Date | null;
  }>`
    select a.id, a.connection_id, a.version, a.name, a.account_type, a.currency, a.provenance, a.include_in_plan, latest.amount_minor, latest.as_of,
           c.status as connection_status, c.last_successful_sync_at as last_sync_at
    from accounts a
    left join lateral (
      select b.amount_minor, b.as_of
      from balance_observations b
      where b.household_id = a.household_id and b.account_id = a.id
        and not (b.provenance = 'manual' and b.source_record_id = 'provisioned')
      order by b.as_of desc, b.recorded_at desc
      limit 1
    ) latest on true
    left join connections c on c.household_id = a.household_id and c.id = a.connection_id
    where a.household_id = ${principal.householdId} and a.archived_at is null
      and a.provenance <> 'sample'
    order by a.created_at
  `.execute(transaction);
  const plan = await transaction
    .selectFrom("plans")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .executeTakeFirstOrThrow();
  const today = dateInTimezone(new Date(), household.timezone);
  const horizonEnd = addDays(today, plan.planning_horizon_days);
  const commitments = await transaction
    .selectFrom("commitments")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .where("active", "=", true)
    .where("settled_at", "is", null)
    .orderBy("due_date", "asc")
    .orderBy("created_at", "asc")
    .execute();
  const datedCommitments = commitments.filter(
    (commitment) =>
      commitment.due_date !== null &&
      toDateOnly(commitment.due_date) <= horizonEnd,
  );
  const includedAccounts = accountRows.rows.filter(
    (account) =>
      account.include_in_plan &&
      ["cash", "checking", "savings"].includes(account.account_type),
  );
  const knownCashMinor = includedAccounts.reduce(
    (sum, account) => sum + BigInt(account.amount_minor ?? "0"),
    0n,
  );
  const projection = calculateProjection({
    knownCash: money(knownCashMinor, "USD"),
    commitments: datedCommitments.map((commitment) =>
      money(commitment.amount_minor, "USD"),
    ),
    plannedSavings: money(plan.planned_savings_minor, "USD"),
    safetyBuffer: money(plan.safety_buffer_minor, "USD"),
  });
  const transactionRows = await sql<{
    id: string;
    account_id: string;
    merchant: string;
    amount_minor: string;
    currency: "USD";
    occurred_on: string;
    status: "pending" | "posted" | "removed" | "superseded";
    direction: "debit" | "credit";
    source_kind: "manual" | "csv" | "plaid" | "sample";
    revision: number;
  }>`
    with latest as (
      select id, account_id, merchant, amount_minor, currency,
        occurred_on, status, direction, source_kind, revision,
        row_number() over (
          partition by household_id, account_id, source_kind, source_record_id
          order by revision desc
        ) as version_rank
      from financial_transactions
      where household_id = ${principal.householdId}
        and source_kind <> 'sample'
    )
    select id, account_id, merchant, amount_minor, currency,
      occurred_on::text, status, direction, source_kind, revision
    from latest
    where version_rank = 1 and status in ('posted','pending')
    order by occurred_on desc, id desc
    limit 50
  `.execute(transaction);
  const activity = await transaction
    .selectFrom("activity_events")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .where("provenance", "!=", "sample")
    .orderBy("occurred_at", "desc")
    .limit(50)
    .execute();
  const cases = await transaction
    .selectFrom("exception_cases")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .where("status", "in", ["open", "decided", "awaiting_verification"])
    .orderBy("updated_at", "desc")
    .limit(100)
    .execute();
  const evidence = cases.length
    ? await transaction
        .selectFrom("case_evidence")
        .selectAll()
        .where("household_id", "=", principal.householdId)
        .where(
          "case_id",
          "in",
          cases.map((item) => item.id),
        )
        .orderBy("created_at", "asc")
        .execute()
    : [];
  const connections = await transaction
    .selectFrom("connections")
    .select([
      "id",
      "provider",
      "environment",
      "institution_name",
      "status",
      "error_code",
      "last_successful_sync_at",
      "initial_update_complete",
      "historical_update_complete",
    ])
    .where("household_id", "=", principal.householdId)
    .where("provider", "!=", "sample")
    .orderBy("created_at", "desc")
    .execute();
  const coveredAsOf =
    includedAccounts
      .map((account) => account.as_of)
      .filter((value): value is Date => value instanceof Date)
      .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
  const plaidAccounts = includedAccounts.filter(
    (account) =>
      account.provenance === "plaid" || account.provenance === "sample",
  );
  const staleCutoff = Date.now() - 36 * 60 * 60 * 1000;
  const incomplete = includedAccounts.some(
    (account) => !account.as_of || account.amount_minor === null,
  );
  const automatedStale = plaidAccounts.some(
    (account) =>
      account.connection_status !== "healthy" ||
      !account.last_sync_at ||
      account.last_sync_at.getTime() < staleCutoff ||
      !account.as_of ||
      account.as_of.getTime() < staleCutoff,
  );
  const calculatedAt = new Date().toISOString();
  return bootstrapResponseSchema.parse({
    revision: household.data_revision,
    household: {
      id: household.id,
      name: household.name,
      role: principal.role,
      onboardingCompleted: membership.onboarding_completed_at !== null,
    },
    capabilities: {
      bankConnections: {
        enabled: process.env.PLAID_ENABLED === "true",
        environment: plaidEnvironment(),
      },
    },
    accounts: accountRows.rows.map((account) => ({
      id: account.id,
      connectionId: account.connection_id,
      version: account.version,
      name: account.name,
      type: account.account_type,
      currency: account.currency,
      provenance: account.provenance,
      includeInPlan: account.include_in_plan,
      coverage: !account.include_in_plan
        ? "excluded"
        : !account.as_of
          ? "missing"
          : (account.provenance === "plaid" ||
                account.provenance === "sample") &&
              (account.connection_status !== "healthy" ||
                !account.last_sync_at ||
                account.last_sync_at.getTime() < staleCutoff ||
                account.as_of.getTime() < staleCutoff)
            ? "stale"
            : "complete",
      balance:
        account.amount_minor === null
          ? null
          : { minor: account.amount_minor, currency: account.currency },
      balanceAsOf: account.as_of?.toISOString() ?? null,
    })),
    connections: connections.map((connection) => ({
      id: connection.id,
      provider: connection.provider as "plaid" | "sample",
      environment: connection.environment as
        | "sandbox"
        | "development"
        | "production"
        | null,
      institutionName: connection.institution_name,
      status: connection.status as
        | "pending"
        | "syncing"
        | "healthy"
        | "stale"
        | "login_required"
        | "error"
        | "revocation_pending"
        | "revoked",
      errorCode: connection.error_code,
      lastSuccessfulSyncAt: connection.last_successful_sync_at
        ? toIso(connection.last_successful_sync_at)
        : null,
      initialUpdateComplete: connection.initial_update_complete,
      historicalUpdateComplete: connection.historical_update_complete,
    })),
    plan: {
      id: plan.id,
      householdId: principal.householdId,
      version: plan.version,
      planningHorizonDays: plan.planning_horizon_days,
      horizonStart: today,
      horizonEnd,
      knownCash: serializeMoney(projection.knownCash),
      commitments: commitments.map((commitment) => ({
        id: commitment.id,
        version: commitment.version,
        name: commitment.name,
        amount: { minor: commitment.amount_minor, currency: "USD" },
        dueDate:
          commitment.due_date === null ? null : toDateOnly(commitment.due_date),
        provenance: commitment.provenance as
          | "manual"
          | "csv"
          | "plaid"
          | "derived"
          | "sample",
      })),
      plannedSavings: serializeMoney(projection.plannedSavings),
      safetyBuffer: serializeMoney(projection.safetyBuffer),
      available: serializeMoney(projection.available),
      reserved: serializeMoney(projection.reserved),
      policyVersion: projection.policyVersion,
      calculatedAt,
      freshness: {
        status: incomplete
          ? "incomplete"
          : plaidAccounts.length === 0
            ? "manual"
            : automatedStale
              ? "stale"
              : "current",
        asOf: coveredAsOf?.toISOString() ?? null,
      },
    },
    transactions: transactionRows.rows.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        merchant: row.merchant,
        amount: { minor: row.amount_minor, currency: row.currency },
        occurredOn: row.occurred_on,
        status: row.status,
        direction: row.direction,
        provenance: row.source_kind,
        revision: row.revision,
      })),
    cases: cases.map((item) => ({
      id: item.id,
      type: item.case_type,
      status: item.status,
      title: item.title,
      expectedAmount:
        item.expected_amount_minor === null || item.currency === null
          ? null
          : { minor: item.expected_amount_minor, currency: item.currency },
      observedAmount:
        item.observed_amount_minor === null || item.currency === null
          ? null
          : { minor: item.observed_amount_minor, currency: item.currency },
      version: item.version,
      createdAt: toIso(item.created_at),
      updatedAt: toIso(item.updated_at),
      evidence: evidence
        .filter((proof) => proof.case_id === item.id)
        .map((proof) => ({
          id: proof.id,
          type: proof.evidence_type,
          summary: proof.summary,
          sourceEntityType: proof.source_entity_type,
          sourceEntityId: proof.source_entity_id,
          createdAt: toIso(proof.created_at),
          transaction:
            proof.merchant_snapshot === null ||
            proof.amount_minor_snapshot === null ||
            proof.currency_snapshot === null ||
            proof.occurred_on_snapshot === null ||
            proof.account_id_snapshot === null ||
            proof.account_name_snapshot === null ||
            proof.status_snapshot === null ||
            proof.provenance_snapshot === null
              ? null
              : {
                  merchant: proof.merchant_snapshot,
                  amount: {
                    minor: proof.amount_minor_snapshot,
                    currency: proof.currency_snapshot,
                  },
                  occurredOn: toDateOnly(proof.occurred_on_snapshot),
                  accountId: proof.account_id_snapshot,
                  accountName: proof.account_name_snapshot,
                  status: proof.status_snapshot,
                  provenance: proof.provenance_snapshot,
                },
        })),
    })),
    activity: activity.map((event) => ({
      id: event.id,
      type: event.event_type,
      title: event.title,
      detail: event.detail,
      provenance: event.provenance as
        | "manual"
        | "csv"
        | "plaid"
        | "derived"
        | "sample",
      occurredAt: toIso(event.occurred_at),
    })),
  });
}

function plaidEnvironment(): "sandbox" | "development" | "production" {
  const value = process.env.PLAID_ENV;
  return value === "development" || value === "production" ? value : "sandbox";
}

export function requireEditor(principal: Principal): void {
  if (principal.role !== "owner" && principal.role !== "admin")
    throw new ForbiddenException("Owner or administrator role required");
}

export async function bumpRevision(
  transaction: Transaction<Database>,
  principal: Principal,
): Promise<void> {
  await sql`update households set data_revision = data_revision + 1 where id = ${principal.householdId}`.execute(
    transaction,
  );
}

export async function persistSnapshot(
  transaction: Transaction<Database>,
  principal: Principal,
): Promise<void> {
  const view = await buildBootstrap(transaction, principal);
  const balanceInputs = await sql<{
    id: string;
    account_id: string;
    amount_minor: string;
    as_of: Date;
  }>`
    select latest.id, latest.account_id, latest.amount_minor, latest.as_of
    from accounts a
    join lateral (
      select b.id, b.account_id, b.amount_minor, b.as_of
      from balance_observations b
      where b.household_id = a.household_id and b.account_id = a.id
        and not (b.provenance = 'manual' and b.source_record_id = 'provisioned')
      order by b.as_of desc, b.recorded_at desc limit 1
    ) latest on true
    where a.household_id = ${principal.householdId} and a.archived_at is null and a.include_in_plan
      and a.provenance <> 'sample'
      and a.account_type in ('cash', 'checking', 'savings')
    order by a.id`.execute(transaction);
  const commitmentIds = view.plan.commitments.map((item) => item.id);
  const commitmentInputs =
    commitmentIds.length === 0
      ? []
      : await transaction
          .selectFrom("commitments")
          .select([
            "id",
            "version",
            "amount_minor",
            "due_date",
            "active",
            "settled_at",
          ])
          .where("household_id", "=", principal.householdId)
          .where("id", "in", commitmentIds)
          .orderBy("id")
          .execute();
  const plan = await transaction
    .selectFrom("plans")
    .select([
      "id",
      "version",
      "planning_horizon_days",
      "calculation_policy_version",
    ])
    .where("id", "=", view.plan.id)
    .executeTakeFirstOrThrow();
  const manifest = [
    {
      kind: "plan_revision",
      id: plan.id,
      version: plan.version,
      value: `${plan.planning_horizon_days}:${plan.calculation_policy_version}`,
    },
    ...balanceInputs.rows.map((item) => ({
      kind: "balance_observation",
      id: item.id,
      version: null,
      value: `${item.account_id}:${item.amount_minor}:${item.as_of.toISOString()}`,
    })),
    ...commitmentInputs.map((item) => ({
      kind: "commitment_revision",
      id: item.id,
      version: item.version,
      value: `${item.amount_minor}:${item.due_date ?? ""}:${item.active}:${item.settled_at?.toISOString() ?? ""}`,
    })),
  ];
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");
  const inserted = await sql<{
    id: string;
  }>`insert into calculation_snapshots (household_id, plan_id, plan_version, known_cash_minor, commitments_minor, planned_savings_minor, safety_buffer_minor, available_minor, currency, policy_version, input_fingerprint)
    values (${principal.householdId}, ${view.plan.id}, ${view.plan.version}, ${view.plan.knownCash.minor}::bigint,
      ${(BigInt(view.plan.reserved.minor) - BigInt(view.plan.plannedSavings.minor) - BigInt(view.plan.safetyBuffer.minor)).toString()}::bigint,
      ${view.plan.plannedSavings.minor}::bigint, ${view.plan.safetyBuffer.minor}::bigint, ${view.plan.available.minor}::bigint, 'USD', ${view.plan.policyVersion}, ${fingerprint})
    on conflict (household_id, input_fingerprint) do nothing
    returning id`.execute(transaction);
  const existing = inserted.rows[0]
    ? null
    : await sql<{
        id: string;
      }>`select id from calculation_snapshots where household_id = ${principal.householdId} and input_fingerprint = ${fingerprint}`.execute(
        transaction,
      );
  const snapshotId = inserted.rows[0]?.id ?? existing?.rows[0]?.id;
  if (!snapshotId) throw new Error("Snapshot persistence failed");
  for (const [ordinal, input] of manifest.entries()) {
    const inputHash = createHash("sha256").update(input.value).digest("hex");
    await sql`insert into calculation_snapshot_inputs (household_id, snapshot_id, input_kind, input_id, input_version, input_hash, ordinal)
      values (${principal.householdId}, ${snapshotId}, ${input.kind}, ${input.id}::uuid, ${input.version}, ${inputHash}, ${ordinal})
      on conflict do nothing`.execute(transaction);
  }
}

function dateInTimezone(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export async function addActivity(
  transaction: Transaction<Database>,
  principal: Principal,
  eventType: string,
  title: string,
  detail: string,
  provenance: "manual" | "csv" | "plaid" | "sample" | "derived",
  entityType: string,
  entityId: string,
): Promise<void> {
  await transaction
    .insertInto("activity_events")
    .values({
      household_id: principal.householdId,
      actor_user_id: principal.userId,
      event_type: eventType,
      title,
      detail,
      entity_type: entityType,
      entity_id: entityId,
      provenance,
      metadata: {},
    })
    .execute();
}

function minorToDecimal(value: string): string {
  const minor = BigInt(value);
  return `${minor / 100n}.${(minor % 100n).toString().padStart(2, "0")}`;
}

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function toDateOnly(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : value.slice(0, 10);
}
