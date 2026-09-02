import { describe, expect, it } from "vitest";
import {
  createOnboardingDraftEnvelope,
  onboardingDraftKey,
  parseOnboardingDraftEnvelope,
} from "../../src/lib/onboarding-draft.js";

describe("onboarding draft isolation", () => {
  const now = Date.parse("2026-09-01T12:00:00.000Z");

  it("restores only the same identity, household, and server revision", () => {
    const raw = JSON.stringify(
      createOnboardingDraftEnvelope({ step: 3 }, "user-a", "house-a", "8", now),
    );
    expect(
      parseOnboardingDraftEnvelope<{ step: number }>(
        raw,
        "user-a",
        "house-a",
        "8",
        now,
      ),
    ).toEqual({
      status: "ready",
      draft: { step: 3 },
    });
    expect(
      parseOnboardingDraftEnvelope(raw, "user-b", "house-a", "8", now).status,
    ).toBe("invalid");
    expect(
      parseOnboardingDraftEnvelope(raw, "user-a", "house-b", "8", now).status,
    ).toBe("invalid");
    expect(
      parseOnboardingDraftEnvelope(raw, "user-a", "house-a", "9", now).status,
    ).toBe("stale");
  });

  it("expires drafts and keeps storage keys identity-specific", () => {
    const raw = JSON.stringify(
      createOnboardingDraftEnvelope({ step: 2 }, "user-a", "house-a", "8", now),
    );
    expect(
      parseOnboardingDraftEnvelope(
        raw,
        "user-a",
        "house-a",
        "8",
        now + 8 * 24 * 60 * 60 * 1_000,
      ).status,
    ).toBe("stale");
    expect(onboardingDraftKey("user-a", "house-a")).not.toBe(
      onboardingDraftKey("user-b", "house-a"),
    );
  });

  it("rejects every previous draft schema version", () => {
    const legacy = JSON.stringify({
      schemaVersion: 2,
      scope: "user-a",
      householdId: "house-a",
      baseRevision: "8",
      expiresAt: new Date(now + 60_000).toISOString(),
      draft: {
        step: 2,
        dataModeDraft: "sample",
        planDraft: { data: { knownCash: 9999 } },
      },
    });
    expect(
      parseOnboardingDraftEnvelope(legacy, "user-a", "house-a", "8", now),
    ).toEqual({ status: "invalid" });
  });
});
