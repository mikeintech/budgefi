import { KeychainAccess, SecureStorage } from "@aparajita/capacitor-secure-storage";
import { isNativeApp } from "@/lib/platform";

const prefix = "budgefi.native.";
let configured: Promise<void> | null = null;

async function prepare(): Promise<void> {
  if (!isNativeApp) return;
  configured ??= Promise.all([
    SecureStorage.setKeyPrefix(prefix),
    SecureStorage.setSynchronize(false),
    SecureStorage.setDefaultKeychainAccess(KeychainAccess.whenPasscodeSetThisDeviceOnly),
  ]).then(() => undefined);
  await configured;
}

export async function nativeSecureGet<T>(key: string): Promise<T | null> {
  if (!isNativeApp) return null;
  await prepare();
  return (await SecureStorage.get(key, false, false)) as T | null;
}

export async function nativeSecureSet(key: string, value: string | number | boolean | Record<string, unknown> | unknown[]): Promise<void> {
  if (!isNativeApp) return;
  await prepare();
  await SecureStorage.set(key, value, false, false, KeychainAccess.whenPasscodeSetThisDeviceOnly);
}

export async function nativeSecureRemove(key: string): Promise<void> {
  if (!isNativeApp) return;
  await prepare();
  await SecureStorage.remove(key, false);
}

export async function clearNativeSecureStorage(): Promise<void> {
  if (!isNativeApp) return;
  await prepare();
  await SecureStorage.clear(false);
}
