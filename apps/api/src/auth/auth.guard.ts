import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { verifyToken } from "@clerk/backend";
import type { FastifyRequest } from "fastify";
import type { AuthenticatedRequest } from "./request-auth.js";
import { ClerkAccountPolicyService } from "./clerk-account-policy.service.js";

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly secretKey = process.env.CLERK_SECRET_KEY?.trim();
  private readonly jwtKey = process.env.CLERK_JWT_KEY?.trim();
  private readonly authorizedParties = clerkAuthorizedParties();

  constructor(
    @Inject(ClerkAccountPolicyService)
    private readonly accountPolicy: ClerkAccountPolicyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>() as AuthenticatedRequest;
    const path = request.url.split("?", 1)[0];
    if (path === "/health" || path === "/v1/health" || path === "/plaid/webhook" || path === "/v1/plaid/webhook" || path === "/clerk/webhook" || path === "/v1/clerk/webhook") return true;
    const requestId = header(request, "x-request-id");
    const requestedHouseholdId = header(request, "x-household-id");
    const authorization = header(request, "authorization");
    if (this.secretKey || this.jwtKey) {
      if (!authorization?.startsWith("Bearer ")) throw new UnauthorizedException("Bearer token required");
      let claims;
      try {
        claims = await verifyToken(authorization.slice(7), {
          authorizedParties: this.authorizedParties,
          ...(this.secretKey ? { secretKey: this.secretKey } : {}),
          ...(this.jwtKey ? { jwtKey: this.jwtKey } : {}),
        });
      } catch {
        throw new UnauthorizedException("Invalid access token");
      }
      if (!claims.sub) throw new UnauthorizedException("Invalid access token");
      await this.accountPolicy.ensureManagedDeletion(claims.sub);
      request.identity = {
        authSubject: `clerk|${claims.sub}`,
        ...(typeof claims.name === "string" ? { displayName: claims.name } : {}),
        ...(typeof claims.email === "string" ? { email: claims.email } : {}),
        ...(requestedHouseholdId ? { requestedHouseholdId } : {}),
        ...(requestId ? { requestId } : {}),
      };
      return true;
    }
    if (process.env.NODE_ENV === "production" || process.env.ALLOW_DEV_AUTH !== "true") {
      throw new UnauthorizedException("Authentication is not configured");
    }
    request.identity = { authSubject: header(request, "x-dev-auth-subject") ?? "dev|maya", ...(requestedHouseholdId ? { requestedHouseholdId } : {}), ...(requestId ? { requestId } : {}) };
    return true;
  }
}

export function assertAuthConfiguration(): void {
  const hasSecretKey = Boolean(process.env.CLERK_SECRET_KEY?.trim());
  const hasVerificationKey = Boolean(hasSecretKey || process.env.CLERK_JWT_KEY?.trim());
  if (process.env.NODE_ENV === "production" && !hasSecretKey) {
    throw new Error("Production requires CLERK_SECRET_KEY for token verification and managed account deletion");
  }
  if (hasVerificationKey) {
    if (clerkAuthorizedParties().length === 0) throw new Error("Clerk authentication requires CLERK_AUTHORIZED_PARTIES or WEB_ORIGIN");
    return;
  }
  if (process.env.ALLOW_DEV_AUTH !== "true") throw new Error("Set ALLOW_DEV_AUTH=true explicitly for local development without Clerk");
}

function clerkAuthorizedParties(): string[] {
  const configured = process.env.CLERK_AUTHORIZED_PARTIES?.trim() || process.env.WEB_ORIGIN?.trim();
  if (configured) return configured.split(",").map((value) => value.trim().replace(/\/$/, "")).filter(Boolean);
  if (process.env.NODE_ENV !== "production") return ["http://localhost:4411", "http://127.0.0.1:4411"];
  return [];
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
