import { describe, expect, it } from "vitest";
import {
  advanceIncomeDate,
  advanceIncomeScheduleDate,
  resolvePlanningHorizon,
  resolvePlanningHorizonFromSchedules,
} from "../src/horizon.js";

describe("planning horizon policy", () => {
  it("ends on the next confirmed income date without counting that income", () => {
    expect(
      resolvePlanningHorizon({
        today: "2026-09-02",
        nextIncomeDate: "2026-09-11",
        incomeConfirmed: true,
        fallbackDays: 14,
      }),
    ).toEqual({
      start: "2026-09-02",
      end: "2026-09-11",
      days: 9,
      basis: "expected_income",
    });
  });

  it("uses the configured fallback for unknown, irregular, or stale income", () => {
    expect(
      resolvePlanningHorizon({
        today: "2026-09-02",
        nextIncomeDate: "2026-08-29",
        incomeConfirmed: true,
        fallbackDays: 14,
      }),
    ).toMatchObject({ end: "2026-09-16", days: 14, basis: "fallback" });
    expect(
      resolvePlanningHorizon({
        today: "2026-09-02",
        nextIncomeDate: "2026-09-11",
        incomeConfirmed: false,
        fallbackDays: 21,
      }),
    ).toMatchObject({ end: "2026-09-23", days: 21, basis: "fallback" });
  });

  it("bounds fallback configuration and rejects implausibly distant paydays", () => {
    expect(
      resolvePlanningHorizon({
        today: "2026-09-02",
        nextIncomeDate: "2027-01-01",
        incomeConfirmed: true,
        fallbackDays: 999,
      }),
    ).toMatchObject({ end: "2026-12-01", days: 90, basis: "fallback" });
  });
});

describe("multiple income schedule horizon", () => {
  const schedule = (
    id: string,
    nextExpectedDate: string | null,
    confirmed = true,
    status = "active",
  ) => ({ id, nextExpectedDate, confirmed, status });
  it("uses the earliest reliable schedule and breaks same-day ties deterministically", () => {
    expect(
      resolvePlanningHorizonFromSchedules({
        today: "2026-09-02",
        fallbackDays: 14,
        schedules: [
          schedule("later", "2026-09-16"),
          schedule("z", "2026-09-09"),
          schedule("a", "2026-09-09"),
        ],
      }),
    ).toMatchObject({
      end: "2026-09-09",
      incomeScheduleId: "a",
      basis: "expected_income",
    });
  });
  it("does not jump past a missed income to a later optimistic date", () => {
    expect(
      resolvePlanningHorizonFromSchedules({
        today: "2026-09-02",
        fallbackDays: 14,
        schedules: [
          schedule("missed", "2026-09-01"),
          schedule("later", "2026-09-06"),
        ],
      }),
    ).toMatchObject({
      end: "2026-09-16",
      incomeScheduleId: "missed",
      missedIncome: true,
      basis: "fallback",
    });
  });
  it("ignores paused, unconfirmed, and implausibly distant schedules", () => {
    expect(
      resolvePlanningHorizonFromSchedules({
        today: "2026-09-02",
        fallbackDays: 7,
        schedules: [
          schedule("paused", "2026-09-03", true, "paused"),
          schedule("uncertain", "2026-09-04", false),
          schedule("distant", "2027-01-01"),
        ],
      }),
    ).toMatchObject({
      end: "2026-09-09",
      incomeScheduleId: null,
      basis: "fallback",
    });
  });
});

describe("income schedule advancement", () => {
  it("preserves a monthly end-of-month anchor", () => {
    expect(advanceIncomeDate("2027-01-31", "monthly")).toBe("2027-02-28");
    expect(advanceIncomeDate("2027-02-28", "monthly")).toBe("2027-03-31");
    expect(advanceIncomeDate("2027-02-28", "monthly", "2027-01-30")).toBe(
      "2027-03-30",
    );
    expect(
      advanceIncomeDate("2027-02-28", "monthly", {
        day: 30,
        endOfMonth: false,
      }),
    ).toBe("2027-03-30");
  });

  it("advances quarterly and annual dates by anchored calendar months", () => {
    expect(advanceIncomeDate("2027-01-31", "quarterly")).toBe("2027-04-30");
    expect(
      advanceIncomeDate("2027-04-30", "quarterly", {
        day: 31,
        endOfMonth: true,
      }),
    ).toBe("2027-07-31");
    expect(advanceIncomeDate("2024-02-29", "annual")).toBe("2025-02-28");
    expect(
      advanceIncomeDate("2027-02-28", "annual", {
        day: 29,
        endOfMonth: true,
      }),
    ).toBe("2028-02-29");
  });

  it("advances only understood semi-monthly anchors", () => {
    expect(advanceIncomeDate("2026-09-01", "semi_monthly")).toBeNull();
    expect(advanceIncomeDate("2026-09-15", "semi_monthly")).toBeNull();
    expect(advanceIncomeDate("2026-09-08", "semi_monthly")).toBeNull();
  });

  it("advances explicit twice-monthly anchors across short and leap months", () => {
    const firstAndLast = {
      frequency: "semi_monthly" as const,
      anchorDay: 1,
      anchorEndOfMonth: false,
      secondAnchorDay: 31,
      secondAnchorEndOfMonth: true,
    };
    expect(advanceIncomeScheduleDate("2027-01-31", firstAndLast)).toBe(
      "2027-02-01",
    );
    expect(advanceIncomeScheduleDate("2027-02-01", firstAndLast)).toBe(
      "2027-02-28",
    );
    expect(advanceIncomeScheduleDate("2028-02-01", firstAndLast)).toBe(
      "2028-02-29",
    );
  });

  it("keeps both custom anchors ordered and refuses irregular advancement", () => {
    expect(
      advanceIncomeScheduleDate("2026-09-15", {
        frequency: "semi_monthly",
        anchorDay: 15,
        anchorEndOfMonth: false,
        secondAnchorDay: 30,
        secondAnchorEndOfMonth: false,
      }),
    ).toBe("2026-09-30");
    expect(
      advanceIncomeScheduleDate("2026-09-30", {
        frequency: "semi_monthly",
        anchorDay: 15,
        anchorEndOfMonth: false,
        secondAnchorDay: 30,
        secondAnchorEndOfMonth: false,
      }),
    ).toBe("2026-10-15");
    expect(
      advanceIncomeScheduleDate("2026-09-30", {
        frequency: "irregular",
        anchorDay: null,
        anchorEndOfMonth: false,
        secondAnchorDay: null,
        secondAnchorEndOfMonth: false,
      }),
    ).toBeNull();
  });
});
