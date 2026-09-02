import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleDashed, Landmark, RotateCcw } from "lucide-react";
import {
  usePlaidLink,
  type PlaidLinkOnExitMetadata,
  type PlaidLinkOnSuccessMetadata,
} from "react-plaid-link";
import { Link, useNavigate } from "react-router-dom";
import { Wordmark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { webPlaidPendingKey } from "@/lib/native-flows";
import { useAppState } from "@/state/app-state";

type PendingOAuth = {
  sessionId: string;
  linkToken: string;
  mode: "create" | "update";
  expiresAt: string;
};

export function PlaidOAuthPage() {
  const navigate = useNavigate();
  const { exchangePlaid, completePlaidUpdate } = useAppState();
  const pending = useMemo(readPending, []);
  const opened = useRef(false);
  const [phase, setPhase] = useState<
    "opening" | "finishing" | "error" | "expired"
  >(pending ? "opening" : "expired");

  const finish = useCallback(
    async (
      publicToken: string | null,
      metadata: PlaidLinkOnSuccessMetadata,
    ) => {
      if (!pending) return setPhase("expired");
      setPhase("finishing");
      const okay =
        pending.mode === "update"
          ? await completePlaidUpdate(
              pending.sessionId,
              metadata.link_session_id,
            )
          : publicToken
            ? await exchangePlaid(pending.sessionId, publicToken, {
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
      window.localStorage.removeItem(webPlaidPendingKey);
      if (okay) navigate("/connections?plaid=connected", { replace: true });
      else setPhase("error");
    },
    [completePlaidUpdate, exchangePlaid, navigate, pending],
  );

  const exit = useCallback(
    (error: unknown, _metadata: PlaidLinkOnExitMetadata) => {
      if (error) setPhase("error");
      else navigate("/connections", { replace: true });
    },
    [navigate],
  );

  const { open, ready, error } = usePlaidLink({
    token: pending?.linkToken ?? null,
    receivedRedirectUri: window.location.href,
    onSuccess: (token, metadata) => void finish(token, metadata),
    onExit: exit,
  });

  useEffect(() => {
    if (ready && pending && !opened.current) {
      opened.current = true;
      open();
    }
  }, [open, pending, ready]);
  useEffect(() => {
    if (error) setPhase("error");
  }, [error]);

  return (
    <main className="paper-grain grid min-h-dvh place-items-center bg-paper p-5">
      <section className="w-full max-w-[390px] rounded-[24px] border border-rule bg-sheet p-5 shadow-sheet">
        <Wordmark />
        <div className="mt-8 grid size-12 place-items-center rounded-2xl bg-pencil/8 text-pencil">
          {phase === "opening" || phase === "finishing" ? (
            <CircleDashed className="size-5 animate-spin" />
          ) : phase === "expired" ? (
            <RotateCcw className="size-5" />
          ) : (
            <Landmark className="size-5" />
          )}
        </div>
        <h1 className="mt-5 font-serif text-3xl font-semibold tracking-tight text-ink">
          {phase === "finishing"
            ? "Confirming your accounts"
            : phase === "expired"
              ? "Connection session expired"
              : phase === "error"
                ? "Connection needs another try"
                : "Returning to your bank connection"}
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted">
          {phase === "expired"
            ? "For your protection, bank connection sessions are temporary. Start again from Accounts & data."
            : phase === "error"
              ? "Nothing was added unless Budgefi could verify the connection. Return to Accounts & data to review or retry."
              : "Keep this page open while Budgefi securely completes the handoff."}
        </p>
        {(phase === "expired" || phase === "error") && (
          <Button asChild size="lg" className="mt-6 w-full">
            <Link to="/connections">Return to Accounts & data</Link>
          </Button>
        )}
      </section>
    </main>
  );
}

function readPending(): PendingOAuth | null {
  try {
    const value = JSON.parse(
      window.localStorage.getItem(webPlaidPendingKey) ?? "null",
    ) as Partial<PendingOAuth> | null;
    if (
      !value ||
      typeof value.sessionId !== "string" ||
      typeof value.linkToken !== "string" ||
      (value.mode !== "create" && value.mode !== "update") ||
      typeof value.expiresAt !== "string" ||
      new Date(value.expiresAt).getTime() <= Date.now()
    ) {
      window.localStorage.removeItem(webPlaidPendingKey);
      return null;
    }
    return value as PendingOAuth;
  } catch {
    window.localStorage.removeItem(webPlaidPendingKey);
    return null;
  }
}
