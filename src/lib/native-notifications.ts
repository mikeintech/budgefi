import { PushNotifications } from "@capacitor/push-notifications";
import { api, requestId } from "@/lib/api";
import { isNativeApp, nativePlatform } from "@/lib/platform";
import {
  nativeSecureGet,
  nativeSecureRemove,
  nativeSecureSet,
} from "@/lib/native-storage";
import { apiBaseUrl } from "@/lib/platform";
import { createSingleFlight } from "@/lib/single-flight";

const endpointKey = "notification-endpoint-id";
const devicePushKey = "notification-device-enabled";
type PushEnableResult = { okay: boolean; message: string };

export async function isNotificationPermissionDenied(): Promise<boolean> {
  if (!isNativeApp) return false;
  return (await PushNotifications.checkPermissions()).receive === "denied";
}

export async function openNotificationSettings(): Promise<void> {
  if (!isNativeApp) return;
  window.location.assign("app-settings:");
}

export async function isPushEnabledOnThisDevice(): Promise<boolean> {
  if (!isNativeApp || !(await nativeSecureGet<boolean>(devicePushKey)))
    return false;
  const permission = await PushNotifications.checkPermissions();
  if (permission.receive === "granted") return true;
  await disablePushOnThisDevice().catch(() => undefined);
  return false;
}

export const enablePushOnThisDevice: () => Promise<PushEnableResult> =
  createSingleFlight(enablePushOnThisDeviceOnce);

async function enablePushOnThisDeviceOnce(): Promise<PushEnableResult> {
  if (!isNativeApp)
    return {
      okay: false,
      message:
        "Install Budgefi on a supported phone to enable push notifications.",
    };
  let permission = await PushNotifications.checkPermissions();
  if (
    permission.receive === "prompt" ||
    permission.receive === "prompt-with-rationale"
  )
    permission = await PushNotifications.requestPermissions();
  if (permission.receive !== "granted")
    return {
      okay: false,
      message:
        "Notifications are off in your phone settings. Budgefi will continue without them.",
    };
  const token = await new Promise<string>((resolve, reject) => {
    const timeout = window.setTimeout(
      () =>
        reject(
          new Error("Your phone did not finish notification registration."),
        ),
      15_000,
    );
    let registered: { remove: () => Promise<void> } | null = null;
    let failed: { remove: () => Promise<void> } | null = null;
    void Promise.all([
      PushNotifications.addListener("registration", ({ value }) => {
        window.clearTimeout(timeout);
        resolve(value);
      }),
      PushNotifications.addListener("registrationError", () => {
        window.clearTimeout(timeout);
        reject(new Error("Your phone could not register for notifications."));
      }),
    ])
      .then(([success, error]) => {
        registered = success;
        failed = error;
        void PushNotifications.register();
      })
      .finally(() =>
        window.setTimeout(() => {
          void registered?.remove();
          void failed?.remove();
        }, 16_000),
      );
  });
  const priorEndpointId = await nativeSecureGet<string>(endpointKey);
  const endpoint = await api.registerNotificationEndpoint({
    platform: nativePlatform === "ios" ? "ios" : "android",
    token,
    deviceLabel: nativePlatform === "ios" ? "This iPhone" : "This phone",
    requestId: requestId(),
  });
  await nativeSecureSet(endpointKey, endpoint.id);
  await nativeSecureSet(devicePushKey, true);
  if (priorEndpointId && priorEndpointId !== endpoint.id)
    await api
      .disableNotificationEndpoint(priorEndpointId)
      .catch(() => undefined);
  return {
    okay: true,
    message: "Push notifications are ready on this device.",
  };
}

export async function refreshPushRegistration(): Promise<void> {
  if (!isNativeApp || !(await nativeSecureGet<boolean>(devicePushKey))) return;
  const permission = await PushNotifications.checkPermissions();
  if (permission.receive === "granted") await enablePushOnThisDevice();
  else await disablePushOnThisDevice().catch(() => undefined);
}
export async function disablePushOnThisDevice(): Promise<void> {
  const endpointId = await nativeSecureGet<string>(endpointKey);
  try {
    if (endpointId) await api.disableNotificationEndpoint(endpointId);
  } finally {
    await nativeSecureRemove(endpointKey);
    await nativeSecureRemove(devicePushKey);
  }
}
export async function disablePushBeforeSignOut(token: string): Promise<void> {
  const endpointId = await nativeSecureGet<string>(endpointKey);
  const id = requestId();
  if (endpointId)
    await fetch(`${apiBaseUrl()}/notifications/endpoints/${endpointId}`, {
      method: "DELETE",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Request-Id": id,
      },
      body: JSON.stringify({ requestId: id }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
  await nativeSecureRemove(endpointKey);
  await nativeSecureRemove(devicePushKey);
}
