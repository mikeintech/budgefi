import { isNativeApp } from "@/lib/platform";

let accessTokenProvider: (() => Promise<string>) | null = null;
let signOutProvider:(()=>Promise<void>)|null=null;

export const clerkPublishableKey = (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined)?.trim();
export const clerkConfigured = Boolean(clerkPublishableKey);

export function authRouteUrl(requestedPath = "/today"): string {
  const path = requestedPath.startsWith("/") && !requestedPath.startsWith("//") ? requestedPath : "/today";
  if (import.meta.env.VITE_ROUTER_MODE !== "hash") return path;
  const configuredBase = (import.meta.env.VITE_PUBLIC_APP_URL as string | undefined)?.replace(/\/$/, "");
  if (!configuredBase && isNativeApp) throw new Error("VITE_PUBLIC_APP_URL is required for native authentication callbacks");
  const base = configuredBase || window.location.href.split("#", 1)[0].replace(/\/$/, "");
  return `${base}/#${path}`;
}

export function setAccessTokenProvider(provider: (() => Promise<string>) | null): void {
  accessTokenProvider = provider;
}
export function setSignOutProvider(provider:(()=>Promise<void>)|null):void{signOutProvider=provider}
export async function signOutCurrentUser():Promise<boolean>{if(!signOutProvider)return false;await signOutProvider();return true}

export async function authorizationHeader(): Promise<Record<string, string>> {
  if (!accessTokenProvider) return {};
  const token = await accessTokenProvider();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function authCacheScope(): Promise<string | null> {
  if (!accessTokenProvider) return clerkConfigured ? null : "dev-local";
  const token = await accessTokenProvider();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { sub?: unknown };
    return typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  } catch { return null; }
}
