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
      const row = await db
        .updateTable("notification_preferences")
        .set({
          email_address: request.emailAddress,
          email_verified_at: verifiedEmail ? new Date() : null,
          email_consent_at: request.emailEnabled ? new Date() : null,
          email_suppressed_at: null,
          email_enabled: request.emailEnabled,
          push_enabled: request.pushEnabled,
          connection_health: request.connectionHealth,
          commitment_reminders: request.commitmentReminders,
          exception_activity: request.exceptionActivity,
          weekly_digest: request.weeklyDigest,
          lock_screen_detail: request.lockScreenDetail,
          reminder_hour: request.reminderHour,
          timezone: request.timezone,
          updated_at: new Date(),
        })
        .where("household_id", "=", principal.householdId)
        .where("user_id", "=", principal.userId)
        .returningAll()
        .executeTakeFirstOrThrow();
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
        patternAnalyses,
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
          .selectFrom("financial_pattern_analyses")
          .selectAll()
          .where("household_id", "=", principal.householdId)
          .execute(),
      ]);
      return accountExportResponseSchema.parse({
        generatedAt: new Date().toISOString(),
        formatVersion: 1,
        data: normalize({
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
          patternAnalyses,
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
      if (!handoff) throw new ConflictException("Account deletion could not verify household ownership");
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
          throw new ConflictException("Account deletion is already in progress");
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
          })
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
    emailAddress: row.email_address,
    emailVerified: Boolean(row.email_verified_at) && !row.email_suppressed_at,
    emailEnabled: row.email_enabled,
    pushEnabled: row.push_enabled,
    connectionHealth: row.connection_health,
    commitmentReminders: row.commitment_reminders,
    exceptionActivity: row.exception_activity,
    weeklyDigest: row.weekly_digest,
    lockScreenDetail: row.lock_screen_detail,
    reminderHour: row.reminder_hour,
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
