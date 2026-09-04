export type WorkspaceMode = "connected" | "manual";

type WorkspaceAccount = {
  id: string;
  connectionId: string | null;
  type: string;
  provenance: string;
  includeInPlan: boolean;
  planningRole: "spendable" | "protected" | "excluded";
  balanceAsOf: string | null;
};

type WorkspaceConnection = {
  id: string;
  provider: string;
  status: string;
};

const spendableAccountTypes = new Set(["cash", "checking", "savings"]);
const inactiveConnectionStatuses = new Set(["revocation_pending", "revoked"]);

/** Derive the active workspace from accounts that can actually fund the plan.
 * Retained, excluded, or revoked Plaid records must not force connected mode. */
export function resolveAccountWorkspace(
  accounts: readonly WorkspaceAccount[],
  connections: readonly WorkspaceConnection[],
): { mode: WorkspaceMode; manualAccountId: string | null } {
  const activePlaidConnections = new Set(
    connections
      .filter(
        (connection) =>
          connection.provider === "plaid" &&
          !inactiveConnectionStatuses.has(connection.status),
      )
      .map((connection) => connection.id),
  );
  const connected = accounts.some(
    (account) =>
      account.provenance === "plaid" &&
      account.includeInPlan &&
      account.planningRole === "spendable" &&
      spendableAccountTypes.has(account.type) &&
      Boolean(
        account.connectionId &&
          activePlaidConnections.has(account.connectionId),
      ),
  );
  const manualAccounts = accounts.filter(
    (account) =>
      account.provenance === "manual" &&
      account.planningRole === "spendable" &&
      spendableAccountTypes.has(account.type),
  );
  const manualAccount =
    manualAccounts.find((account) => account.includeInPlan) ??
    manualAccounts.find((account) => account.balanceAsOf !== null) ??
    manualAccounts[0];
  return {
    mode: connected ? "connected" : "manual",
    manualAccountId: manualAccount?.id ?? null,
  };
}
