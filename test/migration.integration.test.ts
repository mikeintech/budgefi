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
      "024_plaid_duplicate_item_guard.sql",
      "025_plaid_fingerprint_write_boundary.sql",
      "026_exclude_unused_manual_placeholders.sql",
      "027_income_aware_planning_policy.sql",
      "028_transaction_feed_and_categories.sql",
      "029_verified_savings_goals.sql",
      "030_debt_visibility.sql",
      "031_multiple_income_schedules.sql",
      "032_pay_cycle_history.sql",
      "033_flexible_schedules_and_reminders.sql",
      "034_commitment_slots_and_explicit_skips.sql",
      "035_common_bill_starters_and_available_cash_alerts.sql",
    ]);
    expect(
      applied.rows.every((row) => /^[a-f0-9]{64}$/.test(row.checksum)),
    ).toBe(true);
  });

  it("keeps SQL quarterly and annual recurrence identical to calendar anchors", async () => {
    const vectors = await client.query<{
      jan_quarter: string;
      jul_quarter: string;
      fixed_april: string;
      eom_april: string;
      common_february: string;
      leap_february: string;
      non_leap_century: string;
      leap_century: string;
    }>(`select
      anchored_occurrence_date('2027-01-31','quarterly',1,31,true)::text jan_quarter,
      anchored_occurrence_date('2027-01-31','quarterly',2,31,true)::text jul_quarter,
      anchored_occurrence_date('2027-01-30','quarterly',1,30,false)::text fixed_april,
      anchored_occurrence_date('2027-01-31','quarterly',1,31,true)::text eom_april,
      anchored_occurrence_date('2024-02-29','annual',1,29,true)::text common_february,
      anchored_occurrence_date('2024-02-29','annual',4,29,true)::text leap_february,
      anchored_occurrence_date('2096-02-29','annual',4,29,true)::text non_leap_century,
      anchored_occurrence_date('2396-02-29','annual',4,29,true)::text leap_century`);
    expect(vectors.rows[0]).toEqual({
      jan_quarter: "2027-04-30",
      jul_quarter: "2027-07-31",
      fixed_april: "2027-04-30",
      eom_april: "2027-04-30",
      common_february: "2025-02-28",
      leap_february: "2028-02-29",
      non_leap_century: "2100-02-28",
      leap_century: "2400-02-29",
    });
  });

  it("releases a setup slot after a one-time commitment is settled", async () => {
    await client.query("BEGIN");
    try {
      await client.query(
        `update commitments set settled_at=now(), recurrence=null, version=version+1
         where household_id='00000000-0000-4000-8000-000000000101' and setup_slot='utilities'`,
      );
      await client.query(
        `insert into commitments(household_id,name,amount_minor,currency,due_date,provenance,setup_slot)
         values('00000000-0000-4000-8000-000000000101','Replacement power',12000,'USD',current_date+20,'manual','utilities')`,
      );
      await expect(
        client.query(
          `insert into commitments(household_id,name,amount_minor,currency,due_date,provenance,setup_slot)
           values('00000000-0000-4000-8000-000000000101','Duplicate power',13000,'USD',current_date+21,'manual','utilities')`,
        ),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("schedules reminders deterministically across DST and quiet hours", async () => {
    const values = await client.query<{
      repeated_minute: string;
      missing_minute: string;
      overnight_quiet: string;
      immediate_daytime: string;
      immediate_overnight: string;
    }>(`select
      to_char(notification_local_instant('2026-11-01',90,'America/New_York') at time zone 'UTC','YYYY-MM-DD HH24:MI') repeated_minute,
      to_char(notification_local_instant('2026-03-08',150,'America/New_York') at time zone 'UTC','YYYY-MM-DD HH24:MI') missing_minute,
      to_char(notification_scheduled_instant('2026-09-03',0,22,0,'America/New_York',1260,480) at time zone 'UTC','YYYY-MM-DD HH24:MI') overnight_quiet,
      to_char(notification_immediate_instant('2026-09-03 15:37:00+00','America/New_York',1260,480) at time zone 'UTC','YYYY-MM-DD HH24:MI') immediate_daytime,
      to_char(notification_immediate_instant('2026-09-04 02:00:00+00','America/New_York',1260,480) at time zone 'UTC','YYYY-MM-DD HH24:MI') immediate_overnight`);
    expect(values.rows[0]).toEqual({
      repeated_minute: "2026-11-01 05:30",
      missing_minute: "2026-03-08 07:30",
      overnight_quiet: "2026-09-04 12:00",
      immediate_daytime: "2026-09-03 15:37",
      immediate_overnight: "2026-09-04 12:00",
    });
  });

  it("creates one Tuesday digest when Monday quiet hours defer delivery", async () => {
    await client.query("BEGIN");
    try {
      await client.query(
        `insert into notification_preferences(
          household_id,user_id,email_address,email_verified_at,email_enabled,
          weekly_digest,reminder_hour,reminder_minute,quiet_start_minute,
          quiet_end_minute,timezone
        ) values(
          '00000000-0000-4000-8000-000000000101',
          '00000000-0000-4000-8000-000000000001','owner@example.com',now(),true,
          true,22,0,1260,480,'America/New_York'
        )`,
      );
      await client.query("SET LOCAL ROLE budgefi_worker");
      await client.query(
        "select generate_notification_events('00000000-0000-4000-8000-000000000101','2026-09-08 12:00:00+00')",
      );
      await client.query(
        "select generate_notification_events('00000000-0000-4000-8000-000000000101','2026-09-08 12:01:00+00')",
      );
      await client.query("RESET ROLE");
      const digest = await client.query<{
        count: number;
        scheduled_for: string;
        deliveries: number;
      }>(`select count(*)::int count,
        min(to_char(scheduled_for at time zone 'UTC','YYYY-MM-DD HH24:MI')) scheduled_for,
        (select count(*)::int from notification_deliveries d join notification_events e on e.id=d.event_id where e.event_type='digest.weekly') deliveries
        from notification_events where event_type='digest.weekly'`);
      expect(digest.rows[0]).toEqual({
        count: 1,
        scheduled_for: "2026-09-08 12:00",
        deliveries: 1,
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("revisions reminder choices and rejects noisy lead-day sets", async () => {
    await client.query("BEGIN");
    try {
      await client.query(
        "insert into notification_preferences(household_id,user_id) values('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001')",
      );
      await client.query(
        "update notification_preferences set commitment_reminder_days=array[7,1]::smallint[] where household_id='00000000-0000-4000-8000-000000000101' and user_id='00000000-0000-4000-8000-000000000001'",
      );
      const revisions = await client.query<{
        version: number;
        days: number[];
      }>(
        "select version,commitment_reminder_days days from notification_preference_revisions where household_id='00000000-0000-4000-8000-000000000101' order by version",
      );
      expect(revisions.rows).toEqual([
        { version: 1, days: [3] },
        { version: 2, days: [7, 1] },
      ]);
      await client.query("SAVEPOINT invalid_leads");
      await expect(
        client.query(
          "update notification_preferences set commitment_reminder_days=array[14,7,1]::smallint[] where household_id='00000000-0000-4000-8000-000000000101' and user_id='00000000-0000-4000-8000-000000000001'",
        ),
      ).rejects.toThrow();
      await client.query("ROLLBACK TO SAVEPOINT invalid_leads");
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("forces tenant isolation and append-only category history for transaction organization", async () => {
    const names = [
      "transaction_entities",
      "transaction_source_aliases",
      "transaction_category_assignments",
      "transaction_category_revisions",
      "merchant_category_rules",
    ];
    const rls = await client.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      "select relname,relrowsecurity,relforcerowsecurity from pg_class where relname=any($1::text[]) order by relname",
      [names],
    );
    expect(rls.rows).toHaveLength(names.length);
    expect(
      rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
    ).toBe(true);
    const deleteGrants = await client.query(
      "select table_name from information_schema.role_table_grants where grantee in ('budgefi_app','budgefi_plaid_worker') and privilege_type='DELETE' and table_name=any($1::text[])",
      [names],
    );
    expect(deleteGrants.rows).toHaveLength(0);
    const triggers = await client.query<{ count: string }>(
      "select count(*)::text count from pg_trigger where tgrelid='transaction_category_revisions'::regclass and not tgisinternal",
    );
    expect(Number(triggers.rows[0]?.count)).toBeGreaterThan(0);
  });

  it("protects savings data and materializes recurring goals idempotently", async () => {
    const names = [
      "savings_goals",
      "savings_goal_revisions",
      "savings_goal_movements",
      "savings_movement_evidence",
    ];
    const rls = await client.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      "select relname,relrowsecurity,relforcerowsecurity from pg_class where relname=any($1::text[]) order by relname",
      [names],
    );
    expect(rls.rows).toHaveLength(names.length);
    expect(
      rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
    ).toBe(true);
    const deleteGrants = await client.query(
      "select table_name from information_schema.role_table_grants where grantee in ('budgefi_app','budgefi_plaid_worker') and privilege_type='DELETE' and table_name=any($1::text[])",
      [names],
    );
    expect(deleteGrants.rows).toHaveLength(0);

    await client.query("BEGIN");
    try {
      const inserted = await client.query<{ id: string }>(
        "insert into savings_goals(household_id,name,target_amount_minor,contribution_amount_minor,schedule,next_due_on,status,currency,provenance) values('22000000-0000-4000-8000-000000000102','Monthly reserve',100000,10000,'monthly',current_date,'active','USD','manual') returning id",
      );
      const goalId = inserted.rows[0]!.id;
      await client.query(
        "insert into savings_goal_revisions(household_id,savings_goal_id,destination_account_id,destination_prior_planning_role,destination_tracking_started_at,name,target_amount_minor,target_date,contribution_amount_minor,schedule,next_due_on,status,currency,provenance,version,reason) select household_id,id,destination_account_id,destination_prior_planning_role,destination_tracking_started_at,name,target_amount_minor,target_date,contribution_amount_minor,schedule,next_due_on,status,currency,provenance,version,'Test schedule created' from savings_goals where id=$1",
        [goalId],
      );
      const first = await client.query<{ count: number }>(
        "select maintain_savings_goal_occurrences() count",
      );
      expect(first.rows[0]!.count).toBeGreaterThan(0);
      const before = await client.query<{ count: number }>(
        "select count(*)::int count from plan_occurrences where savings_goal_id=$1",
        [goalId],
      );
      await client.query("select maintain_savings_goal_occurrences()");
      const after = await client.query<{ count: number }>(
        "select count(*)::int count from plan_occurrences where savings_goal_id=$1",
        [goalId],
      );
      expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
      const occurrence = await client.query<{
        id: string;
        expected_on: string;
        version: number;
        matched_amount_minor: string;
        source_revision_kind: string;
        source_revision_version: number;
      }>(
        "select id,expected_on::text,version,matched_amount_minor,source_revision_kind,source_revision_version from plan_occurrences where savings_goal_id=$1 order by expected_on limit 1",
        [goalId],
      );
      const skipped = occurrence.rows[0]!;
      expect(skipped).toMatchObject({
        source_revision_kind: "savings",
        source_revision_version: 1,
      });
      await client.query("SAVEPOINT immutable_schedule_revision");
      await expect(
        client.query(
          "update plan_occurrences set source_revision_version=2 where id=$1",
          [skipped.id],
        ),
      ).rejects.toThrow(/immutable/);
      await client.query("ROLLBACK TO SAVEPOINT immutable_schedule_revision");
      await client.query(
        "update plan_occurrences set state='skipped',version=version+1 where id=$1",
        [skipped.id],
      );
      await client.query(
        "insert into plan_occurrence_revisions(household_id,occurrence_id,version,state,matched_amount_minor,reason) values('22000000-0000-4000-8000-000000000102',$1,$2,'skipped',$3,'User marked this occurrence as not due')",
        [skipped.id, skipped.version + 1, skipped.matched_amount_minor],
      );
      await client.query("select maintain_savings_goal_occurrences()");
      const tombstone = await client.query<{ count: number; active: number }>(
        "select count(*)::int count,count(*) filter(where state<>'skipped')::int active from plan_occurrences where savings_goal_id=$1 and expected_on=$2",
        [goalId, skipped.expected_on],
      );
      expect(tombstone.rows[0]).toEqual({ count: 1, active: 0 });
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("forces tenant isolation and append-only debt evidence", async () => {
    const names = [
      "debts",
      "debt_revisions",
      "debt_balance_observations",
      "debt_term_observations",
      "debt_apr_components",
      "debt_payment_policies",
      "debt_payment_policy_revisions",
      "debt_payment_evidence",
      "debt_payment_evidence_reversals",
    ];
    const rls = await client.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      "select relname,relrowsecurity,relforcerowsecurity from pg_class where relname=any($1::text[]) order by relname",
      [names],
    );
    expect(rls.rows).toHaveLength(names.length);
    expect(
      rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
    ).toBe(true);
    const deleteGrants = await client.query(
      "select table_name from information_schema.role_table_grants where grantee in ('budgefi_app','budgefi_plaid_worker') and privilege_type='DELETE' and table_name=any($1::text[])",
      [names],
    );
    expect(deleteGrants.rows).toHaveLength(0);
    const triggers = await client.query<{ count: string }>(
      "select count(*)::text count from pg_trigger where tgrelid in ('debt_revisions'::regclass,'debt_balance_observations'::regclass,'debt_term_observations'::regclass,'debt_apr_components'::regclass,'debt_payment_policy_revisions'::regclass,'debt_payment_evidence'::regclass,'debt_payment_evidence_reversals'::regclass) and tgfoid='reject_append_only_mutation()'::regprocedure and not tgisinternal",
    );
    expect(Number(triggers.rows[0]?.count)).toBe(7);
  });

  it("protects canonical income schedules and enforces one owner per occurrence", async () => {
    const names = ["income_schedules", "income_schedule_revisions"];
    const rls = await client.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      "select relname,relrowsecurity,relforcerowsecurity from pg_class where relname=any($1::text[]) order by relname",
      [names],
    );
    expect(rls.rows).toHaveLength(2);
    expect(
      rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
    ).toBe(true);
    const grants = await client.query(
      "select table_name from information_schema.role_table_grants where grantee in ('budgefi_app','budgefi_plaid_worker') and privilege_type='DELETE' and table_name=any($1::text[])",
      [names],
    );
    expect(grants.rows).toHaveLength(0);
    const trigger = await client.query<{ count: number }>(
      "select count(*)::int count from pg_trigger where tgrelid='income_schedule_revisions'::regclass and not tgisinternal",
    );
    expect(trigger.rows[0]?.count).toBe(1);
    const ownerTrigger = await client.query<{ count: number }>(
      "select count(*)::int count from pg_trigger where tgrelid='income_schedules'::regclass and tgname='income_advancement_owner' and not tgisinternal",
    );
    expect(ownerTrigger.rows[0]?.count).toBe(1);
    await client.query("BEGIN");
    try {
      const schedule = await client.query<{ id: string }>(
        "insert into income_schedules(household_id,name,frequency,next_expected_date,confirmed,status,anchor_day,provenance) values('22000000-0000-4000-8000-000000000102','Second job','biweekly',current_date+7,true,'active',extract(day from current_date+7),'manual') returning id",
      );
      await expect(
        client.query(
          "insert into plan_occurrences(household_id,source_key,kind,name,expected_on,provenance) values('22000000-0000-4000-8000-000000000102','bad-income','income','Unowned',current_date,'manual')",
        ),
      ).rejects.toThrow();
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      const scheduleAgain = await client.query<{ id: string }>(
        "insert into income_schedules(household_id,name,frequency,next_expected_date,confirmed,status,anchor_day,provenance) values('22000000-0000-4000-8000-000000000102','Second job','biweekly',current_date+7,true,'active',extract(day from current_date+7),'manual') returning id",
      );
      await client.query(
        "insert into income_schedule_revisions(household_id,income_schedule_id,destination_account_id,name,expected_amount_minor,frequency,next_expected_date,confirmed,status,anchor_day,anchor_eom,second_anchor_day,second_anchor_eom,review_reason,advanced_from_occurrence_id,previous_expected_date,provenance,version,reason) select household_id,id,destination_account_id,name,expected_amount_minor,frequency,next_expected_date,confirmed,status,anchor_day,anchor_eom,second_anchor_day,second_anchor_eom,review_reason,advanced_from_occurrence_id,previous_expected_date,provenance,version,'Test schedule created' from income_schedules where id=$1",
        [scheduleAgain.rows[0]!.id],
      );
      await client.query(
        "insert into plan_occurrences(household_id,source_key,kind,income_schedule_id,name,expected_on,provenance) values('22000000-0000-4000-8000-000000000102',$1,'income',$2,'Second job',current_date+7,'manual')",
        [
          `income-schedule:${scheduleAgain.rows[0]!.id}`,
          scheduleAgain.rows[0]!.id,
        ],
      );
      const ownedOccurrence = await client.query<{ id: string }>(
        "select id from plan_occurrences where income_schedule_id=$1",
        [scheduleAgain.rows[0]!.id],
      );
      await client.query(
        "update income_schedules set advanced_from_occurrence_id=$1,previous_expected_date=current_date+7,version=version+1 where id=$2",
        [ownedOccurrence.rows[0]!.id, scheduleAgain.rows[0]!.id],
      );
      const advanced = await client.query(
        "select advanced_from_occurrence_id,previous_expected_date from income_schedules where id=$1",
        [scheduleAgain.rows[0]!.id],
      );
      await client.query(
        "insert into income_schedule_revisions(household_id,income_schedule_id,destination_account_id,name,expected_amount_minor,frequency,next_expected_date,confirmed,status,anchor_day,anchor_eom,second_anchor_day,second_anchor_eom,review_reason,advanced_from_occurrence_id,previous_expected_date,provenance,version,reason) select household_id,id,destination_account_id,name,expected_amount_minor,frequency,next_expected_date,confirmed,status,anchor_day,anchor_eom,second_anchor_day,second_anchor_eom,review_reason,advanced_from_occurrence_id,previous_expected_date,provenance,version,'advancement fixture' from income_schedules where id=$1",
        [scheduleAgain.rows[0]!.id],
      );
      const revision = await client.query(
        "select advanced_from_occurrence_id,previous_expected_date from income_schedule_revisions where income_schedule_id=$1 order by version desc limit 1",
        [scheduleAgain.rows[0]!.id],
      );
      expect(revision.rows[0]).toEqual(advanced.rows[0]);
      const unrelated = await client.query<{ id: string }>(
        "insert into income_schedules(household_id,name,frequency,next_expected_date,confirmed,status,anchor_day,provenance) values('22000000-0000-4000-8000-000000000102','Unrelated','weekly',current_date+8,true,'active',extract(day from current_date+8),'manual') returning id",
      );
      await client.query("SAVEPOINT wrong_income_lineage");
      await expect(
        client.query(
          "update income_schedules set advanced_from_occurrence_id=$1,previous_expected_date=current_date+8 where id=$2",
          [ownedOccurrence.rows[0]!.id, unrelated.rows[0]!.id],
        ),
      ).rejects.toThrow(/owned by this schedule/);
      await client.query("ROLLBACK TO SAVEPOINT wrong_income_lineage");
      const earliest = await client.query<{
        horizon: string;
        expected: string;
      }>(
        "select canonical_income_horizon_end('22000000-0000-4000-8000-000000000102',current_date,14)::text horizon,(current_date+7)::text expected",
      );
      expect(earliest.rows[0]?.horizon).toBe(earliest.rows[0]?.expected);
      await client.query(
        "insert into income_schedules(household_id,name,frequency,next_expected_date,confirmed,status,anchor_day,provenance) values('22000000-0000-4000-8000-000000000102','Missed job','weekly',current_date-1,true,'active',extract(day from current_date-1),'manual')",
      );
      const conservative = await client.query<{
        horizon: string;
        expected: string;
      }>(
        "select canonical_income_horizon_end('22000000-0000-4000-8000-000000000102',current_date,14)::text horizon,(current_date+14)::text expected",
      );
      expect(conservative.rows[0]?.horizon).toBe(
        conservative.rows[0]?.expected,
      );
      await client.query("SAVEPOINT colliding_anchors");
      await expect(
        client.query(
          "insert into income_schedules(household_id,name,frequency,next_expected_date,confirmed,status,anchor_day,second_anchor_day,provenance) values('22000000-0000-4000-8000-000000000102','Colliding pay','semi_monthly',current_date+7,true,'active',29,30,'manual')",
        ),
      ).rejects.toThrow();
      await client.query("ROLLBACK TO SAVEPOINT colliding_anchors");
      expect(schedule.rows[0]?.id).toBeTruthy();
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("forces tenant isolation and append-only pay-cycle history", async () => {
    const names = [
      "account_planning_role_revisions",
      "planning_periods",
      "planning_period_revisions",
      "income_boundaries",
      "income_boundary_revisions",
      "income_boundary_evidence",
      "pay_cycles",
      "pay_cycle_report_revisions",
      "pay_cycle_report_inputs",
      "pay_cycle_account_coverage",
    ];
    const rls = await client.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      "select relname,relrowsecurity,relforcerowsecurity from pg_class where relname=any($1::text[]) order by relname",
      [names],
    );
    expect(rls.rows).toHaveLength(names.length);
    expect(
      rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
    ).toBe(true);
    const deletes = await client.query(
      "select table_name from information_schema.role_table_grants where grantee in ('budgefi_app','budgefi_plaid_worker','budgefi_worker') and privilege_type='DELETE' and table_name=any($1::text[])",
      [names],
    );
    expect(deletes.rows).toHaveLength(0);
    const appendOnly = await client.query<{ count: number }>(
      "select count(*)::int count from pg_trigger where tgname like '%append_only' and tgrelid in (select oid from pg_class where relname=any($1::text[])) and not tgisinternal",
      [names],
    );
    expect(appendOnly.rows[0]?.count).toBe(10);
    const ownerValidation = await client.query<{ count: number }>(
      "select count(*)::int count from pg_trigger where tgrelid='pay_cycle_report_inputs'::regclass and tgname='pay_cycle_report_input_owner' and not tgisinternal",
    );
    expect(ownerValidation.rows[0]?.count).toBe(1);
    const reportLocks = await client.query<{ count: number }>(
      "select count(*)::int count from pg_trigger where tgname='pay_cycle_household_lock' and not tgisinternal",
    );
    expect(reportLocks.rows[0]?.count).toBe(12);
    const accountHistoryTrigger = await client.query<{ definition: string }>(
      "select pg_get_triggerdef(oid) definition from pg_trigger where tgname='account_planning_role_history' and not tgisinternal",
    );
    expect(accountHistoryTrigger.rows[0]?.definition).toContain("account_type");
    await client.query("BEGIN");
    try {
      const beforeType = await client.query<{ version: number }>(
        "select max(version)::int version from account_planning_role_revisions where household_id='22000000-0000-4000-8000-000000000102' and account_id='22000000-0000-4000-8000-000000000202'",
      );
      await client.query(
        "update accounts set account_type='savings' where household_id='22000000-0000-4000-8000-000000000102' and id='22000000-0000-4000-8000-000000000202'",
      );
      const afterType = await client.query<{
        version: number;
        account_type: string;
      }>(
        "select version,account_type from account_planning_role_revisions where household_id='22000000-0000-4000-8000-000000000102' and account_id='22000000-0000-4000-8000-000000000202' order by version desc limit 1",
      );
      expect(afterType.rows[0]).toEqual({
        version: beforeType.rows[0]!.version + 1,
        account_type: "savings",
      });
    } finally {
      await client.query("ROLLBACK");
    }
    const snapshots = await client.query<{ is_nullable: string }>(
      "select is_nullable from information_schema.columns where table_name='pay_cycle_report_inputs' and column_name='input_snapshot'",
    );
    expect(snapshots.rows[0]?.is_nullable).toBe("NO");
  });

  it("serializes scheduled materialization with interactive planning changes", async () => {
    const blocker = new pg.Client({ connectionString: databaseUrl });
    const worker = new pg.Client({ connectionString: databaseUrl });
    await blocker.connect();
    await worker.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "select pg_advisory_xact_lock(hashtextextended('22000000-0000-4000-8000-000000000102',7241))",
      );
      await worker.query("set statement_timeout='150ms'");
      await expect(
        worker.query("select maintain_savings_goal_occurrences()"),
      ).rejects.toThrow(/statement timeout|canceling statement/);
      await blocker.query("ROLLBACK");
      await worker.query("set statement_timeout=0");
      await expect(
        worker.query("select maintain_savings_goal_occurrences() count"),
      ).resolves.toBeTruthy();
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
      await worker.end();
    }
  });

  it("backfills a five-figure ledger atomically and serves a bounded indexed page", async () => {
    const backfilled = await client.query<{ count: number }>(
      "select count(*)::int count from transaction_entities where household_id='22000000-0000-4000-8000-000000000102'",
    );
    expect(backfilled.rows[0]?.count).toBe(10001);
    await client.query(
      "analyze transaction_entities,financial_transactions,accounts,transaction_category_assignments",
    );
    await client.query("set enable_seqscan=off");
    const explained = await client.query<{ "QUERY PLAN": unknown }>(
      "explain (format json) select e.id,f.merchant from transaction_entities e join financial_transactions f on f.id=e.current_transaction_id and f.household_id=e.household_id join accounts a on a.id=e.account_id and a.household_id=e.household_id join transaction_category_assignments c on c.transaction_id=e.id and c.household_id=e.household_id where e.household_id='22000000-0000-4000-8000-000000000102' and e.current_transaction_id is not null and f.source_kind<>'sample' order by e.current_occurred_on desc,e.id desc limit 31",
    );
    const plan = JSON.stringify(explained.rows[0]?.["QUERY PLAN"]);
    expect(plan).toContain("transaction_entities_feed_idx");
    expect(plan).not.toContain("WindowAgg");
    const start = performance.now();
    const page = await client.query(
      "select e.id from transaction_entities e join financial_transactions f on f.id=e.current_transaction_id and f.household_id=e.household_id join transaction_category_assignments c on c.transaction_id=e.id and c.household_id=e.household_id where e.household_id='22000000-0000-4000-8000-000000000102' and e.current_transaction_id is not null order by e.current_occurred_on desc,e.id desc limit 31",
    );
    expect(page.rows).toHaveLength(31);
    expect(performance.now() - start).toBeLessThan(1_000);
    const reconciliationExplain = await client.query<{ "QUERY PLAN": unknown }>(
      "explain (format json) select evidence.id from transaction_entities entity join financial_transactions evidence on evidence.household_id=entity.household_id and evidence.id=entity.current_transaction_id join accounts account on account.household_id=entity.household_id and account.id=entity.account_id where entity.household_id='22000000-0000-4000-8000-000000000102' and entity.current_transaction_id is not null and entity.current_occurred_on between '2026-08-25' and '2026-09-08' and evidence.source_kind='plaid' and evidence.status='posted' and account.archived_at is null and account.include_in_plan=true and account.account_type in ('cash','checking','savings') and evidence.direction='debit'",
    );
    const reconciliationPlan = JSON.stringify(
      reconciliationExplain.rows[0]?.["QUERY PLAN"],
    );
    expect(reconciliationPlan).toContain("transaction_entities_feed_idx");
    expect(reconciliationPlan).not.toContain("WindowAgg");
    const reconciliationStart = performance.now();
    await client.query(
      "select evidence.id from transaction_entities entity join financial_transactions evidence on evidence.household_id=entity.household_id and evidence.id=entity.current_transaction_id join accounts account on account.household_id=entity.household_id and account.id=entity.account_id where entity.household_id='22000000-0000-4000-8000-000000000102' and entity.current_transaction_id is not null and entity.current_occurred_on between '2026-08-25' and '2026-09-08' and evidence.source_kind='plaid' and evidence.status='posted' and account.archived_at is null and account.include_in_plan=true and account.account_type in ('cash','checking','savings') and evidence.direction='debit'",
    );
    expect(performance.now() - reconciliationStart).toBeLessThan(1_000);
    await client.query("reset enable_seqscan");
  });

  it("keeps legacy direct-ingestion aliases, versions, and current evidence coherent", async () => {
    const household = "22000000-0000-4000-8000-000000000102";
    const account = "22000000-0000-4000-8000-000000000202";
    await client.query(
      "insert into financial_transactions(household_id,account_id,source_kind,source_record_id,revision,merchant,amount_minor,currency,occurred_on,status,direction) values($1,$2,'csv','legacy-pending',1,'Legacy Coffee','500','USD','2026-08-30','pending','debit')",
      [household, account],
    );
    await client.query(
      "insert into financial_transactions(household_id,account_id,source_kind,source_record_id,revision,merchant,amount_minor,currency,occurred_on,status,direction,pending_source_record_id) values($1,$2,'csv','legacy-posted',1,'Legacy Coffee','500','USD','2026-08-30','posted','debit','legacy-pending')",
      [household, account],
    );
    await client.query(
      "insert into financial_transactions(household_id,account_id,source_kind,source_record_id,revision,merchant,amount_minor,currency,occurred_on,status,direction) values($1,$2,'csv','legacy-pending',2,'Legacy Coffee','500','USD','2026-08-30','removed','debit')",
      [household, account],
    );
    const lifecycle = await client.query<{
      version: number;
      current_status: string;
      aliases: number;
    }>(
      `select e.version,current.status current_status,count(a.*)::int aliases
       from transaction_entities e join financial_transactions current on current.id=e.current_transaction_id and current.household_id=e.household_id join transaction_source_aliases a
         on a.household_id=e.household_id and a.transaction_id=e.id
       where e.household_id=$1 and a.source_record_id in ('legacy-pending','legacy-posted')
       group by e.id,current.status`,
      [household],
    );
    expect(lifecycle.rows).toEqual([
      { version: 3, current_status: "posted", aliases: 2 },
    ]);
  });

  it("rejects invalid categories at rule and revision history boundaries", async () => {
    await expect(
      client.query(
        "insert into merchant_category_rules(household_id,normalized_merchant,category,actor_user_id) values('22000000-0000-4000-8000-000000000102','bad rule','not_a_category','22000000-0000-4000-8000-000000000002')",
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const entity = await client.query<{ id: string }>(
      "select id from transaction_entities where household_id='22000000-0000-4000-8000-000000000102' limit 1",
    );
    await expect(
      client.query(
        "insert into transaction_category_revisions(household_id,transaction_id,category,source,confidence,version,reason) values('22000000-0000-4000-8000-000000000102',$1,'not_a_category','user','high',999999,'invalid fixture')",
        [entity.rows[0]!.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("prevents transaction evidence and aliases from crossing account boundaries", async () => {
    const household = "22000000-0000-4000-8000-000000000102";
    const accountA = "22000000-0000-4000-8000-000000000202";
    const accountB = "24000000-0000-4000-8000-000000000202";
    const entityA = "24000000-0000-4000-8000-000000000301";
    const entityB = "24000000-0000-4000-8000-000000000302";
    const evidenceA = "24000000-0000-4000-8000-000000000401";
    const evidenceB = "24000000-0000-4000-8000-000000000402";
    await client.query("BEGIN");
    try {
      await client.query(
        "insert into accounts(id,household_id,name,account_type,currency,provenance,include_in_plan) values($1,$2,'Second checking','checking','USD','manual',true)",
        [accountB, household],
      );
      await client.query(
        "insert into transaction_entities(id,household_id,account_id) values($1,$3,$2),($4,$3,$5)",
        [entityA, accountA, household, entityB, accountB],
      );
      await client.query(
        "insert into transaction_source_aliases(household_id,transaction_id,account_id,source_kind,source_record_id) values($1,$2,$3,'manual','account-a')",
        [household, entityA, accountA],
      );
      await client.query(
        "insert into financial_transactions(id,household_id,account_id,transaction_id,source_kind,source_record_id,merchant,amount_minor,currency,occurred_on,status,direction) values($1,$2,$3,$4,'manual','account-a','Account A',100,'USD','2026-09-01','posted','debit'),($5,$2,$6,$7,'manual','account-b','Account B',200,'USD','2026-09-01','posted','debit')",
        [evidenceA, household, accountA, entityA, evidenceB, accountB, entityB],
      );
      await client.query("SAVEPOINT wrong_alias");
      await expect(
        client.query(
          "insert into transaction_source_aliases(household_id,transaction_id,account_id,source_kind,source_record_id) values($1,$2,$3,'manual','wrong-account')",
          [household, entityA, accountB],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await client.query("ROLLBACK TO SAVEPOINT wrong_alias");
      await client.query("SAVEPOINT wrong_evidence");
      await expect(
        client.query(
          "insert into financial_transactions(household_id,account_id,transaction_id,source_kind,source_record_id,merchant,amount_minor,currency,occurred_on,status,direction) values($1,$2,$3,'manual','wrong-evidence','Wrong account',100,'USD','2026-09-01','posted','debit')",
          [household, accountB, entityA],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await client.query("ROLLBACK TO SAVEPOINT wrong_evidence");
      await client.query("SAVEPOINT wrong_pointer");
      await client.query(
        "update transaction_entities set current_transaction_id=$1,current_occurred_on='2026-09-01' where id=$2",
        [evidenceB, entityA],
      );
      await expect(
        client.query(
          "set constraints transaction_entities_current_evidence_fk immediate",
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await client.query("ROLLBACK TO SAVEPOINT wrong_pointer");
    } finally {
      await client.query("ROLLBACK");
    }
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
      }>(
        "select * from ingest_verified_clerk_user_deleted('msg_identity_fixture','user_identity_fixture')",
      );
      expect(first.rows[0]).toEqual({
        known: true,
        duplicate: false,
        queued_deletions: 1,
      });
      const duplicate = await client.query<{
        known: boolean;
        duplicate: boolean;
        queued_deletions: number;
      }>(
        "select * from ingest_verified_clerk_user_deleted('msg_identity_fixture','user_identity_fixture')",
      );
      expect(duplicate.rows[0]).toEqual({
        known: true,
        duplicate: true,
        queued_deletions: 1,
      });
      const unknown = await client.query<{
        known: boolean;
        duplicate: boolean;
        queued_deletions: number;
      }>(
        "select * from ingest_verified_clerk_user_deleted('msg_unknown_identity','user_unknown_identity')",
      );
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
      }>(
        "select clerk_user_id_hash,processing_status from clerk_webhook_receipts order by event_id",
      );
      expect(receipts.rows).toHaveLength(2);
      expect(
        receipts.rows.every((row) =>
          /^[a-f0-9]{64}$/.test(row.clerk_user_id_hash),
        ),
      ).toBe(true);
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
      }>(
        "select * from ingest_verified_clerk_user_deleted('msg_multi_household','user_multi_household')",
      );
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
      const first = await client.query<{
        request_id: string;
        household_id: string;
      }>(
        "select request_id::text,household_id::text from claim_account_deletion()",
      );
      expect(first.rows[0]?.household_id).toBe(
        "23100000-0000-4000-8000-000000000101",
      );
      await client.query("select finalize_account_deletion($1)", [
        first.rows[0]?.request_id,
      ]);
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
      const second = await client.query<{
        request_id: string;
        household_id: string;
      }>(
        "select request_id::text,household_id::text from claim_account_deletion()",
      );
      expect(second.rows[0]?.household_id).toBe(
        "23100000-0000-4000-8000-000000000102",
      );
      await client.query("select finalize_account_deletion($1)", [
        second.rows[0]?.request_id,
      ]);
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
    expect(
      (
        await client.query<{
          can_select: boolean;
          can_insert: boolean;
          can_update: boolean;
        }>(`select
          has_column_privilege('budgefi_app','accounts','provider_account_fingerprint','SELECT') as can_select,
          has_column_privilege('budgefi_app','accounts','provider_account_fingerprint','INSERT') as can_insert,
          has_column_privilege('budgefi_app','accounts','provider_account_fingerprint','UPDATE') as can_update`)
      ).rows[0],
    ).toEqual({ can_select: true, can_insert: true, can_update: true });
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
        (
          await client.query(
            "SELECT count(*) FROM plan_revisions WHERE household_id='00000000-0000-4000-8000-000000000101'",
          )
        ).rows[0]?.count,
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
        "INSERT INTO notification_events (id,household_id,user_id,event_type,title,body,dedupe_key,preference_revision,timezone_snapshot) SELECT '00000000-0000-4000-8000-000000000902',household_id,user_id,'test','Generic title','Generic body','fixture-test',version,timezone FROM notification_preferences WHERE household_id='00000000-0000-4000-8000-000000000101' AND user_id='00000000-0000-4000-8000-000000000001'",
      );
      await client.query(
        "INSERT INTO notification_deliveries (id,household_id,user_id,event_id,endpoint_id,channel) VALUES ('00000000-0000-4000-8000-000000000903','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000902','00000000-0000-4000-8000-000000000901','push')",
      );
      await client.query("SET LOCAL ROLE budgefi_worker");
      const claimed = await client.query<{
        delivery_id: string;
        lease_token: string;
        attempts: number;
      }>(
        "SELECT delivery_id,lease_token,attempts FROM claim_notification_delivery()",
      );
      expect(claimed.rows[0]?.delivery_id).toBe(
        "00000000-0000-4000-8000-000000000903",
      );
      expect(claimed.rows[0]?.attempts).toBe(1);
      expect(claimed.rows[0]?.lease_token).toMatch(/^[0-9a-f-]{36}$/);
      const staleFinish = await client.query<{ finished: boolean }>(
        "SELECT finish_notification_delivery('00000000-0000-4000-8000-000000000903','00000000-0000-4000-8000-000000000999','sent',null) finished",
      );
      expect(staleFinish.rows[0]?.finished).toBe(false);
      await client.query(
        "SELECT finish_notification_delivery('00000000-0000-4000-8000-000000000903',$1,'sent',null)",
        [claimed.rows[0]!.lease_token],
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
      await client.query(
        "INSERT INTO financial_transactions(household_id,account_id,source_kind,source_record_id,merchant,amount_minor,currency,direction,occurred_on,status) SELECT '00000000-0000-4000-8000-000000000101',id,'manual','deletion-fixture','Deletion fixture',1000,'USD','debit',current_date,'posted' FROM accounts WHERE household_id='00000000-0000-4000-8000-000000000101' LIMIT 1",
      );
      await client.query(
        "INSERT INTO merchant_category_rules(household_id,normalized_merchant,category,actor_user_id) VALUES('00000000-0000-4000-8000-000000000101','deletion fixture','groceries','00000000-0000-4000-8000-000000000001')",
      );
      await client.query(
        "INSERT INTO savings_goals(id,household_id,name,target_amount_minor,contribution_amount_minor,schedule,status,currency,provenance) VALUES('00000000-0000-4000-8000-000000000914','00000000-0000-4000-8000-000000000101','Deletion goal',100000,5000,'planning_period','active','USD','manual')",
      );
      await client.query(
        "INSERT INTO savings_goal_revisions(household_id,savings_goal_id,name,target_amount_minor,contribution_amount_minor,schedule,status,currency,provenance,version,reason) VALUES('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000914','Deletion goal',100000,5000,'planning_period','active','USD','manual',1,'Deletion fixture')",
      );
      await client.query(
        "INSERT INTO savings_goal_movements(id,household_id,savings_goal_id,kind,amount_minor,effective_on,verification_method,provenance) VALUES('00000000-0000-4000-8000-000000000915','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000914','opening_allocation',2500,current_date,'user_confirmed','manual')",
      );
      await client.query(
        "INSERT INTO income_schedules(id,household_id,name,frequency,next_expected_date,confirmed,status,anchor_day,provenance) VALUES('00000000-0000-4000-8000-000000000916','00000000-0000-4000-8000-000000000101','Deletion income','monthly',current_date+7,true,'active',extract(day from current_date+7),'manual')",
      );
      await client.query(
        "INSERT INTO income_schedule_revisions(household_id,income_schedule_id,name,frequency,next_expected_date,confirmed,status,anchor_day,anchor_eom,second_anchor_day,second_anchor_eom,provenance,version,reason) VALUES('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000916','Deletion income','monthly',current_date+7,true,'active',extract(day from current_date+7),false,null,false,'manual',1,'Deletion fixture')",
      );
      await client.query(
        "INSERT INTO planning_periods(id,household_id,start_on,end_on,timezone_snapshot,boundary_basis,driving_income_schedule_id,policy_version,input_fingerprint) VALUES('00000000-0000-4000-8000-000000000917','00000000-0000-4000-8000-000000000101',current_date,current_date+8,'America/New_York','expected_income','00000000-0000-4000-8000-000000000916','test-v1','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')",
      );
      await client.query(
        "INSERT INTO planning_period_revisions(household_id,planning_period_id,version,state,reason) VALUES('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000917',1,'active','initial')",
      );
      await client.query(
        `insert into starter_template_applications(id,household_id,user_id,template_key,template_version,request_id,plan_version)
         values('00000000-0000-4000-8000-000000000918','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001','common_bills',1,'00000000-0000-4000-8000-000000000919',$1)`,
        [plan.version],
      );
      await client.query(
        `insert into starter_template_application_items(household_id,application_id,item_key,commitment_id,commitment_version,name_snapshot)
         select household_id,'00000000-0000-4000-8000-000000000918','housing',id,version,name from commitments
         where household_id='00000000-0000-4000-8000-000000000101' limit 1`,
      );

      const before = await client.query<{
        snapshots: string;
        inputs: string;
        activity: string;
        plan_revisions: string;
        commitment_revisions: string;
        transaction_entities: string;
        transaction_categories: string;
        transaction_category_revisions: string;
      }>(
        "SELECT (SELECT count(*) FROM calculation_snapshots WHERE household_id='00000000-0000-4000-8000-000000000101') snapshots,(SELECT count(*) FROM calculation_snapshot_inputs WHERE household_id='00000000-0000-4000-8000-000000000101') inputs,(SELECT count(*) FROM activity_events WHERE household_id='00000000-0000-4000-8000-000000000101') activity,(SELECT count(*) FROM plan_revisions WHERE household_id='00000000-0000-4000-8000-000000000101') plan_revisions,(SELECT count(*) FROM commitment_revisions WHERE household_id='00000000-0000-4000-8000-000000000101') commitment_revisions,(SELECT count(*) FROM transaction_entities WHERE household_id='00000000-0000-4000-8000-000000000101') transaction_entities,(SELECT count(*) FROM transaction_category_assignments WHERE household_id='00000000-0000-4000-8000-000000000101') transaction_categories,(SELECT count(*) FROM transaction_category_revisions WHERE household_id='00000000-0000-4000-8000-000000000101') transaction_category_revisions",
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
              "SELECT count(*) FROM planning_periods WHERE household_id='00000000-0000-4000-8000-000000000101'",
            )
          ).rows[0]?.count,
        ),
      ).toBe(0);
      expect(
        Number(
          (
            await client.query(
              "SELECT count(*) FROM starter_template_applications WHERE household_id='00000000-0000-4000-8000-000000000101'",
            )
          ).rows[0]?.count,
        ),
      ).toBe(0);
      const transactionHistory = await client.query<{
        entities: string;
        aliases: string;
        categories: string;
        revisions: string;
        rules: string;
      }>(
        "SELECT (SELECT count(*) FROM transaction_entities WHERE household_id='00000000-0000-4000-8000-000000000101') entities,(SELECT count(*) FROM transaction_source_aliases WHERE household_id='00000000-0000-4000-8000-000000000101') aliases,(SELECT count(*) FROM transaction_category_assignments WHERE household_id='00000000-0000-4000-8000-000000000101') categories,(SELECT count(*) FROM transaction_category_revisions WHERE household_id='00000000-0000-4000-8000-000000000101') revisions,(SELECT count(*) FROM merchant_category_rules WHERE household_id='00000000-0000-4000-8000-000000000101') rules",
      );
      expect(
        Object.values(transactionHistory.rows[0]!).every(
          (count) => Number(count) === 0,
        ),
      ).toBe(true);
      const savingsHistory = await client.query(
        "SELECT (SELECT count(*) FROM savings_goals WHERE household_id='00000000-0000-4000-8000-000000000101') goals,(SELECT count(*) FROM savings_goal_revisions WHERE household_id='00000000-0000-4000-8000-000000000101') revisions,(SELECT count(*) FROM savings_goal_movements WHERE household_id='00000000-0000-4000-8000-000000000101') movements,(SELECT count(*) FROM savings_movement_evidence WHERE household_id='00000000-0000-4000-8000-000000000101') evidence",
      );
      expect(
        Object.values(savingsHistory.rows[0]!).every(
          (count) => Number(count) === 0,
        ),
      ).toBe(true);
      const incomeHistory = await client.query(
        "SELECT (SELECT count(*) FROM income_schedules WHERE household_id='00000000-0000-4000-8000-000000000101') schedules,(SELECT count(*) FROM income_schedule_revisions WHERE household_id='00000000-0000-4000-8000-000000000101') revisions",
      );
      expect(
        Object.values(incomeHistory.rows[0]!).every(
          (count) => Number(count) === 0,
        ),
      ).toBe(true);
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
      await client.query(
        "INSERT INTO merchant_category_rules(household_id,normalized_merchant,category,actor_user_id) VALUES('00000000-0000-4000-8000-000000000101','shared fixture','groceries','00000000-0000-4000-8000-000000000012')",
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
        `insert into starter_template_applications(id,household_id,user_id,template_key,template_version,request_id,plan_version)
         select '00000000-0000-4000-8000-000000000920',household_id,'00000000-0000-4000-8000-000000000001','common_bills',1,
           '00000000-0000-4000-8000-000000000921',version from plans where household_id='00000000-0000-4000-8000-000000000101'`,
      );
      await client.query(
        `insert into starter_template_application_items(household_id,application_id,item_key,commitment_id,commitment_version,name_snapshot)
         select household_id,'00000000-0000-4000-8000-000000000920','housing',id,version,name from commitments
         where household_id='00000000-0000-4000-8000-000000000101' limit 1`,
      );
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
        Number(
          (
            await client.query(
              "SELECT count(*) FROM starter_template_applications WHERE user_id='00000000-0000-4000-8000-000000000001'",
            )
          ).rows[0]?.count,
        ),
      ).toBe(0);
      expect(
        (
          await client.query(
            "SELECT revoked_at IS NULL AS active FROM household_memberships WHERE household_id='00000000-0000-4000-8000-000000000101' AND user_id='00000000-0000-4000-8000-000000000012'",
          )
        ).rows[0]?.active,
      ).toBe(true);
      expect(
        Number(
          (
            await client.query(
              "SELECT count(*) FROM merchant_category_rules WHERE household_id='00000000-0000-4000-8000-000000000101' AND normalized_merchant='shared fixture'",
            )
          ).rows[0]?.count,
        ),
      ).toBe(1);
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

  it("keeps available-cash alerts crossing-based and enforces manual freshness", async () => {
    await client.query("BEGIN");
    try {
      const household = "00000000-0000-4000-8000-000000000101";
      const user = "00000000-0000-4000-8000-000000000001";
      await client.query(
        "SELECT set_config('app.user_id',$1,true),set_config('app.household_id',$2,true)",
        [user, household],
      );
      await client.query(
        `insert into notification_preferences(household_id,user_id,available_cash_alerts,available_cash_threshold_minor,
           email_address,email_verified_at,email_enabled)
         values($1,$2,true,50000,'alerts@example.com',now(),true) on conflict(household_id,user_id) do update
         set available_cash_alerts=true,available_cash_threshold_minor=50000,email_address='alerts@example.com',email_verified_at=now(),email_enabled=true`,
        [household, user],
      );
      const insertSnapshot = async (
        available: number,
        fingerprint: string,
        calculatedAt: string,
        freshness: "current" | "manual",
        freshnessAsOf: string,
      ) =>
        client.query<{ id: string }>(
          `insert into calculation_snapshots(household_id,plan_id,plan_version,known_cash_minor,commitments_minor,
             planned_savings_minor,safety_buffer_minor,available_minor,currency,policy_version,input_fingerprint,
             calculated_at,horizon_start,horizon_end,freshness_status,freshness_as_of)
           select $1,id,version,$2,0,0,0,$2,'USD','test',$3,$4,'2026-09-01','2026-09-14',$5,$6
           from plans where household_id=$1 returning id`,
          [household, available, fingerprint, calculatedAt, freshness, freshnessAsOf],
        ).then((result) => result.rows[0]!.id);

      const first = await insertSnapshot(40000, "alert-first", "2026-09-02T12:00:00Z", "current", "2026-09-02T12:00:00Z");
      const firstEpisode = (await client.query<{ id: string }>(
        "select evaluate_available_cash_alert($1,true,'2026-09-02T12:00:00Z') id", [first],
      )).rows[0]!.id;
      expect(firstEpisode).toBeTruthy();
      expect((await client.query<{ id: string }>(
        "select evaluate_available_cash_alert($1,true,'2026-09-02T12:00:01Z') id", [first],
      )).rows[0]!.id).toBe(firstEpisode);
      expect(Number((await client.query(
        "select count(*) count from available_cash_alert_episodes where household_id=$1", [household],
      )).rows[0]!.count)).toBe(1);

      const recovered = await insertSnapshot(51000, "alert-recovered", "2026-09-02T12:01:00Z", "current", "2026-09-02T12:01:00Z");
      await client.query("select evaluate_available_cash_alert($1,true,'2026-09-02T12:01:00Z')", [recovered]);
      expect((await client.query("select armed from available_cash_alert_states where household_id=$1 and user_id=$2", [household, user])).rows[0]!.armed).toBe(false);
      const suppressed = await insertSnapshot(40000, "alert-suppressed", "2026-09-02T12:02:00Z", "current", "2026-09-02T12:02:00Z");
      expect((await client.query("select evaluate_available_cash_alert($1,true,'2026-09-02T12:02:00Z') id", [suppressed])).rows[0]!.id).toBeNull();
      const rearmed = await insertSnapshot(56000, "alert-rearmed", "2026-09-02T12:03:00Z", "current", "2026-09-02T12:03:00Z");
      await client.query("select evaluate_available_cash_alert($1,true,'2026-09-02T12:03:00Z')", [rearmed]);
      expect((await client.query("select armed from available_cash_alert_states where household_id=$1 and user_id=$2", [household, user])).rows[0]!.armed).toBe(true);
      const second = await insertSnapshot(39000, "alert-second", "2026-09-02T12:04:00Z", "current", "2026-09-02T12:04:00Z");
      expect((await client.query("select evaluate_available_cash_alert($1,true,'2026-09-02T12:04:00Z') id", [second])).rows[0]!.id).not.toBe(firstEpisode);
      await client.query("update available_cash_alert_episodes set notify_eligible_at='2026-09-02T12:04:00Z' where status='open' and household_id=$1", [household]);
      await client.query("SET LOCAL ROLE budgefi_worker");
      expect(Number((await client.query("select generate_available_cash_events($1,'2026-09-02T12:04:01Z') count", [household])).rows[0]!.count)).toBe(1);
      await client.query("RESET ROLE");
      expect((await client.query("select state from notification_deliveries where household_id=$1", [household])).rows[0]!.state).toBe("queued");
      await client.query(
        `insert into calculation_snapshots(household_id,plan_id,plan_version,known_cash_minor,commitments_minor,
           planned_savings_minor,safety_buffer_minor,available_minor,currency,policy_version,input_fingerprint,
           calculated_at,horizon_start,horizon_end,freshness_status,freshness_as_of)
         select $1,id,version,39000,0,0,0,39000,'USD','test','alert-aged-before-claim',now()+interval '1 hour',
           current_date,current_date+14,'manual',now()-interval '8 days' from plans where household_id=$1`,
        [household],
      );
      await client.query("SET LOCAL ROLE budgefi_worker");
      expect((await client.query("select * from claim_notification_delivery()")).rowCount).toBe(0);
      await client.query("RESET ROLE");
      expect((await client.query("select state from notification_deliveries where household_id=$1", [household])).rows[0]!.state).toBe("suppressed");

      const boundary = await insertSnapshot(38000, "alert-manual-boundary", "2026-09-09T12:04:00Z", "manual", "2026-09-02T12:04:00Z");
      await client.query("select evaluate_available_cash_alert($1,true,'2026-09-09T12:04:00Z')", [boundary]);
      expect((await client.query("select current_status from available_cash_alert_states where household_id=$1 and user_id=$2", [household, user])).rows[0]!.current_status).toBe("below");
      const stale = await insertSnapshot(37000, "alert-manual-stale", "2026-09-09T12:05:01Z", "manual", "2026-09-02T12:04:00Z");
      await client.query("select evaluate_available_cash_alert($1,true,'2026-09-09T12:05:01Z')", [stale]);
      expect((await client.query("select current_status from available_cash_alert_states where household_id=$1 and user_id=$2", [household, user])).rows[0]!.current_status).toBe("unavailable");
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
