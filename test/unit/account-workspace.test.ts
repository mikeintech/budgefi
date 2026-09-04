import { describe, expect, it } from "vitest";
import { resolveAccountWorkspace } from "../../src/lib/account-workspace.js";

const account = (
  id: string,
  overrides: Partial<
    Parameters<typeof resolveAccountWorkspace>[0][number]
  > = {},
) => ({
  id,
  connectionId: null,
  type: "checking",
  provenance: "manual",
  includeInPlan: false,
  planningRole: "spendable" as const,
  balanceAsOf: null,
  ...overrides,
});

describe("account workspace selection", () => {
  it("keeps manual mode when only excluded or revoked Plaid records remain", () => {
    expect(
      resolveAccountWorkspace(
        [
          account("manual", { includeInPlan: true }),
          account("excluded-bank", {
            provenance: "plaid",
            connectionId: "healthy",
          }),
          account("revoked-bank", {
            provenance: "plaid",
            connectionId: "revoked",
            includeInPlan: true,
          }),
        ],
        [
          { id: "healthy", provider: "plaid", status: "healthy" },
          { id: "revoked", provider: "plaid", status: "revoked" },
        ],
      ).mode,
    ).toBe("manual");
  });

  it("returns to connected mode only for an included active spendable bank account", () => {
    expect(
      resolveAccountWorkspace(
        [
          account("manual", { includeInPlan: false }),
          account("bank", {
            provenance: "plaid",
            connectionId: "connection",
            includeInPlan: true,
          }),
        ],
        [{ id: "connection", provider: "plaid", status: "login_required" }],
      ).mode,
    ).toBe("connected");
  });

  it("targets the included manual account instead of an obsolete placeholder", () => {
    expect(
      resolveAccountWorkspace(
        [
          account("old-placeholder"),
          account("active-manual", {
            includeInPlan: true,
            balanceAsOf: "2026-09-03T12:00:00.000Z",
          }),
        ],
        [],
      ),
    ).toEqual({ mode: "manual", manualAccountId: "active-manual" });
  });

  it("never targets a protected manual savings account for spendable cash", () => {
    expect(
      resolveAccountWorkspace(
        [
          account("protected", {
            type: "savings",
            includeInPlan: true,
            planningRole: "protected",
          }),
          account("cash", { type: "cash" }),
        ],
        [],
      ).manualAccountId,
    ).toBe("cash");
  });
});
