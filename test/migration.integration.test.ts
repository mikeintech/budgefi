import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

describe("fresh PostgreSQL migration and seed", () => {
  let client: pg.Client;
  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
  });
  afterAll(async () => client.end());

  it("applies every checked migration exactly once", async () => {
    const applied = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations ORDER BY name",
    );
    expect(applied.rows.map((row) => row.name)).toEqual([
      "001_initial.sql",
      "002_integrity_hardening.sql",
      "003_connection_operations.sql",
      "004_snapshot_input_manifest.sql",
      "005_household_revision_and_account_controls.sql",
      "006_real_plaid_and_provisioning.sql",
      "007_plaid_webhook_queue_coalescing.sql",
      "008_plaid_replay_and_runtime_role.sql",
      "009_membership_onboarding_state.sql",
      "010_native_operations.sql",
      "011_exception_evidence_snapshots.sql",
      "012_plaid_hosted_link.sql",
      "013_rls_safe_principal_provisioning.sql",
      "014_onboarding_pattern_analysis.sql",
      "015_pattern_analysis_retention.sql",
      "016_filter_non_actionable_duplicates.sql",
      "017_expire_existing_non_actionable_duplicates.sql",
      "018_cover_round_up_transfer_variants.sql",
      "019_system_operation_boundaries.sql",
      "020_exception_lifecycle.sql",
      "021_plaid_worker_and_deletion_boundaries.sql",
      "022_retire_interactive_sample_data.sql",
      "023_clerk_identity_lifecycle.sql",
    ]);
    expect(
      applied.rows.every((row) => /^[a-f0-9]{64}$/.test(row.checksum)),
    ).toBe(true);
  });

  it("queues verified Clerk deletions without exposing the identity event ledger", async () => {
    await client.query("BEGIN");
    try {
      await client.query(`
        INSERT INTO users(id,auth_subject,display_name)
        VALUES('23000000-0000-4000-8000-000000000001','clerk|user_identity_fixture','Identity Fixture');
        INSERT INTO households(id,name)
        VALUES('23000000-0000-4000-8000-000000000101','Identity Fixture Household');
        INSERT INTO household_memberships(household_id,user_id,role)
        VALUES('23000000-0000-4000-8000-000000000101','23000000-0000-4000-8000-000000000001','owner');
      `);
      await client.query("SET LOCAL ROLE budgefi_app");
      const first = await client.query<{
        known: boolean;
        duplicate: boolean;
        queued_deletions: number;
      }>("select * from ingest_verified_clerk_user_deleted('msg_identity_fixture','user_identity_fixture')");
      expect(first.rows[0]).toEqual({
        known: true,
        duplicate: false,
        queued_deletions: 1,
      });
      const duplicate = await client.query<{
        known: boolean;
        duplicate: boolean;
        queued_deletions: number;
      }>("select * from ingest_verified_clerk_user_deleted('msg_identity_fixture','user_identity_fixture')");
      expect(duplicate.rows[0]).toEqual({
        known: true,
        duplicate: true,
        queued_deletions: 1,
      });
      const unknown = await client.query<{
        known: boolean;
        duplicate: boolean;
        queued_deletions: number;
      }>("select * from ingest_verified_clerk_user_deleted('msg_unknown_identity','user_unknown_identity')");
      expect(unknown.rows[0]).toEqual({
        known: false,
        duplicate: false,
        queued_deletions: 0,
      });
      await client.query("SAVEPOINT hidden_receipts");
      await expect(
        client.query("select * from clerk_webhook_receipts"),
      ).rejects.toThrow(/permission denied/);
      await client.query("ROLLBACK TO SAVEPOINT hidden_receipts");
      await client.query("RESET ROLE");
      expect(
        (
          await client.query(
            "select status from account_deletion_requests where user_id='23000000-0000-4000-8000-000000000001'",
          )
        ).rows[0]?.status,
      ).toBe("ready_to_finalize");
      expect(
        (
          await client.query(
            "select lifecycle_state from households where id='23000000-0000-4000-8000-000000000101'",
          )
        ).rows[0]?.lifecycle_state,
      ).toBe("deleting");
      const receipts = await client.query<{
        clerk_user_id_hash: string;
        processing_status: string;
      }>("select clerk_user_id_hash,processing_status from clerk_webhook_receipts order by event_id");
      expect(receipts.rows).toHaveLength(2);
      expect(receipts.rows.every((row) => /^[a-f0-9]{64}$/.test(row.clerk_user_id_hash))).toBe(true);
      expect(
        (
          await client.query(
            "select processing_status from clerk_webhook_receipts where event_id='msg_identity_fixture'",
          )
        ).rows[0]?.processing_status,
      ).toBe("queued");
      await client.query(
        "update account_deletion_requests set status='completed',completed_at=now() where user_id='23000000-0000-4000-8000-000000000001'",
      );
      expect(
        (
          await client.query(
            "select processing_status from clerk_webhook_receipts where event_id='msg_identity_fixture'",
          )
        ).rows[0]?.processing_status,
      ).toBe("processed");
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("finishes every household for a deleted Clerk identity without erasing a shared household", async () => {
    await client.query("BEGIN");
    try {
      await client.query(`
        INSERT INTO users(id,auth_subject,display_name) VALUES
          ('23100000-0000-4000-8000-000000000001','clerk|user_multi_household','Departing Owner'),
          ('23100000-0000-4000-8000-000000000002','clerk|user_successor_owner','Successor Owner');
        INSERT INTO households(id,name) VALUES
          ('23100000-0000-4000-8000-000000000101','Sole Household'),
          ('23100000-0000-4000-8000-000000000102','Shared Household');
        INSERT INTO household_memberships(household_id,user_id,role,created_at) VALUES
          ('23100000-0000-4000-8000-000000000101','23100000-0000-4000-8000-000000000001','owner','2026-01-01T00:00:00Z'),
          ('23100000-0000-4000-8000-000000000102','23100000-0000-4000-8000-000000000001','owner','2026-01-02T00:00:00Z'),
          ('23100000-0000-4000-8000-000000000102','23100000-0000-4000-8000-000000000002','member','2026-01-03T00:00:00Z');
        INSERT INTO accounts(id,household_id,name,account_type,currency,provenance,provider_account_id) VALUES
          ('23100000-0000-4000-8000-000000000201','23100000-0000-4000-8000-000000000101','Sole checking','checking','USD','manual','sole-checking'),
          ('23100000-0000-4000-8000-000000000202','23100000-0000-4000-8000-000000000102','Shared checking','checking','USD','manual','shared-checking');
        INSERT INTO balance_observations(household_id,account_id,amount_minor,currency,provenance,as_of,source_record_id) VALUES
          ('23100000-0000-4000-8000-000000000101','23100000-0000-4000-8000-000000000201',50000,'USD','manual',now(),'sole-balance'),
          ('23100000-0000-4000-8000-000000000102','23100000-0000-4000-8000-000000000202',75000,'USD','manual',now(),'shared-balance');
      `);

      await client.query("SET LOCAL ROLE budgefi_app");
      const ingested = await client.query<{
        known: boolean;
        duplicate: boolean;
        queued_deletions: number;
      }>("select * from ingest_verified_clerk_user_deleted('msg_multi_household','user_multi_household')");
      expect(ingested.rows[0]).toEqual({
        known: true,
        duplicate: false,
        queued_deletions: 2,
      });
      await client.query("RESET ROLE");

      expect(
        (
          await client.query(
            "select role from household_memberships where household_id='23100000-0000-4000-8000-000000000102' and user_id='23100000-0000-4000-8000-000000000002'",
          )
        ).rows[0]?.role,
      ).toBe("owner");
      await client.query(`
        update account_deletion_requests
        set requested_at = case
          when household_id='23100000-0000-4000-8000-000000000101' then now() - interval '2 minutes'
          else now() - interval '1 minute'
        end,
        updated_at = now() - interval '1 minute'
        where user_id='23100000-0000-4000-8000-000000000001'
      `);

      await client.query("SET LOCAL ROLE budgefi_worker");
      const first = await client.query<{ request_id: string; household_id: string }>(
        "select request_id::text,household_id::text from claim_account_deletion()",
      );
      expect(first.rows[0]?.household_id).toBe("23100000-0000-4000-8000-000000000101");
      await client.query("select finalize_account_deletion($1)", [first.rows[0]?.request_id]);
      await client.query("RESET ROLE");

      expect(
        (
          await client.query(
            "select processing_status from clerk_webhook_receipts where event_id='msg_multi_household'",
          )
        ).rows[0]?.processing_status,
      ).toBe("queued");
      expect(
        (
          await client.query(
            "select count(*)::int count from accounts where household_id='23100000-0000-4000-8000-000000000101'",
          )
        ).rows[0]?.count,
      ).toBe(0);
      expect(
        (
          await client.query(
            "select count(*)::int count from accounts where household_id='23100000-0000-4000-8000-000000000102'",
          )
        ).rows[0]?.count,
      ).toBe(1);

      await client.query("SET LOCAL ROLE budgefi_worker");
      const second = await client.query<{ request_id: string; household_id: string }>(
        "select request_id::text,household_id::text from claim_account_deletion()",
      );
      expect(second.rows[0]?.household_id).toBe("23100000-0000-4000-8000-000000000102");
      await client.query("select finalize_account_deletion($1)", [second.rows[0]?.request_id]);
      await client.query("RESET ROLE");

      expect(
        (
          await client.query(
            "select processing_status from clerk_webhook_receipts where event_id='msg_multi_household'",
          )
        ).rows[0]?.processing_status,
      ).toBe("processed");
      expect(
        (
          await client.query(
            "select count(*)::int count from household_memberships where user_id='23100000-0000-4000-8000-000000000001' and revoked_at is null",
          )
        ).rows[0]?.count,
      ).toBe(0);
      expect(
        (
          await client.query(
            "select lifecycle_state,deleted_at is null as retained from households where id='23100000-0000-4000-8000-000000000102'",
          )
        ).rows[0],
      ).toEqual({ lifecycle_state: "active", retained: true });
      expect(
        (
          await client.query(
            "select role,revoked_at is null as active from household_memberships where household_id='23100000-0000-4000-8000-000000000102' and user_id='23100000-0000-4000-8000-000000000002'",
          )
        ).rows[0],
      ).toEqual({ role: "owner", active: true });
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("retires legacy sample-only and mixed fixtures without changing genuine records", async () => {
    const sampleAccounts = await client.query<{
      count: number;
      archived: number;
      included: number;
    }>(`select count(*)::int count,
        count(*) filter (where archived_at is not null)::int archived,
        count(*) filter (where include_in_plan)::int included
      from accounts where provenance='sample' and household_id::text like '22000000-%'`);
    expect(sampleAccounts.rows[0]).toEqual({
      count: 3,
      archived: 3,
      included: 0,
    });
    const sampleConnections = await client.query<{
      count: number;
      revoked: number;
    }>(`select count(*)::int count,
        count(*) filter (where status='revoked' and revoked_at is not null)::int revoked
      from connections where provider='sample' and household_id::text like '22000000-%'`);
    expect(sampleConnections.rows[0]).toEqual({ count: 3, revoked: 3 });

    const memberships = await client.query<{
      household_id: string;
      complete: boolean;
    }>(`select household_id::text,
        onboarding_completed_at is not null complete
      from household_memberships
      where household_id::text like '22000000-%'
      order by household_id`);
    expect(memberships.rows).toEqual([
      { household_id: "22000000-0000-4000-8000-000000000101", complete: false },
      { household_id: "22000000-0000-4000-8000-000000000102", complete: true },
      { household_id: "22000000-0000-4000-8000-000000000103", complete: true },
    ]);

    expect(
      (
        await client.query(
          "select amount_minor from balance_observations where household_id='22000000-0000-4000-8000-000000000102' and source_record_id='user-confirmed'",
        )
      ).rows[0]?.amount_minor,
    ).toBe("123400");
    expect(
      (
        await client.query(
          "select count(*)::int count from accounts where household_id='22000000-0000-4000-8000-000000000103' and provenance='plaid' and archived_at is null",
        )
      ).rows[0]?.count,
    ).toBe(1);
    expect(
      (
        await client.query(
          "select status from exception_cases where id='22000000-0000-4000-8000-000000000701'",
        )
      ).rows[0]?.status,
    ).toBe("expired");
    expect(
      (
        await client.query(
          "select name,version from commitments where id='22000000-0000-4000-8000-000000000401'",
        )
      ).rows[0],
    ).toEqual({ name: "StreamBox", version: 1 });
    expect(
      (
        await client.query(
          "select name,version from commitment_revisions where commitment_id='22000000-0000-4000-8000-000000000401'",
        )
      ).rows[0],
    ).toEqual({ name: "StreamBox", version: 1 });
    expect(
      (
        await client.query(
          "select min(data_revision)::int minimum,max(data_revision)::int maximum from households where id::text like '22000000-%'",
        )
      ).rows[0],
    ).toEqual({ minimum: 2, maximum: 2 });
  });

  it("bootstraps separate least-privilege production login roles", async () => {
    const result = await client.query<{
      role_name: string;
      can_login: boolean;
      is_superuser: boolean;
      bypasses_rls: boolean;
      app_member: boolean;
      worker_member: boolean;
      plaid_worker_member: boolean;
    }>(`
      select role.rolname as role_name,
        role.rolcanlogin as can_login,
        role.rolsuper as is_superuser,
        role.rolbypassrls as bypasses_rls,
        pg_has_role(role.rolname, 'budgefi_app', 'MEMBER') as app_member,
        pg_has_role(role.rolname, 'budgefi_worker', 'MEMBER') as worker_member
        ,pg_has_role(role.rolname, 'budgefi_plaid_worker', 'MEMBER') as plaid_worker_member
      from pg_roles role
      where role.rolname in ('budgefi_runtime', 'budgefi_worker_runtime', 'budgefi_plaid_worker_runtime')
      order by role.rolname
    `);

    expect(result.rows).toEqual([
      {
        role_name: "budgefi_plaid_worker_runtime",
        can_login: true,
        is_superuser: false,
        bypasses_rls: false,
        app_member: true,
        worker_member: false,
        plaid_worker_member: true,
      },
      {
        role_name: "budgefi_runtime",
        can_login: true,
        is_superuser: false,
        bypasses_rls: false,
        app_member: true,
        worker_member: false,
        plaid_worker_member: false,
      },
      {
        role_name: "budgefi_worker_runtime",
        can_login: true,
        is_superuser: false,
        bypasses_rls: false,
        app_member: false,
        worker_member: true,
        plaid_worker_member: false,
      },
    ]);
  });

  it("seeds included cash plus complete plan and commitment revision history", async () => {
    const cash = await client.query<{
      include_in_plan: boolean;
      amount_minor: string;
    }>(
      "SELECT a.include_in_plan, b.amount_minor FROM accounts a JOIN balance_observations b ON b.account_id = a.id WHERE a.id = '00000000-0000-4000-8000-000000000201'",
    );
    expect(cash.rows[0]).toEqual({
      include_in_plan: true,
      amount_minor: "423039",
    });
    expect(
      Number(
        (await client.query("SELECT count(*) FROM plan_revisions")).rows[0]
          ?.count,
      ),
    ).toBe(1);
    expect(
      Number(
        (
          await client.query(
            "SELECT count(*) FROM commitment_revisions WHERE household_id='00000000-0000-4000-8000-000000000101'",
          )
        ).rows[0]?.count,
      ),
    ).toBe(4);
  });

  it("creates a non-superuser application role without global-user access", async () => {
    const role = await client.query<{
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
    }>(
      "SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = 'budgefi_app'",
    );
    expect(role.rows[0]).toEqual({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
    expect(
      (
        await client.query(
          "SELECT has_table_privilege('budgefi_app', 'users', 'SELECT') AS allowed",
        )
      ).rows[0]?.allowed,
    ).toBe(false);
    expect(
      (
        await client.query(
          "SELECT has_function_privilege('budgefi_app', 'provision_principal(text,text,text)', 'EXECUTE') AS allowed",
        )
      ).rows[0]?.allowed,
    ).toBe(true);
    expect(
      (
        await client.query(
          "SELECT has_function_privilege('budgefi_app', 'claim_plaid_sync_job(uuid)', 'EXECUTE') AS allowed",
        )
      ).rows[0]?.allowed,
    ).toBe(false);
    expect(
      (
        await client.query(
          "SELECT has_function_privilege('budgefi_plaid_worker', 'claim_plaid_sync_job(uuid)', 'EXECUTE') AS allowed",
        )
      ).rows[0]?.allowed,
    ).toBe(true);
    expect(
      (
        await client.query(
          "SELECT has_function_privilege('budgefi_app', 'resolve_system_household_actor(uuid)', 'EXECUTE') AS allowed",
        )
      ).rows[0]?.allowed,
    ).toBe(false);
    expect(
      (
        await client.query(
          "SELECT has_function_privilege('budgefi_app', 'claim_notification_delivery()', 'EXECUTE') AS allowed",
        )
      ).rows[0]?.allowed,
    ).toBe(false);
    expect(
      (
        await client.query(
          "SELECT has_function_privilege('budgefi_worker', 'claim_notification_delivery()', 'EXECUTE') AS allowed",
        )
      ).rows[0]?.allowed,
    ).toBe(true);
  });

  it("leases notification work only through the worker capability and finishes it", async () => {
    await client.query("BEGIN");
    try {
      await client.query(
        "INSERT INTO notification_preferences (household_id,user_id,push_enabled) VALUES ('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001',true)",
      );
      await client.query(
        "INSERT INTO notification_endpoints (id,household_id,user_id,platform,token_hash,encrypted_token,token_key_id,device_label) VALUES ('00000000-0000-4000-8000-000000000901','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001','ios','fixture-token-hash','{}','test-v1','Test iPhone')",
      );
      await client.query(
        "INSERT INTO notification_events (id,household_id,user_id,event_type,title,body,dedupe_key) VALUES ('00000000-0000-4000-8000-000000000902','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001','test','Generic title','Generic body','fixture-test')",
      );
      await client.query(
        "INSERT INTO notification_deliveries (id,household_id,user_id,event_id,endpoint_id,channel) VALUES ('00000000-0000-4000-8000-000000000903','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000902','00000000-0000-4000-8000-000000000901','push')",
      );
      await client.query("SET LOCAL ROLE budgefi_worker");
      const claimed = await client.query<{
        delivery_id: string;
        attempts: number;
      }>("SELECT delivery_id,attempts FROM claim_notification_delivery()");
      expect(claimed.rows[0]).toEqual({
        delivery_id: "00000000-0000-4000-8000-000000000903",
        attempts: 1,
      });
      await client.query(
        "SELECT finish_notification_delivery('00000000-0000-4000-8000-000000000903','sent',null)",
      );
      await client.query("RESET ROLE");
      expect(
        (
          await client.query(
            "SELECT state FROM notification_deliveries WHERE id='00000000-0000-4000-8000-000000000903'",
          )
        ).rows[0]?.state,
      ).toBe("sent");

      await client.query(
        "INSERT INTO users(id,auth_subject,display_name) VALUES('00000000-0000-4000-8000-000000000013','test|endpoint-owner','Endpoint Owner')",
      );
      await client.query(
        "INSERT INTO households(id,name) VALUES('00000000-0000-4000-8000-000000000113','Endpoint Household')",
      );
      await client.query(
        "INSERT INTO household_memberships(household_id,user_id,role,onboarding_completed_at) VALUES('00000000-0000-4000-8000-000000000113','00000000-0000-4000-8000-000000000013','owner',now())",
      );
      await client.query(
        "SELECT set_config('app.user_id','00000000-0000-4000-8000-000000000013',true),set_config('app.household_id','00000000-0000-4000-8000-000000000113',true)",
      );
      const moved = await client.query<{ id: string }>(
        "SELECT id FROM register_notification_endpoint('00000000-0000-4000-8000-000000000904','ios','fixture-token-hash','{}','test-v1','New iPhone')",
      );
      expect(moved.rows[0]?.id).toBe("00000000-0000-4000-8000-000000000904");
      expect(
        (
          await client.query(
            "SELECT enabled,household_id FROM notification_endpoints WHERE id='00000000-0000-4000-8000-000000000901'",
          )
        ).rows[0],
      ).toEqual({
        enabled: false,
        household_id: "00000000-0000-4000-8000-000000000101",
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("keeps append-only history immutable outside an audited final deletion", async () => {
    await client.query("BEGIN");
    try {
      const event = await client.query<{ id: string }>(
        "SELECT id FROM activity_events WHERE household_id='00000000-0000-4000-8000-000000000101' LIMIT 1",
      );
      expect(event.rows[0]?.id).toBeTruthy();
      await client.query("SAVEPOINT ordinary_delete");
      await expect(
        client.query("DELETE FROM activity_events WHERE id=$1", [
          event.rows[0]!.id,
        ]),
      ).rejects.toThrow(/append-only/);
      await client.query("ROLLBACK TO SAVEPOINT ordinary_delete");

      const plan = (
        await client.query<{ id: string; version: number }>(
          "SELECT id,version FROM plans WHERE household_id='00000000-0000-4000-8000-000000000101'",
        )
      ).rows[0]!;
      const revision = (
        await client.query<{ id: string; version: number }>(
          "SELECT id,version FROM plan_revisions WHERE household_id='00000000-0000-4000-8000-000000000101' LIMIT 1",
        )
      ).rows[0]!;
      await client.query(
        "INSERT INTO calculation_snapshots(id,household_id,plan_id,plan_version,known_cash_minor,commitments_minor,planned_savings_minor,safety_buffer_minor,available_minor,currency,policy_version,input_fingerprint) VALUES('00000000-0000-4000-8000-000000000913','00000000-0000-4000-8000-000000000101',$1,$2,10000,1000,500,500,8000,'USD','test-v1','deletion-fixture')",
        [plan.id, plan.version],
      );
      await client.query(
        "INSERT INTO calculation_snapshot_inputs(household_id,snapshot_id,input_kind,input_id,input_version,input_hash,ordinal) VALUES('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000913','plan_revision',$1,$2,'fixture-hash',0)",
        [revision.id, revision.version],
      );

      const before = await client.query<{
        snapshots: string;
        inputs: string;
        activity: string;
        plan_revisions: string;
        commitment_revisions: string;
      }>(
        "SELECT (SELECT count(*) FROM calculation_snapshots WHERE household_id='00000000-0000-4000-8000-000000000101') snapshots,(SELECT count(*) FROM calculation_snapshot_inputs WHERE household_id='00000000-0000-4000-8000-000000000101') inputs,(SELECT count(*) FROM activity_events WHERE household_id='00000000-0000-4000-8000-000000000101') activity,(SELECT count(*) FROM plan_revisions WHERE household_id='00000000-0000-4000-8000-000000000101') plan_revisions,(SELECT count(*) FROM commitment_revisions WHERE household_id='00000000-0000-4000-8000-000000000101') commitment_revisions",
      );
      expect(
        Object.values(before.rows[0]!).every((count) => Number(count) > 0),
      ).toBe(true);
      await client.query(
        "UPDATE connections SET status='revoked',revoked_at=now() WHERE household_id='00000000-0000-4000-8000-000000000101'",
      );
      await client.query(
        "INSERT INTO account_deletion_requests(id,household_id,user_id,status,requested_at,updated_at) VALUES('00000000-0000-4000-8000-000000000911','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001','ready_to_finalize',now()-interval '1 minute',now()-interval '1 minute')",
      );
      await client.query("SET LOCAL ROLE budgefi_worker");
      expect(
        (await client.query("SELECT request_id FROM claim_account_deletion()"))
          .rows[0]?.request_id,
      ).toBe("00000000-0000-4000-8000-000000000911");
      await client.query(
        "SELECT finalize_account_deletion('00000000-0000-4000-8000-000000000911')",
      );
      await client.query("RESET ROLE");
      expect(
        (
          await client.query(
            "SELECT status FROM account_deletion_requests WHERE id='00000000-0000-4000-8000-000000000911'",
          )
        ).rows[0]?.status,
      ).toBe("completed");
      expect(
        Number(
          (
            await client.query(
              "SELECT count(*) FROM calculation_snapshots WHERE household_id='00000000-0000-4000-8000-000000000101'",
            )
          ).rows[0]?.count,
        ),
      ).toBe(0);
      expect(
        Number(
          (
            await client.query(
              "SELECT count(*) FROM activity_events WHERE household_id='00000000-0000-4000-8000-000000000101'",
            )
          ).rows[0]?.count,
        ),
      ).toBe(0);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("removes a departing owner without destroying a successor household", async () => {
    await client.query("BEGIN");
    try {
      await client.query(
        "INSERT INTO users(id,auth_subject,display_name) VALUES('00000000-0000-4000-8000-000000000012','test|successor','Successor')",
      );
      await client.query(
        "INSERT INTO household_memberships(household_id,user_id,role,onboarding_completed_at) VALUES('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000012','owner',now())",
      );
      const before = Number(
        (
          await client.query(
            "SELECT count(*) FROM accounts WHERE household_id='00000000-0000-4000-8000-000000000101'",
          )
        ).rows[0]?.count,
      );
      expect(before).toBeGreaterThan(0);
      await client.query(
        "INSERT INTO account_deletion_requests(id,household_id,user_id,status,requested_at,updated_at) VALUES('00000000-0000-4000-8000-000000000912','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001','ready_to_finalize',now()-interval '1 minute',now()-interval '1 minute')",
      );
      await client.query("SET LOCAL ROLE budgefi_worker");
      expect(
        (await client.query("SELECT request_id FROM claim_account_deletion()"))
          .rows[0]?.request_id,
      ).toBe("00000000-0000-4000-8000-000000000912");
      await client.query(
        "SELECT finalize_account_deletion('00000000-0000-4000-8000-000000000912')",
      );
      await client.query("RESET ROLE");
      expect(
        Number(
          (
            await client.query(
              "SELECT count(*) FROM accounts WHERE household_id='00000000-0000-4000-8000-000000000101'",
            )
          ).rows[0]?.count,
        ),
      ).toBe(before);
      expect(
        (
          await client.query(
            "SELECT revoked_at IS NULL AS active FROM household_memberships WHERE household_id='00000000-0000-4000-8000-000000000101' AND user_id='00000000-0000-4000-8000-000000000012'",
          )
        ).rows[0]?.active,
      ).toBe(true);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("schedules due Plaid synchronization and records a stale health episode", async () => {
    await client.query("BEGIN");
    try {
      await client.query(
        "INSERT INTO connections(id,household_id,provider,provider_item_id,encrypted_access_token,status,last_successful_sync_at,environment,token_key_id) VALUES('00000000-0000-4000-8000-000000000921','00000000-0000-4000-8000-000000000101','plaid','scheduled-fixture','{}','healthy',now()-interval '40 hours','sandbox','test-v1')",
      );
      await client.query("SET LOCAL ROLE budgefi_app");
      expect(
        Number(
          (await client.query("SELECT count(*) FROM connections")).rows[0]
            ?.count,
        ),
      ).toBe(0);
      await client.query("SAVEPOINT before_denied");
      await expect(
        client.query("SELECT schedule_plaid_maintenance() AS count"),
      ).rejects.toThrow(/permission denied/);
      await client.query("ROLLBACK TO SAVEPOINT before_denied");
      await client.query("RESET ROLE");
      await client.query("SET LOCAL ROLE budgefi_plaid_worker");
      expect(
        (await client.query("SELECT schedule_plaid_maintenance() AS count"))
          .rows[0]?.count,
      ).toBe(1);
      expect(
        (
          await client.query(
            "SELECT connection_id FROM claim_plaid_sync_job(null)",
          )
        ).rows[0]?.connection_id,
      ).toBe("00000000-0000-4000-8000-000000000921");
      await client.query("RESET ROLE");
      expect(
        (
          await client.query(
            "SELECT status,error_code FROM connections WHERE id='00000000-0000-4000-8000-000000000921'",
          )
        ).rows[0],
      ).toEqual({ status: "stale", error_code: "SYNC_STALE" });
      expect(
        (
          await client.query(
            "SELECT trigger,state FROM plaid_sync_jobs WHERE connection_id='00000000-0000-4000-8000-000000000921'",
          )
        ).rows[0],
      ).toEqual({ trigger: "scheduled", state: "running" });
      await client.query("SET LOCAL ROLE budgefi_plaid_worker");
      expect(
        (await client.query("SELECT schedule_plaid_maintenance() AS count"))
          .rows[0]?.count,
      ).toBe(0);
      await client.query("RESET ROLE");
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("creates one evidence-backed case for a real duplicate charge", async () => {
    await client.query("BEGIN");
    try {
      const accountId = (
        await client.query(
          "SELECT id FROM accounts WHERE household_id='00000000-0000-4000-8000-000000000101' AND provenance='manual' LIMIT 1",
        )
      ).rows[0]?.id;
      expect(accountId).toBeTruthy();
      await client.query(
        "SELECT set_config('app.user_id','00000000-0000-4000-8000-000000000001',true),set_config('app.household_id','00000000-0000-4000-8000-000000000101',true)",
      );
      await client.query(
        "INSERT INTO financial_transactions(household_id,account_id,source_kind,source_record_id,merchant,amount_minor,currency,occurred_on,status) VALUES('00000000-0000-4000-8000-000000000101',$1,'manual','duplicate-a','Corner Market',4782,'USD','2026-08-28','posted'),('00000000-0000-4000-8000-000000000101',$1,'manual','duplicate-b','Corner   Market',4782,'USD','2026-08-29','posted')",
        [accountId],
      );
      expect(
        (
          await client.query(
            "SELECT refresh_financial_exceptions('00000000-0000-4000-8000-000000000101') AS count",
          )
        ).rows[0]?.count,
      ).toBe(1);
      const item = (
        await client.query(
          "SELECT id,status,detection_key FROM exception_cases WHERE detection_key IS NOT NULL",
        )
      ).rows[0];
      expect(item?.status).toBe("open");
      expect(item?.detection_key).toMatch(/^duplicate:/);
      expect(
        Number(
          (
            await client.query(
              "SELECT count(*) FROM case_evidence WHERE case_id=$1",
              [item.id],
            )
          ).rows[0]?.count,
        ),
      ).toBe(2);
      const snapshots = (
        await client.query(
          "SELECT merchant_snapshot,amount_minor_snapshot::text,currency_snapshot,occurred_on_snapshot::text,account_id_snapshot,account_name_snapshot,status_snapshot,provenance_snapshot FROM case_evidence WHERE case_id=$1 ORDER BY occurred_on_snapshot",
          [item.id],
        )
      ).rows;
      expect(snapshots).toEqual([
        {
          merchant_snapshot: "Corner Market",
          amount_minor_snapshot: "4782",
          currency_snapshot: "USD",
          occurred_on_snapshot: "2026-08-28",
          account_id_snapshot: accountId,
          account_name_snapshot: "Manual spendable cash",
          status_snapshot: "posted",
          provenance_snapshot: "manual",
        },
        {
          merchant_snapshot: "Corner   Market",
          amount_minor_snapshot: "4782",
          currency_snapshot: "USD",
          occurred_on_snapshot: "2026-08-29",
          account_id_snapshot: accountId,
          account_name_snapshot: "Manual spendable cash",
          status_snapshot: "posted",
          provenance_snapshot: "manual",
        },
      ]);
      await client.query("SAVEPOINT evidence_immutability");
      await expect(
        client.query(
          "UPDATE case_evidence SET summary=summary WHERE case_id=$1",
          [item.id],
        ),
      ).rejects.toThrow(/append-only/);
      await client.query("ROLLBACK TO SAVEPOINT evidence_immutability");
      expect(
        (
          await client.query(
            "SELECT refresh_financial_exceptions('00000000-0000-4000-8000-000000000101') AS count",
          )
        ).rows[0]?.count,
      ).toBe(0);
      await client.query(
        "INSERT INTO financial_transactions(household_id,account_id,source_kind,source_record_id,merchant,amount_minor,currency,occurred_on,status,direction,revision) VALUES('00000000-0000-4000-8000-000000000101',$1,'manual','duplicate-b','Corner Market',4782,'USD','2026-08-29','removed','debit',2)",
        [accountId],
      );
      await client.query(
        "SELECT refresh_financial_exceptions('00000000-0000-4000-8000-000000000101')",
      );
      expect(
        (
          await client.query("SELECT status FROM exception_cases WHERE id=$1", [
            item.id,
          ])
        ).rows[0]?.status,
      ).toBe("expired");
      await client.query(
        "INSERT INTO financial_transactions(household_id,account_id,source_kind,source_record_id,merchant,amount_minor,currency,occurred_on,status,direction) VALUES('00000000-0000-4000-8000-000000000101',$1,'manual','credit-a','Employer deposit',150000,'USD','2026-08-28','posted','credit'),('00000000-0000-4000-8000-000000000101',$1,'manual','credit-b','Employer deposit',150000,'USD','2026-08-29','posted','credit')",
        [accountId],
      );
      expect(
        (
          await client.query(
            "SELECT refresh_financial_exceptions('00000000-0000-4000-8000-000000000101') AS count",
          )
        ).rows[0]?.count,
      ).toBe(0);
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
