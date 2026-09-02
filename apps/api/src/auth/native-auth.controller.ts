import { Body, Controller, HttpException, HttpStatus, Inject, Post, Req } from "@nestjs/common";
import { nativeAuthTicketRequestSchema } from "../../../../packages/contracts/src/index.js";
import { parseBody } from "../http/zod.js";
import type { AuthenticatedRequest } from "./request-auth.js";
import { NativeAuthService } from "./native-auth.service.js";

@Controller("native-auth")
export class NativeAuthController {
  private readonly attempts = new Map<string, { startedAt: number; count: number }>();
  constructor(@Inject(NativeAuthService) private readonly nativeAuth: NativeAuthService) {}

  @Post("ticket")
  ticket(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    this.take(request.identity.authSubject);
    return this.nativeAuth.createTicket(request.identity, parseBody(nativeAuthTicketRequestSchema, body));
  }

  private take(subject: string): void {
    if (process.env.NODE_ENV === "test") return;
    const now = Date.now();
    const current = this.attempts.get(subject);
    if (!current || now - current.startedAt >= 60_000) {
      this.attempts.set(subject, { startedAt: now, count: 1 });
      return;
    }
    current.count += 1;
    if (current.count > 6)
      throw new HttpException("Too many authentication handoffs; try again shortly", HttpStatus.TOO_MANY_REQUESTS);
  }
}
