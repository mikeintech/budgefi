import { describe, expect, it } from "vitest";
import {
  clearNativeCleanupRequired,
  markNativeCleanupRequired,
  nativeCleanupRequired,
} from "../../src/lib/native-cleanup-marker.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe("durable native cleanup marker", () => {
  it("is set before cleanup and cleared only after success", () => {
    const storage = memoryStorage();
    expect(nativeCleanupRequired(storage)).toBe(false);
    markNativeCleanupRequired(storage);
    expect(nativeCleanupRequired(storage)).toBe(true);
    clearNativeCleanupRequired(storage);
    expect(nativeCleanupRequired(storage)).toBe(false);
  });

  it("remains required when cleanup fails before marker removal", () => {
    const storage = memoryStorage();
    markNativeCleanupRequired(storage);
    expect(nativeCleanupRequired(storage)).toBe(true);
  });

  it("fails closed when marker storage cannot be read", () => {
    const brokenStorage = {
      getItem: () => {
        throw new Error("unavailable");
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(nativeCleanupRequired(brokenStorage)).toBe(true);
    expect(nativeCleanupRequired(null)).toBe(true);
  });
});
