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
  ["00000000-0000-4000-8000-000000000401", "Rent", "185000", futureDate(1)],
  ["00000000-0000-4000-8000-000000000402", "Electric", "15500", futureDate(4)],
  ["00000000-0000-4000-8000-000000000403", "Subscriptions", "1899", futureDate(6)],
  ["00000000-0000-4000-8000-000000000404", "Insurance", "14240", futureDate(8)],
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
  for (const [id, name, amount, dueDate] of commitments) {
    await client.query("INSERT INTO commitments (id, household_id, name, amount_minor, currency, due_date, recurrence, provenance) VALUES ($1, $2, $3, $4, 'USD', $5, 'monthly', 'manual') ON CONFLICT (id) DO NOTHING", [id, ids.household, name, amount, dueDate]);
  }
  await client.query("INSERT INTO plans (id, household_id, planned_savings_minor, safety_buffer_minor, currency, calculation_policy_version) VALUES ($1, $2, 50000, 28000, 'USD', $3) ON CONFLICT (household_id) DO NOTHING", [ids.plan, ids.household, calculationPolicyVersion]);
  await client.query("INSERT INTO plan_revisions (household_id, plan_id, version, planned_savings_minor, safety_buffer_minor, currency, planning_horizon_days, policy_version) SELECT household_id, id, version, planned_savings_minor, safety_buffer_minor, currency, planning_horizon_days, calculation_policy_version FROM plans WHERE household_id = $1 ON CONFLICT DO NOTHING", [ids.household]);
  await client.query("INSERT INTO commitment_revisions (household_id, commitment_id, version, name, amount_minor, currency, due_date, active, settled_at) SELECT household_id, id, version, name, amount_minor, currency, due_date, active, settled_at FROM commitments WHERE household_id = $1 ON CONFLICT DO NOTHING", [ids.household]);
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
