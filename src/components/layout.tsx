import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useState } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  RefreshCw,
  WifiOff,
} from "lucide-react";
import {
  ActivityIcon,
  MoreIcon,
  PlanIcon,
  ReviewIcon,
  TodayIcon,
  MissingSourceIcon,
  ObservedIcon,
} from "@/components/icons";
import { Wordmark } from "@/components/brand";
import { AccountMenu } from "@/components/account-menu";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAppState } from "@/state/app-state";
import { cn } from "@/lib/utils";
import { clerkConfigured } from "@/lib/auth";
import { isNativeApp } from "@/lib/platform";

const nav = [
  ["/today", "Today", TodayIcon],
  ["/review", "Review", ReviewIcon],
  ["/plan", "Plan", PlanIcon],
  ["/activity", "Activity", ActivityIcon],
  ["/more", "More", MoreIcon],
] as const;
export function MobileShell({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  const state = useAppState();
  const detail =
    loc.pathname.startsWith("/review/") ||
    loc.pathname.startsWith("/accounts/") ||
    loc.pathname.startsWith("/connections") ||
    loc.pathname.startsWith("/manual") ||
    loc.pathname.startsWith("/settings");
  const blocked =
    state.backendStatus === "loading" || state.backendStatus === "unavailable";
  const nativeRoot = isNativeApp && !detail;
  return (
    <div className="min-h-dvh bg-[#ded8ca] sm:px-4 sm:py-4">
      <div className="native-app-shell paper-grain relative mx-auto min-h-dvh w-full max-w-[430px] overflow-x-hidden sm:min-h-[calc(100dvh-32px)] sm:rounded-[26px] sm:border sm:border-carbon/10 sm:shadow-2xl">
        {!nativeRoot && <TopBar detail={detail} />}
        <div
          className={cn(
            detail ? "pb-6" : "safe-bottom",
            nativeRoot && "native-root-content",
          )}
          aria-busy={state.backendStatus === "loading"}
        >
          {blocked ? (
            <ServiceStatePanel
              status={state.backendStatus}
              error={state.backendError}
              onRetry={state.reloadBackend}
            />
          ) : (
            <>
              {state.backendStatus === "cached" && (
                <OfflineNotice
                  confirmedAt={state.lastConfirmedAt}
                  onRetry={state.reloadBackend}
                />
              )}{" "}
              {state.backendError && state.backendStatus !== "cached" && (
                <ServiceNotice
                  message={state.backendError}
                  onRetry={state.reloadBackend}
                />
              )}{" "}
              {children}
            </>
          )}
        </div>
        {!detail && !blocked && <BottomNav />}
      </div>
    </div>
  );
}

export function ServiceStatePanel({
  status,
  error,
  onRetry,
}: {
  status: "loading" | "unavailable" | "connected" | "cached";
  error: string | null;
  onRetry: () => void;
}) {
  if (status === "connected" || status === "cached") return null;
  if (status === "loading")
    return (
      <main className="px-4 pb-10 pt-8" aria-live="polite">
        <div className="rounded-[24px] border border-rule bg-white p-5 shadow-sheet">
          <span className="grid size-11 place-items-center rounded-2xl bg-pencil/8 text-pencil">
            <CircleDashed className="size-5 animate-spin" />
          </span>
          <p className="eyebrow mt-6">Just a moment</p>
          <h1 className="text-[28px] font-bold tracking-[-.04em]">
            Loading your plan
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted">
            Your balances and account status will appear when they are ready.
          </p>
          <div className="mt-6 space-y-2" aria-hidden="true">
            <div className="h-16 animate-pulse rounded-2xl bg-recessed/75" />
            <div className="h-16 animate-pulse rounded-2xl bg-recessed/55" />
            <div className="h-16 animate-pulse rounded-2xl bg-recessed/35" />
          </div>
        </div>
      </main>
    );
  return (
    <main className="px-4 pb-10 pt-8" role="alert">
      <div className="rounded-[24px] border border-coral/20 bg-white p-5 shadow-sheet">
        <span className="grid size-12 place-items-center rounded-2xl bg-coral/10 text-coral">
          <WifiOff className="size-6" />
        </span>
        <p className="eyebrow mt-6">Data unavailable</p>
        <h1 className="text-[28px] font-bold tracking-[-.04em]">
          We can’t load your money data
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted">
          Your balances and plan are hidden until Budgefi can confirm they are
          current.
        </p>
        {error && (
          <p className="mt-4 rounded-2xl bg-coral/[.06] p-3 text-xs leading-5 text-coral">
            {error}
          </p>
        )}
        <Button onClick={onRetry} className="mt-5 w-full">
          <RefreshCw className="size-4" />
          Try again
        </Button>
      </div>
    </main>
  );
}

function ServiceNotice({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      className="mx-4 mt-4 flex items-start gap-3 rounded-2xl border border-coral/20 bg-coral/[.06] p-3"
      role="alert"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-coral" />
      <div className="min-w-0 flex-1">
        <strong className="text-xs text-coral">
          Last action wasn’t confirmed
        </strong>
        <p className="mt-0.5 text-xs leading-5 text-muted">{message}</p>
      </div>
      <button
        onClick={onRetry}
        className="min-h-11 rounded-xl px-2 text-xs font-bold text-pencil focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil"
      >
        Refresh
      </button>
    </div>
  );
}
function OfflineNotice({
  confirmedAt,
  onRetry,
}: {
  confirmedAt: string | null;
  onRetry: () => void;
}) {
  return (
    <div
      className="mx-4 mt-3 flex items-center gap-3 rounded-2xl border border-pencil/15 bg-sheet p-3"
      role="status"
    >
      <WifiOff className="size-4 shrink-0 text-pencil" />
      <div className="min-w-0 flex-1">
        <strong className="block text-xs">Offline · view only</strong>
        <span className="block text-[11px] text-muted">
          Last confirmed{" "}
          {confirmedAt
            ? new Date(confirmedAt).toLocaleString([], {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })
            : "earlier"}
        </span>
      </div>
      <button
        onClick={onRetry}
        className="min-h-11 rounded-xl px-2 text-xs font-bold text-pencil"
      >
        Retry
      </button>
    </div>
  );
}

function TopBar({ detail }: { detail: boolean }) {
  const navg = useNavigate();
  const loc = useLocation();
  const { sourceStale, dataMode, backendStatus, workspaceName } = useAppState();
  const manual = dataMode === "manual";
  const fallback = locationFallback(loc.pathname);
  const nativeTitle = nativeDetailTitle(loc.pathname);
  return (
    <header
      className={cn(
        "sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-rule/80 bg-paper/95 px-4 backdrop-blur-sm",
        isNativeApp && "native-detail-header",
      )}
    >
      {detail ? (
        <button
          onClick={() =>
            isNativeApp
              ? navg(fallback, { replace: true })
              : window.history.length > 1
                ? navg(-1)
                : navg(fallback, { replace: true })
          }
          className="grid size-11 shrink-0 place-items-center rounded-xl border border-transparent hover:bg-recessed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil"
          aria-label="Back"
        >
          <ChevronLeft className="size-6" />
        </button>
      ) : (
        <Wordmark compact />
      )}
      {isNativeApp && detail && (
        <h1 className="pointer-events-none absolute inset-x-16 truncate text-center text-[17px] font-semibold">
          {nativeTitle}
        </h1>
      )}
      {isNativeApp && detail ? (
        <div className="ml-auto size-11" aria-hidden="true" />
      ) : (
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {clerkConfigured ? (
            <AccountMenu />
          ) : (
            <WorkspaceControl workspaceName={workspaceName} />
          )}
          <HealthSheet>
            <button
              className={cn(
                "flex h-11 min-w-[82px] shrink-0 items-center justify-center gap-2 rounded-xl border px-2.5 text-[13px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil",
                backendStatus === "unavailable" || (sourceStale && !manual)
                  ? "border-coral/35 bg-sheet text-carbon"
                  : "border-leaf/25 bg-sheet text-leaf",
              )}
            >
              <MissingSourceIcon
                className={cn(
                  "size-4",
                  backendStatus === "loading" && "animate-pulse",
                )}
              />
              <span>
                {backendStatus === "loading"
                  ? "Loading"
                  : backendStatus === "unavailable"
                    ? "Offline"
                    : manual
                      ? "Manual"
                      : sourceStale
                        ? "Review"
                        : "Current"}
              </span>
            </button>
          </HealthSheet>
        </div>
      )}
    </header>
  );
}

function WorkspaceControl({ workspaceName }: { workspaceName: string }) {
  const initials =
    workspaceName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "BW";
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          className="grid size-11 shrink-0 place-items-center rounded-xl border border-rule bg-sheet text-xs font-bold hover:bg-recessed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil"
          aria-label="Open workspace details"
        >
          {initials}
        </button>
      </SheetTrigger>
      <SheetContent title={workspaceName} description="Your planning space">
        <div className="rounded-xl border border-rule">
          <div className="flex min-h-14 w-full items-center justify-between px-3">
            <span>
              <b>Current account</b>
              <small className="block text-carbon/70">Private access</small>
            </span>
            <Badge tone="blue">Active</Badge>
          </div>
        </div>
        <div className="mt-3 rounded-xl bg-recessed p-3 text-xs leading-5 text-muted">
          This is your private personal plan. Shared access is not enabled.
        </div>
        <SheetClose asChild>
          <Button asChild variant="secondary" className="mt-4 w-full">
            <Link to="/settings">Open settings</Link>
          </Button>
        </SheetClose>
      </SheetContent>
    </Sheet>
  );
}

export function HealthSheet({ children }: { children: React.ReactNode }) {
  const {
    sourceStale,
    dataMode,
    accounts,
    backendStatus,
    backendError,
    reloadBackend,
  } = useAppState();
  const [checking, setChecking] = useState(false);
  const manual = dataMode === "manual";
  const shown = accounts.filter((account) =>
    manual ? account.provenance === "manual" : account.provenance !== "manual",
  );
  return (
    <Sheet>
      <SheetTrigger asChild>{children}</SheetTrigger>
      <SheetContent
        title="Source health"
        description={
          backendStatus === "unavailable"
            ? "Budgefi cannot confirm that your data is current."
            : manual
              ? "This plan uses values maintained by you."
              : sourceStale
                ? "At least one included account is stale or missing a balance."
                : "Every included account has current coverage."
        }
      >
        <div className="space-y-2">
          {shown.map((account) => (
            <SourceRow
              key={account.id}
              name={account.name}
              note={
                account.balanceAsOf
                  ? `Observed ${new Date(account.balanceAsOf).toLocaleString(
                      [],
                      {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      },
                    )}`
                  : "No balance observation"
              }
              impact={
                account.includeInPlan
                  ? "Included in observed cash"
                  : account.type === "credit"
                    ? "Activity only"
                    : "Protected from plan"
              }
              stale={
                account.coverage === "stale" || account.coverage === "missing"
              }
            />
          ))}
        </div>
        {shown.length === 0 && (
          <p className="rounded-xl border border-dashed border-rule p-4 text-sm text-muted">
            No accounts are available in this mode yet.
          </p>
        )}
        {backendError && (
          <p className="mt-3 rounded-xl bg-coral/8 p-3 text-xs leading-5 text-coral">
            {backendError}
          </p>
        )}
        {backendStatus === "unavailable" && (
          <Button onClick={reloadBackend} className="mt-4 w-full">
            <RefreshCw className="size-4" />
            Try again
          </Button>
        )}
        {backendStatus !== "unavailable" && sourceStale && !manual && (
          <div className="mt-4 grid gap-2">
            <Button
              disabled={checking}
              onClick={async () => {
                setChecking(true);
                await reloadBackend();
                setChecking(false);
              }}
              className="w-full"
            >
              <RefreshCw className={cn("size-4", checking && "animate-spin")} />
              {checking ? "Checking accounts" : "Check again"}
            </Button>
            <SheetClose asChild>
              <Button asChild variant="outline" className="w-full">
                <Link to="/connections">Review accounts &amp; sync</Link>
              </Button>
            </SheetClose>
          </div>
        )}
        {backendStatus === "connected" && !sourceStale && (
          <div className="mt-5 flex items-center gap-3 rounded-xl bg-leaf/8 p-4 text-leaf">
            <ObservedIcon className="size-6" />
            <div>
              <b>Coverage verified</b>
              <p className="text-sm">Every included balance is current.</p>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
function SourceRow({
  name,
  note,
  impact,
  stale = false,
}: {
  name: string;
  note: string;
  impact: string;
  stale?: boolean;
}) {
  return (
    <div className="flex min-h-[72px] items-center gap-3 rounded-xl border border-rule bg-sheet p-3">
      <span
        className={cn(
          "grid size-10 shrink-0 place-items-center rounded-lg",
          stale ? "bg-coral/8 text-coral" : "bg-pencil/8 text-pencil",
        )}
      >
        {stale ? (
          <MissingSourceIcon className="size-5" />
        ) : (
          <ObservedIcon className="size-5" />
        )}
      </span>
      <div className="min-w-0">
        <b>{name}</b>
        <p className="text-xs text-carbon/60">{note}</p>
        <p className="text-xs font-medium">{impact}</p>
      </div>
    </div>
  );
}

function BottomNav() {
  const { cases } = useAppState();
  const count = cases.filter((item) => item.status === "open").length;
  return (
    <nav
      className="native-tabbar fixed inset-x-0 bottom-0 z-40 mx-auto grid h-[86px] max-w-[430px] grid-cols-5 border-t border-rule bg-sheet/97 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm sm:bottom-4 sm:rounded-b-[26px]"
      aria-label="Primary navigation"
    >
      {nav.map(([to, label, Icon]) => (
        <NavLink
          key={to}
          to={to}
          end={to === "/today"}
          className={({ isActive }) =>
            cn(
              "relative flex min-w-0 flex-col items-center justify-center gap-1 text-[11.5px] font-semibold text-carbon/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-pencil",
              isActive && "text-pencil",
            )
          }
          children={({ isActive }) => (
            <>
              <span
                className={cn(
                  "relative grid size-11 place-items-center rounded-xl transition-colors",
                  isActive && "bg-citron",
                )}
              >
                <Icon className="size-6" strokeWidth={1.9} />
                {label === "Review" && count > 0 && (
                  <span className="tabular absolute -right-1 -top-1 grid size-5 place-items-center rounded-full bg-pencil text-[10px] font-bold text-white">
                    {count}
                  </span>
                )}
              </span>
              <span>{label}</span>
            </>
          )}
        />
      ))}
    </nav>
  );
}

function locationFallback(pathname: string): string {
  if (pathname !== "/settings" && pathname.startsWith("/settings/"))
    return "/settings";
  if (pathname === "/settings") return "/more";
  if (pathname.startsWith("/connections") || pathname.startsWith("/manual"))
    return "/more";
  if (pathname.startsWith("/review/")) return "/review";
  return "/today";
}

function nativeDetailTitle(pathname: string): string {
  if (pathname.startsWith("/settings/notifications")) return "Notifications";
  if (pathname.startsWith("/settings/security")) return "App security";
  if (pathname.startsWith("/settings/privacy")) return "Privacy & data";
  if (pathname.startsWith("/settings/household")) return "Household";
  if (pathname.startsWith("/settings/planning")) return "Plan rules";
  if (pathname === "/settings") return "Settings";
  if (pathname.startsWith("/connections")) return "Accounts & data";
  if (pathname.startsWith("/manual")) return "Manual workspace";
  if (pathname.startsWith("/review/")) return "Review";
  return "Budgefi";
}
