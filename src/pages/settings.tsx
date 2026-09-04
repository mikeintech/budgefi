import { useEffect, useRef, useState } from "react";
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
import {
  disablePushOnThisDevice,
  enablePushOnThisDevice,
  isNotificationPermissionDenied,
  isPushEnabledOnThisDevice,
  openNotificationSettings,
} from "@/lib/native-notifications";
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
import { resolvePlanningHorizonFromSchedules } from "../../packages/domain/src/index.js";
import {
  IncomeScheduleEditor,
  IncomeScheduleList,
} from "@/components/income-schedule-editor";
import { clearNativeCacheFiles } from "@/lib/native-cache";
import { clerkConfigured } from "@/lib/auth";

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
  const { features } = useAppState();
  const availableSections = sections.filter(
    (item) =>
      (item.slug !== "profile" || (clerkConfigured && !isNativeApp)) &&
      (item.slug !== "household" || features.householdMode),
  );
  return (
    <MobileShell>
      <main className="px-4 pb-8 pt-5">
        <p className="eyebrow">Durable preferences</p>
        <h1 className="text-[31px] font-bold tracking-[-0.045em]">Settings</h1>
        <p className="mt-1 text-sm leading-5 text-muted">
          Manage plan rules, notifications, security, and data access.
          Day-to-day money inputs live in Manual and Plan.
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
  const { features } = useAppState();
  if (section === "calibration") return <Navigate to="/plan" replace />;
  if (section === "profile" && !clerkConfigured)
    return <Navigate to="/settings" replace />;
  if (section === "household" && !features.householdMode)
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
        <div
          role="alert"
          className="mt-5 rounded-[22px] border border-coral/25 bg-coral/[.05] p-5"
        >
          <p className="text-sm font-semibold">
            Account settings need attention
          </p>
          <p className="mt-2 text-sm leading-6 text-muted">
            Profile editing is temporarily unavailable because account removal
            must go through Budgefi’s verified data-deletion process.
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
              fontFamily:
                "Instrument Sans, ui-sans-serif, system-ui, sans-serif",
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
  const [fallbackDays, setFallbackDays] = useState(
    state.calibration.fallbackHorizonDays,
  );
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (dirty) return;
    setDraft(state.planningBuffer);
    setFallbackDays(state.calibration.fallbackHorizonDays);
  }, [state.revision, dirty]);
  const draftHorizon = resolvePlanningHorizonFromSchedules({
    today: state.authoritativeProjection.horizonStart,
    fallbackDays,
    schedules: state.incomeSchedules.map((item) => ({
      id: item.id,
      nextExpectedDate: item.nextExpectedDate,
      confirmed: item.confirmed,
      status: item.status,
    })),
  });
  const available = calculatePlanProjection(
    state.calibration,
    draft,
    draftHorizon.end,
    {
      horizonStart: state.authoritativeProjection.horizonStart,
      commitments: state.commitments,
      savingsGoals: state.savingsGoals,
      occurrences: state.occurrences,
    },
  ).available;
  const changed =
    draft !== state.planningBuffer ||
    fallbackDays !== state.calibration.fallbackHorizonDays;
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
        Cash cushion
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
            setDirty(true);
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
          }).format(new Date(`${draftHorizon.end}T12:00:00Z`))}
        </p>
      </div>
      <section className="mt-6 rounded-[20px] border border-rule bg-white p-4">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold">Income timing</h2>
            <p className="mt-1 text-xs leading-5 text-muted">
              Each reliable payday is tracked separately. The earliest sets the
              plan end date but never adds cash before the deposit arrives.
            </p>
          </div>
          <IncomeScheduleEditor compact />
        </div>
        <div className="mt-4">
          <IncomeScheduleList compact />
        </div>
        <label
          className="mt-3 block text-xs font-semibold"
          htmlFor="planning-fallback"
        >
          When payday is unknown
        </label>
        <select
          id="planning-fallback"
          value={fallbackDays}
          onChange={(event) => {
            setDirty(true);
            setSaved(false);
            setFallbackDays(Number(event.target.value));
          }}
          className="mt-2 h-12 w-full rounded-xl border border-rule px-3 text-base outline-none focus:ring-2 focus:ring-pencil"
        >
          <option value={7}>Plan 7 days ahead</option>
          <option value={14}>Plan 14 days ahead</option>
          <option value={21}>Plan 21 days ahead</option>
          <option value={30}>Plan 30 days ahead</option>
        </select>
      </section>
      <Button
        disabled={!changed || saving}
        onClick={async () => {
          setSaving(true);
          const okay = await state.savePlanningPolicy(
            {
              fallbackHorizonDays: fallbackDays,
            },
            draft,
          );
          setSaving(false);
          setSaved(okay);
          if (okay) setDirty(false);
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
            title="Goal contributions"
            detail="Planned only; progress requires verified movement"
          />
        </div>
      </section>
    </>
  );
}

function NotificationSettings() {
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [availableThreshold, setAvailableThreshold] = useState(250);
  const [devicePushEnabled, setDevicePushEnabled] = useState(false);
  const [pushPermissionDenied, setPushPermissionDenied] = useState(false);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const loadPreferences = () => {
    setPrefs(null);
    setMessage("");
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
  };
  useEffect(() => {
    loadPreferences();
    if (!isNativeApp) return;
    const refreshDeviceState = () => {
      void isPushEnabledOnThisDevice().then(setDevicePushEnabled);
      void isNotificationPermissionDenied().then(setPushPermissionDenied);
    };
    refreshDeviceState();
    window.addEventListener("focus", refreshDeviceState);
    document.addEventListener("visibilitychange", refreshDeviceState);
    return () => {
      window.removeEventListener("focus", refreshDeviceState);
      document.removeEventListener("visibilitychange", refreshDeviceState);
    };
  }, []);
  useEffect(() => {
    if (prefs)
      setAvailableThreshold(
        Number(BigInt(prefs.availableCashThreshold.minor)) / 100,
      );
  }, [prefs?.availableCashThreshold.minor]);
  if (!prefs)
    return (
      <>
        <p className="eyebrow">Settings</p>
        <h1 className="text-[29px] font-bold tracking-[-0.045em]">
          Notifications
        </h1>
        <div className="mt-5 rounded-2xl bg-recessed p-4 text-sm text-muted">
          <p>{message || "Loading your notification choices…"}</p>
          {message && (
            <Button
              type="button"
              variant="outline"
              className="mt-3 min-h-11 bg-white"
              onClick={loadPreferences}
            >
              Try again
            </Button>
          )}
        </div>
      </>
    );
  const persist = async (next: NotificationPreferences) => {
    const { emailVerified: _, version, ...update } = next;
    const saved = await api.updateNotificationPreferences({
      ...update,
      expectedVersion: version,
      requestId: requestId(),
    });
    setPrefs(saved);
    setMessage("Notification choices saved.");
  };
  const save = async (next: NotificationPreferences) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setMessage("");
    try {
      await persist(next);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Changes could not be saved",
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const toggle = (
    key: keyof Pick<
      NotificationPreferences,
      | "connectionHealth"
      | "commitmentReminders"
      | "incomeReminders"
      | "savingsReminders"
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
            incomeReminders: "Missed expected income",
            savingsReminders: "Planned savings",
            exceptionActivity: "Financial exceptions",
            weeklyDigest: "Weekly summary",
            lockScreenDetail: "Show details on lock screen",
          } as const
        )[key]
      }
      checked={prefs[key]}
      disabled={saving}
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
            if (savingRef.current) return;
            savingRef.current = true;
            setSaving(true);
            setMessage(checked ? "Requesting permission…" : "");
            try {
              if (checked) {
                const result = await enablePushOnThisDevice();
                if (!result.okay) {
                  setMessage(result.message);
                  setPushPermissionDenied(
                    await isNotificationPermissionDenied(),
                  );
                  return;
                }
                setDevicePushEnabled(true);
                setPushPermissionDenied(false);
              } else {
                await disablePushOnThisDevice();
                setDevicePushEnabled(false);
              }
              await persist({ ...prefs, pushEnabled: checked });
            } catch (error) {
              setMessage(
                error instanceof Error
                  ? error.message
                  : checked
                    ? "Push setup did not finish"
                    : "Push could not be turned off on this phone",
              );
            } finally {
              savingRef.current = false;
              setSaving(false);
            }
          }}
        />
        {isNativeApp && pushPermissionDenied && (
          <div className="border-b border-rule px-4 py-3">
            <p className="text-xs leading-5 text-muted">
              Notifications are blocked for Budgefi on this iPhone.
            </p>
            <Button
              type="button"
              variant="outline"
              className="mt-2 min-h-11 bg-white"
              onClick={() => void openNotificationSettings()}
            >
              Open iPhone Settings
            </Button>
          </div>
        )}
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
      <section className="mt-5 rounded-[20px] border border-rule bg-white p-4">
        <div className="flex min-h-11 items-center justify-between gap-4">
          <span className="min-w-0">
            <strong className="block text-sm">Low available cash</strong>
            <span className="mt-0.5 block text-xs leading-5 text-muted">
              Alert when Budgefi’s Available to use falls below the amount you choose.
            </span>
          </span>
          <Switch
            checked={prefs.availableCashAlerts}
            disabled={saving}
            onCheckedChange={(checked) =>
              void save({ ...prefs, availableCashAlerts: checked })
            }
            label="Low available cash alert"
          />
        </div>
        {prefs.availableCashAlerts && (
          <label className="mt-4 block border-t border-rule pt-4 text-xs font-semibold">
            Alert below
            <div className="mt-2 flex h-12 items-center rounded-xl border border-rule bg-white px-3 focus-within:ring-2 focus-within:ring-pencil">
              <span className="text-muted">$</span>
              <NumberInput
                value={availableThreshold}
                min={0}
                max={1_000_000}
                step="1"
                disabled={saving}
                onValueChange={setAvailableThreshold}
                onBlur={() => {
                  const minor = String(Math.round(Math.max(0, availableThreshold) * 100));
                  if (minor !== prefs.availableCashThreshold.minor)
                    void save({
                      ...prefs,
                      availableCashThreshold: { minor, currency: "USD" },
                    });
                }}
                className="h-full min-w-0 flex-1 bg-transparent px-2 text-lg font-bold outline-none"
              />
            </div>
            <span className="mt-2 block font-normal leading-5 text-muted">
              Uses the same plan calculation shown on Today. Stale or incomplete data will never trigger this alert.
            </span>
          </label>
        )}
        {prefs.availableCashAlerts &&
          !prefs.emailEnabled &&
          !(prefs.pushEnabled && devicePushEnabled) && (
            <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
              This will appear in Budgefi, but no email or phone delivery method is on.
            </p>
          )}
      </section>
      <section className="mt-5 overflow-hidden rounded-[20px] border border-rule bg-white">
        {toggle("connectionHealth")}
        {toggle("commitmentReminders")}
        {toggle("incomeReminders")}
        {toggle("savingsReminders")}
        {toggle("exceptionActivity")}
        {toggle("weeklyDigest")}
        {toggle("lockScreenDetail")}
      </section>
      <section className="mt-5 rounded-[20px] border border-rule bg-white p-4">
        <h2 className="text-sm font-bold">When should Budgefi remind you?</h2>
        <p className="mt-1 text-xs leading-5 text-muted">
          Choose up to two reminders. Yearly and three-month items use their own
          earlier timing.
        </p>
        <LeadDayPicker
          label="Most commitments"
          days={prefs.commitmentReminderDays}
          disabled={saving}
          onChange={(days) =>
            void save({ ...prefs, commitmentReminderDays: days })
          }
        />
        <LeadDayPicker
          label="Yearly or every three months"
          days={prefs.longTermReminderDays}
          disabled={saving}
          onChange={(days) =>
            void save({ ...prefs, longTermReminderDays: days })
          }
        />
        <LeadDayPicker
          label="Savings plans"
          days={prefs.savingsReminderDays}
          disabled={saving}
          onChange={(days) =>
            void save({ ...prefs, savingsReminderDays: days })
          }
        />
      </section>
      <section className="mt-5 rounded-[20px] border border-rule bg-white p-4">
        <h2 className="text-sm font-bold">Delivery time</h2>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="text-xs font-semibold">
            Reminder time
            <input
              type="time"
              value={timeValue(prefs.reminderHour * 60 + prefs.reminderMinute)}
              disabled={saving}
              onChange={(event) => {
                const minutes = parseTime(event.target.value);
                void save({
                  ...prefs,
                  reminderHour: Math.floor(minutes / 60),
                  reminderMinute: minutes % 60,
                });
              }}
              className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-pencil"
            />
          </label>
          <label className="text-xs font-semibold">
            Time zone
            <select
              value={prefs.timezone}
              disabled={saving}
              onChange={(event) =>
                void save({ ...prefs, timezone: event.target.value })
              }
              className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-pencil"
            >
              {[
                ...new Set([
                  prefs.timezone,
                  Intl.DateTimeFormat().resolvedOptions().timeZone,
                ]),
              ].map((zone) => (
                <option key={zone} value={zone}>
                  {zone === Intl.DateTimeFormat().resolvedOptions().timeZone
                    ? "This device"
                    : zone}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="mt-4 text-xs font-semibold">Quiet time</p>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <label className="text-[11px] text-muted">
            Starts
            <input
              type="time"
              value={timeValue(prefs.quietStartMinute)}
              disabled={saving}
              onChange={(event) =>
                void save({
                  ...prefs,
                  quietStartMinute: parseTime(event.target.value),
                })
              }
              className="mt-1 h-11 w-full rounded-xl border border-rule bg-white px-3 text-sm text-carbon"
            />
          </label>
          <label className="text-[11px] text-muted">
            Ends
            <input
              type="time"
              value={timeValue(prefs.quietEndMinute)}
              disabled={saving}
              onChange={(event) =>
                void save({
                  ...prefs,
                  quietEndMinute: parseTime(event.target.value),
                })
              }
              className="mt-1 h-11 w-full rounded-xl border border-rule bg-white px-3 text-sm text-carbon"
            />
          </label>
        </div>
        <p className="mt-2 text-xs leading-5 text-muted">
          A reminder that falls in quiet time waits until quiet time ends. Old
          reminders expire instead of arriving as a backlog.
        </p>
      </section>
      {message && (
        <p
          className="mt-4 rounded-2xl bg-recessed p-3 text-xs leading-5"
          role="status"
        >
          {message}
        </p>
      )}
    </>
  );
}

function LeadDayPicker({
  label,
  days,
  disabled,
  onChange,
}: {
  label: string;
  days: number[];
  disabled: boolean;
  onChange: (days: number[]) => void;
}) {
  const choices = [0, 1, 3, 7, 14, 30];
  return (
    <div className="mt-4">
      <p className="text-xs font-semibold">{label}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {choices.map((day) => {
          const selected = days.includes(day);
          return (
            <button
              key={day}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              onClick={() => {
                if (selected && days.length === 1) return;
                const next = (
                  selected
                    ? days.filter((item) => item !== day)
                    : days.length < 2
                      ? [...days, day]
                      : [days[0]!, day]
                ).sort((left, right) => right - left);
                onChange(next);
              }}
              className={`min-h-10 rounded-full border px-3 text-xs font-semibold ${selected ? "border-cobalt bg-cobalt text-white" : "border-rule bg-white text-carbon"}`}
            >
              {day === 0
                ? "Due day"
                : `${day} day${day === 1 ? "" : "s"} before`}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function timeValue(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function parseTime(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return Math.max(0, Math.min(1439, (hour || 0) * 60 + (minute || 0)));
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
