import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@clerk/react";
import { ShieldCheck } from "lucide-react";
import { clerkConfigured } from "@/lib/auth";
import { useAppState } from "@/state/app-state";

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const gated = <OnboardingGate>{children}</OnboardingGate>;
  return clerkConfigured ? <ClerkRoute>{gated}</ClerkRoute> : gated;
}

function ClerkRoute({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const location = useLocation();
  if (!isLoaded) return <div className="paper-grain grid min-h-dvh place-items-center bg-paper p-5" aria-live="polite"><div className="w-full max-w-[390px] rounded-[24px] border border-rule bg-sheet p-6 text-center shadow-sheet"><ShieldCheck className="mx-auto size-7 text-pencil"/><h1 className="mt-4 text-xl font-bold">Opening Budgefi</h1><p className="mt-2 text-sm text-muted">Your plan will appear when your account is ready.</p></div></div>;
  if (!isSignedIn) return <Navigate to="/sign-in" replace state={{ from: `${location.pathname}${location.search}` }} />;
  return children;
}

function OnboardingGate({children}:{children:React.ReactNode}) {
  const location=useLocation();
  const {backendStatus,onboardingCompleted}=useAppState();
  if(backendStatus==="connected"&&!onboardingCompleted&&location.pathname!=="/onboarding")return <Navigate to="/onboarding?from=first-login" replace/>;
  return children;
}
