import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ChevronRight,
  CircleDashed,
  Clock3,
  Landmark,
  PenLine,
  RefreshCw,
  ShieldCheck,
  Unplug,
  WalletCards,
} from "lucide-react";
import { MobileShell } from "@/components/layout";
import {
  PlaidLinkButton,
  type PlaidLinkActions,
} from "@/components/plaid-link-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  type FinancialAccount,
  type FinancialConnection,
  useAppState,
} from "@/state/app-state";

export function ConnectionsPage() {
  const state = useAppState();
  const navigate = useNavigate();
  const manual = state.dataMode === "manual";
  const visibleAccounts = useMemo(
    () =>
      state.accounts
        .filter((account) => account.provenance !== "sample")
        .sort(
          (a, b) =>
            (a.provenance === "manual" ? 0 : 1) -
            (b.provenance === "manual" ? 0 : 1),
        ),
    [state.accounts],
  );
  const covered = visibleAccounts.filter(
    (account) =>
      account.coverage === "complete" || account.coverage === "excluded",
  ).length;
  const stale =
    !manual &&
    visibleAccounts.some(
      (account) =>
        account.coverage === "stale" || account.coverage === "missing",
    );

  return (
    <MobileShell>
      <main className="px-4 pb-8 pt-5">
        <p className="eyebrow">Coverage before conclusions</p>
        <div className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-[31px] font-bold tracking-[-0.045em]">
              Accounts & data
            </h1>
            <p className="mt-1 text-sm text-muted">
              See where every planning number comes from.
            </p>
          </div>
          <Badge tone={stale ? "coral" : "green"}>
            {state.backendStatus === "loading"
              ? "Loading"
              : state.backendStatus === "unavailable"
                ? "Offline"
                : stale
                  ? "Incomplete"
                  : manual
                    ? "Manual"
                    : "Current"}
          </Badge>
        </div>

        <section
          className="mt-5 grid grid-cols-3 gap-2"
          aria-label="Connection coverage summary"
        >
          <Metric value={String(visibleAccounts.length)} label="Accounts" />
          <Metric
            value={`${covered}/${visibleAccounts.length}`}
            label="Covered"
          />
          <Metric
            value={String(state.manualActuals.length)}
            label={manual ? "Actuals" : "Manual actuals"}
          />
        </section>

        <section className="mt-6" aria-labelledby="active-sources">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="active-sources" className="text-lg font-bold">
              Available accounts
            </h2>
            <span className="text-xs text-muted">
              {manual ? "Connected sources stay recoverable" : "Read-only data"}
            </span>
          </div>
          {state.backendStatus === "loading" && visibleAccounts.length === 0 ? (
            <LoadingAccounts />
          ) : visibleAccounts.length === 0 ? (
            <EmptyAccounts manual={manual} />
          ) : (
            <div className="space-y-2">
              {visibleAccounts.map((account) => (
                <AccountCard
                  key={account.id}
                  account={account}
                  onInclusion={state.setAccountInclusion}
                />
              ))}
            </div>
          )}
        </section>

        <RealPlaidConnections
          connections={state.connections.filter(
            (connection) =>
              connection.provider === "plaid" &&
              connection.status !== "revoked",
          )}
          onSync={state.syncPlaid}
          onDisconnect={state.disconnectPlaid}
          createToken={state.createPlaidLinkToken}
          exchange={state.exchangePlaid}
          completeUpdate={state.completePlaidUpdate}
        />

        {!manual && (
          <ManualPlanSwitch
            accounts={state.accounts.filter(
              (account) =>
                account.provenance !== "manual" && account.includeInPlan,
            )}
            onSwitch={state.activateManualMode}
            onDone={() => navigate("/manual")}
          />
        )}
        {manual && (
          <Button asChild className="mt-5 w-full">
            <Link to="/manual">Open manual workspace</Link>
          </Button>
        )}

        <section className="mt-7 rounded-[22px] bg-ink p-4 text-white">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-citron" />
            <div>
              <p className="text-sm font-semibold">
                {manual
                  ? "Manual is a first-class mode"
                  : "Connection health is part of the product"}
              </p>
              <p className="mt-1 text-xs leading-5 text-white/65">
                {manual
                  ? "User-entered values remain explicit. Connecting later is optional."
                  : "Only included deposit balances affect spendable cash. Missing or stale observations downgrade the plan before Budgefi presents a conclusion."}
              </p>
            </div>
          </div>
        </section>
      </main>
    </MobileShell>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-2xl border border-rule bg-white p-3 text-center">
      <strong className="tabular block text-lg">{value}</strong>
      <span className="mt-0.5 block text-[10px] font-bold uppercase tracking-[.08em] text-muted">
        {label}
      </span>
    </div>
  );
}

function LoadingAccounts() {
  return (
    <div className="space-y-2" aria-label="Loading accounts">
      {[0, 1].map((item) => (
        <div
          key={item}
          className="h-[88px] animate-pulse rounded-[20px] border border-rule bg-white/70"
        />
      ))}
    </div>
  );
}

function EmptyAccounts({ manual }: { manual: boolean }) {
  return (
    <div className="rounded-[22px] border border-dashed border-pencil/25 bg-white p-5 text-center">
      <span className="mx-auto grid size-11 place-items-center rounded-2xl bg-pencil/8 text-pencil">
        {manual ? (
          <PenLine className="size-5" />
        ) : (
          <WalletCards className="size-5" />
        )}
      </span>
      <strong className="mt-3 block text-sm">
        {manual ? "Manual setup is ready" : "No bank connected"}
      </strong>
      <p className="mx-auto mt-1 max-w-[280px] text-xs leading-5 text-muted">
        {manual
          ? "Add your current cash and commitments in the manual workspace."
          : "Connect a bank or continue with manual entry."}
      </p>
    </div>
  );
}

function AccountCard({
  account,
  onInclusion,
}: {
  account: FinancialAccount;
  onInclusion: (
    account: FinancialAccount,
    include: boolean,
  ) => Promise<boolean>;
}) {
  const [changing, setChanging] = useState(false);
  useEffect(() => setChanging(false), [account.includeInPlan, account.version]);
  const eligible = ["cash", "checking", "savings"].includes(account.type);
  const unhealthy =
    account.coverage === "stale" || account.coverage === "missing";
  const coverageLabel =
    account.coverage === "complete"
      ? "Current"
      : account.coverage === "excluded"
        ? "Excluded"
        : account.coverage === "missing"
          ? "Missing balance"
          : "Stale";
  const impact = account.includeInPlan
    ? "Included in known cash"
    : eligible
      ? "Protected from the plan"
      : "Activity only";
  const toggle = async () => {
    setChanging(true);
    const okay = await onInclusion(account, !account.includeInPlan);
    if (!okay) setChanging(false);
  };
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button className="flex min-h-[88px] w-full items-center gap-3 rounded-[20px] border border-rule bg-white p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil">
          <span
            className={
              unhealthy
                ? "grid size-11 shrink-0 place-items-center rounded-2xl bg-coral/8 text-coral"
                : "grid size-11 shrink-0 place-items-center rounded-2xl bg-pencil/8 text-pencil"
            }
          >
            {unhealthy ? (
              <Clock3 className="size-5" />
            ) : (
              <Landmark className="size-5" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <strong className="truncate text-sm">{account.name}</strong>
              {account.provenance === "plaid" && (
                <Badge tone="green">Connected</Badge>
              )}
            </span>
            <span className="mt-1 block truncate text-xs text-muted">
              {account.balance
                ? `${formatMoney(account.balance.minor)} · ${account.type}`
                : `${title(account.type)} · no observed balance`}
            </span>
            <span
              className={
                unhealthy
                  ? "mt-1 block text-[11px] font-semibold text-coral"
                  : "mt-1 block text-[11px] font-semibold text-leaf"
              }
            >
              {coverageLabel} · {impact}
            </span>
          </span>
          <ChevronRight className="size-4 text-muted" />
        </button>
      </SheetTrigger>
      <SheetContent
        title={account.name}
        description={`${sourceLabel(account.provenance)} ${title(account.type)} account`}
      >
        <div className="space-y-3">
          <Detail
            label="Balance"
            value={
              account.balance
                ? formatMoney(account.balance.minor)
                : "Not observed"
            }
          />
          <Detail label="Coverage" value={coverageLabel} />
          <Detail
            label="Observed"
            value={
              account.balanceAsOf
                ? formatObservedAt(account.balanceAsOf)
                : "No balance observation"
            }
          />
          <Detail label="Planning treatment" value={impact} />
          <Detail
            label="Permission"
            value={
              account.provenance === "manual"
                ? "Maintained by you"
                : "Balances and transactions · read-only"
            }
          />
        </div>
        {eligible && (
          <Button
            onClick={toggle}
            disabled={changing}
            variant={account.includeInPlan ? "outline" : "default"}
            className="mt-5 w-full"
          >
            {changing ? (
              <>
                <CircleDashed className="size-4 animate-spin" />
                Saving…
              </>
            ) : account.includeInPlan ? (
              "Protect from everyday plan"
            ) : (
              "Include in spendable cash"
            )}
          </Button>
        )}
      </SheetContent>
    </Sheet>
  );
}

function RealPlaidConnections({
  connections,
  onSync,
  onDisconnect,
  ...actions
}: {
  connections: FinancialConnection[];
  onSync: (id: string) => Promise<boolean>;
  onDisconnect: (id: string) => Promise<boolean>;
} & PlaidLinkActions) {
  const [working, setWorking] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<FinancialConnection | null>(
    null,
  );
  const [result, setResult] = useState<string | null>(null);
  const act = async (
    id: string,
    operation: () => Promise<boolean>,
    success: string,
  ) => {
    setWorking(id);
    setResult(null);
    const okay = await operation();
    setWorking(null);
    setResult(
      okay
        ? success
        : "That request was not completed. Review the connection status below before trying again.",
    );
    return okay;
  };
  const revoke = async () => {
    if (!confirming) return;
    const connection = confirming;
    const okay = await act(
      connection.id,
      () => onDisconnect(connection.id),
      `${connection.institutionName ?? "Bank access"} was removed. Its accounts are excluded from planning.`,
    );
    if (okay) setConfirming(null);
  };
  return (
    <section className="mt-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-bold">Bank connections</h2>
        <span className="text-xs text-muted">Optional · read-only</span>
      </div>
      {result && (
        <p
          role="status"
          aria-live="polite"
          className="mb-3 rounded-2xl border border-rule bg-white p-3 text-xs leading-5 text-muted"
        >
          {result}
        </p>
      )}
      {connections.length > 0 && (
        <div className="mb-3 space-y-2">
          {connections.map((connection) => {
            const revoking = connection.status === "revocation_pending";
            return (
              <div
                key={connection.id}
                className="rounded-[20px] border border-rule bg-white p-4"
              >
                <div className="flex items-start gap-3">
                  <span className="grid size-10 place-items-center rounded-2xl bg-pencil/8 text-pencil">
                    <Landmark className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block text-sm">
                      {connection.institutionName ?? "Connected bank"}
                    </strong>
                    <span className="mt-1 block text-xs text-muted">
                      {connectionStatus(connection)}
                    </span>
                  </span>
                  <Badge
                    tone={
                      connection.status === "healthy"
                        ? "green"
                        : connection.status === "login_required" ||
                            connection.status === "error"
                          ? "coral"
                          : "blue"
                    }
                  >
                    {title(connection.status)}
                  </Badge>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    disabled={working === connection.id || revoking}
                    onClick={() =>
                      void act(
                        connection.id,
                        () => onSync(connection.id),
                        `${connection.institutionName ?? "Connection"} refresh started. You can leave this page.`,
                      )
                    }
                  >
                    {working === connection.id ? (
                      <CircleDashed className="size-4 animate-spin" />
                    ) : (
                      <RefreshCw className="size-4" />
                    )}
                    {revoking ? "Sync disabled" : "Sync now"}
                  </Button>
                  {connection.status === "login_required" ? (
                    <PlaidLinkButton
                      connection={connection}
                      mode="update"
                      {...actions}
                    />
                  ) : (
                    <Button
                      variant="ghost"
                      className="text-coral"
                      disabled={working === connection.id || revoking}
                      onClick={() => setConfirming(connection)}
                    >
                      <Unplug className="size-4" />
                      {revoking ? "Disconnecting" : "Remove access"}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <PlaidLinkButton mode="create" {...actions} />
      <Sheet
        open={Boolean(confirming)}
        onOpenChange={(open) => {
          if (!open && working === null) setConfirming(null);
        }}
      >
        <SheetContent
          title={`Remove ${confirming?.institutionName ?? "bank"} access?`}
          description="This disconnects the bank from Budgefi."
        >
          <div className="rounded-2xl border border-coral/20 bg-coral/[.05] p-4 text-sm leading-6">
            <strong>What happens</strong>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
              <li>Linked accounts are removed from new plan calculations.</li>
              <li>Reconnect later by setting up the bank again.</li>
              <li>Existing transaction history stays in your records.</li>
            </ul>
          </div>
          <Button
            disabled={working !== null}
            className="mt-5 w-full bg-[#9f382b] text-white hover:bg-[#873025]"
            onClick={() => void revoke()}
          >
            {working ? (
              <>
                <CircleDashed className="size-4 animate-spin" />
                Removing access…
              </>
            ) : (
              <>
                <Unplug className="size-4" />
                Remove bank access
              </>
            )}
          </Button>
          <Button
            disabled={working !== null}
            variant="outline"
            className="mt-2 w-full"
            onClick={() => setConfirming(null)}
          >
            Keep connection
          </Button>
        </SheetContent>
      </Sheet>
    </section>
  );
}

function connectionStatus(connection: FinancialConnection) {
  if (connection.status === "healthy")
    return `${connection.historicalUpdateComplete ? "History is up to date" : connection.initialUpdateComplete ? "Accounts are up to date" : "Waiting for transactions"}`;
  if (connection.status === "login_required")
    return "Reconnect to continue syncing";
  if (connection.status === "revocation_pending")
    return "Accounts excluded · disconnecting";
  if (connection.status === "syncing" || connection.status === "pending")
    return "Updating accounts";
  return connection.errorCode ?? title(connection.status);
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-rule bg-white p-3">
      <span className="text-[10px] font-bold uppercase tracking-[.1em] text-muted">
        {label}
      </span>
      <p className="mt-1 text-sm font-semibold">{value}</p>
    </div>
  );
}

function ManualPlanSwitch({
  accounts,
  onSwitch,
  onDone,
}: {
  accounts: FinancialAccount[];
  onSwitch: () => Promise<boolean>;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const run = async () => {
    setWorking(true);
    const okay = await onSwitch();
    setWorking(false);
    if (okay) {
      setOpen(false);
      onDone();
    }
  };
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!working) setOpen(next);
      }}
    >
      <SheetTrigger asChild>
        <Button variant="ghost" className="mt-2 w-full">
          <PenLine className="size-4" />
          Use manual values in plan
        </Button>
      </SheetTrigger>
      <SheetContent
        title="Use manual values in the plan?"
        description="Your bank connections will stay available."
      >
        <div className="rounded-2xl border border-pencil/15 bg-pencil/[.04] p-4 text-sm leading-6">
          <strong>
            {accounts.length} connected{" "}
            {accounts.length === 1 ? "account" : "accounts"} will be excluded
            from spendable cash.
          </strong>
          <p className="mt-1 text-muted">
            Budgefi will use your manual cash balance instead. You can include a
            connected account again later.
          </p>
          {accounts.length > 0 && (
            <ul className="mt-3 list-disc pl-5 text-xs text-muted">
              {accounts.map((account) => (
                <li key={account.id}>{account.name}</li>
              ))}
            </ul>
          )}
        </div>
        <Button
          disabled={working}
          className="mt-5 w-full"
          onClick={() => void run()}
        >
          {working ? (
            <>
              <CircleDashed className="size-4 animate-spin" />
              Updating plan…
            </>
          ) : (
            "Use manual values"
          )}
        </Button>
        <Button
          disabled={working}
          variant="outline"
          className="mt-2 w-full"
          onClick={() => setOpen(false)}
        >
          Keep connected values
        </Button>
      </SheetContent>
    </Sheet>
  );
}
function formatMoney(minor: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(BigInt(minor)) / 100);
}
function formatObservedAt(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
function title(value: string) {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter: string) => letter.toUpperCase());
}
function sourceLabel(value: FinancialAccount["provenance"]) {
  return value === "manual" ? "Manual" : "Connected";
}
