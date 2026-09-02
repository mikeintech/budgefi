import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { PlaidService } from "../../api/src/plaid/plaid.service.js";
import { PlaidWorkerModule } from "./plaid-worker.module.js";

process.env.PLAID_WORKER_DISABLED = "true";
process.env.BUDGEFI_PROCESS_ROLE = "plaid-worker";
if (process.env.PLAID_WORKER_DATABASE_URL)
  process.env.RUNTIME_DATABASE_URL = process.env.PLAID_WORKER_DATABASE_URL;

const maxItems = positiveInteger("PLAID_JOB_MAX_ITEMS", 100);
const maxRuntimeMs = positiveInteger("PLAID_JOB_MAX_RUNTIME_MS", 240_000);
const application = await NestFactory.createApplicationContext(PlaidWorkerModule, {
  logger: ["error", "warn", "log"],
});

try {
  const plaid = application.get(PlaidService);
  const scheduled = await plaid.scheduleMaintenance();
  const deadline = Date.now() + maxRuntimeMs;
  let processed = 0;
  while (processed < maxItems && Date.now() < deadline) {
    if ((await plaid.processNextJob()) === "empty") break;
    processed += 1;
  }
  console.log(
    JSON.stringify({
      severity: "INFO",
      event: "plaid_worker_complete",
      scheduled,
      processed,
    }),
  );
} finally {
  await application.close();
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}
