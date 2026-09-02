import { createHash } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import type { Transaction } from "kysely";
import type { Database } from "../../../../packages/database/src/index.js";

export type MutationReceipt = Readonly<{ operation: string; resourceId: string }>;

export async function idempotent(
  transaction: Transaction<Database>,
  householdId: string,
  requestId: string,
  operation: string,
  request: unknown,
  work: () => Promise<MutationReceipt>,
): Promise<MutationReceipt> {
  const requestHash = createHash("sha256").update(stableJson(request)).digest("hex");
  const inserted = await transaction.insertInto("idempotency_records").values({ household_id: householdId, request_id: requestId, operation, request_hash: requestHash, response_status: null, response_body: null }).onConflict((conflict) => conflict.columns(["household_id", "request_id"]).doNothing()).returning("request_id").executeTakeFirst();
  if (!inserted) {
    const existing = await transaction.selectFrom("idempotency_records").selectAll().where("household_id", "=", householdId).where("request_id", "=", requestId).executeTakeFirstOrThrow();
    if (existing.operation !== operation || existing.request_hash !== requestHash) throw new ConflictException("Idempotency key was reused with different input");
    if (!existing.response_body) throw new ConflictException("Matching request is still being processed");
    return existing.response_body as MutationReceipt;
  }
  const response = await work();
  await transaction.updateTable("idempotency_records").set({ response_status: 200, response_body: response }).where("household_id", "=", householdId).where("request_id", "=", requestId).execute();
  return response;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
