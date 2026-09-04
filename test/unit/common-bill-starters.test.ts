import { describe, expect, it } from "vitest";
import { untouchedStarterKey } from "../../src/lib/common-bill-starters.js";

const starter = {
  id: "starter-local",
  name: "Phone & internet",
  amount: 0,
  dueDate: "",
  recurrence: "monthly" as const,
  starterItemKey: "phone_internet" as const,
};

describe("common bill starter identity", () => {
  it("keeps the marker only for a new untouched empty row", () => {
    expect(untouchedStarterKey(starter, false)).toBe("phone_internet");
    expect(untouchedStarterKey({ ...starter, amount: 90 }, false)).toBeUndefined();
    expect(untouchedStarterKey({ ...starter, dueDate: "2026-09-15" }, false)).toBeUndefined();
    expect(untouchedStarterKey({ ...starter, name: "Verizon" }, false)).toBeUndefined();
    expect(untouchedStarterKey(starter, true)).toBeUndefined();
  });
});
