import {
  BadRequestException,
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
  advanceIncomeDate,
  advanceIncomeScheduleDate,
  money,
  resolvePlanningHorizon,
  resolvePlanningHorizonFromSchedules,
  projectDebtPayoff,
  scoreReconciliationCandidate,
  serializeMoney,
} from "../../../../packages/domain/src/index.js";
import {
  bootstrapResponseSchema,
  type AccountInclusionRequest,
  type AccountPlanningRoleRequest,
  type BootstrapResponse,
  type CommitmentRequest,
  type DebtCreateRequest,
  type DebtUpdateRequest,
  type ExceptionDecisionRequest,
  type ManualBalanceRequest,
  type ManualModeRequest,
  type IncomeScheduleCreateRequest,
  type IncomeScheduleUpdateRequest,
  type ManualTransactionRequest,
  type ManualTransactionUpdate,
  type ManualTransactionVoid,
  type MerchantCategoryRuleDelete,
  type MerchantCategoryRulesResponse,
  type MerchantCategoryRuleUpdate,
  type OccurrenceSkipRequest,
  type PayCycleDetailResponse,
  type PayCycleListResponse,
  type PayCycleQuery,
  type PlanCalibrationRequest,
  type PlanUpdateRequest,
  type SavingsGoalBalanceUpdateRequest,
  type SavingsGoalCreateRequest,
  type SavingsGoalUpdateRequest,
  type StarterApplicationUndoRequest,
  type TransactionFeedQuery,
  type TransactionFeedResponse,
  type TransactionCategoryUpdate,
  type TransactionOccurrenceLinkRequest,
  type TransactionOccurrenceUnlinkRequest,
} from "../../../../packages/contracts/src/index.js";
import type { Database } from "../../../../packages/database/src/index.js";
import {
  TenantDatabase,
  type RequestIdentity,
  type Principal,
} from "../database/tenant-database.js";
import { idempotent } from "./idempotency.js";
import {
  getPayCycle,
  listPayCycles,
  refreshPayCycleDetail,
  refreshPayCycleHistory,
} from "./pay-cycle-history.js";

const COMMON_BILL_STARTERS = {
  housing: { name: "Housing", setupSlot: "housing" },
  utilities: { name: "Utilities", setupSlot: "utilities" },
  phone_internet: { name: "Phone & internet", setupSlot: null },
  insurance: { name: "Insurance", setupSlot: "insurance" },
  subscriptions: { name: "Subscriptions", setupSlot: "subscriptions" },
  debt_payment: { name: "Minimum debt payment", setupSlot: null },
} as const;

function encodeTransactionCursor(date: string, id: string) {
  return Buffer.from(JSON.stringify({ date, id })).toString("base64url");
}
function decodeTransactionCursor(value?: string) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed.date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ||
      typeof parsed.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        parsed.id,
      )
    )
      throw new Error();
    return parsed as { date: string; id: string };
  } catch {
    throw new BadRequestException("Transaction page cursor is invalid");
  }
}
function normalizeMerchantRule(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .slice(0, 160) || "unknown"
  );
}

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

  listPayCycles(
    identity: RequestIdentity,
    query: PayCycleQuery,
  ): Promise<PayCycleListResponse> {
    return this.tenantDatabase.run(identity, async (transaction, principal) => {
      return listPayCycles(transaction, principal, query);
    });
  }

  getPayCycle(
    identity: RequestIdentity,
    cycleId: string,
  ): Promise<PayCycleDetailResponse> {
    return this.tenantDatabase.run(identity, async (transaction, principal) => {
      try {
        await refreshPayCycleDetail(
          transaction,
          principal,
          await buildBootstrap(transaction, principal),
          cycleId,
        );
        return await getPayCycle(transaction, principal, cycleId);
      } catch (error) {
        if (error instanceof Error && error.message === "PAY_CYCLE_NOT_FOUND")
          throw new NotFoundException("Pay cycle not found");
        throw error;
      }
    });
  }

  listTransactions(
    identity: RequestIdentity,
    query: TransactionFeedQuery,
  ): Promise<TransactionFeedResponse> {
    return this.tenantDatabase.run(identity, async (transaction, principal) => {
      const cursor = decodeTransactionCursor(query.cursor);
      const search = query.query ? `%${query.query.toLowerCase()}%` : null;
      const result =
        await sql<any>`select e.id,e.version,r.merchant,r.amount_minor,r.currency,r.occurred_on::text,r.status,r.direction,r.source_kind,
        a.id account_id,a.name account_name,a.account_type,a.archived_at,
        c.category,c.source category_source,c.confidence,c.version category_version,
        o.id occurrence_id,o.name occurrence_name,o.state occurrence_state,
        o.match_state,o.match_id,o.match_version
      from transaction_entities e
      join financial_transactions r on r.id=e.current_transaction_id and r.household_id=e.household_id
      join accounts a on a.id=e.account_id and a.household_id=e.household_id
      join transaction_category_assignments c on c.transaction_id=e.id and c.household_id=e.household_id
      left join lateral (
        select occurrence.id,occurrence.name,occurrence.state,m.state match_state,
          m.id match_id,m.version match_version
        from occurrence_transaction_matches m
        join financial_transactions linked_evidence on linked_evidence.id=m.transaction_id and linked_evidence.household_id=m.household_id
        join plan_occurrences occurrence
          on occurrence.id=m.occurrence_id and occurrence.household_id=m.household_id
        where m.household_id=e.household_id and linked_evidence.transaction_id=e.id and m.state in ('proposed','confirmed')
        order by m.created_at desc limit 1
      ) o on true
      where e.household_id=${principal.householdId} and e.current_transaction_id is not null and r.source_kind<>'sample'
        and (${query.transactionId ?? null}::uuid is null or e.id=${query.transactionId ?? null}::uuid)
        and (${query.accountId ?? null}::uuid is null or a.id=${query.accountId ?? null}::uuid)
        and (${query.category ?? null}::text is null or c.category=${query.category ?? null}::text)
        and (${query.direction ?? null}::text is null or r.direction=${query.direction ?? null}::text)
        and (${query.status ?? null}::text is null or r.status=${query.status ?? null}::text)
        and (${query.from ?? null}::date is null or e.current_occurred_on>=${query.from ?? null}::date)
        and (${query.to ?? null}::date is null or e.current_occurred_on<=${query.to ?? null}::date)
        and (${search}::text is null or lower(r.merchant) like ${search}::text)
        and (${cursor?.date ?? null}::date is null or (e.current_occurred_on,e.id)<(${cursor?.date ?? null}::date,${cursor?.id ?? null}::uuid))
      order by e.current_occurred_on desc,e.id desc limit ${query.limit + 1}`.execute(
          transaction,
        );
      const rows = result.rows as any[];
      const accountOptions = await transaction
        .selectFrom("accounts as account")
        .select(["account.id", "account.name", "account.archived_at"])
        .where("account.household_id", "=", principal.householdId)
        .where((expression) =>
          expression.exists(
            expression
              .selectFrom("transaction_entities as entity")
              .select("entity.id")
              .whereRef("entity.household_id", "=", "account.household_id")
              .whereRef("entity.account_id", "=", "account.id")
              .where("entity.current_transaction_id", "is not", null),
          ),
        )
        .orderBy("account.name", "asc")
        .execute();
      const hasMore = rows.length > query.limit;
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((row) => ({
          id: row.id,
          version: row.version,
          merchant: row.merchant,
          amount: { minor: row.amount_minor, currency: row.currency },
          occurredOn: row.occurred_on,
          status: row.status,
          direction: row.direction,
          provenance: row.source_kind,
          account: {
            id: row.account_id,
            name: row.account_name,
            type: row.account_type,
            archived: Boolean(row.archived_at),
          },
          category: row.category,
          categorySource: row.category_source,
          categoryConfidence: row.confidence,
          categoryVersion: row.category_version,
          linkedOccurrence: row.occurrence_id
            ? {
                id: row.occurrence_id,
                name: row.occurrence_name,
                state: row.occurrence_state,
                matchState: row.match_state,
                matchId: row.match_id,
                matchVersion: row.match_version,
              }
            : null,
        })),
        accounts: accountOptions.map((account) => ({
          id: account.id,
          name: account.name,
          archived: Boolean(account.archived_at),
        })),
        nextCursor: hasMore
          ? encodeTransactionCursor(page.at(-1)!.occurred_on, page.at(-1)!.id)
          : null,
      };
    });
  }

  updateTransactionCategory(
    identity: RequestIdentity,
    transactionId: string,
    request: TransactionCategoryUpdate,
  ): Promise<TransactionFeedResponse> {
    return this.tenantDatabase
      .run(identity, async (transaction, principal) =>
        idempotent(
          transaction,
          principal.householdId,
          request.requestId,
          "transaction.category.update",
          request,
          async () => {
            requireEditor(principal);
            const current = await transaction
              .selectFrom("transaction_category_assignments")
              .selectAll()
              .where("household_id", "=", principal.householdId)
              .where("transaction_id", "=", transactionId)
              .forUpdate()
              .executeTakeFirst();
            if (!current) throw new NotFoundException("Transaction not found");
            if (current.version !== request.expectedVersion)
              throw new ConflictException(
                "Transaction category changed; refresh and try again",
              );
            const next = current.version + 1;
            await transaction
              .updateTable("transaction_category_assignments")
              .set({
                category: request.category,
                source: "user",
                confidence: "high",
                version: next,
                actor_user_id: principal.userId,
                updated_at: new Date(),
              })
              .where("household_id", "=", principal.householdId)
              .where("transaction_id", "=", transactionId)
              .execute();
            await transaction
              .insertInto("transaction_category_revisions")
              .values({
                household_id: principal.householdId,
                transaction_id: transactionId,
                category: request.category,
                source: "user",
                confidence: "high",
                version: next,
                actor_user_id: principal.userId,
                reason: "Category changed by user",
              })
              .execute();
            if (request.applyToFuture) {
              const evidence = await transaction
                .selectFrom("financial_transactions")
                .select("merchant")
                .where("household_id", "=", principal.householdId)
                .where("transaction_id", "=", transactionId)
                .orderBy("recorded_at", "desc")
                .executeTakeFirstOrThrow();
              const normalized = normalizeMerchantRule(evidence.merchant);
              await transaction
                .insertInto("merchant_category_rules")
                .values({
                  household_id: principal.householdId,
                  normalized_merchant: normalized,
                  category: request.category,
                  actor_user_id: principal.userId,
                })
                .onConflict((conflict) =>
                  conflict
                    .columns(["household_id", "normalized_merchant"])
                    .doUpdateSet({
                      category: request.category,
                      version: sql`merchant_category_rules.version + 1`,
                      actor_user_id: principal.userId,
                      updated_at: new Date(),
                      archived_at: null,
                    }),
                )
                .execute();
            }
            await addActivity(
              transaction,
              principal,
              "transaction.categorized",
              "Transaction category changed",
              request.applyToFuture
                ? "This transaction and future matching merchants will use the category"
                : "Only this transaction was changed",
              "manual",
              "transaction",
              transactionId,
            );
            await persistSnapshot(transaction, principal);
            await bumpRevision(transaction, principal);
            return {
              operation: "transaction.category.update",
              resourceId: transactionId,
            };
          },
        ),
      )
      .then(() => this.listTransactions(identity, { limit: 30 }));
  }

  linkTransactionToOccurrence(
    identity: RequestIdentity,
    transactionId: string,
    request: TransactionOccurrenceLinkRequest,
  ): Promise<BootstrapResponse> {
    return this.mutateThenRead(identity, async (transaction, principal) =>
      idempotent(
        transaction,
        principal.householdId,
        request.requestId,
        "transaction.occurrence.link",
        { transactionId, ...request },
        async () => {
          requireEditor(principal);
          await sql`select pg_advisory_xact_lock(hashtextextended(${principal.householdId}, 7241))`.execute(
            transaction,
          );
          const evidence = await transaction
            .selectFrom("transaction_entities as entity")
            .innerJoin(
              "financial_transactions as evidence",
              "evidence.id",
              "entity.current_transaction_id",
            )
            .innerJoin("accounts as account", (join) =>
              join
                .onRef("account.id", "=", "entity.account_id")
                .onRef("account.household_id", "=", "entity.household_id"),
            )
            .select([
              "entity.id as entity_id",
              "entity.version as entity_version",
              "evidence.id as evidence_id",
              "evidence.amount_minor",
              "evidence.direction",
              "evidence.status",
              "account.id as account_id",
              "account.account_type",
              "account.include_in_plan",
              "account.planning_role",
              "account.archived_at",
            ])
            .where("entity.household_id", "=", principal.householdId)
            .where("entity.id", "=", transactionId)
            .forUpdate("entity")
            .executeTakeFirst();
          if (!evidence) throw new NotFoundException("Transaction not found");
          if (evidence.entity_version !== request.expectedTransactionVersion)
            throw new ConflictException(
              "This transaction changed; refresh and try again",
            );
          if (evidence.status !== "posted")
            throw new ConflictException(
              "Wait for this transaction to post before matching it",
            );
          const occurrence = await transaction
            .selectFrom("plan_occurrences")
            .selectAll()
            .where("household_id", "=", principal.householdId)
            .where("id", "=", request.occurrenceId)
            .forUpdate()
            .executeTakeFirst();
          if (
            !occurrence ||
            occurrence.version !== request.expectedOccurrenceVersion ||
            ![
              "expected",
              "pending",
              "partial",
              "overdue",
              "needs_review",
            ].includes(occurrence.state)
          )
            throw new ConflictException(
              "This plan item changed or is no longer open; refresh and try again",
            );
          const savingsGoal = occurrence.savings_goal_id
            ? await transaction
                .selectFrom("savings_goals")
                .select(["id", "destination_account_id"])
                .where("household_id", "=", principal.householdId)
                .where("id", "=", occurrence.savings_goal_id)
                .where("status", "!=", "archived")
                .executeTakeFirst()
            : null;
          const usableSavingsDestination =
            occurrence.kind === "savings" &&
            savingsGoal?.destination_account_id === evidence.account_id &&
            evidence.planning_role === "protected";
          const incomeSchedule = occurrence.income_schedule_id
            ? await transaction
                .selectFrom("income_schedules")
                .select("destination_account_id")
                .where("household_id", "=", principal.householdId)
                .where("id", "=", occurrence.income_schedule_id)
                .where("status", "!=", "archived")
                .executeTakeFirst()
            : null;
          const usableIncomeDestination =
            occurrence.kind === "income" &&
            evidence.planning_role === "protected" &&
            (!incomeSchedule?.destination_account_id ||
              incomeSchedule.destination_account_id === evidence.account_id);
          const wrongIncomeDestination =
            occurrence.kind === "income" &&
            Boolean(incomeSchedule?.destination_account_id) &&
            incomeSchedule?.destination_account_id !== evidence.account_id;
          if (
            evidence.archived_at ||
            wrongIncomeDestination ||
            !["cash", "checking", "savings"].includes(evidence.account_type) ||
            (!usableSavingsDestination &&
              !usableIncomeDestination &&
              evidence.planning_role !== "spendable")
          )
            throw new ConflictException(
              occurrence.kind === "savings"
                ? "Savings proof must arrive in this goal’s protected destination account"
                : occurrence.kind === "income"
                  ? "Income proof must use its selected destination or a spendable account"
                  : "Plan evidence must use an active spendable cash account",
            );
          const expectedDirection =
            occurrence.kind === "income" || occurrence.kind === "savings"
              ? "credit"
              : "debit";
          if (evidence.direction !== expectedDirection)
            throw new ConflictException(
              "The transaction direction does not match the selected plan item",
            );
          const activeMatches = await transaction
            .selectFrom("occurrence_transaction_matches")
            .selectAll()
            .where("household_id", "=", principal.householdId)
            .where("transaction_id", "=", evidence.evidence_id)
            .where("state", "in", ["proposed", "confirmed"])
            .forUpdate()
            .execute();
          const confirmedUse = activeMatches.find(
            (item) => item.state === "confirmed",
          );
          const proposedForOccurrence = activeMatches.find(
            (item) =>
              item.state === "proposed" && item.occurrence_id === occurrence.id,
          );
          if (confirmedUse && confirmedUse.occurrence_id !== occurrence.id)
            throw new ConflictException(
              "This transaction is already matched to a plan item",
            );
          const allocated = await activeConfirmedAllocation(
            transaction,
            principal.householdId,
            occurrence.id,
          );
          const remaining =
            occurrence.expected_amount_minor === null
              ? allocated === 0n
                ? BigInt(evidence.amount_minor)
                : 0n
              : BigInt(occurrence.expected_amount_minor) - allocated;
          if (remaining <= 0n)
            throw new ConflictException(
              "This plan item already has enough payment evidence",
            );
          const applied =
            BigInt(evidence.amount_minor) < remaining
              ? evidence.amount_minor
              : remaining.toString();
          for (const alternative of activeMatches.filter(
            (item) =>
              item.state === "proposed" &&
              item.id !== proposedForOccurrence?.id,
          )) {
            const rejected = await transaction
              .updateTable("occurrence_transaction_matches")
              .set({
                state: "rejected",
                version: alternative.version + 1,
                actor_user_id: principal.userId,
                reason:
                  "User chose a different income schedule for this transaction",
                resolved_at: new Date(),
              })
              .where("household_id", "=", principal.householdId)
              .where("id", "=", alternative.id)
              .where("version", "=", alternative.version)
              .returningAll()
              .executeTakeFirstOrThrow();
            await transaction
              .insertInto("occurrence_match_revisions")
              .values({
                household_id: principal.householdId,
                match_id: rejected.id,
                version: rejected.version,
                state: rejected.state,
                amount_applied_minor: rejected.amount_applied_minor,
                reflected_in_balance_observation_id:
                  rejected.reflected_in_balance_observation_id,
                reason: rejected.reason,
                actor_user_id: principal.userId,
              })
              .execute();
          }
          const match = proposedForOccurrence
            ? await transaction
                .updateTable("occurrence_transaction_matches")
                .set({
                  amount_applied_minor: applied,
                  state: "confirmed",
                  confidence: "1.000",
                  reason: "User confirmed the suggested transaction match",
                  version: proposedForOccurrence.version + 1,
                  actor_user_id: principal.userId,
                  resolved_at: new Date(),
                })
                .where("household_id", "=", principal.householdId)
                .where("id", "=", proposedForOccurrence.id)
                .where("version", "=", proposedForOccurrence.version)
                .returningAll()
                .executeTakeFirstOrThrow()
            : await transaction
                .insertInto("occurrence_transaction_matches")
                .values({
                  household_id: principal.householdId,
                  occurrence_id: occurrence.id,
                  transaction_id: evidence.evidence_id,
                  reflected_in_balance_observation_id: null,
                  amount_applied_minor: applied,
                  state: "confirmed",
                  confidence: "1.000",
                  reason: "User matched an existing posted transaction",
                  actor_user_id: principal.userId,
                  resolved_at: new Date(),
                })
                .returningAll()
                .executeTakeFirstOrThrow();
          await transaction
            .insertInto("occurrence_match_revisions")
            .values({
              household_id: principal.householdId,
              match_id: match.id,
              version: match.version,
              state: match.state,
              amount_applied_minor: match.amount_applied_minor,
              reflected_in_balance_observation_id: null,
              reason: match.reason,
              actor_user_id: principal.userId,
            })
            .execute();
          await reconcilePlanEvidence(transaction, principal);
          await addActivity(
            transaction,
            principal,
            "occurrence.match.confirmed",
            `${occurrence.name} transaction matched`,
            "The posted transaction is now attached to this plan item",
            "manual",
            "occurrence",
            occurrence.id,
          );
          await persistSnapshot(transaction, principal);
          await bumpRevision(transaction, principal);
          return {
            operation: "transaction.occurrence.link",
            resourceId: match.id,
          };
        },
      ),
    );
  }

  unlinkTransactionFromOccurrence(
    identity: RequestIdentity,
    transactionId: string,
    request: TransactionOccurrenceUnlinkRequest,
  ): Promise<BootstrapResponse> {
    return this.mutateThenRead(identity, async (transaction, principal) =>
      idempotent(
        transaction,
        principal.householdId,
        request.requestId,
        "transaction.occurrence.unlink",
        { transactionId, ...request },
        async () => {
          requireEditor(principal);
          await sql`select pg_advisory_xact_lock(hashtextextended(${principal.householdId}, 7241))`.execute(
            transaction,
          );
          const entity = await transaction
            .selectFrom("transaction_entities")
            .select(["id", "version", "current_transaction_id"])
            .where("household_id", "=", principal.householdId)
            .where("id", "=", transactionId)
            .forUpdate()
            .executeTakeFirst();
          if (!entity) throw new NotFoundException("Transaction not found");
          if (entity.version !== request.expectedTransactionVersion)
            throw new ConflictException(
              "This transaction changed; refresh and try again",
            );
          if (!entity.current_transaction_id)
            throw new ConflictException(
              "This transaction is no longer active; refresh and try again",
            );
          const match = await transaction
            .selectFrom("occurrence_transaction_matches")
            .selectAll()
            .where("household_id", "=", principal.householdId)
            .where("id", "=", request.expectedMatchId)
            .where("transaction_id", "=", entity.current_transaction_id)
            .where("occurrence_id", "=", request.expectedOccurrenceId)
            .where("version", "=", request.expectedMatchVersion)
            .where("state", "in", ["proposed", "confirmed"])
            .forUpdate()
            .executeTakeFirst();
          if (!match)
            throw new ConflictException(
              "This transaction is not matched to an open plan item",
            );
          const occurrence = await transaction
            .selectFrom("plan_occurrences")
            .selectAll()
            .where("household_id", "=", principal.householdId)
            .where("id", "=", match.occurrence_id)
            .forUpdate()
            .executeTakeFirstOrThrow();
          const nextVersion = match.version + 1;
          const reason = "User said this was not the matching transaction";
          await transaction
            .updateTable("occurrence_transaction_matches")
            .set({
              state: "reversed",
              reason,
              version: nextVersion,
              resolved_at: new Date(),
            })
            .where("household_id", "=", principal.householdId)
            .where("id", "=", match.id)
            .where("version", "=", request.expectedMatchVersion)
            .executeTakeFirst();
          await reverseVerifiedOccurrenceConsequences(
            transaction,
            principal,
            occurrence,
          );
          await transaction
            .insertInto("occurrence_match_revisions")
            .values({
              household_id: principal.householdId,
              match_id: match.id,
              version: nextVersion,
              state: "reversed",
              amount_applied_minor: match.amount_applied_minor,
              reflected_in_balance_observation_id:
                match.reflected_in_balance_observation_id,
              reason,
              actor_user_id: principal.userId,
            })
            .execute();
          await reconcilePlanEvidence(transaction, principal);
          const currentPlan = await transaction
            .selectFrom("plans")
            .selectAll()
            .where("household_id", "=", principal.householdId)
            .executeTakeFirstOrThrow();
          await synchronizePlanOccurrences(transaction, principal, currentPlan);
          await addActivity(
            transaction,
            principal,
            "occurrence.match.reversed",
            "Transaction removed from plan item",
            "The plan item is open again and can be matched to the right transaction",
            "manual",
            "occurrence",
            match.occurrence_id,
          );
          await persistSnapshot(transaction, principal);
          await bumpRevision(transaction, principal);
          return {
            operation: "transaction.occurrence.unlink",
            resourceId: match.id,
          };
        },
      ),
    );
  }

  listMerchantCategoryRules(
    identity: RequestIdentity,
  ): Promise<MerchantCategoryRulesResponse> {
    return this.tenantDatabase.run(identity, async (transaction, principal) => {
      const rules = await transaction
        .selectFrom("merchant_category_rules")
        .select(["id", "normalized_merchant", "category", "version"])
        .where("household_id", "=", principal.householdId)
        .where("archived_at", "is", null)
        .orderBy("normalized_merchant", "asc")
        .execute();
      return {
        rules: rules.map((rule) => ({
          id: rule.id,
          merchant: rule.normalized_merchant,
          category:
            rule.category as MerchantCategoryRulesResponse["rules"][number]["category"],
          version: rule.version,
        })),
      };
    });
  }

  updateMerchantCategoryRule(
    identity: RequestIdentity,
    ruleId: string,
    request: MerchantCategoryRuleUpdate,
  ): Promise<MerchantCategoryRulesResponse> {
    return this.tenantDatabase
      .run(identity, async (transaction, principal) =>
        idempotent(
          transaction,
          principal.householdId,
          request.requestId,
          "merchant.category.rule.update",
          request,
          async () => {
            requireEditor(principal);
            const result = await transaction
              .updateTable("merchant_category_rules")
              .set({
                category: request.category,
                version: request.expectedVersion + 1,
                actor_user_id: principal.userId,
                updated_at: new Date(),
              })
              .where("household_id", "=", principal.householdId)
              .where("id", "=", ruleId)
              .where("version", "=", request.expectedVersion)
              .where("archived_at", "is", null)
              .returning("id")
              .executeTakeFirst();
            if (!result)
              throw new ConflictException(
                "Category rule changed; refresh and try again",
              );
            await bumpRevision(transaction, principal);
            return {
              operation: "merchant.category.rule.update",
              resourceId: ruleId,
            };
          },
        ),
      )
      .then(() => this.listMerchantCategoryRules(identity));
  }

  deleteMerchantCategoryRule(
    identity: RequestIdentity,
    ruleId: string,
    request: MerchantCategoryRuleDelete,
  ): Promise<MerchantCategoryRulesResponse> {
    return this.tenantDatabase
      .run(identity, async (transaction, principal) =>
        idempotent(
          transaction,
          principal.householdId,
          request.requestId,
          "merchant.category.rule.delete",
          request,
          async () => {
            requireEditor(principal);
            const result = await transaction
              .updateTable("merchant_category_rules")
              .set({
                archived_at: new Date(),
                version: request.expectedVersion + 1,
                updated_at: new Date(),
                actor_user_id: principal.userId,
              })
              .where("household_id", "=", principal.householdId)
              .where("id", "=", ruleId)
              .where("version", "=", request.expectedVersion)
              .where("archived_at", "is", null)
              .returning("id")
              .executeTakeFirst();
            if (!result)
              throw new ConflictException(
                "Category rule changed; refresh and try again",
              );
            await bumpRevision(transaction, principal);
            return {
              operation: "merchant.category.rule.delete",
              resourceId: ruleId,
            };
          },
        ),
      )
      .then(() => this.listMerchantCategoryRules(identity));
  }

  updateManualTransaction(
    identity: RequestIdentity,
    transactionId: string,
    request: ManualTransactionUpdate,
  ): Promise<TransactionFeedResponse> {
    return this.tenantDatabase
      .run(identity, async (transaction, principal) =>
        idempotent(
          transaction,
          principal.householdId,
          request.requestId,
          "manual.transaction.update",
          request,
          async () => {
            requireEditor(principal);
            const household = await transaction
              .selectFrom("households")
              .select("timezone")
              .where("id", "=", principal.householdId)
              .executeTakeFirstOrThrow();
            if (
              request.occurredOn >
              dateInTimezone(new Date(), household.timezone)
            )
              throw new BadRequestException(
                "Recorded activity cannot be dated in the future",
              );
            const entity = await transaction
              .selectFrom("transaction_entities")
              .selectAll()
              .where("household_id", "=", principal.householdId)
              .where("id", "=", transactionId)
              .forUpdate()
              .executeTakeFirst();
            if (!entity) throw new NotFoundException("Transaction not found");
            if (entity.version !== request.expectedVersion)
              throw new ConflictException(
                "Transaction changed; refresh and try again",
              );
            const latest = await transaction
              .selectFrom("financial_transactions")
              .selectAll()
              .where("household_id", "=", principal.householdId)
              .where("transaction_id", "=", transactionId)
              .orderBy("recorded_at", "desc")
              .orderBy("id", "desc")
              .executeTakeFirstOrThrow();
            if (latest.source_kind !== "manual")
              throw new BadRequestException(
                "Connected transactions are updated by the bank",
              );
            if (latest.status === "removed")
              throw new ConflictException(
                "This transaction was already voided",
              );
            await transaction
              .insertInto("financial_transactions")
              .values({
                id: uuidv7(),
                household_id: principal.householdId,
                account_id: latest.account_id,
                source_kind: "manual",
                source_record_id: latest.source_record_id,
                revision: latest.revision + 1,
                merchant: request.merchant,
                amount_minor: request.amount.minor,
                currency: request.amount.currency,
                occurred_on: request.occurredOn,
                status: "posted",
                pending_source_record_id: null,
                source_updated_at: null,
                raw_hash: null,
                direction: request.direction,
                transaction_id: transactionId,
                provider_category_primary: null,
                provider_category_detailed: null,
              })
              .execute();
            await this.setManualCategory(
              transaction,
              principal,
              transactionId,
              request.category,
              request.expectedCategoryVersion,
            );
            await transaction
              .updateTable("transaction_entities")
              .set({ version: entity.version + 1, updated_at: new Date() })
              .where("household_id", "=", principal.householdId)
              .where("id", "=", transactionId)
              .execute();
            await addActivity(
              transaction,
              principal,
              "manual.transaction.updated",
              "Manual transaction corrected",
              `${request.merchant} was updated; its earlier revision was preserved`,
              "manual",
              "transaction",
              transactionId,
            );
            await reconcilePlanEvidence(transaction, principal);
            await persistSnapshot(transaction, principal);
            await bumpRevision(transaction, principal);
            return {
              operation: "manual.transaction.update",
              resourceId: transactionId,
            };
          },
        ),
      )
      .then(() => this.listTransactions(identity, { limit: 30 }));
  }

  voidManualTransaction(
    identity: RequestIdentity,
    transactionId: string,
    request: ManualTransactionVoid,
  ): Promise<TransactionFeedResponse> {
    return this.tenantDatabase
      .run(identity, async (transaction, principal) =>
        idempotent(
          transaction,
          principal.householdId,
          request.requestId,
          "manual.transaction.void",
          request,
          async () => {
            requireEditor(principal);
            const entity = await transaction
              .selectFrom("transaction_entities")
              .selectAll()
              .where("household_id", "=", principal.householdId)
              .where("id", "=", transactionId)
              .forUpdate()
              .executeTakeFirst();
            if (!entity) throw new NotFoundException("Transaction not found");
            if (entity.version !== request.expectedVersion)
              throw new ConflictException(
                "Transaction changed; refresh and try again",
              );
            const latest = await transaction
              .selectFrom("financial_transactions")
              .selectAll()
              .where("household_id", "=", principal.householdId)
              .where("transaction_id", "=", transactionId)
              .orderBy("recorded_at", "desc")
              .orderBy("id", "desc")
              .executeTakeFirstOrThrow();
            if (latest.source_kind !== "manual")
              throw new BadRequestException(
                "Connected transactions are updated by the bank",
              );
            if (latest.status === "removed")
              return {
                operation: "manual.transaction.void",
                resourceId: transactionId,
              };
            await transaction
              .insertInto("financial_transactions")
              .values({
                id: uuidv7(),
                household_id: principal.householdId,
                account_id: latest.account_id,
                source_kind: "manual",
                source_record_id: latest.source_record_id,
                revision: latest.revision + 1,
                merchant: latest.merchant,
                amount_minor: latest.amount_minor,
                currency: latest.currency,
                occurred_on: latest.occurred_on,
                status: "removed",
                pending_source_record_id: null,
                source_updated_at: null,
                raw_hash: null,
                direction: latest.direction,
                transaction_id: transactionId,
                provider_category_primary: null,
                provider_category_detailed: null,
              })
              .execute();
            await transaction
              .updateTable("transaction_entities")
              .set({ version: entity.version + 1, updated_at: new Date() })
              .where("household_id", "=", principal.householdId)
              .where("id", "=", transactionId)
              .execute();
            await addActivity(
              transaction,
              principal,
              "manual.transaction.voided",
              "Manual transaction removed",
              `${latest.merchant} was removed from the active feed; its audit history was preserved`,
              "manual",
              "transaction",
              transactionId,
            );
            await reconcilePlanEvidence(transaction, principal);
            await persistSnapshot(transaction, principal);
            await bumpRevision(transaction, principal);
            return {
              operation: "manual.transaction.void",
              resourceId: transactionId,
            };
          },
        ),
      )
      .then(() => this.listTransactions(identity, { limit: 30 }));
  }

  private async setManualCategory(
    transaction: Transaction<Database>,
    principal: Principal,
    transactionId: string,
    category: ManualTransactionUpdate["category"],
    expectedVersion: number,
  ) {
    const current = await transaction
      .selectFrom("transaction_category_assignments")
      .selectAll()
      .where("household_id", "=", principal.householdId)
      .where("transaction_id", "=", transactionId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (current.version !== expectedVersion)
      throw new ConflictException(
        "Transaction category changed; refresh and try again",
      );
    if (current.category === category && current.source === "user") return;
    const next = current.version + 1;
    await transaction
      .updateTable("transaction_category_assignments")
      .set({
        category,
        source: "user",
        confidence: "high",
        version: next,
        actor_user_id: principal.userId,
        updated_at: new Date(),
      })
      .where("household_id", "=", principal.householdId)
      .where("transaction_id", "=", transactionId)
      .execute();
    await transaction
      .insertInto("transaction_category_revisions")
      .values({
        household_id: principal.householdId,
        transaction_id: transactionId,
        category,
        source: "user",
        confidence: "high",
        version: next,
        actor_user_id: principal.userId,
        reason: "Category changed with manual transaction correction",
      })
      .execute();
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
          if (account.planning_role === "spendable")
            await transaction
              .updateTable("accounts")
              .set((expression) => ({
                include_in_plan: false,
                planning_role: "excluded",
                version: expression("version", "+", 1),
              }))
              .where("household_id", "=", principal.householdId)
              .where("id", "!=", account.id)
              .where("provenance", "=", "manual")
              .where("include_in_plan", "=", true)
              .where("planning_role", "=", "spendable")
              .where("account_type", "in", ["cash", "checking", "savings"])
              .where("archived_at", "is", null)
              .execute();
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
          await reconcilePlanEvidence(transaction, principal);
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
          await persistSnapshot(transaction, principal, {
            externalEligible: true,
          });
          await bumpRevision(transaction, principal);
          return { operation: "manual.balance.create", resourceId: account.id };
        },
      ),
    );
  }

  activateManualMode(
    identity: RequestIdentity,
    request: ManualModeRequest,
  ): Promise<BootstrapResponse> {
    return this.mutateThenRead(identity, async (transaction, principal) =>
      idempotent(
        transaction,
        principal.householdId,
        request.requestId,
        "manual.mode.activate",
        request,
        async () => {
          requireEditor(principal);
          await lockPlanning(transaction, principal);
          const manualAccount = await transaction
            .selectFrom("accounts")
            .select(["id", "include_in_plan", "version"])
            .where("household_id", "=", principal.householdId)
            .where("provenance", "=", "manual")
            .where("account_type", "in", ["cash", "checking", "savings"])
            .where("planning_role", "!=", "protected")
            .where("archived_at", "is", null)
            .orderBy("include_in_plan", "desc")
            .orderBy("created_at", "asc")
            .executeTakeFirst();
          if (!manualAccount)
            throw new ConflictException(
              "A manual cash account is required before switching modes",
            );
          if (!manualAccount.include_in_plan)
            await transaction
              .updateTable("accounts")
              .set({
                include_in_plan: true,
                planning_role: "spendable",
                version: manualAccount.version + 1,
              })
              .where("household_id", "=", principal.householdId)
              .where("id", "=", manualAccount.id)
              .where("version", "=", manualAccount.version)
              .executeTakeFirstOrThrow();
          await transaction
            .updateTable("accounts")
            .set((expression) => ({
              include_in_plan: false,
              planning_role: "excluded",
              version: expression("version", "+", 1),
            }))
            .where("household_id", "=", principal.householdId)
            .where("id", "!=", manualAccount.id)
            .where("provenance", "=", "manual")
            .where("include_in_plan", "=", true)
            .where("planning_role", "=", "spendable")
            .where("account_type", "in", ["cash", "checking", "savings"])
            .where("archived_at", "is", null)
            .execute();
          await transaction
            .updateTable("accounts")
            .set((expression) => ({
              include_in_plan: false,
              planning_role: "excluded",
              version: expression("version", "+", 1),
            }))
            .where("household_id", "=", principal.householdId)
            .where("provenance", "!=", "manual")
            .where("include_in_plan", "=", true)
            .where("planning_role", "=", "spendable")
            .where("archived_at", "is", null)
            .execute();
          await addActivity(
            transaction,
            principal,
            "account.manual_mode.activated",
            "Manual planning activated",
            "Connected accounts remain available but no longer contribute spendable cash",
            "manual",
            "account",
            manualAccount.id,
          );
          await persistSnapshot(transaction, principal);
          await bumpRevision(transaction, principal);
          return {
            operation: "manual.mode.activate",
            resourceId: manualAccount.id,
          };
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
          const household = await transaction
            .selectFrom("households")
            .select("timezone")
            .where("id", "=", principal.householdId)
            .executeTakeFirstOrThrow();
          if (
            request.occurredOn > dateInTimezone(new Date(), household.timezone)
          )
            throw new BadRequestException(
              "Recorded activity cannot be dated in the future",
            );
          const account = await transaction
            .selectFrom("accounts")
            .select([
              "id",
              "provenance",
              "account_type",
              "include_in_plan",
              "planning_role",
            ])
            .where("household_id", "=", principal.householdId)
            .where("id", "=", request.accountId)
            .where("archived_at", "is", null)
            .executeTakeFirst();
          if (!account) throw new NotFoundException("Account not found");
          const transactionId = uuidv7();
          const evidenceId = uuidv7();
          await transaction
            .insertInto("transaction_entities")
            .values({
              id: transactionId,
              household_id: principal.householdId,
              account_id: account.id,
            })
            .execute();
          await transaction
            .insertInto("transaction_source_aliases")
            .values({
              household_id: principal.householdId,
              transaction_id: transactionId,
              account_id: account.id,
              source_kind: "manual",
              source_record_id: request.requestId,
            })
            .execute();
          await transaction
            .insertInto("financial_transactions")
            .values({
              id: evidenceId,
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
              direction: request.direction,
              transaction_id: transactionId,
              provider_category_primary: null,
              provider_category_detailed: null,
            })
            .execute();
          const merchantRule =
            request.category === "uncategorized"
              ? await transaction
                  .selectFrom("merchant_category_rules")
                  .select("category")
                  .where("household_id", "=", principal.householdId)
                  .where(
                    "normalized_merchant",
                    "=",
                    normalizeMerchantRule(request.merchant),
                  )
                  .where("archived_at", "is", null)
                  .executeTakeFirst()
              : null;
          const assignedCategory = merchantRule?.category ?? request.category;
          const assignedSource = merchantRule
            ? "merchant_rule"
            : request.category === "uncategorized"
              ? "deterministic"
              : "user";
          const categoryConfidence =
            assignedSource === "deterministic" ? "low" : "high";
          await transaction
            .insertInto("transaction_category_assignments")
            .values({
              household_id: principal.householdId,
              transaction_id: transactionId,
              category: assignedCategory,
              source: assignedSource,
              confidence: categoryConfidence,
              actor_user_id:
                assignedSource === "deterministic" ? null : principal.userId,
            })
            .execute();
          await transaction
            .insertInto("transaction_category_revisions")
            .values({
              household_id: principal.householdId,
              transaction_id: transactionId,
              category: assignedCategory,
              source: assignedSource,
              confidence: categoryConfidence,
              version: 1,
              actor_user_id:
                assignedSource === "deterministic" ? null : principal.userId,
              reason:
                assignedSource === "deterministic"
                  ? "No category selected when activity was recorded"
                  : "Category selected when activity was recorded",
            })
            .execute();
          if (request.occurrenceId) {
            await sql`select pg_advisory_xact_lock(hashtextextended(${principal.householdId}, 7241))`.execute(
              transaction,
            );
            const occurrence = await transaction
              .selectFrom("plan_occurrences")
              .selectAll()
              .where("household_id", "=", principal.householdId)
              .where("id", "=", request.occurrenceId)
              .where("state", "in", [
                "expected",
                "pending",
                "partial",
                "overdue",
                "needs_review",
              ])
              .forUpdate()
              .executeTakeFirst();
            if (!occurrence)
              throw new ConflictException(
                "The selected plan occurrence is no longer open",
              );
            const savingsGoal = occurrence.savings_goal_id
              ? await transaction
                  .selectFrom("savings_goals")
                  .select("destination_account_id")
                  .where("household_id", "=", principal.householdId)
                  .where("id", "=", occurrence.savings_goal_id)
                  .where("status", "!=", "archived")
                  .executeTakeFirst()
              : null;
            const incomeSchedule = occurrence.income_schedule_id
              ? await transaction
                  .selectFrom("income_schedules")
                  .select("destination_account_id")
                  .where("household_id", "=", principal.householdId)
                  .where("id", "=", occurrence.income_schedule_id)
                  .where("status", "!=", "archived")
                  .executeTakeFirst()
              : null;
            const usableSavingsDestination =
              occurrence.kind === "savings" &&
              savingsGoal?.destination_account_id === account.id &&
              account.planning_role === "protected";
            const usableIncomeDestination =
              occurrence.kind === "income" &&
              account.planning_role === "protected" &&
              (!incomeSchedule?.destination_account_id ||
                incomeSchedule.destination_account_id === account.id);
            const wrongIncomeDestination =
              occurrence.kind === "income" &&
              Boolean(incomeSchedule?.destination_account_id) &&
              incomeSchedule?.destination_account_id !== account.id;
            if (
              wrongIncomeDestination ||
              !["cash", "checking", "savings"].includes(account.account_type) ||
              (!usableSavingsDestination &&
                !usableIncomeDestination &&
                account.planning_role !== "spendable")
            )
              throw new ConflictException(
                occurrence.kind === "savings"
                  ? "Savings proof must arrive in this goal’s protected destination account"
                  : occurrence.kind === "income"
                    ? "Income proof must use its selected destination or a spendable account"
                    : "Plan evidence must use an included spendable cash account",
              );
            const expectedDirection =
              occurrence.kind === "income" || occurrence.kind === "savings"
                ? "credit"
                : "debit";
            if (request.direction !== expectedDirection)
              throw new ConflictException(
                "The activity direction does not match the selected plan item",
              );
            const allocated = await activeConfirmedAllocation(
              transaction,
              principal.householdId,
              occurrence.id,
            );
            const remaining =
              occurrence.expected_amount_minor === null
                ? allocated === 0n
                  ? BigInt(request.amount.minor)
                  : 0n
                : BigInt(occurrence.expected_amount_minor) - allocated;
            if (remaining <= 0n)
              throw new ConflictException(
                "This plan item already has enough recorded evidence",
              );
            const applied =
              BigInt(request.amount.minor) < remaining
                ? request.amount.minor
                : remaining.toString();
            const reflectedBalance = request.balanceIncludesActivity
              ? await transaction
                  .selectFrom("balance_observations")
                  .select("id")
                  .where("household_id", "=", principal.householdId)
                  .where("account_id", "=", account.id)
                  .orderBy("recorded_at", "desc")
                  .executeTakeFirst()
              : null;
            const match = await transaction
              .insertInto("occurrence_transaction_matches")
              .values({
                household_id: principal.householdId,
                occurrence_id: occurrence.id,
                transaction_id: evidenceId,
                reflected_in_balance_observation_id:
                  reflectedBalance?.id ?? null,
                amount_applied_minor: applied,
                state: "confirmed",
                confidence: "1.000",
                reason: request.balanceIncludesActivity
                  ? "User linked the charge and confirmed the current balance includes it"
                  : "User linked the charge; awaiting a current balance update",
                actor_user_id: principal.userId,
                resolved_at: new Date(),
              })
              .returningAll()
              .executeTakeFirstOrThrow();
            await transaction
              .insertInto("occurrence_match_revisions")
              .values({
                household_id: principal.householdId,
                match_id: match.id,
                version: match.version,
                state: match.state,
                amount_applied_minor: match.amount_applied_minor,
                reflected_in_balance_observation_id:
                  match.reflected_in_balance_observation_id,
                reason: match.reason,
                actor_user_id: principal.userId,
              })
              .execute();
          }
          await reconcilePlanEvidence(transaction, principal);
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
          await persistSnapshot(transaction, principal);
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
              recurrence:
                request.recurrence === "one_time" ? null : request.recurrence,
              ...anchorColumns("recurrence", request.dueDate),
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
          const plan = await transaction
            .selectFrom("plans")
            .selectAll()
            .where("household_id", "=", principal.householdId)
            .executeTakeFirstOrThrow();
          await synchronizePlanOccurrences(transaction, principal, plan);
          await persistSnapshot(transaction, principal);
          await bumpRevision(transaction, principal);
          return { operation: "commitment.create", resourceId: commitmentId };
        },
      ),
    );
  }

  addDebt(
    identity: RequestIdentity,
    request: DebtCreateRequest,
  ): Promise<BootstrapResponse> {
    return this.mutateThenRead(identity, async (transaction, principal) =>
      idempotent(
        transaction,
        principal.householdId,
        request.requestId,
        "debt.create",
        request,
        async () => {
          requireEditor(principal);
          await lockPlanning(transaction, principal);
          if (request.createPaymentCommitment && request.linkedCommitmentId)
            throw new ConflictException(
              "Choose an existing payment or create a new one, not both",
            );
          let account = request.accountId
            ? await transaction
                .selectFrom("accounts")
                .selectAll()
                .where("household_id", "=", principal.householdId)
                .where("id", "=", request.accountId)
                .where("archived_at", "is", null)
                .executeTakeFirst()
            : null;
          if (
            request.accountId &&
            (!account || !["credit", "loan"].includes(account.account_type))
          )
            throw new ConflictException(
              "Choose an available credit or loan account",
            );
          if (!account) {
            account = await transaction
              .insertInto("accounts")
              .values({
                household_id: principal.householdId,
                name: request.name,
                account_type:
                  request.type === "credit_card" ? "credit" : "loan",
                currency: "USD",
                provenance: "manual",
                provider_account_id: null,
                provider_account_fingerprint: null,
                connection_id: null,
                include_in_plan: false,
                planning_role: "excluded",
                archived_at: null,
              })
              .returningAll()
              .executeTakeFirstOrThrow();
          }
          const duplicate = await transaction
            .selectFrom("debts")
            .select("id")
            .where("household_id", "=", principal.householdId)
            .where("account_id", "=", account.id)
            .where("status", "!=", "archived")
            .executeTakeFirst();
          if (duplicate)
            throw new ConflictException(
              "This account is already tracked as debt",
            );
          const payment = await resolveDebtCommitment(
            transaction,
            principal,
            request,
            null,
          );
          const debt = await transaction
            .insertInto("debts")
            .values({
              household_id: principal.householdId,
              account_id: account.id,
              linked_commitment_id: payment.id,
              payment_commitment_managed: payment.managed,
              name: request.name,
              debt_type: request.type,
              status: "active",
              provenance: account.provenance === "plaid" ? "plaid" : "manual",
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await appendDebtRevision(
            transaction,
            principal,
            debt,
            "Debt tracking created",
          );
          if (request.currentBalance)
            await insertManualDebtBalance(
              transaction,
              principal,
              debt.id,
              request.currentBalance.minor,
              request.requestId,
            );
          await insertDebtTermsAndApr(
            transaction,
            principal,
            debt.id,
            request,
            request.requestId,
          );
          await upsertDebtPaymentPolicy(
            transaction,
            principal,
            debt.id,
            request,
            "Debt payment plan created",
          );
          const plan = await transaction
            .selectFrom("plans")
            .selectAll()
            .where("household_id", "=", principal.householdId)
            .executeTakeFirstOrThrow();
          await synchronizePlanOccurrences(transaction, principal, plan);
          await addActivity(
            transaction,
            principal,
            "debt.created",
            `${debt.name} debt added`,
            payment.id
              ? "Payment is included once in your plan"
              : "Balance tracked; no payment is reserved yet",
            "manual",
            "debt",
            debt.id,
          );
          await persistSnapshot(transaction, principal);
          await bumpRevision(transaction, principal);
          return { operation: "debt.create", resourceId: debt.id };
        },
      ),
    );
  }

  addIncomeSchedule(
    identity: RequestIdentity,
    request: IncomeScheduleCreateRequest,
  ): Promise<BootstrapResponse> {
    return this.mutateThenRead(identity, async (transaction, principal) =>
      idempotent(
        transaction,
        principal.householdId,
        request.requestId,
        "income.schedule.create",
        request,
        async () => {
          requireEditor(principal);
          await lockPlanning(transaction, principal);
          await validateIncomeDestination(
            transaction,
            principal,
            request.destinationAccountId,
          );
          const anchor = incomeAnchorColumns(
            request.nextExpectedDate,
            request.anchorDay,
            request.anchorEndOfMonth,
          );
          const schedule = await transaction
            .insertInto("income_schedules")
            .values({
              household_id: principal.householdId,
              destination_account_id: request.destinationAccountId,
              name: request.name,
              expected_amount_minor: request.expectedAmount?.minor ?? null,
              currency: "USD",
              frequency: request.frequency,
              next_expected_date: request.nextExpectedDate,
              confirmed: request.confirmed,
              status: "active",
              anchor_day: anchor.day,
              anchor_eom: anchor.eom,
              second_anchor_day:
                request.frequency === "semi_monthly"
                  ? request.secondAnchorDay
                  : null,
              second_anchor_eom:
                request.frequency === "semi_monthly" &&
                request.secondAnchorEndOfMonth,
              review_reason: null,
              provenance: "manual",
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await appendIncomeScheduleRevision(
            transaction,
            principal,
            schedule,
            "Income schedule created",
          );
          const plan = await transaction
            .selectFrom("plans")
            .selectAll()
            .where("household_id", "=", principal.householdId)
            .executeTakeFirstOrThrow();
          await synchronizePlanOccurrences(transaction, principal, plan);
          await addActivity(
            transaction,
            principal,
            "income.schedule.created",
            `${schedule.name} income added`,
            schedule.confirmed
              ? `Used for planning from ${request.nextExpectedDate}`
              : "Saved without changing the planning horizon",
            "manual",
            "income_schedule",
            schedule.id,
          );
          await persistSnapshot(transaction, principal);
          await bumpRevision(transaction, principal);
          return {
            operation: "income.schedule.create",
            resourceId: schedule.id,
          };
        },
      ),
    );
  }

  updateIncomeSchedule(
    identity: RequestIdentity,
    scheduleId: string,
    request: IncomeScheduleUpdateRequest,
  ): Promise<BootstrapResponse> {
    return this.mutateThenRead(identity, async (transaction, principal) =>
      idempotent(
        transaction,
        principal.householdId,
        request.requestId,
        "income.schedule.update",
        { scheduleId, ...request },
        async () => {
          requireEditor(principal);
          await lockPlanning(transaction, principal);
          await validateIncomeDestination(
            transaction,
            principal,
            request.destinationAccountId,
          );
          const current = await transaction
            .selectFrom("income_schedules")
            .selectAll()
            .where("household_id", "=", principal.householdId)
            .where("id", "=", scheduleId)
            .where("version", "=", request.expectedVersion)
            .where("status", "!=", "archived")
            .forUpdate()
            .executeTakeFirst();
          if (!current)
            throw new ConflictException(
              "This income schedule changed; refresh before saving",
            );
          const status = request.status;
          const confirmed = status === "active" ? request.confirmed : false;
          const anchor = incomeAnchorColumns(
            request.nextExpectedDate,
            request.anchorDay,
            request.anchorEndOfMonth,
          );
          const updated = await transaction
            .updateTable("income_schedules")
            .set({
              destination_account_id: request.destinationAccountId,
              name: request.name,
              expected_amount_minor: request.expectedAmount?.minor ?? null,
              frequency: request.frequency,
              next_expected_date: request.nextExpectedDate,
              confirmed,
              status,
              anchor_day: anchor.day,
              anchor_eom: anchor.eom,
              second_anchor_day:
                request.frequency === "semi_monthly"
                  ? request.secondAnchorDay
                  : null,
              second_anchor_eom:
                request.frequency === "semi_monthly" &&
                request.secondAnchorEndOfMonth,
              review_reason: null,
              advanced_from_occurrence_id: null,
              previous_expected_date: null,
              version: current.version + 1,
              updated_at: new Date(),
            })
            .where("household_id", "=", principal.householdId)
            .where("id", "=", scheduleId)
            .where("version", "=", current.version)
            .returningAll()
            .executeTakeFirstOrThrow();
          await appendIncomeScheduleRevision(
            transaction,
            principal,
            updated,
            status === "archived"
              ? "Income schedule archived"
              : status === "paused"
                ? "Income schedule paused"
                : "Income schedule updated",
          );
          const plan = await transaction
            .selectFrom("plans")
            .selectAll()
            .where("household_id", "=", principal.householdId)
            .executeTakeFirstOrThrow();
          await synchronizePlanOccurrences(transaction, principal, plan);
          await addActivity(
            transaction,
            principal,
            `income.schedule.${status === "active" ? "updated" : status}`,
            `${updated.name} ${status === "active" ? "income updated" : status}`,
            confirmed
              ? `Next expected ${request.nextExpectedDate}`
              : "Not used to shorten the plan",
            "manual",
            "income_schedule",
            scheduleId,
          );
          await persistSnapshot(transaction, principal);
          await bumpRevision(transaction, principal);
          return {
            operation: "income.schedule.update",
            resourceId: scheduleId,
          };
        },
      ),
    );
  }

  updateDebt(
    identity: RequestIdentity,
    debtId: string,
    request: DebtUpdateRequest,
  ): Promise<BootstrapResponse> {
    return this.mutateThenRead(identity, async (transaction, principal) =>
      idempotent(
        transaction,
        principal.householdId,
        request.requestId,
        "debt.update",
        { debtId, ...request },
        async () => {
          requireEditor(principal);
          await lockPlanning(transaction, principal);
          if (request.createPaymentCommitment && request.linkedCommitmentId)
            throw new ConflictException(
              "Choose an existing payment or create a new one, not both",
            );
          const current = await transaction
            .selectFrom("debts")
            .selectAll()
            .where("household_id", "=", principal.householdId)
            .where("id", "=", debtId)
            .where("version", "=", request.expectedVersion)
            .where("status", "!=", "archived")
            .forUpdate()
            .executeTakeFirst();
          if (!current)
            throw new ConflictException(
              "This debt changed; refresh before saving",
            );
          const account = await transaction
            .selectFrom("accounts")
            .selectAll()
            .where("household_id", "=", principal.householdId)
            .where("id", "=", current.account_id)
            .executeTakeFirstOrThrow();
          if (request.currentBalance && account.provenance !== "manual")
            throw new ConflictException(
              "Connected debt balances update from the bank",
            );
          const payment = await resolveDebtCommitment(
            transaction,
            principal,
            request,
            current,
          );
          const updated = await transaction
            .updateTable("debts")
            .set({
              linked_commitment_id: payment.id,
              payment_commitment_managed: payment.managed,
              name: request.name,
              debt_type: request.type,
              status: request.status,
              version: current.version + 1,
              updated_at: new Date(),
            })
            .where("household_id", "=", principal.householdId)
            .where("id", "=", debtId)
            .where("version", "=", current.version)
            .returningAll()
            .executeTakeFirstOrThrow();
          await appendDebtRevision(
            transaction,
            principal,
            updated,
            request.status === "archived"
              ? "Debt archived"
              : "Debt tracking updated",
          );
          if (request.currentBalance)
            await insertManualDebtBalance(
              transaction,
              principal,
              debtId,
              request.currentBalance.minor,
              request.requestId,
            );
          await insertDebtTermsAndApr(
            transaction,
            principal,
            debtId,
            request,
            request.requestId,
          );
          await upsertDebtPaymentPolicy(
            transaction,
            principal,
            debtId,
            request,
            "Debt payment plan updated",
          );
          const plan = await transaction
            .selectFrom("plans")
            .selectAll()
            .where("household_id", "=", principal.householdId)
            .executeTakeFirstOrThrow();
          await synchronizePlanOccurrences(transaction, principal, plan);
          await addActivity(
            transaction,
            principal,
            "debt.updated",
            `${updated.name} debt updated`,
            payment.id
              ? "Payment remains included once in your plan"
              : "No payment is currently reserved",
            "manual",
            "debt",
            debtId,
          );
          await persistSnapshot(transaction, principal);
          await bumpRevision(transaction, principal);
          return { operation: "debt.update", resourceId: debtId };
        },
      ),
    );
  }

  addSavingsGoal(
    identity: RequestIdentity,
    request: SavingsGoalCreateRequest,
  ): Promise<BootstrapResponse> {
    return this.mutateThenRead(identity, async (transaction, principal) =>
      idempotent(
        transaction,
        principal.householdId,
        request.requestId,
        "savings.goal.create",
        request,
        async () => {
          requireEditor(principal);
          await lockPlanning(transaction, principal);
          let destinationAccountId = request.destinationAccountId;
          if (request.trackManually) {
            destinationAccountId = (
              await transaction
                .insertInto("accounts")
                .values({
                  household_id: principal.householdId,
                  name: `${request.name} savings`,
                  account_type: "savings",
                  currency: "USD",
                  provenance: "manual",
                  provider_account_id: null,
                  provider_account_fingerprint: null,
                  connection_id: null,
                  include_in_plan: false,
                  planning_role: "protected",
                  archived_at: null,
                })
                .returning("id")
                .executeTakeFirstOrThrow()
            ).id;
          }
          const destination = destinationAccountId
            ? await requireSavingsDestination(
                transaction,
                principal,
                destinationAccountId,
              )
            : null;
          const destinationTrackingStartedAt = destination
            ? await initialSavingsTrackingStart(transaction, destination)
            : null;
          const goal = await transaction
            .insertInto("savings_goals")
            .values({
              household_id: principal.householdId,
              destination_account_id: destinationAccountId,
              destination_prior_planning_role: request.trackManually
                ? "excluded"
                : destination
                  ? destination.planning_role
                  : null,
              destination_tracking_started_at: destinationTrackingStartedAt,
              name: request.name,
              target_amount_minor: request.targetAmount?.minor ?? null,
              target_date: request.targetDate,
              contribution_amount_minor: request.contributionAmount.minor,
              schedule: request.schedule,
              next_due_on: request.nextDueOn,
              status: "active",
              currency: "USD",
              provenance: "manual",
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await appendSavingsGoalRevision(
            transaction,
            principal,
            goal,
            "Savings goal created",
          );
          if (destination) {
            await protectSavingsDestination(transaction, destination);
            if (request.useCurrentDestinationBalance) {
              const balance = await latestUsableBalance(
                transaction,
                principal.householdId,
                destination.id,
              );
              if (!balance)
                throw new ConflictException(
                  "This account needs a current balance before it can become goal progress",
                );
              if (BigInt(balance.amount_minor) > 0n)
                await createSavingsMovement(transaction, principal, {
                  goalId: goal.id,
                  kind: "opening_allocation",
                  amountMinor: balance.amount_minor,
                  effectiveOn: dateInTimezone(
                    balance.as_of,
                    (
                      await transaction
                        .selectFrom("households")
                        .select("timezone")
                        .where("id", "=", principal.householdId)
                        .executeTakeFirstOrThrow()
                    ).timezone,
                  ),
                  verificationMethod:
                    destination.provenance === "plaid"
                      ? "provider_verified"
                      : "user_confirmed",
                  provenance:
                    destination.provenance === "plaid" ? "plaid" : "manual",
                  occurrence: null,
                  reversedMovementId: null,
                  evidence: [
                    {
                      role:
                        destination.provenance === "plaid"
                          ? "destination_balance"
                          : "manual_balance",
                      balanceObservationId: balance.id,
                    },
                  ],
                });
            }
          }
          const plan = await refreshSavingsPlanAggregate(
            transaction,
            principal,
          );
          await synchronizePlanOccurrences(transaction, principal, plan);
          await addActivity(
            transaction,
            principal,
            "savings.goal.created",
            `${goal.name} goal created`,
            destination
              ? `${destination.name} is protected from safe-to-spend`
              : "No destination account selected; progress is not yet verified",
            "manual",
            "savings_goal",
            goal.id,
          );
          await persistSnapshot(transaction, principal);
          await bumpRevision(transaction, principal);
          return { operation: "savings.goal.create", resourceId: goal.id };
        },
      ),
    );
  }

  updateSavingsGoal(
    identity: RequestIdentity,
    goalId: string,
    request: SavingsGoalUpdateRequest,
  ): Promise<BootstrapResponse> {
    return this.mutateThenRead(identity, async (transaction, principal) =>
      idempotent(
        transaction,
        principal.householdId,
        request.requestId,
        "savings.goal.update",
        { goalId, ...request },
        async () => {
          requireEditor(principal);
          await lockPlanning(transaction, principal);
          const current = await transaction
            .selectFrom("savings_goals")
            .selectAll()
            .where("household_id", "=", principal.householdId)
            .where("id", "=", goalId)
            .where("version", "=", request.expectedVersion)
            .where("status", "!=", "archived")
            .forUpdate()
            .executeTakeFirst();
          if (!current)
            throw new ConflictException(
              "This savings goal changed; refresh before saving",
            );
          const destination = request.destinationAccountId
            ? await requireSavingsDestination(
                transaction,
                principal,
                request.destinationAccountId,
                goalId,
              )
            : null;
          const destinationChanged =
            current.destination_account_id !== request.destinationAccountId;
          if (request.useCurrentDestinationBalance && !destinationChanged)
            throw new ConflictException(
              "Opening balance can only be used when choosing a new destination",
            );
          const nextPriorRole = destinationChanged
            ? (destination?.planning_role ?? null)
            : current.destination_prior_planning_role;
          const nextTrackingStart = destinationChanged
            ? destination
              ? await initialSavingsTrackingStart(transaction, destination)
              : null
            : current.destination_tracking_started_at;
          const updated = await transaction
            .updateTable("savings_goals")
            .set({
              destination_account_id: request.destinationAccountId,
              destination_prior_planning_role: nextPriorRole,
              destination_tracking_started_at: nextTrackingStart,
              name: request.name,
              target_amount_minor: request.targetAmount?.minor ?? null,
              target_date: request.targetDate,
              contribution_amount_minor: request.contributionAmount.minor,
              schedule: request.schedule,
              next_due_on: request.nextDueOn,
              status: request.status,
              version: current.version + 1,
              updated_at: new Date(),
            })
            .where("household_id", "=", principal.householdId)
            .where("id", "=", goalId)
            .where("version", "=", current.version)
            .returningAll()
            .executeTakeFirstOrThrow();
          if (
            current.destination_account_id &&
            (destinationChanged || request.status === "archived")
          )
            await restoreSavingsDestination(
              transaction,
              principal.householdId,
              current.destination_account_id,
              current.destination_prior_planning_role,
            );
          if (destination && request.status !== "archived")
            await protectSavingsDestination(transaction, destination);
          if (
            destination &&
            request.status !== "archived" &&
            request.useCurrentDestinationBalance
          ) {
            const balance = await latestUsableBalance(
              transaction,
              principal.householdId,
              destination.id,
            );
            if (!balance)
              throw new ConflictException(
                "This account needs a current balance before it can become goal progress",
              );
            const currentProgress = await savingsGoalProgress(
              transaction,
              principal.householdId,
              goalId,
            );
            const delta = BigInt(balance.amount_minor) - currentProgress;
            if (delta !== 0n)
              await createSavingsMovement(transaction, principal, {
                goalId,
                kind:
                  currentProgress === 0n && delta > 0n
                    ? "opening_allocation"
                    : delta > 0n
                      ? "contribution"
                      : "withdrawal",
                amountMinor: (delta > 0n ? delta : -delta).toString(),
                effectiveOn: dateInTimezone(
                  balance.as_of,
                  (
                    await transaction
                      .selectFrom("households")
                      .select("timezone")
                      .where("id", "=", principal.householdId)
                      .executeTakeFirstOrThrow()
                  ).timezone,
                ),
                verificationMethod:
                  destination.provenance === "plaid"
                    ? "provider_verified"
                    : "user_confirmed",
                provenance:
                  destination.provenance === "plaid" ? "plaid" : "manual",
                occurrence: null,
                reversedMovementId: null,
                evidence: [
                  {
                    role:
                      destination.provenance === "plaid"
                        ? "destination_balance"
                        : "manual_balance",
                    balanceObservationId: balance.id,
                  },
                ],
              });
          }
          await appendSavingsGoalRevision(
            transaction,
            principal,
            updated,
            request.status === "archived"
              ? "Savings goal archived"
              : "Savings goal updated",
          );
          const plan = await refreshSavingsPlanAggregate(
            transaction,
            principal,
          );
          await synchronizePlanOccurrences(transaction, principal, plan);
          await addActivity(
            transaction,
            principal,
            `savings.goal.${request.status === "active" ? "updated" : request.status}`,
            `${updated.name} goal ${request.status === "active" ? "updated" : request.status}`,
            `Plan contribution is $${minorToDecimal(updated.contribution_amount_minor)}`,
            "manual",
            "savings_goal",
            updated.id,
          );
          await persistSnapshot(transaction, principal);
          await bumpRevision(transaction, principal);
          return { operation: "savings.goal.update", resourceId: goalId };
        },
      ),
    );
  }

  updateSavingsGoalBalance(
    identity: RequestIdentity,
    goalId: string,
    request: SavingsGoalBalanceUpdateRequest,
  ): Promise<BootstrapResponse> {
    return this.mutateThenRead(identity, async (transaction, principal) =>
      idempotent(
        transaction,
        principal.householdId,
        request.requestId,
        "savings.goal.balance.update",
        { goalId, ...request },
        async () => {
          requireEditor(principal);
          await lockPlanning(transaction, principal);
          const goal = await transaction
            .selectFrom("savings_goals")
            .selectAll()
            .where("household_id", "=", principal.householdId)
            .where("id", "=", goalId)
            .where("version", "=", request.expectedGoalVersion)
            .where("status", "!=", "archived")
            .executeTakeFirst();
          if (!goal?.destination_account_id)
            throw new ConflictException(
              "Choose a manual savings destination before updating progress",
            );
          const account = await transaction
            .selectFrom("accounts")
            .selectAll()
            .where("household_id", "=", principal.householdId)
            .where("id", "=", goal.destination_account_id)
            .where("archived_at", "is", null)
            .executeTakeFirst();
          if (!account || account.provenance !== "manual")
            throw new ConflictException(
              "Connected savings progress is updated by verified bank data",
            );
          const previous = await latestUsableBalance(
            transaction,
            principal.householdId,
            account.id,
          );
          if (
            previous &&
            previous.as_of.getTime() > new Date(request.asOf).getTime()
          )
            throw new ConflictException(
              "This goal already has a newer balance; refresh before saving",
            );
          const observation = await transaction
            .insertInto("balance_observations")
            .values({
              household_id: principal.householdId,
              account_id: account.id,
              amount_minor: request.balance.minor,
              currency: "USD",
              provenance: "manual",
              as_of: request.asOf,
              source_record_id: request.requestId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          const before = BigInt(previous?.amount_minor ?? "0");
          const after = BigInt(request.balance.minor);
          const delta = after - before;
          if (delta !== 0n)
            await createSavingsMovement(transaction, principal, {
              goalId,
              kind: delta > 0n ? "contribution" : "withdrawal",
              amountMinor: (delta > 0n ? delta : -delta).toString(),
              effectiveOn: dateInTimezone(
                new Date(request.asOf),
                (
                  await transaction
                    .selectFrom("households")
                    .select("timezone")
                    .where("id", "=", principal.householdId)
                    .executeTakeFirstOrThrow()
                ).timezone,
              ),
              verificationMethod: "user_confirmed",
              provenance: "manual",
              occurrence: null,
              reversedMovementId: null,
              evidence: [
                {
                  role: "manual_balance",
                  balanceObservationId: observation.id,
                },
              ],
            });
          await reconcilePlanEvidence(transaction, principal);
          await addActivity(
            transaction,
            principal,
            "savings.balance.confirmed",
            `${goal.name} balance confirmed by you`,
            `$${minorToDecimal(request.balance.minor)} as of today`,
            "manual",
            "savings_goal",
            goal.id,
          );
          await persistSnapshot(transaction, principal);
          await bumpRevision(transaction, principal);
          return {
            operation: "savings.goal.balance.update",
            resourceId: goalId,
          };
        },
      ),
    );
  }

  skipPlanOccurrence(
    identity: RequestIdentity,
    occurrenceId: string,
    request: OccurrenceSkipRequest,
  ): Promise<BootstrapResponse> {
    return this.mutateThenRead(identity, async (transaction, principal) =>
      idempotent(
        transaction,
        principal.householdId,
        request.requestId,
        "occurrence.skip",
        { occurrenceId, ...request },
        async () => {
          requireEditor(principal);
          await sql`select pg_advisory_xact_lock(hashtextextended(${principal.householdId}, 7241))`.execute(
            transaction,
          );
          const occurrence = await transaction
            .selectFrom("plan_occurrences")
            .selectAll()
            .where("household_id", "=", principal.householdId)
            .where("id", "=", occurrenceId)
            .where("version", "=", request.expectedVersion)
            .where("kind", "in", ["commitment", "savings"])
            .where("state", "in", [
              "expected",
              "pending",
              "partial",
              "overdue",
              "needs_review",
            ])
            .forUpdate()
            .executeTakeFirst();
          if (!occurrence)
            throw new ConflictException(
              "This plan item changed or is no longer open; refresh and try again",
            );
          await skipOccurrence(
            transaction,
            principal,
            occurrence,
            "User marked this occurrence as not due",
          );
          await addActivity(
            transaction,
            principal,
            "occurrence.skipped",
            `${occurrence.name} ${occurrence.kind === "savings" ? "contribution" : "payment"} skipped`,
            `${toDateOnly(occurrence.expected_on)} was removed from the active reserve; the recurring rule remains active`,
            "manual",
            "occurrence",
            occurrence.id,
          );
          await persistSnapshot(transaction, principal);
          await bumpRevision(transaction, principal);
          return { operation: "occurrence.skip", resourceId: occurrence.id };
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
          await lockPlanning(transaction, principal);
          await syncLegacySavingsInput(
            transaction,
            principal,
            request.plannedSavings.minor,
          );
          const updated = await transaction
            .updateTable("plans")
            .set({
              planned_savings_minor: request.plannedSavings.minor,
              safety_buffer_minor: request.safetyBuffer.minor,
              ...(request.fallbackHorizonDays
                ? { fallback_horizon_days: request.fallbackHorizonDays }
                : {}),
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
              income_amount_minor: current.income_amount_minor,
              income_frequency: current.income_frequency,
              next_income_date: current.next_income_date,
              income_confirmed: current.income_confirmed,
              income_source_name: current.income_source_name,
              fallback_horizon_days: current.fallback_horizon_days,
              policy_version: current.calculation_policy_version,
              actor_user_id: principal.userId,
            })
            .execute();
          await synchronizePlanOccurrences(transaction, principal, current);
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
          const protectedGoal = await transaction
            .selectFrom("savings_goals")
            .select("id")
            .where("household_id", "=", principal.householdId)
            .where("destination_account_id", "=", accountId)
            .where("status", "!=", "archived")
            .executeTakeFirst();
          if (protectedGoal)
            throw new ConflictException(
              "Manage this protected account from its savings goal",
            );
          const updated = await transaction
            .updateTable("accounts")
            .set({
              include_in_plan: request.includeInPlan,
              planning_role: request.includeInPlan ? "spendable" : "excluded",
              version: request.expectedVersion + 1,
            })
            .where("household_id", "=", principal.householdId)
            .where("id", "=", accountId)
            .where("version", "=", request.expectedVersion)
            .where("archived_at", "is", null)
            .where("account_type", "in", ["cash", "checking", "savings"])
            .returning(["id", "version", "provenance"])
            .executeTakeFirst();
          if (!updated)
            throw new ConflictException(
              "Account changed, is unavailable, or cannot be included in planning",
            );
          let removedUnusedManual = false;
          if (request.includeInPlan && updated.provenance === "plaid") {
            const result = await sql<{ id: string }>`
              update accounts manual_account
              set include_in_plan = false,
                  planning_role = 'excluded',
                  version = manual_account.version + 1
              where manual_account.household_id = ${principal.householdId}
                and manual_account.provenance = 'manual'
                and manual_account.include_in_plan = true
                and manual_account.archived_at is null
                and manual_account.account_type in ('cash', 'checking', 'savings')
                and not exists (
                  select 1
                  from balance_observations observation
                  where observation.household_id = manual_account.household_id
                    and observation.account_id = manual_account.id
                    and not (
                      observation.provenance = 'manual'
                      and observation.source_record_id = 'provisioned'
                    )
                )
                and not exists (
                  select 1
                  from financial_transactions entry
                  where entry.household_id = manual_account.household_id
                    and entry.account_id = manual_account.id
                )
              returning manual_account.id
            `.execute(transaction);
            removedUnusedManual = result.rows.length > 0;
          }
          if (request.includeInPlan && updated.provenance === "manual") {
            const connectedSpendable = await transaction
              .selectFrom("accounts")
              .select("id")
              .where("household_id", "=", principal.householdId)
              .where("provenance", "!=", "manual")
              .where("include_in_plan", "=", true)
              .where("planning_role", "=", "spendable")
              .where("account_type", "in", ["cash", "checking", "savings"])
              .where("archived_at", "is", null)
              .executeTakeFirst();
            if (connectedSpendable)
              throw new ConflictException(
                "Use the manual-values switch so connected cash is removed safely",
              );
            await transaction
              .updateTable("accounts")
              .set((expression) => ({
                include_in_plan: false,
                planning_role: "excluded",
                version: expression("version", "+", 1),
              }))
              .where("household_id", "=", principal.householdId)
              .where("id", "!=", updated.id)
              .where("provenance", "=", "manual")
              .where("include_in_plan", "=", true)
              .where("planning_role", "=", "spendable")
              .where("account_type", "in", ["cash", "checking", "savings"])
              .where("archived_at", "is", null)
              .execute();
          }
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
          if (removedUnusedManual) {
            await addActivity(
              transaction,
              principal,
              "account.manual_placeholder.excluded",
              "Unused manual account excluded",
              "Connected balances now own plan coverage; no manual balance or activity was removed",
              "derived",
              "account",
              updated.id,
            );
          }
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

  setAccountPlanningRole(
    identity: RequestIdentity,
    accountId: string,
    request: AccountPlanningRoleRequest,
  ): Promise<BootstrapResponse> {
    return this.mutateThenRead(identity, async (transaction, principal) =>
      idempotent(
        transaction,
        principal.householdId,
        request.requestId,
        "account.planning-role.update",
        { accountId, ...request },
        async () => {
          requireEditor(principal);
          await lockPlanning(transaction, principal);
          if (request.role !== "protected") {
            const linkedGoal = await transaction
              .selectFrom("savings_goals")
              .select("id")
              .where("household_id", "=", principal.householdId)
              .where("destination_account_id", "=", accountId)
              .where("status", "!=", "archived")
              .executeTakeFirst();
            if (linkedGoal)
              throw new ConflictException(
                "Move or archive the savings goal before making this account spendable",
              );
          }
          const updated = await transaction
            .updateTable("accounts")
            .set({
              planning_role: request.role,
              include_in_plan: request.role === "spendable",
              version: request.expectedVersion + 1,
            })
            .where("household_id", "=", principal.householdId)
            .where("id", "=", accountId)
            .where("version", "=", request.expectedVersion)
            .where("archived_at", "is", null)
            .where("account_type", "in", ["cash", "checking", "savings"])
            .returningAll()
            .executeTakeFirst();
          if (!updated)
            throw new ConflictException(
              "This account changed; refresh before updating its plan role",
            );
          await addActivity(
            transaction,
            principal,
            "account.planning-role.updated",
            request.role === "protected"
              ? "Savings account protected"
              : request.role === "spendable"
                ? "Account included in spendable cash"
                : "Account excluded from the plan",
            `${updated.name} is now ${request.role === "protected" ? "kept outside safe-to-spend" : request.role}`,
            "manual",
            "account",
            updated.id,
          );
          await persistSnapshot(transaction, principal);
          await bumpRevision(transaction, principal);
          return {
            operation: "account.planning-role.update",
            resourceId: accountId,
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
          await lockPlanning(transaction, principal);
          await syncLegacySavingsInput(
            transaction,
            principal,
            request.plannedSavings.minor,
          );
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
            await reconcilePlanEvidence(transaction, principal);
          }
          const updatedPlan = await transaction
            .updateTable("plans")
            .set({
              planned_savings_minor: request.plannedSavings.minor,
              safety_buffer_minor: request.safetyBuffer.minor,
              ...(request.fallbackHorizonDays
                ? { fallback_horizon_days: request.fallbackHorizonDays }
                : {}),
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
              income_amount_minor: updatedPlan.income_amount_minor,
              income_frequency: updatedPlan.income_frequency,
              next_income_date: updatedPlan.next_income_date,
              income_confirmed: updatedPlan.income_confirmed,
              income_source_name: updatedPlan.income_source_name,
              fallback_horizon_days: updatedPlan.fallback_horizon_days,
              policy_version: updatedPlan.calculation_policy_version,
              actor_user_id: principal.userId,
            })
            .execute();
          const retainedIds: string[] = [];
          const starterRows: Array<{
            key: keyof typeof COMMON_BILL_STARTERS;
            commitmentId: string;
            commitmentVersion: number;
            name: string;
          }> = [];
          for (const item of request.commitments) {
            const starter = item.starterItemKey
              ? COMMON_BILL_STARTERS[item.starterItemKey]
              : null;
            if (
              starter &&
              (item.id ||
                item.expectedVersion ||
                item.name !== starter.name ||
                item.amount.minor !== "0" ||
                item.dueDate !== null)
            )
              throw new BadRequestException(
                "Common bill starters must be new empty rows",
              );
            if (starter) {
              const priorStarter = await transaction
                .selectFrom(
                  "starter_template_application_items as starter_item",
                )
                .innerJoin("commitments as starter_commitment", (join) =>
                  join
                    .onRef(
                      "starter_commitment.household_id",
                      "=",
                      "starter_item.household_id",
                    )
                    .onRef(
                      "starter_commitment.id",
                      "=",
                      "starter_item.commitment_id",
                    ),
                )
                .select("starter_commitment.id")
                .where("starter_item.household_id", "=", principal.householdId)
                .where("starter_item.item_key", "=", item.starterItemKey!)
                .where("starter_commitment.active", "=", true)
                .where("starter_commitment.settled_at", "is", null)
                .executeTakeFirst();
              const conflict = await transaction
                .selectFrom("commitments")
                .select("id")
                .where("household_id", "=", principal.householdId)
                .where("active", "=", true)
                .where((builder) =>
                  starter.setupSlot
                    ? builder.or([
                        builder("setup_slot", "=", starter.setupSlot),
                        sql<boolean>`lower(name)=lower(${starter.name})`,
                      ])
                    : sql<boolean>`lower(name)=lower(${starter.name})`,
                )
                .executeTakeFirst();
              if (priorStarter || conflict)
                throw new ConflictException(
                  `${starter.name} is already in this plan. Refresh and try again.`,
                );
            }
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
            const desiredRecurrence =
              item.recurrence === "one_time"
                ? null
                : (item.recurrence ?? "monthly");
            const existingUnchanged = Boolean(
              existing &&
                existing.name === item.name &&
                BigInt(existing.amount_minor) === BigInt(item.amount.minor) &&
                (existing.due_date ? toDateOnly(existing.due_date) : null) ===
                  item.dueDate &&
                existing.recurrence === desiredRecurrence &&
                existing.setup_slot === (item.setupSlot ?? existing.setup_slot),
            );
            const row = existing
              ? existingUnchanged
                ? existing
                : await transaction
                    .updateTable("commitments")
                    .set({
                      name: item.name,
                      amount_minor: item.amount.minor,
                      due_date: item.dueDate,
                      ...(item.recurrence
                        ? {
                            recurrence: desiredRecurrence,
                          }
                        : {}),
                      setup_slot: item.setupSlot ?? existing.setup_slot,
                      ...anchorColumns("recurrence", item.dueDate),
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
                    recurrence:
                      item.recurrence === "one_time"
                        ? null
                        : (item.recurrence ?? "monthly"),
                    ...anchorColumns("recurrence", item.dueDate),
                    provenance: "manual",
                    setup_slot: starter?.setupSlot ?? item.setupSlot ?? null,
                  })
                  .returningAll()
                  .executeTakeFirstOrThrow();
            retainedIds.push(row.id);
            if (item.starterItemKey)
              starterRows.push({
                key: item.starterItemKey,
                commitmentId: row.id,
                commitmentVersion: row.version,
                name: row.name,
              });
            if (!existing || !existingUnchanged)
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
          if (starterRows.length > 0) {
            const application = await transaction
              .insertInto("starter_template_applications")
              .values({
                household_id: principal.householdId,
                user_id: principal.userId,
                template_key: "common_bills",
                template_version: 1,
                request_id: request.requestId,
                plan_version: updatedPlan.version,
              })
              .returning("id")
              .executeTakeFirstOrThrow();
            await transaction
              .insertInto("starter_template_application_items")
              .values(
                starterRows.map((item) => ({
                  household_id: principal.householdId,
                  application_id: application.id,
                  item_key: item.key,
                  commitment_id: item.commitmentId,
                  commitment_version: item.commitmentVersion,
                  name_snapshot: item.name,
                })),
              )
              .execute();
            await addActivity(
              transaction,
              principal,
              "plan.common_bills_added",
              "Common bills added",
              `${starterRows.length} empty bill ${starterRows.length === 1 ? "row" : "rows"} added for completion`,
              "manual",
              "plan",
              updatedPlan.id,
            );
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
          await synchronizePlanOccurrences(transaction, principal, updatedPlan);
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

  undoStarterApplication(
    identity: RequestIdentity,
    applicationId: string,
    request: StarterApplicationUndoRequest,
  ): Promise<BootstrapResponse> {
    return this.mutateThenRead(identity, async (transaction, principal) =>
      idempotent(
        transaction,
        principal.householdId,
        request.requestId,
        "plan.common_bills.undo",
        { applicationId, ...request },
        async () => {
          requireEditor(principal);
          await lockPlanning(transaction, principal);
          const application = await transaction
            .selectFrom("starter_template_applications")
            .selectAll()
            .where("household_id", "=", principal.householdId)
            .where("user_id", "=", principal.userId)
            .where("id", "=", applicationId)
            .where("undone_at", "is", null)
            .forUpdate()
            .executeTakeFirst();
          if (!application)
            throw new NotFoundException("Common bill addition not found");
          const items = await transaction
            .selectFrom("starter_template_application_items as item")
            .innerJoin("commitments as commitment", (join) =>
              join
                .onRef("commitment.household_id", "=", "item.household_id")
                .onRef("commitment.id", "=", "item.commitment_id"),
            )
            .select([
              "commitment.id",
              "commitment.version",
              "commitment.name",
              "commitment.amount_minor",
              "commitment.currency",
              "commitment.due_date",
              "commitment.active",
              "commitment.settled_at",
              "item.commitment_version",
            ])
            .where("item.household_id", "=", principal.householdId)
            .where("item.application_id", "=", applicationId)
            .execute();
          if (
            items.length === 0 ||
            items.some(
              (item) =>
                !item.active ||
                item.settled_at !== null ||
                item.version !== item.commitment_version ||
                BigInt(item.amount_minor) !== 0n ||
                item.due_date !== null,
            )
          )
            throw new ConflictException(
              "These bill rows changed and can no longer be undone together",
            );
          for (const item of items) {
            const row = await transaction
              .updateTable("commitments")
              .set({
                active: false,
                version: item.version + 1,
                updated_at: new Date(),
              })
              .where("household_id", "=", principal.householdId)
              .where("id", "=", item.id)
              .where("version", "=", item.version)
              .returningAll()
              .executeTakeFirstOrThrow();
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
          await transaction
            .updateTable("starter_template_applications")
            .set({
              undone_at: new Date(),
              undone_request_id: request.requestId,
            })
            .where("household_id", "=", principal.householdId)
            .where("id", "=", applicationId)
            .execute();
          const plan = await transaction
            .selectFrom("plans")
            .selectAll()
            .where("household_id", "=", principal.householdId)
            .executeTakeFirstOrThrow();
          await synchronizePlanOccurrences(transaction, principal, plan);
          await addActivity(
            transaction,
            principal,
            "plan.common_bills_undone",
            "Common bills removed",
            `${items.length} untouched bill ${items.length === 1 ? "row" : "rows"} removed`,
            "manual",
            "plan",
            plan.id,
          );
          await persistSnapshot(transaction, principal);
          await bumpRevision(transaction, principal);
          return {
            operation: "plan.common_bills.undo",
            resourceId: applicationId,
          };
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

async function lockPlanning(
  transaction: Transaction<Database>,
  principal: Principal,
) {
  await sql`select pg_advisory_xact_lock(hashtextextended(${principal.householdId}, 7241))`.execute(
    transaction,
  );
}

async function validateIncomeDestination(
  transaction: Transaction<Database>,
  principal: Principal,
  accountId: string | null,
) {
  if (!accountId) return;
  const account = await transaction
    .selectFrom("accounts")
    .select(["id", "account_type"])
    .where("household_id", "=", principal.householdId)
    .where("id", "=", accountId)
    .where("archived_at", "is", null)
    .executeTakeFirst();
  if (
    !account ||
    !["cash", "checking", "savings"].includes(account.account_type)
  )
    throw new ConflictException(
      "Choose an active deposit account for this income",
    );
}

function incomeAnchorColumns(
  date: string | null,
  requestedDay: number | null,
  requestedEom: boolean,
) {
  if (!date) return { day: requestedDay, eom: requestedEom };
  const parsed = new Date(`${date}T12:00:00Z`);
  const next = new Date(parsed);
  next.setUTCDate(next.getUTCDate() + 1);
  return {
    day: requestedDay ?? parsed.getUTCDate(),
    eom: requestedEom || next.getUTCMonth() !== parsed.getUTCMonth(),
  };
}

async function appendIncomeScheduleRevision(
  transaction: Transaction<Database>,
  principal: Principal,
  schedule: {
    id: string;
    household_id: string;
    destination_account_id: string | null;
    name: string;
    expected_amount_minor: string | null;
    frequency: string;
    next_expected_date: string | null;
    confirmed: boolean;
    status: string;
    anchor_day: number | null;
    anchor_eom: boolean;
    second_anchor_day: number | null;
    second_anchor_eom: boolean;
    review_reason: string | null;
    advanced_from_occurrence_id: string | null;
    previous_expected_date: string | null;
    provenance: string;
    version: number;
  },
  reason: string,
) {
  await transaction
    .insertInto("income_schedule_revisions")
    .values({
      household_id: schedule.household_id,
      income_schedule_id: schedule.id,
      destination_account_id: schedule.destination_account_id,
      name: schedule.name,
      expected_amount_minor: schedule.expected_amount_minor,
      frequency: schedule.frequency,
      next_expected_date: schedule.next_expected_date,
      confirmed: schedule.confirmed,
      status: schedule.status,
      anchor_day: schedule.anchor_day,
      anchor_eom: schedule.anchor_eom,
      second_anchor_day: schedule.second_anchor_day,
      second_anchor_eom: schedule.second_anchor_eom,
      review_reason: schedule.review_reason,
      advanced_from_occurrence_id: schedule.advanced_from_occurrence_id,
      previous_expected_date: schedule.previous_expected_date,
      provenance: schedule.provenance,
      version: schedule.version,
      actor_user_id: principal.userId,
      reason,
    })
    .execute();
}

type DebtMutation = DebtCreateRequest | DebtUpdateRequest;

async function resolveDebtCommitment(
  transaction: Transaction<Database>,
  principal: Principal,
  request: DebtMutation,
  current: {
    linked_commitment_id: string | null;
    payment_commitment_managed: boolean;
  } | null,
): Promise<{ id: string | null; managed: boolean }> {
  const currentCommitmentId = current?.linked_commitment_id ?? null;
  const currentManaged = current?.payment_commitment_managed ?? false;
  if (
    "status" in request &&
    (request.status === "archived" || request.status === "closed")
  ) {
    if (currentCommitmentId && currentManaged)
      await deactivateManagedDebtCommitment(
        transaction,
        principal,
        currentCommitmentId,
      );
    return { id: null, managed: false };
  }
  if (request.createPaymentCommitment) {
    if (currentCommitmentId)
      throw new ConflictException(
        "Unlink the current payment before creating a new one",
      );
    const base =
      request.paymentMode === "fixed_amount"
        ? request.fixedPayment
        : request.minimumPayment;
    const amount = base
      ? BigInt(base.minor) + BigInt(request.extraPayment.minor)
      : 0n;
    if (amount <= 0n || !request.nextDueOn)
      throw new ConflictException(
        "A new debt payment needs an amount and due date",
      );
    const commitmentId = uuidv7();
    await transaction
      .insertInto("commitments")
      .values({
        id: commitmentId,
        household_id: principal.householdId,
        name: `${request.name} payment`,
        amount_minor: amount.toString(),
        currency: "USD",
        due_date: request.nextDueOn,
        recurrence: "monthly",
        ...anchorColumns("recurrence", request.nextDueOn),
        provenance: "manual",
      })
      .execute();
    await transaction
      .insertInto("commitment_revisions")
      .values({
        household_id: principal.householdId,
        commitment_id: commitmentId,
        version: 1,
        name: `${request.name} payment`,
        amount_minor: amount.toString(),
        currency: "USD",
        due_date: request.nextDueOn,
        active: true,
        settled_at: null,
        actor_user_id: principal.userId,
      })
      .execute();
    return { id: commitmentId, managed: true };
  }
  const chosen = request.linkedCommitmentId;
  if (!chosen) {
    if (currentCommitmentId && currentManaged)
      await deactivateManagedDebtCommitment(
        transaction,
        principal,
        currentCommitmentId,
      );
    return { id: null, managed: false };
  }
  if (chosen === currentCommitmentId) {
    if (currentManaged)
      await synchronizeManagedDebtCommitment(
        transaction,
        principal,
        chosen,
        request,
      );
    return { id: chosen, managed: currentManaged };
  }
  const commitment = await transaction
    .selectFrom("commitments")
    .select(["id", "recurrence"])
    .where("household_id", "=", principal.householdId)
    .where("id", "=", chosen)
    .where("active", "=", true)
    .where("settled_at", "is", null)
    .executeTakeFirst();
  if (!commitment)
    throw new ConflictException("Choose an active payment commitment");
  if (commitment.recurrence !== "monthly")
    throw new ConflictException(
      "Debt payoff visibility requires a monthly payment commitment",
    );
  const claimed = await transaction
    .selectFrom("debts")
    .select("id")
    .where("household_id", "=", principal.householdId)
    .where("linked_commitment_id", "=", chosen)
    .where("status", "!=", "archived")
    .executeTakeFirst();
  if (claimed)
    throw new ConflictException(
      "That payment is already linked to another debt",
    );
  if (currentCommitmentId && currentManaged)
    await deactivateManagedDebtCommitment(
      transaction,
      principal,
      currentCommitmentId,
    );
  return { id: chosen, managed: false };
}

async function synchronizeManagedDebtCommitment(
  transaction: Transaction<Database>,
  principal: Principal,
  commitmentId: string,
  request: DebtMutation,
) {
  const base =
    request.paymentMode === "fixed_amount"
      ? request.fixedPayment
      : request.minimumPayment;
  const amount = base
    ? BigInt(base.minor) + BigInt(request.extraPayment.minor)
    : 0n;
  if (amount <= 0n || !request.nextDueOn)
    throw new ConflictException(
      "This Budgefi payment needs an amount and due date",
    );
  const current = await transaction
    .selectFrom("commitments")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .where("id", "=", commitmentId)
    .where("active", "=", true)
    .forUpdate()
    .executeTakeFirst();
  if (!current)
    throw new ConflictException("The linked payment is no longer active");
  const nextVersion = current.version + 1;
  const updated = await transaction
    .updateTable("commitments")
    .set({
      name: `${request.name} payment`,
      amount_minor: amount.toString(),
      due_date: request.nextDueOn,
      ...anchorColumns("recurrence", request.nextDueOn),
      version: nextVersion,
      updated_at: new Date(),
    })
    .where("household_id", "=", principal.householdId)
    .where("id", "=", commitmentId)
    .where("version", "=", current.version)
    .returningAll()
    .executeTakeFirstOrThrow();
  await transaction
    .insertInto("commitment_revisions")
    .values({
      household_id: principal.householdId,
      commitment_id: commitmentId,
      version: nextVersion,
      name: updated.name,
      amount_minor: updated.amount_minor,
      currency: updated.currency,
      due_date: updated.due_date,
      active: true,
      settled_at: null,
      actor_user_id: principal.userId,
    })
    .execute();
}

async function deactivateManagedDebtCommitment(
  transaction: Transaction<Database>,
  principal: Principal,
  commitmentId: string,
) {
  const current = await transaction
    .selectFrom("commitments")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .where("id", "=", commitmentId)
    .forUpdate()
    .executeTakeFirst();
  if (!current || !current.active) return;
  const nextVersion = current.version + 1;
  const updated = await transaction
    .updateTable("commitments")
    .set({
      active: false,
      version: nextVersion,
      updated_at: new Date(),
    })
    .where("household_id", "=", principal.householdId)
    .where("id", "=", commitmentId)
    .where("version", "=", current.version)
    .returningAll()
    .executeTakeFirstOrThrow();
  await transaction
    .insertInto("commitment_revisions")
    .values({
      household_id: principal.householdId,
      commitment_id: commitmentId,
      version: nextVersion,
      name: updated.name,
      amount_minor: updated.amount_minor,
      currency: updated.currency,
      due_date: updated.due_date,
      active: false,
      settled_at: updated.settled_at,
      actor_user_id: principal.userId,
    })
    .execute();
}

async function appendDebtRevision(
  transaction: Transaction<Database>,
  principal: Principal,
  debt: {
    id: string;
    household_id: string;
    account_id: string;
    linked_commitment_id: string | null;
    payment_commitment_managed: boolean;
    name: string;
    debt_type: string;
    status: string;
    provenance: string;
    version: number;
  },
  reason: string,
) {
  await transaction
    .insertInto("debt_revisions")
    .values({
      household_id: debt.household_id,
      debt_id: debt.id,
      account_id: debt.account_id,
      linked_commitment_id: debt.linked_commitment_id,
      payment_commitment_managed: debt.payment_commitment_managed,
      name: debt.name,
      debt_type: debt.debt_type,
      status: debt.status,
      provenance: debt.provenance,
      version: debt.version,
      actor_user_id: principal.userId,
      reason,
    })
    .execute();
}

async function insertManualDebtBalance(
  transaction: Transaction<Database>,
  principal: Principal,
  debtId: string,
  rawMinor: string,
  sourceRecordId: string,
) {
  await transaction
    .insertInto("debt_balance_observations")
    .values({
      household_id: principal.householdId,
      debt_id: debtId,
      current_balance_minor: rawMinor,
      currency: "USD",
      provenance: "manual",
      source_record_id: sourceRecordId,
      observed_at: new Date(),
    })
    .execute();
}

async function insertDebtTermsAndApr(
  transaction: Transaction<Database>,
  principal: Principal,
  debtId: string,
  request: DebtMutation,
  sourceRecordId: string,
) {
  if (request.minimumPayment || request.nextDueOn)
    await transaction
      .insertInto("debt_term_observations")
      .values({
        household_id: principal.householdId,
        debt_id: debtId,
        minimum_payment_minor: request.minimumPayment?.minor ?? null,
        next_due_on: request.nextDueOn,
        statement_balance_minor: null,
        statement_on: null,
        last_payment_minor: null,
        last_payment_on: null,
        overdue: null,
        provenance: "manual",
        source_record_id: sourceRecordId,
        observed_at: new Date(),
      })
      .execute();
  if (request.aprBasisPoints !== null)
    await transaction
      .insertInto("debt_apr_components")
      .values({
        household_id: principal.householdId,
        debt_id: debtId,
        component_key: "user-selected",
        apr_basis_points: request.aprBasisPoints,
        balance_minor: null,
        apr_type: "unknown",
        selected_for_projection: true,
        provenance: "manual",
        source_record_id: sourceRecordId,
        observed_at: new Date(),
      })
      .execute();
}

async function upsertDebtPaymentPolicy(
  transaction: Transaction<Database>,
  principal: Principal,
  debtId: string,
  request: DebtMutation,
  reason: string,
) {
  const existing = await transaction
    .selectFrom("debt_payment_policies")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .where("debt_id", "=", debtId)
    .executeTakeFirst();
  const values = {
    mode: request.paymentMode,
    fixed_amount_minor:
      request.paymentMode === "fixed_amount"
        ? request.fixedPayment!.minor
        : null,
    extra_amount_minor: request.extraPayment.minor,
    actor_user_id: principal.userId,
  };
  const policy = existing
    ? await transaction
        .updateTable("debt_payment_policies")
        .set({
          ...values,
          version: existing.version + 1,
          updated_at: new Date(),
        })
        .where("household_id", "=", principal.householdId)
        .where("debt_id", "=", debtId)
        .where("version", "=", existing.version)
        .returningAll()
        .executeTakeFirstOrThrow()
    : await transaction
        .insertInto("debt_payment_policies")
        .values({
          household_id: principal.householdId,
          debt_id: debtId,
          ...values,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
  await transaction
    .insertInto("debt_payment_policy_revisions")
    .values({
      household_id: principal.householdId,
      debt_id: debtId,
      mode: policy.mode,
      fixed_amount_minor: policy.fixed_amount_minor,
      extra_amount_minor: policy.extra_amount_minor,
      version: policy.version,
      actor_user_id: principal.userId,
      reason,
    })
    .execute();
}

async function requireSavingsDestination(
  transaction: Transaction<Database>,
  principal: Principal,
  accountId: string,
  currentGoalId?: string,
) {
  const account = await transaction
    .selectFrom("accounts")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .where("id", "=", accountId)
    .where("archived_at", "is", null)
    .where("account_type", "=", "savings")
    .executeTakeFirst();
  if (!account)
    throw new ConflictException(
      "Choose an available savings account as the destination",
    );
  const claimed = await transaction
    .selectFrom("savings_goals")
    .select("id")
    .where("household_id", "=", principal.householdId)
    .where("destination_account_id", "=", accountId)
    .where("status", "!=", "archived")
    .$if(Boolean(currentGoalId), (query) =>
      query.where("id", "!=", currentGoalId!),
    )
    .executeTakeFirst();
  if (claimed)
    throw new ConflictException(
      "This account already belongs to another savings goal",
    );
  return account;
}

async function initialSavingsTrackingStart(
  transaction: Transaction<Database>,
  account: {
    provenance: string;
    connection_id: string | null;
  },
): Promise<Date | null> {
  if (account.provenance !== "plaid") return new Date();
  if (!account.connection_id) return null;
  const connection = await transaction
    .selectFrom("connections")
    .select("historical_update_complete")
    .where("id", "=", account.connection_id)
    .executeTakeFirst();
  return connection?.historical_update_complete ? new Date() : null;
}

async function protectSavingsDestination(
  transaction: Transaction<Database>,
  account: {
    id: string;
    household_id: string;
    version: number;
    planning_role: string;
  },
) {
  if (account.planning_role === "protected") return;
  await transaction
    .updateTable("accounts")
    .set({
      planning_role: "protected",
      include_in_plan: false,
      version: account.version + 1,
    })
    .where("household_id", "=", account.household_id)
    .where("id", "=", account.id)
    .where("version", "=", account.version)
    .executeTakeFirstOrThrow();
}

async function restoreSavingsDestination(
  transaction: Transaction<Database>,
  householdId: string,
  accountId: string,
  priorRole: string | null,
) {
  const account = await transaction
    .selectFrom("accounts")
    .select(["id", "version", "planning_role"])
    .where("household_id", "=", householdId)
    .where("id", "=", accountId)
    .forUpdate()
    .executeTakeFirst();
  if (!account || account.planning_role !== "protected") return;
  const role =
    priorRole === "spendable" || priorRole === "protected"
      ? priorRole
      : "excluded";
  await transaction
    .updateTable("accounts")
    .set({
      planning_role: role,
      include_in_plan: role === "spendable",
      version: account.version + 1,
    })
    .where("household_id", "=", householdId)
    .where("id", "=", accountId)
    .where("version", "=", account.version)
    .executeTakeFirstOrThrow();
}

async function savingsGoalProgress(
  transaction: Transaction<Database>,
  householdId: string,
  goalId: string,
) {
  const movements = await transaction
    .selectFrom("savings_goal_movements")
    .select(["id", "kind", "amount_minor", "reversed_movement_id"])
    .where("household_id", "=", householdId)
    .where("savings_goal_id", "=", goalId)
    .execute();
  const reversed = new Set(
    movements
      .filter((movement) => movement.kind === "reversal")
      .map((movement) => movement.reversed_movement_id),
  );
  return movements
    .filter(
      (movement) => movement.kind !== "reversal" && !reversed.has(movement.id),
    )
    .reduce(
      (sum, movement) =>
        sum +
        (movement.kind === "withdrawal" ? -1n : 1n) *
          BigInt(movement.amount_minor),
      0n,
    );
}

async function latestUsableBalance(
  transaction: Transaction<Database>,
  householdId: string,
  accountId: string,
) {
  return transaction
    .selectFrom("balance_observations")
    .selectAll()
    .where("household_id", "=", householdId)
    .where("account_id", "=", accountId)
    .where((expression) =>
      expression.not(
        expression.and([
          expression("provenance", "=", "manual"),
          expression("source_record_id", "=", "provisioned"),
        ]),
      ),
    )
    .orderBy("as_of", "desc")
    .orderBy("recorded_at", "desc")
    .executeTakeFirst();
}

async function appendSavingsGoalRevision(
  transaction: Transaction<Database>,
  principal: Principal,
  goal: {
    id: string;
    household_id: string;
    destination_account_id: string | null;
    destination_prior_planning_role: string | null;
    destination_tracking_started_at: Date | null;
    name: string;
    target_amount_minor: string | null;
    target_date: string | null;
    contribution_amount_minor: string;
    schedule: string;
    next_due_on: string | null;
    status: string;
    currency: string;
    provenance: string;
    version: number;
  },
  reason: string,
) {
  await transaction
    .insertInto("savings_goal_revisions")
    .values({
      household_id: goal.household_id,
      savings_goal_id: goal.id,
      destination_account_id: goal.destination_account_id,
      destination_prior_planning_role: goal.destination_prior_planning_role,
      destination_tracking_started_at: goal.destination_tracking_started_at,
      name: goal.name,
      target_amount_minor: goal.target_amount_minor,
      target_date: goal.target_date,
      contribution_amount_minor: goal.contribution_amount_minor,
      schedule: goal.schedule,
      next_due_on: goal.next_due_on,
      status: goal.status,
      currency: goal.currency,
      provenance: goal.provenance,
      version: goal.version,
      actor_user_id: principal.userId,
      reason,
    })
    .execute();
}

async function createSavingsMovement(
  transaction: Transaction<Database>,
  principal: Principal,
  input: {
    goalId: string;
    kind: "opening_allocation" | "contribution" | "withdrawal" | "reversal";
    amountMinor: string;
    effectiveOn: string;
    verificationMethod: "provider_verified" | "user_confirmed";
    provenance: "manual" | "plaid" | "derived";
    occurrence: { id: string; version: number } | null;
    reversedMovementId: string | null;
    evidence: Array<{
      role:
        | "source_debit"
        | "destination_credit"
        | "source_balance"
        | "destination_balance"
        | "manual_balance";
      transactionId?: string;
      balanceObservationId?: string;
    }>;
  },
) {
  const movement = await transaction
    .insertInto("savings_goal_movements")
    .values({
      household_id: principal.householdId,
      savings_goal_id: input.goalId,
      kind: input.kind,
      amount_minor: input.amountMinor,
      currency: "USD",
      effective_on: input.effectiveOn,
      verification_method: input.verificationMethod,
      originating_occurrence_id: input.occurrence?.id ?? null,
      originating_occurrence_version: input.occurrence?.version ?? null,
      reversed_movement_id: input.reversedMovementId,
      actor_user_id: principal.userId,
      provenance: input.provenance,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  if (input.evidence.length)
    await transaction
      .insertInto("savings_movement_evidence")
      .values(
        input.evidence.map((evidence) => ({
          household_id: principal.householdId,
          movement_id: movement.id,
          evidence_role: evidence.role,
          transaction_id: evidence.transactionId ?? null,
          balance_observation_id: evidence.balanceObservationId ?? null,
        })),
      )
      .execute();
  return movement;
}

async function refreshSavingsPlanAggregate(
  transaction: Transaction<Database>,
  principal: Principal,
) {
  const aggregate = await transaction
    .selectFrom("savings_goals")
    .select((expression) =>
      expression.fn
        .coalesce(
          expression.fn.sum<string>("contribution_amount_minor"),
          sql<string>`0`,
        )
        .as("amount"),
    )
    .where("household_id", "=", principal.householdId)
    .where("status", "=", "active")
    .executeTakeFirstOrThrow();
  const current = await transaction
    .selectFrom("plans")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (current.planned_savings_minor === aggregate.amount) return current;
  const updated = await transaction
    .updateTable("plans")
    .set({
      planned_savings_minor: aggregate.amount,
      version: current.version + 1,
      updated_at: new Date(),
    })
    .where("household_id", "=", principal.householdId)
    .where("version", "=", current.version)
    .returningAll()
    .executeTakeFirstOrThrow();
  await transaction
    .insertInto("plan_revisions")
    .values({
      household_id: principal.householdId,
      plan_id: updated.id,
      version: updated.version,
      planned_savings_minor: updated.planned_savings_minor,
      safety_buffer_minor: updated.safety_buffer_minor,
      currency: updated.currency,
      planning_horizon_days: updated.planning_horizon_days,
      income_amount_minor: updated.income_amount_minor,
      income_frequency: updated.income_frequency,
      next_income_date: updated.next_income_date,
      income_confirmed: updated.income_confirmed,
      income_source_name: updated.income_source_name,
      fallback_horizon_days: updated.fallback_horizon_days,
      policy_version: updated.calculation_policy_version,
      actor_user_id: principal.userId,
    })
    .execute();
  return updated;
}

export async function detachSavingsGoalsForConnection(
  transaction: Transaction<Database>,
  principal: Principal,
  connectionId: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${principal.householdId}, 7241))`.execute(
    transaction,
  );
  const goals = await transaction
    .selectFrom("savings_goals as goal")
    .innerJoin("accounts as account", (join) =>
      join
        .onRef("account.household_id", "=", "goal.household_id")
        .onRef("account.id", "=", "goal.destination_account_id"),
    )
    .selectAll("goal")
    .where("goal.household_id", "=", principal.householdId)
    .where("account.connection_id", "=", connectionId)
    .where("goal.status", "!=", "archived")
    .forUpdate("goal")
    .execute();
  for (const goal of goals) {
    const updated = await transaction
      .updateTable("savings_goals")
      .set({
        destination_account_id: null,
        destination_prior_planning_role: null,
        destination_tracking_started_at: null,
        status: goal.status === "active" ? "paused" : goal.status,
        version: goal.version + 1,
        updated_at: new Date(),
      })
      .where("household_id", "=", principal.householdId)
      .where("id", "=", goal.id)
      .where("version", "=", goal.version)
      .returningAll()
      .executeTakeFirstOrThrow();
    await appendSavingsGoalRevision(
      transaction,
      principal,
      updated,
      "Bank disconnected; destination removed and active contribution paused",
    );
    await addActivity(
      transaction,
      principal,
      "savings.goal.destination_disconnected",
      `${goal.name} needs a new savings account`,
      "The bank was disconnected, so automatic tracking stopped and planned contributions were paused",
      "derived",
      "savings_goal",
      goal.id,
      null,
    );
  }
  if (goals.length > 0) {
    const plan = await refreshSavingsPlanAggregate(transaction, principal);
    await synchronizePlanOccurrences(transaction, principal, plan);
  }
}

export async function detachIncomeSchedulesForConnection(
  transaction: Transaction<Database>,
  principal: Principal,
  connectionId: string,
): Promise<void> {
  const accounts = await transaction
    .selectFrom("accounts")
    .select("id")
    .where("household_id", "=", principal.householdId)
    .where("connection_id", "=", connectionId)
    .execute();
  await detachIncomeSchedulesForAccounts(
    transaction,
    principal,
    accounts.map((item) => item.id),
  );
}

export async function detachIncomeSchedulesForAccounts(
  transaction: Transaction<Database>,
  principal: Principal,
  accountIds: string[],
): Promise<void> {
  if (!accountIds.length) return;
  await sql`select pg_advisory_xact_lock(hashtextextended(${principal.householdId}, 7241))`.execute(
    transaction,
  );
  const schedules = await transaction
    .selectFrom("income_schedules")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .where("destination_account_id", "in", accountIds)
    .where("status", "!=", "archived")
    .forUpdate()
    .execute();
  for (const schedule of schedules) {
    const updated = await transaction
      .updateTable("income_schedules")
      .set({
        destination_account_id: null,
        confirmed: false,
        review_reason: "destination_disconnected",
        advanced_from_occurrence_id: null,
        previous_expected_date: null,
        version: schedule.version + 1,
        updated_at: new Date(),
      })
      .where("household_id", "=", principal.householdId)
      .where("id", "=", schedule.id)
      .where("version", "=", schedule.version)
      .returningAll()
      .executeTakeFirstOrThrow();
    await appendIncomeScheduleRevision(
      transaction,
      principal,
      updated,
      "Destination account disconnected; date requires review",
    );
    await addActivity(
      transaction,
      principal,
      "income.schedule.destination_disconnected",
      `${schedule.name} needs review`,
      "Its destination account is unavailable. The date no longer shortens your plan until you confirm it again",
      "derived",
      "income_schedule",
      schedule.id,
      null,
    );
  }
  if (schedules.length) {
    const plan = await transaction
      .selectFrom("plans")
      .selectAll()
      .where("household_id", "=", principal.householdId)
      .executeTakeFirstOrThrow();
    await synchronizePlanOccurrences(transaction, principal, plan);
  }
}

export async function pauseDebtTrackingForConnection(
  transaction: Transaction<Database>,
  principal: Principal,
  connectionId: string,
): Promise<void> {
  const debts = await transaction
    .selectFrom("debts as debt")
    .innerJoin("accounts as account", (join) =>
      join
        .onRef("account.household_id", "=", "debt.household_id")
        .onRef("account.id", "=", "debt.account_id"),
    )
    .selectAll("debt")
    .where("debt.household_id", "=", principal.householdId)
    .where("account.connection_id", "=", connectionId)
    .where("debt.status", "in", ["active", "needs_review"])
    .forUpdate("debt")
    .execute();
  for (const debt of debts) {
    if (debt.linked_commitment_id && debt.payment_commitment_managed)
      await deactivateManagedDebtCommitment(
        transaction,
        principal,
        debt.linked_commitment_id,
      );
    const updated = await transaction
      .updateTable("debts")
      .set({
        status: "paused",
        linked_commitment_id: debt.payment_commitment_managed
          ? null
          : debt.linked_commitment_id,
        payment_commitment_managed: false,
        version: debt.version + 1,
        updated_at: new Date(),
      })
      .where("household_id", "=", principal.householdId)
      .where("id", "=", debt.id)
      .where("version", "=", debt.version)
      .returningAll()
      .executeTakeFirstOrThrow();
    await appendDebtRevision(
      transaction,
      principal,
      updated,
      "Bank disconnected; automatic debt verification paused",
    );
    await addActivity(
      transaction,
      principal,
      "debt.tracking.paused",
      `${debt.name} bank tracking paused`,
      debt.linked_commitment_id && !debt.payment_commitment_managed
        ? "Automatic verification stopped; your independently created payment remains planned"
        : "Automatic balance and payment verification stopped. Review the debt after reconnecting before reserving another payment",
      "derived",
      "debt",
      debt.id,
      null,
    );
  }
}

export async function pauseDebtTrackingForAccounts(
  transaction: Transaction<Database>,
  principal: Principal,
  accountIds: string[],
): Promise<void> {
  if (!accountIds.length) return;
  const debts = await transaction
    .selectFrom("debts")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .where("account_id", "in", accountIds)
    .where("status", "in", ["active", "needs_review"])
    .forUpdate()
    .execute();
  for (const debt of debts) {
    if (debt.linked_commitment_id && debt.payment_commitment_managed)
      await deactivateManagedDebtCommitment(
        transaction,
        principal,
        debt.linked_commitment_id,
      );
    const updated = await transaction
      .updateTable("debts")
      .set({
        status: "paused",
        linked_commitment_id: debt.payment_commitment_managed
          ? null
          : debt.linked_commitment_id,
        payment_commitment_managed: false,
        version: debt.version + 1,
        updated_at: new Date(),
      })
      .where("household_id", "=", principal.householdId)
      .where("id", "=", debt.id)
      .where("version", "=", debt.version)
      .returningAll()
      .executeTakeFirstOrThrow();
    await appendDebtRevision(
      transaction,
      principal,
      updated,
      "Liability account disappeared; automatic debt verification paused",
    );
  }
}

export async function activatePendingSavingsTrackingForConnection(
  transaction: Transaction<Database>,
  principal: Principal,
  connectionId: string,
): Promise<void> {
  const goals = await transaction
    .selectFrom("savings_goals as goal")
    .innerJoin("accounts as account", (join) =>
      join
        .onRef("account.household_id", "=", "goal.household_id")
        .onRef("account.id", "=", "goal.destination_account_id"),
    )
    .selectAll("goal")
    .where("goal.household_id", "=", principal.householdId)
    .where("account.connection_id", "=", connectionId)
    .where("goal.destination_tracking_started_at", "is", null)
    .where("goal.status", "!=", "archived")
    .forUpdate("goal")
    .execute();
  const startedAt = new Date();
  for (const goal of goals) {
    const updated = await transaction
      .updateTable("savings_goals")
      .set({
        destination_tracking_started_at: startedAt,
        version: goal.version + 1,
        updated_at: startedAt,
      })
      .where("household_id", "=", principal.householdId)
      .where("id", "=", goal.id)
      .where("version", "=", goal.version)
      .returningAll()
      .executeTakeFirstOrThrow();
    await appendSavingsGoalRevision(
      transaction,
      principal,
      updated,
      "Historical bank import completed; automatic savings tracking started",
    );
  }
}

async function syncLegacySavingsInput(
  transaction: Transaction<Database>,
  principal: Principal,
  amountMinor: string,
) {
  const goals = await transaction
    .selectFrom("savings_goals")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .where("status", "=", "active")
    .forUpdate()
    .execute();
  const aggregate = goals.reduce(
    (sum, goal) => sum + BigInt(goal.contribution_amount_minor),
    0n,
  );
  if (aggregate === BigInt(amountMinor)) return;
  const general = goals.find(
    (goal) =>
      goal.name === "General savings" && goal.destination_account_id === null,
  );
  const nonGeneral = goals.filter((goal) => goal.id !== general?.id);
  if (nonGeneral.length)
    throw new ConflictException(
      "Savings are now managed by goal; refresh and edit the goal contribution",
    );
  if (general) {
    const updated = await transaction
      .updateTable("savings_goals")
      .set({
        contribution_amount_minor: amountMinor,
        version: general.version + 1,
        updated_at: new Date(),
      })
      .where("household_id", "=", principal.householdId)
      .where("id", "=", general.id)
      .where("version", "=", general.version)
      .returningAll()
      .executeTakeFirstOrThrow();
    await appendSavingsGoalRevision(
      transaction,
      principal,
      updated,
      "Legacy plan savings input updated the General savings goal",
    );
    return;
  }
  if (BigInt(amountMinor) === 0n) return;
  const created = await transaction
    .insertInto("savings_goals")
    .values({
      household_id: principal.householdId,
      destination_account_id: null,
      name: "General savings",
      target_amount_minor: null,
      target_date: null,
      contribution_amount_minor: amountMinor,
      schedule: "planning_period",
      next_due_on: null,
      status: "active",
      currency: "USD",
      provenance: "manual",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await appendSavingsGoalRevision(
    transaction,
    principal,
    created,
    "Legacy plan savings input created an unverified General savings goal",
  );
}

type OccurrencePlan = Readonly<{
  id: string;
  household_id: string;
  planned_savings_minor: string;
  income_amount_minor: string;
  income_confirmed: boolean;
  income_source_name: string;
  next_income_date: string | null;
  fallback_horizon_days: number;
}>;

async function synchronizePlanOccurrences(
  transaction: Transaction<Database>,
  principal: Principal,
  plan: OccurrencePlan,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${principal.householdId}, 7241))`.execute(
    transaction,
  );
  const household = await transaction
    .selectFrom("households")
    .select("timezone")
    .where("id", "=", principal.householdId)
    .executeTakeFirstOrThrow();
  const today = dateInTimezone(new Date(), household.timezone);
  const incomeSchedules = await transaction
    .selectFrom("income_schedules")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .where("status", "!=", "archived")
    .execute();
  const horizon = resolvePlanningHorizonFromSchedules({
    today,
    fallbackDays: plan.fallback_horizon_days,
    schedules: incomeSchedules.map((item) => ({
      id: item.id,
      nextExpectedDate: item.next_expected_date
        ? toDateOnly(item.next_expected_date)
        : null,
      confirmed: item.confirmed,
      status: item.status,
    })),
  });
  const occurrenceHorizonEnd =
    addDays(today, 30) > horizon.end ? addDays(today, 30) : horizon.end;
  const rules = await transaction
    .selectFrom("commitments")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .where("active", "=", true)
    .where("settled_at", "is", null)
    .where("due_date", "is not", null)
    .execute();
  const savingsGoals = await transaction
    .selectFrom("savings_goals")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .where("status", "=", "active")
    .where("contribution_amount_minor", ">", "0")
    .execute();
  const targets: Array<{
    sourceKey: string;
    kind: string;
    commitmentId: string | null;
    savingsGoalId: string | null;
    incomeScheduleId: string | null;
    name: string;
    amount: string | null;
    expectedOn: string;
    provenance: "manual" | "csv" | "plaid" | "derived";
  }> = rules.flatMap((rule) =>
    materializeCommitmentDates(
      toDateOnly(rule.due_date!),
      rule.recurrence,
      today,
      rule.recurrence === "quarterly" || rule.recurrence === "annual"
        ? addDays(today, 400)
        : occurrenceHorizonEnd,
      rule.recurrence_anchor_day,
      rule.recurrence_anchor_eom,
    ).map((expectedOn) => ({
      sourceKey: `commitment:${rule.id}`,
      kind: "commitment",
      commitmentId: rule.id,
      savingsGoalId: null,
      incomeScheduleId: null,
      name: rule.name,
      amount: rule.amount_minor as string | null,
      expectedOn,
      provenance: (["manual", "csv", "plaid", "derived"].includes(
        rule.provenance,
      )
        ? rule.provenance
        : "derived") as "manual" | "csv" | "plaid" | "derived",
    })),
  );
  for (const schedule of incomeSchedules.filter(
    (item) =>
      item.status === "active" && item.confirmed && item.next_expected_date,
  ))
    targets.push({
      sourceKey: `income-schedule:${schedule.id}`,
      kind: "income",
      commitmentId: null,
      savingsGoalId: null,
      incomeScheduleId: schedule.id,
      name: schedule.name,
      amount: schedule.expected_amount_minor,
      expectedOn: toDateOnly(schedule.next_expected_date!),
      provenance: schedule.provenance as "manual" | "csv" | "plaid" | "derived",
    });
  for (const goal of savingsGoals) {
    const dates =
      goal.schedule === "planning_period"
        ? [horizon.end]
        : materializeCommitmentDates(
            toDateOnly(goal.next_due_on!),
            goal.schedule === "one_time" ? null : goal.schedule,
            today,
            goal.schedule === "quarterly" || goal.schedule === "annual"
              ? addDays(today, 400)
              : occurrenceHorizonEnd,
            goal.schedule_anchor_day,
            goal.schedule_anchor_eom,
          );
    for (const expectedOn of dates)
      targets.push({
        sourceKey: `savings-goal:${goal.id}`,
        kind: "savings",
        commitmentId: null,
        savingsGoalId: goal.id,
        incomeScheduleId: null,
        name: goal.name,
        amount: goal.contribution_amount_minor,
        expectedOn,
        provenance: goal.provenance as "manual" | "csv" | "plaid" | "derived",
      });
  }

  const current = await transaction
    .selectFrom("plan_occurrences")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .orderBy("expected_on", "asc")
    .orderBy("version", "asc")
    .execute();
  const explicitlySkippedIds = new Set(
    (
      await transaction
        .selectFrom("plan_occurrence_revisions")
        .select("occurrence_id")
        .where("household_id", "=", principal.householdId)
        .where("state", "=", "skipped")
        .where("reason", "=", "User marked this occurrence as not due")
        .execute()
    ).map((revision) => revision.occurrence_id),
  );
  const targetIdentities = new Set(
    targets.map((target) => `${target.sourceKey}:${target.expectedOn}`),
  );
  const supersededIds = new Set<string>();
  const retainedIds = new Set<string>();
  for (const target of targets) {
    const sameSource = current.filter(
      (occurrence) => occurrence.source_key === target.sourceKey,
    );
    const lineage = target.commitmentId
      ? current.filter(
          (occurrence) => occurrence.commitment_id === target.commitmentId,
        )
      : target.savingsGoalId
        ? current.filter(
            (occurrence) => occurrence.savings_goal_id === target.savingsGoalId,
          )
        : target.incomeScheduleId
          ? current.filter(
              (occurrence) =>
                occurrence.income_schedule_id === target.incomeScheduleId,
            )
          : sameSource;
    const exact = lineage.find(
      (occurrence) => toDateOnly(occurrence.expected_on) === target.expectedOn,
    );
    const existing = exact ?? lineage.at(-1);
    const unchangedValues =
      existing &&
      existing.name === target.name &&
      existing.expected_amount_minor === target.amount &&
      toDateOnly(existing.expected_on) === target.expectedOn;
    const unchanged =
      unchangedValues &&
      (existing.state !== "skipped" || explicitlySkippedIds.has(existing.id));
    if (
      unchanged ||
      (existing?.state === "verified" &&
        toDateOnly(existing.expected_on) === target.expectedOn)
    ) {
      if (existing) retainedIds.add(existing.id);
      continue;
    }
    if (exact && exact.state !== "verified" && exact.state !== "skipped") {
      await skipOccurrence(
        transaction,
        principal,
        exact,
        "The expected name, amount, or date changed",
      );
      supersededIds.add(exact.id);
    }
    const inserted = await transaction
      .insertInto("plan_occurrences")
      .values({
        household_id: principal.householdId,
        supersedes_occurrence_id: exact?.id ?? existing?.id ?? null,
        source_key: target.sourceKey,
        kind: target.kind,
        commitment_id: target.commitmentId,
        savings_goal_id: target.savingsGoalId,
        income_schedule_id: target.incomeScheduleId,
        name: target.name,
        expected_amount_minor: target.amount,
        expected_on: target.expectedOn,
        provenance: target.provenance,
        verified_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("plan_occurrence_revisions")
      .values({
        household_id: principal.householdId,
        occurrence_id: inserted.id,
        version: inserted.version,
        state: inserted.state,
        matched_amount_minor: inserted.matched_amount_minor,
        verified_at: null,
        reason: existing
          ? "Superseded plan expectation"
          : "Plan expectation created",
        actor_user_id: principal.userId,
      })
      .execute();
  }
  for (const occurrence of current) {
    const unresolvedOverdueCommitment =
      occurrence.kind === "commitment" &&
      occurrence.commitment_id !== null &&
      toDateOnly(occurrence.expected_on) < today &&
      rules.some(
        (rule) =>
          rule.id === occurrence.commitment_id && rule.recurrence === null,
      );
    if (
      occurrence.state === "verified" ||
      unresolvedOverdueCommitment ||
      retainedIds.has(occurrence.id) ||
      supersededIds.has(occurrence.id) ||
      targetIdentities.has(
        `${occurrence.source_key}:${toDateOnly(occurrence.expected_on)}`,
      )
    )
      continue;
    await skipOccurrence(
      transaction,
      principal,
      occurrence,
      "The occurrence is no longer inside the active plan rule",
    );
  }
}

async function skipOccurrence(
  transaction: Transaction<Database>,
  principal: Principal,
  occurrence: {
    id: string;
    version: number;
    state: string;
    matched_amount_minor: string;
  },
  reason: string,
): Promise<void> {
  const activeMatches = await transaction
    .selectFrom("occurrence_transaction_matches")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .where("occurrence_id", "=", occurrence.id)
    .where("state", "in", ["proposed", "confirmed"])
    .execute();
  for (const match of activeMatches) {
    const version = match.version + 1;
    await transaction
      .updateTable("occurrence_transaction_matches")
      .set({ state: "reversed", reason, version, resolved_at: new Date() })
      .where("household_id", "=", principal.householdId)
      .where("id", "=", match.id)
      .where("version", "=", match.version)
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("occurrence_match_revisions")
      .values({
        household_id: principal.householdId,
        match_id: match.id,
        version,
        state: "reversed",
        amount_applied_minor: match.amount_applied_minor,
        reflected_in_balance_observation_id:
          match.reflected_in_balance_observation_id,
        reason,
        actor_user_id: principal.userId,
      })
      .execute();
  }
  const updated = await transaction
    .updateTable("plan_occurrences")
    .set({
      state: "skipped",
      version: occurrence.version + 1,
      verified_at: null,
      updated_at: new Date(),
    })
    .where("household_id", "=", principal.householdId)
    .where("id", "=", occurrence.id)
    .where("version", "=", occurrence.version)
    .returningAll()
    .executeTakeFirstOrThrow();
  await transaction
    .insertInto("plan_occurrence_revisions")
    .values({
      household_id: principal.householdId,
      occurrence_id: updated.id,
      version: updated.version,
      state: updated.state,
      matched_amount_minor: updated.matched_amount_minor,
      verified_at: null,
      reason,
      actor_user_id: principal.userId,
    })
    .execute();
}

async function reverseVerifiedOccurrenceConsequences(
  transaction: Transaction<Database>,
  principal: Principal,
  occurrence: {
    id: string;
    kind: string;
    state: string;
    commitment_id: string | null;
  },
): Promise<boolean> {
  if (occurrence.state !== "verified") return false;
  let changed = false;
  if (occurrence.kind === "commitment" && occurrence.commitment_id) {
    const rule = await transaction
      .selectFrom("commitments")
      .selectAll()
      .where("household_id", "=", principal.householdId)
      .where("id", "=", occurrence.commitment_id)
      .where("settled_by_occurrence_id", "=", occurrence.id)
      .forUpdate()
      .executeTakeFirst();
    if (rule) {
      const updated = await transaction
        .updateTable("commitments")
        .set({
          settled_at: null,
          settled_by_occurrence_id: null,
          version: rule.version + 1,
          updated_at: new Date(),
        })
        .where("household_id", "=", principal.householdId)
        .where("id", "=", rule.id)
        .where("version", "=", rule.version)
        .where("settled_by_occurrence_id", "=", occurrence.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("commitment_revisions")
        .values({
          household_id: principal.householdId,
          commitment_id: updated.id,
          version: updated.version,
          name: updated.name,
          amount_minor: updated.amount_minor,
          currency: updated.currency,
          due_date: updated.due_date,
          active: updated.active,
          settled_at: updated.settled_at,
          actor_user_id: principal.userId,
        })
        .execute();
      changed = true;
    }
  }
  if (occurrence.kind === "savings") {
    const movement = await transaction
      .selectFrom("savings_goal_movements")
      .selectAll()
      .where("household_id", "=", principal.householdId)
      .where("originating_occurrence_id", "=", occurrence.id)
      .where("kind", "=", "contribution")
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    if (movement) {
      const reversal = await transaction
        .selectFrom("savings_goal_movements")
        .select("id")
        .where("household_id", "=", principal.householdId)
        .where("reversed_movement_id", "=", movement.id)
        .where("kind", "=", "reversal")
        .executeTakeFirst();
      if (!reversal) {
        const timezone = (
          await transaction
            .selectFrom("households")
            .select("timezone")
            .where("id", "=", principal.householdId)
            .executeTakeFirstOrThrow()
        ).timezone;
        await createSavingsMovement(transaction, principal, {
          goalId: movement.savings_goal_id,
          kind: "reversal",
          amountMinor: movement.amount_minor,
          effectiveOn: dateInTimezone(new Date(), timezone),
          verificationMethod: movement.verification_method as
            | "provider_verified"
            | "user_confirmed",
          provenance: "derived",
          occurrence: null,
          reversedMovementId: movement.id,
          evidence: [],
        });
        await addActivity(
          transaction,
          principal,
          "savings.movement.reversed",
          "Savings contribution reopened",
          "Its transaction evidence changed, so it no longer counts as confirmed progress",
          "derived",
          "savings_goal",
          movement.savings_goal_id,
          null,
        );
        changed = true;
      }
    }
  }
  return changed;
}

async function recordVerifiedSavingsMovement(
  transaction: Transaction<Database>,
  principal: Principal,
  occurrence: {
    id: string;
    version: number;
    savings_goal_id: string | null;
    expected_on: string;
  },
  matches: Array<{
    amount_applied_minor: string;
    transaction_id: string;
    reflected_in_balance_observation_id: string | null;
    actor_user_id: string | null;
  }>,
) {
  if (!occurrence.savings_goal_id || matches.length === 0) return;
  const exists = await transaction
    .selectFrom("savings_goal_movements")
    .select("id")
    .where("household_id", "=", principal.householdId)
    .where("originating_occurrence_id", "=", occurrence.id)
    .where("originating_occurrence_version", "=", occurrence.version)
    .where("kind", "=", "contribution")
    .executeTakeFirst();
  if (exists) return;
  const goal = await transaction
    .selectFrom("savings_goals")
    .select([
      "id",
      "name",
      "destination_account_id",
      "destination_tracking_started_at",
    ])
    .where("household_id", "=", principal.householdId)
    .where("id", "=", occurrence.savings_goal_id)
    .where("status", "!=", "archived")
    .executeTakeFirst();
  if (!goal?.destination_account_id) return;
  const evidenceRows = await transaction
    .selectFrom("financial_transactions")
    .select([
      "id",
      "account_id",
      "direction",
      "source_kind",
      "amount_minor",
      "occurred_on",
    ])
    .where("household_id", "=", principal.householdId)
    .where(
      "id",
      "in",
      matches.map((match) => match.transaction_id),
    )
    .execute();
  if (
    evidenceRows.length !== matches.length ||
    evidenceRows.some(
      (evidence) =>
        evidence.account_id !== goal.destination_account_id ||
        evidence.direction !== "credit",
    )
  )
    return;
  const amount = matches.reduce(
    (sum, match) => sum + BigInt(match.amount_applied_minor),
    0n,
  );
  const sourceEvidence: Array<{
    role: "source_debit" | "source_balance";
    transactionId?: string;
    balanceObservationId?: string;
  }> = [];
  const providerVerified = matches.every(
    (match) =>
      match.actor_user_id === null &&
      match.reflected_in_balance_observation_id !== null,
  );
  if (providerVerified) {
    for (const destination of evidenceRows) {
      const sources = (
        await sql<{
          id: string;
          account_id: string;
          balance_id: string | null;
        }>`select debit.id,balance.id balance_id
          from transaction_entities entity
          join financial_transactions debit
            on debit.household_id=entity.household_id and debit.id=entity.current_transaction_id
          join accounts account
            on account.household_id=entity.household_id and account.id=entity.account_id
          join transaction_category_assignments category
            on category.household_id=entity.household_id and category.transaction_id=entity.id
          left join lateral (
            select observation.id from balance_observations observation
            where observation.household_id=debit.household_id
              and observation.account_id=debit.account_id
              and observation.provenance='plaid'
              and observation.recorded_at>debit.recorded_at
            order by observation.recorded_at desc limit 1
          ) balance on true
          where entity.household_id=${principal.householdId}
            and entity.account_id<>${goal.destination_account_id}
            and entity.created_at>${goal.destination_tracking_started_at}
            and entity.current_occurred_on between ${addDays(toDateOnly(destination.occurred_on), -3)}::date
              and ${addDays(toDateOnly(destination.occurred_on), 3)}::date
            and debit.source_kind='plaid' and debit.status='posted'
            and debit.direction='debit' and debit.amount_minor=${destination.amount_minor}::bigint
            and account.planning_role='spendable' and account.archived_at is null
            and category.category in ('transfer','savings_investments')
            and not exists (
              select 1 from savings_movement_evidence used
              where used.household_id=entity.household_id and used.transaction_id=debit.id
            )
            and not exists (
              select 1
              from savings_goals other_goal
              join transaction_entities other_entity
                on other_entity.household_id=other_goal.household_id
               and other_entity.account_id=other_goal.destination_account_id
               and other_entity.current_transaction_id is not null
              join financial_transactions other_credit
                on other_credit.household_id=other_entity.household_id
               and other_credit.id=other_entity.current_transaction_id
              where other_goal.household_id=entity.household_id
                and other_goal.status='active'
                and other_goal.destination_account_id<>${goal.destination_account_id}
                and other_goal.destination_tracking_started_at is not null
                and other_entity.created_at>other_goal.destination_tracking_started_at
                and other_credit.occurred_on between debit.occurred_on-3 and debit.occurred_on+3
                and other_credit.source_kind='plaid' and other_credit.status='posted'
                and other_credit.direction='credit'
                and other_credit.amount_minor=debit.amount_minor
            )`.execute(transaction)
      ).rows;
      if (sources.length !== 1 || !sources[0]!.balance_id) return;
      sourceEvidence.push(
        { role: "source_debit", transactionId: sources[0]!.id },
        {
          role: "source_balance",
          balanceObservationId: sources[0]!.balance_id,
        },
      );
    }
  }
  await createSavingsMovement(transaction, principal, {
    goalId: goal.id,
    kind: "contribution",
    amountMinor: amount.toString(),
    effectiveOn: toDateOnly(occurrence.expected_on),
    verificationMethod: providerVerified
      ? "provider_verified"
      : "user_confirmed",
    provenance: providerVerified ? "plaid" : "manual",
    occurrence: { id: occurrence.id, version: occurrence.version },
    reversedMovementId: null,
    evidence: [
      ...sourceEvidence,
      ...matches.flatMap((match) => [
        {
          role: "destination_credit" as const,
          transactionId: match.transaction_id,
        },
        ...(match.reflected_in_balance_observation_id
          ? [
              {
                role: "destination_balance" as const,
                balanceObservationId: match.reflected_in_balance_observation_id,
              },
            ]
          : []),
      ]),
    ],
  });
  await addActivity(
    transaction,
    principal,
    "savings.contribution.verified",
    `${goal.name} contribution confirmed`,
    providerVerified
      ? "The destination transaction and a later bank balance agree"
      : "You confirmed the destination balance includes this contribution",
    providerVerified ? "plaid" : "manual",
    "savings_goal",
    goal.id,
    null,
  );
}

async function reconcileSavingsTransferEvidence(
  transaction: Transaction<Database>,
  principal: Principal,
) {
  const occurrences = await transaction
    .selectFrom("plan_occurrences as occurrence")
    .innerJoin("savings_goals as goal", (join) =>
      join
        .onRef("goal.household_id", "=", "occurrence.household_id")
        .onRef("goal.id", "=", "occurrence.savings_goal_id"),
    )
    .select([
      "occurrence.id",
      "occurrence.name",
      "occurrence.expected_amount_minor",
      "occurrence.expected_on",
      "goal.destination_account_id",
      "goal.destination_tracking_started_at",
    ])
    .where("occurrence.household_id", "=", principal.householdId)
    .where("occurrence.kind", "=", "savings")
    .where("occurrence.state", "in", [
      "expected",
      "pending",
      "partial",
      "overdue",
      "needs_review",
    ])
    .where("goal.status", "=", "active")
    .where("goal.destination_account_id", "is not", null)
    .execute();
  const activeMatches = await transaction
    .selectFrom("occurrence_transaction_matches")
    .select([
      "id",
      "occurrence_id",
      "transaction_id",
      "state",
      "version",
      "amount_applied_minor",
    ])
    .where("household_id", "=", principal.householdId)
    .where("state", "in", ["proposed", "confirmed"])
    .execute();
  const activeMatchByTransaction = new Map(
    activeMatches.map((match) => [match.transaction_id, match]),
  );
  const usedSourceDebits = new Set(
    (
      await transaction
        .selectFrom("savings_movement_evidence")
        .select("transaction_id")
        .where("household_id", "=", principal.householdId)
        .where("evidence_role", "=", "source_debit")
        .where("transaction_id", "is not", null)
        .execute()
    ).flatMap((evidence) =>
      evidence.transaction_id ? [evidence.transaction_id] : [],
    ),
  );
  for (const occurrence of occurrences) {
    if (!occurrence.destination_account_id || !occurrence.expected_amount_minor)
      continue;
    const credits = (
      await sql<{
        id: string;
        amount_minor: string;
        occurred_on: string;
        recorded_at: Date;
        destination_balance_id: string | null;
      }>`select credit.id,credit.amount_minor,credit.occurred_on::text,credit.recorded_at,
          destination_balance.id destination_balance_id
        from transaction_entities entity
        join financial_transactions credit
          on credit.household_id=entity.household_id and credit.id=entity.current_transaction_id
        join accounts destination
          on destination.household_id=entity.household_id and destination.id=entity.account_id
        left join lateral (
          select balance.id from balance_observations balance
          where balance.household_id=credit.household_id
            and balance.account_id=credit.account_id
            and balance.provenance='plaid'
            and balance.recorded_at>credit.recorded_at
          order by balance.recorded_at desc limit 1
        ) destination_balance on true
        where entity.household_id=${principal.householdId}
          and entity.account_id=${occurrence.destination_account_id}
          and entity.created_at>${occurrence.destination_tracking_started_at}
          and entity.current_occurred_on between ${addDays(toDateOnly(occurrence.expected_on), -7)}::date
            and ${addDays(toDateOnly(occurrence.expected_on), 7)}::date
          and credit.source_kind='plaid' and credit.status='posted'
          and credit.direction='credit' and credit.amount_minor=${occurrence.expected_amount_minor}::bigint
          and destination.planning_role='protected' and destination.archived_at is null
        order by abs(credit.occurred_on-${toDateOnly(occurrence.expected_on)}::date),credit.id`.execute(
        transaction,
      )
    ).rows.filter((credit) => {
      const existing = activeMatchByTransaction.get(credit.id);
      return (
        !existing ||
        (existing.occurrence_id === occurrence.id &&
          existing.state === "proposed")
      );
    });
    if (credits.length !== 1) continue;
    const credit = credits[0]!;
    const sourceLegs = (
      await sql<{
        id: string;
        source_balance_id: string | null;
      }>`select debit.id,source_balance.id source_balance_id
        from transaction_entities entity
        join financial_transactions debit
          on debit.household_id=entity.household_id and debit.id=entity.current_transaction_id
        join accounts source
          on source.household_id=entity.household_id and source.id=entity.account_id
        join transaction_category_assignments category
          on category.household_id=entity.household_id and category.transaction_id=entity.id
        left join lateral (
          select balance.id from balance_observations balance
          where balance.household_id=debit.household_id
            and balance.account_id=debit.account_id
            and balance.provenance='plaid'
            and balance.recorded_at>debit.recorded_at
          order by balance.recorded_at desc limit 1
        ) source_balance on true
        where entity.household_id=${principal.householdId}
          and entity.current_occurred_on between ${addDays(credit.occurred_on, -3)}::date
            and ${addDays(credit.occurred_on, 3)}::date
          and entity.account_id<>${occurrence.destination_account_id}
          and entity.created_at>${occurrence.destination_tracking_started_at}
          and debit.source_kind='plaid' and debit.status='posted'
          and debit.direction='debit' and debit.amount_minor=${credit.amount_minor}::bigint
          and source.planning_role='spendable' and source.archived_at is null
          and category.category in ('transfer','savings_investments')
          and not exists (
            select 1
            from savings_goals other_goal
            join transaction_entities other_entity
              on other_entity.household_id=other_goal.household_id
             and other_entity.account_id=other_goal.destination_account_id
             and other_entity.current_transaction_id is not null
            join financial_transactions other_credit
              on other_credit.household_id=other_entity.household_id
             and other_credit.id=other_entity.current_transaction_id
            where other_goal.household_id=entity.household_id
              and other_goal.status='active'
              and other_goal.destination_account_id<>${occurrence.destination_account_id}
              and other_goal.destination_tracking_started_at is not null
              and other_entity.created_at>other_goal.destination_tracking_started_at
              and other_credit.occurred_on between debit.occurred_on-3 and debit.occurred_on+3
              and other_credit.source_kind='plaid' and other_credit.status='posted'
              and other_credit.direction='credit'
              and other_credit.amount_minor=debit.amount_minor
          )
        order by abs(debit.occurred_on-${credit.occurred_on}::date),debit.id`.execute(
        transaction,
      )
    ).rows.filter((source) => !usedSourceDebits.has(source.id));
    const confirmed =
      sourceLegs.length === 1 &&
      sourceLegs[0]!.source_balance_id !== null &&
      credit.destination_balance_id !== null;
    const existing = activeMatchByTransaction.get(credit.id);
    if (existing && !confirmed) continue;
    const reason = confirmed
      ? `Both transfer legs and later balances agree; source ${sourceLegs[0]!.id}`
      : "A destination deposit may fund this savings goal";
    const match = existing
      ? await transaction
          .updateTable("occurrence_transaction_matches")
          .set({
            reflected_in_balance_observation_id: credit.destination_balance_id,
            state: "confirmed",
            confidence: "1.000",
            reason,
            version: existing.version + 1,
            resolved_at: new Date(),
          })
          .where("household_id", "=", principal.householdId)
          .where("id", "=", existing.id)
          .where("version", "=", existing.version)
          .returningAll()
          .executeTakeFirstOrThrow()
      : await transaction
          .insertInto("occurrence_transaction_matches")
          .values({
            household_id: principal.householdId,
            occurrence_id: occurrence.id,
            transaction_id: credit.id,
            reflected_in_balance_observation_id: confirmed
              ? credit.destination_balance_id
              : null,
            amount_applied_minor: credit.amount_minor,
            state: confirmed ? "confirmed" : "proposed",
            confidence: confirmed ? "1.000" : "0.750",
            reason,
            actor_user_id: null,
            resolved_at: confirmed ? new Date() : null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
    await transaction
      .insertInto("occurrence_match_revisions")
      .values({
        household_id: principal.householdId,
        match_id: match.id,
        version: match.version,
        state: match.state,
        amount_applied_minor: match.amount_applied_minor,
        reflected_in_balance_observation_id:
          match.reflected_in_balance_observation_id,
        reason: match.reason,
        actor_user_id: null,
      })
      .execute();
    await addActivity(
      transaction,
      principal,
      "savings.match.created",
      confirmed
        ? `${occurrence.name} transfer found`
        : `${occurrence.name} deposit needs review`,
      confirmed
        ? "Both transfer accounts and later bank balances agree"
        : "Confirm whether the destination deposit belongs to this goal",
      "derived",
      "occurrence",
      occurrence.id,
      null,
    );
    activeMatchByTransaction.set(credit.id, match);
    if (confirmed) usedSourceDebits.add(sourceLegs[0]!.id);
  }
}

async function reconcileSavingsWithdrawals(
  transaction: Transaction<Database>,
  principal: Principal,
) {
  const rows = (
    await sql<{
      goal_id: string;
      goal_name: string;
      transaction_id: string;
      amount_minor: string;
      occurred_on: string;
      balance_id: string;
    }>`select goal.id goal_id,goal.name goal_name,debit.id transaction_id,
        debit.amount_minor,debit.occurred_on::text,balance.id balance_id
      from savings_goals goal
      join accounts destination
        on destination.household_id=goal.household_id
       and destination.id=goal.destination_account_id
       and destination.planning_role='protected' and destination.archived_at is null
      join transaction_entities entity
        on entity.household_id=destination.household_id
       and entity.account_id=destination.id and entity.current_transaction_id is not null
      join financial_transactions debit
        on debit.household_id=entity.household_id and debit.id=entity.current_transaction_id
      join lateral (
        select observation.id from balance_observations observation
        where observation.household_id=debit.household_id
          and observation.account_id=debit.account_id
          and observation.provenance='plaid'
          and observation.recorded_at>debit.recorded_at
        order by observation.recorded_at desc limit 1
      ) balance on true
      where goal.household_id=${principal.householdId}
        and goal.status<>'archived'
        and goal.destination_tracking_started_at is not null
        and entity.created_at>goal.destination_tracking_started_at
        and debit.occurred_on>=current_date-180
        and debit.source_kind='plaid' and debit.status='posted' and debit.direction='debit'
        and not exists (
          select 1 from savings_movement_evidence used
          where used.household_id=goal.household_id and used.transaction_id=debit.id
        )
        and not exists (
          select 1
          from transaction_entities other_entity
          join financial_transactions credit
            on credit.household_id=other_entity.household_id
           and credit.id=other_entity.current_transaction_id
          join accounts protected_destination
            on protected_destination.household_id=other_entity.household_id
           and protected_destination.id=other_entity.account_id
          where other_entity.household_id=goal.household_id
            and other_entity.account_id<>destination.id
            and protected_destination.planning_role='protected'
            and credit.source_kind='plaid' and credit.status='posted'
            and credit.direction='credit' and credit.amount_minor=debit.amount_minor
            and credit.occurred_on between debit.occurred_on-3 and debit.occurred_on+3
        )`.execute(transaction)
  ).rows;
  for (const row of rows) {
    await createSavingsMovement(transaction, principal, {
      goalId: row.goal_id,
      kind: "withdrawal",
      amountMinor: row.amount_minor,
      effectiveOn: row.occurred_on,
      verificationMethod: "provider_verified",
      provenance: "plaid",
      occurrence: null,
      reversedMovementId: null,
      evidence: [
        { role: "source_debit", transactionId: row.transaction_id },
        { role: "source_balance", balanceObservationId: row.balance_id },
      ],
    });
    await addActivity(
      transaction,
      principal,
      "savings.withdrawal.verified",
      `${row.goal_name} balance decreased`,
      `$${minorToDecimal(row.amount_minor)} left the protected savings account`,
      "plaid",
      "savings_goal",
      row.goal_id,
      null,
    );
  }
}

async function reverseInvalidSavingsMovements(
  transaction: Transaction<Database>,
  principal: Principal,
  today: string,
) {
  const invalid = (
    await sql<{
      id: string;
      savings_goal_id: string;
      amount_minor: string;
      verification_method: "provider_verified" | "user_confirmed";
    }>`select distinct movement.id,movement.savings_goal_id,
        movement.amount_minor,movement.verification_method
      from savings_goal_movements movement
      join savings_movement_evidence link
        on link.household_id=movement.household_id and link.movement_id=movement.id
      join financial_transactions evidence
        on evidence.household_id=link.household_id and evidence.id=link.transaction_id
      join transaction_entities entity
        on entity.household_id=evidence.household_id and entity.id=evidence.transaction_id
      where movement.household_id=${principal.householdId}
        and movement.kind<>'reversal' and movement.provenance='plaid'
        and link.transaction_id is not null
        and (entity.current_transaction_id is distinct from evidence.id or evidence.status<>'posted')
        and not exists (
          select 1 from savings_goal_movements reversal
          where reversal.household_id=movement.household_id
            and reversal.kind='reversal' and reversal.reversed_movement_id=movement.id
        )`.execute(transaction)
  ).rows;
  for (const movement of invalid) {
    await createSavingsMovement(transaction, principal, {
      goalId: movement.savings_goal_id,
      kind: "reversal",
      amountMinor: movement.amount_minor,
      effectiveOn: today,
      verificationMethod: movement.verification_method,
      provenance: "derived",
      occurrence: null,
      reversedMovementId: movement.id,
      evidence: [],
    });
    await addActivity(
      transaction,
      principal,
      "savings.movement.reversed",
      "Savings movement reopened",
      "The bank revised or removed its transaction evidence",
      "derived",
      "savings_goal",
      movement.savings_goal_id,
      null,
    );
  }
}

async function reconcileDebtPaymentEvidence(
  transaction: Transaction<Database>,
  principal: Principal,
) {
  const invalid = (
    await sql<{
      evidence_id: string;
      match_id: string;
      match_version: number;
      match_state: string;
      occurrence_id: string;
      occurrence_state: string;
      commitment_id: string | null;
      amount_minor: string;
    }>`select proof.id evidence_id,match.id match_id,match.version match_version,match.state match_state,occurrence.id occurrence_id,
      occurrence.state occurrence_state,occurrence.commitment_id,match.amount_applied_minor amount_minor
    from debt_payment_evidence proof
    left join debt_payment_evidence_reversals reversal on reversal.household_id=proof.household_id and reversal.evidence_id=proof.id
    join occurrence_transaction_matches match on match.household_id=proof.household_id and match.id=proof.occurrence_match_id
    join plan_occurrences occurrence on occurrence.household_id=match.household_id and occurrence.id=match.occurrence_id
    join financial_transactions liability on liability.household_id=proof.household_id and liability.id=proof.liability_transaction_id
    join transaction_entities liability_entity on liability_entity.household_id=liability.household_id and liability_entity.id=liability.transaction_id
    join financial_transactions source on source.household_id=match.household_id and source.id=match.transaction_id
    join transaction_entities source_entity on source_entity.household_id=source.household_id and source_entity.id=source.transaction_id
    where proof.household_id=${principal.householdId} and reversal.id is null
      and (match.state<>'confirmed'
        or liability_entity.current_transaction_id is distinct from liability.id or liability.status<>'posted'
        or source_entity.current_transaction_id is distinct from source.id or source.status<>'posted')`.execute(
      transaction,
    )
  ).rows;
  for (const row of invalid) {
    await transaction
      .insertInto("debt_payment_evidence_reversals")
      .values({
        household_id: principal.householdId,
        evidence_id: row.evidence_id,
        reason: "A payment transaction was revised, removed, or rematched",
      })
      .execute();
    if (row.match_state === "confirmed") {
      await transaction
        .updateTable("occurrence_transaction_matches")
        .set({
          state: "reversed",
          reason: "A payment transaction was revised or removed",
          version: row.match_version + 1,
          resolved_at: new Date(),
        })
        .where("household_id", "=", principal.householdId)
        .where("id", "=", row.match_id)
        .where("version", "=", row.match_version)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("occurrence_match_revisions")
        .values({
          household_id: principal.householdId,
          match_id: row.match_id,
          version: row.match_version + 1,
          state: "reversed",
          amount_applied_minor: row.amount_minor,
          reflected_in_balance_observation_id: null,
          reason: "A payment transaction was revised or removed",
          actor_user_id: null,
        })
        .execute();
      await reverseVerifiedOccurrenceConsequences(transaction, principal, {
        id: row.occurrence_id,
        kind: "commitment",
        state: row.occurrence_state,
        commitment_id: row.commitment_id,
      });
    }
  }

  const proposals = (
    await sql<{
      match_id: string;
      match_version: number;
      occurrence_id: string;
      debt_id: string;
      liability_account_id: string;
      source_transaction_id: string;
      source_recorded_at: Date;
      amount_minor: string;
      occurred_on: string;
    }>`select match.id match_id,match.version match_version,occurrence.id occurrence_id,
      debt.id debt_id,debt.account_id liability_account_id,source.id source_transaction_id,
      source.recorded_at source_recorded_at,match.amount_applied_minor amount_minor,source.occurred_on::text
    from occurrence_transaction_matches match
    join plan_occurrences occurrence on occurrence.household_id=match.household_id and occurrence.id=match.occurrence_id
    join debts debt on debt.household_id=occurrence.household_id and debt.linked_commitment_id=occurrence.commitment_id and debt.status='active'
    join financial_transactions source on source.household_id=match.household_id and source.id=match.transaction_id
    where match.household_id=${principal.householdId} and match.state='proposed'
      and source.status='posted' and source.direction='debit' and source.source_kind='plaid'`.execute(
      transaction,
    )
  ).rows;
  for (const proposal of proposals) {
    const sourceBalance = await transaction
      .selectFrom("balance_observations")
      .select("id")
      .where("household_id", "=", principal.householdId)
      .where("account_id", "=", (eb) =>
        eb
          .selectFrom("financial_transactions")
          .select("account_id")
          .where("id", "=", proposal.source_transaction_id),
      )
      .where("provenance", "=", "plaid")
      .where("recorded_at", ">", proposal.source_recorded_at)
      .orderBy("recorded_at", "desc")
      .executeTakeFirst();
    if (!sourceBalance) continue;
    const liability = (
      await sql<{
        transaction_id: string;
        balance_id: string | null;
      }>`select credit.id transaction_id,balance.id balance_id
      from transaction_entities entity
      join financial_transactions credit on credit.household_id=entity.household_id and credit.id=entity.current_transaction_id
      left join lateral (select observation.id from debt_balance_observations observation
        where observation.household_id=credit.household_id and observation.debt_id=${proposal.debt_id}
          and observation.provenance='plaid' and observation.recorded_at>credit.recorded_at
        order by observation.recorded_at desc limit 1) balance on true
      where entity.household_id=${principal.householdId} and entity.account_id=${proposal.liability_account_id}
        and entity.current_occurred_on between ${addDays(proposal.occurred_on, -3)}::date and ${addDays(proposal.occurred_on, 3)}::date
        and credit.source_kind='plaid' and credit.status='posted' and credit.direction='credit'
        and credit.amount_minor=${proposal.amount_minor}::bigint
        and not exists(select 1 from debt_payment_evidence used
          left join debt_payment_evidence_reversals reversal on reversal.household_id=used.household_id and reversal.evidence_id=used.id
          where used.household_id=entity.household_id and used.liability_transaction_id=credit.id and reversal.id is null)`.execute(
        transaction,
      )
    ).rows;
    if (liability.length !== 1 || !liability[0]!.balance_id) continue;
    const nextVersion = proposal.match_version + 1;
    await transaction
      .updateTable("occurrence_transaction_matches")
      .set({
        state: "confirmed",
        reflected_in_balance_observation_id: sourceBalance.id,
        confidence: "1.000",
        reason: "Both payment legs and later balances agree",
        version: nextVersion,
        resolved_at: new Date(),
      })
      .where("household_id", "=", principal.householdId)
      .where("id", "=", proposal.match_id)
      .where("version", "=", proposal.match_version)
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("occurrence_match_revisions")
      .values({
        household_id: principal.householdId,
        match_id: proposal.match_id,
        version: nextVersion,
        state: "confirmed",
        amount_applied_minor: proposal.amount_minor,
        reflected_in_balance_observation_id: sourceBalance.id,
        reason: "Both payment legs and later balances agree",
        actor_user_id: null,
      })
      .execute();
    await transaction
      .insertInto("debt_payment_evidence")
      .values({
        household_id: principal.householdId,
        debt_id: proposal.debt_id,
        occurrence_match_id: proposal.match_id,
        liability_transaction_id: liability[0]!.transaction_id,
        liability_balance_observation_id: liability[0]!.balance_id!,
        source_balance_observation_id: sourceBalance.id,
      })
      .execute();
    await addActivity(
      transaction,
      principal,
      "debt.payment.verified",
      "Debt payment confirmed",
      "Both accounts and later balances agree; the debt balance remains bank-observed",
      "plaid",
      "debt",
      proposal.debt_id,
      null,
    );
  }
}

export async function reconcilePlanEvidence(
  transaction: Transaction<Database>,
  principal: Principal,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${principal.householdId}, 7241))`.execute(
    transaction,
  );
  const household = await transaction
    .selectFrom("households")
    .select("timezone")
    .where("id", "=", principal.householdId)
    .executeTakeFirstOrThrow();
  const today = dateInTimezone(new Date(), household.timezone);
  await reverseInvalidSavingsMovements(transaction, principal, today);
  let consequencesReversed = false;
  const activeMatches = await transaction
    .selectFrom("occurrence_transaction_matches as match")
    .innerJoin(
      "financial_transactions as evidence",
      "evidence.id",
      "match.transaction_id",
    )
    .innerJoin("transaction_entities as entity", (join) =>
      join
        .onRef("entity.household_id", "=", "evidence.household_id")
        .onRef("entity.id", "=", "evidence.transaction_id"),
    )
    .innerJoin("plan_occurrences as occurrence", (join) =>
      join
        .onRef("occurrence.household_id", "=", "match.household_id")
        .onRef("occurrence.id", "=", "match.occurrence_id"),
    )
    .select([
      "match.id",
      "match.version",
      "match.occurrence_id",
      "match.transaction_id",
      "match.amount_applied_minor",
      "match.state",
      "evidence.status as evidence_status",
      "entity.current_transaction_id",
      "occurrence.kind as occurrence_kind",
      "occurrence.state as occurrence_state",
      "occurrence.commitment_id",
    ])
    .where("match.household_id", "=", principal.householdId)
    .where("match.state", "in", ["proposed", "confirmed"])
    .execute();
  for (const match of activeMatches) {
    if (
      match.current_transaction_id === match.transaction_id &&
      (match.evidence_status === "posted" ||
        (match.state === "proposed" && match.evidence_status === "pending"))
    )
      continue;
    const nextVersion = match.version + 1;
    await transaction
      .updateTable("occurrence_transaction_matches")
      .set({
        state: "reversed",
        reason: "The provider removed or revised the matched transaction",
        version: nextVersion,
        resolved_at: new Date(),
      })
      .where("household_id", "=", principal.householdId)
      .where("id", "=", match.id)
      .where("version", "=", match.version)
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("occurrence_match_revisions")
      .values({
        household_id: principal.householdId,
        match_id: match.id,
        version: nextVersion,
        state: "reversed",
        amount_applied_minor: match.amount_applied_minor,
        reflected_in_balance_observation_id: null,
        reason: "The provider removed or revised the matched transaction",
        actor_user_id: null,
      })
      .execute();
    consequencesReversed =
      (await reverseVerifiedOccurrenceConsequences(transaction, principal, {
        id: match.occurrence_id,
        kind: match.occurrence_kind,
        state: match.occurrence_state,
        commitment_id: match.commitment_id,
      })) || consequencesReversed;
    await addActivity(
      transaction,
      principal,
      "occurrence.match.reversed",
      match.occurrence_kind === "income"
        ? "A previous deposit match was reopened"
        : match.occurrence_kind === "savings"
          ? "A previous contribution match was reopened"
          : "A previous payment match was reopened",
      match.occurrence_kind === "income"
        ? "The provider revised or removed the deposit; expected income needs review again"
        : match.occurrence_kind === "savings"
          ? "The provider revised or removed the contribution; savings progress needs review again"
          : "The provider revised or removed the transaction; the money is reserved again",
      "derived",
      "occurrence",
      match.occurrence_id,
      null,
    );
  }

  const awaitingReflection = await transaction
    .selectFrom("occurrence_transaction_matches as match")
    .innerJoin(
      "financial_transactions as evidence",
      "evidence.id",
      "match.transaction_id",
    )
    .select([
      "match.id",
      "match.version",
      "match.amount_applied_minor",
      "match.reason",
      "evidence.account_id",
      "evidence.recorded_at",
      "evidence.source_kind",
    ])
    .where("match.household_id", "=", principal.householdId)
    .where("match.state", "=", "confirmed")
    .where("match.reflected_in_balance_observation_id", "is", null)
    .execute();
  for (const match of awaitingReflection) {
    const balance = await transaction
      .selectFrom("balance_observations")
      .select("id")
      .where("household_id", "=", principal.householdId)
      .where("account_id", "=", match.account_id)
      .where("provenance", "=", match.source_kind)
      .where("recorded_at", ">", match.recorded_at)
      .orderBy("recorded_at", "desc")
      .executeTakeFirst();
    if (!balance) continue;
    const nextVersion = match.version + 1;
    await transaction
      .updateTable("occurrence_transaction_matches")
      .set({
        reflected_in_balance_observation_id: balance.id,
        reason: "A later provider balance now reflects the posted transaction",
        version: nextVersion,
      })
      .where("household_id", "=", principal.householdId)
      .where("id", "=", match.id)
      .where("version", "=", match.version)
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("occurrence_match_revisions")
      .values({
        household_id: principal.householdId,
        match_id: match.id,
        version: nextVersion,
        state: "confirmed",
        amount_applied_minor: match.amount_applied_minor,
        reflected_in_balance_observation_id: balance.id,
        reason: "A later provider balance now reflects the posted transaction",
        actor_user_id: null,
      })
      .execute();
  }

  await reconcileSavingsTransferEvidence(transaction, principal);
  await reconcileSavingsWithdrawals(transaction, principal);

  const activeLinks = await transaction
    .selectFrom("occurrence_transaction_matches")
    .select(["occurrence_id", "transaction_id"])
    .where("household_id", "=", principal.householdId)
    .where("state", "in", ["proposed", "confirmed"])
    .execute();
  const usedTransactionIds = new Set(
    activeLinks.map((match) => match.transaction_id),
  );
  const usedOccurrenceIds = new Set(
    activeLinks.map((match) => match.occurrence_id),
  );
  const occurrencesWithProposal = new Set(
    (
      await transaction
        .selectFrom("occurrence_transaction_matches")
        .select("occurrence_id")
        .where("household_id", "=", principal.householdId)
        .where("state", "=", "proposed")
        .execute()
    ).map((match) => match.occurrence_id),
  );
  const previousLinks = await transaction
    .selectFrom("occurrence_transaction_matches")
    .select(["occurrence_id", "transaction_id"])
    .where("household_id", "=", principal.householdId)
    .execute();
  const usedPairs = new Set(
    previousLinks.map(
      (match) => `${match.occurrence_id}:${match.transaction_id}`,
    ),
  );
  const debtCommitments = new Set(
    (
      await transaction
        .selectFrom("debts")
        .select("linked_commitment_id")
        .where("household_id", "=", principal.householdId)
        .where("status", "=", "active")
        .where("linked_commitment_id", "is not", null)
        .execute()
    ).flatMap((debt) =>
      debt.linked_commitment_id ? [debt.linked_commitment_id] : [],
    ),
  );
  const openOccurrences = await transaction
    .selectFrom("plan_occurrences")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .where("state", "in", [
      "expected",
      "pending",
      "partial",
      "overdue",
      "needs_review",
    ])
    .execute();
  const occurrenceDates = openOccurrences.map((occurrence) =>
    toDateOnly(occurrence.expected_on),
  );
  const hasIncome = openOccurrences.some(
    (occurrence) => occurrence.kind === "income",
  );
  const hasCommitment = openOccurrences.some(
    (occurrence) => occurrence.kind === "commitment",
  );
  const candidateDirection =
    hasIncome && !hasCommitment
      ? "credit"
      : hasCommitment && !hasIncome
        ? "debit"
        : null;
  const candidateRows = occurrenceDates.length
    ? (
        await sql<{
          id: string;
          account_id: string;
          merchant: string;
          amount_minor: string;
          occurred_on: string;
          direction: "debit" | "credit";
          status: string;
          source_kind: string;
          account_type: string;
          include_in_plan: boolean;
          category: string;
        }>`select evidence.id,evidence.account_id,evidence.merchant,evidence.amount_minor,
            entity.current_occurred_on::text occurred_on,evidence.direction,
            evidence.status,evidence.source_kind,account.account_type,
            account.include_in_plan,category.category
          from transaction_entities entity
          join financial_transactions evidence
            on evidence.household_id=entity.household_id
           and evidence.id=entity.current_transaction_id
          join accounts account
            on account.household_id=entity.household_id
           and account.id=entity.account_id
          join transaction_category_assignments category on category.household_id=entity.household_id and category.transaction_id=entity.id
          where entity.household_id=${principal.householdId}
            and entity.current_transaction_id is not null
            and entity.current_occurred_on between ${addDays(
              occurrenceDates.reduce((left, right) =>
                left < right ? left : right,
              ),
              -7,
            )}::date and ${addDays(
              occurrenceDates.reduce((left, right) =>
                left > right ? left : right,
              ),
              7,
            )}::date
            and evidence.source_kind='plaid' and evidence.status='posted'
            and account.archived_at is null
            and account.account_type in ('cash','checking','savings')
            and (${candidateDirection}::text is null or evidence.direction=${candidateDirection}::text)`.execute(
          transaction,
        )
      ).rows
    : [];
  const candidates: Array<{
    occurrence: (typeof openOccurrences)[number];
    row: (typeof candidateRows)[number];
    score: number;
    automatic: boolean;
    reason: string;
    remaining: bigint | null;
  }> = [];
  const allocatedRows = await transaction
    .selectFrom("occurrence_transaction_matches")
    .select(["occurrence_id", "amount_applied_minor"])
    .where("household_id", "=", principal.householdId)
    .where("state", "=", "confirmed")
    .execute();
  const allocatedByOccurrence = new Map<string, bigint>();
  for (const match of allocatedRows)
    allocatedByOccurrence.set(
      match.occurrence_id,
      (allocatedByOccurrence.get(match.occurrence_id) ?? 0n) +
        BigInt(match.amount_applied_minor),
    );
  const incomeDestinations = new Map(
    (
      await transaction
        .selectFrom("income_schedules")
        .select(["id", "destination_account_id"])
        .where("household_id", "=", principal.householdId)
        .execute()
    ).map((schedule) => [schedule.id, schedule.destination_account_id]),
  );
  for (const occurrence of openOccurrences) {
    if (occurrence.kind === "savings") continue;
    const allocated = allocatedByOccurrence.get(occurrence.id) ?? 0n;
    const remaining =
      occurrence.expected_amount_minor === null
        ? allocated === 0n
          ? null
          : 0n
        : bigintMax(BigInt(occurrence.expected_amount_minor) - allocated, 0n);
    if (remaining === 0n) continue;
    for (const row of candidateRows) {
      const incomeDestination = occurrence.income_schedule_id
        ? incomeDestinations.get(occurrence.income_schedule_id)
        : null;
      if (
        row.source_kind !== "plaid" ||
        row.status !== "posted" ||
        (occurrence.kind !== "income" && !row.include_in_plan) ||
        !["cash", "checking", "savings"].includes(row.account_type) ||
        (occurrence.kind === "income" && row.category !== "income") ||
        (incomeDestination && incomeDestination !== row.account_id) ||
        usedTransactionIds.has(row.id)
      )
        continue;
      const scored = scoreReconciliationCandidate({
        kind: occurrence.kind as "income" | "commitment",
        expectedName: occurrence.name,
        expectedAmountMinor: remaining,
        expectedOn: toDateOnly(occurrence.expected_on),
        merchant: row.merchant,
        amountMinor: BigInt(row.amount_minor),
        occurredOn: row.occurred_on,
        direction: row.direction,
      });
      if (scored.automatic || scored.score >= 0.6)
        candidates.push({ occurrence, row, remaining, ...scored });
    }
  }
  const strongByOccurrence = new Map<string, number>();
  const strongByTransaction = new Map<string, number>();
  const incomeCandidatesByTransaction = new Map<string, number>();
  for (const candidate of candidates.filter(
    (item) => item.occurrence.kind === "income",
  ))
    incomeCandidatesByTransaction.set(
      candidate.row.id,
      (incomeCandidatesByTransaction.get(candidate.row.id) ?? 0) + 1,
    );
  for (const candidate of candidates.filter(
    (item) => item.automatic && item.row.status === "posted",
  )) {
    strongByOccurrence.set(
      candidate.occurrence.id,
      (strongByOccurrence.get(candidate.occurrence.id) ?? 0) + 1,
    );
    strongByTransaction.set(
      candidate.row.id,
      (strongByTransaction.get(candidate.row.id) ?? 0) + 1,
    );
  }
  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      left.occurrence.id.localeCompare(right.occurrence.id) ||
      left.row.id.localeCompare(right.row.id),
  );
  for (const candidate of candidates) {
    const pair = `${candidate.occurrence.id}:${candidate.row.id}`;
    const debtPayment = debtCommitments.has(
      candidate.occurrence.commitment_id ?? "",
    );
    const ambiguousIncome =
      candidate.occurrence.kind === "income" &&
      (incomeCandidatesByTransaction.get(candidate.row.id) ?? 0) > 1;
    if (
      usedPairs.has(pair) ||
      (usedTransactionIds.has(candidate.row.id) && !ambiguousIncome) ||
      (usedOccurrenceIds.has(candidate.occurrence.id) &&
        (candidate.occurrence.kind === "income"
          ? occurrencesWithProposal.has(candidate.occurrence.id)
          : !debtPayment ||
            occurrencesWithProposal.has(candidate.occurrence.id)))
    )
      continue;
    const confirmed =
      !ambiguousIncome &&
      candidate.automatic &&
      !debtCommitments.has(candidate.occurrence.commitment_id ?? "") &&
      strongByOccurrence.get(candidate.occurrence.id) === 1 &&
      strongByTransaction.get(candidate.row.id) === 1;
    const applied =
      candidate.remaining === null
        ? candidate.row.amount_minor
        : BigInt(candidate.row.amount_minor) < candidate.remaining
          ? candidate.row.amount_minor
          : candidate.remaining.toString();
    const match = await transaction
      .insertInto("occurrence_transaction_matches")
      .values({
        household_id: principal.householdId,
        occurrence_id: candidate.occurrence.id,
        transaction_id: candidate.row.id,
        reflected_in_balance_observation_id: null,
        amount_applied_minor: applied,
        state: confirmed ? "confirmed" : "proposed",
        confidence: candidate.score.toFixed(3),
        reason: ambiguousIncome
          ? "This deposit fits more than one expected income; choose the right one"
          : candidate.reason,
        actor_user_id: null,
        resolved_at: confirmed ? new Date() : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("occurrence_match_revisions")
      .values({
        household_id: principal.householdId,
        match_id: match.id,
        version: match.version,
        state: match.state,
        amount_applied_minor: match.amount_applied_minor,
        reflected_in_balance_observation_id: null,
        reason: match.reason,
        actor_user_id: null,
      })
      .execute();
    await addActivity(
      transaction,
      principal,
      "occurrence.match.created",
      candidate.occurrence.kind === "income"
        ? ambiguousIncome
          ? "Deposit needs an income source"
          : `${candidate.occurrence.name} deposit ${confirmed ? "found" : "may have arrived"}`
        : `${candidate.occurrence.name} payment ${confirmed ? "found" : "needs review"}`,
      confirmed
        ? "Posted transaction matched; waiting for the next balance refresh before changing available cash"
        : ambiguousIncome
          ? "This transaction fits multiple income schedules. Review it in Activity and confirm one."
          : "A possible transaction match needs your confirmation",
      "derived",
      "occurrence",
      candidate.occurrence.id,
      null,
    );
    usedPairs.add(pair);
    usedTransactionIds.add(candidate.row.id);
    usedOccurrenceIds.add(candidate.occurrence.id);
    occurrencesWithProposal.add(candidate.occurrence.id);
  }

  await reconcileDebtPaymentEvidence(transaction, principal);

  const lifecycleOccurrences = await transaction
    .selectFrom("plan_occurrences")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .where("state", "!=", "skipped")
    .execute();
  const verifiedCommitments: Array<{
    id: string;
    occurrenceId: string;
    expectedOn: string;
  }> = [];
  for (const occurrence of lifecycleOccurrences) {
    const matches = await transaction
      .selectFrom("occurrence_transaction_matches")
      .select([
        "amount_applied_minor",
        "state",
        "reflected_in_balance_observation_id",
        "transaction_id",
        "actor_user_id",
      ])
      .where("household_id", "=", principal.householdId)
      .where("occurrence_id", "=", occurrence.id)
      .where("state", "in", ["confirmed", "proposed"])
      .execute();
    const confirmedMatches = matches.filter(
      (match) => match.state === "confirmed",
    );
    const reflected = confirmedMatches.filter(
      (match) => match.reflected_in_balance_observation_id !== null,
    );
    const matched = reflected.reduce(
      (sum, match) => sum + BigInt(match.amount_applied_minor),
      0n,
    );
    const expected =
      occurrence.expected_amount_minor === null
        ? null
        : BigInt(occurrence.expected_amount_minor);
    const verified = matched > 0n && (expected === null || matched >= expected);
    const awaitingBalance = confirmedMatches.some(
      (match) => match.reflected_in_balance_observation_id === null,
    );
    const needsReview = matches.some((match) => match.state === "proposed");
    const state = verified
      ? "verified"
      : awaitingBalance
        ? "pending"
        : needsReview
          ? "needs_review"
          : matched > 0n
            ? "partial"
            : toDateOnly(occurrence.expected_on) < today
              ? "overdue"
              : "expected";
    if (
      state === occurrence.state &&
      matched.toString() === occurrence.matched_amount_minor
    )
      continue;
    const now = new Date();
    const updated = await transaction
      .updateTable("plan_occurrences")
      .set({
        state,
        matched_amount_minor: matched.toString(),
        version: occurrence.version + 1,
        verified_at: verified ? now : null,
        updated_at: now,
      })
      .where("household_id", "=", principal.householdId)
      .where("id", "=", occurrence.id)
      .where("version", "=", occurrence.version)
      .returningAll()
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("plan_occurrence_revisions")
      .values({
        household_id: principal.householdId,
        occurrence_id: occurrence.id,
        version: updated.version,
        state: updated.state,
        matched_amount_minor: updated.matched_amount_minor,
        verified_at: updated.verified_at,
        reason: verified
          ? "Posted transaction and refreshed balance verified"
          : "Transaction evidence changed",
        actor_user_id: null,
      })
      .execute();
    if (verified)
      await addActivity(
        transaction,
        principal,
        "occurrence.verified",
        `${occurrence.name} verified`,
        "Posted transaction and a later balance observation agree",
        "derived",
        "occurrence",
        occurrence.id,
        null,
      );
    if (verified && occurrence.kind === "savings" && occurrence.savings_goal_id)
      await recordVerifiedSavingsMovement(
        transaction,
        principal,
        updated,
        reflected,
      );
    if (
      verified &&
      occurrence.kind === "commitment" &&
      occurrence.commitment_id
    )
      verifiedCommitments.push({
        id: occurrence.commitment_id,
        occurrenceId: occurrence.id,
        expectedOn: toDateOnly(occurrence.expected_on),
      });
  }
  if (verifiedCommitments.length) {
    for (const verified of verifiedCommitments) {
      const rule = await transaction
        .selectFrom("commitments")
        .selectAll()
        .where("household_id", "=", principal.householdId)
        .where("id", "=", verified.id)
        .forUpdate()
        .executeTakeFirst();
      if (!rule || !rule.active || rule.settled_at || !rule.due_date) continue;
      if (toDateOnly(rule.due_date) !== verified.expectedOn) continue;
      if (rule.recurrence) continue;
      const nextDue = null;
      const updated = await transaction
        .updateTable("commitments")
        .set({
          due_date: nextDue ?? rule.due_date,
          settled_at: nextDue ? null : new Date(),
          settled_by_occurrence_id: nextDue ? null : verified.occurrenceId,
          version: rule.version + 1,
          updated_at: new Date(),
        })
        .where("household_id", "=", principal.householdId)
        .where("id", "=", rule.id)
        .where("version", "=", rule.version)
        .returningAll()
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("commitment_revisions")
        .values({
          household_id: principal.householdId,
          commitment_id: updated.id,
          version: updated.version,
          name: updated.name,
          amount_minor: updated.amount_minor,
          currency: updated.currency,
          due_date: updated.due_date,
          active: updated.active,
          settled_at: updated.settled_at,
          actor_user_id: null,
        })
        .execute();
    }
    const plan = await transaction
      .selectFrom("plans")
      .selectAll()
      .where("household_id", "=", principal.householdId)
      .executeTakeFirstOrThrow();
    await synchronizePlanOccurrences(transaction, principal, plan);
  }
  await recomputeIncomeSchedulesFromEvidence(transaction, principal);
  if (consequencesReversed) {
    const plan = await transaction
      .selectFrom("plans")
      .selectAll()
      .where("household_id", "=", principal.householdId)
      .executeTakeFirstOrThrow();
    await synchronizePlanOccurrences(transaction, principal, plan);
  }
}

async function recomputeIncomeSchedulesFromEvidence(
  transaction: Transaction<Database>,
  principal: Principal,
) {
  const schedules = await transaction
    .selectFrom("income_schedules")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .where("status", "=", "active")
    .forUpdate()
    .execute();
  for (const schedule of schedules) {
    const latest = await transaction
      .selectFrom("plan_occurrences")
      .select(["id", "expected_on"])
      .where("household_id", "=", principal.householdId)
      .where("income_schedule_id", "=", schedule.id)
      .where("state", "=", "verified")
      .orderBy("expected_on", "desc")
      .orderBy("verified_at", "desc")
      .executeTakeFirst();
    if (!latest) {
      if (
        !schedule.advanced_from_occurrence_id ||
        !schedule.previous_expected_date
      )
        continue;
      const restored = await transaction
        .updateTable("income_schedules")
        .set({
          next_expected_date: toDateOnly(schedule.previous_expected_date),
          confirmed: true,
          advanced_from_occurrence_id: null,
          previous_expected_date: null,
          version: schedule.version + 1,
          updated_at: new Date(),
        })
        .where("household_id", "=", principal.householdId)
        .where("id", "=", schedule.id)
        .where("version", "=", schedule.version)
        .returningAll()
        .executeTakeFirstOrThrow();
      await appendIncomeScheduleRevision(
        transaction,
        principal,
        restored,
        "Deposit evidence reversed; expected date restored",
      );
      continue;
    }
    const expectedOn = toDateOnly(latest.expected_on);
    // A user edit clears the automatic lineage. Historical deposits must not
    // overwrite that newer date on the next sync; only the occurrence for the
    // currently expected date may start a fresh advancement chain.
    if (
      !schedule.advanced_from_occurrence_id &&
      (!schedule.next_expected_date ||
        toDateOnly(schedule.next_expected_date) !== expectedOn)
    )
      continue;
    const nextDate = advanceIncomeScheduleDate(expectedOn, {
      frequency: schedule.frequency as
        | "weekly"
        | "biweekly"
        | "semi_monthly"
        | "monthly"
        | "quarterly"
        | "annual"
        | "irregular",
      anchorDay: schedule.anchor_day,
      anchorEndOfMonth: schedule.anchor_eom,
      secondAnchorDay: schedule.second_anchor_day,
      secondAnchorEndOfMonth: schedule.second_anchor_eom,
    });
    if (
      schedule.advanced_from_occurrence_id === latest.id &&
      (schedule.next_expected_date
        ? toDateOnly(schedule.next_expected_date)
        : null) === nextDate
    )
      continue;
    const updated = await transaction
      .updateTable("income_schedules")
      .set({
        next_expected_date: nextDate,
        confirmed: nextDate !== null,
        advanced_from_occurrence_id: latest.id,
        previous_expected_date: expectedOn,
        version: schedule.version + 1,
        updated_at: new Date(),
      })
      .where("household_id", "=", principal.householdId)
      .where("id", "=", schedule.id)
      .where("version", "=", schedule.version)
      .returningAll()
      .executeTakeFirstOrThrow();
    await appendIncomeScheduleRevision(
      transaction,
      principal,
      updated,
      nextDate
        ? "Verified deposit advanced this income schedule"
        : "Irregular deposit verified; next date needs confirmation",
    );
    await addActivity(
      transaction,
      principal,
      "income.received",
      `${updated.name} received`,
      nextDate
        ? `Next expected ${nextDate}`
        : "No future deposit assumed; add another date when known",
      "derived",
      "income_schedule",
      updated.id,
      null,
    );
  }
  const plan = await transaction
    .selectFrom("plans")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .executeTakeFirstOrThrow();
  await synchronizePlanOccurrences(transaction, principal, plan);
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
    planning_role: "spendable" | "protected" | "excluded";
    amount_minor: string | null;
    as_of: Date | null;
    connection_status: string | null;
    last_sync_at: Date | null;
  }>`
    select a.id, a.connection_id, a.version, a.name, a.account_type, a.currency, a.provenance, a.include_in_plan, a.planning_role, latest.amount_minor, latest.as_of,
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
  const availableCashPreference = await transaction
    .selectFrom("notification_preferences")
    .select(["available_cash_alerts", "available_cash_threshold_minor"])
    .where("household_id", "=", principal.householdId)
    .where("user_id", "=", principal.userId)
    .executeTakeFirst();
  const availableCashEpisode = await sql<{
    id: string;
    last_available_minor: string;
    calculated_at: Date;
    freshness_status: "current" | "manual" | "stale" | "incomplete";
  }>`select episode.id,episode.last_available_minor,snapshot.calculated_at,snapshot.freshness_status
    from available_cash_alert_states state
    join available_cash_alert_episodes episode on episode.household_id=state.household_id and episode.id=state.current_episode_id
    join calculation_snapshots snapshot on snapshot.household_id=episode.household_id and snapshot.id=episode.last_snapshot_id
    where state.household_id=${principal.householdId} and state.user_id=${principal.userId} and episode.status='open'`
    .execute(transaction)
    .then((result) => result.rows[0]);
  const today = dateInTimezone(new Date(), household.timezone);
  const incomeSchedules = await transaction
    .selectFrom("income_schedules")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .where("status", "!=", "archived")
    .orderBy("next_expected_date", "asc")
    .orderBy("created_at", "asc")
    .execute();
  const horizon = resolvePlanningHorizonFromSchedules({
    today,
    fallbackDays: plan.fallback_horizon_days,
    schedules: incomeSchedules.map((item) => ({
      id: item.id,
      nextExpectedDate: item.next_expected_date
        ? toDateOnly(item.next_expected_date)
        : null,
      confirmed: item.confirmed,
      status: item.status,
    })),
  });
  const horizonEnd = horizon.end;
  const commitments = await transaction
    .selectFrom("commitments")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .where("active", "=", true)
    .where("settled_at", "is", null)
    .orderBy("due_date", "asc")
    .orderBy("created_at", "asc")
    .execute();
  const starterItemRows = await transaction
    .selectFrom("starter_template_application_items as item")
    .innerJoin("starter_template_applications as application", (join) =>
      join
        .onRef("application.household_id", "=", "item.household_id")
        .onRef("application.id", "=", "item.application_id"),
    )
    .select(["item.commitment_id", "item.item_key"])
    .where("item.household_id", "=", principal.householdId)
    .where("application.user_id", "=", principal.userId)
    .execute();
  const starterItemByCommitment = new Map(
    starterItemRows.map((item) => [item.commitment_id, item.item_key]),
  );
  const latestStarterApplication = await sql<{
    id: string;
    created_at: Date;
    item_count: number;
    removable: boolean;
  }>`select application.id,application.created_at,count(*)::integer item_count,
      bool_and(commitment.active and commitment.settled_at is null
        and commitment.version=item.commitment_version
        and commitment.amount_minor=0 and commitment.due_date is null) removable
    from starter_template_applications application
    join starter_template_application_items item on item.household_id=application.household_id and item.application_id=application.id
    join commitments commitment on commitment.household_id=item.household_id and commitment.id=item.commitment_id
    where application.household_id=${principal.householdId} and application.user_id=${principal.userId}
      and application.undone_at is null
    group by application.id,application.created_at order by application.created_at desc limit 1`
    .execute(transaction)
    .then((result) => result.rows[0]);
  const occurrenceRows = await transaction
    .selectFrom("plan_occurrences")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .orderBy("expected_on", "asc")
    .orderBy("created_at", "asc")
    .execute();
  const occurrenceEvidence = await transaction
    .selectFrom("occurrence_transaction_matches as match")
    .innerJoin("financial_transactions as evidence", (join) =>
      join
        .onRef("evidence.household_id", "=", "match.household_id")
        .onRef("evidence.id", "=", "match.transaction_id"),
    )
    .innerJoin("accounts as account", (join) =>
      join
        .onRef("account.household_id", "=", "match.household_id")
        .onRef("account.id", "=", "evidence.account_id"),
    )
    .select([
      "match.occurrence_id",
      "match.amount_applied_minor",
      "match.state as match_state",
      "match.id as match_id",
      "match.version as match_version",
      "evidence.transaction_id",
      "evidence.merchant",
      "evidence.occurred_on",
      "evidence.status",
      "account.name as account_name",
    ])
    .where("match.household_id", "=", principal.householdId)
    .where("match.state", "in", ["proposed", "confirmed"])
    .orderBy("evidence.occurred_on", "desc")
    .execute();
  const savingsGoals = await transaction
    .selectFrom("savings_goals")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .where("status", "!=", "archived")
    .orderBy("created_at", "asc")
    .execute();
  const savingsMovements = await transaction
    .selectFrom("savings_goal_movements")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .orderBy("effective_on", "desc")
    .orderBy("created_at", "desc")
    .execute();
  const debtRows = await sql<{
    id: string;
    version: number;
    account_id: string;
    linked_commitment_id: string | null;
    payment_commitment_managed: boolean;
    name: string;
    debt_type: string;
    status: string;
    provenance: string;
    account_archived_at: Date | null;
    connection_status: string | null;
    raw_balance_minor: string | null;
    balance_as_of: Date | null;
    minimum_payment_minor: string | null;
    next_due_on: string | null;
    terms_as_of: Date | null;
    apr_basis_points: number | null;
    apr_type: string | null;
    apr_as_of: Date | null;
    payment_mode: string | null;
    fixed_amount_minor: string | null;
    extra_amount_minor: string | null;
    policy_version: number | null;
    linked_payment_minor: string | null;
  }>`select debt.id,debt.version,debt.account_id,debt.linked_commitment_id,debt.payment_commitment_managed,debt.name,
      debt.debt_type,debt.status,debt.provenance,account.archived_at account_archived_at,connection.status connection_status,
      balance.current_balance_minor raw_balance_minor,balance.observed_at balance_as_of,
      terms.minimum_payment_minor,terms.next_due_on::text,terms.observed_at terms_as_of,
      apr.apr_basis_points,apr.apr_type,apr.observed_at apr_as_of,
      policy.mode payment_mode,policy.fixed_amount_minor,policy.extra_amount_minor,policy.version policy_version,
      payment.amount_minor linked_payment_minor
    from debts debt
    join accounts account on account.household_id=debt.household_id and account.id=debt.account_id
    left join connections connection on connection.household_id=account.household_id and connection.id=account.connection_id
    left join lateral (select b.current_balance_minor,b.observed_at from debt_balance_observations b
      where b.household_id=debt.household_id and b.debt_id=debt.id order by b.observed_at desc,b.recorded_at desc limit 1) balance on true
    left join lateral (select t.minimum_payment_minor,t.next_due_on,t.observed_at from debt_term_observations t
      where t.household_id=debt.household_id and t.debt_id=debt.id order by t.observed_at desc,t.recorded_at desc limit 1) terms on true
    left join lateral (select a.apr_basis_points,a.apr_type,a.observed_at from debt_apr_components a
      where a.household_id=debt.household_id and a.debt_id=debt.id and a.selected_for_projection
      order by a.observed_at desc,a.recorded_at desc limit 1) apr on true
    left join debt_payment_policies policy on policy.household_id=debt.household_id and policy.debt_id=debt.id
    left join commitments payment on payment.household_id=debt.household_id
      and payment.id=debt.linked_commitment_id and payment.active and payment.settled_at is null
    where debt.household_id=${principal.householdId} and debt.status<>'archived'
    order by debt.created_at`.execute(transaction);
  const recentHistoryStart = addDays(today, -90);
  const explicitlySkippedIds = new Set(
    (
      await transaction
        .selectFrom("plan_occurrence_revisions")
        .select("occurrence_id")
        .where("household_id", "=", principal.householdId)
        .where("state", "=", "skipped")
        .where("reason", "=", "User marked this occurrence as not due")
        .execute()
    ).map((revision) => revision.occurrence_id),
  );
  const occurrences = occurrenceRows.filter(
    (occurrence) =>
      (occurrence.state !== "verified" && occurrence.state !== "skipped") ||
      (toDateOnly(occurrence.expected_on) >= recentHistoryStart &&
        (occurrence.state === "verified" ||
          (occurrence.state === "skipped" &&
            explicitlySkippedIds.has(occurrence.id)))),
  );
  const reservable = occurrences.filter(
    (occurrence) =>
      toDateOnly(occurrence.expected_on) <= horizonEnd &&
      occurrence.state !== "verified" &&
      occurrence.state !== "skipped",
  );
  const commitmentReserve = reservable.filter(
    (occurrence) => occurrence.kind === "commitment",
  );
  const savingsReserveMinor = reservable
    .filter((occurrence) => occurrence.kind === "savings")
    .reduce(
      (sum, occurrence) =>
        sum + BigInt(occurrence.expected_amount_minor ?? "0"),
      0n,
    );
  const includedAccounts = accountRows.rows.filter(
    (account) =>
      account.planning_role === "spendable" &&
      ["cash", "checking", "savings"].includes(account.account_type),
  );
  const knownCashMinor = includedAccounts.reduce(
    (sum, account) => sum + BigInt(account.amount_minor ?? "0"),
    0n,
  );
  const projection = calculateProjection({
    knownCash: money(knownCashMinor, "USD"),
    commitments: commitmentReserve.map((occurrence) =>
      money(
        bigintMax(
          0n,
          BigInt(occurrence.expected_amount_minor ?? "0") -
            BigInt(occurrence.matched_amount_minor),
        ),
        "USD",
      ),
    ),
    plannedSavings: money(savingsReserveMinor, "USD"),
    safetyBuffer: money(plan.safety_buffer_minor, "USD"),
  });
  const transactionRows = await sql<{
    id: string;
    version: number;
    account_id: string;
    account_name: string;
    account_type: string;
    archived_at: Date | null;
    merchant: string;
    amount_minor: string;
    currency: "USD";
    occurred_on: string;
    status: "pending" | "posted" | "removed" | "superseded";
    direction: "debit" | "credit";
    source_kind: "manual" | "csv" | "plaid" | "sample";
    revision: number;
    category: string;
    category_source: string;
    category_confidence: string;
    category_version: number;
  }>`
    select e.id,e.version,l.account_id,a.name account_name,a.account_type,a.archived_at,
      l.merchant,l.amount_minor,l.currency,l.occurred_on::text,l.status,l.direction,l.source_kind,l.revision,
      c.category,c.source category_source,c.confidence category_confidence,c.version category_version
    from transaction_entities e
    join financial_transactions l on l.id=e.current_transaction_id and l.household_id=e.household_id
    join accounts a on a.id=l.account_id
    join transaction_category_assignments c on c.transaction_id=e.id and c.household_id=e.household_id
    where e.household_id=${principal.householdId} and e.current_transaction_id is not null and l.source_kind<>'sample'
    order by e.current_occurred_on desc, e.id desc
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
  const includedManualAccounts = includedAccounts.filter(
    (account) => account.provenance === "manual",
  );
  const staleCutoff = Date.now() - 36 * 60 * 60 * 1000;
  const incomplete =
    includedAccounts.length === 0 ||
    includedManualAccounts.length > 1 ||
    includedAccounts.some(
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
  const manualStale =
    plaidAccounts.length === 0 &&
    (!coveredAsOf ||
      coveredAsOf.getTime() < Date.now() - 7 * 24 * 60 * 60 * 1000);
  const calculatedAt = new Date().toISOString();
  const debts = debtRows.rows.map((debt) => {
    const trackingFresh =
      debt.provenance !== "plaid" ||
      (debt.status !== "paused" &&
        debt.status !== "closed" &&
        debt.account_archived_at === null &&
        (debt.connection_status === "healthy" ||
          debt.connection_status === "syncing"));
    const balanceFresh = Boolean(
      trackingFresh &&
        debt.balance_as_of &&
        debt.balance_as_of.getTime() >= staleCutoff,
    );
    const termsFresh = Boolean(
      trackingFresh &&
        debt.terms_as_of &&
        debt.terms_as_of.getTime() >= staleCutoff,
    );
    const aprFresh = Boolean(
      trackingFresh &&
        debt.apr_as_of &&
        debt.apr_as_of.getTime() >= staleCutoff,
    );
    const raw =
      debt.raw_balance_minor === null ? null : BigInt(debt.raw_balance_minor);
    const owed = raw === null || raw < 0n ? 0n : raw;
    // A payoff estimate must use the same payment actually reserved by the
    // canonical linked commitment. Policy inputs alone do not reserve cash.
    const payment =
      debt.linked_payment_minor === null
        ? null
        : BigInt(debt.linked_payment_minor);
    const projection = projectDebtPayoff({
      owedMinor: raw === null ? null : owed,
      aprBasisPoints: debt.apr_basis_points,
      monthlyPaymentMinor: payment,
      fresh: balanceFresh && aprFresh,
    });
    return {
      id: debt.id,
      version: debt.version,
      accountId: debt.account_id,
      linkedCommitmentId: debt.linked_commitment_id,
      paymentManaged: debt.payment_commitment_managed,
      name: debt.name,
      type: debt.debt_type,
      status: debt.status,
      provenance: debt.provenance,
      balance:
        raw === null || !debt.balance_as_of
          ? null
          : {
              raw: { minor: raw.toString(), currency: "USD" as const },
              owed: { minor: owed.toString(), currency: "USD" as const },
              asOf: debt.balance_as_of.toISOString(),
              coverage: balanceFresh
                ? ("complete" as const)
                : ("stale" as const),
            },
      terms: !debt.terms_as_of
        ? null
        : {
            minimumPayment:
              debt.minimum_payment_minor === null
                ? null
                : {
                    minor: debt.minimum_payment_minor,
                    currency: "USD" as const,
                  },
            nextDueOn: debt.next_due_on,
            asOf: debt.terms_as_of.toISOString(),
            coverage: termsFresh ? ("complete" as const) : ("stale" as const),
          },
      apr:
        debt.apr_basis_points === null || !debt.apr_as_of
          ? null
          : {
              basisPoints: debt.apr_basis_points,
              type: debt.apr_type,
              asOf: debt.apr_as_of.toISOString(),
              coverage: aprFresh ? ("complete" as const) : ("stale" as const),
            },
      paymentPolicy:
        !debt.payment_mode || !debt.policy_version
          ? null
          : {
              mode: debt.payment_mode,
              fixedAmount:
                debt.fixed_amount_minor === null
                  ? null
                  : {
                      minor: debt.fixed_amount_minor,
                      currency: "USD" as const,
                    },
              extraAmount: {
                minor: debt.extra_amount_minor ?? "0",
                currency: "USD" as const,
              },
              version: debt.policy_version,
            },
      projection:
        projection.status === "estimate"
          ? {
              status: projection.status,
              months: projection.months,
              totalInterest: {
                minor: projection.totalInterestMinor.toString(),
                currency: "USD" as const,
              },
              finalPayment: {
                minor: projection.finalPaymentMinor.toString(),
                currency: "USD" as const,
              },
            }
          : projection,
    };
  });
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
      planningRole: account.planning_role,
      coverage:
        account.planning_role === "excluded"
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
    debts,
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
      planningHorizonDays: horizon.days,
      fallbackHorizonDays: plan.fallback_horizon_days,
      horizonBasis: horizon.basis,
      horizonMissedIncome: Boolean(horizon.missedIncome),
      horizonStart: today,
      horizonEnd,
      horizonIncomeScheduleId: horizon.incomeScheduleId ?? null,
      incomeSchedules: incomeSchedules.map((item) => ({
        id: item.id,
        version: item.version,
        destinationAccountId: item.destination_account_id,
        name: item.name,
        expectedAmount:
          item.expected_amount_minor === null
            ? null
            : { minor: item.expected_amount_minor, currency: "USD" as const },
        frequency: item.frequency,
        nextExpectedDate: item.next_expected_date
          ? toDateOnly(item.next_expected_date)
          : null,
        confirmed: item.confirmed,
        status: item.status,
        anchorDay: item.anchor_day,
        anchorEndOfMonth: item.anchor_eom,
        secondAnchorDay: item.second_anchor_day,
        secondAnchorEndOfMonth: item.second_anchor_eom,
        reviewReason: item.review_reason,
        provenance: item.provenance,
      })),
      knownCash: serializeMoney(projection.knownCash),
      commitments: commitments.map((commitment) => ({
        id: commitment.id,
        version: commitment.version,
        name: commitment.name,
        amount: { minor: commitment.amount_minor, currency: "USD" },
        dueDate:
          commitment.due_date === null ? null : toDateOnly(commitment.due_date),
        recurrence: (commitment.recurrence ?? "one_time") as
          | "one_time"
          | "weekly"
          | "biweekly"
          | "monthly"
          | "quarterly"
          | "annual",
        setupSlot: commitment.setup_slot as
          | "housing"
          | "utilities"
          | "subscriptions"
          | "insurance"
          | null,
        starterItemKey: (starterItemByCommitment.get(commitment.id) ?? null) as
          | keyof typeof COMMON_BILL_STARTERS
          | null,
        provenance: commitment.provenance as
          | "manual"
          | "csv"
          | "plaid"
          | "derived"
          | "sample",
      })),
      availableCashAlert: {
        enabled: availableCashPreference?.available_cash_alerts ?? false,
        threshold: {
          minor:
            availableCashPreference?.available_cash_threshold_minor ?? "25000",
          currency: "USD" as const,
        },
        currentAvailable: serializeMoney(projection.available),
        status: !(availableCashPreference?.available_cash_alerts ?? false)
          ? ("disabled" as const)
          : incomplete || automatedStale || manualStale
            ? ("unavailable" as const)
            : availableCashEpisode ||
                BigInt(projection.available.minor) <
                  BigInt(
                    availableCashPreference?.available_cash_threshold_minor ??
                      "25000",
                  )
              ? ("below" as const)
              : ("above" as const),
        episodeId: availableCashEpisode?.id ?? null,
        alertAvailable: availableCashEpisode
          ? {
              minor: availableCashEpisode.last_available_minor,
              currency: "USD" as const,
            }
          : null,
        alertEvaluatedAt:
          availableCashEpisode?.calculated_at.toISOString() ?? null,
        alertFreshness: availableCashEpisode?.freshness_status ?? null,
      },
      latestStarterApplication: latestStarterApplication
        ? {
            id: latestStarterApplication.id,
            itemCount: latestStarterApplication.item_count,
            removable: latestStarterApplication.removable,
            createdAt: latestStarterApplication.created_at.toISOString(),
          }
        : null,
      occurrences: occurrences.map((occurrence) => {
        const expected = occurrence.expected_amount_minor;
        const remaining =
          expected === null
            ? null
            : (
                BigInt(expected) - BigInt(occurrence.matched_amount_minor)
              ).toString();
        const effectiveState =
          occurrence.state === "expected" &&
          toDateOnly(occurrence.expected_on) < today
            ? "overdue"
            : occurrence.state;
        return {
          id: occurrence.id,
          kind: occurrence.kind,
          sourceKey: occurrence.source_key,
          commitmentId: occurrence.commitment_id,
          savingsGoalId: occurrence.savings_goal_id,
          incomeScheduleId: occurrence.income_schedule_id,
          name: occurrence.name,
          expectedAmount:
            expected === null ? null : { minor: expected, currency: "USD" },
          expectedOn: toDateOnly(occurrence.expected_on),
          state: effectiveState,
          explicitlySkipped: explicitlySkippedIds.has(occurrence.id),
          matchedAmount: {
            minor: occurrence.matched_amount_minor,
            currency: "USD",
          },
          remainingAmount:
            remaining === null ? null : { minor: remaining, currency: "USD" },
          provenance: occurrence.provenance,
          version: occurrence.version,
          scheduleRevision: {
            kind: occurrence.source_revision_kind,
            id: occurrence.source_revision_id,
            version: occurrence.source_revision_version,
          },
          verifiedAt: occurrence.verified_at
            ? toIso(occurrence.verified_at)
            : null,
          evidence: occurrenceEvidence
            .filter((item) => item.occurrence_id === occurrence.id)
            .map((item) => ({
              transactionId: item.transaction_id,
              matchId: item.match_id,
              matchVersion: item.match_version,
              merchant: item.merchant,
              occurredOn: toDateOnly(item.occurred_on),
              accountName: item.account_name,
              amountApplied: {
                minor: item.amount_applied_minor,
                currency: "USD" as const,
              },
              status: item.status as "pending" | "posted",
              matchState: item.match_state as "proposed" | "confirmed",
            })),
        };
      }),
      savingsGoals: savingsGoals.map((goal) => {
        const goalMovements = savingsMovements.filter(
          (movement) => movement.savings_goal_id === goal.id,
        );
        const reversed = new Set(
          goalMovements
            .filter((movement) => movement.kind === "reversal")
            .map((movement) => movement.reversed_movement_id),
        );
        const active = goalMovements.filter(
          (movement) =>
            movement.kind !== "reversal" && !reversed.has(movement.id),
        );
        const net = (method?: string) =>
          active
            .filter(
              (movement) => !method || movement.verification_method === method,
            )
            .reduce(
              (sum, movement) =>
                sum +
                (movement.kind === "withdrawal" ? -1n : 1n) *
                  BigInt(movement.amount_minor),
              0n,
            );
        const destination = goal.destination_account_id
          ? accountRows.rows.find(
              (account) => account.id === goal.destination_account_id,
            )
          : null;
        const providerVerified = bigintMax(0n, net("provider_verified"));
        const userConfirmed = bigintMax(0n, net("user_confirmed"));
        const confirmed = bigintMax(0n, net());
        const destinationStale =
          destination?.provenance === "plaid" &&
          (!destination.as_of ||
            destination.connection_status !== "healthy" ||
            !destination.last_sync_at ||
            destination.last_sync_at.getTime() < staleCutoff ||
            destination.as_of.getTime() < staleCutoff);
        return {
          id: goal.id,
          version: goal.version,
          name: goal.name,
          targetAmount:
            goal.target_amount_minor === null
              ? null
              : { minor: goal.target_amount_minor, currency: "USD" as const },
          targetDate:
            goal.target_date === null ? null : toDateOnly(goal.target_date),
          contributionAmount: {
            minor: goal.contribution_amount_minor,
            currency: "USD" as const,
          },
          schedule: goal.schedule,
          nextDueOn:
            goal.next_due_on === null ? null : toDateOnly(goal.next_due_on),
          status: goal.status,
          provenance: goal.provenance,
          destination: destination
            ? {
                accountId: destination.id,
                name: destination.name,
                provenance: destination.provenance as
                  | "manual"
                  | "csv"
                  | "plaid",
                coverage: !destination.as_of
                  ? ("missing" as const)
                  : destinationStale
                    ? ("stale" as const)
                    : ("complete" as const),
              }
            : null,
          progress: {
            confirmed: {
              minor: confirmed.toString(),
              currency: "USD" as const,
            },
            providerVerified: {
              minor: providerVerified.toString(),
              currency: "USD" as const,
            },
            userConfirmed: {
              minor: userConfirmed.toString(),
              currency: "USD" as const,
            },
            assurance: destinationStale
              ? ("stale" as const)
              : providerVerified > 0n
                ? ("bank_confirmed" as const)
                : userConfirmed > 0n
                  ? ("user_confirmed" as const)
                  : ("not_started" as const),
            protected: destination?.planning_role === "protected",
            asOf: destination?.as_of?.toISOString() ?? null,
          },
          movements: goalMovements.slice(0, 20).map((movement) => ({
            id: movement.id,
            kind: movement.kind,
            amount: { minor: movement.amount_minor, currency: "USD" as const },
            effectiveOn: toDateOnly(movement.effective_on),
            verificationMethod: movement.verification_method,
            provenance: movement.provenance,
            reversedMovementId: movement.reversed_movement_id,
            createdAt: toIso(movement.created_at),
          })),
        };
      }),
      plannedSavings: serializeMoney(projection.plannedSavings),
      safetyBuffer: serializeMoney(projection.safetyBuffer),
      available: serializeMoney(projection.available),
      reserved: serializeMoney(projection.reserved),
      policyVersion: projection.policyVersion,
      calculatedAt,
      freshness: {
        status: incomplete
          ? "incomplete"
          : automatedStale || manualStale
            ? "stale"
            : plaidAccounts.length === 0
              ? "manual"
              : "current",
        asOf: coveredAsOf?.toISOString() ?? null,
      },
    },
    transactions: transactionRows.rows.map((row) => ({
      id: row.id,
      version: row.version,
      accountId: row.account_id,
      accountName: row.account_name,
      accountType: row.account_type,
      accountArchived: Boolean(row.archived_at),
      merchant: row.merchant,
      amount: { minor: row.amount_minor, currency: row.currency },
      occurredOn: row.occurred_on,
      status: row.status,
      direction: row.direction,
      provenance: row.source_kind,
      revision: row.revision,
      category: row.category,
      categorySource: row.category_source,
      categoryConfidence: row.category_confidence,
      categoryVersion: row.category_version,
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
  options: { externalEligible?: boolean } = {},
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
  const occurrenceIds = view.plan.occurrences.map((item) => item.id);
  const occurrenceInputs =
    occurrenceIds.length === 0
      ? []
      : await transaction
          .selectFrom("plan_occurrences")
          .select([
            "id",
            "version",
            "source_key",
            "kind",
            "expected_amount_minor",
            "expected_on",
            "state",
            "matched_amount_minor",
            "verified_at",
            "income_schedule_id",
            "source_revision_kind",
            "source_revision_id",
            "source_revision_version",
          ])
          .where("household_id", "=", principal.householdId)
          .where("id", "in", occurrenceIds)
          .orderBy("id")
          .execute();
  const matchInputs =
    occurrenceIds.length === 0
      ? []
      : await transaction
          .selectFrom("occurrence_transaction_matches")
          .select([
            "id",
            "version",
            "occurrence_id",
            "transaction_id",
            "amount_applied_minor",
            "state",
            "reflected_in_balance_observation_id",
          ])
          .where("household_id", "=", principal.householdId)
          .where("occurrence_id", "in", occurrenceIds)
          .orderBy("id")
          .execute();
  const savingsGoalInputs = await transaction
    .selectFrom("savings_goals")
    .select([
      "id",
      "version",
      "destination_account_id",
      "target_amount_minor",
      "target_date",
      "contribution_amount_minor",
      "schedule",
      "next_due_on",
      "schedule_anchor_day",
      "schedule_anchor_eom",
      "status",
    ])
    .where("household_id", "=", principal.householdId)
    .orderBy("id")
    .execute();
  const savingsMovementInputs = await transaction
    .selectFrom("savings_goal_movements")
    .select([
      "id",
      "savings_goal_id",
      "kind",
      "amount_minor",
      "effective_on",
      "verification_method",
      "reversed_movement_id",
    ])
    .where("household_id", "=", principal.householdId)
    .orderBy("id")
    .execute();
  const incomeScheduleInputs = await transaction
    .selectFrom("income_schedules")
    .select([
      "id",
      "version",
      "destination_account_id",
      "name",
      "expected_amount_minor",
      "frequency",
      "next_expected_date",
      "confirmed",
      "status",
      "anchor_day",
      "anchor_eom",
      "second_anchor_day",
      "second_anchor_eom",
      "review_reason",
      "advanced_from_occurrence_id",
      "previous_expected_date",
    ])
    .where("household_id", "=", principal.householdId)
    .orderBy("id")
    .execute();
  const plan = await transaction
    .selectFrom("plans")
    .select([
      "id",
      "version",
      "planning_horizon_days",
      "fallback_horizon_days",
      "calculation_policy_version",
    ])
    .where("id", "=", view.plan.id)
    .executeTakeFirstOrThrow();
  const manifest = [
    {
      kind: "plan_revision",
      id: plan.id,
      version: plan.version,
      value: JSON.stringify({
        fallbackDays: plan.fallback_horizon_days,
        horizonBasis: view.plan.horizonBasis,
        horizonStart: view.plan.horizonStart,
        horizonEnd: view.plan.horizonEnd,
        outputPolicy: view.plan.policyVersion,
        storedPolicy: plan.calculation_policy_version,
      }),
    },
    ...balanceInputs.rows.map((item) => ({
      kind: "balance_observation",
      id: item.id,
      version: null,
      value: `${item.account_id}:${item.amount_minor}:${item.as_of.toISOString()}`,
    })),
    ...occurrenceInputs.map((item) => ({
      kind: "plan_occurrence_revision",
      id: item.id,
      version: item.version,
      value: `${item.source_key}:${item.kind}:${item.income_schedule_id ?? "not-income"}:${item.source_revision_kind}:${item.source_revision_id}:${item.source_revision_version}:${item.expected_amount_minor ?? "date-only"}:${item.expected_on}:${item.state}:${item.matched_amount_minor}:${item.verified_at?.toISOString() ?? ""}`,
    })),
    ...incomeScheduleInputs.map((item) => ({
      kind: "income_schedule_revision",
      id: item.id,
      version: item.version,
      value: JSON.stringify({
        destinationAccountId: item.destination_account_id,
        name: item.name,
        expectedAmount: item.expected_amount_minor,
        frequency: item.frequency,
        nextExpectedDate: item.next_expected_date,
        confirmed: item.confirmed,
        status: item.status,
        anchorDay: item.anchor_day,
        anchorEom: item.anchor_eom,
        secondAnchorDay: item.second_anchor_day,
        secondAnchorEom: item.second_anchor_eom,
        reviewReason: item.review_reason,
        advancedFromOccurrenceId: item.advanced_from_occurrence_id,
        previousExpectedDate: item.previous_expected_date,
      }),
    })),
    ...matchInputs.map((item) => ({
      kind: "occurrence_match_revision",
      id: item.id,
      version: item.version,
      value: `${item.occurrence_id}:${item.transaction_id}:${item.amount_applied_minor}:${item.state}:${item.reflected_in_balance_observation_id ?? "unreflected"}`,
    })),
    ...savingsGoalInputs.map((item) => ({
      kind: "savings_goal_revision",
      id: item.id,
      version: item.version,
      value: `${item.destination_account_id ?? "unassigned"}:${item.target_amount_minor ?? "open"}:${item.target_date ?? "undated"}:${item.contribution_amount_minor}:${item.schedule}:${item.next_due_on ?? "planning-period"}:${item.schedule_anchor_day ?? "none"}:${item.schedule_anchor_eom}:${item.status}`,
    })),
    ...savingsMovementInputs.map((item) => ({
      kind: "savings_goal_movement",
      id: item.id,
      version: null,
      value: `${item.savings_goal_id}:${item.kind}:${item.amount_minor}:${item.effective_on}:${item.verification_method}:${item.reversed_movement_id ?? "active"}`,
    })),
  ];
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        manifest,
        horizonStart: view.plan.horizonStart,
        horizonEnd: view.plan.horizonEnd,
        freshness: view.plan.freshness,
      }),
    )
    .digest("hex");
  const inserted = await sql<{
    id: string;
  }>`insert into calculation_snapshots (household_id, plan_id, plan_version, known_cash_minor, commitments_minor, planned_savings_minor, safety_buffer_minor, available_minor, currency, policy_version, input_fingerprint,horizon_start,horizon_end,freshness_status,freshness_as_of)
    values (${principal.householdId}, ${view.plan.id}, ${view.plan.version}, ${view.plan.knownCash.minor}::bigint,
      ${(BigInt(view.plan.reserved.minor) - BigInt(view.plan.plannedSavings.minor) - BigInt(view.plan.safetyBuffer.minor)).toString()}::bigint,
      ${view.plan.plannedSavings.minor}::bigint, ${view.plan.safetyBuffer.minor}::bigint, ${view.plan.available.minor}::bigint, 'USD', ${view.plan.policyVersion}, ${fingerprint},
      ${view.plan.horizonStart}::date,${view.plan.horizonEnd}::date,${view.plan.freshness.status},${view.plan.freshness.asOf}::timestamptz)
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
  await refreshPayCycleHistory(transaction, principal, view);
  await sql`select evaluate_available_cash_alert(${snapshotId}::uuid,${options.externalEligible ?? false})`.execute(
    transaction,
  );
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

function bigintMax(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

async function activeConfirmedAllocation(
  transaction: Transaction<Database>,
  householdId: string,
  occurrenceId: string,
): Promise<bigint> {
  const matches = await transaction
    .selectFrom("occurrence_transaction_matches")
    .select("amount_applied_minor")
    .where("household_id", "=", householdId)
    .where("occurrence_id", "=", occurrenceId)
    .where("state", "=", "confirmed")
    .execute();
  return matches.reduce(
    (total, match) => total + BigInt(match.amount_applied_minor),
    0n,
  );
}

function materializeCommitmentDates(
  firstDue: string,
  recurrence: string | null,
  today: string,
  horizonEnd: string,
  anchorDay: number | null,
  anchorEndOfMonth: boolean,
): string[] {
  if (!recurrence) return [firstDue];
  const dates: string[] = [];
  const earliest = addDays(today, -90);
  let cursor = firstDue;
  for (let guard = 0; guard < 240 && cursor < earliest; guard += 1) {
    const next = advanceCommitmentDate(cursor, recurrence, {
      day: anchorDay ?? Number(firstDue.slice(8, 10)),
      endOfMonth: anchorEndOfMonth,
    });
    if (!next || next <= cursor) return dates;
    cursor = next;
  }
  for (let guard = 0; guard < 240 && cursor <= horizonEnd; guard += 1) {
    if (cursor >= earliest) dates.push(cursor);
    const next = advanceCommitmentDate(cursor, recurrence, {
      day: anchorDay ?? Number(firstDue.slice(8, 10)),
      endOfMonth: anchorEndOfMonth,
    });
    if (!next || next <= cursor) break;
    cursor = next;
  }
  return dates;
}

function anchorColumns(prefix: "income" | "recurrence", date: string | null) {
  const anchor = date ? new Date(`${date}T12:00:00Z`) : null;
  const day = anchor?.getUTCDate() ?? null;
  const endOfMonth = anchor
    ? day ===
      new Date(
        Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0, 12),
      ).getUTCDate()
    : false;
  return prefix === "income"
    ? { income_anchor_day: day, income_anchor_eom: endOfMonth }
    : { recurrence_anchor_day: day, recurrence_anchor_eom: endOfMonth };
}

function advanceCommitmentDate(
  current: string,
  recurrence: string,
  anchor: { day: number; endOfMonth: boolean },
): string | null {
  if (recurrence === "weekly") return addDays(current, 7);
  if (recurrence === "biweekly") return addDays(current, 14);
  if (recurrence === "monthly")
    return advanceIncomeDate(current, "monthly", anchor);
  if (recurrence === "quarterly")
    return advanceIncomeDate(current, "quarterly", anchor);
  if (recurrence === "annual")
    return advanceIncomeDate(current, "annual", anchor);
  return null;
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
  actorUserId: string | null = principal.userId,
): Promise<void> {
  await transaction
    .insertInto("activity_events")
    .values({
      household_id: principal.householdId,
      actor_user_id: actorUserId,
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
