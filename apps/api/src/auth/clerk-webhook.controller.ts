import { Controller, Headers, HttpCode, Inject, Post, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { ClerkWebhookService } from "./clerk-webhook.service.js";

@Controller("clerk")
export class ClerkWebhookController {
  constructor(
    @Inject(ClerkWebhookService) private readonly webhooks: ClerkWebhookService,
  ) {}

  @Post("webhook")
  @HttpCode(202)
  receive(
    @Req() request: FastifyRequest & { rawBody?: Buffer },
    @Headers() rawHeaders: Record<string, string | string[] | undefined>,
  ) {
    if (!request.rawBody) throw new Error("Raw webhook body capture is not configured");
    const headers: Record<string, string | undefined> = {};
    for (const name of ["svix-id", "svix-timestamp", "svix-signature"]) {
      const value = rawHeaders[name];
      headers[name] = Array.isArray(value) ? value[0] : value;
    }
    return this.webhooks.receive(request.rawBody, headers);
  }
}
