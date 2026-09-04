import { lazy, Suspense } from "react";
import { clerkConfigured } from "@/lib/auth";

const ActiveClerkProvider = lazy(() => import("@/components/clerk-provider-active"));

export function OptionalAuthProvider({ children }: { children: React.ReactNode }) {
  if (!clerkConfigured) return children;
  return <Suspense fallback={<AuthLoading/>}><ActiveClerkProvider>{children}</ActiveClerkProvider></Suspense>;
}

function AuthLoading() {
  return <div className="app-boot grid min-h-dvh place-items-center bg-paper text-sm font-semibold text-muted">Opening Budgefi…</div>;
}
