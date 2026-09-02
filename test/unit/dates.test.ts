import { describe, expect, it } from "vitest";
import { nextMonthlyDate } from "../../src/lib/dates.js";

describe("nextMonthlyDate", () => {
  it("uses this month's occurrence when it has not passed", () => {
    expect(nextMonthlyDate("2026-09-01", 10)).toBe("2026-09-10");
  });

  it("rolls a passed day into the following month", () => {
    expect(nextMonthlyDate("2026-09-21", 10)).toBe("2026-10-10");
  });

  it("clamps billing days to shorter months", () => {
    expect(nextMonthlyDate("2027-02-01", 31)).toBe("2027-02-28");
    expect(nextMonthlyDate("2028-02-01", 31)).toBe("2028-02-29");
  });
});
