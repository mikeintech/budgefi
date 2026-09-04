import { describe, expect, it } from "vitest";
import { mutationFailureKeepsConfirmedData } from "../../src/lib/mutation-failure.js";

describe("mutation failure presentation", () => {
  it("keeps confirmed data visible for validation and conflict responses", () => {
    expect(mutationFailureKeepsConfirmedData({ status: 400 })).toBe(true);
    expect(mutationFailureKeepsConfirmedData({ status: 409 })).toBe(true);
  });

  it("downgrades ambiguous network and server failures", () => {
    expect(mutationFailureKeepsConfirmedData({ status: 0 })).toBe(false);
    expect(mutationFailureKeepsConfirmedData({ status: 500 })).toBe(false);
  });

  it("immediately gates data after rejected authentication or authorization", () => {
    expect(mutationFailureKeepsConfirmedData({ status: 401 })).toBe(false);
    expect(mutationFailureKeepsConfirmedData({ status: 403 })).toBe(false);
  });
});
