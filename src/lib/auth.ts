import { isNativeApp } from "@/lib/platform";
import { within } from "@/lib/async-timeout";

type AccessTokenOptions = { forceRefresh?: boolean };
type AccessTokenProvider = (options?: AccessTokenOptions) => Promise<string>;

let accessTokenProvider: AccessTokenProvider | null = null;
let signOutProvider: (() => Promise<void>) | null = null;

export const clerkPublishableKey = (
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined
)?.trim();
export const clerkConfigured = Boolean(clerkPublishableKey);

export function authRouteUrl(requestedPath = "/today"): string {
  const path =
    requestedPath.startsWith("/") && !requestedPath.startsWith("//")
      ? requestedPath
      : "/today";
  if (import.meta.env.VITE_ROUTER_MODE !== "hash") return path;
  const configuredBase = (
    import.meta.env.VITE_PUBLIC_APP_URL as string | undefined
  )?.replace(/\/$/, "");
  if (!configuredBase && isNativeApp)
    throw new Error(
      "VITE_PUBLIC_APP_URL is required for native authentication callbacks",
    );
  const base =
    configuredBase || window.location.href.split("#", 1)[0].replace(/\/$/, "");
  return `${base}/#${path}`;
}

export function setAccessTokenProvider(
  provider: AccessTokenProvider | null,
): void {
  accessTokenProvider = provider;
}
export function setSignOutProvider(
  provider: (() => Promise<void>) | null,
): void {
  signOutProvider = provider;
}
export async function signOutCurrentUser(): Promise<boolean> {
  if (!signOutProvider) return false;
  await signOutProvider();
  return true;
}

async function accessTokenWithin(
  options: AccessTokenOptions = {},
  timeoutMs = 10_000,
): Promise<string> {
  if (!accessTokenProvider) return "";
  return within(
    accessTokenProvider(options),
    timeoutMs,
    "Your secure session took too long to refresh. Try again.",
  );
}

export async function authorizationHeader(
  options: AccessTokenOptions & { timeoutMs?: number } = {},
): Promise<Record<string, string>> {
  if (!accessTokenProvider) return {};
  const token = await accessTokenWithin(options, options.timeoutMs);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function authCacheScope(): Promise<string | null> {
  if (!accessTokenProvider) return clerkConfigured ? null : "dev-local";
  const token = await accessTokenWithin({}, 10_000);
  if (!token) return null;
  try {
    const payload = JSON.parse(
      atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")),
    ) as { sub?: unknown };
    return typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}
