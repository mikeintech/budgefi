import { Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { createClerkClient, type ClerkClient } from "@clerk/backend";
import {
  nativeAuthTicketResponseSchema,
  type NativeAuthTicketRequest,
  type NativeAuthTicketResponse,
} from "../../../../packages/contracts/src/index.js";
import type { RequestIdentity } from "../database/tenant-database.js";

const TICKET_LIFETIME_SECONDS = 60;

@Injectable()
export class NativeAuthService {
  private readonly client: ClerkClient | null;

  constructor() {
    const secretKey = process.env.CLERK_SECRET_KEY?.trim();
    this.client = secretKey ? createClerkClient({ secretKey }) : null;
  }

  async createTicket(identity: RequestIdentity, request: NativeAuthTicketRequest): Promise<NativeAuthTicketResponse> {
    if (!this.client)
      throw new ServiceUnavailableException("Native authentication requires CLERK_SECRET_KEY");
    if (!identity.authSubject.startsWith("clerk|"))
      throw new UnauthorizedException("A verified Clerk session is required");
    const userId = identity.authSubject.slice("clerk|".length);
    if (!userId) throw new UnauthorizedException("Clerk user identity is missing");
    const created = await this.client.signInTokens.createSignInToken({
      userId,
      expiresInSeconds: TICKET_LIFETIME_SECONDS,
    });
    return nativeAuthTicketResponseSchema.parse({
      state: request.state,
      ticket: created.token,
      expiresAt: new Date(Date.now() + TICKET_LIFETIME_SECONDS * 1_000).toISOString(),
    });
  }
}
