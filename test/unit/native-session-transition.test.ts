import { describe, expect, it } from "vitest";
import { shouldGateNativeSessionTransition } from "../../src/lib/native-session-transition.js";

describe("native session transition render gate", () => {
  it("withholds children on the first render after A changes to B", () => {
    expect(shouldGateNativeSessionTransition("session-a", "session-b", true)).toBe(true);
  });

  it("withholds children while a signed-in native session becomes anonymous", () => {
    expect(shouldGateNativeSessionTransition("session-a", null, true)).toBe(true);
  });

  it("does not gate the initial, stable, or web render", () => {
    expect(shouldGateNativeSessionTransition(null, "session-a", true)).toBe(false);
    expect(shouldGateNativeSessionTransition("session-a", "session-a", true)).toBe(false);
    expect(shouldGateNativeSessionTransition("session-a", "session-b", false)).toBe(false);
  });
});
