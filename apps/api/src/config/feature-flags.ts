export const featureFlagNames = ["onboardingAi", "householdMode"] as const;

export type FeatureFlagName = (typeof featureFlagNames)[number];
export type FeatureFlags = Readonly<Record<FeatureFlagName, boolean>>;

const environmentKeys: Record<FeatureFlagName, string> = {
  onboardingAi: "FEATURE_ONBOARDING_AI",
  householdMode: "FEATURE_HOUSEHOLD_MODE",
};

export function getFeatureFlags(
  environment: NodeJS.ProcessEnv = process.env,
): FeatureFlags {
  return Object.fromEntries(
    featureFlagNames.map((name) => [
      name,
      environment[environmentKeys[name]] === "true",
    ]),
  ) as FeatureFlags;
}

export function featureEnabled(
  name: FeatureFlagName,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return getFeatureFlags(environment)[name];
}
