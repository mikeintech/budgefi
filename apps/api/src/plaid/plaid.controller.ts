import { Body, Controller, Headers, HttpCode, HttpException, HttpStatus, Inject, Param, Post, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { plaidExchangeRequestSchema, plaidHostedCompleteRequestSchema, plaidLinkTokenRequestSchema, plaidUpdateCompleteRequestSchema, uuidSchema } from "../../../../packages/contracts/src/index.js";
import type { AuthenticatedRequest } from "../auth/request-auth.js";
import { parseBody } from "../http/zod.js";
import { PlaidService } from "./plaid.service.js";

@Controller("plaid")
export class PlaidController {
  private readonly limiter = new LocalEndpointLimiter();
  constructor(@Inject(PlaidService) private readonly plaid: PlaidService) {}

  @Post("link-token")
  linkToken(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    this.limiter.take(`link:${request.identity.authSubject}`, 20, 60_000);
    return this.plaid.createLinkToken(request.identity, parseBody(plaidLinkTokenRequestSchema, body));
  }

  @Post("exchange")
  exchange(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    this.limiter.take(`exchange:${request.identity.authSubject}`, 10, 60_000);
    return this.plaid.exchange(request.identity, parseBody(plaidExchangeRequestSchema, body));
  }

  @Post("hosted-complete")
  hostedComplete(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    this.limiter.take(`hosted:${request.identity.authSubject}`, 12, 60_000);
    return this.plaid.completeHosted(request.identity, parseBody(plaidHostedCompleteRequestSchema, body));
  }

  @Post("update-complete")
  updateComplete(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    this.limiter.take(`update:${request.identity.authSubject}`, 10, 60_000);
    return this.plaid.completeUpdate(request.identity, parseBody(plaidUpdateCompleteRequestSchema, body));
  }

  @Post("connections/:connectionId/sync")
  sync(@Req() request: AuthenticatedRequest, @Param("connectionId") connectionId: string) {
    this.limiter.take(`sync:${request.identity.authSubject}`, 12, 60_000);
    return this.plaid.requestSync(request.identity, uuidSchema.parse(connectionId));
  }

  @Post("connections/:connectionId/disconnect")
  disconnect(@Req() request: AuthenticatedRequest, @Param("connectionId") connectionId: string) {
    this.limiter.take(`disconnect:${request.identity.authSubject}`, 6, 60_000);
    return this.plaid.disconnect(request.identity, uuidSchema.parse(connectionId));
  }

  @Post("webhook")
  @HttpCode(202)
  webhook(@Req() request: FastifyRequest & { rawBody?: Buffer }, @Headers("plaid-verification") signature?: string) {
    this.limiter.take(`webhook:${request.ip}`, 300, 60_000);
    if (!request.rawBody) throw new Error("Raw webhook body capture is not configured");
    return this.plaid.receiveWebhook(request.rawBody, signature);
  }
}

class LocalEndpointLimiter {
  private readonly buckets = new Map<string, { startedAt: number; count: number }>();
  take(key: string, limit: number, windowMs: number): void {
    if (process.env.NODE_ENV === "test") return;
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) { this.buckets.set(key, { startedAt: now, count: 1 }); return; }
    bucket.count += 1;
    if (bucket.count > limit) throw new HttpException("Too many Plaid requests; try again shortly", HttpStatus.TOO_MANY_REQUESTS);
    if (this.buckets.size > 10_000) for (const [entry, value] of this.buckets) if (now - value.startedAt >= windowMs) this.buckets.delete(entry);
  }
}
