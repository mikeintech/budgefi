import { useCallback, useEffect, useRef, useState } from "react";
import { App as NativeApp } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { Network } from "@capacitor/network";
import { PrivacyScreen } from "@capacitor/privacy-screen";
import { PushNotifications } from "@capacitor/push-notifications";
import { SplashScreen } from "@capacitor/splash-screen";
import { StatusBar, Style } from "@capacitor/status-bar";
import { BiometricAuth } from "@aparajita/capacitor-biometric-auth";
import { LockKeyhole } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { appPathFromUrl, isNativeApp, nativePlatform } from "@/lib/platform";
import { nativeSecureGet, nativeSecureRemove, nativeSecureSet } from "@/lib/native-storage";
import { refreshPushRegistration } from "@/lib/native-notifications";
import { nativeAuthCallbackKey, nativeAuthStateKey, nativePlaidPendingKey, type NativePlaidPending } from "@/lib/native-flows";
import { useAppState } from "@/state/app-state";

const LOCK_KEY = "app-lock-enabled";
const LOCK_AFTER_MS = 15_000;

export function NativeRuntime({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { completeHostedPlaid } = useAppState();
  const completeHostedPlaidRef = useRef(completeHostedPlaid);
  completeHostedPlaidRef.current = completeHostedPlaid;
  const [ready, setReady] = useState(!isNativeApp);
  const [locked, setLocked] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const unlock = useCallback(async () => {
    if (!isNativeApp) return;
    setUnlocking(true);
    setUnlockError(null);
    try {
      await BiometricAuth.authenticate({
        reason: "Unlock your Budgefi plan",
        allowDeviceCredential: true,
        iosFallbackTitle: "Use Passcode",
        androidTitle: "Unlock Budgefi",
      });
      setLocked(false);
      void Haptics.impact({ style: ImpactStyle.Light });
    } catch {
      setUnlockError(
        "Budgefi is still locked. Use Face ID, Touch ID, or your device passcode to continue."
      );
    } finally {
      setUnlocking(false);
    }
  }, []);

  useEffect(() => {
    if (!isNativeApp) return;
    document.documentElement.dataset.platform = nativePlatform;
    let backgroundedAt = 0;
    const removers: Array<() => Promise<void>> = [];
    const setup = async () => {
      await StatusBar.setStyle({ style: Style.Dark });
      await StatusBar.setOverlaysWebView({ overlay: true });
      await PrivacyScreen.enable({
        ios: { blurEffect: "light" },
        android: { dimBackground: true, privacyModeOnActivityHidden: "dim" },
      });
      const lockEnabled = await nativeSecureGet<boolean>(LOCK_KEY).catch(
        () => false
      );
      if (lockEnabled) setLocked(true);
      const network = await Network.getStatus();
      window.dispatchEvent(
        new CustomEvent("budgefi:network", { detail: network })
      );
      const handleIncomingUrl = async (url: string) => {
        const incoming = new URL(url);
        if (incoming.hostname === "open" && incoming.pathname === "/plaid-complete") {
          await Browser.close().catch(() => undefined);
          const pending = await nativeSecureGet<NativePlaidPending>(nativePlaidPendingKey).catch(() => null);
          const returnedSession = incoming.searchParams.get("session_id");
          if (!pending || returnedSession !== pending.sessionId) {
            window.dispatchEvent(new CustomEvent("budgefi:plaid-complete", { detail: { okay: false, sessionId: returnedSession ?? "" } }));
            return;
          }
          const okay = await completeHostedPlaidRef.current(pending.sessionId, pending.linkToken);
          await nativeSecureRemove(nativePlaidPendingKey).catch(() => undefined);
          window.dispatchEvent(new CustomEvent("budgefi:plaid-complete", { detail: { okay, sessionId: pending.sessionId } }));
          return;
        }
        if (incoming.hostname === "open" && incoming.pathname === "/auth-complete") {
          const detail = {
            state: incoming.searchParams.get("state") ?? "",
            ticket: incoming.searchParams.get("ticket") ?? "",
          };
          await nativeSecureSet(nativeAuthCallbackKey, detail).catch(() => undefined);
          await Browser.close().catch(() => undefined);
          window.dispatchEvent(new CustomEvent("budgefi:auth-complete", { detail }));
          return;
        }
        if (incoming.hostname === "open" && incoming.pathname === "/auth-cancel") {
          await Promise.all([
            Browser.close().catch(() => undefined),
            nativeSecureRemove(nativeAuthStateKey).catch(() => undefined),
            nativeSecureRemove(nativeAuthCallbackKey).catch(() => undefined),
          ]);
          window.dispatchEvent(new Event("budgefi:auth-cancel"));
          return;
        }
        const path = appPathFromUrl(url);
        if (path) navigate(path);
      };
      removers.push(
        (
          await Network.addListener("networkStatusChange", (status) =>
            window.dispatchEvent(
              new CustomEvent("budgefi:network", { detail: status })
            )
          )
        ).remove,
        (
          await NativeApp.addListener("appUrlOpen", ({ url }) => void handleIncomingUrl(url))
        ).remove,
        (
          await NativeApp.addListener(
            "appStateChange",
            async ({ isActive }) => {
              if (!isActive) {
                backgroundedAt = Date.now();
                return;
              }
              window.dispatchEvent(new Event("budgefi:resume"));
              void refreshPushRegistration().catch(() => undefined);
              if (
                Date.now() - backgroundedAt >= LOCK_AFTER_MS &&
                (await nativeSecureGet<boolean>(LOCK_KEY).catch(() => false))
              )
                setLocked(true);
            }
          )
        ).remove,
        (
          await PushNotifications.addListener(
            "pushNotificationActionPerformed",
            ({ notification }) => {
              const rawPath =
                typeof notification.data?.path === "string"
                  ? notification.data.path
                  : "/today";
              const path = appPathFromUrl(`budgefi://open${rawPath}`);
              if (path) navigate(path);
            }
          )
        ).remove
      );
      const launch = await NativeApp.getLaunchUrl();
      if (launch?.url) await handleIncomingUrl(launch.url);
      void refreshPushRegistration().catch(() => undefined);
      setReady(true);
    };
    void setup().catch(() => setReady(true));
    return () => {
      delete document.documentElement.dataset.platform;
      removers.forEach((remove) => void remove());
    };
  }, [navigate]);

  useEffect(() => {
    if (!isNativeApp || !ready) return;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => void SplashScreen.hide());
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [ready]);

  useEffect(() => {
    if (!isNativeApp) return;
    const key = `budgefi:scroll:${location.pathname}`;
    const rootTab = [
      "/today",
      "/review",
      "/plan",
      "/activity",
      "/more",
    ].includes(location.pathname);
    const saved = rootTab ? Number(sessionStorage.getItem(key) ?? 0) : 0;
    requestAnimationFrame(() =>
      window.scrollTo({
        top: Number.isFinite(saved) ? saved : 0,
        behavior: "instant",
      })
    );
    return () => {
      if (rootTab) sessionStorage.setItem(key, String(window.scrollY));
    };
  }, [location.pathname]);

  if (!isNativeApp) return children;
  if (!ready)
    return <div className="min-h-dvh bg-paper" aria-label="Opening Budgefi" />;
  return (
    <>
      {children}
      {locked && (
        <div
          className="fixed inset-0 z-[100] grid place-items-center bg-ink px-6 text-white"
          role="dialog"
          aria-modal="true"
          aria-labelledby="native-lock-title"
        >
          <div className="w-full max-w-sm text-center">
            <span className="mx-auto grid size-16 place-items-center rounded-[22px] bg-white/10 text-citron">
              <LockKeyhole className="size-7" />
            </span>
            <p className="eyebrow mt-7 !text-white/55">Privacy lock</p>
            <h1
              id="native-lock-title"
              className="text-[32px] font-bold tracking-[-.045em]"
            >
              Budgefi is locked
            </h1>
            <p className="mt-3 text-sm leading-6 text-white/65">
              Unlock to view your household finances.
            </p>
            {unlockError && (
              <p
                className="mt-4 rounded-2xl bg-white/10 p-3 text-xs leading-5"
                role="alert"
              >
                {unlockError}
              </p>
            )}
            <Button
              onClick={unlock}
              disabled={unlocking}
              size="lg"
              className="mt-6 w-full bg-citron text-ink hover:bg-citron/90"
            >
              {unlocking ? "Checking…" : "Unlock Budgefi"}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

export const nativeLockStorageKey = LOCK_KEY;
