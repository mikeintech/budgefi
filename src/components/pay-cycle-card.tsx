import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarRange, ChevronRight, CloudOff } from "lucide-react";
import type { PayCycleListResponse } from "@budgefi/contracts";
import { api } from "@/lib/api";
import {
  readPayCycleCardCache,
  writePayCycleCardCache,
} from "@/lib/pay-cycle-cache";
import { money } from "@/lib/utils";

export function PayCycleCard() {
  const [data, setData] = useState<PayCycleListResponse | null>(null);
  const dataRef = useRef<PayCycleListResponse | null>(null);
  const confirmedAtRef = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setFailed(false);
      const response = await api.payCycles({ limit: 1, planningLimit: 1 });
      dataRef.current = response;
      setData(response);
      const confirmedAt = new Date().toISOString();
      confirmedAtRef.current = confirmedAt;
      setSavedAt(null);
      void writePayCycleCardCache(response, confirmedAt).catch(() => undefined);
    } catch {
      setFailed(true);
      if (!dataRef.current) {
        const cached = await readPayCycleCardCache();
        if (cached) {
          dataRef.current = cached.data;
          confirmedAtRef.current = cached.confirmedAt;
          setData(cached.data);
          setSavedAt(cached.confirmedAt);
        }
      } else setSavedAt(confirmedAtRef.current);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!data && !failed)
    return (
      <div
        className="mt-3 h-[76px] animate-pulse rounded-2xl border border-rule bg-white/60"
        aria-label="Loading pay cycle"
      />
    );
  if (failed && !data)
    return (
      <button
        onClick={() => void load()}
        className="mt-3 flex min-h-[64px] w-full items-center gap-3 rounded-2xl border border-rule bg-white px-4 py-3 text-left"
      >
        <CloudOff className="size-5 text-muted" />
        <span className="flex-1 text-sm font-semibold">
          Pay-cycle history unavailable
        </span>
        <span className="text-xs text-cobalt">Try again</span>
      </button>
    );
  if (!data?.hasVerifiedPayday) return null;
  const cycle = data.items[0];
  if (!cycle) return null;
  const reportStatus = !cycle.report
    ? "Building verified history"
    : cycle.report.assurance === "incomplete"
      ? "Partial cycle totals · coverage incomplete"
      : cycle.updatedAfterBankCorrection
        ? "Updated after bank correction"
        : cycle.updatedAfterEvidenceChange
          ? "Updated after verified activity changed"
          : cycle.report.assurance === "user_confirmed"
            ? `Confirmed by you · ${formatMoney(cycle.report.spent.minor)} spent`
            : `${formatMoney(cycle.report.spent.minor)} spent`;
  return (
    <Link
      to={`/pay-cycles/${cycle.id}`}
      className="mt-3 flex min-h-[72px] items-center gap-3 rounded-2xl border border-rule bg-white px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-recessed text-cobalt">
        <CalendarRange className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block text-sm">
          {cycle.status === "open" ? "Current pay cycle" : "Latest pay cycle"}
        </strong>
        <span className="block truncate text-xs text-muted">
          {failed
            ? `Saved report${savedAt ? ` · updated ${formatTimestamp(savedAt)}` : ""}`
            : `${reportStatus} · ${formatDate(cycle.startOn)} to ${cycle.endOn ? formatDate(addDays(cycle.endOn, -1)) : "today"}`}
        </span>
      </span>
      <ChevronRight className="size-4 text-muted" />
    </Link>
  );
}
function formatMoney(minor: string) {
  return money(Number(BigInt(minor)) / 100);
}
function formatDate(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}
function addDays(value: string, days: number) {
  const d = new Date(`${value}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function formatTimestamp(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
