import { Configuration, PlaidApi, PlaidEnvironments, Products } from "plaid";

const clientId = required("PLAID_CLIENT_ID");
const secret = required("PLAID_SECRET");
const apiBase = process.env.PLAID_SMOKE_API_BASE ?? "http://127.0.0.1:4422/v1";
const subject = `dev|plaid-smoke-${Date.now()}`;
const headers = { "content-type": "application/json", "x-dev-auth-subject": subject };
const plaid = new PlaidApi(new Configuration({ basePath: PlaidEnvironments.sandbox, baseOptions: { headers: { "PLAID-CLIENT-ID": clientId, "PLAID-SECRET": secret } } }));
let connectionId = null;

try {
  const link = await appRequest("/plaid/link-token", { mode: "create" });
  const publicToken = await plaid.sandboxPublicTokenCreate({ institution_id: "ins_109508", initial_products: [Products.Transactions] });
  const exchange = await appRequest("/plaid/exchange", { sessionId: link.sessionId, publicToken: publicToken.data.public_token, institution: { id: "ins_109508", name: "First Platypus Bank" }, requestId: crypto.randomUUID() }, true);
  let bootstrap = exchange.ok ? exchange.payload : await appRequest("/bootstrap", undefined);
  connectionId = bootstrap.connections?.find((connection) => connection.provider === "plaid" && connection.environment === "sandbox")?.id ?? null;
  if (!connectionId) throw new Error(`Budgefi did not persist the Sandbox Item. Exchange response: ${JSON.stringify(exchange.payload)}`);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const connection = bootstrap.connections.find((item) => item.id === connectionId);
    if (connection?.status === "healthy" && connection.initialUpdateComplete) break;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const sync = await appRequest(`/plaid/connections/${connectionId}/sync`, {}, true);
    bootstrap = sync.ok ? sync.payload : await appRequest("/bootstrap", undefined);
  }
  const connection = bootstrap.connections.find((item) => item.id === connectionId);
  if (connection?.status !== "healthy" || !connection.initialUpdateComplete) throw new Error(`Sandbox sync did not become healthy: ${JSON.stringify(connection)}`);
  const plaidAccounts = bootstrap.accounts.filter((account) => account.connectionId === connectionId);
  if (!plaidAccounts.length || plaidAccounts.some((account) => account.includeInPlan)) throw new Error("Sandbox accounts were not provisioned conservatively");
  process.stdout.write(`Live Plaid Sandbox smoke passed: ${plaidAccounts.length} account(s), verified initial sync, all excluded by default\n`);
} finally {
  if (connectionId) {
    const cleanup = await appRequest(`/plaid/connections/${connectionId}/disconnect`, {}, true);
    if (!cleanup.ok) process.stderr.write(`Sandbox cleanup needs retry: ${JSON.stringify(cleanup.payload)}\n`);
  }
}

async function appRequest(path, body, returnFailure = false) {
  const response = await fetch(`${apiBase}${path}`, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const payload = await response.json().catch(() => null);
  if (!response.ok && !returnFailure) throw new Error(`${response.status} ${path}: ${JSON.stringify(payload)}`);
  return returnFailure ? { ok: response.ok, payload } : payload;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the opt-in live Sandbox smoke test`);
  return value;
}
