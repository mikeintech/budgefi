import { Injectable } from "@nestjs/common";

export type PlaidEnvironment = "sandbox" | "development" | "production";
export type BudgefiEnvironment = "development" | "staging" | "production";

@Injectable()
export class PlaidConfig {
  readonly enabled = process.env.PLAID_ENABLED === "true";
  readonly environment = parseEnvironment(process.env.PLAID_ENV ?? "sandbox");
  readonly deploymentEnvironment = parseDeploymentEnvironment(
    process.env.BUDGEFI_ENV ??
      (process.env.NODE_ENV === "production" ? "production" : "development"),
  );
  readonly clientId = process.env.PLAID_CLIENT_ID?.trim() ?? "";
  readonly secret = process.env.PLAID_SECRET?.trim() ?? "";
  readonly webhookUrl = process.env.PLAID_WEBHOOK_URL?.trim() || null;
  readonly redirectUri = process.env.PLAID_REDIRECT_URI?.trim() || null;
  readonly nativeCompletionUri =
    process.env.PLAID_NATIVE_COMPLETION_URI?.trim() ||
    "budgefi://open/plaid-complete";
  readonly activeKeyId =
    process.env.PLAID_ACTIVE_TOKEN_KEY_ID?.trim() || "local-v1";
  readonly tokenKeys = parseTokenKeys();

  constructor() {
    if (!this.enabled) return;
    if (!this.clientId || !this.secret)
      throw new Error(
        "PLAID_CLIENT_ID and PLAID_SECRET are required when PLAID_ENABLED=true",
      );
    if (!this.tokenKeys.has(this.activeKeyId))
      throw new Error(
        "PLAID_ACTIVE_TOKEN_KEY_ID does not identify a configured 32-byte key",
      );
    if (process.env.NODE_ENV === "production") {
      if (
        this.deploymentEnvironment === "production" &&
        this.environment !== "production"
      )
        throw new Error("Production Budgefi must use PLAID_ENV=production");
      if (process.env.BUDGEFI_PROCESS_ROLE !== "plaid-worker") {
        if (!this.webhookUrl?.startsWith("https://"))
          throw new Error("Production Plaid requires an HTTPS PLAID_WEBHOOK_URL");
        if (!this.redirectUri?.startsWith("https://"))
          throw new Error(
            "Production Plaid requires an HTTPS PLAID_REDIRECT_URI for bank OAuth",
          );
        if (!this.nativeCompletionUri.startsWith("budgefi://"))
          throw new Error(
            "Production Plaid requires a budgefi:// PLAID_NATIVE_COMPLETION_URI",
          );
      }
      if (process.env.ALLOW_DEV_AUTH === "true")
        throw new Error(
          "Development authentication cannot be enabled with production Plaid",
        );
      if (!process.env.PLAID_TOKEN_KEYS)
        throw new Error("Production Plaid requires versioned PLAID_TOKEN_KEYS");
    }
  }
}

function parseDeploymentEnvironment(value: string): BudgefiEnvironment {
  if (value === "development" || value === "staging" || value === "production")
    return value;
  throw new Error("BUDGEFI_ENV must be development, staging, or production");
}

function parseEnvironment(value: string): PlaidEnvironment {
  if (value === "sandbox" || value === "development" || value === "production")
    return value;
  throw new Error("PLAID_ENV must be sandbox, development, or production");
}

function parseTokenKeys(): Map<string, Buffer> {
  const parsed = new Map<string, Buffer>();
  if (process.env.PLAID_TOKEN_KEYS) {
    const value: unknown = JSON.parse(process.env.PLAID_TOKEN_KEYS);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("PLAID_TOKEN_KEYS must be a JSON object");
    for (const [keyId, encoded] of Object.entries(value)) {
      if (typeof encoded !== "string")
        throw new Error(`Plaid token key ${keyId} must be base64`);
      parsed.set(keyId, decodeKey(encoded, keyId));
    }
  } else if (process.env.PLAID_TOKEN_ENCRYPTION_KEY) {
    parsed.set(
      process.env.PLAID_ACTIVE_TOKEN_KEY_ID?.trim() || "local-v1",
      decodeKey(process.env.PLAID_TOKEN_ENCRYPTION_KEY, "local-v1"),
    );
  }
  return parsed;
}

function decodeKey(encoded: string, keyId: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (
    key.length !== 32 ||
    key.toString("base64").replace(/=+$/, "") !==
      encoded.trim().replace(/=+$/, "")
  )
    throw new Error(
      `Plaid token key ${keyId} must be exactly 32 bytes of canonical base64`,
    );
  return key;
}
