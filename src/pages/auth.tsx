import { useCallback, useEffect, useRef, useState } from "react";
import { SignIn, SignUp, useAuth, useSignIn } from "@clerk/react";
import { Browser } from "@capacitor/browser";
import { SystemSession } from "@budgefi/capacitor-system-session";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  FileCheck2,
  LockKeyhole,
  PenLine,
  ShieldCheck,
} from "lucide-react";
import { Wordmark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { authRouteUrl, clerkConfigured } from "@/lib/auth";
import { isNativeApp, nativePlatform } from "@/lib/platform";
import { api } from "@/lib/api";
import { nativeSecureGet, nativeSecureRemove, nativeSecureSet } from "@/lib/native-storage";
import { markNativeCleanupRequired } from "@/lib/native-cleanup-marker";
import {
  isUsableNativeAuthPending,
  nativeAuthCallbackKey,
  nativeAuthPendingLifetimeMs,
  nativeAuthStateKey,
  type NativeAuthCallback,
  type NativeAuthPending,
} from "@/lib/native-flows";

const editorialAsset = (name: string) =>
  `${import.meta.env.BASE_URL}assets/editorial/${name}`;

export function SignUpPage() {
  return clerkConfigured ? <ClerkEntry mode="signup" /> : <AuthUnavailable />;
}

export function SignInPage() {
  return clerkConfigured ? <ClerkEntry mode="signin" /> : <AuthUnavailable />;
}

export function ForgotPasswordPage() {
  return clerkConfigured ? <ClerkEntry mode="recovery" /> : <AuthUnavailable />;
}

function AuthUnavailable() {
  return (
    <AuthShell
      title="Sign-in is temporarily unavailable"
      intro="Budgefi could not open secure account access. Your financial information has not been loaded."
    >
      <div
        className="mt-7 rounded-[22px] border border-coral/20 bg-coral/[.045] p-5"
        role="alert"
      >
        <LockKeyhole className="size-6 text-coral" />
        <p className="mt-3 text-sm leading-6 text-muted">
          Please try again later. If this continues, contact Budgefi support.
        </p>
        <Button asChild variant="outline" className="mt-5 w-full bg-white">
          <Link to="/">Return home</Link>
        </Button>
      </div>
    </AuthShell>
  );
}

function ClerkEntry({ mode }: { mode: "signup" | "signin" | "recovery" }) {
  if (isNativeApp) return <NativeClerkEntry mode={mode} />;
  const { isLoaded, isSignedIn } = useAuth();
  const location = useLocation();
  const signup = mode === "signup";
  const recovery = mode === "recovery";
  const requested = (location.state as { from?: string } | null)?.from;
  // Clerk establishes the session after verification. Always re-enter through a
  // protected route so the server-backed onboarding gate decides what comes next.
  const returnTo =
    requested?.startsWith("/") && !requested.startsWith("//")
      ? requested
      : "/today";
  if (isLoaded && isSignedIn) return <Navigate to={returnTo} replace />;
  return (
    <AuthShell
      title=""
      intro=""
    >
      <div className="w-full">
        {signup ? (
          <SignUp
            routing="path"
            path="/sign-up"
            signInUrl="/sign-in"
            fallbackRedirectUrl={authRouteUrl(returnTo)}
            appearance={clerkAppearance}
          />
        ) : (
          <SignIn
            routing="path"
            path={recovery ? "/forgot-password" : "/sign-in"}
            signUpUrl="/sign-up"
            fallbackRedirectUrl={authRouteUrl(returnTo)}
            appearance={clerkAppearance}
          />
        )}
      </div>
      {recovery && (
        <p className="mx-auto mt-4 flex max-w-[400px] items-start gap-2 text-xs leading-5 text-muted">
          <LockKeyhole className="mt-0.5 size-4 shrink-0 text-pencil" />
          Choose “Forgot password?” to start recovery. Budgefi never sees your
          password or verification code.
        </p>
      )}
    </AuthShell>
  );
}

function NativeClerkEntry({ mode }: { mode: "signup" | "signin" | "recovery" }) {
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const { signIn } = useSignIn();
  const location = useLocation();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<"idle" | "opening" | "finishing" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const consuming = useRef(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const requested = (location.state as { from?: string } | null)?.from;
  const returnTo = requested?.startsWith("/") && !requested.startsWith("//") ? requested : "/today";

  const finish = useCallback(async ({ state, ticket }: NativeAuthCallback) => {
    if (consuming.current) return;
    consuming.current = true;
    setPhase("finishing");
    setMessage(null);
    try {
      const pending = await nativeSecureGet<NativeAuthPending>(nativeAuthStateKey);
      if (!isUsableNativeAuthPending(pending))
        throw new Error("This sign-in attempt expired. Start again from Budgefi.");
      if (!state || pending.state !== state || !ticket)
        throw new Error("The sign-in return could not be verified. Start again from Budgefi.");
      if (!signIn)
        throw new Error("Budgefi is still preparing sign in. Try again.");
      markNativeCleanupRequired();
      const ticketResult = await signIn.ticket({ ticket });
      if (ticketResult.error) throw ticketResult.error;
      if (signIn.status !== "complete" || !signIn.createdSessionId)
        throw new Error("Sign in needs another step. Start again to continue securely.");
      const finalization = await signIn.finalize();
      if (finalization.error) throw finalization.error;
      await Promise.all([nativeSecureRemove(nativeAuthStateKey), nativeSecureRemove(nativeAuthCallbackKey)]);
      navigate(pending.returnTo, { replace: true });
    } catch (error) {
      await Promise.all([
        nativeSecureRemove(nativeAuthStateKey).catch(() => undefined),
        nativeSecureRemove(nativeAuthCallbackKey).catch(() => undefined),
      ]);
      consuming.current = false;
      setMessage(error instanceof Error ? error.message : "Sign in was not completed.");
      setPhase("error");
    }
  }, [navigate, signIn]);

  useEffect(() => {
    const listener = (event: Event) => {
      void finish((event as CustomEvent<NativeAuthCallback>).detail);
    };
    window.addEventListener("budgefi:auth-complete", listener);
    const cancelListener = () => {
      consuming.current = false;
      setMessage("Sign in was canceled. Nothing changed in Budgefi.");
      setPhase("idle");
    };
    window.addEventListener("budgefi:auth-cancel", cancelListener);
    let browserListener: Awaited<ReturnType<typeof Browser.addListener>> | null = null;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    if (nativePlatform === "android")
      void Browser.addListener("browserFinished", () => {
        closeTimer = setTimeout(() => {
          if (phaseRef.current !== "opening" || consuming.current) return;
          void nativeSecureGet<NativeAuthCallback>(nativeAuthCallbackKey).then(
            async (callback) => {
              if (callback) return finish(callback);
              await nativeSecureRemove(nativeAuthStateKey).catch(() => undefined);
              setMessage("Sign in was canceled. Nothing changed in Budgefi.");
              setPhase("idle");
            },
          );
        }, 500);
      }).then((listenerHandle) => {
        browserListener = listenerHandle;
      });
    void nativeSecureGet<NativeAuthCallback>(nativeAuthCallbackKey).then((callback) => {
      if (callback) void finish(callback);
    });
    return () => {
      window.removeEventListener("budgefi:auth-complete", listener);
      window.removeEventListener("budgefi:auth-cancel", cancelListener);
      if (closeTimer) clearTimeout(closeTimer);
      void browserListener?.remove();
    };
  }, [finish]);

  if (authLoaded && isSignedIn) return <Navigate to={returnTo} replace />;
  const open = async () => {
    setPhase("opening");
    setMessage(null);
    try {
      const publicUrl = ((import.meta.env.VITE_NATIVE_AUTH_URL as string | undefined) ?? (import.meta.env.VITE_PUBLIC_APP_URL as string | undefined))?.trim();
      if (!publicUrl?.startsWith("https://"))
        throw new Error("Secure mobile sign in needs an HTTPS VITE_NATIVE_AUTH_URL.");
      const state = randomState();
      const createdAt = Date.now();
      await nativeSecureSet(nativeAuthStateKey, {
        state,
        returnTo,
        createdAt,
        expiresAt: createdAt + nativeAuthPendingLifetimeMs,
      } satisfies NativeAuthPending);
      const url = new URL(publicUrl);
      if (!import.meta.env.VITE_NATIVE_AUTH_URL) {
        const basePath = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
        url.pathname = `${basePath}native-auth`.replace(/\/+/g, "/");
      }
      const authParams = new URLSearchParams({ state, mode: mode === "signup" ? "signup" : "signin" }).toString();
      if (url.hash.startsWith("#/")) url.hash = `${url.hash.split("?", 1)[0]}?${authParams}`;
      else url.search = authParams;
      if (nativePlatform === "ios") {
        const result = await SystemSession.open({
          url: url.toString(),
          callbackScheme: "budgefi",
          prefersEphemeralSession: true,
        });
        const callback = new URL(result.callbackUrl);
        window.dispatchEvent(new CustomEvent("budgefi:auth-complete", {
          detail: {
            state: callback.searchParams.get("state") ?? "",
            ticket: callback.searchParams.get("ticket") ?? "",
          },
        }));
      } else {
        await Browser.open({ url: url.toString(), presentationStyle: "popover", toolbarColor: "#f3eedf" });
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sign in could not open.");
      setPhase("error");
    }
  };
  const signup = mode === "signup";
  return <AuthShell
    title={signup ? "Create your account" : mode === "recovery" ? "Recover your account" : "Welcome back"}
    intro={signup ? "Create your private Budgefi workspace, then set up your plan." : "Continue securely to your Budgefi plan."}
  >
    <div className="mt-7 rounded-[22px] border border-rule bg-white p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-pencil/8 text-pencil"><LockKeyhole className="size-5" /></span>
        <div><strong className="text-sm">Sign in securely</strong><p className="mt-1 text-xs leading-5 text-muted">A protected window opens over Budgefi and closes when you finish.</p></div>
      </div>
      {message && <p role="alert" className="mt-3 rounded-2xl bg-coral/[.07] p-3 text-xs font-semibold leading-5 text-coral">{message}</p>}
      <Button size="lg" className="mt-4 w-full" disabled={phase === "opening" || phase === "finishing"} onClick={() => void open()}>
        {phase === "opening" ? "Opening…" : phase === "finishing" ? "Finishing sign in…" : signup ? "Create account" : mode === "recovery" ? "Recover account" : "Sign in"}
      </Button>
    </div>
    <p className="mt-5 flex min-h-11 items-center justify-center text-center text-sm text-muted">
      {signup ? "Already have an account?" : "New to Budgefi?"}{" "}
      <Link className="-my-3 ml-1 flex min-h-11 items-center font-bold text-pencil" to={signup ? "/sign-in" : "/sign-up"}>{signup ? "Sign in" : "Create account"}</Link>
    </p>
  </AuthShell>;
}

export function NativeAuthHandoffPage() {
  if (!clerkConfigured)
    return <AuthShell title="Account sign in is unavailable" intro="Close this window and return to Budgefi."><p className="mt-6 rounded-2xl bg-coral/[.07] p-4 text-sm text-coral">Authentication is not configured on this environment.</p></AuthShell>;
  return <ConfiguredNativeAuthHandoffPage />;
}

function ConfiguredNativeAuthHandoffPage() {
  const { isLoaded, isSignedIn } = useAuth();
  const [params] = useSearchParams();
  const state = params.get("state") ?? "";
  const signup = params.get("mode") === "signup";
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const sent = useRef(false);
  const handoffUrl = new URL("/native-auth", window.location.origin);
  handoffUrl.searchParams.set("state", state);
  handoffUrl.searchParams.set("mode", signup ? "signup" : "signin");
  useEffect(() => {
    if (!isLoaded || !isSignedIn || sent.current || !/^[A-Za-z0-9_-]{43,128}$/.test(state)) return;
    sent.current = true;
    void api.createNativeAuthTicket({ state }).then((result) => {
      const callback = new URL("budgefi://open/auth-complete");
      callback.searchParams.set("state", result.state);
      callback.searchParams.set("ticket", result.ticket);
      window.location.assign(callback.toString());
    }).catch((reason) => {
      sent.current = false;
      setError(reason instanceof Error ? reason.message : "Budgefi could not finish sign in.");
    });
  }, [attempt, isLoaded, isSignedIn, state]);
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(state))
    return <AuthShell title="This sign-in link is invalid" intro="Close this window and start again from the Budgefi app."><p className="mt-6 rounded-2xl bg-coral/[.07] p-4 text-sm text-coral">The secure return state is missing or malformed.</p></AuthShell>;
  if (isSignedIn)
    return <AuthShell title="Returning to Budgefi" intro="Your account is verified. This window will close automatically.">
      {error ? (
        <div role="alert" className="mt-6 rounded-2xl bg-coral/[.07] p-4 text-sm text-coral">
          <p>{error}</p>
          <Button
            variant="outline"
            className="mt-4 w-full bg-white"
            onClick={() => {
              sent.current = false;
              setError(null);
              setAttempt((value) => value + 1);
            }}
          >
            Try returning again
          </Button>
        </div>
      ) : (
        <div className="mt-8 flex items-center gap-3 rounded-2xl border border-rule bg-white p-4"><span className="size-5 animate-spin rounded-full border-2 border-pencil/20 border-t-pencil"/><span className="text-sm font-semibold">Finishing secure sign in…</span></div>
      )}
      <a
        className="mt-4 flex min-h-11 items-center justify-center text-sm font-semibold text-muted"
        href={`budgefi://open/auth-cancel?state=${encodeURIComponent(state)}`}
      >
        Cancel and return to Budgefi
      </a>
    </AuthShell>;
  return <AuthShell title={signup ? "Create your account" : "Welcome back"} intro="Finish here, then you will return directly to the Budgefi app.">
    <div className="mt-7 flex justify-center">{signup ? <SignUp routing="path" path="/native-auth" forceRedirectUrl={handoffUrl.toString()} appearance={clerkAppearance}/> : <SignIn routing="path" path="/native-auth" forceRedirectUrl={handoffUrl.toString()} appearance={clerkAppearance}/>}</div>
  </AuthShell>;
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const clerkAppearance = {
  variables: {
    colorPrimary: "#3155c6",
    colorBackground: "#fffcf4",
    borderRadius: "1rem",
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif",
  },
  elements: {
    rootBox: "w-full",
    cardBox: "w-full shadow-none",
    card: "w-full border border-rule bg-white shadow-sheet",
    formButtonPrimary:
      "min-h-12 bg-pencil text-sm font-bold shadow-none hover:bg-pencil/90",
    formFieldInput:
      "min-h-12 rounded-xl border-rule bg-white shadow-none focus:border-pencil focus:ring-pencil",
    socialButtonsBlockButton:
      "min-h-12 rounded-xl border-rule bg-white shadow-none hover:bg-recessed/50",
    footer: "bg-transparent",
  },
};

function AuthShell({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: React.ReactNode;
}) {
  return (
    <div className="paper-grain min-h-dvh bg-paper sm:p-5">
      <div className="native-app-shell mx-auto min-h-dvh max-w-[1040px] overflow-hidden sm:min-h-[calc(100dvh-40px)] sm:rounded-[28px] sm:border sm:border-rule sm:bg-sheet sm:shadow-card lg:grid lg:grid-cols-[.9fr_1.1fr]">
        <section className="flex min-h-dvh flex-col px-5 pb-8 pt-4 sm:min-h-0 sm:px-8 lg:p-10">
          <header className="flex h-12 items-center">
            {isNativeApp ? (
              <div className="size-11" />
            ) : (
              <Link
                to="/"
                className="grid size-11 place-items-center rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil"
                aria-label="Back to landing"
              >
                <ArrowLeft className="size-5" />
              </Link>
            )}
            <div className="mx-auto">
              <Wordmark />
            </div>
            <div className="size-11" />
          </header>
          <main className="mx-auto flex w-full max-w-[430px] flex-1 flex-col justify-center py-7">
            {title && (
              <h1 className="text-[36px] font-bold leading-[1.02] tracking-[-.055em]">
                {title}
              </h1>
            )}
            {intro && <p className="mt-3 text-sm leading-6 text-muted">{intro}</p>}
            {children}
            <nav
              className="mt-5 flex justify-center gap-5 text-xs text-muted"
              aria-label="Legal"
            >
              <a className="flex min-h-11 items-center hover:text-ink" href="/privacy.html">
                Privacy
              </a>
              <a className="flex min-h-11 items-center hover:text-ink" href="/terms.html">
                Terms
              </a>
            </nav>
          </main>
        </section>
        <aside className="relative hidden overflow-hidden bg-ink p-10 text-white lg:flex lg:flex-col lg:justify-between">
          <img
            src={editorialAsset("ledger-folios.png")}
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute -right-10 -top-8 w-48 rotate-6 opacity-[.12] grayscale"
          />
          <div className="relative">
            <p className="text-[10px] font-bold uppercase tracking-[.13em] text-citron">
              Start your way
            </p>
            <h2 className="mt-3 max-w-[430px] text-[42px] font-bold leading-[1.02] tracking-[-.05em]">
              Your money. Your choices.
            </h2>
            <p className="mt-4 max-w-[440px] text-sm leading-6 text-white/60">
              Build the plan first. Add financial accounts only when you are
              ready.
            </p>
          </div>
          <div className="relative space-y-3">
            <AuthProof
              icon={LockKeyhole}
              text="Your profile stays separate from bank connections"
            />
            <AuthProof icon={PenLine} text="Manual setup is always available" />
            <AuthProof
              icon={ShieldCheck}
              text="Connected accounts remain read-only"
            />
            <AuthProof
              icon={FileCheck2}
              text="You choose what affects the plan"
            />
          </div>
        </aside>
      </div>
    </div>
  );
}
function AuthProof({
  icon: Icon,
  text,
}: {
  icon: typeof ShieldCheck;
  text: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[.045] p-4">
      <span className="grid size-10 place-items-center rounded-2xl bg-white/10 text-citron">
        <Icon className="size-5" />
      </span>
      <span className="text-sm font-semibold">{text}</span>
    </div>
  );
}
