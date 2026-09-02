import { Link } from "react-router-dom";
import { SignOutButton } from "@clerk/react";
import {
  ChevronRight,
  Database,
  HelpCircle,
  PenLine,
  Settings2,
  Shield,
  type LucideIcon,
} from "lucide-react";
import { MobileShell } from "@/components/layout";
import { AccountMenu } from "@/components/account-menu";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useAppState } from "@/state/app-state";
import { authRouteUrl, clerkConfigured } from "@/lib/auth";

function InfoSheet({
  icon,
  title,
  detail,
  children,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  children: React.ReactNode;
}) {
  const Icon = icon;
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button className="w-full border-b border-ink/8 last:border-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cobalt">
          <div className="flex min-h-[70px] items-center gap-3 px-4 py-3 text-left">
            <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-paper-deep text-cobalt">
              <Icon className="size-5" strokeWidth={1.8} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{title}</span>
              <span className="block text-xs leading-4 text-muted">
                {detail}
              </span>
            </span>
            <ChevronRight className="size-4 text-muted" />
          </div>
        </button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        className="mx-auto max-w-[430px] rounded-t-[28px]"
      >
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{detail}</SheetDescription>
        </SheetHeader>
        <div className="mt-5 text-sm leading-6 text-muted">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

function AuthSessionControl() {
  return (
    <SignOutButton redirectUrl={authRouteUrl("/")}>
      <Button variant="outline" className="mt-4 w-full">
        Sign out of Budgefi
      </Button>
    </SignOutButton>
  );
}

export function MorePage() {
  const { sourceStale, dataMode, workspaceName, commitments } = useAppState();
  const initials =
    workspaceName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "BW";
  return (
    <MobileShell>
      <main className="px-4 pb-8 pt-5">
        <p className="eyebrow">Workspace & controls</p>
        <h1 className="text-[31px] font-bold tracking-[-0.04em]">More</h1>
        <Link
          to="/settings"
          className="mt-5 block rounded-[24px] bg-ink p-5 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil"
        >
          <div className="flex items-center gap-3">
            <span className="grid size-12 place-items-center rounded-2xl bg-citron font-bold text-ink">
              {initials}
            </span>
            <div>
              <p className="font-semibold">{workspaceName}</p>
              <p className="text-xs text-white/75">Private personal plan</p>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-2 text-xs text-white/70">
            <Shield className="size-4 text-citron" strokeWidth={1.8} />
            Your planning preferences
            <ChevronRight className="ml-auto size-4" />
          </div>
        </Link>

        <section className="mt-6 overflow-hidden rounded-[22px] border border-ink/10 bg-white">
          <MoreLink
            to="/manual"
            icon={PenLine}
            title="Manual workspace"
            detail={`${commitments.length} active commitment${commitments.length === 1 ? "" : "s"} · balances and actual charges`}
          />
          <MoreLink
            to="/connections"
            icon={Database}
            title="Accounts & data"
            detail={
              dataMode === "manual"
                ? "Manual values active · manage connection access here"
                : sourceStale
                  ? "At least one included source needs attention"
                  : "All included sources current"
            }
          />
          <MoreLink
            to="/settings"
            icon={Settings2}
            title="Settings"
            detail="Plan rules, notifications, security, and privacy"
          />
          <InfoSheet
            icon={HelpCircle}
            title="How Budgefi works"
            detail="A concise map of the current product"
          >
            <p>
              Today summarizes what needs attention. Plan explains what is
              reserved and lets you edit entries you created. Manual is where
              you maintain balances, actual charges, and commitments without
              connecting a bank. Activity separates the historical proof trail
              from upcoming obligations. Accounts & data controls which sources
              the plan includes.
            </p>
            <p className="mt-3">
              Connection-health and commitment reminders follow your
              notification settings when delivery is configured. Exact
              duplicate-charge detection runs on real and manual transactions,
              and every finding remains reviewable. Merchant contact and money
              movement are not available.
            </p>
          </InfoSheet>
        </section>

        {clerkConfigured && (
          <section className="mt-6 flex min-h-[72px] items-center gap-3 rounded-[22px] border border-ink/10 bg-white px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Sign-in account</p>
              <p className="text-xs leading-4 text-muted">
                Name, sign-in methods, and account security
              </p>
            </div>
            <AccountMenu showName compact />
          </section>
        )}
        {clerkConfigured && <AuthSessionControl />}
        <p className="mt-7 text-center text-[11px] font-medium text-muted">
          Budgefi early access
        </p>
      </main>
    </MobileShell>
  );
}

function MoreLink({
  to,
  icon: Icon,
  title,
  detail,
}: {
  to: string;
  icon: LucideIcon;
  title: string;
  detail: string;
}) {
  return (
    <Link
      to={to}
      className="flex min-h-[70px] items-center gap-3 border-b border-ink/8 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cobalt"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-paper-deep text-cobalt">
        <Icon className="size-5" strokeWidth={1.8} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-xs leading-4 text-muted">{detail}</span>
      </span>
      <ChevronRight className="size-4 text-muted" />
    </Link>
  );
}
