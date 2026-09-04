export function createSingleFlight<T>(operation: () => Promise<T>) {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight) return inFlight;
    inFlight = operation().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

export function runKeyedSingleFlight<K, T>(
  inFlight: Map<K, Promise<T>>,
  key: K,
  operation: () => Promise<T>,
) {
  const existing = inFlight.get(key);
  if (existing) return existing;

  const result = operation().finally(() => {
    if (inFlight.get(key) === result) inFlight.delete(key);
  });
  inFlight.set(key, result);
  return result;
}
