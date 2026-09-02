import { Link } from "react-router-dom";
import { useAuth } from "@clerk/react";
import {
  AlertTriangle,
  ArrowRight,
  ChevronRight,
  CircleDashed,
  Copy,
  Eye,
  FileCheck2,
  Landmark,
  LockKeyhole,
  MonitorSmartphone,
  ReceiptText,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import { Wordmark } from "@/components/brand";
import { AccountMenu } from "@/components/account-menu";
import { Button } from "@/components/ui/button";
import { clerkConfigured } from "@/lib/auth";

const editorialAsset = (name: string) =>
  `${import.meta.env.BASE_URL}assets/editorial/${name}`;

export function LandingPage() {
  return (
    <div className="paper-grain min-h-dvh overflow-x-hidden bg-paper text-ink">
      <PublicHeader />
      <main>
        <section className="relative mx-auto grid max-w-[1180px] gap-12 px-5 pb-20 pt-10 sm:px-8 lg:grid-cols-[.92fr_1.08fr] lg:items-center lg:gap-16 lg:pb-28 lg:pt-20">
          <div className="relative z-10">
            <span className="inline-flex min-h-9 items-center rounded-full bg-citron px-3 text-[10px] font-bold uppercase tracking-[.12em]">
              Early access preview
            </span>
            <p className="mt-7 max-w-[370px] text-[11px] font-bold uppercase leading-[1.55] tracking-[.13em] text-pencil">
              Bills, subscriptions, and cash
              <br />
              made traceable
            </p>
            <h1 className="mt-4 max-w-[650px] text-[43px] font-bold leading-[.98] tracking-[-.06em] sm:text-[58px] lg:text-[68px]">
              Finding the charge is the easy part. See how Budgefi is designed
              to follow it through.
            </h1>
            <p className="mt-6 max-w-[580px] text-[17px] leading-7 text-muted sm:text-lg">
              Build a traceable cash plan and preview how Budgefi turns unusual
              charges into clear next steps.
            </p>
            <div className="mt-7 grid gap-2.5 sm:max-w-[520px] sm:grid-cols-2">
              <Button asChild size="lg" className="h-14">
                <Link to="/sign-up">Create account</Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="h-14 bg-white/60"
              >
                <a href="#how-it-works">See how it works</a>
              </Button>
            </div>
            <div className="mt-5 space-y-2 text-xs leading-5 text-muted">
              <TrustLine icon={MonitorSmartphone}>
                Start manually or connect accounts when you are ready.
              </TrustLine>
              <TrustLine icon={ShieldCheck}>
                Read-only by design · Approval first · No money movement
              </TrustLine>
            </div>
          </div>
          <div className="relative mx-auto w-full max-w-[330px] sm:max-w-[390px]">
            <img
              src={editorialAsset("pencil.png")}
              alt=""
              aria-hidden="true"
              className="pointer-events-none absolute -right-14 -top-12 hidden w-16 rotate-[11deg] drop-shadow-md lg:block"
            />
            <PhoneProof />
          </div>
        </section>

        <section className="relative overflow-hidden border-y border-rule bg-sheet/65">
          <img
            src={editorialAsset("receipt.png")}
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute -right-5 top-5 hidden w-32 rotate-6 opacity-80 lg:block"
          />
          <div className="relative mx-auto max-w-[1120px] px-5 py-16 sm:px-8 lg:py-24">
            <p className="font-display text-[35px] leading-[1.05] tracking-[-.035em] sm:text-[48px]">
              Receipts, not reassurance.
            </p>
            <p className="mt-3 max-w-[600px] text-base leading-6 text-muted">
              Every conclusion keeps the evidence, the decision, and the
              unresolved parts visible.
            </p>
            <div className="mt-8 grid gap-3 md:grid-cols-3">
              <PainCard
                icon={ReceiptText}
                title="A changed bill"
                detail="Expected $65.00. Observed $83.20. The difference needs context, not an automatic verdict."
              />
              <PainCard
                icon={Copy}
                title="A possible duplicate"
                detail="Two matching charges may still be legitimate. Budgefi asks before changing the record."
              />
              <PainCard
                icon={Unplug}
                title="A stale connection"
                detail="Incomplete coverage changes the confidence language before it changes your behavior."
              />
            </div>
          </div>
        </section>

        <section
          id="how-it-works"
          className="mx-auto max-w-[1120px] px-5 py-16 sm:px-8 lg:py-24"
        >
          <p className="eyebrow">The operating loop</p>
          <h2 className="max-w-[720px] text-[36px] font-bold leading-[1.02] tracking-[-.05em] sm:text-[52px]">
            Detection is only the beginning.
          </h2>
          <div className="mt-9 grid gap-4 md:grid-cols-3">
            <LoopCard
              number="01"
              icon={Eye}
              title="Observe"
              detail="Monitor connection health and check current real or manual transaction records for exact duplicates."
            />
            <LoopCard
              number="02"
              icon={FileCheck2}
              title="Decide"
              detail="Compare the saved evidence and record what the two charges mean before the case changes."
            />
            <LoopCard
              number="03"
              icon={CircleDashed}
              title="Follow up"
              detail="Keep the evidence and decision visible. Budgefi does not contact the merchant or move money."
            />
          </div>
        </section>

        <section className="bg-ink text-white">
          <div className="mx-auto grid max-w-[1120px] gap-10 px-5 py-16 sm:px-8 lg:grid-cols-2 lg:items-center lg:py-24">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[.13em] text-citron">
                A plan that shows its work
              </p>
              <h2 className="mt-3 text-[38px] font-bold leading-none tracking-[-.05em] sm:text-[50px]">
                No mystery number.
              </h2>
              <p className="mt-5 max-w-[500px] text-base leading-7 text-white/65">
                Future income stays out until it is received. Cleared charges
                are not counted twice. A stale source turns the answer into a
                partial-data preview.
              </p>
              <Button asChild variant="secondary" size="lg" className="mt-7">
                <Link to="/sign-up">
                  Build your plan <ArrowRight className="size-4" />
                </Link>
              </Button>
            </div>
            <PlanEquation />
          </div>
        </section>

        <section
          id="coverage"
          className="mx-auto grid max-w-[1120px] gap-10 px-5 py-16 sm:px-8 lg:grid-cols-[.9fr_1.1fr] lg:items-center lg:py-24"
        >
          <div>
            <p className="eyebrow">Coverage before conclusions</p>
            <h2 className="text-[36px] font-bold leading-[1.02] tracking-[-.05em] sm:text-[50px]">
              If the data is incomplete, the answer should say so.
            </h2>
            <p className="mt-5 text-base leading-7 text-muted">
              Connection health is part of the product, not a settings footnote.
            </p>
          </div>
          <div className="rounded-[26px] border border-rule bg-white p-4 shadow-sheet">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-[.1em] text-muted">
              Illustrative connection preview
            </p>
            <Source
              name="First Platypus Checking •42"
              detail="Current as of the last refresh"
              status="Included in observed cash"
            />
            <Source
              name="Joint Cash •07"
              detail="Current as of the last refresh"
              status="Included in observed cash"
            />
            <Source
              name="Everyday Card •19"
              detail="Last refresh is outside policy"
              status="Recent spending may be missing"
              stale
            />
          </div>
        </section>

        <section id="privacy" className="border-y border-rule bg-sheet/65">
          <div className="mx-auto max-w-[1120px] px-5 py-16 sm:px-8 lg:py-24">
            <div className="grid gap-7 lg:grid-cols-[.8fr_1.2fr]">
              <div>
                <p className="eyebrow">Permission boundaries</p>
                <h2 className="text-[34px] font-bold tracking-[-.05em]">
                  Control before automation.
                </h2>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Boundary
                  icon={Eye}
                  title="Read-only inputs"
                  detail="Balances and transactions support reconciliation."
                />
                <Boundary
                  icon={LockKeyhole}
                  title="Credentials stay elsewhere"
                  detail="Budgefi never receives your bank password."
                />
                <Boundary
                  icon={ShieldCheck}
                  title="Approval first"
                  detail="A proposed action is not an approved action."
                />
                <Boundary
                  icon={Landmark}
                  title="No money movement"
                  detail="Budgefi does not transfer funds in this build."
                />
              </div>
            </div>
          </div>
        </section>

        <section
          id="faq"
          className="mx-auto max-w-[900px] px-5 py-16 sm:px-8 lg:py-24"
        >
          <p className="eyebrow">Straight answers</p>
          <h2 className="text-[36px] font-bold tracking-[-.05em]">
            Frequently asked
          </h2>
          <div className="mt-7 divide-y divide-rule border-y border-rule">
            <Faq q="Does Budgefi move money?">
              No. Budgefi is read-only and asks before any decision is recorded.
            </Faq>
            <Faq q="Can I use it without connecting an account?">
              Yes. You can maintain balances, charges, and bills manually.
            </Faq>
            <Faq q="What happens when a source stops syncing?">
              The plan is marked as incomplete and shows which activity may be
              missing.
            </Faq>
            <Faq q="Does sign-up create a real account?">
              {clerkConfigured
                ? "Yes. Sign-up creates your private Budgefi account. Connecting a bank remains optional."
                : "Secure sign-up is temporarily unavailable."}
            </Faq>
          </div>
        </section>

        <section className="px-5 pb-10 sm:px-8">
          <div className="mx-auto max-w-[1120px] overflow-hidden rounded-[30px] bg-pencil px-6 py-12 text-white sm:px-10 lg:flex lg:items-center lg:justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[.13em] text-citron">
                Early access
              </p>
              <h2 className="mt-2 max-w-[650px] text-[36px] font-bold leading-none tracking-[-.05em] sm:text-[48px]">
                Give every money problem a visible next step.
              </h2>
            </div>
            <div className="mt-7 grid gap-2 lg:mt-0">
              <Button asChild size="lg" variant="secondary">
                <Link to="/sign-up">Create account</Link>
              </Button>
              <a
                href="#how-it-works"
                className="grid min-h-11 place-items-center text-sm font-semibold underline-offset-4 hover:underline"
              >
                See how it works
              </a>
            </div>
          </div>
        </section>
      </main>
      <footer className="border-t border-rule">
        <div className="mx-auto flex max-w-[1120px] flex-col gap-4 px-5 py-8 text-xs text-muted sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <Wordmark />
          <p>Early access · read-only financial planning</p>
          <div className="flex gap-5">
            <a href="/privacy.html" className="flex min-h-11 min-w-11 items-center">
              Privacy
            </a>
            <a href="/terms.html" className="flex min-h-11 min-w-11 items-center">
              Terms
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function PublicHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-rule/70 bg-paper/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-[1180px] items-center px-5 sm:px-8">
        <Link
          to="/"
          aria-label="Budgefi home"
          className="flex min-h-11 items-center rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil"
        >
          <Wordmark />
        </Link>
        <nav
          className="ml-auto flex items-center gap-1 sm:gap-3"
          aria-label="Public navigation"
        >
          <a
            href="#how-it-works"
            className="hidden min-h-11 items-center px-3 text-sm font-semibold sm:flex"
          >
            How it works
          </a>
          <a
            href="#privacy"
            className="hidden min-h-11 items-center px-3 text-sm font-semibold md:flex"
          >
            Data controls
          </a>
          {clerkConfigured ? (
            <ClerkPublicSession />
          ) : (
            <Link
              to="/sign-in"
              className="flex min-h-11 items-center px-3 text-sm font-bold text-pencil"
            >
              Sign in
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
function ClerkPublicSession() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded)
    return (
      <span
        className="h-10 w-20 animate-pulse rounded-xl bg-recessed"
        aria-label="Checking session"
      />
    );
  return isSignedIn ? (
    <div className="flex items-center gap-2">
      <Link
        to="/today"
        className="flex min-h-11 items-center px-2 text-sm font-bold text-pencil"
      >
        Open app
      </Link>
      <AccountMenu compact />
    </div>
  ) : (
    <Link
      to="/sign-in"
      className="flex min-h-11 items-center px-3 text-sm font-bold text-pencil"
    >
      Sign in
    </Link>
  );
}
function TrustLine({
  icon: Icon,
  children,
}: {
  icon: typeof ShieldCheck;
  children: React.ReactNode;
}) {
  return (
    <p className="flex items-start gap-2">
      <Icon className="mt-0.5 size-4 shrink-0 text-pencil" />
      <span>{children}</span>
    </p>
  );
}
function PhoneProof() {
  return (
    <div className="rounded-[34px] border-[5px] border-ink bg-ink p-1 shadow-card">
      <div className="overflow-hidden rounded-[25px] bg-sheet">
        <div className="flex h-14 items-center border-b border-rule px-4">
          <span className="size-5" />
          <strong className="mx-auto text-sm">Review case</strong>
          <span className="size-5" />
        </div>
        <div className="p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <span className="grid size-11 place-items-center rounded-2xl border border-rule bg-white text-pencil">
              <ReceiptText className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <strong className="block text-base">MetroNet</strong>
              <span className="text-xs font-semibold text-coral">
                Needs your decision
              </span>
            </span>
            <span className="rounded-md bg-pencil/10 px-2 py-1 text-[9px] font-bold uppercase tracking-[.08em] text-pencil">
              Illustrative
            </span>
          </div>
          <div className="mt-5 grid grid-cols-3 divide-x divide-rule border-y border-rule py-4 text-center">
            <ProofAmount label="Expected" value="$65.00" />
            <ProofAmount label="Observed" value="$83.20" />
            <ProofAmount label="Difference" value="+$18.20" alert />
          </div>
          <div className="mt-5 grid grid-cols-3 text-center">
            <Stage icon={Eye} title="Observe" detail="Complete" />
            <Stage
              icon={FileCheck2}
              title="Decide"
              detail="Current step"
              active
            />
            <Stage icon={CircleDashed} title="Verify" detail="Not started" />
          </div>
          <div className="mt-5 grid h-12 w-full place-items-center rounded-xl bg-pencil text-sm font-bold text-white">
            Review next step
          </div>
          <div className="mt-4 overflow-hidden rounded-2xl border border-rule bg-white">
            <ProofRow
              icon={AlertTriangle}
              text="Illustrative partial-data plan preview"
              alert
            />
            <ProofRow
              icon={FileCheck2}
              text="Reviewed commitments · one source stale"
            />
          </div>
        </div>
        <div className="mx-auto mb-2 h-1 w-20 rounded-full bg-ink" />
      </div>
    </div>
  );
}
function ProofAmount({
  label,
  value,
  alert = false,
}: {
  label: string;
  value: string;
  alert?: boolean;
}) {
  return (
    <div className="px-1">
      <span className="block text-[10px] text-muted">{label}</span>
      <strong
        className={
          alert
            ? "tabular mt-1 block text-base text-coral"
            : "tabular mt-1 block text-base"
        }
      >
        {value}
      </strong>
    </div>
  );
}
function Stage({
  icon: Icon,
  title,
  detail,
  active = false,
}: {
  icon: typeof Eye;
  title: string;
  detail: string;
  active?: boolean;
}) {
  return (
    <div>
      <span
        className={
          active
            ? "mx-auto grid size-9 place-items-center rounded-full border-2 border-pencil text-pencil"
            : "mx-auto grid size-9 place-items-center rounded-full border border-muted/50 text-muted"
        }
      >
        <Icon className="size-4" />
      </span>
      <strong
        className={
          active ? "mt-2 block text-xs text-pencil" : "mt-2 block text-xs"
        }
      >
        {title}
      </strong>
      <span className="block text-[10px] text-muted">{detail}</span>
    </div>
  );
}
function ProofRow({
  icon: Icon,
  text,
  alert = false,
}: {
  icon: typeof AlertTriangle;
  text: string;
  alert?: boolean;
}) {
  return (
    <div className="flex min-h-12 items-center gap-2 border-b border-rule px-3 last:border-0">
      <Icon
        className={
          alert ? "size-4 shrink-0 text-coral" : "size-4 shrink-0 text-pencil"
        }
      />
      <span className="text-[11px] font-medium">{text}</span>
      <ChevronRight className="ml-auto size-4 text-muted" />
    </div>
  );
}
function PainCard({
  icon: Icon,
  title,
  detail,
}: {
  icon: typeof ReceiptText;
  title: string;
  detail: string;
}) {
  return (
    <article className="rounded-[22px] border border-rule bg-white p-5">
      <span className="mb-4 grid size-10 place-items-center rounded-2xl bg-recessed text-pencil">
        <Icon className="size-5" />
      </span>
      <h3 className="text-lg font-bold">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-muted">{detail}</p>
    </article>
  );
}
function LoopCard({
  number,
  icon: Icon,
  title,
  detail,
}: {
  number: string;
  icon: typeof Eye;
  title: string;
  detail: string;
}) {
  return (
    <article className="relative rounded-[24px] border border-rule bg-sheet p-5 shadow-sheet">
      <span className="font-mono text-[10px] text-muted">{number}</span>
      <span className="mt-8 grid size-11 place-items-center rounded-2xl bg-pencil text-white">
        <Icon className="size-5" />
      </span>
      <h3 className="mt-4 text-xl font-bold">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-muted">{detail}</p>
    </article>
  );
}
function PlanEquation() {
  const rows = [
    ["Observed cash", "$4,230.39"],
    ["Reviewed commitments", "−$2,166.39"],
    ["Planned savings", "−$500"],
    ["Keep untouched", "−$280"],
  ];
  return (
    <div className="overflow-hidden rounded-[24px] border border-white/15 bg-white/[.06] p-5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-[.12em] text-citron">
          Illustrative preview
        </span>
        <span className="rounded-full bg-white/10 px-2 py-1 text-[9px] font-bold uppercase">
          1 source stale
        </span>
      </div>
      <p className="tabular mt-3 text-[42px] font-bold tracking-[-.05em]">
        $1,284
      </p>
      <p className="text-sm text-white/60">
        Example safe-to-spend calculation
      </p>
      <div className="mt-5 divide-y divide-white/10 border-t border-white/10">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex min-h-12 items-center justify-between gap-4 text-sm"
          >
            <span className="text-white/60">{label}</span>
            <strong className="tabular">{value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}
function Source({
  name,
  detail,
  status,
  stale = false,
}: {
  name: string;
  detail: string;
  status: string;
  stale?: boolean;
}) {
  return (
    <div className="flex min-h-[76px] items-center gap-3 border-b border-rule px-2 py-3 last:border-0">
      <span
        className={
          stale
            ? "grid size-10 place-items-center rounded-2xl bg-coral/10 text-coral"
            : "grid size-10 place-items-center rounded-2xl bg-pencil/10 text-pencil"
        }
      >
        {stale ? (
          <AlertTriangle className="size-5" />
        ) : (
          <Landmark className="size-5" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block text-sm">{name}</strong>
        <span className="block text-xs text-muted">{detail}</span>
        <span
          className={
            stale
              ? "text-[11px] font-semibold text-coral"
              : "text-[11px] font-semibold text-teal"
          }
        >
          {status}
        </span>
      </span>
    </div>
  );
}
function Boundary({
  icon: Icon,
  title,
  detail,
}: {
  icon: typeof Eye;
  title: string;
  detail: string;
}) {
  return (
    <div className="rounded-[20px] border border-rule bg-white p-4">
      <Icon className="size-5 text-pencil" />
      <strong className="mt-4 block text-sm">{title}</strong>
      <p className="mt-1 text-xs leading-5 text-muted">{detail}</p>
    </div>
  );
}
function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className="group">
      <summary className="flex min-h-[68px] cursor-pointer list-none items-center gap-4 py-4 text-sm font-bold">
        <span className="flex-1">{q}</span>
        <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
      </summary>
      <p className="max-w-[720px] pb-5 text-sm leading-6 text-muted">
        {children}
      </p>
    </details>
  );
}
