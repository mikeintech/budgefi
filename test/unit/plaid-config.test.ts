import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlaidConfig } from "../../apps/api/src/plaid/plaid.config.js";

const names = [
  "NODE_ENV",
  "BUDGEFI_ENV",
  "ALLOW_DEV_AUTH",
  "PLAID_ENABLED",
  "PLAID_ENV",
  "PLAID_CLIENT_ID",
  "PLAID_SECRET",
  "PLAID_TOKEN_KEYS",
  "PLAID_ACTIVE_TOKEN_KEY_ID",
  "PLAID_WEBHOOK_URL",
  "PLAID_REDIRECT_URI",
  "PLAID_NATIVE_COMPLETION_URI",
] as const;
const original = new Map(names.map((name) => [name, process.env[name]]));

describe("PlaidConfig deployment boundaries", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
    process.env.ALLOW_DEV_AUTH = "false";
    process.env.PLAID_ENABLED = "true";
    process.env.PLAID_CLIENT_ID = "test-client";
    process.env.PLAID_SECRET = "test-secret";
    process.env.PLAID_TOKEN_KEYS = JSON.stringify({
      "staging-v1": Buffer.alloc(32, 7).toString("base64"),
    });
    process.env.PLAID_ACTIVE_TOKEN_KEY_ID = "staging-v1";
    process.env.PLAID_WEBHOOK_URL = "https://api.example.test/v1/plaid/webhook";
    process.env.PLAID_REDIRECT_URI =
      "https://app.example.test/open/plaid-oauth";
    process.env.PLAID_NATIVE_COMPLETION_URI = "budgefi://open/plaid-complete";
  });

  afterEach(() => {
    for (const name of names) {
      const value = original.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("allows Plaid Sandbox only when the hardened deployment is explicitly staging", () => {
    process.env.BUDGEFI_ENV = "staging";
    process.env.PLAID_ENV = "sandbox";
    expect(new PlaidConfig().environment).toBe("sandbox");
  });

  it("keeps production as the fail-closed default for a production runtime", () => {
    delete process.env.BUDGEFI_ENV;
    process.env.PLAID_ENV = "sandbox";
    expect(() => new PlaidConfig()).toThrow(/must use PLAID_ENV=production/);
  });

  it("allows trial production data in an explicitly staging Budgefi deployment", () => {
    process.env.BUDGEFI_ENV = "staging";
    process.env.PLAID_ENV = "production";
    expect(new PlaidConfig().environment).toBe("production");
  });
});
