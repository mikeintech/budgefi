import pg from "pg";
import { calculationPolicyVersion } from "../../../../packages/domain/src/index.js";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const ids = {
  user: "00000000-0000-4000-8000-000000000001",
  household: "00000000-0000-4000-8000-000000000101",
  cashAccount: "00000000-0000-4000-8000-000000000201",
  plan: "00000000-0000-4000-8000-000000000301",
};

const commitments = [
  ["00000000-0000-4000-8000-000000000401", "Rent", "185000", futureDate(1), "housing"],
  ["00000000-0000-4000-8000-000000000402", "Electric", "15500", futureDate(4), "utilities"],
  ["00000000-0000-4000-8000-000000000403", "Subscriptions", "1899", futureDate(6), "subscriptions"],
  ["00000000-0000-4000-8000-000000000404", "Insurance", "14240", futureDate(8), "insurance"],
] as const;

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("INSERT INTO users (id, auth_subject, display_name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING", [ids.user, "dev|maya", "Maya"]);
  await client.query("INSERT INTO households (id, name, timezone, base_currency) VALUES ($1, $2, $3, 'USD') ON CONFLICT (id) DO NOTHING", [ids.household, "Maya & Alex", "America/New_York"]);
  await client.query("INSERT INTO household_memberships (household_id, user_id, role, onboarding_completed_at) VALUES ($1, $2, 'owner', now()) ON CONFLICT (household_id, user_id) DO UPDATE SET onboarding_completed_at = coalesce(household_memberships.onboarding_completed_at, excluded.onboarding_completed_at)", [ids.household, ids.user]);
  await client.query("INSERT INTO accounts (id, household_id, name, account_type, currency, provenance, include_in_plan) VALUES ($1, $2, 'Manual spendable cash', 'cash', 'USD', 'manual', true) ON CONFLICT (id) DO UPDATE SET include_in_plan = true", [ids.cashAccount, ids.household]);
  await client.query("INSERT INTO balance_observations (household_id, account_id, amount_minor, currency, provenance, as_of, source_record_id) VALUES ($1, $2, 423039, 'USD', 'manual', now(), 'seed-balance-v1') ON CONFLICT DO NOTHING", [ids.household, ids.cashAccount]);
  for (const [id, name, amount, dueDate, setupSlot] of commitments) {
    await client.query("INSERT INTO commitments (id, household_id, name, amount_minor, currency, due_date, recurrence, provenance, setup_slot) VALUES ($1, $2, $3, $4, 'USD', $5, 'monthly', 'manual', $6) ON CONFLICT (id) DO NOTHING", [id, ids.household, name, amount, dueDate, setupSlot]);
  }
  await client.query("INSERT INTO commitment_revisions (household_id, commitment_id, version, name, amount_minor, currency, due_date, active, settled_at) SELECT household_id, id, version, name, amount_minor, currency, due_date, active, settled_at FROM commitments WHERE household_id = $1 ON CONFLICT DO NOTHING", [ids.household]);
  await client.query("INSERT INTO plans (id, household_id, planned_savings_minor, safety_buffer_minor, currency, calculation_policy_version) VALUES ($1, $2, 50000, 28000, 'USD', $3) ON CONFLICT (household_id) DO NOTHING", [ids.plan, ids.household, calculationPolicyVersion]);
  await client.query("INSERT INTO savings_goals(household_id,name,contribution_amount_minor,schedule,status,currency,provenance) SELECT $1,'General savings',50000,'planning_period','active','USD','manual' WHERE NOT EXISTS (SELECT 1 FROM savings_goals WHERE household_id=$1 AND status<>'archived')", [ids.household]);
  await client.query("INSERT INTO savings_goal_revisions(household_id,savings_goal_id,destination_account_id,name,target_amount_minor,target_date,contribution_amount_minor,schedule,next_due_on,status,currency,provenance,version,reason) SELECT household_id,id,destination_account_id,name,target_amount_minor,target_date,contribution_amount_minor,schedule,next_due_on,status,currency,provenance,version,'Local seed' FROM savings_goals WHERE household_id=$1 ON CONFLICT DO NOTHING", [ids.household]);
  await client.query("INSERT INTO plan_occurrences (household_id,source_key,kind,commitment_id,name,expected_amount_minor,expected_on,provenance) SELECT household_id,'commitment:'||id::text,'commitment',id,name,amount_minor,due_date,provenance FROM commitments WHERE household_id=$1 AND due_date IS NOT NULL ON CONFLICT DO NOTHING", [ids.household]);
  await client.query("INSERT INTO plan_occurrences (household_id,source_key,kind,savings_goal_id,name,expected_amount_minor,expected_on,provenance) SELECT g.household_id,'savings-goal:'||g.id::text,'savings',g.id,g.name,g.contribution_amount_minor,(current_date+p.fallback_horizon_days),g.provenance FROM savings_goals g JOIN plans p ON p.household_id=g.household_id WHERE g.household_id=$1 AND g.status='active' AND g.contribution_amount_minor>0 ON CONFLICT DO NOTHING", [ids.household]);
  await client.query("INSERT INTO plan_occurrence_revisions (household_id,occurrence_id,version,state,matched_amount_minor,reason) SELECT household_id,id,version,state,matched_amount_minor,'Local seed' FROM plan_occurrences WHERE household_id=$1 ON CONFLICT DO NOTHING", [ids.household]);
  await client.query("INSERT INTO plan_revisions (household_id, plan_id, version, planned_savings_minor, safety_buffer_minor, currency, planning_horizon_days, policy_version) SELECT household_id, id, version, planned_savings_minor, safety_buffer_minor, currency, planning_horizon_days, calculation_policy_version FROM plans WHERE household_id = $1 ON CONFLICT DO NOTHING", [ids.household]);
  await client.query("INSERT INTO activity_events (household_id, actor_user_id, event_type, title, detail, provenance) SELECT $1, $2, 'workspace.created', 'Manual workspace ready', 'Seeded for local development with explicit manual provenance', 'manual' WHERE NOT EXISTS (SELECT 1 FROM activity_events WHERE household_id = $1 AND event_type = 'workspace.created')", [ids.household, ids.user]);
  await client.query("COMMIT");
  process.stdout.write("Seeded local Budgefi household\n");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}

function futureDate(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
