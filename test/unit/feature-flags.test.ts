import { describe, expect, it } from "vitest";
import { getFeatureFlags } from "../../apps/api/src/config/feature-flags.js";

describe("feature flags", () => {
  it("defaults every product feature to disabled", () => {
    expect(getFeatureFlags({})).toEqual({
      onboardingAi: false,
      householdMode: false,
    });
  });

  it("only enables flags with an explicit true value", () => {
    expect(
      getFeatureFlags({
        FEATURE_ONBOARDING_AI: "true",
        FEATURE_HOUSEHOLD_MODE: "false",
      }),
    ).toEqual({ onboardingAi: true, householdMode: false });
  });
});
