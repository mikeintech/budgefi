import { describe, expect, it } from "vitest";
import {
  isUsableNativeAuthPending,
  nativeAuthPendingLifetimeMs,
  type NativeAuthPending,
} from "../../src/lib/native-flows.js";

const now = 1_800_000_000_000;
const pending = (overrides: Partial<NativeAuthPending> = {}): NativeAuthPending => ({
  state: "a".repeat(43),
  returnTo: "/onboarding?from=first-login",
  createdAt: now - 1_000,
  expiresAt: now + 1_000,
  ...overrides,
});

describe("native authentication handoff state", () => {
  it("accepts only an unexpired, local return with a bounded lifetime", () => {
    expect(isUsableNativeAuthPending(pending(), now)).toBe(true);
    expect(isUsableNativeAuthPending(pending({ expiresAt: now }), now)).toBe(false);
    expect(isUsableNativeAuthPending(pending({ returnTo: "//attacker.test" }), now)).toBe(false);
    expect(
      isUsableNativeAuthPending(
        pending({ expiresAt: now + nativeAuthPendingLifetimeMs + 1 }),
        now,
      ),
    ).toBe(false);
  });

  it("rejects old unversioned state and malformed anti-forgery values", () => {
    expect(isUsableNativeAuthPending(null, now)).toBe(false);
    expect(
      isUsableNativeAuthPending(
        pending({ state: "too-short", createdAt: Number.NaN }),
        now,
      ),
    ).toBe(false);
  });
});
