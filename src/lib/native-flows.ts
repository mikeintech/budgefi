export const nativePlaidPendingKey = "plaid-hosted-pending";
export const webPlaidPendingKey = "budgefi-plaid-oauth-pending";
export const nativeAuthStateKey = "auth-browser-state";
export const nativeAuthCallbackKey = "auth-browser-callback";

export type NativePlaidPending = {
  sessionId: string;
  linkToken: string;
  mode: "create" | "update";
};

export type NativeAuthPending = {
  state: string;
  returnTo: string;
  createdAt: number;
  expiresAt: number;
};

export type NativeAuthCallback = {
  state: string;
  ticket: string;
};

export const nativeAuthPendingLifetimeMs = 15 * 60 * 1000;

export function isUsableNativeAuthPending(
  pending: NativeAuthPending | null,
  now = Date.now(),
): pending is NativeAuthPending {
  return Boolean(
    pending &&
      /^[A-Za-z0-9_-]{43,128}$/.test(pending.state) &&
      pending.returnTo.startsWith("/") &&
      !pending.returnTo.startsWith("//") &&
      Number.isFinite(pending.createdAt) &&
      Number.isFinite(pending.expiresAt) &&
      pending.createdAt <= now &&
      pending.expiresAt > now &&
      pending.expiresAt - pending.createdAt <= nativeAuthPendingLifetimeMs,
  );
}
