import { describe, expect, it, vi } from "vitest";
import {
  createSingleFlight,
  runKeyedSingleFlight,
} from "../../src/lib/single-flight.js";

describe("single-flight operations", () => {
  it("shares one operation and result across concurrent callers", async () => {
    let finish!: (value: string) => void;
    const operation = vi.fn(
      () => new Promise<string>((resolve) => (finish = resolve)),
    );
    const run = createSingleFlight(operation);
    const first = run();
    const second = run();
    expect(second).toBe(first);
    expect(operation).toHaveBeenCalledTimes(1);
    finish("registered");
    await expect(Promise.all([first, second])).resolves.toEqual([
      "registered",
      "registered",
    ]);
  });

  it("sends one request when the same keyed action is activated rapidly", async () => {
    let finish!: (value: boolean) => void;
    const operation = vi.fn(
      () => new Promise<boolean>((resolve) => (finish = resolve)),
    );
    const inFlight = new Map<string, Promise<boolean>>();

    const first = runKeyedSingleFlight(inFlight, "starter-application-1", operation);
    const second = runKeyedSingleFlight(inFlight, "starter-application-1", operation);

    expect(second).toBe(first);
    expect(operation).toHaveBeenCalledTimes(1);
    finish(true);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(inFlight).toHaveLength(0);
  });
});
