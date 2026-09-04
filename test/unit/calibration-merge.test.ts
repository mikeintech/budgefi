import { describe, expect, it } from "vitest";
import { mergeCalibrationDraft } from "../../src/lib/calibration-merge.js";

describe("calibration draft reconciliation", () => {
  it("does not let a stale local null erase a connected canonical slot id", () => {
    type Fixture = {
      rentId: string | null;
      electricId: string | null;
      streamBoxId: string | null;
      insuranceId: string | null;
      electricName: string;
      electricMax: number;
      customCommitments: { id: string; recurrence?: string }[];
    };
    const canonical: Fixture = {
      rentId: null,
      electricId: "10000000-0000-4000-8000-000000000111",
      streamBoxId: null,
      insuranceId: null,
      electricName: "Home power",
      electricMax: 170,
      customCommitments: [],
    };
    const stale: Fixture = {
      rentId: null,
      electricId: null,
      streamBoxId: null,
      insuranceId: null,
      electricName: "Electric",
      electricMax: 125,
      customCommitments: [],
    };
    const merged = mergeCalibrationDraft(canonical, stale);
    expect(merged.electricId).toBe(canonical.electricId);
    expect(merged.electricMax).toBe(125);
  });

  it("restores starter identity when an older onboarding draft lacks it", () => {
    const base = {
      rentId: null,
      electricId: null,
      streamBoxId: null,
      insuranceId: null,
    };
    const canonical = {
      ...base,
      starterItemKeys: ["phone_internet"],
      customCommitments: [
        {
          id: "10000000-0000-4000-8000-000000000222",
          recurrence: "monthly",
          starterItemKey: "phone_internet",
        },
      ],
    };
    const stale = {
      ...base,
      starterItemKeys: [] as string[],
      customCommitments: [
        {
          id: "10000000-0000-4000-8000-000000000222",
          recurrence: "monthly",
        },
      ],
    };
    const merged = mergeCalibrationDraft(canonical, stale);
    expect(merged.starterItemKeys).toEqual(["phone_internet"]);
    expect(
      (merged.customCommitments[0] as { starterItemKey?: string } | undefined)
        ?.starterItemKey,
    ).toBe("phone_internet");
  });
});
