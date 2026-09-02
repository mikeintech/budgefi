import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { isNativeApp } from "@/lib/platform";
import { nativeSecureGet, nativeSecureSet } from "@/lib/native-storage";

const encryptionKeyName = "offline-cache-encryption-key-v1";
const directory = "budgefi-offline";
const maxPlaintextBytes = 2_000_000;
const maxEnvelopeBytes = 3_000_000;

export async function writeNativeCache(
  name: string,
  plaintext: string,
): Promise<void> {
  if (!isNativeApp) return;
  if (new TextEncoder().encode(plaintext).byteLength > maxPlaintextBytes)
    throw new Error("The offline copy is too large to store safely");
  const key = await cacheKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  await Filesystem.mkdir({
    path: directory,
    directory: Directory.LibraryNoCloud,
    recursive: true,
  }).catch(() => undefined);
  await Filesystem.writeFile({
    path: `${directory}/${safeName(name)}.json`,
    directory: Directory.LibraryNoCloud,
    encoding: Encoding.UTF8,
    data: JSON.stringify({
      version: 1,
      iv: toBase64(iv),
      ciphertext: toBase64(new Uint8Array(encrypted)),
    }),
  });
}

export async function readNativeCache(name: string): Promise<string | null> {
  if (!isNativeApp) return null;
  const path = `${directory}/${safeName(name)}.json`;
  const stat = await Filesystem.stat({
    path,
    directory: Directory.LibraryNoCloud,
  }).catch(() => null);
  if (!stat || stat.size > maxEnvelopeBytes) return null;
  const file = await Filesystem.readFile({
    path,
    directory: Directory.LibraryNoCloud,
    encoding: Encoding.UTF8,
  }).catch(() => null);
  if (!file || typeof file.data !== "string") return null;
  const envelope = JSON.parse(file.data) as {
    version?: unknown;
    iv?: unknown;
    ciphertext?: unknown;
  };
  if (
    envelope.version !== 1 ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string"
  )
    return null;
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(envelope.iv) },
    await cacheKey(false),
    fromBase64(envelope.ciphertext),
  );
  if (decrypted.byteLength > maxPlaintextBytes) return null;
  return new TextDecoder().decode(decrypted);
}

export async function clearNativeCacheFiles(): Promise<void> {
  if (!isNativeApp) return;
  await Filesystem.rmdir({
    path: directory,
    directory: Directory.LibraryNoCloud,
    recursive: true,
  }).catch(() => undefined);
}

async function cacheKey(create = true): Promise<CryptoKey> {
  let encoded = await nativeSecureGet<string>(encryptionKeyName);
  if (!encoded && create) {
    encoded = toBase64(crypto.getRandomValues(new Uint8Array(32)));
    await nativeSecureSet(encryptionKeyName, encoded);
  }
  if (!encoded) throw new Error("The offline encryption key is unavailable");
  return crypto.subtle.importKey("raw", fromBase64(encoded), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
}
function toBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
