import { describe, expect, it } from "vitest";
import { withSuggestedCommitmentDates } from "../../src/lib/commitment-defaults.js";
import { calculatePlanProjection } from "../../src/lib/plan-preview.js";
import { planCalibrationRequestSchema } from "../../packages/contracts/src/index.js";

const blankPlan = {
  rentDueDate: "",
  electricDueDate: "",
  streamBoxDueDate: "",
  insuranceDueDate: "",
  customCommitments: [] as { amount: number; dueDate: string }[],
};
const blankProjection = {
  knownCash: 1_000,
  savingsContribution: 0,
  rentId: null,
  rentName: "Rent",
  rentAmount: 0,
  rentDueDate: "",
  rentRecurrence: "monthly" as const,
  electricId: null,
  electricName: "Electric",
  electricMax: 0,
  electricDueDate: "",
  electricRecurrence: "monthly" as const,
  streamBoxId: null,
  streamBoxName: "Subscriptions",
  streamBoxAmount: 0,
  streamBoxDueDate: "",
  streamBoxRecurrence: "monthly" as const,
  insuranceId: null,
  insuranceName: "Insurance",
  insuranceAmount: 0,
  insuranceDueDate: "",
  insuranceRecurrence: "monthly" as const,
  customCommitments: [],
};

describe("commitment setup suggestions", () => {
  it("accepts only identified, unique, blank common-bill starter rows", () => {
    const base = {
      expectedVersion: 1,
      plannedSavings: { minor: "0", currency: "USD" as const },
      safetyBuffer: { minor: "0", currency: "USD" as const },
      commitments: [{
        name: "Phone & internet",
        amount: { minor: "0", currency: "USD" as const },
        dueDate: null,
        recurrence: "monthly" as const,
        setupSlot: null,
        starterItemKey: "phone_internet" as const,
      }],
      removeCommitments: [],
      requestId: "00000000-0000-4000-8000-000000000001",
    };
    expect(planCalibrationRequestSchema.safeParse({
      ...base,
      starterTemplate: { key: "common_bills", version: 1 },
    }).success).toBe(true);
    expect(planCalibrationRequestSchema.safeParse(base).success).toBe(false);
    expect(planCalibrationRequestSchema.safeParse({
      ...base,
      starterTemplate: { key: "common_bills", version: 1 },
      commitments: [...base.commitments, ...base.commitments],
    }).success).toBe(false);
  });
  it("provides useful dates even before amounts are entered", () => {
    const result = withSuggestedCommitmentDates(
      blankPlan,
      "2026-09-01",
      "2026-09-30",
    );

    expect(result.rentDueDate).toBe("2026-09-01");
    expect(result.electricDueDate).toBe("2026-09-10");
    expect(result.streamBoxDueDate).toBe("2026-09-15");
    expect(result.insuranceDueDate).toBe("2026-09-20");
  });

  it("never overwrites dates loaded from the ledger", () => {
    const result = withSuggestedCommitmentDates(
      { ...blankPlan, rentDueDate: "2026-09-07" },
      "2026-09-01",
      "2026-09-30",
    );

    expect(result.rentDueDate).toBe("2026-09-07");
  });

  it("preserves an intentionally undated custom commitment", () => {
    const result = withSuggestedCommitmentDates(
      {
        ...blankPlan,
        customCommitments: [{ amount: 25, dueDate: "" }],
      },
      "2026-09-01",
      "2026-09-30",
    );

    expect(result.customCommitments[0]?.dueDate).toBe("");
  });

  it("counts every weekly occurrence and excludes an already verified one", () => {
    const commitmentId = "00000000-0000-4000-8000-000000000101";
    const projection = calculatePlanProjection(
      {
        ...blankProjection,
        customCommitments: [
          {
            id: commitmentId,
            name: "Weekly care",
            amount: 100,
            dueDate: "2026-09-03",
            recurrence: "weekly",
          },
        ],
      },
      0,
      "2026-09-17",
      {
        horizonStart: "2026-09-03",
        commitments: [{ id: commitmentId, name: "Weekly care" } as never],
        savingsGoals: [],
        occurrences: [
          {
            id: "00000000-0000-4000-8000-000000000201",
            kind: "commitment",
            commitmentId,
            name: "Weekly care",
            expectedOn: "2026-09-03",
            state: "verified",
          } as never,
        ],
      },
    );
    expect(projection.futureBills).toBe(200);
    expect(projection.available).toBe(800);
  });

  it("synthesizes weekly savings when the horizon extends from 14 to 30 days", () => {
    const projection = calculatePlanProjection(
      blankProjection,
      0,
      "2026-10-03",
      {
        horizonStart: "2026-09-03",
        commitments: [],
        savingsGoals: [
          {
            id: "goal",
            contributionAmount: { minor: "2500" },
            schedule: "weekly",
            nextDueOn: "2026-09-05",
            status: "active",
          },
        ],
        occurrences: [
          {
            kind: "savings",
            commitmentId: null,
            savingsGoalId: "goal",
            name: "Reserve",
            expectedOn: "2026-09-05",
            state: "expected",
            remainingAmount: { minor: "2500" },
          },
          {
            kind: "savings",
            commitmentId: null,
            savingsGoalId: "goal",
            name: "Reserve",
            expectedOn: "2026-09-12",
            state: "expected",
            remainingAmount: { minor: "2500" },
          },
        ],
      },
    );
    expect(projection.reserved).toBe(125);
    expect(projection.available).toBe(875);
  });

  it("does not invent recurring commitments older than the server lookback", () => {
    const projection = calculatePlanProjection(
      {
        ...blankProjection,
        rentName: "Old weekly",
        rentAmount: 10,
        rentDueDate: "2024-01-05",
        rentRecurrence: "weekly",
      },
      0,
      "2026-09-17",
      {
        horizonStart: "2026-09-03",
        commitments: [],
        savingsGoals: [],
        occurrences: [],
      },
    );
    expect(projection.futureBills).toBe(150);
  });

  it.each([
    ["changed date", "2026-09-20", "monthly" as const],
    ["changed recurrence", "2026-09-10", "one_time" as const],
  ])(
    "supersedes canonical occurrences for a %s",
    (_label, dueDate, recurrence) => {
      const projection = calculatePlanProjection(
        {
          ...blankProjection,
          rentAmount: 50,
          rentDueDate: dueDate,
          rentRecurrence: recurrence,
        },
        0,
        "2026-09-30",
        {
          horizonStart: "2026-09-03",
          commitments: [
            {
              id: "rent",
              name: "Rent",
              dueDate: "2026-09-10",
              recurrence: "monthly",
              amount: { minor: "5000" },
            },
          ],
          savingsGoals: [],
          occurrences: [
            {
              kind: "commitment",
              commitmentId: "rent",
              savingsGoalId: null,
              name: "Rent",
              expectedOn: "2026-09-10",
              state: "expected",
              remainingAmount: { minor: "5000" },
            },
          ],
        },
      );
      expect(projection.futureBills).toBe(50);
    },
  );

  it("uses the edited amount instead of a stale open occurrence amount", () => {
    const projection = calculatePlanProjection(
      {
        ...blankProjection,
        rentId: "rent",
        rentAmount: 100,
        rentDueDate: "2026-09-10",
      },
      0,
      "2026-09-30",
      {
        horizonStart: "2026-09-03",
        commitments: [
          {
            id: "rent",
            name: "Rent",
            dueDate: "2026-09-10",
            recurrence: "monthly",
            amount: { minor: "5000" },
          },
        ],
        savingsGoals: [],
        occurrences: [
          {
            kind: "commitment",
            commitmentId: "rent",
            savingsGoalId: null,
            name: "Rent",
            expectedOn: "2026-09-10",
            state: "expected",
            remainingAmount: { minor: "5000" },
          },
        ],
      },
    );
    expect(projection.futureBills).toBe(100);
  });

  it("keeps verified lineage when only a commitment name changes", () => {
    const projection = calculatePlanProjection(
      {
        ...blankProjection,
        customCommitments: [
          {
            id: "phone",
            name: "Mobile service",
            amount: 50,
            dueDate: "2026-09-10",
            recurrence: "monthly",
          },
        ],
      },
      0,
      "2026-09-30",
      {
        horizonStart: "2026-09-03",
        commitments: [
          {
            id: "phone",
            name: "Phone bill",
            dueDate: "2026-09-10",
            recurrence: "monthly",
            amount: { minor: "5000" },
          },
        ],
        savingsGoals: [],
        occurrences: [
          {
            kind: "commitment",
            commitmentId: "phone",
            savingsGoalId: null,
            name: "Phone bill",
            expectedOn: "2026-09-10",
            state: "verified",
            remainingAmount: { minor: "0" },
          },
        ],
      },
    );
    expect(projection.futureBills).toBe(0);
  });

  it("suppresses only an explicit user skip, not a superseded occurrence", () => {
    const context = {
      horizonStart: "2026-09-03",
      commitments: [
        {
          id: "rent",
          name: "Rent",
          dueDate: "2026-09-10",
          recurrence: "monthly" as const,
          amount: { minor: "50000" },
        },
      ],
      savingsGoals: [],
      occurrences: [
        {
          kind: "commitment",
          commitmentId: "rent",
          savingsGoalId: null,
          name: "Rent",
          expectedOn: "2026-09-10",
          state: "skipped",
          remainingAmount: { minor: "50000" },
          explicitlySkipped: false,
        },
      ],
    };
    const plan = {
      ...blankProjection,
      rentId: "rent",
      rentAmount: 500,
      rentDueDate: "2026-09-10",
    };
    expect(
      calculatePlanProjection(plan, 0, "2026-09-30", context).futureBills,
    ).toBe(500);
    context.occurrences[0]!.explicitlySkipped = true;
    expect(
      calculatePlanProjection(plan, 0, "2026-09-30", context).futureBills,
    ).toBe(0);
  });

  it("replaces the old planning-period savings target when the horizon changes", () => {
    const projection = calculatePlanProjection(
      blankProjection,
      0,
      "2026-10-03",
      {
        horizonStart: "2026-09-03",
        commitments: [],
        savingsGoals: [
          {
            id: "general",
            contributionAmount: { minor: "10000" },
            schedule: "planning_period",
            nextDueOn: "2026-09-17",
            status: "active",
          },
        ],
        occurrences: [
          {
            kind: "savings",
            commitmentId: null,
            savingsGoalId: "general",
            name: "General savings",
            expectedOn: "2026-09-17",
            state: "expected",
            remainingAmount: { minor: "10000" },
          },
        ],
      },
    );
    expect(projection.plannedSavings).toBe(100);
    expect(projection.available).toBe(900);
  });
});
