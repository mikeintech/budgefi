import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { createClerkClient } from "@clerk/backend";
import {
  accountDeletionResponseSchema,
  accountExportResponseSchema,
  notificationEndpointResponseSchema,
  notificationPreferencesSchema,
  notificationTestResponseSchema,
  type AccountDeletionRequest,
  type NotificationEndpointRequest,
  type NotificationPreferencesUpdate,
  type NotificationTestRequest,
} from "../../../../packages/contracts/src/index.js";
import {
  TenantDatabase,
  type RequestIdentity,
} from "../database/tenant-database.js";
import { NotificationTokenCrypto } from "./notification-token-crypto.js";
import { idempotent } from "../core/idempotency.js";

@Injectable()
export class OperationsService {
  constructor(
    @Inject(TenantDatabase) private readonly tenant: TenantDatabase,
    @Inject(NotificationTokenCrypto)
    private readonly crypto: NotificationTokenCrypto,
  ) {}

  async getPreferences(identity: RequestIdentity) {
    const verifiedEmail = await verifiedNotificationEmail(identity);
    return this.tenant.run(identity, async (db, principal) => {
      await ensurePreferences(
        db,
        principal.householdId,
        principal.userId,
        verifiedEmail,
      );
      const row = await db
        .selectFrom("notification_preferences")
        .selectAll()
        .where("household_id", "=", principal.householdId)
        .where("user_id", "=", principal.userId)
        .executeTakeFirstOrThrow();
      return notificationPreferencesSchema.parse(preferencesResponse(row));
    });
  }

  async updatePreferences(
    identity: RequestIdentity,
    request: NotificationPreferencesUpdate,
  ) {
    const trustedEmail = await verifiedNotificationEmail(identity);
    return this.tenant.run(identity, async (db, principal) => {
      await ensurePreferences(
        db,
        principal.householdId,
        principal.userId,
        trustedEmail,
      );
      const verifiedEmail = Boolean(
        trustedEmail &&
          request.emailAddress &&
          trustedEmail.toLocaleLowerCase() ===
            request.emailAddress.toLocaleLowerCase(),
      );
      if (request.emailEnabled && !verifiedEmail)
        throw new ConflictException(
          "Verify this email with your sign-in provider before enabling email notifications",
        );
      await idempotent(
        db,
        principal.householdId,
        request.requestId,
        "notification.preferences.update",
        request,
        async () => {
          const row = await db.updateTable("notification_preferences").set({
          email_address: request.emailAddress,
          email_verified_at: verifiedEmail ? new Date() : null,
          email_consent_at: request.emailEnabled ? new Date() : null,
          email_suppressed_at: null,
          email_enabled: request.emailEnabled,
          push_enabled: request.pushEnabled,
          connection_health: request.connectionHealth,
          commitment_reminders: request.commitmentReminders,
          income_reminders: request.incomeReminders,
          savings_reminders: request.savingsReminders,
          exception_activity: request.exceptionActivity,
          weekly_digest: request.weeklyDigest,
          available_cash_alerts: request.availableCashAlerts,
          available_cash_threshold_minor:
            request.availableCashThreshold.minor,
          lock_screen_detail: request.lockScreenDetail,
          reminder_hour: request.reminderHour,
          reminder_minute: request.reminderMinute,
          commitment_reminder_days: request.commitmentReminderDays,
          long_term_reminder_days: request.longTermReminderDays,
          savings_reminder_days: request.savingsReminderDays,
          quiet_start_minute: request.quietStartMinute,
          quiet_end_minute: request.quietEndMinute,
          timezone: request.timezone,
          updated_at: new Date(),
          }).where("household_id", "=", principal.householdId)
            .where("user_id", "=", principal.userId)
            .where("version", "=", request.expectedVersion)
            .returningAll().executeTakeFirst();
          if (!row)
            throw new ConflictException(
              "Notification choices changed elsewhere. Reload and try again.",
            );
          if (row.available_cash_alerts) {
            const snapshot = await db.selectFrom("calculation_snapshots").select("id")
              .where("household_id", "=", principal.householdId)
              .orderBy("calculated_at", "desc").executeTakeFirst();
            if (snapshot)
              await sql`select evaluate_available_cash_alert(${snapshot.id}::uuid,false)`.execute(db);
          } else {
            await sql`update available_cash_alert_episodes episode set status='cancelled',notification_suppression_reason='disabled',updated_at=now()
              where episode.household_id=${principal.householdId}::uuid and episode.user_id=${principal.userId}::uuid and episode.status='open'`.execute(db);
            await sql`update notification_deliveries delivery set state='suppressed',last_error_code='available_cash_disabled'
              from notification_events event where delivery.household_id=${principal.householdId}::uuid
                and delivery.event_id=event.id and event.user_id=${principal.userId}::uuid
                and event.available_cash_episode_id is not null and delivery.state in ('queued','retry')`.execute(db);
            await sql`update available_cash_alert_states set current_status='unavailable',armed=true,current_episode_id=null,updated_at=now()
              where household_id=${principal.householdId}::uuid and user_id=${principal.userId}::uuid`.execute(db);
          }
          return { operation: "notification.preferences.update", resourceId: principal.userId };
        },
      );
      const row = await db.selectFrom("notification_preferences").selectAll()
        .where("household_id", "=", principal.householdId)
        .where("user_id", "=", principal.userId).executeTakeFirstOrThrow();
      return notificationPreferencesSchema.parse(preferencesResponse(row));
    });
  }

  registerEndpoint(
    identity: RequestIdentity,
    request: NotificationEndpointRequest,
  ) {
    return this.tenant.run(identity, async (db, principal) => {
      const secured = this.crypto.encrypt(request.token, principal.userId);
      const id = uuidv7();
      const row = await sql<{
        id: string;
        platform: string;
        device_label: string;
        enabled: boolean;
        registered_at: Date;
      }>`select * from register_notification_endpoint(${id}::uuid,${request.platform},${secured.hash},${secured.encrypted},${secured.keyId},${request.deviceLabel})`
        .execute(db)
        .then((result) => result.rows[0]!);
      return notificationEndpointResponseSchema.parse({
        id: row.id,
        platform: row.platform,
        deviceLabel: row.device_label,
        enabled: row.enabled,
        registeredAt: row.registered_at.toISOString(),
      });
    });
  }

  disableEndpoint(
    identity: RequestIdentity,
    endpointId: string,
    _request: { requestId: string },
  ) {
    return this.tenant.run(identity, async (db, principal) => {
      const row = await db
        .updateTable("notification_endpoints")
        .set({ enabled: false, disabled_at: new Date() })
        .where("id", "=", endpointId)
        .where("household_id", "=", principal.householdId)
        .where("user_id", "=", principal.userId)
        .returning("id")
        .executeTakeFirst();
      return { disabled: Boolean(row) };
    });
  }

  queueTest(identity: RequestIdentity, request: NotificationTestRequest) {
    return this.tenant.run(identity, async (db, principal) => {
      await ensurePreferences(db, principal.householdId, principal.userId);
      const prefs = await db
        .selectFrom("notification_preferences")
        .selectAll()
        .where("household_id", "=", principal.householdId)
        .where("user_id", "=", principal.userId)
        .executeTakeFirstOrThrow();
      const endpoints =
        request.channel === "push"
          ? await db
              .selectFrom("notification_endpoints")
              .selectAll()
              .where("household_id", "=", principal.householdId)
              .where("user_id", "=", principal.userId)
              .where("enabled", "=", true)
              .execute()
          : [];
      if (
        request.channel === "email" &&
        (!prefs.email_enabled ||
          !prefs.email_address ||
          !prefs.email_verified_at ||
          prefs.email_suppressed_at)
      )
        return notificationTestResponseSchema.parse({
          queued: false,
          reason: "Add a verified email address and enable email first.",
        });
      if (
        request.channel === "push" &&
        (!prefs.push_enabled || endpoints.length === 0)
      )
        return notificationTestResponseSchema.parse({
          queued: false,
          reason: "Enable push notifications on this device first.",
        });
      const event = await db
        .insertInto("notification_events")
        .values({
          id: uuidv7(),
          household_id: principal.householdId,
          user_id: principal.userId,
          event_type: "notification.test",
          title: "Budgefi check-in",
          body: "Notifications are ready. No financial details appear on your lock screen.",
          deep_link_path: "/settings/notifications",
          dedupe_key: `test:${request.channel}:${request.requestId}`,
          preference_revision: prefs.version,
          scheduled_for: new Date(),
          timezone_snapshot: prefs.timezone,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const base = {
        household_id: principal.householdId,
        user_id: principal.userId,
        event_id: event.id,
        channel: request.channel,
        state: "queued",
        attempts: 0,
        available_at: new Date(),
        locked_at: null,
        sent_at: null,
        last_error_code: null,
        created_at: new Date(),
      } as const;
      if (request.channel === "email")
        await db
          .insertInto("notification_deliveries")
          .values({
            ...base,
            endpoint_id: null,
            destination_hash: hash(prefs.email_address!),
          })
          .execute();
      else
        await db
          .insertInto("notification_deliveries")
          .values(
            endpoints.map((endpoint) => ({
              ...base,
              endpoint_id: endpoint.id,
              destination_hash: null,
            })),
          )
          .execute();
      return notificationTestResponseSchema.parse({
        queued: true,
        reason: null,
      });
    });
  }

  exportAccount(identity: RequestIdentity) {
    return this.tenant.run(identity, async (db, principal) => {
      const [
        household,
        accounts,
        balances,
        transactions,
        commitments,
        plans,
        connections,
        activity,
        cases,
        evidence,
        preferences,
        preferenceRevisions,
        notificationEvents,
        notificationDeliveries,
        patternAnalyses,
        planOccurrences,
        occurrenceRevisions,
        occurrenceMatches,
        occurrenceMatchRevisions,
        transactionEntities,
        transactionAliases,
        transactionCategories,
        transactionCategoryRevisions,
        merchantCategoryRules,
        savingsGoals,
        savingsGoalRevisions,
        savingsGoalMovements,
        savingsMovementEvidence,
        debts,
        debtRevisions,
        debtBalances,
        debtTerms,
        debtAprComponents,
        debtPaymentPolicies,
        debtPaymentPolicyRevisions,
        debtPaymentEvidence,
        debtPaymentEvidenceReversals,
        incomeSchedules,
        incomeScheduleRevisions,
        accountPlanningRoleRevisions,
        planningPeriods,
        planningPeriodRevisions,
        incomeBoundaries,
        incomeBoundaryRevisions,
        incomeBoundaryEvidence,
        payCycles,
        payCycleReportRevisions,
        payCycleReportInputs,
        payCycleAccountCoverage,
        calculationSnapshots,
        availableCashAlertEpisodes,
        availableCashAlertStates,
        starterTemplateApplications,
        starterTemplateApplicationItems,
      ] = await Promise.all([
        db
          .selectFrom("households")
          .selectAll()
          .where("id", "=", principal.householdId)
          .executeTakeFirstOrThrow(),
        db
          .selectFrom("accounts")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("balance_observations")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("financial_transactions")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("commitments")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("plans")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("connections")
          .select([
            "id",
            "provider",
            "status",
            "institution_name",
            "last_successful_sync_at",
            "created_at",
            "updated_at",
          ])
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("activity_events")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("exception_cases")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("case_evidence")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("notification_preferences")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .where("user_id", "=", principal.userId)
          .executeTakeFirst(),
        db
          .selectFrom("notification_preference_revisions")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .where("user_id", "=", principal.userId)
          .orderBy("version", "asc")
          .execute(),
        db
          .selectFrom("notification_events")
          .select([
            "id",
            "user_id",
            "event_type",
            "title",
            "body",
            "deep_link_path",
            "occurrence_id",
            "occurrence_revision",
            "preference_revision",
            "scheduled_for",
            "lead_days",
            "timezone_snapshot",
            "available_cash_episode_id",
            "created_at",
          ])
          .where("household_id", "=", principal.householdId)
          .where("user_id", "=", principal.userId)
          .orderBy("created_at", "asc")
          .execute(),
        db
          .selectFrom("notification_deliveries")
          .select([
            "id",
            "user_id",
            "event_id",
            "channel",
            "state",
            "attempts",
            "available_at",
            "sent_at",
            "last_error_code",
            "created_at",
          ])
          .where("household_id", "=", principal.householdId)
          .where("user_id", "=", principal.userId)
          .orderBy("created_at", "asc")
          .execute(),
        db
          .selectFrom("financial_pattern_analyses")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("plan_occurrences")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("plan_occurrence_revisions")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("occurrence_transaction_matches")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("occurrence_match_revisions")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("transaction_entities")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("transaction_source_aliases")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("transaction_category_assignments")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("transaction_category_revisions")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("merchant_category_rules")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("savings_goals")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("savings_goal_revisions")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("savings_goal_movements")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("savings_movement_evidence")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("debts")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("debt_revisions")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("debt_balance_observations")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("debt_term_observations")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("debt_apr_components")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("debt_payment_policies")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("debt_payment_policy_revisions")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("debt_payment_evidence")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("debt_payment_evidence_reversals")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("income_schedules")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("income_schedule_revisions")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("account_planning_role_revisions")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("planning_periods")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("planning_period_revisions")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("income_boundaries")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("income_boundary_revisions")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("income_boundary_evidence")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("pay_cycles")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("pay_cycle_report_revisions")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("pay_cycle_report_inputs")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db
          .selectFrom("pay_cycle_account_coverage")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
        db.selectFrom("calculation_snapshots").selectAll()
          .where("household_id", "=", principal.householdId).execute(),
        db.selectFrom("available_cash_alert_episodes").selectAll()
          .where("household_id", "=", principal.householdId)
          .where("user_id", "=", principal.userId).execute(),
        db.selectFrom("available_cash_alert_states").selectAll()
          .where("household_id", "=", principal.householdId)
          .where("user_id", "=", principal.userId).execute(),
        db.selectFrom("starter_template_applications").selectAll()
          .where("household_id", "=", principal.householdId)
          .where("user_id", "=", principal.userId).execute(),
        db.selectFrom("starter_template_application_items").selectAll()
          .where("household_id", "=", principal.householdId).execute(),
      ]);
      return accountExportResponseSchema.parse({
        generatedAt: new Date().toISOString(),
        formatVersion: 5,
        data: normalize({
          household,
          accounts,
          balances,
          transactions,
          commitments,
          plans: plans.map((plan) => {
            const {
              income_amount_minor: _incomeAmount,
              income_frequency: _incomeFrequency,
              next_income_date: _nextIncomeDate,
              income_confirmed: _incomeConfirmed,
              income_source_name: _incomeSourceName,
              income_anchor_day: _incomeAnchorDay,
              income_anchor_eom: _incomeAnchorEom,
              income_advanced_from_occurrence_id:
                _incomeAdvancedFromOccurrenceId,
              income_previous_expected_date: _incomePreviousExpectedDate,
              ...canonicalPlan
            } = plan;
            return canonicalPlan;
          }),
          connections,
          activity,
          cases,
          evidence,
          preferences,
          preferenceRevisions,
          notificationEvents,
          notificationDeliveries,
          patternAnalyses,
          planOccurrences,
          occurrenceRevisions,
          occurrenceMatches,
          occurrenceMatchRevisions,
          transactionEntities,
          transactionAliases,
          transactionCategories,
          transactionCategoryRevisions,
          merchantCategoryRules,
          savingsGoals,
          savingsGoalRevisions,
          savingsGoalMovements,
          savingsMovementEvidence,
          debts,
          debtRevisions,
          debtBalances,
          debtTerms,
          debtAprComponents,
          debtPaymentPolicies,
          debtPaymentPolicyRevisions,
          debtPaymentEvidence,
          debtPaymentEvidenceReversals,
          incomeSchedules,
          incomeScheduleRevisions,
          accountPlanningRoleRevisions,
          planningPeriods,
          planningPeriodRevisions,
          incomeBoundaries,
          incomeBoundaryRevisions,
          incomeBoundaryEvidence,
          payCycles,
          payCycleReportRevisions,
          payCycleReportInputs,
          payCycleAccountCoverage,
          calculationSnapshots,
          availableCashAlertEpisodes,
          availableCashAlertStates,
          starterTemplateApplications,
          starterTemplateApplicationItems,
        }),
      });
    });
  }

  requestDeletion(identity: RequestIdentity, _request: AccountDeletionRequest) {
    return this.tenant.run(identity, async (db, principal) => {
      if (principal.role !== "owner")
        throw new ConflictException(
          "Only the household owner can delete this account",
        );
      const household = await db
        .selectFrom("households")
        .select(["id", "lifecycle_state"])
        .where("id", "=", principal.householdId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const membership = await sql<{
        active_household_count: number;
        successor_user_id: string | null;
      }>`select * from prepare_account_deletion_membership()`.execute(db);
      const handoff = membership.rows[0];
      if (!handoff)
        throw new ConflictException(
          "Account deletion could not verify household ownership",
        );
      if (handoff.active_household_count > 1)
        throw new ConflictException(
          "Account deletion for multiple households needs support assistance",
        );
      const successor = handoff.successor_user_id;
      const existing = await db
        .selectFrom("account_deletion_requests")
        .selectAll()
        .where("user_id", "=", principal.userId)
        .where("completed_at", "is", null)
        .executeTakeFirst();
      if (existing) return deletionResponse(existing);
      if (!successor) {
        if (household.lifecycle_state !== "active")
          throw new ConflictException(
            "Account deletion is already in progress",
          );
        await db
          .updateTable("households")
          .set({ lifecycle_state: "deleting" })
          .where("id", "=", principal.householdId)
          .execute();
        await db
          .updateTable("connections")
          .set({
            status: "revoked",
            revoked_at: new Date(),
            updated_at: new Date(),
          })
          .where("household_id", "=", principal.householdId)
          .where("provider", "=", "sample")
          .where("status", "!=", "revoked")
          .execute();
        await db
          .updateTable("accounts")
          .set({ include_in_plan: false, archived_at: new Date() })
          .where("household_id", "=", principal.householdId)
          .where("provenance", "=", "sample")
          .execute();
      }
      const activeConnections = successor
        ? []
        : await db
            .selectFrom("connections")
            .select("id")
            .where("household_id", "=", principal.householdId)
            .where("provider", "=", "plaid")
            .where("status", "not in", ["revoked", "revocation_pending"])
            .execute();
      const row = await db
        .insertInto("account_deletion_requests")
        .values({
          id: uuidv7(),
          household_id: principal.householdId,
          user_id: principal.userId,
          status: activeConnections.length
            ? "revoking_connections"
            : "ready_to_finalize",
          requested_at: new Date(),
          updated_at: new Date(),
          completed_at: null,
          last_error_code: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await db
        .updateTable("notification_endpoints")
        .set({ enabled: false, disabled_at: new Date() })
        .where("household_id", "=", principal.householdId)
        .where("user_id", "=", principal.userId)
        .execute();
      await db
        .updateTable("notification_preferences")
        .set({
          email_enabled: false,
          push_enabled: false,
          updated_at: new Date(),
        })
        .where("household_id", "=", principal.householdId)
        .where("user_id", "=", principal.userId)
        .execute();
      for (const connection of activeConnections) {
        await db
          .updateTable("connections")
          .set({ status: "revocation_pending", updated_at: new Date() })
          .where("id", "=", connection.id)
          .execute();
        await sql`insert into plaid_sync_jobs (household_id, connection_id, operation, trigger, state, available_at) values (${principal.householdId}::uuid, ${connection.id}::uuid, 'revoke', 'recovery', 'queued', now()) on conflict do nothing`.execute(
          db,
        );
      }
      return deletionResponse(row);
    });
  }

  deletionStatus(identity: RequestIdentity) {
    return this.tenant.run(identity, async (db, principal) => {
      const row = await db
        .selectFrom("account_deletion_requests")
        .selectAll()
        .where("user_id", "=", principal.userId)
        .where("completed_at", "is", null)
        .executeTakeFirst();
      return row ? deletionResponse(row) : null;
    });
  }
}

async function ensurePreferences(
  db: Parameters<Parameters<TenantDatabase["run"]>[1]>[0],
  householdId: string,
  userId: string,
  verifiedEmail: string | null = null,
) {
  await db
    .insertInto("notification_preferences")
    .values({
      household_id: householdId,
      user_id: userId,
      email_address: verifiedEmail,
      email_verified_at: verifiedEmail ? new Date() : null,
      email_consent_at: null,
      email_suppressed_at: null,
      updated_at: new Date(),
    })
    .onConflict((oc) =>
      verifiedEmail
        ? oc.columns(["household_id", "user_id"]).doUpdateSet({
            email_address: verifiedEmail,
            email_verified_at: new Date(),
            email_suppressed_at: null,
            updated_at: new Date(),
          }).where(sql<boolean>`
            notification_preferences.email_address is distinct from ${verifiedEmail}
            or notification_preferences.email_verified_at is null
            or notification_preferences.email_suppressed_at is not null
          `)
        : oc.columns(["household_id", "user_id"]).doNothing(),
    )
    .execute();
}
async function verifiedNotificationEmail(
  identity: RequestIdentity,
): Promise<string | null> {
  if (
    !identity.authSubject.startsWith("clerk|") ||
    !process.env.CLERK_SECRET_KEY
  )
    return process.env.NODE_ENV !== "production"
      ? (identity.email ?? null)
      : null;
  try {
    const user = await createClerkClient({
      secretKey: process.env.CLERK_SECRET_KEY,
    }).users.getUser(identity.authSubject.slice(6));
    const primary = user.emailAddresses.find(
      (item) => item.id === user.primaryEmailAddressId,
    );
    return primary?.verification?.status === "verified"
      ? primary.emailAddress
      : null;
  } catch {
    return null;
  }
}
function preferencesResponse(row: any) {
  return {
    version: row.version,
    emailAddress: row.email_address,
    emailVerified: Boolean(row.email_verified_at) && !row.email_suppressed_at,
    emailEnabled: row.email_enabled,
    pushEnabled: row.push_enabled,
    connectionHealth: row.connection_health,
    commitmentReminders: row.commitment_reminders,
    incomeReminders: row.income_reminders,
    savingsReminders: row.savings_reminders,
    exceptionActivity: row.exception_activity,
    weeklyDigest: row.weekly_digest,
    availableCashAlerts: row.available_cash_alerts,
    availableCashThreshold: {
      minor: row.available_cash_threshold_minor,
      currency: "USD",
    },
    lockScreenDetail: row.lock_screen_detail,
    reminderHour: row.reminder_hour,
    reminderMinute: row.reminder_minute,
    commitmentReminderDays: row.commitment_reminder_days,
    longTermReminderDays: row.long_term_reminder_days,
    savingsReminderDays: row.savings_reminder_days,
    quietStartMinute: row.quiet_start_minute,
    quietEndMinute: row.quiet_end_minute,
    timezone: row.timezone,
  };
}
function deletionResponse(row: any) {
  return accountDeletionResponseSchema.parse({
    id: row.id,
    status: row.status,
    requestedAt: row.requested_at.toISOString(),
  });
}
function normalize(value: unknown): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
  ) as Record<string, unknown>;
}
function hash(value: string): string {
  return createHash("sha256")
    .update(value.trim().toLocaleLowerCase())
    .digest("hex");
}
