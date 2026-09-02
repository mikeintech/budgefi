import { Capacitor } from "@capacitor/core";

export const isNativeApp = Capacitor.isNativePlatform();
export const nativePlatform = isNativeApp ? Capacitor.getPlatform() : "web";

export function appPathFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const rawCandidate = url.hash.startsWith("#/")
      ? url.hash.slice(1)
      : url.pathname;
    const candidate = rawCandidate.startsWith("/open/")
      ? rawCandidate.slice("/open".length)
      : rawCandidate;
    if (!candidate.startsWith("/") || candidate.startsWith("//")) return null;
    const allowed = [
      "/today",
      "/review",
      "/plan",
      "/activity",
      "/more",
      "/connections",
      "/manual",
      "/settings",
      "/onboarding",
      "/sign-in",
      "/sign-up",
    ];
    return allowed.some(
      (prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`)
    )
      ? `${candidate}${url.search}`
      : null;
  } catch {
    return null;
  }
}

export function apiBaseUrl(): string {
  const configured = (
    (isNativeApp ? import.meta.env.VITE_NATIVE_API_BASE_URL : undefined) ??
    import.meta.env.VITE_API_BASE_URL ??
    "/api/v1"
  ).replace(/\/$/, "");
  if (!isNativeApp) return configured;
  if (!/^https?:\/\//.test(configured))
    throw new Error("The mobile app requires an absolute API URL");
  if (import.meta.env.PROD && !configured.startsWith("https://"))
    throw new Error("The production mobile app requires an HTTPS API URL");
  return configured;
}
