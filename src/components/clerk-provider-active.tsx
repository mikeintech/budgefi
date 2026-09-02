import { ClerkProvider, useAuth, useClerk } from "@clerk/react";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import {
  authRouteUrl,
  clerkPublishableKey,
  setAccessTokenProvider,
  setSignOutProvider,
} from "@/lib/auth";
import { clearNativeSecureStorage } from "@/lib/native-storage";
import { isNativeApp } from "@/lib/platform";
import { disablePushBeforeSignOut } from "@/lib/native-notifications";
import { clearNativeCacheFiles } from "@/lib/native-cache";
import { shouldGateNativeSessionTransition } from "@/lib/native-session-transition";
import {
  clearNativeCleanupRequired,
  markNativeCleanupRequired,
  nativeCleanupRequired,
} from "@/lib/native-cleanup-marker";

export default function ActiveClerkProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider
      publishableKey={clerkPublishableKey!}
      afterSignOutUrl={authRouteUrl("/")}
      signInUrl={authRouteUrl("/sign-in")}
      signUpUrl={authRouteUrl("/sign-up")}
      appearance={{
        variables: {
          colorPrimary: "#3155c6",
          colorBackground: "#fffcf4",
          colorNeutral: "#565b57",
          borderRadius: "1rem",
          fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif",
        },
      }}
    >
      <AuthTokenBridge>{children}</AuthTokenBridge>
    </ClerkProvider>
  );
}

function AuthTokenBridge({ children }: { children: React.ReactNode }) {
  const { getToken, isLoaded, isSignedIn, sessionId } = useAuth();
  const { signOut } = useClerk();
  const previousSessionId = useRef<string | null>(null);
  const lastToken = useRef<string | null>(null);
  const cleanupQueue = useRef<Promise<void>>(Promise.resolve());
  const cleanupGeneration = useRef(0);
  const cleanupActive = useRef(false);
  const [cleanupPending, setCleanupPending] = useState(
    () => isNativeApp && nativeCleanupRequired(),
  );
  const [cleanupFailed, setCleanupFailed] = useState(false);
  const currentSessionId = isSignedIn ? sessionId ?? null : null;
  // Refs contain the session that was allowed to render previously. Detecting
  // the change during render prevents session B's Effects from starting before
  // the layout effect below has queued cleanup for session A.
  const transitionDetected = shouldGateNativeSessionTransition(
    previousSessionId.current,
    currentSessionId,
    isNativeApp,
  );
  let durableCleanupRequired = isNativeApp && nativeCleanupRequired();
  if (transitionDetected && !durableCleanupRequired) {
    try {
      markNativeCleanupRequired();
      durableCleanupRequired = true;
    } catch {
      durableCleanupRequired = true;
    }
  }
  useLayoutEffect(() => {
    const sessionChanged = Boolean(
      previousSessionId.current &&
        previousSessionId.current !== currentSessionId,
    );
    const cleanupRequired = isNativeApp && nativeCleanupRequired();
    if ((sessionChanged || cleanupRequired) && isNativeApp) {
      const generation = ++cleanupGeneration.current;
      const previousToken = lastToken.current;
      cleanupActive.current = true;
      setCleanupPending(true);
      setCleanupFailed(false);
      try {
        markNativeCleanupRequired();
      } catch {
        setCleanupPending(false);
        setCleanupFailed(true);
        return;
      }
      cleanupQueue.current = cleanupQueue.current
        .catch(() => undefined)
        .then(async () => {
          if (previousToken) {
            try {
              await disablePushBeforeSignOut(previousToken);
            } catch {
              // Push deregistration is best effort; local isolation is not.
            }
          }
          const clears = await Promise.allSettled([
            clearNativeCacheFiles(),
            clearNativeSecureStorage(),
          ]);
          if (clears.some((result) => result.status === "rejected")) {
            throw new Error("Native account data could not be cleared safely");
          }
          clearNativeCleanupRequired();
        });
      const queuedCleanup = cleanupQueue.current;
      void queuedCleanup.then(
        () => {
          if (
            cleanupGeneration.current === generation &&
            cleanupQueue.current === queuedCleanup
          ) {
            cleanupActive.current = false;
            setCleanupPending(false);
          }
        },
        () => {
          if (
            cleanupGeneration.current === generation &&
            cleanupQueue.current === queuedCleanup
          ) {
            cleanupActive.current = false;
            setCleanupPending(false);
            setCleanupFailed(true);
          }
        },
      );
    } else if (!cleanupActive.current) {
      setCleanupPending(false);
    }
    previousSessionId.current = currentSessionId;
    if (currentSessionId)
      void getToken().then((token) => {
        if (previousSessionId.current === currentSessionId)
          lastToken.current = token;
      });
    setAccessTokenProvider(
      currentSessionId ? async () => (await getToken()) ?? "" : null,
    );
    setSignOutProvider(async () => {
      if (isNativeApp) markNativeCleanupRequired();
      await signOut({ redirectUrl: authRouteUrl("/sign-in") });
    });
    return () => {
      setAccessTokenProvider(null);
      setSignOutProvider(null);
    };
  }, [getToken, isSignedIn, sessionId, signOut]);
  if (cleanupFailed)
    return (
      <div className="grid min-h-dvh place-items-center bg-paper px-6 text-center">
        <div className="max-w-sm">
          <p className="font-display text-2xl font-semibold text-ink">
            Account switch paused
          </p>
          <p className="mt-3 text-sm leading-6 text-muted">
            Budgefi could not safely clear the previous account from this
            device. Close and reopen the app before continuing.
          </p>
          <button
            type="button"
            className="mt-5 min-h-12 rounded-2xl bg-pencil px-5 text-sm font-bold text-white"
            onClick={() => window.location.reload()}
          >
            Try again
          </button>
        </div>
      </div>
    );
  if (
    !isLoaded ||
    transitionDetected ||
    durableCleanupRequired ||
    cleanupPending
  )
    return (
      <div className="grid min-h-dvh place-items-center bg-paper text-sm font-semibold text-muted">
        Opening Budgefi…
      </div>
    );
  return (
    <Fragment key={isSignedIn && sessionId ? sessionId : "anonymous"}>
      {children}
    </Fragment>
  );
}
