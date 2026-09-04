import { describe, expect, it } from "vitest";
import { shouldAcceptBootstrap } from "../../src/lib/bootstrap-version.js";

describe("bootstrap version isolation", () => {
  it("rejects an older response for the same household", () => {
    expect(shouldAcceptBootstrap("house-a", 8n, "house-a", 7n)).toBe(false);
  });

  it("accepts a lower revision when the authenticated household changes", () => {
    expect(shouldAcceptBootstrap("house-a", 50n, "house-b", 1n)).toBe(true);
  });

  it("accepts the first and equal-revision snapshots", () => {
    expect(shouldAcceptBootstrap(null, 0n, "house-a", 0n)).toBe(true);
    expect(shouldAcceptBootstrap("house-a", 4n, "house-a", 4n)).toBe(true);
  });
});
