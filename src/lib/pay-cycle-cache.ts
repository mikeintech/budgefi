import {
  payCycleDetailResponseSchema,
  payCycleListResponseSchema,
  type PayCycleDetailResponse,
  type PayCycleListResponse,
} from "@budgefi/contracts";
import { authCacheScope } from "@/lib/auth";
import { readNativeCache, writeNativeCache } from "@/lib/native-cache";
import { isNativeApp } from "@/lib/platform";

type Cached<T> = { data: T; confirmedAt: string };

export async function readPayCycleListCache(): Promise<Cached<PayCycleListResponse> | null> {
  return readCache("list", payCycleListResponseSchema.parse);
}

export async function writePayCycleListCache(
  data: PayCycleListResponse,
  confirmedAt = new Date().toISOString(),
): Promise<void> {
  await writeCache("list", data, confirmedAt);
}

export async function readPayCycleCardCache(): Promise<Cached<PayCycleListResponse> | null> {
  return readCache("card", payCycleListResponseSchema.parse);
}

export async function writePayCycleCardCache(
  data: PayCycleListResponse,
  confirmedAt = new Date().toISOString(),
): Promise<void> {
  await writeCache("card", data, confirmedAt);
}

export async function readPayCycleDetailCache(
  cycleId: string,
): Promise<Cached<PayCycleDetailResponse> | null> {
  return readCache(`detail-${cycleId}`, payCycleDetailResponseSchema.parse);
}

export async function writePayCycleDetailCache(
  cycleId: string,
  data: PayCycleDetailResponse,
  confirmedAt = new Date().toISOString(),
): Promise<void> {
  await writeCache(`detail-${cycleId}`, data, confirmedAt);
}

async function readCache<T>(
  suffix: string,
  parse: (value: unknown) => T,
): Promise<Cached<T> | null> {
  if (!isNativeApp) return null;
  try {
    const scope = await authCacheScope();
    if (!scope) return null;
    const raw = await readNativeCache(cacheKey(scope, suffix));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      scope?: unknown;
      confirmedAt?: unknown;
      data?: unknown;
    };
    if (parsed.scope !== scope || typeof parsed.confirmedAt !== "string")
      return null;
    return { data: parse(parsed.data), confirmedAt: parsed.confirmedAt };
  } catch {
    return null;
  }
}

async function writeCache<T>(
  suffix: string,
  data: T,
  confirmedAt: string,
): Promise<void> {
  if (!isNativeApp) return;
  const scope = await authCacheScope();
  if (!scope) return;
  await writeNativeCache(
    cacheKey(scope, suffix),
    JSON.stringify({ scope, confirmedAt, data }),
  );
}

function cacheKey(scope: string, suffix: string): string {
  return `pay-cycle-${suffix}:${scope.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
}
