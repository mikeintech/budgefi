const nativeCleanupMarkerKey = "budgefi.native-cleanup-required.v1";

type MarkerStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): MarkerStorage | null {
  try {
    return (
      globalThis as unknown as { localStorage?: MarkerStorage }
    ).localStorage ?? null;
  } catch {
    return null;
  }
}

export function nativeCleanupRequired(
  storage: MarkerStorage | null = defaultStorage(),
): boolean {
  try {
    if (!storage) return true;
    return storage.getItem(nativeCleanupMarkerKey) === "required";
  } catch {
    return true;
  }
}

export function markNativeCleanupRequired(
  storage: MarkerStorage | null = defaultStorage(),
): void {
  if (!storage) throw new Error("Native cleanup marker storage is unavailable");
  storage.setItem(nativeCleanupMarkerKey, "required");
}

export function clearNativeCleanupRequired(
  storage: MarkerStorage | null = defaultStorage(),
): void {
  if (!storage) throw new Error("Native cleanup marker storage is unavailable");
  storage.removeItem(nativeCleanupMarkerKey);
}
