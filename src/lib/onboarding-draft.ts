export const onboardingDraftSchemaVersion = 3;
const draftLifetimeMs = 7 * 24 * 60 * 60 * 1_000;

type DraftEnvelope<T> = {
  schemaVersion: typeof onboardingDraftSchemaVersion;
  scope: string;
  householdId: string;
  baseRevision: string;
  expiresAt: string;
  draft: T;
};

export function onboardingDraftKey(scope: string, householdId: string): string {
  return `budgefi:onboarding-draft:v3:${encodeURIComponent(scope)}:${householdId}`;
}

export function createOnboardingDraftEnvelope<T>(
  draft: T,
  scope: string,
  householdId: string,
  baseRevision: string,
  now = Date.now(),
): DraftEnvelope<T> {
  return {
    schemaVersion: onboardingDraftSchemaVersion,
    scope,
    householdId,
    baseRevision,
    expiresAt: new Date(now + draftLifetimeMs).toISOString(),
    draft,
  };
}

export function parseOnboardingDraftEnvelope<T>(
  raw: string,
  scope: string,
  householdId: string,
  currentRevision: string,
  now = Date.now(),
): { status: "ready"; draft: T } | { status: "stale" | "invalid" } {
  try {
    const value = JSON.parse(raw) as Partial<DraftEnvelope<T>>;
    if (
      value.schemaVersion !== onboardingDraftSchemaVersion ||
      value.scope !== scope ||
      value.householdId !== householdId ||
      typeof value.baseRevision !== "string" ||
      typeof value.expiresAt !== "string" ||
      !("draft" in value)
    )
      return { status: "invalid" };
    const expiresAt = new Date(value.expiresAt).getTime();
    if (!Number.isFinite(expiresAt)) return { status: "invalid" };
    if (expiresAt <= now || value.baseRevision !== currentRevision)
      return { status: "stale" };
    return { status: "ready", draft: value.draft as T };
  } catch {
    return { status: "invalid" };
  }
}
