import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlaidConfig } from "../../apps/api/src/plaid/plaid.config.js";
import { PlaidTokenCrypto } from "../../apps/api/src/plaid/token-crypto.js";

const names = ["PLAID_ENABLED", "PLAID_ENV", "PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_TOKEN_ENCRYPTION_KEY", "PLAID_TOKEN_KEYS", "PLAID_ACTIVE_TOKEN_KEY_ID"] as const;
const original = new Map(names.map((name) => [name, process.env[name]]));

describe("PlaidTokenCrypto", () => {
  beforeEach(() => {
    process.env.PLAID_ENABLED = "true";
    process.env.PLAID_ENV = "sandbox";
    process.env.PLAID_CLIENT_ID = "test-client";
    process.env.PLAID_SECRET = "test-secret";
    process.env.PLAID_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
    delete process.env.PLAID_TOKEN_KEYS;
    process.env.PLAID_ACTIVE_TOKEN_KEY_ID = "local-v1";
  });

  afterEach(() => {
    for (const name of names) {
      const value = original.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("round-trips only with the exact Item-bound associated data", () => {
    const crypto = new PlaidTokenCrypto(new PlaidConfig());
    const context = { environment: "sandbox" as const, itemId: "item-1", connectionId: "connection-1" };
    const envelope = crypto.encrypt("access-token-secret", context);
    expect(Buffer.from(envelope.encrypted).toString("utf8")).not.toContain("access-token-secret");
    expect(crypto.decrypt(envelope.encrypted, envelope.keyId, context)).toBe("access-token-secret");
    expect(() => crypto.decrypt(envelope.encrypted, envelope.keyId, { ...context, connectionId: "connection-2" })).toThrow(/authentication failed/);
  });

  it("fails closed when ciphertext, key metadata, or the active key is wrong", () => {
    const crypto = new PlaidTokenCrypto(new PlaidConfig());
    const context = { environment: "sandbox" as const, itemId: "item-1", connectionId: "connection-1" };
    const envelope = crypto.encrypt("access-token-secret", context);
    const decoded = JSON.parse(Buffer.from(envelope.encrypted).toString("utf8")) as { tag: string };
    decoded.tag = `${decoded.tag.startsWith("A") ? "B" : "A"}${decoded.tag.slice(1)}`;
    const tampered = Buffer.from(JSON.stringify(decoded));
    expect(() => crypto.decrypt(tampered, envelope.keyId, context)).toThrow();
    expect(() => crypto.decrypt(envelope.encrypted, "retired-key", context)).toThrow(/metadata does not match/);
    process.env.PLAID_TOKEN_ENCRYPTION_KEY = Buffer.alloc(31).toString("base64");
    expect(() => new PlaidConfig()).toThrow(/exactly 32 bytes/);
  });

  it("decrypts old envelopes while a new versioned key is active", () => {
    const oldKey = Buffer.alloc(32, 2).toString("base64");
    const newKey = Buffer.alloc(32, 3).toString("base64");
    delete process.env.PLAID_TOKEN_ENCRYPTION_KEY;
    process.env.PLAID_TOKEN_KEYS = JSON.stringify({ "kms-v1": oldKey, "kms-v2": newKey });
    process.env.PLAID_ACTIVE_TOKEN_KEY_ID = "kms-v1";
    const oldCrypto = new PlaidTokenCrypto(new PlaidConfig());
    const context = { environment: "sandbox" as const, itemId: "item-1", connectionId: "connection-1" };
    const oldEnvelope = oldCrypto.encrypt("rotatable-token", context);
    process.env.PLAID_ACTIVE_TOKEN_KEY_ID = "kms-v2";
    const rotatedCrypto = new PlaidTokenCrypto(new PlaidConfig());
    expect(rotatedCrypto.decrypt(oldEnvelope.encrypted, oldEnvelope.keyId, context)).toBe("rotatable-token");
    expect(rotatedCrypto.encrypt("new-token", context).keyId).toBe("kms-v2");
  });
});
