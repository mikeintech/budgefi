import { connect } from "node:http2";
import { createClerkClient } from "@clerk/backend";
import { importPKCS8, SignJWT } from "jose";
import { sql } from "kysely";
import { createDatabase } from "../../../packages/database/src/index.js";
import { NotificationTokenCrypto } from "../../api/src/operations/notification-token-crypto.js";

const workerDatabaseUrl =
  process.env.WORKER_DATABASE_URL ??
  (process.env.NODE_ENV === "production"
    ? undefined
    : process.env.DATABASE_URL);
if (!workerDatabaseUrl) throw new Error("WORKER_DATABASE_URL is required");
const database = createDatabase(workerDatabaseUrl);
const crypto = new NotificationTokenCrypto();
const runOnce = process.env.WORKER_RUN_MODE === "once";
const maxJobItems = positiveInteger("WORKER_JOB_MAX_ITEMS", 100);
const maxJobRuntimeMs = positiveInteger("WORKER_JOB_MAX_RUNTIME_MS", 240_000);
let stopping = false;
let nextSweep = 0;
await assertWorkerDatabaseRole();
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

if (runOnce) await runScheduledJob();
else await runDaemon();
await database.destroy();

async function runScheduledJob(): Promise<void> {
  const deadline = Date.now() + maxJobRuntimeMs;
  await sweep();
  for (
    let processed = 0;
    processed < maxJobItems && Date.now() < deadline && !stopping;
    processed += 1
  ) {
    const didWork = await processOneCycle();
    if (!didWork) break;
  }
}

async function runDaemon(): Promise<void> {
  while (!stopping) {
    if (Date.now() >= nextSweep) {
      await sweep();
      nextSweep = Date.now() + 60_000;
    }
    const didWork = await processOneCycle();
    if (!didWork) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function sweep(): Promise<void> {
  await workerCall(sql`select prune_financial_pattern_analyses()`).catch(
    (error) => console.error("pattern_analysis_prune_failed", safeError(error)),
  );
  // Exception reconciliation runs inside the tenant-scoped ingestion
  // transaction that changed the ledger. A global scan would weaken RLS and
  // duplicate expensive work without improving freshness.
  await workerCall(sql`select generate_notification_events()`).catch((error) =>
    console.error("notification_sweep_failed", safeError(error)),
  );
}

async function processOneCycle(): Promise<boolean> {
  const worked = await deliverOne().catch((error) => {
    console.error("notification_worker_failed", safeError(error));
    return false;
  });
  const finalized = await finalizeOne().catch((error) => {
    console.error("deletion_worker_failed", safeError(error));
    return false;
  });
  return worked || finalized;
}

async function assertWorkerDatabaseRole(): Promise<void> {
  const result = await sql<{
    current_user: string;
    is_superuser: boolean;
    bypasses_rls: boolean;
    owns_database: boolean;
    worker_member: boolean;
    app_member: boolean;
    can_claim: boolean;
    direct_table_read: boolean;
  }>`select current_user,
      current_setting('is_superuser')='on' as is_superuser,
      coalesce((select rolbypassrls from pg_roles where rolname=current_user),false) as bypasses_rls,
      (select datdba=(select oid from pg_roles where rolname=current_user) from pg_database where datname=current_database()) as owns_database,
      pg_has_role(current_user,'budgefi_worker','MEMBER') as worker_member,
      pg_has_role(current_user,'budgefi_app','MEMBER') as app_member,
      has_function_privilege('budgefi_worker','claim_notification_delivery()','EXECUTE') as can_claim,
      has_table_privilege(current_user,'notification_deliveries','SELECT') as direct_table_read`.execute(
    database,
  );
  const role = result.rows[0]!;
  if (
    role.is_superuser ||
    role.bypasses_rls ||
    role.owns_database ||
    !role.worker_member ||
    role.app_member ||
    !role.can_claim ||
    role.direct_table_read
  )
    throw new Error(`Unsafe worker database role ${role.current_user}`);
}

async function deliverOne(): Promise<boolean> {
  const result = await database.transaction().execute(async (transaction) => {
    await sql`set local role budgefi_worker`.execute(transaction);
    return sql<Delivery>`select * from claim_notification_delivery()`.execute(
      transaction,
    );
  });
  const delivery = result.rows[0];
  if (!delivery) return false;
  try {
    if (
      delivery.channel === "push" &&
      delivery.platform === "ios" &&
      delivery.encrypted_token &&
      delivery.token_key_id
    ) {
      const token = crypto.decrypt(
        delivery.encrypted_token,
        delivery.token_key_id,
        delivery.user_id,
      );
      await sendApns(
        token,
        delivery.lock_screen_detail
          ? delivery.title
          : "Budgefi needs your attention",
        delivery.lock_screen_detail
          ? delivery.body
          : "Open Budgefi to review a financial update.",
        delivery.deep_link_path,
      );
    } else if (delivery.channel === "email" && delivery.email_address)
      await sendEmail(
        delivery.email_address,
        delivery.title,
        delivery.body,
        delivery.deep_link_path,
      );
    else throw new Error("delivery_channel_not_configured");
    await finish(delivery.delivery_id, "sent", null);
  } catch (error) {
    const code = safeError(error);
    const permanent =
      code.startsWith("apns_400") ||
      code.startsWith("apns_410") ||
      code.startsWith("email_400") ||
      code.startsWith("email_401") ||
      code.startsWith("email_403");
    if (permanent && delivery.endpoint_id)
      await workerCall(
        sql`select disable_notification_endpoint(${delivery.endpoint_id}::uuid,${code})`,
      );
    await finish(delivery.delivery_id, permanent ? "dead" : "retry", code);
  }
  return true;
}

async function finalizeOne(): Promise<boolean> {
  const result = await database.transaction().execute(async (transaction) => {
    await sql`set local role budgefi_worker`.execute(transaction);
    return sql<Deletion>`select * from claim_account_deletion()`.execute(
      transaction,
    );
  });
  const deletion = result.rows[0];
  if (!deletion) return false;
  try {
    if (
      deletion.auth_subject.startsWith("clerk|") &&
      process.env.CLERK_SECRET_KEY
    ) {
      try {
        await createClerkClient({
          secretKey: process.env.CLERK_SECRET_KEY,
        }).users.deleteUser(deletion.auth_subject.slice(6));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    } else if (
      !deletion.auth_subject.startsWith("deleted|") &&
      process.env.NODE_ENV === "production"
    )
      throw new Error("clerk_deletion_not_configured");
    await workerCall(
      sql`select finalize_account_deletion(${deletion.request_id}::uuid)`,
    );
  } catch (error) {
    console.error(
      "account_deletion_finalize_failed",
      deletion.request_id,
      safeError(error),
    );
  }
  return true;
}

async function sendApns(
  deviceToken: string,
  title: string,
  body: string,
  path: string,
): Promise<void> {
  const teamId = required("APNS_TEAM_ID"),
    keyId = required("APNS_KEY_ID"),
    topic = required("APNS_TOPIC"),
    privateKey = required("APNS_PRIVATE_KEY").replace(/\\n/g, "\n");
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: keyId })
    .setIssuer(teamId)
    .setIssuedAt()
    .sign(await importPKCS8(privateKey, "ES256"));
  const authority =
    process.env.APNS_ENV === "production"
      ? "https://api.push.apple.com"
      : "https://api.sandbox.push.apple.com";
  const payload = JSON.stringify({
    aps: { alert: { title, body }, sound: "default" },
    path,
  });
  await new Promise<void>((resolve, reject) => {
    const client = connect(authority);
    client.setTimeout(10_000, () => client.destroy(new Error("apns_timeout")));
    client.on("error", reject);
    const request = client.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": topic,
      "apns-push-type": "alert",
      "content-type": "application/json",
    });
    let status = 0,
      response = "";
    request.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0);
    });
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      response += chunk;
    });
    request.on("end", () => {
      client.close();
      status === 200
        ? resolve()
        : reject(new Error(`apns_${status}_${response.slice(0, 80)}`));
    });
    request.on("error", (error) => {
      client.close();
      reject(error);
    });
    request.end(payload);
  });
}

async function sendEmail(
  to: string,
  subject: string,
  body: string,
  path: string,
): Promise<void> {
  const apiKey = required("RESEND_API_KEY"),
    from = required("NOTIFICATION_FROM_EMAIL"),
    publicUrl = required("PUBLIC_APP_URL").replace(/\/$/, "");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text: `${body}\n\nOpen Budgefi: ${publicUrl}${path}`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`email_${response.status}`);
}

async function finish(
  id: string,
  state: "sent" | "retry" | "dead" | "suppressed",
  error: string | null,
) {
  await workerCall(
    sql`select finish_notification_delivery(${id}::uuid, ${state}, ${error})`,
  );
}
async function workerCall(query: any) {
  return database.transaction().execute(async (transaction) => {
    await sql`set local role budgefi_worker`.execute(transaction);
    return query.execute(transaction);
  });
}
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name.toLocaleLowerCase()}_not_configured`);
  return value;
}
function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name.toLocaleLowerCase()}_invalid`);
  return value;
}
function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 120) : "unknown_error";
}
function isNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "status" in error &&
      (error as { status?: unknown }).status === 404,
  );
}
type Delivery = {
  delivery_id: string;
  household_id: string;
  user_id: string;
  endpoint_id: string | null;
  channel: string;
  platform: string | null;
  encrypted_token: Uint8Array | null;
  token_key_id: string | null;
  email_address: string | null;
  title: string;
  body: string;
  deep_link_path: string;
  lock_screen_detail: boolean;
  attempts: number;
};
type Deletion = {
  request_id: string;
  user_id: string;
  household_id: string;
  auth_subject: string;
};
