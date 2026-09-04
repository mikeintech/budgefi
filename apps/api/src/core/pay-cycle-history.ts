import { createHash } from "node:crypto";
import { sql, type Transaction } from "kysely";
import {
  calculatePayCycleReport,
  type PayCycleOccurrence,
  type PayCycleTransaction,
  type VerifiedMovement,
  type DebtPayment,
  type IncomeReceipt,
} from "../../../../packages/domain/src/index.js";
import {
  payCycleDetailResponseSchema,
  payCycleListResponseSchema,
  type BootstrapResponse,
  type PayCycleDetailResponse,
  type PayCycleListResponse,
  type PayCycleQuery,
} from "../../../../packages/contracts/src/index.js";
import type { Database } from "../../../../packages/database/src/index.js";
import type { Principal } from "../database/tenant-database.js";

const ALGORITHM_VERSION = "pay-cycle-v1";

export async function refreshPayCycleHistory(
  db: Transaction<Database>,
  principal: Principal,
  view: BootstrapResponse,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${principal.householdId},7241))`.execute(
    db,
  );
  await recordPlanningPeriod(db, principal, view);
  await refreshIncomeBoundaries(db, principal, view);
  const cycles = await ensureCanonicalCycles(db, principal, view);
  const eventCutoff = await transactionCutoff(db);
  // Keep normal mutations bounded. Older cycles are refreshed on demand when
  // their detail is opened, while the most recent two years stay warm.
  for (const cycle of cycles.slice(-24))
    await materializeReport(db, principal, cycle, view, eventCutoff);
}

export async function refreshPayCycleDetail(
  db: Transaction<Database>,
  principal: Principal,
  view: BootstrapResponse,
  cycleId: string,
) {
  await sql`select pg_advisory_xact_lock(hashtextextended(${principal.householdId},7241))`.execute(
    db,
  );
  const row = (await canonicalCycleRows(db, principal, 1, null, cycleId))[0];
  if (!row) return;
  const cycle = await db
    .selectFrom("pay_cycles")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .where("id", "=", cycleId)
    .executeTakeFirstOrThrow();
  await materializeReport(
    db,
    principal,
    cycle,
    view,
    await transactionCutoff(db),
  );
}

async function recordPlanningPeriod(
  db: Transaction<Database>,
  principal: Principal,
  view: BootstrapResponse,
) {
  const endExclusive = addDays(view.plan.horizonEnd, 1);
  const fingerprint = hashJson({
    startOn: view.plan.horizonStart,
    endOn: endExclusive,
    basis: view.plan.horizonBasis,
    scheduleId: view.plan.horizonIncomeScheduleId,
    policyVersion: view.plan.policyVersion,
  });
  const occurrence = view.plan.horizonIncomeScheduleId
    ? view.plan.occurrences.find(
        (item) =>
          item.kind === "income" &&
          item.incomeScheduleId === view.plan.horizonIncomeScheduleId &&
          item.expectedOn === view.plan.horizonEnd,
      )
    : null;
  const inserted = await db
    .insertInto("planning_periods")
    .values({
      household_id: principal.householdId,
      start_on: view.plan.horizonStart,
      end_on: endExclusive,
      timezone_snapshot: await householdTimezone(db, principal),
      boundary_basis: view.plan.horizonBasis,
      driving_income_schedule_id: view.plan.horizonIncomeScheduleId,
      driving_expected_occurrence_id: occurrence?.id ?? null,
      policy_version: view.plan.policyVersion,
      input_fingerprint: fingerprint,
    })
    .onConflict((conflict) =>
      conflict.columns(["household_id", "input_fingerprint"]).doNothing(),
    )
    .returning("id")
    .executeTakeFirst();
  const period =
    inserted ??
    (await db
      .selectFrom("planning_periods")
      .select("id")
      .where("household_id", "=", principal.householdId)
      .where("input_fingerprint", "=", fingerprint)
      .executeTakeFirstOrThrow());
  const latest = await db
    .selectFrom("planning_period_revisions")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .where("planning_period_id", "=", period.id)
    .orderBy("version", "desc")
    .executeTakeFirst();
  if (latest) return;
  const previous = await sql<{
    id: string;
    planning_period_id: string;
    version: number;
  }>`
    select latest.id,latest.planning_period_id,latest.version from planning_periods p
    join lateral(select r.id,r.planning_period_id,r.version,r.state,r.recorded_at
      from planning_period_revisions r where r.household_id=p.household_id and r.planning_period_id=p.id
      order by r.version desc limit 1) latest on true
    where p.household_id=${principal.householdId} and latest.state='active'
    order by latest.recorded_at desc,latest.id desc limit 1`.execute(db);
  const prior = previous.rows[0];
  if (prior && prior.planning_period_id !== period.id)
    await db
      .insertInto("planning_period_revisions")
      .values({
        household_id: principal.householdId,
        planning_period_id: prior.planning_period_id,
        version: prior.version + 1,
        supersedes_revision_id: prior.id,
        state: "replaced",
        reason: view.plan.horizonMissedIncome
          ? "expected_income_missed"
          : "planning_input_changed",
      })
      .execute();
  await db
    .insertInto("planning_period_revisions")
    .values({
      household_id: principal.householdId,
      planning_period_id: period.id,
      version: 1,
      supersedes_revision_id: null,
      state: "active",
      reason: "initial",
    })
    .execute();
}

async function refreshIncomeBoundaries(
  db: Transaction<Database>,
  principal: Principal,
  view: BootstrapResponse,
) {
  const eligible = await sql<{
    boundary_on: string;
    occurrence_id: string;
    occurrence_version: number;
    schedule_id: string;
    schedule_version: number;
    match_id: string;
    match_version: number;
    transaction_id: string;
    transaction_revision_number: number;
    balance_observation_id: string;
    amount_applied_minor: string;
    source_kind: string;
    balance_provenance: string;
    verified_at: Date;
  }>`select min(tx.occurred_on) over(partition by o.id)::text boundary_on,o.id occurrence_id,o.version occurrence_version,
      sr.income_schedule_id schedule_id,sr.version schedule_version,m.id match_id,m.version match_version,
      tx.id transaction_id,tx.revision transaction_revision_number,m.reflected_in_balance_observation_id balance_observation_id,
      tx.source_kind,b.provenance balance_provenance,
      m.amount_applied_minor,o.verified_at
    from plan_occurrences o
    join lateral(select r.* from income_schedule_revisions r where r.household_id=o.household_id
      and r.income_schedule_id=o.income_schedule_id and r.recorded_at<=o.verified_at
      order by r.recorded_at desc,r.version desc limit 1) sr on true
    join occurrence_transaction_matches m on m.household_id=o.household_id and m.occurrence_id=o.id
    join financial_transactions tx on tx.household_id=m.household_id and tx.id=m.transaction_id
    join balance_observations b on b.household_id=m.household_id and b.id=m.reflected_in_balance_observation_id
    where o.household_id=${principal.householdId} and o.kind='income' and o.state='verified'
      and sr.confirmed and sr.frequency<>'irregular' and sr.status='active'
      and m.state='confirmed' and m.reflected_in_balance_observation_id is not null and tx.status='posted'
      and tx.occurred_on>=current_date-interval '3 years'
    order by boundary_on desc,o.id,m.id limit 1000`.execute(db);
  // TypeScript keeps raw SQL honest at the call site; normalize the deliberately
  // flat result because PostgreSQL returns date and bigint values as strings.
  const rows = eligible.rows;
  const desiredDates = new Set(rows.map((row) => row.boundary_on));
  const scanFloor =
    rows.length === 1000
      ? rows.reduce(
          (earliest, row) =>
            row.boundary_on < earliest ? row.boundary_on : earliest,
          rows[0]!.boundary_on,
        )
      : addDays(view.plan.horizonStart, -1096);
  const existing = await db
    .selectFrom("income_boundaries")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .where("boundary_on", ">=", scanFloor)
    .execute();
  for (const boundary of existing) {
    const latest = await latestBoundaryRevision(db, principal, boundary.id);
    const shouldBeVerified = desiredDates.has(toDateOnly(boundary.boundary_on));
    const desiredLevel = rows
      .filter((row) => row.boundary_on === toDateOnly(boundary.boundary_on))
      .every(
        (row) =>
          row.source_kind === "plaid" && row.balance_provenance === "plaid",
      )
      ? "provider_verified"
      : "user_confirmed";
    if (
      (latest?.state === "verified") === shouldBeVerified &&
      (!shouldBeVerified || latest?.verification_level === desiredLevel)
    )
      continue;
    await db
      .insertInto("income_boundary_revisions")
      .values({
        household_id: principal.householdId,
        income_boundary_id: boundary.id,
        version: (latest?.version ?? 0) + 1,
        state: shouldBeVerified ? "verified" : "invalidated",
        verification_level: shouldBeVerified
          ? desiredLevel
          : (latest?.verification_level ?? boundary.verification_level),
        reason: shouldBeVerified
          ? "Verified income evidence restored"
          : "Underlying bank or schedule evidence changed",
      })
      .execute();
  }
  for (const boundaryOn of [...desiredDates].sort()) {
    let boundary = existing.find(
      (item) => toDateOnly(item.boundary_on) === boundaryOn,
    );
    if (!boundary) {
      boundary = await db
        .insertInto("income_boundaries")
        .values({
          household_id: principal.householdId,
          boundary_on: boundaryOn,
          timezone_snapshot: await householdTimezone(db, principal),
          verification_level: rows
            .filter((row) => row.boundary_on === boundaryOn)
            .every(
              (row) =>
                row.source_kind === "plaid" &&
                row.balance_provenance === "plaid",
            )
            ? "provider_verified"
            : "user_confirmed",
          verified_at: new Date(
            Math.max(
              ...rows
                .filter((row) => row.boundary_on === boundaryOn)
                .map((row) => row.verified_at.getTime()),
            ),
          ),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await db
        .insertInto("income_boundary_revisions")
        .values({
          household_id: principal.householdId,
          income_boundary_id: boundary.id,
          version: 1,
          state: "verified",
          verification_level: boundary.verification_level,
          reason: "Posted income and a later balance observation verified",
        })
        .execute();
    }
    for (const row of rows.filter((item) => item.boundary_on === boundaryOn))
      await db
        .insertInto("income_boundary_evidence")
        .values({
          household_id: principal.householdId,
          income_boundary_id: boundary.id,
          income_occurrence_id: row.occurrence_id,
          income_occurrence_version: row.occurrence_version,
          income_schedule_id: row.schedule_id,
          income_schedule_version: row.schedule_version,
          match_id: row.match_id,
          match_version: row.match_version,
          transaction_id: row.transaction_id,
          transaction_revision: row.transaction_revision_number,
          balance_observation_id: row.balance_observation_id,
          amount_minor: row.amount_applied_minor,
        })
        .onConflict((conflict) =>
          conflict
            .columns(["household_id", "match_id", "match_version"])
            .doNothing(),
        )
        .execute();
  }
}

async function ensureCanonicalCycles(
  db: Transaction<Database>,
  principal: Principal,
  view: BootstrapResponse,
) {
  const valid = await sql<{ id: string; boundary_on: string }>`
    select recent.id,recent.boundary_on::text from (
      select b.id,b.boundary_on from income_boundaries b
    join lateral (select r.state from income_boundary_revisions r where r.household_id=b.household_id
      and r.income_boundary_id=b.id order by r.version desc limit 1) latest on true
    where b.household_id=${principal.householdId} and latest.state='verified'
    order by b.boundary_on desc,b.id desc limit 80) recent
    order by recent.boundary_on,recent.id`.execute(db);
  const desired = valid.rows.map((start, index) => ({
    start,
    end: valid.rows[index + 1] ?? null,
  }));
  const cycles = [];
  for (const item of desired) {
    const existing = await db
      .selectFrom("pay_cycles")
      .selectAll()
      .where("household_id", "=", principal.householdId)
      .where("start_boundary_id", "=", item.start.id)
      .$if(item.end !== null, (query) =>
        query.where("end_boundary_id", "=", item.end!.id),
      )
      .$if(item.end === null, (query) =>
        query.where("end_boundary_id", "is", null),
      )
      .executeTakeFirst();
    if (existing) {
      cycles.push(existing);
      continue;
    }
    const superseded = await db
      .selectFrom("pay_cycles")
      .select(["id", "start_on", "end_on"])
      .where("household_id", "=", principal.householdId)
      .where((expression) =>
        expression.or([
          expression("start_on", "=", item.start.boundary_on),
          expression(
            "end_on",
            "=",
            item.end?.boundary_on ?? item.start.boundary_on,
          ),
        ]),
      )
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    cycles.push(
      await db
        .insertInto("pay_cycles")
        .values({
          household_id: principal.householdId,
          start_boundary_id: item.start.id,
          end_boundary_id: item.end?.id ?? null,
          start_on: item.start.boundary_on,
          end_on: item.end?.boundary_on ?? null,
          timezone_snapshot: await householdTimezone(db, principal),
          supersedes_cycle_id: superseded?.id ?? null,
          topology_reason: superseded
            ? toDateOnly(superseded.start_on) === item.start.boundary_on &&
              superseded.end_on === null &&
              item.end !== null
              ? "normal_close"
              : "boundary_correction"
            : "initial",
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }
  return cycles;
}

async function materializeReport(
  db: Transaction<Database>,
  principal: Principal,
  cycle: {
    id: string;
    start_on: unknown;
    end_on: unknown;
    supersedes_cycle_id: string | null;
    topology_reason: string;
  },
  view: BootstrapResponse,
  eventCutoff: Date,
) {
  const startOn = toDateOnly(cycle.start_on);
  const endOn = cycle.end_on
    ? toDateOnly(cycle.end_on)
    : addDays(view.plan.horizonStart, 1);
  if (endOn <= startOn) return;
  const timezone = await householdTimezone(db, principal);
  const txRows =
    await sql<any>`select t.id,t.revision,t.account_id,t.merchant,t.amount_minor,t.occurred_on::text,
      t.direction,t.status,t.source_kind,t.recorded_at,c.category,cr.id category_revision_id,c.version category_version,
      historical_role.id role_revision_id,historical_role.version role_revision_version,
      historical_role.planning_role,historical_role.account_type historical_account_type
    from transaction_entities e join financial_transactions t on t.household_id=e.household_id and t.id=e.current_transaction_id
    join accounts a on a.household_id=t.household_id and a.id=t.account_id
    join lateral(select rr.id,rr.version,rr.planning_role,rr.account_type from account_planning_role_revisions rr
      where rr.household_id=a.household_id and rr.account_id=a.id
        and (rr.effective_at at time zone ${timezone})::date<=t.occurred_on
      order by rr.effective_at desc,rr.version desc limit 1) historical_role on true
    join transaction_category_assignments c on c.household_id=e.household_id and c.transaction_id=e.id
    join lateral(select r.id from transaction_category_revisions r where r.household_id=c.household_id
      and r.transaction_id=c.transaction_id and r.version=c.version order by r.created_at desc,r.id desc limit 1) cr on true
    where e.household_id=${principal.householdId} and t.occurred_on>=${startOn}::date and t.occurred_on<${endOn}::date
      and t.status in ('posted','pending') and historical_role.account_type in ('cash','checking','savings')
      and (historical_role.planning_role='spendable'
        or (historical_role.planning_role='protected' and t.status='posted' and t.direction='credit' and c.category='income')
        or exists(select 1 from occurrence_transaction_matches income_match
          join plan_occurrences income_occurrence on income_occurrence.household_id=income_match.household_id
            and income_occurrence.id=income_match.occurrence_id
          where income_match.household_id=t.household_id and income_match.transaction_id=t.id
            and income_match.state='confirmed' and income_occurrence.kind='income' and income_occurrence.state='verified'))
    order by t.occurred_on,t.id`.execute(db);
  const occurrenceRows = (
    await sql<any>`select o.*,r.id occurrence_revision_id
    from plan_occurrences o join plan_occurrence_revisions r on r.household_id=o.household_id
      and r.occurrence_id=o.id and r.version=o.version
    where o.household_id=${principal.householdId} and o.expected_on>=${startOn}::date and o.expected_on<${endOn}::date
    order by o.expected_on,o.id`.execute(db)
  ).rows;
  const movementRows =
    await sql<any>`select m.id,g.name,m.kind,m.amount_minor,m.effective_on::text,m.verification_method,m.provenance
    from savings_goal_movements m join savings_goals g on g.household_id=m.household_id and g.id=m.savings_goal_id
    where m.household_id=${principal.householdId} and m.effective_on>=${startOn}::date and m.effective_on<${endOn}::date
      and m.kind in ('contribution','withdrawal') and not exists(select 1 from savings_goal_movements r
        where r.household_id=m.household_id and r.kind='reversal' and r.reversed_movement_id=m.id)
    order by m.effective_on,m.id`.execute(db);
  const savingsReversalRows =
    await sql<any>`select r.id,g.name,r.amount_minor,r.effective_on::text,r.verification_method,r.provenance,
      r.reversed_movement_id
    from savings_goal_movements r
    join savings_goal_movements original on original.household_id=r.household_id and original.id=r.reversed_movement_id
    join savings_goals g on g.household_id=original.household_id and g.id=original.savings_goal_id
    where r.household_id=${principal.householdId} and r.kind='reversal'
      and original.effective_on>=${startOn}::date and original.effective_on<${endOn}::date
    order by r.created_at,r.id`.execute(db);
  const savingsEvidenceRows =
    await sql<any>`select e.id,e.movement_id,e.evidence_role,e.transaction_id,e.balance_observation_id
    from savings_movement_evidence e join savings_goal_movements m on m.household_id=e.household_id and m.id=e.movement_id
    where e.household_id=${principal.householdId} and m.effective_on>=${startOn}::date and m.effective_on<${endOn}::date
      and m.kind in ('contribution','withdrawal') and not exists(select 1 from savings_goal_movements r
        where r.household_id=m.household_id and r.kind='reversal' and r.reversed_movement_id=m.id)
    order by e.id`.execute(db);
  const debtRows =
    await sql<any>`select p.id,d.name,m.transaction_id,m.amount_applied_minor amount_minor,t.occurred_on::text
    from debt_payment_evidence p join debts d on d.household_id=p.household_id and d.id=p.debt_id
    join occurrence_transaction_matches m on m.household_id=p.household_id and m.id=p.occurrence_match_id
    join financial_transactions t on t.household_id=m.household_id and t.id=m.transaction_id
    left join debt_payment_evidence_reversals r on r.household_id=p.household_id and r.evidence_id=p.id
    where p.household_id=${principal.householdId} and r.id is null and t.occurred_on>=${startOn}::date and t.occurred_on<${endOn}::date
    order by t.occurred_on,p.id`.execute(db);
  const matchRows =
    await sql<any>`select m.id,m.version,m.amount_applied_minor,m.state,m.transaction_id,mr.id match_revision_id,
      o.id occurrence_id,o.version occurrence_version,o.kind occurrence_kind,o.state occurrence_state,
      tx.occurred_on::text,tx.status transaction_status,
      coalesce(sr.name,o.name) income_source_name,sr.id income_schedule_revision_id,
      sr.version income_schedule_version
    from occurrence_transaction_matches m join plan_occurrences o on o.household_id=m.household_id and o.id=m.occurrence_id
    join occurrence_match_revisions mr on mr.household_id=m.household_id and mr.match_id=m.id and mr.version=m.version
    join financial_transactions tx on tx.household_id=m.household_id and tx.id=m.transaction_id
    left join lateral(select r.id,r.version,r.name from income_schedule_revisions r
      where o.kind='income' and r.household_id=o.household_id and r.income_schedule_id=o.income_schedule_id
        and r.recorded_at<=coalesce(o.verified_at,o.created_at)
      order by r.recorded_at desc,r.version desc limit 1) sr on true
    where m.household_id=${principal.householdId}
      and ((o.expected_on>=${startOn}::date and o.expected_on<${endOn}::date)
        or (tx.occurred_on>=${startOn}::date and tx.occurred_on<${endOn}::date))
      and m.state in ('confirmed','proposed') order by m.id`.execute(db);
  const boundaryRows =
    await sql<any>`select e.id evidence_id,sr.id schedule_revision_id,sr.version schedule_version,br.verification_level
    from pay_cycles c join income_boundary_evidence e on e.household_id=c.household_id
      and e.income_boundary_id in (c.start_boundary_id,c.end_boundary_id)
    join income_boundaries b on b.household_id=e.household_id and b.id=e.income_boundary_id
    join lateral(select r.verification_level from income_boundary_revisions r where r.household_id=b.household_id
      and r.income_boundary_id=b.id order by r.version desc limit 1) br on true
    join income_schedule_revisions sr on sr.household_id=e.household_id and sr.income_schedule_id=e.income_schedule_id
      and sr.version=e.income_schedule_version
    where c.household_id=${principal.householdId} and c.id=${cycle.id} order by e.id`.execute(
      db,
    );
  const paidInCycle = new Map<string, bigint>();
  for (const row of matchRows.rows.filter(
    (item: any) =>
      item.state === "confirmed" &&
      item.transaction_status === "posted" &&
      item.occurred_on >= startOn &&
      item.occurred_on < endOn,
  ))
    paidInCycle.set(
      row.occurrence_id,
      (paidInCycle.get(row.occurrence_id) ?? 0n) +
        BigInt(row.amount_applied_minor),
    );
  const incomeReceipts: IncomeReceipt[] = matchRows.rows
    .filter(
      (row: any) =>
        row.state === "confirmed" &&
        row.transaction_status === "posted" &&
        row.occurrence_kind === "income" &&
        row.occurrence_state === "verified" &&
        row.occurred_on >= startOn &&
        row.occurred_on < endOn,
    )
    .map((row: any) => ({
      transactionId: row.transaction_id,
      name: row.income_source_name,
      amountMinor: BigInt(row.amount_applied_minor),
      occurredOn: row.occurred_on,
    }));
  const representedOutflowTransactionIds = new Set<string>([
    ...debtRows.rows.map((row: any) => row.transaction_id),
    ...savingsEvidenceRows.rows
      .filter(
        (row: any) =>
          row.evidence_role === "source_debit" && row.transaction_id,
      )
      .map((row: any) => row.transaction_id),
  ]);
  const report = calculatePayCycleReport({
    startOn,
    endOn,
    transactions: txRows.rows.map(
      (row: any): PayCycleTransaction => ({
        id: row.id,
        revision: row.revision,
        accountId: row.account_id,
        merchant: row.merchant,
        amountMinor: BigInt(row.amount_minor),
        occurredOn: row.occurred_on,
        direction: row.direction,
        status: row.status,
        category: row.category,
        planningRole: row.planning_role,
      }),
    ),
    occurrences: occurrenceRows.map(
      (row): PayCycleOccurrence => ({
        id: row.id,
        version: row.version,
        kind: row.kind as any,
        name: row.name,
        expectedOn: toDateOnly(row.expected_on),
        expectedAmountMinor:
          row.expected_amount_minor === null
            ? null
            : BigInt(row.expected_amount_minor),
        matchedAmountMinor: paidInCycle.get(row.id) ?? 0n,
        state: row.state,
        commitmentId: row.commitment_id,
        incomeScheduleId: row.income_schedule_id,
      }),
    ),
    savingsMovements: movementRows.rows.map(
      (row: any): VerifiedMovement => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        amountMinor: BigInt(row.amount_minor),
        effectiveOn: row.effective_on,
      }),
    ),
    debtPayments: debtRows.rows.map(
      (row: any): DebtPayment => ({
        id: row.id,
        debtName: row.name,
        transactionId: row.transaction_id,
        amountMinor: BigInt(row.amount_minor),
        occurredOn: row.occurred_on,
      }),
    ),
    incomeReceipts,
    representedOutflowTransactionIds,
  });
  const coverage = await accountCoverage(
    db,
    principal,
    startOn,
    endOn,
    cycle.end_on !== null,
    eventCutoff,
  );
  const structurallyComplete =
    coverage.length > 0 &&
    coverage.every((item) => item.coverageState === "complete");
  const providerOnly =
    structurallyComplete &&
    coverage.every(
      (item) =>
        item.provenance === "plaid" &&
        item.openingProvenance === "plaid" &&
        item.closingProvenance === "plaid",
    ) &&
    txRows.rows.every((row: any) => row.source_kind === "plaid") &&
    movementRows.rows.every(
      (row: any) => row.verification_method === "provider_verified",
    ) &&
    savingsReversalRows.rows.every(
      (row: any) => row.verification_method === "provider_verified",
    ) &&
    boundaryRows.rows.every(
      (row: any) => row.verification_level === "provider_verified",
    );
  const assurance = !structurallyComplete
    ? "incomplete"
    : providerOnly
      ? "complete"
      : "user_confirmed";
  const output = serializeBreakdown(report);
  const accountRoleRevisionInputs = new Map<
    string,
    {
      id: string;
      accountId: string;
      version: number;
      role: string;
      accountType: string;
    }
  >();
  for (const row of txRows.rows as any[]) {
    accountRoleRevisionInputs.set(row.role_revision_id, {
      id: row.role_revision_id,
      accountId: row.account_id,
      version: row.role_revision_version,
      role: row.planning_role,
      accountType: row.historical_account_type,
    });
  }
  for (const revision of coverage.flatMap(
    (row) => row.roleRevisions,
  ) as any[]) {
    accountRoleRevisionInputs.set(revision.id, revision);
  }
  const accountRoleRevisionManifest = [...accountRoleRevisionInputs.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((revision) => ({
      kind: "account_role_revision",
      id: revision.id,
      version: revision.version,
      role: revision.role,
      amount: null,
      snapshot: revision,
    }));
  const manifest = [
    ...txRows.rows.flatMap((row: any) => [
      {
        kind: "transaction",
        id: row.id,
        version: row.revision,
        role: row.direction,
        amount: row.amount_minor,
        snapshot: {
          accountId: row.account_id,
          merchant: row.merchant,
          amount: row.amount_minor,
          occurredOn: row.occurred_on,
          direction: row.direction,
          status: row.status,
          source: row.source_kind,
          planningRole: row.planning_role,
          accountType: row.historical_account_type,
          roleRevisionId: row.role_revision_id,
          roleRevisionVersion: row.role_revision_version,
        },
      },
      {
        kind: "transaction_category_revision",
        id: row.category_revision_id,
        version: row.category_version,
        role: "category",
        amount: null,
        snapshot: { category: row.category, version: row.category_version },
      },
    ]),
    ...occurrenceRows.map((row) => ({
      kind: "occurrence_revision",
      id: row.occurrence_revision_id,
      version: row.version,
      role: row.kind,
      amount: row.matched_amount_minor,
      snapshot: {
        occurrenceId: row.id,
        scheduleRevision: {
          kind: row.source_revision_kind,
          id: row.source_revision_id,
          version: row.source_revision_version,
        },
        kind: row.kind,
        name: row.name,
        expectedOn: toDateOnly(row.expected_on),
        expectedAmount: row.expected_amount_minor,
        state: row.state,
        matchedAmount: row.matched_amount_minor,
        verifiedAt: row.verified_at,
      },
    })),
    ...matchRows.rows.map((row: any) => ({
      kind: "occurrence_match_revision",
      id: row.match_revision_id,
      version: row.version,
      role: "payment_evidence",
      amount: row.amount_applied_minor,
      snapshot: {
        matchId: row.id,
        occurrenceId: row.occurrence_id,
        transactionId: row.transaction_id,
        state: row.state,
        amount: row.amount_applied_minor,
        occurredOn: row.occurred_on,
      },
    })),
    ...matchRows.rows
      .filter((row: any) => row.income_schedule_revision_id)
      .map((row: any) => ({
        kind: "income_schedule_revision",
        id: row.income_schedule_revision_id,
        version: row.income_schedule_version,
        role: "income_attribution",
        amount: null,
        snapshot: {
          name: row.income_source_name,
          version: row.income_schedule_version,
        },
      })),
    ...boundaryRows.rows.flatMap((row: any) => [
      {
        kind: "boundary_evidence",
        id: row.evidence_id,
        version: null,
        role: "payday_boundary",
        amount: null,
        snapshot: row,
      },
      {
        kind: "income_schedule_revision",
        id: row.schedule_revision_id,
        version: row.schedule_version,
        role: "income_schedule",
        amount: null,
        snapshot: { version: row.schedule_version },
      },
    ]),
    ...movementRows.rows.map((row: any) => ({
      kind: "savings_movement",
      id: row.id,
      version: null,
      role: row.kind,
      amount: row.amount_minor,
      snapshot: {
        name: row.name,
        kind: row.kind,
        amount: row.amount_minor,
        effectiveOn: row.effective_on,
        verificationMethod: row.verification_method,
      },
    })),
    ...savingsReversalRows.rows.map((row: any) => ({
      kind: "savings_movement",
      id: row.id,
      version: null,
      role: "reversal",
      amount: row.amount_minor,
      snapshot: {
        name: row.name,
        kind: "reversal",
        amount: row.amount_minor,
        effectiveOn: row.effective_on,
        verificationMethod: row.verification_method,
        reversedMovementId: row.reversed_movement_id,
      },
    })),
    ...savingsEvidenceRows.rows.map((row: any) => ({
      kind: "savings_movement_evidence",
      id: row.id,
      version: null,
      role: row.evidence_role,
      amount: null,
      snapshot: row,
    })),
    ...debtRows.rows.map((row: any) => ({
      kind: "debt_payment_evidence",
      id: row.id,
      version: null,
      role: "debt_payment",
      amount: row.amount_minor,
      snapshot: row,
    })),
    ...coverage.flatMap((row) =>
      [row.openingObservationId, row.closingObservationId]
        .filter(Boolean)
        .map((id) => ({
          kind: "balance_observation",
          id: id!,
          version: null,
          role: "coverage",
          amount: null,
          snapshot: {
            accountId: row.accountId,
            coverageState: row.coverageState,
          },
        })),
    ),
    ...accountRoleRevisionManifest,
  ];
  const fingerprint = hashJson({
    startOn,
    endOn,
    manifest,
    coverage,
    output,
    assurance,
  });
  const prior = await db
    .selectFrom("pay_cycle_report_revisions")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .where("pay_cycle_id", "=", cycle.id)
    .orderBy("version", "desc")
    .executeTakeFirst();
  if (prior?.input_fingerprint === fingerprint) return;
  const opening = coverage.every((item) => item.openingMinor !== null)
    ? coverage.reduce((sum, item) => sum + BigInt(item.openingMinor!), 0n)
    : null;
  const closing = coverage.every((item) => item.closingMinor !== null)
    ? coverage.reduce((sum, item) => sum + BigInt(item.closingMinor!), 0n)
    : null;
  const netFlow =
    report.spendableEarnedMinor -
    report.spentMinor -
    report.savedMinor +
    report.savingsWithdrawnMinor -
    report.debtPaidMinor;
  const revision = await db
    .insertInto("pay_cycle_report_revisions")
    .values({
      household_id: principal.householdId,
      pay_cycle_id: cycle.id,
      version: (prior?.version ?? 0) + 1,
      supersedes_revision_id: prior?.id ?? null,
      event_cutoff_at: eventCutoff,
      algorithm_version: ALGORITHM_VERSION,
      status: cycle.end_on ? (prior ? "revised" : "closed") : "provisional",
      assurance,
      coverage_reason:
        assurance === "incomplete"
          ? "One or more accounts lack current boundary balance evidence"
          : assurance === "user_confirmed"
            ? "Some balances or activity were confirmed by you"
            : null,
      earned_minor: report.earnedMinor.toString(),
      spent_minor: report.spentMinor.toString(),
      pending_minor: report.pendingMinor.toString(),
      saved_minor: report.savedMinor.toString(),
      savings_withdrawn_minor: report.savingsWithdrawnMinor.toString(),
      commitments_expected_minor: report.commitmentsExpectedMinor.toString(),
      commitments_paid_minor: report.commitmentsPaidMinor.toString(),
      commitments_remaining_minor: report.commitmentsRemainingMinor.toString(),
      debt_paid_minor: report.debtPaidMinor.toString(),
      opening_cash_minor: opening?.toString() ?? null,
      closing_cash_minor: closing?.toString() ?? null,
      unexplained_delta_minor:
        structurallyComplete && opening !== null && closing !== null
          ? (closing - opening - netFlow).toString()
          : null,
      currency: "USD",
      output,
      input_fingerprint: fingerprint,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  for (const [ordinal, input] of manifest.entries())
    await db
      .insertInto("pay_cycle_report_inputs")
      .values({
        household_id: principal.householdId,
        report_revision_id: revision.id,
        ordinal,
        input_kind: input.kind,
        input_id: input.id,
        input_version: input.version,
        role: input.role,
        amount_attributed_minor: input.amount,
        input_snapshot: JSON.parse(JSON.stringify(input.snapshot)),
        input_hash: hashJson(input.snapshot),
      })
      .execute();
  for (const item of coverage)
    await db
      .insertInto("pay_cycle_account_coverage")
      .values({
        household_id: principal.householdId,
        report_revision_id: revision.id,
        account_id: item.accountId,
        planning_role: item.planningRole,
        provenance: item.provenance,
        opening_observation_id: item.openingObservationId,
        closing_observation_id: item.closingObservationId,
        coverage_state: item.coverageState,
        reason: item.reason,
      })
      .execute();
}

async function accountCoverage(
  db: Transaction<Database>,
  principal: Principal,
  startOn: string,
  endOn: string,
  closed: boolean,
  eventCutoff: Date,
) {
  const timezone = await householdTimezone(db, principal);
  const result = await sql<any>`with role_history as (
      select r.*,lag(r.planning_role) over(partition by r.account_id order by r.effective_at,r.version) previous_role,
        lag(r.account_type) over(partition by r.account_id order by r.effective_at,r.version) previous_account_type,
        lead(r.effective_at) over(partition by r.account_id order by r.effective_at,r.version) next_effective
      from account_planning_role_revisions r where r.household_id=${principal.householdId}
    )
    select a.id account_id,a.provenance,spendable.id role_revision_id,spendable.version role_revision_version,
      start_role.planning_role start_role,end_role.planning_role end_role,
      start_role.account_type start_account_type,end_role.account_type end_account_type,
      coalesce(role_changes.count,0)::int role_change_count,role_inputs.items role_revisions,
      opening.id opening_id,opening.amount_minor opening_minor,opening.provenance opening_provenance,opening.as_of opening_as_of,
      closing.id closing_id,closing.amount_minor closing_minor,closing.provenance closing_provenance,closing.as_of closing_as_of,
      opening.as_of<((${startOn}::date::timestamp at time zone ${timezone})-interval '72 hours') opening_stale,
      closing.as_of<(case when ${closed} then (${endOn}::date::timestamp at time zone ${timezone}) else ${eventCutoff}::timestamptz end-interval '72 hours') closing_stale,
      coalesce(unreflected.count,0)::int unreflected_count
    from accounts a
    join lateral(select r.* from role_history r where r.account_id=a.id and r.planning_role='spendable'
      and r.effective_at<(${endOn}::date::timestamp at time zone ${timezone})
      and coalesce(r.next_effective,'infinity'::timestamptz)>(${startOn}::date::timestamp at time zone ${timezone})
      order by r.effective_at limit 1) spendable on true
    left join lateral(select r.* from role_history r where r.account_id=a.id
      and r.effective_at<=(${startOn}::date::timestamp at time zone ${timezone}) order by r.effective_at desc,r.version desc limit 1) start_role on true
    left join lateral(select r.* from role_history r where r.account_id=a.id
      and r.effective_at<(${endOn}::date::timestamp at time zone ${timezone}) order by r.effective_at desc,r.version desc limit 1) end_role on true
    left join lateral(select count(*) from role_history r where r.account_id=a.id
      and r.effective_at>(${startOn}::date::timestamp at time zone ${timezone})
      and r.effective_at<(${endOn}::date::timestamp at time zone ${timezone})
      and (r.planning_role is distinct from r.previous_role or r.account_type is distinct from r.previous_account_type)) role_changes on true
    join lateral(select jsonb_agg(jsonb_build_object('id',r.id,'accountId',r.account_id,'version',r.version,'role',r.planning_role,'accountType',r.account_type)
      order by r.effective_at,r.version) items from role_history r where r.account_id=a.id
      and r.effective_at<(${endOn}::date::timestamp at time zone ${timezone})
      and coalesce(r.next_effective,'infinity'::timestamptz)>(${startOn}::date::timestamp at time zone ${timezone})) role_inputs on true
    left join lateral(select b.id,b.amount_minor,b.provenance,b.as_of,b.recorded_at from balance_observations b
      where b.household_id=a.household_id and b.account_id=a.id
      and b.as_of<(${startOn}::date::timestamp at time zone ${timezone}) order by b.as_of desc,b.recorded_at desc limit 1) opening on true
    left join lateral(select b.id,b.amount_minor,b.provenance,b.as_of,b.recorded_at from balance_observations b
      where b.household_id=a.household_id and b.account_id=a.id
      and b.as_of<(${endOn}::date::timestamp at time zone ${timezone}) order by b.as_of desc,b.recorded_at desc limit 1) closing on true
    left join lateral(select count(*) from transaction_entities e join financial_transactions t
      on t.household_id=e.household_id and t.id=e.current_transaction_id
      where e.household_id=a.household_id and e.account_id=a.id and t.status='posted'
      and t.occurred_on>=${startOn}::date and t.occurred_on<${endOn}::date
      and closing.id is not null and t.recorded_at>closing.recorded_at
      and not exists(select 1 from occurrence_transaction_matches m where m.household_id=t.household_id
        and m.transaction_id=t.id and m.state='confirmed' and m.reflected_in_balance_observation_id=closing.id)) unreflected on true
    where a.household_id=${principal.householdId} and spendable.account_type in ('cash','checking','savings') order by a.id`.execute(
    db,
  );
  return result.rows.map((row: any) => {
    const eligibleTypes = new Set(["cash", "checking", "savings"]);
    const roleChanged =
      row.start_role !== "spendable" ||
      row.end_role !== "spendable" ||
      !eligibleTypes.has(row.start_account_type) ||
      !eligibleTypes.has(row.end_account_type) ||
      row.start_role !== row.end_role ||
      row.start_account_type !== row.end_account_type ||
      row.role_change_count > 0;
    const state = roleChanged
      ? "role_changed"
      : !row.opening_id
        ? "missing_opening"
        : !row.closing_id
          ? "missing_closing"
          : row.opening_id === row.closing_id ||
              row.opening_stale ||
              row.closing_stale ||
              row.unreflected_count > 0
            ? "stale"
            : "complete";
    return {
      accountId: row.account_id,
      planningRole: "spendable",
      provenance: row.provenance,
      roleRevisionId: row.role_revision_id,
      roleRevisionVersion: row.role_revision_version,
      roleRevisions: row.role_revisions ?? [],
      openingObservationId: row.opening_id ?? null,
      closingObservationId: row.closing_id ?? null,
      openingProvenance: row.opening_provenance ?? null,
      closingProvenance: row.closing_provenance ?? null,
      openingMinor: row.opening_minor ?? null,
      closingMinor: row.closing_minor ?? null,
      coverageState: state,
      reason:
        state === "complete"
          ? "Opening and closing balances observed after included activity"
          : state === "role_changed"
            ? "Account planning role changed during this cycle"
            : state === "missing_opening"
              ? "No balance before this cycle began"
              : state === "missing_closing"
                ? "No later balance closes this cycle"
                : "Balance evidence is stale or predates included activity",
    };
  });
}

export async function listPayCycles(
  db: Transaction<Database>,
  principal: Principal,
  query: PayCycleQuery,
): Promise<PayCycleListResponse> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const rows = await canonicalCycleRows(db, principal, query.limit + 1, cursor);
  const hasMore = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const planningCursor = query.planningCursor
    ? decodePlanningCursor(query.planningCursor)
    : null;
  const verifiedBoundary = await sql<{
    present: boolean;
  }>`select exists(select 1 from income_boundaries b
    join lateral(select r.state from income_boundary_revisions r where r.household_id=b.household_id
      and r.income_boundary_id=b.id order by r.version desc limit 1) latest on true
    where b.household_id=${principal.householdId} and latest.state='verified') present`.execute(
    db,
  );
  const planningPeriods =
    await sql<any>`select p.id,p.start_on::text,(p.end_on-1)::text through_on,p.boundary_basis,
      latest.state,latest.reason,latest.recorded_at,latest.recorded_at::text recorded_at_cursor
    from planning_periods p join lateral(select r.state,r.reason,r.recorded_at from planning_period_revisions r
      where r.household_id=p.household_id and r.planning_period_id=p.id order by r.version desc limit 1) latest on true
    where p.household_id=${principal.householdId}
      and (${planningCursor?.recordedAt ?? null}::timestamptz is null or
        (latest.recorded_at,p.id)<(${planningCursor?.recordedAt ?? null}::timestamptz,${planningCursor?.id ?? null}::uuid))
    order by latest.recorded_at desc,p.id desc limit ${query.planningLimit + 1}`.execute(
      db,
    );
  const hasMorePlanning = planningPeriods.rows.length > query.planningLimit;
  const planningPage = planningPeriods.rows.slice(0, query.planningLimit);
  return payCycleListResponseSchema.parse({
    items: page.map(mapCycle),
    nextCursor: hasMore ? encodeCursor(page.at(-1)!) : null,
    nextPlanningCursor: hasMorePlanning
      ? encodePlanningCursor(planningPage.at(-1)!)
      : null,
    hasVerifiedPayday: Boolean(verifiedBoundary.rows[0]?.present),
    planningPeriods: planningPage.map((row: any) => ({
      id: row.id,
      startOn: row.start_on,
      throughOn: row.through_on,
      basis: row.boundary_basis,
      state: row.state,
      reason: row.reason,
      recordedAt: new Date(row.recorded_at).toISOString(),
    })),
  });
}
export async function getPayCycle(
  db: Transaction<Database>,
  principal: Principal,
  id: string,
): Promise<PayCycleDetailResponse> {
  const rows = await canonicalCycleRows(db, principal, 1, null, id);
  const row = rows[0];
  if (!row) throw new Error("PAY_CYCLE_NOT_FOUND");
  const revisions = await db
    .selectFrom("pay_cycle_report_revisions")
    .select(["id", "version", "calculated_at", "status"])
    .where("household_id", "=", principal.householdId)
    .where("pay_cycle_id", "=", id)
    .orderBy("version", "desc")
    .execute();
  return payCycleDetailResponseSchema.parse({
    cycle: mapCycle(row),
    revisions: revisions.map((item) => ({
      id: item.id,
      version: item.version,
      calculatedAt: item.calculated_at.toISOString(),
      reason:
        item.status === "revised"
          ? "Updated after verified evidence changed"
          : "Initial calculation",
    })),
  });
}

async function canonicalCycleRows(
  db: Transaction<Database>,
  principal: Principal,
  limit: number,
  cursor: { startOn: string; id: string } | null,
  cycleId: string | null = null,
) {
  return (
    await sql<any>`select c.id,c.start_on::text,c.end_on::text,c.timezone_snapshot,c.supersedes_cycle_id,c.topology_reason,
      r.id report_id,r.version report_version,r.status report_status,r.assurance,r.coverage_reason,r.calculated_at,
      r.earned_minor,r.spent_minor,r.pending_minor,r.saved_minor,r.savings_withdrawn_minor,r.commitments_expected_minor,
      r.commitments_paid_minor,r.commitments_remaining_minor,r.debt_paid_minor,r.opening_cash_minor,r.closing_cash_minor,
      r.unexplained_delta_minor,r.output
    from pay_cycles c
    join income_boundaries start_boundary on start_boundary.household_id=c.household_id and start_boundary.id=c.start_boundary_id
    join lateral(select br.state from income_boundary_revisions br where br.household_id=start_boundary.household_id
      and br.income_boundary_id=start_boundary.id order by br.version desc limit 1) start_state on start_state.state='verified'
    left join lateral(select next_boundary.id from income_boundaries next_boundary
      join lateral(select nr.state from income_boundary_revisions nr where nr.household_id=next_boundary.household_id
        and nr.income_boundary_id=next_boundary.id order by nr.version desc limit 1) next_state on next_state.state='verified'
      where next_boundary.household_id=start_boundary.household_id
        and (next_boundary.boundary_on,next_boundary.id)>(start_boundary.boundary_on,start_boundary.id)
      order by next_boundary.boundary_on,next_boundary.id limit 1) next_verified on true
    left join lateral(select rr.* from pay_cycle_report_revisions rr where rr.household_id=c.household_id and rr.pay_cycle_id=c.id order by rr.version desc limit 1) r on true
    where (${cycleId}::uuid is null or c.id=${cycleId}::uuid)
      and c.end_boundary_id is not distinct from next_verified.id
      and (${cursor?.startOn ?? null}::date is null or (c.start_on,c.id)<(${cursor?.startOn ?? null}::date,${cursor?.id ?? null}::uuid))
    order by c.start_on desc,c.id desc limit ${limit}`.execute(db)
  ).rows;
}
function mapCycle(row: any) {
  const moneyValue = (minor: any) => ({
    minor: String(minor ?? "0"),
    currency: "USD",
  });
  const output = row.output ?? {
    categories: [],
    incomeSources: [],
    commitments: [],
    savings: [],
  };
  return {
    id: row.id,
    startOn: row.start_on,
    endOn: row.end_on ?? null,
    status: row.end_on ? "completed" : "open",
    timezone: row.timezone_snapshot,
    updatedAfterBankCorrection: row.topology_reason === "boundary_correction",
    updatedAfterEvidenceChange:
      Boolean(row.end_on) && Number(row.report_version ?? 0) > 1,
    report: row.report_id
      ? {
          id: row.report_id,
          version: row.report_version,
          status: row.report_status,
          assurance: row.assurance,
          coverageReason: row.coverage_reason,
          calculatedAt: new Date(row.calculated_at).toISOString(),
          earned: moneyValue(row.earned_minor),
          spent: moneyValue(row.spent_minor),
          pending: moneyValue(row.pending_minor),
          saved: moneyValue(row.saved_minor),
          savingsWithdrawn: moneyValue(row.savings_withdrawn_minor),
          commitmentsExpected: moneyValue(row.commitments_expected_minor),
          commitmentsPaid: moneyValue(row.commitments_paid_minor),
          commitmentsRemaining: moneyValue(row.commitments_remaining_minor),
          debtPaid: moneyValue(row.debt_paid_minor),
          openingCash:
            row.opening_cash_minor === null
              ? null
              : moneyValue(row.opening_cash_minor),
          closingCash:
            row.closing_cash_minor === null
              ? null
              : moneyValue(row.closing_cash_minor),
          unexplainedDelta:
            row.unexplained_delta_minor === null
              ? null
              : moneyValue(row.unexplained_delta_minor),
          breakdown: output,
        }
      : null,
  };
}
function serializeBreakdown(
  report: ReturnType<typeof calculatePayCycleReport>,
) {
  const m = (minor: bigint) => ({ minor: minor.toString(), currency: "USD" });
  return {
    categories: report.categories.map((x) => ({
      name: x.name,
      amount: m(x.amountMinor),
    })),
    incomeSources: report.incomeSources.map((x) => ({
      name: x.name,
      amount: m(x.amountMinor),
    })),
    commitments: report.commitments.map((x) => ({
      id: x.id,
      name: x.name,
      expected: m(x.expectedMinor),
      paid: m(x.paidMinor),
      remaining: m(x.remainingMinor),
      state: x.state,
    })),
    savings: report.savings.map((x) => ({
      id: x.id,
      name: x.name,
      kind: x.kind,
      amount: m(x.amountMinor),
      effectiveOn: x.effectiveOn,
    })),
  };
}
async function latestBoundaryRevision(
  db: Transaction<Database>,
  principal: Principal,
  id: string,
) {
  return db
    .selectFrom("income_boundary_revisions")
    .selectAll()
    .where("household_id", "=", principal.householdId)
    .where("income_boundary_id", "=", id)
    .orderBy("version", "desc")
    .executeTakeFirst();
}
async function householdTimezone(
  db: Transaction<Database>,
  principal: Principal,
) {
  return (
    await db
      .selectFrom("households")
      .select("timezone")
      .where("id", "=", principal.householdId)
      .executeTakeFirstOrThrow()
  ).timezone;
}
function hashJson(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
async function transactionCutoff(db: Transaction<Database>) {
  return (
    await sql<{ cutoff: Date }>`select clock_timestamp() cutoff`.execute(db)
  ).rows[0]!.cutoff;
}
function addDays(value: string, days: number) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function toDateOnly(value: unknown) {
  return typeof value === "string"
    ? value.slice(0, 10)
    : new Date(value as any).toISOString().slice(0, 10);
}
function encodeCursor(row: any) {
  return Buffer.from(
    JSON.stringify({ startOn: row.start_on, id: row.id }),
  ).toString("base64url");
}
function decodeCursor(value: string) {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(parsed.startOn) ||
      typeof parsed.id !== "string"
    )
      throw new Error();
    return parsed as { startOn: string; id: string };
  } catch {
    throw new Error("PAY_CYCLE_CURSOR_INVALID");
  }
}
function encodePlanningCursor(row: any) {
  return Buffer.from(
    JSON.stringify({
      // node-postgres converts timestamptz to Date and truncates PostgreSQL's
      // microseconds. Keep the database text for a lossless seek cursor.
      recordedAt: row.recorded_at_cursor,
      id: row.id,
    }),
  ).toString("base64url");
}
function decodePlanningCursor(value: string) {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed.recordedAt !== "string" ||
      Number.isNaN(Date.parse(parsed.recordedAt)) ||
      typeof parsed.id !== "string"
    )
      throw new Error();
    return parsed as { recordedAt: string; id: string };
  } catch {
    throw new Error("PAY_CYCLE_CURSOR_INVALID");
  }
}
