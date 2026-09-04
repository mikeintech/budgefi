type NamedCommitment = {
  id: string | null;
  name: string;
  amount: number;
};

/** Existing duplicate names can occur in imported history and must round-trip.
 * Only a new row or rename that creates ambiguity should block the editor. */
export function hasInvalidDuplicateCommitmentNames(
  draft: readonly NamedCommitment[],
  canonical: readonly { id: string; name: string }[],
): boolean {
  const canonicalNames = new Map(
    canonical.map((item) => [item.id, normalize(item.name)]),
  );
  const groups = new Map<string, NamedCommitment[]>();
  for (const item of draft) {
    if (item.amount <= 0 || !item.name.trim()) continue;
    const name = normalize(item.name);
    groups.set(name, [...(groups.get(name) ?? []), item]);
  }
  return [...groups.entries()].some(
    ([name, items]) =>
      items.length > 1 &&
      !items.every((item) => item.id && canonicalNames.get(item.id) === name),
  );
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}
