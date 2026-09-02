import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Wordmark } from "@/components/brand";
import { AppErrorBoundary } from "@/components/app-error-boundary";
import { ProtectedRoute } from "@/components/protected-route";
import { isNativeApp } from "@/lib/platform";

const LandingPage = lazyNamed(() => import("@/pages/landing"), "LandingPage");
const SignUpPage = lazyNamed(() => import("@/pages/auth"), "SignUpPage");
const SignInPage = lazyNamed(() => import("@/pages/auth"), "SignInPage");
const ForgotPasswordPage = lazyNamed(
  () => import("@/pages/auth"),
  "ForgotPasswordPage",
);
const NativeAuthHandoffPage = lazyNamed(
  () => import("@/pages/auth"),
  "NativeAuthHandoffPage",
);
const TodayPage = lazyNamed(() => import("@/pages/today"), "TodayPage");
const ReviewPage = lazyNamed(() => import("@/pages/review"), "ReviewPage");
const ReviewCasePage = lazyNamed(
  () => import("@/pages/review-case"),
  "ReviewCasePage",
);
const PlanPage = lazyNamed(() => import("@/pages/plan"), "PlanPage");
const ActivityPage = lazyNamed(
  () => import("@/pages/activity"),
  "ActivityPage",
);
const MorePage = lazyNamed(() => import("@/pages/more"), "MorePage");
const OnboardingPage = lazyNamed(
  () => import("@/pages/onboarding"),
  "OnboardingPage",
);
const ConnectionsPage = lazyNamed(
  () => import("@/pages/connections"),
  "ConnectionsPage",
);
const PlaidOAuthPage = lazyNamed(
  () => import("@/pages/plaid-oauth"),
  "PlaidOAuthPage",
);
const ManualEntryPage = lazyNamed(
  () => import("@/pages/manual-entry"),
  "ManualEntryPage",
);
const SettingsIndexPage = lazyNamed(
  () => import("@/pages/settings"),
  "SettingsIndexPage",
);
const SettingsDetailPage = lazyNamed(
  () => import("@/pages/settings"),
  "SettingsDetailPage",
);
const NotFoundPage = lazyNamed(
  () => import("@/pages/not-found"),
  "NotFoundPage",
);

export default function App() {
  return (
    <AppErrorBoundary>
      <RouteMetadata />
      <Suspense fallback={<RouteLoading />}>
        <Routes>
          <Route
            path="/"
            element={
              isNativeApp ? <Navigate to="/today" replace /> : <LandingPage />
            }
          />
          <Route path="/sign-up/*" element={<SignUpPage />} />
          <Route path="/sign-in/*" element={<SignInPage />} />
          <Route path="/forgot-password/*" element={<ForgotPasswordPage />} />
          <Route path="/native-auth/*" element={<NativeAuthHandoffPage />} />
          <Route
            path="/today"
            element={
              <Protected>
                <TodayPage />
              </Protected>
            }
          />
          <Route
            path="/review"
            element={
              <Protected>
                <ReviewPage />
              </Protected>
            }
          />
          <Route
            path="/review/:slug"
            element={
              <Protected>
                <ReviewCasePage />
              </Protected>
            }
          />
          <Route
            path="/plan"
            element={
              <Protected>
                <PlanPage />
              </Protected>
            }
          />
          <Route
            path="/activity"
            element={
              <Protected>
                <ActivityPage />
              </Protected>
            }
          />
          <Route
            path="/more"
            element={
              <Protected>
                <MorePage />
              </Protected>
            }
          />
          <Route
            path="/onboarding"
            element={
              <Protected>
                <OnboardingPage />
              </Protected>
            }
          />
          <Route
            path="/connections"
            element={
              <Protected>
                <ConnectionsPage />
              </Protected>
            }
          />
          <Route
            path="/open/plaid-oauth"
            element={
              <Protected>
                <PlaidOAuthPage />
              </Protected>
            }
          />
          <Route
            path="/manual"
            element={
              <Protected>
                <ManualEntryPage />
              </Protected>
            }
          />
          <Route
            path="/settings"
            element={
              <Protected>
                <SettingsIndexPage />
              </Protected>
            }
          />
          <Route
            path="/settings/:section/*"
            element={
              <Protected>
                <SettingsDetailPage />
              </Protected>
            }
          />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </AppErrorBoundary>
  );
}

function Protected({ children }: { children: React.ReactNode }) {
  return <ProtectedRoute>{children}</ProtectedRoute>;
}

const SITE_ORIGIN = "https://budgefi.com";

const routeTitles: Record<string, string> = {
  "/": "Financial clarity you can trace",
  "/sign-up": "Create account",
  "/sign-in": "Sign in",
  "/forgot-password": "Reset password",
  "/native-auth": "Continue securely",
  "/today": "Today",
  "/review": "Review",
  "/plan": "Plan",
  "/activity": "Activity",
  "/more": "More",
  "/onboarding": "Set up Budgefi",
  "/connections": "Accounts & data",
  "/open/plaid-oauth": "Connecting account",
  "/manual": "Manual workspace",
  "/settings": "Settings",
};

function RouteMetadata() {
  const { pathname } = useLocation();
  useEffect(() => {
    const rootPath =
      pathname.startsWith("/review/")
        ? "/review"
        : pathname.startsWith("/settings/")
          ? "/settings"
          : pathname;
    const section = routeTitles[rootPath] ?? "Page not found";
    const isPublicLanding = pathname === "/";
    const description = isPublicLanding
      ? "Budgefi helps households build a traceable cash plan, monitor account coverage, and review unusual charges without moving money."
      : "Your private Budgefi household finance workspace.";

    document.title = `${section} · Budgefi`;
    setMeta("description", description);
    setMeta("robots", isPublicLanding ? "index, follow" : "noindex, nofollow");
    setMeta("og:title", `${section} · Budgefi`, "property");
    setMeta("og:description", description, "property");
    setMeta("og:url", isPublicLanding ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${pathname}`, "property");
    setMeta("twitter:title", `${section} · Budgefi`);
    setMeta("twitter:description", description);

    const existingCanonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (isPublicLanding) {
      const canonical = existingCanonical ?? document.createElement("link");
      canonical.rel = "canonical";
      canonical.href = `${SITE_ORIGIN}/`;
      if (!existingCanonical) document.head.appendChild(canonical);
    } else {
      existingCanonical?.remove();
    }
  }, [pathname]);
  return null;
}

function setMeta(
  key: string,
  content: string,
  attribute: "name" | "property" = "name",
) {
  const selector = `meta[${attribute}="${key}"]`;
  let element = document.head.querySelector<HTMLMetaElement>(selector);
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute(attribute, key);
    document.head.appendChild(element);
  }
  element.content = content;
}

function RouteLoading() {
  return (
    <div
      className="paper-grain grid min-h-dvh place-items-center bg-paper p-5"
      aria-busy="true"
      aria-live="polite"
    >
      <div className="w-full max-w-[390px] rounded-[24px] border border-rule bg-sheet p-5 shadow-sheet">
        <Wordmark />
        <div className="mt-8 space-y-3">
          <div className="h-3 w-24 animate-pulse rounded-full bg-recessed" />
          <div className="h-8 w-3/4 animate-pulse rounded-xl bg-recessed" />
          <div className="h-28 animate-pulse rounded-[20px] bg-recessed/75" />
        </div>
        <p className="mt-5 text-sm font-semibold text-muted">
          Opening this page…
        </p>
      </div>
    </div>
  );
}

function lazyNamed<TModule, TName extends keyof TModule>(
  loader: () => Promise<TModule>,
  name: TName,
) {
  return lazy(async () => ({
    default: (await loader())[name] as React.ComponentType,
  }));
}
