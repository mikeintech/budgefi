export function shouldAcceptBootstrap(
  currentHouseholdId: string | null,
  currentRevision: bigint,
  incomingHouseholdId: string,
  incomingRevision: bigint,
): boolean {
  return (
    currentHouseholdId !== incomingHouseholdId ||
    incomingRevision >= currentRevision
  );
}
