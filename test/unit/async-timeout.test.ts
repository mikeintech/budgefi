import { afterEach, describe, expect, it, vi } from "vitest";
import { within } from "../../src/lib/async-timeout.js";

afterEach(() => vi.useRealTimers());

describe("bounded asynchronous work", () => {
  it("rejects an operation that never settles", async () => {
    vi.useFakeTimers();
    const result = within(
      new Promise(() => undefined),
      100,
      "Session refresh timed out",
    );
    const assertion = expect(result).rejects.toThrow(
      "Session refresh timed out",
    );

    await vi.advanceTimersByTimeAsync(100);

    await assertion;
  });

  it("returns a result without waiting for the deadline", async () => {
    await expect(within(Promise.resolve("ready"), 100, "late")).resolves.toBe(
      "ready",
    );
  });
});
