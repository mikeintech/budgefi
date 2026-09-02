import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { verifyWebhook } from "@clerk/backend/webhooks";
import { sql, type Kysely } from "kysely";
import type { Database } from "../../../../packages/database/src/index.js";
import { DATABASE } from "../database/database.token.js";

@Injectable()
export class ClerkWebhookService {
  constructor(@Inject(DATABASE) private readonly database: Kysely<Database>) {}

  async receive(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): Promise<{ accepted: true; handled: boolean; duplicate: boolean }> {
    const secret = process.env.CLERK_WEBHOOK_SIGNING_SECRET?.trim();
    if (!secret)
      throw new ServiceUnavailableException("Clerk webhook is not configured");
    const eventId = headers["svix-id"];
    if (!eventId) throw new BadRequestException("Webhook event id is missing");
    const requestHeaders = new Headers({ "content-type": "application/json" });
    for (const name of ["svix-id", "svix-timestamp", "svix-signature"])
      if (headers[name]) requestHeaders.set(name, headers[name]!);
    let event: Awaited<ReturnType<typeof verifyWebhook>>;
    try {
      event = await verifyWebhook(
        new Request("https://api.budgefi.com/v1/clerk/webhook", {
          method: "POST",
          headers: requestHeaders,
          body: new Uint8Array(rawBody),
        }),
        { signingSecret: secret },
      );
    } catch {
      throw new BadRequestException("Webhook signature is invalid");
    }
    if (event.type !== "user.deleted")
      return { accepted: true, handled: false, duplicate: false };
    const userId = event.data.id;
    if (typeof userId !== "string" || !userId)
      throw new BadRequestException("Deleted user id is missing");
    const result = await this.database.transaction().execute(async (transaction) => {
      await sql`set local role budgefi_app`.execute(transaction);
      return sql<{ known: boolean; duplicate: boolean; queued_deletions: number }>`
        select * from ingest_verified_clerk_user_deleted(${eventId},${userId})
      `.execute(transaction);
    });
    return {
      accepted: true,
      handled: true,
      duplicate: result.rows[0]?.duplicate ?? false,
    };
  }
}
