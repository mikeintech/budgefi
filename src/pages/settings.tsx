import { useEffect, useState } from "react";
import { UserProfile, useUser } from "@clerk/react";
import { Link, Navigate, useParams } from "react-router-dom";
import {
  Bell,
  ChevronRight,
  Database,
  Download,
  Eye,
  LockKeyhole,
  UserRound,
  Shield,
  SlidersHorizontal,
  Trash2,
  Users,
} from "lucide-react";
import { MobileShell } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  calculatePlanProjection,
  useAppState,
  type HouseholdMode,
} from "@/state/app-state";
import { money } from "@/lib/utils";
import { api, requestId } from "@/lib/api";
import { enablePushOnThisDevice } from "@/lib/native-notifications";
import { isNativeApp } from "@/lib/platform";
import { nativeLockStorageKey } from "@/components/native-runtime";
import {
  nativeSecureGet,
  nativeSecureSet,
  clearNativeSecureStorage,
} from "@/lib/native-storage";
import { BiometricAuth } from "@aparajita/capacitor-biometric-auth";
import type { NotificationPreferences } from "@budgefi/contracts";
import { signOutCurrentUser } from "@/lib/auth";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { Switch } from "@/components/ui/switch";
import { clearNativeCacheFiles } from "@/lib/native-cache";
import { clerkConfigured } from "@/lib/auth";
import {
  disablePushOnThisDevice,
  isPushEnabledOnThisDevice,
} from "@/lib/native-notifications";

const sections = [
  {
    slug: "profile",
    icon: UserRound,
    title: "Account",
    detail: "Name, sign-in methods, and account security",
  },
  {
    slug: "household",
    icon: Users,
    title: "Household",
    detail: "Personal or shared planning language",
  },
  {
    slug: "planning",
    icon: SlidersHorizontal,
    title: "Plan rules",
    detail: "Untouched cash and forecast behavior",
  },
  {
    slug: "notifications",
    icon: Bell,
    title: "Notifications",
    detail: "Push, email, and reminder controls",
  },
  {
    slug: "security",
    icon: LockKeyhole,
    title: "App security",
    detail: "Face ID, device lock, and privacy screen",
  },
  {
    slug: "privacy",
    icon: Shield,
    title: "Privacy & data",
    detail: "Permissions, sources, and access",
  },
] as const;

export function SettingsIndexPage() {
  const availableSections = clerkConfigured && !isNativeApp
    ? sections
    : sections.filter((item) => item.slug !== "profile");
  return (
    <MobileShell>
      <main className="px-4 pb-8 pt-5">
        <p className="eyebrow">Durable preferences</p>
        <h1 className="text-[31px] font-bold tracking-[-0.045em]">Settings</h1>
        <p className="mt-1 text-sm leading-5 text-muted">
          Manage household language, plan rules, and data access. Day-to-day
          money inputs live in Manual and Plan.
        </p>
        <section className="mt-5 overflow-hidden rounded-[22px] border border-rule bg-white">
          {availableSections.map(({ slug, icon: Icon, title, detail }) => (
            <Link
              key={slug}
              to={`/settings/${slug}`}
              className="flex min-h-[76px] items-center gap-3 border-b border-rule px-4 py-3 last:border-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-pencil"
            >
              <span className="grid size-10 place-items-center rounded-2xl bg-recessed text-pencil">
                <Icon className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <strong className="block text-sm">{title}</strong>
                <span className="block text-xs leading-4 text-muted">
                  {detail}
                </span>
              </span>
              <ChevronRight className="size-4 text-muted" />
            </Link>
          ))}
        </section>
      </main>
    </MobileShell>
  );
}

export function SettingsDetailPage() {
  const { section } = useParams();
  if (section === "calibration") return <Navigate to="/plan" replace />;
  if (section === "profile" && !clerkConfigured)
    return <Navigate to="/settings" replace />;
  if (!sections.some((item) => item.slug === section))
    return <Navigate to="/settings" replace />;
  return (
    <MobileShell>
      <main className="px-4 pb-8 pt-5">
        {section === "household" && <HouseholdSettings />}
        {section === "profile" && <ProfileSettings />}
        {section === "planning" && <PlanningSettings />}
        {section === "notifications" && <NotificationSettings />}
        {section === "security" && <SecuritySettings />}
        {section === "privacy" && <PrivacySettings />}
      </main>
    </MobileShell>
  );
}

function ProfileSettings() {
  const { isLoaded, user } = useUser();
  const [policyChecked, setPolicyChecked] = useState(false);
  useEffect(() => {
    if (!isLoaded || !user) return;
    if (!user.deleteSelfEnabled) {
      setPolicyChecked(true);
      return;
    }
    void user.reload().finally(() => setPolicyChecked(true));
  }, [isLoaded, user]);
  if (!isLoaded || (user?.deleteSelfEnabled && !policyChecked))
    return (
      <div className="grid min-h-[50dvh] place-items-center text-sm font-semibold text-muted">
        Opening account settings…
      </div>
    );
  if (!user) return <Navigate to="/sign-in" replace />;
  if (user.deleteSelfEnabled)
    return (
      <>
        <p className="eyebrow">Settings</p>
        <h1 className="text-[29px] font-bold tracking-[-0.045em]">Account</h1>
        <div role="alert" className="mt-5 rounded-[22px] border border-coral/25 bg-coral/[.05] p-5">
          <p className="text-sm font-semibold">Account settings need attention</p>
          <p className="mt-2 text-sm leading-6 text-muted">
            Profile editing is temporarily unavailable because account removal must go through Budgefi’s verified data-deletion process.
          </p>
          <Button asChild variant="outline" className="mt-4 w-full bg-white">
            <Link to="/settings/privacy">Open privacy & data</Link>
          </Button>
        </div>
      </>
    );
  return (
    <>
      <p className="eyebrow mb-3">Settings</p>
      <div className="-mx-4 overflow-hidden sm:mx-0 sm:rounded-[22px] sm:border sm:border-rule">
        <UserProfile
          routing="path"
          path="/settings/profile"
          appearance={{
            variables: {
              colorPrimary: "#3155c6",
              colorBackground: "#fffcf4",
              borderRadius: "1rem",
              fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif",
            },
            elements: {
              rootBox: "w-full",
              cardBox: "w-full shadow-none",
              card: "w-full border-0 bg-white shadow-none",
              navbar: "border-rule bg-paper",
              scrollBox: "bg-white",
            },
          }}
        />
      </div>
    </>
  );
}

function HouseholdSettings() {
  const state = useAppState();
  return (
    <>
      <p className="eyebrow">Settings</p>
      <h1 className="text-[29px] font-bold tracking-[-0.045em]">Household</h1>
      <p className="mt-1 text-sm leading-5 text-muted">
        Choose whether your plan uses personal or shared-household language.
      </p>
      <RadioGroup
        value={state.householdMode}
        onValueChange={(value) =>
          state.setHouseholdMode(value as HouseholdMode)
        }
        className="mt-5 space-y-2"
      >
        <SettingChoice
          value="solo"
          icon={LockKeyhole}
          title="Personal plan"
          detail="Language for one decision-maker."
        />
        <SettingChoice
          value="shared"
          icon={Users}
          title="Shared household"
          detail="Language for shared commitments and reimbursements."
        />
      </RadioGroup>
      {state.householdMode === "shared" && (
        <div className="mt-4 rounded-2xl bg-recessed p-4 text-xs leading-5 text-muted">
          Member invitations and permissions are not available yet. This
          preference currently changes planning language only.
        </div>
      )}
    </>
  );
}

function PlanningSettings() {
  const state = useAppState();
  const [draft, setDraft] = useState(state.planningBuffer);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const available = calculatePlanProjection(
    state.calibration,
    draft,
    state.authoritativeProjection.horizonEnd,
  ).available;
  const changed = draft !== state.planningBuffer;
  const shortfall = available < 0;
  return (
    <>
      <p className="eyebrow">Settings</p>
      <h1 className="text-[29px] font-bold tracking-[-0.045em]">Plan rules</h1>
      <p className="mt-1 text-sm leading-5 text-muted">
        These rules change the plan immediately and remain visible in its
        calculation.
      </p>
      <label
        className="mt-6 block text-sm font-semibold"
        htmlFor="planning-buffer"
      >
        Keep untouched
      </label>
      <p className="mt-1 text-xs text-muted">
        Cash Budgefi excludes from safe-to-spend for surprises.
      </p>
      <div className="mt-3 flex h-14 items-center rounded-2xl border border-rule bg-white px-4 focus-within:ring-2 focus-within:ring-pencil">
        <span className="text-lg font-semibold text-muted">$</span>
        <NumberInput
          id="planning-buffer"
          min={0}
          max={2000}
          inputMode="decimal"
          value={draft}
          onValueChange={(value) => {
            setDraft(value);
            setSaved(false);
          }}
          className="h-full min-w-0 flex-1 bg-transparent px-2 text-xl font-bold outline-none"
        />
      </div>
      <div className="mt-4 rounded-[20px] bg-ink p-4 text-white">
        <p className="text-[10px] font-bold uppercase tracking-[.1em] text-citron">
          {shortfall
            ? "Projected shortfall"
            : state.sourceStale
              ? "Partial-data preview"
              : "Plan consequence"}
        </p>
        <p className="mt-1 text-2xl font-bold tabular-nums">
          {money(Math.abs(available))} {shortfall ? "shortfall" : "preview"}
        </p>
        <p className="mt-1 text-xs text-white/60">
          {state.sourceStale ? "Before unobserved account activity · " : ""}
          through{" "}
          {new Intl.DateTimeFormat("en-US", {
            month: "long",
            day: "numeric",
            timeZone: "UTC",
          }).format(
            new Date(`${state.authoritativeProjection.horizonEnd}T12:00:00Z`),
          )}
        </p>
      </div>
      <Button
        disabled={!changed || saving}
        onClick={async () => {
          setSaving(true);
          const okay = await state.savePlanningBuffer(draft);
          setSaving(false);
          setSaved(okay);
        }}
        className="mt-5 w-full"
      >
        {saving ? "Saving…" : "Save plan rule"}
      </Button>
      {saved && (
        <Button asChild variant="outline" className="mt-2 w-full">
          <Link to="/plan">View updated plan</Link>
        </Button>
      )}
      <section className="mt-7">
        <h2 className="text-sm font-bold">Forecast behavior</h2>
        <div className="mt-2 overflow-hidden rounded-[20px] border border-rule bg-white">
          <StaticRow
            title="Planning horizon"
            detail={`Next ${state.authoritativeProjection.planningHorizonDays} days`}
          />
          <StaticRow title="Future income" detail="Exclude until observed" />
          <StaticRow
            title="Planned savings"
            detail="Reserve now for this horizon"
          />
        </div>
      </section>
    </>
  );
}

function NotificationSettings() {
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [devicePushEnabled, setDevicePushEnabled] = useState(false);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void api
      .notificationPreferences()
      .then(setPrefs)
      .catch((error) =>
        setMessage(
          error instanceof Error
            ? error.message
            : "Notification settings could not load",
        ),
      );
    if (isNativeApp) {
      void isPushEnabledOnThisDevice().then(setDevicePushEnabled);
    }
  }, []);
  if (!prefs)
    return (
      <>
        <p className="eyebrow">Settings</p>
        <h1 className="text-[29px] font-bold tracking-[-0.045em]">
          Notifications
        </h1>
        <p className="mt-5 rounded-2xl bg-recessed p-4 text-sm text-muted">
          {message || "Loading your notification choices…"}
        </p>
      </>
    );
  const save = async (next: NotificationPreferences) => {
    setSaving(true);
    setMessage("");
    try {
      const { emailVerified: _, ...update } = next;
      const saved = await api.updateNotificationPreferences({
        ...update,
        requestId: requestId(),
      });
      setPrefs(saved);
      setMessage("Notification choices saved.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Changes could not be saved",
      );
    } finally {
      setSaving(false);
    }
  };
  const toggle = (
    key: keyof Pick<
      NotificationPreferences,
      | "connectionHealth"
      | "commitmentReminders"
      | "exceptionActivity"
      | "weeklyDigest"
      | "lockScreenDetail"
    >,
  ) => (
    <ToggleRow
      title={
        (
          {
            connectionHealth: "Connection health",
            commitmentReminders: "Upcoming commitments",
            exceptionActivity: "Financial exceptions",
            weeklyDigest: "Weekly summary",
            lockScreenDetail: "Show details on lock screen",
          } as const
        )[key]
      }
      checked={prefs[key]}
      onChange={(checked) => void save({ ...prefs, [key]: checked })}
    />
  );
  return (
    <>
      <p className="eyebrow">Settings</p>
      <h1 className="text-[29px] font-bold tracking-[-0.045em]">
        Notifications
      </h1>
      <p className="mt-1 text-sm leading-5 text-muted">
        Choose the useful moments. Lock-screen messages stay generic unless you
        opt in to detail.
      </p>
      <section className="mt-5 overflow-hidden rounded-[20px] border border-rule bg-white">
        <ToggleRow
          title="Push notifications"
          detail={
            isNativeApp
              ? "Alerts on this phone; turning this off also pauses push delivery"
              : "Available in the installed mobile app"
          }
          checked={devicePushEnabled && prefs.pushEnabled}
          disabled={!isNativeApp || saving}
          onChange={async (checked) => {
            if (checked) {
              setMessage("Requesting permission…");
              try {
                const result = await enablePushOnThisDevice();
                if (!result.okay) {
                  setMessage(result.message);
                  return;
                }
                setDevicePushEnabled(true);
              } catch (error) {
                setMessage(
                  error instanceof Error
                    ? error.message
                    : "Push setup did not finish",
                );
                return;
              }
            } else {
              try {
                await disablePushOnThisDevice();
                setDevicePushEnabled(false);
              } catch (error) {
                setMessage(
                  error instanceof Error
                    ? error.message
                    : "Push could not be turned off on this phone",
                );
                return;
              }
            }
            await save({ ...prefs, pushEnabled: checked });
          }}
        />
        <ToggleRow
          title="Email"
          detail={
            prefs.emailVerified
              ? `Verified · ${prefs.emailAddress}`
              : "Add and verify an email in your sign-in account first"
          }
          checked={prefs.emailEnabled}
          disabled={!prefs.emailVerified || saving}
          onChange={(checked) => void save({ ...prefs, emailEnabled: checked })}
        />
      </section>
      <section className="mt-5 overflow-hidden rounded-[20px] border border-rule bg-white">
        {toggle("connectionHealth")}
        {toggle("commitmentReminders")}
        {toggle("exceptionActivity")}
        {toggle("weeklyDigest")}
        {toggle("lockScreenDetail")}
      </section>
      {message && (
        <p
          className="mt-4 rounded-2xl bg-recessed p-3 text-xs leading-5"
          role="status"
        >
          {message}
        </p>
      )}
      <p className="mt-4 text-xs leading-5 text-muted">
        Reminder time: {String(prefs.reminderHour).padStart(2, "0")}:00 ·{" "}
        {prefs.timezone}
      </p>
    </>
  );
}

function SecuritySettings() {
  const [enabled, setEnabled] = useState(false);
  const [available, setAvailable] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!isNativeApp) return;
    void Promise.all([
      nativeSecureGet<boolean>(nativeLockStorageKey),
      BiometricAuth.checkBiometry(),
    ]).then(([stored, bio]) => {
      setEnabled(Boolean(stored));
      setAvailable(bio.deviceIsSecure);
    });
  }, []);
  return (
    <>
      <p className="eyebrow">Settings</p>
      <h1 className="text-[29px] font-bold tracking-[-0.045em]">
        App security
      </h1>
      <p className="mt-1 text-sm leading-5 text-muted">
        Protect what appears on this device. Your server sign-in remains
        separate.
      </p>
      <section className="mt-5 overflow-hidden rounded-[20px] border border-rule bg-white">
        <ToggleRow
          title="Lock Budgefi"
          detail={
            isNativeApp
              ? available
                ? "Use Face ID, Touch ID, or device passcode"
                : "Set a device passcode first"
              : "Available in the installed mobile app"
          }
          checked={enabled}
          disabled={!isNativeApp || !available}
          onChange={async (checked) => {
            if (checked) {
              try {
                await BiometricAuth.authenticate({
                  reason: "Turn on Budgefi app lock",
                  allowDeviceCredential: true,
                });
              } catch {
                setMessage("App lock was not enabled.");
                return;
              }
            }
            await nativeSecureSet(nativeLockStorageKey, checked);
            setEnabled(checked);
            setMessage(
              checked
                ? "Budgefi will lock after you leave the app."
                : "App lock is off on this device.",
            );
          }}
        />
        <StaticRow
          title="App switcher privacy"
          detail={isNativeApp ? "Always on" : "Mobile app only"}
        />
        <StaticRow
          title="Offline financial cache"
          detail={
            isNativeApp
              ? "Protected by this device"
              : "Not stored for offline use"
          }
        />
      </section>
      {message && (
        <p className="mt-4 rounded-2xl bg-recessed p-3 text-xs" role="status">
          {message}
        </p>
      )}
    </>
  );
}

function PrivacySettings() {
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const exportData = async () => {
    setBusy(true);
    try {
      const payload = await api.exportAccount();
      const filename = `budgefi-export-${new Date()
        .toISOString()
        .slice(0, 10)}.json`;
      const contents = JSON.stringify(payload, null, 2);
      if (isNativeApp) {
        const file = await Filesystem.writeFile({
          path: filename,
          data: contents,
          directory: Directory.Cache,
          encoding: Encoding.UTF8,
        });
        await Share.share({
          title: "Budgefi data export",
          text: "Your Budgefi data export",
          url: file.uri,
          dialogTitle: "Save or share your export",
        });
        await Filesystem.deleteFile({
          path: filename,
          directory: Directory.Cache,
        }).catch(() => undefined);
      } else {
        const blob = new Blob([contents], { type: "application/json" });
        const href = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = href;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(href);
      }
      setMessage("Your export is ready.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Export could not be prepared",
      );
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (confirm !== "DELETE") return;
    setBusy(true);
    try {
      const status = await api.requestAccountDeletion({
        confirmation: "DELETE",
        requestId: requestId(),
      });
      await clearNativeCacheFiles();
      await clearNativeSecureStorage();
      const signedOut = await signOutCurrentUser();
      if (!signedOut) {
        setMessage(
          `Deletion requested. Status: ${status.status.replace(
            /_/g,
            " ",
          )}. Connected access and notifications are being revoked first.`,
        );
      }
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Deletion could not be requested",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="eyebrow">Settings</p>
      <h1 className="text-[29px] font-bold tracking-[-0.045em]">
        Privacy & data
      </h1>
      <p className="mt-1 text-sm leading-5 text-muted">
        Understand, export, or remove the information tied to your account.
      </p>
      <section className="mt-5 overflow-hidden rounded-[20px] border border-rule bg-white">
        <Permission
          icon={Eye}
          title="Balances and transactions"
          detail="Used to build and check your plan"
        />
        <Permission
          icon={LockKeyhole}
          title="Bank passwords stay private"
          detail="Budgefi never receives them"
        />
        <Permission
          icon={Shield}
          title="No money movement"
          detail="Connected accounts remain read-only"
        />
      </section>
      <section className="mt-6">
        <h2 className="text-sm font-bold">Your data</h2>
        <div className="mt-2 overflow-hidden rounded-[20px] border border-rule bg-white">
          <Link
            to="/connections"
            className="flex min-h-[68px] items-center gap-3 border-b border-rule px-4"
          >
            <Database className="size-5 text-pencil" />
            <span className="flex-1">
              <strong className="block text-sm">Accounts & data</strong>
              <span className="text-xs text-muted">
                Review or remove connected access
              </span>
            </span>
            <ChevronRight className="size-4 text-muted" />
          </Link>
          <button
            disabled={busy}
            onClick={exportData}
            className="flex min-h-[68px] w-full items-center gap-3 px-4 text-left"
          >
            <Download className="size-5 text-pencil" />
            <span className="flex-1">
              <strong className="block text-sm">Export my data</strong>
              <span className="text-xs text-muted">
                Download a readable JSON archive
              </span>
            </span>
          </button>
        </div>
      </section>
      <section className="mt-7 rounded-[20px] border border-coral/25 bg-white p-4">
        <div className="flex items-center gap-3">
          <Trash2 className="size-5 text-coral" />
          <h2 className="text-sm font-bold">Delete account</h2>
        </div>
        <p className="mt-2 text-xs leading-5 text-muted">
          This disables notifications, revokes connected providers, then deletes
          the account. This cannot be undone.
        </p>
        <label
          htmlFor="delete-confirm"
          className="mt-4 block text-xs font-bold"
        >
          Type DELETE to continue
        </label>
        <input
          id="delete-confirm"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          autoCapitalize="characters"
          className="field mt-2"
        />
        <Button
          variant="destructive"
          disabled={confirm !== "DELETE" || busy}
          onClick={remove}
          className="mt-3 w-full"
        >
          Request account deletion
        </Button>
      </section>
      {message && (
        <p
          className="mt-4 rounded-2xl bg-recessed p-3 text-xs leading-5"
          role="status"
        >
          {message}
        </p>
      )}
      <div className="mt-5 flex gap-4 text-xs font-bold text-pencil">
        <a href="/privacy.html" target="_blank" rel="noreferrer">
          Privacy policy
        </a>
        <a href="/terms.html" target="_blank" rel="noreferrer">
          Terms
        </a>
      </div>
    </>
  );
}

function ToggleRow({
  title,
  detail,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  detail?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-[70px] items-center gap-3 border-b border-rule px-4 py-3 last:border-0">
      <span className="min-w-0 flex-1">
        <strong className="block text-sm">{title}</strong>
        {detail && (
          <span className="block text-xs leading-4 text-muted">{detail}</span>
        )}
      </span>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        label={title}
      />
    </label>
  );
}

function SettingChoice({
  value,
  icon: Icon,
  title,
  detail,
}: {
  value: string;
  icon: typeof Users;
  title: string;
  detail: string;
}) {
  return (
    <label className="flex min-h-[76px] cursor-pointer items-center gap-3 rounded-[20px] border border-rule bg-white p-3 has-[[data-state=checked]]:border-pencil">
      <span className="grid size-10 place-items-center rounded-2xl bg-recessed text-pencil">
        <Icon className="size-5" />
      </span>
      <span className="flex-1">
        <strong className="block text-sm">{title}</strong>
        <span className="text-xs text-muted">{detail}</span>
      </span>
      <RadioGroupItem value={value} />
    </label>
  );
}
function StaticRow({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex min-h-[62px] items-center justify-between gap-4 border-b border-rule px-4 last:border-0">
      <span className="text-sm font-semibold">{title}</span>
      <span className="text-right text-xs text-muted">{detail}</span>
    </div>
  );
}
function Permission({
  icon: Icon,
  title,
  detail,
}: {
  icon: typeof Eye;
  title: string;
  detail: string;
}) {
  return (
    <div className="flex min-h-[76px] items-center gap-3 border-b border-rule px-4 py-3 last:border-0">
      <span className="grid size-10 place-items-center rounded-2xl bg-recessed text-pencil">
        <Icon className="size-5" />
      </span>
      <span>
        <strong className="block text-sm">{title}</strong>
        <span className="mt-0.5 block text-xs leading-4 text-muted">
          {detail}
        </span>
      </span>
    </div>
  );
}
