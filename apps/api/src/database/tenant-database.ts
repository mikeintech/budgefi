import {
  ForbiddenException,
  Inject,
  Injectable,
  OnModuleInit,
} from "@nestjs/common";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../../../../packages/database/src/index.js";
import { DATABASE } from "./database.token.js";

export type RequestIdentity = Readonly<{
  authSubject: string;
  displayName?: string;
  email?: string;
  requestedHouseholdId?: string;
  requestId?: string;
}>;
export type Principal = Readonly<{
  userId: string;
  householdId: string;
  role: "owner" | "admin" | "member" | "viewer";
}>;

@Injectable()
export class TenantDatabase implements OnModuleInit {
  constructor(@Inject(DATABASE) private readonly database: Kysely<Database>) {}

  async onModuleInit(): Promise<void> {
    if (process.env.NODE_ENV !== "production") return;
    const role = await sql<{
      current_user: string;
      is_superuser: boolean;
      bypasses_rls: boolean;
      owns_database: boolean;
      app_member: boolean;
      plaid_worker_member: boolean;
      can_provision: boolean;
    }>`
      select current_user,
        current_setting('is_superuser') = 'on' as is_superuser,
        coalesce((select rolbypassrls from pg_roles where rolname = current_user), false) as bypasses_rls,
        (select datdba = (select oid from pg_roles where rolname = current_user) from pg_database where datname = current_database()) as owns_database,
        pg_has_role(current_user, 'budgefi_app', 'MEMBER') as app_member,
        pg_has_role(current_user, 'budgefi_plaid_worker', 'MEMBER') as plaid_worker_member,
        has_function_privilege('budgefi_app', 'provision_principal(text,text,text)', 'EXECUTE') as can_provision
    `
      .execute(this.database)
      .then((result) => result.rows[0]!);
    const plaidWorker = process.env.BUDGEFI_PROCESS_ROLE === "plaid-worker";
    if (
      role.is_superuser ||
      role.bypasses_rls ||
      role.owns_database ||
      !role.app_member ||
      (plaidWorker ? !role.plaid_worker_member : role.plaid_worker_member) ||
      !role.can_provision
    ) {
      throw new Error(
        `Unsafe production database role ${role.current_user}: request servers require only budgefi_app; the Plaid worker requires budgefi_app plus budgefi_plaid_worker`,
      );
    }
  }

  async run<T>(
    identity: RequestIdentity,
    work: (
      transaction: Transaction<Database>,
      principal: Principal,
    ) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction().execute(async (transaction) => {
      await sql`set local role budgefi_app`.execute(transaction);
      const existing = await sql<{
        user_id: string;
      }>`select user_id from resolve_principal(${identity.authSubject}, ${identity.requestedHouseholdId ?? null}::uuid)`.execute(
        transaction,
      );
      if (!existing.rows[0] && process.env.ALLOW_USER_PROVISIONING === "true") {
        await sql`select * from provision_principal(${identity.authSubject}, ${identity.displayName ?? null}, ${identity.email ?? null})`.execute(
          transaction,
        );
      }
      const resolved = await sql<{
        user_id: string;
        household_id: string;
        membership_role: Principal["role"];
      }>`
        select * from resolve_principal(${identity.authSubject}, ${identity.requestedHouseholdId ?? null}::uuid)
      `.execute(transaction);
      const row = resolved.rows[0];
      if (!row)
        throw new ForbiddenException(
          identity.requestedHouseholdId
            ? "No active membership for the requested household"
            : "No unambiguous active household membership",
        );
      await sql`select set_config('app.user_id', ${row.user_id}, true)`.execute(
        transaction,
      );
      await sql`select set_config('app.household_id', ${row.household_id}, true)`.execute(
        transaction,
      );
      return work(transaction, {
        userId: row.user_id,
        householdId: row.household_id,
        role: row.membership_role,
      });
    });
  }

  async healthCheck(): Promise<void> {
    await sql`select 1`.execute(this.database);
  }

  async runSystemHousehold<T>(
    householdId: string,
    work: (
      transaction: Transaction<Database>,
      principal: Principal,
    ) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction().execute(async (transaction) => {
      await sql`set local role budgefi_plaid_worker`.execute(transaction);
      const membership = await sql<{
        user_id: string;
        membership_role: Principal["role"];
      }>`select * from resolve_system_household_actor(${householdId}::uuid)`
        .execute(transaction)
        .then((result) => result.rows[0]);
      if (!membership)
        throw new ForbiddenException("Household has no active system actor");
      await sql`set local role budgefi_app`.execute(transaction);
      await sql`select set_config('app.user_id', ${membership.user_id}, true)`.execute(
        transaction,
      );
      await sql`select set_config('app.household_id', ${householdId}, true)`.execute(
        transaction,
      );
      return work(transaction, {
        userId: membership.user_id,
        householdId,
        role: membership.membership_role,
      });
    });
  }
}
