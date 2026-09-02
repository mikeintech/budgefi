import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { createClerkClient, type ClerkClient } from "@clerk/backend";

const POLICY_CACHE_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class ClerkAccountPolicyService {
  private readonly client: ClerkClient | null;
  private readonly cache = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor() {
    const secretKey = process.env.CLERK_SECRET_KEY?.trim();
    this.client = secretKey ? createClerkClient({ secretKey }) : null;
  }

  async ensureManagedDeletion(clerkUserId: string): Promise<void> {
    if (!this.client) return;
    const now = Date.now();
    if ((this.cache.get(clerkUserId) ?? 0) > now) return;
    const active = this.inFlight.get(clerkUserId);
    if (active) return active;
    const operation = (async () => {
      try {
        await this.client!.users.updateUser(clerkUserId, {
          deleteSelfEnabled: false,
        });
        this.cache.set(clerkUserId, Date.now() + POLICY_CACHE_MS);
      } catch {
        this.cache.delete(clerkUserId);
        throw new ServiceUnavailableException(
          "Account safety policy could not be confirmed",
        );
      } finally {
        this.inFlight.delete(clerkUserId);
      }
    })();
    this.inFlight.set(clerkUserId, operation);
    return operation;
  }
}
