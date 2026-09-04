import { describe, expect, it } from "vitest";
import {
  advanceAnchoredDate,
  anchoredOccurrenceDate,
} from "../src/schedule.js";

describe("anchored calendar schedules", () => {
  it("derives every occurrence from the original month anchor", () => {
    const anchor = { day: 31, endOfMonth: true };
    expect(anchoredOccurrenceDate("2027-01-31", "monthly", 1, anchor)).toBe(
      "2027-02-28",
    );
    expect(anchoredOccurrenceDate("2027-01-31", "monthly", 2, anchor)).toBe(
      "2027-03-31",
    );
    expect(anchoredOccurrenceDate("2027-01-31", "quarterly", 1, anchor)).toBe(
      "2027-04-30",
    );
    expect(anchoredOccurrenceDate("2027-01-31", "quarterly", 2, anchor)).toBe(
      "2027-07-31",
    );
    expect(anchoredOccurrenceDate("2027-01-31", "quarterly", 3, anchor)).toBe(
      "2027-10-31",
    );
  });

  it("distinguishes a fixed day from an end-of-month identity", () => {
    expect(
      advanceAnchoredDate("2027-04-30", "monthly", {
        day: 30,
        endOfMonth: false,
      }),
    ).toBe("2027-05-30");
    expect(
      advanceAnchoredDate("2027-04-30", "monthly", {
        day: 30,
        endOfMonth: true,
      }),
    ).toBe("2027-05-31");
  });

  it("handles leap years including Gregorian century rules", () => {
    const leap = { day: 29, endOfMonth: true };
    expect(anchoredOccurrenceDate("2024-02-29", "annual", 1, leap)).toBe(
      "2025-02-28",
    );
    expect(anchoredOccurrenceDate("2024-02-29", "annual", 4, leap)).toBe(
      "2028-02-29",
    );
    expect(anchoredOccurrenceDate("2096-02-29", "annual", 4, leap)).toBe(
      "2100-02-28",
    );
    expect(anchoredOccurrenceDate("2396-02-29", "annual", 4, leap)).toBe(
      "2400-02-29",
    );
  });

  it("keeps weekly schedules in LocalDate days", () => {
    expect(anchoredOccurrenceDate("2026-03-07", "weekly", 1)).toBe(
      "2026-03-14",
    );
    expect(anchoredOccurrenceDate("2026-10-31", "biweekly", 1)).toBe(
      "2026-11-14",
    );
  });
});
