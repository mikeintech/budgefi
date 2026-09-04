type CalibrationIdentityShape = {
  rentId: string | null;
  electricId: string | null;
  streamBoxId: string | null;
  insuranceId: string | null;
  starterItemKeys?: string[];
  customCommitments: { id: string; recurrence?: string; starterItemKey?: string }[];
};

/** Merge an unfinished local setup draft without erasing identities learned
 * from a newer canonical bootstrap. */
export function mergeCalibrationDraft<T extends CalibrationIdentityShape>(
  canonical: T,
  stored: T,
): T {
  const storedIds = new Set(
    (stored.customCommitments ?? []).map((item) => item.id),
  );
  const canonicalById = new Map(
    canonical.customCommitments.map((item) => [item.id, item]),
  );
  return {
    ...canonical,
    ...stored,
    rentId: stored.rentId ?? canonical.rentId,
    electricId: stored.electricId ?? canonical.electricId,
    streamBoxId: stored.streamBoxId ?? canonical.streamBoxId,
    insuranceId: stored.insuranceId ?? canonical.insuranceId,
    starterItemKeys: [
      ...new Set([
        ...(canonical.starterItemKeys ?? []),
        ...(stored.starterItemKeys ?? []),
      ]),
    ],
    customCommitments: [
      ...(stored.customCommitments ?? []).map((item) => ({
        ...item,
        recurrence: item.recurrence ?? ("monthly" as const),
        starterItemKey:
          canonicalById.get(item.id)?.starterItemKey ?? item.starterItemKey,
      })),
      ...canonical.customCommitments.filter((item) => !storedIds.has(item.id)),
    ],
  } as T;
}
