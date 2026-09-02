import { afterEach, describe, expect, it } from "vitest";
import { assertAuthConfiguration } from "../../apps/api/src/auth/auth.guard.js";

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
});

describe("authentication startup policy", () => {
  it("requires an explicit local opt-in", () => {
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_JWT_KEY;
    delete process.env.ALLOW_DEV_AUTH;
    process.env.NODE_ENV = "development";
    expect(() => assertAuthConfiguration()).toThrow(/ALLOW_DEV_AUTH=true/);
  });

  it("accepts Clerk verification with an authorized frontend", () => {
    process.env.CLERK_SECRET_KEY = "sk_test_example";
    process.env.CLERK_AUTHORIZED_PARTIES = "https://app.example.com";
    expect(() => assertAuthConfiguration()).not.toThrow();
  });

  it("never permits development identity headers in production", () => {
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_JWT_KEY;
    process.env.ALLOW_DEV_AUTH = "true";
    process.env.NODE_ENV = "production";
    expect(() => assertAuthConfiguration()).toThrow(/Production requires CLERK_SECRET_KEY/);
  });

  it("requires the Clerk server key in production even when a JWT key exists", () => {
    delete process.env.CLERK_SECRET_KEY;
    process.env.CLERK_JWT_KEY = "-----BEGIN PUBLIC KEY-----\nexample\n-----END PUBLIC KEY-----";
    process.env.CLERK_AUTHORIZED_PARTIES = "https://app.example.com";
    process.env.NODE_ENV = "production";
    expect(() => assertAuthConfiguration()).toThrow(/CLERK_SECRET_KEY/);
  });

  it("requires an authorized frontend in production", () => {
    process.env.CLERK_SECRET_KEY = "sk_test_example";
    delete process.env.CLERK_AUTHORIZED_PARTIES;
    delete process.env.WEB_ORIGIN;
    process.env.NODE_ENV = "production";
    expect(() => assertAuthConfiguration()).toThrow(/CLERK_AUTHORIZED_PARTIES/);
  });
});
