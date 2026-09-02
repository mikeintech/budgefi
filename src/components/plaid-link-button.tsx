import { useEffect, useRef, useState } from "react";
import { CircleDashed, Plus, RefreshCw } from "lucide-react";
import { Browser } from "@capacitor/browser";
import { SystemSession } from "@budgefi/capacitor-system-session";
import {
  usePlaidLink,
  type PlaidLinkOnExitMetadata,
  type PlaidLinkOnSuccessMetadata,
} from "react-plaid-link";
import { Button } from "@/components/ui/button";
import { type FinancialConnection, useAppState } from "@/state/app-state";
import { isNativeApp, nativePlatform } from "@/lib/platform";
import { nativeSecureRemove, nativeSecureSet } from "@/lib/native-storage";
import { nativePlaidPendingKey, webPlaidPendingKey } from "@/lib/native-flows";

export type PlaidLinkActions = {
  createToken: (
    mode?: "create" | "update",
    connectionId?: string,
  ) => ReturnType<ReturnType<typeof useAppState>["createPlaidLinkToken"]>;
  exchange: ReturnType<typeof useAppState>["exchangePlaid"];
  completeUpdate: ReturnType<typeof useAppState>["completePlaidUpdate"];
  completeHosted?: ReturnType<typeof useAppState>["completeHostedPlaid"];
};

export function PlaidLinkButton({
  mode,
  connection,
  createToken,
  exchange,
  completeUpdate,
  onComplete,
  className,
}: PlaidLinkActions & {
  mode: "create" | "update";
  connection?: FinancialConnection;
  onComplete?: () => void;
  className?: string;
}) {
  const { bankConnectionsEnabled, completeHostedPlaid } = useAppState();
  const [session, setSession] =
    useState<Awaited<ReturnType<PlaidLinkActions["createToken"]>>>(null);
  const [phase, setPhase] = useState<
    | "idle"
    | "requesting"
    | "opening"
    | "exchanging"
    | "done"
    | "cancelled"
    | "error"
  >("idle");
  useEffect(() => {
    if (!isNativeApp) return;
    const finished = (event: Event) => {
      const detail = (
        event as CustomEvent<{ okay: boolean; sessionId: string }>
      ).detail;
      if (!session || detail.sessionId !== session.sessionId) return;
      setPhase(detail.okay ? "done" : "error");
      if (detail.okay) onComplete?.();
    };
    window.addEventListener("budgefi:plaid-complete", finished);
    return () => window.removeEventListener("budgefi:plaid-complete", finished);
  }, [onComplete, session]);
  const onSuccess = async (
    publicToken: string | null,
    metadata: PlaidLinkOnSuccessMetadata,
  ) => {
    if (!session) return setPhase("error");
    if (!isNativeApp) window.localStorage.removeItem(webPlaidPendingKey);
    setPhase("exchanging");
    const okay =
      mode === "update"
        ? await completeUpdate(session.sessionId, metadata.link_session_id)
        : publicToken
          ? await exchange(session.sessionId, publicToken, {
              linkSessionId: metadata.link_session_id,
              ...(metadata.institution
                ? {
                    institution: {
                      id: metadata.institution.institution_id,
                      name: metadata.institution.name,
                    },
                  }
                : {}),
            })
          : false;
    setPhase(okay ? "done" : "error");
    if (okay) onComplete?.();
  };
  const onExit = (error: unknown, _metadata: PlaidLinkOnExitMetadata) => {
    if (!isNativeApp) window.localStorage.removeItem(webPlaidPendingKey);
    setPhase(error ? "error" : "cancelled");
  };
  const start = async () => {
    setPhase("requesting");
    const created = await createToken(mode, connection?.id);
    if (!created) return setPhase("error");
    setSession(created);
    if (!isNativeApp)
      window.localStorage.setItem(
        webPlaidPendingKey,
        JSON.stringify({
          sessionId: created.sessionId,
          linkToken: created.linkToken,
          mode,
          expiresAt: created.expiration,
        }),
      );
    setPhase("opening");
    if (isNativeApp) {
      if (!created.hostedLinkUrl) return setPhase("error");
      await nativeSecureSet(nativePlaidPendingKey, {
        sessionId: created.sessionId,
        linkToken: created.linkToken,
        mode,
      });
      try {
        if (nativePlatform === "ios") {
          const result = await SystemSession.open({
            url: created.hostedLinkUrl,
            callbackScheme: "budgefi",
            prefersEphemeralSession: false,
          });
          const callback = new URL(result.callbackUrl);
          if (callback.searchParams.get("session_id") !== created.sessionId)
            throw new Error("Plaid returned an unexpected Link session");
          setPhase("exchanging");
          const okay = await completeHostedPlaid(
            created.sessionId,
            created.linkToken,
          );
          await nativeSecureRemove(nativePlaidPendingKey).catch(
            () => undefined,
          );
          setPhase(okay ? "done" : "error");
          if (okay) onComplete?.();
        } else {
          await Browser.open({
            url: created.hostedLinkUrl,
            presentationStyle: "popover",
            toolbarColor: "#f3eedf",
          });
        }
      } catch (error) {
        await nativeSecureRemove(nativePlaidPendingKey).catch(() => undefined);
        setPhase(
          (error as { code?: unknown } | null)?.code === "SESSION_CANCELLED"
            ? "cancelled"
            : "error",
        );
      }
    }
  };
  if (!bankConnectionsEnabled)
    return (
      <div className={className}>
        <Button
          variant="outline"
          size={mode === "create" ? "lg" : "default"}
          className={mode === "create" ? "w-full" : ""}
          disabled
        >
          {mode === "update" ? (
            <>
              <RefreshCw className="size-4" />
              Repair unavailable
            </>
          ) : (
            <>
              <Plus className="size-4" />
              Bank connections unavailable
            </>
          )}
        </Button>
        <p className="mt-2 text-xs leading-5 text-muted">
          Bank connections are temporarily unavailable. You can continue with
          manual setup and connect later.
        </p>
      </div>
    );
  if (phase === "done")
    return (
      <div
        role="status"
        className="rounded-2xl border border-leaf/20 bg-leaf/5 p-3 text-sm font-semibold text-leaf"
      >
        {mode === "update"
          ? "Connection repaired. Account refresh is running in the background."
          : "Bank connected. Accounts are syncing and will stay out of your plan until you review them."}
      </div>
    );
  const busy =
    phase === "requesting" || phase === "opening" || phase === "exchanging";
  return (
    <div className={className}>
      {!isNativeApp && session && phase === "opening" && (
        <PlaidLinkLauncher
          token={session.linkToken}
          onSuccess={(token, metadata) => void onSuccess(token, metadata)}
          onExit={onExit}
          onError={() => setPhase("error")}
        />
      )}
      <Button
        variant={mode === "create" ? "default" : "outline"}
        size={mode === "create" ? "lg" : "default"}
        className={mode === "create" ? "w-full" : ""}
        disabled={busy}
        onClick={() => void start()}
      >
        {phase === "requesting" || phase === "opening" ? (
          <>
            <CircleDashed className="size-4 animate-spin" />
            Opening secure connection…
          </>
        ) : phase === "exchanging" ? (
          <>
            <CircleDashed className="size-4 animate-spin" />
            Adding accounts…
          </>
        ) : mode === "update" ? (
          <>
            <RefreshCw className="size-4" />
            Repair connection
          </>
        ) : (
          <>
            <Plus className="size-4" />
            Connect a bank
          </>
        )}
      </Button>
      {phase === "cancelled" && (
        <p className="mt-2 text-xs text-muted">
          Connection closed. Nothing was added.
        </p>
      )}
      {phase === "error" && (
        <p role="alert" className="mt-2 text-xs font-semibold text-coral">
          The bank connection was not completed. Nothing was added. Review
          Accounts & data before trying again.
        </p>
      )}
    </div>
  );
}

function PlaidLinkLauncher({
  token,
  onSuccess,
  onExit,
  onError,
}: {
  token: string;
  onSuccess: (
    publicToken: string | null,
    metadata: PlaidLinkOnSuccessMetadata,
  ) => void;
  onExit: (error: unknown, metadata: PlaidLinkOnExitMetadata) => void;
  onError: () => void;
}) {
  const { open, ready, error } = usePlaidLink({ token, onSuccess, onExit });
  const opened = useRef(false);
  useEffect(() => {
    if (ready && !opened.current) {
      opened.current = true;
      open();
    }
  }, [ready, open]);
  useEffect(() => {
    if (error) onError();
  }, [error, onError]);
  return null;
}
