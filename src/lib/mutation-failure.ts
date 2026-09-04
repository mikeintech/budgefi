/** A rejected client request leaves the last confirmed snapshot usable.
 * Transport and server failures are ambiguous, so they downgrade freshness
 * until a reconciliation read succeeds. */
export function mutationFailureKeepsConfirmedData(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("status" in error)) return false;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && [400, 409, 422, 429].includes(status);
}
